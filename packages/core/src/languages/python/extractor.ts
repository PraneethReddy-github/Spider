import type { SyntaxNode } from '../../parse/parser.js';
import { field, stringValue } from '../../parse/parser.js';
import {
  type DeclFact,
  type ExtractContext,
  type FileFacts,
  type ImportFact,
  type LanguageExtractor,
  complexityOf,
  countLoc,
  dottedText,
  spanOf,
} from '../types.js';

const HTTP_DECORATORS = new Set([
  'get',
  'post',
  'put',
  'delete',
  'patch',
  'options',
  'head',
  'route',
  'api_route',
  'websocket',
]);

/** Wrapper generics unwrapped when typing a receiver from an annotation. */
const WRAPPER_TYPES = new Set(['Optional', 'Awaitable', 'Final', 'Annotated', 'ClassVar', 'Type']);

interface Scope {
  qname?: string;
  isClass?: boolean;
  /** Enclosing class qname inside methods (for `self.x = …` field typing). */
  classQname?: string;
  /** Annotated parameter name → type name in the current function. */
  paramTypes?: Map<string, string>;
}

export class PythonExtractor implements LanguageExtractor {
  languages = ['python'];

  extract(root: SyntaxNode, ctx: ExtractContext): FileFacts {
    const facts: FileFacts = {
      path: ctx.path,
      language: 'python',
      loc: countLoc(ctx.source),
      decls: [],
      imports: [],
      exports: [],
      calls: [],
      endpoints: [],
      bindings: [],
      hints: {},
    };
    const w = new Walker(facts, ctx);
    w.visitChildren(root, {});
    // Python "exports": every non-underscore top-level decl, unless __all__ restricts.
    const all = facts.hints.__all__ as string[] | undefined;
    for (const d of facts.decls) {
      if (d.parentQname) continue;
      const isPub = all ? all.includes(d.name) : !d.name.startsWith('_');
      d.isExported = isPub;
      if (isPub) facts.exports.push({ name: d.name, span: d.span });
    }
    return facts;
  }
}

class Walker {
  /** Router variable → its own prefix (`APIRouter(prefix=)`, `Blueprint(url_prefix=)`). */
  private routerPrefixes = new Map<string, string>();
  private seenRefs = new Set<string>();

  constructor(
    private facts: FileFacts,
    private ctx: ExtractContext,
  ) {}

  visitChildren(n: SyntaxNode, scope: Scope): void {
    for (const c of n.namedChildren) this.visit(c, scope);
  }

  private q(scope: Scope, name: string): string {
    return scope.qname ? `${scope.qname}.${name}` : name;
  }

