import path from 'node:path';
import type { GraphNode, SubsystemOverrides } from '@spider/shared';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';
import { type Discovery, isTestPath } from '../pipeline/discover.js';

export const SOURCE_LANGS = new Set([
  'typescript',
  'tsx',
  'javascript',
  'python',
  'go',
  'rust',
  'java',
  'kotlin',
  'csharp',
  'ruby',
  'php',
  'c',
  'cpp',
]);

/** An inferred subsystem before overrides; persisted in graph meta `subsystems` for re-application. */
export interface SubsystemGroup {
  id: string;
  label: string;
  /** Member file node ids. */
  members: string[];
}

export const EMPTY_OVERRIDES: SubsystemOverrides = { rename: {}, merge: [], pins: {} };

/** Directory names too generic to describe a slice of the code on their own. */
const GENERIC_DIRS = new Set(['src', 'lib', 'app', 'source', 'pkg', 'packages', 'internal', 'libs', 'apps']);

/** Mulberry32: a tiny seeded PRNG, so Louvain (random node order) gives the same partition every run. */
export function seededRandom(seed = 0x5eed): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BARREL = /^(__init__|index|mod)\.\w+$/;

/** Examples, docs, scripts and benchmarks are their own subsystems, never mixed into the code they use. */
const AUX_DIR = /^(examples?|samples?|demos?|docs?|benchmarks?|scripts)$/;

/** `examples/tutorial/app/x.py` → `examples/tutorial`: the auxiliary directory plus one level. */
function auxDir(p: string): string | undefined {
  const dirs = p.split('/').slice(0, -1);
  const i = dirs.findIndex((s) => AUX_DIR.test(s));
  return i < 0 ? undefined : dirs.slice(0, Math.min(i + 2, dirs.length)).join('/');
}

/** Workspace packages (non-root manifests outside tests with ≥ 3 source files) seed one subsystem each. */
function workspaceSeeds(d: Discovery, files: GraphNode[]): string[] {
  const dirs = [...new Set(d.manifests.map((m) => m.dir))].filter((dir) => dir && !isTestPath(`${dir}/x`));
  return dirs
    .filter((dir) => files.filter((f) => (f.file ?? '').startsWith(`${dir}/`)).length >= 3)
    .sort((a, b) => b.length - a.length); // deepest first, so nested packages win
}

/**
 * Subsystem inference over production files: workspace packages and auxiliary directories
 * (examples, docs, scripts, benchmarks) are seeds; other files are grouped by
 * Louvain communities on the undirected file graph (seeded, deterministic), constrained by directory
 * structure (small communities merge into their directory's dominant community), labelled by
 * directory paths. Test files then join the subsystem they depend on most (else one group per
 * top-level directory), so tests never decide communities or labels.
 */
export function inferSubsystems(g: GraphBuilder, fg: Graph, d: Discovery): SubsystemGroup[] {
  const files = g.nodesOfKind('file').filter((f) => SOURCE_LANGS.has(f.language ?? ''));
  if (files.length === 0) return [];
  const prod = files.filter((f) => !f.props.isTest);
  const seeds = workspaceSeeds(d, prod);
  const seedOf = (p: string) => seeds.find((s) => p.startsWith(`${s}/`)) ?? auxDir(p);
  const community = communities(
    fg,
    prod.filter((f) => !seedOf(f.file ?? '')),
  );
  const keyOf = new Map<string, string>();
  for (const f of prod) {
    const seed = seedOf(f.file ?? '');
    keyOf.set(f.id, seed ? `s:${seed}` : `c:${community[f.id]}`);
  }
  for (const f of files) {
    if (keyOf.has(f.id)) continue;
    const seed = seedOf(f.file ?? '');
    keyOf.set(f.id, seed ? `s:${seed}` : (subjectOf(fg, f.id, keyOf) ?? `t:${(f.file ?? '').split('/')[0]}`));
  }
  const groups = new Map<string, GraphNode[]>();
  for (const f of files) {
    const key = keyOf.get(f.id) as string;
    let l = groups.get(key);
    if (!l) groups.set(key, (l = []));
    l.push(f);
  }
  const allPaths = prod.map((f) => f.file ?? '');
  const countUnder = (dir: string) => allPaths.filter((p) => p.startsWith(`${dir}/`)).length;
  const used = new Map<string, number>();
  const out: SubsystemGroup[] = [];
  const size = (l: GraphNode[]) => l.filter((f) => !f.props.isTest).length;
  const ordered = [...groups.entries()].sort(
    (a, b) =>
      size(b[1]) - size(a[1]) || b[1].length - a[1].length || (a[1][0].file ?? '').localeCompare(b[1][0].file ?? ''),
  );
  for (const [key, list] of ordered) {
    const own = list
      .filter((f) => !f.props.isTest)
      .sort((a, b) => (b.metrics?.pagerank ?? 0) - (a.metrics?.pagerank ?? 0));
    const paths = (own.length ? own : list).map((f) => f.file ?? '');
    let label = key.startsWith('s:') ? key.slice(2) : labelFor(paths, used, countUnder);
    const seen = used.get(label) ?? 0;
    used.set(label, seen + 1);
    if (seen > 0) label = `${label} #${seen + 1}`;
    out.push({ id: ids.subsystem(label), label, members: list.map((f) => f.id) });
  }
  return out;
}

