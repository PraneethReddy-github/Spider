import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { repoDir } from '../src/analyze.js';
import { createProvider, llmConfig } from '../src/llm/config.js';
import { generateSummaries, readSummaries, summaryTargets } from '../src/llm/summaries.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../src/llm/types.js';
import { FIXTURES, analyzeFixture } from './helpers.js';

/** Echoes the first line of its input; records every prompt. */
class FakeProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model = 'fake-1';
  prompts: string[] = [];
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const text = req.messages[0].content[0].type === 'text' ? req.messages[0].content[0].text : '';
    this.prompts.push(text);
    return { content: [{ type: 'text', text: `About ${text.split('\n')[0]}.` }], stop: 'end', model: this.model };
  }
}

const home = mkdtempSync(path.join(os.tmpdir(), 'spider-llm-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('C-23 provider config', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('is off unless a provider is named', () => {
    Reflect.deleteProperty(process.env, 'SPIDER_LLM_PROVIDER');
    expect(llmConfig(home)).toBeUndefined();
    process.env.SPIDER_LLM_PROVIDER = 'none';
    expect(llmConfig(home)).toBeUndefined();
  });

  it('reads config.json and lets env override it', () => {
    Reflect.deleteProperty(process.env, 'SPIDER_LLM_PROVIDER');
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ llm: { provider: 'ollama', model: 'qwen3' } }));
    expect(llmConfig(home)).toEqual({ provider: 'ollama', model: 'qwen3', baseUrl: undefined });
    process.env.SPIDER_LLM_MODEL = 'llama4';
    expect(llmConfig(home)?.model).toBe('llama4');
    expect(createProvider(llmConfig(home))?.name).toBe('openai');
    process.env.SPIDER_LLM_PROVIDER = 'anthropic';
    Reflect.deleteProperty(process.env, 'SPIDER_LLM_MODEL');
    rmSync(path.join(home, 'config.json'));
    const p = createProvider(llmConfig(home));
    expect([p?.name, p?.model]).toEqual(['anthropic', 'claude-opus-5-5']);
    process.env.SPIDER_LLM_PROVIDER = 'gpt';
    expect(() => llmConfig(home)).toThrow(/unknown/);
  });
});

describe('C-23 summaries', async () => {
  const fx = await analyzeFixture('ts-express');
  const repoId = 'fixture-ts-express';
  mkdirSync(repoDir(home, repoId), { recursive: true });
  const root = path.join(FIXTURES, 'ts-express');

  it('targets hubs, packages and subsystems, never tests', () => {
    const t = summaryTargets(fx.g, 4);
    expect(t.some((n) => n.kind === 'subsystem')).toBe(true);
    expect(t.every((n) => !n.props.isTest)).toBe(true);
    expect(t.filter((n) => n.kind === 'file' || n.kind === 'class').length).toBeLessThanOrEqual(4);
  });

  it('summarises leaves before groups and reuses unchanged inputs', async () => {
    const p = new FakeProvider();
    const first = await generateSummaries({ repoId, g: fx.g, root, provider: p, home, limit: 4 });
    expect(first.failed).toEqual([]);
    expect(first.generated).toBe(p.prompts.length);
    // a subsystem prompt lists its members with their summaries
    const sub = p.prompts.find((x) => x.startsWith('subsystem:'));
    expect(sub).toMatch(/: About (file|class): /);
    // leaf prompts carry the source
    expect(p.prompts.find((x) => x.startsWith('file:'))).toMatch(/\nsource:\n/);

    const stored = await readSummaries(repoId, home);
    expect(Object.keys(stored).length).toBe(first.generated);

    const p2 = new FakeProvider();
    const second = await generateSummaries({ repoId, g: fx.g, root, provider: p2, home, limit: 4 });
    expect([second.generated, second.reused, p2.prompts.length]).toEqual([0, first.generated, 0]);

    const forced = await generateSummaries({ repoId, g: fx.g, root, provider: p2, home, limit: 4, force: true });
    expect(forced.generated).toBe(first.generated);
  });

  it('records provider failures per node without losing the rest', async () => {
    const bad: LlmProvider = {
      name: 'openai',
      model: 'broken',
      chat: async () => {
        throw new Error('HTTP 500');
      },
    };
    const target = summaryTargets(fx.g, 1)[0];
    const r = await generateSummaries({ repoId, g: fx.g, root, provider: bad, home, nodeIds: [target.id] });
    expect(r.failed).toEqual([{ nodeId: target.id, error: 'HTTP 500' }]);
    expect((await readSummaries(repoId, home))[target.id]?.model).toBe('fake-1');
  });
});
