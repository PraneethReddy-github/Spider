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
  /** Commits touching the file in the last 6 months (files only; 0 outside git). */
  churn?: number;
  /** Approximate normalised betweenness centrality on the file dependency graph (files only, 0..1). */
  betweenness?: number;
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

/** Message on `WS /repos/:id/events`: a (re-)analysis of the repo finished; refetch its queries. */
export interface RepoEvent {
  type: 'updated';
  repoId: string;
  analysedAt: string;
}

export interface NodeDetail {
  node: GraphNode;
  parents: GraphNode[];
  incoming: { edge: GraphEdge; node: GraphNode }[];
  outgoing: { edge: GraphEdge; node: GraphNode }[];
  children: GraphNode[];
}

/** `GET /repos/:id/trace/:nodeId` — an endpoint's execution flow, ready for the Flow view. */
export interface TraceResult extends SubGraph {
  /** BFS hop count from the endpoint (0) for every node. */
  distances: Record<string, number>;
  /** Node ids grouped by distance, in a stable order (index = distance). */
  layers: string[][];
  /** Middleware the endpoint runs before its handler, in execution order (empty when unknown). */
  middleware: string[];
  /** Datastore/external nodes where the trace stopped (included, never traversed past). */
  boundaries: string[];
}

export interface EndpointSummary {
  node: GraphNode;
  handler?: GraphNode;
  traceDepth: number;
}

export interface Diagnostic {
  type: 'cycle' | 'dead-code' | 'god-module' | 'orphan' | 'layer-violation';
  title: string;
  nodeIds: string[];
  severity: 'info' | 'warn' | 'error';
  detail?: string;
}

/**
 * User corrections to inferred subsystems (`SPIDER_HOME/repos/<id>/overrides.json`). Applied in order:
 * merge (groups of subsystem ids merged into the first), pins (repo-relative file path → subsystem
 * id), rename (subsystem id → label).
 */
export interface SubsystemOverrides {
  rename: Record<string, string>;
  merge: string[][];
  pins: Record<string, string>;
}

/** `GET /repos/:id/nodes/:nodeId/history` — git history of the node's file (author names only). */
export interface NodeHistory {
  commits: number;
  authors: { name: string; commits: number }[];
  /** ISO date of the latest commit touching the file. */
  lastModified?: string;
}

export interface MatrixCell {
  /** Row: index of the source node in `MatrixResult.nodes`. */
  i: number;
  /** Column: index of the target node. */
  j: number;
  weight: number;
  kinds: Partial<Record<EdgeKind, number>>;
}

/** `GET /repos/:id/matrix` — dependency structure matrix, nodes ordered by layer then name. */
export interface MatrixResult {
  nodes: GraphNode[];
  cells: MatrixCell[];
  /** `layers[k]` = inferred layer of `nodes[k]` (0 = depends on nothing in the matrix). */
  layers: number[];
}

/** `GET /repos/:id/externals` item — an external dependency and the source files that use it. */
export interface ExternalUsage {
  node: GraphNode;
  total: number;
  users: { node: GraphNode; weight: number }[];
}

/** `GET /remote/refs` — branches and tags of a remote git repository. */
export interface RemoteRefs {
  defaultBranch?: string;
  branches: string[];
  tags: string[];
}

export * from './schemas.js';
export * from './diff.js';

/* ---------- semantic layer (Phase 5) ---------- */

/** A model-written summary of a node (C-23), cached by the hash of its input. */
export interface NodeSummary {
  nodeId: string;
  text: string;
  hash: string;
  model: string;
  generatedAt: string;
}

/** `GET /llm` — the configured provider, or `{ provider: null }` when model features are off. */
export interface LlmStatus {
  provider: 'anthropic' | 'openai' | 'ollama' | null;
  model?: string;
}
