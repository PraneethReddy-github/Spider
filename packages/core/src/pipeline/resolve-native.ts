import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';
import { joinUrl } from '../languages/go/routes.js';
import type { EndpointFact } from '../languages/types.js';
import type { Discovery } from './discover.js';
import { goLang } from './resolve-go.js';
import { rustLang } from './resolve-rust.js';
import type { Binding, FileTable, ResolveStats, SymbolEntry } from './resolve.js';

/**
 * Shared resolution engine for languages with package/module scoping and explicit types (Go, Rust).
 * Languages supply name/path lookup (`NativeLang`); the engine types receivers from bindings, walks
 * struct fields, binds methods (own, else embedded / trait-default at 0.9) and resolves endpoints.
 * No name-based guessing: an edge exists only when the target is bound through scope or types.
 */

export interface Sym {
  table: FileTable;
  entry: SymbolEntry;
}

export type Res = { kind: 'sym'; sym: Sym; conf: number } | { kind: 'ext' } | { kind: 'missing' } | undefined;

export interface NativeLang {
  /** Resolves a type / function / variable reference as written in `table` at `scope` (enclosing qname). */
  ref(table: FileTable, ref: string, scope?: string): Res;
  /** Resolves the head of a value chain that is not a local binding; `used` = segments consumed. */
  head(table: FileTable, segs: string[], scope?: string): { res: Res; used: number };
  /** A callee resolved as a path by `ref` (not a value chain). */
  isPath(callee: string): boolean;
  /** Module resolution, import edges, method tables and inheritance; runs before calls. */
  prepare(): void;
  /** Runs after calls / references / endpoints (e.g. Go import edges to the files actually used). */
  finish?(): void;
  /** Fully qualified gRPC service name for a generated service interface. */
  grpcServiceName?(iface: Sym): string | undefined;
}

type Emit = (
  g: GraphBuilder,
  table: FileTable,
  ep: EndpointFact,
  method: string,
  path: string,
  handler: { id: string; confidence: number }[],
) => void;

const NATIVE = new Set(['go', 'rust']);

/** Removes Go/Rust files from the generic resolver's tables and resolves them here. */
export function resolveNative(
  g: GraphBuilder,
  d: Discovery,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
  stats: ResolveStats,
  emit: Emit,
): void {
  const byLang = new Map<string, Map<string, FileTable>>();
  for (const [p, t] of tables) {
    if (!NATIVE.has(t.facts.language)) continue;
    tables.delete(p);
    const m = byLang.get(t.facts.language) ?? new Map<string, FileTable>();
    m.set(p, t);
    byLang.set(t.facts.language, m);
  }
  if (byLang.size === 0) return;
  // the generic name fallback must never land on a Go/Rust symbol
  const nativeIds = new Set(
    [...byLang.values()].flatMap((m) => [...m.values()].flatMap((t) => [...t.own.values()].map((e) => e.id))),
  );
  for (const [k, list] of globalByName)
    globalByName.set(
      k,
      list.filter((e) => !nativeIds.has(e.id)),
    );
  for (const [lang, ts] of byLang) {
    const e = new NativeEngine(g, ts, stats);
    e.run(lang === 'go' ? goLang(e, d) : rustLang(e, d), emit);
  }
}

export class NativeEngine {
  readonly methods = new Map<string, Map<string, Sym>>();
  /** Embedded structs (Go) / implemented traits (Rust): members found there bind at 0.9. */
  readonly supers = new Map<string, Sym[]>();
  private lang!: NativeLang;

  constructor(
    readonly g: GraphBuilder,
    readonly tables: Map<string, FileTable>,
    readonly stats: ResolveStats,
  ) {}

  external(ecosystem: string, name: string): string {
    const id = ids.external(ecosystem, name);
    if (!this.g.hasNode(id))
      this.g.addNode({
        id,
        kind: 'external',
        name,
        qname: `${ecosystem}:${name}`,
        props: { ecosystem, inferred: true },
      });
    return id;
  }

  addMethod(type: Sym, name: string, m: Sym): void {
    const map = this.methods.get(type.entry.id) ?? new Map<string, Sym>();
    if (!map.has(name)) map.set(name, m);
    this.methods.set(type.entry.id, map);
  }

  addSuper(type: Sym, sup: Sym): void {
    const list = this.supers.get(type.entry.id) ?? [];
    if (!list.some((s) => s.entry.id === sup.entry.id)) list.push(sup);
    this.supers.set(type.entry.id, list);
  }

  member(type: Sym, name: string, depth = 0): Res {
    const own = this.methods.get(type.entry.id)?.get(name);
    if (own) return { kind: 'sym', sym: own, conf: depth === 0 ? 1 : 0.9 };
    if (depth > 3) return undefined;
    for (const s of this.supers.get(type.entry.id) ?? []) {
      const r = this.member(s, name, depth + 1);
      if (r) return r;
    }
    return undefined;
  }

