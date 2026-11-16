# Spider HTTP API (v1)

Base URL: `http://127.0.0.1:4747/api/v1`. All responses are JSON unless noted. Errors:
`{ "error": string }` with 400/403/404. Types referenced below are defined in
`packages/shared/src/index.ts`.

**Validation.** Query strings are validated with the zod schemas in `packages/shared/src/schemas.ts`
(`graphQuerySchema`, `traversalQuerySchema`, `searchQuerySchema`, … plus `parseQuery`). Invalid input
returns `400 { error }` naming each bad field, e.g. `focusDepth: Number must be less than or equal to 6`.
Limits: `level` ∈ `L0..L3`; `depth` 1–6; `focusDepth` 0–6; `limit` 1–100; `minConfidence` 0–1;
`edgeKinds`/`kinds` and `nodeKinds` must be known kinds; booleans are `true|false`.

## Repositories & jobs

| Method & path | Body / query | Response |
|---|---|---|
| `GET /health` | — | `{ ok: true }` |
| `GET /repos` | — | `RepoInfo[]` (newest first) |
| `POST /repos` | `{ source: string, ref?: string, name?: string }` — local path, git URL, or `owner/repo` | `{ jobId }` |
| `GET /jobs/:jobId` | — | `JobProgress` (`status: queued|running|done|failed`, `stage`, `current`, `total`, `message`, `log[]`, `repoId` when done) |
| `WS /jobs/:jobId/events` | — | Stream of `JobProgress` JSON messages: the current state on connect, then one per progress update, and a final one when `status` is `done` or `failed`; the server then closes (code 1000). Unknown job: one `{ error }` message, close code 4404. Polling `GET /jobs/:jobId` remains available. |
| `GET /repos/:id` | — | `RepoInfo` |
| `DELETE /repos/:id` | — | `{ ok: true }` |
| `POST /repos/:id/reanalyze` | — | `{ jobId }` |
| `GET /remote/refs` | `source=<owner/repo\|git URL>` (required) | `RemoteRefs` `{ defaultBranch?, branches: string[], tags: string[] }` via `git ls-remote --symref` (15 s timeout; tags newest first by numeric sort). Local paths → 400; unreachable/unknown remote → 502 `{ error }` |

**Remote sources.** `POST /repos` accepts `owner/repo` (GitHub) or a git URL plus an optional `ref`
(branch or tag). Clones are shallow, under `SPIDER_HOME/clones/<hash>`; re-analysis fetches `ref` (or the
default branch) into the existing clone. Private GitHub repos: set `GITHUB_TOKEN` in the server's (or
CLI's) environment; it is injected into `https://github.com/…` URLs only for the git command, never
stored in the clone's remote, and redacted (`***`) from errors and logs. Git never prompts for
credentials (`GIT_TERMINAL_PROMPT=0`). Clone/fetch progress (`git --progress`) is streamed as `[ingest]`
lines into `JobProgress.log` and `message`, one per stage and 10 % step (e.g. `receiving objects 40% (410/1024)`).

## Graph queries

