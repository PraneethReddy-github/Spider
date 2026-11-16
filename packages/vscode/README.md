# Spider for VS Code

Hosts the Spider web app in a VS Code webview, against a local `spider serve`.

## Commands

- **Spider: Open map** — connects to the Spider server on `spider.host:spider.port` (default
  `127.0.0.1:4747`), starting `spider serve` when nothing answers (`spider.autoStart`), finds the
  analysed repository whose root is the workspace folder (analysing it first if needed) and opens the map.
- **Spider: Reveal in Spider** (command palette and editor context menu) — opens the map at the
  innermost symbol around the cursor (falls back to the file).
- **Open in editor** in the map (details header, context menu) opens the file at the symbol's line in
  VS Code, beside the map. Only files inside an open workspace folder are opened.

## Settings

| Setting | Default | |
|---|---|---|
| `spider.command` | `spider` | CLI to start the server: a command on `PATH`, or the path to `packages/cli/dist/index.js` (run with `node`) |
| `spider.host` | `127.0.0.1` | Server host |
| `spider.port` | `4747` | Server port |
| `spider.autoStart` | `true` | Start `spider serve` when no server answers; it stops with the extension |

## How it works

The webview contains one full-size iframe of the local server (URL passed through
`vscode.env.asExternalUri`, so remote/SSH/Codespaces sessions get a forwarded port). Its CSP allows
frames from that origin only and one nonce'd script. Embedded, the web app hands editor deep links to
its parent with `postMessage({ type: 'spider.openFile', path, line, col })`; the webview script relays
messages from the server's origin to the extension, which calls `vscode.window.showTextDocument`.
"Reveal" computes the file node id the way `@spider/core` does (`sha1("file <path>")`, base64url, 16
chars) and walks `GET /repos/:id/nodes/:nodeId` children by span.

## Build and try

```bash
pnpm --filter spider-vscode build      # tsc → dist/extension.js (CommonJS)
pnpm build:lib && pnpm --filter @spider/web build   # the CLI and web app the server serves
```

In VS Code, open `packages/vscode` and press F5 (Run Extension), or package it with
`npx @vscode/vsce package --no-dependencies`. Set `spider.command` to
`<repo>/packages/cli/dist/index.js` unless `spider` is on your `PATH`. Not published.
