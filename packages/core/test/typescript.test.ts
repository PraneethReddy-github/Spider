import { describe, expect, it } from 'vitest';
import { analyzeFixture, edgeLabels } from './helpers.js';

describe('typescript / express fixture', async () => {
  const { g, q, stats, en } = await analyzeFixture('ts-express');
  const edges = edgeLabels(g);

  it('resolves relative, index-less, tsconfig-path and package imports', () => {
    expect(edges).toContain('imports src/index.ts -> src/routes/users.ts');
    expect(edges).toContain('imports src/routes/users.ts -> src/services/userService.ts'); // @services/* alias
    expect(edges).toContain('imports src/services/db.ts -> npm:pg');
    expect(stats.unresolvedImports).toBe(0);
  });

  it('builds symbol nodes with hierarchy', () => {
    const cls = [...g.nodes.values()].find((n) => n.kind === 'class' && n.name === 'OrderController')!;
    expect(cls).toBeDefined();
    expect(g.children(cls.id).map((c) => c.name).sort()).toEqual(['create', 'get']);
    expect(g.getNode(cls.parentId!)?.kind).toBe('file');
  });

  it('resolves calls, instantiations and inheritance', () => {
    expect(edges).toContain('extends src/routes/orders.ts::OrderController -> src/routes/base.ts::BaseController');
    expect(edges).toContain('instantiates src/index.ts::orders -> src/routes/orders.ts::OrderController');
    expect(edges).toContain('calls src/routes/orders.ts::OrderController.get -> src/services/db.ts::query');
    expect(edges).toContain('calls src/routes/orders.ts::OrderController.get -> src/routes/base.ts::BaseController.ok'); // inherited via this.ok
    // instance binding: const svc = new UserService(); svc.list()
    expect(edges).toContain('calls src/routes/users.ts::registerUserRoutes.GET /users -> src/services/userService.ts::UserService.list');
    // module-level binding: orders.get(...)
    expect(edges).toContain('calls src/index.ts -> src/routes/orders.ts::OrderController.get');
    // must not bind app.get(...) to OrderController.get by name
    expect(edges).not.toContain('calls src/routes/users.ts::registerUserRoutes -> src/routes/orders.ts::OrderController.get');
  });

  it('detects express endpoints and binds handlers', () => {
    const eps = q.endpoints().map((e) => `${e.node.name} -> ${e.handler?.name}`);
    expect(eps).toContain('GET /orders/:id -> GET /orders/:id');
    expect(eps).toContain('POST /orders -> create');
    expect(eps).toContain('GET /users/:id -> getUser');
    expect(eps).toContain('GET /users -> GET /users');
  });

  it('traces an endpoint through to the database layer', () => {
    const ep = q.endpoints().find((e) => e.node.name === 'GET /users/:id')!;
    const t = q.trace(ep.node.id);
    expect(t.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['getUser', 'find', 'query']));
  });

  it('computes upstream impact', () => {
    const query = [...g.nodes.values()].find((n) => n.kind === 'function' && n.name === 'query')!;
    const up = q.upstream(query.id, 3);
    expect(up.nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['get', 'create', 'list', 'find', 'GET /users/:id']));
  });

  it('marks tests and flags dead code without false positives on interfaces', () => {
    const test = [...g.nodes.values()].find((n) => n.file === 'src/utils.test.ts' && n.kind === 'file')!;
    expect(test.props.isTest).toBe(true);
    const dead = en.diagnostics.filter((d) => d.type === 'dead-code').map((d) => d.title);
    expect(dead).toEqual(['unusedHelper has no references']);
  });

  it('projects levels and rolls edges up', () => {
    const l1 = q.projection({ level: 'L1' });
    expect(l1.nodes.map((n) => n.name)).toContain('src');
    expect(l1.edges.some((e) => e.kind === 'imports' && e.weight >= 2)).toBe(true);
    const l3 = q.projection({ level: 'L3' });
    expect(l3.nodes.some((n) => n.kind === 'method')).toBe(true);
    const ids = new Set(l3.nodes.map((n) => n.id));
    for (const e of l3.edges) {
      expect(ids.has(e.src)).toBe(true);
      expect(ids.has(e.dst)).toBe(true);
    }
    expect(l3.nodes.some((n) => n.file === 'src/utils.test.ts')).toBe(false);
    expect(q.projection({ level: 'L2', includeTests: true }).nodes.some((n) => n.file === 'src/utils.test.ts')).toBe(true);
  });

  it('expanding a container keeps it as a group node with children inside', () => {
    const src = [...g.nodes.values()].find((n) => n.kind === 'directory' && n.name === 'src')!;
    const p = q.projection({ level: 'L1', expanded: [src.id] });
    expect(p.nodes.some((n) => n.id === src.id)).toBe(true);
    const inside = p.nodes.filter((n) => n.props.viewParent === src.id);
    expect(inside.length).toBeGreaterThan(0);
  });

  it('search ranks exact and prefix matches first', () => {
    const hits = q.search('UserService');
    expect(hits[0].node.name).toBe('UserService');
    expect(q.search('usr').length).toBeGreaterThan(0);
  });
});
