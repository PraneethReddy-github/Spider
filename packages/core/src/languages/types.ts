import type { Span } from '@spider/shared';
import type { SyntaxNode } from '../parse/parser.js';

export type DeclKind = 'class' | 'function' | 'method' | 'variable' | 'type';

export interface DeclFact {
  kind: DeclKind;
  name: string;
  /** Qualified within the file, e.g. `Foo.bar` for a method. */
  qname: string;
  /** qname of the enclosing declaration (class for methods, function for nested functions). */
  parentQname?: string;
  span: Span;
  isExported: boolean;
  isAsync?: boolean;
  isStatic?: boolean;
  isAbstract?: boolean;
  visibility?: 'public' | 'private' | 'protected';
  classKind?: 'class' | 'interface' | 'struct' | 'enum' | 'trait';
  params?: string[];
  signature?: string;
  /** Raw names this class extends. */
  extends?: string[];
  implements?: string[];
  decorators?: string[];
  /** Raw annotated return type, unwrapped from `Promise<…>`/`Optional[…]` (receiver typing). */
  returns?: string;
  complexity?: number;
  loc: number;
  docstring?: string;
}

export interface ImportFact {
  /** Raw module specifier, e.g. `./utils`, `lodash`, `os.path`, `..models`. */
  specifier: string;
  /** Imported names: `{ imported: 'x', local: 'y' }`. Empty for side-effect imports. */
  names: { imported: string; local: string }[];
  /** `import * as ns from` / `import pkg` → local namespace binding name. */
  namespace?: string;
  isDynamic?: boolean;
  span: Span;
}

export interface ExportFact {
  /** Exported name (`default` for default export). */
  name: string;
  /** Local declaration name (if different from exported). */
  local?: string;
  /** Re-export source specifier. */
  from?: string;
  span: Span;
}

export interface CallFact {
  /** Dotted callee text, e.g. `foo`, `obj.method`, `this.save`, `self.repo.find`. Max 3 segments. */
  callee: string;
  /** qname of the enclosing declaration, undefined at module level. */
  callerQname?: string;
  isNew?: boolean;
  argCount: number;
  span: Span;
}

export interface EndpointFact {
  method: string; // GET, POST, ..., ANY, WS
  path: string;
  framework: string;
  /** Dotted reference to the handler (a local name or `Class.method`). */
  handlerRef?: string;
  /** qname of the enclosing declaration (for decorators, the decorated function/method). */
  enclosingQname?: string;
  /** Router variable (or controller class qname) the route is registered on, e.g. `router`, `bp`. */
  receiver?: string;
  /** File-local prefix of the receiver already joined into `path` (stripped when a mount replaces it). */
  receiverPrefix?: string;
  span: Span;
}

/** A router / blueprint / module mounted under a path prefix (resolved across files in resolve). */
export interface MountFact {
  /** Path prefix the target is mounted at (may be empty). */
  prefix: string;
  /** Dotted reference to the mounted router variable / module class, or a dotted module path. */
  target: string;
  /** Receiver the mount is made on (`app`, `router`, `urlpatterns`, module class qname). */
  parent?: string;
  /** `target` is a dotted module path string (Django `include('app.urls')`). */
  targetIsModule?: boolean;
  /** A non-empty prefix replaces the target's own prefix (Flask `register_blueprint(url_prefix=)`). */
  replacesOwnPrefix?: boolean;
  /** Applies to every endpoint of `framework` (NestJS `setGlobalPrefix`). */
  global?: boolean;
  framework?: string;
  span: Span;
}

/** A router variable or controller class with its own file-local prefix. */
export interface RouterFact {
  /** Module-level variable name or class qname. */
  name: string;
  prefix: string;
}

/** A name used as a type annotation, generic argument or decorator (→ `references` edge). */
export interface ReferenceFact {
  name: string;
  /** qname of the referencing declaration; undefined at module level. */
  scopeQname?: string;
  span: Span;
}

/** A local variable bound to the result of `new X()` / `X()` — used to type receivers. */
export interface BindingFact {
  name: string;
  /** qname of the enclosing declaration; undefined at module level. */
  scopeQname?: string;
  /** Dotted reference of the constructor / factory. */
  ref: string;
  isNew: boolean;
  /** `ref` is a type annotation (parameter, field, variable), not a constructor call. */
  isType?: boolean;
}

export interface FileFacts {
  path: string;
  language: string;
  loc: number;
  decls: DeclFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  calls: CallFact[];
  endpoints: EndpointFact[];
  bindings: BindingFact[];
  references?: ReferenceFact[];
  mounts?: MountFact[];
  routers?: RouterFact[];
  /** Language-specific hints: e.g. python `__all__`. */
  hints: Record<string, unknown>;
}

export interface ExtractContext {
  path: string;
  language: string;
  source: string;
  frameworks: Set<string>;
}

export interface LanguageExtractor {
  languages: string[];
  extract(root: SyntaxNode, ctx: ExtractContext): FileFacts;
}

export function spanOf(n: SyntaxNode, file: string): Span {
  return {
    file,
    startLine: n.startPosition.row + 1,
    startCol: n.startPosition.column,
    endLine: n.endPosition.row + 1,
    endCol: n.endPosition.column,
  };
}

export function countLoc(source: string): number {
  let n = 0;
  for (const line of source.split('\n')) if (line.trim().length > 0) n++;
  return n;
}

export const BRANCH_TYPES = new Set([
  'if_statement',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'switch_case',
  'case_clause',
  'catch_clause',
  'ternary_expression',
  'conditional_expression',
  'elif_clause',
  'except_clause',
  'with_statement',
  'list_comprehension',
  'match_statement',
  'case_pattern',
  'binary_expression',
  'boolean_operator',
]);

/** Approximate cyclomatic complexity: 1 + branching constructs (&&/|| counted for binary ops). */
export function complexityOf(n: SyntaxNode): number {
  let c = 1;
  const stack = [n];
  while (stack.length) {
    const cur = stack.pop()!;
    if (BRANCH_TYPES.has(cur.type)) {
      if (cur.type === 'binary_expression') {
        const op = cur.child(1)?.text;
        if (op === '&&' || op === '||' || op === '??') c++;
      } else c++;
    }
    for (const ch of cur.namedChildren) stack.push(ch);
  }
  return c;
}

export function dottedText(n: SyntaxNode, maxSegments = 4): string {
  const t = n.text.replace(/\s+/g, '');
  const segs = t.split('.');
  return segs.length > maxSegments ? segs.slice(-maxSegments).join('.') : t;
}
