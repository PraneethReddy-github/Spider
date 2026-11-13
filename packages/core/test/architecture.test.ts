import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Graph from 'graphology';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze, loadRepo } from '../src/analyze.js';
import { fileHistory, gitChurn } from '../src/enrich/churn.js';
import { enrich } from '../src/enrich/index.js';
import { layerize } from '../src/enrich/layers.js';
import { EMPTY_OVERRIDES, applySubsystems, inferSubsystems, matchPrevious } from '../src/enrich/subsystems.js';
import { GraphBuilder } from '../src/graph/builder.js';
import { parseLsRemote, redact, remoteRefs } from '../src/ingest/git.js';
import { readOverrides, writeOverrides } from '../src/overrides.js';
import type { Discovery } from '../src/pipeline/discover.js';
import { markdownReport } from '../src/query/report.js';
import { QueryService } from '../src/query/service.js';
import { FIXTURES, analyzeFixture } from './helpers.js';

const ALL_FIXTURES = [
  'ts-express',
  'py-fastapi',
  'ts-typed',
  'ts-barrels',
  'py-typed',
  'ts-koa',
  'ts-hono',
  'ts-nest',
  'ts-next',
  'py-flask',
  'py-django',
  'py-fastapi-routers',
];
const REPO_ROOT = path.resolve(FIXTURES, '..');

let tmp: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'spider-arch-'));
});
afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('determinism', () => {
  it('Louvain subsystems are identical across runs on an ambiguous graph', () => {
    const run = () => {
      const g = new GraphBuilder();
      const fg = new Graph({ type: 'directed' });
      const n = 120;
      const id = (i: number) => `f${i}`;
      for (let i = 0; i < n; i++) {
        g.addNode({ id: id(i), kind: 'file', name: `${i}.ts`, file: `src/m${i % 7}/${i}.ts`, language: 'typescript' });
        fg.addNode(id(i));
      }
      // a ring with long chords: many near-equal modularity optima
      for (let i = 0; i < n; i++)
        for (const k of [1, 2, 17])
          if (!fg.hasEdge(id(i), id((i + k) % n))) fg.addEdge(id(i), id((i + k) % n), { weight: 1 });
      const d = { root: '', files: [], manifests: [], frameworks: new Set<string>() } as unknown as Discovery;
      return JSON.stringify(inferSubsystems(g, fg, d));
    };
    const a = run();
    for (let i = 0; i < 5; i++) expect(run()).toBe(a);
  });

  it('enrich gives identical subsystems and metrics on identical runs', async () => {
    const snapshot = async () => {
      const { g } = await analyzeFixture('../packages/core');
      return JSON.stringify(
        [...g.nodes.values()].map((n) => [n.id, n.metrics, n.props.subsystem]).concat([[g.nodes.size, g.edges.size]]),
      );
    };
    const a = await snapshot();
    for (let i = 0; i < 2; i++) expect(await snapshot()).toBe(a);
  });
});

describe('layering', () => {
  it('condenses cycles and assigns longest-path layers', () => {
    const l = layerize(
      ['a', 'b', 'c', 'd', 'e'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'b'],
        ['c', 'd'],
        ['e', 'd'],
      ],
    );
    expect(Object.fromEntries(l)).toEqual({ a: 2, b: 1, c: 1, d: 0, e: 1 });
  });

  it('flags the upward dependency in ts-layers', async () => {
    const { en } = await analyzeFixture('ts-layers');
    const v = en.diagnostics.filter((d) => d.type === 'layer-violation');
    expect(v.map((d) => d.title)).toEqual(['src/data depends upward on src/ui']);
  });

  it.each(ALL_FIXTURES)('reports no layer violations on %s', async (fixture) => {
    const { en } = await analyzeFixture(fixture);
    expect(en.diagnostics.filter((d) => d.type === 'layer-violation')).toEqual([]);
  });
});

describe('betweenness', () => {
  it('is normalised, deterministic and highest on the connector', async () => {
    const { g } = await analyzeFixture('ts-layers');
    const bc = (p: string) => g.nodesOfKind('file').find((f) => f.file === p)?.metrics?.betweenness ?? -1;
    for (const f of g.nodesOfKind('file')) expect(bc(f.file ?? '')).toBeGreaterThanOrEqual(0);
    // index → page → format → theme: format sits on paths through the layers
    expect(bc('src/data/format.ts')).toBeGreaterThan(0);
    expect(bc('src/data/format.ts')).toBeGreaterThan(bc('src/data/store.ts'));
    expect(bc('src/index.ts')).toBe(0);
  });
});

