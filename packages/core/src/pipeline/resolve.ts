import path from 'node:path';
import type { GraphNode } from '@spider/shared';
import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';
import type { DeclFact, FileFacts } from '../languages/types.js';
import type { Discovery } from './discover.js';

export interface ResolveStats {
  unresolvedImports: number;
  unresolvedCalls: number;
  resolvedImports: number;
  resolvedCalls: number;
  ambiguousCalls: number;
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.d.ts', '.vue', '.svelte', '.json'];

const JS_BUILTINS = new Set([
  'console', 'JSON', 'Math', 'Object', 'Array', 'Promise', 'String', 'Number', 'Boolean', 'Date', 'Error', 'Map', 'Set',
  'WeakMap', 'Symbol', 'Reflect', 'Proxy', 'parseInt', 'parseFloat', 'setTimeout', 'setInterval', 'clearTimeout',
  'clearInterval', 'require', 'process', 'Buffer', 'window', 'document', 'globalThis', 'RegExp', 'Intl', 'fetch',
  'encodeURIComponent', 'decodeURIComponent', 'isNaN', 'isFinite', 'Number', 'BigInt', 'structuredClone', 'queueMicrotask',
  'super', 'describe', 'it', 'test', 'expect', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
]);
const PY_BUILTINS = new Set([
  'print', 'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple', 'range', 'enumerate', 'zip', 'map',
  'filter', 'sorted', 'reversed', 'isinstance', 'issubclass', 'getattr', 'setattr', 'hasattr', 'delattr', 'type', 'super',
  'open', 'iter', 'next', 'min', 'max', 'sum', 'abs', 'round', 'any', 'all', 'repr', 'format', 'id', 'hash', 'input',
  'vars', 'dir', 'callable', 'ord', 'chr', 'bytes', 'bytearray', 'object', 'property', 'staticmethod', 'classmethod',
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'RuntimeError', 'NotImplementedError', 'AttributeError',
  'IndexError', 'StopIteration', 'frozenset', 'slice', 'divmod', 'pow', 'globals', 'locals', 'exec', 'eval', 'compile',
  'memoryview', 'complex', 'help', 'dataclass', 'field', 'override', 'abstractmethod', 'wraps', 'lru_cache', 'cache',
]);
const PY_STDLIB = new Set([
  'os', 'sys', 're', 'json', 'time', 'datetime', 'math', 'random', 'typing', 'collections', 'itertools', 'functools',
  'pathlib', 'logging', 'subprocess', 'threading', 'multiprocessing', 'asyncio', 'io', 'abc', 'enum', 'dataclasses',
  'copy', 'pickle', 'struct', 'socket', 'ssl', 'http', 'urllib', 'email', 'uuid', 'hashlib', 'hmac', 'base64', 'shutil',
  'tempfile', 'glob', 'fnmatch', 'argparse', 'configparser', 'csv', 'sqlite3', 'decimal', 'fractions', 'statistics',
  'string', 'textwrap', 'unicodedata', 'operator', 'contextlib', 'inspect', 'traceback', 'warnings', 'weakref', 'types',
  'queue', 'heapq', 'bisect', 'array', 'secrets', 'signal', 'select', 'errno', 'platform', 'importlib', 'unittest',
  'pprint', 'zipfile', 'tarfile', 'gzip', 'zlib', 'html', 'xml', 'ctypes', 'concurrent', 'numbers', 'codecs', 'locale',
  'gettext', 'calendar', 'zoneinfo', 'builtins', '__future__', 'ast', 'dis', 'tokenize', 'token', 'keyword', 'sched',
  'timeit', 'cProfile', 'profile', 'pdb', 'doctest', 'site', 'atexit', 'getpass', 'shlex', 'mimetypes', 'webbrowser',
  'wsgiref', 'ipaddress', 'graphlib', 'stat', 'filecmp', 'linecache', 'fileinput', 'tomllib',
]);

interface SymbolEntry {
  id: string;
  decl: DeclFact;
}

interface FileTable {
  path: string;
  fileId: string;
  facts: FileFacts;
  /** qname → symbol id for own declarations. */
  own: Map<string, SymbolEntry>;
  /** local binding name → bound entity (symbol id, or file id for namespaces). */
  locals: Map<string, { kind: 'symbol' | 'file' | 'external'; id: string }>;
  /** scope qname ('' = module) → variable name → constructor/factory reference. */
  bindings: Map<string, Map<string, { ref: string; isNew: boolean }>>;
}

const GENERIC_METHODS = new Set([
  'get', 'set', 'add', 'remove', 'push', 'pop', 'map', 'filter', 'then', 'catch', 'on', 'off', 'emit', 'json', 'send', 'status',
  'toString', 'has', 'keys', 'values', 'entries', 'call', 'apply', 'bind', 'slice', 'concat', 'sort', 'reverse', 'indexOf',
  'includes', 'test', 'match', 'replace', 'trim', 'split', 'join', 'write', 'read', 'end', 'close', 'open', 'next', 'done',
  'resolve', 'reject', 'log', 'error', 'warn', 'info', 'debug', 'append', 'extend', 'items', 'update', 'copy', 'clear',
  'format', 'strip', 'lower', 'upper', 'encode', 'decode', 'startswith', 'endswith', 'exists', 'delete', 'post', 'put',
  'patch', 'use', 'listen', 'forEach', 'some', 'every', 'reduce', 'flat', 'find', 'findIndex', 'fill', 'length', 'size',
  'toJSON', 'valueOf', 'assign', 'freeze', 'query', 'execute', 'commit', 'rollback', 'connect', 'disconnect', 'run',
]);

export function resolve(g: GraphBuilder, d: Discovery, all: Map<string, FileFacts>): ResolveStats {
  const stats: ResolveStats = { unresolvedImports: 0, unresolvedCalls: 0, resolvedImports: 0, resolvedCalls: 0, ambiguousCalls: 0 };
  const filesByPath = new Set(d.files.map((f) => f.path));
  const tables = new Map<string, FileTable>();
  const globalByName = new Map<string, SymbolEntry[]>();
  const workspacePkgs = new Map<string, { dir: string; main?: string }>();
  for (const m of d.manifests) if (m.ecosystem === 'npm' && m.name) workspacePkgs.set(m.name, { dir: m.dir, main: (m.extra.main as string) ?? (m.extra.module as string) });

  /* ---------- 1. symbol nodes ---------- */
  for (const [p, facts] of all) {
    const fileId = ids.file(p);
    const table: FileTable = { path: p, fileId, facts, own: new Map(), locals: new Map(), bindings: new Map() };
    facts.bindings ??= [];
    tables.set(p, table);
    for (const b of facts.bindings) {
      const key = b.scopeQname ?? '';
      let m = table.bindings.get(key);
      if (!m) table.bindings.set(key, (m = new Map()));
      m.set(b.name, { ref: b.ref, isNew: b.isNew });
    }
    const fileNode = g.getNode(fileId);
    if (fileNode) {
      fileNode.props.loc = facts.loc;
      fileNode.metrics = { fanIn: 0, fanOut: 0, loc: facts.loc };
    }
    // Ensure parents are registered before children: sort by qname depth.
    const decls = [...facts.decls].sort((a, b) => a.qname.split('.').length - b.qname.split('.').length);
    for (const decl of decls) {
      const id = ids.symbol(p, decl.qname);
      const parentEntry = decl.parentQname ? table.own.get(decl.parentQname) : undefined;
      const node = g.addNode({
        id,
        kind: decl.kind,
        name: decl.name,
        qname: `${p}::${decl.qname}`,
        file: p,
        language: facts.language,
        parentId: parentEntry?.id ?? fileId,
        span: decl.span,
        metrics: { fanIn: 0, fanOut: 0, loc: decl.loc, complexity: decl.complexity },
        props: {
          isExported: decl.isExported,
          isAsync: decl.isAsync,
          isStatic: decl.isStatic,
          isAbstract: decl.isAbstract,
          visibility: decl.visibility,
          classKind: decl.classKind,
          signature: decl.signature,
          params: decl.params,
          decorators: decl.decorators,
          isTest: g.getNode(fileId)?.props.isTest ?? false,
        },
      });
      const entry = { id: node.id, decl };
      table.own.set(decl.qname, entry);
      if (!decl.parentQname) table.locals.set(decl.name, { kind: 'symbol', id: node.id });
      let list = globalByName.get(decl.name);
      if (!list) globalByName.set(decl.name, (list = []));
      list.push(entry);
      if (decl.isExported) g.addEdge('exports', fileId, node.id);
    }
  }

  /* ---------- 2. import resolution ---------- */
  const jsResolver = new JsResolver(filesByPath, d, workspacePkgs);
  const pyResolver = new PyResolver(filesByPath, d);

  for (const table of tables.values()) {
    const { facts, fileId, path: p } = table;
    for (const imp of facts.imports) {
      const target = facts.language === 'python' ? pyResolver.resolve(p, imp.specifier) : jsResolver.resolve(p, imp.specifier);
      if (!target) {
        stats.unresolvedImports++;
        continue;
      }
      stats.resolvedImports++;
      if (target.kind === 'external') {
        const extId = ids.external(target.ecosystem, target.name);
        if (!g.hasNode(extId)) g.addNode({ id: extId, kind: 'external', name: target.name, qname: `${target.ecosystem}:${target.name}`, props: { ecosystem: target.ecosystem, inferred: true } });
        g.addEdge('imports', fileId, extId, { evidence: imp.span, props: { isDynamic: imp.isDynamic } });
        if (imp.namespace) table.locals.set(imp.namespace, { kind: 'external', id: extId });
        for (const n of imp.names) table.locals.set(n.local, { kind: 'external', id: extId });
        continue;
      }
      const targetId = ids.file(target.path);
      g.addEdge('imports', fileId, targetId, { evidence: imp.span, props: { isDynamic: imp.isDynamic } });
      const targetTable = tables.get(target.path);
      if (imp.namespace) table.locals.set(imp.namespace, { kind: 'file', id: targetId });
      for (const n of imp.names) {
        if (n.imported === '*') {
          if (targetTable) for (const [qn, e] of targetTable.own) if (!e.decl.parentQname) table.locals.set(qn, { kind: 'symbol', id: e.id });
          continue;
        }
        const bound = targetTable ? bindExport(targetTable, n.imported, tables, jsResolver, pyResolver, 0) : undefined;
        if (bound) table.locals.set(n.local, bound);
        else if (facts.language === 'python' && targetTable) {
          // `from pkg import submodule`
          const sub = pyResolver.resolve(p, imp.specifier ? `${imp.specifier}.${n.imported}` : n.imported);
          if (sub && sub.kind === 'file') {
            table.locals.set(n.local, { kind: 'file', id: ids.file(sub.path) });
            g.addEdge('imports', fileId, ids.file(sub.path), { evidence: imp.span });
          } else table.locals.set(n.local, { kind: 'file', id: targetId });
        } else table.locals.set(n.local, { kind: 'file', id: targetId });
      }
    }
  }

  /* ---------- 3. inheritance ---------- */
  for (const table of tables.values()) {
    for (const [qn, entry] of table.own) {
      const decl = entry.decl;
      if (decl.kind !== 'class') continue;
      for (const [rel, names] of [['extends', decl.extends ?? []], ['implements', decl.implements ?? []]] as const) {
        for (const name of names) {
          const target = lookupDotted(table, name, tables, globalByName, qn);
          if (target?.length === 1) g.addEdge(rel, entry.id, target[0].id, { evidence: decl.span });
          else if (target && target.length > 1) for (const t of target) g.addEdge(rel, entry.id, t.id, { confidence: 1 / target.length, props: { ambiguous: true }, evidence: decl.span });
        }
      }
    }
  }

  /* ---------- 4. calls ---------- */
  const builtins = (lang: string) => (lang === 'python' ? PY_BUILTINS : JS_BUILTINS);
  for (const table of tables.values()) {
    const { facts } = table;
    const bi = builtins(facts.language);
    for (const call of facts.calls) {
      const first = call.callee.split('.')[0];
      if (bi.has(first) || bi.has(call.callee)) continue;
      const callerId = call.callerQname ? (table.own.get(call.callerQname)?.id ?? nearestOwner(table, call.callerQname)) : table.fileId;
      const targets = lookupDotted(table, call.callee, tables, globalByName, call.callerQname);
      if (!targets || targets.length === 0) {
        stats.unresolvedCalls++;
        continue;
      }
      stats.resolvedCalls++;
      if (targets.length > 1) stats.ambiguousCalls++;
      for (const t of targets) {
        const targetNode = g.getNode(t.id);
        const kind = call.isNew || targetNode?.kind === 'class' ? 'instantiates' : 'calls';
        g.addEdge(kind, callerId, t.id, {
          confidence: t.confidence,
          evidence: call.span,
          props: t.confidence < 1 ? { ambiguous: true } : undefined,
        });
      }
    }
  }

  /* ---------- 5. endpoints ---------- */
  for (const table of tables.values()) {
    for (const ep of table.facts.endpoints) {
      const id = ids.endpoint(table.path, ep.method, ep.path, ep.span.startLine);
      g.addNode({
        id,
        kind: 'endpoint',
        name: `${ep.method} ${ep.path}`,
        qname: `${table.path}::${ep.method} ${ep.path}`,
        file: table.path,
        language: table.facts.language,
        parentId: table.fileId,
        span: ep.span,
        metrics: { fanIn: 0, fanOut: 0 },
        props: { method: ep.method, path: ep.path, framework: ep.framework, protocol: ep.method === 'WS' ? 'ws' : 'http', isTest: g.getNode(table.fileId)?.props.isTest ?? false },
      });
      let handler: { id: string }[] | undefined;
      if (ep.handlerRef) {
        const own = table.own.get(ep.handlerRef);
        handler = own ? [{ id: own.id }] : lookupDotted(table, ep.handlerRef, tables, globalByName, ep.enclosingQname);
      }
      if ((!handler || handler.length === 0) && ep.enclosingQname) {
        const own = table.own.get(ep.enclosingQname);
        if (own) handler = [{ id: own.id }];
      }
      if (handler) for (const h of handler) g.addEdge('exposes', id, h.id, { evidence: ep.span, confidence: 1 / handler.length });
    }
  }

  return stats;
}

/* ---------- helpers ---------- */

function nearestOwner(table: FileTable, qname: string): string {
  const parts = qname.split('.');
  while (parts.length) {
    const e = table.own.get(parts.join('.'));
    if (e) return e.id;
    parts.pop();
  }
  return table.fileId;
}

/** Resolves an exported name in a target file to a symbol (following re-exports). */
function bindExport(
  target: FileTable,
  name: string,
  tables: Map<string, FileTable>,
  js: JsResolver,
  py: PyResolver,
  depth: number,
): { kind: 'symbol' | 'file' | 'external'; id: string } | undefined {
  if (depth > 5) return undefined;
  const own = target.own.get(name);
  if (own && !own.decl.parentQname) return { kind: 'symbol', id: own.id };
  for (const ex of target.facts.exports) {
    if (ex.name !== name && ex.name !== '*') continue;
    if (ex.from) {
      const r = target.facts.language === 'python' ? py.resolve(target.path, ex.from) : js.resolve(target.path, ex.from);
      if (!r || r.kind !== 'file') continue;
      const t2 = tables.get(r.path);
      if (!t2) return { kind: 'file', id: ids.file(r.path) };
      const inner = bindExport(t2, ex.name === '*' ? name : (ex.local ?? name), tables, js, py, depth + 1);
      if (inner) return inner;
    } else if (ex.local) {
      const o = target.own.get(ex.local);
      if (o) return { kind: 'symbol', id: o.id };
    }
  }
  // python: locals imported into a module can be re-exported implicitly
  const viaLocal = target.locals.get(name);
  if (viaLocal && target.facts.language === 'python') return viaLocal;
  if (name === 'default' && own) return { kind: 'symbol', id: own.id };
  return undefined;
}

interface Target {
  id: string;
  confidence: number;
}

/**
 * Resolves a dotted reference (`foo`, `ns.foo`, `Class.method`, `this.method`, `obj.method`) from a file.
 */
function lookupDotted(
  table: FileTable,
  dotted: string,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
  contextQname?: string,
): Target[] | undefined {
  const segs = dotted.split('.').filter(Boolean);
  if (segs.length === 0) return undefined;
  const [head, ...rest] = segs;

  // this/self/cls → enclosing class
  if (head === 'this' || head === 'self' || head === 'cls' || head === 'super') {
    const cls = enclosingClass(table, contextQname);
    if (cls && rest.length) {
      const member = table.own.get(`${cls.decl.qname}.${rest.join('.')}`);
      if (member) return [{ id: member.id, confidence: 1 }];
      // inherited
      const inherited = findInherited(table, cls, rest[0], tables, globalByName, 0);
      if (inherited) return [{ id: inherited, confidence: 0.9 }];
      return GENERIC_METHODS.has(rest[0]) ? undefined : fallbackByName(rest[rest.length - 1], globalByName, ['method'], 0.5);
    }
    return undefined;
  }

  // nested qualified in same scope, e.g. calling a nested function
  if (contextQname) {
    const parts = contextQname.split('.');
    while (parts.length) {
      const candidate = table.own.get([...parts, dotted].join('.'));
      if (candidate) return [{ id: candidate.id, confidence: 1 }];
      parts.pop();
    }
  }

  const own = table.own.get(dotted);
  if (own) return [{ id: own.id, confidence: 1 }];

  // variable bound to `new X()` / `X()` in an enclosing scope → treat as instance of X
  if (rest.length > 0) {
    const binding = findBinding(table, head, contextQname);
    if (binding) {
      const ctorTargets = lookupDotted(table, binding.ref, tables, globalByName, undefined);
      const ctorLocal = table.locals.get(binding.ref.split('.')[0]);
      if (ctorLocal?.kind === 'external') return undefined; // instance of a library type
      if (ctorTargets && ctorTargets.length === 1) {
        const owner = findEntryById(tables, ctorTargets[0].id);
        if (owner?.entry.decl.kind === 'class') {
          const member = owner.table.own.get(`${owner.entry.decl.qname}.${rest.join('.')}`);
          if (member) return [{ id: member.id, confidence: 1 }];
          const inherited = findInherited(owner.table, owner.entry, rest[0], tables, globalByName, 0);
          if (inherited) return [{ id: inherited, confidence: 0.9 }];
          return undefined;
        }
      }
    }
  }

  const local = table.locals.get(head);
  if (local) {
    if (local.kind === 'external') return undefined; // calls into libraries are not graphed at symbol level
    if (rest.length === 0) return local.kind === 'symbol' ? [{ id: local.id, confidence: 1 }] : undefined;
    if (local.kind === 'file') {
      const t = [...tables.values()].find((x) => x.fileId === local.id);
      if (!t) return undefined;
      const e = t.own.get(rest.join('.'));
      if (e) return [{ id: e.id, confidence: 1 }];
      const viaExport = t.locals.get(rest[0]);
      if (viaExport?.kind === 'symbol') return [{ id: viaExport.id, confidence: 0.9 }];
      return undefined;
    }
    // symbol-bound local: Class.method / instance.method (instance of imported class unknown → name fallback)
    const owner = findEntryById(tables, local.id);
    if (owner) {
      const member = owner.table.own.get(`${owner.entry.decl.qname}.${rest.join('.')}`);
      if (member) return [{ id: member.id, confidence: 1 }];
      const inherited = findInherited(owner.table, owner.entry, rest[0], tables, globalByName, 0);
      if (inherited) return [{ id: inherited, confidence: 0.9 }];
    }
    return fallbackByName(rest[rest.length - 1], globalByName, ['method']);
  }

  if (rest.length === 0) return fallbackByName(head, globalByName, ['function', 'class']);
  // obj.method() where obj is an untyped variable → cautious method-name fallback
  const last = rest[rest.length - 1];
  if (GENERIC_METHODS.has(last) || last.length < 3) return undefined;
  return fallbackByName(last, globalByName, ['method'], 0.5);
}

function findBinding(table: FileTable, name: string, contextQname?: string): { ref: string; isNew: boolean } | undefined {
  const parts = contextQname ? contextQname.split('.') : [];
  while (true) {
    const b = table.bindings.get(parts.join('.'))?.get(name);
    if (b) return b;
    if (parts.length === 0) return undefined;
    parts.pop();
  }
}

function fallbackByName(name: string, globalByName: Map<string, SymbolEntry[]>, kinds: string[], base = 0.7): Target[] | undefined {
  const cands = (globalByName.get(name) ?? []).filter((e) => kinds.includes(e.decl.kind));
  if (cands.length === 0 || cands.length > 4) return undefined;
  const conf = cands.length === 1 ? base : (base * 0.7) / cands.length;
  return cands.map((c) => ({ id: c.id, confidence: conf }));
}

function enclosingClass(table: FileTable, contextQname?: string): SymbolEntry | undefined {
  if (!contextQname) return undefined;
  const parts = contextQname.split('.');
  while (parts.length) {
    const e = table.own.get(parts.join('.'));
    if (e?.decl.kind === 'class') return e;
    parts.pop();
  }
  return undefined;
}

function findEntryById(tables: Map<string, FileTable>, id: string): { table: FileTable; entry: SymbolEntry } | undefined {
  for (const t of tables.values()) for (const e of t.own.values()) if (e.id === id) return { table: t, entry: e };
  return undefined;
}

function findInherited(
  table: FileTable,
  cls: SymbolEntry,
  member: string,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
  depth: number,
): string | undefined {
  if (depth > 4) return undefined;
  for (const base of cls.decl.extends ?? []) {
    const targets = lookupDotted(table, base, tables, globalByName, undefined);
    if (!targets || targets.length !== 1) continue;
    const owner = findEntryById(tables, targets[0].id);
    if (!owner) continue;
    const m = owner.table.own.get(`${owner.entry.decl.qname}.${member}`);
    if (m) return m.id;
    const deeper = findInherited(owner.table, owner.entry, member, tables, globalByName, depth + 1);
    if (deeper) return deeper;
  }
  return undefined;
}

/* ---------- module resolvers ---------- */

type ModuleTarget = { kind: 'file'; path: string } | { kind: 'external'; ecosystem: string; name: string };

class JsResolver {
  private cache = new Map<string, ModuleTarget | null>();
  constructor(
    private files: Set<string>,
    private d: Discovery,
    private workspacePkgs: Map<string, { dir: string; main?: string }>,
  ) {}

