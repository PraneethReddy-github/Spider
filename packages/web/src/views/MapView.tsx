import type { SubGraph } from '@spider/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Graph from 'graphology';
import { useEffect, useMemo, useRef, useState } from 'react';
import type Sigma from 'sigma';
import { api } from '../api';
import { fmtNum, nodeLabel } from '../format';
import { GraphCanvas } from '../graph/GraphCanvas';
import { Minimap } from '../graph/Minimap';
import { animatePositions, encodeGraph } from '../graph/encode';
import { mapVisible, useMarks, useNodeDetail, useReveal } from '../hooks';
import { type Pos, layoutMap, loadPins, savePin } from '../layout/map';
import { useStore } from '../store';
import { EmptyState, Spinner } from '../ui';

export function useProjection(repoId: string) {
  const level = useStore((s) => s.level);
  const expanded = useStore((s) => s.expanded);
  const f = useStore((s) => s.filters);
  return useQuery({
    queryKey: [
      'graph',
      repoId,
      level,
      expanded.join(','),
      f.edgeKinds.join(','),
      f.nodeKinds?.join(',') ?? '*',
      f.languages?.join(',') ?? '*',
      f.includeTests,
      f.minConfidence,
    ],
    queryFn: () =>
      api.graph(repoId, {
        level,
        expanded,
        edgeKinds: f.edgeKinds,
        nodeKinds: f.nodeKinds,
        languages: f.languages,
        includeTests: f.includeTests,
        minConfidence: f.minConfidence,
      }),
    placeholderData: keepPreviousData,
  });
}

