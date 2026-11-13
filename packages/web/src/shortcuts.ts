import { useEffect } from 'react';
import { actions } from './actions';
import { useStore } from './store';

const LEVEL_KEYS = { '1': 'L0', '2': 'L1', '3': 'L2', '4': 'L3' } as const;

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
}

/**
 * Workspace keyboard registry (IMPLEMENTATION_PLAN §6.3): F / Shift+F fit, Esc, U, D, P, H / Shift+H,
 * 1–4 levels, ⌘K and / for search.
 */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        s.setSearchOpen(!s.searchOpen);
        return;
      }
      // ⌘Z / ⇧⌘Z (Ctrl on other platforms; Ctrl+Y too) step through view history; inputs keep native undo
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !typing(e.target) && !s.searchOpen) {
        const k = e.key.toLowerCase();
        if (k === 'z' || k === 'y') {
          e.preventDefault();
          if (k === 'y' || e.shiftKey) s.redo();
          else s.undo();
          return;
        }
      }
      if (e.key === 'Escape') {
        if (s.searchOpen) s.setSearchOpen(false);
        else if (s.contextMenu) s.openContextMenu(undefined);
        else if (s.pathMode) s.setPathMode(undefined);
        else if (s.selected) s.select(undefined);
        return;
      }
      if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey || s.searchOpen) return;
      const sel = s.selected;
      switch (e.key) {
        case '/':
          e.preventDefault();
          s.setSearchOpen(true);
          return;
        case 'f':
          s.fit();
          return;
        case 'F':
          s.fitSelection();
          return;
        case 'u':
        case 'U':
          if (sel) actions.upstream(sel);
          return;
        case 'd':
        case 'D':
          if (sel) actions.downstream(sel);
          return;
        case 'p':
        case 'P':
          if (!actions.pathBetweenSelection() && sel) actions.path(sel, 'from');
          return;
        case 'h':
          if (sel) actions.hide(sel);
          return;
        case 'H':
          s.unhideAll();
          return;
      }
      if (e.key in LEVEL_KEYS) {
        s.setLevel(LEVEL_KEYS[e.key as keyof typeof LEVEL_KEYS]);
        if (s.view !== 'map' && s.view !== 'matrix') s.setView('map');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
