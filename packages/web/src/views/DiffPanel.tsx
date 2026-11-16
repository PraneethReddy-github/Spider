import type { DiffEdgeRef, DiffNodeRef, GraphDiff, RemoteRefs } from '@spider/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { diffApi, useDiff } from '../diff';
import { fmtNum } from '../format';
import { useReveal } from '../hooks';
import { IconButton, KindGlyph, Spinner } from '../ui';
import './DiffPanel.css';

const LIST_MAX = 200;

/** Prefer comparing against main/master; else the checked-out branch (= uncommitted changes). */
function defaultBase(refs: RemoteRefs): string | undefined {
  const trunk = ['main', 'master'].find((b) => refs.branches.includes(b) && b !== refs.defaultBranch);
  return trunk ?? refs.defaultBranch ?? refs.branches[0] ?? refs.tags[0];
}

/** Compare overlay: pick a base ref, diff it against the working tree, list the changes; the map shows rings. */
export function DiffPanel({ repoId }: { repoId: string }) {
  const { open, diff, setOpen, setResult } = useDiff();
  const refs = useQuery({
    queryKey: ['refs', repoId],
    queryFn: () => diffApi.refs(repoId),
    enabled: open,
    retry: false,
  });
  const [base, setBase] = useState<string>();
  const run = useMutation({
    mutationFn: (ref: string) => diffApi.diff(repoId, ref),
    onSuccess: (d, ref) => setResult(ref, d),
  });

  useEffect(() => {
    if (refs.data && !base) setBase(defaultBase(refs.data));
  }, [refs.data, base]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);
  useEffect(() => () => setOpen(false), [setOpen]); // leaving the repo ends compare mode

  if (!open) return null;
  const options = refs.data ? [...refs.data.branches, ...refs.data.tags] : [];
  return (
    <section className="overlay diff-panel" aria-label="Compare">
      <header className="panel-header">
        <h2>Compare</h2>
        <IconButton label="Close compare" onClick={() => setOpen(false)}>
          <X size={16} strokeWidth={1.5} />
        </IconButton>
      </header>
      <div className="diff-body">
        <div className="diff-form">
          <select
            className="select"
            aria-label="Base revision"
            value={base ?? ''}
            disabled={!options.length || run.isPending}
            onChange={(e) => setBase(e.target.value)}
          >
            {refs.data && (
              <>
                <optgroup label="Branches">
                  {refs.data.branches.map((b) => (
                    <option key={`b:${b}`} value={b}>
                      {b}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Tags">
                  {refs.data.tags.map((t) => (
                    <option key={`t:${t}`} value={t}>
                      {t}
                    </option>
                  ))}
                </optgroup>
              </>
            )}
          </select>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!base || run.isPending}
            onClick={() => base && run.mutate(base)}
          >
            Compare
          </button>
        </div>
        <p className="tone-3">Base revision against the working tree on disk.</p>
        {refs.isError && <p className="tone-danger">{(refs.error as Error).message}</p>}
        {run.isPending && <Spinner label={`Analysing ${run.variables}`} />}
        {run.isError && <p className="tone-danger">Compare failed: {(run.error as Error).message}</p>}
        {diff && !run.isPending && <DiffResult diff={diff} />}
      </div>
    </section>
  );
}

function DiffResult({ diff }: { diff: GraphDiff }) {
  const s = diff.summary;
  const reveal = useReveal();
  const nodes = (list: DiffNodeRef[]) => list.filter((n) => n.kind !== 'directory');
  const added = nodes(diff.nodes.added);
  const removed = nodes(diff.nodes.removed);
  const issues = [
    ...diff.diagnostics.newCycles.map((d) => ({ key: d.nodeIds.join(), text: `New cycle: ${d.detail ?? d.title}` })),
    ...diff.diagnostics.newViolations.map((d) => ({ key: d.nodeIds.join(), text: `New violation: ${d.title}` })),
  ];
  if (!s.nodesAdded && !s.nodesRemoved && !s.edgesAdded && !s.edgesRemoved)
    return <p className="diff-empty">No structural changes since {diff.base.ref}.</p>;
  return (
    <>
      <div className="metrics diff-metrics">
        <Metric label="Files" plus={s.filesAdded} minus={s.filesRemoved} />
        <Metric label="Edges" plus={s.edgesAdded} minus={s.edgesRemoved} />
        <div className="metric">
          <div className="t-caption tone-3">Changed</div>
          <div className="value">{fmtNum(s.filesChanged)}</div>
        </div>
      </div>
      <p className="tone-3 diff-legend">
        <span className="diff-dot" data-mark="ok" /> added <span className="diff-dot" data-mark="danger" /> removed,
        shown faded
      </p>
      {issues.length > 0 && (
        <Section title="Architecture" count={issues.length}>
          {issues.map((i) => (
            <div key={i.key} className="diff-issue">
              <span className="diff-dot" data-mark="danger" />
              {i.text}
            </div>
          ))}
        </Section>
      )}
      <Section title="Added" count={added.length}>
        {added.slice(0, LIST_MAX).map((n) => (
          <NodeRow key={n.id} n={n} mark="ok" onPick={() => void reveal(n.id)} />
        ))}
      </Section>
      <Section title="Removed" count={removed.length}>
        {removed.slice(0, LIST_MAX).map((n) => (
          <NodeRow key={n.id} n={n} mark="danger" />
        ))}
      </Section>
      <Section title="New dependencies" count={diff.edges.added.length}>
        {diff.edges.added.slice(0, LIST_MAX).map((e) => (
          <EdgeRow key={e.id} e={e} mark="ok" onPick={() => void reveal(e.src)} />
        ))}
      </Section>
      <Section title="Dropped dependencies" count={diff.edges.removed.length}>
        {diff.edges.removed.slice(0, LIST_MAX).map((e) => (
          <EdgeRow key={e.id} e={e} mark="danger" />
        ))}
      </Section>
    </>
  );
}

function Metric({ label, plus, minus }: { label: string; plus: number; minus: number }) {
  return (
    <div className="metric">
      <div className="t-caption tone-3">{label}</div>
      <div className="value">
        +{fmtNum(plus)} <span className="tone-3">−{fmtNum(minus)}</span>
      </div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  if (!count) return null;
  return (
    <section className="diff-section">
      <div className="t-caption">
        {title} <span className="tone-3">{fmtNum(count)}</span>
      </div>
      {children}
      {count > LIST_MAX && <p className="tone-3">and {fmtNum(count - LIST_MAX)} more.</p>}
    </section>
  );
}

function NodeRow({ n, mark, onPick }: { n: DiffNodeRef; mark: 'ok' | 'danger'; onPick?: () => void }) {
  const name = n.qname?.split('::').pop() ?? n.name;
  const content = (
    <>
      <span className="diff-dot" data-mark={mark} />
      <KindGlyph kind={n.kind} />
      <span className="name">{n.kind === 'file' ? n.file : name}</span>
      {n.kind !== 'file' && n.file && <span className="meta">{n.file.split('/').pop()}</span>}
    </>
  );
  return onPick ? (
    <button type="button" className="row" title={n.qname ?? n.name} onClick={onPick}>
      {content}
    </button>
  ) : (
    <div className="row diff-static" title={n.qname ?? n.name}>
      {content}
    </div>
  );
}

function EdgeRow({ e, mark, onPick }: { e: DiffEdgeRef; mark: 'ok' | 'danger'; onPick?: () => void }) {
  const short = (l: string) => l.split('::').pop()?.split('/').pop() ?? l;
  const content = (
    <>
      <span className="diff-dot" data-mark={mark} />
      <span className="name">
        {short(e.srcLabel)} → {short(e.dstLabel)}
      </span>
      <span className="meta">{e.kind}</span>
    </>
  );
  const title = `${e.kind} ${e.srcLabel} → ${e.dstLabel}`;
  return onPick ? (
    <button type="button" className="row" title={title} onClick={onPick}>
      {content}
    </button>
  ) : (
    <div className="row diff-static" title={title}>
      {content}
    </div>
  );
}
