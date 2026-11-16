import type { SyntaxNode } from '../../parse/parser.js';
import { stringValue } from '../../parse/parser.js';
import { type Annotation, FactBuilder, locOf, springController, springEndpoints, typeHead } from '../jvm/common.js';
import { type DeclFact, type ExtractContext, type FileFacts, type LanguageExtractor, complexityOf } from '../types.js';

interface Scope {
  qname?: string;
  cls?: string;
  prefixes?: string[];
  /** Inside a companion object: members belong to the enclosing class (static). */
  companion?: boolean;
}

const TYPE_NODES = new Set(['user_type', 'nullable_type', 'function_type', 'parenthesized_type', 'type_reference']);

class KotlinExtractor {
  private b: FactBuilder;
  private pkg = '';

  constructor(ctx: ExtractContext) {
    this.b = new FactBuilder(ctx);
  }

  run(root: SyntaxNode): FileFacts {
    const header = root.namedChildren.find((c) => c.type === 'package_header');
    this.pkg = header?.namedChildren.find((c) => c.type === 'identifier')?.text ?? '';
    this.b.declarePackage(this.pkg);
    this.visit(root, {});
    return this.b.finish();
  }

  private visit(n: SyntaxNode, s: Scope): void {
    switch (n.type) {
      case 'package_header':
        return;
      case 'import_header': {
        this.importHeader(n);
        return;
      }
      case 'class_declaration':
      case 'object_declaration': {
        this.typeDecl(n, s);
        return;
      }
      case 'companion_object': {
        const body = n.namedChildren.find((c) => c.type === 'class_body');
        if (body && s.cls) for (const c of body.namedChildren) this.visit(c, { ...s, companion: true });
        return;
      }
      case 'function_declaration': {
        this.functionDecl(n, s);
        return;
      }
      case 'secondary_constructor': {
        this.secondaryCtor(n, s);
        return;
      }
      case 'property_declaration':
        this.property(n, s);
        break;
      case 'call_expression':
        this.callExpr(n, s);
        break;
      case 'object_literal':
        // anonymous objects: their members run as part of the enclosing declaration
        for (const c of n.namedChildren)
          for (const cc of c.type === 'class_body' ? c.namedChildren : [c]) this.visitAnon(cc, s);
        return;
    }
    for (const c of n.namedChildren) this.visit(c, s);
  }

  private visitAnon(n: SyntaxNode, s: Scope): void {
    if (n.type === 'function_declaration' || n.type === 'property_declaration') {
      for (const c of n.namedChildren) if (c.type === 'function_body' || isExpr(c)) this.visit(c, s);
      return;
    }
    this.visit(n, s);
  }

  private importHeader(n: SyntaxNode): void {
    const spec = n.namedChildren.find((c) => c.type === 'identifier')?.text;
    if (!spec) return;
    const alias = n.namedChildren.find((c) => c.type === 'import_alias')?.namedChildren[0]?.text;
    this.b.imp(spec, n, { wildcard: n.namedChildren.some((c) => c.type === 'wildcard_import'), alias });
  }

  private typeDecl(n: SyntaxNode, s: Scope): void {
    const name = n.namedChildren.find((c) => c.type === 'type_identifier')?.text;
    if (!name) return;
    const mods = n.namedChildren.find((c) => c.type === 'modifiers');
    const anns = annotationsOf(mods);
    const qname = s.cls ? `${s.cls}.${name}` : name;
    const isInterface = n.children.some((c) => c.type === 'interface');
    const ext: string[] = [];
    const impl: string[] = [];
    for (const d of n.namedChildren.filter((c) => c.type === 'delegation_specifier')) {
      const inv = d.namedChildren.find((c) => c.type === 'constructor_invocation');
      const t = typeHead((inv ?? d).namedChildren.find((c) => c.type === 'user_type')?.text);
      if (t) (inv || isInterface ? ext : impl).push(t);
      for (const c of d.namedChildren)
        if (c.type !== 'user_type' && c.type !== 'constructor_invocation') this.visit(c, s);
      for (const a of inv?.namedChildren ?? []) if (a.type === 'value_arguments') this.visit(a, { ...s, qname });
    }
    const decl: DeclFact = {
      kind: 'class',
      classKind: isInterface ? 'interface' : hasMod(mods, 'enum') ? 'enum' : 'class',
      name,
      qname,
      parentQname: s.cls,
      span: this.b.span(n),
      isExported: !hasMod(mods, 'private'),
      isAbstract: hasMod(mods, 'abstract') || undefined,
      visibility: visibilityOf(mods),
      extends: ext,
      implements: impl,
      decorators: anns.map((a) => a.name),
      loc: locOf(n),
    };
    this.b.decl(decl, s.cls ? undefined : this.pkg);
    for (const a of anns) this.b.ref(a.name, qname, a.node);
    // primary constructor `val`/`var` parameters are properties
    const ctor = n.namedChildren.find((c) => c.type === 'primary_constructor');
    for (const p of ctor?.namedChildren.filter((c) => c.type === 'class_parameter') ?? []) {
      const pn = p.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
      const t = p.namedChildren.find((c) => TYPE_NODES.has(c.type));
      this.typeRefs(t, qname);
      if (pn && p.namedChildren.some((c) => c.type === 'binding_pattern_kind'))
        this.b.field(pn, qname, typeHead(t?.text));
    }
    const inner: Scope = { qname, cls: qname, prefixes: springController(anns) };
    const body = n.namedChildren.find((c) => c.type === 'class_body' || c.type === 'enum_class_body');
    for (const c of body?.namedChildren ?? []) this.visit(c, inner);
  }

