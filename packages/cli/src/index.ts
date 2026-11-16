#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import {
  QueryService,
  analyze,
  configuredProvider,
  diffMarkdown,
  diffRevisions,
  generateSummaries,
  listRepos,
  loadRepo,
  markdownReport,
  readOverrides,
  repoIdFor,
  serveMcpStdio,
  toDot,
  toGraphML,
} from '@spider/core';
import type { ProgressEvent } from '@spider/core';
import { startServer } from '@spider/server';
import { Command } from 'commander';
import pc from 'picocolors';

const program = new Command();
program
  .name('spider')
  .description('Intelligent codebase analysis and visualization')
  .version('0.1.0')
  .option('--home <dir>', 'data directory (default: $SPIDER_HOME or ~/.spider)');

/** Global `--home`, accepted before or after the subcommand. */
const home = () => program.opts<{ home?: string }>().home;
const num = (n: number) => n.toLocaleString('en-US');
const count = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;
const fmtStage = (stage: string) => pc.cyan(stage.padEnd(8));

/** Progress printer: one rewritten line on a TTY, plain lines (parse at 25% steps) otherwise. */
function progressPrinter() {
  const tty = process.stdout.isTTY;
  let pending = false;
  let lastQuarter = -1;
  return (e: ProgressEvent) => {
    const progress = e.total ? `${num(e.current).padStart(num(e.total).length)}/${num(e.total)} ` : '';
    const line = `${fmtStage(e.stage)} ${progress}${e.message ?? ''}`.trimEnd();
    const transient =
      (e.stage === 'parse' || e.stage === 'discover') && (e.total ? e.current < e.total : e.current > 0);
    if (tty && transient) {
      process.stdout.write(`\r${line.slice(0, 100).padEnd(100)}`);
      pending = true;
      return;
    }
    if (!tty && transient) {
      const quarter = e.total ? Math.floor((e.current / e.total) * 4) : -1;
      if (quarter <= lastQuarter) return;
      lastQuarter = quarter;
      console.log(`${fmtStage(e.stage)} ${progress}`.trimEnd());
      return;
    }
    if (pending) process.stdout.write(`\r${' '.repeat(100)}\r`);
    pending = false;
    console.log(line);
  };
}

program
  .command('analyze')
  .argument('<source>', 'local path, git URL, or owner/repo')
  .option('-r, --ref <ref>', 'git ref to analyse (URL sources only)')
  .option('-n, --name <name>', 'display name')
  .option('--json', 'print the RepoInfo as JSON')
  .description('Analyse a repository and store its graph')
  .action(async (source: string, opts: { ref?: string; name?: string; json?: boolean }) => {
    const info = await analyze({
      source,
      ref: opts.ref,
      name: opts.name,
      home: home(),
      onProgress: opts.json ? undefined : progressPrinter(),
    });
    if (opts.json) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    const s = info.stats;
    const testEps = s.endpointsInTests ? pc.dim(` (+${num(s.endpointsInTests)} in tests)`) : '';
    console.log();
    console.log(
      `${pc.green('✔')} ${pc.bold(info.name)} analysed in ${(info.durationMs / 1000).toFixed(1)}s  ${pc.dim(`repo id ${info.repoId}`)}`,
    );
    console.log(
      `  ${count(s.files, 'file')} · ${num(s.loc)} LOC · ${count(s.nodes, 'node')} · ${count(s.edges, 'edge')}  ${pc.dim(
        s.languages
          .slice(0, 4)
          .map((l) => `${l.language} ${num(l.files)}`)
          .join(', '),
      )}`,
    );
    if (s.frameworks.length) console.log(`  Frameworks: ${s.frameworks.join(', ')}`);
    console.log(
      `  ${count(s.byEdgeKind.imports ?? 0, 'import')} · ${count(s.byEdgeKind.calls ?? 0, 'call')} · ${count(s.byNodeKind.endpoint ?? 0, 'endpoint')}${testEps} · ${count(s.byNodeKind.subsystem ?? 0, 'subsystem')}`,
    );
    const unresolved = `  Unresolved: ${count(s.unresolvedImports, 'import')}, ${count(s.unresolvedCalls, 'call')} · ${count(s.externalCalls, 'library call')}`;
    console.log(s.unresolvedImports || s.unresolvedCalls ? pc.yellow(unresolved) : unresolved);
    console.log();
    console.log(`Run ${pc.cyan('spider open')} to explore the map.`);
  });

