import { useQuery } from '@tanstack/react-query';
import Graph from 'graphology';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { fillGraph } from '../build';
import { layeredLayout } from '../layout';
import { type FlowQuery, useStore } from '../store';
import { Stepper } from './FocusView';
import { StatusChip } from './MapView';

function describe(q: FlowQuery, name: (id: string) => string): string {
  switch (q.type) {
    case 'upstream':
      return `Upstream of ${name(q.id)}`;
    case 'downstream':
      return `Downstream of ${name(q.id)}`;
    case 'trace':
      return `Trace of ${name(q.id)}`;
    case 'path':
      return `Path ${name(q.from)} → ${name(q.to)}`;
  }
}

export function FlowView({ repoId }: { repoId: string }) {
  const graph = useMemo(() => new Graph({ multi: false, type: 'directed' }), []);
  const [version, setVersion] = useState(0);
  const q = useStore((s) => s.flowQuery);
  const setFlowQuery = useStore((s) => s.setFlowQuery);
  const selected = useStore((s) => s.selected);
  const hovered = useStore((s) => s.hovered);
  const hidden = useStore((s) => s.hidden);
  const hideAmbiguous = useStore((s) => s.filters.hideAmbiguous);
  const edgeKinds = useStore((s) => s.filters.edgeKinds);
  const fitNonce = useStore((s) => s.fitNonce);
  const select = useStore((s) => s.select);
  const setHovered = useStore((s) => s.setHovered);
  const setView = useStore((s) => s.setView);
  const openContextMenu = useStore((s) => s.openContextMenu);

  const query = useQuery({
    queryKey: ['flow', repoId, JSON.stringify(q), edgeKinds.join(',')],
    queryFn: async () => {
      if (!q) return undefined;
      switch (q.type) {
        case 'upstream':
          return api.upstream(repoId, q.id, q.depth, edgeKinds);
        case 'downstream':
          return api.downstream(repoId, q.id, q.depth, edgeKinds);
        case 'trace':
          return api.trace(repoId, q.id, q.depth);
        case 'path': {
          const sg = await api.path(repoId, q.from, q.to);
          // path nodes are ordered: column = index
          const distances: Record<string, number> = {};
          sg.nodes.forEach((n, i) => (distances[n.id] = i));
          return { ...sg, distances };
        }
      }
    },
    enabled: Boolean(q),
    placeholderData: (prev) => prev,
  });
  const data = query.data;

  useEffect(() => {
    if (!data) {
      fillGraph(graph, undefined);
      setVersion((v) => v + 1);
      return;
    }
    const positions = layeredLayout(data.nodes, data.edges, data.distances);
    fillGraph(graph, data, { hidden: new Set(hidden), hideAmbiguous, positions });
    setVersion((v) => v + 1);
  }, [graph, data, hidden, hideAmbiguous]);

  if (!q)
    return (
      <div className="view-fill">
        <div className="canvas-empty">
          <div className="empty-title">No flow query yet</div>
          <div className="empty-sub">Run Upstream, Downstream, Trace or Path from the Details panel, the context menu, or with U / D.</div>
        </div>
      </div>
    );

  const nameOf = (id: string) => data?.nodes.find((n) => n.id === id)?.name ?? id;
  const empty = data && data.nodes.length === 0;
  const pathNotFound = q.type === 'path' && data && data.meta && (data.meta as { found?: boolean }).found === false;

  return (
    <div className="view-fill">
      <GraphCanvas
        graph={graph}
        version={version}
        fitNonce={fitNonce}
        selected={selected}
        hovered={hovered}
        draggable
        onSelect={select}
        onHover={setHovered}
        onDoubleClick={(id) => {
          select(id);
          setView('map');
          useStore.getState().setCenterOn(id);
        }}
        onContext={(id, x, y) => openContextMenu({ nodeId: id, x, y })}
      />
      <div className="view-controls">
        <span className="view-controls-label">{describe(q, nameOf)}</span>
        {q.type !== 'path' && (
          <>
            <span className="hint">depth</span>
            <Stepper value={q.depth} min={1} max={q.type === 'trace' ? 10 : 5} onChange={(d) => setFlowQuery({ ...q, depth: d })} />
          </>
        )}
        <span className="hint">left → right by distance</span>
      </div>
      <StatusChip data={data} loading={query.isFetching} error={query.error} />
      {(empty || pathNotFound) && (
        <div className="canvas-empty">
          <div className="empty-title">{q.type === 'path' ? 'No path between these nodes' : 'Nothing reachable'}</div>
          <div className="empty-sub">{q.type === 'path' ? 'Neither direction connects them through the enabled edge kinds.' : 'Try a larger depth or enable more edge kinds.'}</div>
        </div>
      )}
      {query.isError && (
        <div className="canvas-empty">
          <div className="empty-title">Query failed</div>
          <div className="empty-sub">{String((query.error as Error).message)}</div>
        </div>
      )}
    </div>
  );
}
