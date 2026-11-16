import { type SyntaxNode, field } from '../parse/parser.js';
import type { CallArg, CallFact } from './types.js';

/**
 * Literal arguments of a call, language-neutral over the bundled grammars (C-19/C-20 read them:
 * HTTP client paths, SQL strings, topics, ORM model references). Interpolations become `{}`.
 */

const STRING_TYPES = new Set([
  'string',
  'template_string',
  'interpreted_string_literal',
  'raw_string_literal',
  'string_literal',
  'verbatim_string_literal',
  'interpolated_string_expression',
  'concatenated_string',
]);
const INTERPOLATION = /^(template_substitution|interpolation|interpolated_identifier|interpolated_expression)$/;
const CONCAT = new Set(['binary_expression', 'binary_operator', 'additive_expression']);
const MAX_ARGS = 4;
const MAX_LEN = 1000;

function strText(n: SyntaxNode): string {
  if (n.type === 'concatenated_string') return n.namedChildren.map(strText).join('');
  let t = n.text;
  // replace interpolations right to left so earlier offsets stay valid
  const parts = n.namedChildren.filter((c) => INTERPOLATION.test(c.type)).reverse();
  for (const c of parts) t = `${t.slice(0, c.startIndex - n.startIndex)}{}${t.slice(c.endIndex - n.startIndex)}`;
  t = t
    .replace(/^[A-Za-z@$#]*("""|'''|"|'|`)/, '')
    .replace(/("""|'''|"|'|`)#*$/, '')
    .replace(/\$\{(\{\})?\}/g, '{}');
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t;
}

/** A string literal, a `+` concatenation with at least one string part, or Rust `format!("…")`. */
function stringOf(n: SyntaxNode): string | undefined {
  if (STRING_TYPES.has(n.type)) return strText(n);
  if (CONCAT.has(n.type) && n.child(1)?.text === '+') {
    const l = n.namedChildren[0];
    const r = n.namedChildren[n.namedChildren.length - 1];
    const a = l ? stringOf(l) : undefined;
    const b = r ? stringOf(r) : undefined;
    if (a === undefined && b === undefined) return undefined;
    return `${a ?? '{}'}${b ?? '{}'}`;
  }
  if (n.type === 'macro_invocation' && /^(format|concat)$/.test(field(n, 'macro')?.text ?? '')) {
    const tt = n.namedChildren.find((c) => c.type === 'token_tree');
    const s = tt?.namedChildren.find((c) => STRING_TYPES.has(c.type));
    return s ? strText(s) : undefined;
  }
  // tagged template: sql`SELECT …`
  if (n.type === 'call_expression' && field(n, 'arguments')?.type === 'template_string')
    return strText(field(n, 'arguments') as SyntaxNode);
  return undefined;
}

/** Type-like references: `User`, `models.User`, `&User{}`, `User.class`, `User::class`, `typeof(User)`. */
function refOf(n: SyntaxNode): string | undefined {
  switch (n.type) {
    case 'unary_expression':
      return n.namedChildren[0] ? refOf(n.namedChildren[0]) : undefined;
    case 'composite_literal':
      return /(\w+)$/.exec(field(n, 'type')?.text ?? '')?.[1]; // `pkg.User`, `[]User` → `User`
    case 'class_literal':
    case 'type_of_expression':
    case 'callable_reference':
      return n.namedChildren[0]?.text;
    case 'navigation_expression':
      return n.namedChildren[0]?.type === 'callable_reference' ? refOf(n.namedChildren[0]) : undefined;
  }
  const t = n.text;
  if (t.length > 60 || !/^[A-Za-z_][\w.]*$/.test(t)) return undefined;
  return /^[A-Z]/.test(t.split('.').pop() ?? '') ? t : undefined;
}

function argList(call: SyntaxNode): SyntaxNode | undefined {
  const a = field(call, 'arguments');
  if (a) return a;
  const suffix = call.namedChildren.find((c) => c.type === 'call_suffix');
  return suffix?.namedChildren.find((c) => c.type === 'value_arguments');
}

/** `{ args, kw }` for a call node; both omitted when the call has no literal arguments. */
export function callArgs(call: SyntaxNode): Pick<CallFact, 'args' | 'kw'> {
  const list = argList(call);
  if (!list) return {};
  const nodes = STRING_TYPES.has(list.type) ? [list] : list.namedChildren;
  const args: (CallArg | null)[] = [];
  let kw: Record<string, string> | undefined;
  const setKw = (k: string | undefined, v: SyntaxNode | null | undefined) => {
    const s = v ? stringOf(v) : undefined;
    if (k && s !== undefined) (kw ??= {})[k.replace(/^["']|["']$/g, '')] = s;
  };
  for (let raw of nodes) {
    if (raw.type === 'comment') continue;
    if (raw.type === 'argument' || raw.type === 'value_argument') {
      if (raw.namedChildCount !== 1) {
        args.push(null);
        continue;
      }
      raw = raw.namedChildren[0];
    }
    if (raw.type === 'keyword_argument') {
      setKw(field(raw, 'name')?.text, field(raw, 'value'));
      continue;
    }
    if (raw.type === 'object')
      for (const p of raw.namedChildren) if (p.type === 'pair') setKw(field(p, 'key')?.text, field(p, 'value'));
    if (args.length >= MAX_ARGS) continue;
    const s = stringOf(raw);
    const r = s === undefined ? refOf(raw) : undefined;
    args.push(s !== undefined ? { s } : r ? { r } : null);
  }
  while (args.length && args[args.length - 1] === null) args.pop();
  return { ...(args.length ? { args } : {}), ...(kw ? { kw } : {}) };
}
