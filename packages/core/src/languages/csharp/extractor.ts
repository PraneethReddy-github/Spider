import type { SyntaxNode } from '../../parse/parser.js';
import { field, stringValue } from '../../parse/parser.js';
import { type Annotation, FactBuilder, joinRoute, locOf, typeHead, withSlash } from '../jvm/common.js';
import { type DeclFact, type ExtractContext, type FileFacts, type LanguageExtractor, complexityOf } from '../types.js';

interface Scope {
  qname?: string;
  cls?: string;
  ns: string;
  /** ASP.NET Core controller: class name and class-level route templates. */
  controller?: { name: string; routes: string[] };
}

const TYPE_DECLS: Record<string, NonNullable<DeclFact['classKind']>> = {
  class_declaration: 'class',
  record_declaration: 'class',
  record_struct_declaration: 'struct',
  struct_declaration: 'struct',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
};

const HTTP_ATTRS: Record<string, string> = {
  HttpGet: 'GET',
  HttpPost: 'POST',
  HttpPut: 'PUT',
  HttpDelete: 'DELETE',
  HttpPatch: 'PATCH',
  HttpHead: 'HEAD',
  HttpOptions: 'OPTIONS',
};

const MAP_VERBS: Record<string, string> = {
  MapGet: 'GET',
  MapPost: 'POST',
  MapPut: 'PUT',
  MapDelete: 'DELETE',
  MapPatch: 'PATCH',
  Map: 'ANY',
};

class CSharpExtractor {
  private b: FactBuilder;
  /** Minimal-API route groups: variable → prefix (`var g = app.MapGroup("/x")`). */
  private groups = new Map<string, string>();

  constructor(ctx: ExtractContext) {
    this.b = new FactBuilder(ctx);
  }

  run(root: SyntaxNode): FileFacts {
    this.visit(root, { ns: '' });
    return this.b.finish();
  }

  private visit(n: SyntaxNode, s: Scope): void {
    const kind = TYPE_DECLS[n.type];
    if (kind) {
      this.typeDecl(n, s, kind);
      return;
    }
    switch (n.type) {
      case 'using_directive': {
        this.using(n);
        return;
      }
      case 'namespace_declaration':
      case 'file_scoped_namespace_declaration': {
        const name = field(n, 'name')?.text ?? '';
        const ns = s.ns ? `${s.ns}.${name}` : name;
        this.b.declarePackage(ns);
        for (const c of n.namedChildren) if (c.startIndex !== field(n, 'name')?.startIndex) this.visit(c, { ...s, ns });
        // a file-scoped namespace applies to the rest of the file
        if (n.type === 'file_scoped_namespace_declaration') s.ns = ns;
        return;
      }
      case 'method_declaration':
      case 'constructor_declaration':
      case 'local_function_statement':
        if (s.cls || n.type === 'local_function_statement') {
          this.method(n, s);
          return;
        }
        break;
      case 'field_declaration':
      case 'event_field_declaration':
        if (s.cls) {
          this.fieldDecl(n, s);
          return;
        }
        break;
      case 'property_declaration':
        if (s.cls) this.propertyDecl(n, s.cls);
        break;
      case 'local_declaration_statement':
        this.localDecl(n, s);
        break;
      case 'for_each_statement': {
        const name = field(n, 'left');
        const t = field(n, 'type');
        if (name?.type === 'identifier' && t) this.typed(name.text, t, s.qname);
        break;
      }
      case 'catch_declaration': {
        const t = field(n, 'type');
        const name = field(n, 'name')?.text;
        if (t && name) this.typed(name, t, s.qname);
        break;
      }
      case 'invocation_expression':
        if (this.minimalApi(n, s)) return;
        this.b.call(calleeOf(field(n, 'function')), s.qname, n, argCount(n));
        break;
      case 'object_creation_expression':
        this.b.call(typeHead(field(n, 'type')?.text), s.qname, n, argCount(n), true);
        break;
    }
    for (const c of n.namedChildren) this.visit(c, s);
  }

  private using(n: SyntaxNode): void {
    const alias = n.namedChildren.find((c) => c.type === 'name_equals')?.namedChildren[0]?.text;
    const target = n.namedChildren.find((c) => c.type === 'qualified_name' || c.type === 'identifier');
    if (!target || (alias && target.startIndex === n.namedChildren[0]?.startIndex)) return;
    if (alias) this.b.imp(target.text, n, { alias });
    else this.b.imp(target.text, n, { wildcard: true }); // namespace or `using static` type
  }

