# Hosted Spider

Spider runs single-user and local by default. Setting `SPIDER_DATABASE_URL` switches `spider serve` to hosted
mode: accounts, org workspaces, API tokens, read-only share links, and analyses queued in Postgres and run by one
or more `spider worker` processes. Local mode is unchanged when the variable is unset.

## Run it

```bash
SPIDER_SECRET=$(openssl rand -base64 32) docker compose up --build
```

Open http://localhost:4747. The first account owns a new workspace. Under **Settings → Invite to <workspace>…**
you can copy an invite link (valid 7 days). Whoever opens it creates an account in, or signs in to, that workspace.
Inside a repository, **Export → Copy read-only link** creates a 7-day link that opens that repository's map
without an account.

Without Docker: run Postgres, then

```bash
export SPIDER_DATABASE_URL=postgres://user:pass@host/spider SPIDER_SECRET=… SPIDER_HOME=/shared/spider
spider serve --host 0.0.0.0 &
spider worker            # as many as you like, on any host that mounts SPIDER_HOME
```

| Env | Meaning |
|-----|---------|
| `SPIDER_DATABASE_URL` | Postgres URL; turns hosted mode on. The schema is created on start. |
| `SPIDER_SECRET` | At least 32 random characters. Signs share links and invites; rotating it revokes all of them. |
| `SPIDER_SIGNUP` | `invite` (default): only the first account signs up freely, everyone else needs an invite. `open`: anyone can sign up and gets a workspace. |
| `SPIDER_HOME` | Graph store. It must be shared by the server and every worker (the compose file uses a volume). |
| `SPIDER_ALLOW_LOCAL_SOURCES` | `1` lets users analyse paths on the server. Never set it on a shared host. By default only git URLs and `owner/repo` are accepted. |
| `GITHUB_TOKEN`, `SPIDER_LLM_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | As in local mode, for private clones and model features. |

## How it fits together

- **Postgres** holds users (scrypt password hashes), orgs, memberships (`owner` or `member`), tokens (sessions
  for 30 days and API tokens, stored as SHA-256 hashes), the repository registry per org, and the job queue.
- **Workers** claim the oldest queued job with `FOR UPDATE SKIP LOCKED`, analyse it into `SPIDER_HOME`, report
  progress on the job row, and `NOTIFY` the servers, which drop their cached graph. A job whose worker stopped
  sending heartbeats for 2 minutes is claimed again.
- **Graphs** stay in per-repository SQLite files, written by the worker and read by the servers. Repository ids are
  scoped per org, so two orgs analysing the same repository get separate graphs. Keeping graphs in SQLite reuses every query, search and
  stored-view path; the cost is a volume shared by server and workers.

## Access rules

Every `/api/v1` route needs a principal except `/health`, `/hosted`, `/auth/signup` and `/auth/login`.

- **Session or API token** (`Authorization: Bearer spd_…`, or `?access_token=` for WebSockets and downloads):
  routes under `/repos/:id` need membership of the repository's org; deleting a repository needs `owner`.
- **Share link** (`x-spider-share` header or `?share=`): `GET` only, for that one repository (plus `/llm`).

| Route | Body | Notes |
|-------|------|-------|
| `GET /hosted` | — | `{ hosted, signup, firstUser }` (local mode: 404) |
| `POST /auth/signup` | `{ email, password (≥ 10), name?, orgName?, invite? }` | → `{ token, user, orgs }` |
| `POST /auth/login` | `{ email, password }` | → `{ token, user, orgs }` |
| `POST /auth/logout` | — | ends the session |
| `GET /me` | — | `{ user, orgs }` |
| `POST /auth/tokens` | `{ name }` | API token, shown once; `GET /auth/tokens`, `DELETE /auth/tokens/:id` |
| `POST /orgs` | `{ name }` | new org, caller owns it |
| `GET /orgs/:id/members` | — | members only |
| `POST /orgs/:id/invites` | `{ role?, days? (≤ 30) }` | owners only → `{ code, expiresAt }` |
| `POST /orgs/join` | `{ invite }` | signed-in user joins |
| `DELETE /orgs/:id/members/:userId` | — | owners only; the last owner stays |
| `POST /repos` | `{ source, ref?, name?, orgId? }` | queues an analysis in the org (default: the first) → `{ jobId }` |
| `POST /repos/:id/share` | `{ days? (≤ 90) }` | → `{ url, token, expiresAt }` |

`scripts/hosted-smoke.mjs <base-url> <source>` checks all of the above against a fresh server and worker.

Failed sign-ins are limited to 10 per email and address per 15 minutes (in memory, per server process).
Not built yet: GitHub OAuth, password reset, revoking a single share link, and per-org
quotas. Put the server behind TLS; tokens are bearer credentials.
