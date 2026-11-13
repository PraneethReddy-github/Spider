import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Graph from 'graphology';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { nodeLabel } from '../format';
import { GraphCanvas } from '../graph/GraphCanvas';
import { animatePositions, dropTests, encodeGraph } from '../graph/encode';
import { useMarks, useReveal } from '../hooks';
import { radialLayout } from '../layout/views';
import { useStore } from '../store';
import { EmptyState, Stepper } from '../ui';
import { StatusChip } from './MapView';

/** Radial neighbourhood of the selection: incoming on the left half, outgoing on the right. */
export function FocusView({ repoId }: { repoId: string }) {
  const graph = useMemo(() => new Graph({ multi: true, type: 'directed' }), []);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const s = useStore();
  const root = s.selected;
  const marks = useMarks(repoId);
  const reveal = useReveal();

  const query = useQuery({
    queryKey: ['neighbors', repoId, root, s.focusDepth, s.filters.edgeKinds.join(',')],
    queryFn: () => api.neighbors(repoId, root as string, s.focusDepth, s.filters.edgeKinds),
    enabled: Boolean(root),
    placeholderData: keepPreviousData,
  });
  const { sg: data, dropped } = useMemo(
    () => (query.data && !s.filters.includeTests ? dropTests(query.data, root) : { sg: query.data, dropped: 0 }),
    [query.data, s.filters.includeTests, root],
  );

  useEffect(() => {
    if (!data || !root) {
      encodeGraph(graph, undefined, { theme: s.theme });
      return;
    }
    const enc = encodeGraph(graph, data, {
      theme: s.theme,
      hidden: new Set(s.hidden),
      hideAmbiguous: s.filters.hideAmbiguous,
      labelAll: true,
      marks,
    });
    const pos = radialLayout(enc.nodes, enc.edges, root, data.distances ?? {});
    const cancel = animatePositions(graph, pos, 0);
    setLayoutVersion((v) => v + 1);
    return cancel;
  }, [graph, data, root, s.theme, s.hidden, s.filters.hideAmbiguous, marks]);

  if (!root)
    return (
      <div className="canvas-empty">
        <EmptyState
          title="Focus needs a selection"
          body="Select a node on the map, in the explorer, or with ⌘K."
          action={{ label: 'Back to map', onClick: () => s.setView('map') }}
        />
      </div>
    );

  const rootNode = data?.nodes.find((n) => n.id === root);
  return (
    <>
      <GraphCanvas
        graph={graph}
        theme={s.theme}
        selected={root}
        hovered={s.hovered}
        layoutVersion={layoutVersion}
        fitNonce={s.fitNonce}
        onClickNode={(id) => s.select(id)}
        onDoubleClickNode={(id) => void reveal(id)}
        onContextNode={(id, x, y) => s.openContextMenu({ nodeId: id, x, y })}
        onHover={s.setHovered}
      />
      <div className="overlay view-header">
        <span className="title ellipsis">Focus · {rootNode ? nodeLabel(rootNode) : '…'}</span>
        <span className="tone-3">Depth</span>
        <Stepper label="depth" value={s.focusDepth} min={1} max={3} onChange={s.setFocusDepth} />
        <span className="tone-3">Incoming left · outgoing right</span>
      </div>
      <StatusChip data={data} loading={query.isFetching} />
      {query.isError && (
        <div className="canvas-empty">
          <EmptyState
            title="Could not load the neighbourhood"
            body={(query.error as Error).message}
            action={{ label: 'Retry', onClick: () => void query.refetch() }}
          />
        </div>
      )}
      {data && data.nodes.length <= 1 && (
        <div className="canvas-empty">
          {dropped > 0 ? (
            <EmptyState
              title="Only test code is connected"
              body={`${dropped} related ${dropped === 1 ? 'node is' : 'nodes are'} in test files, which are hidden.`}
              action={{ label: 'Include tests', onClick: () => s.setFilters({ includeTests: true }) }}
            />
          ) : (
            <EmptyState title="No relationships" body="Nothing connects to this node through the enabled edge kinds." />
          )}
        </div>
      )}
    </>
  );
}
