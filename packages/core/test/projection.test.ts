import type { Projection, ViewLevel } from '@spider/shared';
import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graph/builder.js';
import { QueryService } from '../src/query/service.js';
import { analyzeFixture } from './helpers.js';

const LEVELS: ViewLevel[] = ['L0', 'L1', 'L2', 'L3'];

function expectInvariants(p: Projection) {
  const ids = new Set(p.nodes.map((n) => n.id));
  for (const e of p.edges) {
    expect(ids.has(e.src), `edge ${e.id} src`).toBe(true);
    expect(ids.has(e.dst), `edge ${e.id} dst`).toBe(true);
  }
  for (const n of p.nodes) {
    const vp = n.props.viewParent as string | undefined;
    expect(vp === undefined || vp === 'repo' || ids.has(vp), `viewParent of ${n.id}`).toBe(true);
    expect(typeof n.props.childCount).toBe('number');
  }
  expect(p.meta.stats.nodes).toBe(p.nodes.length);
  expect(p.meta.stats.edges).toBe(p.edges.length);
  expect(Object.values(p.meta.stats.byKind).reduce((a, b) => a + b, 0)).toBe(p.nodes.length);
}

describe.each(['ts-express', 'py-fastapi'])('projection invariants / %s', async (fixture) => {
  const { g, q } = await analyzeFixture(fixture);
  const files = g.nodesOfKind('file');
  const dirs = g.nodesOfKind('directory');

  it.each(LEVELS)('holds at %s, plain, expanded, with tests and with focus', (level) => {
    expectInvariants(q.projection({ level }));
    expectInvariants(q.projection({ level, includeTests: true }));
    expectInvariants(q.projection({ level, expanded: dirs.map((d) => d.id) }));
    for (const f of files) expectInvariants(q.projection({ level, focus: f.id, focusDepth: 2 }));
  });
});

describe('projection focus', async () => {
  const { g, q } = await analyzeFixture('ts-express');
  const file = (p: string) => g.nodesOfKind('file').find((n) => n.file === p)!;

  it('keeps only nodes within focusDepth hops of the focus representative', () => {
    const db = file('src/services/db.ts');
    const full = q.projection({ level: 'L2' });
    const p = q.projection({ level: 'L2', focus: db.id, focusDepth: 1 });
    expect(p.meta.focus).toBe(db.id);
    const ids = new Set(p.nodes.map((n) => n.id));
    expect(ids.has(db.id)).toBe(true);
    // every kept node is the focus or touches it through a projected edge
    const neighbours = new Set(full.edges.flatMap((e) => (e.src === db.id ? [e.dst] : e.dst === db.id ? [e.src] : [])));
    for (const id of ids) expect(id === db.id || neighbours.has(id)).toBe(true);
    for (const n of neighbours) expect(ids.has(n)).toBe(true);
    expect(p.nodes.length).toBeLessThan(full.nodes.length);
  });

  it('grows with focusDepth and depth 0 is the node alone', () => {
    const db = file('src/services/db.ts');
    const d0 = q.projection({ level: 'L2', focus: db.id, focusDepth: 0 });
    const d1 = q.projection({ level: 'L2', focus: db.id, focusDepth: 1 });
    const d2 = q.projection({ level: 'L2', focus: db.id, focusDepth: 2 });
    expect(d0.nodes.map((n) => n.id)).toEqual([db.id]);
    expect(d2.nodes.length).toBeGreaterThanOrEqual(d1.nodes.length);
  });

  it('maps a hidden symbol to its visible representative', () => {
    const query = g.nodesOfKind('function').find((n) => n.name === 'query')!;
    const p = q.projection({ level: 'L2', focus: query.id });
    expect(p.meta.focus).toBe(file('src/services/db.ts').id);
  });

  it('keeps view-parent groups of kept nodes', () => {
    const src = g.nodesOfKind('directory').find((n) => n.name === 'src')!;
    const db = file('src/services/db.ts');
    const p = q.projection({ level: 'L1', expanded: [src.id], focus: db.id, focusDepth: 1 });
    expect(p.nodes.some((n) => n.id === src.id)).toBe(true);
    expectInvariants(p);
  });

  it('reports stats by kind', () => {
    const p = q.projection({ level: 'L2' });
    expect(p.meta.stats.byKind.file).toBe(p.nodes.filter((n) => n.kind === 'file').length);
    expect(p.meta.truncated).toBe(false);
    expect(p.meta.truncatedReason).toBeUndefined();
  });
});

describe('projection truncation', () => {
  it('caps at MAX_NODES with a reason', () => {
    const g = new GraphBuilder();
    g.addNode({ id: 'repo', kind: 'repository', name: 'r' });
    for (let i = 0; i < 6100; i++) g.addNode({ id: `f${i}`, kind: 'file', name: `f${i}`, parentId: 'repo' });
    const p = new QueryService(g, {}).projection({ level: 'L1' });
    expect(p.nodes.length).toBe(6000);
    expect(p.meta.truncated).toBe(true);
    expect(p.meta.truncatedReason).toBe('Showing first 6,000 of 6,100 nodes. Collapse containers or use filters.');
  });
});
