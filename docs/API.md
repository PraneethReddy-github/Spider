# Spider HTTP API (v1)

Base URL: `http://127.0.0.1:4747/api/v1`. All responses are JSON unless noted. Errors:
`{ "error": string }` with 400/403/404. Types referenced below are defined in
`packages/shared/src/index.ts`.

## Repositories & jobs

| Method & path | Body / query | Response |
|---|---|---|
| `GET /health` | — | `{ ok: true }` |
| `GET /repos` | — | `RepoInfo[]` (newest first) |
| `POST /repos` | `{ source: string, ref?: string, name?: string }` — local path, git URL, or `owner/repo` | `{ jobId }` |
| `GET /jobs/:jobId` | — | `JobProgress` (`status: queued|running|done|failed`, `stage`, `current`, `total`, `message`, `log[]`, `repoId` when done) |
| `GET /repos/:id` | — | `RepoInfo` |
| `DELETE /repos/:id` | — | `{ ok: true }` |
| `POST /repos/:id/reanalyze` | — | `{ jobId }` |

## Graph queries

| Method & path | Query | Response |
|---|---|---|
| `GET /repos/:id/graph` | `level=L0|L1|L2|L3`, `expanded=id,id`, `edgeKinds=`, `nodeKinds=`, `languages=`, `includeTests=true`, `minConfidence=0..1`, `minWeight=n` | `SubGraph` — projected nodes carry `props.childCount`, `props.viewParent`; edges are aggregated (`id = kind|src|dst`, `weight`, `props.leafCount`, `props.ambiguous`, `props.direct`); `meta: { truncated, level, total }` |
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
| `GET /repos/:id/export` | `format=json|dot` | full graph JSON `{ info, nodes, edges }` or Graphviz text |

Edge kinds: `contains, imports, exports, calls, instantiates, extends, implements, references,
exposes, depends_on, reads, writes, configures, member_of, dep_aggregate`. Structural kinds
(`contains, member_of, exports`) are never returned by relationship queries.

Planned (see `IMPLEMENTATION_PLAN.md`): `WS /jobs/:id/events` (S-1), zod validation (S-2),
`GET /repos/:id/matrix` (C-16), `PATCH /repos/:id/subsystems/:sid` (C-11), `POST /repos/:id/ask` (Phase 5).