  /** Binding of `name` visible at `scope`: enclosing functions outward (struct field scopes skipped), then file. */
  findBinding(table: FileTable, name: string, scope?: string): Binding | undefined {
    let s = scope;
    for (let i = 0; s !== undefined && i < 20; i++) {
      const e = table.own.get(s);
      if (e?.decl.kind !== 'class') {
        const b = table.bindings.get(s)?.get(name);
        if (b) return b;
      }
      s = e?.decl.parentQname;
    }
    return table.bindings.get('')?.get(name);
  }

  /** The type a binding holds: annotation / literal type, or the declared return type of the call. */
  typeOf(table: FileTable, b: Binding, depth = 0): Sym | 'ext' | undefined {
    if (depth > 5) return undefined;
    const scope = b.scope || undefined;
    if (b.isType || b.isNew) return this.asType(this.lang.ref(table, b.ref, scope));
    const r = this.resolve(table, b.ref, scope, depth + 1);
    if (r?.kind === 'ext') return 'ext';
    if (r?.kind !== 'sym' || r.conf < 1) return undefined;
    const fn = r.sym.entry.decl;
    if (fn.kind === 'class') return r.sym;
    if (!fn.returns || (fn.kind !== 'function' && fn.kind !== 'method')) return undefined;
    return this.asType(this.lang.ref(r.sym.table, fn.returns, fn.qname));
  }

  private asType(r: Res): Sym | 'ext' | undefined {
    if (r?.kind === 'ext') return 'ext';
    return r?.kind === 'sym' && r.conf === 1 && r.sym.entry.decl.kind === 'class' ? r.sym : undefined;
  }

  /** Type of a package-level variable / static. */
  private typeOfVar(v: Sym, depth: number): Sym | 'ext' | undefined {
    const b = v.table.bindings.get('')?.get(v.entry.decl.qname);
    return b ? this.typeOf(v.table, b, depth + 1) : undefined;
  }

  /** Resolves a callee / handler reference: a path (`pkg.Fn`, `a::b::f`) or a typed value chain (`s.repo.Find`). */
  resolve(table: FileTable, callee: string, scope?: string, depth = 0): Res {
    if (depth > 6) return undefined;
    if (this.lang.isPath(callee)) return this.lang.ref(table, callee, scope);
    const segs = callee.split('.');
    let cur: Sym | 'ext' | undefined;
    let i = 1;
    const b = this.findBinding(table, segs[0], scope);
    if (b) cur = this.typeOf(table, b, depth);
    else {
      const h = this.lang.head(table, segs, scope);
      if (h.used >= segs.length || h.res?.kind !== 'sym') return h.res;
      i = h.used;
      const kind = h.res.sym.entry.decl.kind;
      cur = kind === 'variable' ? this.typeOfVar(h.res.sym, depth) : kind === 'class' ? h.res.sym : undefined;
    }
    for (; cur && cur !== 'ext' && i < segs.length - 1; i++) {
      const fb = cur.table.bindings.get(cur.entry.decl.qname)?.get(segs[i]);
      cur = fb ? this.typeOf(cur.table, fb, depth + 1) : undefined;
    }
    if (cur === 'ext') return { kind: 'ext' };
    return cur ? this.member(cur, segs[segs.length - 1]) : undefined;
  }

  run(lang: NativeLang, emit: Emit): void {
    this.lang = lang;
    lang.prepare();
    for (const table of this.tables.values()) {
      this.calls(table);
      this.references(table);
    }
    this.endpoints(emit);
    lang.finish?.();
  }

  private ownerId(table: FileTable, qname?: string): string {
    return (qname && table.own.get(qname)?.id) || table.fileId;
  }

  private calls(table: FileTable): void {
    for (const call of table.facts.calls) {
      const r = this.resolve(table, call.callee, call.callerQname);
      if (r?.kind === 'ext') this.stats.externalCalls++;
      else if (r?.kind === 'missing') this.stats.unresolvedCalls++;
      if (r?.kind !== 'sym') continue;
      const kind = r.sym.entry.decl.kind;
      // `T(x)` is a conversion and `x()` a call through a func-typed variable: no edge
      const edge =
        kind === 'class' ? (call.isNew ? 'instantiates' : undefined) : kind === 'variable' ? undefined : 'calls';
      if (!edge) continue;
      this.stats.resolvedCalls++;
      this.g.addEdge(edge, this.ownerId(table, call.callerQname), r.sym.entry.id, {
        confidence: r.conf,
        evidence: call.span,
        props: r.conf < 1 ? { ambiguous: true } : undefined,
      });
    }
  }

