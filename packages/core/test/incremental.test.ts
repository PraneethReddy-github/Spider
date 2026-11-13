import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ProgressEvent, analyze } from '../src/analyze.js';
import { discover } from '../src/pipeline/discover.js';
import { extractAllWithStats } from '../src/pipeline/extract.js';
import { watchTree } from '../src/pipeline/watch.js';
import { FIXTURES } from './helpers.js';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/index.js');
const factsJson = (m: Map<string, unknown>) => JSON.stringify([...m]);

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spider-incr-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function copyFixture(name: string) {
  const dir = path.join(tmp, `${name}-${Math.random().toString(36).slice(2)}`);
  await fs.cp(path.join(FIXTURES, name), dir, { recursive: true });
  return dir;
}

// Workers need the built entry (dist/pipeline/extract-worker.js); vitest runs sources, so both sides of the
// comparison use dist to test exactly one extractor build.
describe.skipIf(!existsSync(DIST))('worker pool (dist build)', () => {
  for (const fixture of ['ts-express', 'py-fastapi']) {
    it(`${fixture}: worker facts are identical to in-process facts, in the same order`, async () => {
      const core = (await import(DIST)) as { extractAllWithStats: typeof extractAllWithStats };
      const d = await discover(path.join(FIXTURES, fixture));
      const inProc = await core.extractAllWithStats(d.files, { frameworks: d.frameworks, workers: 0 });
      const pooled = await core.extractAllWithStats(d.files, { frameworks: d.frameworks, workers: 2 });
      expect(inProc.stats.workers).toBe(0);
      expect(pooled.stats.workers).toBe(2);
      expect(pooled.stats.extracted).toBe(inProc.stats.files);
      expect(factsJson(pooled.facts)).toBe(factsJson(inProc.facts));
    });
  }
});

describe('incremental re-analysis', () => {
  it('reuses cached facts for unchanged files and re-extracts only changed ones', async () => {
    const root = await copyFixture('ts-express');
    const cacheDir = path.join(tmp, 'cache-a');
    const d = await discover(root);
    const first = await extractAllWithStats(d.files, { frameworks: d.frameworks, cacheDir });
    expect(first.stats).toMatchObject({ reused: 0, extracted: first.stats.files });
    await new Promise((r) => setTimeout(r, 50)); // cache writes are fire-and-forget

    const second = await extractAllWithStats(d.files, { frameworks: d.frameworks, cacheDir });
    expect(second.stats).toMatchObject({ reused: first.stats.files, extracted: 0 });
    expect(factsJson(second.facts)).toBe(factsJson(first.facts));

    const changed = d.files.find((f) => f.language === 'typescript');
    if (!changed) throw new Error('fixture has no typescript file');
    await fs.appendFile(changed.abs, '\nexport function addedLater() {}\n');
    const third = await extractAllWithStats(d.files, { frameworks: d.frameworks, cacheDir });
    expect(third.stats).toMatchObject({ reused: first.stats.files - 1, extracted: 1 });
    expect(third.facts.get(changed.path)?.decls.some((x) => x.name === 'addedLater')).toBe(true);
  });

  it('analyze() reports reused vs re-extracted counts on a second run', async () => {
    const root = await copyFixture('py-fastapi');
    const home = path.join(tmp, 'home');
    const parseMessages = async () => {
      const events: ProgressEvent[] = [];
      await analyze({ source: root, home, onProgress: (e) => events.push(e) });
      return events.filter((e) => e.stage === 'parse' && e.current === e.total).map((e) => e.message);
    };
    const [first] = await parseMessages();
    expect(first).toMatch(/^0 reused, \d+ re-extracted/);
    await new Promise((r) => setTimeout(r, 50));
    const [second] = await parseMessages();
    expect(second).toMatch(/^\d+ reused, 0 re-extracted$/);
  });
});

describe('watchTree', () => {
  it('fires once, debounced, after a burst of edits', async () => {
    const root = await copyFixture('ts-express');
    let calls = 0;
    const w = await watchTree(root, () => calls++, 100);
    try {
      const d = await discover(root);
      for (const f of d.files.slice(0, 3)) await fs.appendFile(f.abs, '\n// edit\n');
      await new Promise((r) => setTimeout(r, 400));
      expect(calls).toBe(1);
    } finally {
      w.close();
    }
  });
});
