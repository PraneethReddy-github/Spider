import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type {
  Diagnostic,
  DiffEdgeRef,
  DiffNodeChange,
  DiffNodeRef,
  GraphDiff,
  GraphNode,
  SubsystemOverrides,
} from '@spider/shared';
import { spiderHome } from '../analyze.js';
import { type SubsystemGroup, enrich } from '../enrich/index.js';
import { GraphBuilder } from '../graph/builder.js';
import { discover, emitStructure } from '../pipeline/discover.js';
import { extractAllWithStats } from '../pipeline/extract.js';
import { resolve } from '../pipeline/resolve.js';
import { exportCommit, resolveCommit } from './git.js';

export { exportCommit, isGitRoot, localRefs, resolveCommit } from './git.js';
export { diffMarkdown } from './markdown.js';

export interface DiffOptions {
  /** Root of a local git work tree. */
  root: string;
  base: string;
  /** Head revision; omitted = the working tree as it is on disk (uncommitted changes included). */
  head?: string;
  home?: string;
  overrides?: SubsystemOverrides;
}

export interface BuiltGraph {
  g: GraphBuilder;
  diagnostics: Diagnostic[];
  subsystemGroups: SubsystemGroup[];
}

/** discover → extract (shared content cache) → resolve → enrich, in memory; nothing is persisted. */
export async function buildGraph(
  root: string,
  name: string,
  opts: { home?: string; previousSubsystems?: SubsystemGroup[]; overrides?: SubsystemOverrides } = {},
): Promise<BuiltGraph> {
  const d = await discover(root);
  const g = new GraphBuilder();
  emitStructure(g, d, name);
  const { facts } = await extractAllWithStats(d.files, {
    cacheDir: path.join(spiderHome(opts.home), 'cache'),
    frameworks: d.frameworks,
  });
  resolve(g, d, facts);
  const en = enrich(g, d, { previousSubsystems: opts.previousSubsystems, overrides: opts.overrides });
  return { g, diagnostics: en.diagnostics, subsystemGroups: en.subsystemGroups };
}

/**
 * Analyses `base` (and `head`, unless it is the working tree) from `git archive` exports under
 * `SPIDER_HOME/tmp`, then diffs the graphs. The temporary trees are always removed.
 */
