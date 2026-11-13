import { Component, type ErrorInfo, type ReactNode, useEffect } from 'react';
import { navigate, useRoute } from './router';
import { useStore } from './store';
import { applyTheme } from './theme';
import { EmptyState } from './ui';
import { Home } from './views/Home';
import { Workspace } from './views/Workspace';

export function App() {
  const route = useRoute();
  const theme = useStore((s) => s.theme);
  useEffect(() => applyTheme(theme), [theme]);
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