interface ServeOpts {
  port: string;
  host: string;
  watch?: boolean;
}

async function serve(opts: ServeOpts) {
  const { url } = await startServer({ port: Number(opts.port), host: opts.host, home: home(), watch: opts.watch });
  const repos = await listRepos(home());
  console.log(`${pc.bold('Spider')} is running at ${pc.cyan(url)}`);
  console.log(
    repos.length
      ? `  ${num(repos.length)} analysed ${repos.length === 1 ? 'repository' : 'repositories'}: ${repos.map((r) => r.name).join(', ')}`
      : `  No repositories yet. Run ${pc.cyan('spider analyze <path|url>')} or use the web app.`,
  );
  if (opts.watch) console.log('  Watching local repositories; changes are re-analysed automatically.');
  return url;
}

/** Opens a URL with the platform's own opener (no dependency). */
function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url]]
        : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(pc.yellow(`  Could not open a browser. Visit ${url}`)));
  child.unref();
}

program
  .command('serve')
  .option('-p, --port <port>', 'port', '4747')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .option('-w, --watch', 're-analyse local repositories when their files change')
  .description('Start the Spider server and web app')
  .action(async (opts: ServeOpts) => void (await serve(opts)));

program
  .command('open')
  .option('-p, --port <port>', 'port', '4747')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .option('-w, --watch', 're-analyse local repositories when their files change')
  .description('Start the Spider server and open the web app in a browser')
  .action(async (opts: ServeOpts) => openBrowser(await serve(opts)));

program
  .command('list')
  .description('List analysed repositories')
  .action(async () => {
    const repos = await listRepos(home());
    if (!repos.length) return console.log('No repositories yet.');
    const w = Math.max(...repos.map((r) => r.name.length));
    for (const r of repos)
      console.log(
        `${r.repoId}  ${r.name.padEnd(w)}  ${num(r.stats.nodes).padStart(8)} nodes  ${num(r.stats.edges).padStart(8)} edges  ${pc.dim(r.analysedAt)}`,
      );
  });

program
  .command('stats')
  .argument('<repo>', 'repo id, name or source path')
  .description('Show statistics for an analysed repository (JSON)')
  .action(async (repo: string) => {
    const info = await resolveRepo(repo);
    console.log(JSON.stringify(info.stats, null, 2));
  });

const EXPORT_FORMATS = ['json', 'dot', 'graphml'];

program
  .command('export')
  .argument('<repo>', 'repo id, name or source path')
  .option('-f, --format <format>', 'json | dot | graphml', 'json')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .description('Export the full graph')
  .action(async (repo: string, opts: { format: string; out?: string }) => {
    if (!EXPORT_FORMATS.includes(opts.format)) {
      console.error(pc.red(`✖ Unknown format ${opts.format}. Use ${EXPORT_FORMATS.join(', ')}.`));
      process.exit(1);
    }
    const info = await resolveRepo(repo);
    const { graph } = await loadRepo(info.repoId, home());
    const sg = graph.toSubGraph();
    const text =
      opts.format === 'dot'
        ? toDot(sg)
        : opts.format === 'graphml'
          ? toGraphML(sg)
          : JSON.stringify({ info, ...sg }, null, 2);
    if (!opts.out) return void process.stdout.write(`${text}\n`);
    await fs.writeFile(opts.out, `${text}\n`);
    console.log(
      `${pc.green('✔')} Wrote ${count(sg.nodes.length, 'node')} and ${count(sg.edges.length, 'edge')} to ${opts.out}`,
    );
  });

