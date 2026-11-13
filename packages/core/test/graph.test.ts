import { describe, expect, it } from 'vitest';
import { GraphBuilder } from '../src/graph/builder.js';
import { ids, makeId } from '../src/graph/ids.js';
import { detectLanguage, isTestPath } from '../src/pipeline/discover.js';
import { toDot, toGraphML } from '../src/query/export.js';

describe('graph builder', () => {
  it('ids are deterministic and url safe', () => {
    expect(makeId('a', 'b')).toBe(makeId('a', 'b'));
    expect(ids.file('src/x.ts')).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });
  it('adds contains edges and accumulates weight', () => {
    const g = new GraphBuilder();
    g.addNode({ id: 'repo', kind: 'repository', name: 'r' });
    g.addNode({ id: 'f', kind: 'file', name: 'f', parentId: 'repo' });
    g.addNode({ id: 'h', kind: 'file', name: 'h', parentId: 'repo' });
    g.addEdge('imports', 'f', 'h');
    g.addEdge('imports', 'f', 'h', { confidence: 0.5 });
    const e = g.outEdges('f', 'imports')[0];
    expect(e.weight).toBe(2);
    expect(e.confidence).toBe(1);
    expect(g.ancestors('f').map((n) => n.id)).toEqual(['repo']);
  });
});
describe('discovery helpers', () => {
  it('detects languages and tests', () => {
    expect(detectLanguage('a/b.tsx')).toBe('tsx');
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(isTestPath('src/a.test.ts')).toBe(true);
    expect(isTestPath('src/testing_utils.ts')).toBe(false);
  });
});

describe('exporters', () => {
  it('escapes names in dot and graphml and omits containment', () => {
    const g = new GraphBuilder();
    g.addNode({ id: 'repo', kind: 'repository', name: 'r' });
    g.addNode({ id: 'a', kind: 'file', name: 'a"<&>.ts', parentId: 'repo' });
    g.addNode({ id: 'b', kind: 'file', name: 'b.ts', parentId: 'repo' });
    g.addEdge('imports', 'a', 'b');
    const sg = g.toSubGraph();
    const dot = toDot(sg);
    expect(dot).toContain('"a" [label="a\\"<&>.ts", kind="file"];');
    expect(dot).toContain('"a" -> "b" [label="imports"];');
    expect(dot).not.toContain('contains');
    const xml = toGraphML(sg);
    expect(xml).toContain('<data key="name">a&quot;&lt;&amp;&gt;.ts</data>');
    expect(xml).toContain('source="a" target="b"><data key="ekind">imports</data>');
    expect(xml).not.toContain('>contains<');
  });
});
