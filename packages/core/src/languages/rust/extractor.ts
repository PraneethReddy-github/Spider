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
import { RustRoutes } from './routes.js';

/** Prelude constructors / functions that are never repo symbols. */
const PRELUDE_CALLS = new Set(['Some', 'Ok', 'Err', 'None', 'drop', 'Box::new', 'Vec::new', 'String::from']);
/** Smart pointers / extractors that deref to (or wrap) the type that receives method calls. */
const WRAPPERS = new Set(['Box', 'Arc', 'Rc', 'Option', 'Result', 'Data', 'State', 'Extension']);

export interface RustScope {
  /** Enclosing fn qname. */
  qname?: string;
  /** Inline module prefix (`db.inner`), '' at the file's module. */
  mod: string;
  /** Enclosing impl / trait: qname base for its methods and the raw type path `Self` stands for. */
  impl?: { qname: string; raw: string };
  /** Route-owning function (mount key). */
  owner?: string;
  /** URL prefix from an enclosing axum `nest` / actix `scope`. */
  prefix: string;
}

export function rustString(n: SyntaxNode | null | undefined): string | undefined {
  if (n?.type !== 'string_literal') return undefined;
  return n.text.slice(1, -1);
}

/** Path text without generic arguments: `Vec::<u8>::new` → `Vec::new`. */
export function rustPath(n: SyntaxNode): string {
  return n.text.replace(/\s+/g, '').replace(/::<[^>]*>|<[^>]*>/g, '');
}

/** Named type a value of type `n` dispatches methods on: `&mut Arc<dyn Repo>` → `Repo`, `Self` → impl type. */
export function rustTypeRef(n: SyntaxNode | null | undefined, self?: string): string | undefined {
  if (!n) return undefined;
  switch (n.type) {
    case 'reference_type':
      return rustTypeRef(field(n, 'type'), self);
    case 'dynamic_type':
    case 'abstract_type':
      return rustTypeRef(field(n, 'trait') ?? n.namedChildren[0], self);
    case 'generic_type': {
      const base = field(n, 'type');
      const name = base ? rustPath(base) : '';
      if (WRAPPERS.has(name.split('::').pop() ?? ''))
        return rustTypeRef(field(n, 'type_arguments')?.namedChildren[0], self);
      return base ? rustTypeRef(base, self) : undefined;
    }
    case 'type_identifier':
      return n.text === 'Self' ? self : n.text;
    case 'scoped_type_identifier':
      return rustPath(n);
    default:
      return undefined;
  }
}

/** Pure callee text: `f`, `a::b::f`, `self.repo.find`, `x.y`; undefined for chains through calls. */
function calleeOf(n: SyntaxNode | null, self?: string): string | undefined {
  if (!n) return undefined;
  if (n.type === 'identifier' || n.type === 'self') return n.text;
  if (n.type === 'scoped_identifier') {
    const p = rustPath(n);
    return self && p.startsWith('Self::') ? `${self}${p.slice(4)}` : p;
  }
  if (n.type === 'generic_function') return calleeOf(field(n, 'function'), self);
  if (n.type === 'field_expression') {
    const v = field(n, 'value');
    const head =
      v && (v.type === 'identifier' || v.type === 'self' || v.type === 'field_expression') ? calleeOf(v) : undefined;
    const f = field(n, 'field')?.text;
    return head && f && !head.includes('::') ? `${head}.${f}` : undefined;
  }
  return undefined;
}

const ITEM_TYPES = new Set([
  'function_item',
  'struct_item',
  'enum_item',
  'union_item',
  'trait_item',
  'impl_item',
  'mod_item',
  'const_item',
  'static_item',
  'type_item',
  'use_declaration',
]);

export class RustWalker {
  readonly routes: RustRoutes;
  readonly inlined = new Set<number>();
  private seenRefs = new Set<string>();

  constructor(
    readonly facts: FileFacts,
    readonly ctx: ExtractContext,
  ) {
    this.routes = new RustRoutes(this);
  }

  items(nodes: SyntaxNode[], scope: RustScope): void {
    let attrs: SyntaxNode[] = [];
    for (const c of nodes) {
      if (c.type === 'attribute_item') attrs.push(c);
      else if (!c.type.endsWith('comment')) {
        if (ITEM_TYPES.has(c.type)) this.item(c, scope, attrs);
        attrs = [];
      }
    }
  }

