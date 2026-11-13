import type { Diagnostic, GraphNode } from '@spider/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { api } from './api';
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

/** Diagnostic rings: cycles in danger, god modules in warn. */
export function useMarks(repoId: string): Map<string, 'danger' | 'warn'> {
  const { data } = useDiagnostics(repoId);
  return useMemo(() => marksFrom(data ?? []), [data]);
}

export function marksFrom(diags: Diagnostic[]): Map<string, 'danger' | 'warn'> {
  const m = new Map<string, 'danger' | 'warn'>();
  for (const d of diags) {
    if (d.type === 'cycle') for (const id of d.nodeIds) m.set(id, 'danger');
    else if (d.type === 'god-module') for (const id of d.nodeIds) if (!m.has(id)) m.set(id, 'warn');
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
