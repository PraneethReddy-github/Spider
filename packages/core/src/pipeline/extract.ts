import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { getExtractor } from '../languages/index.js';
import type { FileFacts } from '../languages/types.js';
import { PARSEABLE_LANGUAGES } from '../parse/parser.js';
import type { DiscoveredFile } from './discover.js';
import { type ExtractJob, errorFacts, extractFile } from './extract-file.js';

export const EXTRACTOR_VERSION = 10;

/** Built worker entry; absent when running from TypeScript sources (vitest), which forces in-process extraction. */
const WORKER_URL = new URL('./extract-worker.js', import.meta.url);
/** Each worker must get at least this many cache misses, else its start-up (wasm init) costs more than it saves. */
const MIN_FILES_PER_WORKER = 50;
/**
 * Every worker compiles the tree-sitter grammars (multi-MB wasm) itself, and those compiles contend for V8's
 * shared compiler threads: measured on fastify, parse time bottoms out at 4 workers and rises beyond.
 */
const MAX_WORKERS = 4;

export interface ExtractOptions {
  cacheDir?: string;
  frameworks: Set<string>;
  onProgress?: (done: number, total: number, file: string) => void;
  /** Worker threads for parse+extract. 0 = in-process; omitted = auto from cache misses and cores. */
  workers?: number;
}

export interface ExtractStats {
  /** Parseable files. */
  files: number;
  /** Facts reused from the content-hash cache (no parse). */
  reused: number;
  /** Files parsed + extracted in this run. */
  extracted: number;
  /** Worker threads used (0 = in-process). */
  workers: number;
}

export async function extractAll(files: DiscoveredFile[], opts: ExtractOptions): Promise<Map<string, FileFacts>> {
  return (await extractAllWithStats(files, opts)).facts;
}

interface Miss {
  index: number;
  job: ExtractJob;
  cachePath?: string;
}

export async function extractAllWithStats(
  files: DiscoveredFile[],
  opts: ExtractOptions,
): Promise<{ facts: Map<string, FileFacts>; stats: ExtractStats }> {
  const targets = files.filter((f) => PARSEABLE_LANGUAGES.has(f.language) && getExtractor(f.language));
  const results: FileFacts[] = new Array(targets.length);
  if (opts.cacheDir) await fs.mkdir(opts.cacheDir, { recursive: true });
  // Facts depend on detected frameworks (endpoint extraction), so they are part of the cache key.
  const fwKey = [...opts.frameworks].sort().join(',');
  let done = 0;
  const tick = (file: string) => {
    done++;
    if (done % 25 === 0 || done === targets.length) opts.onProgress?.(done, targets.length, file);
  };

  /* cache lookup: everything not cached becomes a Miss */
  const misses: Miss[] = [];
  for (const [index, f] of targets.entries()) {
    let source: string;
    try {
      source = await fs.readFile(f.abs, 'utf8');
    } catch (err) {
      results[index] = errorFacts(f.path, f.language, err);
      tick(f.path);
      continue;
    }
    const hash = createHash('sha256')
      .update(`${EXTRACTOR_VERSION}:${f.language}:${f.path}:${fwKey}:`)
      .update(source)
      .digest('hex');
    const cachePath = opts.cacheDir ? path.join(opts.cacheDir, `${hash}.json`) : undefined;
    const cached = cachePath ? await fs.readFile(cachePath, 'utf8').catch(() => undefined) : undefined;
    if (cached) {
      try {
        results[index] = JSON.parse(cached) as FileFacts;
        tick(f.path);
        continue;
      } catch {
        /* corrupt entry: re-extract */
      }
    }
    misses.push({ index, job: { path: f.path, language: f.language, source }, cachePath });
  }

  /* parse + extract misses; facts always go through JSON so fresh and cached results are identical */
  const accept = (m: Miss, json: string) => {
    results[m.index] = JSON.parse(json) as FileFacts;
    if (m.cachePath) fs.writeFile(m.cachePath, json).catch(() => {});
    tick(m.job.path);
  };
  const workers = workerCount(opts.workers, misses.length);
  if (workers > 0) {
    try {
      await runPool(
        misses.map((m) => m.job),
        opts.frameworks,
        workers,
        (k, json) => accept(misses[k], json),
      );
    } catch {
      /* worker failure: whatever is left runs in-process below */
    }
  }
  for (const m of misses) {
    if (!results[m.index]) accept(m, JSON.stringify(await extractFile(m.job, opts.frameworks)));
  }

  const facts = new Map<string, FileFacts>();
  for (const [i, f] of targets.entries()) facts.set(f.path, results[i]);
  const stats = { files: targets.length, reused: targets.length - misses.length, extracted: misses.length, workers };
  return { facts, stats };
}

function workerCount(requested: number | undefined, misses: number): number {
  if (misses === 0 || !existsSync(fileURLToPath(WORKER_URL))) return 0;
  if (requested !== undefined) return Math.max(0, Math.min(requested, misses));
  const n = Math.min(MAX_WORKERS, os.availableParallelism() - 1, Math.floor(misses / MIN_FILES_PER_WORKER));
  return n >= 2 ? n : 0;
}

/**
 * Runs jobs on `n` worker threads. Jobs are grouped largest-first into batches of roughly equal source size
 * (~4 batches per worker) and handed to whichever worker is idle, so one huge file doesn't stall a whole
 * share. `onResult(jobIndex, json)` fires per job; output order is restored by the caller.
 */
async function runPool(
  jobs: ExtractJob[],
  frameworks: Set<string>,
  n: number,
  onResult: (index: number, json: string) => void,
): Promise<void> {
  const order = jobs.map((_, i) => i).sort((a, b) => jobs[b].source.length - jobs[a].source.length);
  const target = jobs.reduce((s, j) => s + j.source.length, 0) / (n * 4);
  const batches: number[][] = [];
  let cur: number[] = [];
  let bytes = 0;
  for (const i of order) {
    cur.push(i);
    bytes += jobs[i].source.length;
    if (bytes >= target) {
      batches.push(cur);
      cur = [];
      bytes = 0;
    }
  }
  if (cur.length) batches.push(cur);

  let next = 0;
  const pool = Array.from(
    { length: Math.min(n, batches.length) },
    () => new Worker(WORKER_URL, { workerData: { frameworks: [...frameworks] } }),
  );
  try {
    await Promise.all(
      pool.map(
        (w) =>
          new Promise<void>((resolve, reject) => {
            let batch: number[] = [];
            const feed = () => {
              const b = batches[next++];
              if (!b) return resolve();
              batch = b;
              w.postMessage(b.map((i) => jobs[i]));
            };
            w.on('message', (out: string[]) => {
              for (const [k, i] of batch.entries()) onResult(i, out[k]);
              feed();
            });
            w.on('error', reject);
            w.on('exit', (code) => reject(new Error(`extract worker exited with code ${code}`)));
            feed();
          }),
      ),
    );
  } finally {
    await Promise.all(pool.map((w) => w.terminate()));
  }
}
