import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { GraphEdge, GraphNode } from '@spider/shared';
import Database from 'better-sqlite3';
import { GraphBuilder } from '../graph/builder.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qname TEXT,
  file TEXT,
  language TEXT,
  parent_id TEXT,
  start_line INTEGER,
  end_line INTEGER,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  weight REAL NOT NULL,
  confidence REAL NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS views (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
// Secondary indexes are dropped for a save and rebuilt in bulk after it (≈ 30 % faster at 250k nodes).
const INDEXES = `
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src, kind);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst, kind);
`;
const DROP_INDEXES =
  'DROP INDEX IF EXISTS nodes_kind; DROP INDEX IF EXISTS nodes_file; DROP INDEX IF EXISTS nodes_parent; DROP INDEX IF EXISTS edges_src; DROP INDEX IF EXISTS edges_dst;';
// Trigram FTS over node names (G6): substring candidates for search without scanning every node.
// External content over `nodes`, rebuilt after every save; `user_version` 1 marks it as built.
const FTS = `CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(name, qname, content='nodes', tokenize='trigram');`;

export class SqliteStore {
  private constructor(private db: Database.Database) {}

  static async open(file: string): Promise<SqliteStore> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = OFF');
    db.pragma('cache_size = -131072'); // 128 MB: random-id primary keys thrash the 2 MB default on big saves
    db.exec(SCHEMA);
    db.exec(INDEXES);
    if (db.pragma('user_version', { simple: true }) !== 1) {
      db.exec(FTS);
      db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild'); PRAGMA user_version = 1;`);
    }
    return new SqliteStore(db);
  }

  close(): void {
    this.db.close();
  }

  saveGraph(g: GraphBuilder, meta: Record<string, unknown>): void {
    const db = this.db;
    const insNode = db.prepare(
      'INSERT OR REPLACE INTO nodes VALUES (@id,@kind,@name,@qname,@file,@language,@parent_id,@start_line,@end_line,@data)',
    );
    const insEdge = db.prepare('INSERT OR REPLACE INTO edges VALUES (@id,@kind,@src,@dst,@weight,@confidence,@data)');
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
    db.transaction(() => {
      db.exec(DROP_INDEXES);
      db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM meta; DELETE FROM views;');
      for (const n of g.nodes.values()) {
        insNode.run({
          id: n.id,
          kind: n.kind,
          name: n.name,
          qname: n.qname ?? null,
          file: n.file ?? null,
          language: n.language ?? null,
          parent_id: n.parentId ?? null,
          start_line: n.span?.startLine ?? null,
          end_line: n.span?.endLine ?? null,
          data: JSON.stringify({ span: n.span, metrics: n.metrics, props: n.props }),
        });
      }
      for (const e of g.edges.values()) {
        insEdge.run({
          id: e.id,
          kind: e.kind,
          src: e.src,
          dst: e.dst,
          weight: e.weight,
          confidence: e.confidence,
          data: JSON.stringify(e.props),
        });
      }
      for (const [k, v] of Object.entries(meta)) insMeta.run(k, JSON.stringify(v));
      db.exec(INDEXES);
      db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')`);
    })();
  }

  /** Precomputed projections (C-21), written after `saveGraph`, which clears them. */
  saveViews(views: Map<string, unknown>): void {
    const ins = this.db.prepare('INSERT OR REPLACE INTO views VALUES (?, ?)');
    this.db.transaction(() => {
      for (const [k, v] of views) ins.run(k, JSON.stringify(v));
    })();
  }

  /** A stored projection as raw JSON (served as-is, never parsed on the cold path). */
  viewJson(key: string): string | undefined {
    if (!this.db.open) return undefined;
    const row = this.db.prepare('SELECT value FROM views WHERE key = ?').pluck().get(key) as string | undefined;
    return row;
  }

  /** One meta value without loading the graph. */
  loadMeta(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  /**
   * Ids of nodes whose name or qname contains `q` (case-insensitive), in insertion order; undefined
   * when there are more than `max` or the index can't answer (query shorter than a trigram, store closed).
   */
  substringIds(q: string, max: number): string[] | undefined {
    if (q.length < 3 || !this.db.open) return undefined;
    const stmt = (this.ftsStmt ??= this.db
      .prepare(
        'SELECT n.id FROM nodes_fts f JOIN nodes n ON n.rowid = f.rowid WHERE nodes_fts MATCH ? ORDER BY f.rowid LIMIT ?',
      )
      .pluck());
    const ids = stmt.all(`"${q.replaceAll('"', '""')}"`, max + 1) as string[];
    return ids.length > max ? undefined : ids;
  }
  private ftsStmt?: Database.Statement;

  loadGraph(): { graph: GraphBuilder; meta: Record<string, unknown> } {
    const steps = this.loadSteps();
    for (let r = steps.next(); ; r = steps.next()) if (r.done) return r.value;
  }

  /**
   * `loadGraph` that yields to the event loop every few thousand rows, so a server keeps answering
   * (e.g. precomputed views) while a 250k-node graph streams in (C-21).
   */
  async loadGraphAsync(): Promise<{ graph: GraphBuilder; meta: Record<string, unknown> }> {
    const steps = this.loadSteps();
    for (let r = steps.next(); ; r = steps.next()) {
      if (r.done) return r.value;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  private *loadSteps(): Generator<void, { graph: GraphBuilder; meta: Record<string, unknown> }> {
    const CHUNK = 20000;
    const g = new GraphBuilder();
    // raw rows + putEdge: no per-row objects, no edge-id rehashing (G12)
    type NodeRow = [
      string,
      GraphNode['kind'],
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
    ];
    type EdgeRow = [string, GraphEdge['kind'], string, string, number, number, string];
    let n = 0;
    const nodeRows = this.db
      .prepare('SELECT id, kind, name, qname, file, language, parent_id, data FROM nodes ORDER BY rowid')
      .raw()
      .iterate() as IterableIterator<NodeRow>;
    for (const [id, kind, name, qname, file, language, parentId, json] of nodeRows) {
      const data = JSON.parse(json) as {
        span?: GraphNode['span'];
        metrics?: GraphNode['metrics'];
        props?: Record<string, unknown>;
      };
      g.nodes.set(id, {
        id,
        kind,
        name,
        qname: qname ?? undefined,
        file: file ?? undefined,
        language: language ?? undefined,
        parentId: parentId ?? undefined,
        span: data.span,
        metrics: data.metrics,
        props: data.props ?? {},
      });
      if (++n % CHUNK === 0) yield;
    }
    yield;
    const edgeRows = this.db
      .prepare('SELECT id, kind, src, dst, weight, confidence, data FROM edges ORDER BY rowid')
      .raw()
      .iterate() as IterableIterator<EdgeRow>;
    for (const [id, kind, src, dst, weight, confidence, json] of edgeRows) {
      g.putEdge({ id, kind, src, dst, weight, confidence, props: JSON.parse(json) });
      if (++n % CHUNK === 0) yield;
    }
    const meta: Record<string, unknown> = {};
    for (const r of this.db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>)
      meta[r.key] = JSON.parse(r.value);
    return { graph: g, meta };
  }
}
