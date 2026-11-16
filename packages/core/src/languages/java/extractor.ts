import type { SyntaxNode } from '../../parse/parser.js';
import { field, stringValue } from '../../parse/parser.js';
import { type Annotation, FactBuilder, locOf, springController, springEndpoints, typeHead } from '../jvm/common.js';
import { type DeclFact, type ExtractContext, type FileFacts, type LanguageExtractor, complexityOf } from '../types.js';

interface Scope {
  /** Enclosing declaration (caller / binding scope). */
  qname?: string;
  /** Enclosing class qname. */
  cls?: string;
  /** Spring controller prefixes of the enclosing class. */
  prefixes?: string[];
}

const TYPE_DECLS = new Set([
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
]);

class JavaExtractor {
  private b: FactBuilder;
  private pkg = '';

  constructor(ctx: ExtractContext) {
    this.b = new FactBuilder(ctx);
  }

  run(root: SyntaxNode): FileFacts {
    for (const c of root.namedChildren) {
      if (c.type === 'package_declaration') {
        this.pkg = c.namedChildren.find((x) => x.type !== 'annotation' && x.type !== 'marker_annotation')?.text ?? '';
        this.b.declarePackage(this.pkg);
      }
    }
    this.visit(root, {});
    return this.b.finish();
  }

  private visit(n: SyntaxNode, s: Scope): void {
    switch (n.type) {
      case 'import_declaration': {
        this.importDecl(n);
        return;
      }
      case 'package_declaration':
        return;
      case 'method_declaration':
      case 'constructor_declaration':
      case 'compact_constructor_declaration':
        if (s.cls) {
          this.method(n, s);
          return;
        }
        break;
      case 'field_declaration':
      case 'constant_declaration':
        if (s.cls) this.fieldDecl(n, s.cls);
        break;
      case 'local_variable_declaration':
        this.localDecl(n, s);
        break;
      case 'enhanced_for_statement':
      case 'catch_formal_parameter':
      case 'resource': {
        const name = field(n, 'name')?.text;
        const t = field(n, 'type') ?? n.namedChildren.find((c) => c.type === 'catch_type');
        if (name && t) this.typed(name, t, s.qname);
        break;
      }
      case 'method_invocation':
        this.invocation(n, s);
        break;
      case 'object_creation_expression': {
        const t = field(n, 'type');
        this.b.call(typeHead(t?.text), s.qname, n, field(n, 'arguments')?.namedChildCount ?? 0, true);
        // anonymous class bodies: their methods run as part of the enclosing declaration
        for (const c of n.namedChildren) if (c.type !== 'class_body') this.visit(c, s);
        const body = n.namedChildren.find((c) => c.type === 'class_body');
        if (body) for (const c of body.namedChildren) this.visit(c, { ...s, cls: undefined });
        return;
      }
      default:
        if (TYPE_DECLS.has(n.type)) {
          this.typeDecl(n, s);
          return;
        }
    }
    for (const c of n.namedChildren) this.visit(c, s);
  }

  private importDecl(n: SyntaxNode): void {
    const spec = n.namedChildren.find((c) => c.type === 'scoped_identifier' || c.type === 'identifier')?.text;
    if (!spec) return;
    this.b.imp(spec, n, { wildcard: n.namedChildren.some((c) => c.type === 'asterisk') });
  }

