import type { GraphBuilder } from '../graph/builder.js';
import { ids } from '../graph/ids.js';
import type { Discovery } from './discover.js';
import type { FileTable, ResolveStats, SymbolEntry } from './resolve.js';

/**
 * Import / visibility resolution for statically typed, package-based languages (Java, Kotlin; C# reuses it
 * from `resolve-csharp.ts`). It fills `FileTable.locals` the way the language's name lookup works, so the
 * shared call / inheritance / reference binding in `resolve.ts` applies unchanged:
 *   own top-level decls > explicit imports > same package (C#: enclosing namespaces) > wildcard imports.
 * Names that stay unknown are marked external: in these languages an unimported type is a library type, and
 * an unqualified call that is no own / inherited member is a library (base class) member — so the untyped
 * name fallback never guesses for them.
 */
export interface TypedFamily {
  langs: Set<string>;
  /** Packages whose top-level types a file declaring `pkgs` sees without an import. */
  visiblePackages(pkgs: string[]): string[];
  /** External package node for an unresolved import. */
  external(spec: string): { ecosystem: string; name: string };
  /** Manifest ecosystems that delimit modules (preferred when a name is declared in several modules). */
  moduleEcosystems: string[];
}

type Entry = { table: FileTable; entry: SymbolEntry };

export const JVM_FAMILY: TypedFamily = {
  langs: new Set(['java', 'kotlin']),
  visiblePackages: (pkgs) => pkgs,
  external(spec) {
    const segs = spec.split('.');
    const ecosystem = /^(java|javax|jdk|sun)$/.test(segs[0]) ? 'jdk' : segs[0] === 'kotlin' ? 'kotlin' : 'maven';
    return { ecosystem, name: segs.slice(0, 2).join('.') };
  },
  moduleEcosystems: ['maven'],
};

export function resolveJvmImports(
  g: GraphBuilder,
  d: Discovery,
  tables: Map<string, FileTable>,
  stats: ResolveStats,
): void {
  resolveTypedImports(g, d, tables, stats, JVM_FAMILY);
}

