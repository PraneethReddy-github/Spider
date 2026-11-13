import type { EdgeKind, GraphEdge, GraphNode, NodeDetail } from '@spider/shared';
import { useQuery } from '@tanstack/react-query';
import { Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { actions } from '../actions';
import { api } from '../api';
import { fmtNum, locationOf, nodeLabel } from '../format';
import { useNodeDetail, useReveal } from '../hooks';
import { useStore } from '../store';
import { EmptyState, IconButton, KindBadge, KindGlyph, Spinner, Tabs } from '../ui';

type Tab = 'overview' | 'source';

export function Details({ repoId }: { repoId: string }) {
  const selected = useStore((s) => s.selected);
  const [tab, setTab] = useState<Tab>('overview');
  const q = useNodeDetail(repoId, selected);

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
          <span style={{ marginLeft: 'auto' }}>
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
        {tab === 'overview' || !hasSource ? <Overview d={d} /> : <Source repoId={repoId} id={n.id} />}
      </div>
    </>
  );
}

function Overview({ d }: { d: NodeDetail }) {
  const n = d.node;
  const reveal = useReveal();
  const expanded = useStore((s) => s.expanded);
  const props = propRows(n);
  return (
    <>
      <section className="details-section">
        <div className="metrics">
          <Metric label="Fan-in" value={n.metrics?.fanIn} />
          <Metric label="Fan-out" value={n.metrics?.fanOut} />
          <Metric label="Lines" value={n.metrics?.loc} />
          <Metric label="Complexity" value={n.metrics?.complexity} />
        </div>
      </section>
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

function Metric({ label, value }: { label: string; value?: number }) {
  return (
    <div className="metric">
      <div className="t-caption tone-3">{label}</div>
      <div className="value">{value === undefined ? '–' : fmtNum(value)}</div>
    </div>
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

function Source({ repoId, id }: { repoId: string; id: string }) {
  const q = useQuery({ queryKey: ['source', repoId, id], queryFn: () => api.source(repoId, id, 8), staleTime: 60_000 });
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
              <span>{line || ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
