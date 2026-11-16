import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { RepoInfo } from '@spider/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { repoDir } from '../src/analyze.js';
import { onboardingDoc, writeNarrative } from '../src/llm/onboarding.js';
import type { LlmProvider } from '../src/llm/types.js';
import { defaultTour } from '../src/query/tour.js';
import { analyzeFixture } from './helpers.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'spider-tour-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('C-27 tours and onboarding', async () => {
  const fx = await analyzeFixture('ts-express');
  const info: RepoInfo = {
    repoId: 'tour-fixture',
    name: 'ts-express',
    source: 'fixtures/ts-express',
    root: 'fixtures/ts-express',
    analysedAt: '2026-01-01T00:00:00Z',
    durationMs: 1,
    stats: {
      nodes: fx.g.nodes.size,
      edges: fx.g.edges.size,
      files: 6,
      loc: 120,
      languages: [{ language: 'typescript', files: 6, loc: 120 }],
      frameworks: ['express'],
      byNodeKind: { subsystem: 2, endpoint: 4 },
      byEdgeKind: {},
      endpointsInTests: 0,
      unresolvedImports: 0,
    } as unknown as RepoInfo['stats'],
  };

  it('walks overview → subsystems → hubs → endpoints, deterministically', () => {
    const t = defaultTour(fx.q, info);
    expect(t.steps[0]).toMatchObject({ title: 'ts-express at a glance', level: 'L1' });
    expect(t.steps[0].nodeId).toBeUndefined();
    expect(t.steps.some((s) => s.title === 'Where requests come in')).toBe(true);
    for (const s of t.steps.slice(1)) expect(fx.q.node(s.nodeId ?? '')).toBeDefined();
    expect(new Set(t.steps.map((s) => s.nodeId).filter(Boolean)).size).toBe(t.steps.length - 1);
    expect(defaultTour(fx.q, info)).toEqual(t);
  });

  it('narrates with summaries when they exist', () => {
    const sub = fx.q.subsystems()[0].node;
    const t = defaultTour(fx.q, info, { [sub.id]: { text: 'Handles HTTP routing.' } });
    expect(t.steps.find((s) => s.title === sub.name)?.text).toBe('Handles HTTP routing.');
  });

  it('caches the narrative against its input and marks it stale when the input changes', async () => {
    mkdirSync(repoDir(home, info.repoId), { recursive: true });
    let calls = 0;
    const provider: LlmProvider = {
      name: 'anthropic',
      model: 'fake',
      chat: async () => {
        calls++;
        return { content: [{ type: 'text', text: 'Ts-express is a small order API.' }], stop: 'end', model: 'fake' };
      },
    };
    expect((await onboardingDoc(fx.q, info, {}, home)).narrative).toBeUndefined();
    const r = await writeNarrative({ q: fx.q, info, summaries: {}, provider, home });
    expect(r.markdown.split('\n').slice(0, 3)).toEqual([
      '# Architecture of ts-express',
      '',
      'Ts-express is a small order API.',
    ]);
    await writeNarrative({ q: fx.q, info, summaries: {}, provider, home });
    expect(calls).toBe(1);
    const changed = await onboardingDoc(
      fx.q,
      info,
      { x: { nodeId: 'x', text: 't', hash: 'h', model: 'm', generatedAt: '' } },
      home,
    );
    expect(changed.stale).toBe(false); // unknown node ids do not change the input
    const sub = fx.q.subsystems()[0].node;
    const stale = await onboardingDoc(
      fx.q,
      info,
      { [sub.id]: { nodeId: sub.id, text: 'new', hash: 'h', model: 'm', generatedAt: '' } },
      home,
    );
    expect([stale.stale, stale.markdown.includes('small order API')]).toEqual([true, false]);
  });
});
