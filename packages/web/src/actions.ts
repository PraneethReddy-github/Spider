import { useStore } from './store';

/** Node actions shared by the details panel, context menu and keyboard shortcuts. */
export const actions = {
  upstream(id: string) {
    const s = useStore.getState();
    s.select(id);
    s.setFlowQuery({ type: 'upstream', id, depth: 3 });
  },
  downstream(id: string) {
    const s = useStore.getState();
    s.select(id);
    s.setFlowQuery({ type: 'downstream', id, depth: 3 });
  },
  trace(id: string) {
    const s = useStore.getState();
    s.select(id);
    s.setFlowQuery({ type: 'trace', id, depth: 6 });
  },
  focus(id: string) {
    const s = useStore.getState();
    s.select(id);
    s.setView('focus');
  },
  /** Starts path mode; the next node clicked on the map completes the path. */
  path(id: string, direction: 'from' | 'to') {
    const s = useStore.getState();
    s.select(id);
    if (s.view !== 'map') s.setView('map');
    s.setPathMode({ anchor: id, direction });
  },
  /** Path between the selection and the shift-selected node, if both exist. */
  pathBetweenSelection(): boolean {
    const s = useStore.getState();
    if (!s.selected || !s.secondary) return false;
    s.setFlowQuery({ type: 'path', from: s.selected, to: s.secondary });
    return true;
  },
  toggleExpand(id: string) {
    const s = useStore.getState();
    s.toggleExpanded(id);
    s.select(id);
    s.fit();
  },
  hide(id: string) {
    useStore.getState().hide(id);
  },
  /** Hands an editor deep link to the OS (the browser asks before launching the app). */
  openInEditor(url: string) {
    window.location.assign(url);
  },
  async copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      useStore.getState().notify('Node id copied.');
    } catch {
      useStore.getState().notify(`Copy failed. Node id: ${id}`);
    }
  },
};
