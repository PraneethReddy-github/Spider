import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { type Me, detectMode, useAuth } from './auth';
import { navigate, useRoute } from './router';
import { useStore } from './store';
import { applyTheme } from './theme';
import { EmptyState, Spinner } from './ui';
import { AuthScreen } from './views/AuthScreen';
import { Home } from './views/Home';
import { Workspace } from './views/Workspace';

export function App() {
  const route = useRoute();
  const theme = useStore((s) => s.theme);
  useEffect(() => applyTheme(theme), [theme]);
  const mode = useAuth((s) => s.mode);
  const needsLogin = useAuth((s) => s.needsLogin);
  const me = useAuth((s) => s.me);
  useEffect(() => void detectMode(), []);
  // hosted: a signed-in user opening an invite link joins that workspace
  useEffect(() => {
    const invite = new URLSearchParams(window.location.search).get('invite');
    if (!me || !invite) return;
    void (async () => {
      const res = await fetch('/api/v1/orgs/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ invite }),
      });
      window.history.replaceState(null, '', window.location.pathname);
      const body = (await res.json()) as { error?: string };
      const fresh = await fetch('/api/v1/me').then((r) => r.json() as Promise<Me>);
      useAuth.setState({ me: fresh });
      useStore.getState().notify(res.ok ? 'You joined the workspace.' : (body.error ?? 'Could not join'));
    })();
  }, [me]);
  if (mode === 'unknown')
    return (
      <div className="home">
        <Spinner label="Loading" />
      </div>
    );
  if (mode === 'hosted' && needsLogin)
    return (
      <ErrorBoundary>
        <div className="app">
          <AuthScreen />
        </div>
      </ErrorBoundary>
    );
  return (
    <ErrorBoundary>
      <div className="app">
        {route.name === 'home' && <Home />}
        {route.name === 'repo' && <Workspace key={route.id} repoId={route.id} />}
        {route.name === 'missing' && (
          <div className="home">
            <EmptyState
              title="Page not found"
              body="This address does not match a Spider view."
              action={{ label: 'Go to repositories', onClick: () => navigate('/') }}
            />
          </div>
        )}
      </div>
      <Toaster />
    </ErrorBoundary>
  );
}

function Toaster() {
  const toast = useStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => useStore.setState({ toast: undefined }), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);
  if (!toast) return null;
  return (
    <output className="toast" key={toast.id}>
      {toast.text}
    </output>
  );
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
    // recover quietly: reload once; only a second failure within 15 s shows the message
    try {
      const last = Number(sessionStorage.getItem('spider.autoReload') ?? 0);
      if (Date.now() - last > 15_000) {
        sessionStorage.setItem('spider.autoReload', String(Date.now()));
        window.location.reload();
      }
    } catch {
      /* storage blocked: show the message */
    }
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="home">
        <EmptyState
          title="Something went wrong"
          body={`${this.state.error.message.replace(/\.+$/, '')}. Reload the page to continue.`}
          action={{ label: 'Reload', onClick: () => window.location.reload() }}
        />
      </div>
    );
  }
}
