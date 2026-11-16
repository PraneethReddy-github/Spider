import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const key = await scryptAsync(password, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash, 'hex');
  return want.length === key.length && timingSafeEqual(key, want);
}

/** Opaque bearer token; only its SHA-256 is stored. */
export function newToken(): { token: string; hash: string } {
  const token = `spd_${randomBytes(32).toString('base64url')}`;
  return { token, hash: tokenHash(token) };
}
export const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

/**
 * Signed, expiring capabilities (share links, org invites): `base64url(json).hmac`. No server state, so they
 * cannot be revoked one by one; rotating `SPIDER_SECRET` revokes all.
 */
export function sign(secret: string, payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

export function verify<T extends { exp: number }>(secret: string, token: string, kind: string): T | undefined {
  const [body, mac] = token.split('.');
  if (!body || !mac) return undefined;
  const want = createHmac('sha256', secret).update(body).digest();
  const got = Buffer.from(mac, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return undefined;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as T & { kind?: string };
    return p.kind === kind && p.exp > Date.now() ? p : undefined;
  } catch {
    return undefined;
  }
}

export interface UserPrincipal {
  type: 'user';
  user: { id: string; email: string; name: string };
  orgs: { id: string; name: string; role: 'owner' | 'member' }[];
  tokenId: string;
}
export interface SharePrincipal {
  type: 'share';
  repoId: string;
}
export type Principal = UserPrincipal | SharePrincipal;

export async function userFromToken(db: Db, token: string): Promise<UserPrincipal | undefined> {
  const r = await db.query(
    `update tokens set last_used_at = now()
       where hash = $1 and (expires_at is null or expires_at > now())
       returning id, user_id`,
    [tokenHash(token)],
  );
  if (!r.rowCount) return undefined;
  return principalFor(db, r.rows[0].user_id, r.rows[0].id);
}

export async function principalFor(db: Db, userId: string, tokenId: string): Promise<UserPrincipal | undefined> {
  const u = await db.query('select id, email, name from users where id = $1', [userId]);
  if (!u.rowCount) return undefined;
  const orgs = await db.query(
    `select o.id, o.name, m.role from memberships m join orgs o on o.id = m.org_id
      where m.user_id = $1 order by o.created_at`,
    [userId],
  );
  return { type: 'user', user: u.rows[0], orgs: orgs.rows, tokenId };
}
