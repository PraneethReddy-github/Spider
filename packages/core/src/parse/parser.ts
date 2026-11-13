import { createRequire } from 'node:module';
import path from 'node:path';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);

export type SyntaxNode = Parser.SyntaxNode;
export type Tree = Parser.Tree;

const GRAMMAR_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  kotlin: 'tree-sitter-kotlin.wasm',
  csharp: 'tree-sitter-c_sharp.wasm',
  ruby: 'tree-sitter-ruby.wasm',
  php: 'tree-sitter-php.wasm',
  c: 'tree-sitter-c.wasm',
  cpp: 'tree-sitter-cpp.wasm',
};

/** Languages with a grammar available. */
export const PARSEABLE_LANGUAGES = new Set(Object.keys(GRAMMAR_FILES));

let initPromise: Promise<void> | undefined;
const languages = new Map<string, Promise<Parser.Language>>();
const parsers = new Map<string, Parser>();

function wasmDir(): string {
  const pkg = require.resolve('tree-sitter-wasms/package.json');
  return path.join(path.dirname(pkg), 'out');
}

async function init(): Promise<void> {
  initPromise ??= Parser.init();
  await initPromise;
}

export async function loadLanguage(language: string): Promise<Parser.Language> {
  await init();
  let p = languages.get(language);
  if (!p) {
    const file = GRAMMAR_FILES[language];
    if (!file) throw new Error(`No grammar for language ${language}`);
    p = Parser.Language.load(path.join(wasmDir(), file));
    languages.set(language, p);
  }
  return p;
}

export async function getParser(language: string): Promise<Parser> {
  let p = parsers.get(language);
  if (!p) {
    const lang = await loadLanguage(language);
    p = new Parser();
    p.setLanguage(lang);
    parsers.set(language, p);
  }
  return p;
}

export async function parseSource(language: string, source: string): Promise<Tree> {
  const parser = await getParser(language);
  return parser.parse(source);
}

/* ---------- small AST helpers used by extractors ---------- */

export function field(n: SyntaxNode, name: string): SyntaxNode | null {
  return n.childForFieldName(name);
}

export function childrenOfType(n: SyntaxNode, type: string): SyntaxNode[] {
  return n.namedChildren.filter((c) => c.type === type);
}

export function firstChildOfType(n: SyntaxNode, ...types: string[]): SyntaxNode | undefined {
  return n.namedChildren.find((c) => types.includes(c.type));
}

/** Unquote a string literal node's text. */
export function stringValue(n: SyntaxNode | null | undefined): string | undefined {
  if (!n) return undefined;
  if (n.type === 'string' || n.type === 'string_literal' || n.type === 'template_string' || n.type === 'concatenated_string') {
    const t = n.text;
    if (t.length >= 2) {
      const q = t[0];
      if ((q === '"' || q === "'" || q === '`') && t[t.length - 1] === q) return t.slice(1, -1);
    }
    return t;
  }
  return undefined;
}

export function walk(n: SyntaxNode, visit: (node: SyntaxNode, depth: number) => boolean | void, depth = 0): void {
  const stop = visit(n, depth);
  if (stop === false) return;
  for (const c of n.namedChildren) walk(c, visit, depth + 1);
}