describe('subsystems', () => {
  it('labels by directory, never by tests, with (root) for root files', async () => {
    const { q } = await analyzeFixture('ts-next');
    expect(q.subsystems().map((s) => s.node.name)).toContain('(root)');
    const { q: q2 } = await analyzeFixture('ts-layers');
    expect(q2.subsystems().map((s) => s.node.name)).toContain('src/ui');
  });

  it('seeds one subsystem per workspace package', async () => {
    const { q } = await analyzeFixture('..');
    const names = q.subsystems().map((s) => s.node.name);
    for (const p of ['packages/core', 'packages/server', 'packages/shared']) expect(names).toContain(p);
  });

  it('keeps ids stable by member overlap', async () => {
    const { g, d } = await analyzeFixture('ts-express');
    const first = enrich(g, d).subsystemGroups;
    const previous = first.map((x, i) => ({ ...x, id: `prev-${i}` }));
    const again = enrich(g, d, { previousSubsystems: previous }).subsystemGroups;
    expect(again.map((x) => x.id)).toEqual(previous.map((x) => x.id));
    // a group with no overlapping predecessor keeps a fresh id
    const groups = [{ id: 'new', label: 'x', members: ['zz'] }];
    matchPrevious(groups, previous);
    expect(groups[0].id).toBe('new');
  });

  it('applies merge, pins and rename overrides', async () => {
    const { g, en } = await analyzeFixture('ts-layers');
    const [a, b] = en.subsystemGroups;
    expect(
      applySubsystems(g, en.subsystemGroups, { rename: { [a.id]: 'Core' }, merge: [[a.id, b.id]], pins: {} }),
    ).toBe(1);
    const sub = g.getNode(a.id);
    expect(sub?.name).toBe('Core');
    expect(g.inEdges(a.id, 'member_of').length).toBe(a.members.length + b.members.length);
    expect(g.getNode(b.id)).toBeUndefined();

    applySubsystems(g, en.subsystemGroups, { ...EMPTY_OVERRIDES, pins: { 'src/index.ts': b.id } });
    const index = g.nodesOfKind('file').find((f) => f.file === 'src/index.ts');
    expect(index?.props.subsystem).toBe(b.id);
    expect(g.nodesOfKind('subsystem').length).toBe(en.subsystemGroups.length);
  });

  it('persists overrides and keeps them across re-analysis', async () => {
    const home = path.join(tmp, 'home');
    const info = await analyze({ source: path.join(FIXTURES, 'ts-layers'), home });
    expect(await readOverrides(info.repoId, home)).toEqual(EMPTY_OVERRIDES);
    const before = await loadRepo(info.repoId, home);
    const sub = before.graph.nodesOfKind('subsystem')[0];
    await writeOverrides(info.repoId, { ...EMPTY_OVERRIDES, rename: { [sub.id]: 'Renamed' } }, home);
    expect((await loadRepo(info.repoId, home)).graph.getNode(sub.id)?.name).toBe('Renamed');
    await analyze({ source: path.join(FIXTURES, 'ts-layers'), home });
    const after = await loadRepo(info.repoId, home);
    expect(after.graph.getNode(sub.id)?.name).toBe('Renamed');
    expect(
      after.graph
        .nodesOfKind('subsystem')
        .map((s) => s.id)
        .sort(),
    ).toEqual(
      before.graph
        .nodesOfKind('subsystem')
        .map((s) => s.id)
        .sort(),
    );
    await expect(writeOverrides('nope', EMPTY_OVERRIDES, home)).rejects.toThrow('repo not found');
  });
});

