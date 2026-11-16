import type { EdgeKind, GraphEdge, GraphNode, NodeDetail } from '@spider/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, SquareArrowOutUpRight } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { actions } from '../actions';
import { api } from '../api';
import { fmtNum, fmtRelative, locationOf, nodeLabel } from '../format';
import { type Token, grammarFor, tokenize } from '../highlight';
import { useEditorUrl, useNodeDetail, useOverrides, useReveal, useSaveOverrides } from '../hooks';
import { useStore } from '../store';
import { EmptyState, IconButton, KindBadge, KindGlyph, Spinner, Tabs } from '../ui';

type Tab = 'overview' | 'source';

export function Details({ repoId }: { repoId: string }) {
  const selected = useStore((s) => s.selected);
  const [tab, setTab] = useState<Tab>('overview');
  const q = useNodeDetail(repoId, selected);
  const editorHref = useEditorUrl(repoId, q.data?.node);

  if (!selected)
    return (
      <div className="side-scroll">
        <EmptyState title="Nothing selected" body="Select a node on the map, in the explorer, or press / to search." />
      </div>
    );
  if (q.isLoading)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  if (q.isError || !q.data)
    return (
      <EmptyState
        title="Could not load this node"
        body={(q.error as Error | null)?.message ?? 'It may have been removed by a re-analysis.'}
      />
    );

  const d = q.data;
  const n = d.node;
  const hasSource = Boolean(n.file) && n.kind !== 'directory';
  return (
    <>
      <header className="details-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <KindBadge kind={n.kind} />
          {n.props.isTest ? <span className="badge">test</span> : null}
          {n.props.classKind && n.props.classKind !== 'class' ? (
            <span className="badge">{String(n.props.classKind)}</span>
          ) : null}
          <span style={{ marginLeft: 'auto', display: 'flex' }}>
            {editorHref && (
              <IconButton label="Open in editor" onClick={() => actions.openInEditor(editorHref)}>
                <SquareArrowOutUpRight size={16} strokeWidth={1.5} />
              </IconButton>
            )}
            <IconButton label="Copy id" onClick={() => void actions.copyId(n.id)}>
              <Copy size={16} strokeWidth={1.5} />
            </IconButton>
          </span>
        </div>
        <h2 className="name">{nodeLabel(n)}</h2>
        {n.qname && n.qname !== n.name && <div className="qname">{n.qname}</div>}
        {locationOf(n) && hasSource && (
          <button
            type="button"
            className="t-mono"
            style={{ color: 'var(--accent-text)', textAlign: 'left' }}
            onClick={() => setTab('source')}
          >
            {locationOf(n)}
          </button>
        )}
      </header>
      {hasSource && (
        <Tabs
          value={tab}
          onChange={setTab}
          options={[
            { value: 'overview', label: 'Overview' },
            { value: 'source', label: 'Source' },
          ]}
        />
      )}
      <div className="side-scroll" style={{ padding: 0 }}>
        {tab === 'overview' || !hasSource ? (
          <Overview repoId={repoId} d={d} />
        ) : (
          <Source repoId={repoId} id={n.id} outgoing={d.outgoing} />
        )}
      </div>
    </>
  );
}

