import type { GraphBuilder } from '../graph/builder.js';
import type { Discovery } from './discover.js';
import { type TypedFamily, resolveTypedImports } from './resolve-jvm.js';
import type { FileTable, ResolveStats } from './resolve.js';

/**
 * C#: `using A.B;` imports a namespace, `using static A.B.C;` a type's members, `using X = A.B.C;` an alias;
 * types of the declaring namespace and every enclosing namespace are visible without a using.
 * `.csproj` directories delimit projects (preferred when a name is declared in several).
 */
export const CSHARP_FAMILY: TypedFamily = {
  langs: new Set(['csharp']),
  visiblePackages(pkgs) {
    const out = new Set<string>(['']);
    for (const p of pkgs) {
      const segs = p.split('.');
      for (let i = 1; i <= segs.length; i++) out.add(segs.slice(0, i).join('.'));
    }
    // shallow first: a deeper namespace's types shadow an outer one's
    return [...out].sort((a, b) => a.split('.').length - b.split('.').length || a.length - b.length);
  },
  external(spec) {
    const segs = spec.split('.');
    return segs[0] === 'System'
      ? { ecosystem: 'dotnet', name: segs.slice(0, 2).join('.') }
      : { ecosystem: 'nuget', name: segs.slice(0, 2).join('.') };
  },
  moduleEcosystems: ['nuget'],
};

export function resolveCsharpImports(
  g: GraphBuilder,
  d: Discovery,
  tables: Map<string, FileTable>,
  stats: ResolveStats,
): void {
  resolveTypedImports(g, d, tables, stats, CSHARP_FAMILY);
}
