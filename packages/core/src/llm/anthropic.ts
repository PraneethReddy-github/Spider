import Anthropic from '@anthropic-ai/sdk';
import type { ChatRequest, ChatResponse, LlmBlock, LlmMessage, LlmProvider, StopReason } from './types.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
/** Models that take the server-side refusal fallback (`fallbacks: "default"`); others reject the parameter. */
const FALLBACK_MODELS = new Set([
  'claude-fable-5-2',
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);

/**
 * Claude via the official SDK. Credentials resolve the SDK's way (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, an
 * `ant auth login` profile). Streams every request (long thinking turns would otherwise hit HTTP timeouts).
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  private readonly client: Anthropic;

  constructor(
    readonly model = DEFAULT_ANTHROPIC_MODEL,
    opts: { baseURL?: string } = {},
  ) {
    this.client = new Anthropic(opts.baseURL ? { baseURL: opts.baseURL } : {});
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const fallback = FALLBACK_MODELS.has(this.model);
    const stream = this.client.beta.messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? 32000,
        system: req.system,
        output_config: { effort: req.effort ?? 'medium' },
        ...(fallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
                // inputs stream as generated; callers validate them before running a tool
                eager_input_streaming: true,
              })),
            }
          : {}),
        messages: req.messages.map(toParam),
      },
      { signal: req.signal },
    );
    if (req.onText) stream.on('text', req.onText);
    const msg = await stream.finalMessage();
    const content: LlmBlock[] = [];
    for (const b of msg.content) {
      if (b.type === 'text') content.push({ type: 'text', text: b.text });
      else if (b.type === 'tool_use') content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input });
    }
    return { content, raw: msg.content, stop: stopOf(msg.stop_reason), model: msg.model };
  }
}

function stopOf(s: string | null): StopReason {
  if (s === 'end_turn' || s === 'stop_sequence') return 'end';
  if (s === 'tool_use' || s === 'max_tokens' || s === 'refusal') return s;
  return 'other';
}

function toParam(m: LlmMessage): Anthropic.Beta.BetaMessageParam {
  if (m.role === 'assistant' && m.raw)
    return { role: 'assistant', content: m.raw as Anthropic.Beta.BetaContentBlock[] };
  return {
    role: m.role,
    content: m.content.map((b): Anthropic.Beta.BetaContentBlockParam => {
      if (b.type === 'text') return { type: 'text', text: b.text };
      if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input };
      return { type: 'tool_result', tool_use_id: b.toolUseId, content: b.content, is_error: b.isError };
    }),
  };
}
