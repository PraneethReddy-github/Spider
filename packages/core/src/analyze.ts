import { createHash } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { EdgeKind, NodeKind, RepoInfo, RepoStats } from '@spider/shared';
import { simpleGit } from 'simple-git';
import { enrich } from './enrich/index.js';
import { GraphBuilder } from './graph/builder.js';
import { discover, emitStructure } from './pipeline/discover.js';
import { extractAll } from './pipeline/extract.js';
import { resolve } from './pipeline/resolve.js';
import { SqliteStore } from './store/sqlite.js';

export interface ProgressEvent {
  stage: 'ingest' | 'discover' | 'parse' | 'resolve' | 'enrich' | 'persist' | 'done';
  current: number;
  total: number;
  message?: string;
}

export interface AnalyzeOptions {
  /** Local path or git URL. */
  source: string;
  ref?: string;
  /** Where Spider keeps repos, clones and caches. Defaults to ~/.spider */
  home?: string;
  name?: string;
  onProgress?: (e: ProgressEvent) => void;
}

export function spiderHome(home?: string): string {
  return home ?? process.env.SPIDER_HOME ?? path.join(os.homedir(), '.spider');
}

export function repoIdFor(source: string): string {
  return createHash('sha1').update(path.resolve(source)).digest('hex').slice(0, 12);
}

export function repoDir(home: string, repoId: string): string {
  return path.join(home, 'repos', repoId);
}

function isGitUrl(s: string): boolean {
  if (existsSync(path.resolve(s))) return false; // `fixtures/x` is a local dir, not owner/repo
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s);
}

export async function analyze(opts: AnalyzeOptions): Promise<RepoInfo> {
  const started = Date.now();
  const home = spiderHome(opts.home);
  const progress = opts.onProgress ?? (() => {});

  /* ---------- ingest ---------- */
  progress({ stage: 'ingest', current: 0, total: 1, message: opts.source });
  let root: string;
  let source = opts.source;
  let commit: string | undefined;
  let branch: string | undefined;
  if (isGitUrl(opts.source)) {
    const url = /^[\w.-]+\/[\w.-]+$/.test(opts.source) ? `https://github.com/${opts.source}.git` : opts.source;
    source = url;
    const id = createHash('sha1').update(url).digest('hex').slice(0, 12);
    root = path.join(home, 'clones', id);
    const exists = await fs
      .stat(path.join(root, '.git'))
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      await fs.mkdir(path.dirname(root), { recursive: true });
      progress({ stage: 'ingest', current: 0, total: 1, message: `cloning ${url}` });
      await simpleGit().clone(url, root, ['--depth', '1', ...(opts.ref ? ['--branch', opts.ref] : [])]);
    } else {
      progress({ stage: 'ingest', current: 0, total: 1, message: `updating ${url}` });
      try {
        await simpleGit(root).fetch(['--depth', '1']);
        await simpleGit(root).reset(['--hard', 'FETCH_HEAD']);
      } catch {
        /* offline is fine */
      }
    }
  } else {
    root = path.resolve(opts.source);
  }
  try {
    const git = simpleGit(root);
    commit = (await git.revparse(['HEAD'])).trim();
    branch = (await git.revparse(['--abbrev-ref', 'HEAD'])).trim();
  } catch {
    /* not a git repo */
  }
  progress({ stage: 'ingest', current: 1, total: 1 });

  const repoId = repoIdFor(source);
  const name = opts.name ?? path.basename(source.replace(/\.git$/, '').replace(/\/$/, ''));

  /* ---------- discover ---------- */
  progress({ stage: 'discover', current: 0, total: 0 });
  const d = await discover(root, (n) => progress({ stage: 'discover', current: n, total: 0, message: `${n} files` }));
  progress({
    stage: 'discover',
    current: d.files.length,
    total: d.files.length,
    message: `${d.files.length} files, frameworks: ${[...d.frameworks].join(', ') || 'none'}`,
  });
  const g = new GraphBuilder();
  emitStructure(g, d, name);

  /* ---------- parse + extract ---------- */
  const facts = await extractAll(d.files, {
    cacheDir: path.join(home, 'cache'),
    frameworks: d.frameworks,
    onProgress: (done, total, file) => progress({ stage: 'parse', current: done, total, message: file }),
  });

  /* ---------- resolve ---------- */
  progress({ stage: 'resolve', current: 0, total: 1 });
  const rs = resolve(g, d, facts);
  progress({
    stage: 'resolve',
    current: 1,
    total: 1,
    message: `${rs.resolvedImports} imports, ${rs.resolvedCalls} calls resolved`,
  });

  /* ---------- enrich ---------- */
  progress({ stage: 'enrich', current: 0, total: 1 });
  const en = enrich(g, d);
  progress({
    stage: 'enrich',
    current: 1,
    total: 1,
    message: `${en.subsystems} subsystems, ${en.diagnostics.length} diagnostics`,
  });

  /* ---------- stats & persist ---------- */
  const stats = computeStats(g, d, rs);
  const info: RepoInfo = {
    repoId,
    name,
    source,
    root,
    commit,
    branch,
    analysedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    stats,
  };
  progress({ stage: 'persist', current: 0, total: 1 });
  const dir = repoDir(home, repoId);
  const store = await SqliteStore.open(path.join(dir, 'graph.db'));
  store.saveGraph(g, { info, diagnostics: en.diagnostics });
  store.close();
  await fs.writeFile(path.join(dir, 'repo.json'), JSON.stringify(info, null, 2));
  info.durationMs = Date.now() - started;
  progress({
    stage: 'done',
    current: 1,
    total: 1,
    message: `${stats.nodes} nodes, ${stats.edges} edges in ${(info.durationMs / 1000).toFixed(1)}s`,
  });
  return info;
}