  private references(table: FileTable): void {
    for (const ref of table.facts.references ?? []) {
      const r = this.lang.ref(table, ref.name, ref.scopeQname);
      const src = this.ownerId(table, ref.scopeQname);
      if (r?.kind !== 'sym' || r.conf < 1 || r.sym.entry.id === src) continue;
      this.g.addEdge('references', src, r.sym.entry.id, { evidence: ref.span });
    }
  }

  /** Function symbol id → mounts placing its routes under a prefix (inside another route-owning function). */
  private mounts(): (key: string | undefined) => string[] {
    const mountsOf = new Map<string, { parent?: string; prefix: string }[]>();
    for (const table of this.tables.values())
      for (const m of table.facts.mounts ?? []) {
        const r = this.resolve(table, m.target, m.parent);
        if (r?.kind !== 'sym' || r.conf < 1) continue;
        const list = mountsOf.get(r.sym.entry.id) ?? [];
        list.push({ parent: m.parent ? table.own.get(m.parent)?.id : undefined, prefix: m.prefix });
        mountsOf.set(r.sym.entry.id, list);
      }
    const prefixesOf = (key: string | undefined, depth: number): string[] => {
      const ms = key ? mountsOf.get(key) : undefined;
      if (!ms || depth > 6) return [''];
      const out = new Set<string>();
      for (const m of ms)
        for (const pp of m.parent ? prefixesOf(m.parent, depth + 1) : ['']) out.add(joinUrl(pp, m.prefix));
      return [...out].slice(0, 8);
    };
    return (key) => prefixesOf(key, 0);
  }

  private endpoints(emit: Emit): void {
    const prefixesOf = this.mounts();
    for (const table of this.tables.values()) {
      for (const ep of table.facts.endpoints) {
        if (ep.framework === 'grpc') {
          this.grpc(table, ep, emit);
          continue;
        }
        const handler = this.handler(table, ep);
        const key = ep.receiver ? table.own.get(ep.receiver)?.id : undefined;
        for (const p of prefixesOf(key)) {
          const path = joinUrl(p, ep.path);
          emit(this.g, table, ep, ep.method, path.startsWith('/') ? path : `/${path}`, handler);
        }
      }
    }
  }

  private handler(table: FileTable, ep: EndpointFact): { id: string; confidence: number }[] {
    if (!ep.handlerRef) return [];
    // synthetic inline handlers and attribute-routed functions (`#[get]`) are own declarations
    const direct = table.own.get(ep.handlerRef);
    if (direct) return [{ id: direct.id, confidence: 1 }];
    const r = this.resolve(table, ep.handlerRef, ep.enclosingQname);
    const kind = r?.kind === 'sym' ? r.sym.entry.decl.kind : undefined;
    return r?.kind === 'sym' && (kind === 'function' || kind === 'method')
      ? [{ id: r.sym.entry.id, confidence: r.conf }]
      : [];
  }

  /** `RegisterXServer(s, impl)`: one endpoint per method of the generated `XServer` interface when it is in the repo. */
  private grpc(table: FileTable, ep: EndpointFact, emit: Emit): void {
    const iface = this.asType(ep.receiver ? this.lang.ref(table, ep.receiver, ep.enclosingQname) : undefined);
    let impl: Sym | 'ext' | undefined;
    const ref = ep.handlerRef;
    if (ref?.endsWith('()'))
      impl = this.typeOf(table, { ref: ref.slice(0, -2), isNew: false, scope: ep.enclosingQname ?? '' });
    else if (ref) {
      const b = this.findBinding(table, ref, ep.enclosingQname);
      impl = b ? this.typeOf(table, b) : this.asType(this.lang.ref(table, ref, ep.enclosingQname));
    }
    const implSym = impl === 'ext' ? undefined : impl;
    const svc = ep.path.slice(1);
    const full = (iface !== 'ext' && iface && this.lang.grpcServiceName?.(iface)) || svc;
    const methods =
      iface && iface !== 'ext'
        ? [...(this.methods.get(iface.entry.id)?.entries() ?? [])].filter(([n]) => !n.startsWith('mustEmbed'))
        : [];
    const mark = (path: string) => {
      const node = this.g.getNode(ids.endpoint(table.path, 'GRPC', path, ep.span.startLine));
      if (node) node.props.protocol = 'grpc';
    };
    if (methods.length === 0) {
      emit(this.g, table, ep, 'GRPC', `/${full}`, implSym ? [{ id: implSym.entry.id, confidence: 1 }] : []);
      mark(`/${full}`);
      return;
    }
    for (const [name, m] of methods) {
      const own = implSym ? this.member(implSym, name) : undefined;
      const h = own?.kind === 'sym' ? own : { sym: m, conf: 1 };
      const path = `/${full}/${name}`;
      emit(this.g, table, ep, 'GRPC', path, [{ id: h.sym.entry.id, confidence: h.conf }]);
      mark(path);
    }
  }
}