export function MapView({ repoId }: { repoId: string }) {
  const graph = useMemo(() => new Graph({ multi: true, type: 'directed' }), []);
  const [groups, setGroups] = useState<Map<string, string[]>>(new Map());
  const [layoutVersion, setLayoutVersion] = useState(0);
  const [sigma, setSigma] = useState<Sigma>();
  const query = useProjection(repoId);
  const data = query.data;
  const s = useStore();
  const marks = useMarks(repoId);
  const reveal = useReveal();
  const viewKey = `${repoId}:${s.level}:${[...s.expanded].sort().join(',')}`;
  const fitKey = useRef('');
  const cancelAnim = useRef<() => void>(() => {});

  // projection → graph → layout → animate
  useEffect(() => {
    cancelAnim.current();
    const prev = new Map<string, Pos>();
    graph.forEachNode((id, a) => prev.set(id, { x: a.x, y: a.y }));
    const enc = encodeGraph(graph, data, {
      theme: s.theme,
      hidden: new Set(s.hidden),
      hideAmbiguous: s.filters.hideAmbiguous,
      colorBySubsystem: s.filters.colorBySubsystem,
      marks,
    });
    mapVisible.ids = new Set(enc.nodes.map((n) => n.id));
    setGroups(enc.groups);
    if (enc.nodes.length === 0) return;

    const target = layoutMap(
      enc.nodes.map((n) => ({
        id: n.id,
        size: Number(graph.getNodeAttribute(n.id, 'size')),
        parent: graph.getNodeAttribute(n.id, 'parent') as string | undefined,
      })),
      enc.edges,
    );
    for (const [id, p] of Object.entries(loadPins(viewKey))) if (target.has(id)) target.set(id, p);

    // start new nodes where their group (or their former container) was, so expansion reads as growth
    graph.updateEachNodeAttributes((id, a) => {
      const was = prev.get(id);
      if (was) return { ...a, ...was };
      let parent = a.parent as string | undefined;
      while (parent && !prev.has(parent))
        parent = graph.hasNode(parent) ? (graph.getNodeAttribute(parent, 'parent') as string | undefined) : undefined;
      const origin = (parent && prev.get(parent)) || target.get(id) || { x: 0, y: 0 };
      return { ...a, x: origin.x, y: origin.y };
    });
    cancelAnim.current = animatePositions(graph, target, prev.size ? 300 : 0);

    const key = `${repoId}:${s.level}:${JSON.stringify(s.filters)}:${s.hidden.length}`;
    if (key !== fitKey.current) {
      fitKey.current = key;
      setLayoutVersion((v) => v + 1);
    }
    return () => cancelAnim.current();
    // theme/marks re-encode too; selection does not
  }, [graph, data, s.theme, s.hidden, s.filters, marks, viewKey, repoId, s.level]);

  // deep links (?node=…) may point inside a collapsed container: reveal once, after the first projection
  const revealed = useRef(false);
  useEffect(() => {
    if (revealed.current || !data) return;
    revealed.current = true;
    const sel = useStore.getState().selected;
    if (sel && !mapVisible.ids.has(sel)) void reveal(sel);
  }, [data, reveal]);

  const onDouble = (id: string) => {
    if (!graph.hasNode(id)) return;
    const a = graph.getNodeAttributes(id);
    if (Number(a.childCount) > 0 || a.isGroup) {
      s.toggleExpanded(id);
      s.select(id);
      s.fit();
    } else {
      s.select(id);
      s.setView('focus');
    }
  };

  const onClick = (id: string, additive: boolean) => {
    const pm = useStore.getState().pathMode;
    if (pm && id !== pm.anchor) {
      s.setFlowQuery(
        pm.direction === 'from' ? { type: 'path', from: pm.anchor, to: id } : { type: 'path', from: id, to: pm.anchor },
      );
      return;
    }
    s.select(id, { additive });
  };

  const truncated = Boolean(data?.meta?.truncated);
  const empty = data && data.nodes.length === 0;

  return (
    <>
      <GraphCanvas
        graph={graph}
        theme={s.theme}
        selected={s.selected}
        secondary={s.secondary}
        hovered={s.hovered}
        groups={groups}
        layoutVersion={layoutVersion}
        fitNonce={s.fitNonce}
        fitSelectionNonce={s.fitSelectionNonce}
        centerOn={s.centerOn}
        onCentered={() => s.setCenterOn(undefined)}
        onClickNode={onClick}
        onClickStage={() => {
          if (!useStore.getState().pathMode) s.select(undefined);
        }}
        onDoubleClickNode={onDouble}
        onContextNode={(id, x, y) => s.openContextMenu({ nodeId: id, x, y })}
        onHover={s.setHovered}
        onDragEnd={(moved) => {
          for (const [id, p] of moved) savePin(viewKey, id, p);
        }}
        onReady={setSigma}
      />
      <Breadcrumb repoId={repoId} onPick={(id) => void reveal(id)} />
      <StatusChip
        data={data}
        loading={query.isFetching}
        truncated={truncated}
        reason={data?.meta?.truncatedReason as string | undefined}
      />
      <Minimap sigma={sigma} theme={s.theme} />
      {query.isError && !data && (
        <div className="canvas-empty">
          <EmptyState
            title="Could not load the map"
            body={(query.error as Error).message}
            action={{ label: 'Retry', onClick: () => void query.refetch() }}
          />
        </div>
      )}
      {query.isLoading && (
        <div className="canvas-empty">
          <Spinner label="Loading map" />
        </div>
      )}
      {empty && (
        <div className="canvas-empty">
          <EmptyState
            title="Nothing to show at this level"
            body="Try another level, enable more kinds in Filters, or include tests."
            action={{ label: 'Reset filters', onClick: s.resetFilters }}
          />
        </div>
      )}
    </>
  );
}

function Breadcrumb({ repoId, onPick }: { repoId: string; onPick: (id: string) => void }) {
  const selected = useStore((s) => s.selected);
  const { data } = useNodeDetail(repoId, selected);
  if (!selected || !data || data.node.id !== selected) return null;
  const chain = [...data.parents].reverse().filter((p) => p.kind !== 'repository');
  return (
    <nav className="overlay breadcrumb" aria-label="Breadcrumb">
      {chain.map((p) => (
        <span key={p.id} style={{ display: 'contents' }}>
          <button type="button" onClick={() => onPick(p.id)}>
            {nodeLabel(p)}
          </button>
          <span className="sep" aria-hidden="true">
            /
          </span>
        </span>
      ))}
      <button type="button" onClick={() => onPick(selected)}>
        {nodeLabel(data.node)}
      </button>
    </nav>
  );
}

export function StatusChip({
  data,
  loading,
  truncated,
  reason,
  label,
}: { data?: SubGraph; loading: boolean; truncated?: boolean; reason?: string; label?: string }) {
  const n = data?.nodes.length ?? 0;
  const m = data?.edges.length ?? 0;
  return (
    <div className="overlay status-chip" aria-live="polite">
      {loading && <Spinner />}
      {label && <span>{label}</span>}
      <span className="num">
        {fmtNum(n)} nodes · {fmtNum(m)} edges
      </span>
      {truncated && (
        <span className="warn" title={reason ?? 'The server limited the number of nodes.'}>
          truncated
        </span>
      )}
    </div>
  );
}