program
  .command('report')
  .argument('<repo>', 'repo id, name or source path')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .description('Write a Markdown architecture report')
  .action(async (repo: string, opts: { out?: string }) => {
    const info = await resolveRepo(repo);
    const { graph, meta } = await loadRepo(info.repoId, home());
    const md = markdownReport(new QueryService(graph, meta), info);
    if (!opts.out) return void process.stdout.write(md);
    await fs.writeFile(opts.out, md);
    console.log(`${pc.green('✔')} Wrote the architecture report of ${info.name} to ${opts.out}`);
  });

program
  .command('summarize')
  .argument('<repo>', 'repo id, name or source path')
  .option('-l, --limit <n>', 'hub files and classes to summarise (plus every package and subsystem)', '40')
  .option('-n, --node <ids...>', 'summarise only these node ids')
  .option('-f, --force', 'regenerate summaries whose input did not change')
  .description('Write model summaries of subsystems, packages and hubs (needs SPIDER_LLM_PROVIDER)')
  .action(async (repo: string, opts: { limit: string; node?: string[]; force?: boolean }) => {
    const provider = configuredProvider(home());
    if (!provider) {
      console.error(pc.red('No model provider configured.'), 'Set SPIDER_LLM_PROVIDER=anthropic|openai|ollama.');
      process.exitCode = 1;
      return;
    }
    const info = await resolveRepo(repo);
    const { graph } = await loadRepo(info.repoId, home());
    console.log(pc.dim(`Summarising ${info.name} with ${provider.name}/${provider.model}…`));
    const r = await generateSummaries({
      repoId: info.repoId,
      g: graph,
      root: info.root,
      provider,
      home: home(),
      nodeIds: opts.node,
      limit: Number(opts.limit),
      force: opts.force,
      onProgress: (done, total, n) => process.stderr.write(pc.dim(`  ${done}/${total} ${n.qname ?? n.name}\n`)),
    });
    console.log(`${pc.green('✔')} ${r.generated} written, ${r.reused} unchanged, ${r.failed.length} failed`);
    for (const f of r.failed) console.log(pc.red(`  ${graph.getNode(f.nodeId)?.qname ?? f.nodeId}: ${f.error}`));
    if (r.failed.length) process.exitCode = 1;
  });

program
  .command('mcp')
  .argument('[repo]', 'repo id or name every tool uses by default (otherwise tools take a `repo` argument)')
  .description('Serve the graph tools to an MCP client over stdio (read-only, no model calls)')
  .action(async (repo?: string) => {
    await serveMcpStdio({ home: home(), repo, version: program.version() });
  });