  resolve(from: string, spec: string): ModuleTarget | undefined {
    const key = `${from}\0${spec}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    const r = this.doResolve(from, spec);
    this.cache.set(key, r ?? null);
    return r;
  }

  private doResolve(from: string, spec: string): ModuleTarget | undefined {
    if (spec.startsWith('node:')) return { kind: 'external', ecosystem: 'node', name: spec };
    const fromDir = path.posix.dirname(from);
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const base = spec.startsWith('/') ? spec.slice(1) : path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, spec));
      const f = this.probe(base);
      return f ? { kind: 'file', path: f } : undefined;
    }
    // tsconfig paths / baseUrl
    for (const tc of this.d.tsconfigs) {
      if (tc.dir && !from.startsWith(tc.dir + '/')) continue;
      for (const [pattern, targets] of Object.entries(tc.paths)) {
        const m = matchPattern(pattern, spec);
        if (m === undefined) continue;
        for (const t of targets) {
          const rel = t.replace('*', m);
          const base = path.posix.normalize(path.posix.join(tc.dir, tc.baseUrl ?? '', rel));
          const f = this.probe(base);
          if (f) return { kind: 'file', path: f };
        }
      }
      if (tc.baseUrl) {
        const f = this.probe(path.posix.normalize(path.posix.join(tc.dir, tc.baseUrl, spec)));
        if (f) return { kind: 'file', path: f };
      }
    }
    // workspace packages
    const pkgName = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    const ws = this.workspacePkgs.get(pkgName);
    if (ws) {
      const sub = spec.slice(pkgName.length + 1);
      const candidates = sub ? [path.posix.join(ws.dir, sub)] : [ws.main ? path.posix.join(ws.dir, ws.main) : '', path.posix.join(ws.dir, 'src/index'), path.posix.join(ws.dir, 'index')].filter(Boolean);
      for (const c of candidates) {
        const f = this.probe(path.posix.normalize(c));
        if (f) return { kind: 'file', path: f };
      }
    }
    // '#imports' subpath imports, or a bare 'src/...' style path (common with baseUrl-less setups)
    if (spec.startsWith('#')) {
      const f = this.probe(spec.slice(1)) ?? this.probe('src/' + spec.slice(1));
      if (f) return { kind: 'file', path: f };
    }
    const bare = this.probe(spec);
    if (bare) return { kind: 'file', path: bare };
    return { kind: 'external', ecosystem: 'npm', name: pkgName };
  }

  private probe(base: string): string | undefined {
    base = base.replace(/^\.\//, '');
    if (this.files.has(base) && !base.endsWith('/')) return base;
    // `.js` → `.ts` swap (ESM TS style)
    const stripped = base.replace(/\.(m|c)?jsx?$/, '');
    for (const b of stripped === base ? [base] : [stripped, base]) {
      for (const ext of JS_EXTS) if (this.files.has(b + ext)) return b + ext;
      for (const ext of JS_EXTS) if (this.files.has(`${b}/index${ext}`)) return `${b}/index${ext}`;
    }
    return undefined;
  }
}

function matchPattern(pattern: string, spec: string): string | undefined {
  const star = pattern.indexOf('*');
  if (star < 0) return pattern === spec ? '' : undefined;
  const pre = pattern.slice(0, star);
  const post = pattern.slice(star + 1);
  if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length) return spec.slice(pre.length, spec.length - post.length);
  return undefined;
}

class PyResolver {
  private cache = new Map<string, ModuleTarget | null>();
  constructor(
    private files: Set<string>,
    private d: Discovery,
  ) {}

  resolve(from: string, spec: string): ModuleTarget | undefined {
    const key = `${from}\0${spec}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit ?? undefined;
    const r = this.doResolve(from, spec);
    this.cache.set(key, r ?? null);
    return r;
  }

