import type { GraphEdge, GraphNode } from '@spider/shared';
import type { Pos } from './map';

/**
 * Focus view: root at the origin; every other node on a ring whose radius grows with its distance.
 * Nodes that reach the root (incoming) take the left half, the ones it reaches (outgoing) the right.
 */
export function radialLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  root: string,
  distances: Record<string, number>,
): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  if (nodes.length === 0) return pos;
  pos.set(root, { x: 0, y: 0 });
  const dist = (id: string) => distances[id] ?? Number.POSITIVE_INFINITY;
  const adj = new Map<string, { other: string; dir: 'in' | 'out' }[]>();
  const push = (k: string, v: { other: string; dir: 'in' | 'out' }) => {
    const list = adj.get(k);
    if (list) list.push(v);
    else adj.set(k, [v]);
  };
  for (const e of edges) {
    push(e.src, { other: e.dst, dir: 'out' });
    push(e.dst, { other: e.src, dir: 'in' });
  }
  const side = new Map<string, 'in' | 'out'>();
  const ordered = nodes
    .filter((n) => n.id !== root)
    .sort((a, b) => dist(a.id) - dist(b.id) || a.name.localeCompare(b.name));
  for (const n of ordered) {
    let s: 'in' | 'out' | undefined;
    for (const { other, dir } of adj.get(n.id) ?? []) {
      if (other === root) {
        s = dir === 'out' ? 'in' : 'out'; // n → root: n is upstream
        break;
      }
      if (dist(other) < dist(n.id) && side.has(other)) s = side.get(other);
    }
    side.set(n.id, s ?? 'out');
  }
  const finite = ordered.map((n) => dist(n.id)).filter(Number.isFinite);
  const maxD = Math.max(1, ...finite);
  let r = 0;
  for (let d = 1; d <= maxD; d++) {
    const ring = ordered.filter((n) => (Number.isFinite(dist(n.id)) ? dist(n.id) : maxD) === d);
    r += RING_STEP;
    const inner = r;
    r = Math.max(
      r,
      arc(
        ring.filter((n) => side.get(n.id) === 'in'),
        inner,
        Math.PI / 2,
        (3 * Math.PI) / 2,
        pos,
      ),
      arc(
        ring.filter((n) => side.get(n.id) !== 'in'),
        inner,
        -Math.PI / 2,
        Math.PI / 2,
        pos,
      ),
    );
  }
  return pos;
}

const RING_STEP = 140;
/** Minimum arc distance between neighbours on one sub-ring, and the gap between sub-rings. */
const NODE_GAP = 40;
const SUB_RING_GAP = 44;

/**
 * Spreads `list` evenly over the arc [from, to]. When the arc at radius `r` is too short for the
 * labels, consecutive nodes alternate between k staggered sub-rings so neighbours never share a
 * radius. Returns the outermost radius used.
 */
function arc(list: GraphNode[], r: number, from: number, to: number, pos: Map<string, Pos>): number {
  const step = (to - from) / (list.length + 1);
  const k = Math.max(1, Math.ceil(NODE_GAP / (Math.abs(step) * r)));
  list.forEach((node, i) => {
    const a = from + step * (i + 1);
    const ri = r + (i % k) * SUB_RING_GAP;
    // graph y points up in sigma; negate so the first item sits at the top of each half
    pos.set(node.id, { x: Math.cos(a) * ri, y: -Math.sin(a) * ri });
  });
  return list.length ? r + (k - 1) * SUB_RING_GAP : r;
}

/**
 * Flow view: column = distance from the root (or index along a path); rows spread evenly and
 * ordered by the barycentre of their neighbours in the previous column to reduce crossings.
 * `mirror` puts the root on the right (upstream queries read right → left).
 */
export function layeredLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  distances: Record<string, number>,
  mirror = false,
): Map<string, Pos> {
  const pos = new Map<string, Pos>();
  if (nodes.length === 0) return pos;
  const col = new Map<string, number>();
  for (const n of nodes) col.set(n.id, Number.isFinite(distances[n.id]) ? distances[n.id] : 0);
  const columns = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const c = col.get(n.id) ?? 0;
    const list = columns.get(c);
    if (list) list.push(n);
    else columns.set(c, [n]);
  }
  const preds = new Map<string, string[]>();
  for (const e of edges) {
    const a = col.get(e.src) ?? 0;
    const b = col.get(e.dst) ?? 0;
    const [lo, hi] = a <= b ? [e.src, e.dst] : [e.dst, e.src];
    const list = preds.get(hi);
    if (list) list.push(lo);
    else preds.set(hi, [lo]);
  }
  const COL_W = 240;
  const ROW_H = 48;
  const rowOf = new Map<string, number>();
  [...columns.keys()]
    .sort((a, b) => a - b)
    .forEach((c, ci) => {
      const list = columns.get(c) ?? [];
      const bary = (id: string) => {
        const ps = (preds.get(id) ?? []).map((p) => rowOf.get(p)).filter((v): v is number => v !== undefined);
        return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : Number.MAX_SAFE_INTEGER;
      };
      list.sort((a, b) => (ci > 0 ? bary(a.id) - bary(b.id) : 0) || a.name.localeCompare(b.name));
      const h = (list.length - 1) * ROW_H;
      list.forEach((n, i) => {
        rowOf.set(n.id, i);
        pos.set(n.id, { x: (mirror ? -1 : 1) * ci * COL_W, y: h / 2 - i * ROW_H });
      });
    });
  return pos;
}
