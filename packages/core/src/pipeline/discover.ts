import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';

export interface DiscoveredFile {
  /** Repo-relative, forward-slash path. */
  path: string;
  abs: string;
  language: string;
  size: number;
  isTest: boolean;
}

export interface Manifest {
  path: string;
  ecosystem: 'npm' | 'pypi' | 'go' | 'cargo' | 'maven';
  name: string;
  version?: string;
  dir: string;
  deps: { name: string; version?: string; isDev: boolean }[];
  frameworks: string[];
  /** For npm: tsconfig paths etc. discovered near the manifest. */
  extra: Record<string, unknown>;
}

export interface Discovery {
  root: string;
  files: DiscoveredFile[];
  manifests: Manifest[];
  frameworks: Set<string>;
  tsconfigs: TsConfigInfo[];
  pythonRoots: string[];
}

export interface TsConfigInfo {
  dir: string;
  baseUrl?: string;
  paths: Record<string, string[]>;
}

const DEFAULT_IGNORES = [
  '.git/',
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'coverage/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  '.cache/',
  '.spider/',
  'vendor/',
  'target/',
  '__pycache__/',
  '.venv/',
  'venv/',
  'env/',
  '.tox/',
  '.mypy_cache/',
  '.pytest_cache/',
  'site-packages/',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '*.png', '*.jpg', '*.jpeg', '*.gif', '*.svg', '*.ico', '*.woff', '*.woff2', '*.ttf', '*.eot',
  '*.pdf', '*.zip', '*.gz', '*.tar', '*.wasm', '*.so', '*.dll', '*.dylib', '*.pyc', '*.class', '*.jar',
];

const EXT_LANG: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'tsx', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
  '.swift': 'swift', '.scala': 'scala', '.lua': 'lua', '.ex': 'elixir', '.exs': 'elixir',
  '.sh': 'shell', '.bash': 'shell',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.md': 'markdown', '.mdx': 'markdown', '.html': 'html', '.css': 'css', '.scss': 'scss',
  '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql', '.proto': 'protobuf',
  '.vue': 'vue', '.svelte': 'svelte',
};

const MAX_FILE_SIZE = 2 * 1024 * 1024;

export function detectLanguage(rel: string): string {
  const base = path.basename(rel);
  if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) return 'dockerfile';
  if (base === 'Makefile') return 'makefile';
  const ext = path.extname(rel).toLowerCase();
  return EXT_LANG[ext] ?? 'other';
}

const TEST_PATTERNS = [
  /(^|\/)(test|tests|__tests__|spec|specs|e2e|__mocks__)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(py|go)$/i,
  /(^|\/)conftest\.py$/i,
];

export function isTestPath(rel: string): boolean {
  return TEST_PATTERNS.some((r) => r.test(rel));
}

/** Walks the repo, honouring .gitignore / .spiderignore, and returns candidate files. */
export async function discover(root: string, onProgress?: (n: number) => void): Promise<Discovery> {
  const ig = ignore().add(DEFAULT_IGNORES);
  for (const f of ['.gitignore', '.spiderignore']) {
    try {
      ig.add(await fs.readFile(path.join(root, f), 'utf8'));
    } catch {
      /* not present */
    }
  }

  const files: DiscoveredFile[] = [];
  const manifests: Manifest[] = [];
  const tsconfigs: TsConfigInfo[] = [];
  const frameworks = new Set<string>();
  const pythonRoots = new Set<string>();

  async function walk(dirAbs: string, dirRel: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    // Nested .gitignore support (simple: merge into global ignore with prefix-less rules)
    for (const ent of entries) {
      const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ig.ignores(`${rel}/`)) continue;
        await walk(path.join(dirAbs, ent.name), rel);
      } else if (ent.isFile()) {
        if (ig.ignores(rel)) continue;
        const abs = path.join(dirAbs, ent.name);
        let size = 0;
        try {
          size = (await fs.stat(abs)).size;
        } catch {
          continue;
        }
        if (size > MAX_FILE_SIZE) continue;
        const language = detectLanguage(rel);
        files.push({ path: rel, abs, language, size, isTest: isTestPath(rel) });
        if (files.length % 500 === 0) onProgress?.(files.length);

        if (ent.name === 'package.json') manifests.push(await readNpmManifest(abs, rel, frameworks));
        else if (ent.name === 'pyproject.toml' || ent.name === 'requirements.txt' || ent.name === 'setup.py')
          manifests.push(await readPyManifest(abs, rel, frameworks));
        else if (ent.name === 'go.mod') manifests.push(await readGoMod(abs, rel));
        else if (ent.name === 'Cargo.toml') manifests.push(await readCargo(abs, rel));
        else if (ent.name === 'tsconfig.json' || ent.name === 'jsconfig.json') {
          const tc = await readTsConfig(abs, rel);
          if (tc) tsconfigs.push(tc);
        }
        if (ent.name === '__init__.py') {
          const pkgDir = dirRel;
          const parent = path.posix.dirname(pkgDir);
          pythonRoots.add(parent === '.' ? '' : parent);
        }
      }
    }
  }

  await walk(root, '');
  onProgress?.(files.length);

  // Common python source roots
  for (const cand of ['', 'src', 'lib', 'app']) {
    if (files.some((f) => f.language === 'python' && (cand ? f.path.startsWith(cand + '/') : true))) pythonRoots.add(cand);
  }
  for (const m of manifests) if (m.ecosystem === 'pypi') pythonRoots.add(m.dir);

  // Only keep minimal python roots (a root that is a package dir itself shouldn't shadow the parent)
  const roots = [...pythonRoots].sort((a, b) => a.length - b.length);

  return { root, files, manifests, frameworks, tsconfigs, pythonRoots: roots };
}

