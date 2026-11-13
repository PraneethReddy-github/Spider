import type { Diagnostic, EndpointSummary, GraphNode, JobProgress, NodeDetail, ProjectionRequest, RepoInfo, SearchHit, SubGraph } from '@spider/shared';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, { headers: { 'content-type': 'application/json' }, ...init });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | boolean | string[] | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export type SubGraphWithDistances = SubGraph & { distances: Record<string, number> };

export interface SourceSnippet {
  path: string;
  language?: string;
  startLine: number;
  endLine: number;
  highlight?: [number, number];
  lines: string[];
  totalLines: number;
}

export type TreeNode = GraphNode & { childCount: number };
export interface SubsystemEntry {
  node: GraphNode;
  members: GraphNode[];
}

export const api = {
  repos: () => request<RepoInfo[]>('/repos'),
  repo: (id: string) => request<RepoInfo>(`/repos/${enc(id)}`),
  analyze: (body: { source: string; ref?: string; name?: string }) =>
    request<{ jobId: string }>('/repos', { method: 'POST', body: JSON.stringify(body) }),
  job: (id: string) => request<JobProgress>(`/jobs/${enc(id)}`),
  deleteRepo: (id: string) => request<{ ok: boolean }>(`/repos/${enc(id)}`, { method: 'DELETE' }),

  graph: (id: string, req: ProjectionRequest) =>
    request<SubGraph>(
      `/repos/${enc(id)}/graph${qs({
        level: req.level,
        expanded: req.expanded,
        edgeKinds: req.edgeKinds,
        nodeKinds: req.nodeKinds,
        languages: req.languages,
        includeTests: req.includeTests ? 'true' : undefined,
        minConfidence: req.minConfidence,
        minWeight: req.minWeight,
      })}`,
    ),
  node: (id: string, nodeId: string) => request<NodeDetail>(`/repos/${enc(id)}/nodes/${enc(nodeId)}`),
  source: (id: string, nodeId: string, context = 5) =>
    request<SourceSnippet>(`/repos/${enc(id)}/nodes/${enc(nodeId)}/source${qs({ context })}`),
  search: (id: string, q: string, kinds?: string[], limit = 25) =>
    request<SearchHit[]>(`/repos/${enc(id)}/search${qs({ q, kinds, limit })}`),
  upstream: (id: string, nodeId: string, depth = 3, kinds?: string[]) =>
    request<SubGraphWithDistances>(`/repos/${enc(id)}/upstream/${enc(nodeId)}${qs({ depth, kinds })}`),
  downstream: (id: string, nodeId: string, depth = 3, kinds?: string[]) =>
    request<SubGraphWithDistances>(`/repos/${enc(id)}/downstream/${enc(nodeId)}${qs({ depth, kinds })}`),
  neighbors: (id: string, nodeId: string, depth = 1, kinds?: string[]) =>
    request<SubGraphWithDistances>(`/repos/${enc(id)}/neighbors/${enc(nodeId)}${qs({ depth, kinds })}`),
  path: (id: string, from: string, to: string) => request<SubGraph>(`/repos/${enc(id)}/path${qs({ from, to })}`),
  endpoints: (id: string) => request<EndpointSummary[]>(`/repos/${enc(id)}/endpoints`),
  trace: (id: string, endpointId: string, depth = 6) =>
    request<SubGraphWithDistances>(`/repos/${enc(id)}/trace/${enc(endpointId)}${qs({ depth })}`),
  diagnostics: (id: string, type?: string) => request<Diagnostic[]>(`/repos/${enc(id)}/diagnostics${qs({ type })}`),
  subsystems: (id: string) => request<SubsystemEntry[]>(`/repos/${enc(id)}/subsystems`),
  tree: (id: string, node = 'repo', depth = 1) => request<TreeNode[]>(`/repos/${enc(id)}/tree${qs({ node, depth })}`),
  exportUrl: (id: string, format: 'json' | 'dot') => `${BASE}/repos/${enc(id)}/export?format=${format}`,
};

function enc(s: string): string {
  return encodeURIComponent(s);
}
