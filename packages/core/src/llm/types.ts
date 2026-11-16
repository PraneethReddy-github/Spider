/**
 * Provider-neutral chat model interface (C-23). Every model-backed feature goes through `LlmProvider`, so the
 * Anthropic default and OpenAI-compatible endpoints (incl. local Ollama) are interchangeable.
 */

export type LlmBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: LlmBlock[];
  /** Provider-native assistant content, replayed verbatim on the next turn (keeps thinking blocks intact). */
  raw?: unknown;
}

export interface LlmTool {
  name: string;
  description: string;
  /** JSON Schema of the input object. */
  inputSchema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: LlmMessage[];
  tools?: LlmTool[];
  maxTokens?: number;
  effort?: 'low' | 'medium' | 'high';
  /** Text deltas as they stream. */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

export type StopReason = 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other';

export interface ChatResponse {
  content: LlmBlock[];
  /** Provider-native assistant content; put it on the next `LlmMessage.raw`. */
  raw?: unknown;
  stop: StopReason;
  /** Model that produced the answer (may differ from the configured one after a fallback). */
  model: string;
}

export interface LlmProvider {
  readonly name: 'anthropic' | 'openai';
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** Text of a response (all text blocks joined). */
export function textOf(r: { content: LlmBlock[] }): string {
  return r.content
    .filter((b): b is Extract<LlmBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}