  visit(n: SyntaxNode, scope: Scope, decorators: SyntaxNode[] = []): void {
    switch (n.type) {
      case 'import_statement':
        for (const c of n.namedChildren) {
          if (c.type === 'dotted_name')
            this.facts.imports.push({
              specifier: c.text,
              names: [],
              namespace: c.text.split('.')[0],
              span: spanOf(n, this.ctx.path),
            });
          else if (c.type === 'aliased_import') {
            const name = field(c, 'name')?.text;
            const alias = field(c, 'alias')?.text;
            if (name)
              this.facts.imports.push({
                specifier: name,
                names: [],
                namespace: alias ?? name,
                span: spanOf(n, this.ctx.path),
              });
          }
        }
        return;
      case 'import_from_statement': {
        const modNode = field(n, 'module_name');
        const spec = modNode?.text ?? '';
        const imp: ImportFact = { specifier: spec, names: [], span: spanOf(n, this.ctx.path) };
        const isWildcard = n.children.some((c) => c.type === 'wildcard_import');
        if (isWildcard) imp.names.push({ imported: '*', local: '*' });
        for (const c of n.namedChildren) {
          if (modNode && c.startIndex === modNode.startIndex && c.endIndex === modNode.endIndex) continue;
          if (c.type === 'dotted_name') imp.names.push({ imported: c.text, local: c.text });
          else if (c.type === 'aliased_import') {
            const name = field(c, 'name')?.text;
            const alias = field(c, 'alias')?.text;
            if (name) imp.names.push({ imported: name, local: alias ?? name });
          }
        }
        this.facts.imports.push(imp);
        return;
      }
      case 'decorated_definition': {
        const decs = n.namedChildren.filter((c) => c.type === 'decorator');
        const def = field(n, 'definition');
        if (def) this.visit(def, scope, decs);
        return;
      }
      case 'function_definition':
        this.functionDef(n, scope, decorators);
        return;
      case 'class_definition':
        this.classDef(n, scope, decorators);
        return;
      case 'expression_statement': {
        const first = n.namedChildren[0];
        if (first?.type === 'assignment') {
          const left = field(first, 'left');
          let right = field(first, 'right');
          if (right?.type === 'await' && right.namedChildren[0]) right = right.namedChildren[0];
          const type = field(first, 'type');
          const refScope = scope.qname ?? (left?.type === 'identifier' ? left.text : undefined);
          this.typeRefs(type, refScope);
          const typeName = typeNameOf(type);
          if (left?.type === 'identifier' && typeName)
            this.facts.bindings.push({
              name: left.text,
              scopeQname: scope.qname,
              ref: typeName,
              isNew: true,
              isType: true,
            });
          else if (left?.type === 'identifier' && right?.type === 'call') {
            const fn = field(right, 'function');
            if (fn && (fn.type === 'identifier' || fn.type === 'attribute'))
              this.facts.bindings.push({ name: left.text, scopeQname: scope.qname, ref: dottedText(fn), isNew: true });
            if (!scope.qname && fn) this.routerPrefix(left.text, dottedText(fn), right);
          }
          // self.x = X() / self.x = annotated_param → field typing for `self.x.method()`
          if (left?.type === 'attribute' && field(left, 'object')?.text === 'self' && scope.classQname) {
            const attr = field(left, 'attribute')?.text;
            const fn = right?.type === 'call' ? field(right, 'function') : null;
            const ref =
              fn && (fn.type === 'identifier' || fn.type === 'attribute')
                ? dottedText(fn)
                : right?.type === 'identifier'
                  ? scope.paramTypes?.get(right.text)
                  : undefined;
            if (attr && ref)
              this.facts.bindings.push({
                name: `self.${attr}`,
                scopeQname: scope.classQname,
                ref,
                isNew: true,
                isType: right?.type === 'identifier',
              });
          }
        }
        if (first?.type === 'assignment' && !scope.qname) {
          const left = field(first, 'left');
          const right = field(first, 'right');
          if (left?.type === 'identifier') {
            if (left.text === '__all__' && right) {
              this.facts.hints.__all__ = right.namedChildren.map((s) => stringValue(s)).filter((x): x is string => !!x);
            } else {
              this.facts.decls.push({
                kind: 'variable',
                name: left.text,
                qname: left.text,
                span: spanOf(first, this.ctx.path),
                isExported: false,
                loc: 1,
              });
            }
          }
          // Django urls: urlpatterns = [path('x/', view), ...]
          if (left?.text === 'urlpatterns' && right) this.djangoUrls(right, scope);
        }
        this.visitChildren(n, scope);
        return;
      }
      case 'call':
        this.call(n, scope);
        this.visitChildren(n, scope);
        return;
      default:
        this.visitChildren(n, scope);
    }
  }

  private decoratorInfo(d: SyntaxNode): { name: string; call?: SyntaxNode } {
    const inner = d.namedChildren[0];
    if (!inner) return { name: d.text.replace(/^@/, '') };
    if (inner.type === 'call') return { name: dottedText(field(inner, 'function') ?? inner), call: inner };
    return { name: dottedText(inner) };
  }

