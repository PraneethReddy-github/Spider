import Graph from 'graphology';
import forceAtlas2 from 'graphology-layout-forceatlas2';
import noverlap from 'graphology-layout-noverlap';

export interface Pos {
  x: number;
  y: number;
}

export interface LayoutInput {
  id: string;
  size: number;
  /** Visible view parent (an expanded container on the map), if any. */
  parent?: string;
}

const ROOT = '\u0000root';
const GROUP_PAD = 18;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

/**
 * Group-aware map layout. Every expanded container is laid out bottom-up as its own small graph
 * (members + nested groups as super-nodes sized by their radius), relaxed with ForceAtlas2 and a
 * no-overlap pass, then placed inside its parent. Deterministic for a given input, so the same
 * projection always yields the same picture.
 */
export function layoutMap(
  nodes: LayoutInput[],
  edges: { src: string; dst: string; weight: number }[],
): Map<string, Pos> {
  // Same input → same picture, so recent layouts are reused (theme switches, re-renders, going back a
  // level skip the multi-second relaxation of 20k-node views). Callers get a copy they may mutate.
  const key = layoutKey(nodes, edges);
  let hit = recent.get(key);
  if (!hit) {
    hit = computeLayout(nodes, edges);
    recent.set(key, hit);
    if (recent.size > 4) recent.delete(recent.keys().next().value as string);
  }
  return new Map(hit);
}

const recent = new Map<string, Map<string, Pos>>();

/** FNV-1a over the layout input; collisions only cost a wrong cached picture, never data. */
function layoutKey(nodes: LayoutInput[], edges: { src: string; dst: string; weight: number }[]): string {
  let h = 0x811c9dc5;
  const mix = (str: string) => {
    for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  };
  for (const n of nodes) mix(`${n.id}|${n.parent ?? ''}|${n.size};`);
  for (const e of edges) mix(`${e.src}>${e.dst}:${e.weight};`);
  return `${nodes.length}:${edges.length}:${h >>> 0}`;
}

