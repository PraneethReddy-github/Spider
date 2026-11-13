import type { GraphEdge, GraphNode } from '@spider/shared';
import Graph from 'graphology';
import circlepack from 'graphology-layout/circlepack';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import FA2Layout from 'graphology-layout-forceatlas2/worker';

export interface Pos {
  x: number;
  y: number;
}

/* ---------- position persistence ---------- */

const posKey = (repoId: string) => `spider:pos:${repoId}`;

export function loadPositions(repoId: string): Record<string, Pos> {
  try {
    const raw = localStorage.getItem(posKey(repoId));
    return raw ? (JSON.parse(raw) as Record<string, Pos>) : {};
  } catch {
    return {};
  }
}

export function savePositions(repoId: string, graph: Graph): void {
  try {
    const cur = loadPositions(repoId);
    graph.forEachNode((id, a) => {
      if (Number.isFinite(a.x) && Number.isFinite(a.y)) cur[id] = { x: round(a.x), y: round(a.y) };
    });
    // keep the store bounded
    const keys = Object.keys(cur);
    if (keys.length > 20000) for (const k of keys.slice(0, keys.length - 20000)) delete cur[k];
    localStorage.setItem(posKey(repoId), JSON.stringify(cur));
  } catch {
    /* quota or private mode; positions just won't persist */
  }
}

const round = (v: number) => Math.round(v * 100) / 100;

/* ---------- map layout: circlepack seed + ForceAtlas2 ---------- */

const SYNC_LIMIT = 1500;

/**
 * Seeds positions with a circle packing grouped by the visible parent and kind (so members of an
 * expanded container start together), then relaxes with ForceAtlas2. Nodes with a known position
 * (from localStorage or a previous render) keep it and are not re-seeded; if *every* node already
 * has a position, no layout is run at all.
 *
 * Returns a cancel function (stops the worker for large graphs).
 */
export function layoutMap(graph: Graph, known: Record<string, Pos>, onDone: () => void): () => void {
  if (graph.order === 0) {
    onDone();
    return () => {};
  }
  let missing = 0;
  graph.forEachNode((id) => {
    const k = known[id];
    if (k && Number.isFinite(k.x) && Number.isFinite(k.y)) {
      graph.mergeNodeAttributes(id, { x: k.x, y: k.y, fixed: true });
    } else missing++;
  });

  if (missing === 0) {
    onDone();
    return () => {};
  }

  // Seed the whole graph, then restore known positions, so new nodes land near their siblings.
  const seed = new Graph();
  graph.forEachNode((id, a) => seed.addNode(id, { size: a.size ?? 5, viewParent: a.viewParent ?? '', kind: a.kind }));
  circlepack.assign(seed, { hierarchyAttributes: ['viewParent', 'kind'], center: 0, scale: 1.1 });
  graph.forEachNode((id, a) => {
    if (a.fixed) return;
    const p = seed.getNodeAttributes(id);
    // Bring unknown nodes near their expanded container if it is on the map.
    const parent = a.viewParent as string | undefined;
    if (parent && graph.hasNode(parent) && graph.getNodeAttribute(parent, 'fixed')) {
      const pp = graph.getNodeAttributes(parent);
      graph.mergeNodeAttributes(id, { x: pp.x + (p.x % 60) - 30, y: pp.y + (p.y % 60) - 30 });
    } else graph.mergeNodeAttributes(id, { x: p.x, y: p.y });
  });

  const settings = {
    ...forceAtlas2.inferSettings(graph),
    adjustSizes: true,
    gravity: 1.2,
    strongGravityMode: false,
    scalingRatio: graph.order > 500 ? 6 : 12,
    barnesHutOptimize: graph.order > 300,
    slowDown: 4,
  };
  // FA2 doesn't support pinning; approximate it by only running when there are new nodes and
  // pulling known ones back afterwards.
  const fixedPos = new Map<string, Pos>();
  graph.forEachNode((id, a) => {
    if (a.fixed) fixedPos.set(id, { x: a.x, y: a.y });
  });
  const restore = () => {
    for (const [id, p] of fixedPos) if (graph.hasNode(id)) graph.mergeNodeAttributes(id, p);
  };

  if (graph.order <= SYNC_LIMIT) {
    forceAtlas2.assign(graph, { iterations: fixedPos.size > 0 ? 60 : 150, settings });
    restore();
    onDone();
    return () => {};
  }

  const layout = new FA2Layout(graph, { settings });
  layout.start();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    layout.stop();
    layout.kill();
    restore();
    onDone();
  };
  const timer = window.setTimeout(finish, 3000);
  return () => {
    window.clearTimeout(timer);
    if (!done) {
      done = true;
      layout.kill();
    }
  };
}

/* ---------- focus view: radial ---------- */

/**
 * Selected node at the origin; every other node on a ring whose radius grows with its distance.
 * Nodes on the "incoming" side (they reach the root) go on the left half, "outgoing" on the right.
 */
