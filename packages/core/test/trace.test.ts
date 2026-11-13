import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graph/builder.js';
import { QueryService } from '../src/query/service.js';
import { analyzeFixture } from './helpers.js';

/** endpoint → [auth, log (middleware)] + handler → service → {db (datastore), lib (external)} → beyond. */
function synthetic() {
  const g = new GraphBuilder();
  g.addNode({ id: 'repo', kind: 'repository', name: 'r' });
  g.addNode({ id: 'f', kind: 'file', name: 'f.ts', parentId: 'repo' });
  const fn = (id: string, props: Record<string, unknown> = {}) =>
    g.addNode({ id, kind: 'function', name: id, parentId: 'f', props });
  g.addNode({ id: 'ep', kind: 'endpoint', name: 'GET /x', parentId: 'f' });
  fn('log', { middleware: true, order: 1 });
  fn('auth', { middleware: true, order: 0 });
  fn('handler');
  fn('service');
  g.addNode({ id: 'db', kind: 'datastore', name: 'postgres', parentId: 'repo' });
  g.addNode({ id: 'lib', kind: 'external', name: 'axios', parentId: 'repo' });
  fn('beyondDb');
  fn('beyondLib');
  g.addEdge('exposes', 'ep', 'log');
  g.addEdge('exposes', 'ep', 'auth');
  g.addEdge('exposes', 'ep', 'handler');
  g.addEdge('calls', 'handler', 'service');
  g.addEdge('writes', 'service', 'db');
  g.addEdge('calls', 'service', 'lib');
  g.addEdge('calls', 'db', 'beyondDb');
  g.addEdge('calls', 'lib', 'beyondLib');
  return new QueryService(g, {});
}

describe('trace', () => {
  it('stops at datastore and external boundaries but includes them', () => {
    const t = synthetic().trace('ep');
    const ids = t.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['auth', 'db', 'ep', 'handler', 'lib', 'log', 'service']);
    expect(t.boundaries.sort()).toEqual(['db', 'lib']);
    expect(t.edges.every((e) => e.src !== 'db' && e.src !== 'lib')).toBe(true);
  });

  it('returns the middleware chain in order and ordered layers', () => {
    const t = synthetic().trace('ep');
    expect(t.middleware).toEqual(['auth', 'log']);
    // within a layer: middleware in order, then by name (axios < postgres)
    expect(t.layers).toEqual([['ep'], ['auth', 'log', 'handler'], ['service'], ['lib', 'db']]);
    for (const [d, layer] of t.layers.entries()) for (const id of layer) expect(t.distances[id]).toBe(d);
  });

  it('respects depth and unknown ids', () => {
    const q = synthetic();
    expect(q.trace('ep', 1).layers).toHaveLength(2);
    expect(q.trace('nope')).toMatchObject({ nodes: [], layers: [], middleware: [], boundaries: [] });
  });

  it('layers the fixture trace consistently with distances', async () => {
    const { q } = await analyzeFixture('ts-express');
    const ep = q.endpoints().find((e) => e.node.name === 'GET /users/:id')!;
    const t = q.trace(ep.node.id);
    expect(t.layers[0]).toEqual([ep.node.id]);
    expect(t.layers.flat().sort()).toEqual(t.nodes.map((n) => n.id).sort());
    expect(t.layers.length).toBeGreaterThanOrEqual(3);
  });
});
