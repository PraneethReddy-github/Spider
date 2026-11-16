import { describe, expect, it } from 'vitest';
import { analyzeFixture, edgeLabels } from './helpers.js';

describe('rust / axum + actix workspace fixture', async () => {
  const { g, q, stats } = await analyzeFixture('rust-axum');
  const edges = edgeLabels(g);
  const conf = (label: string) =>
    [...g.edges.values()].find((e) => `${e.kind} ${g.getNode(e.src)?.qname} -> ${g.getNode(e.dst)?.qname}` === label)
      ?.confidence;

  it('builds the mod tree and resolves crate::, super::super::, workspace crates and re-exports', () => {
    expect(edges).toContain('imports api/src/main.rs -> api/src/routes/mod.rs');
    expect(edges).toContain('imports api/src/routes/mod.rs -> api/src/routes/users.rs');
    expect(edges).toContain('imports domain/src/repo.rs -> domain/src/model.rs');
    expect(edges).toContain('imports api/src/routes/users.rs -> api/src/legacy.rs');
    expect(edges).toContain('imports api/src/routes/users.rs -> domain/src/repo.rs');
    expect(edges).toContain('imports api/src/routes/users.rs -> domain/src/model.rs'); // `pub use model::User`
    expect(edges).toContain('imports api/src/routes/mod.rs -> cargo:axum');
    expect(edges).toContain('imports api/src/legacy.rs -> cargo:actix-web');
    expect(stats.unresolvedImports).toBe(0);
  });

  it('binds paths, impl methods, typed extractors and trait default methods', () => {
    expect(edges).toContain('calls api/src/main.rs::main -> api/src/routes/mod.rs::app');
    expect(edges).toContain('calls api/src/routes/users.rs::create -> domain/src/model.rs::User.new');
    expect(edges).toContain('calls api/src/routes/users.rs::create -> domain/src/model.rs::User.label');
    expect(edges).toContain('calls api/src/routes/users.rs::list -> domain/src/repo.rs::MemRepo.find');
    expect(conf('calls api/src/routes/users.rs::list -> domain/src/repo.rs::Store.count')).toBe(0.9);
    expect(edges).toContain('calls domain/src/model.rs::User.label -> domain/src/model.rs::helper');
    expect(edges).toContain('implements domain/src/repo.rs::MemRepo -> domain/src/repo.rs::Store');
    expect(edges).toContain('instantiates domain/src/model.rs::User.new -> domain/src/model.rs::User');
    expect(edges.filter((e) => e.startsWith('calls '))).toHaveLength(11);
    expect(edges.some((e) => e.includes('finds'))).toBe(false); // #[cfg(test)] module skipped
    expect(stats.unresolvedCalls).toBe(0);
    expect(stats.ambiguousCalls).toBe(0);
  });

  it('detects axum route/nest (variable and function) and actix attribute, scope, resource and configure routes', () => {
    expect(
      q
        .endpoints()
        .map((e) => `${e.node.name} -> ${e.handler?.qname ?? '-'}`)
        .sort(),
    ).toEqual([
      'GET /api/users -> api/src/routes/users.rs::list',
      'GET /health -> api/src/routes/mod.rs::app.GET /health',
      'GET /legacy/bye -> api/src/legacy.rs::bye',
      'GET /legacy/hello/{name} -> api/src/legacy.rs::hello',
      'GET /v2/items/:id -> api/src/routes/users.rs::list',
      'POST /api/users -> api/src/routes/users.rs::create',
      'POST /ping -> api/src/legacy.rs::bye',
    ]);
  });
});
