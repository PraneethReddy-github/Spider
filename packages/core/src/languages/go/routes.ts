import type { SyntaxNode } from '../../parse/parser.js';
import { field } from '../../parse/parser.js';
import { type EndpointFact, spanOf } from '../types.js';
import type { GoScope, GoWalker } from './extractor.js';
import { goChain, goString, goTypeRef } from './extractor.js';

const VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE'];
const CHI_VERBS = new Map(VERBS.map((v) => [v[0] + v.slice(1).toLowerCase(), v]));

const FW_RE = {
  gin: /^github\.com\/gin-gonic\/gin$/,
  echo: /^github\.com\/labstack\/echo(\/v\d+)?$/,
  chi: /^github\.com\/go-chi\/chi(\/v\d+)?$/,
  gorilla: /^github\.com\/gorilla\/mux$/,
  nethttp: /^net\/http$/,
  grpc: /^google\.golang\.org\/grpc$/,
};

export function joinUrl(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}

/**
 * Go HTTP / gRPC route registration: net/http (incl. Go 1.22 `"GET /x/{id}"` patterns), Gin, Echo, Chi,
 * gorilla/mux, `pb.RegisterXServer(s, impl)`. Router-variable prefixes are file-local; cross-function
 * prefixes become mounts keyed by the route-owning function (resolved in `resolve-go.ts`).
 */
export class GoRoutes {
  private fw: Record<keyof typeof FW_RE, boolean> | undefined;
  /** `owner\0var` → endpoints registered on that router variable (re-prefixed by a later `Mount`). */
  private byVar = new Map<string, EndpointFact[]>();
  /** HandleFunc call start → methods from a chained gorilla `.Methods("GET", …)`. */
  private methodsOf = new Map<number, string[]>();

  constructor(private w: GoWalker) {}

  private frameworks() {
    this.fw ??= {
      gin: this.w.fileImports(FW_RE.gin),
      echo: this.w.fileImports(FW_RE.echo),
      chi: this.w.fileImports(FW_RE.chi),
      gorilla: this.w.fileImports(FW_RE.gorilla),
      nethttp: this.w.fileImports(FW_RE.nethttp),
      grpc: this.w.fileImports(FW_RE.grpc),
    };
    return this.fw;
  }

  /** URL prefix a router expression carries: a prefixed variable, `x.Group("/p")`, `x.With(mw)`, … */
  prefixOf(n: SyntaxNode | null | undefined, scope: GoScope): string {
    if (!n) return '';
    if (n.type === 'identifier') return scope.prefixes.get(n.text) ?? '';
    return this.groupPrefix(n, scope) ?? '';
  }

  /** Prefix of a router-deriving call (`Group`, `PathPrefix(…).Subrouter()`, `With`), else undefined. */
  groupPrefix(call: SyntaxNode, scope: GoScope): string | undefined {
    if (call.type !== 'call_expression') return undefined;
    const fn = field(call, 'function');
    if (fn?.type !== 'selector_expression') return undefined;
    const m = field(fn, 'field')?.text;
    const recv = field(fn, 'operand');
    const arg0 = field(call, 'arguments')?.namedChildren[0];
    const p = goString(arg0);
    const fw = this.frameworks();
    if ((m === 'Group' && (fw.gin || fw.echo)) || (m === 'PathPrefix' && fw.gorilla))
      return p !== undefined ? joinUrl(this.prefixOf(recv, scope), p) : undefined;
    if ((m === 'With' && fw.chi) || (m === 'Subrouter' && fw.gorilla)) return this.prefixOf(recv, scope);
    return undefined;
  }

  /** Detects a route registration; returns true when it visited the call's children itself. */
  route(call: SyntaxNode, scope: GoScope): boolean {
    const fn = field(call, 'function');
    const args = field(call, 'arguments')?.namedChildren ?? [];
    const chain = goChain(fn);
    const reg = chain ? /(?:^|\.)Register(\w+)Server$/.exec(chain) : null;
    if (reg && args.length === 2) {
      this.grpc(call, chain as string, reg[1], args[1], scope);
      return false;
    }
    this.passedGroups(call, args, scope);
    if (fn?.type !== 'selector_expression') return false;
    const m = field(fn, 'field')?.text ?? '';
    const recv = field(fn, 'operand');
    const fw = this.frameworks();
    if (m === 'Methods' && fw.gorilla && recv?.type === 'call_expression') {
      const ms = args.map((a) => goString(a)?.toUpperCase()).filter((x): x is string => !!x);
      if (ms.length) this.methodsOf.set(recv.startIndex, ms);
      return false;
    }
    if (fw.chi && (m === 'Route' || m === 'Group') && args.at(-1)?.type === 'func_literal')
      return this.chiSubRouter(m, args, recv, scope);
    if (m === 'Mount' && fw.chi && args.length === 2) {
      const p = goString(args[0]);
      if (p !== undefined) this.mount(joinUrl(this.prefixOf(recv, scope), p), args[1], call, scope);
      return false;
    }
    if (fw.chi && m === 'Route' && args.length === 2) {
      const p = goString(args[0]);
      if (p !== undefined) this.mount(joinUrl(this.prefixOf(recv, scope), p), args[1], call, scope);
      return false;
    }
    this.verbRoute(call, m, recv, args, scope);
    return false;
  }

