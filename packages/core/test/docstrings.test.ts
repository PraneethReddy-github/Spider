import { describe, expect, it } from 'vitest';
import { extractFile } from '../src/pipeline/extract-file.js';

const docs = async (language: string, path: string, source: string) => {
  const f = await extractFile({ path, language, source }, new Set());
  return Object.fromEntries(f.decls.map((d) => [d.qname, d.docstring]));
};

describe('C-26 docstrings', () => {
  it('TypeScript: JSDoc and line comments right above a declaration', async () => {
    const d = await docs(
      'typescript',
      'a.ts',
      `// license header

/**
 * Loads users from the database.
 * @param id user id
 */
export function loadUser(id: string) {}

// Caches sessions in memory.
// Evicts after an hour.
export class SessionCache {
  /** Drops one entry. */
  evict(key: string) {}

  size() {}
}

const x = 1; // trailing, not a doc
export function bare() {}
`,
    );
    expect(d.loadUser).toBe('Loads users from the database. @param id user id');
    expect(d.SessionCache).toBe('Caches sessions in memory. Evicts after an hour.');
    expect(d['SessionCache.evict']).toBe('Drops one entry.');
    expect(d['SessionCache.size']).toBeUndefined();
    expect(d.bare).toBeUndefined();
  });

  it('Python: body docstrings, decorated or not, and # comments', async () => {
    const d = await docs(
      'python',
      'a.py',
      `class Repo:
    """Persistence for orders."""

    @staticmethod
    def find(oid):
        '''Find one order
        by id.'''
        return None

# Charges a card.
def charge(card):
    pass
`,
    );
    expect(d.Repo).toBe('Persistence for orders.');
    expect(d['Repo.find']).toBe('Find one order by id.');
    expect(d.charge).toBe('Charges a card.');
  });

  it('Go and Rust doc comments', async () => {
    const go = await docs('go', 'a.go', 'package a\n\n// Serve starts the HTTP server.\nfunc Serve() {}\n');
    expect(go.Serve).toBe('Serve starts the HTTP server.');
    const rs = await docs('rust', 'a.rs', '/// Parses a config file.\n/// Fails on bad TOML.\npub fn parse() {}\n');
    expect(rs.parse).toBe('Parses a config file. Fails on bad TOML.');
  });
});