| Method & path | Query | Response |
|---|---|---|
| `GET /repos/:id/graph` | `level=L0|L1|L2|L3` (default L1), `expanded=id,id`, `edgeKinds=`, `nodeKinds=`, `languages=`, `includeTests=true`, `minConfidence=0..1`, `minWeight=n`, `focus=<nodeId>`, `focusDepth=0..6` (default 1) | `Projection` — projected nodes carry `props.childCount`, `props.viewParent`; edges are aggregated (`id = kind|src|dst`, `weight`, `props.leafCount`, `props.ambiguous`, `props.direct`); `meta: ProjectionMeta { level, total, truncated, truncatedReason?, focus?, stats: { nodes, edges, byKind } }`. With `focus`, only nodes within `focusDepth` undirected hops of the focus node's visible representative (`meta.focus`) over the projected edges are kept, plus the view-parent groups containing them; unknown `focus` → 404. Over 6 000 nodes the result is cut and `meta.truncatedReason` says so. |
| `GET /repos/:id/nodes/:nodeId` | — | `NodeDetail` `{ node, parents (nearest first), incoming[{edge,node}], outgoing[{edge,node}], children }` |
| `GET /repos/:id/nodes/:nodeId/source` | `context=5` | `{ path, language, startLine, endLine, highlight: [s, e], lines: string[], totalLines }` |
| `GET /repos/:id/search` | `q=`, `kinds=`, `limit=25` | `SearchHit[]` `{ node, score }` |
| `GET /repos/:id/upstream/:nodeId` | `depth=3`, `kinds=` | `SubGraph & { distances: Record<id, number> }` (root = 0) |
| `GET /repos/:id/downstream/:nodeId` | `depth=3`, `kinds=` | same |
| `GET /repos/:id/neighbors/:nodeId` | `depth=1`, `kinds=` | same (both directions) |
| `GET /repos/:id/path` | `from=`, `to=`, `kinds=` | `SubGraph` with nodes/edges ordered along the path; empty + `meta.found=false` if none |
| `GET /repos/:id/endpoints` | `includeTests=true` | `EndpointSummary[]` `{ node, handler?, traceDepth }` sorted by path |
| `GET /repos/:id/trace/:endpointId` | `depth=6` | `SubGraph & { distances }` following `exposes → calls/instantiates` |
| `GET /repos/:id/diagnostics` | `type=cycle|dead-code|god-module|orphan|layer-violation` | `Diagnostic[]` |
| `GET /repos/:id/subsystems` | — | `{ node, members }[]` |
| `GET /repos/:id/tree` | `node=repo`, `depth=1` | `(GraphNode & { childCount })[]` sorted dirs → files → symbols |
| `GET /repos/:id/nodes/:nodeId/history` | — | `NodeHistory` `{ commits, authors: { name, commits }[], lastModified? }` — whole git history of the node's file (directories: their path); author names only, never emails; nodes without a file and non-git repos → `{ commits: 0, authors: [] }`; unknown node → 404 |
| `GET /repos/:id/overrides` | — | `SubsystemOverrides` `{ rename: Record<subsystemId, label>, merge: subsystemId[][], pins: Record<filePath, subsystemId> }` (empty defaults) |
| `PUT /repos/:id/overrides` | body `SubsystemOverrides` (missing fields default to empty; unknown keys → 400; each merge group needs ≥ 2 ids) | `{ ok: true }`. Saved to `SPIDER_HOME/repos/<id>/overrides.json` and applied to the stored graph at once (no re-parse): merge groups fold into their first id, pins move files, rename relabels. Unknown ids/paths are ignored. Overrides survive re-analysis; `WS /repos/:id/events` sends `updated`. Unknown repo → 404 |
| `GET /repos/:id/matrix` | `level=L1|L2` (default L1), `expanded=id,id`, `includeTests=true` | `MatrixResult` `{ nodes, cells: { i, j, weight, kinds }[], layers }` — dependency structure matrix over the same roll-up as `/graph` (expanded groups, externals, packages and non-source files left out). Row `i` = source, column `j` = target, `kinds` = weight per edge kind. Nodes are ordered by inferred layer (`layers[k]`; 0 = depends on nothing in the matrix, cycles share a layer) then name, so dependencies sit below the diagonal and cells with `j > i` are upward or cyclic |
| `GET /repos/:id/externals` | — | `ExternalUsage[]` `{ node, total, users: { node, weight }[] }` — externals with the non-test files that import/call/extend/reference them, by `total` desc |
| `GET /repos/:id/report` | `format=md` (default) | `text/markdown` "Architecture of <name>": overview, languages/frameworks, subsystems (key files, dependencies), layering of subsystems, endpoints table, hubs by PageRank and betweenness, diagnostics summary. Same as `spider report <repo> [-o file]` |
| `GET /repos/:id/diff` | `base=<ref>` (required), `head=<ref>` (default: the working tree on disk) | `GraphDiff` `{ base, head, nodes: { added, removed, changed }, edges: { added, removed }, diagnostics: { newCycles, resolvedCycles, newViolations, resolvedViolations }, summary, ancestors }` — see *Graph diff* below. Local git repos only (repo root must be a work tree root) → else 400; unknown or option-like ref → 400; unknown repo → 404 |
| `GET /repos/:id/refs` | — | `RemoteRefs` `{ defaultBranch (checked-out branch), branches, tags }` of a local git repo (400 otherwise) |
| `GET /repos/:id/export` | `format=json|dot|graphml` | full graph JSON `{ info, nodes, edges }`, Graphviz text (`text/vnd.graphviz`) or GraphML (`application/graphml+xml`) |

