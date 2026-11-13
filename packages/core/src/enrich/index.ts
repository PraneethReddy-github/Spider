import path from 'node:path';
import type { Diagnostic, GraphNode } from '@spider/shared';
import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';
import type { Discovery } from '../pipeline/discover.js';

const SOURCE_LANGS = new Set([
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

export interface EnrichResult {
  diagnostics: Diagnostic[];
  subsystems: number;
}

export function enrich(g: GraphBuilder, d: Discovery): EnrichResult {
  markEntryPoints(g, d);
  computeDegrees(g);
  const fileGraph = buildFileGraph(g);
  computePagerank(g, fileGraph);
  const subsystems = inferSubsystems(g, fileGraph);
  const diagnostics = [
    ...findCycles(g, fileGraph),
    ...findDeadCode(g),
    ...findGodModules(g),
    ...findOrphans(g, fileGraph),
  ];
  return { diagnostics, subsystems };
}

function markEntryPoints(g: GraphBuilder, d: Discovery): void {
  const entryNames = /^(index|main|app|server|cli|__main__|manage|wsgi|asgi)\.(m?[jt]sx?|py)$/;
  for (const f of g.nodesOfKind('file')) {
    const p = f.file ?? '';
    const depth = p.split('/').length;
    let isEntry = false;
    if (entryNames.test(path.posix.basename(p)) && depth <= 3) isEntry = true;
    if (/^(src\/)?(bin|cmd)\//.test(p)) isEntry = true;
    if (isEntry) f.props.isEntry = true;
  }
  for (const m of d.manifests) {
    const bins = m.extra.bin;
    const mains = [
      m.extra.main,
      m.extra.module,
      ...(typeof bins === 'string'
        ? [bins]
        : bins && typeof bins === 'object'
          ? Object.values(bins as Record<string, string>)
          : []),
    ];
    for (const rel of mains) {
      if (typeof rel !== 'string') continue;
      const p = path.posix.normalize(path.posix.join(m.dir, rel));
      const n = g.getNode(ids.file(p));
      if (n) n.props.isEntry = true;
    }
  }
}

function computeDegrees(g: GraphBuilder): void {
  for (const n of g.nodes.values()) {
    n.metrics ??= { fanIn: 0, fanOut: 0 };
    n.metrics.fanIn = 0;
    n.metrics.fanOut = 0;
  }
  for (const e of g.edges.values()) {
    if (e.kind === 'contains' || e.kind === 'exports' || e.kind === 'member_of') continue;
    const s = g.getNode(e.src);
    const t = g.getNode(e.dst);
    if (s?.metrics) s.metrics.fanOut += 1;
    if (t?.metrics) t.metrics.fanIn += 1;
  }
}

/** Directed weighted file-level graph (imports + rolled-up calls). */
function buildFileGraph(g: GraphBuilder): Graph {
  const fg = new Graph({ type: 'directed', multi: false });
  for (const f of g.nodesOfKind('file')) fg.addNode(f.id);
  const fileOf = (id: string): string | undefined => {
    const n = g.getNode(id);
    if (!n) return undefined;
    if (n.kind === 'file') return n.id;
    if (n.file) return ids.file(n.file);
    return undefined;
  };
  for (const e of g.edges.values()) {
    if (!['imports', 'calls', 'instantiates', 'extends', 'implements', 'exposes'].includes(e.kind)) continue;
    const a = fileOf(e.src);
    const b = fileOf(e.dst);
    if (!a || !b || a === b || !fg.hasNode(a) || !fg.hasNode(b)) continue;
    const w = e.kind === 'imports' ? 3 : 1;
    if (fg.hasEdge(a, b)) fg.updateEdgeAttribute(a, b, 'weight', (x: number) => x + w);
    else fg.addEdge(a, b, { weight: w });
  }
  return fg;
}

function computePagerank(g: GraphBuilder, fg: Graph): void {
  if (fg.order === 0) return;
  try {
    const pr = pagerank(fg, { getEdgeWeight: 'weight' });
    for (const [id, v] of Object.entries(pr as Record<string, number>)) {
      const n = g.getNode(id);
      if (n?.metrics) n.metrics.pagerank = v;
    }
  } catch {
    /* pagerank can fail on degenerate graphs */
  }
}

/**
 * Subsystem inference: Louvain communities on the undirected file graph, constrained by
 * directory structure (small communities are merged into their directory's dominant community),
 * labelled by the longest common directory prefix.
 */
function inferSubsystems(g: GraphBuilder, fg: Graph): number {
  const files = g.nodesOfKind('file').filter((f) => SOURCE_LANGS.has(f.language ?? ''));
  if (files.length === 0) return 0;

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
      community = louvain(ug, { getEdgeWeight: 'weight', resolution: 1 });
    } catch {
      community = {};
    }
  }
  // Files without edges: assign by top-level directory
  const dirKey = (p: string) => {
    const parts = p.split('/');
    return parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '(root)';
  };
  let nextId = Math.max(-1, ...Object.values(community)) + 1;
  const byDir = new Map<string, number>();
  for (const f of files) {
    if (community[f.id] === undefined) {
      const k = dirKey(f.file ?? '');
      let c = byDir.get(k);
      if (c === undefined) byDir.set(k, (c = nextId++));
      community[f.id] = c;
    }
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
  for (const [c, list] of members) {
    if (list.length >= 3) continue;
    for (const f of list) {
      const dir = path.posix.dirname(f.file ?? '');
      const dom = dirDominant.get(dir) ?? dirDominant.get(path.posix.dirname(dir));
      if (dom !== undefined) community[f.id] = dom;
    }
  }

  // Regroup, label, emit
  const groups = new Map<number, GraphNode[]>();
  for (const f of files) {
    const c = community[f.id];
    let l = groups.get(c);
    if (!l) groups.set(c, (l = []));
    l.push(f);
  }
  const usedLabels = new Map<string, number>();
  let count = 0;
  for (const [, list] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    let label = commonDirPrefix(list.map((f) => f.file ?? ''));
    if (!label || usedLabels.has(label))
      label = dominantDir(
        list.map((f) => f.file ?? ''),
        label,
      );
    if (!label) label = 'core';
    const seen = usedLabels.get(label) ?? 0;
    usedLabels.set(label, seen + 1);
    if (seen > 0) label = `${label} #${seen + 1}`;
    const id = ids.subsystem(label);
    g.addNode({
      id,
      kind: 'subsystem',
      name: label,
      qname: label,
      props: { memberCount: list.length, inferred: true },
    });
    for (const f of list) {
      g.addEdge('member_of', f.id, id);
      f.props.subsystem = id;
    }
    count++;
  }
  return count;
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
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return best;
}

/* ---------- diagnostics ---------- */

function findCycles(g: GraphBuilder, fg: Graph): Diagnostic[] {
  // Tarjan SCC on import edges only (calls create too many spurious cycles)
  const adj = new Map<string, string[]>();
  for (const e of g.edges.values()) {
    if (e.kind !== 'imports') continue;
    if (g.getNode(e.dst)?.kind !== 'file') continue;
    let l = adj.get(e.src);
    if (!l) adj.set(e.src, (l = []));
    l.push(e.dst);
  }
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const strong = (v: string) => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1) sccs.push(comp);
    }
  };
  for (const v of fg.nodes()) if (!idx.has(v) && adj.has(v)) strong(v);
  return sccs
    .sort((a, b) => b.length - a.length)
    .slice(0, 100)
    .map((comp) => ({
      type: 'cycle' as const,
      title: `Import cycle of ${comp.length} files`,
      nodeIds: comp,
      severity: comp.length > 5 ? ('error' as const) : ('warn' as const),
      detail: comp
        .map((id) => g.getNode(id)?.file)
        .filter(Boolean)
        .slice(0, 8)
        .join(' → '),
    }));
}

