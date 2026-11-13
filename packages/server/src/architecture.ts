import path from 'node:path';
import {
  type QueryService,
  fileHistory,
  markdownReport,
  readOverrides,
  remoteRefs,
  writeOverrides,
} from '@spider/core';
import {
  type NodeHistory,
  type RepoInfo,
  matrixQuerySchema,
  parseQuery,
  remoteRefsQuerySchema,
  reportQuerySchema,
  subsystemOverridesSchema,
} from '@spider/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';

type RepoReq = { Params: { id: string; nodeId?: string }; Querystring: Record<string, string> };

export interface ArchitectureDeps {
  home?: string;
  withService: <T>(repoId: string, fn: (q: QueryService, info: RepoInfo) => T | Promise<T>) => Promise<T>;
  /** Drops the cached graph of a repo and tells its event subscribers it changed. */
  invalidate: (repoId: string) => Promise<void>;
}

function valid<S extends Parameters<typeof parseQuery>[0]>(schema: S, input: unknown, reply: FastifyReply) {
  const r = parseQuery(schema, input);
  if (r.ok) return r.data;
  void reply.code(400).send({ error: r.error });
  return undefined;
}

/** Phase 3 routes: overrides, history, matrix, externals, report, remote refs. */
export function registerArchitectureRoutes(app: FastifyInstance, deps: ArchitectureDeps): void {
  const { home, withService } = deps;

  app.get<RepoReq>('/api/v1/repos/:id/overrides', async (req) =>
    withService(req.params.id, () => readOverrides(req.params.id, home)),
  );

  app.put<RepoReq & { Body: unknown }>('/api/v1/repos/:id/overrides', async (req, reply) => {
    const ov = valid(subsystemOverridesSchema, req.body, reply);
    if (!ov) return reply;
    try {
      await writeOverrides(req.params.id, ov, home);
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return reply.code(404).send({ error: 'repo not found' });
      throw err;
    }
    await deps.invalidate(req.params.id);
    return { ok: true };
  });

  app.get<RepoReq>('/api/v1/repos/:id/nodes/:nodeId/history', async (req, reply) =>
    withService(req.params.id, async (q, info): Promise<NodeHistory | FastifyReply> => {
      const node = q.node(req.params.nodeId ?? '');
      if (!node) return reply.code(404).send({ error: 'node not found' });
      if (!node.file) return { commits: 0, authors: [] };
      const root = path.resolve(info.root);
      const abs = path.resolve(root, node.file);
      if (abs !== root && !abs.startsWith(root + path.sep)) return reply.code(403).send({ error: 'forbidden' });
      return fileHistory(root, path.relative(root, abs) || '.');
    }),
  );

  app.get<RepoReq>('/api/v1/repos/:id/matrix', async (req, reply) => {
    const p = valid(matrixQuerySchema, req.query, reply);
    if (!p) return reply;
    return withService(req.params.id, (q) => q.matrix(p));
  });

  app.get<RepoReq>('/api/v1/repos/:id/externals', async (req) => withService(req.params.id, (q) => q.externals()));

  app.get<RepoReq>('/api/v1/repos/:id/report', async (req, reply) => {
    const p = valid(reportQuerySchema, req.query, reply);
    if (!p) return reply;
    return withService(req.params.id, (q, info) =>
      reply.type('text/markdown; charset=utf-8').send(markdownReport(q, info)),
    );
  });

  app.get<{ Querystring: Record<string, string> }>('/api/v1/remote/refs', async (req, reply) => {
    const p = valid(remoteRefsQuerySchema, req.query, reply);
    if (!p) return reply;
    try {
      return await remoteRefs(p.source);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'failed' });
    }
  });
}
