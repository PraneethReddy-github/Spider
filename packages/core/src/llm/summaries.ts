import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphNode, NodeSummary } from '@spider/shared';
import { repoDir, spiderHome } from '../analyze.js';
import type { GraphBuilder } from '../graph/builder.js';
import { type LlmProvider, textOf } from './types.js';

/** Bump when the prompt or the input format changes: every cached summary is then regenerated. */
const PROMPT_VERSION = 1;
const SYSTEM = `You summarise parts of a codebase for an architecture map.
Write 2-3 plain sentences: what this part does and its role in the system, naming its key collaborators.
Use only the material given; if it is too thin to tell, say what little it shows. No headings, lists or code.`;

const MAX_LINES = 250;
const MAX_CHARS = 12_000;
const LEAF_KINDS = new Set(['file', 'class', 'module']);
const GROUP_KINDS = new Set(['subsystem', 'package']);

export type SummaryMap = Record<string, NodeSummary>;

const summariesFile = (repoId: string, home?: string) => path.join(repoDir(spiderHome(home), repoId), 'summaries.json');

export async function readSummaries(repoId: string, home?: string): Promise<SummaryMap> {
  try {
    return JSON.parse(await fs.readFile(summariesFile(repoId, home), 'utf8')) as SummaryMap;
  } catch {
    return {};
  }
}

async function writeSummaries(repoId: string, map: SummaryMap, home?: string): Promise<void> {
  const file = summariesFile(repoId, home);
  await fs.writeFile(`${file}.tmp`, JSON.stringify(map));
  await fs.rename(`${file}.tmp`, file);
}

/**
 * Default targets: every subsystem and workspace package, plus the hub files (PageRank) and classes (fan-in),
 * `limit` hubs in all. Tests are left out.
 */
export function summaryTargets(g: GraphBuilder, limit = 40): GraphNode[] {
  const prod = (n: GraphNode) => !n.props.isTest;
  const files = g
    .nodesOfKind('file')
    .filter((n) => prod(n) && n.metrics?.loc)
    .sort((a, b) => (b.metrics?.pagerank ?? 0) - (a.metrics?.pagerank ?? 0))
    .slice(0, Math.ceil(limit * 0.6));
  const classes = g
    .nodesOfKind('class')
    .filter(prod)
    .sort((a, b) => (b.metrics?.fanIn ?? 0) - (a.metrics?.fanIn ?? 0))
    .slice(0, limit - files.length);
  return [...files, ...classes, ...g.nodesOfKind('package'), ...g.nodesOfKind('subsystem')];
}

export interface SummarizeOptions {
  repoId: string;
  g: GraphBuilder;
  /** Repo root on disk (source excerpts are read from here, never outside it). */
  root: string;
  provider: LlmProvider;
  home?: string;
  /** Explicit targets; default `summaryTargets(g, limit)`. Unsupported kinds are skipped. */
  nodeIds?: string[];
  limit?: number;
  /** Regenerate even when the input hash is unchanged. */
  force?: boolean;
  concurrency?: number;
  onProgress?: (done: number, total: number, node: GraphNode) => void;
  signal?: AbortSignal;
}

export interface SummarizeResult {
  generated: number;
  reused: number;
  failed: { nodeId: string; error: string }[];
  summaries: SummaryMap;
}

