#!/usr/bin/env node
// Benchmarks the analysis pipeline in-memory (no persistence, no cache, no network).
// SPIDER_WORKERS=<n> fixes the parse worker count (0 = in-process); default is auto.
// Uses fastify/fastify and pallets/flask from the SPIDER_HOME clone cache when present, else the fixtures.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(path.join(root, 'packages/core/dist/index.js')).catch(() => {
  console.error('Build core first: pnpm -r --filter @spider/core... run build');
  process.exit(1);
});
const { GraphBuilder, QueryService, discover, emitStructure, enrich, extractAllWithStats, resolve } = core;
const workers = process.env.SPIDER_WORKERS === undefined ? undefined : Number(process.env.SPIDER_WORKERS);

const home = process.env.SPIDER_HOME ?? path.join(os.homedir(), '.spider');
const cloneOf = (slug) =>
  path.join(home, 'clones', createHash('sha1').update(`https://github.com/${slug}.git`).digest('hex').slice(0, 12));

const targets = ['fastify/fastify', 'pallets/flask']
  .map((slug) => ({ name: slug, dir: cloneOf(slug) }))
  .filter((t) => existsSync(t.dir));
if (!targets.length) {
  console.log('No cached clones in SPIDER_HOME; benchmarking fixtures.');
  for (const f of ['ts-express', 'py-fastapi']) targets.push({ name: f, dir: path.join(root, 'fixtures', f) });
}

const ms = (t) => `${(performance.now() - t).toFixed(0)}ms`.padStart(7);
const num = (n) => n.toLocaleString('en-US').padStart(7);

for (const t of targets) {
  const t0 = performance.now();
  const d = await discover(t.dir);
  const g = new GraphBuilder();
  emitStructure(g, d, t.name);
  const tDisc = ms(t0);
  let t1 = performance.now();
  const { facts, stats: ex } = await extractAllWithStats(d.files, { frameworks: d.frameworks, workers });
  const tParse = ms(t1);
  t1 = performance.now();
  resolve(g, d, facts);
  const tRes = ms(t1);
  t1 = performance.now();
  const en = enrich(g, d);
  const tEnr = ms(t1);
  const total = ((performance.now() - t0) / 1000).toFixed(1);
  const q = new QueryService(g, { diagnostics: en.diagnostics });
  const proj = ['L1', 'L2', 'L3'].map((level) => {
    const s = performance.now();
    const r = q.projection({ level });
    return `${level} ${r.nodes.length}/${r.edges.length} ${ms(s).trim()}`;
  });
  t1 = performance.now();
  q.search('get');
  const tSearch = ms(t1).trim();
  console.log(`${t.name}`);
  console.log(
    `  files ${num(d.files.length)}  nodes ${num(g.nodes.size)}  edges ${num(g.edges.size)}  total ${total}s`,
  );
  console.log(`  discover ${tDisc}  parse ${tParse} (${ex.workers || 'no'} workers)  resolve ${tRes}  enrich ${tEnr}`);
  console.log(`  projection ${proj.join(' · ')}  search ${tSearch}`);
}
