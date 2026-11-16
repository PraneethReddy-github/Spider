/**
 * Graph diff between two revisions of a repository (`GET /repos/:id/diff`, `spider diff`).
 * Nodes and edges are matched by their deterministic ids.
 */
import { z } from 'zod';
import type { Diagnostic } from './index.js';
import type { EdgeKind, NodeKind } from './kinds.js';

export interface DiffNodeRef {
  id: string;
  kind: NodeKind;
  name: string;
  qname?: string;
  file?: string;
}

/** A node present on both sides whose name, parent, span length, size metrics or props differ. */
export interface DiffNodeChange extends DiffNodeRef {
  /** field → [base, head], e.g. `{ 'metrics.loc': [12, 30], span: ['4-15', '4-33'] }`. */
  changes: Record<string, [unknown, unknown]>;
}

export interface DiffEdgeRef {
  id: string;
  kind: EdgeKind;
  src: string;
  dst: string;
  /** Occurrences (call sites, imported names) behind the edge. */
  weight: number;
  /** Readable endpoints (qname, else file, else name). */
  srcLabel: string;
  dstLabel: string;
}

export interface DiffSide {
  /** The ref as given (`main`, `HEAD~1`), or `working tree`. */
  ref: string;
  commit?: string;
}

export interface GraphDiffSummary {
  nodesAdded: number;
  nodesRemoved: number;
  nodesChanged: number;
  edgesAdded: number;
  edgesRemoved: number;
  filesAdded: number;
  filesRemoved: number;
  filesChanged: number;
  newCycles: number;
  resolvedCycles: number;
  newViolations: number;
  resolvedViolations: number;
}

export interface GraphDiff {
  base: DiffSide;
  head: DiffSide;
  nodes: { added: DiffNodeRef[]; removed: DiffNodeRef[]; changed: DiffNodeChange[] };
  /** Relationship edges only (`contains`, `exports` and `member_of` follow from node changes). */
  edges: { added: DiffEdgeRef[]; removed: DiffEdgeRef[] };
  diagnostics: {
    newCycles: Diagnostic[];
    resolvedCycles: Diagnostic[];
    newViolations: Diagnostic[];
    resolvedViolations: Diagnostic[];
  };
  summary: GraphDiffSummary;
  /** Containment chain (parent first, up to `repo`) of every node id referenced above. */
  ancestors: Record<string, string[]>;
}

/** A git revision; must not look like an option. */
export const gitRefSchema = z
  .string({ required_error: 'required' })
  .min(1, 'required')
  .max(200)
  .regex(/^(?!-)[\w./@^~{}+-]+$/, 'not a valid git ref');

/** `GET /repos/:id/diff`. */
export const diffQuerySchema = z.object({ base: gitRefSchema, head: gitRefSchema.optional() });
export type DiffQuery = z.infer<typeof diffQuerySchema>;
