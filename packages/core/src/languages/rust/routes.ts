import type { SyntaxNode } from '../../parse/parser.js';
import { field } from '../../parse/parser.js';
import { joinUrl } from '../go/routes.js';
import { type EndpointFact, spanOf } from '../types.js';
import type { RustScope, RustWalker } from './extractor.js';
import { rustPath, rustString } from './extractor.js';

const VERBS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options', 'trace', 'connect'];
const AXUM_VERBS = new Set([...VERBS, 'any']);

const lastSeg = (n: SyntaxNode) => rustPath(n).split('::').pop() ?? '';
const argsOf = (call: SyntaxNode) => field(call, 'arguments')?.namedChildren ?? [];

/**
 * Axum (`Router::new().route("/x", get(h).post(h2))`, `.nest`, `.merge`), Actix (`#[get("/x")]`,
 * `web::scope`, `web::resource`, `.route(path, web::get().to(h))`, `.service`, `.configure`) and Rocket
 * (`#[get("/x")]`, `.mount("/p", routes![…])`). In-function prefixes are applied here; prefixes across
 * functions become mounts keyed by the route-owning function (resolved in `resolve-rust.ts`).
 */
export class RustRoutes {
  private fw: { axum: boolean; actix: boolean; rocket: boolean } | undefined;
  /** `owner\0var` → endpoints built into a `let` router variable (re-prefixed by a later `.nest`). */
  private byVar = new Map<string, EndpointFact[]>();
  private currentVar: string | undefined;

  constructor(private w: RustWalker) {}

  private frameworks() {
    if (this.fw) return this.fw;
    const own = {
      axum: this.w.importsCrate('axum'),
      actix: this.w.importsCrate('actix_web'),
      rocket: this.w.importsCrate('rocket'),
    };
    // a file's own imports decide; the crate's dependencies only when the file names none
    const fws = this.w.ctx.frameworks;
    this.fw =
      own.axum || own.actix || own.rocket
        ? own
        : { axum: fws.has('axum'), actix: fws.has('actix'), rocket: fws.has('rocket') };
    return this.fw;
  }

  withVar(name: string | undefined, scope: RustScope, visit: () => void): void {
    const prev = this.currentVar;
    this.currentVar = name && `${scope.owner}\0${name}`;
    visit();
    this.currentVar = prev;
  }

  private emit(
    method: string,
    path: string,
    h: SyntaxNode | undefined,
    call: SyntaxNode,
    scope: RustScope,
    fw: string,
  ) {
    const ep: EndpointFact = {
      method,
      path,
      framework: fw,
      handlerRef: this.handlerRef(h, `${method} ${path}`, scope),
      enclosingQname: scope.qname,
      receiver: scope.owner,
      span: spanOf(call, this.w.ctx.path),
    };
    this.w.facts.endpoints.push(ep);
    if (this.currentVar) this.byVar.set(this.currentVar, [...(this.byVar.get(this.currentVar) ?? []), ep]);
  }

  private handlerRef(h: SyntaxNode | undefined, name: string, scope: RustScope): string | undefined {
    if (h?.type === 'generic_function') h = field(h, 'function') ?? undefined; // `handler::<Repo>`
    if (!h) return undefined;
    if (h.type === 'identifier' || h.type === 'scoped_identifier') return rustPath(h);
    if (h.type === 'closure_expression') return this.w.inlineHandler(h, name, scope);
    return undefined;
  }

  /** `#[get("/x")]` / `#[route("/x", method = "GET", method = "POST")]` on a function. */
  attrRoutes(attrs: SyntaxNode[], qname: string): void {
    const fw = this.frameworks();
    if (!fw.actix && !fw.rocket) return;
    for (const a of attrs) {
      const attr = a.namedChildren[0];
      const nameNode = attr?.namedChildren[0];
      const tt = attr ? field(attr, 'arguments') : null;
      if (!nameNode || !tt) continue;
      const name = lastSeg(nameNode);
      const path = rustString(tt.namedChildren.find((c) => c.type === 'string_literal'));
      if (path === undefined || !path.startsWith('/')) continue;
      const methods =
        name === 'route'
          ? [...tt.text.matchAll(/method\s*=\s*"(\w+)"/g)].map((m) => m[1].toUpperCase())
          : VERBS.includes(name)
            ? [name.toUpperCase()]
            : [];
      for (const method of methods)
        this.w.facts.endpoints.push({
          method,
          path,
          framework: fw.rocket && !fw.actix ? 'rocket' : 'actix',
          handlerRef: qname,
          enclosingQname: qname,
          receiver: qname, // `.service(handler)` mounts key on the handler itself
          span: spanOf(a, this.w.ctx.path),
        });
    }
  }