function computeStats(
  g: GraphBuilder,
  d: Awaited<ReturnType<typeof discover>>,
  rs: ReturnType<typeof resolve>,
): RepoStats {
  const byNodeKind: Partial<Record<NodeKind, number>> = {};
  const byEdgeKind: Partial<Record<EdgeKind, number>> = {};
  let endpointsInTests = 0;
  for (const n of g.nodes.values()) {
    if (n.kind === 'endpoint' && n.props.isTest) endpointsInTests++;
    else byNodeKind[n.kind] = (byNodeKind[n.kind] ?? 0) + 1;
  }
  for (const e of g.edges.values()) byEdgeKind[e.kind] = (byEdgeKind[e.kind] ?? 0) + 1;
  const langMap = new Map<string, { files: number; loc: number }>();
  let loc = 0;
  for (const f of g.nodesOfKind('file')) {
    const l = f.language ?? 'other';
    const cur = langMap.get(l) ?? { files: 0, loc: 0 };
    cur.files++;
    cur.loc += (f.props.loc as number) ?? 0;
    loc += (f.props.loc as number) ?? 0;
    langMap.set(l, cur);
  }
  return {
    nodes: g.nodes.size,
    edges: g.edges.size,
    files: d.files.length,
    loc,
    languages: [...langMap.entries()].map(([language, v]) => ({ language, ...v })).sort((a, b) => b.files - a.files),
    frameworks: [...d.frameworks],
    byNodeKind,
    byEdgeKind,
    unresolvedImports: rs.unresolvedImports,
    unresolvedCalls: rs.unresolvedCalls,
    externalCalls: rs.externalCalls,
    endpointsInTests,
  };
}

/* ---------- registry ---------- */

export async function listRepos(home?: string): Promise<RepoInfo[]> {
  const dir = path.join(spiderHome(home), 'repos');
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: RepoInfo[] = [];
  for (const e of entries) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, e, 'repo.json'), 'utf8')));
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.analysedAt.localeCompare(a.analysedAt));
}

export async function loadRepo(repoId: string, home?: string) {
  const dir = repoDir(spiderHome(home), repoId);
  const store = await SqliteStore.open(path.join(dir, 'graph.db'));
  const { graph, meta } = store.loadGraph();
  store.close();
  return { graph, meta, info: meta.info as RepoInfo };
}

export async function deleteRepo(repoId: string, home?: string): Promise<void> {
  await fs.rm(repoDir(spiderHome(home), repoId), { recursive: true, force: true });
}
