import { type TreeWatcher, watchTree } from '@spider/core';
import type { RepoInfo } from '@spider/shared';

export interface RepoWatcher {
  /** Starts watching a repo if it is local (cloned URL sources are never watched). Idempotent. */
  add(info: RepoInfo): Promise<void>;
  remove(repoId: string): void;
  close(): void;
}

const isRemote = (source: string) => /^(https?:\/\/|git@|ssh:\/\/|git:\/\/)/.test(source);

/**
 * `serve --watch`: re-analyses registered local repos when their files change. Changes are debounced by
 * `watchTree`; a change during a running analysis queues exactly one follow-up run.
 */
export function createRepoWatcher(reanalyse: (info: RepoInfo) => Promise<RepoInfo | undefined>): RepoWatcher {
  const repos = new Map<string, { tree?: TreeWatcher; running: boolean; dirty: boolean; info: RepoInfo }>();

  const run = async (repoId: string) => {
    const r = repos.get(repoId);
    if (!r) return;
    if (r.running) {
      r.dirty = true;
      return;
    }
    r.running = true;
    // Local repos re-analyse by absolute root: the stored source may be relative to another cwd.
    r.info = (await reanalyse({ ...r.info, source: r.info.root })) ?? r.info;
    await r.tree?.refresh().catch(() => {});
    r.running = false;
    if (r.dirty) {
      r.dirty = false;
      void run(repoId);
    }
  };

  return {
    async add(info) {
      if (isRemote(info.source) || repos.has(info.repoId)) return;
      const r: { tree?: TreeWatcher; running: boolean; dirty: boolean; info: RepoInfo } = {
        running: false,
        dirty: false,
        info,
      };
      repos.set(info.repoId, r);
      try {
        r.tree = await watchTree(info.root, () => void run(info.repoId));
      } catch {
        repos.delete(info.repoId); // root gone or unreadable: nothing to watch
      }
    },
    remove(repoId) {
      repos.get(repoId)?.tree?.close();
      repos.delete(repoId);
    },
    close() {
      for (const r of repos.values()) r.tree?.close();
      repos.clear();
    },
  };
}