  /** Detects route registration on a method call; returns true when it visited the children itself. */
  route(call: SyntaxNode, scope: RustScope): boolean {
    const fn = field(call, 'function');
    if (fn?.type !== 'field_expression') return false;
    const fw = this.frameworks();
    if (!fw.axum && !fw.actix && !fw.rocket) return false;
    const m = field(fn, 'field')?.text ?? '';
    const recv = field(fn, 'value');
    const args = argsOf(call);
    const scoped = joinUrl(scope.prefix, chainPath(recv, 'scope') ?? '');
    const label = fw.actix ? 'actix' : 'axum';
    if (m === 'route' && args.length === 2) {
      const p = rustString(args[0]);
      if (p === undefined) return false;
      for (const r of methodRouter(args[1])) this.emit(r.verb, joinUrl(scoped, p), r.h, call, scope, label);
      return false;
    }
    const resource = chainPath(recv, 'resource');
    if (resource !== undefined && (m === 'route' || m === 'to') && args.length === 1) {
      const path = joinUrl(scoped, resource);
      const rs = m === 'to' ? [{ verb: 'ANY', h: args[0] }] : methodRouter(args[0]);
      for (const r of rs) this.emit(r.verb, path, r.h, call, scope, 'actix');
      return false;
    }
    if (m === 'nest' && args.length === 2) {
      const p = rustString(args[0]);
      if (p === undefined) return false;
      const prefix = joinUrl(scoped, p);
      this.mountTarget(args[1], prefix, call, scope);
      if (recv) this.w.visit(recv, scope);
      this.w.visit(args[1], { ...scope, prefix });
      return true;
    }
    if ((m === 'merge' || m === 'service' || m === 'configure') && args.length === 1) {
      if (args[0].type === 'identifier' || args[0].type === 'scoped_identifier') {
        this.mount(rustPath(args[0]), scoped, call, scope);
        return false;
      }
      if (m === 'merge') this.mountTarget(args[0], scoped, call, scope);
    }
    if (m === 'mount' && fw.rocket && args.length === 2) {
      const p = rustString(args[0]);
      const mac = args[1];
      if (p !== undefined && mac.type === 'macro_invocation' && lastSeg(field(mac, 'macro') ?? mac) === 'routes')
        for (const id of mac.namedChildren.at(-1)?.namedChildren ?? [])
          if (id.type === 'identifier') this.mount(id.text, joinUrl(scoped, p), call, scope);
      return false;
    }
    if (scoped !== scope.prefix) {
      // a call on a `web::scope("/p")` chain: its arguments (services, resources) live under the prefix
      if (recv) this.w.visit(recv, scope);
      for (const a of args) this.w.visit(a, { ...scope, prefix: scoped });
      return true;
    }
    return false;
  }

  /** `.nest("/p", x)`: a local router variable is re-prefixed; a function call becomes a mount. */
  private mountTarget(t: SyntaxNode, prefix: string, call: SyntaxNode, scope: RustScope): void {
    if (t.type === 'identifier') {
      const eps = this.byVar.get(`${scope.owner}\0${t.text}`);
      for (const ep of eps ?? []) ep.path = joinUrl(prefix, ep.path);
      if (eps) return;
    }
    const target = t.type === 'call_expression' ? field(t, 'function') : t;
    if (target && (target.type === 'identifier' || target.type === 'scoped_identifier'))
      this.mount(rustPath(target), prefix, call, scope);
  }

  private mount(target: string, prefix: string, call: SyntaxNode, scope: RustScope): void {
    (this.w.facts.mounts ??= []).push({
      prefix,
      target,
      parent: scope.owner,
      span: spanOf(call, this.w.ctx.path),
    });
  }
}

/** Path of the `scope("/p")` / `resource("/p")` call a method chain starts from. */
function chainPath(n: SyntaxNode | null, fnName: string): string | undefined {
  while (n?.type === 'call_expression') {
    const fn = field(n, 'function');
    if (!fn) return undefined;
    if ((fn.type === 'scoped_identifier' || fn.type === 'identifier') && lastSeg(fn) === fnName)
      return rustString(argsOf(n)[0]);
    if (fn.type !== 'field_expression') return undefined;
    n = field(fn, 'value');
  }
  return undefined;
}

/** `get(h).post(h2)`, `routing::get(h)`, `web::get().to(h)`, `web::route().to(h)` → verb + handler. */
function methodRouter(n: SyntaxNode | null): { verb: string; h?: SyntaxNode }[] {
  if (n?.type !== 'call_expression') return [];
  const fn = field(n, 'function');
  const args = argsOf(n);
  if (!fn) return [];
  if (fn.type === 'identifier' || fn.type === 'scoped_identifier') {
    const v = lastSeg(fn);
    return AXUM_VERBS.has(v) && args.length === 1 ? [{ verb: v === 'any' ? 'ANY' : v.toUpperCase(), h: args[0] }] : [];
  }
  if (fn.type !== 'field_expression') return [];
  const f = field(fn, 'field')?.text ?? '';
  const val = field(fn, 'value');
  if (AXUM_VERBS.has(f) && args.length === 1)
    return [...methodRouter(val), { verb: f === 'any' ? 'ANY' : f.toUpperCase(), h: args[0] }];
  if (f === 'to' && val?.type === 'call_expression') {
    const vf = field(val, 'function');
    const v = vf && vf.type !== 'field_expression' ? lastSeg(vf) : '';
    return [{ verb: VERBS.includes(v) ? v.toUpperCase() : 'ANY', h: args[0] }];
  }
  return methodRouter(val);
}