  private typeDecl(n: SyntaxNode, s: Scope, classKind: NonNullable<DeclFact['classKind']>): void {
    const name = field(n, 'name')?.text;
    if (!name) return;
    const qname = s.cls ? `${s.cls}.${name}` : name;
    const mods = modifiersOf(n);
    const anns = attributesOf(n);
    const ext: string[] = [];
    const impl: string[] = [];
    const bases = (field(n, 'bases') ?? n.namedChildren.find((c) => c.type === 'base_list'))?.namedChildren ?? [];
    bases.forEach((b, i) => {
      const t = typeHead(b.type === 'primary_constructor_base_type' ? b.namedChildren[0]?.text : b.text);
      if (!t) return;
      // C# lists the base class first; `IName` is the interface naming convention
      const isIface = classKind === 'interface' || i > 0 || /^I[A-Z]/.test(t.split('.').pop() ?? '');
      (classKind === 'interface' ? ext : isIface ? impl : ext).push(t);
    });
    const decl: DeclFact = {
      kind: 'class',
      classKind,
      name,
      qname,
      parentQname: s.cls,
      span: this.b.span(n),
      isExported: mods.includes('public') || mods.includes('internal') || mods.includes('protected'),
      isAbstract: mods.includes('abstract') || undefined,
      isStatic: mods.includes('static') || undefined,
      visibility: visibilityOf(mods),
      extends: ext,
      implements: impl,
      decorators: anns.map((a) => a.name),
      loc: locOf(n),
    };
    this.b.decl(decl, s.cls ? undefined : s.ns);
    for (const a of anns) this.b.ref(a.name, qname, a.node);
    for (const b of bases) this.typeRefs(b, qname, false);
    // positional record parameters are properties
    for (const p of field(n, 'parameters')?.namedChildren ?? []) {
      const pn = field(p, 'name')?.text;
      if (pn) this.b.field(pn, qname, typeHead(field(p, 'type')?.text));
      this.typeRefs(field(p, 'type'), qname);
    }
    const inner: Scope = { ...s, qname, cls: qname, controller: aspnetController(name, anns, ext) };
    for (const c of field(n, 'body')?.namedChildren ?? []) this.visit(c, inner);
  }

  private method(n: SyntaxNode, s: Scope): void {
    const isCtor = n.type === 'constructor_declaration';
    const name = isCtor ? 'constructor' : field(n, 'name')?.text;
    const parent = n.type === 'local_function_statement' ? s.qname : s.cls;
    if (!name) return;
    const qname = this.b.uniqueQname(parent ? `${parent}.${name}` : name);
    const mods = modifiersOf(n);
    const anns = attributesOf(n);
    const params: string[] = [];
    for (const p of field(n, 'parameters')?.namedChildren ?? []) {
      const pn = field(p, 'name')?.text;
      const t = field(p, 'type');
      if (!pn) continue;
      params.push(pn);
      if (t) this.typed(pn, t, qname);
      for (const a of attributesOf(p)) this.b.ref(a.name, qname, a.node);
    }
    const body = field(n, 'body') ?? n.namedChildren.find((c) => c.type === 'arrow_expression_clause');
    const retType = field(n, 'returns') ?? field(n, 'type');
    const decl: DeclFact = {
      kind: s.cls ? 'method' : 'function',
      name,
      qname,
      parentQname: parent,
      span: this.b.span(n),
      isExported: mods.includes('public') || mods.includes('internal') || mods.includes('protected'),
      isStatic: mods.includes('static') || undefined,
      isAsync: mods.includes('async') || undefined,
      isAbstract: !body || mods.includes('abstract') || undefined,
      visibility: visibilityOf(mods),
      params,
      signature: `${name}(${params.join(', ')})`,
      returns: unwrapTask(typeHead(retType?.text), retType),
      decorators: anns.map((a) => a.name),
      complexity: body ? complexityOf(body) : 1,
      loc: locOf(n),
    };
    this.b.decl(decl);
    this.typeRefs(retType, qname);
    for (const a of anns) this.b.ref(a.name, qname, a.node);
    if (s.controller && !isCtor && n.type === 'method_declaration') this.actionRoutes(s.controller, name, anns, qname);
    const init = n.namedChildren.find((c) => c.type === 'constructor_initializer');
    const inner = { ...s, qname };
    if (init) this.visit(init, inner);
    if (body) this.visit(body, inner);
  }

