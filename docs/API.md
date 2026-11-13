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
| `GET /repos/:id/diagnostics` | `type=cycle|dead-code|god-module|orphan` | `Diagnostic[]` |
| `GET /repos/:id/subsystems` | — | `{ node, members }[]` |
| `GET /repos/:id/tree` | `node=repo`, `depth=1` | `(GraphNode & { childCount })[]` sorted dirs → files → symbols |
| `GET /repos/:id/export` | `format=json|dot|graphml` | full graph JSON `{ info, nodes, edges }`, Graphviz text (`text/vnd.graphviz`) or GraphML (`application/graphml+xml`) |

Edge kinds: `contains, imports, exports, calls, instantiates, extends, implements, references,
exposes, depends_on, reads, writes, configures, member_of, dep_aggregate`. Structural kinds
(`contains, member_of, exports`) are never returned by relationship queries.

`RepoInfo.stats` (`RepoStats`): `byNodeKind.endpoint` excludes endpoints in test files (counted in
`endpointsInTests`); `unresolvedCalls` counts calls whose head is a local or imported name that failed
to bind; `externalCalls` counts calls into libraries (head is an external import or an instance of one).

Planned (see `IMPLEMENTATION_PLAN.md`): `GET /repos/:id/matrix` (C-16), `PATCH /repos/:id/subsystems/:sid` (C-11), `POST /repos/:id/ask` (Phase 5).
