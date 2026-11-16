import { createHash } from 'node:crypto';
import path from 'node:path';
import { isGitUrl } from '@spider/core';
import type { JobProgress, RepoInfo } from '@spider/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pg from 'pg';
import {
  type Principal,
  type UserPrincipal,
  hashPassword,
  newToken,
  principalFor,
  sign,
  userFromToken,
  verify,
  verifyPassword,
} from './auth.js';
import { type Db, JOBS_CHANNEL, REPO_CHANNEL } from './db.js';

/**
 * Hosted mode (S-4): accounts, org workspaces, API tokens, signed read-only share links, and a Postgres job
 * queue drained by `spider worker`. Every `/api/v1` route except health, hosted status and login/signup needs a
 * principal; repo routes need membership of the repo's org (or a share link for that repo, GET only).
 */

export interface HostedOptions {
  db: Db;
  databaseUrl: string;
  /** HMAC key for share links and invites. */
  secret: string;
  /** `open`: anyone can sign up (and gets an org). `invite` (default): the first user, then invite codes only. */
  signup: 'open' | 'invite';
  /** Let users analyse server paths (never on a multi-tenant host). */
  allowLocalSources: boolean;
}

export interface Hosted {
  listRepos(req: FastifyRequest): Promise<RepoInfo[]>;
  enqueue(
    req: FastifyRequest,
    body: { source: string; ref?: string; name?: string; orgId?: string },
  ): Promise<{ jobId: string }>;
  job(req: FastifyRequest, id: string): Promise<JobProgress | undefined>;
  reanalyze(req: FastifyRequest, repoId: string): Promise<{ jobId: string }>;
  removeRepo(repoId: string): Promise<void>;
  /** Called with a repo id when a worker finished (re-)analysing it. */
  onRepoUpdated(fn: (repoId: string) => void): void;
  close(): Promise<void>;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

const SESSION_DAYS = 30;
const PUBLIC = new Set(['/api/v1/health', '/api/v1/hosted', '/api/v1/auth/signup', '/api/v1/auth/login']);
const SHAREABLE_GLOBAL = new Set(['/api/v1/llm']);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const user = (req: FastifyRequest): UserPrincipal => {
  if (req.principal?.type !== 'user') throw new HttpError(401, 'sign in required');
  return req.principal;
};

/** `owner/repo` and git URLs only: a hosted user must never make the server read its own disk. */
function checkSource(source: string, allowLocal: boolean): void {
  if (allowLocal || isGitUrl(source) || /^[\w.-]+\/[\w.-]+$/.test(source)) return;
  throw new HttpError(400, 'hosted Spider analyses git URLs or owner/repo only');
}

export async function registerHosted(app: FastifyInstance, o: HostedOptions): Promise<Hosted> {
  const { db } = o;
  const listeners: ((repoId: string) => void)[] = [];
  const listener = new pg.Client({ connectionString: o.databaseUrl });
  await listener.connect();
  await listener.query(`listen ${REPO_CHANNEL}`);
  listener.on('notification', (n) => {
    if (n.channel === REPO_CHANNEL && n.payload) for (const fn of listeners) fn(n.payload);
  });

  const repoOrg = async (repoId: string): Promise<string | undefined> =>
    (await db.query('select org_id from repos where repo_id = $1', [repoId])).rows[0]?.org_id;

  /* ---------- who is calling, and may they ---------- */
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return; // the web app itself
    const q = req.query as Record<string, string | undefined>;
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? q.access_token;
    if (bearer) req.principal = await userFromToken(db, bearer);
    const share = (req.headers['x-spider-share'] as string | undefined) ?? q.share;
    if (!req.principal && share) {
      const p = verify<{ repoId: string; exp: number }>(o.secret, share, 'share');
      if (p) req.principal = { type: 'share', repoId: p.repoId };
    }
    if (PUBLIC.has(url)) return;
    const p = req.principal;
    if (!p) return reply.code(401).send({ error: 'sign in required' });

    const repoId = url.match(/^\/api\/v1\/repos\/([^/]+)/)?.[1];
    if (p.type === 'share') {
      const ok = req.method === 'GET' && ((repoId && repoId === p.repoId) || SHAREABLE_GLOBAL.has(url));
      if (!ok) return reply.code(403).send({ error: 'this share link is read-only and limited to one repository' });
      return;
    }
    if (repoId) {
      const org = await repoOrg(decodeURIComponent(repoId));
      const role = p.orgs.find((x) => x.id === org)?.role;
      if (!role) return reply.code(404).send({ error: 'repo not found' });
      if (req.method === 'DELETE' && role !== 'owner')
        return reply.code(403).send({ error: 'only org owners delete repositories' });
    }
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: err.message });
    reply.log.error(err);
    return reply.code(500).send({ error: 'internal error' });
  });

  /* ---------- accounts ---------- */
  const session = async (userId: string, reply: FastifyReply) => {
    const t = newToken();
    const r = await db.query(
      `insert into tokens (hash, user_id, name, kind, expires_at)
       values ($1, $2, 'session', 'session', now() + interval '${SESSION_DAYS} days') returning id`,
      [t.hash, userId],
    );
    const p = await principalFor(db, userId, r.rows[0].id);
    return reply.send({ token: t.token, user: p?.user, orgs: p?.orgs });
  };

  app.get('/api/v1/hosted', async () => {
    const users = Number((await db.query('select count(*) from users')).rows[0].count);
    return { hosted: true, signup: o.signup, firstUser: users === 0 };
  });

  app.post<{ Body: { email?: string; password?: string; name?: string; invite?: string; orgName?: string } }>(
    '/api/v1/auth/signup',
    async (req, reply) => {
      const { email = '', password = '', name, invite, orgName } = req.body ?? {};
      if (!EMAIL.test(email)) throw new HttpError(400, 'a valid email is required');
      if (password.length < 10) throw new HttpError(400, 'passwords need at least 10 characters');
      const inv = invite
        ? verify<{ orgId: string; role: 'owner' | 'member'; exp: number }>(o.secret, invite, 'invite')
        : undefined;
      if (invite && !inv) throw new HttpError(400, 'this invite is invalid or has expired');
      const c = await db.connect();
      try {
        await c.query('begin');
        await c.query('lock table users in share row exclusive mode');
        const first = Number((await c.query('select count(*) from users')).rows[0].count) === 0;
        if (!inv && !first && o.signup !== 'open')
          throw new HttpError(403, 'sign-up needs an invite from an org owner');
        const exists = await c.query('select 1 from users where lower(email) = lower($1)', [email]);
        if (exists.rowCount) throw new HttpError(409, 'an account with this email exists; sign in instead');
        const u = await c.query('insert into users (email, name, password_hash) values ($1, $2, $3) returning id', [
          email.toLowerCase(),
          name?.trim() || email.split('@')[0],
          await hashPassword(password),
        ]);
        const userId = u.rows[0].id as string;
        if (inv) {
          await c.query('insert into memberships (org_id, user_id, role) values ($1, $2, $3)', [
            inv.orgId,
            userId,
            inv.role,
          ]);
        } else {
          const org = await c.query('insert into orgs (name) values ($1) returning id', [
            orgName?.trim() || `${name?.trim() || email.split('@')[0]}'s workspace`,
          ]);
          await c.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [
            org.rows[0].id,
            userId,
          ]);
        }
        await c.query('commit');
        return session(userId, reply);
      } catch (err) {
        await c.query('rollback');
        throw err;
      } finally {
        c.release();
      }
    },
  );

  // shortcut: in-memory, per server process; use a shared store if several servers sit behind one balancer
  const failures = new Map<string, { n: number; until: number }>();
  const FAIL_MAX = 10;
  const FAIL_WINDOW = 15 * 60_000;

  app.post<{ Body: { email?: string; password?: string } }>('/api/v1/auth/login', async (req, reply) => {
    const { email = '', password = '' } = req.body ?? {};
    const key = `${req.ip}\0${email.toLowerCase()}`;
    const f = failures.get(key);
    if (f && f.until > Date.now() && f.n >= FAIL_MAX)
      throw new HttpError(429, 'too many failed sign-ins; try again in 15 minutes');
    const r = await db.query('select id, password_hash from users where lower(email) = lower($1)', [email]);
    // same answer and similar work whether or not the account exists
    const ok = await verifyPassword(password, r.rows[0]?.password_hash ?? 'scrypt$00$00');
    if (!r.rowCount || !ok) {
      const cur = f && f.until > Date.now() ? f : { n: 0, until: Date.now() + FAIL_WINDOW };
      failures.set(key, { n: cur.n + 1, until: cur.until });
      if (failures.size > 10_000) for (const [k, v] of failures) if (v.until < Date.now()) failures.delete(k);
      throw new HttpError(401, 'wrong email or password');
    }
    failures.delete(key);
    return session(r.rows[0].id, reply);
  });

  app.post('/api/v1/auth/logout', async (req) => {
    await db.query('delete from tokens where id = $1', [user(req).tokenId]);
    return { ok: true };
  });

  app.get('/api/v1/me', async (req) => {
    const p = req.principal;
    if (p?.type === 'share') return { share: { repoId: p.repoId } };
    const u = user(req);
    return { user: u.user, orgs: u.orgs };
  });

  /** API tokens for the CLI, CI and MCP clients. Shown once. */
  app.post<{ Body: { name?: string } }>('/api/v1/auth/tokens', async (req) => {
    const u = user(req);
    const t = newToken();
    const r = await db.query(
      `insert into tokens (hash, user_id, name, kind) values ($1, $2, $3, 'api') returning id, name, created_at`,
      [t.hash, u.user.id, req.body?.name?.trim() || 'API token'],
    );
    return { ...r.rows[0], token: t.token };
  });
  app.get('/api/v1/auth/tokens', async (req) => {
    const r = await db.query(
      `select id, name, created_at, last_used_at from tokens where user_id = $1 and kind = 'api' order by created_at`,
      [user(req).user.id],
    );
    return r.rows;
  });
  app.delete<{ Params: { id: string } }>('/api/v1/auth/tokens/:id', async (req) => {
    await db.query('delete from tokens where id = $1 and user_id = $2', [req.params.id, user(req).user.id]);
    return { ok: true };
  });

  /* ---------- orgs ---------- */
  const role = (req: FastifyRequest, orgId: string) => user(req).orgs.find((x) => x.id === orgId)?.role;
  const owner = (req: FastifyRequest, orgId: string) => {
    if (role(req, orgId) !== 'owner') throw new HttpError(403, 'only org owners can do this');
  };

  app.post<{ Body: { name?: string } }>('/api/v1/orgs', async (req) => {
    const u = user(req);
    const name = req.body?.name?.trim();
    if (!name) throw new HttpError(400, 'name is required');
    const r = await db.query('insert into orgs (name) values ($1) returning id, name', [name]);
    await db.query(`insert into memberships (org_id, user_id, role) values ($1, $2, 'owner')`, [
      r.rows[0].id,
      u.user.id,
    ]);
    return { ...r.rows[0], role: 'owner' };
  });

  app.get<{ Params: { id: string } }>('/api/v1/orgs/:id/members', async (req) => {
    if (!role(req, req.params.id)) throw new HttpError(404, 'org not found');
    const r = await db.query(
      `select u.id, u.email, u.name, m.role from memberships m join users u on u.id = m.user_id
        where m.org_id = $1 order by u.email`,
      [req.params.id],
    );
    return r.rows;
  });

  app.post<{ Params: { id: string }; Body: { role?: 'owner' | 'member'; days?: number } }>(
    '/api/v1/orgs/:id/invites',
    async (req) => {
      owner(req, req.params.id);
      const days = Math.min(Math.max(1, Number(req.body?.days ?? 7)), 30);
      const exp = Date.now() + days * 86_400_000;
      const r = req.body?.role === 'owner' ? 'owner' : 'member';
      return {
        code: sign(o.secret, { kind: 'invite', orgId: req.params.id, role: r, exp }),
        expiresAt: new Date(exp).toISOString(),
      };
    },
  );

  app.post<{ Body: { invite?: string } }>('/api/v1/orgs/join', async (req) => {
    const u = user(req);
    const inv = verify<{ orgId: string; role: 'owner' | 'member'; exp: number }>(
      o.secret,
      req.body?.invite ?? '',
      'invite',
    );
    if (!inv) throw new HttpError(400, 'this invite is invalid or has expired');
    await db.query(
      'insert into memberships (org_id, user_id, role) values ($1, $2, $3) on conflict (org_id, user_id) do nothing',
      [inv.orgId, u.user.id, inv.role],
    );
    return { ok: true, orgId: inv.orgId };
  });

  app.delete<{ Params: { id: string; userId: string } }>('/api/v1/orgs/:id/members/:userId', async (req) => {
    owner(req, req.params.id);
    const owners = await db.query(`select user_id from memberships where org_id = $1 and role = 'owner'`, [
      req.params.id,
    ]);
    if (owners.rowCount === 1 && owners.rows[0].user_id === req.params.userId)
      throw new HttpError(400, 'an org needs at least one owner');
    await db.query('delete from memberships where org_id = $1 and user_id = $2', [req.params.id, req.params.userId]);
    return { ok: true };
  });

  /* ---------- share links ---------- */
  app.post<{ Params: { id: string }; Body: { days?: number } }>('/api/v1/repos/:id/share', async (req) => {
    user(req); // membership checked by the hook; share principals cannot mint links
    const days = Math.min(Math.max(1, Number(req.body?.days ?? 7)), 90);
    const exp = Date.now() + days * 86_400_000;
    const token = sign(o.secret, { kind: 'share', repoId: req.params.id, exp });
    return {
      token,
      url: `/repo/${encodeURIComponent(req.params.id)}?share=${token}`,
      expiresAt: new Date(exp).toISOString(),
    };
  });

  const api: Hosted = {
    async listRepos(req) {
      const p = req.principal;
      if (p?.type === 'share') {
        const r = await db.query('select info from repos where repo_id = $1 and info is not null', [p.repoId]);
        return r.rows.map((x) => x.info);
      }
      const r = await db.query(
        "select info from repos where org_id = any($1) and info is not null order by info->>'analysedAt' desc",
        [user(req).orgs.map((x) => x.id)],
      );
      return r.rows.map((x) => x.info);
    },

    async enqueue(req, body) {
      const u = user(req);
      const orgId = body.orgId ?? u.orgs[0]?.id;
      if (!orgId || !role(req, orgId)) throw new HttpError(403, 'not a member of this org');
      const source = body.source?.trim();
      if (!source) throw new HttpError(400, 'source is required');
      checkSource(source, o.allowLocalSources);
      // ids are per org, so two orgs analysing one repository never share (or overwrite) a graph
      const key = isGitUrl(source) || !o.allowLocalSources ? source : path.resolve(source);
      const repoId = createHash('sha1').update(`${orgId}\0${key}`).digest('hex').slice(0, 12);
      const name =
        body.name ??
        source
          .replace(/\.git$/, '')
          .split(/[/:]/)
          .filter(Boolean)
          .pop() ??
        source;
      await db.query(
        `insert into repos (repo_id, org_id, name, source) values ($1, $2, $3, $4)
         on conflict (repo_id) do update set name = excluded.name`,
        [repoId, orgId, name, source],
      );
      const r = await db.query(
        'insert into jobs (org_id, repo_id, source, ref, name, created_by) values ($1, $2, $3, $4, $5, $6) returning id',
        [orgId, repoId, source, body.ref ?? null, name, u.user.id],
      );
      await db.query(`select pg_notify('${JOBS_CHANNEL}', $1)`, [r.rows[0].id]);
      return { jobId: r.rows[0].id };
    },

    async job(req, id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
      const r = await db.query('select * from jobs where id = $1', [id]);
      const j = r.rows[0];
      if (!j || !user(req).orgs.some((x) => x.id === j.org_id)) return undefined;
      return {
        jobId: j.id,
        status: j.status,
        stage: j.stage,
        current: j.current,
        total: j.total,
        message: j.message ?? undefined,
        log: j.log,
        error: j.error ?? undefined,
        repoId: j.status === 'done' ? j.repo_id : undefined,
      };
    },

    async reanalyze(req, repoId) {
      const r = await db.query('select org_id, source, name from repos where repo_id = $1', [repoId]);
      if (!r.rowCount) throw new HttpError(404, 'repo not found');
      return api.enqueue(req, { source: r.rows[0].source, name: r.rows[0].name, orgId: r.rows[0].org_id });
    },

    async removeRepo(repoId) {
      await db.query('delete from repos where repo_id = $1', [repoId]);
    },

    onRepoUpdated(fn) {
      listeners.push(fn);
    },

    async close() {
      await listener.end().catch(() => {});
      await db.end().catch(() => {});
    },
  };
  return api;
}