export function resolveTypedImports(
  g: GraphBuilder,
  d: Discovery,
  tables: Map<string, FileTable>,
  stats: ResolveStats,
  fam: TypedFamily,
): void {
  const family = [...tables.values()].filter((t) => fam.langs.has(t.facts.language));
  if (family.length === 0) return;
  const modules = d.manifests
    .filter((m) => fam.moduleEcosystems.includes(m.ecosystem))
    .map((m) => m.dir)
    .sort((a, b) => b.length - a.length);
  const moduleOf = (p: string) => modules.find((m) => m === '' || p.startsWith(`${m}/`)) ?? '';
  /** One candidate, else the only one in the same module; ambiguous names bind nothing. */
  const pick = (cands: Entry[] | undefined, from: FileTable): Entry | undefined => {
    if (!cands || cands.length === 0) return undefined;
    if (cands.length === 1) return cands[0];
    const same = cands.filter((c) => moduleOf(c.table.path) === moduleOf(from.path));
    return same.length === 1 ? same[0] : undefined;
  };

  /* index: fully qualified name → decls, package → top-level decls */
  const byFqn = new Map<string, Entry[]>();
  const byPkg = new Map<string, Entry[]>();
  const repoPkgs = new Set<string>();
  for (const table of family) {
    const pkgOf = (table.facts.hints.packageOf ?? {}) as Record<string, string>;
    const pkgs = (table.facts.hints.packages ?? []) as string[];
    for (const p of pkgs) if (p) repoPkgs.add(p);
    for (const [qn, entry] of table.own) {
      if (entry.decl.name.includes(' ')) continue; // synthetic route handlers
      const pkg = pkgOf[qn.split('.')[0]] ?? pkgs[0] ?? '';
      const top = !entry.decl.parentQname;
      if (top || entry.decl.kind === 'class') push(byFqn, pkg ? `${pkg}.${qn}` : qn, { table, entry });
      if (top) push(byPkg, pkg, { table, entry });
    }
  }

  const external = (table: FileTable, spec: string, span: { startLine: number }, local?: string) => {
    // inside a repo package but not found: a broken import, not a library
    const segs = spec.split('.');
    if (segs.some((_, k) => repoPkgs.has(segs.slice(0, k + 1).join('.')))) {
      stats.unresolvedImports++;
      return;
    }
    const { ecosystem, name } = fam.external(spec);
    const extId = ids.external(ecosystem, name);
    if (!g.hasNode(extId))
      g.addNode({
        id: extId,
        kind: 'external',
        name,
        qname: `${ecosystem}:${name}`,
        props: { ecosystem, inferred: true },
      });
    g.addEdge('imports', table.fileId, extId, { evidence: span as never });
    if (local && !table.locals.has(local)) table.locals.set(local, { kind: 'external', id: extId });
    stats.resolvedImports++;
  };
  const importEdge = (table: FileTable, target: FileTable, span: unknown) => {
    if (target.fileId !== table.fileId) g.addEdge('imports', table.fileId, target.fileId, { evidence: span as never });
  };

  for (const table of family) {
    const { facts } = table;
    table.strict = true;
    const used = usedNames(table);
    const vis = new Map<string, Entry[]>();
    const layer = (entries: Entry[]) => {
      const m = new Map<string, Entry[]>();
      for (const e of entries) push(m, e.entry.decl.name, e);
      for (const [k, v] of m) vis.set(k, v);
    };
    const explicit: [string, Entry][] = [];

    for (const imp of facts.imports) {
      const name = imp.names[0];
      if (!name) continue;
      if (name.imported === '*') {
        const pkgEntries = byPkg.get(imp.specifier);
        const cls = pick(byFqn.get(imp.specifier), table);
        if (pkgEntries) {
          layer(pkgEntries);
          stats.resolvedImports++;
          const files = new Set<FileTable>();
          for (const e of pkgEntries) if (used.has(e.entry.decl.name)) files.add(e.table);
          for (const t of files) importEdge(table, t, imp.span);
        } else if (cls?.entry.decl.kind === 'class') {
          // static-on-demand import / `using static`: the class's members
          const prefix = `${cls.entry.decl.qname}.`;
          const members = [...cls.table.own].filter(
            ([qn]) => qn.startsWith(prefix) && !qn.slice(prefix.length).includes('.'),
          );
          layer(members.map(([, entry]) => ({ table: cls.table, entry })));
          stats.resolvedImports++;
          importEdge(table, cls.table, imp.span);
        } else external(table, imp.specifier, imp.span);
        continue;
      }
      let target = pick(byFqn.get(imp.specifier), table);
      if (!target) {
        // static member import: `import static a.B.m` / Kotlin `import a.B.m`
        const i = imp.specifier.lastIndexOf('.');
        const owner = i > 0 ? pick(byFqn.get(imp.specifier.slice(0, i)), table) : undefined;
        const member = owner?.table.own.get(`${owner.entry.decl.qname}.${imp.specifier.slice(i + 1)}`);
        if (owner && member) target = { table: owner.table, entry: member };
      }
      if (!target) {
        external(table, imp.specifier, imp.span, name.local);
        continue;
      }
      stats.resolvedImports++;
      importEdge(table, target.table, imp.span);
      explicit.push([name.local, target]);
    }
    for (const p of fam.visiblePackages((facts.hints.packages ?? []) as string[])) layer(byPkg.get(p) ?? []);
    for (const [local, e] of explicit) vis.set(local, [e]);
    for (const [name, cands] of vis) {
      if (table.locals.has(name)) continue; // own declarations shadow imports
      const c = pick(cands, table);
      if (c) table.locals.set(name, { kind: 'symbol', id: c.entry.id });
    }
    rewriteCalls(table);
    markUnknownHeads(table, fam);
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** Simple names a file mentions (call heads, types, bases) — wildcard imports only get edges to these. */
function usedNames(table: FileTable): Set<string> {
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    if (s) for (const seg of s.split('.')) out.add(seg);
  };
  const { facts } = table;
  for (const c of facts.calls) add(c.callee);
  for (const b of facts.bindings) add(b.ref);
  for (const r of facts.references ?? []) add(r.name);
  for (const d of facts.decls) for (const n of [...(d.extends ?? []), ...(d.implements ?? [])]) add(n);
  for (const e of facts.endpoints) add(e.handlerRef);
  return out;
}

function enclosingClass(table: FileTable, qname: string): SymbolEntry | undefined {
  const parts = qname.split('.');
  while (parts.length) {
    const e = table.own.get(parts.join('.'));
    if (e?.decl.kind === 'class') return e;
    parts.pop();
  }
  return undefined;
}

/** `m` declared on a repo base class of `cls` (walks `extends` through the file's visible names). */
function inheritedHas(table: FileTable, cls: SymbolEntry, m: string, depth = 0): boolean {
  if (depth > 5) return false;
  for (const base of cls.decl.extends ?? []) {
    const local = table.locals.get(base);
    const id = local?.kind === 'symbol' ? local.id : table.own.get(base)?.id;
    const owner = id ? table.ctx.byId.get(id) : undefined;
    if (!owner) continue;
    if (owner.table.own.has(`${owner.entry.decl.qname}.${m}`)) return true;
    if (inheritedHas(owner.table, owner.entry, m, depth + 1)) return true;
  }
  return false;
}

/** qname of the own declaration an unqualified `name` refers to (innermost scope first). */
function ownNested(table: FileTable, ctxQname: string, name: string): string | undefined {
  const parts = ctxQname.split('.');
  while (parts.length) {
    const q = [...parts, name].join('.');
    if (table.own.has(q)) return q;
    parts.pop();
  }
  return table.own.has(name) ? name : undefined;
}

/** Overloads share a name (`m`, `m#2`, …): pick the one whose arity matches when exactly one does. */
function overload(table: FileTable, qname: string, name: string, argCount: number): string {
  const all: string[] = [];
  for (let k = 1; table.own.has(k === 1 ? qname : `${qname}#${k}`); k++) all.push(k === 1 ? name : `${name}#${k}`);
  if (all.length < 2) return name;
  const fit = all.filter(
    (n, i) => table.own.get(i === 0 ? qname : `${qname}#${i + 1}`)?.decl.params?.length === argCount,
  );
  return fit.length === 1 ? fit[0] : name;
}

/**
 * Java/Kotlin/C# member access is implicit: `m()` may be an own, inherited or statically imported member,
 * and `field.m()` needs no `this.`. Rewrites callees so the shared lookup binds them exactly:
 * `m` → `this.m` when inherited from a repo class; `this.f.m` → `f.m` (field typing); `super.m` → `Base.m`.
 */
function rewriteCalls(table: FileTable): void {
  for (const call of table.facts.calls) {
    if (call.isNew || !call.callerQname) continue;
    const cls = enclosingClass(table, call.callerQname);
    if (!cls) continue;
    const segs = call.callee.split('.');
    if (segs[0] === 'super' && segs.length === 2) {
      const base = cls.decl.extends?.[0];
      call.callee = base ? `${base}.${segs[1]}` : segs[1];
      continue;
    }
    if (segs[0] === 'this' && segs.length > 2) {
      if (!shadowed(table, cls.decl.qname, call.callerQname, segs[1])) call.callee = segs.slice(1).join('.');
      continue;
    }
    const m = segs[0] === 'this' && segs.length === 2 ? segs[1] : segs.length === 1 ? segs[0] : undefined;
    if (!m) continue;
    const own = ownNested(table, call.callerQname, m);
    if (own) call.callee = overload(table, own, m, call.argCount);
    else if (segs.length === 1 && table.locals.has(m)) call.callee = m;
    else call.callee = inheritedHas(table, cls, m) ? `this.${m}` : m;
  }
}

/** A method-scope binding (param / local) hides the class field of the same name. */
function shadowed(table: FileTable, clsQname: string, callerQname: string, name: string): boolean {
  const parts = callerQname.split('.');
  while (parts.length > clsQname.split('.').length) {
    if (table.bindings.get(parts.join('.'))?.has(name)) return true;
    parts.pop();
  }
  return false;
}

function markUnknownHeads(table: FileTable, fam: TypedFamily): void {
  const { facts } = table;
  const heads = new Set<string>();
  for (const c of facts.calls) heads.add(c.callee.split('.')[0]);
  for (const b of facts.bindings) heads.add(b.ref.split('.')[0]);
  for (const r of facts.references ?? []) heads.add(r.name.split('.')[0]);
  for (const d of facts.decls)
    for (const n of [...(d.extends ?? []), ...(d.implements ?? [])]) heads.add(n.split('.')[0]);
  // variables keep their (scoped) bindings: `x = repo.find()` must still type through `repo`
  for (const b of facts.bindings) heads.delete(b.name);
  const eco = fam.langs.has('csharp') ? 'dotnet' : 'jvm';
  for (const h of heads) {
    if (h === 'this' || h === 'super' || table.locals.has(h) || table.own.has(h)) continue;
    table.locals.set(h, { kind: 'external', id: ids.external(eco, h) });
  }
}