  /** ASP.NET Core attribute routing: class `[Route]` × action `[HttpX("t")]` / `[Route]`. */
  private actionRoutes(ctl: { name: string; routes: string[] }, action: string, anns: Annotation[], qname: string) {
    const methodRoutes = anns.filter((a) => a.name === 'Route').map((a) => a.positional[0]?.[0] ?? '');
    const pairs: { verb: string; tpl: string; node: SyntaxNode }[] = [];
    for (const a of anns) {
      const verb = HTTP_ATTRS[a.name];
      if (!verb) continue;
      const tpl = a.positional[0]?.[0] ?? a.named.Template?.[0];
      for (const t of tpl !== undefined ? [tpl] : methodRoutes.length ? methodRoutes : [''])
        pairs.push({ verb, tpl: t, node: a.node });
    }
    if (pairs.length === 0)
      for (const a of anns.filter((x) => x.name === 'Route'))
        pairs.push({ verb: 'ANY', tpl: a.positional[0]?.[0] ?? '', node: a.node });
    for (const { verb, tpl, node } of pairs) {
      const absolute = tpl.startsWith('/') || tpl.startsWith('~/');
      for (const base of absolute ? [''] : ctl.routes) {
        const raw = joinRoute(base, tpl.replace(/^~/, ''));
        const path = withSlash(
          raw
            .replace(/\[controller\]/gi, ctl.name)
            .replace(/\[action\]/gi, action)
            .replace(/\{(\*{0,2}\w+)(:[^}?]+)?(\?)?\}/g, '{$1$3}'),
        );
        this.b.facts.endpoints.push({
          method: verb,
          path,
          framework: 'aspnetcore',
          handlerRef: qname,
          enclosingQname: qname,
          span: this.b.span(node),
        });
      }
    }
  }

  /** `app.MapGet("/x", handler)` (incl. `MapGroup` prefixes in the same file). True when handled. */
  private minimalApi(n: SyntaxNode, s: Scope): boolean {
    const fn = field(n, 'function');
    if (fn?.type !== 'member_access_expression') return false;
    const verb = MAP_VERBS[field(fn, 'name')?.text ?? ''];
    const args = field(n, 'arguments')?.namedChildren.filter((c) => c.type === 'argument') ?? [];
    const sub = stringValue(args[0]?.namedChildren[0]);
    if (!verb || sub === undefined || args.length < 2) return false;
    const recv = field(fn, 'expression');
    const path = withSlash(joinRoute(recv ? this.groupPrefix(recv) : '', sub)).replace(/(.)\/$/, '$1');
    const last = args[args.length - 1].namedChildren[0];
    // shortcut: this grammar misparses lambdas with an explicit return type (`async Task<X> (…) =>`) into a
    // binary expression; the lambda is still inside it. Fully broken ones (ERROR nodes) are skipped.
    const h = last?.type === 'binary_expression' ? last.descendantsOfType('lambda_expression')[0] : last;
    let handlerRef: string | undefined;
    let enclosingQname = s.qname;
    if (h?.type === 'lambda_expression' || h?.type === 'anonymous_method_expression') {
      // inline handler → synthetic function so its calls have a caller (as the TS extractor does)
      const name = `${verb} ${path}`;
      const qname = this.b.uniqueQname(s.qname ? `${s.qname}.${name}` : name);
      this.b.decl({
        kind: 'function',
        name,
        qname,
        parentQname: s.qname,
        span: this.b.span(h),
        isExported: false,
        params: [],
        complexity: complexityOf(h),
        loc: locOf(h),
      });
      for (const p of field(h, 'parameters')?.namedChildren ?? []) {
        const pn = field(p, 'name')?.text;
        const t = field(p, 'type');
        if (pn && t) this.typed(pn, t, qname);
      }
      handlerRef = qname;
      enclosingQname = qname;
      const body = field(h, 'body');
      if (body) this.visit(body, { ...s, qname });
    } else if (h) {
      handlerRef = calleeOf(h);
      this.visit(h, s);
    }
    this.b.facts.endpoints.push({
      method: verb,
      path,
      framework: 'aspnetcore',
      handlerRef,
      enclosingQname,
      span: this.b.span(n),
    });
    if (recv) this.visit(recv, s);
    return true;
  }

  private groupPrefix(e: SyntaxNode): string {
    if (e.type === 'identifier') return this.groups.get(e.text) ?? '';
    if (e.type !== 'invocation_expression') return '';
    const fn = field(e, 'function');
    if (fn?.type !== 'member_access_expression') return '';
    const inner = field(fn, 'expression');
    const base = inner ? this.groupPrefix(inner) : '';
    if (field(fn, 'name')?.text !== 'MapGroup') return base;
    const arg = field(e, 'arguments')?.namedChildren[0]?.namedChildren[0];
    return joinRoute(base, stringValue(arg) ?? `{${arg?.text ?? ''}}`);
  }

  private fieldDecl(n: SyntaxNode, s: Scope): void {
    const cls = s.cls as string;
    const v = n.namedChildren.find((c) => c.type === 'variable_declaration');
    const t = v ? field(v, 'type') : null;
    this.typeRefs(t, cls);
    for (const a of attributesOf(n)) this.b.ref(a.name, cls, a.node);
    for (const d of v?.namedChildren.filter((c) => c.type === 'variable_declarator') ?? []) {
      const name = d.namedChildren.find((c) => c.type === 'identifier')?.text;
      const init = initOf(d);
      if (name) this.b.field(name, cls, typeHead(t?.text) ?? newTypeOf(init));
      if (init) this.visit(init, { ...s, qname: cls });
    }
  }

  private propertyDecl(n: SyntaxNode, cls: string): void {
    const name = field(n, 'name')?.text;
    const t = field(n, 'type');
    if (name) this.b.field(name, cls, typeHead(t?.text));
    this.typeRefs(t, cls);
    for (const a of attributesOf(n)) this.b.ref(a.name, cls, a.node);
  }

  private localDecl(n: SyntaxNode, s: Scope): void {
    const v = n.namedChildren.find((c) => c.type === 'variable_declaration');
    const t = v ? field(v, 'type') : null;
    const type = typeHead(t?.text);
    this.typeRefs(t, s.qname);
    for (const d of v?.namedChildren.filter((c) => c.type === 'variable_declarator') ?? []) {
      const name = d.namedChildren.find((c) => c.type === 'identifier')?.text;
      const init = initOf(d);
      if (!name) continue;
      if (init && hasMapGroup(init)) this.groups.set(name, this.groupPrefix(init));
      if (type) this.b.bind(name, s.qname, type, { isType: true });
      else if (init?.type === 'object_creation_expression')
        this.b.bind(name, s.qname, newTypeOf(init), { isNew: true });
      else if (init?.type === 'invocation_expression') this.b.bind(name, s.qname, calleeOf(field(init, 'function')));
      else if (init?.type === 'await_expression' && init.namedChildren[0]?.type === 'invocation_expression')
        this.b.bind(name, s.qname, calleeOf(field(init.namedChildren[0], 'function')));
    }
  }

  private typed(name: string, t: SyntaxNode, scope: string | undefined): void {
    this.b.bind(name, scope, typeHead(t.text), { isType: true });
    this.typeRefs(t, scope);
  }

  private typeRefs(t: SyntaxNode | null | undefined, scope: string | undefined, self = true): void {
    if (!t) return;
    if (t.type === 'identifier' || t.type === 'qualified_name') {
      if (self) this.b.ref(t.text, scope, t);
      return;
    }
    if (t.type === 'generic_name') {
      const id = t.namedChildren.find((c) => c.type === 'identifier');
      if (id && self) this.b.ref(id.text, scope, id);
      for (const c of t.namedChildren) if (c.type === 'type_argument_list') this.typeRefs(c, scope, true);
      return;
    }
    for (const c of t.namedChildren) this.typeRefs(c, scope, self);
  }
}

