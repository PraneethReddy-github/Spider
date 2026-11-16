import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { RepoInfo } from '@spider/shared';
import { repoDir, spiderHome } from '../analyze.js';
import { markdownReport } from '../query/report.js';
import type { QueryService } from '../query/service.js';
import type { SummaryMap } from './summaries.js';
import { type LlmProvider, textOf } from './types.js';

/**
 * "Architecture of X" (C-27): the deterministic report, plus a model-written narrative when one was generated.
 * The narrative is cached against the hash of the report and summaries it was written from.
 */

const SYSTEM = `You write the opening of an onboarding document for engineers new to a codebase.
From the architecture report and component summaries given, write 3-5 short paragraphs of plain Markdown prose (no
headings): what the system is for, its main parts and how they depend on each other, where requests enter and where
data lives, and what to read first. Name real files, subsystems and endpoints from the material. Do not invent
anything the material does not show.`;

interface Narrative {
  hash: string;
  text: string;
  model: string;
  generatedAt: string;
}

const narrativeFile = (repoId: string, home?: string) => path.join(repoDir(spiderHome(home), repoId), 'narrative.json');

function inputOf(report: string, summaries: SummaryMap, q: QueryService): string {
  const sums = Object.values(summaries)
    .map((s) => ({ s, n: q.node(s.nodeId) }))
    .filter((x) => x.n && (x.n.kind === 'subsystem' || x.n.kind === 'package' || x.n.kind === 'file'))
    .slice(0, 60)
    .map((x) => `- ${x.n?.kind} ${x.n?.qname ?? x.n?.name}: ${x.s.text}`);
  return `${report}\n\n## Component summaries\n\n${sums.join('\n') || '(none)'}`;
}

/** Report with the cached narrative (if it still matches) under the title. */
export async function onboardingDoc(q: QueryService, info: RepoInfo, summaries: SummaryMap, home?: string) {
  const report = markdownReport(q, info);
  const hash = createHash('sha256')
    .update(inputOf(report, summaries, q))
    .digest('hex');
  let n: Narrative | undefined;
  try {
    n = JSON.parse(await fs.readFile(narrativeFile(info.repoId, home), 'utf8')) as Narrative;
  } catch {
    n = undefined;
  }
  const fresh = n?.hash === hash ? n : undefined;
  return { markdown: withNarrative(report, fresh?.text), narrative: fresh, stale: !!n && !fresh, hash };
}

function withNarrative(report: string, text: string | undefined): string {
  if (!text) return report;
  const [title, ...rest] = report.split('\n');
  return [title, '', text.trim(), '', ...rest].join('\n');
}

export async function writeNarrative(o: {
  q: QueryService;
  info: RepoInfo;
  summaries: SummaryMap;
  provider: LlmProvider;
  home?: string;
  force?: boolean;
  signal?: AbortSignal;
}): Promise<{ markdown: string; generated: boolean }> {
  const cur = await onboardingDoc(o.q, o.info, o.summaries, o.home);
  if (cur.narrative && !o.force) return { markdown: cur.markdown, generated: false };
  const report = markdownReport(o.q, o.info);
  const r = await o.provider.chat({
    system: SYSTEM,
    messages: [{ role: 'user', content: [{ type: 'text', text: inputOf(report, o.summaries, o.q) }] }],
    effort: 'medium',
    maxTokens: 16000,
    signal: o.signal,
  });
  const text = textOf(r);
  if (r.stop === 'refusal' || !text) throw new Error(r.stop === 'refusal' ? 'model declined' : 'empty answer');
  const n: Narrative = { hash: cur.hash, text, model: r.model, generatedAt: new Date().toISOString() };
  await fs.writeFile(narrativeFile(o.info.repoId, o.home), JSON.stringify(n));
  return { markdown: withNarrative(report, text), generated: true };
}
