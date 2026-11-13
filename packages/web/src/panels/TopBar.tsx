import type { RepoInfo, ViewLevel } from '@spider/shared';
import { Download, Maximize, Moon, PanelLeft, PanelRight, Search, Sun } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { type ViewMode, useStore } from '../store';
import { IconButton, Segmented } from '../ui';

const LEVELS: { value: ViewLevel; label: string; title: string }[] = [
  { value: 'L0', label: 'L0', title: 'Architecture: subsystems (1)' },
  { value: 'L1', label: 'L1', title: 'Modules: top directories (2)' },
  { value: 'L2', label: 'L2', title: 'Files (3)' },
  { value: 'L3', label: 'L3', title: 'Symbols (4)' },
];
const VIEWS: { value: ViewMode; label: string }[] = [
  { value: 'map', label: 'Map' },
  { value: 'focus', label: 'Focus' },
  { value: 'flow', label: 'Flow' },
];

const ICON = { size: 16, strokeWidth: 1.5 } as const;

export function TopBar({ repo }: { repo?: RepoInfo }) {
  const s = useStore();
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <header className="topbar">
      <a
        className="wordmark"
        href="/"
        onClick={(e) => {
          e.preventDefault();
          navigate('/');
        }}
      >
        Spider
      </a>
      <span className="repo-name ellipsis" title={repo?.source}>
        {repo?.name}
      </span>
      <div className="topbar-sep" />
      <Segmented
        label="Level"
        value={s.level}
        options={LEVELS}
        onChange={(l) => {
          s.setLevel(l);
          if (s.view !== 'map') s.setView('map');
        }}
      />
      <Segmented label="View" value={s.view} options={VIEWS} onChange={s.setView} />
      <button type="button" className="input search-trigger" onClick={() => s.setSearchOpen(true)} aria-label="Search">
        <Search {...ICON} aria-hidden="true" />
        <span>Search</span>
        <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
      </button>
      <div className="tools">
        <IconButton label="Fit to screen" shortcut="F" onClick={s.fit}>
          <Maximize {...ICON} />
        </IconButton>
        {repo && <ExportMenu repoId={repo.repoId} />}
        <IconButton
          label={s.theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={() => s.setTheme(s.theme === 'dark' ? 'light' : 'dark')}
        >
          {s.theme === 'dark' ? <Sun {...ICON} /> : <Moon {...ICON} />}
        </IconButton>
        <IconButton label="Explorer panel" pressed={s.panels.explorer} onClick={() => s.togglePanel('explorer')}>
          <PanelLeft {...ICON} />
        </IconButton>
        <IconButton label="Details panel" pressed={s.panels.details} onClick={() => s.togglePanel('details')}>
          <PanelRight {...ICON} />
        </IconButton>
      </div>
    </header>
  );
}

function ExportMenu({ repoId }: { repoId: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [open]);
  return (
    <div ref={ref} style={{ display: 'contents' }}>
      <IconButton
        label="Export"
        pressed={open}
        onClick={() => {
          const r = ref.current?.querySelector('button')?.getBoundingClientRect();
          if (r) setPos({ x: Math.min(r.left, window.innerWidth - 232), y: r.bottom + 4 });
          setOpen(!open);
        }}
      >
        <Download {...ICON} />
      </IconButton>
      {open && (
        <div className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
          <a
            className="menu-item"
            role="menuitem"
            href={api.exportUrl(repoId, 'json')}
            download={`${repoId}.json`}
            onClick={() => setOpen(false)}
          >
            Graph as JSON
          </a>
          <a
            className="menu-item"
            role="menuitem"
            href={api.exportUrl(repoId, 'dot')}
            download={`${repoId}.dot`}
            onClick={() => setOpen(false)}
          >
            Graph as Graphviz DOT
          </a>
        </div>
      )}
    </div>
  );
}
