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
import { NodeShapeProgram, nodeFx } from './program';

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
    if (nodeFx.glow) nodeFx.glow = graphPalette[p.theme].glow;
    sigma?.refresh();
  }, [p.theme, sigma]);

  /* ----- regions layer (expanded containers) ----- */
  useEffect(() => {
    if (!sigma) return;
    const canvas = sigma.createCanvas('spider-regions', { beforeLayer: 'edges' });
    const ctx = canvas.getContext('2d');
    const graph = sigma.getGraph();
    // Member bounds in graph space only change when nodes move or the groups change, not with the
    // camera: cache them and project two corners per region per frame (20k-node L3 views).
    let boxes: GraphBox[] | undefined;
    let boxesFor: Map<string, string[]> | undefined;
    const dirty = () => {
      boxes = undefined;
    };
    const events = [
      'nodeAdded',
      'nodeDropped',
      'cleared',
      'nodeAttributesUpdated',
      'eachNodeAttributesUpdated',
    ] as const;
    for (const ev of events) graph.on(ev, dirty);
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
      const groups = props.current.groups;
      if (!boxes || boxesFor !== groups) {
        boxes = graphBoxes(graph, groups);
        boxesFor = groups;
      }
      const theme = props.current.theme;
      const sel = props.current.selected;
      const pal = graphPalette[theme];
      drawGrid(ctx, sigma, width, height, pal.grid);
      ctx.fillStyle = pal.region;
      ctx.strokeStyle = pal.regionRing;
      ctx.lineWidth = 1;
      // one path per nesting depth (translucent fills still darken inward) instead of one per region
      const rects = viewportRects(sigma, boxes, width, height);
      const fancy = rects.length <= 120;
      let selRect: Rect | undefined;
      for (let i = 0; i < rects.length; ) {
        const depth = rects[i].depth;
        ctx.save();
        if (fancy && depth === 0) {
          ctx.shadowColor = theme === 'dark' ? 'rgba(0,0,0,0.45)' : 'rgba(15,23,42,0.10)';
          ctx.shadowBlur = 24;
          ctx.shadowOffsetY = 6;
        }
        ctx.beginPath();
        for (; i < rects.length && rects[i].depth === depth; i++) {
          const r = rects[i];
          if (r.id === sel) selRect = r;
          ctx.roundRect(r.x, r.y, r.w, r.h, 16);
        }
        ctx.fill();
        ctx.restore();
        ctx.stroke();
      }
      if (rects.length <= 400)
        for (const r of rects)
          if (graph.hasNode(r.id)) drawRegionTitle(ctx, r, String(graph.getNodeAttribute(r.id, 'title') ?? ''), theme);
      if (selRect) {
        ctx.beginPath();
        ctx.roundRect(selRect.x, selRect.y, selRect.w, selRect.h, 16);
        ctx.strokeStyle = tokens[theme].accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    };
    sigma.on('afterRender', draw);
    draw();
    return () => {
      sigma.off('afterRender', draw);
      for (const ev of events) graph.off(ev, dirty);
      canvas.remove();
    };
  }, [sigma]);

  /* ----- level of detail: big views drop edges and labels while the camera moves ----- */
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-evaluated whenever a new projection is laid out
  useEffect(() => {
    if (!sigma) return;
    const big = sigma.getGraph().order > LOD_NODES || sigma.getGraph().size > LOD_EDGES;
    nodeFx.glow = big ? 0 : graphPalette[props.current.theme].glow;
    sigma.setSetting('hideEdgesOnMove', big);
    sigma.setSetting('hideLabelsOnMove', big);
    // node sizes are screen pixels: dense maps need a deeper zoom before neighbours separate
    sigma.setSetting('minCameraRatio', big ? 0.002 : 0.02);
    // Sigma picks the node under the pointer on every wheel/move event with a WebGL readPixels, which
    // stalls on the GPU each time; on big maps skip picking while the camera is moving (hover is moot then).
    // shortcut: overrides a private sigma 3 method on the instance; re-check on sigma upgrades.
    const picker = sigma as unknown as { getNodeAtPosition: Picker };
    const pick = (Object.getPrototypeOf(sigma) as { getNodeAtPosition: Picker }).getNodeAtPosition;
    const moving = () => sigma.getCamera().isAnimated() || sigma.getMouseCaptor().isMoving;
    picker.getNodeAtPosition = big ? (pos) => (moving() ? null : pick.call(sigma, pos)) : pick;
  }, [sigma, p.layoutVersion, p.groups]);

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

  /* ----- selection ripple: two accent rings expand from a newly selected node ----- */
  useEffect(() => {
    const id = p.selected;
    if (!sigma || !id || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const canvas = sigma.createCanvas('spider-ripple', { afterLayer: 'nodes' });
    const ctx = canvas.getContext('2d');
    const start = performance.now();
    const DURATION = 1100;
    let raf = 0;
    const frame = (now: number) => {
      const { width, height } = sigma.getDimensions();
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      const d = sigma.getGraph().hasNode(id) ? sigma.getNodeDisplayData(id) : undefined;
      const elapsed = now - start;
      if (d && !d.hidden) {
        const c = sigma.framedGraphToViewport(d);
        const r = sigma.scaleSize(d.size);
        ctx.strokeStyle = tokens[props.current.theme].accent;
        for (const lag of [0, 260]) {
          const t = Math.min(1, Math.max(0, (elapsed - lag) / (DURATION - 260)));
          if (t <= 0 || t >= 1) continue;
          ctx.globalAlpha = 0.55 * (1 - t) ** 2;
          ctx.lineWidth = 2 * (1 - t) + 0.5;
          ctx.beginPath();
          ctx.arc(c.x, c.y, r + 4 + 30 * (1 - (1 - t) ** 3), 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      if (elapsed < DURATION) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, width, height);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      canvas.remove();
    };
  }, [sigma, p.selected]);

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

type Picker = (pos: { x: number; y: number }) => string | null;

/** Above these counts the map is "big": edges and labels hide while panning/zooming. */
const LOD_NODES = 5000;
const LOD_EDGES = 20000;
/** Regions smaller than this on screen (zoomed far out) are skipped: they'd be specks. */
const MIN_REGION_PX = 6;

interface GraphBox {
  id: string;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Largest member size (sigma px at ratio 1), for padding. */
  size: number;
  depth: number;
}

/** Bounding boxes of every visible group in raw graph coordinates, outermost first. */
function graphBoxes(graph: Graph, groups: Map<string, string[]> | undefined): GraphBox[] {
  if (!groups || groups.size === 0) return [];
  const out: GraphBox[] = [];
  for (const [id, members] of groups) {
    if (!graph.hasNode(id) || graph.getNodeAttribute(id, 'hidden')) continue;
    const box: GraphBox = {
      id,
      minX: Number.POSITIVE_INFINITY,
      minY: Number.POSITIVE_INFINITY,
      maxX: Number.NEGATIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
      size: 0,
      depth: Number(graph.getNodeAttribute(id, 'depth') ?? 0),
    };
    const add = (m: string) => {
      if (!graph.hasNode(m)) return;
      const a = graph.getNodeAttributes(m);
      if (a.hidden) return;
      box.minX = Math.min(box.minX, a.x);
      box.maxX = Math.max(box.maxX, a.x);
      box.minY = Math.min(box.minY, a.y);
      box.maxY = Math.max(box.maxY, a.y);
      box.size = Math.max(box.size, Number(a.size ?? 0));
    };
    add(id);
    for (const m of members) add(m);
    if (Number.isFinite(box.minX)) out.push(box);
  }
  return out.sort((a, b) => a.depth - b.depth);
}

/** Cached graph boxes → on-screen rectangles; off-screen and speck-sized regions are dropped. */
function viewportRects(sigma: Sigma, boxes: GraphBox[], width: number, height: number): Rect[] {
  const out: Rect[] = [];
  for (const b of boxes) {
    const p = sigma.graphToViewport({ x: b.minX, y: b.minY });
    const q = sigma.graphToViewport({ x: b.maxX, y: b.maxY });
    const pad = sigma.scaleSize(b.size) + 12;
    const x = Math.min(p.x, q.x) - pad;
    const y = Math.min(p.y, q.y) - pad;
    const w = Math.abs(q.x - p.x) + 2 * pad;
    const h = Math.abs(q.y - p.y) + 2 * pad;
    if (x > width || y > height || x + w < 0 || y + h < 0) continue;
    if (w - 24 < MIN_REGION_PX && h - 24 < MIN_REGION_PX && boxes.length > 200) continue;
    out.push({ id: b.id, x, y, w, h, depth: b.depth });
  }
  return out;
}

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

/* ---------- canvas decoration ---------- */

/** Dot grid that pans and zooms with the camera; spacing folds back into 18–36 px so density stays even. */
function drawGrid(ctx: CanvasRenderingContext2D, sigma: Sigma, width: number, height: number, color: string): void {
  const a = sigma.graphToViewport({ x: 0, y: 0 });
  const b = sigma.graphToViewport({ x: 1, y: 0 });
  let step = Math.abs(b.x - a.x) * 0.02 || 24;
  while (step < 18) step *= 2;
  while (step > 36) step /= 2;
  const ox = ((a.x % step) + step) % step;
  const oy = ((a.y % step) + step) % step;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let x = ox; x < width; x += step) for (let y = oy; y < height; y += step) ctx.rect(x - 0.75, y - 0.75, 1.5, 1.5);
  ctx.fill();
}

/** Container name as a small pill on the region's top edge. */
function drawRegionTitle(ctx: CanvasRenderingContext2D, r: Rect, label: string, theme: ThemeName): void {
  if (!label || r.w < 90 || r.h < 48) return;
  const t = tokens[theme];
  ctx.font = '600 11px -apple-system, BlinkMacSystemFont, "Inter Variable", "Inter", sans-serif';
  const max = r.w - 40;
  let text = label;
  while (text.length > 3 && ctx.measureText(text).width > max) text = `${text.slice(0, -2)}…`;
  const w = ctx.measureText(text).width + 16;
  const x = r.x + 12;
  const y = r.y - 10;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 20, 10);
  ctx.fillStyle = t.bgSurface2;
  ctx.fill();
  ctx.strokeStyle = t.hairlineStrong;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = t.textSecondary;
  ctx.fillText(text, x + 8, y + 14);
}
