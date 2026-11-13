import type { EdgeKind, GraphNode, NodeKind } from '@spider/shared';

/**
 * Design tokens — single source of truth (DESIGN_RULES.md §4, §13).
 * CSS variables are generated from this object by `applyTheme`; the WebGL renderer reads the
 * graph palette directly. No component may hard-code a colour.
 */
export const tokens = {
  dark: {
    bgCanvas: '#0A0A0B',
    bgApp: '#101012',
    bgSurface: '#151517',
    bgSurface2: '#1B1B1E',
    bgSurface3: '#222226',
    hairline: 'rgba(255,255,255,0.08)',
    hairlineStrong: 'rgba(255,255,255,0.14)',
    textPrimary: '#F5F5F7',
    textSecondary: '#A1A1A6',
    textTertiary: '#6E6E73',
    textInverse: '#0A0A0B',
    accent: '#3B8BFF',
    accentHover: '#5C9FFF',
    accentSoft: 'rgba(59,139,255,0.14)',
    accentText: '#8AB8FF',
    ok: '#30D158',
    warn: '#FFB340',
    danger: '#FF5A5F',
    shadow1: '0 1px 2px rgba(0,0,0,0.4)',
    shadow2: '0 12px 32px rgba(0,0,0,0.5)',
  },
  light: {
    bgCanvas: '#FFFFFF',
    bgApp: '#F5F5F7',
    bgSurface: '#FFFFFF',
    bgSurface2: '#F2F2F4',
    bgSurface3: '#E9E9EC',
    hairline: 'rgba(0,0,0,0.08)',
    hairlineStrong: 'rgba(0,0,0,0.14)',
    textPrimary: '#1D1D1F',
    textSecondary: '#6E6E73',
    textTertiary: '#A1A1A6',
    textInverse: '#FFFFFF',
    accent: '#0071E3',
    accentHover: '#0077ED',
    accentSoft: 'rgba(0,113,227,0.10)',
    accentText: '#0066CC',
    ok: '#1F9D48',
    warn: '#C77700',
    danger: '#D70015',
    shadow1: '0 1px 2px rgba(0,0,0,0.08)',
    shadow2: '0 12px 32px rgba(0,0,0,0.12)',
  },
} as const;

export type ThemeName = keyof typeof tokens;
export type Tokens = (typeof tokens)[ThemeName];

/** Graph encoding (DESIGN_RULES §4.4). Light theme keeps the order of prominence, inverted in luminance. */
export const graphPalette = {
  dark: {
    node: {
      container: '#2A2A2F',
      containerRing: '#8A8A92',
      file: '#C9C9CF',
      class: '#E5E5EA',
      function: '#9A9AA2',
      method: '#7C7C84',
      variable: '#5A5A62',
      type: '#5A5A62',
      external: '#3A3A40',
      externalRing: '#6E6E73',
      datastore: '#48484F',
    },
    edge: {
      imports: 'rgba(255,255,255,0.22)',
      calls: 'rgba(255,255,255,0.34)',
      instantiates: 'rgba(255,255,255,0.34)',
      extends: 'rgba(255,255,255,0.34)',
      implements: 'rgba(255,255,255,0.34)',
      depends_on: 'rgba(255,255,255,0.14)',
      references: 'rgba(255,255,255,0.12)',
    } as Partial<Record<EdgeKind, string>>,
    region: 'rgba(27,27,30,0.55)',
  },
  light: {
    node: {
      container: '#EDEDF0',
      containerRing: '#8A8A92',
      file: '#76767C',
      class: '#48484D',
      function: '#8E8E95',
      method: '#A1A1A8',
      variable: '#BDBDC3',
      type: '#BDBDC3',
      external: '#E2E2E6',
      externalRing: '#A1A1A6',
      datastore: '#C7C7CC',
    },
    edge: {
      imports: 'rgba(0,0,0,0.22)',
      calls: 'rgba(0,0,0,0.34)',
      instantiates: 'rgba(0,0,0,0.34)',
      extends: 'rgba(0,0,0,0.34)',
      implements: 'rgba(0,0,0,0.34)',
      depends_on: 'rgba(0,0,0,0.14)',
      references: 'rgba(0,0,0,0.12)',
    } as Partial<Record<EdgeKind, string>>,
    region: 'rgba(242,242,244,0.55)',
  },
  subsystems: ['#6E8FB3', '#7FA38B', '#B39A6E', '#A97F8D', '#7E9FA6', '#9C8F72', '#8E7FA9', '#7B9C7B'],
  dim: 0.18,
  hoverDim: 0.35,
} as const;

