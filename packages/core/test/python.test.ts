import { describe, expect, it } from 'vitest';
import { analyzeFixture, edgeLabels } from './helpers.js';

describe('python / fastapi fixture', async () => {
  const { g, q, stats, facts } = await analyzeFixture('py-fastapi');
  const edges = edgeLabels(g);
  it('resolves absolute, relative and stdlib/pypi imports', () => {
    expect(edges).toContain('imports app/routers/users.py -> app/services/user_service.py');
    expect(edges).toContain('imports app/main.py -> app/services/db.py');
    expect(edges).toContain('imports app/routers/users.py -> app/services/db.py');
    expect(edges).toContain('imports app/main.py -> pypi:fastapi');
    expect(edges).toContain('imports app/services/db.py -> python-stdlib:logging');
    expect(stats.unresolvedImports).toBe(0);
  });
  it('does not treat the module name as an imported symbol', () => {
    const imp = facts.get('app/main.py')!.imports.find((i) => i.specifier === 'fastapi')!;
    expect(imp.names).toEqual([{ imported: 'FastAPI', local: 'FastAPI' }]);
  });
  it('resolves calls through namespaces, instances, self and inheritance', () => {
    expect(edges).toContain('calls app/routers/users.py::create_user -> app/services/db.py::log');
    expect(edges).toContain('calls app/routers/users.py::list_users -> app/services/user_service.py::UserService.list');
    expect(edges).toContain(
      'calls app/services/user_service.py::UserService.create -> app/services/base.py::BaseService.validate',
    );
    expect(edges).toContain('extends app/services/user_service.py::UserService -> app/services/base.py::BaseService');
  });
  it('detects fastapi decorator endpoints', () => {
    const eps = q.endpoints().map((e) => `${e.node.name} -> ${e.handler?.name}`);
    expect(eps).toEqual(
      expect.arrayContaining(['GET /health -> health', 'GET /users -> list_users', 'POST /users -> create_user']),
    );
  });
  it('binds startup hooks, instances and nothing spurious', () => {
    expect(edges).toContain('calls app/main.py::startup -> app/services/db.py::connect');
    expect(edges).toContain(
      'calls app/routers/users.py::create_user -> app/services/user_service.py::UserService.create',
    );
    expect(edges).toContain('calls app/services/user_service.py::UserService.list -> app/services/db.py::query');
    expect(edges).toContain('instantiates app/routers/users.py -> app/services/user_service.py::UserService');
    expect(edges.filter((e) => e.startsWith('calls '))).toHaveLength(7);
    expect(edges.some((e) => e.includes('-> app/__init__.py'))).toBe(false);
  });
  it('splits library calls from unresolved calls', () => {
    expect(stats.externalCalls).toBe(9); // FastAPI(), APIRouter(), app.include_router, logging.info, ...
    expect(stats.unresolvedCalls).toBe(0);
    expect(stats.ambiguousCalls).toBe(0);
  });
  it('finds a path from endpoint to data layer', () => {
    const ep = q.endpoints().find((e) => e.node.name === 'POST /users')!;
    const query = [...g.nodes.values()].find((n) => n.name === 'query' && n.kind === 'function')!;
    expect(q.path(ep.node.id, query.id).nodes.map((n) => n.name)).toEqual([
      'POST /users',
      'create_user',
      'create',
      'query',
    ]);
  });
});
