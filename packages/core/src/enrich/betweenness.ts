import type Graph from 'graphology';
import type { GraphBuilder } from '../graph/builder.js';
import { seededRandom } from './subsystems.js';

/**
 * Approximate betweenness centrality of non-test files on the directed, unweighted file graph:
 * Brandes from up to `samples` source files (a fixed seeded sample, so results are deterministic),
 * scaled by n/k and normalised by (n−1)(n−2) → `metrics.betweenness` in 0..1.
 */
export function computeBetweenness(g: GraphBuilder, fg: Graph, samples = 256): void {
  const nodes = fg.nodes().filter((id) => !g.getNode(id)?.props.isTest);
  const n = nodes.length;
  const index = new Map(nodes.map((id, i) => [id, i]));
  const adj: number[][] = nodes.map(() => []);
  fg.forEachEdge((_e, _a, s, t) => {
    const a = index.get(s);
    const b = index.get(t);
    if (a !== undefined && b !== undefined) adj[a].push(b);
  });
  let pivots = nodes.map((_, i) => i);
  if (n > samples) {
    const rnd = seededRandom(n);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pivots[i], pivots[j]] = [pivots[j], pivots[i]];
    }
    pivots = pivots.slice(0, samples);
  }
  const bc = new Float64Array(n);
  const sigma = new Float64Array(n);
  const dist = new Int32Array(n);
  const delta = new Float64Array(n);
  const preds: number[][] = nodes.map(() => []);
  for (const s of pivots) {
    sigma.fill(0);
    dist.fill(-1);
    delta.fill(0);
    for (const p of preds) p.length = 0;
    sigma[s] = 1;
    dist[s] = 0;
    const order: number[] = [];
    const queue = [s];
    for (let qi = 0; qi < queue.length; qi++) {
      const v = queue[qi];
      order.push(v);
      for (const w of adj[v]) {
        if (dist[w] < 0) {
          dist[w] = dist[v] + 1;
          queue.push(w);
        }
        if (dist[w] === dist[v] + 1) {
          sigma[w] += sigma[v];
          preds[w].push(v);
        }
      }
    }
    for (let k = order.length - 1; k >= 0; k--) {
      const w = order[k];
      for (const v of preds[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) bc[w] += delta[w];
    }
  }
  const scale = n > 2 ? n / pivots.length / ((n - 1) * (n - 2)) : 0;
  nodes.forEach((id, i) => {
    const node = g.getNode(id);
    if (node?.metrics) node.metrics.betweenness = Math.min(1, bc[i] * scale);
  });
}
