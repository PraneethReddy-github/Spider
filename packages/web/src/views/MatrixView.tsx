import type { GraphNode } from '@spider/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Matrix, type MatrixCell, api } from '../api';
import { fmtNum, nodeLabel } from '../format';
import { exportTarget } from '../graph/exportImage';
import { useStore } from '../store';
import { type ThemeName, blend, tokens } from '../theme';
import { EmptyState, Spinner } from '../ui';

const LABEL_W = 232;
const HEAD_H = 148;
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", "Inter", sans-serif';

interface Hover {
  i: number;
  j: number;
  x: number;
  y: number;
}

const matrixLabel = (n: GraphNode) => (n.kind === 'file' ? (n.file ?? n.name) : nodeLabel(n));

/** Keeps the end of a path-like label when it doesn't fit ("…/routes/users.ts"). */
function fit(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ctx.measureText(`…${text.slice(mid)}`).width <= max) hi = mid;
    else lo = mid + 1;
  }
  return `…${text.slice(lo)}`;
}

/**
 * Upward dependency: a cell above the diagonal. Rows come ordered by inferred layer (foundation first),
 * so dependencies normally sit below the diagonal; anything above points against the layering (cycles).
 */
const isUpward = (c: MatrixCell) => c.j > c.i;

function draw(
  canvas: HTMLCanvasElement,
  m: Matrix,
  cs: number,
  scroll: { left: number; top: number },
  hover: Hover | undefined,
  theme: ThemeName,
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const t = tokens[theme];
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = t.bgCanvas;
  ctx.fillRect(0, 0, w, h);
  const n = m.nodes.length;
  const x0 = LABEL_W - scroll.left;
  const y0 = HEAD_H - scroll.top;
  const i0 = Math.max(0, Math.floor(scroll.top / cs));
  const i1 = Math.min(n, Math.ceil((scroll.top + h - HEAD_H) / cs));
  const j0 = Math.max(0, Math.floor(scroll.left / cs));
  const j1 = Math.min(n, Math.ceil((scroll.left + w - LABEL_W) / cs));

  // cell area
  ctx.save();
  ctx.beginPath();
  ctx.rect(LABEL_W, HEAD_H, w - LABEL_W, h - HEAD_H);
  ctx.clip();
  // upper triangle a faint tint (both themes), so "above vs below the diagonal" reads at a glance
  ctx.fillStyle = blend(t.textPrimary, 0.035, t.bgCanvas);
  for (let i = i0; i < i1; i++) {
    const from = Math.max(i + 1, j0);
    if (from < j1) ctx.fillRect(x0 + from * cs, y0 + i * cs, (j1 - from) * cs, cs);
  }
  if (hover) {
    ctx.fillStyle = t.bgSurface3;
    ctx.fillRect(x0 + j0 * cs, y0 + hover.i * cs, (j1 - j0) * cs, cs);
    ctx.fillRect(x0 + hover.j * cs, y0 + i0 * cs, cs, (i1 - i0) * cs);
  }
  ctx.fillStyle = t.bgSurface3;
  for (let k = Math.max(i0, j0); k < Math.min(i1, j1); k++) ctx.fillRect(x0 + k * cs, y0 + k * cs, cs, cs);
  if (cs >= 8) {
    ctx.strokeStyle = t.hairline;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      ctx.moveTo(x0 + j0 * cs, y0 + i * cs + 0.5);
      ctx.lineTo(x0 + j1 * cs, y0 + i * cs + 0.5);
    }
    for (let j = j0; j <= j1; j++) {
      ctx.moveTo(x0 + j * cs + 0.5, y0 + i0 * cs);
      ctx.lineTo(x0 + j * cs + 0.5, y0 + i1 * cs);
    }
    ctx.stroke();
  }
  let maxW = 1;
  for (const c of m.cells) maxW = Math.max(maxW, c.weight);
  const top = Math.log2(1 + maxW);
  const pad = cs >= 8 ? 1 : 0;
  for (const c of m.cells) {
    if (c.i < i0 || c.i >= i1 || c.j < j0 || c.j >= j1) continue;
    // grey ramp: weight on a log scale, from a faint tone to near text-primary
    ctx.fillStyle = blend(t.textPrimary, 0.16 + (0.74 * Math.log2(1 + c.weight)) / top, t.bgCanvas);
    const x = x0 + c.j * cs + pad;
    const y = y0 + c.i * cs + pad;
    ctx.fillRect(x, y, cs - 2 * pad, cs - 2 * pad);
    if (isUpward(c)) {
      ctx.fillStyle = t.warn;
      ctx.fillRect(x, y + cs - 2 * pad - 2, cs - 2 * pad, 2);
    }
  }
  if (hover) {
    ctx.strokeStyle = t.textPrimary;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x0 + hover.j * cs + 0.75, y0 + hover.i * cs + 0.75, cs - 1.5, cs - 1.5);
  }
  ctx.restore();

  // row labels (frozen left), column labels (frozen top, rotated)
  const fontPx = Math.min(12, Math.max(9, cs - 3));
  ctx.textBaseline = 'middle';
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, HEAD_H, LABEL_W, h - HEAD_H);
  ctx.clip();
  for (let i = i0; i < i1; i++) {
    const on = hover?.i === i;
    ctx.font = `${on ? 600 : 400} ${fontPx}px ${FONT}`;
    ctx.fillStyle = on ? t.textPrimary : t.textSecondary;
    ctx.textAlign = 'right';
    ctx.fillText(fit(ctx, matrixLabel(m.nodes[i]), LABEL_W - 48), LABEL_W - 32, y0 + i * cs + cs / 2);
    ctx.font = `400 ${Math.min(11, fontPx)}px ${FONT}`;
    ctx.fillStyle = t.textTertiary;
    ctx.fillText(String(i + 1), LABEL_W - 6, y0 + i * cs + cs / 2);
  }
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(LABEL_W, 0, w - LABEL_W, HEAD_H);
  ctx.clip();
  for (let j = j0; j < j1; j++) {
    const on = hover?.j === j;
    ctx.save();
    ctx.translate(x0 + j * cs + cs / 2, HEAD_H - 8);
    ctx.rotate(-Math.PI / 2);
    ctx.font = `${on ? 600 : 400} ${fontPx}px ${FONT}`;
    ctx.fillStyle = on ? t.textPrimary : t.textSecondary;
    ctx.textAlign = 'left';
    ctx.fillText(fit(ctx, matrixLabel(m.nodes[j]), HEAD_H - 16), 0, 0);
    ctx.restore();
  }
  ctx.restore();
  ctx.fillStyle = t.hairline;
  ctx.fillRect(LABEL_W - 0.5, 0, 1, h);
  ctx.fillRect(0, HEAD_H - 0.5, w, 1);
}

