import type { EdgeKind, NodeKind, ViewLevel } from '@spider/shared';
import { create } from 'zustand';
import { DEFAULT_EDGE_KINDS, type ThemeName } from './theme';

export type ViewMode = 'map' | 'focus' | 'flow';

export type FlowQuery =
  | { type: 'upstream'; id: string; depth: number }
  | { type: 'downstream'; id: string; depth: number }
  | { type: 'trace'; id: string; depth: number }
  | { type: 'path'; from: string; to: string };

export interface Filters {
  edgeKinds: EdgeKind[];
  /** undefined = all kinds */
  nodeKinds?: NodeKind[];
  /** undefined = all languages */
  languages?: string[];
  includeTests: boolean;
  minConfidence: number;
  hideAmbiguous: boolean;
  colorBySubsystem: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
}

export interface Toast {
  id: number;
  text: string;
}

export interface State {
  repoId?: string;
  level: ViewLevel;
  expanded: string[];
  selected?: string;
  /** Second node of a shift-click pair (path endpoints). */
  secondary?: string;
  hovered?: string;
  view: ViewMode;
  flowQuery?: FlowQuery;
  focusDepth: number;
  filters: Filters;
  hidden: string[];
  /** Waiting for the user to pick the other end of a path. */
  pathMode?: { anchor: string; direction: 'from' | 'to' };
  /** Node the canvas should centre on once it's rendered. */
  centerOn?: string;
  contextMenu?: ContextMenuState;
  searchOpen: boolean;
  fitNonce: number;
  fitSelectionNonce: number;
  theme: ThemeName;
  panels: { explorer: boolean; details: boolean };
  toast?: Toast;

  setRepo(repoId: string | undefined): void;
  setLevel(level: ViewLevel): void;
  toggleExpanded(id: string): void;
  expandMany(ids: string[]): void;
  select(id: string | undefined, opts?: { additive?: boolean }): void;
  setHovered(id: string | undefined): void;
  setView(view: ViewMode): void;
  setFlowQuery(q: FlowQuery | undefined): void;
  setFocusDepth(d: number): void;
  setFilters(patch: Partial<Filters>): void;
  resetFilters(): void;
  hide(id: string): void;
  unhideAll(): void;
  setPathMode(m: State['pathMode']): void;
  setCenterOn(id: string | undefined): void;
  openContextMenu(m: ContextMenuState | undefined): void;
  setSearchOpen(open: boolean): void;
  fit(): void;
  fitSelection(): void;
  setTheme(t: ThemeName): void;
  togglePanel(p: 'explorer' | 'details'): void;
  notify(text: string): void;
  hydrate(partial: Partial<Pick<State, 'level' | 'expanded' | 'selected' | 'view' | 'flowQuery'>>): void;
}

export const defaultFilters: Filters = {
  edgeKinds: [...DEFAULT_EDGE_KINDS],
  nodeKinds: undefined,
  languages: undefined,
  includeTests: false,
  minConfidence: 0,
  hideAmbiguous: false,
  colorBySubsystem: false,
};

const uniq = (xs: string[]) => Array.from(new Set(xs));

function initialTheme(): ThemeName {
  try {
    const saved = localStorage.getItem('spider:theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* storage blocked */
  }
  return 'dark';
}

let toastSeq = 0;

export const useStore = create<State>((set, get) => ({
  level: 'L1',
  expanded: [],
  view: 'map',
  focusDepth: 1,
  filters: defaultFilters,
  hidden: [],
  searchOpen: false,
  fitNonce: 0,
  fitSelectionNonce: 0,
  theme: initialTheme(),
  panels: { explorer: true, details: true },

  setRepo: (repoId) => {
    if (repoId === get().repoId) return;
    set({
      repoId,
      level: 'L1',
      expanded: [],
      selected: undefined,
      secondary: undefined,
      hovered: undefined,
      view: 'map',
      flowQuery: undefined,
      hidden: [],
      pathMode: undefined,
      contextMenu: undefined,
      centerOn: undefined,
      filters: defaultFilters,
    });
  },
  setLevel: (level) => set({ level, expanded: [] }),
  toggleExpanded: (id) => {
    const cur = get().expanded;
    set({ expanded: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  expandMany: (ids) => {
    const cur = get().expanded;
    const next = uniq([...cur, ...ids.filter((x) => x !== 'repo')]);
    if (next.length !== cur.length) set({ expanded: next });
  },
  select: (id, opts) => {
    const s = get();
    if (opts?.additive && id && s.selected && id !== s.selected) {
      set({ secondary: id, contextMenu: undefined });
      return;
    }
    set({ selected: id, secondary: undefined, contextMenu: undefined });
  },
  setHovered: (hovered) => {
    if (get().hovered !== hovered) set({ hovered });
  },
  setView: (view) => set({ view, contextMenu: undefined, hovered: undefined }),
  setFlowQuery: (flowQuery) =>
    set({ flowQuery, view: flowQuery ? 'flow' : get().view, contextMenu: undefined, pathMode: undefined }),
  setFocusDepth: (d) => set({ focusDepth: Math.max(1, Math.min(3, d)) }),
  setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
  resetFilters: () => set({ filters: defaultFilters }),
  hide: (id) => {
    const s = get();
    set({ hidden: uniq([...s.hidden, id]), selected: s.selected === id ? undefined : s.selected });
  },
  unhideAll: () => set({ hidden: [] }),
  setPathMode: (pathMode) => set({ pathMode, contextMenu: undefined }),
  setCenterOn: (centerOn) => set({ centerOn }),
  openContextMenu: (contextMenu) => set({ contextMenu }),
  setSearchOpen: (searchOpen) => set({ searchOpen, contextMenu: undefined }),
  fit: () => set({ fitNonce: get().fitNonce + 1 }),
  fitSelection: () => set({ fitSelectionNonce: get().fitSelectionNonce + 1 }),
  setTheme: (theme) => {
    try {
      localStorage.setItem('spider:theme', theme);
    } catch {
      /* storage blocked: theme lasts for the session */
    }
    set({ theme });
  },
  togglePanel: (p) => set({ panels: { ...get().panels, [p]: !get().panels[p] } }),
  notify: (text) => set({ toast: { id: ++toastSeq, text } }),
  hydrate: (partial) => set(partial),
}));
