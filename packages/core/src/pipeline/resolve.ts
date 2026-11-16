import path from 'node:path';
import type { GraphNode } from '@spider/shared';
import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';
import type { DeclFact, EndpointFact, FileFacts, MountFact } from '../languages/types.js';
import type { Discovery } from './discover.js';
import { resolveCsharpImports } from './resolve-csharp.js';
import { resolveData } from './resolve-data.js';
import { resolveHttp } from './resolve-http.js';
import { resolveJvmImports } from './resolve-jvm.js';
import { resolveNative } from './resolve-native.js';

export interface ResolveStats {
  unresolvedImports: number;
  /** Calls whose head is a local or imported name that failed to bind to a repo symbol. */
  unresolvedCalls: number;
  /** Calls into libraries: head is an external import or an instance of an external type. */
  externalCalls: number;
  resolvedImports: number;
  resolvedCalls: number;
  ambiguousCalls: number;
}

const JS_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.d.ts', '.vue', '.svelte', '.json'];

const JS_BUILTINS = new Set([
  'console',
  'JSON',
  'Math',
  'Object',
  'Array',
  'Promise',
  'String',
  'Number',
  'Boolean',
  'Date',
  'Error',
  'Map',
  'Set',
  'WeakMap',
  'Symbol',
  'Reflect',
  'Proxy',
  'parseInt',
  'parseFloat',
  'setTimeout',
  'setInterval',
  'clearTimeout',
  'clearInterval',
  'require',
  'process',
  'Buffer',
  'window',
  'document',
  'globalThis',
  'RegExp',
  'Intl',
  'fetch',
  'encodeURIComponent',
  'decodeURIComponent',
  'isNaN',
  'isFinite',
  'Number',
  'BigInt',
  'structuredClone',
  'queueMicrotask',
  'super',
  'describe',
  'it',
  'test',
  'expect',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll',
]);
const PY_BUILTINS = new Set([
  'print',
  'len',
  'str',
  'int',
  'float',
  'bool',
  'list',
  'dict',
  'set',
  'tuple',
  'range',
  'enumerate',
  'zip',
  'map',
  'filter',
  'sorted',
  'reversed',
  'isinstance',
  'issubclass',
  'getattr',
  'setattr',
  'hasattr',
  'delattr',
  'type',
  'super',
  'open',
  'iter',
  'next',
  'min',
  'max',
  'sum',
  'abs',
  'round',
  'any',
  'all',
  'repr',
  'format',
  'id',
  'hash',
  'input',
  'vars',
  'dir',
  'callable',
  'ord',
  'chr',
  'bytes',
  'bytearray',
  'object',
  'property',
  'staticmethod',
  'classmethod',
  'Exception',
  'ValueError',
  'TypeError',
  'KeyError',
  'RuntimeError',
  'NotImplementedError',
  'AttributeError',
  'IndexError',
  'StopIteration',
  'frozenset',
  'slice',
  'divmod',
  'pow',
  'globals',
  'locals',
  'exec',
  'eval',
  'compile',
  'memoryview',
  'complex',
  'help',
  'dataclass',
  'field',
  'override',
  'abstractmethod',
  'wraps',
  'lru_cache',
  'cache',
]);
const PY_STDLIB = new Set([
  'os',
  'sys',
  're',
  'json',
  'time',
  'datetime',
  'math',
  'random',
  'typing',
  'collections',
  'itertools',
  'functools',
  'pathlib',
  'logging',
  'subprocess',
  'threading',
  'multiprocessing',
  'asyncio',
  'io',
  'abc',
  'enum',
  'dataclasses',
  'copy',
  'pickle',
  'struct',
  'socket',
  'ssl',
  'http',
  'urllib',
  'email',
  'uuid',
  'hashlib',
  'hmac',
  'base64',
  'shutil',
  'tempfile',
  'glob',
  'fnmatch',
  'argparse',
  'configparser',
  'csv',
  'sqlite3',
  'decimal',
  'fractions',
  'statistics',
  'string',
  'textwrap',
  'unicodedata',
  'operator',
  'contextlib',
  'inspect',
  'traceback',
  'warnings',
  'weakref',
  'types',
  'queue',
  'heapq',
  'bisect',
  'array',
  'secrets',
  'signal',
  'select',
  'errno',
  'platform',
  'importlib',
  'unittest',
  'pprint',
  'zipfile',
  'tarfile',
  'gzip',
  'zlib',
  'html',
  'xml',
  'ctypes',
  'concurrent',
  'numbers',
  'codecs',
  'locale',
  'gettext',
  'calendar',
  'zoneinfo',
  'builtins',
  '__future__',
  'ast',
  'dis',
  'tokenize',
  'token',
  'keyword',
  'sched',
  'timeit',
  'cProfile',
  'profile',
  'pdb',
  'doctest',
  'site',
  'atexit',
  'getpass',
  'shlex',
  'mimetypes',
  'webbrowser',
  'wsgiref',
  'ipaddress',
  'graphlib',
  'stat',
  'filecmp',
  'linecache',
  'fileinput',
  'tomllib',
]);

