import type { NodeKind } from '@spider/shared';
import type Graph from 'graphology';
import { useEffect, useRef, useState } from 'react';
import Sigma from 'sigma';
import { EdgeArrowProgram, EdgeRectangleProgram } from 'sigma/rendering';
import type { Settings } from 'sigma/settings';
import type { NodeDisplayData } from 'sigma/types';
import { fmtNum } from '../format';
import { type ThemeName, blend, graphPalette, tokens } from '../theme';
import { KindBadge } from '../ui';
import { drawHover, drawLabel, drawTheme } from './draw';
import { type ExportSource, exportTarget, sigmaPng, sigmaSvg } from './exportImage';
import { NodeShapeProgram } from './program';

export interface GraphCanvasProps {
  /** Stable graphology instance; views mutate it in place and sigma follows. */
  graph: Graph;
  theme: ThemeName;
  selected?: string;
  secondary?: string;
  hovered?: string;
  /** Group node → ids of every visible descendant (drawn as rounded regions behind the map). */
  groups?: Map<string, string[]>;
  /** Bumped by the view after a new projection has been laid out: the camera fits once per bump. */
  layoutVersion: number;
  fitNonce: number;
  fitSelectionNonce?: number;
  centerOn?: string;
  onCentered?: () => void;
  onClickNode?: (id: string, additive: boolean) => void;
  onClickStage?: () => void;
  onDoubleClickNode?: (id: string) => void;
  onContextNode?: (id: string, x: number, y: number) => void;
  onHover?: (id: string | undefined) => void;
  /** Called after a drag with the final positions of every node that moved. */
  onDragEnd?: (moved: Map<string, { x: number; y: number }>) => void;
  onReady?: (sigma: Sigma | undefined) => void;
}

interface Tip {
  id: string;
  x: number;
  y: number;
}

