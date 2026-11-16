import path from 'node:path';
import type { Span } from '@spider/shared';
import { ids } from '../graph/ids.js';
import { defaultAlias } from '../languages/go/extractor.js';
import type { Discovery } from './discover.js';
import type { NativeEngine, NativeLang, Res, Sym } from './resolve-native.js';
import type { FileTable } from './resolve.js';

interface Pkg {
  dir: string;
  name: string;
  files: FileTable[];
  /** Package-level declarations (functions, types, vars) across all files of the package. */
  syms: Map<string, Sym>;
}

interface Alias {
  pkg?: Pkg;
  ext?: boolean;
  span: Span;
  /** Files of `pkg` whose symbols this file uses through the alias. */
  used: Set<string>;
}

/**
 * Go: `go.mod` module paths map import paths to package directories; a package's scope is every
 * file in its directory declaring the same package name; methods attach to receiver types package-wide.
 */
export function goLang(e: NativeEngine, d: Discovery): NativeLang {
  const pkgs = new Map<string, Pkg>();
  const pkgOf = new Map<string, Pkg>();
  for (const t of e.tables.values()) {
    const dir = path.posix.dirname(t.path) === '.' ? '' : path.posix.dirname(t.path);
    const name = (t.facts.hints.goPackage as string | undefined) ?? '';
    const key = `${dir}\0${name}`;
    let p = pkgs.get(key);
    if (!p) pkgs.set(key, (p = { dir, name, files: [], syms: new Map() }));
    p.files.push(t);
    pkgOf.set(t.path, p);
    for (const entry of t.own.values()) if (!entry.decl.parentQname) p.syms.set(entry.decl.qname, { table: t, entry });
  }
  const dirPkg = new Map<string, Pkg>();
  for (const p of pkgs.values()) if (!p.name.endsWith('_test') && p.name !== 'main') dirPkg.set(p.dir, p);
  const modules = d.manifests.filter((m) => m.ecosystem === 'go').sort((a, b) => b.name.length - a.name.length);
  const deps = modules.flatMap((m) => m.deps.map((x) => x.name)).sort((a, b) => b.length - a.length);
  const aliases = new Map<string, Map<string, Alias>>();
  const dots = new Map<string, Pkg[]>();

  const target = (spec: string): { pkg?: Pkg; local: boolean } => {
    for (const m of modules) {
      if (spec !== m.name && !spec.startsWith(`${m.name}/`)) continue;
      const dir = path.posix.join(m.dir, spec.slice(m.name.length + 1));
      return { pkg: dirPkg.get(dir === '.' ? '' : dir), local: true };
    }
    return { local: false };
  };
  const extOf = (spec: string): string => {
    if (!spec.split('/')[0].includes('.')) return e.external('go-stdlib', spec);
    const dep = deps.find((x) => spec === x || spec.startsWith(`${x}/`));
    const segs = spec.split('/');
    return e.external('go', dep ?? (/^(github|gitlab|bitbucket)\./.test(segs[0]) ? segs.slice(0, 3).join('/') : spec));
  };

  const ref = (table: FileTable, r: string): Res => {
    const segs = r.split('.');
    const pkg = pkgOf.get(table.path);
    const pkgSym = (name: string): Sym | undefined =>
      pkg?.syms.get(name) ??
      dots
        .get(table.path)
        ?.map((p) => p.syms.get(name))
        .find(Boolean);
    const a = aliases.get(table.path)?.get(segs[0]);
    if (segs.length === 1) {
      const s = pkgSym(segs[0]);
      return s ? { kind: 'sym', sym: s, conf: 1 } : undefined;
    }
    let type: Sym | undefined;
    let rest = segs.slice(1);
    if (a) {
      if (a.ext) return { kind: 'ext' };
      const s = a.pkg?.syms.get(segs[1]);
      if (!s) return { kind: 'missing' };
      a.used.add(s.table.path);
      if (segs.length === 2) return { kind: 'sym', sym: s, conf: 1 };
      type = s;
      rest = segs.slice(2);
    } else type = pkgSym(segs[0]);
    // method expression `T.Method` (also `T.ServeHTTP` for handler types)
    if (type?.entry.decl.kind !== 'class' || rest.length !== 1) return undefined;
    return e.member(type, rest[0]);
  };

  return {
    isPath: (callee) => !callee.includes('.'),
    ref: (table, r) => ref(table, r),
    head(table, segs) {
      const n = aliases.get(table.path)?.has(segs[0]) ? 2 : 1;
      return { res: ref(table, segs.slice(0, n).join('.')), used: n };
    },
    prepare() {
      for (const t of e.tables.values()) {
        const map = new Map<string, Alias>();
        aliases.set(t.path, map);
        for (const imp of t.facts.imports) {
          const tg = target(imp.specifier);
          if (tg.local && !tg.pkg) {
            e.stats.unresolvedImports++;
            continue;
          }
          e.stats.resolvedImports++;
          const name = imp.namespace ?? tg.pkg?.name ?? defaultAlias(imp.specifier);
          if (!tg.pkg) {
            e.g.addEdge('imports', t.fileId, extOf(imp.specifier), { evidence: imp.span });
            if (name !== '_') map.set(name, { ext: true, span: imp.span, used: new Set() });
            continue;
          }
          if (imp.names[0]?.imported === '*') dots.set(t.path, [...(dots.get(t.path) ?? []), tg.pkg]);
          map.set(name === '_' || imp.names[0]?.imported === '*' ? `\0${imp.specifier}` : name, {
            pkg: tg.pkg,
            span: imp.span,
            used: new Set(),
          });
        }
      }
      for (const p of pkgs.values())
        for (const t of p.files)
          for (const entry of t.own.values()) {
            const owner = entry.decl.parentQname && p.syms.get(entry.decl.parentQname);
            if (owner && entry.decl.kind === 'method') e.addMethod(owner, entry.decl.name, { table: t, entry });
          }
      // embedded structs / interfaces: promoted methods
      for (const t of e.tables.values())
        for (const entry of t.own.values())
          for (const x of entry.decl.extends ?? []) {
            const r = ref(t, x);
            if (r?.kind !== 'sym' || r.sym.entry.decl.kind !== 'class') continue;
            e.addSuper({ table: t, entry }, r.sym);
            e.g.addEdge('extends', entry.id, r.sym.entry.id, { evidence: entry.decl.span });
          }
    },
    finish() {
      // a Go import names a package: link the files whose symbols are used (all of them when none is seen)
      for (const t of e.tables.values())
        for (const a of aliases.get(t.path)?.values() ?? []) {
          if (!a.pkg) continue;
          const files = a.used.size
            ? [...a.used]
            : a.pkg.files.filter((f) => !/_test\.go$/.test(f.path)).map((f) => f.path);
          for (const f of files) if (f !== t.path) e.g.addEdge('imports', t.fileId, ids.file(f), { evidence: a.span });
        }
    },
    grpcServiceName(iface) {
      const pkg = pkgOf.get(iface.table.path);
      for (const f of pkg?.files ?? []) {
        const name = (f.facts.hints.grpcServices as Record<string, string> | undefined)?.[iface.entry.decl.name];
        if (name) return name;
      }
      return undefined;
    },
  };
}