  private doResolve(from: string, spec: string): ModuleTarget | undefined {
    const dots = /^\.*/.exec(spec)![0].length;
    const rest = spec.slice(dots);
    const fromDir = path.posix.dirname(from);
    if (dots > 0) {
      let base = fromDir === '.' ? '' : fromDir;
      for (let i = 1; i < dots; i++) base = base ? path.posix.dirname(base) : '';
      if (base === '.') base = '';
      const f = this.probeModule(base, rest);
      return f ? { kind: 'file', path: f } : undefined;
    }
    for (const root of this.d.pythonRoots) {
      const f = this.probeModule(root, rest);
      if (f) return { kind: 'file', path: f };
    }
    // relative to current dir (scripts executed from their dir)
    const f = this.probeModule(fromDir === '.' ? '' : fromDir, rest);
    if (f) return { kind: 'file', path: f };
    const top = rest.split('.')[0];
    if (PY_STDLIB.has(top)) return { kind: 'external', ecosystem: 'python-stdlib', name: top };
    return { kind: 'external', ecosystem: 'pypi', name: top };
  }

  private probeModule(base: string, dotted: string): string | undefined {
    const parts = dotted ? dotted.split('.') : [];
    // Try full, then progressively shorter (from a.b import c where c is a symbol in a/b.py)
    for (let n = parts.length; n >= Math.max(1, parts.length - 1); n--) {
      const rel = path.posix.join(base, ...parts.slice(0, n));
      const asFile = rel + '.py';
      const asPkg = path.posix.join(rel, '__init__.py');
      if (this.files.has(asFile)) return asFile;
      if (this.files.has(asPkg)) return asPkg;
    }
    // `from . import x` → package __init__
    if (parts.length === 0 && base) {
      const asPkg = path.posix.join(base, '__init__.py');
      if (this.files.has(asPkg)) return asPkg;
    }
    return undefined;
  }
}

export type { GraphNode };
