import type Sigma from 'sigma';
import { SHAPE, type ThemeName, graphPalette, tokens } from '../theme';

/** What the Export menu can render for the view on screen. Views register themselves while mounted. */
export interface ExportSource {
  png?: () => Promise<Blob | null>;
  svg?: () => string;
}
export const exportTarget: { current?: ExportSource } = {};

export interface RegionRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Composites sigma's layers (WebGL + 2D, in DOM order) over the canvas colour. */
export function sigmaPng(sigma: Sigma, theme: ThemeName): Promise<Blob | null> {
  sigma.refresh(); // renders synchronously, so the WebGL buffers are readable in this task
  const { width, height } = sigma.getDimensions();
  const dpr = window.devicePixelRatio || 1;
  const out = document.createElement('canvas');
  out.width = Math.round(width * dpr);
  out.height = Math.round(height * dpr);
  const ctx = out.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.fillStyle = tokens[theme].bgCanvas;
  ctx.fillRect(0, 0, out.width, out.height);
  for (const c of sigma.getContainer().querySelectorAll('canvas')) ctx.drawImage(c, 0, 0, out.width, out.height);
  return new Promise((resolve) => out.toBlob(resolve, 'image/png'));
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);
const f1 = (n: number) => n.toFixed(1);

function shapeSvg(x: number, y: number, r: number, shape: number, attrs: string): string {
  if (shape === SHAPE.diamond) {
    const k = r * 1.05;
    return `<path d="M${f1(x)} ${f1(y - k)}L${f1(x + k)} ${f1(y)}L${f1(x)} ${f1(y + k)}L${f1(x - k)} ${f1(y)}Z" ${attrs}/>`;
  }
  if (shape === SHAPE.square || shape === SHAPE.roundedSquare) {
    const h = r * 0.86;
    const rx = shape === SHAPE.square ? r * 0.1 : r * 0.32;
    return `<rect x="${f1(x - h)}" y="${f1(y - h)}" width="${f1(2 * h)}" height="${f1(2 * h)}" rx="${f1(rx)}" ${attrs}/>`;
  }
  if (shape === SHAPE.hexagon) {
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i;
      return `${f1(x + Math.cos(a) * r)},${f1(y + Math.sin(a) * r)}`;
    }).join(' ');
    return `<polygon points="${pts}" ${attrs}/>`;
  }
  return `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(r)}" ${attrs}/>`;
}

/**
 * Vector copy of what sigma shows: regions, edges (with arrowheads), node shapes with rings and the
 * labels sigma would draw. Uses the reducers' display data, so selection dimming carries over.
 */
export function sigmaSvg(sigma: Sigma, theme: ThemeName, regions: RegionRect[]): string {
  const t = tokens[theme];
  const { width, height } = sigma.getDimensions();
  const graph = sigma.getGraph();
  const parts: string[] = [];
  parts.push(`<rect width="100%" height="100%" fill="${t.bgCanvas}"/>`);
  for (const r of regions)
    parts.push(
      `<rect x="${f1(r.x)}" y="${f1(r.y)}" width="${f1(r.w)}" height="${f1(r.h)}" rx="14" fill="${graphPalette[theme].region}" stroke="${t.hairlineStrong}"/>`,
    );
  const view = (id: string) => {
    const d = sigma.getNodeDisplayData(id);
    if (!d || d.hidden) return undefined;
    return { ...sigma.framedGraphToViewport(d), r: sigma.scaleSize(d.size), d };
  };
  graph.forEachEdge((e, a, src, dst) => {
    const ed = sigma.getEdgeDisplayData(e);
    const s = view(src);
    const d = view(dst);
    if (!ed || ed.hidden || !s || !d) return;
    const w = Math.max(0.6, sigma.scaleSize(ed.size));
    const dx = d.x - s.x;
    const dy = d.y - s.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const ex = d.x - ux * d.r;
    const ey = d.y - uy * d.r;
    parts.push(
      `<line x1="${f1(s.x)}" y1="${f1(s.y)}" x2="${f1(ex)}" y2="${f1(ey)}" stroke="${ed.color}" stroke-width="${f1(w)}"/>`,
    );
    if (a.type !== 'line') {
      const h = 4 + w * 2;
      const bx = ex - ux * h;
      const by = ey - uy * h;
      parts.push(
        `<path d="M${f1(ex)} ${f1(ey)}L${f1(bx - uy * h * 0.5)} ${f1(by + ux * h * 0.5)}L${f1(bx + uy * h * 0.5)} ${f1(by - ux * h * 0.5)}Z" fill="${ed.color}"/>`,
      );
    }
  });
  const labels: string[] = [];
  graph.forEachNode((id) => {
    const v = view(id);
    if (!v) return;
    const d = v.d as typeof v.d & { shape?: number; ringColor?: string; ringWidth?: number; labelTone?: string };
    const ring = d.ringColor && d.ringWidth ? `stroke="${d.ringColor}" stroke-width="${d.ringWidth}"` : '';
    parts.push(shapeSvg(v.x, v.y, v.r, d.shape ?? SHAPE.circle, `fill="${d.color}" ${ring}`));
    if (d.label && (d.forceLabel || v.r >= 7) && labels.length < 400) {
      const fill =
        d.labelTone === 'secondary' ? t.textSecondary : d.labelTone === 'accent' ? t.accentText : t.textPrimary;
      labels.push(
        `<text x="${f1(v.x + v.r * 1.15 + 4)}" y="${f1(v.y + 4)}" fill="${fill}" stroke="${t.bgCanvas}" stroke-width="3" paint-order="stroke" stroke-linejoin="round">${esc(d.label)}</text>`,
      );
    }
  });
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', Inter, sans-serif" font-size="12" font-weight="500">`,
    ...parts,
    ...labels,
    '</svg>',
  ].join('\n');
}
