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

  // ancestor chain lookup: child-of-`group` that contains `id`
  const childUnder = (id: string, group: string): string | undefined => {
    let cur = id;
    for (let guard = 0; guard < 64; guard++) {
      const p = parentOf(cur);
      if (p === group) return cur;
      if (p === ROOT) return undefined;
      cur = p;
    }
    return undefined;
  };

  const rel = new Map<string, Pos>(); // position relative to the parent group's centre
  const radiusOf = new Map<string, number>();

  const layoutGroup = (group: string): number => {
    const members = (kids.get(group) ?? []).slice().sort();
    for (const m of members) if (kids.has(m)) radiusOf.set(m, layoutGroup(m));
    const g = new Graph({ type: 'undirected' });
    members.forEach((m, i) => {
      const r = radiusOf.get(m) ?? byId.get(m)?.size ?? 5;
      const d = 14 * Math.sqrt(i + 1);
      g.addNode(m, { x: Math.cos(i * GOLDEN) * d * 4, y: Math.sin(i * GOLDEN) * d * 4, size: r });
    });
    if (members.length > 1) {
      for (const e of edges) {
        const a = childUnder(e.src, group);
        const b = childUnder(e.dst, group);
        if (!a || !b || a === b) continue;
        if (g.hasEdge(a, b)) g.updateEdgeAttribute(a, b, 'weight', (w: number) => w + e.weight);
        else g.addEdge(a, b, { weight: e.weight });
      }
      const n = g.order;
      forceAtlas2.assign(g, {
        iterations: n > 1500 ? 60 : n > 400 ? 120 : 200,
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
      noverlap.assign(g, { maxIterations: 120, settings: { margin: 6, ratio: 1.05 } });
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
