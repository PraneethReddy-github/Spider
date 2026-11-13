import { useSyncExternalStore } from 'react';

export type Route = { name: 'home' } | { name: 'repo'; id: string } | { name: 'missing' };

const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};
window.addEventListener('popstate', emit);

export function navigate(to: string): void {
  if (to === window.location.pathname + window.location.search) return;
  window.history.pushState(null, '', to);
  emit();
}

export function parseRoute(pathname: string): Route {
  if (pathname === '/' || pathname === '') return { name: 'home' };
  const m = pathname.match(/^\/repo\/([^/]+)\/?$/);
  if (m) return { name: 'repo', id: decodeURIComponent(m[1]) };
  return { name: 'missing' };
}

/** Tiny history router: "/" and "/repo/:id". */
export function useRoute(): Route {
  const path = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => window.location.pathname,
  );
  return parseRoute(path);
}
