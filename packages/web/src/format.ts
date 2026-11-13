import type { GraphNode } from '@spider/shared';
import type { DiagnosticType } from './api';

/** Thin-space thousands separators (DESIGN_RULES §10): 12 408. */
export function fmtNum(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '–';
  const [int, frac] = (Number.isInteger(n) ? String(n) : n.toFixed(2)).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return frac ? `${grouped}.${frac}` : grouped;
}

export function fmtDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

export function fmtRelative(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d} d ago`;
  return new Date(t).toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function shortSource(src: string): string {
  return src.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
}

export function nodeLabel(n: GraphNode): string {
  if (n.kind === 'endpoint' && n.props.path) {
    const m = n.props.method ? `${String(n.props.method).toUpperCase()} ` : '';
    return `${m}${String(n.props.path)}`;
  }
  return n.name;
}

/** `file:line` for nodes with a span, the file path for files, otherwise undefined. */
export function locationOf(n: GraphNode): string | undefined {
  if (n.span) return `${n.span.file}:${n.span.startLine}`;
  return n.file;
}

/** Diagnostic group names and display order (Explorer Issues tab and the Issues view). */
export const DIAG_LABEL: Record<DiagnosticType, string> = {
  cycle: 'Import cycles',
  'layer-violation': 'Layer violations',
  'god-module': 'Large hubs',
  'dead-code': 'Unreferenced exports',
  orphan: 'Orphan files',
};
export const DIAG_ORDER: DiagnosticType[] = ['cycle', 'layer-violation', 'god-module', 'dead-code', 'orphan'];