  private typeDecl(n: SyntaxNode, s: Scope): void {
    const name = field(n, 'name')?.text;
    if (!name) return;
    const mods = modifiersOf(n);
    const anns = annotationsOf(mods);
    const qname = s.cls ? `${s.cls}.${name}` : name;
    const classKind =
      n.type === 'interface_declaration' || n.type === 'annotation_type_declaration'
        ? 'interface'
        : n.type === 'enum_declaration'
          ? 'enum'
          : 'class';
    const ext: string[] = [];
    const impl: string[] = [];
    const sup = field(n, 'superclass');
    for (const t of sup?.namedChildren ?? []) pushType(ext, t);
    const ifaces = field(n, 'interfaces') ?? n.namedChildren.find((c) => c.type === 'extends_interfaces');
    const list = ifaces?.namedChildren.find((c) => c.type === 'type_list');
    for (const t of list?.namedChildren ?? []) pushType(classKind === 'interface' ? ext : impl, t);
    const decl: DeclFact = {
      kind: 'class',
      classKind,
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
    for (const t of [sup, ifaces]) if (t) this.typeRefs(t, qname, false);
    // record components are fields
    for (const p of field(n, 'parameters')?.namedChildren ?? []) {
      const pn = field(p, 'name')?.text;
      if (pn) this.b.field(pn, qname, typeHead(field(p, 'type')?.text));
      this.typeRefs(field(p, 'type'), qname);
    }
    const inner: Scope = { qname, cls: qname, prefixes: springController(anns) };
    const body = field(n, 'body');
    for (const c of body?.namedChildren ?? []) {
      if (c.type === 'enum_body_declarations') for (const cc of c.namedChildren) this.visit(cc, inner);
      else if (c.type === 'enum_constant') this.visit(c, inner);
      else this.visit(c, inner);
    }
  }

  private method(n: SyntaxNode, s: Scope): void {
    const cls = s.cls as string;
    const isCtor = n.type !== 'method_declaration';
    const name = isCtor ? 'constructor' : field(n, 'name')?.text;
    if (!name) return;
    const qname = this.b.uniqueQname(`${cls}.${name}`);
    const mods = modifiersOf(n);
    const anns = annotationsOf(mods);
    const params: string[] = [];
    for (const p of field(n, 'parameters')?.namedChildren ?? []) {
      const pn = field(p, 'name')?.text ?? p.namedChildren.find((c) => c.type === 'variable_declarator')?.text;
      if (!pn) continue;
      params.push(pn);
      const t = field(p, 'type');
      if (t) this.typed(pn, t, qname);
      for (const a of annotationsOf(modifiersOf(p))) this.b.ref(a.name, qname, a.node);
    }
    const body = field(n, 'body');
    const retType = field(n, 'type');
    const decl: DeclFact = {
      kind: 'method',
      name,
      qname,
      parentQname: cls,
      span: this.b.span(n),
      isExported: !hasMod(mods, 'private'),
      isStatic: hasMod(mods, 'static') || undefined,
      isAbstract: !body || hasMod(mods, 'abstract') || undefined,
      visibility: visibilityOf(mods),
      params,
      signature: `${name}(${params.join(', ')})`,
      returns: typeHead(retType?.text),
      decorators: anns.map((a) => a.name),
      complexity: body ? complexityOf(body) : 1,
      loc: locOf(n),
    };
    this.b.decl(decl);
    this.typeRefs(retType, qname);
    for (const a of anns) this.b.ref(a.name, qname, a.node);
    if (s.prefixes) springEndpoints(this.b, s.prefixes, anns, qname);
    if (body) this.visit(body, { ...s, qname });
  }

  private fieldDecl(n: SyntaxNode, cls: string): void {
    const t = field(n, 'type');
    const type = typeHead(t?.text);
    this.typeRefs(t, cls);
    for (const a of annotationsOf(modifiersOf(n))) this.b.ref(a.name, cls, a.node);
    for (const d of n.namedChildren.filter((c) => c.type === 'variable_declarator')) {
      const name = field(d, 'name')?.text;
      if (name) this.b.field(name, cls, type ?? newTypeOf(field(d, 'value')));
    }
  }

  private localDecl(n: SyntaxNode, s: Scope): void {
    const t = field(n, 'type');
    const type = typeHead(t?.text);
    this.typeRefs(t, s.qname);
    for (const d of n.namedChildren.filter((c) => c.type === 'variable_declarator')) {
      const name = field(d, 'name')?.text;
      if (!name) continue;
      const value = field(d, 'value');
      if (type) this.b.bind(name, s.qname, type, { isType: true });
      else if (value?.type === 'object_creation_expression')
        this.b.bind(name, s.qname, newTypeOf(value), { isNew: true });
      else if (value?.type === 'method_invocation') this.b.bind(name, s.qname, calleeOf(value));
    }
  }

  private typed(name: string, t: SyntaxNode, scope: string | undefined): void {
    this.b.bind(name, scope, typeHead(t.text), { isType: true });
    this.typeRefs(t, scope);
  }

  private invocation(n: SyntaxNode, s: Scope): void {
    this.b.call(calleeOf(n), s.qname, n, field(n, 'arguments')?.namedChildCount ?? 0);
  }

  /** Every named type inside a type subtree (incl. generic arguments) → references. */
  private typeRefs(t: SyntaxNode | null | undefined, scope: string | undefined, self = true): void {
    if (!t) return;
    if (t.type === 'type_identifier' || t.type === 'scoped_type_identifier') {
      if (self) this.b.ref(t.text, scope, t);
      if (t.type === 'scoped_type_identifier') return;
    }
    for (const c of t.namedChildren) this.typeRefs(c, scope, t.type === 'type_arguments' || self);
  }
}

function pushType(out: string[], t: SyntaxNode): void {
  const h = typeHead(t.text);
  if (h) out.push(h);
}

/** `a.b()` → `a.b`; `this.x.y()` → `this.x.y`; chained calls on call results are not resolvable. */
function calleeOf(n: SyntaxNode): string | undefined {
  const name = field(n, 'name')?.text;
  if (!name) return undefined;
  const obj = field(n, 'object');
  if (!obj) return name;
  const head = dotted(obj);
  return head ? `${head}.${name}` : undefined;
}

function dotted(n: SyntaxNode): string | undefined {
  if (n.type === 'identifier') return n.text;
  if (n.type === 'this') return 'this';
  if (n.type === 'super') return 'super';
  if (n.type === 'field_access') {
    const o = field(n, 'object');
    const f = field(n, 'field')?.text;
    const h = o ? dotted(o) : undefined;
    return h && f ? `${h}.${f}` : undefined;
  }
  return undefined;
}

function newTypeOf(v: SyntaxNode | null | undefined): string | undefined {
  return v?.type === 'object_creation_expression' ? typeHead(field(v, 'type')?.text) : undefined;
}

function modifiersOf(n: SyntaxNode): SyntaxNode | undefined {
  return n.namedChildren.find((c) => c.type === 'modifiers');
}

function hasMod(mods: SyntaxNode | undefined, m: string): boolean {
  return !!mods?.children.some((c) => c.type === m || c.text === m);
}

function visibilityOf(mods: SyntaxNode | undefined): DeclFact['visibility'] {
  for (const v of ['public', 'private', 'protected'] as const) if (hasMod(mods, v)) return v;
  return undefined;
}

function annotationsOf(mods: SyntaxNode | undefined): Annotation[] {
  const out: Annotation[] = [];
  for (const a of mods?.namedChildren ?? []) {
    if (a.type !== 'annotation' && a.type !== 'marker_annotation') continue;
    const name = field(a, 'name')?.text.split('.').pop();
    if (!name) continue;
    const ann: Annotation = { name, positional: [], named: {}, node: a };
    for (const arg of field(a, 'arguments')?.namedChildren ?? []) {
      if (arg.type === 'element_value_pair') {
        const k = field(arg, 'key')?.text;
        const v = field(arg, 'value');
        if (k && v) ann.named[k] = values(v);
      } else ann.positional.push(values(arg));
    }
    out.push(ann);
  }
  return out;
}

/** Annotation argument → strings: literals, `{…}` arrays, `RequestMethod.GET` → `GET`, other expressions as `{text}`. */
function values(v: SyntaxNode): string[] {
  if (v.type === 'element_value_array_initializer') return v.namedChildren.flatMap(values);
  if (v.type === 'string_literal') return [stringValue(v) ?? ''];
  if (v.type === 'field_access') return [field(v, 'field')?.text ?? v.text];
  if (v.type === 'binary_expression') {
    const parts = v.namedChildren.map(values);
    if (parts.every((p) => p.length === 1)) return [parts.map((p) => p[0]).join('')];
  }
  return [`{${v.text}}`];
}

export const javaExtractor: LanguageExtractor = {
  languages: ['java'],
  extract(root, ctx) {
    return new JavaExtractor(ctx).run(root);
  },
};
