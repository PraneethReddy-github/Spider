#!/usr/bin/env node
// D-7: Ask Spider answers fixture questions with correct citations.
//   spider analyze fixtures/ts-express && SPIDER_LLM_PROVIDER=anthropic spider serve &
//   node scripts/ask-eval.mjs [base-url]
// Each question names nodes a correct answer must cite; extra citations are fine, invented ids are already dropped
// by the server. Spends model tokens (one Ask per question).
const base = process.argv[2] ?? 'http://127.0.0.1:4747';

const QUESTIONS = [
  { q: 'Which class handles the order endpoints?', cite: ['OrderController'] },
  { q: 'What does UserService depend on to load users?', cite: ['UserService', 'db.ts'] },
  {
    q: 'Which function registers the user routes, and which service does it create?',
    cite: ['registerUserRoutes', 'UserService'],
  },
  { q: 'Which class do the route controllers extend?', cite: ['BaseController'] },
  { q: 'Where is money formatted?', cite: ['formatMoney'] },
];

async function ask(repoId, question) {
  const res = await fetch(`${base}/api/v1/repos/${repoId}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const text = await res.text();
  const events = text
    .split('\n\n')
    .map((b) => b.split('\n').find((l) => l.startsWith('data: ')))
    .filter(Boolean)
    .map((l) => JSON.parse(l.slice(6)));
  const done = events.find((e) => e.type === 'done');
  const err = events.find((e) => e.type === 'error');
  if (!done) throw new Error(err?.message ?? 'no answer');
  return done;
}

const repos = await (await fetch(`${base}/api/v1/repos`)).json();
const repo = repos.find((r) => r.name === 'ts-express');
if (!repo) {
  console.error('analyse fixtures/ts-express first');
  process.exit(2);
}
let pass = 0;
for (const { q, cite } of QUESTIONS) {
  const done = await ask(repo.repoId, q);
  const names = await Promise.all(
    done.citations.map(async (id) => {
      const d = await (await fetch(`${base}/api/v1/repos/${repo.repoId}/nodes/${encodeURIComponent(id)}`)).json();
      return d.node?.name ?? id;
    }),
  );
  const missing = cite.filter((c) => !names.includes(c));
  const ok = missing.length === 0;
  if (ok) pass++;
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${q}\n     cited: ${names.join(', ') || '(none)'}${ok ? '' : `\n     missing: ${missing.join(', ')}`}`,
  );
}
console.log(`\n${pass}/${QUESTIONS.length} answers cite every expected node`);
process.exit(pass === QUESTIONS.length ? 0 : 1);
