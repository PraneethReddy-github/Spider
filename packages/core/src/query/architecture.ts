import type { EdgeKind, ExternalUsage, GraphNode, MatrixCell, MatrixResult } from '@spider/shared';
import { layerize } from '../enrich/layers.js';
import { SOURCE_LANGS } from '../enrich/subsystems.js';
import { ids } from '../graph/ids.js';
import type { QueryService } from './service.js';

/** Edge kinds that count as one file using another (or an external). */
const USE_KINDS = new Set<EdgeKind>(['imports', 'calls', 'instantiates', 'extends', 'implements', 'references']);

/** Externals have their own view; packages only carry `depends_on` to externals; the repo is the frame. */
const OUTSIDE_MATRIX = new Set(['external', 'package', 'repository']);

export interface MatrixRequest {
  level: 'L1' | 'L2';
  expanded?: string[];
  includeTests?: boolean;
}

/**
 * Dependency structure matrix from the projection roll-up: one row/column per visible node (expanded
 * groups, externals, packages and non-source files left out), ordered by inferred layer (0 = depends on nothing) then name, so
 * dependencies sit below the diagonal and cells above it (j > i) are upward or cyclic.
 */
export function matrix(q: QueryService, req: MatrixRequest): MatrixResult {
  const p = q.projection({ level: req.level, expanded: req.expanded, includeTests: req.includeTests });
  const expanded = new Set(req.expanded ?? []);
  const nodes = p.nodes.filter(
    (n) =>
      !OUTSIDE_MATRIX.has(n.kind) &&
      !(n.kind === 'file' && !SOURCE_LANGS.has(n.language ?? '')) &&
      !(expanded.has(n.id) && ((n.props.childCount as number | undefined) ?? 0) > 0),
  );
  const keep = new Set(nodes.map((n) => n.id));
  const edges = p.edges.filter((e) => keep.has(e.src) && keep.has(e.dst));
  const layer = layerize(
    nodes.map((n) => n.id),
    edges.map((e): [string, string] => [e.src, e.dst]),
  );
  const key = (n: GraphNode) => n.qname ?? n.name;
  nodes.sort(
    (a, b) =>
      (layer.get(a.id) ?? 0) - (layer.get(b.id) ?? 0) ||
      a.name.localeCompare(b.name) ||
      key(a).localeCompare(key(b)) ||
      a.id.localeCompare(b.id),
  );
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const cells = new Map<string, MatrixCell>();
  for (const e of edges) {
    const i = index.get(e.src) as number;
    const j = index.get(e.dst) as number;
    let c = cells.get(`${i},${j}`);
    if (!c) cells.set(`${i},${j}`, (c = { i, j, weight: 0, kinds: {} }));
    c.weight += e.weight;
    c.kinds[e.kind] = (c.kinds[e.kind] ?? 0) + e.weight;
  }
  return {
    nodes,
    cells: [...cells.values()].sort((a, b) => a.i - b.i || a.j - b.j),
    layers: nodes.map((n) => layer.get(n.id) ?? 0),
  };
}

/** The non-test file a node lives in (the node itself for files). */
function fileOf(q: QueryService, id: string): GraphNode | undefined {
  const n = q.g.getNode(id);
  if (!n) return undefined;
  const f = n.kind === 'file' ? n : n.file ? q.g.getNode(ids.file(n.file)) : undefined;
  return f && !f.props.isTest ? f : undefined;
}

/** External dependencies with the non-test files that import or call them, most used first. */
export function externals(q: QueryService): ExternalUsage[] {
  const out: ExternalUsage[] = [];
  for (const ext of q.g.nodesOfKind('external')) {
    const users = new Map<string, { node: GraphNode; weight: number }>();
    for (const e of q.g.inEdges(ext.id)) {
      if (!USE_KINDS.has(e.kind)) continue;
      const f = fileOf(q, e.src);
      if (!f) continue;
      const u = users.get(f.id) ?? { node: f, weight: 0 };
      u.weight += e.weight;
      users.set(f.id, u);
    }
    if (users.size === 0) continue;
    const list = [...users.values()].sort(
      (a, b) => b.weight - a.weight || (a.node.file ?? '').localeCompare(b.node.file ?? ''),
    );
    out.push({ node: ext, total: list.reduce((s, u) => s + u.weight, 0), users: list });
  }
  return out.sort((a, b) => b.total - a.total || a.node.name.localeCompare(b.node.name));
}

/** Subsystem → subsystem dependency weights from non-test relationship edges. */
export function subsystemDeps(q: QueryService): Map<string, Map<string, number>> {
  const deps = new Map<string, Map<string, number>>();
  for (const e of q.g.edges.values()) {
    if (!USE_KINDS.has(e.kind) || e.kind === 'references') continue;
    const a = fileOf(q, e.src)?.props.subsystem as string | undefined;
    const b = fileOf(q, e.dst)?.props.subsystem as string | undefined;
    if (!a || !b || a === b) continue;
    let m = deps.get(a);
    if (!m) deps.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + e.weight);
  }
  return deps;
}

/** Inferred layer of every non-test subsystem over the subsystem dependency graph (cycles condensed). */
export function subsystemLayers(q: QueryService): Map<string, number> {
  const deps = subsystemDeps(q);
  const edges: [string, string][] = [];
  for (const [a, m] of deps) for (const b of m.keys()) edges.push([a, b]);
  return layerize(
    q.g
      .nodesOfKind('subsystem')
      .filter((s) => !s.props.isTest)
      .map((s) => s.id),
    edges,
  );
}
