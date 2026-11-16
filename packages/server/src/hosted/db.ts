import pg from 'pg';

/**
 * Hosted mode (S-4) state in Postgres: users, orgs, memberships, tokens, the per-org repo registry and the job
 * queue. Graphs themselves stay in per-repo SQLite files under the shared `SPIDER_HOME`.
 */
export type Db = pg.Pool;

const SCHEMA = `
create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now()
);
create table if not exists orgs (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now()
);
create table if not exists memberships (
  org_id uuid not null references orgs on delete cascade,
  user_id uuid not null references users on delete cascade,
  role text not null check (role in ('owner', 'member')),
  primary key (org_id, user_id)
);
create table if not exists tokens (
  id uuid primary key default gen_random_uuid(),
  hash text not null unique,
  user_id uuid not null references users on delete cascade,
  name text not null,
  kind text not null check (kind in ('session', 'api')),
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  last_used_at timestamptz
);
create table if not exists repos (
  repo_id text primary key,
  org_id uuid not null references orgs on delete cascade,
  name text not null,
  source text not null,
  info jsonb,
  created_at timestamptz not null default now()
);
create index if not exists repos_org on repos (org_id);
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs on delete cascade,
  repo_id text not null,
  source text not null,
  ref text,
  name text,
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  stage text not null default 'ingest',
  current integer not null default 0,
  total integer not null default 0,
  message text,
  log jsonb not null default '[]',
  error text,
  created_by uuid references users on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  heartbeat timestamptz,
  finished_at timestamptz
);
create index if not exists jobs_queued on jobs (created_at) where status = 'queued';
`;

/** Opens a pool and applies the schema (idempotent; serialised across processes by an advisory lock). */
export async function openDb(url: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  const c = await pool.connect();
  try {
    await c.query('select pg_advisory_lock(4747)');
    await c.query(SCHEMA);
  } finally {
    await c.query('select pg_advisory_unlock(4747)').catch(() => {});
    c.release();
  }
  return pool;
}

export const JOBS_CHANNEL = 'spider_jobs';
export const REPO_CHANNEL = 'spider_repo_updated';