function hasMapGroup(e: SyntaxNode): boolean {
  for (let cur: SyntaxNode | null = e; cur?.type === 'invocation_expression'; ) {
    const fn = field(cur, 'function');
    if (fn?.type !== 'member_access_expression') return false;
    if (field(fn, 'name')?.text === 'MapGroup') return true;
    cur = field(fn, 'expression');
  }
  return false;
}

function initOf(d: SyntaxNode): SyntaxNode | undefined {
  const eq = d.namedChildren.find((c) => c.type === 'equals_value_clause');
  return eq?.namedChildren[0] ?? d.namedChildren.find((c, i) => i > 0 && c.type !== 'bracketed_argument_list');
}

function newTypeOf(v: SyntaxNode | null | undefined): string | undefined {
  return v?.type === 'object_creation_expression' ? typeHead(field(v, 'type')?.text) : undefined;
}

function argCount(n: SyntaxNode): number {
  return field(n, 'arguments')?.namedChildren.filter((c) => c.type === 'argument').length ?? 0;
}

/** `Task<Foo>` / `ValueTask<Foo>` → `Foo` so awaited results stay typed. */
function unwrapTask(head: string | undefined, t: SyntaxNode | null | undefined): string | undefined {
  if (!t || (head !== 'Task' && head !== 'ValueTask')) return head;
  const m = /<\s*([\w.]+)\s*>$/.exec(t.text);
  return m ? typeHead(m[1]) : undefined;
}