  private functionDef(n: SyntaxNode, scope: Scope, decorators: SyntaxNode[]): void {
    const name = field(n, 'name')?.text;
    if (!name) return;
    const qname = this.q(scope, name);
    const params = field(n, 'parameters');
    const paramNames = params
      ? params.namedChildren.map((p) => (field(p, 'name') ?? p).text.replace(/\s+/g, ' ').slice(0, 40))
      : [];
    const paramTypes = new Map<string, string>();
    for (const p of params?.namedChildren ?? []) {
      if (p.type !== 'typed_parameter' && p.type !== 'typed_default_parameter') continue;
      const pname = (field(p, 'name') ?? p.namedChildren[0])?.text;
      const type = field(p, 'type');
      this.typeRefs(type, qname);
      const typeName = typeNameOf(type);
      if (!pname || !/^\w+$/.test(pname) || !typeName) continue;
      paramTypes.set(pname, typeName);
      this.facts.bindings.push({ name: pname, scopeQname: qname, ref: typeName, isNew: true, isType: true });
    }
    const returnType = field(n, 'return_type');
    this.typeRefs(returnType, qname);
    const decl: DeclFact = {
      kind: scope.isClass ? 'method' : 'function',
      name,
      qname,
      parentQname: scope.qname,
      span: spanOf(n, this.ctx.path),
      isExported: !scope.qname && !name.startsWith('_'),
      isAsync: n.children.some((c) => c.type === 'async'),
      params: paramNames,
      signature: `${name}(${paramNames.join(', ')})`,
      complexity: complexityOf(n),
      decorators: [],
      loc: n.endPosition.row - n.startPosition.row + 1,
      visibility: scope.isClass ? (name.startsWith('_') ? 'private' : 'public') : undefined,
      returns: typeNameOf(returnType),
    };
    for (const d of decorators) {
      const { name: dn, call } = this.decoratorInfo(d);
      decl.decorators!.push(dn);
      if (dn === 'staticmethod') decl.isStatic = true;
      this.decoratorRef(d, qname);
      // FastAPI / Flask / Sanic style route decorators
      const last = dn.split('.').pop() ?? '';
      const receiver = dn.includes('.') ? dn.slice(0, dn.lastIndexOf('.')) : undefined;
      const own = receiver ? this.routerPrefixes.get(receiver) : undefined;
      if (call && HTTP_DECORATORS.has(last)) {
        const args = field(call, 'arguments');
        const p = stringValue(args?.namedChildren.find((a) => a.type === 'string'));
        if (p !== undefined) {
          let methods: string[] = [];
          if (last === 'route' || last === 'api_route') {
            const kw = args?.namedChildren.find(
              (a) => a.type === 'keyword_argument' && field(a, 'name')?.text === 'methods',
            );
            const val = kw ? field(kw, 'value') : null;
            methods = val
              ? val.namedChildren.map((s) => stringValue(s)?.toUpperCase()).filter((x): x is string => !!x)
              : ['GET'];
          } else methods = [last === 'websocket' ? 'WS' : last.toUpperCase()];
          const framework = this.ctx.frameworks.has('fastapi')
            ? 'fastapi'
            : this.ctx.frameworks.has('flask')
              ? 'flask'
              : 'python-http';
          for (const m of methods)
            this.facts.endpoints.push({
              method: m,
              path: own ? joinUrl(own, p) : p,
              framework,
              handlerRef: qname,
              enclosingQname: qname,
              receiver,
              receiverPrefix: own,
              span: spanOf(d, this.ctx.path),
            });
        }
      }
      // decorators run at definition time: a call from the enclosing scope (plus a reference above)
      this.facts.calls.push({ callee: dn, callerQname: scope.qname, argCount: 1, span: spanOf(d, this.ctx.path) });
    }
    this.facts.decls.push(decl);
    const body = field(n, 'body');
    const classQname = scope.isClass ? scope.qname : scope.classQname;
    if (body) this.visitChildren(body, { qname, classQname, paramTypes });
  }

  private classDef(n: SyntaxNode, scope: Scope, decorators: SyntaxNode[]): void {
    const name = field(n, 'name')?.text;
    if (!name) return;
    const qname = this.q(scope, name);
    const decl: DeclFact = {
      kind: 'class',
      classKind: 'class',
      name,
      qname,
      parentQname: scope.qname,
      span: spanOf(n, this.ctx.path),
      isExported: !scope.qname && !name.startsWith('_'),
      extends: [],
      decorators: decorators.map((d) => this.decoratorInfo(d).name),
      loc: n.endPosition.row - n.startPosition.row + 1,
    };
    for (const d of decorators) this.decoratorRef(d, qname);
    const sup = field(n, 'superclasses');
    if (sup) {
      for (const s of sup.namedChildren) {
        if (s.type === 'identifier' || s.type === 'attribute') decl.extends!.push(dottedText(s));
        else if (s.type === 'keyword_argument') {
          const k = field(s, 'name')?.text;
          if (k === 'metaclass') continue;
        }
      }
    }
    if (decl.extends!.some((e) => /Protocol|ABC|Interface$/.test(e))) decl.classKind = 'interface';
    this.facts.decls.push(decl);
    const body = field(n, 'body');
    if (body) this.visitChildren(body, { qname, isClass: true });
  }

