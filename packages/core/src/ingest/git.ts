import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RemoteRefs } from '@spider/shared';

const run = promisify(execFile);
/** Never let git block on a credential prompt (private repo without a token). */
const gitEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });

export function isGitUrl(s: string): boolean {
  if (existsSync(path.resolve(s))) return false; // `fixtures/x` is a local dir, not owner/repo
  return /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(s) || /^[\w.-]+\/[\w.-]+$/.test(s);
}

/** `owner/repo` → GitHub https URL; other sources unchanged. */
export function remoteUrl(source: string): string {
  return /^[\w.-]+\/[\w.-]+$/.test(source) ? `https://github.com/${source}.git` : source;
}

/** Removes `GITHUB_TOKEN` and any `user:password@` credentials from text (errors, logs). */
export function redact(text: string): string {
  const token = process.env.GITHUB_TOKEN;
  let out = text.replace(/(\w+:\/\/)[^/@\s]+@/g, '$1***@');
  if (token) out = out.split(token).join('***');
  return out;
}

/** The URL git talks to: GitHub https URLs carry `GITHUB_TOKEN` when it is set (never logged). */
function authUrl(url: string): string {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !/^https:\/\/github\.com\//.test(url)) return url;
  return url.replace('https://', `https://x-access-token:${encodeURIComponent(token)}@`);
}

const redacted = (err: unknown) => new Error(redact(String((err as Error)?.message ?? err)));

export type CloneProgress = (message: string, current: number, total: number) => void;

/**
 * Runs git with prompts disabled; with `onProgress`, parses its `--progress` stderr lines
 * (`Receiving objects:  45% (450/1000)`) and reports one line per stage and 10 % step.
 */
function git(args: string[], cwd: string | undefined, onProgress?: CloneProgress): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, env: gitEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let last = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
      for (const line of chunk.split(/[\r\n]+/)) {
        const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d+)% \((\d+)\/(\d+)\)/.exec(line.trim());
        if (!m || !onProgress) continue;
        const key = `${m[1]}:${Math.floor(Number(m[2]) / 10)}`;
        if (key === last) continue;
        last = key;
        onProgress(`${m[1].toLowerCase()} ${m[2]}% (${m[3]}/${m[4]})`, Number(m[3]), Number(m[4]));
      }
    });
    child.on('error', (err) => reject(redacted(err)));
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(redact(`git ${args[0]} failed: ${stderr.trim().split('\n').pop()}`))),
    );
  });
}

/**
 * Shallow clone of `url` into `root`, or refresh of an existing clone (fetch `ref` or the default
 * branch, hard reset; offline is tolerated). The stored remote never contains the token.
 */
export async function cloneOrUpdate(url: string, root: string, ref: string | undefined, onProgress: CloneProgress) {
  const auth = authUrl(url);
  if (!existsSync(path.join(root, '.git'))) {
    await git(
      ['clone', '--progress', '--depth', '1', ...(ref ? ['--branch', ref] : []), '--', auth, root],
      undefined,
      onProgress,
    );
    await git(['remote', 'set-url', 'origin', url], root);
    return;
  }
  try {
    await git(['fetch', '--progress', '--depth', '1', '--', auth, ...(ref ? [ref] : [])], root, onProgress);
    await git(['reset', '--hard', 'FETCH_HEAD'], root);
  } catch {
    /* offline is fine: analyse what is there */
  }
}

/** Branches and tags of a remote via `git ls-remote --symref` (15 s timeout). */
export async function remoteRefs(source: string): Promise<RemoteRefs> {
  if (!isGitUrl(source)) throw Object.assign(new Error('source is not a remote repository'), { statusCode: 400 });
  let stdout: string;
  try {
    ({ stdout } = await run('git', ['ls-remote', '--symref', authUrl(remoteUrl(source))], {
      timeout: 15_000,
      env: gitEnv(),
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    throw Object.assign(redacted(err), { statusCode: 502 });
  }
  return parseLsRemote(stdout);
}

export function parseLsRemote(text: string): RemoteRefs {
  let defaultBranch: string | undefined;
  const branches = new Set<string>();
  const tags = new Set<string>();
  for (const line of text.split('\n')) {
    const [left, name] = line.split('\t');
    if (!name) continue;
    if (left.startsWith('ref: ') && name === 'HEAD') defaultBranch = left.slice(5).replace(/^refs\/heads\//, '');
    else if (name.startsWith('refs/heads/')) branches.add(name.slice(11));
    else if (name.startsWith('refs/tags/')) tags.add(name.slice(10).replace(/\^\{\}$/, ''));
  }
  const cmp = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  return { defaultBranch, branches: [...branches].sort(cmp), tags: [...tags].sort(cmp).reverse() };
}
