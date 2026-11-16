import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import {
  QueryService,
  analyzeInWorker,
  deleteRepo,
  listRepos,
  loadRepo,
  openSearchIndex,
  repoDir,
  spiderHome,
  storedView,
  toDot,
  toGraphML,
} from '@spider/core';
import {
  type EdgeKind,
  type JobProgress,
  type RepoEvent,
  type RepoInfo,
  diagnosticsQuerySchema,
  endpointsQuerySchema,
  exportQuerySchema,
  graphQuerySchema,
  parseQuery,
  pathQuerySchema,
  searchQuerySchema,
  sourceQuerySchema,
  traversalQuerySchema,
  treeQuerySchema,
} from '@spider/shared';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { registerArchitectureRoutes } from './architecture.js';
import { registerDiffRoutes } from './diff.js';
import { type RepoWatcher, createRepoWatcher } from './watch.js';

export interface ServerOptions {
  port?: number;
  host?: string;
  home?: string;
  /** Directory with the built web app (index.html). */
  webDir?: string;
  logger?: boolean;
  /** Re-analyse registered local repos when their files change (`spider serve --watch`). */
  watch?: boolean;
}

const jobs = new Map<string, JobProgress>();
/** WebSocket subscribers per job id; each receives every progress update. */
const jobListeners = new Map<string, Set<(job: JobProgress) => void>>();
const isFinal = (job: JobProgress) => job.status === 'done' || job.status === 'failed';

function publish(job: JobProgress) {
  for (const listener of jobListeners.get(job.jobId) ?? []) listener(job);
  if (isFinal(job)) jobListeners.delete(job.jobId);
}
/** `WS /repos/:id/events` subscribers per repo id; told when a re-analysis lands. */
const repoListeners = new Map<string, Set<(msg: RepoEvent) => void>>();
const services = new Map<string, Promise<{ q: QueryService; info: RepoInfo }>>();

async function getService(repoId: string, home?: string) {
  let p = services.get(repoId);
  if (!p) {
    p = loadRepo(repoId, home).then(async ({ graph, meta, info }) => ({
      q: new QueryService(graph, meta, await openSearchIndex(repoId, home)),
      info,
    }));
    services.set(repoId, p);
    p.catch(() => services.delete(repoId));
  }
  return p;
}

/** Forgets a repo's loaded graph and closes its search index. */
function dropService(repoId: string) {
  const p = services.get(repoId);
  services.delete(repoId);
  p?.then(({ q }) => q.close()).catch(() => {});
}

/** Validates `query` against a shared schema; on failure replies 400 `{error}` and returns undefined. */
function valid<S extends Parameters<typeof parseQuery>[0]>(schema: S, query: unknown, reply: FastifyReply) {
  const r = parseQuery(schema, query);
  if (r.ok) return r.data;
  void reply.code(400).send({ error: r.error });
  return undefined;
}

function findWebDir(): string | undefined {
  const require = createRequire(import.meta.url);
  const candidates = [
    path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../web/dist'),
    (() => {
      try {
        return path.join(path.dirname(require.resolve('@spider/web/package.json')), 'dist');
      } catch {
        return '';
      }
    })(),
  ];
  return candidates.find((c) => c && existsSync(path.join(c, 'index.html')));
}

