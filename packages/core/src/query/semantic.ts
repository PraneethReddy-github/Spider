import type { GraphNode, SearchHit } from '@spider/shared';

/**
 * Local semantic search (C-26): BM25 over names, qualified-name parts, signatures, docstrings and summaries.
 * No network. Optional embeddings re-rank on top (`hybridRank`).
 */

const SEARCHABLE = new Set([
  'file',
  'module',
  'class',
  'function',
  'method',
  'type',
  'endpoint',
  'subsystem',
  'package',
  'datastore',
]);
const STOP = new Set(
  'a an and are as at be by do does for from how i in is it of on or the this that to what where which who why with'.split(
    ' ',
  ),
);
const K1 = 1.2;
const B = 0.75;

/** `getUserById` / `user_service.py` / `HTTPServer` → `get user by id`, `user service py`, `http server`. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
  for (const raw of spaced.split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Light stemming so `users`/`user`, `caching`/`cache`, `handled`/`handle` meet. */
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** The text a node is found by; the name counts three times. */
export function searchText(n: GraphNode, summary?: string): string {
  const qparts = (n.qname ?? n.file ?? '').replace(/::/g, ' ');
  const p = n.props as { signature?: string; docstring?: string; path?: string; method?: string };
  return [n.name, n.name, n.name, qparts, p.path, p.signature, p.docstring, summary].filter(Boolean).join(' ');
}

export class Bm25Index {
  private readonly postings = new Map<string, { doc: number; tf: number }[]>();
  private readonly lengths: number[] = [];
  private readonly avg: number;
  readonly ids: string[] = [];

  constructor(docs: Iterable<{ id: string; text: string }>) {
    for (const d of docs) {
      const doc = this.ids.length;
      this.ids.push(d.id);
      const tokens = tokenize(d.text);
      this.lengths.push(tokens.length);
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [t, c] of tf) {
        let list = this.postings.get(t);
        if (!list) this.postings.set(t, (list = []));
        list.push({ doc, tf: c });
      }
    }
    this.avg = this.lengths.reduce((a, b) => a + b, 0) / Math.max(1, this.lengths.length);
  }

  /** Scores by BM25; ties keep document order. */
  search(query: string, limit = 50): { id: string; score: number }[] {
    const scores = new Map<number, number>();
    const n = this.ids.length;
    for (const t of new Set(tokenize(query))) {
      const list = this.postings.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const { doc, tf } of list) {
        const norm = tf + K1 * (1 - B + (B * this.lengths[doc]) / this.avg);
        scores.set(doc, (scores.get(doc) ?? 0) + (idf * tf * (K1 + 1)) / norm);
      }
    }
    return [...scores]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([doc, score]) => ({ id: this.ids[doc], score }));
  }
}

export function buildBm25(nodes: Iterable<GraphNode>, summaries: Record<string, { text: string }> = {}): Bm25Index {
  const docs: { id: string; text: string }[] = [];
  for (const n of nodes)
    if (SEARCHABLE.has(n.kind)) docs.push({ id: n.id, text: searchText(n, summaries[n.id]?.text) });
  return new Bm25Index(docs);
}

export interface HybridInput {
  bm25: { id: string; score: number }[];
  /** Name-match hits (`QueryService.search`, scores ~0–120). */
  names: SearchHit[];
  /** Cosine similarity per node id, when embeddings exist. */
  cosine?: Map<string, number>;
  node: (id: string) => GraphNode | undefined;
  kinds?: string[];
  limit: number;
}

/**
 * Hybrid ranking: BM25 and name match, each scaled to 0–1 by its best hit, weighted 0.6 / 0.4; with
 * embeddings, cosine (0–1) joins at 0.4 and the others shrink to 0.36 / 0.24. Output scores are 0–100.
 */
export function hybridRank(h: HybridInput): SearchHit[] {
  const maxB = Math.max(1e-9, ...h.bm25.map((x) => x.score));
  const maxN = Math.max(1e-9, ...h.names.map((x) => x.score));
  const w = h.cosine?.size ? { b: 0.36, n: 0.24, c: 0.4 } : { b: 0.6, n: 0.4, c: 0 };
  const score = new Map<string, number>();
  const add = (id: string, v: number) => score.set(id, (score.get(id) ?? 0) + v);
  for (const x of h.bm25) add(x.id, (w.b * x.score) / maxB);
  for (const x of h.names) add(x.node.id, (w.n * x.score) / maxN);
  for (const [id, c] of h.cosine ?? []) add(id, w.c * Math.max(0, c));
  const ks = h.kinds ? new Set(h.kinds) : undefined;
  const out: SearchHit[] = [];
  for (const [id, s] of score) {
    const node = h.node(id);
    if (!node || (ks && !ks.has(node.kind))) continue;
    out.push({ node, score: Math.round(s * 1000) / 10 - (node.props.isTest ? 5 : 0) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, h.limit);
}
