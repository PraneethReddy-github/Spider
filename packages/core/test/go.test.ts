import { describe, expect, it } from 'vitest';
import { analyzeFixture, edgeLabels } from './helpers.js';

/** `METHOD /path -> handler qname` for every non-test endpoint. */
function routes(q: Awaited<ReturnType<typeof analyzeFixture>>['q']): string[] {
  return q
    .endpoints()
    .map((e) => `${e.node.name} -> ${e.handler?.qname ?? '-'}`)
    .sort();
}

describe('go / gin fixture', async () => {
  const { g, q, stats } = await analyzeFixture('go-gin');
  const edges = edgeLabels(g);
  const conf = (label: string) =>
    [...g.edges.values()].find((e) => `${e.kind} ${g.getNode(e.src)?.qname} -> ${g.getNode(e.dst)?.qname}` === label)
      ?.confidence;

  it('resolves go.mod import paths to the package files actually used', () => {
    expect(edges).toContain('imports main.go -> internal/store/store.go');
    expect(edges).toContain('imports main.go -> internal/handlers/user.go');
    expect(edges).toContain('imports main.go -> internal/routes/admin.go');
    expect(edges).toContain('imports internal/handlers/user.go -> internal/store/db.go');
    expect(edges).toContain('imports main.go -> go:github.com/gin-gonic/gin');
    expect(edges).toContain('imports internal/store/db.go -> go-stdlib:fmt');
    expect(stats.unresolvedImports).toBe(0);
  });

  it('binds package calls, receivers, struct fields, cross-file methods and embedding', () => {
    expect(edges).toContain('calls main.go::main -> internal/store/store.go::NewStore');
    expect(edges).toContain('calls internal/store/store.go::NewStore -> internal/store/db.go::openDB');
    expect(edges).toContain(
      'calls internal/handlers/user.go::UserHandler.Get -> internal/store/store.go::Store.FindUser',
    );
    expect(edges).toContain('calls internal/store/store.go::Store.FindUser -> internal/store/db.go::DB.Query');
    expect(edges).toContain(
      'calls internal/handlers/user.go::UserHandler.Get -> internal/handlers/base.go::UserHandler.respond',
    );
    expect(conf('calls internal/handlers/user.go::UserHandler.Create -> internal/handlers/base.go::Base.Log')).toBe(
      0.9,
    );
    expect(edges).toContain('extends internal/handlers/user.go::UserHandler -> internal/handlers/base.go::Base');
    expect(edges).toContain('instantiates internal/handlers/user.go::UserHandler.Create -> internal/store/db.go::User');
    expect(edges).toContain(
      'calls internal/routes/admin.go::RegisterAdmin.DELETE /users/:id -> internal/store/store.go::Store.Save',
    );
    expect(edges).toContain(
      'calls internal/store/store_test.go::TestFindUser -> internal/store/store.go::Store.FindUser',
    );
    expect(edges.filter((e) => e.startsWith('calls '))).toHaveLength(13);
    expect(stats.unresolvedCalls).toBe(0);
    expect(stats.ambiguousCalls).toBe(0);
  });

  it('detects gin routes with group prefixes, inline handlers and groups passed to functions', () => {
    expect(routes(q)).toEqual([
      'DELETE /api/admin/users/:id -> internal/routes/admin.go::RegisterAdmin.DELETE /users/:id',
      'GET /api/admin/stats -> internal/routes/admin.go::stats',
      'GET /api/v1/users/:id -> internal/handlers/user.go::UserHandler.Get',
      'GET /health -> main.go::main.GET /health',
      'POST /api/v1/users -> internal/handlers/user.go::UserHandler.Create',
    ]);
  });
});

describe('go / net/http + chi + gRPC fixture', async () => {
  const { g, q, stats } = await analyzeFixture('go-nethttp');
  const edges = edgeLabels(g);

  it('detects Go 1.22 patterns, chi Route/Mount prefixes and gRPC service methods', () => {
    expect(routes(q)).toEqual([
      'ANY /static/ -> -',
      'GET /admin/stats -> internal/api/admin.go::stats',
      'GET /items/{id} -> internal/api/items.go::GetItem',
      'GET /v2/items -> internal/api/items.go::ListItems',
      'GRPC /helloworld.Greeter/SayGoodbye -> proto/hello/hello_grpc.pb.go::UnimplementedGreeterServer.SayGoodbye',
      'GRPC /helloworld.Greeter/SayHello -> internal/greeter/server.go::Server.SayHello',
      'POST /v2/items -> internal/api/items.go::CreateItem',
    ]);
    const grpc = q.endpoints().filter((e) => e.node.props.method === 'GRPC');
    expect(grpc.every((e) => e.node.props.protocol === 'grpc')).toBe(true);
  });

  it('resolves package-level calls across files and aliased imports', () => {
    expect(edges).toContain('calls internal/api/admin.go::stats -> internal/api/items.go::lookup');
    expect(edges).toContain('calls cmd/server/main.go::main -> internal/api/admin.go::AdminRouter');
    expect(edges).toContain('instantiates cmd/server/main.go::main -> internal/greeter/server.go::Server');
    expect(edges).toContain(
      'extends internal/greeter/server.go::Server -> proto/hello/hello_grpc.pb.go::UnimplementedGreeterServer',
    );
    expect(edges).toContain('imports internal/greeter/server.go -> proto/hello/hello.pb.go');
    expect(stats.unresolvedImports).toBe(0);
    expect(stats.unresolvedCalls).toBe(0);
  });
});

describe('go extractor: echo and gorilla/mux', () => {
  const extract = async (src: string) => {
    const { parseSource } = await import('../src/parse/parser.js');
    const { goExtractor } = await import('../src/languages/go/extractor.js');
    const tree = await parseSource('go', src);
    const facts = goExtractor.extract(tree.rootNode, {
      path: 'x.go',
      language: 'go',
      source: src,
      frameworks: new Set(),
    });
    return facts.endpoints.map((e) => `${e.method} ${e.path} ${e.framework} ${e.handlerRef ?? '-'}`);
  };
  it('echo: handler is the second argument, groups prefix', async () => {
    const eps = await extract(`package main
import "github.com/labstack/echo/v4"
func main() {
	e := echo.New()
	g := e.Group("/api", auth)
	g.GET("/users/:id", getUser, logMW)
	e.Add("PUT", "/x", putX)
}`);
    expect(eps).toEqual(['GET /api/users/:id echo getUser', 'PUT /x echo putX']);
  });
  it('gorilla: Methods() and PathPrefix().Subrouter()', async () => {
    const eps = await extract(`package main
import ("net/http"; "github.com/gorilla/mux")
func main() {
	r := mux.NewRouter()
	s := r.PathPrefix("/v1").Subrouter()
	s.HandleFunc("/items", list).Methods("GET", "POST")
	http.Handle("/", r)
}`);
    expect(eps).toEqual(['GET /v1/items gorilla list', 'POST /v1/items gorilla list', 'ANY / net/http r']);
  });
});
