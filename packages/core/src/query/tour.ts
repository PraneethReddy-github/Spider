import type { GraphNode, RepoInfo, Tour, TourStep } from '@spider/shared';
import type { QueryService } from './service.js';

/**
 * Deterministic default tour (C-27): overview → subsystems → hub files → endpoints → issues. Each step is a map
 * state (level + node to reveal) with narration; summaries narrate when they exist, graph facts otherwise.
 */
export function defaultTour(q: QueryService, info: RepoInfo, summaries: Record<string, { text: string }> = {}): Tour {
  const s = info.stats;
  const steps: TourStep[] = [];
  const shown = new Set<string>();
  const say = (n: GraphNode, fallback: string) => summaries[n.id]?.text ?? fallback;
  const langs = s.languages
    .slice(0, 3)
    .map((l) => l.language)
    .join(', ');
  steps.push({
    title: `${info.name} at a glance`,
    text: `${num(s.files)} files and ${num(s.loc)} lines of ${langs || 'code'}${s.frameworks.length ? `, built on ${s.frameworks.slice(0, 4).join(', ')}` : ''}. Spider found ${num(s.byNodeKind.subsystem ?? 0)} subsystems and ${num(s.byNodeKind.endpoint ?? 0)} endpoints. This tour walks the main parts, the files everything leans on, and where requests come in.`,
    level: 'L1',
  });

  const central = (ids: string[]) =>
    ids
      .map((id) => q.node(id))
      .filter((n): n is GraphNode => !!n && !n.props.isTest)
      .sort((a, b) => (b.metrics?.pagerank ?? 0) - (a.metrics?.pagerank ?? 0));

  const subs = q
    .subsystems()
    .filter((x) => !x.node.props.isTest && x.members > 0)
    .sort((a, b) => b.members - a.members || a.node.name.localeCompare(b.node.name))
    .slice(0, 6);
  for (const sub of subs) {
    const files = central(q.g.inEdges(sub.node.id, 'member_of').map((e) => e.src));
    const top = files[0];
    if (!top) continue;
    shown.add(top.id);
    steps.push({
      title: sub.node.name,
      text: say(
        sub.node,
        `${num(sub.members)} files. Most central: ${files
          .slice(0, 3)
          .map((f) => f.name)
          .join(', ')}.`,
      ),
      nodeId: top.id,
      level: 'L1',
    });
  }

  const hubs = central(q.g.nodesOfKind('file').map((n) => n.id))
    .filter((n) => !shown.has(n.id))
    .slice(0, 3);
  for (const h of hubs) {
    const users = new Set(
      q.g
        .inEdges(h.id)
        .filter((e) => e.kind === 'imports')
        .map((e) => e.src),
    ).size;
    steps.push({
      title: `Hub: ${h.name}`,
      text: say(
        h,
        `${h.file} is one of the most depended-on files: ${num(users)} ${users === 1 ? 'file imports' : 'files import'} it.`,
      ),
      nodeId: h.id,
      level: 'L2',
    });
  }

  const eps = q.endpoints();
  if (eps.length) {
    const first = eps[0];
    steps.push({
      title: 'Where requests come in',
      text: `${num(eps.length)} endpoints. ${first.node.name}${first.handler ? ` is handled by ${first.handler.name}` : ''}; open Trace on any endpoint to follow it to the database.`,
      nodeId: first.node.id,
      level: 'L2',
    });
  }

  const cycles = q.diagnostics('cycle');
  const violations = q.diagnostics('layer-violation');
  if (cycles.length || violations.length) {
    const d = cycles[0] ?? violations[0];
    steps.push({
      title: 'Worth a look',
      text: `${num(cycles.length)} import cycles and ${num(violations.length)} layer violations. For example: ${d.title}. The Issues view lists them all.`,
      nodeId: d.nodeIds[0],
      level: 'L2',
    });
  }
  return { id: 'default', title: `Tour of ${info.name}`, steps };
}

const num = (n: number) => n.toLocaleString('en-US');
