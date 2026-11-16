import { create } from 'zustand';

/**
 * Hosted mode (S-4) in the browser. Local mode never sees any of this: `/api/v1/hosted` 404s and the app renders
 * as before. In hosted mode a session token (localStorage) or a share-link token (from `?share=`, kept for the
 * tab) rides on every API call: as a header on fetch, as a query parameter on WebSockets and download links.
 */

const TOKEN = 'spider.token';
const SHARE = 'spider.share';

const read = (s: Storage | undefined, k: string) => {
  try {
    return s?.getItem(k) ?? undefined;
  } catch {
    return undefined;
  }
};
const write = (s: Storage | undefined, k: string, v: string | undefined) => {
  try {
    if (v) s?.setItem(k, v);
    else s?.removeItem(k);
  } catch {
    /* storage blocked: the session lasts until reload */
  }
};

let memToken = read(globalThis.localStorage, TOKEN);
let memShare = new URLSearchParams(globalThis.location?.search).get('share') ?? read(globalThis.sessionStorage, SHARE);
if (memShare) write(globalThis.sessionStorage, SHARE, memShare);

export interface Me {
  user: { id: string; email: string; name: string };
  orgs: { id: string; name: string; role: 'owner' | 'member' }[];
}

interface AuthState {
  mode: 'unknown' | 'local' | 'hosted';
  signup?: 'open' | 'invite';
  firstUser?: boolean;
  me?: Me;
  /** Viewing through a read-only share link. */
  shared?: boolean;
  /** Hosted and nobody signed in. */
  needsLogin: boolean;
  setSession: (token: string, me: Me) => void;
  signOut: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  mode: 'unknown',
  needsLogin: false,
  setSession: (token, me) => {
    memToken = token;
    write(globalThis.localStorage, TOKEN, token);
    set({ me, needsLogin: false });
  },
  signOut: async () => {
    await fetch('/api/v1/auth/logout', { method: 'POST' }).catch(() => {});
    memToken = undefined;
    write(globalThis.localStorage, TOKEN, undefined);
    set({ me: undefined, needsLogin: true });
  },
}));

/** Adds the session or share token to same-origin API requests. Installed once, before the app renders. */
export function installAuthFetch(): void {
  const base = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = url.startsWith('/')
      ? url
      : url.startsWith(window.location.origin)
        ? url.slice(window.location.origin.length)
        : '';
    if (!path.startsWith('/api/') || (!memToken && !memShare)) return base(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (memToken) headers.set('authorization', `Bearer ${memToken}`);
    else if (memShare) headers.set('x-spider-share', memShare);
    return base(input, { ...init, headers }).then((res) => {
      if (res.status === 401 && useAuth.getState().mode === 'hosted' && !memShare)
        useAuth.setState({ needsLogin: true });
      return res;
    });
  };
}

/** For URLs the browser fetches itself (WebSocket, `<a href>` downloads). */
export function withAuth(url: string): string {
  const t = memToken
    ? `access_token=${encodeURIComponent(memToken)}`
    : memShare
      ? `share=${encodeURIComponent(memShare)}`
      : '';
  return t ? `${url}${url.includes('?') ? '&' : '?'}${t}` : url;
}

/** Works out local vs hosted, and who is signed in. */
export async function detectMode(): Promise<void> {
  const res = await fetch('/api/v1/hosted').catch(() => undefined);
  if (!res || res.status === 404) return useAuth.setState({ mode: 'local' });
  const h = (await res.json()) as { signup: 'open' | 'invite'; firstUser: boolean };
  useAuth.setState({ mode: 'hosted', signup: h.signup, firstUser: h.firstUser });
  if (memShare && !memToken) return useAuth.setState({ shared: true });
  const me = memToken ? await fetch('/api/v1/me').catch(() => undefined) : undefined;
  if (me?.ok) useAuth.setState({ me: (await me.json()) as Me });
  else useAuth.setState({ needsLogin: true });
}

export function forgetShare(): void {
  memShare = undefined;
  write(globalThis.sessionStorage, SHARE, undefined);
}
