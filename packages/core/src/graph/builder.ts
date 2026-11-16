import type { EdgeKind, GraphEdge, GraphNode, NodeKind, Span, SubGraph } from '@spider/shared';
import { ids } from './ids.js';

export interface AddEdgeOpts {
  weight?: number;
  confidence?: number;
  evidence?: Span;
  props?: Record<string, unknown>;
}

export class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges = new Map<string, GraphEdge>();
  private readonly outIndex = new Map<string, Set<string>>();
  private readonly inIndex = new Map<string, Set<string>>();

  addNode(n: Omit<GraphNode, 'props'> & { props?: Record<string, unknown> }): GraphNode {
    const existing = this.nodes.get(n.id);
    if (existing) {
      Object.assign(existing.props, n.props ?? {});
      return existing;
    }
    const node: GraphNode = { ...n, props: n.props ?? {} };
    this.nodes.set(node.id, node);
    if (node.parentId) this.addEdge('contains', node.parentId, node.id);
    return node;
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  addEdge(kind: EdgeKind, src: string, dst: string, opts: AddEdgeOpts = {}): GraphEdge | undefined {
    if (src === dst && kind !== 'calls') return undefined;
    const id = ids.edge(kind, src, dst);
    let e = this.edges.get(id);
    if (e) {
      e.weight += opts.weight ?? 1;
      if (opts.evidence) {
        const ev = (e.props.evidence ??= []);
        if (ev.length < 20) ev.push(opts.evidence);
      }
      if (opts.confidence !== undefined) e.confidence = Math.max(e.confidence, opts.confidence);
      return e;
    }
    e = {
      id,
      kind,
      src,
      dst,
      weight: opts.weight ?? 1,
      confidence: opts.confidence ?? 1,
      props: { ...(opts.props ?? {}), ...(opts.evidence ? { evidence: [opts.evidence] } : {}) },
    };
    this.putEdge(e);
    return e;
  }

  /** Inserts a stored edge as-is (id, weight, props kept); used by the store when loading. */
  putEdge(e: GraphEdge): void {
    this.edges.set(e.id, e);
    let o = this.outIndex.get(e.src);
    if (!o) this.outIndex.set(e.src, (o = new Set()));
    o.add(e.id);
    let i = this.inIndex.get(e.dst);
    if (!i) this.inIndex.set(e.dst, (i = new Set()));
    i.add(e.id);
  }

  removeEdge(id: string): void {
    const e = this.edges.get(id);
    if (!e) return;
    this.edges.delete(id);
    this.outIndex.get(e.src)?.delete(id);
    this.inIndex.get(e.dst)?.delete(id);
  }

  outEdges(id: string, kind?: EdgeKind): GraphEdge[] {
    const set = this.outIndex.get(id);
    if (!set) return [];
    const out: GraphEdge[] = [];
    for (const eid of set) {
      const e = this.edges.get(eid)!;
      if (!kind || e.kind === kind) out.push(e);
    }
    return out;
  }

  inEdges(id: string, kind?: EdgeKind): GraphEdge[] {
    const set = this.inIndex.get(id);
    if (!set) return [];
    const out: GraphEdge[] = [];
    for (const eid of set) {
      const e = this.edges.get(eid)!;
      if (!kind || e.kind === kind) out.push(e);
    }
    return out;
  }

  children(id: string): GraphNode[] {
    return this.outEdges(id, 'contains').map((e) => this.nodes.get(e.dst)!);
  }

  nodesOfKind(kind: NodeKind): GraphNode[] {
    const out: GraphNode[] = [];
    for (const n of this.nodes.values()) if (n.kind === kind) out.push(n);
    return out;
  }

  /** Walks up the `contains` chain, nearest first. */
  ancestors(id: string): GraphNode[] {
    const out: GraphNode[] = [];
    let cur = this.nodes.get(id);
    while (cur?.parentId) {
      cur = this.nodes.get(cur.parentId);
      if (cur) out.push(cur);
    }
    return out;
  }

  toSubGraph(): SubGraph {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }
}