Edge kinds: `contains, imports, exports, calls, instantiates, extends, implements, references,
exposes, depends_on, reads, writes, configures, member_of, dep_aggregate`. Structural kinds
(`contains, member_of, exports`) are never returned by relationship queries.

`RepoInfo.stats` (`RepoStats`): `byNodeKind.endpoint` excludes endpoints in test files (counted in
`endpointsInTests`); `unresolvedCalls` counts calls whose head is a local or imported name that failed
to bind; `externalCalls` counts calls into libraries (head is an external import or an instance of one).

**Metrics** on nodes (`GraphNode.metrics`): `fanIn`, `fanOut`, `pagerank` (files), `betweenness` (non-test
files: sampled Brandes over ≤ 256 fixed pivots on the file dependency graph, normalised to 0..1), `churn`
(files: commits touching the file in the last 6 months; 0 outside git or in shallow clones beyond depth).

**Subsystems** are inferred on production files: workspace packages and `examples`/`docs`/`scripts`/
`benchmarks` directories seed their own subsystems; the rest are Louvain communities (seeded RNG, so runs
are identical) constrained by directories; test files join the subsystem they depend on most. Labels are
directory paths (`(root)` for root files); a repeated label becomes `dir (most-central-file)`. Subsystem
ids are kept stable across runs by member overlap (Jaccard ≥ 0.5) with the previous run. Subsystems made
only of tests carry `props.isTest` (hidden unless `includeTests`).

**Layer violations** (`type: 'layer-violation'`): directory A depends on sibling directory B ≥ 3× as much
(weight, over ≥ 2 file pairs) as B depends on A → each B → A dependency is reported as upward. Nested
directories are never compared.

Planned (see `IMPLEMENTATION_PLAN.md`): `POST /repos/:id/ask` (Phase 5).

## Repo events & watch mode

| Method & path | Body / query | Response |
|---|---|---|
| `WS /repos/:id/events` | — | Stays open. Sends `RepoEvent` JSON `{ type: 'updated', repoId, analysedAt }` each time a (re-)analysis of the repo finishes — from `POST /repos`, `POST /repos/:id/reanalyze` or the watcher. Clients should refetch the repo's queries (keying caches on `analysedAt` is enough). Nothing is sent on connect. |

`spider serve --watch` (`ServerOptions.watch`) watches every registered **local** repo (cloned URL
sources are never watched) plus local repos analysed later through `POST /repos`. File changes are
debounced (300 ms); a change during a running analysis queues exactly one follow-up run. Only
directories that hold discovered files are watched, so `.gitignore`d trees (e.g. `node_modules`)
cost nothing; editor swap files are ignored. Re-analysis reuses cached per-file facts, so only
changed files are re-parsed: the job's `[parse]` log line reads `N reused, M re-extracted`.

Analyses started by the server run on a worker thread (parse+extract on a further pool of up to 4
threads), so the API stays responsive while analysing (fastify: `GET /health` max 9 ms).

## Graph diff

`GET /repos/:id/diff?base=main` and `spider diff [repo|path] --base main [--head HEAD] [--format md|json] [-o file]`
(exit code 0 whatever the diff contains; 1 on errors).

