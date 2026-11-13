import { useQuery } from '@tanstack/react-query';
import { ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { fmtNum, nodeLabel } from '../format';
import { useReveal } from '../hooks';
import { useStore } from '../store';
import { EmptyState, KindGlyph, Spinner } from '../ui';

/** Which internal files use which dependency: externals by usage, expandable to their users. */
export function ExternalsView({ repoId }: { repoId: string }) {
  const q = useQuery({ queryKey: ['externals', repoId], queryFn: () => api.externals(repoId) });
  const reveal = useReveal();
  const selected = useStore((s) => s.selected);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');

  const list = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return [...(q.data ?? [])]
      .filter((x) => !needle || x.node.name.toLowerCase().includes(needle))
      .sort((a, b) => b.total - a.total || a.node.name.localeCompare(b.node.name));
  }, [q.data, filter]);

  if (q.isLoading)
    return (
      <div className="canvas-empty">
        <Spinner label="Loading externals" />
      </div>
    );
  if (q.isError)
    return (
      <div className="canvas-empty">
        <EmptyState
          title="Could not load externals"
          body={(q.error as Error).message}
          action={{ label: 'Retry', onClick: () => void q.refetch() }}
        />
      </div>
    );
  if (!q.data?.length)
    return (
      <div className="canvas-empty">
        <EmptyState title="No external dependencies" body="Nothing in this repository imports a package." />
      </div>
    );

  const toggle = (id: string) => {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  };

  return (
    <div className="view-page">
      <header className="view-page-head">
        <h2 className="t-title-3">Externals</h2>
        <span className="num tone-3">{fmtNum(list.length)}</span>
        <label className="input view-filter">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">Filter externals</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by package"
            spellCheck={false}
          />
        </label>
      </header>
      <div className="view-list">
        <div className="list-head t-caption tone-3">
          <span>Package</span>
          <span>Uses</span>
        </div>
        {list.length === 0 && <EmptyState title="No matching packages" body="Clear the filter to see every package." />}
        <ul>
          {list.map((x) => {
            const isOpen = open.has(x.node.id);
            const meta = [x.node.props.ecosystem, x.node.props.version].filter(Boolean).join(' · ');
            return (
              <li key={x.node.id}>
                <button type="button" className="row" aria-expanded={isOpen} onClick={() => toggle(x.node.id)}>
                  <ChevronRight className="chevron" data-open={isOpen} strokeWidth={1.5} />
                  <KindGlyph kind="external" />
                  <span className="name">
                    {x.node.name}
                    {meta && <span className="t-mono tone-3"> {meta}</span>}
                  </span>
                  <span className="meta">
                    {fmtNum(x.total)} in {fmtNum(x.users.length)} {x.users.length === 1 ? 'file' : 'files'}
                  </span>
                </button>
                {isOpen && (
                  <ul>
                    {[...x.users]
                      .sort((a, b) => b.weight - a.weight)
                      .map((u) => (
                        <li key={u.node.id}>
                          <button
                            type="button"
                            className="row"
                            style={{ paddingLeft: 48 }}
                            aria-selected={selected === u.node.id}
                            title="Show on map"
                            onClick={() => void reveal(u.node.id)}
                          >
                            <KindGlyph kind={u.node.kind} />
                            <span className="name t-mono">{u.node.file ?? nodeLabel(u.node)}</span>
                            <span className="meta">{fmtNum(u.weight)}</span>
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