/** Summaries for leaves first, then groups (whose input lists their members' summaries); cached by input hash. */
export async function generateSummaries(o: SummarizeOptions): Promise<SummarizeResult> {
  const map = await readSummaries(o.repoId, o.home);
  const targets = (o.nodeIds ? o.nodeIds.map((id) => o.g.getNode(id)) : summaryTargets(o.g, o.limit)).filter(
    (n): n is GraphNode => !!n && (LEAF_KINDS.has(n.kind) || GROUP_KINDS.has(n.kind) || n.kind === 'function'),
  );
  const result: SummarizeResult = { generated: 0, reused: 0, failed: [], summaries: map };
  let done = 0;
  const run = async (n: GraphNode) => {
    try {
      const input = GROUP_KINDS.has(n.kind) ? groupInput(o.g, n, map) : await leafInput(o.g, n, o.root);
      const hash = createHash('sha256').update(`${PROMPT_VERSION}\0${o.provider.model}\0${input}`).digest('hex');
      if (!o.force && map[n.id]?.hash === hash) {
        result.reused++;
        return;
      }
      const r = await o.provider.chat({
        system: SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
        effort: 'low',
        maxTokens: 8000,
        signal: o.signal,
      });
      const text = textOf(r);
      if (r.stop === 'refusal' || !text) throw new Error(r.stop === 'refusal' ? 'model declined' : 'empty answer');
      map[n.id] = { nodeId: n.id, text, hash, model: r.model, generatedAt: new Date().toISOString() };
      result.generated++;
    } catch (err) {
      if (o.signal?.aborted) throw err;
      result.failed.push({ nodeId: n.id, error: String((err as Error)?.message ?? err) });
    } finally {
      o.onProgress?.(++done, targets.length, n);
    }
  };
  try {
    await pool(
      targets.filter((n) => !GROUP_KINDS.has(n.kind)),
      o.concurrency ?? 4,
      run,
    );
    await pool(
      targets.filter((n) => GROUP_KINDS.has(n.kind)),
      o.concurrency ?? 4,
      run,
    );
  } finally {
    if (result.generated) await writeSummaries(o.repoId, map, o.home);
  }
  return result;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

const label = (n: GraphNode | undefined) => (n ? (n.qname ?? n.file ?? n.name) : '?');

function neighbours(g: GraphBuilder, n: GraphNode, dir: 'out' | 'in', max: number): string[] {
  const kinds = new Set(['imports', 'calls', 'extends', 'implements', 'instantiates', 'references', 'reads', 'writes']);
  const count = new Map<string, number>();
  for (const e of dir === 'out' ? g.outEdges(n.id) : g.inEdges(n.id)) {
    if (!kinds.has(e.kind)) continue;
    const other = label(g.getNode(dir === 'out' ? e.dst : e.src));
    count.set(other, (count.get(other) ?? 0) + e.weight);
  }
  return [...count]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([k]) => k);
}

async function leafInput(g: GraphBuilder, n: GraphNode, root: string): Promise<string> {
  const head = [
    `${n.kind}: ${label(n)}`,
    n.language ? `language: ${n.language}` : '',
    n.metrics
      ? `fan-in ${n.metrics.fanIn}, fan-out ${n.metrics.fanOut}${n.metrics.loc ? `, ${n.metrics.loc} LOC` : ''}`
      : '',
    `depends on: ${neighbours(g, n, 'out', 15).join(', ') || '(nothing resolved)'}`,
    `used by: ${neighbours(g, n, 'in', 10).join(', ') || '(nothing resolved)'}`,
  ].filter(Boolean);
  return `${head.join('\n')}\n\nsource:\n${await excerpt(n, root)}`;
}

async function excerpt(n: GraphNode, root: string): Promise<string> {
  if (!n.file) return '(none)';
  const base = path.resolve(root);
  const abs = path.resolve(base, n.file);
  if (!abs.startsWith(base + path.sep)) return '(outside the repository)';
  const text = await fs.readFile(abs, 'utf8').catch(() => undefined);
  if (text === undefined) return '(file missing on disk)';
  let lines = text.split('\n');
  if (n.span && n.kind !== 'file') lines = lines.slice(n.span.startLine - 1, n.span.endLine);
  let out = lines.slice(0, MAX_LINES).join('\n');
  if (out.length > MAX_CHARS) out = out.slice(0, MAX_CHARS);
  return out.length < lines.join('\n').length ? `${out}\n… (truncated)` : out;
}

function groupInput(g: GraphBuilder, n: GraphNode, map: SummaryMap): string {
  const files: GraphNode[] = [];
  if (n.kind === 'subsystem') {
    for (const e of g.inEdges(n.id, 'member_of')) {
      const f = g.getNode(e.src);
      if (f) files.push(f);
    }
  } else {
    const stack = [n.id];
    while (stack.length && files.length < 2000) {
      for (const c of g.children(stack.pop()!)) {
        if (c.kind === 'file') files.push(c);
        else if (c.kind === 'directory' || c.kind === 'package') stack.push(c.id);
      }
    }
  }
  const members = files
    .filter((f) => !f.props.isTest)
    .sort((a, b) => (b.metrics?.pagerank ?? 0) - (a.metrics?.pagerank ?? 0))
    .slice(0, 25)
    .map((f) => `- ${f.file ?? f.name}${map[f.id] ? `: ${map[f.id].text}` : ''}`);
  return `${n.kind}: ${n.name} (${files.length} files)\nmost central files:\n${members.join('\n') || '(none)'}`;
}
