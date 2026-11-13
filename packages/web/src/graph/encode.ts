import type { GraphEdge, GraphNode, SubGraph } from '@spider/shared';
import type Graph from 'graphology';
import { locationOf, nodeLabel } from '../format';
import type { SizeBy } from '../store';
import {
  CONTAINER_KINDS,
  type ThemeName,
  blend,
  edgeColorOf,
  edgeWidth,
  nodeLook,
  nodeSize,
  subsystemColor,
  tokens,
} from '../theme';

export interface EncodeOptions {
  theme: ThemeName;
  hidden?: Set<string>;
  hideAmbiguous?: boolean;
  colorBySubsystem?: boolean;
  /** Node ids to mark with a diagnostic ring. */
  marks?: Map<string, 'danger' | 'warn'>;
  /** Edge ids drawn as a path/trace (accent, 2.5 px). */
  pathEdges?: Set<string>;
  /** Label every node (small query views) as long as the label cap allows. */
  labelAll?: boolean;
  /** Draw labels centred under nodes (column layouts, where edges run through the label side). */
  labelBelow?: boolean;
  /** Size nodes by a metric instead of the per-kind default (nodes without the metric keep the default). */
  sizeBy?: SizeBy;
}

export interface Encoded {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Expanded container → every visible descendant id. */
  groups: Map<string, string[]>;
}

const LABEL_CAP = 400;

/** Drops test-code nodes (and their edges) unless `keep` names them; tests are hidden by default. */
export function dropTests<T extends SubGraph>(sg: T, keep?: string): { sg: T; dropped: number } {
  const nodes = sg.nodes.filter((n) => !n.props.isTest || n.id === keep);
  if (nodes.length === sg.nodes.length) return { sg, dropped: 0 };
  const ids = new Set(nodes.map((n) => n.id));
  return {
    sg: { ...sg, nodes, edges: sg.edges.filter((e) => ids.has(e.src) && ids.has(e.dst)) },
    dropped: sg.nodes.length - nodes.length,
  };
}

/**
 * Replaces the graph's content with `sg`, applying the visual encoding (DESIGN_RULES §4.4, §8).
 * Existing x/y are kept for nodes that survive so views can animate from them.
 */
