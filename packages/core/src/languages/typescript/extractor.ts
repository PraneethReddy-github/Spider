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
  type MountFact,
  complexityOf,
  countLoc,
  dottedText,
  spanOf,
} from '../types.js';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'head', 'all', 'use', 'route', 'ws']);
const NEST_METHOD_DECORATORS = new Set(['Get', 'Post', 'Put', 'Delete', 'Patch', 'Options', 'Head', 'All']);
/** Wrapper generics unwrapped when typing a receiver from an annotation. */
const WRAPPER_TYPES = new Set(['Promise', 'PromiseLike', 'Readonly', 'Awaited', 'NonNullable', 'Required']);
const TYPE_REF_NODES = new Set(['type_identifier', 'nested_type_identifier']);
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
  private controllerClass: string | undefined;
  private anonCounter = 0;
  /** Router variable → its own prefix (Koa `new Router({ prefix })`, Hono `.basePath()`). */
  private routerPrefixes = new Map<string, string>();
  private seenRefs = new Set<string>();

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
          this.typeRefs(field(n, 'value'), this.q(scope, name));
          this.typeRefs(field(n, 'type_parameters'), this.q(scope, name));
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
          return;
        }
        const type = field(n, 'type');
        const typeName = typeNameOf(type);
        if (classQname && name && typeName)
          this.facts.bindings.push({
            name: `this.${name}`,
            scopeQname: classQname,
            ref: typeName,
            isNew: true,
            isType: true,
          });
        this.typeRefs(type, scope.qname);
        this.decoratorRefs(n, scope.qname);
        if (value) this.visit(value, scope, false, classQname);
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
      case 'type_identifier':
      case 'nested_type_identifier':
        this.ref(n, scope.qname);
        return;
      case 'assignment_expression': {
        // this.x = new X() → field typing for `this.x.method()`
        const left = field(n, 'left');
        const right = field(n, 'right');
        if (classQname && left?.type === 'member_expression' && field(left, 'object')?.type === 'this') {
          const ctor = right?.type === 'new_expression' ? field(right, 'constructor') : null;
          const prop = field(left, 'property')?.text;
          if (ctor && prop)
            this.facts.bindings.push({
              name: `this.${prop}`,
              scopeQname: classQname,
              ref: dottedText(ctor),
              isNew: true,
            });
        }
        this.visitChildren(n, scope, false, classQname);
        return;
      }
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
        this.facts.exports.push({ name: 'default', local: value.type === 'identifier' ? value.text : undefined, span });
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
        // generic arguments in heritage clauses (`extends Repo<User>`) are references
        for (const v of h.namedChildren) this.typeRefs(field(v, 'type_arguments'), qname);
        for (const v of h.namedChildren) if (v.type === 'type_arguments') this.typeRefs(v, qname);
      }
    }
    this.typeRefs(field(n, 'type_parameters'), qname);
    const savedPrefix = this.controllerPrefix;
    const savedController = this.controllerClass;
    for (const d of this.decoratorsOf(n)) {
      const { name: dn, args } = this.decoratorName(d);
      decl.decorators!.push(dn);
      this.decoratorRef(d, qname);
      const arg0 = args?.namedChildren[0];
      if (dn === 'Controller') {
        const prefix = (arg0?.type === 'object' ? stringValue(objectProp(arg0, 'path')) : stringValue(arg0)) ?? '';
        this.controllerPrefix = prefix;
        this.controllerClass = qname;
        (this.facts.routers ??= []).push({ name: qname, prefix: prefix ? joinPath(prefix, '') : '' });
      }
      // @Module({ controllers: [A, B] }) → controllers are mounted under the module (NestJS RouterModule)
      if (dn === 'Module' && arg0?.type === 'object') {
        const list = objectProp(arg0, 'controllers');
        for (const c of list?.type === 'array' ? list.namedChildren : [])
          if (c.type === 'identifier' || c.type === 'member_expression')
            this.mount({ prefix: '', target: dottedText(c), parent: qname, span: spanOf(c, this.ctx.path) });
        // imports: [RouterModule.register([...])] — decorator arguments are not walked for calls
        const imps = objectProp(arg0, 'imports');
        for (const c of imps?.type === 'array' ? imps.namedChildren : [])
          if (c.type === 'call_expression' && field(c, 'function')?.text === 'RouterModule.register')
            this.nestRoutes(field(c, 'arguments')?.namedChildren[0], undefined);
      }
    }
    this.facts.decls.push(decl);
    if (exported)
      this.facts.exports.push({ name: forcedName === 'default' ? 'default' : name, local: name, span: decl.span });
    const body = field(n, 'body');
    if (body) this.visitChildren(body, { qname }, false, qname);
    this.controllerPrefix = savedPrefix;
    this.controllerClass = savedController;
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
    if (ext) for (const v of ext.namedChildren) this.typeRefs(field(v, 'type_arguments'), decl.qname);
    this.typeRefs(field(n, 'type_parameters'), decl.qname);
    this.typeRefs(field(n, 'body'), decl.qname);
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
    this.paramTyping(params, qname, kind === 'method' && name === 'constructor' ? classQname : undefined);
    const returnType = field(fn, 'return_type');
    decl.returns = typeNameOf(returnType);
    this.typeRefs(returnType, qname);
    this.typeRefs(field(fn, 'type_parameters'), qname);
    for (const d of this.decoratorsOf(declNode)) {
      const { name: dn, args } = this.decoratorName(d);
      decl.decorators!.push(dn);
      this.decoratorRef(d, qname);
      if (NEST_METHOD_DECORATORS.has(dn)) {
        const sub = stringValue(args?.namedChildren[0]) ?? '';
        const p = joinPath(this.controllerPrefix ?? '', sub);
        this.facts.endpoints.push({
          method: dn === 'All' ? 'ANY' : dn.toUpperCase(),
          path: p,
          framework: 'nestjs',
          handlerRef: qname,
          enclosingQname: qname,
          receiver: this.controllerClass,
          receiverPrefix: this.controllerPrefix ? joinPath(this.controllerPrefix, '') : undefined,
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
      const type = field(d, 'type');
      this.typeRefs(type, scope.qname ?? (nameNode.type === 'identifier' ? nameNode.text : undefined));
      if (nameNode.type === 'identifier' && value) this.routerPrefix(nameNode.text, value);
      // Next.js middleware `export const config = { matcher: '/x' | ['/a', '/b'] }`
      if (!scope.qname && nameNode.text === 'config' && value?.type === 'object') {
        const m = objectProp(value, 'matcher');
        const list = m?.type === 'array' ? m.namedChildren.map((x) => stringValue(x)) : [stringValue(m)];
        const matchers = list.filter((x): x is string => x !== undefined);
        if (matchers.length) this.facts.hints.nextMatcher = matchers;
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
      // `const x: Foo = …` — the annotation wins over the initialiser
      const typeName = nameNode.type === 'identifier' ? typeNameOf(type) : undefined;
      if (typeName)
        this.facts.bindings.push({
          name: nameNode.text,
          scopeQname: scope.qname,
          ref: typeName,
          isNew: true,
          isType: true,
        });
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
      const objNode = field(fnNode, 'object');
      const receiver = objNode?.type === 'identifier' ? objNode.text : undefined;
      if (prop === 'setGlobalPrefix') {
        const gp = stringValue(args.namedChildren[0]);
        if (gp !== undefined) this.mount({ prefix: gp, target: '', global: true, framework: 'nestjs', span });
      }
      if (prop === 'register' && objNode?.text === 'RouterModule') this.nestRoutes(args.namedChildren[0], undefined);
      if (prop === 'prefix' && receiver && this.ctx.frameworks.has('koa')) {
        const kp = stringValue(args.namedChildren[0]);
        if (kp !== undefined) this.setRouterPrefix(receiver, kp);
      }
      if (HTTP_METHODS.has(prop)) {
        let first = args.namedChildren[0];
        let p = stringValue(first);
        // koa-router named routes: router.get('name', '/path', handler)
        const second = args.namedChildren[1];
        const p2 = second ? stringValue(second) : undefined;
        if (p !== undefined && !p.startsWith('/') && p2?.startsWith('/') && this.ctx.frameworks.has('koa')) {
          first = second;
          p = p2;
        }
        // mounts: app.route('/x', sub) (Hono) · router.use('/x', sub.routes()) (Koa) · app.use('/x', router)
        if (p !== undefined && (prop === 'route' || prop === 'use') && args.namedChildren.length >= 2) {
          const t = mountTarget(
            prop === 'route' ? args.namedChildren[1] : args.namedChildren[args.namedChildren.length - 1],
          );
          const koaT = mountTarget(args.namedChildren[1]);
          const target = prop === 'use' && koaT && args.namedChildren[1]?.type === 'call_expression' ? koaT : t;
          if (target) this.mount({ prefix: p, target, parent: receiver, span });
        }
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
            const own = receiver ? this.routerPrefixes.get(receiver) : undefined;
            this.facts.endpoints.push({
              method,
              path: own ? joinUrl(own, p) : p,
              framework: this.guessFramework(),
              handlerRef,
              enclosingQname: scope.qname,
              receiver,
              receiverPrefix: own,
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

  private ref(n: SyntaxNode, scopeQname: string | undefined): void {
    const name = dottedText(n);
    const key = `${scopeQname ?? ''}\0${name}`;
    if (this.seenRefs.has(key)) return;
    this.seenRefs.add(key);
    (this.facts.references ??= []).push({ name, scopeQname, span: spanOf(n, this.ctx.path) });
  }

  /** All type names used inside a type subtree (annotations, generics, alias bodies, interface bodies). */
  private typeRefs(n: SyntaxNode | null | undefined, scopeQname: string | undefined): void {
    if (!n) return;
    if (TYPE_REF_NODES.has(n.type)) {
      this.ref(n, scopeQname);
      return;
    }
    for (const c of n.namedChildren) this.typeRefs(c, scopeQname);
  }

  /** `@Deco(arg)` → references to `Deco` and to identifier arguments (`@UseGuards(AuthGuard)`). */
  private decoratorRef(d: SyntaxNode, scopeQname: string): void {
    const inner = d.namedChildren[0];
    if (!inner) return;
    const head = inner.type === 'call_expression' ? field(inner, 'function') : inner;
    if (head && (head.type === 'identifier' || head.type === 'member_expression')) this.ref(head, scopeQname);
    const args = inner.type === 'call_expression' ? field(inner, 'arguments') : null;
    for (const a of args?.namedChildren ?? []) if (a.type === 'identifier') this.ref(a, scopeQname);
  }

  private decoratorRefs(n: SyntaxNode, scopeQname: string | undefined): void {
    if (!scopeQname) return;
    for (const d of this.decoratorsOf(n)) this.decoratorRef(d, scopeQname);
  }

  /** `param: Type` → binding (receiver typing); constructor parameter properties → `this.param`. */
  private paramTyping(params: SyntaxNode | null, qname: string, ctorClass: string | undefined): void {
    for (const p of params?.namedChildren ?? []) {
      const pattern = field(p, 'pattern');
      const type = field(p, 'type');
      this.typeRefs(type, qname);
      this.decoratorRefs(p, qname);
      const typeName = typeNameOf(type);
      if (pattern?.type !== 'identifier' || !typeName) continue;
      this.facts.bindings.push({ name: pattern.text, scopeQname: qname, ref: typeName, isNew: true, isType: true });
      const isProperty = p.namedChildren.some((c) => c.type === 'accessibility_modifier' || c.text === 'readonly');
      if (ctorClass && isProperty)
        this.facts.bindings.push({
          name: `this.${pattern.text}`,
          scopeQname: ctorClass,
          ref: typeName,
          isNew: true,
          isType: true,
        });
    }
  }

  private setRouterPrefix(name: string, prefix: string): void {
    this.routerPrefixes.set(name, prefix);
    (this.facts.routers ??= []).push({ name, prefix });
  }

  /** `new Router({ prefix: '/x' })` (Koa) and `new Hono().basePath('/x')` / `x.basePath('/x')`. */
  private routerPrefix(name: string, value: SyntaxNode): void {
    if (value.type === 'new_expression') {
      const arg = field(value, 'arguments')?.namedChildren[0];
      const ctor = field(value, 'constructor')?.text ?? '';
      if (/Router$/.test(ctor) && arg?.type === 'object') {
        const prefix = stringValue(objectProp(arg, 'prefix'));
        if (prefix !== undefined) this.setRouterPrefix(name, prefix);
      }
      return;
    }
    const fn = value.type === 'call_expression' ? field(value, 'function') : null;
    if (fn?.type === 'member_expression' && field(fn, 'property')?.text === 'basePath') {
      const prefix = stringValue(field(value, 'arguments')?.namedChildren[0]);
      if (prefix !== undefined) this.setRouterPrefix(name, prefix);
    }
  }

  private mount(m: MountFact): void {
    (this.facts.mounts ??= []).push(m);
  }

  /** NestJS `RouterModule.register([{ path, module, children }])`, children nested under their parent. */
  private nestRoutes(list: SyntaxNode | undefined, parent: string | undefined): void {
    for (const o of list?.type === 'array' ? list.namedChildren : []) {
      if (o.type !== 'object') continue;
      const path = stringValue(objectProp(o, 'path')) ?? '';
      const mod = objectProp(o, 'module');
      const modRef =
        mod && (mod.type === 'identifier' || mod.type === 'member_expression') ? dottedText(mod) : undefined;
      if (modRef) this.mount({ prefix: path, target: modRef, parent, span: spanOf(o, this.ctx.path) });
      // shortcut: a child entry without its own `module` loses its path segment; follow up if seen in the wild
      this.nestRoutes(objectProp(o, 'children'), modRef ?? parent);
    }
  }

  /** Next.js `middleware.ts` / `proxy.ts` at the app root: one `USE` endpoint per `config.matcher`. */
  private nextMiddleware(): void {
    const p = this.ctx.path;
    if (!this.ctx.frameworks.has('nextjs') || !/(^|\/)(src\/)?(middleware|proxy)\.[cm]?[jt]s$/.test(p)) return;
    if (/(^|\/)node_modules\//.test(p)) return;
    const fnName = ['middleware', 'proxy', 'default'].find((n) => this.facts.exports.some((e) => e.name === n));
    if (!fnName) return;
    const ex = this.facts.exports.find((e) => e.name === fnName)!;
    const matchers = (this.facts.hints.nextMatcher as string[] | undefined) ?? ['/*'];
    for (const m of matchers)
      this.facts.endpoints.push({
        method: 'USE',
        path: m,
        framework: 'nextjs',
        handlerRef: ex.local ?? ex.name,
        span: ex.span,
      });
  }

  private guessFramework(): string {
    for (const f of ['fastify', 'express', 'koa', 'hono', 'hapi']) if (this.ctx.frameworks.has(f)) return f;
    return 'http';
  }

  /** Next.js style file routes: pages/api/... and app/.../route.ts */
  detectFileRoutes(): void {
    const p = this.ctx.path;
    this.nextMiddleware();
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

/** The class-like name of a type annotation for receiver typing; undefined for unions, arrays, literals. */
function typeNameOf(n: SyntaxNode | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'type_annotation' || n.type === 'parenthesized_type') return typeNameOf(n.namedChildren[0]);
  if (n.type === 'type_identifier' || n.type === 'nested_type_identifier') return dottedText(n);
  if (n.type === 'generic_type') {
    const name = field(n, 'name');
    if (name && WRAPPER_TYPES.has(name.text)) return typeNameOf(field(n, 'type_arguments')?.namedChildren[0]);
    return name ? dottedText(name) : undefined;
  }
  if (n.type === 'union_type') {
    // `X | null | undefined` → X; any other union is ambiguous
    const parts: SyntaxNode[] = [];
    const flat = (u: SyntaxNode) => {
      for (const c of u.namedChildren) c.type === 'union_type' ? flat(c) : parts.push(c);
    };
    flat(n);
    const real = parts.filter((c) => !/^(null|undefined|void)$/.test(c.text));
    return real.length === 1 ? typeNameOf(real[0]) : undefined;
  }
  return undefined;
}

function objectProp(obj: SyntaxNode, key: string): SyntaxNode | undefined {
  for (const pair of obj.namedChildren) {
    const k = pair.type === 'pair' ? field(pair, 'key') : null;
    if (k && (stringValue(k) ?? k.text) === key) return field(pair, 'value') ?? undefined;
  }
  return undefined;
}

/** Mounted router reference: `sub`, `routes.sub`, or `sub.routes()` / `sub.middleware()` (Koa). */
function mountTarget(n: SyntaxNode | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'identifier' || n.type === 'member_expression') return dottedText(n);
  if (n.type === 'call_expression') {
    const fn = field(n, 'function');
    const prop = fn?.type === 'member_expression' ? field(fn, 'property')?.text : undefined;
    const obj = fn?.type === 'member_expression' ? field(fn, 'object') : null;
    if (
      (prop === 'routes' || prop === 'middleware') &&
      obj &&
      (obj.type === 'identifier' || obj.type === 'member_expression')
    )
      return dottedText(obj);
  }
  return undefined;
}

function joinUrl(a: string, b: string): string {
  if (!a) return b;
  if (!b || b === '/') return a; // koa-router / Hono: `/` under a prefix is the bare prefix
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}

function joinPath(a: string, b: string): string {
  const x = a.replace(/\/+$/, '');
  const y = b.replace(/^\/+/, '');
  const joined = `${x}/${y}`.replace(/\/+$/, '');
  return joined.startsWith('/') ? joined || '/' : `/${joined}`;
}

export const typescriptExtractor = new TypeScriptExtractor();
