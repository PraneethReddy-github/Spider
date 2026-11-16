import { csharpExtractor } from './csharp/extractor.js';
import { goExtractor } from './go/extractor.js';
import { javaExtractor } from './java/extractor.js';
import { kotlinExtractor } from './kotlin/extractor.js';
import { pythonExtractor } from './python/extractor.js';
import { rustExtractor } from './rust/extractor.js';
import type { LanguageExtractor } from './types.js';
import { typescriptExtractor } from './typescript/extractor.js';

const registry = new Map<string, LanguageExtractor>();
for (const ex of [
  typescriptExtractor,
  pythonExtractor,
  javaExtractor,
  kotlinExtractor,
  csharpExtractor,
  goExtractor,
  rustExtractor,
])
  for (const l of ex.languages) registry.set(l, ex);

export function getExtractor(language: string): LanguageExtractor | undefined {
  return registry.get(language);
}

export function extractableLanguages(): string[] {
  return [...registry.keys()];
}
