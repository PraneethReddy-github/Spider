import type { NodeHistory } from '@spider/shared';
import { simpleGit } from 'simple-git';
import type { GraphBuilder } from '../graph/builder.js';

const git = (root: string) => simpleGit({ baseDir: root, timeout: { block: 30_000 } });

/** Commits per file (paths relative to `root`) since `since`; empty when `root` is not in a git work tree. */
export async function gitChurn(root: string, since = '6 months ago'): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  try {
    const out = await git(root).raw(['log', `--since=${since}`, '--name-only', '--relative', '--format=', '--', '.']);
    for (const line of out.split('\n')) if (line) counts.set(line, (counts.get(line) ?? 0) + 1);
  } catch {
    /* not a git repo, or git unavailable: churn stays 0 */
  }
  return counts;
}

/** `metrics.churn` on every file node: commits touching it in the last 6 months (0 outside git). */
export async function computeChurn(g: GraphBuilder, root: string): Promise<void> {
  const counts = await gitChurn(root);
  for (const f of g.nodesOfKind('file')) {
    f.metrics ??= { fanIn: 0, fanOut: 0 };
    f.metrics.churn = counts.get(f.file ?? '') ?? 0;
  }
}

/** Whole-history commit count, authors (names only, never emails) and last commit date of a path. */
export async function fileHistory(root: string, file: string): Promise<NodeHistory> {
  try {
    const out = await git(root).raw(['log', '--format=%aN%x09%aI', '--', file]);
    const lines = out.split('\n').filter(Boolean);
    const authors = new Map<string, number>();
    for (const l of lines) {
      const name = l.split('\t')[0];
      authors.set(name, (authors.get(name) ?? 0) + 1);
    }
    return {
      commits: lines.length,
      authors: [...authors.entries()]
        .map(([name, commits]) => ({ name, commits }))
        .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name)),
      lastModified: lines[0]?.split('\t')[1],
    };
  } catch {
    return { commits: 0, authors: [] };
  }
}
