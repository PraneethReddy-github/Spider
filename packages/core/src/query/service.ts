import type {
  Diagnostic,
  EdgeKind,
  EndpointSummary,
  GraphEdge,
  GraphNode,
  NodeDetail,
  Projection,
  ProjectionRequest,
  SearchHit,
  SubGraph,
  TraceResult,
} from '@spider/shared';
import type { GraphBuilder } from '../graph/builder.js';

const STRUCTURAL: Set<EdgeKind> = new Set(['contains', 'member_of', 'exports']);
const DEFAULT_EDGE_KINDS: EdgeKind[] = [
  'imports',
  'calls',
  'instantiates',
  'extends',
  'implements',
  'exposes',
  'depends_on',
];
const MAX_NODES = 6000;

export class QueryService {
  constructor(
    public readonly g: GraphBuilder,
    public readonly meta: Record<string, unknown>,
  ) {}

  /* ---------- projections ---------- */

  /**
   * Computes the visible node set for a view level plus explicitly expanded containers, then rolls
   * every relationship edge up to the nearest visible ancestor on both ends.
   */
  projection(req: ProjectionRequest): Projection {
    const g = this.g;
    const expanded = new Set(req.expanded ?? []);
    const edgeKinds = new Set(req.edgeKinds ?? DEFAULT_EDGE_KINDS);
    const includeTests = req.includeTests ?? false;
    const minConf = req.minConfidence ?? 0;
    const langs = req.languages ? new Set(req.languages) : undefined;
    const nodeKinds = req.nodeKinds ? new Set(req.nodeKinds) : undefined;

    const visible = new Map<string, GraphNode>();
    const childCount = new Map<string, number>();
    const parentOf = new Map<string, string>(); // visible-parent mapping for the current view
    let overflow = 0; // nodes that would have been visible beyond MAX_NODES

    const isAutoExpanded = (n: GraphNode): boolean => {
      if (expanded.has(n.id)) return true;
      switch (req.level) {
        case 'L0':
          return n.kind === 'repository';
        case 'L1':
          return n.kind === 'repository';
        case 'L2':
          return n.kind === 'repository' || n.kind === 'directory' || n.kind === 'package';
        case 'L3':
          return n.kind !== 'class' && n.kind !== 'function' && n.kind !== 'method';
      }
    };

    const acceptNode = (n: GraphNode): boolean => {
      if (!includeTests && n.props.isTest) return false;
      if (langs && n.language && n.kind !== 'directory' && !langs.has(n.language)) return false;
      if (nodeKinds && !nodeKinds.has(n.kind)) return false;
      return true;
    };

    // L0 uses subsystems as top-level containers (via member_of).
    const walk = (n: GraphNode, parent: string | undefined) => {
      let kids: GraphNode[];
      if (n.kind === 'subsystem')
        kids = g
          .inEdges(n.id, 'member_of')
          .map((e) => g.getNode(e.src)!)
          .filter(Boolean);
      else kids = g.children(n.id);
      kids = kids.filter(acceptNode);
      // At L3 classes are groups: the class stays visible with its members inside it.
      const explicit = expanded.has(n.id) || (req.level === 'L3' && n.kind === 'class' && kids.length > 0);
      if (!explicit && isAutoExpanded(n) && kids.length > 0) {
        // auto-expanded container disappears; its children take its place under the same view parent
        for (const k of kids) walk(k, parent);
        return;
      }
      if (visible.size >= MAX_NODES) {
        // keep counting so the truncation reason can state the real size
        overflow++;
        if (explicit) for (const k of kids) walk(k, n.id);
        return;
      }
      visible.set(n.id, n);
      childCount.set(n.id, kids.length);
      if (parent) parentOf.set(n.id, parent);
      if (explicit) {
        // explicitly expanded: keep the container as a group node and show its children inside it
        for (const k of kids) walk(k, n.id);
      }
    };

    const root = g.getNode('repo');
    if (!root)
      return { nodes: [], edges: [], meta: { level: req.level, total: 0, truncated: false, stats: statsOf([], []) } };
    if (req.level === 'L0') {
      const subs = g.nodesOfKind('subsystem');
      if (subs.length === 0) {
        for (const k of g.children('repo').filter(acceptNode)) walk(k, 'repo');
      } else {
        for (const s of subs) {
          if (expanded.has(s.id)) {
            visible.set(s.id, s);
            childCount.set(s.id, g.inEdges(s.id, 'member_of').length);
            for (const e of g.inEdges(s.id, 'member_of')) {
              const f = g.getNode(e.src);
              if (f && acceptNode(f)) walk(f, s.id);
            }
          } else {
            visible.set(s.id, s);
            childCount.set(s.id, g.inEdges(s.id, 'member_of').length);
          }
        }
      }
    } else {
      for (const k of g.children('repo').filter(acceptNode)) walk(k, 'repo');
    }

    // Externals & packages are always candidates; kept only if connected.
    const externals = g.nodesOfKind('external').filter(acceptNode);

    // Representative lookup: nearest visible ancestor (using containment, or subsystem for L0).
    const repCache = new Map<string, string | undefined>();
    const representative = (id: string): string | undefined => {
      if (visible.has(id)) return id;
      if (repCache.has(id)) return repCache.get(id);
      let cur = g.getNode(id);
      let rep: string | undefined;
      while (cur) {
        if (visible.has(cur.id)) {
          rep = cur.id;
          break;
        }
        if (req.level === 'L0' && cur.kind === 'file') {
          const sub = cur.props.subsystem as string | undefined;
          if (sub && visible.has(sub)) {
            rep = sub;
            break;
          }
        }
        cur = cur.parentId ? g.getNode(cur.parentId) : undefined;
      }
      repCache.set(id, rep);
      return rep;
    };

    const agg = new Map<string, GraphEdge>();
    const usedExternals = new Set<string>();
    for (const e of this.g.edges.values()) {
      if (STRUCTURAL.has(e.kind) || !edgeKinds.has(e.kind)) continue;
      if (e.confidence < minConf) continue;
      const srcNode = g.getNode(e.src);
      const dstNode = g.getNode(e.dst);
      if (!srcNode || !dstNode) continue;
      if (!includeTests && (srcNode.props.isTest || dstNode.props.isTest)) continue;
      let s = representative(e.src);
      let t = representative(e.dst);
      if (!s && dstNode.kind === 'external' && externals.includes(dstNode)) {
        continue;
      }
      if (!t && dstNode.kind === 'external' && (!nodeKinds || nodeKinds.has('external'))) {
        t = dstNode.id;
      }
      if (!s && srcNode.kind === 'package') s = representative(srcNode.parentId ?? '') ?? undefined;
      if (!s || !t || s === t) continue;
      if (g.getNode(t)?.kind === 'external') usedExternals.add(t);
      const key = `${e.kind}|${s}|${t}`;
      let a = agg.get(key);
      if (!a) {
        a = {
          id: key,
          kind: e.kind,
          src: s,
          dst: t,
          weight: 0,
          confidence: 0,
          props: { leafCount: 0, ambiguous: e.props.ambiguous ?? false },
        };
        agg.set(key, a);
      }
      a.weight += e.weight;
      a.props.leafCount = (a.props.leafCount as number) + 1;
      a.confidence = Math.max(a.confidence, e.confidence);
      if (!e.props.ambiguous) a.props.ambiguous = false;
      if (e.src === s && e.dst === t) a.props.direct = true;
    }
    for (const x of usedExternals) {
      const n = g.getNode(x);
      if (n) visible.set(x, n);
    }
    let edges = [...agg.values()].filter((e) => (req.minWeight ? e.weight >= req.minWeight : true));

    let focus: string | undefined;
    if (req.focus) {
      focus = visible.has(req.focus) ? req.focus : representative(req.focus);
      const keep = focus ? focusSet(focus, Math.min(6, Math.max(0, req.focusDepth ?? 1)), edges, parentOf) : new Set();
      for (const id of [...visible.keys()]) if (!keep.has(id)) visible.delete(id);
      edges = edges.filter((e) => keep.has(e.src) && keep.has(e.dst));
    }

    const nodes = [...visible.values()].map((n) => ({
      ...n,
      props: { ...n.props, childCount: childCount.get(n.id) ?? 0, viewParent: parentOf.get(n.id) },
    }));
    const truncated = overflow > 0;
    const truncatedReason = truncated
      ? `Showing first ${MAX_NODES.toLocaleString('en-US')} of ${(MAX_NODES + overflow).toLocaleString('en-US')} nodes. Collapse containers or use filters.`
      : undefined;
    return {
      nodes,
      edges,
      meta: {
        level: req.level,
        total: this.g.nodes.size,
        truncated,
        truncatedReason,
        focus,
        stats: statsOf(nodes, edges),
      },
    };
  }

