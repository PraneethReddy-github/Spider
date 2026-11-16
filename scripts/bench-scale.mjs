#!/usr/bin/env node
// Scale benchmark (C-21): analyze → persist → load → projection L0–L3 → search, with memory.
//   node --expose-gc scripts/bench-scale.mjs <repo-dir> [--skip-analyze]
// Generate inputs with scripts/gen-big-repo.mjs. Uses SPIDER_HOME (set it to a scratch dir).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = await import(path.join(root, 'packages/core/dist/index.js'));
const dir = path.resolve(process.argv[2] ?? '');
const skipAnalyze = process.argv.includes('--skip-analyze');
const mb = () => {
  globalThis.gc?.();
  return `${(process.memoryUsage().rss / 2 ** 20).toFixed(0)} MB`;
};
const time = async (fn) => {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
};
const f = (ms) => `${ms.toFixed(0)} ms`;

let repoId = core.repoIdFor(dir);
if (!skipAnalyze) {
  const stages = {};
  let last = performance.now();
  let stage = 'ingest';
  const [info, t] = await time(() =>
    core.analyze({
      source: dir,
      onProgress: (e) => {
        if (e.stage !== stage) {
          const now = performance.now();
          stages[stage] = (stages[stage] ?? 0) + now - last;
          last = now;
          stage = e.stage;
        }
      },
    }),
  );
  repoId = info.repoId;
  console.log(`analyze ${f(t)}  nodes ${info.stats.nodes}  edges ${info.stats.edges}  files ${info.stats.files}`);
  console.log(
    `  stages ${Object.entries(stages)
      .map(([k, v]) => `${k} ${f(v)}`)
      .join(' · ')}`,
  );
}
// cold start as the server does it: a stored default view, read without loading the graph
for (const level of ['L1', 'L3']) {
  const [raw, t] = await time(() => core.storedView(repoId, { level }));
  console.log(`stored view ${level} ${raw ? `${(raw.length / 2 ** 20).toFixed(1)} MB` : 'missing'}  ${f(t)}`);
}
const before = mb();
const [{ graph, meta }, tLoad] = await time(() => core.loadRepo(repoId));
console.log(`load ${f(tLoad)}  nodes ${graph.nodes.size}  rss ${before} → ${mb()}`);
const [q, tSvc] = await time(async () => new core.QueryService(graph, meta, await core.openSearchIndex(repoId)));
console.log(`service ${f(tSvc)}  rss ${mb()}`);
for (const level of ['L0', 'L1', 'L2', 'L3']) {
  const [p1, t1] = await time(() => q.projection({ level }));
  const [, t2] = await time(() => q.projection({ level }));
  console.log(`projection ${level} ${p1.nodes.length}/${p1.edges.length}  first ${f(t1)}  repeat ${f(t2)}`);
}
// expanding one directory is the common uncached interaction
const dirNode = graph.nodesOfKind('directory').find((n) => n.parentId === 'repo');
if (dirNode) {
  const [p, t] = await time(() => q.projection({ level: 'L1', expanded: [dirNode.id] }));
  console.log(`projection L1 +expand ${p.nodes.length}/${p.edges.length}  ${f(t)}`);
}
for (const s of ['user', 'Service', 'ord', 'xq', 'catalogflag0']) {
  const [hits, t] = await time(() => q.search(s));
  console.log(`search "${s}" ${hits.length} hits  ${f(t)}`);
}
q.close?.();
console.log(`rss end ${mb()}`);
