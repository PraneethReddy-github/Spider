import type { RepoInfo, ViewLevel } from '@spider/shared';
import {
  Check,
  ChevronDown,
  Download,
  Maximize,
  Moon,
  PanelLeft,
  PanelRight,
  Redo2,
  Search,
  Settings,
  Sun,
  Undo2,
} from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAsk } from '../ask';
import { useDiff } from '../diff';
import { EDITORS } from '../editor';
import { download, exportTarget } from '../graph/exportImage';
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
/** Secondary views live behind the fourth segment so the top bar stays one tidy row. */
const MORE_VIEWS: { value: ViewMode; label: string }[] = [
  { value: 'matrix', label: 'Matrix' },
  { value: 'endpoints', label: 'Endpoints' },
  { value: 'externals', label: 'Externals' },
  { value: 'issues', label: 'Issues' },
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
          if (s.view !== 'map' && s.view !== 'matrix') s.setView('map');
        }}
      />
      <ViewSwitch />
      <button type="button" className="input search-trigger" onClick={() => s.setSearchOpen(true)} aria-label="Search">
        <Search {...ICON} aria-hidden="true" />
        <span>Search</span>
        <span className="kbd">{isMac ? '⌘K' : 'Ctrl K'}</span>
      </button>
      <div className="tools">
        <IconButton
          label="Undo view change"
          shortcut={isMac ? '⌘Z' : 'Ctrl+Z'}
          disabled={!s.past.length}
          onClick={s.undo}
        >
          <Undo2 {...ICON} />
        </IconButton>
        <IconButton
          label="Redo view change"
          shortcut={isMac ? '⇧⌘Z' : 'Ctrl+Shift+Z'}
          disabled={!s.future.length}
          onClick={s.redo}
        >
          <Redo2 {...ICON} />
        </IconButton>
        <IconButton label="Fit to screen" shortcut="F" onClick={s.fit}>
          <Maximize {...ICON} />
        </IconButton>
        {repo && <ExportMenu repoId={repo.repoId} name={repo.name} />}
        <IconButton
          label={s.theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={() => s.setTheme(s.theme === 'dark' ? 'light' : 'dark')}
        >
          {s.theme === 'dark' ? <Sun {...ICON} /> : <Moon {...ICON} />}
        </IconButton>
        <SettingsMenu />
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

function ViewSwitch() {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const more = MORE_VIEWS.find((v) => v.value === view);
  return (
    <div className="segmented" role="radiogroup" aria-label="View">
      {VIEWS.map((o) => (
        <button
          key={o.value}
          type="button"
          // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radio-group pattern on buttons keeps the segmented look
          role="radio"
          aria-checked={o.value === view}
          onClick={() => setView(o.value)}
        >
          {o.label}
        </button>
      ))}
      <MenuButton
        label="More views"
        trigger={(open, toggle) => (
          <button
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: fourth segment of the radio group, opening the other views
            role="radio"
            aria-checked={Boolean(more)}
            aria-haspopup="menu"
            aria-expanded={open}
            title="More views"
            className="segment-more"
            onClick={toggle}
          >
            {more?.label ?? 'More'}
            <ChevronDown size={12} strokeWidth={1.5} aria-hidden="true" />
          </button>
        )}
      >
        {(close) => [
          ...MORE_VIEWS.map((v) => (
            <button
              key={v.value}
              type="button"
              className="menu-item"
              role="menuitemradio"
              aria-checked={view === v.value}
              onClick={() => {
                setView(v.value);
                close();
              }}
            >
              {v.label}
              {view === v.value && <Check size={16} strokeWidth={1.5} className="menu-check" aria-hidden="true" />}
            </button>
          )),
          <div key="sep" className="menu-sep" />,
          <button
            key="compare"
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setView('map');
              useAsk.getState().setOpen(false);
              useDiff.getState().setOpen(true);
              close();
            }}
          >
            Compare with a revision…
          </button>,
          <button
            key="ask"
            type="button"
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setView('map');
              useDiff.getState().setOpen(false);
              useAsk.getState().setOpen(true);
              close();
            }}
          >
            Ask Spider…
          </button>,
        ]}
      </MenuButton>
    </div>
  );
}

function ExportMenu({ repoId, name }: { repoId: string; name: string }) {
  const view = useStore((s) => s.view);
  const notify = useStore((s) => s.notify);
  const base = `${name}-${view}`;
  return (
    <MenuButton label="Export" icon={<Download {...ICON} />}>
      {(close) => {
        const src = exportTarget.current;
        return (
          <>
            <div className="menu-label t-caption">Current view</div>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              disabled={!src?.png}
              onClick={async () => {
                close();
                const blob = await src?.png?.();
                if (blob) download(blob, `${base}.png`);
                else notify('Image export failed. Try again after the view has rendered.');
              }}
            >
              Image as PNG
            </button>
            <button
              type="button"
              className="menu-item"
              role="menuitem"
              disabled={!src?.svg}
              onClick={() => {
                close();
                const svg = src?.svg?.();
                if (svg) download(new Blob([svg], { type: 'image/svg+xml' }), `${base}.svg`);
              }}
            >
              Image as SVG
            </button>
            <div className="menu-sep" />
            <div className="menu-label t-caption">Repository</div>
            <a
              className="menu-item"
              role="menuitem"
              href={api.reportUrl(repoId)}
              download={`${name}.md`}
              onClick={close}
            >
              Architecture report (Markdown)
            </a>
            <a
              className="menu-item"
              role="menuitem"
              href={api.exportUrl(repoId, 'json')}
              download={`${name}.json`}
              onClick={close}
            >
              Graph as JSON
            </a>
            <a
              className="menu-item"
              role="menuitem"
              href={api.exportUrl(repoId, 'dot')}
              download={`${name}.dot`}
              onClick={close}
            >
              Graph as Graphviz DOT
            </a>
            <a
              className="menu-item"
              role="menuitem"
              href={api.exportUrl(repoId, 'graphml')}
              download={`${name}.graphml`}
              onClick={close}
            >
              Graph as GraphML
            </a>
          </>
        );
      }}
    </MenuButton>
  );
}

function SettingsMenu() {
  const editor = useStore((s) => s.editor);
  const setEditor = useStore((s) => s.setEditor);
  return (
    <MenuButton label="Settings" icon={<Settings {...ICON} />}>
      {(close) => (
        <>
          <div className="menu-label t-caption">Open in editor</div>
          {EDITORS.map((e) => (
            <button
              key={e.value}
              type="button"
              className="menu-item"
              role="menuitemradio"
              aria-checked={editor === e.value}
              onClick={() => {
                setEditor(e.value);
                close();
              }}
            >
              {e.label}
              {editor === e.value && <Check size={16} strokeWidth={1.5} className="menu-check" aria-hidden="true" />}
            </button>
          ))}
        </>
      )}
    </MenuButton>
  );
}

/** Ghost icon button that opens a dropdown menu below itself; Esc or an outside click closes it. */
function MenuButton({
  label,
  icon,
  trigger,
  children,
}: {
  label: string;
  icon?: ReactNode;
  /** Custom trigger; defaults to a ghost icon button showing `icon`. */
  trigger?: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const toggle = () => {
    const r = ref.current?.querySelector('button')?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(r.left, window.innerWidth - 232), y: r.bottom + 4 });
    setOpen(!open);
  };
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
      {trigger ? (
        trigger(open, toggle)
      ) : (
        <IconButton label={label} pressed={open} onClick={toggle}>
          {icon}
        </IconButton>
      )}
      {open && (
        <div className="menu" role="menu" style={{ left: pos.x, top: pos.y }}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}
