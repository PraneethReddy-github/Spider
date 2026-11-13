import type { ViewLevel } from '@spider/shared';
import { type FlowQuery, type ViewMode, type ViewSnapshot, useStore } from './store';

type UrlState = ViewSnapshot;

const VIEWS: ViewMode[] = ['map', 'focus', 'flow'];
const LEVELS: ViewLevel[] = ['L0', 'L1', 'L2', 'L3'];

export function readUrlState(search = window.location.search): Partial<UrlState> {
  const sp = new URLSearchParams(search);
  const out: Partial<UrlState> = {};
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
    let q: FlowQuery | undefined;
    if (type === 'path' && a && b) q = { type, from: a, to: b };
    else if ((type === 'upstream' || type === 'downstream' || type === 'trace') && a)
      q = { type, id: a, depth: Number(b) || (type === 'trace' ? 6 : 3) };
    if (q) out.flowQuery = q;
  }
  return out;
}

export function urlSearchFor(s: UrlState): string {
  const sp = new URLSearchParams();
  sp.set('level', s.level);
  if (s.expanded.length) sp.set('expanded', s.expanded.join(','));
  if (s.selected) sp.set('node', s.selected);
  if (s.view !== 'map') sp.set('view', s.view);
  const fq = s.flowQuery;
  if (fq) sp.set('flow', fq.type === 'path' ? `path~${fq.from}~${fq.to}` : `${fq.type}~${fq.id}~${fq.depth}`);
  return `?${sp.toString()}`;
}

/** Two-way binding between the workspace state and the query string. Returns an unsubscribe. */
export function bindUrl(): () => void {
  useStore
    .getState()
    .hydrate({ expanded: [], selected: undefined, view: 'map', flowQuery: undefined, ...readUrlState() });
  let last = '';
  const unsub = useStore.subscribe((s) => {
    if (!s.repoId) return;
    const next = urlSearchFor(s);
    if (next === last) return;
    last = next;
    if (next !== window.location.search) window.history.replaceState(null, '', window.location.pathname + next);
  });
  return unsub;
}
