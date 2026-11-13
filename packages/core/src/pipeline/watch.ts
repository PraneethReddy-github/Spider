import { type FSWatcher, watch } from 'node:fs';
import path from 'node:path';
import { discover } from './discover.js';

export interface TreeWatcher {
  /** Re-syncs the watched directory set with the repo (call after a re-analysis: dirs may have come or gone). */
  refresh(): Promise<void>;
  close(): void;
}

/** Editor swap/backup files that change on every keystroke or save but never affect the graph. */
const NOISE = /(^\.#|~$|\.sw[px]$|^4913$)/;

/**
 * Watches every directory that holds a discovered file (so `.gitignore`d trees such as `node_modules` cost no
 * watches) and calls `onChange` once per burst of changes, `debounceMs` after the last one. Uses one
 * non-recursive `fs.watch` per directory: no dependency, same behaviour on Linux, macOS and Windows.
 */
export async function watchTree(root: string, onChange: () => void, debounceMs = 300): Promise<TreeWatcher> {
  const abs = path.resolve(root);
  const watchers = new Map<string, FSWatcher>();
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  const fire = (name: string | null) => {
    if (closed || (name && NOISE.test(name))) return;
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  const refresh = async () => {
    const d = await discover(abs);
    const dirs = new Set([abs]);
    for (const f of d.files) {
      for (let dir = path.dirname(f.abs); dir.length > abs.length && !dirs.has(dir); dir = path.dirname(dir)) {
        dirs.add(dir);
      }
    }
    if (closed) return;
    for (const [dir, w] of watchers) {
      if (dirs.has(dir)) continue;
      w.close();
      watchers.delete(dir);
    }
    for (const dir of dirs) {
      if (watchers.has(dir)) continue;
      try {
        const w = watch(dir, (_event, name) => fire(name));
        w.on('error', () => {
          w.close();
          watchers.delete(dir);
        });
        watchers.set(dir, w);
      } catch {
        /* directory vanished between discover and watch; the next refresh settles it */
      }
    }
  };
  await refresh();
  return {
    refresh,
    close() {
      closed = true;
      clearTimeout(timer);
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
}