  /* ---------- neighbourhood queries ---------- */

  private relEdges(id: string, dir: 'in' | 'out', kinds?: Set<EdgeKind>): GraphEdge[] {
    const list = dir === 'in' ? this.g.inEdges(id) : this.g.outEdges(id);
    return list.filter((e) => !STRUCTURAL.has(e.kind) && (!kinds || kinds.has(e.kind)));
  }

  neighborhood(
    id: string,
    direction: 'in' | 'out' | 'both',
    depth: number,
    kinds?: EdgeKind[],
  ): SubGraph & { distances: Record<string, number> } {
    const ks = kinds ? new Set(kinds) : undefined;
    const start = this.g.getNode(id);
    if (!start) return { nodes: [], edges: [], distances: {} };
    const dist = new Map<string, number>([[id, 0]]);
    const edges = new Map<string, GraphEdge>();
    let frontier = [id];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        const es = [
          ...(direction !== 'out' ? this.relEdges(cur, 'in', ks) : []),
          ...(direction !== 'in' ? this.relEdges(cur, 'out', ks) : []),
        ];
        for (const e of es) {
          edges.set(e.id, e);
          const other = e.src === cur ? e.dst : e.src;
          if (!dist.has(other)) {
            dist.set(other, d);
            next.push(other);
          }
          if (dist.size > 3000) break;
        }
      }
      frontier = next;
    }
    const nodes = [...dist.keys()].map((n) => this.g.getNode(n)!).filter(Boolean);
    return {
      nodes,
      edges: [...edges.values()],
      distances: Object.fromEntries(dist),
      meta: { root: id, direction, depth },
    };
  }

  upstream(id: string, depth = 3, kinds?: EdgeKind[]) {
    return this.neighborhood(id, 'in', depth, kinds);
  }

  downstream(id: string, depth = 3, kinds?: EdgeKind[]) {
    return this.neighborhood(id, 'out', depth, kinds);
  }

  /**
   * Shortest directed path (following relationship edges) from a to b; falls back to undirected.
   * Container endpoints (directories, files, classes, subsystems) stand for everything inside them,
   * because their relationships only exist on their contents.
   */
  path(from: string, to: string, kinds?: EdgeKind[]): SubGraph {
    const ks = kinds ? new Set(kinds) : undefined;
    const sources = this.selfAndDescendants(from);
    let targets = new Set(this.selfAndDescendants(to));
    const srcSet = new Set(sources);
    const disjoint = new Set([...targets].filter((t) => !srcSet.has(t)));
    if (disjoint.size > 0) targets = disjoint;
    const search = (undirected: boolean): SubGraph | undefined => {
      const prev = new Map<string, { node: string; edge: GraphEdge } | null>(sources.map((s) => [s, null]));
      const queue = [...sources];
      let hit: string | undefined;
      for (let i = 0; i < queue.length && !hit; i++) {
        const cur = queue[i];
        if (targets.has(cur)) {
          hit = cur;
          break;
        }
        const es = [...this.relEdges(cur, 'out', ks), ...(undirected ? this.relEdges(cur, 'in', ks) : [])];
        for (const e of es) {
          const other = e.src === cur ? e.dst : e.src;
          if (prev.has(other)) continue;
          prev.set(other, { node: cur, edge: e });
          if (targets.has(other)) {
            hit = other;
            break;
          }
          queue.push(other);
        }
        if (prev.size > 200000) break;
      }
      if (!hit) return undefined;
      const nodes: GraphNode[] = [];
      const edges: GraphEdge[] = [];
      let cur: string | undefined = hit;
      while (cur) {
        const n = this.g.getNode(cur);
        if (n) nodes.unshift(n);
        const p = prev.get(cur);
        if (!p) break;
        edges.unshift(p.edge);
        cur = p.node;
      }
      return { nodes, edges, meta: { undirected } };
    };
    return search(false) ?? search(true) ?? { nodes: [], edges: [], meta: { found: false } };
  }

  /** The node plus everything contained in it (subsystems include their member files' contents). */
  private selfAndDescendants(id: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      out.push(cur);
      const n = this.g.getNode(cur);
      if (!n) continue;
      const kids =
        n.kind === 'subsystem'
          ? this.g.inEdges(cur, 'member_of').map((e) => e.src)
          : this.g.children(cur).map((c) => c.id);
      for (const k of kids) stack.push(k);
    }
    return out;
  }

  /* ---------- lookups ---------- */

  node(id: string): GraphNode | undefined {
    return this.g.getNode(id);
  }

  detail(id: string, limit = 200): NodeDetail | undefined {
    const node = this.g.getNode(id);
    if (!node) return undefined;
    const mapEdge = (e: GraphEdge, otherId: string) => ({ edge: e, node: this.g.getNode(otherId)! });
    const incoming = this.g
      .inEdges(id)
      .filter((e) => !STRUCTURAL.has(e.kind))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map((e) => mapEdge(e, e.src))
      .filter((x) => x.node);
    const outgoing = this.g
      .outEdges(id)
      .filter((e) => !STRUCTURAL.has(e.kind))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map((e) => mapEdge(e, e.dst))
      .filter((x) => x.node);
    const children =
      node.kind === 'subsystem'
        ? this.g.inEdges(id, 'member_of').map((e) => this.g.getNode(e.src)!)
        : this.g.children(id);
    return { node, parents: this.g.ancestors(id), incoming, outgoing, children: children.slice(0, 500) };
  }

  search(query: string, kinds?: string[], limit = 25): SearchHit[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const ks = kinds ? new Set(kinds) : undefined;
    const hits: SearchHit[] = [];
    for (const n of this.g.nodes.values()) {
      if (ks && !ks.has(n.kind)) continue;
      if (n.kind === 'directory' && q.length < 3) continue;
      const name = n.name.toLowerCase();
      const qn = (n.qname ?? '').toLowerCase();
      let score = 0;
      if (name === q) score = 100;
      else if (name.startsWith(q)) score = 80;
      else if (name.includes(q)) score = 60;
      else if (qn.includes(q)) score = 40;
      else if (fuzzy(q, name)) score = 20;
      if (score === 0) continue;
      score += Math.min(15, Math.log2(1 + (n.metrics?.fanIn ?? 0)) * 3);
      if (n.kind === 'endpoint' || n.kind === 'class') score += 5;
      if (n.props.isTest) score -= 10;
      hits.push({ node: n, score });
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  endpoints(includeTests = false): EndpointSummary[] {
    return this.g
      .nodesOfKind('endpoint')
      .filter((ep) => includeTests || !ep.props.isTest)
      .sort((a, b) => String(a.props.path).localeCompare(String(b.props.path)) || a.name.localeCompare(b.name))
      .map((ep) => {
        const handlerEdge = this.g.outEdges(ep.id, 'exposes')[0];
        const handler = handlerEdge ? this.g.getNode(handlerEdge.dst) : undefined;
        const trace = this.trace(ep.id, 6);
        return { node: ep, handler, traceDepth: Math.max(0, ...Object.values(trace.distances)) };
      });
  }

  /**
   * An endpoint's execution flow: exposes → calls/instantiates/reads/writes, breadth-first.
   * Datastore and external nodes are included but never expanded (they are boundaries). Middleware
   * (an `exposes` edge or target marked `props.middleware`) is listed in `props.order`/source order.
   */
  trace(id: string, depth = 6): TraceResult {
    const kinds = new Set<EdgeKind>(['exposes', 'calls', 'instantiates', 'reads', 'writes']);
    const empty: TraceResult = { nodes: [], edges: [], distances: {}, layers: [], middleware: [], boundaries: [] };
    if (!this.g.getNode(id)) return empty;
    const isBoundary = (n?: GraphNode) => n?.kind === 'datastore' || n?.kind === 'external';
    const dist = new Map<string, number>([[id, 0]]);
    const edges = new Map<string, GraphEdge>();
    let frontier = [id];
    for (let d = 1; d <= depth && frontier.length && dist.size <= 3000; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        if (cur !== id && isBoundary(this.g.getNode(cur))) continue;
        for (const e of this.relEdges(cur, 'out', kinds)) {
          edges.set(e.id, e);
          if (!dist.has(e.dst)) {
            dist.set(e.dst, d);
            next.push(e.dst);
          }
        }
      }
      frontier = next;
    }
    const nodes = [...dist.keys()].map((n) => this.g.getNode(n)).filter((n): n is GraphNode => !!n);
    const ev = (e: GraphEdge) => e.props.evidence?.[0];
    const order = (e: GraphEdge) =>
      Number(
        e.props.order ?? this.g.getNode(e.dst)?.props.order ?? (ev(e)?.startLine ?? 0) * 1e4 + (ev(e)?.startCol ?? 0),
      );
    const middleware = this.g
      .outEdges(id, 'exposes')
      .filter((e) => e.props.middleware || this.g.getNode(e.dst)?.props.middleware)
      .sort((a, b) => order(a) - order(b))
      .map((e) => e.dst);
    const mwRank = new Map(middleware.map((m, i) => [m, i]));
    const layers: string[][] = [];
    for (const n of nodes) (layers[dist.get(n.id)!] ??= []).push(n.id);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const key = (nid: string) => {
      const n = byId.get(nid)!;
      return `${mwRank.has(nid) ? `0${String(mwRank.get(nid)).padStart(4, '0')}` : '1'}${n.qname ?? n.name}`;
    };
    for (const l of layers) l.sort((a, b) => key(a).localeCompare(key(b)));
    return {
      nodes,
      edges: [...edges.values()],
      distances: Object.fromEntries(dist),
      layers,
      middleware,
      boundaries: nodes.filter((n) => n.id !== id && isBoundary(n)).map((n) => n.id),
      meta: { root: id, direction: 'out', depth },
    };
  }

  diagnostics(type?: string): Diagnostic[] {
    const all = (this.meta.diagnostics as Diagnostic[] | undefined) ?? [];
    return type ? all.filter((d) => d.type === type) : all;
  }

  subsystems(): { node: GraphNode; members: number }[] {
    return this.g.nodesOfKind('subsystem').map((s) => ({ node: s, members: this.g.inEdges(s.id, 'member_of').length }));
  }

  /** Symbol tree under a node (for the explorer). */
  tree(id = 'repo', depth = 1): (GraphNode & { childCount: number })[] {
    const out: (GraphNode & { childCount: number })[] = [];
    const rec = (nid: string, d: number) => {
      for (const c of this.g.children(nid).sort(sortTree)) {
        const cc = this.g.children(c.id).length;
        out.push({ ...c, childCount: cc });
        if (d < depth) rec(c.id, d + 1);
      }
    };
    rec(id, 1);
    return out;
  }
}

