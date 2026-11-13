import type { Diagnostic, GraphNode, RepoInfo } from '@spider/shared';
import { subsystemDeps, subsystemLayers } from './architecture.js';
import type { QueryService } from './service.js';

const cell = (s: unknown) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, ' ');
const num = (n: number) => n.toLocaleString('en-US');
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

/** Markdown "Architecture of <name>" report built only from the stored graph. */
export function markdownReport(q: QueryService, info: RepoInfo): string {
  const s = info.stats;
  const out: string[] = [`# Architecture of ${info.name}`, ''];
  out.push(
    `Source ${code(info.source)}${info.commit ? ` at ${code(info.commit.slice(0, 12))}` : ''}${info.branch ? ` (${info.branch})` : ''} · analysed ${info.analysedAt} by Spider.`,
    '',
    '## Overview',
    '',
    '| Files | Lines of code | Nodes | Edges | Endpoints | Subsystems |',
    '|---:|---:|---:|---:|---:|---:|',
    `| ${num(s.files)} | ${num(s.loc)} | ${num(s.nodes)} | ${num(s.edges)} | ${num(s.byNodeKind.endpoint ?? 0)} | ${num(s.byNodeKind.subsystem ?? 0)} |`,
    '',
    '## Languages and frameworks',
    '',
    ...s.languages.slice(0, 10).map((l) => `- ${l.language}: ${num(l.files)} files, ${num(l.loc)} lines`),
    '',
    `Frameworks: ${s.frameworks.length ? s.frameworks.join(', ') : 'none detected'}.`,
    '',
  );
  subsystemSection(q, out);
  endpointSection(q, out);
  hubSection(q, out);
  diagnosticSection(q.diagnostics(), out);
  return `${out.join('\n').trimEnd()}\n`;
}

function subsystemSection(q: QueryService, out: string[]): void {
  const subs = q
    .subsystems()
    .filter((x) => !x.node.props.isTest)
    .sort((a, b) => b.members - a.members || a.node.name.localeCompare(b.node.name));
  if (!subs.length) return;
  const name = (id: string) => q.g.getNode(id)?.name ?? id;
  const deps = subsystemDeps(q);
  out.push('## Subsystems', '');
  for (const { node, members } of subs) {
    const files = q.g
      .inEdges(node.id, 'member_of')
      .map((e) => q.g.getNode(e.src))
      .filter((f): f is GraphNode => !!f && !f.props.isTest)
      .sort((a, b) => (b.metrics?.pagerank ?? 0) - (a.metrics?.pagerank ?? 0));
    const tests = members - files.length;
    out.push(
      `### ${node.name}`,
      '',
      `${num(files.length)} ${files.length === 1 ? 'file' : 'files'}${tests ? ` (+${num(tests)} test files)` : ''}. Key files: ${
        files
          .slice(0, 8)
          .map((f) => code(f.file ?? f.name))
          .join(', ') || 'none'
      }${files.length > 8 ? `, and ${num(files.length - 8)} more` : ''}.`,
    );
    const d = [...(deps.get(node.id) ?? [])].sort((a, b) => b[1] - a[1]);
    out.push(
      '',
      `Depends on: ${d.length ? d.map(([id, w]) => `${name(id)} (${num(w)})`).join(', ') : 'nothing inside the repository'}.`,
      '',
    );
  }
  const layers = subsystemLayers(q);
  const byLayer = new Map<number, string[]>();
  for (const [id, l] of layers) byLayer.set(l, [...(byLayer.get(l) ?? []), name(id)]);
  const violations = q.diagnostics('layer-violation').length;
  out.push(
    '## Layering',
    '',
    'Subsystems by inferred layer (layer 0 depends on no other subsystem; each higher layer depends on lower ones; mutually dependent subsystems share a layer).',
    '',
    ...[...byLayer.keys()]
      .sort((a, b) => b - a)
      .map((l) => `- Layer ${l}: ${(byLayer.get(l) ?? []).sort().join(', ')}`),
    '',
    `${num(violations)} upward ${violations === 1 ? 'dependency' : 'dependencies'} between sibling directories (see diagnostics).`,
    '',
  );
}

function endpointSection(q: QueryService, out: string[]): void {
  const eps = q.endpoints();
  if (!eps.length) return;
  out.push('## Endpoints', '', '| Method | Path | Handler | File |', '|---|---|---|---|');
  for (const e of eps.slice(0, 300))
    out.push(
      `| ${cell(e.node.props.method)} | ${cell(code(String(e.node.props.path ?? e.node.name)))} | ${cell(e.handler ? (e.handler.qname?.split('::').pop() ?? e.handler.name) : '—')} | ${cell(e.node.file)} |`,
    );
  if (eps.length > 300) out.push('', `…and ${num(eps.length - 300)} more.`);
  out.push('');
}

function hubSection(q: QueryService, out: string[]): void {
  const files = q.g.nodesOfKind('file').filter((f) => !f.props.isTest && f.metrics);
  const top = (metric: 'pagerank' | 'betweenness') =>
    files
      .filter((f) => (f.metrics?.[metric] ?? 0) > 0)
      .sort((a, b) => (b.metrics?.[metric] ?? 0) - (a.metrics?.[metric] ?? 0))
      .slice(0, 10);
  out.push('## Hubs', '');
  for (const [metric, title] of [
    ['pagerank', 'Most depended-on files (PageRank)'],
    ['betweenness', 'Most central connectors (betweenness)'],
  ] as const) {
    const list = top(metric);
    if (!list.length) continue;
    out.push(`### ${title}`, '', `| File | ${metric} | Fan-in | Fan-out | Churn (6 mo) |`, '|---|---:|---:|---:|---:|');
    for (const f of list)
      out.push(
        `| ${cell(f.file)} | ${(f.metrics?.[metric] ?? 0).toFixed(4)} | ${f.metrics?.fanIn ?? 0} | ${f.metrics?.fanOut ?? 0} | ${f.metrics?.churn ?? 0} |`,
      );
    out.push('');
  }
}

function diagnosticSection(diags: Diagnostic[], out: string[]): void {
  out.push('## Diagnostics', '');
  if (!diags.length) {
    out.push('No issues found.', '');
    return;
  }
  const byType = new Map<string, Diagnostic[]>();
  for (const d of diags) byType.set(d.type, [...(byType.get(d.type) ?? []), d]);
  out.push('| Type | Count |', '|---|---:|', ...[...byType].map(([t, l]) => `| ${t} | ${num(l.length)} |`), '');
  for (const [t, l] of byType) {
    out.push(`### ${t}`, '', ...l.slice(0, 10).map((d) => `- ${d.title}${d.detail ? ` — ${d.detail}` : ''}`));
    if (l.length > 10) out.push(`- …and ${num(l.length - 10)} more`);
    out.push('');
  }
}
