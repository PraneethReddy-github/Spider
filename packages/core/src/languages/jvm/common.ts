import type { SyntaxNode } from '../../parse/parser.js';
import { callArgs } from '../args.js';
import { type BindingFact, type DeclFact, type ExtractContext, type FileFacts, countLoc, spanOf } from '../types.js';

/**
 * Fact collection shared by the Java, Kotlin and C# extractors (statically typed, class-based languages).
 *
 * Conventions every one of them follows (the resolvers in `pipeline/resolve-jvm.ts` and
 * `pipeline/resolve-csharp.ts` rely on them):
 * - imports: `specifier` is the full dotted name; `names` is `[{imported:'*'}]` for a wildcard / namespace /
 *   static-on-demand import, else one name (the last segment, or the alias as `local`);
 * - `hints.packages`: the packages / namespaces the file declares types in;
 *   `hints.packageOf`: top-level decl name → its package / namespace;
 * - constructors are methods named `constructor`; overloads get `#2`, `#3` qnames (first overload keeps the name);
 * - fields and properties are bindings `x` and `this.x` in the class scope (`isType`), params and typed locals
 *   are bindings in the method scope.
 */
export class FactBuilder {
  readonly facts: FileFacts;
  private qnames = new Map<string, number>();
  private refSeen = new Set<string>();
  private packageOf: Record<string, string> = {};
  private packages = new Set<string>();

  constructor(readonly ctx: ExtractContext) {
    this.facts = {
      path: ctx.path,
      language: ctx.language,
      loc: countLoc(ctx.source),
      decls: [],
      imports: [],
      exports: [],
      calls: [],
      endpoints: [],
      bindings: [],
      references: [],
      mounts: [],
      routers: [],
      hints: {},
    };
  }

  /** `Cls.m` → `Cls.m`, then `Cls.m#2`, `Cls.m#3` for overloads. */
  uniqueQname(q: string): string {
    const n = this.qnames.get(q) ?? 0;
    this.qnames.set(q, n + 1);
    return n === 0 ? q : `${q}#${n + 1}`;
  }

  decl(d: DeclFact, pkg?: string): void {
    this.facts.decls.push(d);
    if (!d.parentQname && pkg !== undefined) {
      this.packageOf[d.name] = pkg;
      this.packages.add(pkg);
    }
  }

  declarePackage(pkg: string): void {
    this.packages.add(pkg);
  }

  imp(specifier: string, n: SyntaxNode, opts: { wildcard?: boolean; alias?: string } = {}): void {
    const last = specifier.split('.').pop() ?? specifier;
    this.facts.imports.push({
      specifier,
      names: opts.wildcard ? [{ imported: '*', local: '*' }] : [{ imported: last, local: opts.alias ?? last }],
      span: this.span(n),
    });
  }

  call(callee: string | undefined, callerQname: string | undefined, n: SyntaxNode, argCount: number, isNew = false) {
    if (!callee) return;
    const segs = callee.split('.');
    if (segs.length > 4) return; // long chains are package-qualified names or fluent builders
    this.facts.calls.push({
      callee,
      callerQname,
      isNew: isNew || undefined,
      argCount,
      span: this.span(n),
      ...callArgs(n),
    });
  }

  /** A type / annotation name used inside `scope` (→ `references`, exact bindings only). */
  ref(name: string | undefined, scope: string | undefined, n: SyntaxNode): void {
    if (!name || PRIMITIVES.has(name)) return;
    const key = `${scope ?? ''}|${name}`;
    if (this.refSeen.has(key)) return;
    this.refSeen.add(key);
    this.facts.references?.push({ name, scopeQname: scope, span: this.span(n) });
  }

  bind(name: string, scope: string | undefined, ref: string | undefined, opts: Partial<BindingFact> = {}): void {
    if (!ref || PRIMITIVES.has(ref)) return;
    this.facts.bindings.push({ name, scopeQname: scope, ref, isNew: false, ...opts });
  }

