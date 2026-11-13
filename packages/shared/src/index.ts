/**
 * @spider/shared — graph model and API contract shared by core, server, cli and web.
 */

import type { EdgeKind, NodeKind } from './kinds.js';

export * from './kinds.js';

/** Kinds that act as containers in the hierarchy. */
export const CONTAINER_KINDS: NodeKind[] = [
  'repository',
  'subsystem',
  'package',
  'directory',
  'file',
  'module',
  'namespace',
  'class',
];

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

export interface LanguageStat {
  language: string;
  files: number;
  loc: number;
}

export interface RepoStats {
  nodes: number;
  edges: number;
  files: number;
  loc: number;
  languages: LanguageStat[];
  frameworks: string[];
  /** Node counts by kind; `endpoint` excludes endpoints declared in test files. */
  byNodeKind: Partial<Record<NodeKind, number>>;
  byEdgeKind: Partial<Record<EdgeKind, number>>;
  /** Endpoints declared in test files (not included in `byNodeKind.endpoint`). */
  endpointsInTests: number;
  unresolvedImports: number;
  /** Calls whose head is a local or imported name that failed to bind to a repo symbol. */
  unresolvedCalls: number;
  /** Calls into libraries (head is an external import or an instance of an external type). */
  externalCalls: number;
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
  /** Node id: keep only nodes within `focusDepth` undirected hops of its visible representative. */
  focus?: string;
  /** Hops around `focus` (default 1, max 6). */
  focusDepth?: number;
}

export interface ProjectionStats {
  nodes: number;
  edges: number;
  byKind: Record<string, number>;
}

export interface ProjectionMeta {
  level: ViewLevel;
  /** Total nodes in the stored graph. */
  total: number;
  truncated: boolean;
  truncatedReason?: string;
  /** Visible representative of the requested focus node (absent when no focus or not visible). */
  focus?: string;
  stats: ProjectionStats;
}

export interface Projection {
  nodes: GraphNode[];
  edges: GraphEdge[];
  meta: ProjectionMeta;
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

export * from './schemas.js';
