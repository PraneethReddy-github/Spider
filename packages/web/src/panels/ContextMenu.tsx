import { useEffect, useRef } from 'react';
import { actions } from '../actions';
import { useNodeDetail } from '../hooks';
import { useStore } from '../store';

export function ContextMenu({ repoId }: { repoId: string }) {
  const menu = useStore((s) => s.contextMenu);
  const close = useStore((s) => s.openContextMenu);
  const expanded = useStore((s) => s.expanded);
  const view = useStore((s) => s.view);
  const { data } = useNodeDetail(repoId, menu?.nodeId);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close(undefined);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [menu, close]);

  if (!menu) return null;
  const id = menu.nodeId;
  const node = data?.node.id === id ? data.node : undefined;
  const isContainer = (data?.children.length ?? 0) > 0;
  const isExpanded = expanded.includes(id);
  const run = (fn: () => void) => () => {
    close(undefined);
    fn();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };

  return (
    <div
      ref={ref}
      className="menu"
      role="menu"
      style={{ left: Math.min(menu.x, window.innerWidth - 232), top: Math.min(menu.y, window.innerHeight - 320) }}
      onKeyDown={onKey}
    >
      <Item label="Upstream" kbd="U" onClick={run(() => actions.upstream(id))} />
      <Item label="Downstream" kbd="D" onClick={run(() => actions.downstream(id))} />
      <Item label="Trace" disabled={node?.kind !== 'endpoint'} onClick={run(() => actions.trace(id))} />
      <Item label="Focus" onClick={run(() => actions.focus(id))} />
      <div className="menu-sep" />
      <Item label="Path from here" kbd="P" onClick={run(() => actions.path(id, 'from'))} />
      <Item label="Path to here" onClick={run(() => actions.path(id, 'to'))} />
      <div className="menu-sep" />
      <Item
        label={isExpanded ? 'Collapse' : 'Expand'}
        disabled={view !== 'map' || (!isContainer && !isExpanded)}
        onClick={run(() => actions.toggleExpand(id))}
      />
      <Item label="Hide" kbd="H" onClick={run(() => actions.hide(id))} />
      <Item label="Copy id" onClick={run(() => void actions.copyId(id))} />
    </div>
  );
}

function Item({
  label,
  kbd,
  onClick,
  disabled,
}: { label: string; kbd?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" role="menuitem" className="menu-item" onClick={onClick} disabled={disabled}>
      {label}
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}
