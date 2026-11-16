import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { repoDir } from '../src/analyze.js';
import { buildEmbeddings, loadEmbeddings, nearest } from '../src/llm/embeddings.js';
import type { LlmProvider } from '../src/llm/types.js';
import { Bm25Index, tokenize } from '../src/query/semantic.js';
import { analyzeFixture } from './helpers.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'spider-sem-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('C-26 BM25', () => {
  it('splits identifiers and stems lightly', () => {
    expect(tokenize('getUserById HTTPServer user_service.py caching orders')).toEqual([
      'get',
      'user',
      'id',
      'http',
      'server',
      'user',
      'service',
      'py',
      'cach',
      'order',
    ]);
  });

  it('ranks rarer, denser matches first', () => {
    const ix = new Bm25Index([
      { id: 'a', text: 'order order order service' },
      { id: 'b', text: 'payment gateway charges cards for orders' },
      { id: 'c', text: 'logger' },
    ]);
    expect(ix.search('charge a card').map((h) => h.id)).toEqual(['b']);
    expect(ix.search('orders').map((h) => h.id)).toEqual(['a', 'b']);
    expect(ix.search('nothing here')).toEqual([]);
  });
});

describe('C-26 semantic search on a fixture', async () => {
  const fx = await analyzeFixture('ts-express');
  const svc = fx.q.search('UserService', ['class'], 1)[0].node;

  it('finds a node by words in its summary that its name lacks', () => {
    expect(fx.q.semantic('account lookup').find((h) => h.node.id === svc.id)).toBeUndefined();
    const summaries = { [svc.id]: { text: 'Looks up customer accounts in Postgres.', generatedAt: '2026-01-01' } };
    const hits = fx.q.semantic('account lookup', { summaries });
    expect(hits[0].node.id).toBe(svc.id);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('keeps name matches and honours kinds', () => {
    const hits = fx.q.semantic('order controller', { kinds: ['class'] });
    expect(hits[0].node.name).toBe('OrderController');
    expect(hits.every((h) => h.node.kind === 'class')).toBe(true);
  });

  it('lets embeddings pull in a node with no lexical overlap', () => {
    const other = fx.q.search('OrderController', ['class'], 1)[0].node;
    const cosine = new Map([[other.id, 0.95]]);
    expect(fx.q.semantic('purchase flow', { cosine })[0].node.id).toBe(other.id);
  });

  it('builds, reuses and queries embeddings', async () => {
    const repoId = 'sem-fixture';
    mkdirSync(repoDir(home, repoId), { recursive: true });
    let calls = 0;
    const provider: LlmProvider = {
      name: 'openai',
      model: 'chat',
      embedModel: 'emb-1',
      chat: async () => {
        throw new Error('unused');
      },
      // 3-d toy vectors: [mentions user, mentions order, 1]
      embed: async (texts) => {
        calls += texts.length;
        return texts.map((t) => [/user/i.test(t) ? 1 : 0, /order/i.test(t) ? 1 : 0, 0.1]);
      },
    };
    const first = await buildEmbeddings({ repoId, g: fx.g, provider, home, batch: 5 });
    expect(first.embedded).toBe(first.total);
    expect(calls).toBe(first.total);
    const again = await buildEmbeddings({ repoId, g: fx.g, provider, home });
    expect([again.embedded, again.reused]).toEqual([0, first.total]);
    expect(calls).toBe(first.total);

    const store = await loadEmbeddings(repoId, home);
    expect(store?.dim).toBe(3);
    const near = nearest(store!, [1, 0, 0], 3);
    expect([...near.keys()].map((id) => fx.g.getNode(id)?.name).join(' ')).toMatch(/user/i);
  });
});