export interface SymbolEntry {
  id: string;
  decl: DeclFact;
}

export interface FileTable {
  path: string;
  fileId: string;
  facts: FileFacts;
  /** qname → symbol id for own declarations. */
  own: Map<string, SymbolEntry>;
  /** local binding name → bound entity (symbol id, or file id for namespaces). */
  locals: Map<string, { kind: 'symbol' | 'file' | 'external'; id: string }>;
  /** scope qname ('' = module) → variable name → constructor/factory/annotation reference. */
  bindings: Map<string, Map<string, Binding>>;
  /** Shared resolution context (module resolvers, id indices). */
  ctx: ResolveCtx;
  /** Statically typed language: unbound names are never guessed by name (set by its import resolver). */
  strict?: boolean;
}

interface ResolveCtx {
  js: JsResolver;
  py: PyResolver;
  byId: Map<string, { table: FileTable; entry: SymbolEntry }>;
  byFileId: Map<string, FileTable>;
}

export interface Binding {
  ref: string;
  isNew: boolean;
  isType?: boolean;
  /** Scope the binding was declared in ('' = module). */
  scope: string;
}

/** HTTP verbs a class-based view (`View.as_view()`) can implement as methods. */
const CBV_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

const GENERIC_METHODS = new Set([
  'get',
  'set',
  'add',
  'remove',
  'push',
  'pop',
  'map',
  'filter',
  'then',
  'catch',
  'on',
  'off',
  'emit',
  'json',
  'send',
  'status',
  'toString',
  'has',
  'keys',
  'values',
  'entries',
  'call',
  'apply',
  'bind',
  'slice',
  'concat',
  'sort',
  'reverse',
  'indexOf',
  'includes',
  'test',
  'match',
  'replace',
  'trim',
  'split',
  'join',
  'write',
  'read',
  'end',
  'close',
  'open',
  'next',
  'done',
  'resolve',
  'reject',
  'log',
  'error',
  'warn',
  'info',
  'debug',
  'append',
  'extend',
  'items',
  'update',
  'copy',
  'clear',
  'format',
  'strip',
  'lower',
  'upper',
  'encode',
  'decode',
  'startswith',
  'endswith',
  'exists',
  'delete',
  'post',
  'put',
  'patch',
  'use',
  'listen',
  'forEach',
  'some',
  'every',
  'reduce',
  'flat',
  'find',
  'findIndex',
  'fill',
  'length',
  'size',
  'toJSON',
  'valueOf',
  'assign',
  'freeze',
  'query',
  'execute',
  'commit',
  'rollback',
  'connect',
  'disconnect',
  'run',
]);

