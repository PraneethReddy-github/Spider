import { type QueryService, configuredProvider, generateSummaries, llmConfig, readSummaries } from '@spider/core';
import { type LlmStatus, type RepoInfo, parseQuery, summarizeBodySchema } from '@spider/shared';
import type { FastifyInstance } from 'fastify';

export interface SemanticDeps {
  home?: string;
  withService: <T>(repoId: string, fn: (q: QueryService, info: RepoInfo) => T | Promise<T>) => Promise<T>;
}

type RepoReq = { Params: { id: string } };

/** Phase 5 routes: provider status, summaries (C-23). Model calls happen only when a provider is configured. */
export function registerSemanticRoutes(app: FastifyInstance, deps: SemanticDeps): void {
  const { home, withService } = deps;

  app.get('/api/v1/llm', async (): Promise<LlmStatus> => {
    const cfg = llmConfig(home);
    if (!cfg) return { provider: null };
    return { provider: cfg.provider, model: configuredProvider(home)?.model };
  });

  app.get<RepoReq>('/api/v1/repos/:id/summaries', async (req) =>
    withService(req.params.id, () => readSummaries(req.params.id, home)),
  );

  app.post<RepoReq & { Body: unknown }>('/api/v1/repos/:id/summaries', async (req, reply) => {
    const body = parseQuery(summarizeBodySchema, req.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    const provider = configuredProvider(home);
    if (!provider) return reply.code(409).send({ error: 'no model provider configured (set SPIDER_LLM_PROVIDER)' });
    return withService(req.params.id, async (q, info) => {
      const r = await generateSummaries({ repoId: info.repoId, g: q.g, root: info.root, provider, home, ...body.data });
      return { generated: r.generated, reused: r.reused, failed: r.failed, summaries: r.summaries };
    });
  });
}
