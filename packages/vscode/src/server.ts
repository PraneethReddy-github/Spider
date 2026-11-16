import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

export interface Settings {
  command: string;
  host: string;
  port: number;
  autoStart: boolean;
}

export function settings(): Settings {
  const c = vscode.workspace.getConfiguration('spider');
  return {
    command: c.get('command', 'spider'),
    host: c.get('host', '127.0.0.1'),
    port: c.get('port', 4747),
    autoStart: c.get('autoStart', true),
  };
}

export const baseUrl = (s: Settings) => `http://${s.host}:${s.port}`;

async function api<T>(s: Settings, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${baseUrl(s)}/api/v1${path}`, {
    ...init,
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
  });
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

const healthy = (s: Settings) =>
  api<{ ok: boolean }>(s, '/health').then(
    (r) => r.ok,
    () => false,
  );

let child: ChildProcess | undefined;

/** Connects to a running `spider serve`, or starts one (killed with the extension). */
export async function ensureServer(s: Settings, log: vscode.OutputChannel): Promise<void> {
  if (await healthy(s)) return;
  if (!s.autoStart) throw new Error(`No Spider server on ${baseUrl(s)}. Run \`spider serve -p ${s.port}\`.`);
  if (!child || child.exitCode !== null) {
    const viaNode = /\.[cm]?js$/.test(s.command);
    const args = ['serve', '-p', String(s.port), '--host', s.host];
    log.appendLine(`Starting ${s.command} ${args.join(' ')}`);
    child = spawn(viaNode ? 'node' : s.command, viaNode ? [s.command, ...args] : args, {
      shell: process.platform === 'win32' && !viaNode,
    });
    child.stdout?.on('data', (b) => log.append(String(b)));
    child.stderr?.on('data', (b) => log.append(String(b)));
    child.on('error', (e) => log.appendLine(`Spider server failed to start: ${e.message}`));
  }
  for (let i = 0; i < 60; i++) {
    if (await healthy(s)) return;
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Spider server did not start on ${baseUrl(s)}. See the Spider output channel.`);
}

export function stopServer(): void {
  child?.kill();
  child = undefined;
}

interface RepoInfo {
  repoId: string;
  root: string;
}

const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** The analysed repo whose root is `folder`; analyses the folder first when it isn't registered. */
export async function repoFor(s: Settings, folder: string): Promise<RepoInfo> {
  const find = async () => (await api<RepoInfo[]>(s, '/repos')).find((r) => samePath(r.root, folder));
  const found = await find();
  if (found) return found;
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Spider: analysing workspace' },
    async (progress) => {
      const { jobId } = await api<{ jobId: string }>(s, '/repos', {
        method: 'POST',
        body: JSON.stringify({ source: folder }),
      });
      for (;;) {
        const job = await api<{ status: string; stage: string; error?: string; repoId?: string }>(s, `/jobs/${jobId}`);
        if (job.status === 'failed') throw new Error(`Analysis failed: ${job.error}`);
        if (job.status === 'done' && job.repoId) return { repoId: job.repoId, root: folder };
        progress.report({ message: job.stage });
        await new Promise((r) => setTimeout(r, 400));
      }
    },
  );
}

/** Same deterministic id as `ids.file` in @spider/core. */
export const fileNodeId = (relPath: string) =>
  createHash('sha1').update(`file ${relPath}`).digest('base64url').slice(0, 16);

interface Node {
  id: string;
  kind: string;
  span?: { startLine: number; endLine: number };
}

/** Innermost node of the file whose span holds `line` (descends into classes), else the file node. */
export async function nodeAt(s: Settings, repoId: string, relPath: string, line: number): Promise<string> {
  let id = fileNodeId(relPath);
  for (let depth = 0; depth < 4; depth++) {
    const d = await api<{ children: Node[] }>(s, `/repos/${repoId}/nodes/${encodeURIComponent(id)}`).catch(
      () => undefined,
    );
    if (!d) {
      if (depth === 0) throw new Error(`${relPath} is not in the Spider graph. Re-analyse the repository.`);
      break;
    }
    const hit = d.children.find((c) => c.span && c.span.startLine <= line && line <= c.span.endLine);
    if (!hit) break;
    id = hit.id;
  }
  return id;
}