function computeLayout(nodes: LayoutInput[], edges: { src: string; dst: string; weight: number }[]): Map<string, Pos> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const kids = new Map<string, string[]>();
  const parentOf = (id: string) => {
    const p = byId.get(id)?.parent;
    return p && p !== id && byId.has(p) ? p : ROOT;
  };
  for (const n of nodes) {
    const p = parentOf(n.id);
    let list = kids.get(p);
    if (!list) kids.set(p, (list = []));
    list.push(n.id);
  }

  // Each edge belongs to exactly one group: the deepest group holding both ends, where it links the two
  // children of that group containing them. Bucketing once keeps layout O(edges × depth), not
  // O(groups × edges) (thousands of class/file groups at L3).
  const chainOf = (id: string): string[] => {
    const chain = [id];
    for (let cur = id, guard = 0; guard < 64; guard++) {
      cur = parentOf(cur);
      chain.push(cur);
      if (cur === ROOT) break;
    }
    return chain; // id, parent, …, ROOT
  };
  const groupEdges = new Map<string, { a: string; b: string; weight: number }[]>();
  for (const e of edges) {
    if (!byId.has(e.src) || !byId.has(e.dst)) continue;
    const cs = chainOf(e.src);
    const cd = chainOf(e.dst);
    // walk both chains from the root down while they agree; the last shared entry is the group
    let i = cs.length - 1;
    let j = cd.length - 1;
    while (i > 0 && j > 0 && cs[i - 1] === cd[j - 1]) {
      i--;
      j--;
    }
    if (cs[i] !== cd[j] || i === 0 || j === 0) continue; // one end contains the other, or unrelated
    let list = groupEdges.get(cs[i]);
    if (!list) groupEdges.set(cs[i], (list = []));
    list.push({ a: cs[i - 1], b: cd[j - 1], weight: e.weight });
  }

  const huge = nodes.length > 5000;
  const rel = new Map<string, Pos>(); // position relative to the parent group's centre
  const radiusOf = new Map<string, number>();

  const layoutGroup = (group: string): number => {
    const members = (kids.get(group) ?? []).slice().sort();
    for (const m of members) if (kids.has(m)) radiusOf.set(m, layoutGroup(m));
    const g = new Graph({ type: 'undirected' });
    // big maps (thousands of small class groups at L3): tiny groups keep a tight spiral, no relaxation
    const settled = huge && members.length <= 8;
    members.forEach((m, i) => {
      const r = radiusOf.get(m) ?? byId.get(m)?.size ?? 5;
      const d = settled ? 3.2 * r * Math.sqrt(i + 0.5) : 14 * Math.sqrt(i + 1) * 4;
      g.addNode(m, { x: Math.cos(i * GOLDEN) * d, y: Math.sin(i * GOLDEN) * d, size: r });
    });
    if (members.length > 1 && !settled) {
      for (const { a, b, weight } of groupEdges.get(group) ?? []) {
        if (a === b) continue;
        if (g.hasEdge(a, b)) g.updateEdgeAttribute(a, b, 'weight', (w: number) => w + weight);
        else g.addEdge(a, b, { weight });
      }
      const n = g.order;
      // shortcut: > 5k-member groups get few FA2 passes on the main thread; move to the FA2 worker if they must look tighter
      forceAtlas2.assign(g, {
        iterations: n > 5000 ? 15 : n > 1500 ? 60 : n > 400 ? 120 : 200,
        getEdgeWeight: (_e, attr) => Math.log2(1 + (attr.weight as number)),
        settings: {
          ...forceAtlas2.inferSettings(g),
          adjustSizes: true,
          gravity: 1,
          scalingRatio: 4,
          barnesHutOptimize: n > 300,
          slowDown: 2,
        },
      });
      // noverlap costs ~0.3 s per pass at 17k members and can't separate that many nodes at fit zoom anyway;
      // huge groups rely on FA2's adjustSizes and a deeper zoom (GraphCanvas lowers minCameraRatio)
      if (n <= 5000) noverlap.assign(g, { maxIterations: 120, settings: { margin: 6, ratio: 1.05 } });
    }
    // centre on the bounding box and measure the enclosing radius
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    g.forEachNode((_id, a) => {
      minX = Math.min(minX, a.x - a.size);
      maxX = Math.max(maxX, a.x + a.size);
      minY = Math.min(minY, a.y - a.size);
      maxY = Math.max(maxY, a.y + a.size);
    });
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let r = 0;
    g.forEachNode((id, a) => {
      const p = { x: a.x - cx, y: a.y - cy };
      rel.set(id, p);
      r = Math.max(r, Math.hypot(p.x, p.y) + a.size);
    });
    return r + GROUP_PAD;
  };

  layoutGroup(ROOT);

  const abs = new Map<string, Pos>();
  const place = (group: string, origin: Pos) => {
    for (const m of kids.get(group) ?? []) {
      const p = rel.get(m) ?? { x: 0, y: 0 };
      const a = { x: origin.x + p.x, y: origin.y + p.y };
      abs.set(m, a);
      if (kids.has(m)) place(m, a);
    }
  };
  place(ROOT, { x: 0, y: 0 });

  // Group nodes act as the region's handle: park them at the top-left corner of their members.
  // (sigma's graph y-axis points up, so "top" is max y.)
  const handleOf = (group: string) => {
    const r = radiusOf.get(group) ?? 0;
    const c = abs.get(group);
    if (c) abs.set(group, { x: c.x - r * 0.72, y: c.y + r * 0.72 });
  };
  for (const g of radiusOf.keys()) handleOf(g);
  return abs;
}

/* ---------- user-pinned positions (dragged nodes), per repo and view (level + expanded set) ---------- */

const pinKey = (scope: string) => `spider:pins:${scope}`;

export function loadPins(scope: string): Record<string, Pos> {
  try {
    const raw = localStorage.getItem(pinKey(scope));
    return raw ? (JSON.parse(raw) as Record<string, Pos>) : {};
  } catch {
    return {};
  }
}

export function savePin(scope: string, id: string, p: Pos): void {
  try {
    const cur = loadPins(scope);
    cur[id] = { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
    const keys = Object.keys(cur);
    // shortcut: drops oldest pins past 5 000; upgrade to per-node LRU if users pin heavily.
    if (keys.length > 5000) for (const k of keys.slice(0, keys.length - 5000)) delete cur[k];
    localStorage.setItem(pinKey(scope), JSON.stringify(cur));
  } catch {
    /* storage full or blocked: pins just don't persist */
  }
}

export function clearPins(scope: string): void {
  try {
    localStorage.removeItem(pinKey(scope));
  } catch {
    /* ignore */
  }
}