export function resolve(g: GraphBuilder, d: Discovery, all: Map<string, FileFacts>): ResolveStats {
  const stats: ResolveStats = {
    unresolvedImports: 0,
    unresolvedCalls: 0,
    externalCalls: 0,
    resolvedImports: 0,
    resolvedCalls: 0,
    ambiguousCalls: 0,
  };
  const filesByPath = new Set(d.files.map((f) => f.path));
  const tables = new Map<string, FileTable>();
  const globalByName = new Map<string, SymbolEntry[]>();
  const workspacePkgs = new Map<string, { dir: string; main?: string }>();
  for (const m of d.manifests)
    if (m.ecosystem === 'npm' && m.name)
      workspacePkgs.set(m.name, { dir: m.dir, main: (m.extra.main as string) ?? (m.extra.module as string) });

  const jsResolver = new JsResolver(filesByPath, d, workspacePkgs);
  const pyResolver = new PyResolver(filesByPath, d);
  const ctx: ResolveCtx = { js: jsResolver, py: pyResolver, byId: new Map(), byFileId: new Map() };

  /* ---------- 1. symbol nodes ---------- */
  for (const [p, facts] of all) {
    const fileId = ids.file(p);
    const table: FileTable = { path: p, fileId, facts, own: new Map(), locals: new Map(), bindings: new Map(), ctx };
    ctx.byFileId.set(fileId, table);
    facts.bindings ??= [];
    facts.references ??= [];
    facts.mounts ??= [];
    facts.routers ??= [];
    tables.set(p, table);
    for (const b of facts.bindings) {
      const key = b.scopeQname ?? '';
      let m = table.bindings.get(key);
      if (!m) table.bindings.set(key, (m = new Map()));
      m.set(b.name, { ref: b.ref, isNew: b.isNew, isType: b.isType, scope: key });
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
      ctx.byId.set(node.id, { table, entry });
      if (!decl.parentQname) table.locals.set(decl.name, { kind: 'symbol', id: node.id });
      let list = globalByName.get(decl.name);
      if (!list) globalByName.set(decl.name, (list = []));
      list.push(entry);
      if (decl.isExported) g.addEdge('exports', fileId, node.id);
    }
  }

  const allTables = [...tables.values()];
  // Go / Rust: package & module scoping in resolve-native.ts (their tables leave `tables` here)
  resolveNative(g, d, tables, globalByName, stats, emitEndpoint);

  /* ---------- 2. import resolution ---------- */
  for (const table of tables.values()) {
    const { facts, fileId, path: p } = table;
    if (facts.language === 'java' || facts.language === 'kotlin' || facts.language === 'csharp') continue;
    for (const imp of facts.imports) {
      const target =
        facts.language === 'python' ? pyResolver.resolve(p, imp.specifier) : jsResolver.resolve(p, imp.specifier);
      if (!target) {
        stats.unresolvedImports++;
        continue;
      }
      stats.resolvedImports++;
      if (target.kind === 'external') {
        const extId = ids.external(target.ecosystem, target.name);
        if (!g.hasNode(extId))
          g.addNode({
            id: extId,
            kind: 'external',
            name: target.name,
            qname: `${target.ecosystem}:${target.name}`,
            props: { ecosystem: target.ecosystem, inferred: true },
          });
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
          const all = targetTable?.facts.hints.__all__ as string[] | undefined;
          if (targetTable && all) {
            // `from pkg import *` honours `__all__`, which may name re-exported imports
            for (const name of all) {
              const b = bindExport(targetTable, name, tables, jsResolver, pyResolver, 0);
              if (b) table.locals.set(name, b);
            }
          } else if (targetTable)
            for (const [qn, e] of targetTable.own)
              if (!e.decl.parentQname) table.locals.set(qn, { kind: 'symbol', id: e.id });
          continue;
        }
        const bound = targetTable ? bindExport(targetTable, n.imported, tables, jsResolver, pyResolver, 0) : undefined;
        if (bound) table.locals.set(n.local, bound);
        else if (facts.language === 'python' && targetTable) {
          // `from pkg import submodule`
          const sub = pyResolver.resolve(p, subModule(imp.specifier, n.imported));
          if (sub && sub.kind === 'file') {
            table.locals.set(n.local, { kind: 'file', id: ids.file(sub.path) });
            g.addEdge('imports', fileId, ids.file(sub.path), { evidence: imp.span });
          } else table.locals.set(n.local, { kind: 'file', id: targetId });
        } else table.locals.set(n.local, { kind: 'file', id: targetId });
      }
    }
  }

  resolveJvmImports(g, d, tables, stats);
  resolveCsharpImports(g, d, tables, stats);

  /* ---------- 3. inheritance ---------- */
  for (const table of tables.values()) {
    for (const [qn, entry] of table.own) {
      const decl = entry.decl;
      if (decl.kind !== 'class') continue;
      for (const [rel, names] of [
        ['extends', decl.extends ?? []],
        ['implements', decl.implements ?? []],
      ] as const) {
        for (const name of names) {
          const target = lookupDotted(table, name, tables, globalByName, qn);
          if (target?.length === 1) g.addEdge(rel, entry.id, target[0].id, { evidence: decl.span });
          else if (target && target.length > 1)
            for (const t of target)
              g.addEdge(rel, entry.id, t.id, {
                confidence: 1 / target.length,
                props: { ambiguous: true },
                evidence: decl.span,
              });
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
      const callerId = call.callerQname
        ? (table.own.get(call.callerQname)?.id ?? nearestOwner(table, call.callerQname))
        : table.fileId;
      let targets = lookupDotted(table, call.callee, tables, globalByName, call.callerQname);
      if (table.strict) targets = targets?.filter((t) => t.confidence >= 0.9);
      if (!targets || targets.length === 0) {
        const kind = classifyUnbound(table, first, call.callerQname);
        if (kind === 'external') stats.externalCalls++;
        else if (kind === 'unresolved') stats.unresolvedCalls++;
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

  /* ---------- 5. references (annotations, generics, decorators) ---------- */
  for (const table of tables.values()) {
    for (const r of table.facts.references ?? []) {
      const head = r.name.split('.')[0];
      if (builtins(table.facts.language).has(head)) continue;
      const src = r.scopeQname ? (table.own.get(r.scopeQname)?.id ?? nearestOwner(table, r.scopeQname)) : table.fileId;
      const t = lookupDotted(table, r.name, tables, globalByName, r.scopeQname);
      // exact bindings only: a name-matched type is a guess, and references claim confidence 1
      if (t?.length !== 1 || t[0].confidence < 1 || t[0].id === src) continue;
      g.addEdge('references', src, t[0].id, { evidence: r.span });
    }
  }

  /* ---------- 6. endpoints (with cross-file mount prefixes) ---------- */
  const routes = resolveMounts(tables, globalByName);
  for (const table of tables.values()) {
    for (const ep of table.facts.endpoints) {
      if (routes.suppressed.has(spanKey(table.path, ep.span))) continue; // `.use('/x', router)` is a mount, not a route
      let handlerRef = ep.handlerRef;
      const isCbv = !!handlerRef?.endsWith('.as_view');
      if (handlerRef && isCbv) handlerRef = handlerRef.slice(0, -'.as_view'.length);
      let handler: Target[] | undefined;
      if (handlerRef) {
        const own = table.own.get(handlerRef);
        handler = own
          ? [{ id: own.id, confidence: 1 }]
          : lookupDotted(table, handlerRef, tables, globalByName, ep.enclosingQname);
      }
      if ((!handler || handler.length === 0) && ep.enclosingQname) {
        const own = table.own.get(ep.enclosingQname);
        if (own) handler = [{ id: own.id, confidence: 1 }];
      }
      // Django / Flask class-based views: one endpoint per HTTP-verb method the class defines
      const cbv = isCbv && handler?.length === 1 ? table.ctx.byId.get(handler[0].id) : undefined;
      const verbs =
        cbv?.entry.decl.kind === 'class' && ep.method === 'ANY'
          ? CBV_METHODS.map((m) => cbv.table.own.get(`${cbv.entry.decl.qname}.${m}`)).filter(
              (e): e is SymbolEntry => !!e,
            )
          : [];
      for (const path of routes.pathsOf(table, ep)) {
        if (verbs.length === 0) {
          emitEndpoint(g, table, ep, ep.method, path, handler ?? []);
          continue;
        }
        for (const v of verbs)
          emitEndpoint(g, table, ep, v.decl.name.toUpperCase(), path, [{ id: v.id, confidence: 1 }]);
      }
    }
  }

  /* ---------- 7. cross-language HTTP calls (C-19) and datastores (C-20) ---------- */
  resolveHttp(g, allTables);
  resolveData(g, allTables, tables, globalByName);

  return stats;
}

/* ---------- helpers ---------- */

export function nearestOwner(table: FileTable, qname: string): string {
  const parts = qname.split('.');
  while (parts.length) {
    const e = table.own.get(parts.join('.'));
    if (e) return e.id;
    parts.pop();
  }
  return table.fileId;
}

type Bound = { kind: 'symbol' | 'file' | 'external'; id: string };

/** Resolves an exported name in a target file to a symbol (following re-exports and barrels). */
function bindExport(
  target: FileTable,
  name: string,
  tables: Map<string, FileTable>,
  js: JsResolver,
  py: PyResolver,
  depth: number,
): Bound | undefined {
  if (depth > 5) return undefined;
  const own = target.own.get(name);
  if (own && !own.decl.parentQname) return { kind: 'symbol', id: own.id };
  for (const ex of target.facts.exports) {
    if (ex.name !== name && ex.name !== '*') continue;
    if (ex.from) {
      const r =
        target.facts.language === 'python' ? py.resolve(target.path, ex.from) : js.resolve(target.path, ex.from);
      if (!r || r.kind !== 'file') continue;
      const t2 = tables.get(r.path);
      if (!t2) return { kind: 'file', id: ids.file(r.path) };
      const inner = bindExport(t2, ex.name === '*' ? name : (ex.local ?? name), tables, js, py, depth + 1);
      if (inner) return inner;
    } else if (ex.local) {
      const o = target.own.get(ex.local);
      if (o) return { kind: 'symbol', id: o.id };
      // `import { X } from './x'; export { X }` / `export default X`
      const imported = bindImported(target, ex.local, tables, js, py, depth);
      if (imported) return imported;
    }
  }
  // python: names imported into a module (`__init__.py` barrels) are importable from it
  if (target.facts.language === 'python') {
    const imported = bindImported(target, name, tables, js, py, depth);
    if (imported) return imported;
  }
  if (name === 'default' && own) return { kind: 'symbol', id: own.id };
  return undefined;
}

/** What a file's own import statement binds `name` to — independent of import-loop order. */
function bindImported(
  target: FileTable,
  name: string,
  tables: Map<string, FileTable>,
  js: JsResolver,
  py: PyResolver,
  depth: number,
): Bound | undefined {
  const isPy = target.facts.language === 'python';
  for (const imp of target.facts.imports) {
    const n = imp.names.find((x) => x.local === name);
    if (!n && imp.namespace !== name) continue;
    const r = isPy ? py.resolve(target.path, imp.specifier) : js.resolve(target.path, imp.specifier);
    if (!r) continue;
    if (r.kind === 'external') return { kind: 'external', id: ids.external(r.ecosystem, r.name) };
    if (!n) return { kind: 'file', id: ids.file(r.path) };
    const t2 = tables.get(r.path);
    const inner = t2 ? bindExport(t2, n.imported, tables, js, py, depth + 1) : undefined;
    if (inner) return inner;
    if (isPy) {
      // `from pkg import submodule`
      const sub = py.resolve(target.path, subModule(imp.specifier, n.imported));
      if (sub?.kind === 'file' && sub.path !== r.path) return { kind: 'file', id: ids.file(sub.path) };
    }
  }
  return undefined;
}

interface Target {
  id: string;
  confidence: number;
}

/** Member `rest` of a class (own, else inherited at 0.9). */
function memberOf(
  owner: { table: FileTable; entry: SymbolEntry },
  rest: string[],
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
): Target[] | undefined {
  const member = owner.table.own.get(`${owner.entry.decl.qname}.${rest.join('.')}`);
  if (member) return [{ id: member.id, confidence: 1 }];
  const inherited = findInherited(owner.table, owner.entry, rest[0], tables, globalByName, 0);
  if (inherited) return [{ id: inherited, confidence: 0.9 }];
  return undefined;
}

/**
 * The class a bound variable is an instance of: `new X()` / `X()` / `x: X` / `x = await svc.find()` when
 * `find` has an annotated return type. `'external'` for library types, undefined when unknown.
 */
function classOfBinding(
  table: FileTable,
  b: Binding,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
  depth: number,
): { table: FileTable; entry: SymbolEntry } | 'external' | undefined {
  if (table.locals.get(b.ref.split('.')[0])?.kind === 'external') return 'external';
  const targets = lookupDotted(table, b.ref, tables, globalByName, b.scope || undefined, depth + 1);
  if (targets?.length !== 1) return undefined;
  // an annotation must bind exactly; constructor calls keep their historical leniency
  if ((b.isType || !b.isNew) && targets[0].confidence < 1) return undefined;
  const owner = table.ctx.byId.get(targets[0].id);
  if (!owner) return undefined;
  if (owner.entry.decl.kind === 'class') return b.isType || b.isNew || !b.ref.includes('.') ? owner : undefined;
  // a call: type the result from the callee's annotated return type — only when the callee itself bound exactly
  const ret = owner.entry.decl.returns;
  if (!ret || depth > 4 || targets[0].confidence < 1) return undefined;
  if (owner.table.locals.get(ret.split('.')[0])?.kind === 'external') return 'external';
  const rt = lookupDotted(owner.table, ret, tables, globalByName, owner.entry.decl.parentQname, depth + 1);
  if (rt?.length !== 1 || rt[0].confidence < 1) return undefined;
  const cls = table.ctx.byId.get(rt[0].id);
  return cls?.entry.decl.kind === 'class' ? cls : undefined;
}

/** Interfaces declare no method bodies: typing a receiver to one would only lose recall. */
function isInterface(owner: { entry: SymbolEntry }): boolean {
  return owner.entry.decl.classKind === 'interface';
}

/**
 * Resolves a dotted reference (`foo`, `ns.foo`, `Class.method`, `this.method`, `obj.method`) from a file.
 */
export function lookupDotted(
  table: FileTable,
  dotted: string,
  tables: Map<string, FileTable>,
  globalByName: Map<string, SymbolEntry[]>,
  contextQname?: string,
  depth = 0,
): Target[] | undefined {
  if (depth > 6) return undefined;
  const segs = dotted.split('.').filter(Boolean);
  if (segs.length === 0) return undefined;
  const [head, ...rest] = segs;

  // this/self/cls → enclosing class
  if (head === 'this' || head === 'self' || head === 'cls' || head === 'super') {
    const cls = enclosingClass(table, contextQname);
    if (cls && rest.length) {
      const member = table.own.get(`${cls.decl.qname}.${rest.join('.')}`);
      if (member) return [{ id: member.id, confidence: 1 }];
      // this.repo.find() where `repo` is a typed field / constructor parameter property
      const field = rest.length > 1 ? table.bindings.get(cls.decl.qname)?.get(`${head}.${rest[0]}`) : undefined;
      if (field) {
        const owner = classOfBinding(table, field, tables, globalByName, depth);
        if (owner === 'external') return undefined;
        const m = owner ? memberOf(owner, rest.slice(1), tables, globalByName) : undefined;
        if (owner && (m || !isInterface(owner))) return m; // interfaces bind only when they declare the member
      }
      // inherited
      const inherited = findInherited(table, cls, rest[0], tables, globalByName, 0);
      if (inherited) return [{ id: inherited, confidence: 0.9 }];
      return GENERIC_METHODS.has(rest[0])
        ? undefined
        : fallbackByName(rest[rest.length - 1], globalByName, ['method'], 0.5);
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

  // variable bound to `new X()` / `X()` / `x: X` / an annotated call result → instance of X
  if (rest.length > 0) {
    const binding = findBinding(table, head, contextQname);
    if (binding) {
      const owner = classOfBinding(table, binding, tables, globalByName, depth);
      if (owner === 'external') return undefined; // instance of a library type
      const m = owner ? memberOf(owner, rest, tables, globalByName) : undefined;
      if (owner && (m || !isInterface(owner))) return m; // interfaces bind only when they declare the member
    }
  }

  const local = table.locals.get(head);
  if (local) {
    if (local.kind === 'external') return undefined; // calls into libraries are not graphed at symbol level
    if (rest.length === 0) return local.kind === 'symbol' ? [{ id: local.id, confidence: 1 }] : undefined;
    if (local.kind === 'file') {
      const t = table.ctx.byFileId.get(local.id);
      if (!t) return undefined;
      const e = t.own.get(rest.join('.'));
      if (e) return [{ id: e.id, confidence: 1 }];
      // namespace import of a barrel: `import * as S from './services'; S.UserService.create()`
      const viaExport = bindExport(t, rest[0], tables, table.ctx.js, table.ctx.py, 0);
      if (viaExport?.kind !== 'symbol') return undefined;
      // `ns.fn.call(thisArg, …)` / `.apply` invoke `fn` itself
      if (rest.length === 1 || (rest.length === 2 && (rest[1] === 'call' || rest[1] === 'apply')))
        return [{ id: viaExport.id, confidence: 1 }];
      const owner = table.ctx.byId.get(viaExport.id);
      return owner?.entry.decl.kind === 'class' ? memberOf(owner, rest.slice(1), tables, globalByName) : undefined;
    }
    // symbol-bound local: Class.method / instance.method (instance of imported class unknown → name fallback)
    const owner = table.ctx.byId.get(local.id);
    if (owner) {
      const m = memberOf(owner, rest, tables, globalByName);
      if (m) return m;
    }
    return fallbackByName(rest[rest.length - 1], globalByName, ['method']);
  }

  if (rest.length === 0) return fallbackByName(head, globalByName, ['function', 'class']);
  // obj.method() where obj is an untyped variable → cautious method-name fallback
  const last = rest[rest.length - 1];
  if (GENERIC_METHODS.has(last) || last.length < 3) return undefined;
  return fallbackByName(last, globalByName, ['method'], 0.5);
}

/** Why a call head did not bind: a library call, a known name that failed, or an unknown name (not counted). */
function classifyUnbound(table: FileTable, head: string, contextQname?: string): 'external' | 'unresolved' | 'unknown' {
  const local = table.locals.get(head);
  if (local?.kind === 'external') return 'external';
  const binding = findBinding(table, head, contextQname);
  if (binding && table.locals.get(binding.ref.split('.')[0])?.kind === 'external') return 'external';
  if (local || binding || table.own.has(head)) return 'unresolved';
  return 'unknown';
}

export function findBinding(table: FileTable, name: string, contextQname?: string): Binding | undefined {
  const parts = contextQname ? contextQname.split('.') : [];
  while (true) {
    const b = table.bindings.get(parts.join('.'))?.get(name);
    if (b) return b;
    if (parts.length === 0) return undefined;
    parts.pop();
  }
}

function fallbackByName(
  name: string,
  globalByName: Map<string, SymbolEntry[]>,
  kinds: string[],
  base = 0.7,
): Target[] | undefined {
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
    const owner = table.ctx.byId.get(targets[0].id);
    if (!owner) continue;
    const m = owner.table.own.get(`${owner.entry.decl.qname}.${member}`);
    if (m) return m.id;
    const deeper = findInherited(owner.table, owner.entry, member, tables, globalByName, depth + 1);
    if (deeper) return deeper;
  }
  return undefined;
}

/** `from pkg import sub` → `pkg.sub`; `from . import sub` → `.sub` (not `..sub`). */
function subModule(spec: string, name: string): string {
  if (!spec) return name;
  return spec.endsWith('.') ? `${spec}${name}` : `${spec}.${name}`;
}

/* ---------- endpoints & mounts ---------- */

function spanKey(file: string, span: { startLine: number; startCol: number }): string {
  return `${file}:${span.startLine}:${span.startCol}`;
}

function joinUrl(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a.replace(/\/+$/, '')}/${b.replace(/^\/+/, '')}`;
}

function emitEndpoint(
  g: GraphBuilder,
  table: FileTable,
  ep: EndpointFact,
  method: string,
  path: string,
  handler: Target[],
): void {
  const id = ids.endpoint(table.path, method, path, ep.span.startLine);
  g.addNode({
    id,
    kind: 'endpoint',
    name: `${method} ${path}`,
    qname: `${table.path}::${method} ${path}`,
    file: table.path,
    language: table.facts.language,
    parentId: table.fileId,
    span: ep.span,
    metrics: { fanIn: 0, fanOut: 0 },
    props: {
      method,
      path,
      framework: ep.framework,
      protocol: method === 'WS' ? 'ws' : 'http',
      isTest: g.getNode(table.fileId)?.props.isTest ?? false,
    },
  });
  for (const h of handler) g.addEdge('exposes', id, h.id, { evidence: ep.span, confidence: 1 / handler.length });
}

interface ResolvedMount {
  parent?: string;
  prefix: string;
  replaces: boolean;
}

/**
 * Cross-file route prefixes. Keys are symbol ids of router variables (`router`, `bp`, `urlpatterns`)
 * or NestJS controller/module classes; a mount says "child key is served under parent key + prefix".
 */
function resolveMounts(tables: Map<string, FileTable>, globalByName: Map<string, SymbolEntry[]>) {
  const exact = (table: FileTable, ref: string): string | undefined => {
    const own = table.own.get(ref);
    if (own) return own.id;
    const t = lookupDotted(table, ref, tables, globalByName, undefined);
    return t?.length === 1 && t[0].confidence === 1 ? t[0].id : undefined;
  };
  const urlpatternsOf = (path: string | undefined) => (path ? tables.get(path)?.own.get('urlpatterns')?.id : undefined);
  const mountKey = (table: FileTable, m: MountFact): string | undefined => {
    if (m.targetIsModule) {
      const r = table.ctx.py.resolve(table.path, m.target);
      return r?.kind === 'file' ? urlpatternsOf(r.path) : undefined;
    }
    const local = table.locals.get(m.target);
    if (local?.kind === 'file') return urlpatternsOf(table.ctx.byFileId.get(local.id)?.path);
    const key = exact(table, m.target);
    if (key || table.facts.language !== 'python' || m.parent !== 'urlpatterns') return key;
    const r = table.ctx.py.resolve(table.path, m.target); // include(users.urls)
    return r?.kind === 'file' ? urlpatternsOf(r.path) : undefined;
  };

  const ownPrefix = new Map<string, string>();
  const receiverKeys = new Set<string>();
  const epKey = new Map<EndpointFact, string>();
  for (const table of tables.values()) {
    for (const r of table.facts.routers ?? []) {
      const id = table.own.get(r.name)?.id;
      if (id) ownPrefix.set(id, r.prefix);
    }
    for (const ep of table.facts.endpoints) {
      const key = ep.receiver ? exact(table, ep.receiver) : undefined;
      if (!key) continue;
      epKey.set(ep, key);
      receiverKeys.add(key);
    }
  }
  const pending: { table: FileTable; m: MountFact; child: string; parent?: string }[] = [];
  const globals = new Map<string, Set<string>>();
  const parentKeys = new Set<string>();
  for (const table of tables.values()) {
    for (const m of table.facts.mounts ?? []) {
      if (m.global) {
        const set = globals.get(m.framework ?? '') ?? new Set<string>();
        set.add(m.prefix);
        globals.set(m.framework ?? '', set);
        continue;
      }
      const child = mountKey(table, m);
      if (!child) continue;
      const parent = m.parent ? exact(table, m.parent) : undefined;
      if (parent) parentKeys.add(parent);
      pending.push({ table, m, child, parent });
    }
  }
  const mountsOf = new Map<string, ResolvedMount[]>();
  const suppressed = new Set<string>();
  for (const { table, m, child, parent } of pending) {
    // only routers are mounted; `app.use('/x', authMiddleware)` stays a middleware route
    if (!ownPrefix.has(child) && !receiverKeys.has(child) && !parentKeys.has(child)) continue;
    const list = mountsOf.get(child) ?? [];
    list.push({ parent, prefix: m.prefix, replaces: !!m.replacesOwnPrefix });
    mountsOf.set(child, list);
    suppressed.add(spanKey(table.path, m.span));
  }

  const prefixesOf = (key: string, depth: number): string[] => {
    const own = ownPrefix.get(key) ?? '';
    const ms = mountsOf.get(key);
    if (!ms || depth > 6) return [own];
    const out = new Set<string>();
    for (const m of ms) {
      const base = m.replaces && m.prefix ? m.prefix : joinUrl(m.prefix, own);
      for (const pp of m.parent ? prefixesOf(m.parent, depth + 1) : ['']) out.add(joinUrl(pp, base));
    }
    return [...out].slice(0, 8);
  };

  const pathsOf = (table: FileTable, ep: EndpointFact): string[] => {
    const key = epKey.get(ep);
    let paths = [ep.path];
    if (key && mountsOf.has(key)) {
      const rp = ep.receiverPrefix;
      let rest = rp && ep.path.startsWith(rp) ? ep.path.slice(rp.length) : ep.path;
      // JS routers serve `/` under a prefix at the bare prefix (koa-router, Hono, Express); Python keeps the slash
      if (rest === '/' && table.facts.language !== 'python') rest = '';
      paths = prefixesOf(key, 0).map((p) => joinUrl(p, rest) || '/');
    }
    const gp = globals.get(ep.framework);
    // several apps with different global prefixes → don't guess
    if (gp?.size === 1) paths = paths.map((p) => joinUrl([...gp][0], p));
    return paths.map((p) => (p.startsWith('/') || p === '*' || p.startsWith('http') ? p : `/${p}`));
  };
  return { suppressed, pathsOf };
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
      const base = spec.startsWith('/')
        ? spec.slice(1)
        : path.posix.normalize(path.posix.join(fromDir === '.' ? '' : fromDir, spec));
      const f = this.probe(base);
      return f ? { kind: 'file', path: f } : undefined;
    }
    // tsconfig paths / baseUrl
    for (const tc of this.d.tsconfigs) {
      if (tc.dir && !from.startsWith(`${tc.dir}/`)) continue;
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
      const candidates = sub
        ? [path.posix.join(ws.dir, sub)]
        : [
            ws.main ? path.posix.join(ws.dir, ws.main) : '',
            path.posix.join(ws.dir, 'src/index'),
            path.posix.join(ws.dir, 'index'),
          ].filter(Boolean);
      for (const c of candidates) {
        const f = this.probe(path.posix.normalize(c));
        if (f) return { kind: 'file', path: f };
      }
    }
    // '#imports' subpath imports, or a bare 'src/...' style path (common with baseUrl-less setups)
    if (spec.startsWith('#')) {
      const f = this.probe(spec.slice(1)) ?? this.probe(`src/${spec.slice(1)}`);
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
  if (spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length)
    return spec.slice(pre.length, spec.length - post.length);
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
      const asFile = `${rel}.py`;
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
