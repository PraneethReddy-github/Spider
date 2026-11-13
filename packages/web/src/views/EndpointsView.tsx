import type { EndpointSummary } from '@spider/shared';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { actions } from '../actions';
import { api } from '../api';
import { fmtNum, locationOf } from '../format';
import { useStore } from '../store';
import { EmptyState, Spinner } from '../ui';

type Key = 'method' | 'path' | 'framework' | 'handler' | 'file' | 'depth';

const COLUMNS: { key: Key; label: string; right?: boolean }[] = [
  { key: 'method', label: 'Method' },
  { key: 'path', label: 'Path' },
  { key: 'framework', label: 'Framework' },
  { key: 'handler', label: 'Handler' },
  { key: 'file', label: 'File' },
  { key: 'depth', label: 'Depth', right: true },
];

function cell(e: EndpointSummary, k: Key): string | number {
  const p = e.node.props;
  switch (k) {
    case 'method':
      return String(p.method ?? '').toUpperCase();
    case 'path':
      return String(p.path ?? e.node.name);
    case 'framework':
      return String(p.framework ?? '');
    case 'handler':
      return e.handler ? (e.handler.qname?.split('::').pop() ?? e.handler.name) : '';
    case 'file':
      return locationOf(e.node) ?? '';
    case 'depth':
      return e.traceDepth;
  }
}

/** Full-canvas table of every endpoint: sortable, filterable; a row opens its trace in Flow. */
export function EndpointsView({ repoId }: { repoId: string }) {
  const includeTests = useStore((s) => s.filters.includeTests);
  const selected = useStore((s) => s.selected);
  const q = useQuery({ queryKey: ['endpoints', repoId], queryFn: () => api.endpoints(repoId) });
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState<{ key: Key; desc: boolean }>({ key: 'path', desc: false });

  const rows = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = (q.data ?? []).filter(
      (e) =>
        (includeTests || !e.node.props.isTest) &&
        (!needle || COLUMNS.some((c) => String(cell(e, c.key)).toLowerCase().includes(needle))),
    );
    const dir = sort.desc ? -1 : 1;
    return list.sort((a, b) => {
      const x = cell(a, sort.key);
      const y = cell(b, sort.key);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * dir;
    });
  }, [q.data, filter, sort, includeTests]);

  if (q.isLoading)
    return (
      <div className="canvas-empty">
        <Spinner label="Loading endpoints" />
      </div>
    );
  if (q.isError)
    return (
      <div className="canvas-empty">
        <EmptyState
          title="Could not load endpoints"
          body={(q.error as Error).message}
          action={{ label: 'Retry', onClick: () => void q.refetch() }}
        />
      </div>
    );
  if (!q.data?.length)
    return (
      <div className="canvas-empty">
        <EmptyState title="No endpoints found" body="No supported web framework routes were detected." />
      </div>
    );

  return (
    <div className="view-page">
      <header className="view-page-head">
        <h2 className="t-title-3">Endpoints</h2>
        <span className="num tone-3">{fmtNum(rows.length)}</span>
        <label className="input view-filter">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">Filter endpoints</span>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by method, path, handler or file"
            spellCheck={false}
          />
        </label>
      </header>
      {rows.length === 0 ? (
        <EmptyState title="No matching endpoints" body="Clear the filter to see every endpoint." />
      ) : (
        <table className="table table-fixed">
          <colgroup>
            <col style={{ width: 76 }} />
            <col style={{ width: '24%' }} />
            <col style={{ width: 112 }} />
            <col style={{ width: '20%' }} />
            <col />
            <col style={{ width: 76 }} />
          </colgroup>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  className={c.right ? 'right' : undefined}
                  aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}
                  title={c.key === 'depth' ? 'Trace depth: calls from the endpoint to its deepest callee' : undefined}
                >
                  <button
                    type="button"
                    className="th-sort"
                    onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : c.key === 'depth' })}
                  >
                    {c.label}
                    {sort.key === c.key &&
                      (sort.desc ? <ArrowDown size={12} strokeWidth={1.5} /> : <ArrowUp size={12} strokeWidth={1.5} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr
                key={e.node.id}
                className="table-select"
                aria-selected={selected === e.node.id}
                tabIndex={0}
                title="Trace this endpoint"
                onClick={() => actions.trace(e.node.id)}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') actions.trace(e.node.id);
                }}
              >
                <td className="t-mono tone-2">{cell(e, 'method')}</td>
                <td className="t-mono ellipsis" title={String(cell(e, 'path'))}>
                  {cell(e, 'path')}
                </td>
                <td className="tone-2">{cell(e, 'framework') || '–'}</td>
                <td className="t-mono ellipsis" title={String(cell(e, 'handler'))}>
                  {cell(e, 'handler') || <span className="tone-3">inline</span>}
                </td>
                <td className="t-mono tone-3 ellipsis" title={String(cell(e, 'file'))}>
                  {cell(e, 'file')}
                </td>
                <td className="right num tone-2">{e.traceDepth}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
