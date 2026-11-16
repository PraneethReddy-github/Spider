#!/usr/bin/env node
// Generates a deterministic synthetic TypeScript repo for scale benchmarks (C-21).
//   node scripts/gen-big-repo.mjs <dir> --files N [--lang ts] [--seed S]
// Layout: packages/<pkg>/src/<domain>/<area>/<name>.ts — each file has a class (some extend another
// file's class), methods calling each other and imported functions, free functions, and ~2 % of files
// register Express routes. ≈ 10 graph nodes per file, so --files 25000 gives ≈ 250k nodes.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const files = Number(flag('files', '1000'));
const lang = flag('lang', 'ts');
const seed = Number(flag('seed', '42'));
if (!dir || !Number.isInteger(files) || files < 1) {
  console.error('usage: gen-big-repo.mjs <dir> --files N [--lang ts] [--seed S]');
  process.exit(1);
}
if (lang !== 'ts') {
  console.error(`--lang ${lang}: only ts is supported`);
  process.exit(1);
}

// mulberry32: small, fast, deterministic
let s = seed >>> 0;
const rnd = () => {
  s = (s + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));

const WORDS = [
  'user',
  'order',
  'invoice',
  'cart',
  'payment',
  'session',
  'token',
  'report',
  'audit',
  'search',
  'index',
  'cache',
  'queue',
  'mail',
  'billing',
  'catalog',
  'price',
  'stock',
  'ship',
  'route',
  'policy',
  'role',
  'team',
  'project',
  'task',
  'event',
  'metric',
  'log',
  'config',
  'flag',
  'file',
  'image',
  'note',
  'tag',
  'comment',
];
const cap = (w) => w[0].toUpperCase() + w.slice(1);
const pkgCount = Math.max(1, Math.round(Math.sqrt(files) / 8));
const DOMAINS = ['core', 'api', 'data', 'domain', 'infra', 'ui', 'jobs', 'util'];

/** @type {{rel: string, cls: string, fns: string[], methods: string[]}[]} */
const plan = [];
for (let i = 0; i < files; i++) {
  const pkg = `pkg${i % pkgCount}`;
  const domain = DOMAINS[Math.floor(i / pkgCount) % DOMAINS.length];
  const area = `${pick(WORDS)}${Math.floor(i / (pkgCount * DOMAINS.length * 12))}`;
  const base = `${pick(WORDS)}${cap(pick(WORDS))}${i}`;
  plan.push({
    rel: `packages/${pkg}/src/${domain}/${area}/${base}.ts`,
    cls: `${cap(base)}Service`,
    fns: Array.from({ length: int(2, 4) }, (_, k) => `${pick(WORDS)}${cap(pick(WORDS))}${i}_${k}`),
    methods: Array.from({ length: int(2, 4) }, (_, k) => `${pick(['load', 'save', 'find', 'apply', 'sync'])}${k}`),
  });
}

rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
writeFileSync(
  path.join(dir, 'package.json'),
  JSON.stringify({ name: 'big-synthetic', private: true, dependencies: { express: '^4.0.0' } }, null, 2),
);
const relImport = (from, to) => {
  let r = path.posix.relative(path.posix.dirname(from), to).replace(/\.ts$/, '');
  if (!r.startsWith('.')) r = `./${r}`;
  return r;
};

let routes = 0;
for (let i = 0; i < files; i++) {
  const f = plan[i];
  // mostly import earlier files (layered), sometimes later ones (cycles), biased towards neighbours
  const deps = new Set();
  const nDeps = i === 0 ? 0 : int(1, 4);
  for (let k = 0; k < nDeps; k++) {
    const near = rnd() < 0.7;
    const j = near ? Math.max(0, i - int(1, 40)) : Math.floor(rnd() * files);
    if (j !== i) deps.add(j);
  }
  const lines = [];
  const isRoute = rnd() < 0.02;
  if (isRoute) lines.push(`import { Router } from 'express';`);
  const depList = [...deps];
  for (const j of depList)
    lines.push(`import { ${plan[j].cls}, ${plan[j].fns[0]} } from '${relImport(f.rel, plan[j].rel)}';`);
  const parent = depList.length && rnd() < 0.25 ? plan[depList[0]].cls : undefined;
  lines.push('');
  lines.push(`export class ${f.cls}${parent ? ` extends ${parent}` : ''} {`);
  f.methods.forEach((m, k) => {
    const body = [];
    if (k + 1 < f.methods.length) body.push(`this.${f.methods[k + 1]}(input);`);
    body.push(`${pick(f.fns)}(input);`);
    if (depList.length) body.push(`${plan[pick(depList)].fns[0]}(input);`);
    lines.push(`  ${m}(input: number): number {`, ...body.map((b) => `    ${b}`), '    return input + 1;', '  }');
  });
  lines.push('}', '');
  f.fns.forEach((fn, k) => {
    const body = [];
    if (k > 0) body.push(`${f.fns[k - 1]}(x);`);
    if (depList.length && rnd() < 0.5) {
      const d = plan[pick(depList)];
      body.push(`new ${d.cls}().${d.methods[0]}(x);`);
    }
    lines.push(`export function ${fn}(x: number): number {`, ...body.map((b) => `  ${b}`), '  return x * 2;', '}', '');
  });
  if (isRoute) {
    routes++;
    const res = f.fns[0].replace(/\d.*$/, '').toLowerCase();
    lines.push('export const router = Router();');
    lines.push(`router.get('/${res}/${i}', (req, res) => res.json(${f.fns[0]}(1)));`);
    lines.push(`router.post('/${res}/${i}', (req, res) => res.json(new ${f.cls}().${f.methods[0]}(2)));`);
  }
  const abs = path.join(dir, f.rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, `${lines.join('\n')}\n`);
}
console.log(`${files} files in ${pkgCount} packages, ${routes} route files → ${dir}`);
