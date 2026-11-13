import { SigmaContainer, useRegisterEvents, useSetSettings, useSigma } from '@react-sigma/core';
import type Graph from 'graphology';
import { useEffect, useMemo, useRef } from 'react';
import type { Settings } from 'sigma/settings';
import { COLORS } from '../theme';

export interface GraphCanvasProps {
  /** A stable graphology instance; the parent mutates it in place. */
  graph: Graph;
  /** Bumped whenever the graph content or layout changed; triggers a camera fit. */
  version: number;
  fitNonce: number;
  selected?: string;
  hovered?: string;
  centerOn?: string;
  draggable?: boolean;
  onCentered?: () => void;
  onDragEnd?: () => void;
  onSelect?: (id: string | undefined) => void;
  onHover?: (id: string | undefined) => void;
  onDoubleClick?: (id: string) => void;
  onContext?: (id: string, x: number, y: number) => void;
}

const withAlpha = (hex: string, alpha: string) => (hex.length === 7 ? hex + alpha : hex);

export function GraphCanvas(props: GraphCanvasProps) {
  const settings = useMemo<Partial<Settings>>(
    () => ({
      defaultEdgeType: 'arrow',
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 9,
      labelDensity: 0.1,
      labelGridCellSize: 80,
      labelFont: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      labelSize: 12,
      labelWeight: '500',
      labelColor: { color: COLORS.label },
      zIndex: true,
      minCameraRatio: 0.02,
      maxCameraRatio: 6,
      stagePadding: 40,
      hideEdgesOnMove: true,
      hideLabelsOnMove: false,
    }),
    [],
  );
  return (
    <div className="canvas-wrap" onContextMenu={(e) => e.preventDefault()}>
      <SigmaContainer graph={props.graph} settings={settings} className="sigma-root" style={{ width: '100%', height: '100%', background: COLORS.canvasBg }}>
        <CanvasController {...props} />
      </SigmaContainer>
    </div>
  );
}

function CanvasController(p: GraphCanvasProps) {
  const sigma = useSigma();
  const registerEvents = useRegisterEvents();
  const setSettings = useSetSettings();
  const drag = useRef<{ id: string; moved: boolean } | null>(null);
  const handlers = useRef(p);
  handlers.current = p;

  /* ----- events ----- */
  useEffect(() => {
    registerEvents({
      enterNode: (e) => handlers.current.onHover?.(e.node),
      leaveNode: () => handlers.current.onHover?.(undefined),
      clickNode: (e) => {
        if (drag.current?.moved) return;
        handlers.current.onSelect?.(e.node);
      },
      clickStage: () => handlers.current.onSelect?.(undefined),
      doubleClickNode: (e) => {
        e.preventSigmaDefault();
        handlers.current.onDoubleClick?.(e.node);
      },
      doubleClickStage: (e) => e.preventSigmaDefault(),
      rightClickNode: (e) => {
        e.preventSigmaDefault();
        e.event.original.preventDefault();
        handlers.current.onContext?.(e.node, e.event.x, e.event.y);
      },
      downNode: (e) => {
        if (!handlers.current.draggable) return;
        drag.current = { id: e.node, moved: false };
        sigma.getCamera().disable();
      },
      mousemovebody: (e) => {
        const d = drag.current;
        if (!d) return;
        const pos = sigma.viewportToGraph(e);
        sigma.getGraph().mergeNodeAttributes(d.id, { x: pos.x, y: pos.y });
        d.moved = true;
        e.preventSigmaDefault();
        e.original.preventDefault();
        e.original.stopPropagation();
      },
      mouseup: () => {
        const d = drag.current;
        if (!d) return;
        sigma.getCamera().enable();
        const moved = d.moved;
        // keep `moved` visible to the click handler that fires right after mouseup
        setTimeout(() => {
          drag.current = null;
        }, 0);
        if (moved) handlers.current.onDragEnd?.();
      },
    });
  }, [registerEvents, sigma]);

  /* ----- reducers: hover / selection highlighting ----- */
  const { selected, hovered, graph } = p;
  useEffect(() => {
    const focus = hovered && graph.hasNode(hovered) ? hovered : selected && graph.hasNode(selected) ? selected : undefined;
    const neighbours = new Set<string>();
    if (focus) {
      neighbours.add(focus);
      graph.forEachNeighbor(focus, (n) => neighbours.add(n));
    }
    setSettings({
      nodeReducer: (node, data) => {
        const out = { ...data };
        if (node === selected) {
          out.highlighted = true;
          out.zIndex = 3;
          out.forceLabel = true;
        }
        if (!focus) return out;
        if (node === focus) {
          out.zIndex = 3;
          out.forceLabel = true;
          return out;
        }
        if (neighbours.has(node)) {
          out.zIndex = 2;
          out.forceLabel = true;
          return out;
        }
        out.color = withAlpha(data.color as string, '33');
        out.label = '';
        out.zIndex = 0;
        return out;
      },
      edgeReducer: (edge, data) => {
        const out = { ...data };
        if (!focus) return out;
        const src = graph.source(edge);
        const dst = graph.target(edge);
        if (src === focus || dst === focus) {
          out.zIndex = 2;
          out.color = dst === focus ? COLORS.incoming : COLORS.outgoing;
          out.size = Math.max(1.5, (data.size as number) ?? 1);
          return out;
        }
        out.color = withAlpha(data.color as string, '22');
        out.zIndex = 0;
        return out;
      },
    });
  }, [selected, hovered, graph, setSettings]);

  /* ----- camera: fit on new layout, explicit fit, centre on node ----- */
  const lastVersion = useRef(-1);
  useEffect(() => {
    if (p.version === lastVersion.current) return;
    lastVersion.current = p.version;
    if (graph.order === 0) return;
    if (!p.centerOn) sigma.getCamera().animatedReset({ duration: 400 });
  }, [p.version, graph, sigma, p.centerOn]);

  useEffect(() => {
    if (p.fitNonce > 0) sigma.getCamera().animatedReset({ duration: 400 });
  }, [p.fitNonce, sigma]);

  useEffect(() => {
    if (!p.centerOn) return;
    if (!graph.hasNode(p.centerOn)) return; // wait for the projection that contains it
    const d = sigma.getNodeDisplayData(p.centerOn);
    if (d) {
      const ratio = Math.min(sigma.getCamera().ratio, 0.45);
      sigma.getCamera().animate({ x: d.x, y: d.y, ratio }, { duration: 400 });
    }
    handlers.current.onCentered?.();
  }, [p.centerOn, p.version, graph, sigma]);

  return null;
}
