import type { SyntaxNode } from '../../parse/parser.js';
import { field } from '../../parse/parser.js';
import { callArgs } from '../args.js';
import {
  type DeclFact,
  type ExtractContext,
  type FileFacts,
  type LanguageExtractor,
  complexityOf,
  countLoc,
  spanOf,
} from '../types.js';
import { GoRoutes } from './routes.js';

/** Builtin functions and conversion types: never graph calls to these. */
const GO_BUILTINS = new Set(
  (
    'append cap clear close complex copy delete imag len make max min new panic print println real recover ' +
    'string int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 complex64 ' +
    'complex128 byte rune bool error any'
  ).split(' '),
);

export const isGoBuiltinType = (name: string) => GO_BUILTINS.has(name) || name === 'comparable';

/** Unquotes an interpreted or raw Go string literal. */
export function goString(n: SyntaxNode | null | undefined): string | undefined {
  if (!n || (n.type !== 'interpreted_string_literal' && n.type !== 'raw_string_literal')) return undefined;
  return n.text.slice(1, -1);
}

/** `T`, `*T`, `pkg.T`, `T[K]` → the named type; slices, maps, funcs and builtins → undefined. */
export function goTypeRef(n: SyntaxNode | null | undefined): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'pointer_type':
    case 'parenthesized_type':
      return goTypeRef(n.namedChildren[0]);
    case 'generic_type':
      return goTypeRef(field(n, 'type'));
    case 'type_identifier':
      return isGoBuiltinType(n.text) ? undefined : n.text;
    case 'qualified_type':
      return n.text.replace(/\s+/g, '');
    default:
      return undefined;
  }
}

/** Pure `a.b.c` chain of identifiers / selectors, else undefined. */
export function goChain(n: SyntaxNode | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'identifier' || n.type === 'field_identifier' || n.type === 'package_identifier') return n.text;
  if (n.type === 'selector_expression') {
    const head = goChain(field(n, 'operand'));
    const f = field(n, 'field')?.text;
    return head && f ? `${head}.${f}` : undefined;
  }
  return undefined;
}

export interface GoScope {
  /** qname of the enclosing declaration. */
  qname?: string;
  /** Top-level function the code belongs to: endpoints' route owner (mount key). */
  owner?: string;
  /** Router variable → URL prefix (`v1 := r.Group("/v1")`, chi `Route` callback params). */
  prefixes: Map<string, string>;
}

class GoWalker {
  readonly imports = new Map<string, string>(); // local alias → import path
  readonly routes: GoRoutes;
  private seenRefs = new Set<string>();
  /** func literals already visited as synthetic route handlers. */
  private inlined = new Set<number>();

  constructor(
    readonly facts: FileFacts,
    readonly ctx: ExtractContext,
  ) {
    this.routes = new GoRoutes(this);
  }

  run(root: SyntaxNode): void {
    for (const c of root.namedChildren) if (c.type === 'import_declaration') this.importDecl(c);
    for (const c of root.namedChildren) {
      switch (c.type) {
        case 'package_clause':
          this.facts.hints.goPackage = c.namedChildren[0]?.text;
          break;
        case 'function_declaration':
        case 'method_declaration':
          this.func(c);
          break;
        case 'type_declaration':
          for (const s of c.namedChildren) this.typeSpec(s);
          break;
        case 'var_declaration':
        case 'const_declaration':
          for (const s of c.namedChildren) this.varSpec(s, { prefixes: new Map() }, true);
          break;
      }
    }
  }

  private importDecl(n: SyntaxNode): void {
    const specs = n.namedChildren.flatMap((c) => (c.type === 'import_spec_list' ? c.namedChildren : [c]));
    for (const s of specs) {
      if (s.type !== 'import_spec') continue;
      const spec = goString(field(s, 'path'));
      if (!spec) continue;
      const alias = field(s, 'name')?.text;
      this.facts.imports.push({
        specifier: spec,
        names: alias === '.' ? [{ imported: '*', local: '*' }] : [],
        namespace: alias && alias !== '.' ? alias : undefined,
        span: spanOf(s, this.ctx.path),
      });
      this.imports.set(alias ?? defaultAlias(spec), spec);
    }
  }