/** Dependency-structure matrix: rows depend on columns; tone = log weight; warn marks = upward deps. */
export function MatrixView({ repoId }: { repoId: string }) {
  const storeLevel = useStore((s) => s.level);
  const expanded = useStore((s) => s.expanded);
  const includeTests = useStore((s) => s.filters.includeTests);
  const theme = useStore((s) => s.theme);
  const level = storeLevel === 'L2' || storeLevel === 'L3' ? 'L2' : 'L1';
  const q = useQuery({
    queryKey: ['matrix', repoId, level, expanded.join(','), includeTests],
    queryFn: () => api.matrix(repoId, level, expanded, includeTests),
    placeholderData: keepPreviousData,
  });
  const m = q.data;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [scroll, setScroll] = useState({ left: 0, top: 0 });
  const [hover, setHover] = useState<Hover>();
  const n = m?.nodes.length ?? 0;
  const cs = n ? Math.max(14, Math.min(40, Math.floor(Math.min(size.w - LABEL_W - 24, size.h - HEAD_H - 24) / n))) : 14;
  const byCell = useMemo(() => new Map((m?.cells ?? []).map((c) => [c.i * 100_000 + c.j, c])), [m]);
  const upward = useMemo(() => (m ? m.cells.filter((c) => isUpward(c)).length : 0), [m]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: size changes the canvas box, which draw() reads
  useEffect(() => {
    if (canvasRef.current && m) draw(canvasRef.current, m, cs, scroll, hover, theme);
  }, [m, cs, scroll, hover, theme, size]);

  useEffect(() => {
    const source = {
      png: () =>
        new Promise<Blob | null>((resolve) => {
          const c = canvasRef.current;
          if (c) c.toBlob(resolve, 'image/png');
          else resolve(null);
        }),
    };
    exportTarget.current = source;
    return () => {
      if (exportTarget.current === source) exportTarget.current = undefined;
    };
  }, []);

  const cellAt = (e: React.MouseEvent): Hover | undefined => {
    const el = scrollRef.current;
    if (!el || !m) return undefined;
    const r = el.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (x < LABEL_W && y < HEAD_H) return undefined;
    const j = x >= LABEL_W ? Math.floor((x - LABEL_W + el.scrollLeft) / cs) : -1;
    const i = y >= HEAD_H ? Math.floor((y - HEAD_H + el.scrollTop) / cs) : -1;
    if (i >= n || j >= n) return undefined;
    return { i, j, x: e.clientX, y: e.clientY };
  };

  const onClick = (e: React.MouseEvent) => open(cellAt(e));
  const open = (hit: Hover | undefined) => {
    if (!hit || !m) return;
    const s = useStore.getState();
    if (hit.i < 0 || hit.j < 0) {
      s.select(m.nodes[Math.max(hit.i, hit.j)].id);
      return;
    }
    if (!byCell.has(hit.i * 100_000 + hit.j)) return;
    s.select(m.nodes[hit.i].id);
    s.setFlowQuery({ type: 'path', from: m.nodes[hit.i].id, to: m.nodes[hit.j].id });
  };

  // keyboard: arrows move a cell cursor (kept in view), Enter opens the path like a click
  const onKey = (e: React.KeyboardEvent) => {
    const el = scrollRef.current;
    const d = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
    if (e.key === 'Enter') open(hover);
    if (!d || !el || !n) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(n - 1, (hover?.i ?? 0) + (hover ? d[0] : 0)));
    const j = Math.max(0, Math.min(n - 1, (hover?.j ?? 0) + (hover ? d[1] : 0)));
    if (i * cs < el.scrollTop) el.scrollTop = i * cs;
    if ((i + 1) * cs > el.scrollTop + el.clientHeight - HEAD_H) el.scrollTop = (i + 1) * cs - el.clientHeight + HEAD_H;
    if (j * cs < el.scrollLeft) el.scrollLeft = j * cs;
    if ((j + 1) * cs > el.scrollLeft + el.clientWidth - LABEL_W)
      el.scrollLeft = (j + 1) * cs - el.clientWidth + LABEL_W;
    const r = el.getBoundingClientRect();
    setHover({
      i,
      j,
      x: r.left + LABEL_W + (j + 1) * cs - el.scrollLeft,
      y: r.top + HEAD_H + (i + 1) * cs - el.scrollTop,
    });
  };

  const hovered = hover && hover.i >= 0 && hover.j >= 0 ? byCell.get(hover.i * 100_000 + hover.j) : undefined;
  const label = level === 'L1' ? 'modules' : 'files';
  return (
    <>
      <canvas ref={canvasRef} className="matrix-canvas" />
      <div
        ref={scrollRef}
        className="matrix-scroll"
        onScroll={(e) => setScroll({ left: e.currentTarget.scrollLeft, top: e.currentTarget.scrollTop })}
        onMouseMove={(e) => setHover(cellAt(e))}
        onMouseLeave={() => setHover(undefined)}
        onClick={onClick}
        onKeyDown={onKey}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: the matrix is one keyboard-navigable widget (arrows + Enter)
        tabIndex={0}
        aria-label="Dependency matrix. Arrow keys move between cells, Enter shows the path."
        role="application"
        style={{ cursor: hovered ? 'pointer' : 'default' }}
      >
        <div style={{ width: LABEL_W + n * cs + 24, height: HEAD_H + n * cs + 24 }} />
      </div>
      {m && n > 0 && (
        <div className="matrix-corner" style={{ width: LABEL_W - 16, height: HEAD_H - 16 }}>
          <span className="t-strong">Dependency matrix</span>
          <span className="tone-2 num">
            {fmtNum(n)} {label} · {level}
          </span>
          <span className="tone-3">Rows depend on columns.</span>
          {upward > 0 && (
            <span className="tone-3 matrix-legend">
              <span className="matrix-mark" aria-hidden="true" />
              {fmtNum(upward)} upward
            </span>
          )}
        </div>
      )}
      {hover && hovered && m && (
        <div className="tooltip" style={{ left: Math.min(hover.x + 12, window.innerWidth - 330), top: hover.y + 12 }}>
          <div className="tooltip-title">
            <span className="ellipsis">
              {nodeLabel(m.nodes[hover.i])} → {nodeLabel(m.nodes[hover.j])}
            </span>
          </div>
          <div className="tone-2 num">
            weight {fmtNum(hovered.weight)}
            {isUpward(hovered) ? <span className="tone-warn"> · upward</span> : null}
          </div>
          <div className="tone-3">
            {Object.entries(hovered.kinds)
              .map(([k, v]) => `${k.replace('_', ' ')} ${fmtNum(v)}`)
              .join(' · ')}
          </div>
        </div>
      )}
      {q.isLoading && (
        <div className="canvas-empty">
          <Spinner label="Loading matrix" />
        </div>
      )}
      {q.isError && !m && (
        <div className="canvas-empty">
          <EmptyState
            title="Could not load the matrix"
            body={(q.error as Error).message}
            action={{ label: 'Retry', onClick: () => void q.refetch() }}
          />
        </div>
      )}
      {m && n === 0 && (
        <div className="canvas-empty">
          <EmptyState title="Nothing to compare" body={`No ${label} at this level. Try L2 or include tests.`} />
        </div>
      )}
    </>
  );
}
