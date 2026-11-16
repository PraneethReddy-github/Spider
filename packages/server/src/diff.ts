import { diffRevisions, isGitRoot, isGitUrl, localRefs, readOverrides } from '@spider/core';
import { type RepoInfo, diffQuerySchema, parseQuery } from '@spider/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';

/** A diff analyses one or two extra revisions; past this the request answers 504 (the work still finishes). */
export const DIFF_TIMEOUT_MS = 120_000;

export interface DiffDeps {
  home?: string;
  repoInfo: (repoId: string) => Promise<RepoInfo>;
}

type RepoReq = { Params: { id: string }; Querystring: Record<string, string> };

/** Local git work tree of a registered repo, or a 400/404 reply. */
async function gitRoot(deps: DiffDeps, repoId: string, reply: FastifyReply): Promise<string | undefined> {
  const info = await deps.repoInfo(repoId).catch(() => undefined);
  if (!info) {
    void reply.code(404).send({ error: 'repo not found' });
    return undefined;
  }
  if (isGitUrl(info.source) || !(await isGitRoot(info.root))) {
    void reply.code(400).send({ error: 'diff needs a local git repository' });
    return undefined;
  }
  return info.root;
}

/** `GET /repos/:id/diff?base=&head=` (synchronous, bounded) and `GET /repos/:id/refs`. */
export function registerDiffRoutes(app: FastifyInstance, deps: DiffDeps): void {
  app.get<RepoReq>('/api/v1/repos/:id/diff', async (req, reply) => {
    const p = parseQuery(diffQuerySchema, req.query);
    if (!p.ok) return reply.code(400).send({ error: p.error });
    const root = await gitRoot(deps, req.params.id, reply);
    if (!root) return reply;
    const work = diffRevisions({
      root,
      base: p.data.base,
      head: p.data.head,
      home: deps.home,
      overrides: await readOverrides(req.params.id, deps.home),
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error('diff timed out'), { statusCode: 504 })),
        DIFF_TIMEOUT_MS,
      );
    });
    work.catch(() => {}); // a late failure after a timeout must not become an unhandled rejection
    try {
      return await Promise.race([work, timeout]);
    } catch (err) {
      const e = err as { statusCode?: number; message?: string };
      return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'diff failed' });
    } finally {
      clearTimeout(timer);
    }
  });

  app.get<RepoReq>('/api/v1/repos/:id/refs', async (req, reply) => {
    const root = await gitRoot(deps, req.params.id, reply);
    if (!root) return reply;
    return localRefs(root);
  });
}