  /** Is `alias` an import of a path matching `re` (framework gating by import, not by name)? */
  importsMatch(alias: string, re: RegExp): boolean {
    const p = this.imports.get(alias);
    return !!p && re.test(p);
  }

  fileImports(re: RegExp): boolean {
    for (const p of this.imports.values()) if (re.test(p)) return true;
    return false;
  }

  q(scope: GoScope, name: string): string {
    return scope.qname ? `${scope.qname}.${name}` : name;
  }

  ref(n: SyntaxNode | null | undefined, scopeQname: string | undefined): void {
    if (!n) return;
    const name = goTypeRef(n);
    if (name) {
      const key = `${scopeQname ?? ''}\0${name}`;
      if (!this.seenRefs.has(key)) {
        this.seenRefs.add(key);
        (this.facts.references ??= []).push({ name, scopeQname, span: spanOf(n, this.ctx.path) });
      }
    }
    for (const c of n.namedChildren) if (c.type !== 'type_identifier' || !name) this.ref(c, scopeQname);
  }

  private func(n: SyntaxNode): void {
    const name = field(n, 'name')?.text;
    if (!name) return;
    let parentQname: string | undefined;
    const bindings: { name: string; type: SyntaxNode | null }[] = [];
    if (n.type === 'method_declaration') {
      const recv = field(n, 'receiver')?.namedChildren[0];
      parentQname = goTypeRef(field(recv ?? n, 'type'));
      if (!parentQname || parentQname.includes('.')) return;
      const rn = recv ? field(recv, 'name')?.text : undefined;
      if (rn && rn !== '_') bindings.push({ name: rn, type: field(recv as SyntaxNode, 'type') });
    }
    const qname = parentQname ? `${parentQname}.${name}` : name;
    const params = field(n, 'parameters');
    const paramNames: string[] = [];
    for (const p of params?.namedChildren ?? []) {
      const names = p.namedChildren.filter((c) => c.type === 'identifier');
      for (const pn of names) {
        paramNames.push(pn.text);
        bindings.push({ name: pn.text, type: field(p, 'type') });
      }
      this.ref(field(p, 'type'), qname);
    }
    const result = field(n, 'result');
    this.ref(result, qname);
    const decl: DeclFact = {
      kind: parentQname ? 'method' : 'function',
      name,
      qname,
      parentQname,
      span: spanOf(n, this.ctx.path),
      isExported: isUpper(name),
      params: paramNames,
      signature: `${name}(${paramNames.join(', ')})`,
      complexity: complexityOf(n),
      loc: n.endPosition.row - n.startPosition.row + 1,
      returns: resultType(result),
    };
    this.facts.decls.push(decl);
    for (const b of bindings) this.typeBinding(b.name, b.type, qname);
    const body = field(n, 'body');
    if (body) this.visit(body, { qname, owner: qname, prefixes: new Map() });
  }

  private typeBinding(name: string, type: SyntaxNode | null, scopeQname: string | undefined): void {
    const ref = goTypeRef(type);
    if (ref && name !== '_') this.facts.bindings.push({ name, scopeQname, ref, isNew: true, isType: true });
  }