/** The production group a test file depends on most (by outgoing file-graph weight). */
function subjectOf(fg: Graph, id: string, keyOf: Map<string, string>): string | undefined {
  if (!fg.hasNode(id)) return undefined;
  const weight = new Map<string, number>();
  fg.forEachOutEdge(id, (_e, attrs, _s, t) => {
    const k = keyOf.get(t);
    if (k) weight.set(k, (weight.get(k) ?? 0) + (attrs.weight as number));
  });
  return [...weight.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
}

/** Louvain communities over `files` (seeded RNG); edgeless files grouped by top-level directory. */
function communities(fg: Graph, files: GraphNode[]): Record<string, number> {
  const ug = new Graph({ type: 'undirected' });
  for (const f of files) ug.addNode(f.id);
  fg.forEachEdge((_e, attrs, s, t) => {
    if (!ug.hasNode(s) || !ug.hasNode(t)) return;
    if (ug.hasEdge(s, t)) ug.updateEdgeAttribute(s, t, 'weight', (x: number) => x + attrs.weight);
    else ug.addEdge(s, t, { weight: attrs.weight });
  });
  let community: Record<string, number> = {};
  if (ug.size > 0) {
    try {
      community = louvain(ug, { getEdgeWeight: 'weight', resolution: 1, rng: seededRandom() });
    } catch {
      community = {};
    }
  }
  const dirKey = (p: string) => {
    const parts = p.split('/');
    return parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '(root)';
  };
  let nextId = Math.max(-1, ...Object.values(community)) + 1;
  const byDir = new Map<string, number>();
  for (const f of files) {
    if (community[f.id] !== undefined) continue;
    const k = dirKey(f.file ?? '');
    let c = byDir.get(k);
    if (c === undefined) byDir.set(k, (c = nextId++));
    community[f.id] = c;
  }
  // Merge tiny communities (< 3 files) into the dominant community of their directory.
  const members = new Map<number, GraphNode[]>();
  for (const f of files) {
    const c = community[f.id];
    let l = members.get(c);
    if (!l) members.set(c, (l = []));
    l.push(f);
  }
  const dirDominant = new Map<string, number>();
  for (const [c, list] of members) {
    if (list.length < 3) continue;
    for (const f of list) {
      const dir = path.posix.dirname(f.file ?? '');
      const cur = dirDominant.get(dir);
      if (cur === undefined || (members.get(cur)?.length ?? 0) < list.length) dirDominant.set(dir, c);
    }
  }
  for (const [, list] of members) {
    if (list.length >= 3) continue;
    for (const f of list) {
      const dir = path.posix.dirname(f.file ?? '');
      const dom = dirDominant.get(dir) ?? dirDominant.get(path.posix.dirname(dir));
      if (dom !== undefined) community[f.id] = dom;
    }
  }
  return community;
}

/**
 * Path-like label: the members' common directory. From the root, a generic directory (`src`, `lib`, …)
 * the group covers only partly, or a label already taken, it descends into the child directory that
 * holds a strict majority of the members, as long as there is one. No majority at the root → the most
 * common top-level directory, or `(root)`. A label still taken becomes the file path (one member) or
 * `dir (file)` after the group's most central non-barrel file under it (`paths` sorted by PageRank).
 */
function labelFor(paths: string[], used: Map<string, number>, countUnder: (dir: string) => number): string {
  let label = commonDirPrefix(paths);
  const vague = (l: string) =>
    !l || used.has(l) || (GENERIC_DIRS.has(l.split('/').pop() ?? '') && countUnder(l) > paths.length);
  while (vague(label)) {
    const child = dominantDir(paths, label);
    const share = paths.filter((p) => p.startsWith(`${child}/`)).length / paths.length;
    if (child === label || child === '(root)' || share <= 0.5) break;
    label = child;
  }
  if (!label) return dominantDir(paths);
  if (!used.has(label)) return label;
  if (paths.length === 1) return paths[0];
  // `paths` is sorted by PageRank: name the group after its most central non-barrel file under `label`
  const under = paths.filter((p) => p.startsWith(`${label}/`));
  const hub = under.find((p) => !BARREL.test(path.posix.basename(p))) ?? under[0];
  return hub ? `${label} (${path.posix.relative(label, hub).replace(/\.[^./]+$/, '')})` : label;
}

function commonDirPrefix(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map((p) => p.split('/').slice(0, -1));
  let prefix = split[0];
  for (const s of split.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) break;
  }
  return prefix.join('/');
}