export async function createServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  const home = opts.home;
  let watcher: RepoWatcher | undefined;

  app.get('/api/v1/health', async () => ({ ok: true }));

  /* ---------- repos & jobs ---------- */
  app.get('/api/v1/repos', async () => listRepos(home));

  /** Starts an analysis job (on a worker thread, so this event loop keeps serving) and returns it. */
  const startJob = (source: string, ref?: string, name?: string) => {
    const jobId = randomUUID();
    const job: JobProgress = { jobId, status: 'queued', stage: 'ingest', current: 0, total: 0, log: [] };
    jobs.set(jobId, job);
    const done = analyzeInWorker({
      source,
      ref,
      name,
      home,
      onProgress: (e) => {
        job.status = 'running';
        job.stage = e.stage;
        job.current = e.current;
        job.total = e.total;
        job.message = e.message;
        if (e.message && (e.stage !== 'parse' || e.current === e.total)) job.log.push(`[${e.stage}] ${e.message}`);
        if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
        publish(job);
      },
    })
      .then((info) => {
        job.status = 'done';
        job.repoId = info.repoId;
        dropService(info.repoId);
        publish(job);
        const event: RepoEvent = { type: 'updated', repoId: info.repoId, analysedAt: info.analysedAt };
        for (const listener of repoListeners.get(info.repoId) ?? []) listener(event);
        return info;
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = String(err?.message ?? err);
        publish(job);
        return undefined;
      });
    return { job, done };
  };

  app.post<{ Body: { source: string; ref?: string; name?: string } }>('/api/v1/repos', async (req, reply) => {
    const { source, ref, name } = req.body ?? {};
    if (!source) return reply.code(400).send({ error: 'source is required' });
    const { job, done } = startJob(source, ref, name);
    if (watcher) void done.then((info) => info && watcher?.add(info));
    return { jobId: job.jobId };
  });

  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return job;
  });

  // Streams JobProgress JSON messages: the current state on connect, then every update; closes after done/failed.
  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id/events', { websocket: true }, (socket, req) => {
    const job = jobs.get(req.params.id);
    if (!job) {
      socket.send(JSON.stringify({ error: 'job not found' }));
      socket.close(4404, 'job not found');
      return;
    }
    const send = (j: JobProgress) => {
      socket.send(JSON.stringify(j));
      if (isFinal(j)) socket.close(1000, j.status);
    };
    send(job);
    if (isFinal(job)) return;
    let set = jobListeners.get(job.jobId);
    if (!set) jobListeners.set(job.jobId, (set = new Set()));
    set.add(send);
    socket.on('close', () => jobListeners.get(job.jobId)?.delete(send));
  });

  // Sends `{type:'updated', repoId, analysedAt}` whenever a (re-)analysis of the repo lands; stays open.
  app.get<{ Params: { id: string } }>('/api/v1/repos/:id/events', { websocket: true }, (socket, req) => {
    const id = req.params.id;
    const send = (e: RepoEvent) => socket.send(JSON.stringify(e));
    let set = repoListeners.get(id);
    if (!set) repoListeners.set(id, (set = new Set()));
    set.add(send);
    socket.on('close', () => repoListeners.get(id)?.delete(send));
  });

  app.get<{ Params: { id: string } }>('/api/v1/repos/:id', async (req, reply) => {
    // cold start: repo.json answers without waiting for the graph to load (large repos take seconds)
    if (!services.has(req.params.id) && /^[\w-]+$/.test(req.params.id)) {
      const info = await fs
        .readFile(path.join(repoDir(spiderHome(home), req.params.id), 'repo.json'), 'utf8')
        .then((raw) => JSON.parse(raw) as RepoInfo)
        .catch(() => undefined);
      if (info) return info;
    }
    try {
      const { info } = await getService(req.params.id, home);
      return info;
    } catch {
      return reply.code(404).send({ error: 'repo not found' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/repos/:id', async (req) => {
    dropService(req.params.id);
    watcher?.remove(req.params.id);
    await deleteRepo(req.params.id, home);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/v1/repos/:id/reanalyze', async (req, reply) => {
    const { info } = await getService(req.params.id, home).catch(() => ({ info: undefined }));
    if (!info) return reply.code(404).send({ error: 'repo not found' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/repos',
      payload: { source: info.source, name: info.name },
    });
    return res.json();
  });

  /* ---------- graph queries ---------- */
  type RepoReq = { Params: { id: string; nodeId?: string }; Querystring: Record<string, string> };

  const withService = async <T>(repoId: string, fn: (q: QueryService, info: RepoInfo) => T | Promise<T>) => {
    const { q, info } = await getService(repoId, home);
    return fn(q, info);
  };

  app.get<RepoReq>('/api/v1/repos/:id/graph', async (req, reply) => {
    const p = valid(graphQuerySchema, req.query, reply);
    if (!p) return reply;
    // cold start: answer default views from the precomputed copy while the full graph loads
    const raw = await storedView(req.params.id, p, home);
    if (raw) {
      void getService(req.params.id, home).catch(() => {});
      return reply.type('application/json').send(raw);
    }
    return withService(req.params.id, (q) =>
      p.focus && !q.node(p.focus) ? reply.code(404).send({ error: 'focus node not found' }) : q.projection(p),
    );
  });

  app.get<RepoReq>('/api/v1/repos/:id/nodes/:nodeId', async (req, reply) =>
    withService(
      req.params.id,
      (q) => q.detail(req.params.nodeId!) ?? reply.code(404).send({ error: 'node not found' }),
    ),
  );

  app.get<RepoReq>('/api/v1/repos/:id/nodes/:nodeId/source', async (req, reply) =>
    withService(req.params.id, async (q, info) => {
      const node = q.node(req.params.nodeId!);
      if (!node?.file) return reply.code(404).send({ error: 'no source for node' });
      const abs = path.resolve(info.root, node.file);
      if (!abs.startsWith(path.resolve(info.root) + path.sep)) return reply.code(403).send({ error: 'forbidden' });
      const text = await fs.readFile(abs, 'utf8').catch(() => undefined);
      if (text === undefined) return reply.code(404).send({ error: 'file missing on disk' });
      const lines = text.split('\n');
      const p = valid(sourceQuerySchema, req.query, reply);
      if (!p) return reply;
      const { context } = p;
      const startLine = node.span ? Math.max(1, node.span.startLine - context) : 1;
      const endLine = node.span ? Math.min(lines.length, node.span.endLine + context) : Math.min(lines.length, 400);
      return {
        path: node.file,
        language: node.language,
        startLine,
        endLine,
        highlight: node.span ? [node.span.startLine, node.span.endLine] : undefined,
        lines: lines.slice(startLine - 1, endLine),
        totalLines: lines.length,
      };
    }),
  );

  app.get<RepoReq>('/api/v1/repos/:id/search', async (req, reply) => {
    const p = valid(searchQuerySchema, req.query, reply);
    if (!p) return reply;
    return withService(req.params.id, (q) => q.search(p.q, p.kinds, p.limit));
  });

  const traversal = (
    route: string,
    run: (q: QueryService, id: string, depth?: number, kinds?: EdgeKind[]) => unknown,
  ) =>
    app.get<RepoReq>(`/api/v1/repos/:id/${route}/:nodeId`, async (req, reply) => {
      const p = valid(traversalQuerySchema, req.query, reply);
      if (!p) return reply;
      return withService(req.params.id, (q) => run(q, req.params.nodeId!, p.depth, p.kinds));
    });
  traversal('upstream', (q, id, depth, kinds) => q.upstream(id, depth ?? 3, kinds));
  traversal('downstream', (q, id, depth, kinds) => q.downstream(id, depth ?? 3, kinds));
  traversal('neighbors', (q, id, depth, kinds) => q.neighborhood(id, 'both', depth ?? 1, kinds));
  traversal('trace', (q, id, depth) => q.trace(id, depth ?? 6));

  app.get<RepoReq>('/api/v1/repos/:id/path', async (req, reply) => {
    const p = valid(pathQuerySchema, req.query, reply);
    if (!p) return reply;
    return withService(req.params.id, (q) => q.path(p.from, p.to, p.kinds));
  });

  app.get<RepoReq>('/api/v1/repos/:id/endpoints', async (req, reply) => {
    const p = valid(endpointsQuerySchema, req.query, reply);
    if (!p) return reply;
    return withService(req.params.id, (q) => q.endpoints(p.includeTests));
  });
  app.get<RepoReq>('/api/v1/repos/:id/diagnostics', async (req, reply) => {
    const p = valid(diagnosticsQuerySchema, req.query, reply);
    if (!p) return reply;
    return withService(req.params.id, (q) => q.diagnostics(p.type));
  });
  app.get<RepoReq>('/api/v1/repos/:id/subsystems', async (req) => withService(req.params.id, (q) => q.subsystems()));
  app.get<RepoReq>('/api/v1/repos/:id/tree', async (req, reply) => {
    const p = valid(treeQuerySchema, req.query, reply);
    if (!p) return reply;
    return withService(req.params.id, (q) => q.tree(p.node, p.depth));
  });

  app.get<RepoReq>('/api/v1/repos/:id/export', async (req, reply) => {
    const p = valid(exportQuerySchema, req.query, reply);
    if (!p) return reply;
    return withService(req.params.id, (q, info) => {
      const sg = q.g.toSubGraph();
      if (p.format === 'dot') return reply.type('text/vnd.graphviz').send(toDot(sg));
      if (p.format === 'graphml') return reply.type('application/graphml+xml').send(toGraphML(sg));
      return { info, ...sg };
    });
  });

  registerDiffRoutes(app, { home, repoInfo: async (id) => (await getService(id, home)).info });

  registerArchitectureRoutes(app, {
    home,
    withService,
    invalidate: async (repoId) => {
      dropService(repoId);
      const { info } = await getService(repoId, home);
      const event: RepoEvent = { type: 'updated', repoId, analysedAt: info.analysedAt };
      for (const listener of repoListeners.get(repoId) ?? []) listener(event);
    },
  });

  /* ---------- static web app ---------- */
  const webDir = opts.webDir ?? findWebDir();
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: true });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  }

  if (opts.watch) {
    const w = createRepoWatcher((info) => startJob(info.source, undefined, info.name).done);
    watcher = w;
    for (const info of await listRepos(home)) await w.add(info);
    app.addHook('onClose', async () => w.close());
  }

  return app;
}

export async function startServer(opts: ServerOptions = {}): Promise<{ app: FastifyInstance; url: string }> {
  const app = await createServer(opts);
  const port = opts.port ?? 4747;
  const host = opts.host ?? '127.0.0.1';
  await app.listen({ port, host });
  return { app, url: `http://${host}:${port}` };
}

export { spiderHome };