  private typeSpec(s: SyntaxNode): void {
    if (s.type !== 'type_spec' && s.type !== 'type_alias') return;
    const name = field(s, 'name')?.text;
    const type = field(s, 'type');
    if (!name || !type) return;
    const base = {
      name,
      qname: name,
      span: spanOf(s, this.ctx.path),
      isExported: isUpper(name),
      loc: s.endPosition.row - s.startPosition.row + 1,
    };
    if (s.type === 'type_alias' || (type.type !== 'struct_type' && type.type !== 'interface_type')) {
      this.facts.decls.push({ ...base, kind: 'type' });
      this.ref(type, name);
      return;
    }
    const extendsList: string[] = [];
    const decl: DeclFact = {
      ...base,
      kind: 'class',
      classKind: type.type === 'struct_type' ? 'struct' : 'interface',
      extends: extendsList,
    };
    this.facts.decls.push(decl);
    if (type.type === 'struct_type') {
      for (const f of type.namedChildren[0]?.namedChildren ?? []) {
        if (f.type !== 'field_declaration') continue;
        const ft = field(f, 'type');
        this.ref(ft, name);
        const names = f.namedChildren.filter((c) => c.type === 'field_identifier');
        if (names.length === 0) {
          // embedded field: promoted methods (extends) and an implicit field named after the type
          const ref = goTypeRef(ft);
          if (ref) {
            extendsList.push(ref);
            this.typeBinding(ref.split('.').pop() as string, ft, name);
          }
        }
        for (const fn of names) this.typeBinding(fn.text, ft, name);
      }
      return;
    }
    for (const m of type.namedChildren) {
      if (m.type === 'method_spec') {
        const mn = field(m, 'name')?.text;
        if (!mn) continue;
        const mq = `${name}.${mn}`;
        this.ref(field(m, 'parameters'), mq);
        this.ref(field(m, 'result'), mq);
        this.facts.decls.push({
          kind: 'method',
          name: mn,
          qname: mq,
          parentQname: name,
          span: spanOf(m, this.ctx.path),
          isExported: isUpper(mn),
          isAbstract: true,
          loc: 1,
          returns: resultType(field(m, 'result')),
        });
      } else if (m.type === 'constraint_elem' || m.type === 'type_elem') {
        const ref = goTypeRef(m.namedChildren[0]);
        if (ref && m.namedChildren.length === 1) extendsList.push(ref);
      }
    }
  }

  /** `var a, b T = …` / `x := …` — declares top-level variables, binds typed locals. */
  varSpec(s: SyntaxNode, scope: GoScope, topLevel: boolean): void {
    if (s.type !== 'var_spec' && s.type !== 'const_spec') return;
    const names = s.namedChildren.filter((c) => c.type === 'identifier');
    const type = field(s, 'type');
    const values = field(s, 'value')?.namedChildren ?? [];
    this.ref(type, scope.qname);
    names.forEach((nm, i) => {
      if (topLevel && nm.text !== '_')
        this.facts.decls.push({
          kind: 'variable',
          name: nm.text,
          qname: nm.text,
          span: spanOf(s, this.ctx.path),
          isExported: isUpper(nm.text),
          loc: 1,
        });
      if (type) this.typeBinding(nm.text, type, scope.qname);
      else if (values.length === names.length || i === 0) this.valueBinding(nm.text, values[i], scope);
    });
    for (const v of values) this.visit(v, topLevel ? { ...scope, qname: undefined } : scope);
    const desc = values.find((v) => v.type === 'composite_literal');
    if (desc && field(desc, 'type')?.text === 'grpc.ServiceDesc') this.routes.serviceDesc(desc);
  }

  /** Types a variable from its initialiser: composite literal, `new(T)`, `&T{}` or a call result. */
  valueBinding(name: string, v: SyntaxNode | undefined, scope: GoScope): void {
    if (!v || name === '_') return;
    if (v.type === 'unary_expression' && v.text.startsWith('&')) v = field(v, 'operand') ?? v;
    if (v.type === 'composite_literal') {
      const ref = goTypeRef(field(v, 'type'));
      if (ref) this.facts.bindings.push({ name, scopeQname: scope.qname, ref, isNew: true, isType: true });
      return;
    }
    if (v.type !== 'call_expression') return;
    const fn = field(v, 'function');
    const callee = goChain(fn);
    const args = field(v, 'arguments')?.namedChildren ?? [];
    if (callee === 'new') {
      const ref = goTypeRef(args[0]);
      if (ref) this.facts.bindings.push({ name, scopeQname: scope.qname, ref, isNew: true, isType: true });
      return;
    }
    const prefix = this.routes.groupPrefix(v, scope);
    if (prefix !== undefined) scope.prefixes.set(name, prefix);
    if (callee && !GO_BUILTINS.has(callee))
      this.facts.bindings.push({ name, scopeQname: scope.qname, ref: callee, isNew: false });
  }