export function GraphCanvas(p: GraphCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const [sigma, setSigma] = useState<Sigma>();
  const props = useRef(p);
  props.current = p;
  const [tip, setTip] = useState<Tip>();

  /* ----- lifecycle ----- */
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const settings: Partial<Settings> = {
      allowInvalidContainer: true,
      defaultNodeType: 'shape',
      defaultEdgeType: 'arrow',
      nodeProgramClasses: { shape: NodeShapeProgram },
      edgeProgramClasses: { arrow: EdgeArrowProgram, line: EdgeRectangleProgram },
      renderEdgeLabels: false,
      enableEdgeEvents: false,
      zIndex: true,
      labelRenderedSizeThreshold: 7,
      labelDensity: 0.8,
      labelGridCellSize: 120,
      labelFont: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", "Inter", sans-serif',
      labelSize: 12,
      labelWeight: '500',
      defaultDrawNodeLabel: drawLabel as Settings['defaultDrawNodeLabel'],
      defaultDrawNodeHover: drawHover as Settings['defaultDrawNodeHover'],
      minCameraRatio: 0.02,
      maxCameraRatio: 5,
      stagePadding: 72,
      hideEdgesOnMove: false,
      zoomDuration: 200,
      doubleClickZoomingDuration: 250,
    };
    const s = new Sigma(p.graph, el, settings);
    setSigma(s);
    props.current.onReady?.(s);
    const source: ExportSource = {
      png: () => sigmaPng(s, props.current.theme),
      svg: () => sigmaSvg(s, props.current.theme, regionRects(s, props.current.groups)),
    };
    exportTarget.current = source;
    return () => {
      if (exportTarget.current === source) exportTarget.current = undefined;
      props.current.onReady?.(undefined);
      s.kill();
      setSigma(undefined);
    };
    // graph identity is stable per view
  }, [p.graph]);

  /* ----- events ----- */
  useEffect(() => {
    if (!sigma) return;
    const graph = sigma.getGraph();
    let drag: { id: string; moved: boolean; members: string[]; last: { x: number; y: number } } | null = null;
    let suppressClick = false;

    sigma.on('enterNode', ({ node, event }) => {
      props.current.onHover?.(node);
      setTip({ id: node, x: event.x, y: event.y });
    });
    sigma.on('leaveNode', () => {
      props.current.onHover?.(undefined);
      setTip(undefined);
    });
    sigma.on('clickNode', ({ node, event }) => {
      if (suppressClick) return;
      const orig = event.original as MouseEvent;
      props.current.onClickNode?.(node, orig.shiftKey || orig.metaKey);
    });
    sigma.on('clickStage', ({ event }) => {
      if (suppressClick) return;
      const g = hitGroup(sigma, props.current.groups, event.x, event.y);
      if (g) props.current.onClickNode?.(g, (event.original as MouseEvent).shiftKey);
      else props.current.onClickStage?.();
    });
    sigma.on('doubleClickNode', (e) => {
      e.preventSigmaDefault();
      props.current.onDoubleClickNode?.(e.node);
    });
    sigma.on('doubleClickStage', (e) => {
      const g = hitGroup(sigma, props.current.groups, e.event.x, e.event.y);
      if (g) {
        e.preventSigmaDefault();
        props.current.onDoubleClickNode?.(g);
      }
    });
    sigma.on('rightClickNode', ({ node, event }) => {
      event.preventSigmaDefault();
      const orig = event.original as MouseEvent;
      orig.preventDefault();
      props.current.onContextNode?.(node, orig.clientX, orig.clientY);
    });
    sigma.on('downNode', ({ node, event }) => {
      if ((event.original as MouseEvent).button !== 0) return;
      const members = props.current.groups?.get(node) ?? [];
      drag = { id: node, moved: false, members, last: sigma.viewportToGraph(event) };
    });
    const captor = sigma.getMouseCaptor();
    const onMove = (e: { x: number; y: number; preventSigmaDefault(): void; original: Event }) => {
      if (!drag) return;
      if (!drag.moved) {
        drag.moved = true;
        setTip(undefined);
      }
      const pos = sigma.viewportToGraph(e);
      const dx = pos.x - drag.last.x;
      const dy = pos.y - drag.last.y;
      drag.last = pos;
      for (const id of [drag.id, ...drag.members]) {
        if (graph.hasNode(id)) graph.updateNodeAttributes(id, (a) => ({ ...a, x: a.x + dx, y: a.y + dy }));
      }
      e.preventSigmaDefault();
      e.original.preventDefault();
      e.original.stopPropagation();
    };
    const onUp = () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (!d.moved) return;
      suppressClick = true;
      window.setTimeout(() => {
        suppressClick = false;
      }, 0);
      const moved = new Map<string, { x: number; y: number }>();
      for (const id of [d.id, ...d.members]) {
        if (graph.hasNode(id))
          moved.set(id, { x: graph.getNodeAttribute(id, 'x'), y: graph.getNodeAttribute(id, 'y') });
      }
      props.current.onDragEnd?.(moved);
    };
    const clearTip = () => setTip(undefined);
    graph.on('cleared', clearTip);
    captor.on('mousemovebody', onMove);
    captor.on('mouseup', onUp);
    return () => {
      sigma.removeAllListeners();
      graph.off('cleared', clearTip);
      captor.off('mousemovebody', onMove);
      captor.off('mouseup', onUp);
    };
  }, [sigma]);

  /* ----- theme ----- */
  useEffect(() => {
    drawTheme.name = p.theme;
    sigma?.refresh();
  }, [p.theme, sigma]);

  /* ----- regions layer (expanded containers) ----- */
  useEffect(() => {
    if (!sigma) return;
    const canvas = sigma.createCanvas('spider-regions', { beforeLayer: 'edges' });
    const ctx = canvas.getContext('2d');
    const draw = () => {
      if (!ctx) return;
      const { width, height } = sigma.getDimensions();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const rects = regionRects(sigma, props.current.groups);
      const theme = props.current.theme;
      const sel = props.current.selected;
      for (const r of rects) {
        ctx.beginPath();
        ctx.roundRect(r.x, r.y, r.w, r.h, 14);
        ctx.fillStyle = graphPalette[theme].region;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = r.id === sel ? tokens[theme].accent : tokens[theme].hairlineStrong;
        ctx.stroke();
      }
    };
    sigma.on('afterRender', draw);
    draw();
    return () => {
      sigma.off('afterRender', draw);
      canvas.remove();
    };
  }, [sigma]);

  /* ----- reducers: selection / hover styling ----- */
  const { selected, secondary, hovered, theme, graph } = p;
  useEffect(() => {
    if (!sigma) return;
    const t = tokens[theme];
    const bg = t.bgCanvas;
    const focus =
      hovered && graph.hasNode(hovered) ? hovered : selected && graph.hasNode(selected) ? selected : undefined;
    const dimAlpha = hovered && focus === hovered ? graphPalette.hoverDim : graphPalette.dim;
    const near = new Set<string>();
    if (focus) {
      near.add(focus);
      graph.forEachNeighbor(focus, (n) => {
        near.add(n);
      });
      // a group's members stay lit when the group is the focus, and the focus's own groups stay labelled
      for (const m of p.groups?.get(focus) ?? []) near.add(m);
      for (
        let a = graph.getNodeAttribute(focus, 'parent') as string | undefined, i = 0;
        a && graph.hasNode(a) && i < 64;
        i++
      ) {
        near.add(a);
        a = graph.getNodeAttribute(a, 'parent') as string | undefined;
      }
    }
    if (secondary && graph.hasNode(secondary)) near.add(secondary);
    const incomingColor = blend(t.textPrimary, 0.6, bg);

    sigma.setSetting('nodeReducer', (node, data) => {
      const out: Partial<NodeDisplayData> & Record<string, unknown> = { ...data };
      if (node === selected || node === secondary) {
        out.ringColor = t.accent;
        out.ringWidth = 2;
        out.forceLabel = true;
        out.zIndex = 3;
      }
      if (!focus || near.has(node)) {
        if (focus && near.has(node)) {
          out.forceLabel = true;
          out.zIndex = Math.max(Number(out.zIndex ?? 1), 2);
        }
        return out;
      }
      out.color = blend(String(data.color), dimAlpha, bg);
      if (data.ringColor) out.ringColor = blend(String(data.ringColor), dimAlpha, bg);
      out.label = null;
      out.forceLabel = false;
      out.zIndex = 0;
      return out;
    });
    sigma.setSetting('edgeReducer', (edge, data) => {
      if (!focus) return data;
      const src = graph.source(edge);
      const dst = graph.target(edge);
      const out = { ...data };
      if (src === focus || dst === focus) {
        out.zIndex = 2;
        out.color = src === focus ? (focus === selected ? t.accent : String(data.color)) : incomingColor;
        if (focus === hovered && focus !== selected) out.color = blend(t.textPrimary, 0.7, bg);
        out.size = Math.max(1.5, Number(data.size ?? 1));
        return out;
      }
      out.color = blend(String(data.color), dimAlpha, bg);
      out.zIndex = 0;
      return out;
    });
  }, [sigma, selected, secondary, hovered, theme, graph, p.groups]);

  /* ----- camera ----- */
  const lastLayout = useRef(-1);
  useEffect(() => {
    if (!sigma || p.layoutVersion === lastLayout.current) return;
    const first = lastLayout.current === -1;
    lastLayout.current = p.layoutVersion;
    if (!p.centerOn) sigma.getCamera().animatedReset({ duration: first ? 0 : 300 });
  }, [sigma, p.layoutVersion, p.centerOn]);

  useEffect(() => {
    if (sigma && p.fitNonce > 0) sigma.getCamera().animatedReset({ duration: 250 });
  }, [sigma, p.fitNonce]);

  useEffect(() => {
    const id = props.current.selected;
    if (!sigma || !p.fitSelectionNonce || !id) return;
    const d = sigma.getNodeDisplayData(id);
    if (d) sigma.getCamera().animate({ x: d.x, y: d.y, ratio: 0.35 }, { duration: 250 });
  }, [sigma, p.fitSelectionNonce]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: layoutVersion retries once the projection containing the node lands
  useEffect(() => {
    if (!sigma || !p.centerOn || !graph.hasNode(p.centerOn)) return;
    // nodes added since the last frame still carry raw graph coordinates; index them before reading
    sigma.refresh();
    const d = sigma.getNodeDisplayData(p.centerOn);
    if (d) {
      const ratio = Math.min(sigma.getCamera().ratio, 0.5);
      sigma.getCamera().animate({ x: d.x, y: d.y, ratio }, { duration: 250 });
    }
    props.current.onCentered?.();
  }, [sigma, p.centerOn, p.layoutVersion, graph]);

  return (
    <>
      <div ref={host} className="sigma-host" onContextMenu={(e) => e.preventDefault()} />
      {tip && graph.hasNode(tip.id) && <NodeTooltip graph={graph} tip={tip} host={host.current} />}
    </>
  );
}

