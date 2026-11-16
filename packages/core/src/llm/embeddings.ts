import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphNode } from '@spider/shared';
import { repoDir, spiderHome } from '../analyze.js';
import type { GraphBuilder } from '../graph/builder.js';
import { searchText } from '../query/semantic.js';
import type { SummaryMap } from './summaries.js';
import type { LlmProvider } from './types.js';

/**
 * Optional embeddings for semantic search (C-26): one vector per searchable production node, from the configured
 * provider's embedding model. `repos/<id>/embeddings.json` (model, ids, text hashes) + `embeddings.bin` (Float32).
 */

const EMBED_KINDS = new Set(['file', 'class', 'function', 'method', 'endpoint', 'subsystem', 'package', 'type']);

export interface EmbeddingStore {
  model: string;
  dim: number;
  ids: string[];
  hashes: string[];
  vectors: Float32Array;
}

const files = (repoId: string, home?: string) => {
  const dir = repoDir(spiderHome(home), repoId);
  return { meta: path.join(dir, 'embeddings.json'), bin: path.join(dir, 'embeddings.bin') };
};

export async function loadEmbeddings(repoId: string, home?: string): Promise<EmbeddingStore | undefined> {
  const f = files(repoId, home);
  try {
    const meta = JSON.parse(await fs.readFile(f.meta, 'utf8')) as Omit<EmbeddingStore, 'vectors'>;
    const buf = await fs.readFile(f.bin);
    const vectors = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (vectors.length !== meta.ids.length * meta.dim) return undefined;
    return { ...meta, vectors };
  } catch {
    return undefined;
  }
}

export interface EmbedOptions {
  repoId: string;
  g: GraphBuilder;
  provider: LlmProvider;
  home?: string;
  summaries?: SummaryMap;
  /** Most-central nodes first; the rest are left out. */
  max?: number;
  batch?: number;
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

/** Embeds every searchable node (reusing vectors whose text did not change) and writes the store. */
export async function buildEmbeddings(o: EmbedOptions): Promise<{ embedded: number; reused: number; total: number }> {
  if (!o.provider.embed || !o.provider.embedModel)
    throw new Error('no embedding model configured (set SPIDER_EMBED_MODEL with an openai or ollama provider)');
  const nodes: GraphNode[] = [];
  for (const kind of EMBED_KINDS)
    for (const n of o.g.nodesOfKind(kind as GraphNode['kind'])) if (!n.props.isTest) nodes.push(n);
  nodes.sort((a, b) => (b.metrics?.fanIn ?? 0) - (a.metrics?.fanIn ?? 0));
  const picked = nodes.slice(0, o.max ?? 20_000);
  const texts = picked.map((n) => searchText(n, o.summaries?.[n.id]?.text).slice(0, 2000));
  const hashes = texts.map((t) => createHash('sha1').update(t).digest('hex'));

  const old = await loadEmbeddings(o.repoId, o.home);
  const reuse = new Map<string, number>();
  if (old?.model === o.provider.embedModel) old.ids.forEach((id, i) => reuse.set(`${id}\0${old.hashes[i]}`, i));

  let dim = old?.model === o.provider.embedModel ? old.dim : 0;
  const vecs: (Float32Array | undefined)[] = picked.map((n, i) => {
    const j = reuse.get(`${n.id}\0${hashes[i]}`);
    return j === undefined || !old ? undefined : old.vectors.slice(j * old.dim, (j + 1) * old.dim);
  });
  const todo = vecs.flatMap((v, i) => (v ? [] : [i]));
  const batch = o.batch ?? 64;
  for (let k = 0; k < todo.length; k += batch) {
    const idx = todo.slice(k, k + batch);
    const out = await o.provider.embed(
      idx.map((i) => texts[i]),
      o.signal,
    );
    for (let m = 0; m < idx.length; m++) {
      dim ||= out[m].length;
      if (out[m].length !== dim) throw new Error(`embedding size changed (${out[m].length} vs ${dim})`);
      vecs[idx[m]] = normalise(Float32Array.from(out[m]));
    }
    o.onProgress?.(Math.min(k + batch, todo.length), todo.length);
  }

  const all = new Float32Array(picked.length * dim);
  vecs.forEach((v, i) => v && all.set(v, i * dim));
  const f = files(o.repoId, o.home);
  await fs.writeFile(`${f.bin}.tmp`, Buffer.from(all.buffer));
  await fs.rename(`${f.bin}.tmp`, f.bin);
  const meta = { model: o.provider.embedModel, dim, ids: picked.map((n) => n.id), hashes };
  await fs.writeFile(f.meta, JSON.stringify(meta));
  return { embedded: todo.length, reused: picked.length - todo.length, total: picked.length };
}

function normalise(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

/** Cosine similarity of `query` to every stored vector; the `top` best. */
export function nearest(store: EmbeddingStore, query: number[], top = 200): Map<string, number> {
  const q = normalise(Float32Array.from(query));
  if (q.length !== store.dim) return new Map();
  const scores: [number, number][] = [];
  for (let i = 0; i < store.ids.length; i++) {
    let dot = 0;
    const off = i * store.dim;
    for (let d = 0; d < store.dim; d++) dot += q[d] * store.vectors[off + d];
    scores.push([i, dot]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  return new Map(scores.slice(0, top).map(([i, s]) => [store.ids[i], s]));
}