  private call(n: SyntaxNode, scope: Scope): void {
    const fn = field(n, 'function');
    if (!fn) return;
    if (fn.type !== 'identifier' && fn.type !== 'attribute') return;
    const callee = dottedText(fn);
    const args = field(n, 'arguments');
    this.facts.calls.push({
      callee,
      callerQname: scope.qname,
      argCount: args?.namedChildCount ?? 0,
      span: spanOf(n, this.ctx.path),
    });
    // Flask: app.add_url_rule('/x', view_func=f); FastAPI: app.add_api_route('/x', f)
    const last = callee.split('.').pop();
    if ((last === 'add_url_rule' || last === 'add_api_route') && args) {
      const p = stringValue(args.namedChildren[0]);
      let handlerRef: string | undefined;
      for (const a of args.namedChildren) {
        if (a.type === 'keyword_argument' && ['view_func', 'endpoint'].includes(field(a, 'name')?.text ?? '')) {
          const v = field(a, 'value');
          // view_func=ItemAPI.as_view('item') → `ItemAPI.as_view` (class-based view)
          handlerRef = v?.type === 'call' ? dottedText(field(v, 'function') ?? v) : v?.text;
        } else if (a.type === 'identifier' && a !== args.namedChildren[0]) handlerRef = a.text;
      }
      const receiver = callee.includes('.') ? callee.slice(0, callee.lastIndexOf('.')) : undefined;
      const own = receiver ? this.routerPrefixes.get(receiver) : undefined;
      if (p)
        this.facts.endpoints.push({
          method: 'ANY',
          path: own ? joinUrl(own, p) : p,
          framework: last === 'add_api_route' ? 'fastapi' : 'flask',
          handlerRef,
          enclosingQname: scope.qname,
          receiver,
          receiverPrefix: own,
          span: spanOf(n, this.ctx.path),
        });
    }
    // FastAPI: app.include_router(r, prefix='/x') · Flask: app.register_blueprint(bp, url_prefix='/x')
    if ((last === 'include_router' || last === 'register_blueprint') && args) {
      const target = args.namedChildren[0];
      if (target && (target.type === 'identifier' || target.type === 'attribute')) {
        const kw = last === 'include_router' ? 'prefix' : 'url_prefix';
        (this.facts.mounts ??= []).push({
          prefix: stringValue(keywordArg(args, kw)) ?? '',
          target: dottedText(target),
          parent: callee.includes('.') ? callee.slice(0, callee.lastIndexOf('.')) : undefined,
          replacesOwnPrefix: last === 'register_blueprint',
          span: spanOf(n, this.ctx.path),
        });
      }
    }
  }

  /** `APIRouter(prefix='/x')` / `Blueprint('n', __name__, url_prefix='/x')` at module level. */
  private routerPrefix(name: string, ctor: string, call: SyntaxNode): void {
    const last = ctor.split('.').pop();
    const kw = last === 'APIRouter' ? 'prefix' : last === 'Blueprint' ? 'url_prefix' : undefined;
    const args = field(call, 'arguments');
    if (!kw || !args) return;
    const prefix = stringValue(keywordArg(args, kw));
    if (prefix === undefined) return;
    this.routerPrefixes.set(name, prefix);
    (this.facts.routers ??= []).push({ name, prefix });
  }

  private ref(name: string, scopeQname: string | undefined, n: SyntaxNode): void {
    const key = `${scopeQname ?? ''}\0${name}`;
    if (this.seenRefs.has(key)) return;
    this.seenRefs.add(key);
    (this.facts.references ??= []).push({ name, scopeQname, span: spanOf(n, this.ctx.path) });
  }

