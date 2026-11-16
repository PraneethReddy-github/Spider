#!/usr/bin/env node
// Hosted-mode smoke test (S-4 / D-7) against a running server + worker.
//   node scripts/hosted-smoke.mjs <base-url> <source-a> [source-b]
// The server must be fresh (no users). Sources must be acceptable to it: git URLs or owner/repo, or local paths
// when the server runs with SPIDER_ALLOW_LOCAL_SOURCES=1.
const [base = 'http://127.0.0.1:4747', sourceA, sourceB = sourceA] = process.argv.slice(2);
if (!sourceA) {
  console.error('usage: hosted-smoke.mjs <base-url> <source-a> [source-b]');
  process.exit(2);
}
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) failures++;
};
async function call(method, path, { token, share, body } = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(share ? { 'x-spider-share': share } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: res.status, json };
}
async function waitJob(token, jobId) {
  for (let i = 0; i < 600; i++) {
    const j = await call('GET', `/jobs/${jobId}`, { token });
    if (j.json.status === 'done' || j.json.status === 'failed') return j.json;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`job ${jobId} did not finish`);
}

const status = await call('GET', '/hosted');
check(status.json.hosted === true && status.json.firstUser === true, 'hosted mode, no users yet');
check((await call('GET', '/repos')).status === 401, 'anonymous requests are refused');

const pw = 'correct horse battery';
const a = await call('POST', '/auth/signup', {
  body: { email: 'ada@example.com', password: pw, name: 'Ada', orgName: 'Acme' },
});
check(a.status === 200 && a.json.orgs?.[0]?.role === 'owner', 'first user signs up and owns a new org');
const org = a.json.orgs[0].id;
const ta = a.json.token;

const closed = await call('POST', '/auth/signup', { body: { email: 'mallory@example.com', password: pw } });
check(closed.status === 403, 'without an invite, sign-up is closed');

const inv = await call('POST', `/orgs/${org}/invites`, { token: ta, body: { role: 'member' } });
check(inv.status === 200 && typeof inv.json.code === 'string', 'owner creates an invite');
const b = await call('POST', '/auth/signup', {
  body: { email: 'bob@example.com', password: pw, name: 'Bob', invite: inv.json.code },
});
check(
  b.status === 200 && b.json.orgs?.[0]?.id === org && b.json.orgs[0].role === 'member',
  'second user joins the same org by invite',
);
const tb = b.json.token;
check((await call('POST', `/orgs/${org}/invites`, { token: tb, body: {} })).status === 403, 'members cannot invite');
check((await call('GET', `/orgs/${org}/members`, { token: tb })).json.length === 2, 'both users are members');
check(
  (await call('POST', '/auth/login', { body: { email: 'bob@example.com', password: 'nope nope nope' } })).status ===
    401,
  'wrong password is refused',
);
const login = await call('POST', '/auth/login', { body: { email: 'BOB@example.com', password: pw } });
check(login.status === 200 && login.json.token, 'login is case-insensitive on email');

// analysis through the queue and the worker
const job = await call('POST', '/repos', { token: tb, body: { source: sourceA } });
check(job.status === 200 && job.json.jobId, 'member queues an analysis');
const done = await waitJob(tb, job.json.jobId);
check(
  done.status === 'done' && done.repoId,
  `the worker analysed it (${done.status}${done.error ? `: ${done.error}` : ''})`,
);
const repoId = done.repoId;
const listA = await call('GET', '/repos', { token: ta });
check(
  listA.json.some?.((r) => r.repoId === repoId),
  'the other member sees the repo',
);
const search = await call('GET', `/repos/${repoId}/search?q=a&limit=3`, { token: ta });
check(search.status === 200 && Array.isArray(search.json), 'graph queries work for members');

// a second org is isolated
const org2 = await call('POST', '/orgs', { token: ta, body: { name: 'Side project' } });
const job2 = await call('POST', '/repos', { token: ta, body: { source: sourceB, orgId: org2.json.id } });
const done2 = await waitJob(ta, job2.json.jobId);
check(done2.status === 'done' && done2.repoId !== repoId, 'same source in another org gets its own graph');
check(
  (await call('GET', `/repos/${done2.repoId}`, { token: tb })).status === 404,
  "a non-member cannot see another org's repo",
);
check(
  (await call('GET', `/jobs/${job2.json.jobId}`, { token: tb })).status === 404,
  "a non-member cannot see another org's job",
);
check(
  (await call('POST', '/repos', { token: tb, body: { source: sourceA, orgId: org2.json.id } })).status === 403,
  'a non-member cannot queue into another org',
);

// read-only share links
const share = await call('POST', `/repos/${repoId}/share`, { token: tb, body: { days: 1 } });
check(share.status === 200 && share.json.url.includes('share='), 'member creates a share link');
const s = share.json.token;
check((await call('GET', `/repos/${repoId}`, { share: s })).status === 200, 'share link reads its repo');
check((await call('GET', `/repos/${repoId}/graph?level=L1`, { share: s })).status === 200, 'share link reads the map');
check((await call('POST', `/repos/${repoId}/reanalyze`, { share: s })).status === 403, 'share link cannot write');
check((await call('GET', `/repos/${done2.repoId}`, { share: s })).status === 403, 'share link is limited to one repo');
check((await call('GET', `/repos/${repoId}`, { share: `${s}x` })).status === 401, 'a tampered share link is refused');
check((await call('GET', '/repos', { share: s })).status === 403, 'share link cannot list the org');

// API tokens
const api = await call('POST', '/auth/tokens', { token: tb, body: { name: 'ci' } });
check(
  (await call('GET', '/me', { token: api.json.token })).json.user?.email === 'bob@example.com',
  'API token authenticates',
);
await call('DELETE', `/auth/tokens/${api.json.id}`, { token: tb });
check((await call('GET', '/me', { token: api.json.token })).status === 401, 'revoked API token is refused');

// deletes are owner-only
check((await call('DELETE', `/repos/${repoId}`, { token: tb })).status === 403, 'members cannot delete repos');
check((await call('POST', '/auth/logout', { token: tb })).status === 200, 'logout');
check((await call('GET', '/me', { token: tb })).status === 401, 'session ends at logout');

// brute force is throttled
let last;
for (let i = 0; i < 11; i++)
  last = await call('POST', '/auth/login', { body: { email: 'ada@example.com', password: `wrong-${i}-xxxx` } });
check(last.status === 429, 'repeated failed sign-ins are throttled');

console.log(failures ? `\n${failures} check(s) failed` : '\nall hosted checks passed');
process.exit(failures ? 1 : 0);