describe('matrix, externals, report', () => {
  it('orders matrix nodes by layer with cells from the projection', async () => {
    const { q } = await analyzeFixture('ts-layers');
    const m = q.matrix({ level: 'L2' });
    expect(m.nodes.length).toBe(m.layers.length);
    for (let k = 1; k < m.layers.length; k++) expect(m.layers[k]).toBeGreaterThanOrEqual(m.layers[k - 1]);
    const name = (i: number) => m.nodes[i].file;
    const cell = (a: string, b: string) => m.cells.find((c) => name(c.i) === a && name(c.j) === b);
    expect(cell('src/ui/page.ts', 'src/data/store.ts')?.kinds.imports).toBe(1);
    expect(m.layers[m.nodes.findIndex((n) => n.file === 'src/data/store.ts')]).toBe(0);
    expect(m.layers[m.nodes.findIndex((n) => n.file === 'src/index.ts')]).toBe(Math.max(...m.layers));
    const p = q.projection({ level: 'L2' });
    const internal = p.edges.filter((e) => q.node(e.dst)?.kind !== 'external');
    expect(m.cells.reduce((s, c) => s + c.weight, 0)).toBe(internal.reduce((s, e) => s + e.weight, 0));
  });

  it('lists externals with their non-test users', async () => {
    const { q } = await analyzeFixture('ts-express');
    const ext = q.externals();
    const express = ext.find((e) => e.node.name === 'express');
    expect(express?.users.map((u) => u.node.file)).toContain('src/index.ts');
    for (const e of ext) {
      expect(e.total).toBe(e.users.reduce((s, u) => s + u.weight, 0));
      for (const u of e.users) expect(u.node.props.isTest).toBeFalsy();
    }
    for (let i = 1; i < ext.length; i++) expect(ext[i].total).toBeLessThanOrEqual(ext[i - 1].total);
  });

  it('writes a Markdown architecture report', async () => {
    const { g, q, en } = await analyzeFixture('ts-express');
    const info = {
      repoId: 'x',
      name: 'ts-express',
      source: 'fixtures/ts-express',
      root: '',
      analysedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 0,
      stats: {
        nodes: g.nodes.size,
        edges: g.edges.size,
        files: 9,
        loc: 1,
        languages: [{ language: 'typescript', files: 9, loc: 1 }],
        frameworks: ['express'],
        byNodeKind: {},
        byEdgeKind: {},
        endpointsInTests: 0,
        unresolvedImports: 0,
        unresolvedCalls: 0,
        externalCalls: 0,
      },
    };
    const md = markdownReport(new QueryService(g, { diagnostics: en.diagnostics }), info);
    expect(md.startsWith('# Architecture of ts-express\n')).toBe(true);
    for (const h of ['## Overview', '## Subsystems', '## Layering', '## Endpoints', '## Hubs', '## Diagnostics'])
      expect(md).toContain(h);
    expect(md).toMatch(/\| GET \| `\/users\/:id` \|/);
  });
});

describe('git', () => {
  it('counts churn and history in a git repo, zeros elsewhere', async () => {
    const churn = await gitChurn(REPO_ROOT);
    expect(churn.get('packages/core/src/analyze.ts') ?? 0).toBeGreaterThan(0);
    const h = await fileHistory(REPO_ROOT, 'packages/core/src/analyze.ts');
    expect(h.commits).toBeGreaterThan(0);
    expect(h.authors.reduce((s, a) => s + a.commits, 0)).toBe(h.commits);
    for (const a of h.authors) expect(a.name).not.toContain('@');
    expect(h.lastModified).toMatch(/^\d{4}-\d\d-\d\dT/);
    const plain = await fs.mkdtemp(path.join(tmp, 'plain-'));
    expect((await gitChurn(plain)).size).toBe(0);
    expect(await fileHistory(plain, 'x.ts')).toEqual({ commits: 0, authors: [] });
  });

  it('parses ls-remote output and redacts tokens', async () => {
    const refs = parseLsRemote(
      'ref: refs/heads/main\tHEAD\nabc\tHEAD\nabc\trefs/heads/main\ndef\trefs/heads/dev\n1\trefs/tags/v1.2.0\n2\trefs/tags/v1.10.0\n3\trefs/tags/v1.10.0^{}\n',
    );
    expect(refs).toEqual({ defaultBranch: 'main', branches: ['dev', 'main'], tags: ['v1.10.0', 'v1.2.0'] });
    const old = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'ghp_secret123';
    try {
      expect(redact('fatal: https://x-access-token:ghp_secret123@github.com/a/b.git ghp_secret123')).toBe(
        'fatal: https://***@github.com/a/b.git ***',
      );
    } finally {
      if (old === undefined) Reflect.deleteProperty(process.env, 'GITHUB_TOKEN');
      else process.env.GITHUB_TOKEN = old;
    }
    await expect(remoteRefs(path.join(FIXTURES, 'ts-express'))).rejects.toThrow('not a remote');
  });
});
