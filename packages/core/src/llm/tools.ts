import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { EdgeKind, GraphNode } from '@spider/shared';
import type { QueryService } from '../query/service.js';
import type { SummaryMap } from './summaries.js';
import type { LlmTool } from './types.js';

/**
 * Read-only graph tools shared by Ask Spider (C-24) and the MCP server (C-25). Every result names node ids so
 * answers can cite them and the UI can highlight them.
 */

export interface ToolContext {
  q: QueryService;
  /** Repo root on disk; `source` never reads outside it. */
  root: string;
  summaries?: SummaryMap;
}

export interface ToolOutput {
  /** Compact JSON for the model. */
  text: string;
  /** Node ids the result mentions (for highlighting). */
  nodeIds: string[];
  isError?: boolean;
}

type Props = Record<string, { type: 'string' | 'integer'; description: string; enum?: string[] }>;
interface GraphTool extends LlmTool {
  required: string[];
  run(ctx: ToolContext, input: Record<string, unknown>): Promise<unknown> | unknown;
}

const MAX_ITEMS = 40;
const RELATION_KINDS: EdgeKind[] = [
  'imports',
  'calls',
  'instantiates',
  'extends',
  'implements',
  'references',
  'exposes',
  'reads',
  'writes',
  'depends_on',
];

/** The model sees nodes as `{id, kind, name, file, line}`; ids are what it cites. */
function brief(n: GraphNode | undefined) {
  if (!n) return undefined;
  return {
    id: n.id,
    kind: n.kind,
    name: n.qname?.split('::').pop() ?? n.name,
    ...(n.file ? { file: n.file } : {}),
    ...(n.span ? { line: n.span.startLine } : {}),
  };
}

function cap<T>(items: T[], max = MAX_ITEMS): { items: T[]; more?: number } {
  return items.length > max ? { items: items.slice(0, max), more: items.length - max } : { items };
}

function schema(props: Props, required: string[]): Record<string, unknown> {
  return { type: 'object', properties: props, required, additionalProperties: false };
}

const str = (description: string) => ({ type: 'string' as const, description });
const int = (description: string) => ({ type: 'integer' as const, description });
const kindsArg = (input: Record<string, unknown>) =>
  typeof input.kinds === 'string' && input.kinds ? (input.kinds.split(',') as EdgeKind[]) : RELATION_KINDS;

function traversal(dir: 'upstream' | 'downstream'): GraphTool {
  return {
    name: dir,
    description:
      dir === 'upstream'
        ? 'What depends on a node: callers, importers, subclasses, endpoint exposers, with hop distance.'
        : 'What a node depends on: callees, imports, base classes, datastores, with hop distance.',
    inputSchema: {},
    required: ['id'],
    run: ({ q }, input) => {
      const depth = Math.min(Number(input.depth ?? 2), 4);
      const sg = q[dir](String(input.id), depth, kindsArg(input));
      const nodes = sg.nodes
        .filter((n) => n.id !== input.id)
        .sort((a, b) => (sg.distances[a.id] ?? 9) - (sg.distances[b.id] ?? 9))
        .map((n) => ({ ...brief(n), distance: sg.distances[n.id] }));
      return cap(nodes);
    },
  };
}