export const space = [0, 4, 8, 12, 16, 24, 32, 48, 64] as const;
export const radius = { sm: 4, md: 6, lg: 10, xl: 14 } as const;
export const motion = { fast: 120, base: 200, slow: 300, ease: 'cubic-bezier(0.2, 0, 0, 1)' } as const;

const cssName = (k: string) => `--${k.replace(/[A-Z0-9]/g, (m) => `-${m.toLowerCase()}`)}`;

/** Writes the theme's tokens into `:root` CSS variables and records the theme on <html>. */
export function applyTheme(name: ThemeName): void {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(tokens[name])) root.style.setProperty(cssName(k), v);
  root.dataset.theme = name;
  root.style.colorScheme = name;
}

/* ---------- colour maths (WebGL gets opaque colours, pre-blended on the canvas) ---------- */

type RGBA = [number, number, number, number];
const parseCache = new Map<string, RGBA>();

export function parseColor(c: string): RGBA {
  const hit = parseCache.get(c);
  if (hit) return hit;
  let out: RGBA = [0, 0, 0, 1];
  if (c.startsWith('#')) {
    const h = c.length === 4 ? c.replace(/^#(.)(.)(.)$/, '#$1$1$2$2$3$3') : c;
    out = [
      Number.parseInt(h.slice(1, 3), 16),
      Number.parseInt(h.slice(3, 5), 16),
      Number.parseInt(h.slice(5, 7), 16),
      1,
    ];
  } else {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const [r, g, b, a] = m[1].split(',').map((s) => Number.parseFloat(s));
      out = [r, g, b, Number.isFinite(a) ? a : 1];
    }
  }
  parseCache.set(c, out);
  return out;
}

const hex2 = (v: number) =>
  Math.round(Math.max(0, Math.min(255, v)))
    .toString(16)
    .padStart(2, '0');

/** Composites `color` at `alpha` (times its own alpha) over the opaque `bg`, returning opaque hex. */
export function blend(color: string, alpha: number, bg: string): string {
  const [r, g, b, a0] = parseColor(color);
  const [br, bgG, bb] = parseColor(bg);
  const a = a0 * alpha;
  return `#${hex2(r * a + br * (1 - a))}${hex2(g * a + bgG * (1 - a))}${hex2(b * a + bb * (1 - a))}`;
}

/* ---------- node & edge encoding ---------- */

/** Shape ids understood by the node program (graph/program.ts). */
export const SHAPE = { circle: 0, square: 1, roundedSquare: 2, diamond: 3, hexagon: 4 } as const;

export const CONTAINER_KINDS = new Set<NodeKind>([
  'repository',
  'subsystem',
  'package',
  'directory',
  'module',
  'namespace',
]);

export interface NodeLook {
  shape: number;
  fill: string;
  ring?: string;
  ringWidth: number;
}

export function nodeLook(kind: NodeKind, theme: ThemeName): NodeLook {
  const p = graphPalette[theme].node;
  switch (kind) {
    case 'repository':
    case 'subsystem':
    case 'package':
    case 'directory':
    case 'module':
    case 'namespace':
      return { shape: SHAPE.roundedSquare, fill: p.container, ring: p.containerRing, ringWidth: 1 };
    case 'file':
    case 'config':
      return { shape: SHAPE.circle, fill: p.file, ringWidth: 0 };
    case 'class':
      return { shape: SHAPE.square, fill: p.class, ringWidth: 0 };
    case 'function':
      return { shape: SHAPE.circle, fill: p.function, ringWidth: 0 };
    case 'method':
      return { shape: SHAPE.circle, fill: p.method, ringWidth: 0 };
    case 'variable':
      return { shape: SHAPE.circle, fill: p.variable, ringWidth: 0 };
    case 'type':
      return { shape: SHAPE.square, fill: p.type, ringWidth: 0 };
    case 'endpoint':
      return { shape: SHAPE.diamond, fill: tokens[theme].accent, ringWidth: 0 };
    case 'external':
      return { shape: SHAPE.hexagon, fill: p.external, ring: p.externalRing, ringWidth: 1 };
    case 'datastore':
      return { shape: SHAPE.roundedSquare, fill: p.datastore, ringWidth: 0 };
  }
}

