import type { NodeKind } from '@spider/shared';
import { Minus, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { KIND_LABEL, SHAPE, nodeLook } from '../theme';

/* ---------- kind glyph (same shape vocabulary as the canvas) ---------- */

export function ShapeGlyph({
  shape,
  size = 14,
  fill,
  stroke,
}: { shape: number; size?: number; fill?: string; stroke?: string }) {
  const c = size / 2;
  const r = size / 2 - 2;
  const common = { fill: fill ?? 'none', stroke: stroke ?? (fill ? 'none' : 'currentColor'), strokeWidth: 1.5 };
  let el: ReactNode;
  if (shape === SHAPE.diamond) {
    const k = r * 1.05;
    el = <path d={`M${c} ${c - k}L${c + k} ${c}L${c} ${c + k}L${c - k} ${c}Z`} {...common} />;
  } else if (shape === SHAPE.square || shape === SHAPE.roundedSquare) {
    const h = r * 0.86;
    el = <rect x={c - h} y={c - h} width={2 * h} height={2 * h} rx={shape === SHAPE.square ? 1 : 2.5} {...common} />;
  } else if (shape === SHAPE.hexagon) {
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i;
      return `${c + Math.cos(a) * r},${c + Math.sin(a) * r}`;
    }).join(' ');
    el = <polygon points={pts} {...common} />;
  } else {
    el = <circle cx={c} cy={c} r={r * 0.9} {...common} />;
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" className="glyph">
      {el}
    </svg>
  );
}

export function KindGlyph({ kind, size }: { kind: NodeKind; size?: number }) {
  return <ShapeGlyph shape={nodeLook(kind, 'dark').shape} size={size} />;
}

export function KindBadge({ kind }: { kind: NodeKind }) {
  return <span className={kind === 'endpoint' ? 'badge badge-accent' : 'badge'}>{KIND_LABEL[kind]}</span>;
}

/* ---------- segmented control ---------- */

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio-group pattern on buttons keeps the segmented look
          role="radio"
          aria-checked={o.value === value}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- tabs ---------- */

export function Tabs<T extends string>({
  value,
  options,
  onChange,
}: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- stepper ---------- */

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: { value: number; min: number; max: number; onChange: (v: number) => void; label: string }) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: an inline control group; <fieldset> would break inline layout
    <span className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        disabled={value <= min}
        onClick={() => onChange(value - 1)}
        aria-label={`Decrease ${label}`}
      >
        <Minus size={14} strokeWidth={1.5} />
      </button>
      <span className="num">{value}</span>
      <button
        type="button"
        disabled={value >= max}
        onClick={() => onChange(value + 1)}
        aria-label={`Increase ${label}`}
      >
        <Plus size={14} strokeWidth={1.5} />
      </button>
    </span>
  );
}

/* ---------- icon button (always with a tooltip) ---------- */

export function IconButton({
  label,
  onClick,
  children,
  pressed,
  shortcut,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  pressed?: boolean;
  shortcut?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-icon"
      aria-label={label}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/* ---------- progress, empty state ---------- */

export function Progress({ value }: { value?: number }) {
  const indeterminate = value === undefined || !Number.isFinite(value);
  return (
    <div
      className="progress"
      data-indeterminate={indeterminate}
      role="progressbar"
      tabIndex={-1}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : Math.round((value ?? 0) * 100)}
    >
      <div style={indeterminate ? undefined : { transform: `scaleX(${Math.max(0, Math.min(1, value ?? 0))})` }} />
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: { title: string; body?: string; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="empty">
      <h3 className="t-title-3">{title}</h3>
      {body && <p>{body}</p>}
      {action && (
        <button type="button" className="btn btn-secondary" onClick={action.onClick}>
          {action.label}
        </button>
      )}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return <span className="ring-spinner" role="status" aria-label={label} />;
}