function calleeOf(n: SyntaxNode | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'generic_name') return n.namedChildren.find((c) => c.type === 'identifier')?.text;
  if (n.type === 'conditional_access_expression') {
    const cond = field(n, 'condition');
    const name = n.namedChildren.find((c) => c.type === 'member_binding_expression');
    const h = cond ? dotted(cond) : undefined;
    const m = name ? calleeOf(field(name, 'name')) : undefined;
    return h && m ? `${h}.${m}` : undefined;
  }
  return dotted(n);
}

function dotted(n: SyntaxNode): string | undefined {
  if (n.type === 'identifier') return n.text;
  if (n.type === 'this_expression') return 'this';
  if (n.type === 'base_expression') return 'super';
  if (n.type === 'generic_name') return n.namedChildren.find((c) => c.type === 'identifier')?.text;
  if (n.type === 'member_access_expression') {
    const e = field(n, 'expression');
    const name = field(n, 'name');
    const h = e ? dotted(e) : undefined;
    const m = name ? dotted(name) : undefined;
    return h && m ? `${h}.${m}` : undefined;
  }
  return undefined;
}

function modifiersOf(n: SyntaxNode): string[] {
  return n.namedChildren.filter((c) => c.type === 'modifier').map((c) => c.text);
}

function visibilityOf(mods: string[]): DeclFact['visibility'] {
  for (const v of ['public', 'private', 'protected'] as const) if (mods.includes(v)) return v;
  return undefined;
}

function attributesOf(n: SyntaxNode): Annotation[] {
  const out: Annotation[] = [];
  for (const list of n.namedChildren.filter((c) => c.type === 'attribute_list')) {
    for (const a of list.namedChildren.filter((c) => c.type === 'attribute')) {
      const name = field(a, 'name')
        ?.text.split('.')
        .pop()
        ?.replace(/Attribute$/, '');
      if (!name) continue;
      const ann: Annotation = { name, positional: [], named: {}, node: a };
      const args = a.namedChildren.find((c) => c.type === 'attribute_argument_list');
      for (const arg of args?.namedChildren ?? []) {
        const ne = arg.namedChildren.find((c) => c.type === 'name_equals' || c.type === 'name_colon');
        const v = arg.namedChildren.find((c) => c.type !== 'name_equals' && c.type !== 'name_colon');
        const val = v ? [stringValue(v) ?? `{${v.text}}`] : [];
        if (ne) ann.named[ne.namedChildren[0]?.text ?? ''] = val;
        else ann.positional.push(val);
      }
      out.push(ann);
    }
  }
  return out;
}

function aspnetController(name: string, anns: Annotation[], bases: string[]): Scope['controller'] {
  const isController =
    anns.some((a) => a.name === 'ApiController') ||
    bases.some((b) => b === 'Controller' || b === 'ControllerBase') ||
    (name.endsWith('Controller') && anns.some((a) => a.name === 'Route'));
  if (!isController) return undefined;
  const routes = anns.filter((a) => a.name === 'Route').map((a) => a.positional[0]?.[0] ?? '');
  return { name: name.replace(/Controller$/, ''), routes: routes.length ? routes : [''] };
}

export const csharpExtractor: LanguageExtractor = {
  languages: ['csharp'],
  extract(root, ctx) {
    return new CSharpExtractor(ctx).run(root);
  },
};
