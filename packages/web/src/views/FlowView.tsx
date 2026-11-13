import type { GraphNode } from '@spider/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Graph from 'graphology';
import { Map as MapIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { type SubGraphWithDistances, api } from '../api';
import { fmtNum, nodeLabel } from '../format';
import { GraphCanvas } from '../graph/GraphCanvas';
import { animatePositions, dropTests, encodeGraph } from '../graph/encode';
import { useMarks, useNodeDetail, useReveal } from '../hooks';
import { elkLayered } from '../layout/elk';
import { layeredLayout } from '../layout/views';
import { type FlowQuery, useStore } from '../store';
import { EmptyState, Stepper } from '../ui';
import { StatusChip } from './MapView';

async function runFlow(repoId: string, q: FlowQuery, edgeKinds: string[]): Promise<SubGraphWithDistances> {
  switch (q.type) {
    case 'upstream':
      return api.upstream(repoId, q.id, q.depth, edgeKinds);
    case 'downstream':
      return api.downstream(repoId, q.id, q.depth, edgeKinds);
    case 'trace':
      return api.trace(repoId, q.id, q.depth);
    case 'path': {
      const sg = await api.path(repoId, q.from, q.to);
      const distances: Record<string, number> = {};
      sg.nodes.forEach((n, i) => {
        distances[n.id] = i;
      });
      return { ...sg, distances };
    }
  }
}

const VERB: Record<FlowQuery['type'], string> = {
  upstream: 'Upstream of',
  downstream: 'Downstream of',
  trace: 'Trace of',
  path: 'Path',
};

/** Layered flow (ELK): downstream/trace/path read left → right from the root, upstream right → left. */
export function FlowView({ repoId }: { repoId: string }) {
  const graph = useMemo(() => new Graph({ multi: true, type: 'directed' }), []);
  const [layoutVersion, setLayoutVersion] = useState(0);
  const s = useStore();
  const q = s.flowQuery;
  const marks = useMarks(repoId);
  const reveal = useReveal();

  const query = useQuery({
    queryKey: ['flow', repoId, JSON.stringify(q), s.filters.edgeKinds.join(',')],
    queryFn: () => runFlow(repoId, q as FlowQuery, s.filters.edgeKinds),
    enabled: Boolean(q),
    placeholderData: keepPreviousData,
  });
  const raw = query.data;
  const rootKey = q ? (q.type === 'path' ? q.from : q.id) : undefined;
  const { sg: data, dropped } = useMemo(
    () => (raw && !s.filters.includeTests && q?.type !== 'path' ? dropTests(raw, rootKey) : { sg: raw, dropped: 0 }),
    [raw, s.filters.includeTests, q?.type, rootKey],
  );

  useEffect(() => {
    if (!data || !q) {
      encodeGraph(graph, undefined, { theme: s.theme });
      return;
    }
    const pathEdges = q.type === 'path' ? new Set(data.edges.map((e) => e.id)) : undefined;
    const enc = encodeGraph(graph, data, {
      theme: s.theme,
      hidden: new Set(s.hidden),
      hideAmbiguous: s.filters.hideAmbiguous,
      labelAll: true,
      labelBelow: true,
      marks,
      pathEdges,
    });
    // columns-by-distance right away; ELK's layered layout replaces it when the worker answers
    const upstream = q.type === 'upstream';
    let cancel = animatePositions(graph, layeredLayout(enc.nodes, enc.edges, data.distances ?? {}, upstream), 0);
    setLayoutVersion((v) => v + 1);
    let live = true;
    elkLayered(
      enc.nodes.map((n) => ({
        id: n.id,
        size: graph.getNodeAttribute(n.id, 'size') ?? 6,
      })),
      enc.edges,
      upstream,
    )
      .then((pos) => {
        if (!live) return;
        cancel = animatePositions(graph, pos, 300);
        setLayoutVersion((v) => v + 1);
      })
      .catch(() => {
        /* no worker (or ELK failed): keep the column layout */
      });
    return () => {
      live = false;
      cancel();
    };
  }, [graph, data, q, s.theme, s.hidden, s.filters.hideAmbiguous, marks]);

  if (!q)
    return (
      <div className="canvas-empty">
        <EmptyState
          title="No flow query yet"
          body="Run Upstream, Downstream, Trace or Path from the details panel, the context menu, or with U and D."
          action={{ label: 'Back to map', onClick: () => s.setView('map') }}
        />
      </div>
    );

  const notFound = q.type === 'path' && data?.meta?.found === false;
  const rootId = q.type === 'path' ? q.from : q.id;
  return (
    <>
      <GraphCanvas
        graph={graph}
        theme={s.theme}
        selected={s.selected}
        hovered={s.hovered}
        layoutVersion={layoutVersion}
        fitNonce={s.fitNonce}
        onClickNode={(id) => s.select(id)}
        onClickStage={() => s.select(undefined)}
        onDoubleClickNode={(id) => void reveal(id)}
        onContextNode={(id, x, y) => s.openContextMenu({ nodeId: id, x, y })}
        onHover={s.setHovered}
      />
      <div className="overlay view-header">
        <FlowTitle repoId={repoId} q={q} nodes={data?.nodes} />
        {q.type !== 'path' && (
          <>
            <span className="tone-3">Depth</span>
            <Stepper
              label="depth"
              value={q.depth}
              min={1}
              max={6}
              onChange={(d) => s.setFlowQuery({ ...q, depth: d })}
            />
          </>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => void reveal(s.selected ?? rootId)}>
          <MapIcon size={16} strokeWidth={1.5} aria-hidden="true" />
          Show on map
        </button>
      </div>
      <StatusChip data={data} loading={query.isFetching} />
      {query.isError && (
        <div className="canvas-empty">
          <EmptyState
            title="Query failed"
            body={(query.error as Error).message}
            action={{ label: 'Retry', onClick: () => void query.refetch() }}
          />
        </div>
      )}
      {dropped > 0 && data && data.nodes.length <= 1 && (
        <div className="canvas-empty">
          <EmptyState
            title="Only test code is connected"
            body={`${dropped} related ${dropped === 1 ? 'node is' : 'nodes are'} in test files, which are hidden.`}
            action={{ label: 'Include tests', onClick: () => s.setFilters({ includeTests: true }) }}
          />
        </div>
      )}
      {(notFound || (data && data.nodes.length === 0)) && (
        <div className="canvas-empty">
          <EmptyState
            title={q.type === 'path' ? 'No path between these nodes' : 'Nothing reachable'}
            body={
              q.type === 'path'
                ? 'No chain of relationships connects them in either direction.'
                : 'Try a larger depth or enable more edge kinds.'
            }
          />
        </div>
      )}
    </>
  );
}

function FlowTitle({ repoId, q, nodes }: { repoId: string; q: FlowQuery; nodes?: GraphNode[] }) {
  const firstId = q.type === 'path' ? q.from : q.id;
  const first = useNodeDetail(repoId, firstId).data?.node;
  const second = useNodeDetail(repoId, q.type === 'path' ? q.to : undefined).data?.node;
  const name = (n?: GraphNode) => (n ? nodeLabel(n) : '…');
  const count = nodes ? ` · ${fmtNum(nodes.length)} nodes` : '';
  if (q.type === 'path')
    return (
      <span className="title ellipsis">
        Path <code className="t-mono">{name(first)}</code> to <code className="t-mono">{name(second)}</code>
        <span className="tone-3">{count}</span>
      </span>
    );
  return (
    <span className="title ellipsis">
      {VERB[q.type]} <code className="t-mono">{name(first)}</code>
      <span className="tone-3">
        {' '}
        · depth {q.depth}
        {count}
      </span>
    </span>
  );
}
