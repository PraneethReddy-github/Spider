import type { GraphNode, SubGraph } from '@spider/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from './api';
import { useStore } from './store';

/** Ids of the nodes currently drawn on the Map (kept outside React state; read on demand). */
export const mapVisible = { ids: new Set<string>() };

/**
 * Select a node and make sure the Map shows it: if it isn't in the current projection, expand its
 * ancestors (nearest first, up to the first one that is already visible), then centre on it.
 */
export function useReveal() {
  const qc = useQueryClient();
  return useCallback(
    async (id: string, opts: { view?: 'map' | 'focus'; keepView?: boolean } = {}) => {
      const s = useStore.getState();
      const repoId = s.repoId;
      if (!repoId) return;
      s.select(id);
      const view = opts.view ?? (opts.keepView ? s.view : 'map');
      if (view !== s.view) s.setView(view);
      if (view !== 'map') return;
      if (!mapVisible.ids.has(id)) {
        try {
          const detail = await qc.fetchQuery({ queryKey: ['node', repoId, id], queryFn: () => api.node(repoId, id), staleTime: 60_000 });
          const toExpand: string[] = [];
          for (const p of detail.parents) {
            if (p.id === 'repo' || p.kind === 'repository') break;
            toExpand.push(p.id);
            if (mapVisible.ids.has(p.id)) break;
          }
          if (toExpand.length) useStore.getState().expandMany(toExpand);
        } catch {
          /* node may not exist any more */
        }
      }
      useStore.getState().setCenterOn(id);
    },
    [qc],
  );
}

export function nodeById(sg: SubGraph | undefined, id: string | undefined): GraphNode | undefined {
  if (!sg || !id) return undefined;
  return sg.nodes.find((n) => n.id === id);
}

export function fmtNum(n: number | undefined): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '–';
  if (Math.abs(n) >= 1000) return n.toLocaleString();
  return Number.isInteger(n) ? String(n) : n.toFixed(3);
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortSource(src: string): string {
  return src.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
}
