import { useEffect, useRef } from 'react';
import type Sigma from 'sigma';
import { type ThemeName, tokens } from '../theme';

const W = 160;
const H = 110;

/** 160×110 overview: nodes as 1 px dots, viewport as a hairline-strong rectangle. Click to pan. */
export function Minimap({ sigma, theme }: { sigma?: Sigma; theme: ThemeName }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!sigma || !canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    let raf = 0;
    const m = 8;
    // framed graph space is roughly [0,1]²; map it into the minimap with a small margin
    const toMini = (x: number, y: number) => ({ x: m + x * (W - 2 * m), y: m + (1 - y) * (H - 2 * m) });
    // the dots only change when nodes do: keep them in an offscreen layer, redraw just the viewport box per frame
    const dots = document.createElement('canvas');
    dots.width = W * dpr;
    dots.height = H * dpr;
    const dctx = dots.getContext('2d');
    let dirty = true;
    const markDirty = () => {
      dirty = true;
    };
    const graph = sigma.getGraph();
    // display data (framed positions) is recomputed only by a process pass, never by camera moves
    sigma.on('afterProcess', markDirty);
    const draw = () => {
      raf = 0;
      const t = tokens[theme];
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, W * dpr, H * dpr);
      if (graph.order === 0 || !dctx) return;
      if (dirty) {
        dirty = false;
        dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        dctx.clearRect(0, 0, W, H);
        dctx.fillStyle = t.textTertiary;
        graph.forEachNode((id) => {
          const d = sigma.getNodeDisplayData(id);
          if (!d || d.hidden) return;
          const p = toMini(d.x, d.y);
          dctx.fillRect(p.x, p.y, 1, 1);
        });
      }
      ctx.drawImage(dots, 0, 0);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const { width, height } = sigma.getDimensions();
      const a = sigma.viewportToFramedGraph({ x: 0, y: 0 });
      const b = sigma.viewportToFramedGraph({ x: width, y: height });
      const pa = toMini(a.x, a.y);
      const pb = toMini(b.x, b.y);
      ctx.strokeStyle = t.hairlineStrong;
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.min(pa.x, pb.x) + 0.5,
        Math.min(pa.y, pb.y) + 0.5,
        Math.abs(pb.x - pa.x),
        Math.abs(pb.y - pa.y),
      );
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    sigma.on('afterRender', schedule);
    schedule();
    return () => {
      sigma.off('afterRender', schedule);
      sigma.off('afterProcess', markDirty);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [sigma, theme]);

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!sigma) return;
    const r = e.currentTarget.getBoundingClientRect();
    const m = 8;
    const x = (e.clientX - r.left - m) / (W - 2 * m);
    const y = 1 - (e.clientY - r.top - m) / (H - 2 * m);
    sigma.getCamera().animate({ x, y }, { duration: 250 });
  };

  return (
    <div className="overlay minimap" aria-hidden="true">
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: pointer shortcut only; F, search and the explorer cover keyboard navigation */}
      <canvas ref={ref} style={{ width: W, height: H, display: 'block' }} onClick={onClick} />
    </div>
  );
}
