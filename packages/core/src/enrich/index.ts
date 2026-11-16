import path from 'node:path';
import type { Diagnostic, SubsystemOverrides } from '@spider/shared';
import Graph from 'graphology';
import pagerank from 'graphology-metrics/centrality/pagerank.js';
import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';
import type { Discovery } from '../pipeline/discover.js';
import { computeBetweenness } from './betweenness.js';
import { findLayerViolations } from './layers.js';
import {
  EMPTY_OVERRIDES,
  SOURCE_LANGS,
  type SubsystemGroup,
  applySubsystems,
  inferSubsystems,
  matchPrevious,
} from './subsystems.js';

export { layerize } from './layers.js';
export { EMPTY_OVERRIDES, applySubsystems, groupsFromGraph, type SubsystemGroup } from './subsystems.js';

export interface EnrichOptions {
  /** Subsystems of the previous run (graph meta `subsystems`), to keep subsystem ids stable. */
  previousSubsystems?: SubsystemGroup[];
  overrides?: SubsystemOverrides;
}

export interface EnrichResult {
  diagnostics: Diagnostic[];
  subsystems: number;
  /** Inferred subsystems before overrides (persist as graph meta `subsystems`). */
  subsystemGroups: SubsystemGroup[];
}

export function enrich(g: GraphBuilder, d: Discovery, opts: EnrichOptions = {}): EnrichResult {
  markEntryPoints(g, d);
  computeDegrees(g);
  const fileGraph = buildFileGraph(g);
  computePagerank(g, fileGraph);
  computeBetweenness(g, fileGraph);
  const subsystemGroups = inferSubsystems(g, fileGraph, d);
  matchPrevious(subsystemGroups, opts.previousSubsystems);
  const subsystems = applySubsystems(g, subsystemGroups, opts.overrides ?? EMPTY_OVERRIDES);
  const diagnostics = [
    ...findCycles(g, fileGraph),
    ...findLayerViolations(g, fileGraph),
    ...findDeadCode(g),
    ...findGodModules(g),
    ...findOrphans(g, fileGraph),
  ];
  return { diagnostics, subsystems, subsystemGroups };
}

function markEntryPoints(g: GraphBuilder, d: Discovery): void {
  const entryNames = /^(index|main|app|server|cli|__main__|manage|wsgi|asgi)\.(m?[jt]sx?|py|go|rs)$/;
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
    if (e.props.protocol === 'http') continue; // a service boundary, not a code dependency
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
  // iterative (explicit call frames): recursion overflowed the stack on ~28k-file import chains
  const strong = (root: string) => {
    const frames: [string, number][] = [];
    const enter = (v: string) => {
      idx.set(v, index);
      low.set(v, index);
      index++;
      stack.push(v);
      onStack.add(v);
      frames.push([v, 0]);
    };
    enter(root);
    while (frames.length) {
      const top = frames[frames.length - 1];
      const v = top[0];
      const out = adj.get(v) ?? [];
      if (top[1] < out.length) {
        const w = out[top[1]++];
        if (!idx.has(w)) enter(w);
        else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent[0], Math.min(low.get(parent[0])!, low.get(v)!));
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
