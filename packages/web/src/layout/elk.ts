import type { ELK, ElkNode } from 'elkjs/lib/elk-api';
import type { Pos } from './map';

let elk: Promise<ELK> | undefined;

/** elkjs runs in its own web worker; both the API and the worker script load on first use. */
function getElk(): Promise<ELK> {
  elk ??= Promise.all([import('elkjs/lib/elk-api.js'), import('elkjs/lib/elk-worker.min.js?url')]).then(
    ([api, worker]) => new api.default({ workerUrl: worker.default }),
  );
  return elk;
}

export interface FlowNodeBox {
  id: string;
  /** Rendered node radius (graph `size`). */
  size: number;
}

/** Room reserved for a label under each node (≈ 16 characters of 12 px text). */
const LABEL_W = 112;

/**
 * Flow view layered layout (ELK "layered"). Downstream/trace/path read left → right from the root.
 * Upstream reverses every edge and lays out right → left, so the root is the single source on the
 * right and its callers fan out leftwards by distance. Labels sit below nodes, so each box reserves
 * room for its label. Returns graph coordinates (y up).
 */
export async function elkLayered(
  nodes: FlowNodeBox[],
  edges: { id: string; src: string; dst: string }[],
  upstream: boolean,
): Promise<Map<string, Pos>> {
  const ids = new Set(nodes.map((n) => n.id));
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': upstream ? 'LEFT' : 'RIGHT',
      'elk.layered.spacing.nodeNodeBetweenLayers': '96',
      'elk.spacing.nodeNode': '20',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.separateConnectedComponents': 'false',
    },
    // one width for every node keeps each layer's centres on one vertical line; height leaves room
    // for the 12 px label drawn below the node
    children: nodes.map((n) => ({ id: n.id, width: LABEL_W, height: n.size * 2 + 20 })),
    edges: edges
      .filter((e) => e.src !== e.dst && ids.has(e.src) && ids.has(e.dst))
      .map((e) => ({ id: e.id, sources: [upstream ? e.dst : e.src], targets: [upstream ? e.src : e.dst] })),
  };
  const out = await (await getElk()).layout(graph);
  // The canvas fits the whole drawing, so a tall result (many nodes per layer) would squeeze layers
  // together and their labels would collide. Stretch x until the drawing is about as wide as tall.
  const stretch = Math.max(1, (out.height ?? 0) / Math.max(1, out.width ?? 0));
  const size = new Map(nodes.map((n) => [n.id, n.size]));
  const pos = new Map<string, Pos>();
  for (const c of out.children ?? []) {
    pos.set(c.id, { x: ((c.x ?? 0) + LABEL_W / 2) * stretch, y: -((c.y ?? 0) + (size.get(c.id) ?? 0)) });
  }
  return pos;
}