export function encodeGraph(graph: Graph, sg: SubGraph | undefined, o: EncodeOptions): Encoded {
  const prev = new Map<string, { x: number; y: number }>();
  graph.forEachNode((id, a) => prev.set(id, { x: a.x, y: a.y }));
  graph.clear();
  if (!sg) return { nodes: [], edges: [], groups: new Map() };

  const hidden = o.hidden ?? new Set<string>();
  const nodes = sg.nodes.filter((n) => !hidden.has(n.id));
  const ids = new Set(nodes.map((n) => n.id));
  const t = tokens[o.theme];

  // group structure from view parents
  const parentOf = new Map<string, string>();
  for (const n of nodes) {
    const vp = n.props.viewParent as string | undefined;
    if (vp && vp !== n.id && ids.has(vp)) parentOf.set(n.id, vp);
  }
  const groups = new Map<string, string[]>();
  const depthOf = (id: string) => {
    let d = 0;
    for (let cur = parentOf.get(id); cur && d < 64; cur = parentOf.get(cur)) d++;
    return d;
  };
  for (const n of nodes) {
    for (let cur = parentOf.get(n.id), guard = 0; cur && guard < 64; cur = parentOf.get(cur), guard++) {
      const list = groups.get(cur);
      if (list) list.push(n.id);
      else groups.set(cur, [n.id]);
    }
  }

  // labels: containers & endpoints are always labelled, but never more than LABEL_CAP at once
  const forced = new Set<string>();
  const labelCandidates =
    (o.labelAll && nodes.length <= LABEL_CAP) || nodes.length <= 80
      ? nodes
      : nodes.filter((n) => CONTAINER_KINDS.has(n.kind) || n.kind === 'endpoint' || groups.has(n.id));
  const ranked = labelCandidates.sort((a, b) => nodeSize(b) - nodeSize(a));
  for (const n of ranked.slice(0, nodes.length > LABEL_CAP ? 60 : LABEL_CAP)) forced.add(n.id);

  const sizeOf = metricSizer(nodes, o.sizeBy);
  for (const n of nodes) {
    const look = nodeLook(n.kind, o.theme);
    let fill = look.fill;
    if (o.colorBySubsystem && n.props.subsystem) fill = subsystemColor(String(n.props.subsystem));
    else if (o.colorBySubsystem && n.kind === 'subsystem') fill = subsystemColor(n.id);
    if (n.props.isTest) fill = blend(fill, 0.4, t.bgCanvas);
    const mark = o.marks?.get(n.id);
    const p = prev.get(n.id);
    const isGroup = groups.has(n.id);
    graph.addNode(n.id, {
      x: p?.x ?? 0,
      y: p?.y ?? 0,
      label: nodeLabel(n),
      fullLabel: n.qname ?? nodeLabel(n),
      kind: n.kind,
      size: isGroup ? 7 : sizeOf(n),
      color: fill,
      shape: look.shape,
      ringColor: mark ? t[mark] : look.ring,
      ringWidth: mark ? 2 : look.ringWidth,
      labelTone: n.kind === 'endpoint' ? 'accent' : CONTAINER_KINDS.has(n.kind) || isGroup ? 'primary' : 'secondary',
      forceLabel: forced.has(n.id),
      labelBelow: o.labelBelow ?? false,
      zIndex: isGroup ? 2 : 1,
      parent: parentOf.get(n.id),
      depth: depthOf(n.id),
      isGroup,
      childCount: Number(n.props.childCount ?? 0),
      location: locationOf(n),
      fanIn: n.metrics?.fanIn ?? 0,
      fanOut: n.metrics?.fanOut ?? 0,
    });
  }

  const edges: GraphEdge[] = [];
  const accent = t.accent;
  for (const e of sg.edges) {
    if (!ids.has(e.src) || !ids.has(e.dst) || e.src === e.dst) continue;
    const ambiguous = Boolean(e.props.ambiguous) || e.confidence < 1;
    if (o.hideAmbiguous && ambiguous) continue;
    if (graph.hasEdge(e.id)) continue;
    edges.push(e);
    const onPath = o.pathEdges?.has(e.id);
    const base = edgeColorOf(e.kind, o.theme);
    graph.addEdgeWithKey(e.id, e.src, e.dst, {
      kind: e.kind,
      weight: e.weight,
      size: onPath ? 2.5 : ambiguous ? 0.8 : edgeWidth(e.weight),
      color: onPath ? accent : ambiguous ? blend(base, 0.5, t.bgCanvas) : base,
      type: e.kind === 'depends_on' ? 'line' : 'arrow',
      zIndex: onPath ? 2 : 1,
    });
  }
  return { nodes, edges, groups };
}

/**
 * Radius 4–26 px by `sizeBy`, normalised to the largest visible value: counts (churn, LOC) on a log
 * scale, centralities (PageRank, betweenness: small fractions) by square root so area tracks value.
 */
function metricSizer(nodes: GraphNode[], sizeBy: SizeBy | undefined): (n: GraphNode) => number {
  if (!sizeBy || sizeBy === 'default') return nodeSize;
  const value = (n: GraphNode) => n.metrics?.[sizeBy];
  let max = 0;
  for (const n of nodes) max = Math.max(max, value(n) ?? 0);
  if (max <= 0) return nodeSize;
  const scale =
    sizeBy === 'pagerank' || sizeBy === 'betweenness'
      ? (v: number) => Math.sqrt(v / max)
      : (v: number) => Math.log2(1 + v) / Math.log2(1 + max);
  return (n) => {
    const v = value(n);
    return v === undefined ? nodeSize(n) : 4 + 22 * scale(v);
  };
}

/** Animates node positions to `target` over `ms` (ease-out). Returns a cancel function. */
export function animatePositions(graph: Graph, target: Map<string, { x: number; y: number }>, ms: number): () => void {
  const from = new Map<string, { x: number; y: number }>();
  graph.forEachNode((id, a) => from.set(id, { x: a.x, y: a.y }));
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const apply = (k: number) => {
    graph.updateEachNodeAttributes(
      (id, a) => {
        const to = target.get(id);
        const f = from.get(id);
        if (!to || !f) return a;
        a.x = f.x + (to.x - f.x) * k;
        a.y = f.y + (to.y - f.y) * k;
        return a;
      },
      { attributes: ['x', 'y'] },
    );
  };
  if (reduced || ms <= 0) {
    apply(1);
    return () => {};
  }
  const start = performance.now();
  let raf = 0;
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / ms);
    apply(1 - (1 - t) ** 3);
    if (t < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