export async function diffRevisions(opts: DiffOptions): Promise<GraphDiff> {
  const root = path.resolve(opts.root);
  const name = path.basename(root);
  const tmp = path.join(spiderHome(opts.home), 'tmp', `diff-${randomUUID()}`);
  try {
    const baseCommit = await resolveCommit(root, opts.base);
    const headCommit = opts.head
      ? await resolveCommit(root, opts.head)
      : await resolveCommit(root, 'HEAD').catch(() => undefined);
    const baseDir = path.join(tmp, 'base');
    await exportCommit(root, baseCommit, baseDir);
    const base = await buildGraph(baseDir, name, { home: opts.home, overrides: opts.overrides });
    let headRoot = root;
    if (opts.head && headCommit) {
      headRoot = path.join(tmp, 'head');
      await exportCommit(root, headCommit, headRoot);
    }
    // base subsystems seed the head run so unchanged subsystems keep their ids
    const head = await buildGraph(headRoot, name, {
      home: opts.home,
      overrides: opts.overrides,
      previousSubsystems: base.subsystemGroups,
    });
    return diffGraphs(base, head, {
      base: { ref: opts.base, commit: baseCommit },
      head: { ref: opts.head ?? 'working tree', commit: headCommit },
    });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

const STRUCTURAL = new Set(['contains', 'exports', 'member_of']);
/** Graph-global or git-derived metrics move with unrelated changes; they are not diffed. */
const DIFFED_METRICS = ['loc', 'complexity', 'fanIn', 'fanOut'] as const;

/** Pure diff of two built graphs by node/edge id. */
export function diffGraphs(
  base: Pick<BuiltGraph, 'g' | 'diagnostics'>,
  head: Pick<BuiltGraph, 'g' | 'diagnostics'>,
  sides: Pick<GraphDiff, 'base' | 'head'>,
): GraphDiff {
  const b = base.g;
  const h = head.g;
  const ref = (n: GraphNode): DiffNodeRef => ({ id: n.id, kind: n.kind, name: n.name, qname: n.qname, file: n.file });
  const label = (g: GraphBuilder, id: string) => {
    const n = g.getNode(id);
    return n ? (n.qname ?? n.file ?? n.name) : id;
  };
  const edgeRef = (g: GraphBuilder, e: Omit<DiffEdgeRef, 'srcLabel' | 'dstLabel'>): DiffEdgeRef => ({
    id: e.id,
    kind: e.kind,
    src: e.src,
    dst: e.dst,
    weight: e.weight,
    srcLabel: label(g, e.src),
    dstLabel: label(g, e.dst),
  });

  const added: DiffNodeRef[] = [];
  const removed: DiffNodeRef[] = [];
  const changed: DiffNodeChange[] = [];
  for (const n of h.nodes.values()) {
    const old = b.getNode(n.id);
    if (!old) added.push(ref(n));
    else {
      const changes = nodeChanges(old, n);
      if (Object.keys(changes).length) changed.push({ ...ref(n), changes });
    }
  }
  for (const n of b.nodes.values()) if (!h.hasNode(n.id)) removed.push(ref(n));

  const edgesAdded: DiffEdgeRef[] = [];
  const edgesRemoved: DiffEdgeRef[] = [];
  for (const e of h.edges.values()) if (!STRUCTURAL.has(e.kind) && !b.edges.has(e.id)) edgesAdded.push(edgeRef(h, e));
  for (const e of b.edges.values()) if (!STRUCTURAL.has(e.kind) && !h.edges.has(e.id)) edgesRemoved.push(edgeRef(b, e));

  const diag = (type: Diagnostic['type']) => {
    const key = (d: Diagnostic) => [...d.nodeIds].sort().join(',');
    const before = base.diagnostics.filter((d) => d.type === type);
    const after = head.diagnostics.filter((d) => d.type === type);
    const had = new Set(before.map(key));
    const has = new Set(after.map(key));
    return { added: after.filter((d) => !had.has(key(d))), resolved: before.filter((d) => !has.has(key(d))) };
  };
  const cycles = diag('cycle');
  const violations = diag('layer-violation');

  const byName = (a: DiffNodeRef, c: DiffNodeRef) => (a.qname ?? a.name).localeCompare(c.qname ?? c.name);
  const byEdge = (a: DiffEdgeRef, c: DiffEdgeRef) =>
    a.kind.localeCompare(c.kind) || a.srcLabel.localeCompare(c.srcLabel) || a.dstLabel.localeCompare(c.dstLabel);
  added.sort(byName);
  removed.sort(byName);
  changed.sort(byName);
  edgesAdded.sort(byEdge);
  edgesRemoved.sort(byEdge);

  const ancestors: Record<string, string[]> = {};
  const chain = (id: string) => {
    if (ancestors[id]) return;
    const g = h.hasNode(id) ? h : b;
    const out: string[] = [];
    for (let p = g.getNode(id)?.parentId; p && out.length < 64; p = g.getNode(p)?.parentId) out.push(p);
    ancestors[id] = out;
  };
  for (const n of [...added, ...removed, ...changed]) chain(n.id);
  for (const e of [...edgesAdded, ...edgesRemoved]) {
    chain(e.src);
    chain(e.dst);
  }

  const files = (list: DiffNodeRef[]) => list.filter((n) => n.kind === 'file').length;
  return {
    ...sides,
    nodes: { added, removed, changed },
    edges: { added: edgesAdded, removed: edgesRemoved },
    diagnostics: {
      newCycles: cycles.added,
      resolvedCycles: cycles.resolved,
      newViolations: violations.added,
      resolvedViolations: violations.resolved,
    },
    summary: {
      nodesAdded: added.length,
      nodesRemoved: removed.length,
      nodesChanged: changed.length,
      edgesAdded: edgesAdded.length,
      edgesRemoved: edgesRemoved.length,
      filesAdded: files(added),
      filesRemoved: files(removed),
      filesChanged: files(changed),
      newCycles: cycles.added.length,
      resolvedCycles: cycles.resolved.length,
      newViolations: violations.added.length,
      resolvedViolations: violations.resolved.length,
    },
    ancestors,
  };
}

/** Field-level differences; a span that only moved (same length) is not a change. */
function nodeChanges(a: GraphNode, b: GraphNode): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  if (a.name !== b.name) out.name = [a.name, b.name];
  if (a.parentId !== b.parentId) out.parentId = [a.parentId, b.parentId];
  const len = (n: GraphNode) => (n.span ? n.span.endLine - n.span.startLine : undefined);
  if (len(a) !== len(b)) {
    const fmt = (n: GraphNode) => (n.span ? `${n.span.startLine}-${n.span.endLine}` : undefined);
    out.span = [fmt(a), fmt(b)];
  }
  for (const m of DIFFED_METRICS) {
    const x = a.metrics?.[m];
    const y = b.metrics?.[m];
    if (x !== y) out[`metrics.${m}`] = [x, y];
  }
  for (const k of new Set([...Object.keys(a.props), ...Object.keys(b.props)])) {
    const x = JSON.stringify(a.props[k]);
    const y = JSON.stringify(b.props[k]);
    if (x !== y) out[`props.${k}`] = [a.props[k], b.props[k]];
  }
  return out;
}
