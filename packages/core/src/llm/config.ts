import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spiderHome } from '../analyze.js';
import { AnthropicProvider, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { OLLAMA_BASE_URL, OpenAiCompatibleProvider } from './openai.js';
import type { LlmProvider } from './types.js';

/** `SPIDER_HOME/config.json` → `llm`. API keys are never stored here; they come from the environment. */
export interface LlmConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  model?: string;
  baseUrl?: string;
}

const PROVIDERS = new Set(['anthropic', 'openai', 'ollama']);

/**
 * The configured provider, or undefined: model features are opt-in, so nothing is sent anywhere unless
 * `SPIDER_LLM_PROVIDER` (or `config.json` `llm.provider`) names one. Env vars override the file.
 */
export function llmConfig(home?: string): LlmConfig | undefined {
  let file: Partial<LlmConfig> = {};
  try {
    const raw = JSON.parse(readFileSync(path.join(spiderHome(home), 'config.json'), 'utf8')) as { llm?: unknown };
    if (raw.llm && typeof raw.llm === 'object') file = raw.llm as Partial<LlmConfig>;
  } catch {
    // no config file (or unreadable): env only
  }
  const provider = process.env.SPIDER_LLM_PROVIDER ?? file.provider;
  if (!provider || provider === 'none') return undefined;
  if (!PROVIDERS.has(provider))
    throw new Error(`unknown SPIDER_LLM_PROVIDER "${provider}" (anthropic | openai | ollama)`);
  return {
    provider: provider as LlmConfig['provider'],
    model: process.env.SPIDER_LLM_MODEL ?? file.model,
    baseUrl: process.env.SPIDER_LLM_BASE_URL ?? file.baseUrl,
  };
}

export function createProvider(cfg: LlmConfig | undefined): LlmProvider | undefined {
  if (!cfg) return undefined;
  if (cfg.provider === 'anthropic')
    return new AnthropicProvider(cfg.model ?? DEFAULT_ANTHROPIC_MODEL, { baseURL: cfg.baseUrl });
  if (!cfg.model) throw new Error(`SPIDER_LLM_MODEL is required for the ${cfg.provider} provider`);
  if (cfg.provider === 'ollama') return new OpenAiCompatibleProvider(cfg.model, cfg.baseUrl ?? OLLAMA_BASE_URL);
  return new OpenAiCompatibleProvider(cfg.model, cfg.baseUrl ?? 'https://api.openai.com/v1');
}

/** `createProvider(llmConfig(home))`. */
export function configuredProvider(home?: string): LlmProvider | undefined {
  return createProvider(llmConfig(home));
}
