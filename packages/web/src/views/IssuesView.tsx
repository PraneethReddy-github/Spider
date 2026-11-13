import { Map as MapIcon, Route } from 'lucide-react';
import { useState } from 'react';
import type { AnyDiagnostic, DiagnosticType } from '../api';
import { DIAG_LABEL, DIAG_ORDER, fmtNum } from '../format';
import { useDiagnostics, useRevealMany } from '../hooks';
import { useStore } from '../store';
import { EmptyState, Segmented, Spinner } from '../ui';

const DIAG_HINT: Record<DiagnosticType, string> = {
  cycle: 'Files that import each other in a loop. Break one edge to restore a clear direction.',
  'layer-violation': 'A lower layer depends on a higher one, against the inferred layering.',
  'god-module': 'Files with unusually many dependants or dependencies.',
  'dead-code': 'Exported symbols nothing in the repository references.',
  orphan: 'Files nothing imports and that import nothing.',
};

const tone = (t: DiagnosticType) =>
  t === 'cycle' ? 'tone-danger' : t === 'layer-violation' || t === 'god-module' ? 'tone-warn' : '';

/** Every diagnostic, grouped by type; each item reveals its nodes on the map (rings mark them there). */
export function IssuesView({ repoId }: { repoId: string }) {
  const q = useDiagnostics(repoId);
  const revealMany = useRevealMany();
  const [type, setType] = useState<DiagnosticType | 'all'>('all');

  if (q.isLoading)
    return (
      <div className="canvas-empty">
        <Spinner label="Loading issues" />
      </div>
    );
  if (q.isError)
    return (
      <div className="canvas-empty">
        <EmptyState
          title="Could not load issues"
          body={(q.error as Error).message}
          action={{ label: 'Retry', onClick: () => void q.refetch() }}
        />
      </div>
    );
  const all = q.data ?? [];
  if (!all.length)
    return (
      <div className="canvas-empty">
        <EmptyState
          title="No issues found"
          body="No cycles, layer violations, large hubs, unreferenced exports or orphan files."
        />
      </div>
    );

  const present = DIAG_ORDER.filter((t) => all.some((d) => d.type === t));
  const shown = type === 'all' ? present : present.filter((t) => t === type);
  const showPath = (d: AnyDiagnostic) => {
    const s = useStore.getState();
    s.select(d.nodeIds[0]);
    s.setFlowQuery({ type: 'path', from: d.nodeIds[0], to: d.nodeIds[d.nodeIds.length - 1] });
  };

  return (
    <div className="view-page">
      <header className="view-page-head">
        <h2 className="t-title-3">Issues</h2>
        <span className="num tone-3">{fmtNum(all.length)}</span>
        <span style={{ marginLeft: 'auto' }}>
          <Segmented
            label="Issue type"
            value={type}
            onChange={setType}
            options={[
              { value: 'all', label: 'All' },
              ...present.map((t) => ({
                value: t,
                label: `${DIAG_LABEL[t]} ${fmtNum(all.filter((d) => d.type === t).length)}`,
              })),
            ]}
          />
        </span>
      </header>
      <div className="view-list">
        {shown.map((t) => {
          const list = all.filter((d) => d.type === t);
          return (
            <section key={t}>
              <div className="group-head">
                <h3 className={`t-title-3 ${tone(t)}`}>{DIAG_LABEL[t]}</h3>
                <span className="num tone-3">{fmtNum(list.length)}</span>
              </div>
              <p className="tone-2" style={{ marginBottom: 8 }}>
                {DIAG_HINT[t]}
              </p>
              <ul>
                {list.map((d, i) => (
                  <li key={`${d.title}-${i}`} className="item-row">
                    <div className="grow">
                      <div className="ellipsis">{d.title}</div>
                      {d.detail && <div className="detail t-mono ellipsis">{d.detail}</div>}
                    </div>
                    <span className="num tone-3" title="Nodes involved">
                      {fmtNum(d.nodeIds.length)} {d.nodeIds.length === 1 ? 'node' : 'nodes'}
                    </span>
                    <span className="item-actions">
                      {d.type === 'cycle' && d.nodeIds.length > 1 && (
                        <button type="button" className="btn btn-ghost" onClick={() => showPath(d)}>
                          <Route size={16} strokeWidth={1.5} aria-hidden="true" />
                          Path
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn btn-ghost"
                        disabled={!d.nodeIds.length}
                        onClick={() => void revealMany(d.nodeIds)}
                      >
                        <MapIcon size={16} strokeWidth={1.5} aria-hidden="true" />
                        Show on map
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>
    </div>
  );
}
