import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applySubsystems, groupsFromGraph } from '../src/enrich/subsystems.js';
import { GraphBuilder } from '../src/graph/builder.js';
import { QueryService, projectionKey } from '../src/query/service.js';
import { SqliteStore } from '../src/store/sqlite.js';
import { analyzeFixture } from './helpers.js';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'spider-scale-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Fixture graph plus 300 `userThing*` functions so FTS answers on its own (≥ limit hits above 40). */
async function storedGraph(name: string) {
  const { g, en } = await analyzeFixture('ts-express');
  for (let i = 0; i < 300; i++)
    g.addNode({
      id: `bulk${i}`,
      kind: 'function',
      name: i % 7 === 0 ? 'userthing' : `userThing${i}`,
      qname: `bulk.userThing${i}`,
      parentId: 'repo',
      metrics: { fanIn: i % 13 },
      props: { isTest: i % 11 === 0 },
    });
  const meta = { diagnostics: en.diagnostics };
  const store = await SqliteStore.open(path.join(tmp, `${name}.db`));
  store.saveGraph(g, meta);
  const { graph } = store.loadGraph();
  return { graph, meta, store };
}

const hitKey = (hits: { node: { id: string }; score: number }[]) =>
  hits.map((h) => `${h.node.id}:${h.score.toFixed(3)}`);

describe('FTS5 search', () => {
  it('ranks exactly like the full scan', async () => {
    const { graph, meta, store } = await storedGraph('fts');
    const scan = new QueryService(graph, meta);
    const fts = new QueryService(graph, meta, store);
    expect(store.substringIds('userthing', 5000)?.length).toBeGreaterThan(25);
    expect(store.substringIds('us', 5000)).toBeUndefined(); // shorter than a trigram
    expect(store.substringIds('user', 10)).toBeUndefined(); // too unselective: scan instead
    for (const q of [
      'userthing',
      'UserThing1',
      'user',
      'thing2',
      'bulk.user',
      'query',
      'ord',
      'uc',
      'xq',
      'a"b',
      'BaseController',
    ])
      for (const limit of [3, 25, 400])
        for (const kinds of [undefined, ['function'], ['class', 'file']])
          expect(hitKey(fts.search(q, kinds, limit)), `${q} ${limit} ${kinds}`).toEqual(
            hitKey(scan.search(q, kinds, limit)),
          );
    fts.close();
    expect(fts.search('userthing').length).toBe(25); // closed index falls back to scanning
  });
});

describe('projection cache', () => {
  it('reuses projections, normalises keys and invalidates after in-place changes', async () => {
    const { g, q } = await analyzeFixture('ts-express');
    const a = q.projection({ level: 'L0' });
    expect(q.projection({ level: 'L0', includeTests: false, minConfidence: 0 })).toBe(a);
    const dirs = g.nodesOfKind('directory').map((d) => d.id);
    expect(projectionKey({ level: 'L1', expanded: dirs })).toBe(
      projectionKey({ level: 'L1', expanded: [...dirs].reverse() }),
    );
    const sub = g.nodesOfKind('subsystem')[0];
    applySubsystems(g, groupsFromGraph(g), { rename: { [sub.id]: 'renamed-subsystem' }, merge: [], pins: {} });
    expect(q.projection({ level: 'L0' })).toBe(a); // stale until invalidated
    q.invalidate();
    const b = q.projection({ level: 'L0' });
    expect(b).not.toBe(a);
    expect(b.nodes.some((n) => n.name === 'renamed-subsystem')).toBe(true);
  });

  it('serves persisted default views identical to computed ones', async () => {
    const { graph, meta, store } = await storedGraph('views');
    const computed = new QueryService(graph, meta).defaultViews();
    store.saveViews(computed);
    const q = new QueryService(graph, meta, store);
    for (const level of ['L0', 'L1', 'L2', 'L3'] as const) {
      const key = projectionKey({ level });
      expect(store.viewJson(key)).toBeDefined();
      expect(q.projection({ level })).toEqual(JSON.parse(JSON.stringify(computed.get(key))));
    }
    store.saveGraph(graph, meta);
    expect(store.viewJson(projectionKey({ level: 'L1' }))).toBeUndefined(); // saving the graph drops stale views
    store.close();
  });

  it('keeps the projection loop linear on a wide graph', () => {
    const g = new GraphBuilder();
    g.addNode({ id: 'repo', kind: 'repository', name: 'r' });
    for (let i = 0; i < 40000; i++) g.addNode({ id: `f${i}`, kind: 'file', name: `f${i}`, parentId: 'repo' });
    for (let i = 1; i < 40000; i++) g.addEdge('imports', `f${i}`, `f${i - 1}`);
    const t = performance.now();
    new QueryService(g, {}).projection({ level: 'L2' });
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
