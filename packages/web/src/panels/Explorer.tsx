import type { Diagnostic, RepoInfo } from '@spider/shared';
import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { type TreeNode, api } from '../api';
import { fmtNum, nodeLabel } from '../format';
import { useDiagnostics, useReveal } from '../hooks';
import { useStore } from '../store';
import { EmptyState, KindGlyph, Spinner, Tabs } from '../ui';
import { FiltersSection, LegendSection } from './Filters';

type Tab = 'tree' | 'subsystems' | 'endpoints' | 'diagnostics';

export function Explorer({ repoId, repo }: { repoId: string; repo?: RepoInfo }) {
  const [tab, setTab] = useState<Tab>('tree');
  return (
    <>
      <Tabs
        value={tab}
        onChange={setTab}
        options={[
          { value: 'tree', label: 'Tree' },
          { value: 'subsystems', label: 'Subsystems' },
          { value: 'endpoints', label: 'Endpoints' },
          { value: 'diagnostics', label: 'Issues' },
        ]}
      />
      <div className="side-scroll">
        {tab === 'tree' && <TreeLevel repoId={repoId} parent="repo" depth={0} />}
        {tab === 'subsystems' && <Subsystems repoId={repoId} />}
        {tab === 'endpoints' && <Endpoints repoId={repoId} />}
        {tab === 'diagnostics' && <Diagnostics repoId={repoId} />}
        <FiltersSection languages={repo?.stats.languages.map((l) => l.language) ?? []} />
        <LegendSection />
      </div>
    </>
  );
}

/* ---------- tree ---------- */

function TreeLevel({ repoId, parent, depth }: { repoId: string; parent: string; depth: number }) {
  const q = useQuery({
    queryKey: ['tree', repoId, parent],
    queryFn: () => api.tree(repoId, parent, 1),
    staleTime: 5 * 60_000,
  });
  if (q.isLoading)
    return (
      <div className="row tree-row" style={{ ['--depth' as string]: depth }}>
        <Spinner />
      </div>
    );
  if (q.isError) return <div className="row tree-row tone-danger">{(q.error as Error).message}</div>;
  if (!q.data?.length && depth === 0) return <EmptyState title="Empty repository" body="No files were analysed." />;
  return (
    <ul role={depth === 0 ? 'tree' : 'group'}>
      {q.data?.map((n) => (
        <TreeItem key={n.id} repoId={repoId} node={n} depth={depth} />
      ))}
    </ul>
  );
}

