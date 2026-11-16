import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  type AskEvent,
  type EmbeddingStore,
  type QueryService,
  ask,
  configuredProvider,
  generateSummaries,
  llmConfig,
  loadEmbeddings,
  nearest,
  readSummaries,
  repoDir,
  spiderHome,
} from '@spider/core';
import {
  type LlmStatus,
  type RepoInfo,
  type SearchHit,
  askBodySchema,
  parseQuery,
  summarizeBodySchema,
} from '@spider/shared';
import type { FastifyInstance } from 'fastify';

export interface SemanticDeps {
  home?: string;
  withService: <T>(repoId: string, fn: (q: QueryService, info: RepoInfo) => T | Promise<T>) => Promise<T>;
}

type RepoReq = { Params: { id: string } };

/**
 * Phase 5 routes: provider status, summaries (C-23), ask (C-24). Model calls happen only when a provider is
 * configured. Returns the semantic search used by `GET /search?mode=semantic` (C-26).
 */
export function registerSemanticRoutes(
  app: FastifyInstance,
  deps: SemanticDeps,
): (repoId: string, p: { q: string; kinds?: string[]; limit: number }) => Promise<SearchHit[]> {
  const { home, withService } = deps;
  /** Loaded embedding stores by repo, reloaded when the file changes. */
  const stores = new Map<string, { mtimeMs: number; store?: EmbeddingStore }>();
  const embeddings = async (info: RepoInfo) => {
    const stat = await fs
      .stat(path.join(repoDir(spiderHome(home), info.repoId), 'embeddings.bin'))
      .catch(() => undefined);
    if (!stat) return undefined;
    const hit = stores.get(info.repoId);
    if (hit?.mtimeMs === stat.mtimeMs) return hit.store;
    const store = await loadEmbeddings(info.repoId, home);
    stores.set(info.repoId, { mtimeMs: stat.mtimeMs, store });
    return store;
  };

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

  // Server-sent events: `text` deltas, `tool`/`tool_result` steps, then `done` {answer, citations} or `error`.
  app.post<RepoReq & { Body: unknown }>('/api/v1/repos/:id/ask', async (req, reply) => {
    const body = parseQuery(askBodySchema, req.body);
    if (!body.ok) return reply.code(400).send({ error: body.error });
    const provider = configuredProvider(home);
    if (!provider) return reply.code(409).send({ error: 'no model provider configured (set SPIDER_LLM_PROVIDER)' });
    return withService(req.params.id, async (q, info) => {
      const summaries = await readSummaries(info.repoId, home);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        ...(reply.getHeaders() as Record<string, string>),
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
      });
      const ac = new AbortController();
      // the client went away: stop the model loop (no more billed turns)
      res.on('close', () => ac.abort());
      const send = (e: AskEvent) => {
        if (!res.writableEnded) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      try {
        await ask({
          q,
          root: info.root,
          summaries,
          provider,
          repoName: info.name,
          question: body.data.question,
          history: body.data.history,
          onEvent: send,
          signal: ac.signal,
        });
      } catch (err) {
        if (!ac.signal.aborted) send({ type: 'error', message: String((err as Error)?.message ?? err) });
      } finally {
        res.end();
      }
    });
  });

  return (repoId, p) =>
    withService(repoId, async (q, info) => {
      const summaries = await readSummaries(info.repoId, home);
      let cosine: Map<string, number> | undefined;
      const provider = configuredProvider(home);
      const store = provider?.embed ? await embeddings(info) : undefined;
      // the query is embedded only when this repo has vectors from the same model
      if (provider?.embed && store && store.model === provider.embedModel) {
        try {
          cosine = nearest(store, (await provider.embed([p.q]))[0]);
        } catch {
          // embedding endpoint down: fall back to local ranking
        }
      }
      return q.semantic(p.q, { kinds: p.kinds, limit: p.limit, summaries, cosine });
    });
}