const NPM_FRAMEWORKS: Record<string, string> = {
  express: 'express', fastify: 'fastify', koa: 'koa', hono: 'hono', '@nestjs/core': 'nestjs', next: 'nextjs',
  react: 'react', vue: 'vue', svelte: 'svelte', '@angular/core': 'angular', '@hapi/hapi': 'hapi',
  '@remix-run/react': 'remix', 'apollo-server': 'apollo', '@apollo/server': 'apollo', '@trpc/server': 'trpc',
};

const PY_FRAMEWORKS: Record<string, string> = {
  fastapi: 'fastapi', flask: 'flask', django: 'django', starlette: 'starlette', tornado: 'tornado',
  sanic: 'sanic', aiohttp: 'aiohttp', celery: 'celery', sqlalchemy: 'sqlalchemy',
};

async function readNpmManifest(abs: string, rel: string, frameworks: Set<string>): Promise<Manifest> {
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const m: Manifest = { path: rel, ecosystem: 'npm', name: dir || 'root', dir, deps: [], frameworks: [], extra: {} };
  try {
    const json = JSON.parse(await fs.readFile(abs, 'utf8'));
    m.name = json.name ?? m.name;
    m.version = json.version;
    for (const [field, isDev] of [['dependencies', false], ['devDependencies', true], ['peerDependencies', false]] as const) {
      for (const [name, version] of Object.entries(json[field] ?? {})) {
        m.deps.push({ name, version: String(version), isDev });
        if (!isDev && NPM_FRAMEWORKS[name]) {
          m.frameworks.push(NPM_FRAMEWORKS[name]);
          frameworks.add(NPM_FRAMEWORKS[name]);
        }
      }
    }
    m.extra = { main: json.main, module: json.module, exports: json.exports, bin: json.bin, workspaces: json.workspaces, type: json.type };
  } catch {
    /* ignore malformed */
  }
  return m;
}

async function readPyManifest(abs: string, rel: string, frameworks: Set<string>): Promise<Manifest> {
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const m: Manifest = { path: rel, ecosystem: 'pypi', name: dir || 'root', dir, deps: [], frameworks: [], extra: {} };
  try {
    const text = await fs.readFile(abs, 'utf8');
    const nameMatch = /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text);
    if (nameMatch) m.name = nameMatch[1];
    const depRe = /^\s*["']?([A-Za-z0-9_.\-]+)\s*(?:[<>=!~\[]|$|["'])/gm;
    let mm: RegExpExecArray | null;
    const seen = new Set<string>();
    while ((mm = depRe.exec(text))) {
      const name = mm[1].toLowerCase();
      if (['name', 'version', 'description', 'requires', 'build', 'backend', 'python', 'readme', 'license', 'authors', 'dependencies', 'classifiers', 'urls', 'project', 'tool', 'packages', 'include', 'exclude', 'homepage', 'repository', 'keywords', 'scripts', 'optional'].includes(name)) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const isDev = /dev|test/.test(rel);
      m.deps.push({ name, isDev });
      if (PY_FRAMEWORKS[name]) {
        m.frameworks.push(PY_FRAMEWORKS[name]);
        frameworks.add(PY_FRAMEWORKS[name]);
      }
    }
  } catch {
    /* ignore */
  }
  return m;
}

