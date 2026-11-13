#!/usr/bin/env node
import { QueryService, analyze, listRepos, loadRepo, repoIdFor } from '@spider/core';
import { startServer } from '@spider/server';
import { Command } from 'commander';
import pc from 'picocolors';

const program = new Command();
program.name('spider').description('Intelligent codebase analysis and visualization').version('0.1.0');

function fmtStage(stage: string): string {
  return pc.cyan(stage.padEnd(8));
}

program
  .command('analyze')
  .argument('<source>', 'local path, git URL, or owner/repo')
  .option('-r, --ref <ref>', 'git ref to analyse (URL sources only)')
  .option('-n, --name <name>', 'display name')
  .option('--json', 'print the RepoInfo as JSON')
  .description('Analyse a repository and store its graph')
  .action(async (source: string, opts: { ref?: string; name?: string; json?: boolean }) => {
    let lastLine = '';
    const info = await analyze({
      source,
      ref: opts.ref,
      name: opts.name,
      onProgress: (e) => {
        if (opts.json) return;
        const line = `${fmtStage(e.stage)} ${e.total ? `${e.current}/${e.total} ` : ''}${e.message ?? ''}`;
        if (e.stage === 'parse' && e.current !== e.total) {
          process.stdout.write(`\r${line.slice(0, 100).padEnd(100)}`);
          lastLine = line;
        } else {
          if (lastLine) process.stdout.write('\n');
          lastLine = '';
          console.log(line);
        }
      },
    });
    if (opts.json) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }
    const s = info.stats;
    console.log();
    console.log(pc.bold(pc.green('✔')) + ` ${pc.bold(info.name)} analysed in ${(info.durationMs / 1000).toFixed(1)}s  ${pc.dim(`(repo id ${info.repoId})`)}`);
    console.log(`  ${s.files} files · ${s.loc.toLocaleString()} LOC · ${s.nodes.toLocaleString()} nodes · ${s.edges.toLocaleString()} edges`);
    console.log(`  languages: ${s.languages.slice(0, 6).map((l) => `${l.language} (${l.files})`).join(', ')}`);
    if (s.frameworks.length) console.log(`  frameworks: ${s.frameworks.join(', ')}`);
    console.log(`  imports: ${s.byEdgeKind.imports ?? 0} · calls: ${s.byEdgeKind.calls ?? 0} · endpoints: ${s.byNodeKind.endpoint ?? 0} · subsystems: ${s.byNodeKind.subsystem ?? 0}`);
    console.log(`  unresolved: ${s.unresolvedImports} imports, ${s.unresolvedCalls} calls`);
    console.log();
    console.log(`Run ${pc.cyan('spider serve')} and open the map.`);
  });

program
  .command('serve')
  .option('-p, --port <port>', 'port', '4747')
  .option('--host <host>', 'host to bind', '127.0.0.1')
  .description('Start the Spider server and web app')
  .action(async (opts: { port: string; host: string }) => {
    const { url } = await startServer({ port: Number(opts.port), host: opts.host });
    const repos = await listRepos();
    console.log(`${pc.bold('Spider')} is running at ${pc.cyan(url)}`);
    console.log(repos.length ? `  ${repos.length} analysed repo(s): ${repos.map((r) => r.name).join(', ')}` : `  No repos analysed yet — run ${pc.cyan('spider analyze <path|url>')} or use the UI.`);
  });

program
  .command('list')
  .description('List analysed repositories')
  .action(async () => {
    const repos = await listRepos();
    if (!repos.length) return console.log('No repos analysed yet.');
    for (const r of repos) console.log(`${pc.bold(r.repoId)}  ${r.name.padEnd(28)} ${String(r.stats.nodes).padStart(7)} nodes  ${String(r.stats.edges).padStart(7)} edges  ${pc.dim(r.analysedAt)}`);
  });

program
  .command('stats')
  .argument('<repo>', 'repo id or source path')
  .description('Show statistics for an analysed repository')
  .action(async (repo: string) => {
    const info = await resolveRepo(repo);
    console.log(JSON.stringify(info.stats, null, 2));
  });

program
  .command('query')
  .argument('<repo>', 'repo id or source path')
  .argument('<kind>', 'search | upstream | downstream | path | endpoints | diagnostics | subsystems')
  .argument('[args...]')
  .option('-d, --depth <n>', 'traversal depth', '3')
  .description('Query the graph from the command line')
  .action(async (repo: string, kind: string, args: string[], opts: { depth: string }) => {
    const info = await resolveRepo(repo);
    const { graph, meta } = await loadRepo(info.repoId);
    const q = new QueryService(graph, meta);
    const label = (id: string) => {
      const n = graph.getNode(id);
      return n ? `${pc.dim(n.kind)} ${n.qname ?? n.name}` : id;
    };
    const findNode = (ref: string) => graph.getNode(ref) ?? q.search(ref, undefined, 1)[0]?.node;
    switch (kind) {
      case 'search':
        for (const h of q.search(args.join(' '))) console.log(`${String(h.score.toFixed(0)).padStart(4)}  ${h.node.id}  ${label(h.node.id)}`);
        break;
      case 'upstream':
      case 'downstream': {
        const n = findNode(args[0]);
        if (!n) return console.error('node not found');
        const r = kind === 'upstream' ? q.upstream(n.id, Number(opts.depth)) : q.downstream(n.id, Number(opts.depth));
        console.log(pc.bold(`${kind} of ${label(n.id)} (depth ${opts.depth}): ${r.nodes.length - 1} nodes`));
        for (const x of r.nodes.filter((x) => x.id !== n.id).sort((a, b) => r.distances[a.id] - r.distances[b.id])) console.log(`  ${r.distances[x.id]}  ${label(x.id)}`);
        break;
      }
      case 'path': {
        const a = findNode(args[0]);
        const b = findNode(args[1]);
        if (!a || !b) return console.error('node not found');
        const p = q.path(a.id, b.id);
        if (!p.nodes.length) return console.log('no path');
        p.nodes.forEach((x, i) => console.log(`${i ? `  ${pc.dim('↓ ' + p.edges[i - 1].kind)}\n` : ''}${label(x.id)}`));
        break;
      }
      case 'endpoints':
        for (const e of q.endpoints()) console.log(`${e.node.name.padEnd(36)} → ${e.handler ? label(e.handler.id) : pc.dim('(unresolved)')}  ${pc.dim(`depth ${e.traceDepth}`)}`);
        break;
      case 'diagnostics':
        for (const d of q.diagnostics(args[0])) console.log(`${pc.yellow(d.type.padEnd(11))} ${d.title}${d.detail ? pc.dim(`  ${d.detail}`) : ''}`);
        break;
      case 'subsystems':
        for (const s of q.subsystems()) console.log(`${s.node.name.padEnd(40)} ${s.members} files`);
        break;
      default:
        console.error(`unknown query kind ${kind}`);
    }
  });

async function resolveRepo(ref: string) {
  const repos = await listRepos();
  const found = repos.find((r) => r.repoId === ref || r.repoId === repoIdFor(ref) || r.name === ref);
  if (!found) {
    console.error(`repo ${ref} not found. Known: ${repos.map((r) => `${r.repoId} (${r.name})`).join(', ') || 'none'}`);
    process.exit(1);
  }
  return found;
}

program.parseAsync().catch((err) => {
  console.error(pc.red(String(err?.stack ?? err)));
  process.exit(1);
});
