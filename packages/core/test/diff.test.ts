import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GraphDiff } from '@spider/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { diffMarkdown, diffRevisions, localRefs } from '../src/diff/index.js';

let tmp: string;
let repo: string;
let home: string;

const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: repo }).toString();
const write = (file: string, text: string) =>
  fs
    .mkdir(path.dirname(path.join(repo, file)), { recursive: true })
    .then(() => fs.writeFile(path.join(repo, file), text));
const edges = (list: GraphDiff['edges']['added']) => list.map((e) => `${e.kind} ${e.srcLabel} -> ${e.dstLabel}`);

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spider-diff-'));
  repo = path.join(tmp, 'repo');
  home = path.join(tmp, 'home');
  await fs.mkdir(repo);
  git('init', '-q', '-b', 'main');
  await write('src/a.ts', "import { foo } from './b.js';\nexport function main() {\n  return foo();\n}\n");
  await write('src/b.ts', 'export function foo() {\n  return 1;\n}\n');
  await write('src/old.ts', "import { foo } from './b.js';\nexport function legacy() {\n  return foo();\n}\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'v1');
  git('tag', 'v1');
  // v2: a → c instead of b, c → b, b → c (new cycle), old.ts deleted
  await write('src/a.ts', "import { bar } from './c.js';\nexport function main() {\n  return bar();\n}\n");
  await write('src/c.ts', "import { foo } from './b.js';\nexport function bar() {\n  return foo() + 1;\n}\n");
  await write(
    'src/b.ts',
    "import { bar } from './c.js';\nexport function foo() {\n  return 1;\n}\nexport function baz() {\n  return bar();\n}\n",
  );
  await fs.rm(path.join(repo, 'src/old.ts'));
  git('add', '-A');
  git('commit', '-q', '-m', 'v2');
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('graph diff between two commits', () => {
  it('reports exact added and removed relationship edges', async () => {
    const d = await diffRevisions({ root: repo, base: 'v1', head: 'HEAD', home });
    expect(edges(d.edges.added)).toEqual([
      'calls src/a.ts::main -> src/c.ts::bar',
      'calls src/b.ts::baz -> src/c.ts::bar',
      'calls src/c.ts::bar -> src/b.ts::foo',
      'imports src/a.ts -> src/c.ts',
      'imports src/b.ts -> src/c.ts',
      'imports src/c.ts -> src/b.ts',
    ]);
    expect(edges(d.edges.removed)).toEqual([
      'calls src/a.ts::main -> src/b.ts::foo',
      'calls src/old.ts::legacy -> src/b.ts::foo',
      'imports src/a.ts -> src/b.ts',
      'imports src/old.ts -> src/b.ts',
    ]);
    expect(d.nodes.added.map((n) => n.qname ?? n.name)).toEqual(['src/b.ts::baz', 'src/c.ts', 'src/c.ts::bar']);
    expect(d.nodes.removed.map((n) => n.qname ?? n.name)).toEqual(['src/old.ts', 'src/old.ts::legacy']);
    expect(d.nodes.changed.find((n) => n.file === 'src/b.ts' && n.kind === 'file')?.changes['metrics.loc']).toEqual([
      3, 7,
    ]);
    expect(d.summary).toMatchObject({ filesAdded: 1, filesRemoved: 1, newCycles: 1, resolvedCycles: 0 });
    expect(d.base.commit).toMatch(/^[0-9a-f]{40}$/);
    // every referenced node has a containment chain ending at the repo node
    for (const e of d.edges.added) expect(d.ancestors[e.src].at(-1)).toBe('repo');
    const md = diffMarkdown(d);
    expect(md).toContain('## Spider graph diff: `v1`');
    expect(md).toContain('New cycle:');
    expect(md).toContain('- imports `src/a.ts` → `src/c.ts`');
  });

  it('diffs the working tree by default and leaves no temporary files', async () => {
    await write('src/d.ts', "import { foo } from './b.js';\nexport const d = foo();\n");
    const d = await diffRevisions({ root: repo, base: 'HEAD', home });
    expect(d.head.ref).toBe('working tree');
    expect(edges(d.edges.added)).toContain('imports src/d.ts -> src/b.ts');
    expect(d.edges.removed).toEqual([]);
    expect(await fs.readdir(path.join(home, 'tmp'))).toEqual([]);
    expect(git('status', '--porcelain')).toBe('?? src/d.ts\n');
  });

  it('rejects unknown and option-like refs, lists local refs', async () => {
    await expect(diffRevisions({ root: repo, base: 'nope', home })).rejects.toMatchObject({ statusCode: 400 });
    await expect(diffRevisions({ root: repo, base: '--output=x', home })).rejects.toMatchObject({ statusCode: 400 });
    expect(await localRefs(repo)).toEqual({ defaultBranch: 'main', branches: ['main'], tags: ['v1'] });
  });
});
