import { useQueryClient } from '@tanstack/react-query';
import { Suspense, lazy, useEffect } from 'react';
import { watchRepo } from '../api';
import { useRepo } from '../hooks';
import { ContextMenu } from '../panels/ContextMenu';
import { Details } from '../panels/Details';
import { Explorer } from '../panels/Explorer';
import { SearchPalette } from '../panels/SearchPalette';
import { TopBar } from '../panels/TopBar';
import { navigate } from '../router';
import { useShortcuts } from '../shortcuts';
import { useStore } from '../store';
import { EmptyState, Spinner } from '../ui';
import { bindUrl } from '../urlState';
import { DiffPanel } from './DiffPanel';
import { FlowView } from './FlowView';
import { FocusView } from './FocusView';
import { MapView } from './MapView';

// secondary views load on first use so the main bundle stays small
const MatrixView = lazy(() => import('./MatrixView').then((m) => ({ default: m.MatrixView })));
const EndpointsView = lazy(() => import('./EndpointsView').then((m) => ({ default: m.EndpointsView })));
const ExternalsView = lazy(() => import('./ExternalsView').then((m) => ({ default: m.ExternalsView })));
const IssuesView = lazy(() => import('./IssuesView').then((m) => ({ default: m.IssuesView })));

/** Re-analysis (watch mode) pushes `updated`: refetch everything about this repo. */
function useLiveUpdates(repoId: string) {
  const qc = useQueryClient();
  useEffect(
    () =>
      watchRepo(repoId, () => {
        void qc.invalidateQueries({ predicate: (q) => q.queryKey[1] === repoId || q.queryKey[0] === 'repos' });
        useStore.getState().notify('Analysis updated.');
      }),
    [repoId, qc],
  );
}

export function Workspace({ repoId }: { repoId: string }) {
  const repo = useRepo(repoId);
  const view = useStore((s) => s.view);
  const panels = useStore((s) => s.panels);
  const pathMode = useStore((s) => s.pathMode);
  const setPathMode = useStore((s) => s.setPathMode);

  useEffect(() => {
    useStore.getState().setRepo(repoId);
    return bindUrl();
  }, [repoId]);
  useShortcuts();
  useLiveUpdates(repoId);

  useEffect(() => {
    if (repo.data) document.title = `${repo.data.name} · Spider`;
  }, [repo.data]);

  if (repo.isLoading)
    return (
      <div className="home">
        <div className="empty">
          <Spinner label="Loading repository" />
        </div>
      </div>
    );
  if (repo.isError)
    return (
      <div className="home">
        <EmptyState
          title="Repository not found"
          body={(repo.error as Error).message}
          action={{ label: 'Go to repositories', onClick: () => navigate('/') }}
        />
      </div>
    );

  return (
    <div className="workspace">
      <TopBar repo={repo.data} />
      <div className="body">
        <aside className="side side-left" data-collapsed={!panels.explorer} aria-label="Explorer">
          {panels.explorer && <Explorer repoId={repoId} repo={repo.data} />}
        </aside>
        <main className="canvas-well">
          {view === 'map' && <MapView repoId={repoId} />}
          {view === 'focus' && <FocusView repoId={repoId} />}
          {view === 'flow' && <FlowView repoId={repoId} />}
          <Suspense
            fallback={
              <div className="canvas-empty">
                <Spinner label="Loading view" />
              </div>
            }
          >
            {view === 'matrix' && <MatrixView repoId={repoId} />}
            {view === 'endpoints' && <EndpointsView repoId={repoId} />}
            {view === 'externals' && <ExternalsView repoId={repoId} />}
            {view === 'issues' && <IssuesView repoId={repoId} />}
          </Suspense>
          <DiffPanel repoId={repoId} />
          {pathMode && (
            <output className="overlay mode-banner">
              <span>Path {pathMode.direction === 'from' ? 'from' : 'to'} selection: click another node.</span>
              <button type="button" className="btn btn-ghost" onClick={() => setPathMode(undefined)}>
                Cancel
              </button>
            </output>
          )}
        </main>
        <aside className="side side-right" data-collapsed={!panels.details} aria-label="Details">
          {panels.details && <Details repoId={repoId} />}
        </aside>
      </div>
      <SearchPalette repoId={repoId} />
      <ContextMenu repoId={repoId} />
    </div>
  );
}