  /** Names used in an annotation: identifiers, dotted attributes, simple string forward references. */
  private typeRefs(n: SyntaxNode | null | undefined, scopeQname: string | undefined): void {
    if (!n) return;
    if (n.type === 'identifier' || n.type === 'attribute') {
      this.ref(dottedText(n), scopeQname, n);
      return;
    }
    if (n.type === 'string') {
      const v = stringValue(n);
      if (v && /^[A-Za-z_][\w.]*$/.test(v)) this.ref(v, scopeQname, n);
      return;
    }
    for (const c of n.namedChildren) this.typeRefs(c, scopeQname);
  }

  /** The decorator itself (`@cached` / `@cache(…)`) is a reference from the decorated declaration. */
  private decoratorRef(d: SyntaxNode, qname: string): void {
    const inner = d.namedChildren[0];
    const head = inner?.type === 'call' ? field(inner, 'function') : inner;
    if (head && (head.type === 'identifier' || head.type === 'attribute')) this.ref(dottedText(head), qname, head);
  }

  private djangoUrls(listNode: SyntaxNode, scope: Scope): void {
    const items = listNode.type === 'list' ? listNode.namedChildren : [];
    for (const it of items) {
      if (it.type !== 'call') continue;
      const fname = field(it, 'function')?.text;
      if (fname !== 'path' && fname !== 're_path' && fname !== 'url') continue;
      const args = field(it, 'arguments');
      if (!args) continue;
      const p = stringValue(args.namedChildren[0]);
      const view = args.namedChildren[1];
      if (p === undefined) continue;
      let handlerRef: string | undefined;
      if (view?.type === 'identifier' || view?.type === 'attribute') handlerRef = dottedText(view);
      else if (view?.type === 'call') handlerRef = dottedText(field(view, 'function') ?? view); // View.as_view()
      if (view?.type === 'call' && field(view, 'function')?.text === 'include') {
        // include('app.urls') · include(module) · include(('app.urls', 'ns'))
        let t = field(view, 'arguments')?.namedChildren[0];
        if (t?.type === 'tuple') t = t.namedChildren[0];
        const mod = stringValue(t);
        const target = mod ?? (t && (t.type === 'identifier' || t.type === 'attribute') ? dottedText(t) : undefined);
        if (target)
          (this.facts.mounts ??= []).push({
            prefix: p,
            target,
            parent: 'urlpatterns',
            targetIsModule: mod !== undefined,
            span: spanOf(it, this.ctx.path),
          });
        continue;
      }
      this.facts.endpoints.push({
        method: 'ANY',
        path: `/${p.replace(/^\//, '')}`,
        framework: 'django',
        handlerRef,
        enclosingQname: scope.qname,
        receiver: 'urlpatterns',
        span: spanOf(it, this.ctx.path),
      });
    }
  }
}

export const pythonExtractor = new PythonExtractor();

/** The class-like name of an annotation for receiver typing; undefined for unions and containers. */
function typeNameOf(n: SyntaxNode | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'type') return typeNameOf(n.namedChildren[0]);
  if (n.type === 'identifier' || n.type === 'attribute') return dottedText(n);
  if (n.type === 'string') {
    const v = stringValue(n);
    return v && /^[A-Za-z_][\w.]*$/.test(v) ? v : undefined;
  }
  if (n.type === 'generic_type' || n.type === 'subscript') {
    const head = n.namedChildren[0];
    if (!head || !WRAPPER_TYPES.has(head.text.split('.').pop() ?? '')) return undefined;
    const inner = n.namedChildren[1];
    return typeNameOf(inner?.type === 'type_parameter' ? inner.namedChildren[0] : inner);
  }
  if (n.type === 'binary_operator') {
    // `X | None`
    const parts = [field(n, 'left'), field(n, 'right')].filter((x) => x && x.text !== 'None');
    return parts.length === 1 ? typeNameOf(parts[0]) : undefined;
  }
  return undefined;
}

function keywordArg(args: SyntaxNode, name: string): SyntaxNode | undefined {
  const kw = args.namedChildren.find((a) => a.type === 'keyword_argument' && field(a, 'name')?.text === name);
  return kw ? (field(kw, 'value') ?? undefined) : undefined;
}

function joinUrl(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}