export function radialLayout(nodes: GraphNode[], edges: GraphEdge[], root: string, distances: Record<string, number>): Record<string, Pos> {
  const pos: Record<string, Pos> = {};
  if (nodes.length === 0) return pos;
  pos[root] = { x: 0, y: 0 };
  const side = new Map<string, 'in' | 'out'>();
  const dist = (id: string) => distances[id] ?? Infinity;
  const adj = new Map<string, { other: string; dir: 'in' | 'out' }[]>();
  for (const e of edges) {
    if (!adj.has(e.src)) adj.set(e.src, []);
    if (!adj.has(e.dst)) adj.set(e.dst, []);
    adj.get(e.src)!.push({ other: e.dst, dir: 'out' }); // e.src -> e.dst: from src's view dst is downstream
    adj.get(e.dst)!.push({ other: e.src, dir: 'in' });
  }
  const ordered = nodes.filter((n) => n.id !== root).sort((a, b) => dist(a.id) - dist(b.id) || a.name.localeCompare(b.name));
  for (const n of ordered) {
    const d = dist(n.id);
    let s: 'in' | 'out' | undefined;
    for (const { other, dir } of adj.get(n.id) ?? []) {
      if (other === root) {
        // n -> root means n is upstream/incoming
        s = dir === 'out' ? 'in' : 'out';
        break;
      }
      if (dist(other) < d && side.has(other)) s = side.get(other);
    }
    side.set(n.id, s ?? 'out');
  }
  const maxD = Math.max(1, ...ordered.map((n) => (Number.isFinite(dist(n.id)) ? dist(n.id) : 1)));
  for (let d = 1; d <= maxD; d++) {
    const ring = ordered.filter((n) => (Number.isFinite(dist(n.id)) ? dist(n.id) : maxD) === d);
    const left = ring.filter((n) => side.get(n.id) === 'in');
    const right = ring.filter((n) => side.get(n.id) !== 'in');
    const r = 120 * d;
    place(left, r, Math.PI / 2, (3 * Math.PI) / 2, pos);
    place(right, r, -Math.PI / 2, Math.PI / 2, pos);
  }
  return pos;
}

function place(list: GraphNode[], r: number, from: number, to: number, pos: Record<string, Pos>) {
  const n = list.length;
  if (n === 0) return;
  const span = to - from;
  const step = span / (n + 1);
  list.forEach((node, i) => {
    const a = from + step * (i + 1);
    pos[node.id] = { x: Math.cos(a) * r, y: Math.sin(a) * r };
  });
}

/* ---------- flow view: layered left → right ---------- */

/**
 * Column = distance from the root (or position along a path), rows spread evenly and ordered by
 * the barycentre of their predecessors to reduce crossings.
 */
export function layeredLayout(nodes: GraphNode[], edges: GraphEdge[], distances?: Record<string, number>): Record<string, Pos> {
  const pos: Record<string, Pos> = {};
  if (nodes.length === 0) return pos;
  const col = new Map<string, number>();
  if (distances && Object.keys(distances).length) {
    for (const n of nodes) col.set(n.id, Number.isFinite(distances[n.id]) ? distances[n.id] : 0);
  } else {
    nodes.forEach((n, i) => col.set(n.id, i));
  }
  const columns = new Map<number, GraphNode[]>();
  for (const n of nodes) {
    const c = col.get(n.id) ?? 0;
    if (!columns.has(c)) columns.set(c, []);
    columns.get(c)!.push(n);
  }
  const preds = new Map<string, string[]>();
  for (const e of edges) {
    const a = col.get(e.src) ?? 0;
    const b = col.get(e.dst) ?? 0;
    const [lo, hi] = a <= b ? [e.src, e.dst] : [e.dst, e.src];
    if (!preds.has(hi)) preds.set(hi, []);
    preds.get(hi)!.push(lo);
  }
  const sortedCols = [...columns.keys()].sort((a, b) => a - b);
  const rowOf = new Map<string, number>();
  const COL_W = 220;
  const ROW_H = 44;
  sortedCols.forEach((c, ci) => {
    const list = columns.get(c)!;
    if (ci > 0) {
      const bary = (id: string) => {
        const ps = (preds.get(id) ?? []).map((p) => rowOf.get(p)).filter((v): v is number => v !== undefined);
        return ps.length ? ps.reduce((s, v) => s + v, 0) / ps.length : Number.MAX_SAFE_INTEGER;
      };
      list.sort((a, b) => bary(a.id) - bary(b.id) || a.name.localeCompare(b.name));
    } else list.sort((a, b) => a.name.localeCompare(b.name));
    const h = (list.length - 1) * ROW_H;
    list.forEach((n, i) => {
      rowOf.set(n.id, i);
      pos[n.id] = { x: ci * COL_W, y: i * ROW_H - h / 2 };
    });
  });
  return pos;
}
