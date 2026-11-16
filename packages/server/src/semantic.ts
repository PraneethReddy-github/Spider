import {
  type AskEvent,
  type QueryService,
  ask,
  configuredProvider,
  generateSummaries,
  llmConfig,
  readSummaries,
} from '@spider/core';
import { type LlmStatus, type RepoInfo, askBodySchema, parseQuery, summarizeBodySchema } from '@spider/shared';
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
}