  /** Field / property: reachable as `x` and `this.x` from the class's methods. */
  field(name: string, cls: string, type: string | undefined, isType = true): void {
    this.bind(name, cls, type, { isType: isType || undefined });
    this.bind(`this.${name}`, cls, type, { isType: isType || undefined });
  }

  span(n: SyntaxNode) {
    return spanOf(n, this.ctx.path);
  }

  finish(): FileFacts {
    this.facts.hints.packages = [...this.packages];
    this.facts.hints.packageOf = this.packageOf;
    return this.facts;
  }
}

export const PRIMITIVES = new Set([
  'var',
  'val',
  'void',
  'int',
  'long',
  'short',
  'byte',
  'char',
  'boolean',
  'bool',
  'float',
  'double',
  'decimal',
  'string',
  'object',
  'dynamic',
  'uint',
  'ulong',
  'ushort',
  'sbyte',
  'nint',
  'nuint',
  'Unit',
  'Any',
  'Nothing',
]);

/** Head type name of a type's source text: `List<Owner>` → `List`, `Foo?` → `Foo`, `a.b.C` kept, arrays dropped. */
export function typeHead(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let t = text.replace(/\s+/g, '');
  if (t.endsWith('[]') || t.startsWith('(') || t.includes('->')) return undefined;
  const lt = t.indexOf('<');
  if (lt >= 0) t = t.slice(0, lt);
  t = t.replace(/[?!]+$/, '').replace(/^global::/, '');
  if (!/^[A-Za-z_][\w.]*$/.test(t) || PRIMITIVES.has(t)) return undefined;
  return t;
}

export function locOf(n: SyntaxNode): number {
  return n.endPosition.row - n.startPosition.row + 1;
}

/** Joins two route segments: `/api` + `{id}` → `/api/{id}`; empty parts are skipped. */
export function joinRoute(a: string, b: string): string {
  if (!b) return a;
  if (!a) return b;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}

export function withSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

/* ---------- Spring (Java + Kotlin) ---------- */

/** A parsed annotation / attribute: positional and named arguments as strings (literals, or `Enum.CONST` → `CONST`). */
export interface Annotation {
  name: string;
  positional: string[][];
  named: Record<string, string[]>;
  node: SyntaxNode;
}

const SPRING_VERBS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

function springPaths(a: Annotation): string[] {
  const v = a.named.value ?? a.named.path ?? a.positional[0];
  return v && v.length > 0 ? v : [''];
}

/** Class-level prefixes of a Spring controller, undefined when the class is not a controller. */
export function springController(anns: Annotation[]): string[] | undefined {
  if (!anns.some((a) => a.name === 'RestController' || a.name === 'Controller')) return undefined;
  const rm = anns.find((a) => a.name === 'RequestMapping');
  return rm ? springPaths(rm) : [''];
}

/** `(method, sub-path)` pairs a handler method's mapping annotations declare. */
export function springRoutes(anns: Annotation[]): { method: string; path: string; node: SyntaxNode }[] {
  const out: { method: string; path: string; node: SyntaxNode }[] = [];
  for (const a of anns) {
    const verb = SPRING_VERBS[a.name];
    const methods = verb ? [verb] : a.name === 'RequestMapping' ? (a.named.method ?? ['ANY']) : [];
    for (const m of methods)
      for (const p of springPaths(a)) out.push({ method: m.toUpperCase(), path: p, node: a.node });
  }
  return out;
}

export function springEndpoints(b: FactBuilder, prefixes: string[], anns: Annotation[], qname: string): void {
  for (const r of springRoutes(anns))
    for (const pre of prefixes)
      b.facts.endpoints.push({
        method: r.method,
        path: withSlash(joinRoute(pre, r.path)),
        framework: 'spring',
        handlerRef: qname,
        enclosingQname: qname,
        span: b.span(r.node),
      });
}