program
  .command('query')
  .argument('<repo>', 'repo id, name or source path')
  .argument('<kind>', 'search | upstream | downstream | path | endpoints | diagnostics | subsystems')
  .argument('[args...]')
  .option('-d, --depth <n>', 'traversal depth', '3')
  .description('Query the graph from the command line')
  .action(async (repo: string, kind: string, args: string[], opts: { depth: string }) => {
    const info = await resolveRepo(repo);
    const { graph, meta } = await loadRepo(info.repoId, home());
    const q = new QueryService(graph, meta);
    const label = (id: string) => {
      const n = graph.getNode(id);
      return n ? `${pc.dim(n.kind)} ${n.qname ?? n.name}` : id;
    };
    const findNode = (ref: string) => graph.getNode(ref) ?? q.search(ref, undefined, 1)[0]?.node;
    switch (kind) {
      case 'search':
        for (const h of q.search(args.join(' ')))
          console.log(`${String(h.score.toFixed(0)).padStart(4)}  ${h.node.id}  ${label(h.node.id)}`);
        break;
      case 'upstream':
      case 'downstream': {
        const n = findNode(args[0]);
        if (!n) return console.error(pc.red('✖ Node not found.'));
        const r = kind === 'upstream' ? q.upstream(n.id, Number(opts.depth)) : q.downstream(n.id, Number(opts.depth));
        console.log(pc.bold(`${kind} of ${label(n.id)} (depth ${opts.depth}): ${num(r.nodes.length - 1)} nodes`));
        for (const x of r.nodes.filter((x) => x.id !== n.id).sort((a, b) => r.distances[a.id] - r.distances[b.id]))
          console.log(`  ${r.distances[x.id]}  ${label(x.id)}`);
        break;
      }
      case 'path': {
        const a = findNode(args[0]);
        const b = findNode(args[1]);
        if (!a || !b) return console.error(pc.red('✖ Node not found.'));
        const p = q.path(a.id, b.id);
        if (!p.nodes.length) return console.log('No path.');
        p.nodes.forEach((x, i) => console.log(`${i ? `  ${pc.dim(`↓ ${p.edges[i - 1].kind}`)}\n` : ''}${label(x.id)}`));
        break;
      }
      case 'endpoints':
        for (const e of q.endpoints())
          console.log(
            `${e.node.name.padEnd(36)} → ${e.handler ? label(e.handler.id) : pc.dim('(unresolved)')}  ${pc.dim(`depth ${e.traceDepth}`)}`,
          );
        break;
      case 'diagnostics':
        for (const d of q.diagnostics(args[0]))
          console.log(`${pc.yellow(d.type.padEnd(11))} ${d.title}${d.detail ? pc.dim(`  ${d.detail}`) : ''}`);
        break;
      case 'subsystems':
        for (const s of q.subsystems()) console.log(`${s.node.name.padEnd(40)} ${num(s.members).padStart(6)} files`);
        break;
      default:
        console.error(pc.red(`✖ Unknown query kind ${kind}.`));
    }
  });

program
  .command('diff')
  .argument('[repo]', 'local path, or id/name of an analysed local repo', '.')
  .requiredOption('-b, --base <ref>', 'base revision, e.g. main')
  .option('--head <ref>', 'head revision (default: the working tree)')
  .option('-f, --format <format>', 'md | json', 'md')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .description('Diff the graph of two revisions (Markdown summary for a PR comment)')
  .action(async (repo: string, opts: { base: string; head?: string; format: string; out?: string }) => {
    if (opts.format !== 'md' && opts.format !== 'json') {
      console.error(pc.red(`✖ Unknown format ${opts.format}. Use md or json.`));
      process.exit(1);
    }
    const isDir = await fs
      .stat(repo)
      .then((s) => s.isDirectory())
      .catch(() => false);
    const info = isDir ? undefined : await resolveRepo(repo);
    const d = await diffRevisions({
      root: info?.root ?? repo,
      base: opts.base,
      head: opts.head,
      home: home(),
      overrides: info ? await readOverrides(info.repoId, home()) : undefined,
    }).catch((err: Error) => {
      console.error(pc.red(`✖ ${err.message}`));
      process.exit(1);
    });
    const text = opts.format === 'json' ? `${JSON.stringify(d, null, 2)}\n` : diffMarkdown(d);
    if (!opts.out) return void process.stdout.write(text);
    await fs.writeFile(opts.out, text);
    const s = d.summary;
    const stats = pc.dim(`  +${num(s.edgesAdded)} −${num(s.edgesRemoved)} edges, ${count(s.newCycles, 'new cycle')}`);
    console.log(`${pc.green('✔')} Wrote the diff ${opts.base} → ${opts.head ?? 'working tree'} to ${opts.out}${stats}`);
  });

async function resolveRepo(ref: string) {
  const repos = await listRepos(home());
  const found = repos.find((r) => r.repoId === ref || r.repoId === repoIdFor(ref) || r.name === ref);
  if (!found) {
    const known = repos.map((r) => `${r.repoId} (${r.name})`).join(', ') || 'none';
    console.error(pc.red(`✖ Repository ${ref} not found.`) + pc.dim(` Known: ${known}`));
    process.exit(1);
  }
  return found;
}

program.parseAsync().catch((err) => {
  console.error(pc.red(`✖ ${String(err?.stack ?? err)}`));
  process.exit(1);
});
