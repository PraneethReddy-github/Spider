import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getExtractor } from '../languages/index.js';
import type { FileFacts } from '../languages/types.js';
import { PARSEABLE_LANGUAGES, parseSource } from '../parse/parser.js';
import type { DiscoveredFile } from './discover.js';

export const EXTRACTOR_VERSION = 5;

export interface ExtractOptions {
  cacheDir?: string;
  frameworks: Set<string>;
  onProgress?: (done: number, total: number, file: string) => void;
}

export async function extractAll(files: DiscoveredFile[], opts: ExtractOptions): Promise<Map<string, FileFacts>> {
  const targets = files.filter((f) => PARSEABLE_LANGUAGES.has(f.language) && getExtractor(f.language));
  const out = new Map<string, FileFacts>();
  if (opts.cacheDir) await fs.mkdir(opts.cacheDir, { recursive: true });
  let done = 0;
  for (const f of targets) {
    try {
      const source = await fs.readFile(f.abs, 'utf8');
      const hash = createHash('sha256')
        .update(`${EXTRACTOR_VERSION}:${f.language}:${f.path}:`)
        .update(source)
        .digest('hex');
      const cachePath = opts.cacheDir ? path.join(opts.cacheDir, `${hash}.json`) : undefined;
      let facts: FileFacts | undefined;
      if (cachePath) {
        try {
          facts = JSON.parse(await fs.readFile(cachePath, 'utf8')) as FileFacts;
        } catch {
          /* miss */
        }
      }
      if (!facts) {
        const tree = await parseSource(f.language, source);
        const extractor = getExtractor(f.language)!;
        facts = extractor.extract(tree.rootNode, {
          path: f.path,
          language: f.language,
          source,
          frameworks: opts.frameworks,
        });
        tree.delete();
        if (cachePath) fs.writeFile(cachePath, JSON.stringify(facts)).catch(() => {});
      }
      out.set(f.path, facts);
    } catch (err) {
      // A single bad file must never abort the analysis.
      out.set(f.path, {
        path: f.path,
        language: f.language,
        loc: 0,
        decls: [],
        imports: [],
        exports: [],
        calls: [],
        endpoints: [],
        bindings: [],
        hints: { error: String(err) },
      });
    }
    done++;
    if (done % 25 === 0 || done === targets.length) opts.onProgress?.(done, targets.length, f.path);
  }
  return out;
}