const TOOLS: GraphTool[] = [
  {
    name: 'search',
    description:
      'Find nodes (files, classes, functions, endpoints, subsystems, datastores…) by name or qualified name. Start here.',
    inputSchema: {},
    required: ['query'],
    run: ({ q }, input) => {
      const kinds = typeof input.kinds === 'string' && input.kinds ? input.kinds.split(',') : undefined;
      return q.search(String(input.query), kinds, Math.min(Number(input.limit ?? 15), 40)).map((h) => brief(h.node));
    },
  },
  {
    name: 'node_detail',
    description:
      'One node: kind, file, metrics, parents, its relationships in and out (kind + other node), children, and its summary when one exists.',
    inputSchema: {},
    required: ['id'],
    run: ({ q, summaries }, input) => {
      const d = q.detail(String(input.id), 120);
      if (!d) throw new Error(`no node ${input.id}`);
      const rel = (items: typeof d.incoming) =>
        cap(items.filter((x) => x.edge.kind !== 'contains').map((x) => ({ edge: x.edge.kind, node: brief(x.node) })));
      return {
        node: { ...brief(d.node), qname: d.node.qname, metrics: d.node.metrics, props: d.node.props },
        summary: summaries?.[d.node.id]?.text,
        parents: d.parents.map(brief),
        incoming: rel(d.incoming),
        outgoing: rel(d.outgoing),
        children: cap(d.children.map(brief)),
      };
    },
  },
  traversal('upstream'),
  traversal('downstream'),
  {
    name: 'path',
    description: 'Shortest dependency path between two nodes (directed if possible, else undirected).',
    inputSchema: {},
    required: ['from', 'to'],
    run: ({ q }, input) => {
      const sg = q.path(String(input.from), String(input.to));
      return {
        found: sg.nodes.length > 0,
        nodes: sg.nodes.map(brief),
        edges: sg.edges.map((e) => `${e.src} -${e.kind}-> ${e.dst}`),
      };
    },
  },
  {
    name: 'endpoints',
    description: 'HTTP/RPC endpoints of the repo with their handlers.',
    inputSchema: {},
    required: [],
    run: ({ q }) =>
      cap(
        q.endpoints().map((e) => ({ ...brief(e.node), handler: brief(e.handler) })),
        80,
      ),
  },
  {
    name: 'trace',
    description:
      'Execution flow of an endpoint: middleware, handler, the calls it makes, down to datastores and externals.',
    inputSchema: {},
    required: ['endpointId'],
    run: ({ q }, input) => {
      const t = q.trace(String(input.endpointId));
      const byId = new Map(t.nodes.map((n) => [n.id, n]));
      return {
        middleware: t.middleware.map((id) => brief(byId.get(id))),
        layers: t.layers.slice(0, 7).map((ids) =>
          cap(
            ids.map((id) => brief(byId.get(id))),
            15,
          ),
        ),
        boundaries: t.boundaries.map((id) => brief(byId.get(id))),
      };
    },
  },
  {
    name: 'subsystems',
    description: 'The inferred subsystems (architectural groups) with member counts and summaries.',
    inputSchema: {},
    required: [],
    run: ({ q, summaries }) =>
      q.subsystems().map((s) => ({ ...brief(s.node), members: s.members, summary: summaries?.[s.node.id]?.text })),
  },
  {
    name: 'diagnostics',
    description: 'Architecture findings: import cycles, layer violations, dead code, god modules, orphans.',
    inputSchema: {},
    required: [],
    run: ({ q }, input) =>
      cap(
        q.diagnostics(typeof input.type === 'string' && input.type ? input.type : undefined).map((d) => ({
          type: d.type,
          severity: d.severity,
          title: d.title,
          nodeIds: d.nodeIds.slice(0, 10),
        })),
      ),
  },
  {
    name: 'source',
    description: 'Source code of a node (its span; whole file for files), up to 200 lines.',
    inputSchema: {},
    required: ['id'],
    run: async ({ q, root }, input) => {
      const n = q.node(String(input.id));
      if (!n?.file) throw new Error('node has no source');
      const base = path.resolve(root);
      const abs = path.resolve(base, n.file);
      if (!abs.startsWith(base + path.sep)) throw new Error('outside the repository');
      const lines = (await fs.readFile(abs, 'utf8')).split('\n');
      const from = n.span && n.kind !== 'file' ? n.span.startLine : 1;
      const to = Math.min(n.span && n.kind !== 'file' ? n.span.endLine : lines.length, from + 199);
      return { file: n.file, from, to, code: lines.slice(from - 1, to).join('\n') };
    },
  },
];

const PROPS: Record<string, Props> = {
  search: {
    query: str('Name, partial name or qualified name.'),
    kinds: str('Optional comma-separated node kinds, e.g. "class,function".'),
    limit: int('Max hits (default 15).'),
  },
  node_detail: { id: str('Node id.') },
  upstream: {
    id: str('Node id.'),
    depth: int('Hops (1-4, default 2).'),
    kinds: str('Optional comma-separated edge kinds.'),
  },
  downstream: {
    id: str('Node id.'),
    depth: int('Hops (1-4, default 2).'),
    kinds: str('Optional comma-separated edge kinds.'),
  },
  path: { from: str('Start node id.'), to: str('End node id.') },
  endpoints: {},
  trace: { endpointId: str('Endpoint node id.') },
  subsystems: {},
  diagnostics: {
    type: { ...str('Optional filter.'), enum: ['cycle', 'dead-code', 'god-module', 'orphan', 'layer-violation'] },
  },
  source: { id: str('Node id.') },
};
for (const t of TOOLS) t.inputSchema = schema(PROPS[t.name], t.required);

/** Tool definitions for a model request. */
export const GRAPH_TOOLS: LlmTool[] = TOOLS.map(({ name, description, inputSchema }) => ({
  name,
  description,
  inputSchema,
}));

/** Input check against the tool's schema (model-supplied input is untrusted and may be truncated). */
function invalid(t: GraphTool, input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'input must be an object';
  const props = PROPS[t.name];
  for (const k of t.required) if ((input as Record<string, unknown>)[k] === undefined) return `missing "${k}"`;
  for (const [k, v] of Object.entries(input)) {
    const p = props[k];
    if (!p) return `unknown field "${k}"`;
    if (p.type === 'string' && typeof v !== 'string') return `"${k}" must be a string`;
    if (p.type === 'integer' && !Number.isInteger(v)) return `"${k}" must be an integer`;
    if (p.enum && !p.enum.includes(String(v))) return `"${k}" must be one of ${p.enum.join(', ')}`;
  }
  return undefined;
}

/** Every string in a result that is a node id. */
function idsIn(v: unknown, q: QueryService, out = new Set<string>()): Set<string> {
  if (typeof v === 'string') {
    if (q.node(v)) out.add(v);
  } else if (Array.isArray(v)) for (const x of v) idsIn(x, q, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) idsIn(x, q, out);
  return out;
}

/** Runs a graph tool; errors come back as `isError` results, never thrown. */
export async function runGraphTool(ctx: ToolContext, name: string, input: unknown): Promise<ToolOutput> {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { text: `unknown tool "${name}"`, nodeIds: [], isError: true };
  const bad = invalid(t, input);
  if (bad) return { text: `invalid input: ${bad}`, nodeIds: [], isError: true };
  try {
    const result = await t.run(ctx, input as Record<string, unknown>);
    return { text: JSON.stringify(result), nodeIds: [...idsIn(result, ctx.q)] };
  } catch (err) {
    return { text: String((err as Error)?.message ?? err), nodeIds: [], isError: true };
  }
}
