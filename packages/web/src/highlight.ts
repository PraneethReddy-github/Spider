import type { HighlighterCore, LanguageRegistration, ThemeRegistration } from 'shiki/core';

/**
 * Lazy Shiki tokenizer for the Source panel. Shiki, the JS regex engine and each grammar are separate
 * chunks fetched on first use. Tokens come back as one of four tones, which CSS
 * maps to theme tokens, so both themes work without re-highlighting.
 */
export type Tone = 1 | 2 | 3 | 4; // primary, secondary, tertiary, accent-text
export interface Token {
  text: string;
  tone: Tone;
}

type LangModule = { default: LanguageRegistration[] };
const LANGS: Record<string, () => Promise<LangModule>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
};
const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  py: 'python',
  pyi: 'python',
  json: 'json',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  cs: 'csharp',
  rb: 'ruby',
  php: 'php',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  swift: 'swift',
  sh: 'shellscript',
};

export function grammarFor(language: string | undefined, path: string): string | undefined {
  const lang = language === 'shell' ? 'shellscript' : language;
  if (lang && lang in LANGS) return lang;
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return BY_EXT[ext];
}

// Sentinel colours: Shiki resolves scopes to one of these; tokenize() turns them back into tones.
const TONE_OF: Record<string, Tone> = { '#000001': 1, '#000002': 2, '#000003': 3, '#000004': 4 };
const THEME: ThemeRegistration = {
  name: 'spider-mono',
  type: 'dark',
  fg: '#000001',
  bg: '#000000',
  settings: [
    { settings: { foreground: '#000001' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#000003' } },
    {
      scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.operator.new', 'variable.language'],
      settings: { foreground: '#000002' },
    },
    {
      scope: ['string', 'constant.numeric', 'constant.language', 'constant.character', 'string.regexp'],
      settings: { foreground: '#000004' },
    },
    { scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: '#000003' } },
    { scope: ['entity.name', 'support.function', 'meta.function-call'], settings: { foreground: '#000001' } },
  ],
};

let core: Promise<HighlighterCore> | undefined;
const loaded = new Set<string>();

function highlighter(): Promise<HighlighterCore> {
  core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript')]).then(([s, e]) =>
    s.createHighlighterCore({ themes: [THEME], langs: [], engine: e.createJavaScriptRegexEngine() }),
  );
  return core;
}

/** Tokens per line, or undefined when the language has no grammar here (render plain). */
export async function tokenize(lines: string[], lang: string | undefined): Promise<Token[][] | undefined> {
  const load = lang ? LANGS[lang] : undefined;
  if (!lang || !load) return undefined;
  const h = await highlighter();
  if (!loaded.has(lang)) {
    await h.loadLanguage((await load()).default);
    loaded.add(lang);
  }
  return h
    .codeToTokensBase(lines.join('\n'), { lang, theme: THEME.name as string })
    .map((line) => line.map((t) => ({ text: t.content, tone: TONE_OF[(t.color ?? '').toLowerCase()] ?? 1 })));
}
