import type { GraphNode } from '@spider/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { type AnyDiagnostic, type Overrides, api } from './api';
import { editorUrl } from './editor';
import { type ViewMode, useStore } from './store';

/** Ids currently drawn on the Map (kept outside React state; read on demand). */
export const mapVisible = { ids: new Set<string>() };

/**
 * Select a node and make sure the Map shows it: when it isn't in the current projection, expand
 * its ancestors (nearest first, up to the first one already visible), then centre on it.
 */
export function useReveal() {
  const qc = useQueryClient();
  return useCallback(
    async (id: string, opts: { view?: ViewMode } = {}) => {
      const s = useStore.getState();
      const repoId = s.repoId;
      if (!repoId) return;
      s.select(id);
      const view = opts.view ?? 'map';
      if (view !== s.view) s.setView(view);
      if (view !== 'map') return;
      if (!mapVisible.ids.has(id)) {
        try {
          const detail = await qc.fetchQuery({
            queryKey: ['node', repoId, id],
            queryFn: () => api.node(repoId, id),
            staleTime: 60_000,
          });
          const toExpand: string[] = [];
          for (const p of detail.parents) {
            if (p.id === 'repo' || p.kind === 'repository') break;
            toExpand.push(p.id);
            if (mapVisible.ids.has(p.id)) break;
          }
          if (toExpand.length) useStore.getState().expandMany(toExpand);
        } catch {
          /* node no longer exists: selection stays, nothing to expand */
        }
      }
      useStore.getState().setCenterOn(id);
    },
    [qc],
  );
}

export function useDiagnostics(repoId: string) {
  return useQuery({ queryKey: ['diagnostics', repoId], queryFn: () => api.diagnostics(repoId), staleTime: 5 * 60_000 });
}

/**
 * Reveals several nodes on the Map at once (diagnostics): expands every needed ancestor, selects the
 * first and centres on it. Capped so a huge diagnostic doesn't expand the whole repo.
 */
export function useRevealMany() {
  const qc = useQueryClient();
  return useCallback(
    async (ids: string[]) => {
      const s = useStore.getState();
      const repoId = s.repoId;
      if (!repoId || !ids.length) return;
      s.select(ids[0]);
      if (s.view !== 'map') s.setView('map');
      const details = await Promise.all(
        ids
          .slice(0, 24)
          .map((id) =>
            qc
              .fetchQuery({ queryKey: ['node', repoId, id], queryFn: () => api.node(repoId, id), staleTime: 60_000 })
              .catch(() => undefined),
          ),
      );
      const toExpand: string[] = [];
      for (const d of details) {
        if (!d || mapVisible.ids.has(d.node.id)) continue;
        for (const p of d.parents) {
          if (p.id === 'repo' || p.kind === 'repository') break;
          toExpand.push(p.id);
          if (mapVisible.ids.has(p.id)) break;
        }
      }
      if (toExpand.length) useStore.getState().expandMany(toExpand);
      useStore.getState().setCenterOn(ids[0]);
    },
    [qc],
  );
}

export const EMPTY_OVERRIDES: Overrides = { rename: {}, merge: [], pins: {} };

export function useOverrides(repoId: string) {
  return useQuery({ queryKey: ['overrides', repoId], queryFn: () => api.overrides(repoId), retry: false });
}

/** Saves subsystem overrides (read-modify-write on the latest copy) and refreshes everything derived from them. */
export function useSaveOverrides(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (update: (o: Overrides) => Overrides) => {
      const cur = await qc.fetchQuery({ queryKey: ['overrides', repoId], queryFn: () => api.overrides(repoId) });
      const next = update({ ...EMPTY_OVERRIDES, ...cur });
      await api.saveOverrides(repoId, next);
      return next;
    },
    onSuccess: (next) => {
      qc.setQueryData(['overrides', repoId], next);
      for (const key of ['graph', 'subsystems', 'diagnostics', 'node', 'matrix', 'tree'])
        void qc.invalidateQueries({ queryKey: [key, repoId] });
    },
    onError: (e: Error) => useStore.getState().notify(`Could not save: ${e.message}`),
  });
}

/** Diagnostic rings: cycles in danger, god modules and layer violations in warn. */
export function useMarks(repoId: string): Map<string, 'danger' | 'warn'> {
  const { data } = useDiagnostics(repoId);
  return useMemo(() => marksFrom(data ?? []), [data]);
}

export function marksFrom(diags: AnyDiagnostic[]): Map<string, 'danger' | 'warn'> {
  const m = new Map<string, 'danger' | 'warn'>();
  for (const d of diags) {
    if (d.type === 'cycle') for (const id of d.nodeIds) m.set(id, 'danger');
    else if (d.type === 'god-module' || d.type === 'layer-violation')
      for (const id of d.nodeIds) if (!m.has(id)) m.set(id, 'warn');
  }
  return m;
}

export function useNodeDetail(repoId: string, id: string | undefined) {
  return useQuery({
    queryKey: ['node', repoId, id],
    queryFn: () => api.node(repoId, id as string),
    enabled: Boolean(id),
    staleTime: 60_000,
  });
}

export function useRepo(repoId: string) {
  return useQuery({ queryKey: ['repo', repoId], queryFn: () => api.repo(repoId), retry: false });
}

/** "Open in editor" deep link for a node, per the user's editor setting (undefined = unavailable). */
export function useEditorUrl(repoId: string, node: GraphNode | undefined): string | undefined {
  const scheme = useStore((s) => s.editor);
  const root = useRepo(repoId).data?.root;
  return node ? editorUrl(scheme, root, node) : undefined;
}