  private modQ(scope: RustScope, name: string): string {
    return scope.mod ? `${scope.mod}.${name}` : name;
  }

  ref(n: SyntaxNode | null | undefined, scopeQname: string | undefined, self?: string): void {
    if (!n) return;
    if (n.type === 'type_identifier' || n.type === 'scoped_type_identifier') {
      const name = n.type === 'type_identifier' && n.text === 'Self' ? self : rustPath(n);
      const key = `${scopeQname ?? ''}\0${name}`;
      if (name && !this.seenRefs.has(key)) {
        this.seenRefs.add(key);
        (this.facts.references ??= []).push({ name, scopeQname, span: spanOf(n, this.ctx.path) });
      }
      return;
    }
    for (const c of n.namedChildren) this.ref(c, scopeQname, self);
  }

  private item(n: SyntaxNode, scope: RustScope, attrs: SyntaxNode[]): void {
    const attrText = attrs.map((a) => a.namedChildren[0]?.text.replace(/\s+/g, '') ?? '');
    if (attrText.some((a) => a === 'cfg(test)' || a === 'test' || /::test$/.test(a))) return;
    const name = field(n, 'name')?.text;
    const base = (kind: DeclFact['kind'], qname: string): DeclFact => ({
      kind,
      name: name ?? '',
      qname,
      span: spanOf(n, this.ctx.path),
      isExported: n.namedChildren.some((c) => c.type === 'visibility_modifier'),
      loc: n.endPosition.row - n.startPosition.row + 1,
    });
    switch (n.type) {
      case 'use_declaration':
        this.useTree(field(n, 'argument'), [], n);
        return;
      case 'mod_item': {
        if (!name) return;
        const body = field(n, 'body');
        const pathAttr = attrText.map((a) => /^path="([^"]+)"$/.exec(a)?.[1]).find(Boolean);
        const mods = (this.facts.hints.rustMods ??= []) as {
          name: string;
          parent: string;
          inline: boolean;
          path?: string;
        }[];
        mods.push({ name, parent: scope.mod, inline: !!body, ...(pathAttr ? { path: pathAttr } : {}) });
        if (body) this.items(body.namedChildren, { mod: this.modQ(scope, name), prefix: '' });
        return;
      }
      case 'function_item':
      case 'function_signature_item':
        this.fn(n, scope, attrs);
        return;
      case 'struct_item':
      case 'enum_item':
      case 'union_item':
      case 'trait_item': {
        if (!name) return;
        const qname = this.modQ(scope, name);
        const classKind = n.type === 'trait_item' ? 'trait' : n.type === 'enum_item' ? 'enum' : 'struct';
        this.facts.decls.push({ ...base('class', qname), classKind });
        const body = field(n, 'body');
        if (n.type === 'trait_item' && body) {
          this.items(body.namedChildren, { mod: scope.mod, impl: { qname, raw: name }, prefix: '' });
          return;
        }
        for (const f of n.type === 'struct_item' ? (body?.namedChildren ?? []) : []) {
          if (f.type !== 'field_declaration') continue;
          const fname = field(f, 'name')?.text;
          const ref = rustTypeRef(field(f, 'type'));
          this.ref(field(f, 'type'), qname);
          if (fname && ref)
            this.facts.bindings.push({ name: fname, scopeQname: qname, ref, isNew: true, isType: true });
        }
        return;
      }
      case 'impl_item': {
        const type = field(n, 'type');
        const raw = rustTypeRef(type);
        const body = field(n, 'body');
        if (!raw || !body) return;
        const qname = this.modQ(scope, raw.split('::').pop() as string);
        const trait = field(n, 'trait');
        const impls = (this.facts.hints.rustImpls ??= []) as { qname: string; type: string; trait?: string }[];
        impls.push({ qname, type: raw, ...(trait ? { trait: rustPath(trait) } : {}) });
        this.items(body.namedChildren, { mod: scope.mod, impl: { qname, raw }, prefix: '' });
        return;
      }
      case 'const_item':
      case 'static_item': {
        if (!name || scope.qname) return;
        const qname = this.modQ(scope, name);
        this.facts.decls.push(base('variable', qname));
        const ref = rustTypeRef(field(n, 'type'));
        if (ref) this.facts.bindings.push({ name: qname, ref, isNew: true, isType: true });
        return;
      }
      case 'type_item':
        if (name && !scope.qname) this.facts.decls.push(base('type', this.modQ(scope, name)));
        return;
    }
  }

  private useTree(n: SyntaxNode | null, prefix: string[], decl: SyntaxNode): void {
    if (!n) return;
    const push = (segs: string[], local: string, star = false) =>
      this.facts.imports.push({
        specifier: segs.join('::'),
        names: [{ imported: star ? '*' : (segs.at(-1) as string), local: star ? '*' : local }],
        span: spanOf(decl, this.ctx.path),
      });
    switch (n.type) {
      case 'identifier':
      case 'scoped_identifier':
      case 'crate':
      case 'super': {
        const segs = [...prefix, ...rustPath(n).split('::')];
        push(segs, segs.at(-1) as string);
        return;
      }
      case 'self':
        if (prefix.length) push(prefix, prefix.at(-1) as string);
        return;
      case 'use_as_clause': {
        const p = field(n, 'path');
        const alias = field(n, 'alias')?.text;
        if (p && alias && alias !== '_') push([...prefix, ...rustPath(p).split('::')], alias);
        return;
      }
      case 'scoped_use_list': {
        const p = field(n, 'path');
        const next = p ? [...prefix, ...rustPath(p).split('::')] : prefix;
        for (const c of field(n, 'list')?.namedChildren ?? []) this.useTree(c, next, decl);
        return;
      }
      case 'use_list':
        for (const c of n.namedChildren) this.useTree(c, prefix, decl);
        return;
      case 'use_wildcard': {
        const inner = n.namedChildren[0];
        push([...prefix, ...(inner ? rustPath(inner).split('::') : [])], '*', true);
        return;
      }
    }
  }

  private fn(n: SyntaxNode, scope: RustScope, attrs: SyntaxNode[]): void {
    const name = field(n, 'name')?.text;
    if (!name) return;
    const impl = scope.qname ? undefined : scope.impl;
    const qname = impl ? `${impl.qname}.${name}` : scope.qname ? `${scope.qname}.${name}` : this.modQ(scope, name);
    const params = field(n, 'parameters');
    const paramNames: string[] = [];
    for (const p of params?.namedChildren ?? []) {
      if (p.type === 'self_parameter') {
        paramNames.push('self');
        if (impl)
          this.facts.bindings.push({ name: 'self', scopeQname: qname, ref: impl.raw, isNew: true, isType: true });
        continue;
      }
      if (p.type !== 'parameter') continue;
      let pat = field(p, 'pattern');
      // axum extractors: `State(state): State<AppState>`
      if (pat?.type === 'tuple_struct_pattern' && pat.namedChildren.length === 2) pat = pat.namedChildren[1];
      const type = field(p, 'type');
      this.ref(type, qname, impl?.raw);
      if (pat?.type !== 'identifier') continue;
      paramNames.push(pat.text);
      const ref = rustTypeRef(type, impl?.raw);
      if (ref) this.facts.bindings.push({ name: pat.text, scopeQname: qname, ref, isNew: true, isType: true });
    }
    const ret = field(n, 'return_type');
    this.ref(ret, qname, impl?.raw);
    this.facts.decls.push({
      kind: impl ? 'method' : 'function',
      name,
      qname,
      parentQname: impl?.qname ?? scope.qname,
      span: spanOf(n, this.ctx.path),
      isExported: !!impl || n.namedChildren.some((c) => c.type === 'visibility_modifier'),
      isAsync: /^(pub(\([^)]*\))?\s+)?(const\s+)?async\b/.test(n.text),
      isAbstract: n.type === 'function_signature_item' || undefined,
      params: paramNames,
      signature: `${name}(${paramNames.join(', ')})`,
      complexity: complexityOf(n),
      loc: n.endPosition.row - n.startPosition.row + 1,
      returns: rustTypeRef(ret, impl?.raw),
    });
    this.routes.attrRoutes(attrs, qname);
    const body = field(n, 'body');
    if (body) this.visit(body, { qname, mod: scope.mod, impl, owner: scope.owner ?? qname, prefix: '' });
  }

  visit(n: SyntaxNode, scope: RustScope): void {
    if (ITEM_TYPES.has(n.type)) {
      this.item(n, { ...scope, impl: undefined }, []);
      return;
    }
    switch (n.type) {
      case 'macro_invocation':
        return; // token trees are not parsed
      case 'let_declaration':
        this.letDecl(n, scope);
        return;
      case 'closure_expression':
        if (this.inlined.has(n.startIndex)) return;
        break;
      case 'call_expression': {
        const callee = calleeOf(field(n, 'function'), scope.impl?.raw);
        if (callee && !PRELUDE_CALLS.has(callee) && callee.split(/::|\./).length <= 5)
          this.facts.calls.push({
            callee,
            callerQname: scope.qname,
            argCount: field(n, 'arguments')?.namedChildCount ?? 0,
            span: spanOf(n, this.ctx.path),
            ...callArgs(n),
          });
        if (this.routes.route(n, scope)) return;
        break;
      }
      case 'struct_expression': {
        const t = field(n, 'name');
        const callee = t ? (t.text === 'Self' ? scope.impl?.raw : rustPath(t)) : undefined;
        if (callee)
          this.facts.calls.push({
            callee,
            callerQname: scope.qname,
            isNew: true,
            argCount: 0,
            span: spanOf(n, this.ctx.path),
          });
        break;
      }
    }
    for (const c of n.namedChildren) this.visit(c, scope);
  }

  private letDecl(n: SyntaxNode, scope: RustScope): void {
    const pat = field(n, 'pattern');
    const name = pat?.type === 'identifier' ? pat.text : undefined;
    const type = field(n, 'type');
    let v = field(n, 'value');
    while (v && (v.type === 'try_expression' || v.type === 'await_expression')) v = v.namedChildren[0] ?? null;
    if (name) {
      const self = scope.impl?.raw;
      const tref = rustTypeRef(type, self);
      const push = (ref: string, isType: boolean) =>
        this.facts.bindings.push({ name, scopeQname: scope.qname, ref, isNew: isType, isType: isType || undefined });
      if (tref) push(tref, true);
      else if (v?.type === 'struct_expression') {
        const t = field(v, 'name');
        const ref = t && (t.text === 'Self' ? self : rustPath(t));
        if (ref) push(ref, true);
      } else if (v?.type === 'call_expression') {
        const callee = calleeOf(field(v, 'function'), self);
        if (callee && !PRELUDE_CALLS.has(callee)) push(callee, false);
      }
    }
    this.ref(type, scope.qname, scope.impl?.raw);
    const value = field(n, 'value');
    if (value) this.routes.withVar(name, scope, () => this.visit(value, scope));
  }

  /** A synthetic function for an inline route closure (`get(|| async { … })`). */
  inlineHandler(fn: SyntaxNode, name: string, scope: RustScope): string {
    const qname = scope.qname ? `${scope.qname}.${name}` : name;
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
    const body = field(fn, 'body');
    if (body) this.visit(body, { ...scope, qname });
    return qname;
  }

  importsCrate(name: string): boolean {
    return this.facts.imports.some((i) => i.specifier.split('::')[0] === name) || this.ctx.source.includes(`${name}::`);
  }
}

export const rustExtractor: LanguageExtractor = {
  languages: ['rust'],
  extract(root: SyntaxNode, ctx: ExtractContext): FileFacts {
    const facts: FileFacts = {
      path: ctx.path,
      language: 'rust',
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
    const w = new RustWalker(facts, ctx);
    // uses first: framework gating looks at them
    for (const c of root.namedChildren) if (c.type === 'use_declaration') w.items([c], { mod: '', prefix: '' });
    w.items(
      root.namedChildren.filter((c) => c.type !== 'use_declaration'),
      { mod: '', prefix: '' },
    );
    for (const d of facts.decls) if (d.isExported && !d.parentQname) facts.exports.push({ name: d.name, span: d.span });
    return facts;
  },
};
