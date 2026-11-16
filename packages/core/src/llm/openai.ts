import type { ChatRequest, ChatResponse, LlmBlock, LlmProvider, StopReason } from './types.js';

export const OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

interface OaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/**
 * Any OpenAI-compatible `/chat/completions` endpoint (OpenAI, vLLM, LM Studio, Ollama's `/v1`). Key from
 * `OPENAI_API_KEY` when set (local servers need none).
 * shortcut: not streamed — `onText` receives the whole answer at once; stream if long local answers feel slow.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai' as const;

  constructor(
    readonly model: string,
    private readonly baseUrl: string,
    private readonly apiKey = process.env.OPENAI_API_KEY,
  ) {}

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const messages: OaMessage[] = [{ role: 'system', content: req.system }];
    for (const m of req.messages) {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      if (m.role === 'assistant') {
        const calls = m.content.flatMap((b) =>
          b.type === 'tool_use'
            ? [{ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }]
            : [],
        );
        messages.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      } else {
        for (const b of m.content)
          if (b.type === 'tool_result') messages.push({ role: 'tool', tool_call_id: b.toolUseId, content: b.content });
        if (text) messages.push({ role: 'user', content: text });
      }
    }
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: req.signal,
      headers: {
        'content-type': 'application/json',
        ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: req.maxTokens ?? 4096,
        messages,
        ...(req.tools?.length
          ? {
              tools: req.tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.inputSchema },
              })),
            }
          : {}),
      }),
    });
    if (!res.ok) throw new Error(`${this.baseUrl}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as {
      model?: string;
      choices: { finish_reason: string; message: OaMessage }[];
    };
    const choice = data.choices[0];
    const content: LlmBlock[] = [];
    if (choice?.message.content) {
      content.push({ type: 'text', text: choice.message.content });
      req.onText?.(choice.message.content);
    }
    for (const c of choice?.message.tool_calls ?? []) {
      let input: unknown;
      try {
        input = JSON.parse(c.function.arguments || '{}');
      } catch {
        input = { INVALID_JSON: c.function.arguments };
      }
      content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
    }
    const f = choice?.finish_reason;
    const stop: StopReason =
      content.some((b) => b.type === 'tool_use') || f === 'tool_calls'
        ? 'tool_use'
        : f === 'stop'
          ? 'end'
          : f === 'length'
            ? 'max_tokens'
            : f === 'content_filter'
              ? 'refusal'
              : 'other';
    return { content, stop, model: data.model ?? this.model };
  }
}
