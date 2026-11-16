import { describe, expect, it } from 'vitest';
import { sqlTables, tableKey } from '../src/pipeline/resolve-data.js';
import { normalisePath } from '../src/pipeline/resolve-http.js';
import { analyzeFixture } from './helpers.js';

type Fx = Awaited<ReturnType<typeof analyzeFixture>>;

/** `kind src -> dst conf[ amb]` for HTTP calls and datastore access. */
function links(g: Fx['g'], pick: (kind: string, protocol: unknown) => boolean): string[] {
  const out: string[] = [];
  for (const e of g.edges.values()) {
    if (!pick(e.kind, e.props.protocol)) continue;
    const s = g.getNode(e.src);
    const t = g.getNode(e.dst);
    out.push(
      `${e.kind} ${s?.qname} -> ${t?.kind === 'datastore' ? t.name : t?.qname} ${e.confidence}${e.props.ambiguous ? ' ambiguous' : ''}`,
    );
  }
  return out.sort();
}

describe('C-19 polyglot HTTP linking (TS → FastAPI + gin, Python → Go, Go → Python)', async () => {
  const fx = await analyzeFixture('polyglot');
  const http = links(fx.g, (_k, p) => p === 'http');

  it('links client calls to endpoints across languages with calibrated confidence', () => {
    expect(http).toEqual([
      'calls services/catalog/main.py::reserve -> services/orders/main.go::POST /orders/:id/reserve 0.8',
      'calls services/orders/main.go::fetchItem -> services/catalog/main.py::GET /items/{item_id} 0.8',
      'calls web/src/api.test.ts::res -> services/catalog/main.py::GET /items 1',
      'calls web/src/api.ts::cancelOrder -> services/orders/main.go::DELETE /orders/:id 0.8',
      'calls web/src/api.ts::createOrder -> services/orders/main.go::POST /orders 0.8',
      'calls web/src/api.ts::getItem -> services/catalog/main.py::GET /items/{item_id} 0.8',
      'calls web/src/api.ts::getOrder -> services/orders/main.go::GET /orders/:id 0.8',
      'calls web/src/api.ts::health -> services/catalog/main.py::GET /health 0.4 ambiguous',
      'calls web/src/api.ts::health -> services/orders/main.go::GET /health 0.4 ambiguous',
      'calls web/src/api.ts::listItems -> services/catalog/main.py::GET /items 1',
    ]);
  });

  it('does not mistake client requests for routes and ignores public hosts', () => {
    const names = fx.q.endpoints(true).map((e) => `${e.node.file} ${e.node.name}`);
    expect(names.filter((n) => n.startsWith('web/'))).toEqual([]);
    expect(http.some((l) => l.includes('::stars'))).toBe(false);
  });

  it('traces a frontend-facing endpoint through its handler into the datastore', () => {
    const ep = fx.q.endpoints().find((e) => e.node.name === 'GET /items');
    const t = fx.q.trace(ep?.node.id ?? '');
    expect(t.boundaries.map((id) => fx.g.getNode(id)?.name)).toEqual(['items']);
  });

  it('normalises client paths', () => {
    expect(normalisePath('http://localhost:8000/users/{}?q=1')).toEqual({ segs: ['users', null], literal: false });
    expect(normalisePath('{}/orders')).toEqual({ segs: ['orders'], literal: false });
    expect(normalisePath('/x', 'http://localhost/api')).toEqual({ segs: ['api', 'x'], literal: true });
    expect(normalisePath('api/users')).toEqual({ segs: ['api', 'users'], literal: true });
    expect(normalisePath('https://api.github.com/users')).toBeUndefined();
    expect(normalisePath('hello world')).toBeUndefined();
  });
});

describe('C-20 datastore heuristics', async () => {
  const fx = await analyzeFixture('datastores');
  const data = links(fx.g, (k) => k === 'reads' || k === 'writes');

  it('emits reads/writes from SQL strings, ORMs, Redis and queues', () => {
    expect(data).toEqual([
      'reads api/src/users.ts -> emails 0.7',
      'reads api/src/users.ts::SessionService.active -> Session 0.8',
      'reads api/src/users.ts::listUsers -> user 0.9',
      'reads api/src/users.ts::listen -> post-events 0.7',
      'reads library/orders.py::latest -> Order 0.9',
      'reads library/orders.py::open_orders -> Order 0.9',
      'reads library/views.py::index_book -> index_book 0.7',
      'reads library/views.py::list_books -> Book 0.9',
      'reads library/views.py::list_books -> redis 0.8',
      'reads library/views.py::report -> Author 0.9',
      'reads library/views.py::report -> Book 0.9',
      'reads shop/Owners.java::OwnerService.all -> Owner 0.9',
      'reads shop/Owners.java::OwnerService.legacyCount -> Owner 0.9',
      'reads shop/ShopContext.cs::CustomerService.Count -> Customer 0.9',
      'reads store/store.go::Store.Cheap -> Product 0.9',
      'reads store/store.go::Store.List -> Product 0.9',
      'writes api/src/users.ts::SessionService.touch -> Session 0.8',
      'writes api/src/users.ts::audit -> audit_log 0.9',
      'writes api/src/users.ts::createPost -> post 0.9',
      'writes api/src/users.ts::createPost -> post-events 0.7',
      'writes api/src/users.ts::welcome -> emails 0.7',
      'writes library/orders.py::place -> Order 0.9',
      'writes library/views.py::add_author -> Author 0.9',
      'writes library/views.py::add_author -> redis 0.8',
      'writes library/views.py::publish -> index_book 0.7',
      'writes shop/Owners.java::OwnerService.add -> Owner 0.9',
      'writes shop/ShopContext.cs::CustomerService.Add -> Customer 0.9',
      'writes store/store.go::Store.Add -> Product 0.9',
    ]);
  });

  it('keeps datastores in the containment tree under per-system groups', () => {
    const stores = fx.g.nodesOfKind('datastore');
    const parent = (name: string) => fx.g.getNode(stores.find((n) => n.name === name)?.parentId ?? '')?.name;
    expect(parent('Owner')).toBe('database');
    expect(parent('post-events')).toBe('queues');
    expect(parent('database')).toBe('datastores');
    expect(parent('redis')).toBe('datastores');
    // `owners` (SQL) and `Owner` (JPA entity) are one table
    expect(stores.filter((n) => /^owners?$/i.test(n.name))).toHaveLength(1);
    const p = fx.q.projection({ level: 'L1', edgeKinds: ['reads', 'writes'] });
    expect(p.nodes.some((n) => n.kind === 'datastore')).toBe(true);
  });

  it('tokenizes SQL without a parser', () => {
    expect(sqlTables('SELECT a.x FROM users a, teams t JOIN roles r ON r.id = a.role')).toEqual({
      reads: ['users', 'teams', 'roles'],
      writes: [],
    });
    expect(sqlTables('INSERT INTO audit (who) SELECT name FROM users')).toEqual({
      reads: ['users'],
      writes: ['audit'],
    });
    expect(sqlTables('UPDATE "public"."users" SET x = 1 WHERE id IN (SELECT id FROM bans)')).toEqual({
      reads: ['bans'],
      writes: ['users'],
    });
    expect(sqlTables('INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = 2')).toEqual({
      reads: [],
      writes: ['t'],
    });
    expect(sqlTables('DELETE FROM sessions WHERE expires < now()')).toEqual({ reads: [], writes: ['sessions'] });
    expect(['Users', 'user', 'categories', 'Addresses', 'boxes'].map(tableKey)).toEqual([
      'user',
      'user',
      'category',
      'address',
      'box',
    ]);
  });
});