/** Most common directory among the paths, one level deeper than `prefix` when possible. */
function dominantDir(paths: string[], prefix = ''): string {
  const counts = new Map<string, number>();
  const depth = prefix ? prefix.split('/').length + 1 : 1;
  for (const p of paths) {
    const parts = p.split('/').slice(0, -1);
    const key = parts.length === 0 ? '(root)' : parts.slice(0, Math.min(parts.length, depth)).join('/');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

/**
 * Keeps subsystem ids stable across runs: each new group takes the id of the previous run's group
 * with the highest member overlap (Jaccard ≥ 0.5), one-to-one; the rest get fresh label-based ids.
 */
export function matchPrevious(groups: SubsystemGroup[], previous: SubsystemGroup[] | undefined): void {
  if (!previous?.length) return;
  const prevOf = new Map<string, number>();
  previous.forEach((p, i) => {
    for (const m of p.members) prevOf.set(m, i);
  });
  const pairs: { n: number; p: number; j: number }[] = [];
  groups.forEach((grp, n) => {
    const overlap = new Map<number, number>();
    for (const m of grp.members) {
      const p = prevOf.get(m);
      if (p !== undefined) overlap.set(p, (overlap.get(p) ?? 0) + 1);
    }
    for (const [p, inter] of overlap) {
      const j = inter / (grp.members.length + previous[p].members.length - inter);
      if (j >= 0.5) pairs.push({ n, p, j });
    }
  });
  pairs.sort((a, b) => b.j - a.j || a.n - b.n || a.p - b.p);
  const doneN = new Set<number>();
  const doneP = new Set<number>();
  for (const { n, p } of pairs) {
    if (doneN.has(n) || doneP.has(p)) continue;
    doneN.add(n);
    doneP.add(p);
    groups[n].id = previous[p].id;
  }
  const taken = new Set(groups.filter((_, n) => doneN.has(n)).map((x) => x.id));
  groups.forEach((grp, n) => {
    if (doneN.has(n)) return;
    let id = grp.id;
    for (let k = 2; taken.has(id); k++) id = ids.subsystem(`${grp.label}#${k}`);
    grp.id = id;
    taken.add(id);
  });
}

/** Current subsystems of a stored graph as groups (for graphs persisted before `meta.subsystems`). */
export function groupsFromGraph(g: GraphBuilder): SubsystemGroup[] {
  return g.nodesOfKind('subsystem').map((s) => ({
    id: s.id,
    label: (s.props.inferredLabel as string | undefined) ?? s.name,
    members: g.inEdges(s.id, 'member_of').map((e) => e.src),
  }));
}

/**
 * Replaces the graph's subsystem nodes and `member_of` edges with `groups` after applying the
 * overrides: merge (into the first id of each group), pins (file path → subsystem id), rename.
 * Unknown ids and paths are ignored. Returns the number of subsystems emitted.
 */
export function applySubsystems(g: GraphBuilder, groups: SubsystemGroup[], ov: SubsystemOverrides): number {
  for (const s of g.nodesOfKind('subsystem')) {
    for (const e of g.inEdges(s.id, 'member_of')) g.removeEdge(e.id);
    g.nodes.delete(s.id);
  }
  for (const f of g.nodesOfKind('file')) f.props.subsystem = undefined;

  const label = new Map(groups.map((x) => [x.id, x.label]));
  const owner = new Map<string, string>();
  for (const x of groups) for (const m of x.members) owner.set(m, x.id);
  const alias = new Map<string, string>();
  const target = (id: string) => {
    let cur = id;
    for (let i = 0; alias.has(cur) && i < 100; i++) cur = alias.get(cur) as string;
    return cur;
  };
  for (const grp of ov.merge) {
    const into = target(grp[0]);
    if (!label.has(into)) continue;
    for (const other of grp.slice(1)) {
      const t = target(other);
      if (t === into || !label.has(t)) continue;
      alias.set(t, into);
      for (const [m, o] of owner) if (o === t) owner.set(m, into);
    }
  }
  for (const [file, sid] of Object.entries(ov.pins)) {
    const fid = ids.file(file);
    const t = target(sid);
    if (g.getNode(fid)?.kind === 'file' && label.has(t) && !alias.has(t)) owner.set(fid, t);
  }

  const members = new Map<string, string[]>();
  for (const [m, o] of owner) {
    if (!g.hasNode(m)) continue;
    let l = members.get(o);
    if (!l) members.set(o, (l = []));
    l.push(m);
  }
  let count = 0;
  for (const x of groups) {
    const list = members.get(x.id);
    if (!list?.length) continue;
    const renamed = ov.rename[x.id];
    const isTest = list.every((m) => g.getNode(m)?.props.isTest);
    g.addNode({
      id: x.id,
      kind: 'subsystem',
      name: renamed ?? x.label,
      qname: renamed ?? x.label,
      props: {
        memberCount: list.length,
        inferred: true,
        inferredLabel: x.label,
        ...(renamed ? { renamed: true } : {}),
        ...(isTest ? { isTest: true } : {}),
      },
    });
    for (const m of list) {
      g.addEdge('member_of', m, x.id);
      const f = g.getNode(m);
      if (f) f.props.subsystem = x.id;
    }
    count++;
  }
  return count;
}