function findDeadCode(g: GraphBuilder): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const n of g.nodes.values()) {
    // interfaces and type aliases count now that annotations produce `references` edges
    if (n.kind !== 'function' && n.kind !== 'class' && n.kind !== 'type') continue;
    if (n.props.isTest) continue;
    if (n.file?.endsWith('.d.ts')) continue; // declaration files describe a public API for consumers
    const file = n.file ? g.getNode(ids.file(n.file)) : undefined;
    if (file?.props.isEntry || file?.props.isTest) continue;
    if (!n.props.isExported) continue;
    if (/^(main|default|handler|setup|teardown|app|config|router|create[A-Z]\w*Plugin)$/.test(n.name)) continue;
    if ((n.metrics?.fanIn ?? 0) > 0) continue;
    if (g.inEdges(n.id).some((e) => e.kind === 'exposes')) continue;
    out.push({
      type: 'dead-code',
      title: `${n.name} has no references`,
      nodeIds: [n.id],
      severity: 'info',
      detail: `${n.kind} in ${n.file}`,
    });
  }
  return out.slice(0, 500);
}

function findGodModules(g: GraphBuilder): Diagnostic[] {
  const files = g.nodesOfKind('file').filter((f) => f.metrics);
  if (files.length < 20) return [];
  const scored = files
    .map((f) => ({ f, s: (f.metrics!.fanIn ?? 0) + (f.metrics!.fanOut ?? 0) }))
    .sort((a, b) => b.s - a.s);
  const cutoff = Math.max(1, Math.floor(files.length * 0.02));
  return scored
    .slice(0, cutoff)
    .filter(({ f }) => (f.metrics!.fanIn ?? 0) >= 10 && (f.metrics!.fanOut ?? 0) >= 10)
    .map(({ f }) => ({
      type: 'god-module' as const,
      title: `${f.file} is highly coupled`,
      nodeIds: [f.id],
      severity: 'warn' as const,
      detail: `fan-in ${f.metrics!.fanIn}, fan-out ${f.metrics!.fanOut}`,
    }));
}

function findOrphans(g: GraphBuilder, fg: Graph): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const f of g.nodesOfKind('file')) {
    if (!SOURCE_LANGS.has(f.language ?? '') || f.props.isTest || f.props.isEntry) continue;
    if (!fg.hasNode(f.id) || fg.degree(f.id) > 0) continue;
    out.push({ type: 'orphan', title: `${f.file} is not connected to anything`, nodeIds: [f.id], severity: 'info' });
  }
  return out.slice(0, 200);
}
