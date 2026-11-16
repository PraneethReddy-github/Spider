import type {
  Diagnostic,
  EndpointSummary,
  ExternalUsage,
  GraphNode,
  JobProgress,
  LlmStatus,
  MatrixCell,
  MatrixResult,
  NodeDetail,
  NodeHistory,
  NodeSummary,
  ProjectionRequest,
  RemoteRefs,
  RepoInfo,
  SearchHit,
  SubGraph,
  SubsystemOverrides,
  TraceResult,
} from '@spider/shared';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch {
    throw new ApiError(0, 'Spider server is not reachable. Start it with `spider serve`.');
  }
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error body: keep the status text */
    }
    // the server's catch-all answers unknown API routes with a bare "not found"
    if (res.status === 404 && msg.toLowerCase() === 'not found')
      msg = 'Not available on this server. Update Spider and restart `spider serve`.';
    throw new ApiError(res.status, msg || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

type QueryValue = string | number | boolean | string[] | undefined;

function qs(params: Record<string, QueryValue>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === '' || v === false || (Array.isArray(v) && v.length === 0)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

export type SubGraphWithDistances = SubGraph & { distances: Record<string, number> };
export type TreeNode = GraphNode & { childCount: number };
export interface SubsystemEntry {
  node: GraphNode;
  members: number;
}
export interface SourceSnippet {
  path: string;
  language?: string;
  startLine: number;
  endLine: number;
  highlight?: [number, number];
  lines: string[];
  totalLines: number;
}

export type Overrides = SubsystemOverrides;
export type Matrix = MatrixResult;
export type { ExternalUsage, MatrixCell, NodeHistory, RemoteRefs };
export type DiagnosticType = Diagnostic['type'];
export type AnyDiagnostic = Diagnostic;

/** Projection request as the web app sends it (focus fields are optional server-side). */
export type GraphRequest = ProjectionRequest & { focus?: string; focusDepth?: number };

export const api = {
  repos: () => request<RepoInfo[]>('/repos'),
  repo: (id: string) => request<RepoInfo>(`/repos/${enc(id)}`),
  analyze: (body: { source: string; ref?: string; name?: string }) =>
    request<{ jobId: string }>('/repos', { method: 'POST', body: JSON.stringify(body) }),
  reanalyze: (id: string) => request<{ jobId: string }>(`/repos/${enc(id)}/reanalyze`, { method: 'POST' }),
  job: (id: string) => request<JobProgress>(`/jobs/${enc(id)}`),
  deleteRepo: (id: string) => request<{ ok: boolean }>(`/repos/${enc(id)}`, { method: 'DELETE' }),

  graph: (id: string, req: GraphRequest) =>
    request<SubGraph>(
      `/repos/${enc(id)}/graph${qs({
        level: req.level,
        expanded: req.expanded,
        edgeKinds: req.edgeKinds,
        nodeKinds: req.nodeKinds,
        languages: req.languages,
        includeTests: req.includeTests ? 'true' : undefined,
        minConfidence: req.minConfidence || undefined,
        minWeight: req.minWeight || undefined,
        focus: req.focus,
        focusDepth: req.focus ? req.focusDepth : undefined,
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
    request<TraceResult>(`/repos/${enc(id)}/trace/${enc(endpointId)}${qs({ depth })}`),
  diagnostics: (id: string) => request<AnyDiagnostic[]>(`/repos/${enc(id)}/diagnostics`),
  subsystems: (id: string) => request<SubsystemEntry[]>(`/repos/${enc(id)}/subsystems`),
  tree: (id: string, node = 'repo', depth = 1) => request<TreeNode[]>(`/repos/${enc(id)}/tree${qs({ node, depth })}`),
  exportUrl: (id: string, format: 'json' | 'dot' | 'graphml') => `${BASE}/repos/${enc(id)}/export?format=${format}`,
  reportUrl: (id: string) => `${BASE}/repos/${enc(id)}/report?format=md`,
  overrides: (id: string) => request<Overrides>(`/repos/${enc(id)}/overrides`),
  llm: () => request<LlmStatus>('/llm'),
  summaries: (id: string) => request<Record<string, NodeSummary>>(`/repos/${enc(id)}/summaries`),
  summarize: (id: string, body: { nodeIds?: string[]; force?: boolean }) =>
    request<{ generated: number; reused: number; failed: { nodeId: string; error: string }[] }>(
      `/repos/${enc(id)}/summaries`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  saveOverrides: (id: string, body: Overrides) =>
    request<{ ok: true }>(`/repos/${enc(id)}/overrides`, { method: 'PUT', body: JSON.stringify(body) }),
  history: (id: string, nodeId: string) => request<NodeHistory>(`/repos/${enc(id)}/nodes/${enc(nodeId)}/history`),
  matrix: (id: string, level: 'L1' | 'L2', expanded: string[], includeTests: boolean) =>
    request<Matrix>(
      `/repos/${enc(id)}/matrix${qs({ level, expanded, includeTests: includeTests ? 'true' : undefined })}`,
    ),
  externals: (id: string) => request<ExternalUsage[]>(`/repos/${enc(id)}/externals`),
  remoteRefs: (source: string) => request<RemoteRefs>(`/remote/refs${qs({ source })}`),
};

/** Subscribes to `WS /repos/:id/events`; calls `onUpdated` after each re-analysis. Returns a stop function. */
export function watchRepo(repoId: string, onUpdated: (analysedAt: string) => void): () => void {
  let ws: WebSocket | undefined;
  let timer: number | undefined;
  let stopped = false;
  const open = (delay: number) => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    try {
      ws = new WebSocket(`${proto}://${window.location.host}${BASE}/repos/${enc(repoId)}/events`);
    } catch {
      return;
    }
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type?: string; analysedAt?: string };
        if (m.type === 'updated') onUpdated(m.analysedAt ?? '');
      } catch {
        /* ignore malformed frame */
      }
    };
    // server restarts drop the socket: reconnect with backoff (max 30 s)
    ws.onclose = () => {
      if (!stopped) timer = window.setTimeout(() => open(Math.min(30_000, delay * 2)), delay);
    };
  };
  open(1000);
  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    ws?.close();
  };
}

