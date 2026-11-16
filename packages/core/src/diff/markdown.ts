import type { DiffEdgeRef, DiffNodeRef, GraphDiff } from '@spider/shared';

const LIST_MAX = 25;
const short = (sha?: string) => (sha ? sha.slice(0, 7) : '');
const side = (s: GraphDiff['base']) =>
  `\`${s.ref}\`${s.commit && s.ref !== short(s.commit) ? ` (${short(s.commit)})` : ''}`;
const nodeLine = (n: DiffNodeRef) => `- ${n.kind} \`${n.qname ?? n.file ?? n.name}\``;
const edgeLine = (e: DiffEdgeRef) => `- ${e.kind} \`${e.srcLabel}\` → \`${e.dstLabel}\``;

function section(title: string, lines: string[]): string[] {
  if (!lines.length) return [];
  const more = lines.length > LIST_MAX ? [`- … ${lines.length - LIST_MAX} more`] : [];
  return [`### ${title}`, '', ...lines.slice(0, LIST_MAX), ...more, ''];
}

/** PR-comment-sized Markdown summary of a graph diff. */
export function diffMarkdown(d: GraphDiff): string {
  const s = d.summary;
  const out = [
    `## Spider graph diff: ${side(d.base)} → ${side(d.head)}`,
    '',
    '| | Added | Removed | Changed |',
    '|---|---:|---:|---:|',
    `| Files | ${s.filesAdded} | ${s.filesRemoved} | ${s.filesChanged} |`,
    `| Nodes | ${s.nodesAdded} | ${s.nodesRemoved} | ${s.nodesChanged} |`,
    `| Edges | ${s.edgesAdded} | ${s.edgesRemoved} | |`,
    '',
  ];
  const issues = [
    ...d.diagnostics.newCycles.map((x) => `- New cycle: ${x.title}${x.detail ? ` (\`${x.detail}\`)` : ''}`),
    ...d.diagnostics.newViolations.map((x) => `- New layer violation: ${x.title}`),
    ...d.diagnostics.resolvedCycles.map((x) => `- Resolved cycle: ${x.title}${x.detail ? ` (\`${x.detail}\`)` : ''}`),
    ...d.diagnostics.resolvedViolations.map((x) => `- Resolved layer violation: ${x.title}`),
  ];
  out.push(...(issues.length ? ['### Architecture', '', ...issues, ''] : ['No new cycles or layer violations.', '']));
  const symbols = (list: DiffNodeRef[]) => list.filter((n) => n.kind !== 'directory').map(nodeLine);
  out.push(...section('Added', symbols(d.nodes.added)));
  out.push(...section('Removed', symbols(d.nodes.removed)));
  out.push(...section('New dependencies', d.edges.added.map(edgeLine)));
  out.push(...section('Dropped dependencies', d.edges.removed.map(edgeLine)));
  return `${out.join('\n').trimEnd()}\n`;
}
