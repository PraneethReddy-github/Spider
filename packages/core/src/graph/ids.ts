import { createHash } from 'node:crypto';

/** Deterministic, short, url-safe id from a list of parts. */
export function makeId(...parts: (string | number | undefined)[]): string {
  const h = createHash('sha1')
    .update(parts.map((p) => String(p ?? '')).join(' '))
    .digest('base64url');
  return h.slice(0, 16);
}

export const ids = {
  repo: () => 'repo',
  directory: (path: string) => (path === '' ? 'repo' : makeId('dir', path)),
  file: (path: string) => makeId('file', path),
  symbol: (file: string, qname: string) => makeId('sym', file, qname),
  external: (ecosystem: string, name: string) => makeId('ext', ecosystem, name),
  pkg: (manifestPath: string) => makeId('pkg', manifestPath),
  endpoint: (file: string, method: string, path: string, line: number) => makeId('ep', file, method, path, line),
  subsystem: (label: string) => makeId('sub', label),
  edge: (kind: string, src: string, dst: string) => makeId('e', kind, src, dst),
};