function TreeItem({ repoId, node, depth }: { repoId: string; node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(false);
  const selected = useStore((s) => s.selected === node.id);
  const reveal = useReveal();
  const hasKids = node.childCount > 0;
  return (
    <li role="treeitem" aria-expanded={hasKids ? open : undefined} aria-selected={selected}>
      <div
        className="row tree-row"
        style={{ ['--depth' as string]: depth }}
        // biome-ignore lint/a11y/useSemanticElements: the row holds the chevron <button>; buttons cannot nest
        role="button"
        aria-selected={selected}
        tabIndex={0}
        onClick={() => void reveal(node.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void reveal(node.id);
          if (e.key === 'ArrowRight' && hasKids) setOpen(true);
          if (e.key === 'ArrowLeft') setOpen(false);
        }}
      >
        <button
          type="button"
          aria-label={open ? 'Collapse' : 'Expand'}
          style={{ visibility: hasKids ? 'visible' : 'hidden', display: 'flex' }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          tabIndex={-1}
        >
          <ChevronRight className="chevron" data-open={open} strokeWidth={1.5} />
        </button>
        <KindGlyph kind={node.kind} />
        <span className="name">{nodeLabel(node)}</span>
        {node.kind === 'file' && node.metrics?.loc ? <span className="meta">{fmtNum(node.metrics.loc)}</span> : null}
      </div>
      {open && hasKids && <TreeLevel repoId={repoId} parent={node.id} depth={depth + 1} />}
    </li>
  );
}

/* ---------- subsystems ---------- */

function Subsystems({ repoId }: { repoId: string }) {
  const q = useQuery({ queryKey: ['subsystems', repoId], queryFn: () => api.subsystems(repoId) });
  const selected = useStore((s) => s.selected);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <EmptyState title="Could not load subsystems" body={(q.error as Error).message} />;
  if (!q.data?.length)
    return <EmptyState title="No subsystems" body="This repository is too small to split into subsystems." />;
  return (
    <ul>
      {[...q.data]
        .sort((a, b) => b.members - a.members)
        .map((s) => (
          <li key={s.node.id}>
            <button
              type="button"
              className="row"
              aria-selected={selected === s.node.id}
              onClick={() => {
                const st = useStore.getState();
                if (st.level !== 'L0') st.setLevel('L0');
                if (st.view !== 'map') st.setView('map');
                st.select(s.node.id);
                st.setCenterOn(s.node.id);
              }}
            >
              <KindGlyph kind="subsystem" />
              <span className="name">{s.node.name}</span>
              <span className="meta">{fmtNum(s.members)}</span>
            </button>
          </li>
        ))}
    </ul>
  );
}

/* ---------- endpoints ---------- */

function Endpoints({ repoId }: { repoId: string }) {
  const q = useQuery({ queryKey: ['endpoints', repoId], queryFn: () => api.endpoints(repoId) });
  const selected = useStore((s) => s.selected);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <EmptyState title="Could not load endpoints" body={(q.error as Error).message} />;
  if (!q.data?.length)
    return <EmptyState title="No endpoints found" body="No supported web framework routes were detected." />;
  return (
    <table className="table">
      <thead>
        <tr>
          <th style={{ paddingLeft: 8 }}>Method</th>
          <th>Path</th>
          <th className="right" style={{ paddingRight: 8 }} title="Trace depth">
            Depth
          </th>
        </tr>
      </thead>
      <tbody>
        {q.data.map((e) => (
          <tr
            key={e.node.id}
            className="table-select"
            aria-selected={selected === e.node.id}
            tabIndex={0}
            onClick={() => {
              const st = useStore.getState();
              st.select(e.node.id);
              st.setFlowQuery({ type: 'trace', id: e.node.id, depth: 6 });
            }}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') useStore.getState().setFlowQuery({ type: 'trace', id: e.node.id, depth: 6 });
            }}
            title={e.handler ? `Handler: ${e.handler.qname ?? e.handler.name}` : undefined}
          >
            <td className="t-mono tone-2" style={{ paddingLeft: 8 }}>
              {String(e.node.props.method ?? '').toUpperCase()}
            </td>
            <td className="t-mono ellipsis" style={{ maxWidth: 150 }}>
              {String(e.node.props.path ?? e.node.name)}
            </td>
            <td className="right num tone-3" style={{ paddingRight: 8 }}>
              {e.traceDepth}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ---------- diagnostics ---------- */

const DIAG_LABEL: Record<Diagnostic['type'], string> = {
  cycle: 'Import cycles',
  'god-module': 'Large hubs',
  'dead-code': 'Unreferenced exports',
  orphan: 'Orphan files',
};
const DIAG_ORDER: Diagnostic['type'][] = ['cycle', 'god-module', 'dead-code', 'orphan'];

function Diagnostics({ repoId }: { repoId: string }) {
  const q = useDiagnostics(repoId);
  const reveal = useReveal();
  const [open, setOpen] = useState<string | undefined>('cycle');
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <EmptyState title="Could not load issues" body={(q.error as Error).message} />;
  if (!q.data?.length)
    return <EmptyState title="No issues found" body="No cycles, large hubs, unreferenced exports or orphan files." />;
  return (
    <div>
      {DIAG_ORDER.map((type) => {
        const list = q.data.filter((d) => d.type === type);
        if (list.length === 0) return null;
        const isOpen = open === type;
        return (
          <div key={type} className="list-group">
            <button
              type="button"
              className="row"
              onClick={() => setOpen(isOpen ? undefined : type)}
              aria-expanded={isOpen}
            >
              <ChevronRight className="chevron" data-open={isOpen} strokeWidth={1.5} />
              <span className={`name${type === 'cycle' ? ' tone-danger' : ''}`}>{DIAG_LABEL[type]}</span>
              <span className="meta">{fmtNum(list.length)}</span>
            </button>
            {isOpen && (
              <ul>
                {list.map((d, i) => (
                  <li key={`${d.title}-${i}`}>
                    <button
                      type="button"
                      className="row"
                      style={{ paddingLeft: 28 }}
                      title={d.detail ?? d.title}
                      onClick={() => {
                        const first = d.nodeIds[0];
                        if (!first) return;
                        if (d.type === 'cycle' && d.nodeIds.length > 1) {
                          useStore.getState().select(first);
                          useStore
                            .getState()
                            .setFlowQuery({ type: 'path', from: first, to: d.nodeIds[d.nodeIds.length - 1] });
                        } else void reveal(first);
                      }}
                    >
                      <span className="name">{d.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