  private verbRoute(call: SyntaxNode, m: string, recv: SyntaxNode | null, args: SyntaxNode[], scope: GoScope): void {
    const fw = this.frameworks();
    let method: string | undefined;
    let pathArg = 0;
    let handlerArg = -1; // last
    let framework = '';
    if ((fw.gin || fw.echo) && (VERBS.includes(m) || m === 'Any')) {
      method = m === 'Any' ? 'ANY' : m;
      framework = fw.gin ? 'gin' : 'echo';
      if (!fw.gin) handlerArg = 1; // echo: e.GET(path, h, middleware...)
    } else if ((fw.gin && m === 'Handle') || (fw.echo && m === 'Add')) {
      method = goString(args[0])?.toUpperCase();
      pathArg = 1;
      framework = fw.gin ? 'gin' : 'echo';
      if (!fw.gin) handlerArg = 2;
    } else if (fw.chi && CHI_VERBS.has(m)) {
      method = CHI_VERBS.get(m);
      framework = 'chi';
    } else if (fw.chi && (m === 'Method' || m === 'MethodFunc')) {
      method = goString(args[0])?.toUpperCase();
      pathArg = 1;
      framework = 'chi';
    } else if ((m === 'Handle' || m === 'HandleFunc') && (fw.nethttp || fw.chi || fw.gorilla)) {
      method = 'ANY';
      framework = fw.chi ? 'chi' : fw.gorilla ? 'gorilla' : 'net/http';
      handlerArg = 1;
    }
    if (!method || args.length < pathArg + 2) return;
    let path = goString(args[pathArg]);
    if (path === undefined) return;
    if (handlerArg === 1 && method === 'ANY' && (/^[A-Z]+\s+\S*\//.test(path) || recv?.text === 'http'))
      framework = 'net/http';
    if (framework === 'net/http') {
      // Go 1.22 patterns: "[METHOD ][HOST]/path"
      const pm = /^([A-Z]+)\s+(.*)$/.exec(path);
      if (pm) {
        method = pm[1];
        path = pm[2];
      }
      const slash = path.indexOf('/');
      if (slash < 0) return;
      path = path.slice(slash);
    }
    if (!path.startsWith('/')) return;
    const full = joinUrl(this.prefixOf(recv, scope), path);
    const h = args.at(handlerArg) as SyntaxNode;
    // net/http: mux.Handle("/api/", http.StripPrefix("/api", sub)) mounts a sub-mux
    if ((m === 'Handle' || m === 'Mount') && this.mountVar(h, full, scope)) return;
    const methods = this.methodsOf.get(call.startIndex) ?? [method];
    for (const verb of methods) {
      const handlerRef = this.handlerRef(h, `${verb} ${full}`, scope);
      const ep: EndpointFact = {
        method: verb,
        path: full,
        framework,
        handlerRef,
        enclosingQname: scope.qname,
        receiver: scope.owner,
        span: spanOf(call, this.w.ctx.path),
      };
      this.w.facts.endpoints.push(ep);
      if (recv?.type === 'identifier') {
        const key = `${scope.owner}\0${recv.text}`;
        this.byVar.set(key, [...(this.byVar.get(key) ?? []), ep]);
      }
    }
  }

  /** chi `r.Route("/p", func(r chi.Router) {…})` / `r.Group(func(r chi.Router) {…})`. */
  private chiSubRouter(m: string, args: SyntaxNode[], recv: SyntaxNode | null, scope: GoScope): boolean {
    const fnLit = args.at(-1) as SyntaxNode;
    const p = m === 'Route' ? goString(args[0]) : '';
    if (p === undefined) return false;
    const prefix = joinUrl(this.prefixOf(recv, scope), p);
    const prefixes = new Map(scope.prefixes);
    const param = field(fnLit, 'parameters')?.namedChildren[0];
    const pn = param?.namedChildren.find((c) => c.type === 'identifier')?.text;
    if (pn) prefixes.set(pn, prefix);
    const inner: GoScope = { ...scope, prefixes };
    if (recv) this.w.visit(recv, scope);
    for (const a of args.slice(0, -1)) this.w.visit(a, scope);
    const body = field(fnLit, 'body');
    if (body) this.w.visit(body, inner);
    return true;
  }

  /** `r.Mount("/p", sub)`: a local router variable is re-prefixed; a call becomes a cross-function mount. */
  private mount(prefix: string, target: SyntaxNode, call: SyntaxNode, scope: GoScope): void {
    if (this.mountVar(target, prefix, scope)) return;
    const t = target.type === 'call_expression' ? goChain(field(target, 'function')) : goChain(target);
    if (t)
      (this.w.facts.mounts ??= []).push({
        prefix,
        target: t,
        parent: scope.owner,
        framework: 'chi',
        span: spanOf(call, this.w.ctx.path),
      });
  }

  private mountVar(h: SyntaxNode | undefined, prefix: string, scope: GoScope): boolean {
    if (!h) return false;
    let target = h;
    let full = prefix;
    // http.StripPrefix("/api", sub): sub's routes are served under the stripped prefix
    if (h.type === 'call_expression' && /(^|\.)StripPrefix$/.test(goChain(field(h, 'function')) ?? '')) {
      const a = field(h, 'arguments')?.namedChildren ?? [];
      const sp = goString(a[0]);
      if (sp === undefined || !a[1]) return false;
      target = a[1];
      full = sp;
    }
    if (target.type !== 'identifier') return false;
    const eps = this.byVar.get(`${scope.owner}\0${target.text}`);
    if (!eps && h === target) return false;
    for (const ep of eps ?? []) ep.path = joinUrl(full, ep.path);
    scope.prefixes.set(target.text, joinUrl(full, scope.prefixes.get(target.text) ?? ''));
    return true;
  }

  /** `routes.Register(v1)`: a prefixed router passed to a function mounts that function's routes. */
  private passedGroups(call: SyntaxNode, args: SyntaxNode[], scope: GoScope): void {
    const callee = goChain(field(call, 'function'));
    if (!callee) return;
    for (const a of args) {
      const prefix = a.type === 'identifier' ? scope.prefixes.get(a.text) : this.groupPrefix(a, scope);
      if (prefix)
        (this.w.facts.mounts ??= []).push({
          prefix,
          target: callee,
          parent: scope.owner,
          span: spanOf(call, this.w.ctx.path),
        });
    }
  }

  private handlerRef(h: SyntaxNode | undefined, name: string, scope: GoScope): string | undefined {
    if (!h) return undefined;
    if (h.type === 'func_literal') return this.w.inlineHandler(h, name, scope);
    const chain = goChain(h);
    if (chain) return chain;
    if (h.type === 'unary_expression' && h.text.startsWith('&')) h = field(h, 'operand') ?? h;
    if (h.type === 'composite_literal') {
      const t = goTypeRef(field(h, 'type'));
      return t ? `${t}.ServeHTTP` : undefined;
    }
    // http.HandlerFunc(h) conversion
    if (h.type === 'call_expression' && /(^|\.)HandlerFunc$/.test(goChain(field(h, 'function')) ?? ''))
      return this.handlerRef(field(h, 'arguments')?.namedChildren[0], name, scope);
    return undefined;
  }

  /** `pb.RegisterGreeterServer(s, &server{})` → one endpoint per service (expanded per method in resolve). */
  private grpc(call: SyntaxNode, chain: string, svc: string, impl: SyntaxNode, scope: GoScope): void {
    const head = chain.includes('.') ? chain.slice(0, chain.lastIndexOf('.') + 1) : '';
    if (!this.frameworks().grpc && !head) return;
    let n = impl;
    if (n.type === 'unary_expression' && n.text.startsWith('&')) n = field(n, 'operand') ?? n;
    let handlerRef: string | undefined;
    if (n.type === 'composite_literal') handlerRef = goTypeRef(field(n, 'type'));
    else if (n.type === 'call_expression') {
      const c = goChain(field(n, 'function'));
      handlerRef = c === 'new' ? goTypeRef(field(n, 'arguments')?.namedChildren[0]) : c && `${c}()`;
    } else handlerRef = goChain(n);
    this.w.facts.endpoints.push({
      method: 'GRPC',
      path: `/${svc}`,
      framework: 'grpc',
      handlerRef,
      enclosingQname: scope.qname,
      // gRPC: `receiver` names the generated service interface (`pb.GreeterServer`)
      receiver: `${head}${svc}Server`,
      span: spanOf(call, this.w.ctx.path),
    });
  }

  /** Generated `grpc.ServiceDesc{ServiceName: "pkg.Svc", HandlerType: (*SvcServer)(nil)}`. */
  serviceDesc(desc: SyntaxNode): void {
    let name: string | undefined;
    let handler: string | undefined;
    for (const kv of field(desc, 'body')?.namedChildren ?? []) {
      if (kv.type !== 'keyed_element') continue;
      const [k, v] = kv.namedChildren;
      if (k?.text === 'ServiceName') name = goString(v?.namedChildren[0] ?? v);
      if (k?.text === 'HandlerType') handler = /\*\s*(\w+)\s*\)/.exec(v?.text ?? '')?.[1];
    }
    if (!name || !handler) return;
    const map = (this.w.facts.hints.grpcServices ??= {}) as Record<string, string>;
    map[handler] = name;
  }
}