- **How**: the base revision (and `head`, when given) is written to `SPIDER_HOME/tmp/diff-<uuid>` with
  `git archive <sha> | tar -x` — only the object database is read, the user's working tree, index and
  refs are never touched, and the temporary tree is always deleted. Both sides run discover → extract →
  resolve → enrich in memory (nothing is persisted) and reuse the per-file extraction cache, so only files
  that differ are parsed. Without `head` the working tree is analysed as it is on disk (uncommitted and
  untracked-but-not-ignored files included). The base run's subsystems seed the head run, so unchanged
  subsystems keep their ids; the repo's subsystem overrides apply to both sides.
- **Matching** is by deterministic id. `edges` lists relationship edges only (`contains`, `exports`,
  `member_of` follow from node changes). `changed` nodes record `{ field: [base, head] }` for name, parent,
  span *length* (a span that only moved is not a change), `metrics.loc|complexity|fanIn|fanOut` and props;
  PageRank, betweenness and churn are not diffed (they move with unrelated changes, churn needs git).
  Endpoint ids include their line, so a moved route shows as removed + added.
- **Diagnostics**: cycles and layer violations are keyed by type + node ids.
- **`ancestors`**: id → containment chain (parent first, up to `repo`) for every id referenced, so a
  client can place changes on a rolled-up projection (the web app's Compare overlay does).
- **Synchronous** with a 120 s limit (→ 504; the work still finishes and cleans up). A cached diff of
  this repo (~1 500 nodes) answers in 0.3 s; a cold one takes ~4 s. Resolve/enrich run on the server's event
  loop, so other requests wait while a large diff resolves.

The Markdown summary (`--format md`, the default) is sized for a PR comment: counts table, new/resolved
cycles and layer violations, then the first 25 added/removed symbols and new/dropped dependencies.
`docs/examples/spider-diff.yml` is an example GitHub workflow that posts it with `gh pr comment`.

## Semantic layer (Phase 5)

Model-backed features are **opt-in**. Nothing is sent to a model unless a provider is configured, by env or by
`SPIDER_HOME/config.json` (`{ "llm": { "provider", "model", "baseUrl" } }`; env wins). API keys are never read from
the file.

| Env | Meaning |
|-----|---------|
| `SPIDER_LLM_PROVIDER` | `anthropic` (Claude, default model `claude-opus-5-5`), `openai` (any OpenAI-compatible `/chat/completions`, default base `https://api.openai.com/v1`), `ollama` (base `http://127.0.0.1:11434/v1`), `none` |
| `SPIDER_LLM_MODEL` | model id (required for `openai`/`ollama`) |
| `SPIDER_LLM_BASE_URL` | endpoint override |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | credentials (Anthropic also accepts `ANTHROPIC_AUTH_TOKEN` or an `ant auth login` profile) |

| Route | Body / query | Response |
|-------|--------------|----------|
| `GET /llm` | — | `LlmStatus` `{ provider: 'anthropic'\|'openai'\|'ollama'\|null, model? }` |
| `GET /repos/:id/summaries` | — | `Record<nodeId, NodeSummary>` `{ nodeId, text, hash, model, generatedAt }` (empty when none) |
| `POST /repos/:id/summaries` | `{ nodeIds?: string[], limit?: number, force?: boolean }` | `{ generated, reused, failed: {nodeId, error}[], summaries }`. Default targets: every subsystem and package plus `limit` (40) hub files (PageRank) and classes (fan-in), tests excluded. Leaves first, then groups, whose prompt lists their members' summaries. A summary is reused while the hash of its input (prompt version, model, source excerpt, neighbours) is unchanged; `force` regenerates. 409 when no provider is configured. Runs synchronously. |

CLI: `spider summarize <repo> [--limit 40] [--node <ids...>] [--force]`. Summaries live in
`SPIDER_HOME/repos/<id>/summaries.json`.
