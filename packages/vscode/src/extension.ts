import { randomBytes } from 'node:crypto';
import path from 'node:path';
import * as vscode from 'vscode';
import { type Settings, baseUrl, ensureServer, nodeAt, repoFor, settings, stopServer } from './server';

let panel: vscode.WebviewPanel | undefined;
let log: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('Spider');
  context.subscriptions.push(
    log,
    vscode.commands.registerCommand('spider.openMap', () => run(() => openMap())),
    vscode.commands.registerCommand('spider.reveal', () => run(() => reveal())),
  );
}

export function deactivate(): void {
  stopServer();
}

async function run(task: () => Promise<void>): Promise<void> {
  try {
    await task();
  } catch (err) {
    void vscode.window.showErrorMessage(`Spider: ${(err as Error).message}`);
  }
}

function workspaceFolder(uri?: vscode.Uri): vscode.WorkspaceFolder {
  const folder = (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder || folder.uri.scheme !== 'file') throw new Error('Open a local folder first.');
  return folder;
}

async function openMap(uri?: vscode.Uri, query = ''): Promise<void> {
  const s = settings();
  const folder = workspaceFolder(uri);
  await ensureServer(s, log);
  const repo = await repoFor(s, folder.uri.fsPath);
  await show(s, `/repo/${encodeURIComponent(repo.repoId)}${query}`);
}

/** Opens the map focused on the symbol (or file) under the cursor. */
async function reveal(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') throw new Error('Open a file to reveal it in Spider.');
  const s = settings();
  const folder = workspaceFolder(editor.document.uri);
  await ensureServer(s, log);
  const repo = await repoFor(s, folder.uri.fsPath);
  const rel = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).split(path.sep).join('/');
  const id = await nodeAt(s, repo.repoId, rel, editor.selection.active.line + 1);
  await show(s, `/repo/${encodeURIComponent(repo.repoId)}?level=L2&node=${encodeURIComponent(id)}`);
}

async function show(s: Settings, route: string): Promise<void> {
  // asExternalUri maps the local port when VS Code runs remotely (SSH, containers, Codespaces)
  const external = await vscode.env.asExternalUri(vscode.Uri.parse(baseUrl(s)));
  const origin = external.toString(true).replace(/\/$/, '');
  if (!panel) {
    panel = vscode.window.createWebviewPanel('spider.map', 'Spider', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.onDidDispose(() => {
      panel = undefined;
    });
    panel.webview.onDidReceiveMessage((m: unknown) => void openFile(m));
  }
  panel.webview.html = html(origin, `${origin}${route}`);
  panel.reveal();
}

/** `{type: 'spider.openFile', path, line, col}` from the web app → editor, only inside the workspace. */
async function openFile(m: unknown): Promise<void> {
  const msg = m as { type?: string; path?: unknown; line?: unknown; col?: unknown };
  if (msg?.type !== 'spider.openFile' || typeof msg.path !== 'string') return;
  const uri = vscode.Uri.file(msg.path);
  if (!vscode.workspace.getWorkspaceFolder(uri)) return;
  const pos = new vscode.Position(Math.max(0, Number(msg.line) - 1 || 0), Math.max(0, Number(msg.col) - 1 || 0));
  await vscode.window.showTextDocument(uri, {
    viewColumn: vscode.ViewColumn.Beside,
    selection: new vscode.Range(pos, pos),
  });
}

/** A full-size iframe of the local server; its postMessages are relayed to the extension. */
function html(origin: string, src: string): string {
  const nonce = randomBytes(16).toString('base64');
  const attr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${attr(origin)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden;background:#0A0A0B}</style>
</head><body>
<iframe src="${attr(src)}" title="Spider map" allow="clipboard-write"></iframe>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  window.addEventListener('message', (e) => {
    if (e.origin === ${JSON.stringify(origin)} && e.data && e.data.type === 'spider.openFile') vscode.postMessage(e.data);
  });
</script>
</body></html>`;
}
