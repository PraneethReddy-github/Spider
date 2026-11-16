import type { RepoInfo } from '@spider/shared';
import { listRepos, loadRepo, repoIdFor } from './analyze.js';
import { readSummaries } from './llm/summaries.js';
import { GRAPH_TOOLS, runGraphTool } from './llm/tools.js';
import { QueryService } from './query/service.js';

/**
 * MCP server (C-25): the Ask Spider graph tools for external agents, over stdio (newline-delimited JSON-RPC 2.0).
 * Read-only; never calls a model. `repo` pins one repository, otherwise every tool takes a `repo` argument.
 */

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

interface RpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}
type RpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

export interface McpOptions {
  home?: string;
  /** Repo id, name or source path every tool uses by default. */
  repo?: string;
  version?: string;
}

const LIST_REPOS = {
  name: 'list_repos',
  description: 'Repositories Spider has analysed (id, name, source, languages, size). Pass an id or name as `repo`.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};

export function createMcpHandler(o: McpOptions = {}): (msg: RpcRequest) => Promise<RpcResponse | undefined> {
  const loaded = new Map<string, Promise<{ q: QueryService; info: RepoInfo }>>();

  const findRepo = async (ref: string | undefined): Promise<RepoInfo> => {
    const want = ref ?? o.repo;
    const repos = await listRepos(o.home);
    if (!want) {
      if (repos.length === 1) return repos[0];
      throw new Error('pass `repo` (an id or name from list_repos)');
    }
    const r = repos.find((x) => x.repoId === want || x.name === want || x.repoId === repoIdFor(want));
    if (!r) throw new Error(`unknown repo "${want}"; known: ${repos.map((x) => x.name).join(', ') || 'none'}`);
    return r;
  };
  const service = (info: RepoInfo) => {
    let p = loaded.get(info.repoId);
    if (!p) {
      p = loadRepo(info.repoId, o.home).then(({ graph, meta }) => ({ q: new QueryService(graph, meta), info }));
      loaded.set(info.repoId, p);
      p.catch(() => loaded.delete(info.repoId));
    }
    return p;
  };

  const tools = () => [
    LIST_REPOS,
    ...GRAPH_TOOLS.map((t) => {
      const s = t.inputSchema as { properties: Record<string, unknown>; required: string[] };
      return {
        name: t.name,
        description: t.description,
        inputSchema: {
          ...s,
          properties: {
            ...s.properties,
            repo: { type: 'string', description: `Repository id or name${o.repo ? ` (default ${o.repo})` : ''}.` },
          },
        },
      };
    }),
  ];

  const callTool = async (name: string, args: Record<string, unknown> = {}) => {
    if (name === 'list_repos') {
      const repos = await listRepos(o.home);
      return text(
        repos.map((r) => ({
          id: r.repoId,
          name: r.name,
          source: r.source,
          languages: r.stats.languages,
          frameworks: r.stats.frameworks,
          files: r.stats.files,
          loc: r.stats.loc,
          analysedAt: r.analysedAt,
        })),
      );
    }
    const { repo, ...input } = args;
    let info: RepoInfo;
    try {
      info = await findRepo(typeof repo === 'string' ? repo : undefined);
    } catch (err) {
      return { content: [{ type: 'text', text: String((err as Error).message) }], isError: true };
    }
    const { q } = await service(info);
    const out = await runGraphTool(
      { q, root: info.root, summaries: await readSummaries(info.repoId, o.home) },
      name,
      input,
    );
    return { content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) };
  };

  return async (msg) => {
    const id = msg.id ?? null;
    const ok = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
    const fail = (code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });
    // notifications (no id) get no reply
    if (msg.id === undefined) return undefined;
    try {
      switch (msg.method) {
        case 'initialize': {
          const asked = String(msg.params?.protocolVersion ?? '');
          return ok({
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: 'spider', version: o.version ?? '0.0.0' },
            instructions:
              'Spider answers structural questions about analysed codebases from a code graph. Start with search (or list_repos), then follow node ids through node_detail, upstream, downstream, path and trace.',
          });
        }
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: tools() });
        case 'tools/call': {
          const name = String(msg.params?.name ?? '');
          if (name !== 'list_repos' && !GRAPH_TOOLS.some((t) => t.name === name))
            return fail(-32602, `unknown tool "${name}"`);
          return ok(await callTool(name, (msg.params?.arguments ?? {}) as Record<string, unknown>));
        }
        default:
          return fail(-32601, `method not found: ${msg.method}`);
      }
    } catch (err) {
      return fail(-32603, String((err as Error)?.message ?? err));
    }
  };
}

const text = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(v) }] });

/** Serves MCP on stdin/stdout until stdin closes. Logs go to stderr: stdout carries only protocol messages. */
export async function serveMcpStdio(o: McpOptions = {}): Promise<void> {
  const handle = createMcpHandler(o);
  const write = (r: RpcResponse | undefined) => r && process.stdout.write(`${JSON.stringify(r)}\n`);
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buf += chunk;
    let i = buf.indexOf('\n');
    while (i >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      i = buf.indexOf('\n');
      if (!line) continue;
      let msg: RpcRequest;
      try {
        msg = JSON.parse(line) as RpcRequest;
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      // answer in arrival order is not required by JSON-RPC; handle concurrently
      void handle(msg).then(write);
    }
  }
}
