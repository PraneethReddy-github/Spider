import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import type { RemoteRefs } from '@spider/shared';
import { simpleGit } from 'simple-git';

/** Commit sha of `ref` in the repository at `root`; throws `{statusCode: 400}` when it doesn't resolve. */
export async function resolveCommit(root: string, ref: string): Promise<string> {
  if (ref.startsWith('-')) throw Object.assign(new Error(`not a valid git ref: ${ref}`), { statusCode: 400 });
  try {
    return (await simpleGit(root).raw(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  } catch {
    throw Object.assign(new Error(`unknown revision: ${ref}`), { statusCode: 400 });
  }
}

/** True when `root` is the top of a git work tree (not just somewhere inside one). */
export async function isGitRoot(root: string): Promise<boolean> {
  try {
    const top = (await simpleGit(root).revparse(['--show-toplevel'])).trim();
    return (await fs.realpath(top)) === (await fs.realpath(root));
  } catch {
    return false;
  }
}

/**
 * Writes the tree of `commit` into `dir` (`git archive | tar -x`). Reads only the object database:
 * the user's working tree, index and refs are untouched.
 */
export async function exportCommit(root: string, commit: string, dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const git = spawn('git', ['-C', root, 'archive', '--format=tar', commit], { stdio: ['ignore', 'pipe', 'pipe'] });
    const tar = spawn('tar', ['-x', '-f', '-', '-C', dir], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    git.stderr.on('data', (b) => {
      err += b;
    });
    tar.stderr.on('data', (b) => {
      err += b;
    });
    git.stdout.pipe(tar.stdin);
    let pending = 2;
    const done = (code: number | null) => {
      if (code !== 0) reject(new Error(`git archive ${commit} failed: ${err.trim() || `exit ${code}`}`));
      else if (--pending === 0) resolve();
    };
    git.on('error', reject);
    tar.on('error', reject);
    git.on('close', done);
    tar.on('close', done);
  });
}

/** Local branches and tags of the repository at `root` (current branch as `defaultBranch`). */
export async function localRefs(root: string): Promise<RemoteRefs> {
  const git = simpleGit(root);
  const out = await git.raw(['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']);
  const branches: string[] = [];
  const tags: string[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('refs/heads/')) branches.push(line.slice(11));
    else if (line.startsWith('refs/tags/')) tags.push(line.slice(10));
  }
  const current = (await git.revparse(['--abbrev-ref', 'HEAD']).catch(() => '')).trim();
  return { defaultBranch: current && current !== 'HEAD' ? current : undefined, branches, tags };
}
