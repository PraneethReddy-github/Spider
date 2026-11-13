import type { GraphNode } from '@spider/shared';
import type { EditorScheme } from './store';

export const EDITORS: { value: EditorScheme; label: string }[] = [
  { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'idea', label: 'JetBrains IDE' },
  { value: 'none', label: 'None' },
];

/** Deep link that opens `node` at its first line in the chosen editor; undefined when not possible. */
export function editorUrl(scheme: EditorScheme, root: string | undefined, node: GraphNode): string | undefined {
  if (scheme === 'none' || !root || !node.file || node.kind === 'directory') return undefined;
  const abs = `${root.replace(/[\\/]+$/, '')}/${node.file}`.replace(/\\/g, '/');
  const line = node.span?.startLine ?? 1;
  const col = (node.span?.startCol ?? 0) + 1;
  if (scheme === 'idea') return `idea://open?file=${encodeURIComponent(abs)}&line=${line}`;
  // vscode://file/<abs>:<line>:<col>; Windows drive paths need the extra leading slash
  return `${scheme}://file${encodeURI(abs.startsWith('/') ? abs : `/${abs}`)}:${line}:${col}`;
}
