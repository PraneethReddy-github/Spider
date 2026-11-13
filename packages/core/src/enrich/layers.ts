import path from 'node:path';
import type { Diagnostic } from '@spider/shared';
import type Graph from 'graphology';
import type { GraphBuilder } from '../graph/builder.js';

/**
 * Topological layers of a directed graph after condensing cycles (Kosaraju, iterative): a node that
 * depends on nothing is layer 0; otherwise 1 + the highest layer it depends on. Nodes of one strongly
 * connected component share a layer.
 */
export function layerize(nodes: string[], edges: Iterable<[string, string]>): Map<string, number> {
  const index = new Map(nodes.map((n, i) => [n, i]));
  const out: number[][] = nodes.map(() => []);
  const inn: number[][] = nodes.map(() => []);
  for (const [s, t] of edges) {
    const a = index.get(s);
    const b = index.get(t);
    if (a === undefined || b === undefined || a === b) continue;
    out[a].push(b);
    inn[b].push(a);
  }
  // pass 1: post-order on the graph
  const order: number[] = [];
  const seen = new Uint8Array(nodes.length);
  for (let r = 0; r < nodes.length; r++) {
    if (seen[r]) continue;
    seen[r] = 1;
    const stack: [number, number][] = [[r, 0]];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [v, i] = top;
      if (i < out[v].length) {
        top[1]++;
        const w = out[v][i];
        if (!seen[w]) {
          seen[w] = 1;
          stack.push([w, 0]);
        }
      } else {
        order.push(v);
        stack.pop();
      }
    }
  }
  // pass 2: components on the transpose in reverse post-order → topological order (sources first)
  const comp = new Int32Array(nodes.length).fill(-1);
  let nComp = 0;
  for (let k = order.length - 1; k >= 0; k--) {
    const r = order[k];
    if (comp[r] >= 0) continue;
    const stack = [r];
    comp[r] = nComp;
    while (stack.length) {
      const v = stack.pop() as number;
      for (const w of inn[v])
        if (comp[w] < 0) {
          comp[w] = nComp;
          stack.push(w);
        }
    }
    nComp++;
  }
  const compOut: number[][] = Array.from({ length: nComp }, () => []);
  for (let v = 0; v < nodes.length; v++)
    for (const w of out[v]) if (comp[v] !== comp[w]) compOut[comp[v]].push(comp[w]);
  const layer = new Int32Array(nComp);
  for (let c = nComp - 1; c >= 0; c--) for (const d of compOut[c]) layer[c] = Math.max(layer[c], layer[d] + 1);
  return new Map(nodes.map((n, i) => [n, layer[comp[i]]]));
}

const isWithin = (a: string, b: string) => a === b || b === '' || a.startsWith(`${b}/`);

/**
 * Upward dependencies between sibling directories: when directory A depends on B at least 3× as much
 * (by weight, over ≥ 2 file pairs) as B depends on A, A sits above B, and every B → A dependency goes
 * against that layering. Directories nested in one another are never compared (a parent mixes
 * files of several layers), which keeps the check precise.
 */
export function findLayerViolations(g: GraphBuilder, fg: Graph): Diagnostic[] {
  type Pair = { weight: number; files: [string, string][] };
  const dirOf = new Map<string, string>();
  for (const f of g.nodesOfKind('file'))
    if (!f.props.isTest && f.file) dirOf.set(f.id, path.posix.dirname(f.file).replace(/^\.$/, ''));
  const pairs = new Map<string, Pair>();
  fg.forEachEdge((_e, attrs, s, t) => {
    const a = dirOf.get(s);
    const b = dirOf.get(t);
    if (a === undefined || b === undefined || isWithin(a, b) || isWithin(b, a)) return;
    const key = `${a}\0${b}`;
    let p = pairs.get(key);
    if (!p) pairs.set(key, (p = { weight: 0, files: [] }));
    p.weight += attrs.weight as number;
    p.files.push([s, t]);
  });
  const out: Diagnostic[] = [];
  for (const [key, up] of pairs) {
    const [low, high] = key.split('\0');
    const down = pairs.get(`${high}\0${low}`);
    if (!down || down.files.length < 2 || down.weight < 3 * up.weight) continue;
    const nodeIds = [...new Set(up.files.flat())].slice(0, 20);
    out.push({
      type: 'layer-violation',
      title: `${low} depends upward on ${high}`,
      nodeIds,
      severity: 'warn',
      detail: `${up.files.length} upward file dependencies (weight ${up.weight}) against ${down.files.length} downward (weight ${down.weight})`,
    });
  }
  return out.sort((a, b) => a.title.localeCompare(b.title)).slice(0, 200);
}
