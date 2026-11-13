import type { NodeKind } from '@spider/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { nodeLabel } from '../format';
import { useReveal } from '../hooks';
import { useStore } from '../store';
import { KindBadge } from '../ui';

const FILTERS: { label: string; kinds?: NodeKind[] }[] = [
  { label: 'All' },
  { label: 'Files', kinds: ['file'] },
  { label: 'Classes', kinds: ['class'] },
  { label: 'Functions', kinds: ['function', 'method'] },
  { label: 'Endpoints', kinds: ['endpoint'] },
];

export function SearchPalette({ repoId }: { repoId: string }) {
  const open = useStore((s) => s.searchOpen);
  const setOpen = useStore((s) => s.setSearchOpen);
  const view = useStore((s) => s.view);
  const reveal = useReveal();
  const [text, setText] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState(0);

  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(text.trim()), 120);
    return () => window.clearTimeout(t);
  }, [text]);
  useEffect(() => {
    if (open) setText('');
  }, [open]);

  const kinds = FILTERS[filter].kinds;
  const results = useQuery({
    queryKey: ['search', repoId, debounced, kinds?.join(',') ?? '*'],
    queryFn: () => api.search(repoId, debounced, kinds, 30),
    enabled: open && debounced.length > 0,
    placeholderData: keepPreviousData,
  });

  if (!open) return null;
  const hits = debounced ? (results.data ?? []) : [];
  const pick = (id: string) => {
    setOpen(false);
    void reveal(id, { view: view === 'flow' ? 'map' : view });
  };

  return (
    <>
      <div className="palette-backdrop" onMouseDown={() => setOpen(false)} />
      <Command className="palette" label="Search" shouldFilter={false} loop>
        <Command.Input
          value={text}
          onValueChange={setText}
          placeholder="Search files, classes, functions, endpoints"
          autoFocus
        />
        <div className="palette-chips">
          {FILTERS.map((f, i) => (
            <button key={f.label} type="button" aria-pressed={i === filter} onClick={() => setFilter(i)}>
              {f.label}
            </button>
          ))}
        </div>
        <Command.List>
          {debounced && !results.isFetching && hits.length === 0 && (
            <Command.Empty>No matches for “{debounced}”.</Command.Empty>
          )}
          {!debounced && <div className="empty tone-2">Type a name. Exact and prefix matches rank first.</div>}
          {hits.map((h) => (
            <Command.Item key={h.node.id} value={h.node.id} onSelect={pick}>
              <KindBadge kind={h.node.kind} />
              <span className="ellipsis" style={{ flex: 'none', maxWidth: '45%' }}>
                {nodeLabel(h.node)}
              </span>
              <span className="t-mono tone-3 ellipsis" style={{ flex: 1, textAlign: 'right' }}>
                {h.node.qname ?? h.node.file ?? ''}
              </span>
            </Command.Item>
          ))}
        </Command.List>
        <div className="palette-foot kbd">
          <span>↑↓ navigate</span>
          <span>⏎ open</span>
          <span>esc close</span>
        </div>
      </Command>
    </>
  );
}