async function readGoMod(abs: string, rel: string): Promise<Manifest> {
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const m: Manifest = { path: rel, ecosystem: 'go', name: dir || 'root', dir, deps: [], frameworks: [], extra: {} };
  try {
    const text = await fs.readFile(abs, 'utf8');
    const mod = /^module\s+(\S+)/m.exec(text);
    if (mod) m.name = mod[1];
    const re = /^\s*([\w.\-\/]+\.[\w.\-\/]+)\s+v([\w.\-+]+)/gm;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(text))) m.deps.push({ name: mm[1], version: mm[2], isDev: false });
  } catch {
    /* ignore */
  }
  return m;
}

async function readCargo(abs: string, rel: string): Promise<Manifest> {
  const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
  const m: Manifest = { path: rel, ecosystem: 'cargo', name: dir || 'root', dir, deps: [], frameworks: [], extra: {} };
  try {
    const text = await fs.readFile(abs, 'utf8');
    const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text);
    if (name) m.name = name[1];
    const section = text.split(/^\[dependencies\]/m)[1]?.split(/^\[/m)[0] ?? '';
    for (const line of section.split('\n')) {
      const mm = /^\s*([\w\-]+)\s*=/.exec(line);
      if (mm) m.deps.push({ name: mm[1], isDev: false });
    }
  } catch {
    /* ignore */
  }
  return m;
}

async function readTsConfig(abs: string, rel: string): Promise<TsConfigInfo | undefined> {
  try {
    const raw = await fs.readFile(abs, 'utf8');
    // strip comments & trailing commas (tsconfig is JSONC)
    const cleaned = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1');
    const json = JSON.parse(cleaned);
    const co = json.compilerOptions ?? {};
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    return { dir, baseUrl: co.baseUrl, paths: co.paths ?? {} };
  } catch {
    return undefined;
  }
}

/** Emits repository / directory / file / package / external nodes into the graph. */
export function emitStructure(g: GraphBuilder, d: Discovery, repoName: string): void {
  g.addNode({ id: ids.repo(), kind: 'repository', name: repoName, props: { path: '' } });

  const dirIds = new Map<string, string>([['', ids.repo()]]);
  function ensureDir(dirRel: string): string {
    const known = dirIds.get(dirRel);
    if (known) return known;
    const parent = path.posix.dirname(dirRel);
    const parentId = ensureDir(parent === '.' ? '' : parent);
    const id = ids.directory(dirRel);
    g.addNode({ id, kind: 'directory', name: path.posix.basename(dirRel), qname: dirRel, file: dirRel, parentId, props: { path: dirRel } });
    dirIds.set(dirRel, id);
    return id;
  }

  for (const f of d.files) {
    const dir = path.posix.dirname(f.path);
    const parentId = ensureDir(dir === '.' ? '' : dir);
    g.addNode({
      id: ids.file(f.path),
      kind: 'file',
      name: path.posix.basename(f.path),
      qname: f.path,
      file: f.path,
      language: f.language,
      parentId,
      props: { path: f.path, size: f.size, isTest: f.isTest },
    });
  }

  for (const m of d.manifests) {
    const pkgId = ids.pkg(m.path);
    const dirId = dirIds.get(m.dir) ?? ids.repo();
    g.addNode({ id: pkgId, kind: 'package', name: m.name, qname: m.path, file: m.path, parentId: dirId, props: { ecosystem: m.ecosystem, version: m.version, dir: m.dir, frameworks: m.frameworks } });
    for (const dep of m.deps) {
      const extId = ids.external(m.ecosystem, dep.name);
      g.addNode({ id: extId, kind: 'external', name: dep.name, qname: `${m.ecosystem}:${dep.name}`, props: { ecosystem: m.ecosystem, version: dep.version, isDev: dep.isDev } });
      g.addEdge('depends_on', pkgId, extId, { props: { isDev: dep.isDev } });
    }
  }
}
