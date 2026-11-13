import type { Settings } from 'sigma/settings';
import type { NodeDisplayData, PartialButFor } from 'sigma/types';
import { SHAPE, type ThemeName, tokens } from '../theme';

/** Theme the 2D layers draw with; set by GraphCanvas whenever the app theme changes. */
export const drawTheme: { name: ThemeName } = { name: 'dark' };

type Data = PartialButFor<NodeDisplayData, 'x' | 'y' | 'size' | 'label' | 'color'> & {
  shape?: number;
  labelTone?: 'primary' | 'secondary' | 'accent';
  labelBelow?: boolean;
};

const FONT =
  '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter Variable", "Inter", "Segoe UI", Roboto, sans-serif';

function labelColor(tone: Data['labelTone']): string {
  const t = tokens[drawTheme.name];
  return tone === 'secondary' ? t.textSecondary : tone === 'accent' ? t.accentText : t.textPrimary;
}

/** 12 px label right of the node, legible through a canvas-coloured stroke instead of a pill. */
export function drawLabel(ctx: CanvasRenderingContext2D, data: Data, _settings: Settings): void {
  if (!data.label) return;
  ctx.font = `500 12px ${FONT}`;
  let x = data.x + data.size * 1.15 + 4;
  let y = data.y + 4;
  if (data.labelBelow) {
    x = data.x - ctx.measureText(data.label).width / 2;
    y = data.y + data.size * 1.2 + 14;
  }
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = tokens[drawTheme.name].bgCanvas;
  ctx.strokeText(data.label, x, y);
  ctx.fillStyle = labelColor(data.labelTone);
  ctx.fillText(data.label, x, y);
}

/** Traces the node outline (matching the WebGL shape) slightly outside the node. */
export function shapePath(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, shape: number): void {
  ctx.beginPath();
  if (shape === SHAPE.diamond) {
    const k = r * 1.22;
    ctx.moveTo(x, y - k);
    ctx.lineTo(x + k, y);
    ctx.lineTo(x, y + k);
    ctx.lineTo(x - k, y);
    ctx.closePath();
  } else if (shape === SHAPE.square || shape === SHAPE.roundedSquare) {
    const h = r * 0.86;
    ctx.roundRect(x - h, y - h, 2 * h, 2 * h, shape === SHAPE.square ? r * 0.1 : r * 0.32);
  } else if (shape === SHAPE.hexagon) {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const px = x + Math.cos(a) * r;
      const py = y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

/** Hover: 1.5 px primary ring around the node plus its label (tooltip lives in the DOM). */
export function drawHover(ctx: CanvasRenderingContext2D, data: Data, settings: Settings): void {
  shapePath(ctx, data.x, data.y, data.size + 2.5, data.shape ?? SHAPE.circle);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = tokens[drawTheme.name].textPrimary;
  ctx.stroke();
  drawLabel(ctx, data, settings);
}
