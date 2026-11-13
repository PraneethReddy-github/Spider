import { pythonExtractor } from './python/extractor.js';
import type { LanguageExtractor } from './types.js';
import { typescriptExtractor } from './typescript/extractor.js';

const registry = new Map<string, LanguageExtractor>();
for (const ex of [typescriptExtractor, pythonExtractor]) for (const l of ex.languages) registry.set(l, ex);

export function getExtractor(language: string): LanguageExtractor | undefined {
  return registry.get(language);
}

export function extractableLanguages(): string[] {
  return [...registry.keys()];
}
