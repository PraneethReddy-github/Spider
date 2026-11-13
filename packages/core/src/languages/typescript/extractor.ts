import type { SyntaxNode } from '../../parse/parser.js';
import { field, stringValue } from '../../parse/parser.js';
import {
  type CallFact,
  type DeclFact,
  type EndpointFact,
  type ExportFact,
  type ExtractContext,
  type FileFacts,
  type ImportFact,
  type LanguageExtractor,
  complexityOf,
  countLoc,
  dottedText,
  spanOf,
} from '../types.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all', 'use', 'route', 'ws']);
const NEST_METHOD_DECORATORS = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head', 'All']);
const FUNCTION_TYPES = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'arrow_function',
  'generator_function',
  'method_definition',
]);

interface Scope {
  qname?: string;
}

export class TypeScriptExtractor implements LanguageExtractor {
  languages = ['typescript', 'tsx', 'javascript'];

  extract(root: SyntaxNode, ctx: ExtractContext): FileFacts {
    const facts: FileFacts = {
      path: ctx.path,
      language: ctx.language,
      loc: countLoc(ctx.source),
      decls: [],
      imports: [],
      exports: [],
      calls: [],
      endpoints: [],
      bindings: [],
      hints: {},
    };
    const ex = new Walker(facts, ctx);
    ex.visitChildren(root, { qname: undefined }, false, undefined);
    ex.detectFileRoutes();
    return facts;
  }
}

class Walker {
  private controllerPrefix: string | undefined;
  private anonCounter = 0;

  constructor(
    private facts: FileFacts,
    private ctx: ExtractContext,
  ) {}

  visitChildren(n: SyntaxNode, scope: Scope, exported: boolean, classQname: string | undefined): void {
    for (const c of n.namedChildren) this.visit(c, scope, exported, classQname);
  }

