import { getExtractor } from '../languages/index.js';
import type { FileFacts } from '../languages/types.js';
import { type SyntaxNode, parseSource, walk } from '../parse/parser.js';

/** One file to parse + extract; plain data so it can cross a worker boundary. */
export interface ExtractJob {
  path: string;
  language: string;
  source: string;
}

export function errorFacts(path: string, language: string, err: unknown): FileFacts {
  return {
    path,
    language,
    loc: 0,
    decls: [],
    imports: [],
    exports: [],
    calls: [],
    endpoints: [],
    bindings: [],
    hints: { error: String(err) },
  };
}

/** Parse + extract one file. Never throws: a bad file yields empty facts with `hints.error`. */
export async function extractFile(job: ExtractJob, frameworks: Set<string>): Promise<FileFacts> {
  try {
    const extractor = getExtractor(job.language);
    if (!extractor) throw new Error(`No extractor for language ${job.language}`);
    const tree = await parseSource(job.language, job.source);
    try {
      const facts = extractor.extract(tree.rootNode, {
        path: job.path,
        language: job.language,
        source: job.source,
        frameworks,
      });
      attachDocstrings(tree.rootNode, facts);
      return facts;
    } finally {
      tree.delete();
    }
  } catch (err) {
    return errorFacts(job.path, job.language, err);
  }
}

const DOC_MAX = 600;
const PY_DEFS = new Set(['function_definition', 'class_definition', 'decorated_definition']);

/**
 * Docstrings for every language at once (C-26 search text): the comment block that ends on the line right above
 * a declaration (JSDoc, `///`, `//`, `#`, block comments), or a Python body docstring. Fills `DeclFact.docstring`.
 */
export function attachDocstrings(root: SyntaxNode, facts: FileFacts): void {
  if (facts.decls.length === 0) return;
  const byEndRow = new Map<number, SyntaxNode>();
  walk(root, (n) => {
    // a comment after code on its line (`x = 1 // note`) documents that code, not the next declaration
    const trailing = n.previousNamedSibling?.endPosition.row === n.startPosition.row;
    if (n.type.includes('comment') && !trailing) byEndRow.set(n.endPosition.row, n);
    return undefined;
  });
  for (const d of facts.decls) {
    if (d.docstring) continue;
    const row = d.span.startLine - 1; // 0-based row of the declaration
    let doc: string | undefined;
    if (facts.language === 'python') doc = pythonDoc(root, row, d.span.startCol);
    if (!doc) {
      const parts: string[] = [];
      let r = row - 1;
      for (let c = byEndRow.get(r); c; c = byEndRow.get(r)) {
        parts.unshift(c.text);
        r = c.startPosition.row - 1;
      }
      doc = parts.length ? cleanComment(parts.join('\n')) : undefined;
    }
    if (doc) d.docstring = doc.length > DOC_MAX ? `${doc.slice(0, DOC_MAX)}…` : doc;
  }
}

function pythonDoc(root: SyntaxNode, row: number, col: number): string | undefined {
  let n: SyntaxNode | null = root.descendantForPosition({ row, column: Math.max(0, col) });
  while (n && !PY_DEFS.has(n.type)) n = n.parent;
  if (n?.type === 'decorated_definition') n = n.childForFieldName('definition');
  const first = n?.childForFieldName('body')?.namedChildren[0];
  const str = first?.type === 'expression_statement' ? first.namedChildren[0] : undefined;
  if (str?.type !== 'string') return undefined;
  return cleanComment(str.text.replace(/^[rubfRUBF]*("{3}|'{3}|"|')|("{3}|'{3}|"|')$/g, ''));
}

function cleanComment(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*(\/\*\*?|\*\/|\*(?!\/)|\/\/\/?!?|#+)\s?/, '').replace(/\s*\*\/\s*$/, ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
