import type { JobProgress, RepoInfo } from '@spider/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderGit2, GitBranch } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { api, watchJob } from '../api';
import { fmtDuration, fmtNum, fmtRelative, shortSource } from '../format';
import { navigate } from '../router';
import { EmptyState, Progress, Spinner } from '../ui';

export function Home() {
  const qc = useQueryClient();
  const repos = useQuery({ queryKey: ['repos'], queryFn: api.repos });
  const [source, setSource] = useState('');
  const [job, setJob] = useState<JobProgress>();
  const [error, setError] = useState<string>();
  const stopRef = useRef<() => void>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Spider';
    inputRef.current?.focus();
    return () => stopRef.current?.();
  }, []);

  const start = (jobId: string) => {
    stopRef.current?.();
    stopRef.current = watchJob(jobId, (p) => {
      setJob(p);
      if (p.status === 'done') {
        void qc.invalidateQueries({ queryKey: ['repos'] });
        if (p.repoId) navigate(`/repo/${encodeURIComponent(p.repoId)}`);
      } else if (p.status === 'failed') {
        setError(p.error ?? p.message ?? 'Analysis failed.');
        void qc.invalidateQueries({ queryKey: ['repos'] });
      }
    });
  };

  const [ref, setRef] = useState('');
  const remote = looksRemote(source.trim());
  const debounced = useDebounced(remote ? source.trim() : '', 400);
  const refs = useQuery({
    queryKey: ['remote-refs', debounced],
    queryFn: () => api.remoteRefs(debounced),
    enabled: Boolean(debounced),
    retry: false,
    staleTime: 5 * 60_000,
  });
  // a ref from another repository must not leak into this one
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the source changes
  useEffect(() => setRef(''), [debounced]);

  const analyse = useMutation({
    mutationFn: (s: string) => api.analyze({ source: s, ref: remote && ref ? ref : undefined }),
    onMutate: () => {
      setError(undefined);
      setJob(undefined);
    },
    onSuccess: ({ jobId }) => start(jobId),
    onError: (e: Error) => setError(e.message),
  });

  const running = analyse.isPending || job?.status === 'queued' || job?.status === 'running';
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const s = source.trim();
    if (s && !running) analyse.mutate(s);
  };

  return (
    <main className="home">
      <div className="home-inner">
        <header className="home-head">
          <h1 className="t-title-1">Spider</h1>
          <p>Analyse a repository to see how it is connected.</p>
        </header>

        <form className="analyse-form" onSubmit={onSubmit}>
          <label className="input input-lg">
            <FolderGit2 size={16} strokeWidth={1.5} aria-hidden="true" />
            <span className="sr-only">Repository</span>
            <input
              ref={inputRef}
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="Path or GitHub URL"
              spellCheck={false}
              autoComplete="off"
              disabled={running}
            />
          </label>
          {remote && (
            <label className="ref-picker">
              <span className="sr-only">Ref</span>
              <GitBranch size={16} strokeWidth={1.5} aria-hidden="true" />
              <select
                className="select"
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                disabled={running || refs.isFetching}
                title={refs.isError ? 'Could not list branches and tags; the default branch is used.' : 'Branch or tag'}
              >
                <option value="">
                  {refs.isFetching
                    ? 'Loading refs'
                    : refs.data?.defaultBranch
                      ? `${refs.data.defaultBranch} (default)`
                      : 'Default branch'}
                </option>
                {refs.data && refs.data.branches.length > 0 && (
                  <optgroup label="Branches">
                    {refs.data.branches
                      .filter((b) => b !== refs.data?.defaultBranch)
                      .map((b) => (
                        <option key={`b:${b}`} value={b}>
                          {b}
                        </option>
                      ))}
                  </optgroup>
                )}
                {refs.data && refs.data.tags.length > 0 && (
                  <optgroup label="Tags">
                    {refs.data.tags.map((t) => (
                      <option key={`t:${t}`} value={t}>
                        {t}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </label>
          )}
          <button type="submit" className="btn btn-primary btn-lg" disabled={!source.trim() || running}>
            Analyse
          </button>
        </form>

        {(running || job) && !error && <JobView job={job} />}
        {error && (
          <p className="job tone-danger" role="alert">
            {error}
          </p>
        )}

        <section className="home-table">
          <h2 className="t-title-3">Repositories</h2>
          {repos.isLoading && (
            <div className="empty">
              <Spinner />
            </div>
          )}
          {repos.isError && (
            <EmptyState
              title="Could not load repositories"
              body={(repos.error as Error).message}
              action={{ label: 'Retry', onClick: () => void repos.refetch() }}
            />
          )}
          {repos.data && repos.data.length === 0 && (
            <EmptyState title="No repositories yet." body="Enter a local path or a GitHub URL above." />
          )}
          {repos.data && repos.data.length > 0 && <RepoTable repos={repos.data} />}
        </section>
      </div>
    </main>
  );
}

function JobView({ job }: { job?: JobProgress }) {
  const ratio = job && job.total > 0 ? job.current / job.total : undefined;
  return (
    <div className="job" aria-live="polite">
      <Progress value={job?.status === 'done' ? 1 : ratio} />
      <div className="t-body">
        {job
          ? `${capitalise(job.stage)}${job.total > 0 ? ` · ${fmtNum(job.current)} of ${fmtNum(job.total)}` : ''}`
          : 'Starting'}
        {job?.message ? <span className="tone-2"> — {job.message}</span> : null}
      </div>
      {job && job.log.length > 0 && (
        <div className="job-log">
          {job.log.slice(-3).map((l, i) => (
            <div key={`${i}-${l}`} className="ellipsis">
              {l}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** GitHub URL or bare `owner/repo` (what the server clones); local paths start with /, ., ~ or a drive. */
function looksRemote(s: string): boolean {
  return /^(https?:\/\/)?(www\.)?github\.com\/[\w.-]+\/[\w.-]+/i.test(s) || /^[\w-]+\/[\w.-]+$/.test(s);
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function RepoTable({ repos }: { repos: RepoInfo[] }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState<string>();
  const del = useMutation({
    mutationFn: (id: string) => api.deleteRepo(id),
    onSuccess: () => {
      setConfirming(undefined);
      void qc.invalidateQueries({ queryKey: ['repos'] });
    },
  });
  return (
    <table className="table" style={{ marginTop: 12 }}>
      <thead>
        <tr>
          <th>Name</th>
          <th>Source</th>
          <th>Commit</th>
          <th className="right">Files</th>
          <th className="right">Nodes</th>
          <th className="right">Edges</th>
          <th>Languages</th>
          <th>Analysed</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {repos.map((r) => (
          <tr key={r.repoId}>
            <td className="name">
              <a
                href={`/repo/${encodeURIComponent(r.repoId)}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/repo/${encodeURIComponent(r.repoId)}`);
                }}
              >
                {r.name}
              </a>
            </td>
            <td className="t-mono tone-2 ellipsis" style={{ maxWidth: 220 }} title={r.source}>
              {shortSource(r.source)}
            </td>
            <td className="t-mono tone-3">{r.commit ? r.commit.slice(0, 7) : '–'}</td>
            <td className="right num">{fmtNum(r.stats.files)}</td>
            <td className="right num">{fmtNum(r.stats.nodes)}</td>
            <td className="right num">{fmtNum(r.stats.edges)}</td>
            <td>
              <span className="repo-langs">
                {r.stats.languages.slice(0, 3).map((l) => (
                  <span key={l.language} className="badge">
                    {l.language}
                  </span>
                ))}
              </span>
            </td>
            <td className="tone-2" title={`${new Date(r.analysedAt).toLocaleString()} · ${fmtDuration(r.durationMs)}`}>
              {fmtRelative(r.analysedAt)}
            </td>
            <td className="right">
              {confirming === r.repoId ? (
                <>
                  <span className="tone-2" style={{ marginRight: 8 }}>
                    Delete {r.name}?
                  </span>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={del.isPending}
                    onClick={() => del.mutate(r.repoId)}
                  >
                    Delete
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirming(undefined)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => navigate(`/repo/${encodeURIComponent(r.repoId)}`)}
                  >
                    Open
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirming(r.repoId)}>
                    Delete
                  </button>
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