/**
 * Streams job progress over `WS /jobs/:id/events`, falling back to polling every 400 ms if the
 * socket can't open. Calls `onUpdate` until the job is done or failed. Returns a stop function.
 */
export function watchJob(jobId: string, onUpdate: (p: JobProgress) => void): () => void {
  let stopped = false;
  let timer: number | undefined;
  let ws: WebSocket | undefined;
  const finished = (p: JobProgress) => p.status === 'done' || p.status === 'failed';

  const poll = async () => {
    if (stopped) return;
    try {
      const p = await api.job(jobId);
      if (stopped) return;
      onUpdate(p);
      if (finished(p)) return;
    } catch (e) {
      if (stopped) return;
      onUpdate({ jobId, status: 'failed', stage: 'error', current: 0, total: 0, log: [], error: (e as Error).message });
      return;
    }
    timer = window.setTimeout(poll, 400);
  };

  let polling = false;
  const startPolling = () => {
    if (polling || stopped) return;
    polling = true;
    void poll();
  };

  try {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${window.location.host}${BASE}/jobs/${enc(jobId)}/events`);
    let gotMessage = false;
    ws.onmessage = (ev) => {
      gotMessage = true;
      try {
        const p = JSON.parse(String(ev.data)) as JobProgress;
        if (!stopped) onUpdate(p);
      } catch {
        /* ignore malformed frame */
      }
    };
    ws.onerror = () => {
      if (!gotMessage) startPolling();
    };
    // the server closes after the final message; one poll confirms the outcome either way
    ws.onclose = startPolling;
  } catch {
    startPolling();
  }

  return () => {
    stopped = true;
    if (timer) window.clearTimeout(timer);
    ws?.close();
  };
}
