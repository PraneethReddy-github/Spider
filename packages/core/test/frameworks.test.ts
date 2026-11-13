import { describe, expect, it } from 'vitest';
import { analyzeFixture } from './helpers.js';

/** `METHOD /path -> handler qname` for every non-test endpoint. */
async function routes(fixture: string): Promise<string[]> {
  const { q } = await analyzeFixture(fixture);
  return q
    .endpoints()
    .map((e) => `${e.node.name} -> ${e.handler?.qname ?? '-'}`)
    .sort();
}

describe('C-9 frameworks', () => {
  it('koa-router: prefix option, named routes, nested router.use mount', async () => {
    expect(await routes('ts-koa')).toEqual([
      'GET /api/users -> src/routes/users.ts::listUsers',
      'GET /api/users/:id -> src/routes/users.ts::getUser',
      'GET /health -> src/app.ts::health',
    ]);
  });

  it('hono: basePath and app.route groups across files', async () => {
    expect(await routes('ts-hono')).toEqual([
      'GET /health -> src/index.ts::GET /health',
      'GET /v1/api/books -> src/books.ts::GET /',
      'POST /v1/api/books/:id -> src/books.ts::createBook',
    ]);
  });

  it('nestjs: global prefix, RouterModule module prefix, @Controller({ path })', async () => {
    expect(await routes('ts-nest')).toEqual([
      'GET /api/admin/stats -> src/admin/stats.controller.ts::StatsController.summary',
      'GET /api/users -> src/users/users.controller.ts::UsersController.list',
      'GET /api/users/:id -> src/users/users.controller.ts::UsersController.one',
    ]);
  });

  it('next.js: middleware matchers and app routes', async () => {
    expect(await routes('ts-next')).toEqual([
      'GET /api/items -> app/api/items/route.ts::GET',
      'USE /api/:path* -> middleware.ts::middleware',
      'USE /dashboard/:path* -> middleware.ts::middleware',
    ]);
  });

  it('flask: blueprint url_prefix, register_blueprint override, MethodView', async () => {
    expect(await routes('py-flask')).toEqual([
      'DELETE /api/v1/users/items/<int:item_id> -> web/views.py::ItemAPI.delete',
      'GET /admin/stats -> web/views.py::stats',
      'GET /api/v1/users/ -> web/views.py::list_users',
      'GET /api/v1/users/items/<int:item_id> -> web/views.py::ItemAPI.get',
      'GET /health -> web/app.py::health',
    ]);
  });

  it('django: nested include() prefixes (module string and module object) and class-based views', async () => {
    expect(await routes('py-django')).toEqual([
      'ANY / -> site_cfg/views.py::home',
      'ANY /blog/api/feed/ -> blog/views.py::feed',
      'ANY /blog/posts/ -> blog/views.py::post_list',
      'GET /blog/posts/<int:pk>/ -> blog/views.py::PostDetail.get',
      'POST /blog/posts/<int:pk>/ -> blog/views.py::PostDetail.post',
    ]);
  });

  it('fastapi: APIRouter(prefix=) and nested include_router(prefix=)', async () => {
    expect(await routes('py-fastapi-routers')).toEqual([
      'GET /api/v1/catalog/items/ -> api/routers/items.py::list_items',
      'GET /api/v1/catalog/items/{item_id} -> api/routers/items.py::get_item',
      'GET /health -> api/main.py::health',
    ]);
  });
});