  private functionDecl(n: SyntaxNode, s: Scope): void {
    const name = n.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
    if (!name) return;
    const parent = s.cls ?? s.qname;
    const qname = this.b.uniqueQname(parent ? `${parent}.${name}` : name);
    const mods = n.namedChildren.find((c) => c.type === 'modifiers');
    const anns = annotationsOf(mods);
    const paramsNode = n.namedChildren.find((c) => c.type === 'function_value_parameters');
    const params: string[] = [];
    for (const p of paramsNode?.namedChildren.filter((c) => c.type === 'parameter') ?? []) {
      const pn = p.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
      const t = p.namedChildren.find((c) => TYPE_NODES.has(c.type));
      if (!pn) continue;
      params.push(pn);
      this.b.bind(pn, qname, typeHead(t?.text), { isType: true });
      this.typeRefs(t, qname);
    }
    for (const pm of paramsNode?.namedChildren.filter((c) => c.type === 'parameter_modifiers') ?? [])
      for (const a of annotationsOf(pm)) this.b.ref(a.name, qname, a.node);
    // the return type follows the parameter list (a type before the name is an extension receiver)
    const retType = paramsNode ? nextOfType(n, paramsNode) : undefined;
    const body = n.namedChildren.find((c) => c.type === 'function_body');
    const decl: DeclFact = {
      kind: s.cls ? 'method' : 'function',
      name,
      qname,
      parentQname: parent,
      span: this.b.span(n),
      isExported: !hasMod(mods, 'private'),
      isStatic: s.companion || undefined,
      isAsync: hasMod(mods, 'suspend') || undefined,
      isAbstract: !body || hasMod(mods, 'abstract') || undefined,
      visibility: visibilityOf(mods),
      params,
      signature: `${name}(${params.join(', ')})`,
      returns: typeHead(retType?.text),
      decorators: anns.map((a) => a.name),
      complexity: body ? complexityOf(body) : 1,
      loc: locOf(n),
    };
    this.b.decl(decl, parent ? undefined : this.pkg);
    this.typeRefs(retType, qname);
    for (const a of anns) this.b.ref(a.name, qname, a.node);
    if (s.prefixes) springEndpoints(this.b, s.prefixes, anns, qname);
    if (body) this.visit(body, { ...s, qname, companion: false });
  }

  private secondaryCtor(n: SyntaxNode, s: Scope): void {
    if (!s.cls) return;
    const qname = this.b.uniqueQname(`${s.cls}.constructor`);
    const params: string[] = [];
    for (const p of n.namedChildren.find((c) => c.type === 'function_value_parameters')?.namedChildren ?? []) {
      const pn = p.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
      if (!pn) continue;
      params.push(pn);
      this.b.bind(pn, qname, typeHead(p.namedChildren.find((c) => TYPE_NODES.has(c.type))?.text), { isType: true });
    }
    this.b.decl({
      kind: 'method',
      name: 'constructor',
      qname,
      parentQname: s.cls,
      span: this.b.span(n),
      isExported: true,
      params,
      signature: `constructor(${params.join(', ')})`,
      complexity: complexityOf(n),
      loc: locOf(n),
    });
    for (const c of n.namedChildren) if (c.type !== 'function_value_parameters') this.visit(c, { ...s, qname });
  }

  private property(n: SyntaxNode, s: Scope): void {
    const v = n.namedChildren.find((c) => c.type === 'variable_declaration');
    const name = v?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
    if (!v || !name) return;
    const t = v.namedChildren.find((c) => TYPE_NODES.has(c.type));
    const scope = s.companion ? s.cls : s.qname;
    this.typeRefs(t, scope);
    const init = n.namedChildren.find((c) => isExpr(c));
    let ref = typeHead(t?.text);
    const isType = !!ref;
    if (!ref && init?.type === 'call_expression') ref = calleeOf(init);
    if (!ref) return;
    if (s.cls && scope === s.cls) this.b.field(name, s.cls, ref, isType);
    else this.b.bind(name, scope, ref, { isType: isType || undefined });
  }

