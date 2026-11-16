import path from 'node:path';
import { ids } from '../graph/ids.js';
import type { Discovery } from './discover.js';
import type { NativeEngine, NativeLang, Res, Sym } from './resolve-native.js';
import type { FileTable } from './resolve.js';

interface RMod {
  file: string;
  /** Inline module prefix inside `file` ('' = the file's own module). */
  prefix: string;
  parent?: RMod;
  root: RMod;
  children: Map<string, RMod>;
}

type RRes = { kind: 'mod'; mod: RMod } | Res;

const STD = new Set(['std', 'core', 'alloc', 'proc_macro']);
const PRELUDE = new Set([
  'Vec',
  'String',
  'Box',
  'Option',
  'Result',
  'Some',
  'None',
  'Ok',
  'Err',
  'Default',
  'ToString',
]);

interface ModHint {
  name: string;
  parent: string;
  inline: boolean;
  path?: string;
}

/**
 * Rust: crate roots from Cargo layouts (`src/lib.rs`, `src/main.rs`, `src/bin`, `examples`, `tests`,
 * `benches`), the `mod` tree (`foo.rs` / `foo/mod.rs`, inline modules, `#[path]`), `use` paths with
 * `crate::` / `super::` / `self::`, globs, aliases and workspace crates; methods attach through `impl`.
 */
