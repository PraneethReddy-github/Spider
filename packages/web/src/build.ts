import type { GraphEdge, GraphNode, SubGraph, ViewLevel } from '@spider/shared';
import type Graph from 'graphology';
import type { Pos } from './layout';
import { edgeColor, edgeWidth, forceLabel, nodeColor, nodeSize } from './theme';

export interface BuildOptions {
  level?: ViewLevel;
  hidden?: Set<string>;
  hideAmbiguous?: boolean;
  positions?: Record<string, Pos>;
  /** Keep the x/y of nodes already present in the graph. */
  keepExisting?: boolean;
}

export function nodeLabel(n: GraphNode): string {
  if (n.kind === 'endpoint') {
    const m = n.props.method ? `${String(n.props.method).toUpperCase()} ` : '';
    return `${m}${n.props.path ?? n.name}`;
  }
  return n.name;
}

/** Replace a graphology graph's content with a SubGraph, applying the visual encoding. */
export function fillGraph(graph: Graph, sg: SubGraph | undefined, opts: BuildOptions = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const prev = new Map<string, Pos>();
  if (opts.keepExisting) graph.forEachNode((id, a) => prev.set(id, { x: a.x, y: a.y }));
  graph.clear();
  if (!sg) return { nodes: [], edges: [] };
  const hidden = opts.hidden ?? new Set();
  const nodes = sg.nodes.filter((n) => !hidden.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const p = prev.get(n.id) ?? opts.positions?.[n.id];
    graph.addNode(n.id, {
      label: nodeLabel(n),
      kind: n.kind,
      size: nodeSize(n, opts.level),
      color: nodeColor(n),
      x: p?.x ?? 0,
      y: p?.y ?? 0,
      viewParent: n.props.viewParent ?? '',
      forceLabel: forceLabel(n),
      zIndex: 1,
    });
  }
  const edges = sg.edges.filter((e) => ids.has(e.src) && ids.has(e.dst) && e.src !== e.dst && !(opts.hideAmbiguous && e.props.ambiguous));
  for (const e of edges) {
    if (graph.hasEdge(e.id)) continue;
    const ambiguous = Boolean(e.props.ambiguous);
    graph.addEdgeWithKey(e.id, e.src, e.dst, {
      kind: e.kind,
      weight: e.weight,
      size: ambiguous ? 0.8 : edgeWidth(e.weight),
      color: ambiguous ? edgeColor(e.kind, true) : edgeColor(e.kind),
      type: 'arrow',
      zIndex: 1,
    });
  }
  return { nodes, edges };
}