  private callExpr(n: SyntaxNode, s: Scope): void {
    const suffix = n.namedChildren.find((c) => c.type === 'call_suffix');
    const args = suffix?.namedChildren.find((c) => c.type === 'value_arguments')?.namedChildCount ?? 0;
    const lambda = suffix?.namedChildren.some((c) => c.type === 'annotated_lambda') ? 1 : 0;
    this.b.call(calleeOf(n), s.qname, n, args + lambda);
  }

  private typeRefs(t: SyntaxNode | null | undefined, scope: string | undefined): void {
    if (!t) return;
    if (t.type === 'user_type') {
      const ids = t.namedChildren.filter((c) => c.type === 'type_identifier').map((c) => c.text);
      if (ids.length) this.b.ref(ids.join('.'), scope, t);
    }
    for (const c of t.namedChildren) this.typeRefs(c, scope);
  }
}

function isExpr(n: SyntaxNode): boolean {
  return ![
    'modifiers',
    'binding_pattern_kind',
    'variable_declaration',
    'multi_variable_declaration',
    'type_constraints',
    'type_parameters',
    'getter',
    'setter',
    'property_delegate',
  ].includes(n.type);
}

function nextOfType(n: SyntaxNode, after: SyntaxNode): SyntaxNode | undefined {
  let seen = false;
  for (const c of n.namedChildren) {
    if (c.startIndex === after.startIndex) seen = true;
    else if (seen && TYPE_NODES.has(c.type)) return c;
    else if (seen && c.type === 'function_body') return undefined;
  }
  return undefined;
}

function calleeOf(n: SyntaxNode): string | undefined {
  const head = n.namedChildren[0];
  return head ? dotted(head) : undefined;
}

function dotted(n: SyntaxNode): string | undefined {
  if (n.type === 'simple_identifier') return n.text;
  if (n.type === 'this_expression') return n.text === 'this' ? 'this' : undefined;
  if (n.type === 'super_expression') return n.text === 'super' ? 'super' : undefined;
  if (n.type === 'navigation_expression') {
    const [obj, suffix] = n.namedChildren;
    const name = suffix?.namedChildren.find((c) => c.type === 'simple_identifier')?.text;
    const h = obj ? dotted(obj) : undefined;
    return h && name ? `${h}.${name}` : undefined;
  }
  return undefined;
}

function hasMod(mods: SyntaxNode | undefined, m: string): boolean {
  return !!mods?.namedChildren.some((c) => c.text === m);
}

function visibilityOf(mods: SyntaxNode | undefined): DeclFact['visibility'] {
  for (const v of ['public', 'private', 'protected'] as const) if (hasMod(mods, v)) return v;
  return undefined;
}

function annotationsOf(mods: SyntaxNode | undefined): Annotation[] {
  const out: Annotation[] = [];
  for (const a of mods?.namedChildren ?? []) {
    if (a.type !== 'annotation') continue;
    const inv = a.namedChildren.find((c) => c.type === 'constructor_invocation');
    const ut = (inv ?? a).namedChildren.find((c) => c.type === 'user_type');
    const name = ut?.namedChildren.filter((c) => c.type === 'type_identifier').pop()?.text;
    if (!name) continue;
    const ann: Annotation = { name, positional: [], named: {}, node: a };
    for (const arg of inv?.namedChildren.find((c) => c.type === 'value_arguments')?.namedChildren ?? []) {
      const kids = arg.namedChildren;
      if (kids.length === 2 && kids[0].type === 'simple_identifier') ann.named[kids[0].text] = values(kids[1]);
      else if (kids[0]) ann.positional.push(values(kids[0]));
    }
    out.push(ann);
  }
  return out;
}

function values(v: SyntaxNode): string[] {
  if (v.type === 'collection_literal') return v.namedChildren.flatMap(values);
  if (v.type === 'string_literal' && !v.namedChildren.some((c) => c.type.startsWith('interpolat')))
    return [stringValue(v) ?? ''];
  if (v.type === 'navigation_expression') return [dotted(v)?.split('.').pop() ?? v.text];
  return [`{${v.text}}`];
}

export const kotlinExtractor: LanguageExtractor = {
  languages: ['kotlin'],
  extract(root, ctx) {
    return new KotlinExtractor(ctx).run(root);
  },
};