  visit(n: SyntaxNode, scope: Scope, exported: boolean, classQname: string | undefined): void {
    switch (n.type) {
      case 'import_statement':
        this.importStatement(n);
        return;
      case 'export_statement':
        this.exportStatement(n, scope, classQname);
        return;
      case 'function_declaration':
      case 'generator_function_declaration':
        this.functionDecl(n, scope, exported, 'function', classQname);
        return;
      case 'class_declaration':
      case 'abstract_class_declaration':
      case 'class':
        this.classDecl(n, scope, exported);
        return;
      case 'interface_declaration':
        this.interfaceDecl(n, scope, exported);
        return;
      case 'type_alias_declaration':
      case 'enum_declaration': {
        const name = field(n, 'name')?.text;
        if (name) {
          this.facts.decls.push({
            kind: n.type === 'enum_declaration' ? 'class' : 'type',
            classKind: n.type === 'enum_declaration' ? 'enum' : undefined,
            name,
            qname: this.q(scope, name),
            parentQname: scope.qname,
            span: spanOf(n, this.ctx.path),
            isExported: exported,
            loc: n.endPosition.row - n.startPosition.row + 1,
          });
          if (exported) this.facts.exports.push({ name, span: spanOf(n, this.ctx.path) });
        }
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration':
        this.variableDecl(n, scope, exported, classQname);
        return;
      case 'method_definition':
        this.functionDecl(n, scope, false, 'method', classQname);
        return;
      case 'public_field_definition':
      case 'field_definition': {
        // class property holding an arrow function → method
        const value = field(n, 'value');
        const name = field(n, 'name')?.text;
        if (value && name && FUNCTION_TYPES.has(value.type)) {
          this.functionLike(value, name, scope, false, 'method', n, classQname);
        } else if (value) this.visit(value, scope, false, classQname);
        return;
      }
      case 'call_expression':
        this.callExpression(n, scope, classQname);
        this.visitChildren(n, scope, false, classQname);
        return;
      case 'new_expression': {
        const ctor = field(n, 'constructor');
        if (ctor) {
          this.facts.calls.push({
            callee: dottedText(ctor),
            callerQname: scope.qname,
            isNew: true,
            argCount: field(n, 'arguments')?.namedChildCount ?? 0,
            span: spanOf(n, this.ctx.path),
          });
        }
        this.visitChildren(n, scope, false, classQname);
        return;
      }
      case 'arrow_function':
      case 'function_expression':
      case 'function': {
        // anonymous function not bound to a declaration: attribute contents to enclosing scope
        this.visitChildren(n, scope, false, classQname);
        return;
      }
      case 'decorator':
        return; // handled by parents
      default:
        this.visitChildren(n, scope, exported && n.type === 'export_statement', classQname);
    }
  }

  private q(scope: Scope, name: string): string {
    return scope.qname ? `${scope.qname}.${name}` : name;
  }

  private importStatement(n: SyntaxNode): void {
    const spec = stringValue(field(n, 'source'));
    if (!spec) return;
    const imp: ImportFact = { specifier: spec, names: [], span: spanOf(n, this.ctx.path) };
    const clause = n.namedChildren.find((c) => c.type === 'import_clause');
    if (clause) {
      for (const c of clause.namedChildren) {
        if (c.type === 'identifier') imp.names.push({ imported: 'default', local: c.text });
        else if (c.type === 'namespace_import') {
          imp.namespace = c.namedChildren.find((x) => x.type === 'identifier')?.text;
        } else if (c.type === 'named_imports') {
          for (const s of c.namedChildren) {
            if (s.type !== 'import_specifier') continue;
            const name = field(s, 'name')?.text;
            const alias = field(s, 'alias')?.text;
            if (name) imp.names.push({ imported: name, local: alias ?? name });
          }
        }
      }
    }
    this.facts.imports.push(imp);
  }

  private exportStatement(n: SyntaxNode, scope: Scope, classQname: string | undefined): void {
    const source = stringValue(field(n, 'source'));
    const decl = field(n, 'declaration');
    const span = spanOf(n, this.ctx.path);
    if (decl) {
      const isDefault = n.children.some((c) => c.type === 'default');
      if (isDefault && (decl.type === 'identifier' || !FUNCTION_TYPES.has(decl.type))) {
        if (decl.type === 'identifier') this.facts.exports.push({ name: 'default', local: decl.text, span });
        else if (decl.type === 'class' || decl.type === 'class_declaration') {
          this.classDecl(decl, scope, true, 'default');
        } else {
          this.facts.exports.push({ name: 'default', span });
          this.visit(decl, scope, false, classQname);
        }
        return;
      }
      if (isDefault && FUNCTION_TYPES.has(decl.type)) {
        const name = field(decl, 'name')?.text ?? 'default';
        this.functionLike(decl, name, scope, true, 'function', decl, classQname);
        if (name !== 'default') this.facts.exports.push({ name: 'default', local: name, span });
        return;
      }
      this.visit(decl, scope, true, classQname);
      return;
    }
    // export { a as b } [from '...']  |  export * from '...'
    const clause = n.namedChildren.find((c) => c.type === 'export_clause');
    if (clause) {
      for (const s of clause.namedChildren) {
        if (s.type !== 'export_specifier') continue;
        const name = field(s, 'name')?.text;
        const alias = field(s, 'alias')?.text;
        if (name) this.facts.exports.push({ name: alias ?? name, local: name, from: source, span });
      }
      if (source) this.facts.imports.push({ specifier: source, names: [], span });
    } else if (source) {
      this.facts.exports.push({ name: '*', from: source, span });
      this.facts.imports.push({ specifier: source, names: [], span });
    } else {
      // `export default expr` with a non-declaration value (e.g. object literal)
      const value = n.namedChildren.find((c) => c.type !== 'decorator');
      if (value) {
        this.facts.exports.push({ name: 'default', span });
        this.visit(value, scope, false, classQname);
      }
    }
  }

  private decoratorsOf(n: SyntaxNode): SyntaxNode[] {
    const out: SyntaxNode[] = [];
    // decorators appear as preceding siblings (class members) or children (export statements/classes)
    for (const c of n.namedChildren) if (c.type === 'decorator') out.push(c);
    let prev = n.previousNamedSibling;
    while (prev && prev.type === 'decorator') {
      out.push(prev);
      prev = prev.previousNamedSibling;
    }
    if (n.parent?.type === 'export_statement') {
      for (const c of n.parent.namedChildren) if (c.type === 'decorator') out.push(c);
    }
    return out;
  }

  private decoratorName(d: SyntaxNode): { name: string; args: SyntaxNode | null } {
    const inner = d.namedChildren[0];
    if (!inner) return { name: d.text, args: null };
    if (inner.type === 'call_expression') {
      return { name: dottedText(field(inner, 'function') ?? inner), args: field(inner, 'arguments') };
    }
    return { name: dottedText(inner), args: null };
  }

  private classDecl(n: SyntaxNode, scope: Scope, exported: boolean, forcedName?: string): void {
    const name = field(n, 'name')?.text ?? forcedName ?? `AnonymousClass${++this.anonCounter}`;
    const qname = this.q(scope, name);
    const decl: DeclFact = {
      kind: 'class',
      classKind: 'class',
      name,
      qname,
      parentQname: scope.qname,
      span: spanOf(n, this.ctx.path),
      isExported: exported,
      isAbstract: n.type === 'abstract_class_declaration',
      extends: [],
      implements: [],
      decorators: [],
      loc: n.endPosition.row - n.startPosition.row + 1,
    };
    const heritage = n.namedChildren.find((c) => c.type === 'class_heritage');
    if (heritage) {
      for (const h of heritage.namedChildren) {
        if (h.type === 'extends_clause')
          for (const v of h.namedChildren) if (v.type !== 'type_arguments') decl.extends!.push(dottedText(v));
        if (h.type === 'implements_clause')
          for (const v of h.namedChildren) decl.implements!.push(dottedText(v).replace(/<.*$/, ''));
      }
    }
    for (const d of this.decoratorsOf(n)) {
      const { name: dn, args } = this.decoratorName(d);
      decl.decorators!.push(dn);
      if (dn === 'Controller') {
        const prefix = stringValue(args?.namedChildren[0]) ?? '';
        this.controllerPrefix = prefix;
      }
    }
    this.facts.decls.push(decl);
    if (exported)
      this.facts.exports.push({ name: forcedName === 'default' ? 'default' : name, local: name, span: decl.span });
    const body = field(n, 'body');
    const savedPrefix = this.controllerPrefix;
    if (body) this.visitChildren(body, { qname }, false, qname);
    this.controllerPrefix = savedPrefix;
  }

  private interfaceDecl(n: SyntaxNode, scope: Scope, exported: boolean): void {
    const name = field(n, 'name')?.text;
    if (!name) return;
    const decl: DeclFact = {
      kind: 'class',
      classKind: 'interface',
      name,
      qname: this.q(scope, name),
      parentQname: scope.qname,
      span: spanOf(n, this.ctx.path),
      isExported: exported,
      extends: [],
      loc: n.endPosition.row - n.startPosition.row + 1,
    };
    const ext = n.namedChildren.find((c) => c.type === 'extends_type_clause');
    if (ext) for (const v of ext.namedChildren) decl.extends!.push(dottedText(v).replace(/<.*$/, ''));
    this.facts.decls.push(decl);
    if (exported) this.facts.exports.push({ name, span: decl.span });
  }

  private functionDecl(
    n: SyntaxNode,
    scope: Scope,
    exported: boolean,
    kind: 'function' | 'method',
    classQname: string | undefined,
  ): void {
    const nameNode = field(n, 'name');
    const name = nameNode?.text ?? `anonymous${++this.anonCounter}`;
    this.functionLike(n, name, scope, exported, kind, n, classQname);
  }

  private functionLike(
    fn: SyntaxNode,
    name: string,
    scope: Scope,
    exported: boolean,
    kind: 'function' | 'method',
    declNode: SyntaxNode,
    classQname: string | undefined,
  ): void {
    const qname = this.q(scope, name);
    const params = field(fn, 'parameters');
    const paramNames = params
      ? params.namedChildren.map((p) => (field(p, 'pattern') ?? p).text.replace(/\s+/g, ' ').slice(0, 40))
      : [];
    const decl: DeclFact = {
      kind,
      name,
      qname,
      parentQname: scope.qname,
      span: spanOf(declNode, this.ctx.path),
      isExported: exported,
      isAsync: declNode.children.some((c) => c.type === 'async') || fn.children.some((c) => c.type === 'async'),
      isStatic: declNode.children.some((c) => c.type === 'static'),
      params: paramNames,
      signature: `${name}(${paramNames.join(', ')})`,
      complexity: complexityOf(fn),
      decorators: [],
      loc: fn.endPosition.row - fn.startPosition.row + 1,
    };
    const accessibility = declNode.namedChildren.find((c) => c.type === 'accessibility_modifier');
    if (accessibility) decl.visibility = accessibility.text as DeclFact['visibility'];
    for (const d of this.decoratorsOf(declNode)) {
      const { name: dn, args } = this.decoratorName(d);
      decl.decorators!.push(dn);
      if (NEST_METHOD_DECORATORS.has(dn)) {
        const sub = stringValue(args?.namedChildren[0]) ?? '';
        const p = joinPath(this.controllerPrefix ?? '', sub);
        this.facts.endpoints.push({
          method: dn === 'All' ? 'ANY' : dn.toUpperCase(),
          path: p,
          framework: 'nestjs',
          handlerRef: qname,
          enclosingQname: qname,
          span: spanOf(d, this.ctx.path),
        });
      }
    }
    this.facts.decls.push(decl);
    if (exported) this.facts.exports.push({ name, span: decl.span });
    const body = field(fn, 'body');
    if (body) this.visitChildren(body, { qname }, false, classQname);
  }

  private variableDecl(n: SyntaxNode, scope: Scope, exported: boolean, classQname: string | undefined): void {
    for (const d of n.namedChildren) {
      if (d.type !== 'variable_declarator') continue;
      const nameNode = field(d, 'name');
      const value = field(d, 'value');
      if (!nameNode) continue;
      if (nameNode.type === 'identifier' && value && FUNCTION_TYPES.has(value.type)) {
        this.functionLike(value, nameNode.text, scope, exported, 'function', d, classQname);
        continue;
      }
      if (nameNode.type === 'identifier' && value) {
        let v = value;
        if (v.type === 'await_expression' && v.namedChildren[0]) v = v.namedChildren[0];
        if (v.type === 'new_expression') {
          const ctor = field(v, 'constructor');
          if (ctor)
            this.facts.bindings.push({
              name: nameNode.text,
              scopeQname: scope.qname,
              ref: dottedText(ctor),
              isNew: true,
            });
        } else if (v.type === 'call_expression') {
          const fn = field(v, 'function');
          if (fn && (fn.type === 'identifier' || fn.type === 'member_expression'))
            this.facts.bindings.push({
              name: nameNode.text,
              scopeQname: scope.qname,
              ref: dottedText(fn),
              isNew: false,
            });
        }
      }
      // require() import
      if (value?.type === 'call_expression' && field(value, 'function')?.text === 'require') {
        const spec = stringValue(field(value, 'arguments')?.namedChildren[0]);
        if (spec) {
          const imp: ImportFact = { specifier: spec, names: [], span: spanOf(d, this.ctx.path) };
          if (nameNode.type === 'identifier') imp.namespace = nameNode.text;
          else if (nameNode.type === 'object_pattern') {
            for (const p of nameNode.namedChildren) {
              if (p.type === 'shorthand_property_identifier_pattern')
                imp.names.push({ imported: p.text, local: p.text });
              else if (p.type === 'pair_pattern') {
                const k = field(p, 'key')?.text;
                const v = field(p, 'value')?.text;
                if (k && v) imp.names.push({ imported: k, local: v });
              }
            }
          }
          this.facts.imports.push(imp);
          continue;
        }
      }
      if (!scope.qname && nameNode.type === 'identifier') {
        // module-level variable
        this.facts.decls.push({
          kind: 'variable',
          name: nameNode.text,
          qname: nameNode.text,
          span: spanOf(d, this.ctx.path),
          isExported: exported,
          loc: d.endPosition.row - d.startPosition.row + 1,
        });
        if (exported) this.facts.exports.push({ name: nameNode.text, span: spanOf(d, this.ctx.path) });
        if (value) this.visit(value, { qname: nameNode.text }, false, classQname);
        continue;
      }
      if (value) this.visit(value, scope, false, classQname);
    }
  }

  private callExpression(n: SyntaxNode, scope: Scope, classQname: string | undefined): void {
    const fnNode = field(n, 'function');
    const args = field(n, 'arguments');
    if (!fnNode) return;
    const argCount = args?.namedChildCount ?? 0;
    const span = spanOf(n, this.ctx.path);

    // dynamic import / require
    if (fnNode.type === 'import' || fnNode.text === 'require') {
      const spec = stringValue(args?.namedChildren[0]);
      if (spec) this.facts.imports.push({ specifier: spec, names: [], isDynamic: fnNode.type === 'import', span });
      return;
    }

    let callee = fnNode.type === 'identifier' || fnNode.type === 'member_expression' ? dottedText(fnNode) : '';
    if (fnNode.type === 'await_expression' || fnNode.type === 'parenthesized_expression') callee = '';
    if (callee && !callee.includes('(')) {
      this.facts.calls.push({ callee, callerQname: scope.qname, argCount, span });
    }

    // Express/Fastify/Koa/Hono style routes: x.get('/path', ...handlers)
    if (fnNode.type === 'member_expression' && args) {
      const prop = field(fnNode, 'property')?.text ?? '';
      if (HTTP_METHODS.has(prop)) {
        const first = args.namedChildren[0];
        const p = stringValue(first);
        if (p !== undefined && (p.startsWith('/') || p === '*' || p.startsWith('http'))) {
          const last = args.namedChildren[args.namedChildren.length - 1];
          let handlerRef: string | undefined;
          if (last && last !== first) {
            if (last.type === 'identifier' || last.type === 'member_expression') handlerRef = dottedText(last);
            else if (FUNCTION_TYPES.has(last.type)) {
              const name = `${prop.toUpperCase()} ${p}`;
              this.functionLike(last, name, scope, false, 'function', last, classQname);
              handlerRef = this.q(scope, name);
            }
          }
          const method = prop === 'use' ? 'USE' : prop === 'all' || prop === 'route' ? 'ANY' : prop.toUpperCase();
          if (prop !== 'use' || argCount > 1) {
            this.facts.endpoints.push({
              method,
              path: p,
              framework: this.guessFramework(),
              handlerRef,
              enclosingQname: scope.qname,
              span,
            });
          }
        }
      }
      // fastify.route({ method, url, handler })
      if (prop === 'route' && args.namedChildren[0]?.type === 'object') {
        const obj = args.namedChildren[0];
        let method = 'ANY';
        let url: string | undefined;
        let handlerRef: string | undefined;
        for (const pair of obj.namedChildren) {
          if (pair.type !== 'pair') continue;
          const k = field(pair, 'key')?.text;
          const v = field(pair, 'value');
          if (k === 'method') method = stringValue(v) ?? 'ANY';
          if (k === 'url' || k === 'path') url = stringValue(v);
          if (k === 'handler' && v)
            handlerRef = v.type === 'identifier' || v.type === 'member_expression' ? dottedText(v) : undefined;
        }
        if (url)
          this.facts.endpoints.push({
            method: method.toUpperCase(),
            path: url,
            framework: 'fastify',
            handlerRef,
            enclosingQname: scope.qname,
            span,
          });
      }
    }
  }

  private guessFramework(): string {
    for (const f of ['fastify', 'express', 'koa', 'hono', 'hapi']) if (this.ctx.frameworks.has(f)) return f;
    return 'http';
  }

  /** Next.js style file routes: pages/api/... and app/.../route.ts */
  detectFileRoutes(): void {
    const p = this.ctx.path;
    const m1 = /(^|\/)pages\/api\/(.+)\.[cm]?[jt]sx?$/.exec(p);
    if (m1) {
      const route = `/api/${m1[2]
        .replace(/\/index$/, '')
        .replace(/\[\.\.\.(\w+)\]/g, '*$1')
        .replace(/\[(\w+)\]/g, ':$1')}`;
      const handler = this.facts.exports.find((e) => e.name === 'default');
      this.facts.endpoints.push({
        method: 'ANY',
        path: route === '/api/index' ? '/api' : route,
        framework: 'nextjs',
        handlerRef: handler?.local,
        span: { file: p, startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
      });
    }
    const m2 = /(^|\/)app\/(.*?)\/?route\.[cm]?[jt]sx?$/.exec(p);
    if (m2) {
      const route = `/${m2[2]
        .replace(/\(.*?\)\/?/g, '')
        .replace(/\[\.\.\.(\w+)\]/g, '*$1')
        .replace(/\[(\w+)\]/g, ':$1')}`;
      for (const e of this.facts.exports) {
        if (['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(e.name)) {
          this.facts.endpoints.push({
            method: e.name,
            path: route,
            framework: 'nextjs',
            handlerRef: e.local ?? e.name,
            span: e.span,
          });
        }
      }
    }
  }
}

function joinPath(a: string, b: string): string {
  const x = a.replace(/\/+$/, '');
  const y = b.replace(/^\/+/, '');
  const joined = `${x}/${y}`.replace(/\/+$/, '');
  return joined.startsWith('/') ? joined || '/' : `/${joined}`;
}

export const typescriptExtractor = new TypeScriptExtractor();
