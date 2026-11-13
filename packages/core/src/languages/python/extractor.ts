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

const HTTP_DECORATORS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'route', 'api_route', 'websocket']);

interface Scope {
  qname?: string;
  isClass?: boolean;
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
          if (c.type === 'dotted_name') this.facts.imports.push({ specifier: c.text, names: [], namespace: c.text.split('.')[0], span: spanOf(n, this.ctx.path) });
          else if (c.type === 'aliased_import') {
            const name = field(c, 'name')?.text;
            const alias = field(c, 'alias')?.text;
            if (name) this.facts.imports.push({ specifier: name, names: [], namespace: alias ?? name, span: spanOf(n, this.ctx.path) });
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
          if (left?.type === 'identifier' && right?.type === 'call') {
            const fn = field(right, 'function');
            if (fn && (fn.type === 'identifier' || fn.type === 'attribute')) this.facts.bindings.push({ name: left.text, scopeQname: scope.qname, ref: dottedText(fn), isNew: true });
          }
        }
        if (first?.type === 'assignment' && !scope.qname) {
          const left = field(first, 'left');
          const right = field(first, 'right');
          if (left?.type === 'identifier') {
            if (left.text === '__all__' && right) {
              this.facts.hints.__all__ = right.namedChildren.map((s) => stringValue(s)).filter((x): x is string => !!x);
            } else {
              this.facts.decls.push({ kind: 'variable', name: left.text, qname: left.text, span: spanOf(first, this.ctx.path), isExported: false, loc: 1 });
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
    const paramNames = params ? params.namedChildren.map((p) => (field(p, 'name') ?? p).text.replace(/\s+/g, ' ').slice(0, 40)) : [];
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
    };
    for (const d of decorators) {
      const { name: dn, call } = this.decoratorInfo(d);
      decl.decorators!.push(dn);
      if (dn === 'staticmethod') decl.isStatic = true;
      // FastAPI / Flask / Sanic style route decorators
      const last = dn.split('.').pop() ?? '';
      if (call && HTTP_DECORATORS.has(last)) {
        const args = field(call, 'arguments');
        const p = stringValue(args?.namedChildren.find((a) => a.type === 'string'));
        if (p !== undefined) {
          let methods: string[] = [];
          if (last === 'route' || last === 'api_route') {
            const kw = args?.namedChildren.find((a) => a.type === 'keyword_argument' && field(a, 'name')?.text === 'methods');
            const val = kw ? field(kw, 'value') : null;
            methods = val ? val.namedChildren.map((s) => stringValue(s)?.toUpperCase()).filter((x): x is string => !!x) : ['GET'];
          } else methods = [last === 'websocket' ? 'WS' : last.toUpperCase()];
          const framework = this.ctx.frameworks.has('fastapi') ? 'fastapi' : this.ctx.frameworks.has('flask') ? 'flask' : 'python-http';
          for (const m of methods) this.facts.endpoints.push({ method: m, path: p, framework, handlerRef: qname, enclosingQname: qname, span: spanOf(d, this.ctx.path) });
        }
      }
      // decorators are references/calls too
      this.facts.calls.push({ callee: dn, callerQname: scope.qname, argCount: 1, span: spanOf(d, this.ctx.path) });
    }
    this.facts.decls.push(decl);
    const body = field(n, 'body');
    if (body) this.visitChildren(body, { qname });
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
    this.facts.calls.push({ callee, callerQname: scope.qname, argCount: args?.namedChildCount ?? 0, span: spanOf(n, this.ctx.path) });
    // Flask: app.add_url_rule('/x', view_func=f); FastAPI: app.add_api_route('/x', f)
    const last = callee.split('.').pop();
    if ((last === 'add_url_rule' || last === 'add_api_route') && args) {
      const p = stringValue(args.namedChildren[0]);
      let handlerRef: string | undefined;
      for (const a of args.namedChildren) {
        if (a.type === 'keyword_argument' && ['view_func', 'endpoint'].includes(field(a, 'name')?.text ?? '')) handlerRef = field(a, 'value')?.text;
        else if (a.type === 'identifier' && a !== args.namedChildren[0]) handlerRef = a.text;
      }
      if (p) this.facts.endpoints.push({ method: 'ANY', path: p, framework: last === 'add_api_route' ? 'fastapi' : 'flask', handlerRef, enclosingQname: scope.qname, span: spanOf(n, this.ctx.path) });
    }
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
      if (view?.type === 'call' && field(view, 'function')?.text === 'include') continue;
      this.facts.endpoints.push({ method: 'ANY', path: '/' + p.replace(/^\//, ''), framework: 'django', handlerRef, enclosingQname: scope.qname, span: spanOf(it, this.ctx.path) });
    }
  }
}

export const pythonExtractor = new PythonExtractor();
