import type { EdgeKind, NodeKind, ViewLevel } from '@spider/shared';
import { create } from 'zustand';
import { DEFAULT_EDGE_KINDS } from './theme';

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
  includeTests: boolean;
  minConfidence: number;
  minWeight: number;
  hideAmbiguous: boolean;
}

export interface ContextMenuState {
  x: number;
  y: number;
  nodeId: string;
}

interface State {
  repoId?: string;
  level: ViewLevel;
  expanded: string[];
  selected?: string;
  hovered?: string;
  view: ViewMode;
  flowQuery?: FlowQuery;
  focusDepth: number;
  filters: Filters;
  hidden: string[];
  /** first node chosen with "Path from here" */
  pathFrom?: string;
  /** node the canvas should centre on once it's rendered */
  centerOn?: string;
  contextMenu?: ContextMenuState;
  searchOpen: boolean;
  fitNonce: number;

  setRepo(repoId: string | undefined): void;
  setLevel(level: ViewLevel): void;
  setExpanded(ids: string[]): void;
  toggleExpanded(id: string): void;
  expandMany(ids: string[]): void;
  select(id: string | undefined): void;
  setHovered(id: string | undefined): void;
  setView(view: ViewMode): void;
  setFlowQuery(q: FlowQuery | undefined): void;
  setFocusDepth(d: number): void;
  setFilters(patch: Partial<Filters>): void;
  hide(id: string): void;
  unhideAll(): void;
  setPathFrom(id: string | undefined): void;
  setCenterOn(id: string | undefined): void;
  openContextMenu(m: ContextMenuState | undefined): void;
  setSearchOpen(open: boolean): void;
  fit(): void;
  /** Replace URL-backed state (level, expanded, node, view) in one go. */
  hydrate(partial: Partial<Pick<State, 'level' | 'expanded' | 'selected' | 'view' | 'flowQuery'>>): void;
}

const defaultFilters: Filters = {
  edgeKinds: [...DEFAULT_EDGE_KINDS],
  nodeKinds: undefined,
  includeTests: false,
  minConfidence: 0,
  minWeight: 0,
  hideAmbiguous: false,
};

export const useStore = create<State>((set, get) => ({
  repoId: undefined,
  level: 'L1',
  expanded: [],
  selected: undefined,
  hovered: undefined,
  view: 'map',
  flowQuery: undefined,
  focusDepth: 2,
  filters: defaultFilters,
  hidden: [],
  pathFrom: undefined,
  centerOn: undefined,
  contextMenu: undefined,
  searchOpen: false,
  fitNonce: 0,

  setRepo: (repoId) => {
    if (repoId === get().repoId) return;
    set({
      repoId,
      level: 'L1',
      expanded: [],
      selected: undefined,
      hovered: undefined,
      view: 'map',
      flowQuery: undefined,
      hidden: [],
      pathFrom: undefined,
      contextMenu: undefined,
      filters: defaultFilters,
    });
  },
  setLevel: (level) => set({ level, expanded: [] }),
  setExpanded: (expanded) => set({ expanded: uniq(expanded) }),
  toggleExpanded: (id) => {
    const cur = get().expanded;
    set({ expanded: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  expandMany: (ids) => {
    const cur = get().expanded;
    const next = uniq([...cur, ...ids.filter((x) => x !== 'repo')]);
    if (next.length !== cur.length) set({ expanded: next });
  },
  select: (selected) => set({ selected, contextMenu: undefined }),
  setHovered: (hovered) => set({ hovered }),
  setView: (view) => set({ view, contextMenu: undefined }),
  setFlowQuery: (flowQuery) => set({ flowQuery, view: flowQuery ? 'flow' : get().view, contextMenu: undefined }),
  setFocusDepth: (focusDepth) => set({ focusDepth: Math.max(1, Math.min(3, focusDepth)) }),
  setFilters: (patch) => set({ filters: { ...get().filters, ...patch } }),
  hide: (id) => set({ hidden: uniq([...get().hidden, id]), selected: get().selected === id ? undefined : get().selected }),
  unhideAll: () => set({ hidden: [] }),
  setPathFrom: (pathFrom) => set({ pathFrom }),
  setCenterOn: (centerOn) => set({ centerOn }),
  openContextMenu: (contextMenu) => set({ contextMenu }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  fit: () => set({ fitNonce: get().fitNonce + 1 }),
  hydrate: (partial) => set(partial),
}));

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs));
}

/* ---------- URL state ---------- */

const VIEWS: ViewMode[] = ['map', 'focus', 'flow'];
const LEVELS: ViewLevel[] = ['L0', 'L1', 'L2', 'L3'];

export function readUrlState(): Partial<Pick<State, 'level' | 'expanded' | 'selected' | 'view' | 'flowQuery'>> {
  const sp = new URLSearchParams(window.location.search);
  const out: ReturnType<typeof readUrlState> = {};
  const level = sp.get('level') as ViewLevel | null;
  if (level && LEVELS.includes(level)) out.level = level;
  const expanded = sp.get('expanded');
  if (expanded) out.expanded = expanded.split(',').filter(Boolean);
  const node = sp.get('node');
  if (node) out.selected = node;
  const view = sp.get('view') as ViewMode | null;
  if (view && VIEWS.includes(view)) out.view = view;
  const flow = sp.get('flow');
  if (flow) {
    const [type, a, b] = flow.split('~');
    if (type === 'path' && a && b) out.flowQuery = { type, from: a, to: b };
    else if ((type === 'upstream' || type === 'downstream' || type === 'trace') && a)
      out.flowQuery = { type, id: a, depth: Number(b) || (type === 'trace' ? 6 : 3) };
  }
  return out;
}

export function writeUrlState(s: Pick<State, 'level' | 'expanded' | 'selected' | 'view' | 'flowQuery'>): void {
  const sp = new URLSearchParams(window.location.search);
  sp.set('level', s.level);
  if (s.expanded.length) sp.set('expanded', s.expanded.join(','));
  else sp.delete('expanded');
  if (s.selected) sp.set('node', s.selected);
  else sp.delete('node');
  if (s.view !== 'map') sp.set('view', s.view);
  else sp.delete('view');
  const fq = s.flowQuery;
  if (fq) sp.set('flow', fq.type === 'path' ? `path~${fq.from}~${fq.to}` : `${fq.type}~${fq.id}~${fq.depth}`);
  else sp.delete('flow');
  const next = `${window.location.pathname}?${sp.toString()}`;
  if (next !== window.location.pathname + window.location.search) window.history.replaceState(null, '', next);
}

/** Subscribes the store to the URL for the lifetime of the workspace. Returns an unsubscribe. */
export function bindUrl(): () => void {
  useStore.getState().hydrate(readUrlState());
  let last = '';
  return useStore.subscribe((s) => {
    if (!s.repoId) return;
    const key = [s.level, s.expanded.join(','), s.selected, s.view, JSON.stringify(s.flowQuery)].join('|');
    if (key === last) return;
    last = key;
    writeUrlState(s);
  });
}
