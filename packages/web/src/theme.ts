import type { EdgeKind, GraphNode, NodeKind, ViewLevel } from '@spider/shared';

/** Node colours by kind. Used by the renderer, the legend and the badges. */
export const NODE_COLORS: Record<NodeKind, string> = {
  repository: '#e2e8f0',
  subsystem: '#f472b6',
  package: '#fb923c',
  directory: '#facc15',
  module: '#a3e635',
  namespace: '#bef264',
  file: '#60a5fa',
  class: '#a78bfa',
  function: '#2dd4bf',
  method: '#6ee7b7',
  variable: '#94a3b8',
  type: '#a1a1aa',
  endpoint: '#f97316',
  external: '#6b7280',
  datastore: '#f59e0b',
  config: '#d4d4d8',
};

export const EDGE_COLORS: Record<EdgeKind, string> = {
  contains: '#475569',
  imports: '#64748b',
  exports: '#7dd3fc',
  calls: '#3b82f6',
  instantiates: '#22d3ee',
  extends: '#a855f7',
  implements: '#c084fc',
  references: '#9ca3af',
  exposes: '#f97316',
  depends_on: '#6b7280',
  reads: '#f59e0b',
  writes: '#ef4444',
  configures: '#d4d4d8',
  member_of: '#475569',
  dep_aggregate: '#64748b',
};

export const COLORS = {
  bg: '#0b0f17',
  canvasBg: '#0d1219',
  label: '#e5e7eb',
  labelMuted: '#9ca3af',
  dim: '#1f2937',
  dimEdge: '#111827',
  selected: '#ffffff',
  incoming: '#60a5fa',
  outgoing: '#fb923c',
  ambiguous: '#4b5563',
};

/** Kinds that show up in the Legend, in display order. */
export const LEGEND_NODE_KINDS: NodeKind[] = [
  'subsystem', 'package', 'directory', 'file', 'class', 'function', 'method', 'endpoint', 'external', 'variable', 'type',
];
export const LEGEND_EDGE_KINDS: EdgeKind[] = [
  'imports', 'calls', 'instantiates', 'extends', 'implements', 'exposes', 'depends_on', 'references',
];

/** Edge kinds offered in the filter panel (and the projection default). */
export const FILTER_EDGE_KINDS: EdgeKind[] = [
  'imports', 'calls', 'instantiates', 'extends', 'implements', 'references', 'exposes', 'depends_on', 'reads', 'writes',
];
export const DEFAULT_EDGE_KINDS: EdgeKind[] = ['imports', 'calls', 'instantiates', 'extends', 'implements', 'exposes', 'depends_on'];

export const FILTER_NODE_KINDS: NodeKind[] = [
  'subsystem', 'package', 'directory', 'file', 'class', 'function', 'method', 'variable', 'type', 'endpoint', 'external',
];

export const KIND_ICONS: Record<NodeKind, string> = {
  repository: '◉',
  subsystem: '◈',
  package: '▣',
  directory: '▸',
  module: '▪',
  namespace: '▪',
  file: '▭',
  class: '■',
  function: '●',
  method: '○',
  variable: '·',
  type: 'τ',
  endpoint: '◆',
  external: '⬡',
  datastore: '⛁',
  config: '⚙',
};

export const KIND_SHORT: Record<NodeKind, string> = {
  repository: 'repo',
  subsystem: 'subsys',
  package: 'pkg',
  directory: 'dir',
  module: 'mod',
  namespace: 'ns',
  file: 'file',
  class: 'class',
  function: 'fn',
  method: 'method',
  variable: 'var',
  type: 'type',
  endpoint: 'endpoint',
  external: 'ext',
  datastore: 'store',
  config: 'config',
};

export const CONTAINERS = new Set<NodeKind>(['repository', 'subsystem', 'package', 'directory', 'file', 'module', 'namespace', 'class']);

const MIN_SIZE = 4;
const MAX_SIZE = 28;
const clamp = (v: number) => Math.max(MIN_SIZE, Math.min(MAX_SIZE, v));

/** Node size following the encoding in design.md §11.1 (log scales, clamped 4–28). */
export function nodeSize(n: GraphNode, level?: ViewLevel): number {
  const p = n.props ?? {};
  const childCount = Number(p.childCount ?? p.memberCount ?? p.fileCount ?? 0);
  switch (n.kind) {
    case 'subsystem':
    case 'package':
    case 'directory':
    case 'module':
    case 'namespace':
    case 'repository':
      return clamp(8 + 4 * Math.log2(childCount + 1));
    case 'file': {
      const loc = Number(p.loc ?? n.metrics?.loc ?? 0);
      const base = 5 + 2.2 * Math.log2(loc + 1);
      return clamp(childCount > 0 && level === 'L3' ? Math.max(base, 8 + 3 * Math.log2(childCount + 1)) : base);
    }
    case 'class': {
      const deg = (n.metrics?.fanIn ?? 0) + (n.metrics?.fanOut ?? 0) + 1;
      return clamp(6 + 3 * Math.log2(deg + childCount));
    }
    default: {
      const deg = (n.metrics?.fanIn ?? 0) + (n.metrics?.fanOut ?? 0) + 1;
      return clamp(4 + 3 * Math.log2(deg));
    }
  }
}

export function edgeWidth(weight: number): number {
  return 1 + Math.log2(Math.max(1, weight));
}

export function nodeColor(n: GraphNode): string {
  return NODE_COLORS[n.kind] ?? '#94a3b8';
}

export function edgeColor(kind: EdgeKind, ambiguous?: boolean): string {
  if (ambiguous) return COLORS.ambiguous;
  return EDGE_COLORS[kind] ?? '#64748b';
}

/** Whether a node's label should always be rendered (containers & endpoints). */
export function forceLabel(n: GraphNode): boolean {
  return CONTAINERS.has(n.kind) || n.kind === 'endpoint';
}