function Overview({ repoId, d }: { repoId: string; d: NodeDetail }) {
  const n = d.node;
  const reveal = useReveal();
  const expanded = useStore((s) => s.expanded);
  const props = propRows(n);
  return (
    <>
      <section className="details-section">
        <div
          className="metrics"
          style={
            n.metrics?.churn !== undefined || n.metrics?.betweenness !== undefined
              ? { gridTemplateColumns: 'repeat(3, 1fr)' }
              : undefined
          }
        >
          <Metric label="Fan-in" value={n.metrics?.fanIn} />
          <Metric label="Fan-out" value={n.metrics?.fanOut} />
          <Metric label="Lines" value={n.metrics?.loc} />
          <Metric label="Complexity" value={n.metrics?.complexity} />
          {n.metrics?.churn !== undefined && <Metric label="Churn" value={n.metrics.churn} />}
          {n.metrics?.betweenness !== undefined && (
            <Metric label="Betweenness" text={n.metrics.betweenness.toFixed(3)} />
          )}
        </div>
      </section>
      <Summary repoId={repoId} node={n} />
      <section className="details-section">
        <div className="actions">
          <button type="button" className="btn btn-secondary" onClick={() => actions.upstream(n.id)} title="U">
            Upstream
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => actions.downstream(n.id)} title="D">
            Downstream
          </button>
          {n.kind === 'endpoint' && (
            <button type="button" className="btn btn-secondary" onClick={() => actions.trace(n.id)}>
              Trace
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => actions.focus(n.id)}>
            Focus
          </button>
          {d.children.length > 0 && (
            <button type="button" className="btn btn-ghost" onClick={() => actions.toggleExpand(n.id)}>
              {expanded.includes(n.id) ? 'Collapse' : 'Expand'}
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => actions.path(n.id, 'from')} title="P">
            Path
          </button>
        </div>
      </section>
      {props.length > 0 && (
        <section className="details-section">
          <span className="t-caption">Properties</span>
          <dl className="props">
            {props.map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{k}</dt>
                <dd className={k === 'Signature' ? 't-mono' : undefined}>{v}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {n.kind === 'file' && <SubsystemPin repoId={repoId} node={n} />}
      {n.kind === 'file' && <History repoId={repoId} id={n.id} />}
      <EdgeGroups title="Incoming" items={d.incoming} onPick={(id) => void reveal(id, { view: keepView() })} />
      <EdgeGroups title="Outgoing" items={d.outgoing} onPick={(id) => void reveal(id, { view: keepView() })} />
      {d.children.length > 0 && (
        <section className="details-section">
          <span className="t-caption">Contains {fmtNum(d.children.length)}</span>
          <NodeList nodes={d.children} onPick={(id) => void reveal(id, { view: keepView() })} />
        </section>
      )}
    </>
  );
}

const keepView = () => useStore.getState().view;

const SUMMARY_KINDS = new Set(['file', 'class', 'module', 'function', 'package', 'subsystem']);

/** Model-written summary (C-23): shown when one exists; "Summarize" only when a provider is configured. */
function Summary({ repoId, node }: { repoId: string; node: GraphNode }) {
  const qc = useQueryClient();
  const llm = useQuery({ queryKey: ['llm'], queryFn: api.llm, staleTime: 5 * 60_000 });
  const sums = useQuery({ queryKey: ['summaries', repoId], queryFn: () => api.summaries(repoId), staleTime: 60_000 });
  const run = useMutation({
    mutationFn: () => api.summarize(repoId, { nodeIds: [node.id], force: !!sums.data?.[node.id] }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['summaries', repoId] });
      if (r.failed.length) throw new Error(r.failed[0].error);
    },
  });
  const s = sums.data?.[node.id];
  const canRun = !!llm.data?.provider && SUMMARY_KINDS.has(node.kind);
  if (!s && !canRun) return null;
  return (
    <section className="details-section">
      <div className="section-head">
        <span className="t-caption">Summary</span>
        {canRun && (
          <button type="button" className="btn btn-ghost" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? 'Writing…' : s ? 'Regenerate' : 'Summarize'}
          </button>
        )}
      </div>
      {s ? <p>{s.text}</p> : !run.isPending && <p className="tone-3">No summary yet.</p>}
      {run.isPending && <Spinner label="Writing summary" />}
      {run.isError && <p className="tone-3">{String((run.error as Error).message)}</p>}
      {s && <p className="t-caption tone-3 summary-model">{s.model}</p>}
    </section>
  );
}

function Metric({ label, value, text }: { label: string; value?: number; text?: string }) {
  return (
    <div className="metric">
      <div className="t-caption tone-3">{label}</div>
      <div className="value">{text ?? (value === undefined ? '–' : fmtNum(value))}</div>
    </div>
  );
}

/** Pin a file to a subsystem (subsystem override); the server recomputes subsystems. */
function SubsystemPin({ repoId, node }: { repoId: string; node: GraphNode }) {
  const subs = useQuery({ queryKey: ['subsystems', repoId], queryFn: () => api.subsystems(repoId) });
  const overrides = useOverrides(repoId);
  const save = useSaveOverrides(repoId);
  if (!subs.data?.length) return null;
  // pins are keyed by repo-relative file path
  const key = node.file ?? node.id;
  const pinned = overrides.data?.pins[key];
  const current = pinned ?? (node.props.subsystem as string | undefined) ?? '';
  return (
    <section className="details-section">
      <label className="select-row" style={{ marginTop: 0 }}>
        <span className="t-caption">Subsystem</span>
        <select
          className="select"
          style={{ maxWidth: 200 }}
          value={current}
          disabled={save.isPending || overrides.isError}
          title={overrides.isError ? 'Subsystem overrides are unavailable on this server.' : undefined}
          onChange={(e) => {
            const to = e.target.value;
            save.mutate((o) => {
              const pins = { ...o.pins };
              if (to) pins[key] = to;
              else delete pins[key];
              return { ...o, pins };
            });
          }}
        >
          {!current && <option value="">None</option>}
          {[...subs.data]
            .sort((a, b) => a.node.name.localeCompare(b.node.name))
            .map((s) => (
              <option key={s.node.id} value={s.node.id}>
                {s.node.name}
              </option>
            ))}
        </select>
      </label>
      {pinned && (
        <div className="tone-3" style={{ marginTop: 4 }}>
          Pinned.{' '}
          <button
            type="button"
            className="link-button"
            onClick={() =>
              save.mutate((o) => {
                const pins = { ...o.pins };
                delete pins[key];
                return { ...o, pins };
              })
            }
          >
            Unpin
          </button>
        </div>
      )}
    </section>
  );
}

/** Git history of a file: commits, top authors, last change. Hidden when the server has none. */
function History({ repoId, id }: { repoId: string; id: string }) {
  const q = useQuery({
    queryKey: ['history', repoId, id],
    queryFn: () => api.history(repoId, id),
    retry: false,
    staleTime: 5 * 60_000,
  });
  return (
    <section className="details-section">
      <span className="t-caption">History</span>
      {q.isLoading && <Spinner label="Loading history" />}
      {q.isError && <p className="tone-3">No git history available.</p>}
      {q.data && q.data.commits === 0 && <p className="tone-3">No commits touch this file.</p>}
      {q.data && q.data.commits > 0 && (
        <>
          <div className="metrics" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <Metric label="Commits" value={q.data.commits} />
            <Metric label="Last change" text={q.data.lastModified ? fmtRelative(q.data.lastModified) : '–'} />
          </div>
          {q.data.authors.length > 0 && (
            <dl className="props" style={{ marginTop: 12 }}>
              {q.data.authors.slice(0, 5).map((a) => (
                <div key={a.name} style={{ display: 'contents' }}>
                  <dt className="ellipsis">{a.name}</dt>
                  <dd className="num">
                    {fmtNum(a.commits)} {a.commits === 1 ? 'commit' : 'commits'}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </>
      )}
    </section>
  );
}

function propRows(n: GraphNode): [string, string][] {
  const p = n.props;
  const rows: [string, string][] = [];
  const add = (k: string, v: unknown) => {
    if (v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && v.length === 0)) return;
    rows.push([k, v === true ? 'Yes' : Array.isArray(v) ? v.join(', ') : String(v)]);
  };
  add('Signature', p.signature);
  add('Method', p.method);
  add('Path', n.kind === 'endpoint' ? p.path : undefined);
  add('Framework', p.framework);
  add('Exported', p.isExported);
  add('Async', p.isAsync);
  add('Static', p.isStatic);
  add('Abstract', p.isAbstract);
  add('Decorators', p.decorators);
  add('Entry point', p.isEntry);
  add('Language', n.language);
  add('Ecosystem', p.ecosystem);
  add('Version', p.version);
  add('Subsystem members', p.memberCount);
  return rows;
}

const EDGE_ORDER: EdgeKind[] = [
  'exposes',
  'calls',
  'instantiates',
  'extends',
  'implements',
  'imports',
  'references',
  'depends_on',
];

function EdgeGroups({
  title,
  items,
  onPick,
}: { title: string; items: { edge: GraphEdge; node: GraphNode }[]; onPick: (id: string) => void }) {
  if (items.length === 0) return null;
  const byKind = new Map<EdgeKind, { edge: GraphEdge; node: GraphNode }[]>();
  for (const it of items) {
    const list = byKind.get(it.edge.kind);
    if (list) list.push(it);
    else byKind.set(it.edge.kind, [it]);
  }
  const kinds = [...byKind.keys()].sort((a, b) => EDGE_ORDER.indexOf(a) - EDGE_ORDER.indexOf(b));
  return (
    <section className="details-section">
      <span className="t-caption">
        {title} {fmtNum(items.length)}
      </span>
      {kinds.map((k) => (
        <div key={k} className="list-group">
          <div className="list-group-head">
            <span className="tone-3">{k.replace('_', ' ')}</span>
            <span className="num tone-3">{fmtNum(byKind.get(k)?.length)}</span>
          </div>
          <ul>
            {(byKind.get(k) ?? []).slice(0, 50).map(({ edge, node }) => (
              <li key={edge.id}>
                <button type="button" className="row" onClick={() => onPick(node.id)} title={node.qname ?? node.name}>
                  <KindGlyph kind={node.kind} />
                  <span className="name" style={edge.confidence < 1 ? { color: 'var(--text-secondary)' } : undefined}>
                    {nodeLabel(node)}
                  </span>
                  <span className="meta">
                    {edge.confidence < 1
                      ? `${Math.round(edge.confidence * 100)}%`
                      : edge.weight > 1
                        ? `×${edge.weight}`
                        : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function NodeList({ nodes, onPick }: { nodes: GraphNode[]; onPick: (id: string) => void }) {
  return (
    <ul>
      {nodes.slice(0, 200).map((c) => (
        <li key={c.id}>
          <button type="button" className="row" onClick={() => onPick(c.id)}>
            <KindGlyph kind={c.kind} />
            <span className="name">{nodeLabel(c)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** A clickable call site: [from, to) columns on one source line, pointing at the edge's target. */
interface Site {
  from: number;
  to: number;
  target: GraphNode;
  kind: EdgeKind;
}

/** Call/import sites from the evidence spans of the node's outgoing edges, keyed by line. */
function sitesByLine(outgoing: NodeDetail['outgoing'], path: string, lines: string[], first: number) {
  const out = new Map<number, Site[]>();
  for (const { edge, node } of outgoing) {
    for (const sp of edge.props.evidence ?? []) {
      const text = lines[sp.startLine - first];
      if (sp.file !== path || text === undefined) continue;
      const end = sp.endLine === sp.startLine ? sp.endCol : text.length;
      // underline the callee (`orders.get`), not its arguments
      const paren = text.indexOf('(', sp.startCol);
      const to = paren > sp.startCol && paren < end ? paren : end;
      if (to <= sp.startCol) continue;
      const list = out.get(sp.startLine) ?? [];
      if (list.some((x) => x.from < to && sp.startCol < x.to)) continue; // first edge wins overlaps
      list.push({ from: sp.startCol, to, target: node, kind: edge.kind });
      out.set(sp.startLine, list);
    }
  }
  for (const l of out.values()) l.sort((a, b) => a.from - b.from);
  return out;
}

/** The tokens covering columns [from, to) of a line. */
function sliceTokens(tokens: Token[], from: number, to: number): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const t of tokens) {
    const a = Math.max(from, at);
    const b = Math.min(to, at + t.text.length);
    if (a < b)
      out.push(
        <span key={a} className={`tok-${t.tone}`}>
          {t.text.slice(a - at, b - at)}
        </span>,
      );
    at += t.text.length;
  }
  return out;
}

function CodeText({
  text,
  tokens,
  sites,
  onPick,
}: {
  text: string;
  tokens?: Token[];
  sites?: Site[];
  onPick: (id: string) => void;
}) {
  const toks = tokens ?? [{ text, tone: 1 as const }];
  if (!sites?.length) return <span>{sliceTokens(toks, 0, text.length)}</span>;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const site of sites) {
    parts.push(...sliceTokens(toks, at, site.from));
    parts.push(
      <button
        key={`s${site.from}`}
        type="button"
        className="code-link"
        title={`${site.kind.replace('_', ' ')} ${nodeLabel(site.target)}`}
        onClick={() => onPick(site.target.id)}
      >
        {sliceTokens(toks, site.from, site.to)}
      </button>,
    );
    at = site.to;
  }
  parts.push(...sliceTokens(toks, at, text.length));
  return <span>{parts}</span>;
}

function Source({ repoId, id, outgoing }: { repoId: string; id: string; outgoing: NodeDetail['outgoing'] }) {
  const q = useQuery({ queryKey: ['source', repoId, id], queryFn: () => api.source(repoId, id, 8), staleTime: 60_000 });
  const grammar = q.data ? grammarFor(q.data.language, q.data.path) : undefined;
  const tokens = useQuery({
    queryKey: ['tokens', repoId, id, grammar],
    queryFn: () => tokenize(q.data?.lines ?? [], grammar),
    enabled: Boolean(q.data && grammar),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const sites = useMemo(
    () => (q.data ? sitesByLine(outgoing, q.data.path, q.data.lines, q.data.startLine) : undefined),
    [q.data, outgoing],
  );
  const reveal = useReveal();
  const ref = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll again whenever new source arrives
  useEffect(() => {
    ref.current?.querySelector('[data-hl="true"]')?.scrollIntoView({ block: 'center' });
  }, [q.data]);
  if (q.isLoading)
    return (
      <div className="empty">
        <Spinner />
      </div>
    );
  if (q.isError || !q.data)
    return (
      <EmptyState title="Source unavailable" body={(q.error as Error | null)?.message ?? 'The file is not on disk.'} />
    );
  const s = q.data;
  const [h0, h1] = s.highlight ?? [0, -1];
  return (
    <div className="details-section">
      <div className="t-mono tone-3" style={{ marginBottom: 8 }}>
        {s.path} · lines {s.startLine}–{s.endLine} of {fmtNum(s.totalLines)}
      </div>
      <div className="code" ref={ref}>
        {s.lines.map((line, i) => {
          const ln = s.startLine + i;
          return (
            <div key={ln} className="code-line" data-hl={ln >= h0 && ln <= h1}>
              <span className="ln">{ln}</span>
              <CodeText
                text={line || ' '}
                tokens={tokens.data?.[i]}
                sites={sites?.get(ln)}
                onPick={(nid) => void reveal(nid, { view: keepView() })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