  visit(n: SyntaxNode, scope: GoScope): void {
    switch (n.type) {
      case 'short_var_declaration': {
        const left = field(n, 'left')?.namedChildren ?? [];
        const right = field(n, 'right')?.namedChildren ?? [];
        left.forEach((l, i) => {
          if (l.type === 'identifier' && (right.length === left.length || i === 0))
            this.valueBinding(l.text, right[i], scope);
        });
        for (const r of right) this.visit(r, scope);
        return;
      }
      case 'var_declaration':
        for (const s of n.namedChildren) this.varSpec(s, scope, false);
        return;
      case 'call_expression':
        this.call(n, scope);
        if (this.routes.route(n, scope)) return;
        break;
      case 'composite_literal': {
        const ref = goTypeRef(field(n, 'type'));
        if (ref)
          this.facts.calls.push({
            callee: ref,
            callerQname: scope.qname,
            isNew: true,
            argCount: 0,
            span: spanOf(n, this.ctx.path),
          });
        break;
      }
      case 'func_literal':
        if (this.inlined.has(n.startIndex)) return;
        // closures: their calls belong to the enclosing declaration; typed params shadow nothing we track
        for (const p of field(n, 'parameters')?.namedChildren ?? [])
          for (const pn of p.namedChildren.filter((c) => c.type === 'identifier'))
            this.typeBinding(pn.text, field(p, 'type'), scope.qname);
        break;
    }
    for (const c of n.namedChildren) this.visit(c, scope);
  }

  private call(n: SyntaxNode, scope: GoScope): void {
    const callee = goChain(field(n, 'function'));
    if (!callee || GO_BUILTINS.has(callee) || callee.split('.').length > 4) return;
    this.facts.calls.push({
      callee,
      callerQname: scope.qname,
      argCount: field(n, 'arguments')?.namedChildCount ?? 0,
      span: spanOf(n, this.ctx.path),
      ...callArgs(n),
    });
  }

  /** A synthetic function for an inline route handler (`func(c *gin.Context) {…}`). */
  inlineHandler(fn: SyntaxNode, name: string, scope: GoScope): string {
    const qname = this.q(scope, name);
    this.inlined.add(fn.startIndex);
    this.facts.decls.push({
      kind: 'function',
      name,
      qname,
      parentQname: scope.qname,
      span: spanOf(fn, this.ctx.path),
      isExported: false,
      complexity: complexityOf(fn),
      loc: fn.endPosition.row - fn.startPosition.row + 1,
    });
    for (const p of field(fn, 'parameters')?.namedChildren ?? [])
      for (const pn of p.namedChildren.filter((c) => c.type === 'identifier'))
        this.typeBinding(pn.text, field(p, 'type'), qname);
    const body = field(fn, 'body');
    if (body) this.visit(body, { ...scope, qname });
    return qname;
  }
}

function isUpper(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/** First result type of a signature, unwrapped from pointers (`(*Server, error)` → `Server`). */
function resultType(r: SyntaxNode | null): string | undefined {
  if (!r) return undefined;
  if (r.type === 'parameter_list') return goTypeRef(field(r.namedChildren[0] ?? r, 'type'));
  return goTypeRef(r);
}

/** Package name guessed from an import path: `github.com/go-chi/chi/v5` → `chi`, `gopkg.in/yaml.v3` → `yaml`. */
export function defaultAlias(spec: string): string {
  const segs = spec.split('/');
  let last = segs[segs.length - 1];
  if (/^v\d+$/.test(last) && segs.length > 1) last = segs[segs.length - 2];
  return last
    .replace(/\.v\d+$/, '')
    .replace(/^go-/, '')
    .replace(/[-.]/g, '_');
}

export const goExtractor: LanguageExtractor = {
  languages: ['go'],
  extract(root: SyntaxNode, ctx: ExtractContext): FileFacts {
    const facts: FileFacts = {
      path: ctx.path,
      language: 'go',
      loc: countLoc(ctx.source),
      decls: [],
      imports: [],
      exports: [],
      calls: [],
      endpoints: [],
      bindings: [],
      references: [],
      mounts: [],
      hints: {},
    };
    new GoWalker(facts, ctx).run(root);
    for (const d of facts.decls) if (d.isExported && !d.parentQname) facts.exports.push({ name: d.name, span: d.span });
    return facts;
  },
};

export type { GoWalker };
