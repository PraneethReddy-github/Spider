import type { SubGraph } from '@spider/shared';
import { useQuery } from '@tanstack/react-query';
import Graph from 'graphology';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { fillGraph } from '../build';
import { mapVisible } from '../hooks';
import { layoutMap, loadPositions, savePositions } from '../layout';
import { useStore } from '../store';
import { CONTAINERS } from '../theme';
import { GraphCanvas } from './GraphCanvas';

export function useProjection(repoId: string) {
  const level = useStore((s) => s.level);
  const expanded = useStore((s) => s.expanded);
  const filters = useStore((s) => s.filters);
  return useQuery({
    queryKey: ['graph', repoId, level, expanded.join(','), filters.edgeKinds.join(','), filters.nodeKinds?.join(',') ?? '*', filters.includeTests, filters.minConfidence, filters.minWeight],
    queryFn: () =>
      api.graph(repoId, {
        level,
        expanded,
        edgeKinds: filters.edgeKinds,
        nodeKinds: filters.nodeKinds,
        includeTests: filters.includeTests,
        minConfidence: filters.minConfidence || undefined,
        minWeight: filters.minWeight || undefined,
      }),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });
}

export function MapView({ repoId, onDoubleClick }: { repoId: string; onDoubleClick: (id: string, isContainer: boolean) => void }) {
  const graph = useMemo(() => new Graph({ multi: false, type: 'directed' }), []);
  const [version, setVersion] = useState(0);
  const [laying, setLaying] = useState(false);
  const query = useProjection(repoId);
  const level = useStore((s) => s.level);
  const hidden = useStore((s) => s.hidden);
  const hideAmbiguous = useStore((s) => s.filters.hideAmbiguous);
  const selected = useStore((s) => s.selected);
  const hovered = useStore((s) => s.hovered);
  const centerOn = useStore((s) => s.centerOn);
  const fitNonce = useStore((s) => s.fitNonce);
  const select = useStore((s) => s.select);
  const setHovered = useStore((s) => s.setHovered);
  const setCenterOn = useStore((s) => s.setCenterOn);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const cancelRef = useRef<() => void>(() => {});
  const data = query.data;

  useEffect(() => {
    cancelRef.current();
    const hiddenSet = new Set(hidden);
    const known = loadPositions(repoId);
    graph.forEachNode((id, a) => {
      known[id] = { x: a.x, y: a.y };
    });
    const { nodes } = fillGraph(graph, data, { level, hidden: hiddenSet, hideAmbiguous, positions: {} });
    mapVisible.ids = new Set(nodes.map((n) => n.id));
    if (nodes.length === 0) {
      setVersion((v) => v + 1);
      return;
    }
    setLaying(true);
    cancelRef.current = layoutMap(graph, known, () => {
      graph.forEachNode((id) => graph.removeNodeAttribute(id, 'fixed'));
      savePositions(repoId, graph);
      setLaying(false);
      setVersion((v) => v + 1);
    });
    return () => cancelRef.current();
  }, [graph, data, level, hidden, hideAmbiguous, repoId]);

  const nodeIndex = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n])), [data]);
  const truncated = Boolean(data?.meta?.truncated);
  const visibleEdges = graph.size;

  return (
    <div className="view-fill">
      <GraphCanvas
        graph={graph}
        version={version}
        fitNonce={fitNonce}
        selected={selected}
        hovered={hovered}
        centerOn={centerOn}
        draggable
        onCentered={() => setCenterOn(undefined)}
        onDragEnd={() => savePositions(repoId, graph)}
        onSelect={select}
        onHover={setHovered}
        onDoubleClick={(id) => {
          const n = nodeIndex.get(id);
          if (!n) return;
          const isContainer = Number(n.props.childCount ?? 0) > 0 || (CONTAINERS.has(n.kind) && n.kind !== 'file');
          onDoubleClick(id, isContainer);
        }}
        onContext={(id, x, y) => openContextMenu({ nodeId: id, x, y })}
      />
      <StatusChip data={data} loading={query.isFetching || laying} error={query.error} truncated={truncated} edges={visibleEdges} />
      {query.isError && (
        <div className="canvas-empty">
          <div className="empty-title">Could not load the projection</div>
          <div className="empty-sub">{String((query.error as Error).message)}</div>
        </div>
      )}
      {!query.isError && data && data.nodes.length === 0 && (
        <div className="canvas-empty">
          <div className="empty-title">Nothing to show at this level</div>
          <div className="empty-sub">Try another level, enable more edge or node kinds, or include tests.</div>
        </div>
      )}
    </div>
  );
}

export function StatusChip({ data, loading, error, truncated, edges, label }: { data?: SubGraph; loading: boolean; error: unknown; truncated?: boolean; edges?: number; label?: string }) {
  if (error) return null;
  const n = data?.nodes.length ?? 0;
  const m = edges ?? data?.edges.length ?? 0;
  return (
    <div className="status-chip">
      {label && <span className="status-label">{label}</span>}
      {loading && <span className="spinner" aria-label="loading" />}
      <span>
        {n.toLocaleString()} nodes · {m.toLocaleString()} edges
      </span>
      {truncated && <span className="chip-warn" title="The projection was truncated by the server's node limit">truncated</span>}
    </div>
  );
}
