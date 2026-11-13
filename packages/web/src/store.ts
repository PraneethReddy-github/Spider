import type { EdgeKind, NodeKind, ViewLevel } from '@spider/shared';
import { create } from 'zustand';
import { DEFAULT_EDGE_KINDS, type ThemeName } from './theme';

export type ViewMode = 'map' | 'focus' | 'flow' | 'matrix' | 'endpoints' | 'externals' | 'issues';
export const VIEW_MODES: ViewMode[] = ['map', 'focus', 'flow', 'matrix', 'endpoints', 'externals', 'issues'];

/** Node size metric on the canvas ('default' = the per-kind rule in theme.nodeSize). */
export type SizeBy = 'default' | 'pagerank' | 'churn' | 'betweenness' | 'loc';

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
  sizeBy: SizeBy;
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

/** The navigable part of the workspace: what undo/redo and the URL restore. */
export type ViewSnapshot = Pick<State, 'level' | 'expanded' | 'selected' | 'view' | 'flowQuery'>;

export type EditorScheme = 'vscode' | 'cursor' | 'idea' | 'none';

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
  /** Undo/redo stacks of view snapshots (most recent last). */
  past: ViewSnapshot[];
  future: ViewSnapshot[];
  editor: EditorScheme;

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
  undo(): void;
  redo(): void;
  setEditor(e: EditorScheme): void;
  hydrate(partial: Partial<ViewSnapshot>): void;
}

export const defaultFilters: Filters = {
  edgeKinds: [...DEFAULT_EDGE_KINDS],
  nodeKinds: undefined,
  languages: undefined,
  includeTests: false,
  minConfidence: 0,
  hideAmbiguous: false,
  colorBySubsystem: false,
  sizeBy: 'default',
};

const uniq = (xs: string[]) => Array.from(new Set(xs));

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const saved = localStorage.getItem(key) as T | null;
    if (saved && allowed.includes(saved)) return saved;
  } catch {
    /* storage blocked */
  }
  return fallback;
}

function persist(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked: the setting lasts for the session */
  }
}

export const pickView = (s: ViewSnapshot): ViewSnapshot => ({
  level: s.level,
  expanded: s.expanded,
  selected: s.selected,
  view: s.view,
  flowQuery: s.flowQuery,
});
const sameView = (a: ViewSnapshot, b: ViewSnapshot) =>
  a.level === b.level &&
  a.expanded === b.expanded &&
  a.selected === b.selected &&
  a.view === b.view &&
  a.flowQuery === b.flowQuery;
const HISTORY_MAX = 100;

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
  theme: stored<ThemeName>('spider:theme', ['dark', 'light'], 'dark'),
  panels: { explorer: true, details: true },
  past: [],
  future: [],
  editor: stored<EditorScheme>('spider:editor', ['vscode', 'cursor', 'idea', 'none'], 'vscode'),

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
      past: [],
      future: [],
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
    persist('spider:theme', theme);
    set({ theme });
  },
  setEditor: (editor) => {
    persist('spider:editor', editor);
    set({ editor });
  },
  undo: () => {
    const { past, future } = get();
    const prev = past.at(-1);
    if (!prev) return;
    set({ ...prev, past: past.slice(0, -1), future: [...future, pickView(get())], ...TRANSIENT });
  },
  redo: () => {
    const { past, future } = get();
    const next = future.at(-1);
    if (!next) return;
    set({ ...next, future: future.slice(0, -1), past: [...past, pickView(get())], ...TRANSIENT });
  },
  togglePanel: (p) => set({ panels: { ...get().panels, [p]: !get().panels[p] } }),
  notify: (text) => set({ toast: { id: ++toastSeq, text } }),
  hydrate: (partial) => set({ ...partial, past: [], future: [] }),
}));

const TRANSIENT = { contextMenu: undefined, pathMode: undefined, hovered: undefined, secondary: undefined };

/*
 * History recording: every change to the view snapshot pushes the previous snapshot. Changes made in
 * one tick (e.g. select + open flow) coalesce into one step. Updates that touch the stacks themselves
 * (undo, redo, hydrate, repo switch) are not recorded.
 */
let pending: ViewSnapshot | undefined;
useStore.subscribe((s, prev) => {
  if (s.past !== prev.past || s.future !== prev.future || sameView(s, prev)) return;
  if (pending) return;
  pending = pickView(prev);
  queueMicrotask(() => {
    const snap = pending as ViewSnapshot;
    pending = undefined;
    const cur = useStore.getState();
    if (sameView(snap, cur)) return;
    useStore.setState({ past: [...cur.past.slice(-(HISTORY_MAX - 1)), snap], future: [] });
  });
});
