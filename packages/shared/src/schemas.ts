/**
 * Query-string schemas for the HTTP API (zod). The server validates with them; the web app can use
 * the inferred types (and `parseQuery`) to build requests.
 */
import { z } from 'zod';
import { EDGE_KINDS, type EdgeKind, NODE_KINDS, type NodeKind } from './kinds.js';

export const MAX_DEPTH = 6;
export const MAX_LIMIT = 100;

/** Comma-separated list, e.g. `edgeKinds=imports,calls`. Empty → undefined. */
const csv = <T extends z.ZodTypeAny>(item: T) =>
  z
    .string()
    .transform((v) => v.split(',').filter(Boolean))
    .pipe(z.array(item))
    .transform((v) => (v.length ? v : undefined))
    .optional();

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true')
  .optional();
const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const edgeKind = z.enum(EDGE_KINDS as [EdgeKind, ...EdgeKind[]]);
const nodeKind = z.enum(NODE_KINDS as [NodeKind, ...NodeKind[]]);

export const viewLevelSchema = z.enum(['L0', 'L1', 'L2', 'L3']);

/** `GET /repos/:id/graph` → `ProjectionRequest`. */
export const graphQuerySchema = z.object({
  level: viewLevelSchema.default('L1'),
  expanded: csv(z.string()),
  edgeKinds: csv(edgeKind),
  nodeKinds: csv(nodeKind),
  languages: csv(z.string()),
  includeTests: bool,
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  minWeight: z.coerce.number().min(0).optional(),
  focus: z.string().min(1).optional(),
  focusDepth: int(0, MAX_DEPTH).optional(),
});

/** `upstream`, `downstream`, `neighbors`, `trace`. */
export const traversalQuerySchema = z.object({
  depth: int(1, MAX_DEPTH).optional(),
  kinds: csv(edgeKind),
});

export const searchQuerySchema = z.object({
  q: z.string().default(''),
  kinds: csv(nodeKind),
  limit: int(1, MAX_LIMIT).default(25),
});

export const pathQuerySchema = z.object({
  from: z.string({ required_error: 'required' }).min(1, 'required'),
  to: z.string({ required_error: 'required' }).min(1, 'required'),
  kinds: csv(edgeKind),
});

export const endpointsQuerySchema = z.object({ includeTests: bool });

export const diagnosticsQuerySchema = z.object({
  type: z.enum(['cycle', 'dead-code', 'god-module', 'orphan', 'layer-violation']).optional(),
});

export const treeQuerySchema = z.object({
  node: z.string().min(1).default('repo'),
  depth: int(1, MAX_DEPTH).default(1),
});

export const sourceQuerySchema = z.object({ context: int(0, 1000).default(5) });

export const exportFormatSchema = z.enum(['json', 'dot', 'graphml']);
export const exportQuerySchema = z.object({ format: exportFormatSchema.default('json') });

/** `GET /repos/:id/matrix`. */
export const matrixQuerySchema = z.object({
  level: z.enum(['L1', 'L2']).default('L1'),
  expanded: csv(z.string()),
  includeTests: bool,
});

/** `GET /repos/:id/report`. */
export const reportQuerySchema = z.object({ format: z.enum(['md']).default('md') });

/** `GET /remote/refs`. */
export const remoteRefsQuerySchema = z.object({
  source: z.string({ required_error: 'required' }).min(1, 'required'),
});

/** `PUT /repos/:id/overrides` body (`SubsystemOverrides`); missing fields default to empty. */
export const subsystemOverridesSchema = z
  .object({
    rename: z.record(z.string().min(1), z.string().min(1).max(200)).default({}),
    merge: z.array(z.array(z.string().min(1)).min(2)).default([]),
    pins: z.record(z.string().min(1), z.string().min(1)).default({}),
  })
  .strict();

/** `POST /repos/:id/summaries` body (C-23). */
export const summarizeBodySchema = z
  .object({
    nodeIds: z.array(z.string().min(1)).min(1).max(500).optional(),
    limit: z.number().int().min(1).max(500).optional(),
    force: z.boolean().optional(),
  })
  .strict();

/** `POST /repos/:id/ask` body (C-24). */
export const askBodySchema = z
  .object({
    question: z.string().trim().min(1).max(4000),
    history: z
      .array(z.object({ question: z.string().max(4000), answer: z.string().max(20000) }).strict())
      .max(20)
      .default([]),
  })
  .strict();

export type GraphQuery = z.infer<typeof graphQuerySchema>;
export type TraversalQuery = z.infer<typeof traversalQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type PathQuery = z.infer<typeof pathQuerySchema>;
export type TreeQuery = z.infer<typeof treeQuerySchema>;
export type ExportFormat = z.infer<typeof exportFormatSchema>;
export type MatrixQuery = z.infer<typeof matrixQuerySchema>;

/** Parses a query object; on failure returns a single readable message such as `depth: must be ≤ 6`. */
export function parseQuery<S extends z.ZodTypeAny>(
  schema: S,
  query: unknown,
): { ok: true; data: z.output<S> } | { ok: false; error: string } {
  const r = schema.safeParse(query ?? {});
  if (r.success) return { ok: true, data: r.data };
  const error = r.error.issues.map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
  return { ok: false, error };
}
