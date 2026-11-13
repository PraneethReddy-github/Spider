import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enrich } from '../src/enrich/index.js';
import { GraphBuilder } from '../src/graph/builder.js';
import { discover, emitStructure } from '../src/pipeline/discover.js';
import { extractAll } from '../src/pipeline/extract.js';
import { resolve } from '../src/pipeline/resolve.js';
import { QueryService } from '../src/query/service.js';

export const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures');

export async function analyzeFixture(name: string) {
  const root = path.join(FIXTURES, name);
  const d = await discover(root);
  const g = new GraphBuilder();
  emitStructure(g, d, name);
  const facts = await extractAll(d.files, { frameworks: d.frameworks });
  const stats = resolve(g, d, facts);
  const en = enrich(g, d);
  const q = new QueryService(g, { diagnostics: en.diagnostics });
  return { d, g, facts, stats, q, en };
}

/** `kind src -> dst` labels for all relationship edges, using qnames. */
export function edgeLabels(g: GraphBuilder, kinds?: string[]): string[] {
  const out: string[] = [];
  for (const e of g.edges.values()) {
    if (['contains', 'exports', 'member_of'].includes(e.kind)) continue;
    if (kinds && !kinds.includes(e.kind)) continue;
    const s = g.getNode(e.src)!;
    const t = g.getNode(e.dst)!;
    out.push(`${e.kind} ${s.qname ?? s.name} -> ${t.qname ?? t.name}`);
  }
  return out.sort();
}