function NodeTooltip({ graph, tip, host }: { graph: Graph; tip: Tip; host: HTMLDivElement | null }) {
  const a = graph.getNodeAttributes(tip.id);
  const r = host?.getBoundingClientRect();
  if (!r) return null;
  const left = Math.min(r.left + tip.x + 12, window.innerWidth - 330);
  const top = r.top + tip.y + 12;
  return (
    <div className="tooltip" style={{ left, top }}>
      <div className="tooltip-title">
        <KindBadge kind={a.kind as NodeKind} />
        <span className="ellipsis">{String(a.fullLabel ?? a.label ?? tip.id)}</span>
      </div>
      {a.location && <div className="t-mono tone-3 ellipsis">{String(a.location)}</div>}
      <div className="tone-2 num">
        in {fmtNum(Number(a.fanIn ?? 0))} · out {fmtNum(Number(a.fanOut ?? 0))}
        {Number(a.childCount ?? 0) > 0 ? ` · ${fmtNum(Number(a.childCount))} inside` : ''}
      </div>
    </div>
  );
}

/* ---------- region geometry ---------- */

interface Rect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  depth: number;
}

function regionRects(sigma: Sigma, groups: Map<string, string[]> | undefined): Rect[] {
  if (!groups || groups.size === 0) return [];
  const graph = sigma.getGraph();
  const out: Rect[] = [];
  for (const [id, members] of groups) {
    if (!graph.hasNode(id) || graph.getNodeAttribute(id, 'hidden')) continue;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const m of [id, ...members]) {
      const d = sigma.getNodeDisplayData(m);
      if (!d || d.hidden) continue;
      const v = sigma.framedGraphToViewport(d);
      const r = sigma.scaleSize(d.size);
      minX = Math.min(minX, v.x - r);
      maxX = Math.max(maxX, v.x + r);
      minY = Math.min(minY, v.y - r);
      maxY = Math.max(maxY, v.y + r);
    }
    if (!Number.isFinite(minX)) continue;
    const pad = 12;
    out.push({
      id,
      x: minX - pad,
      y: minY - pad,
      w: maxX - minX + 2 * pad,
      h: maxY - minY + 2 * pad,
      depth: Number(graph.getNodeAttribute(id, 'depth') ?? 0),
    });
  }
  return out.sort((a, b) => a.depth - b.depth);
}

function hitGroup(sigma: Sigma, groups: Map<string, string[]> | undefined, x: number, y: number): string | undefined {
  const rects = regionRects(sigma, groups);
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r.id;
  }
  return undefined;
}