/** Nodes within `depth` undirected hops of `start` over `edges`, plus their view-parent ancestors. */
function focusSet(start: string, depth: number, edges: GraphEdge[], parentOf: Map<string, string>): Set<string> {
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string) => {
    let l = adj.get(a);
    if (!l) adj.set(a, (l = []));
    l.push(b);
  };
  for (const e of edges) {
    link(e.src, e.dst);
    link(e.dst, e.src);
  }
  const keep = new Set([start]);
  let frontier = [start];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: string[] = [];
    for (const id of frontier)
      for (const o of adj.get(id) ?? [])
        if (!keep.has(o)) {
          keep.add(o);
          next.push(o);
        }
    frontier = next;
  }
  for (const id of [...keep]) for (let p = parentOf.get(id); p && !keep.has(p); p = parentOf.get(p)) keep.add(p);
  return keep;
}

function statsOf(nodes: GraphNode[], edges: GraphEdge[]) {
  const byKind: Record<string, number> = {};
  for (const n of nodes) byKind[n.kind] = (byKind[n.kind] ?? 0) + 1;
  return { nodes: nodes.length, edges: edges.length, byKind };
}

const KIND_ORDER: Record<string, number> = {
  directory: 0,
  package: 1,
  file: 2,
  class: 3,
  function: 4,
  method: 5,
  variable: 6,
  type: 7,
  endpoint: 8,
};
function sortTree(a: GraphNode, b: GraphNode): number {
  const ka = KIND_ORDER[a.kind] ?? 9;
  const kb = KIND_ORDER[b.kind] ?? 9;
  if (ka !== kb) return ka - kb;
  return a.name.localeCompare(b.name);
}

function fuzzy(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i]) i++;
  return i === q.length;
}
