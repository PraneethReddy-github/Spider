import type { GraphDiff, GraphEdge, GraphNode, RemoteRefs, SubGraph } from '@spider/shared';
import { useMemo } from 'react';
import { create } from 'zustand';
import { useStore } from './store';

export type Mark = 'danger' | 'warn' | 'ok';

/** Compare mode: the panel, the chosen base ref and the diff it produced. */
interface DiffState {
  open: boolean;
  base?: string;
  diff?: GraphDiff;
  setOpen: (open: boolean) => void;
  setResult: (base: string | undefined, diff: GraphDiff | undefined) => void;
}

export const useDiff = create<DiffState>((set) => ({
  open: false,
  setOpen: (open) => set(open ? { open } : { open, base: undefined, diff: undefined }),
  setResult: (base, diff) => set({ base, diff }),
}));

async function get<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('Spider server is not reachable. Start it with `spider serve`.');
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const diffApi = {
  refs: (repoId: string) => get<RemoteRefs>(`/api/v1/repos/${encodeURIComponent(repoId)}/refs`),
  diff: (repoId: string, base: string) =>
    get<GraphDiff>(`/api/v1/repos/${encodeURIComponent(repoId)}/diff?base=${encodeURIComponent(base)}`),
};

/**
 * Lays a diff over a projection: removed nodes come back as ghosts where their siblings are shown,
 * removed edges between visible nodes come back as ghost edges, and every change marks its nearest
 * visible node (added → ok, removed only → danger). Added edges tag the projected edge they roll up into.
 */
export function overlayDiff(
  sg: SubGraph,
  d: GraphDiff,
  edgeKinds?: string[],
): { sg: SubGraph; marks: Map<string, Mark> } {
  const shownChildren = new Map<string, unknown>(); // parent id → view parent of its shown children
  for (const n of sg.nodes) if (n.parentId) shownChildren.set(n.parentId, n.props.viewParent);
  const ghosts: GraphNode[] = [];
  for (const r of d.nodes.removed) {
    const parent = d.ancestors[r.id]?.[0];
    if (!parent || !shownChildren.has(parent)) continue;
    ghosts.push({
      ...r,
      parentId: parent,
      props: { ghost: true, childCount: 0, viewParent: shownChildren.get(parent) },
    });
  }
  const nodes = [...sg.nodes, ...ghosts];
  const ids = new Set(nodes.map((n) => n.id));
  const visible = (id: string) => [id, ...(d.ancestors[id] ?? [])].find((x) => ids.has(x));

  const marks = new Map<string, Mark>();
  for (const n of d.nodes.added) {
    const v = visible(n.id);
    if (v) marks.set(v, 'ok');
  }
  for (const n of d.nodes.removed) {
    const v = visible(n.id);
    if (v && !marks.has(v)) marks.set(v, 'danger');
  }

  const pair = (kind: string, a: string, b: string) => `${kind}|${a}|${b}`;
  // a projected edge is new only when added edges account for all of its weight
  const addedWeight = new Map<string, number>();
  for (const e of d.edges.added) {
    const a = visible(e.src);
    const b = visible(e.dst);
    const key = a && b ? pair(e.kind, a, b) : '';
    if (key) addedWeight.set(key, (addedWeight.get(key) ?? 0) + e.weight);
  }
  const edges: GraphEdge[] = sg.edges.map((e) =>
    (addedWeight.get(pair(e.kind, e.src, e.dst)) ?? 0) >= e.weight ? { ...e, props: { ...e.props, diff: 'added' } } : e,
  );
  const present = new Set(edges.map((e) => pair(e.kind, e.src, e.dst)));
  for (const e of d.edges.removed) {
    if (edgeKinds && !edgeKinds.includes(e.kind)) continue;
    const a = visible(e.src);
    const b = visible(e.dst);
    const key = a && b ? pair(e.kind, a, b) : '';
    if (!a || !b || a === b || present.has(key)) continue;
    present.add(key);
    edges.push({
      id: `removed|${key}`,
      kind: e.kind,
      src: a,
      dst: b,
      weight: 1,
      confidence: 0.5,
      props: { diff: 'removed' },
    });
  }
  return { sg: { ...sg, nodes, edges }, marks };
}

/** Map hook: the projection with the active diff laid over it, and the rings to draw (diff rings replace diagnostics). */
export function useDiffOverlay(
  data: SubGraph | undefined,
  diagnostics: Map<string, Mark>,
): { data: SubGraph | undefined; marks: Map<string, Mark> } {
  const diff = useDiff((s) => s.diff);
  const edgeKinds = useStore((s) => s.filters.edgeKinds);
  return useMemo(() => {
    if (!diff || !data) return { data, marks: diagnostics };
    const o = overlayDiff(data, diff, edgeKinds);
    return { data: o.sg, marks: o.marks };
  }, [data, diff, diagnostics, edgeKinds]);
}
