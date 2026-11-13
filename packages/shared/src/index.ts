/**
 * @spider/shared — graph model and API contract shared by core, server, cli and web.
 */

export type NodeKind =
  | 'repository'
  | 'subsystem'
  | 'package'
  | 'directory'
  | 'file'
  | 'module'
  | 'namespace'
  | 'class'
  | 'function'
  | 'method'
  | 'variable'
  | 'type'
  | 'endpoint'
  | 'external'
  | 'datastore'
  | 'config';

export type EdgeKind =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'calls'
  | 'instantiates'
  | 'extends'
  | 'implements'
  | 'references'
  | 'exposes'
  | 'depends_on'
  | 'reads'
  | 'writes'
  | 'configures'
  | 'member_of'
  | 'dep_aggregate';

export const NODE_KINDS: NodeKind[] = [
  'repository', 'subsystem', 'package', 'directory', 'file', 'module', 'namespace', 'class',
  'function', 'method', 'variable', 'type', 'endpoint', 'external', 'datastore', 'config',
];

export const EDGE_KINDS: EdgeKind[] = [
  'contains', 'imports', 'exports', 'calls', 'instantiates', 'extends', 'implements', 'references',
  'exposes', 'depends_on', 'reads', 'writes', 'configures', 'member_of', 'dep_aggregate',
];

/** Kinds that act as containers in the hierarchy. */
export const CONTAINER_KINDS: NodeKind[] = ['repository', 'subsystem', 'package', 'directory', 'file', 'module', 'namespace', 'class'];

/** Symbol-level kinds. */
export const SYMBOL_KINDS: NodeKind[] = ['class', 'function', 'method', 'variable', 'type', 'endpoint'];

export interface Span {
  file: string;
  startLine: number; // 1-based
  startCol: number;
  endLine: number;
  endCol: number;
}

export interface NodeMetrics {
  fanIn: number;
  fanOut: number;
  loc?: number;
  complexity?: number;
  pagerank?: number;
  churn?: number;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  name: string;
  /** Fully qualified name, e.g. src/auth/login.ts::LoginService.login */
  qname?: string;
  /** Path of the file this node lives in (or is), repo-relative. */
  file?: string;
  language?: string;
  parentId?: string;
  span?: Span;
  metrics?: NodeMetrics;
  props: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  src: string;
  dst: string;
  weight: number;
  confidence: number;
  props: Record<string, unknown> & { evidence?: Span[]; ambiguous?: boolean; isDynamic?: boolean };
}

export interface SubGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta?: Record<string, unknown>;
}

export interface LanguageStat { language: string; files: number; loc: number }

export interface RepoStats {
  nodes: number;
  edges: number;
  files: number;
  loc: number;
  languages: LanguageStat[];
  frameworks: string[];
  byNodeKind: Partial<Record<NodeKind, number>>;
  byEdgeKind: Partial<Record<EdgeKind, number>>;
  unresolvedImports: number;
  unresolvedCalls: number;
}

export interface RepoInfo {
  repoId: string;
  name: string;
  source: string;
  root: string;
  commit?: string;
  branch?: string;
  analysedAt: string;
  durationMs: number;
  stats: RepoStats;
}

export type ViewLevel = 'L0' | 'L1' | 'L2' | 'L3';

export interface ProjectionRequest {
  level: ViewLevel;
  /** Container node ids the user has expanded (their children replace them). */
  expanded?: string[];
  edgeKinds?: EdgeKind[];
  nodeKinds?: NodeKind[];
  languages?: string[];
  includeTests?: boolean;
  minConfidence?: number;
  minWeight?: number;
}

export interface SearchHit {
  node: GraphNode;
  score: number;
}

export interface JobProgress {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  stage: string;
  current: number;
  total: number;
  message?: string;
  error?: string;
  log: string[];
  repoId?: string;
}

export interface NodeDetail {
  node: GraphNode;
  parents: GraphNode[];
  incoming: { edge: GraphEdge; node: GraphNode }[];
  outgoing: { edge: GraphEdge; node: GraphNode }[];
  children: GraphNode[];
}

export interface EndpointSummary {
  node: GraphNode;
  handler?: GraphNode;
  traceDepth: number;
}

export interface Diagnostic {
  type: 'cycle' | 'dead-code' | 'god-module' | 'orphan';
  title: string;
  nodeIds: string[];
  severity: 'info' | 'warn' | 'error';
  detail?: string;
}
