import { useQuery } from '@tanstack/react-query';
import Graph from 'graphology';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { fillGraph } from '../build';
import { radialLayout } from '../layout';
import { useStore } from '../store';
import { GraphCanvas } from './GraphCanvas';
import { StatusChip } from './MapView';

export function FocusView({ repoId }: { repoId: string }) {
  const graph = useMemo(() => new Graph({ multi: false, type: 'directed' }), []);
  const [version, setVersion] = useState(0);
  const root = useStore((s) => s.selected);
  const depth = useStore((s) => s.focusDepth);
  const setFocusDepth = useStore((s) => s.setFocusDepth);
  const hovered = useStore((s) => s.hovered);
  const hidden = useStore((s) => s.hidden);
  const hideAmbiguous = useStore((s) => s.filters.hideAmbiguous);
  const edgeKinds = useStore((s) => s.filters.edgeKinds);
  const fitNonce = useStore((s) => s.fitNonce);
  const select = useStore((s) => s.select);
  const setHovered = useStore((s) => s.setHovered);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const setView = useStore((s) => s.setView);

  const query = useQuery({
    queryKey: ['neighbors', repoId, root, depth, edgeKinds.join(',')],
    queryFn: () => api.neighbors(repoId, root!, depth, edgeKinds),
    enabled: Boolean(root),
    placeholderData: (prev) => prev,
  });
  const data = query.data;

  useEffect(() => {
    if (!data || !root) {
      fillGraph(graph, undefined);
      setVersion((v) => v + 1);
      return;
    }
    const positions = radialLayout(data.nodes, data.edges, root, data.distances ?? {});
    fillGraph(graph, data, { hidden: new Set(hidden), hideAmbiguous, positions });
    setVersion((v) => v + 1);
  }, [graph, data, root, hidden, hideAmbiguous]);

  if (!root)
    return (
      <div className="view-fill">
        <div className="canvas-empty">
          <div className="empty-title">Focus needs a selection</div>
          <div className="empty-sub">Pick a node on the Map, in the tree, or with ⌘K, then switch to Focus.</div>
        </div>
      </div>
    );

  return (
    <div className="view-fill">
      <GraphCanvas
        graph={graph}
        version={version}
        fitNonce={fitNonce}
        selected={root}
        hovered={hovered}
        draggable
        onSelect={(id) => {
          if (id) select(id);
        }}
        onHover={setHovered}
        onDoubleClick={(id) => {
          select(id);
          setView('map');
          useStore.getState().setCenterOn(id);
        }}
        onContext={(id, x, y) => openContextMenu({ nodeId: id, x, y })}
      />
      <div className="view-controls">
        <span className="view-controls-label">Focus · depth</span>
        <Stepper value={depth} min={1} max={3} onChange={setFocusDepth} />
        <span className="hint">incoming on the left · outgoing on the right</span>
      </div>
      <StatusChip data={data} loading={query.isFetching} error={query.error} />
      {query.isError && (
        <div className="canvas-empty">
          <div className="empty-title">Could not load the neighbourhood</div>
          <div className="empty-sub">{String((query.error as Error).message)}</div>
        </div>
      )}
    </div>
  );
}

export function Stepper({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <span className="stepper">
      <button type="button" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label="decrease">
        −
      </button>
      <span className="stepper-value">{value}</span>
      <button type="button" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label="increase">
        +
      </button>
    </span>
  );
}