export function rustLang(e: NativeEngine, d: Discovery): NativeLang {
  const cargo = d.manifests.filter((m) => m.ecosystem === 'cargo').sort((a, b) => b.dir.length - a.dir.length);
  const depNames = new Map<string, string>();
  for (const m of cargo) for (const dep of m.deps) depNames.set(dep.name.replace(/-/g, '_'), dep.name);
  const fileMods = new Map<string, Map<string, RMod>>();
  const crates = new Map<string, RMod>();
  const modEdges: [string, string][] = [];

  const register = (m: RMod) => {
    const map = fileMods.get(m.file) ?? new Map<string, RMod>();
    map.set(m.prefix, m);
    fileMods.set(m.file, map);
  };
  const newRoot = (file: string): RMod => {
    const m = { file, prefix: '', children: new Map() } as unknown as RMod;
    m.root = m;
    register(m);
    return m;
  };
  const cargoDir = (p: string) => cargo.find((m) => !m.dir || p.startsWith(`${m.dir}/`));
  const isRoot = (p: string): boolean => {
    const c = cargoDir(p);
    const rel = c?.dir ? p.slice(c.dir.length + 1) : p;
    if (!c) return /(^|\/)(lib|main)\.rs$/.test(p);
    return /^(src\/(lib|main)\.rs|src\/bin\/[^/]+\.rs|src\/bin\/[^/]+\/main\.rs|(examples|tests|benches)\/[^/]+\.rs|examples\/[^/]+\/main\.rs|build\.rs)$/.test(
      rel,
    );
  };

  /* ---- module tree ---- */
  const queue: RMod[] = [];
  for (const t of [...e.tables.values()].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isRoot(t.path)) continue;
    const root = newRoot(t.path);
    queue.push(root);
    const c = cargoDir(t.path);
    const crate = (c?.name ?? path.posix.basename(path.posix.dirname(t.path))).replace(/-/g, '_');
    if (t.path.endsWith('/lib.rs') || !crates.has(crate)) crates.set(crate, root);
  }
  const expand = (root: RMod) => {
    const t = e.tables.get(root.file);
    const hints = ((t?.facts.hints.rustMods as ModHint[] | undefined) ?? []).slice();
    const isModRs = root === root.root || /(^|\/)mod\.rs$/.test(root.file);
    const fileDir = path.posix.dirname(root.file) === '.' ? '' : path.posix.dirname(root.file);
    const baseDir = isModRs ? fileDir : root.file.slice(0, -3);
    for (const h of hints) {
      const parent = fileMods.get(root.file)?.get(h.parent);
      if (!parent) continue;
      if (h.inline) {
        const child: RMod = {
          file: root.file,
          prefix: h.parent ? `${h.parent}.${h.name}` : h.name,
          parent,
          root: parent.root,
          children: new Map(),
        };
        parent.children.set(h.name, child);
        register(child);
        continue;
      }
      const dir = path.posix.join(baseDir, ...(h.parent ? h.parent.split('.') : []));
      const candidates = h.path
        ? [path.posix.normalize(path.posix.join(fileDir, h.path))]
        : [path.posix.join(dir, `${h.name}.rs`), path.posix.join(dir, h.name, 'mod.rs')];
      const file = candidates.find((c) => e.tables.has(c) && !fileMods.has(c));
      if (!file) continue;
      const child: RMod = { file, prefix: '', parent, root: parent.root, children: new Map() };
      parent.children.set(h.name, child);
      register(child);
      modEdges.push([root.file, file]);
      queue.push(child);
    }
  };
  while (queue.length) expand(queue.shift() as RMod);
  for (const t of e.tables.values())
    if (!fileMods.has(t.path)) {
      const r = newRoot(t.path);
      expand(r);
      while (queue.length) expand(queue.shift() as RMod);
    }

  const modFor = (table: FileTable, qname?: string): RMod => {
    const mods = fileMods.get(table.path) as Map<string, RMod>;
    let best = mods.get('') as RMod;
    for (const [p, m] of mods)
      if (p && qname && (qname === p || qname.startsWith(`${p}.`)) && p.length > best.prefix.length) best = m;
    return best;
  };

  const extern = (name: string): RRes => {
    const c = crates.get(name);
    if (c) return { kind: 'mod', mod: c };
    if (STD.has(name) || PRELUDE.has(name)) return { kind: 'ext' };
    const dep = depNames.get(name);
    if (dep) {
      e.external('cargo', dep);
      return { kind: 'ext' };
    }
    return undefined;
  };

  const resolveName = (mod: RMod, name: string, depth: number): RRes => {
    const t = e.tables.get(mod.file);
    if (!t || depth > 8) return undefined;
    const own = t.own.get(mod.prefix ? `${mod.prefix}.${name}` : name);
    if (own && own.decl.kind !== 'method') return { kind: 'sym', sym: { table: t, entry: own }, conf: 1 };
    const child = mod.children.get(name);
    if (child) return { kind: 'mod', mod: child };
    // shortcut: `use` declarations are file-scoped (a `use` inside an inline module or fn leaks to the file)
    for (const imp of t.facts.imports) {
      const n = imp.names[0];
      if (n && n.imported !== '*' && n.local === name) {
        const r = resolvePath(mod, imp.specifier.split('::'), depth + 1);
        if (r) return r;
      }
    }
    for (const imp of t.facts.imports) {
      if (imp.names[0]?.imported !== '*') continue;
      const r = resolvePath(mod, imp.specifier.split('::'), depth + 1);
      const inner = r?.kind === 'mod' ? resolveName(r.mod, name, depth + 1) : undefined;
      if (inner && inner.kind !== 'missing') return inner;
    }
    return undefined;
  };

  const resolvePath = (mod: RMod, segs: string[], depth: number): RRes => {
    if (depth > 8 || segs.length === 0) return undefined;
    let cur: RRes;
    let i = 1;
    const s0 = segs[0];
    if (s0 === '') {
      cur = extern(segs[1]);
      i = 2;
    } else if (s0 === 'crate') cur = { kind: 'mod', mod: mod.root };
    else if (s0 === 'self') cur = { kind: 'mod', mod };
    else if (s0 === 'super') cur = { kind: 'mod', mod: mod.parent ?? mod };
    else cur = resolveName(mod, s0, depth) ?? extern(s0);
    for (; i < segs.length && cur; i++) {
      const seg = segs[i];
      if (cur.kind === 'ext' || cur.kind === 'missing') return cur;
      if (cur.kind === 'mod') {
        cur =
          seg === 'super'
            ? { kind: 'mod', mod: cur.mod.parent ?? cur.mod }
            : (resolveName(cur.mod, seg, depth + 1) ?? { kind: 'missing' });
        continue;
      }
      // Type::assoc_fn — enum variants and trait items from libraries stay unbound
      if (cur.sym.entry.decl.kind !== 'class' || i !== segs.length - 1) return undefined;
      return e.member(cur.sym, seg);
    }
    return cur;
  };

  const ref = (table: FileTable, r: string, scope?: string): Res => {
    const segs = r.split('::');
    // nested fn items: `outer.inner`
    for (let s = scope, k = 0; segs.length === 1 && s && k < 10; k++) {
      const enclosing = table.own.get(s);
      if (enclosing?.decl.kind === 'class') break;
      const nested = table.own.get(`${s}.${segs[0]}`);
      if (nested && nested.decl.kind === 'function') return { kind: 'sym', sym: { table, entry: nested }, conf: 1 };
      s = enclosing?.decl.parentQname;
    }
    const res = resolvePath(modFor(table, scope), segs, 0);
    return res?.kind === 'mod' ? undefined : res;
  };

  return {
    isPath: (callee) => !callee.includes('.'),
    ref,
    head: (table, segs, scope) => ({ res: ref(table, segs[0], scope), used: 1 }),
    prepare() {
      for (const [a, b] of modEdges) e.g.addEdge('imports', ids.file(a), ids.file(b), { props: { mod: true } });
      for (const t of e.tables.values()) {
        const root = modFor(t);
        for (const imp of t.facts.imports) {
          const segs = imp.specifier.split('::');
          const r = resolvePath(root, segs, 0);
          if (!r || r.kind === 'missing') {
            if (['crate', 'self', 'super'].includes(segs[0]) || crates.has(segs[0])) e.stats.unresolvedImports++;
            continue;
          }
          e.stats.resolvedImports++;
          const head = segs[0] === '' ? segs[1] : segs[0];
          const dst =
            r.kind === 'ext'
              ? STD.has(head)
                ? e.external('rust-std', head)
                : depNames.has(head)
                  ? e.external('cargo', depNames.get(head) as string)
                  : undefined
              : ids.file(r.kind === 'mod' ? r.mod.file : r.sym.table.path);
          if (dst && dst !== t.fileId) e.g.addEdge('imports', t.fileId, dst, { evidence: imp.span });
        }
        // impl blocks → method tables, trait impls → implements
        type Impl = { qname: string; type: string; trait?: string };
        for (const impl of (t.facts.hints.rustImpls as Impl[] | undefined) ?? []) {
          const mod = modFor(t, impl.qname);
          const tr = resolvePath(mod, impl.type.split('::'), 0);
          if (tr?.kind !== 'sym' || tr.sym.entry.decl.kind !== 'class') continue;
          for (const entry of t.own.values())
            if (entry.decl.parentQname === impl.qname && entry.decl.kind === 'method')
              e.addMethod(tr.sym, entry.decl.name, { table: t, entry });
          if (!impl.trait) continue;
          const trait = resolvePath(mod, impl.trait.split('::'), 0);
          if (trait?.kind !== 'sym' || trait.sym.entry.decl.kind !== 'class') continue;
          e.addSuper(tr.sym, trait.sym);
          e.g.addEdge('implements', tr.sym.entry.id, trait.sym.entry.id, { evidence: tr.sym.entry.decl.span });
        }
        // trait declarations own their (default and required) methods
        for (const entry of t.own.values()) {
          if (entry.decl.kind !== 'method' || !entry.decl.parentQname) continue;
          const owner = t.own.get(entry.decl.parentQname);
          if (owner?.decl.classKind === 'trait')
            e.addMethod({ table: t, entry: owner } as Sym, entry.decl.name, { table: t, entry });
        }
      }
    },
  };
}
