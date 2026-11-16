import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AskEvent, ask } from '../src/llm/ask.js';
import { GRAPH_TOOLS, runGraphTool } from '../src/llm/tools.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../src/llm/types.js';
import { FIXTURES, analyzeFixture } from './helpers.js';

/** Plays a script: each step sees the request and returns the next response. */
class ScriptedProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model = 'scripted';
  requests: ChatRequest[] = [];
  constructor(private steps: ((req: ChatRequest) => ChatResponse)[]) {}
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone({ ...req, onText: undefined, signal: undefined }));
    const r = this.steps[this.requests.length - 1](req);
    for (const b of r.content) if (b.type === 'text') req.onText?.(b.text);
    return r;
  }
}

const lastToolResult = (req: ChatRequest) => {
  const m = req.messages.at(-1)!;
  const b = m.content[0];
  return b.type === 'tool_result' ? b : undefined;
};

describe('C-24 graph tools', async () => {
  const fx = await analyzeFixture('ts-express');
  const ctx = { q: fx.q, root: path.join(FIXTURES, 'ts-express') };
  const svc = fx.q.search('UserService', ['class'], 1)[0].node;

  it('defines strict JSON schemas', () => {
    for (const t of GRAPH_TOOLS) expect(t.inputSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(GRAPH_TOOLS.map((t) => t.name)).toContain('trace');
  });

  it('answers with node ids, and rejects bad input without throwing', async () => {
    const s = await runGraphTool(ctx, 'search', { query: 'UserService' });
    expect(s.nodeIds).toContain(svc.id);
    const up = await runGraphTool(ctx, 'upstream', { id: svc.id, depth: 2 });
    expect(JSON.parse(up.text).items.length).toBeGreaterThan(0);
    expect((await runGraphTool(ctx, 'source', { id: svc.id })).text).toContain('class UserService');
    expect(await runGraphTool(ctx, 'upstream', { id: svc.id, depth: '2' })).toMatchObject({ isError: true });
    expect(await runGraphTool(ctx, 'search', {})).toMatchObject({
      isError: true,
      text: 'invalid input: missing "query"',
    });
    expect(await runGraphTool(ctx, 'node_detail', { id: 'nope' })).toMatchObject({ isError: true });
    expect(await runGraphTool(ctx, 'drop_tables', {})).toMatchObject({ isError: true });
  });

  it('runs the loop, streams events and keeps only real, seen citations', async () => {
    const p = new ScriptedProvider([
      () => ({
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 't1', name: 'search', input: { query: 'UserService' } },
        ],
        stop: 'tool_use',
        model: 'scripted',
      }),
      (req) => {
        const hits = JSON.parse(lastToolResult(req)!.content) as { id: string }[];
        return {
          content: [
            {
              type: 'text',
              text: `It is [UserService](node:${hits[0].id}), not [Ghost](node:AAAAAAAAAAAAAAAA) or [Repo](node:repo).`,
            },
          ],
          stop: 'end',
          model: 'scripted',
        };
      },
    ]);
    const events: AskEvent[] = [];
    const r = await ask({
      ...ctx,
      provider: p,
      repoName: 'ts-express',
      question: 'Where is UserService?',
      onEvent: (e) => events.push(e),
    });
    expect(r.citations).toEqual([svc.id]);
    expect(r.answer.startsWith('It is [UserService]')).toBe(true);
    expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'tool_result', 'text', 'done']);
    // the second request carries the tool result for t1 and the full tool list
    expect(lastToolResult(p.requests[1])?.toolUseId).toBe('t1');
    expect(p.requests[1].tools?.length).toBe(GRAPH_TOOLS.length);
  });

  it('replays history and stops after maxSteps', async () => {
    const loop = () =>
      ({
        content: [{ type: 'tool_use', id: 'x', name: 'subsystems', input: {} }],
        stop: 'tool_use',
        model: 'scripted',
      }) as ChatResponse;
    const p = new ScriptedProvider([loop, loop]);
    await expect(
      ask({
        ...ctx,
        provider: p,
        repoName: 'r',
        question: 'q2',
        history: [{ question: 'q1', answer: 'a1' }],
        maxSteps: 2,
      }),
    ).rejects.toThrow(/No answer after 2 steps/);
    expect(p.requests[0].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});
