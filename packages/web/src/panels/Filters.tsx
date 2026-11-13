import type { EdgeKind, NodeKind } from '@spider/shared';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useStore } from '../store';
import {
  FILTER_EDGE_KINDS,
  FILTER_NODE_KINDS,
  KIND_LABEL,
  LEGEND_EDGE_KINDS,
  LEGEND_NODE_KINDS,
  edgeColorOf,
  nodeLook,
} from '../theme';
import { ShapeGlyph } from '../ui';

function Section({
  title,
  children,
  defaultOpen = false,
}: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="side-section">
      <button
        type="button"
        className="row"
        style={{ paddingLeft: 0 }}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ChevronRight className="chevron" data-open={open} strokeWidth={1.5} />
        <span className="t-caption">{title}</span>
      </button>
      {open && <div style={{ marginTop: 4 }}>{children}</div>}
    </section>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="ellipsis">{label}</span>
    </label>
  );
}

const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v));

export function FiltersSection({ languages }: { languages: string[] }) {
  const f = useStore((s) => s.filters);
  const set = useStore((s) => s.setFilters);
  const reset = useStore((s) => s.resetFilters);
  const hiddenCount = useStore((s) => s.hidden.length);
  const unhide = useStore((s) => s.unhideAll);
  const nodeKinds = f.nodeKinds ?? FILTER_NODE_KINDS;
  const langs = f.languages ?? languages;

  return (
    <Section title="Filters">
      <div className="filters">
        <span className="t-caption tone-3">Edges</span>
        <div className="filter-grid">
          {FILTER_EDGE_KINDS.map((k) => (
            <Check
              key={k}
              label={k.replace('_', ' ')}
              checked={f.edgeKinds.includes(k)}
              onChange={(on) => set({ edgeKinds: toggle<EdgeKind>(f.edgeKinds, k, on) })}
            />
          ))}
        </div>
        <span className="t-caption tone-3" style={{ marginTop: 8 }}>
          Nodes
        </span>
        <div className="filter-grid">
          {FILTER_NODE_KINDS.map((k) => (
            <Check
              key={k}
              label={KIND_LABEL[k]}
              checked={nodeKinds.includes(k)}
              onChange={(on) => {
                const next = toggle<NodeKind>(nodeKinds, k, on);
                // containers must stay so the hierarchy can still be walked
                set({
                  nodeKinds:
                    next.length === FILTER_NODE_KINDS.length
                      ? undefined
                      : ([...next, 'subsystem', 'package', 'repository'] as NodeKind[]),
                });
              }}
            />
          ))}
        </div>
        {languages.length > 1 && (
          <>
            <span className="t-caption tone-3" style={{ marginTop: 8 }}>
              Languages
            </span>
            <div className="filter-grid">
              {languages.map((l) => (
                <Check
                  key={l}
                  label={l}
                  checked={langs.includes(l)}
                  onChange={(on) => {
                    const next = toggle(langs, l, on);
                    set({ languages: next.length === languages.length ? undefined : next });
                  }}
                />
              ))}
            </div>
          </>
        )}
        <span className="t-caption tone-3" style={{ marginTop: 8 }}>
          Display
        </span>
        <Check label="Include tests" checked={f.includeTests} onChange={(v) => set({ includeTests: v })} />
        <Check label="Hide uncertain edges" checked={f.hideAmbiguous} onChange={(v) => set({ hideAmbiguous: v })} />
        <Check
          label="Colour by subsystem"
          checked={f.colorBySubsystem}
          onChange={(v) => set({ colorBySubsystem: v })}
        />
        <label className="tone-2" style={{ display: 'grid', gap: 4, marginTop: 4 }}>
          <span>
            Minimum confidence <span className="num tone-3">{f.minConfidence.toFixed(1)}</span>
          </span>
          <input
            className="range"
            type="range"
            min={0}
            max={1}
            step={0.1}
            value={f.minConfidence}
            onChange={(e) => set({ minConfidence: Number(e.target.value) })}
          />
        </label>
        <div className="actions" style={{ marginTop: 8 }}>
          <button type="button" className="btn btn-secondary" onClick={reset}>
            Reset filters
          </button>
          {hiddenCount > 0 && (
            <button type="button" className="btn btn-ghost" onClick={unhide} title="Shift+H">
              Show {hiddenCount} hidden
            </button>
          )}
        </div>
      </div>
    </Section>
  );
}

export function LegendSection() {
  const theme = useStore((s) => s.theme);
  return (
    <Section title="Legend">
      <div className="legend">
        {LEGEND_NODE_KINDS.map((k) => {
          const look = nodeLook(k, theme);
          return (
            <span key={k} className="legend-item">
              <ShapeGlyph shape={look.shape} fill={look.fill} stroke={look.ring} />
              {KIND_LABEL[k]}
            </span>
          );
        })}
      </div>
      <div className="legend" style={{ marginTop: 8 }}>
        {LEGEND_EDGE_KINDS.map((k) => (
          <span key={k} className="legend-item">
            <svg width="20" height="8" aria-hidden="true">
              <line x1="0" y1="4" x2="20" y2="4" stroke={edgeColorOf(k, theme)} strokeWidth="1.5" />
            </svg>
            {k.replace('_', ' ')}
          </span>
        ))}
        <span className="legend-item">
          <svg width="20" height="8" aria-hidden="true">
            <line x1="0" y1="4" x2="20" y2="4" stroke={edgeColorOf('calls', theme)} strokeWidth="0.8" opacity="0.5" />
          </svg>
          uncertain
        </span>
      </div>
    </Section>
  );
}
