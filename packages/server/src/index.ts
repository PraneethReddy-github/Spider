import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { QueryService, analyze, deleteRepo, listRepos, loadRepo, spiderHome } from '@spider/core';
import type { EdgeKind, JobProgress, NodeKind, RepoInfo, ViewLevel } from '@spider/shared';
import Fastify, { type FastifyInstance } from 'fastify';

export interface ServerOptions {
  port?: number;
  host?: string;
  home?: string;
  /** Directory with the built web app (index.html). */
  webDir?: string;
  logger?: boolean;
}

const jobs = new Map<string, JobProgress>();
const services = new Map<string, Promise<{ q: QueryService; info: RepoInfo }>>();

async function getService(repoId: string, home?: string) {
  let p = services.get(repoId);
  if (!p) {
    p = loadRepo(repoId, home).then(({ graph, meta, info }) => ({ q: new QueryService(graph, meta), info }));
    services.set(repoId, p);
    p.catch(() => services.delete(repoId));
  }
  return p;
}

function csv<T extends string>(v: unknown): T[] | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  return v.split(',').filter(Boolean) as T[];
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
  const home = opts.home;

  app.get('/api/v1/health', async () => ({ ok: true }));

  /* ---------- repos & jobs ---------- */
  app.get('/api/v1/repos', async () => listRepos(home));

  app.post<{ Body: { source: string; ref?: string; name?: string } }>('/api/v1/repos', async (req, reply) => {
    const { source, ref, name } = req.body ?? {};
    if (!source) return reply.code(400).send({ error: 'source is required' });
    const jobId = randomUUID();
    const job: JobProgress = { jobId, status: 'queued', stage: 'ingest', current: 0, total: 0, log: [] };
    jobs.set(jobId, job);
    void analyze({
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
      },
    })
      .then((info) => {
        job.status = 'done';
        job.repoId = info.repoId;
        services.delete(info.repoId);
      })
      .catch((err) => {
        job.status = 'failed';
        job.error = String(err?.message ?? err);
      });
    return { jobId };
  });

  app.get<{ Params: { id: string } }>('/api/v1/jobs/:id', async (req, reply) => {
    const job = jobs.get(req.params.id);
    if (!job) return reply.code(404).send({ error: 'job not found' });
    return job;
  });

  app.get<{ Params: { id: string } }>('/api/v1/repos/:id', async (req, reply) => {
    try {
      const { info } = await getService(req.params.id, home);
      return info;
    } catch {
      return reply.code(404).send({ error: 'repo not found' });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/v1/repos/:id', async (req) => {
    services.delete(req.params.id);
    await deleteRepo(req.params.id, home);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/v1/repos/:id/reanalyze', async (req, reply) => {
    const { info } = await getService(req.params.id, home).catch(() => ({ info: undefined }));
    if (!info) return reply.code(404).send({ error: 'repo not found' });
    const res = await app.inject({ method: 'POST', url: '/api/v1/repos', payload: { source: info.source, name: info.name } });
    return res.json();
  });

  /* ---------- graph queries ---------- */
  type RepoReq = { Params: { id: string; nodeId?: string }; Querystring: Record<string, string> };

  const withService = async <T>(repoId: string, fn: (q: QueryService, info: RepoInfo) => T | Promise<T>) => {
    const { q, info } = await getService(repoId, home);
    return fn(q, info);
  };

  app.get<RepoReq>('/api/v1/repos/:id/graph', async (req) =>
    withService(req.params.id, (q) =>
      q.projection({
        level: ((req.query.level as ViewLevel) || 'L1') as ViewLevel,
        expanded: csv(req.query.expanded),
        edgeKinds: csv<EdgeKind>(req.query.edgeKinds),
        nodeKinds: csv<NodeKind>(req.query.nodeKinds),
        languages: csv(req.query.languages),
        includeTests: req.query.includeTests === 'true',
        minConfidence: req.query.minConfidence ? Number(req.query.minConfidence) : undefined,
        minWeight: req.query.minWeight ? Number(req.query.minWeight) : undefined,
      }),
    ),
  );

  app.get<RepoReq>('/api/v1/repos/:id/nodes/:nodeId', async (req, reply) =>
    withService(req.params.id, (q) => q.detail(req.params.nodeId!) ?? reply.code(404).send({ error: 'node not found' })),
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
      const context = Number(req.query.context ?? 5);
      const startLine = node.span ? Math.max(1, node.span.startLine - context) : 1;
      const endLine = node.span ? Math.min(lines.length, node.span.endLine + context) : Math.min(lines.length, 400);
      return { path: node.file, language: node.language, startLine, endLine, highlight: node.span ? [node.span.startLine, node.span.endLine] : undefined, lines: lines.slice(startLine - 1, endLine), totalLines: lines.length };
    }),
  );

  app.get<RepoReq>('/api/v1/repos/:id/search', async (req) =>
    withService(req.params.id, (q) => q.search(req.query.q ?? '', csv(req.query.kinds), req.query.limit ? Number(req.query.limit) : 25)),
  );

  app.get<RepoReq>('/api/v1/repos/:id/upstream/:nodeId', async (req) =>
    withService(req.params.id, (q) => q.upstream(req.params.nodeId!, Number(req.query.depth ?? 3), csv<EdgeKind>(req.query.kinds))),
  );

  app.get<RepoReq>('/api/v1/repos/:id/downstream/:nodeId', async (req) =>
    withService(req.params.id, (q) => q.downstream(req.params.nodeId!, Number(req.query.depth ?? 3), csv<EdgeKind>(req.query.kinds))),
  );

  app.get<RepoReq>('/api/v1/repos/:id/neighbors/:nodeId', async (req) =>
    withService(req.params.id, (q) => q.neighborhood(req.params.nodeId!, 'both', Number(req.query.depth ?? 1), csv<EdgeKind>(req.query.kinds))),
  );

  app.get<RepoReq>('/api/v1/repos/:id/path', async (req, reply) => {
    if (!req.query.from || !req.query.to) return reply.code(400).send({ error: 'from and to are required' });
    return withService(req.params.id, (q) => q.path(req.query.from, req.query.to, csv<EdgeKind>(req.query.kinds)));
  });

  app.get<RepoReq>('/api/v1/repos/:id/endpoints', async (req) => withService(req.params.id, (q) => q.endpoints(req.query.includeTests === 'true')));
  app.get<RepoReq>('/api/v1/repos/:id/trace/:nodeId', async (req) => withService(req.params.id, (q) => q.trace(req.params.nodeId!, Number(req.query.depth ?? 6))));
  app.get<RepoReq>('/api/v1/repos/:id/diagnostics', async (req) => withService(req.params.id, (q) => q.diagnostics(req.query.type)));
  app.get<RepoReq>('/api/v1/repos/:id/subsystems', async (req) => withService(req.params.id, (q) => q.subsystems()));
  app.get<RepoReq>('/api/v1/repos/:id/tree', async (req) => withService(req.params.id, (q) => q.tree(req.query.node ?? 'repo', Number(req.query.depth ?? 1))));

  app.get<RepoReq>('/api/v1/repos/:id/export', async (req, reply) =>
    withService(req.params.id, (q, info) => {
      const format = req.query.format ?? 'json';
      const sg = q.g.toSubGraph();
      if (format === 'json') return { info, ...sg };
      if (format === 'dot') {
        const esc = (s: string) => s.replace(/"/g, '\\"');
        const lines = ['digraph spider {', '  rankdir=LR;', '  node [shape=box, fontname="Helvetica"];'];
        for (const n of sg.nodes) lines.push(`  "${n.id}" [label="${esc(n.name)}", kind="${n.kind}"];`);
        for (const e of sg.edges) if (e.kind !== 'contains' && e.kind !== 'member_of') lines.push(`  "${e.src}" -> "${e.dst}" [label="${e.kind}"];`);
        lines.push('}');
        reply.type('text/vnd.graphviz');
        return lines.join('\n');
      }
      return reply.code(400).send({ error: `unknown format ${format}` });
    }),
  );

  /* ---------- static web app ---------- */
  const webDir = opts.webDir ?? findWebDir();
  if (webDir) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler(async (req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
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
