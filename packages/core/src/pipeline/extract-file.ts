import { getExtractor } from '../languages/index.js';
import type { FileFacts } from '../languages/types.js';
import { parseSource } from '../parse/parser.js';

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
      return extractor.extract(tree.rootNode, {
        path: job.path,
        language: job.language,
        source: job.source,
        frameworks,
      });
    } finally {
      tree.delete();
    }
  } catch (err) {
    return errorFacts(job.path, job.language, err);
  }
}
