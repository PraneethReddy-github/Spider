# Spider as an MCP server

`spider mcp [repo]` serves Spider's graph tools to any Model Context Protocol client over stdio
(newline-delimited JSON-RPC 2.0; protocol versions 2025-06-18, 2025-03-26, 2024-11-05). It is read-only, it
never calls a model, and it serves only repositories you have already analysed (`spider analyze <path|url>`).

Pass a repo id or name to pin one repository. Without one, every tool takes a `repo` argument; it is optional
when exactly one repository is analysed.

| Tool | What it returns |
|------|-----------------|
| `list_repos` | Analysed repositories: id, name, source, languages, frameworks, files, LOC |
| `search` | Nodes by name or qualified name (`query`, optional `kinds`, `limit`) |
| `node_detail` | One node: metrics, parents, relationships in and out, children, summary if one was generated |
| `upstream` / `downstream` | Dependents / dependencies with hop distance (`depth` 1–4, optional edge `kinds`) |
| `path` | Shortest dependency path between two nodes |
| `endpoints` | HTTP/RPC endpoints with handlers |
| `trace` | An endpoint's flow: middleware, handler, calls, down to datastores and externals |
| `subsystems` | Inferred architectural groups with member counts |
| `diagnostics` | Cycles, layer violations, dead code, god modules, orphans |
| `source` | Source of a node (≤ 200 lines, never outside the repository root) |

Every result carries node ids, so an agent can chain calls (`search` → `node_detail` → `upstream` …).

## Client configuration

Claude Code:

```bash
claude mcp add spider -- spider mcp
# or pinned to one repository
claude mcp add spider-api -- spider mcp my-service
```

Claude Desktop, Cursor and other clients that take a JSON server list:

```json
{
  "mcpServers": {
    "spider": { "command": "spider", "args": ["mcp"], "env": { "SPIDER_HOME": "/home/me/.spider" } }
  }
}
```

Without a global install, use `"command": "node", "args": ["/path/to/Spider/packages/cli/dist/index.js", "mcp"]`.
Logs go to stderr; stdout carries only protocol messages.