/** Classes, interfaces and enums share the `class` kind; `props.classKind` tells them apart. */
export function classKindOf(n: GraphNode): string | undefined {
  return n.kind === 'class' ? ((n.props.classKind as string | undefined) ?? 'class') : undefined;
}

export function edgeColorOf(kind: EdgeKind, theme: ThemeName): string {
  if (kind === 'exposes') return blend(tokens[theme].accent, 0.7, tokens[theme].bgCanvas);
  const c = graphPalette[theme].edge[kind] ?? graphPalette[theme].edge.imports ?? '#888888';
  return blend(c, 1, tokens[theme].bgCanvas);
}

/** Aggregated edge width = 1 + log2(weight), max 6 px. */
export function edgeWidth(weight: number): number {
  return Math.min(6, 1 + Math.log2(Math.max(1, weight)));
}

const clampSize = (v: number) => Math.max(4, Math.min(26, v));

/** Node radius 4–26 px on a log scale of the level's size metric (DESIGN_RULES §8). */
export function nodeSize(n: GraphNode): number {
  const childCount = Number(n.props.childCount ?? 0);
  const deg = (n.metrics?.fanIn ?? 0) + (n.metrics?.fanOut ?? 0);
  switch (n.kind) {
    case 'repository':
    case 'subsystem':
    case 'package':
    case 'directory':
    case 'module':
    case 'namespace':
      return clampSize(8 + 3 * Math.log2(childCount + 1));
    case 'file':
      return clampSize(5 + 1.6 * Math.log2((n.metrics?.loc ?? 0) + 1));
    case 'class':
      return clampSize(6 + 2.5 * Math.log2(deg + childCount + 1));
    case 'endpoint':
      return clampSize(7 + 2 * Math.log2(deg + 1));
    case 'method':
    case 'variable':
    case 'type':
      return clampSize(3.5 + 2 * Math.log2(deg + 1));
    default:
      return clampSize(4.5 + 2.5 * Math.log2(deg + 1));
  }
}

/** Stable categorical colour for subsystem identity (off by default). */
export function subsystemColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return graphPalette.subsystems[h % graphPalette.subsystems.length];
}

/* ---------- vocabulary shared by panels ---------- */

export const KIND_LABEL: Record<NodeKind, string> = {
  repository: 'repo',
  subsystem: 'subsystem',
  package: 'package',
  directory: 'dir',
  module: 'module',
  namespace: 'namespace',
  file: 'file',
  class: 'class',
  function: 'function',
  method: 'method',
  variable: 'var',
  type: 'type',
  endpoint: 'endpoint',
  external: 'external',
  datastore: 'store',
  config: 'config',
};

export const LEGEND_NODE_KINDS: NodeKind[] = [
  'directory',
  'file',
  'class',
  'function',
  'method',
  'endpoint',
  'external',
];
export const LEGEND_EDGE_KINDS: EdgeKind[] = [
  'imports',
  'calls',
  'instantiates',
  'extends',
  'implements',
  'exposes',
  'depends_on',
];

/** Edge kinds offered in the filter panel, and the projection default. */
export const FILTER_EDGE_KINDS: EdgeKind[] = [
  'imports',
  'calls',
  'instantiates',
  'extends',
  'implements',
  'references',
  'exposes',
  'depends_on',
];
export const DEFAULT_EDGE_KINDS: EdgeKind[] = [
  'imports',
  'calls',
  'instantiates',
  'extends',
  'implements',
  'exposes',
  'depends_on',
];
export const FILTER_NODE_KINDS: NodeKind[] = [
  'directory',
  'file',
  'class',
  'function',
  'method',
  'variable',
  'type',
  'endpoint',
  'external',
];
