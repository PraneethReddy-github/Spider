import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { RepoInfo, SubsystemOverrides } from '@spider/shared';
import { repoDir, spiderHome } from './analyze.js';
import { EMPTY_OVERRIDES, type SubsystemGroup, applySubsystems, groupsFromGraph } from './enrich/subsystems.js';
import { QueryService } from './query/service.js';
import { SqliteStore } from './store/sqlite.js';

const file = (repoId: string, home?: string) => path.join(repoDir(spiderHome(home), repoId), 'overrides.json');

/** The repo's subsystem overrides (`overrides.json`), or empty defaults. */
export async function readOverrides(repoId: string, home?: string): Promise<SubsystemOverrides> {
  try {
    const raw = JSON.parse(await fs.readFile(file(repoId, home), 'utf8')) as Partial<SubsystemOverrides>;
    return { rename: raw.rename ?? {}, merge: raw.merge ?? [], pins: raw.pins ?? {} };
  } catch {
    return structuredClone(EMPTY_OVERRIDES);
  }
}

/**
 * Saves overrides and re-applies subsystems on the stored graph (no re-parse): the inferred groups in
 * graph meta `subsystems` (or the current subsystems of older graphs) are rebuilt with the overrides.
 * Throws an error with `code: 'ENOENT'` when the repo is unknown.
 */
export async function writeOverrides(repoId: string, ov: SubsystemOverrides, home?: string): Promise<void> {
  const dir = repoDir(spiderHome(home), repoId);
  const dbFile = path.join(dir, 'graph.db');
  if (!existsSync(dbFile)) throw Object.assign(new Error('repo not found'), { code: 'ENOENT' });
  await fs.writeFile(file(repoId, home), JSON.stringify(ov, null, 2));
  const store = await SqliteStore.open(dbFile);
  try {
    const { graph, meta } = store.loadGraph();
    const groups = (meta.subsystems as SubsystemGroup[] | undefined) ?? groupsFromGraph(graph);
    const count = applySubsystems(graph, groups, ov);
    const info = meta.info as RepoInfo | undefined;
    if (info) {
      info.stats.byNodeKind.subsystem = count;
      info.stats.byEdgeKind.member_of = graph.edges.size - (info.stats.edges - (info.stats.byEdgeKind.member_of ?? 0));
      info.stats.nodes = graph.nodes.size;
      info.stats.edges = graph.edges.size;
      await fs.writeFile(path.join(dir, 'repo.json'), JSON.stringify(info, null, 2));
    }
    const next = { ...meta, subsystems: groups };
    store.saveGraph(graph, next);
    store.saveViews(new QueryService(graph, next).defaultViews());
  } finally {
    store.close();
  }
}
