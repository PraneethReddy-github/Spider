import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import { OpenAiCompatibleProvider } from '../src/llm/openai.js';
import type { LlmMessage, LlmTool } from '../src/llm/types.js';

/** One local server; each test queues the response it wants and reads back what was sent. */
let server: http.Server;
let base = '';
const seen: { url: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
let respond: (res: http.ServerResponse) => void = (res) => res.end();

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      seen.push({ url: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') });
      respond(res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const tools: LlmTool[] = [
  {
    name: 'search',
    description: 'Search the graph',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
];

function sse(res: http.ServerResponse, events: Record<string, unknown>[]) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

describe('AnthropicProvider wire format', () => {
  it('streams with effort, fallbacks and eager tool inputs, and replays raw content', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    respond = (res) =>
      sse(res, [
        {
          type: 'message_start',
          message: {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: thinking },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Looking' } },
        { type: 'content_block_stop', index: 1 },
        {
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'tu_1', name: 'search', input: {} },
        },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"auth"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 9 } },
        { type: 'message_stop' },
      ]);
    const p = new AnthropicProvider('claude-opus-5-5', { baseURL: base });
    const deltas: string[] = [];
    const r = await p.chat({
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'where is auth?' }] }],
      tools,
      onText: (d) => deltas.push(d),
    });
    expect(deltas.join('')).toBe('Looking');
    expect(r.stop).toBe('tool_use');
    expect(r.content).toEqual([
      { type: 'text', text: 'Looking' },
      { type: 'tool_use', id: 'tu_1', name: 'search', input: { q: 'auth' } },
    ]);
    const req = seen.at(-1)!;
    expect(req.url).toMatch(/^\/v1\/messages/);
    expect(String(req.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(req.body).toMatchObject({
      model: 'claude-opus-5-5',
      stream: true,
      system: 'sys',
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      tools: [{ name: 'search', eager_input_streaming: true }],
    });

    // second turn: the assistant's raw content (thinking block included) goes back verbatim
    const history: LlmMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'where is auth?' }] },
      { role: 'assistant', content: r.content, raw: r.raw },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu_1', content: '[]' }] },
    ];
    await p.chat({ system: 'sys', messages: history, tools });
    const msgs = seen.at(-1)!.body.messages as { role: string; content: Record<string, unknown>[] }[];
    expect(msgs[1].content[0]).toMatchObject({ type: 'thinking', signature: 'sig' });
    expect(msgs[2].content[0]).toEqual({ type: 'tool_result', tool_use_id: 'tu_1', content: '[]' });
  });

  it('omits fallbacks for models that do not take them', async () => {
    await new AnthropicProvider('claude-haiku-5-5', { baseURL: base })
      .chat({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
      .catch(() => undefined);
    expect(seen.at(-1)!.body.fallbacks).toBeUndefined();
    expect(seen.at(-1)!.headers['anthropic-beta']).toBeUndefined();
  });
});

describe('OpenAiCompatibleProvider wire format', () => {
  it('maps tools, tool calls and tool results', async () => {
    respond = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'qwen3',
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"db"}' } }],
              },
            },
          ],
        }),
      );
    };
    const p = new OpenAiCompatibleProvider('qwen3', `${base}/v1`, '');
    const r = await p.chat({
      system: 'sys',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'q' }] }],
      tools,
    });
    expect(r).toMatchObject({
      stop: 'tool_use',
      content: [{ type: 'tool_use', id: 'c1', name: 'search', input: { q: 'db' } }],
    });
    expect(seen.at(-1)!.url).toBe('/v1/chat/completions');
    expect(seen.at(-1)!.body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'search', description: 'Search the graph', parameters: tools[0].inputSchema },
      },
    ]);

    await p.chat({
      system: 'sys',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: r.content },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'found' }] },
      ],
    });
    expect(seen.at(-1)!.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search', arguments: '{"q":"db"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'found' },
    ]);
  });
});
