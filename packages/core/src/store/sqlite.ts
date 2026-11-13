import { promises as fs } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { GraphEdge, GraphNode } from '@spider/shared';
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
CREATE INDEX IF NOT EXISTS nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS nodes_file ON nodes(file);
CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  weight REAL NOT NULL,
  confidence REAL NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src, kind);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst, kind);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export class SqliteStore {
  private constructor(private db: Database.Database) {}

  static async open(file: string): Promise<SqliteStore> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = OFF');
    db.exec(SCHEMA);
    return new SqliteStore(db);
  }

  close(): void {
    this.db.close();
  }

  saveGraph(g: GraphBuilder, meta: Record<string, unknown>): void {
    const db = this.db;
    const insNode = db.prepare('INSERT OR REPLACE INTO nodes VALUES (@id,@kind,@name,@qname,@file,@language,@parent_id,@start_line,@end_line,@data)');
    const insEdge = db.prepare('INSERT OR REPLACE INTO edges VALUES (@id,@kind,@src,@dst,@weight,@confidence,@data)');
    const insMeta = db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)');
    db.transaction(() => {
      db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM meta;');
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
        insEdge.run({ id: e.id, kind: e.kind, src: e.src, dst: e.dst, weight: e.weight, confidence: e.confidence, data: JSON.stringify(e.props) });
      }
      for (const [k, v] of Object.entries(meta)) insMeta.run(k, JSON.stringify(v));
    })();
  }

  loadGraph(): { graph: GraphBuilder; meta: Record<string, unknown> } {
    const g = new GraphBuilder();
    const nodeRows = this.db.prepare('SELECT * FROM nodes').all() as Array<Record<string, unknown>>;
    // Insert without auto-contains edges (they're persisted explicitly).
    for (const r of nodeRows) {
      const data = JSON.parse(r.data as string) as { span?: GraphNode['span']; metrics?: GraphNode['metrics']; props: Record<string, unknown> };
      const node: GraphNode = {
        id: r.id as string,
        kind: r.kind as GraphNode['kind'],
        name: r.name as string,
        qname: (r.qname as string) ?? undefined,
        file: (r.file as string) ?? undefined,
        language: (r.language as string) ?? undefined,
        parentId: (r.parent_id as string) ?? undefined,
        span: data.span,
        metrics: data.metrics,
        props: data.props ?? {},
      };
      g.nodes.set(node.id, node);
    }
    const edgeRows = this.db.prepare('SELECT * FROM edges').all() as Array<Record<string, unknown>>;
    for (const r of edgeRows) {
      const e: GraphEdge = {
        id: r.id as string,
        kind: r.kind as GraphEdge['kind'],
        src: r.src as string,
        dst: r.dst as string,
        weight: r.weight as number,
        confidence: r.confidence as number,
        props: JSON.parse(r.data as string),
      };
      g.addEdge(e.kind, e.src, e.dst, { weight: e.weight, confidence: e.confidence, props: e.props });
      // addEdge stores weight cumulatively; set exact values
      const stored = g.edges.get(e.id);
      if (stored) {
        stored.weight = e.weight;
        stored.confidence = e.confidence;
        stored.props = e.props;
      }
    }
    const meta: Record<string, unknown> = {};
    for (const r of this.db.prepare('SELECT key, value FROM meta').all() as Array<{ key: string; value: string }>) meta[r.key] = JSON.parse(r.value);
    return { graph: g, meta };
  }
}
