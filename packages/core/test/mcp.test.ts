import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { createMcpHandler } from '../src/mcp.js';
import { FIXTURES } from './helpers.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'spider-mcp-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

type Result = { content: { type: string; text: string }[]; isError?: boolean };

describe('C-25 MCP handler', () => {
  beforeAll(async () => {
    await analyze({ source: path.join(FIXTURES, 'ts-express'), home });
    await analyze({ source: path.join(FIXTURES, 'py-fastapi'), home });
  }, 60_000);

  const rpc = async (h: ReturnType<typeof createMcpHandler>, method: string, params?: Record<string, unknown>) => {
    const r = await h({ jsonrpc: '2.0', id: 1, method, params });
    if (!r || !('result' in r)) throw new Error(JSON.stringify(r));
    return r.result as Record<string, unknown>;
  };

  it('initialises, negotiates the protocol version and ignores notifications', async () => {
    const h = createMcpHandler({ home, version: '9.9.9' });
    expect(await rpc(h, 'initialize', { protocolVersion: '2025-03-26' })).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'spider', version: '9.9.9' },
    });
    expect((await rpc(h, 'initialize', { protocolVersion: '1999-01-01' })).protocolVersion).toBe('2025-06-18');
    expect(await h({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    expect(await h({ jsonrpc: '2.0', id: 2, method: 'resources/list' })).toMatchObject({ error: { code: -32601 } });
  });

  it('lists the graph tools with a repo argument', async () => {
    const { tools } = (await rpc(createMcpHandler({ home }), 'tools/list')) as {
      tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[];
    };
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_repos', 'search', 'trace', 'source']));
    expect(tools.find((t) => t.name === 'search')?.inputSchema.properties.repo).toBeDefined();
  });

  it('answers tool calls per repo, and needs a repo when several exist', async () => {
    const h = createMcpHandler({ home });
    const repos = JSON.parse(((await rpc(h, 'tools/call', { name: 'list_repos' })) as Result).content[0].text);
    expect(repos.map((r: { name: string }) => r.name).sort()).toEqual(['py-fastapi', 'ts-express']);

    const ambiguous = (await rpc(h, 'tools/call', { name: 'search', arguments: { query: 'User' } })) as Result;
    expect(ambiguous).toMatchObject({ isError: true });

    const hits = (await rpc(h, 'tools/call', {
      name: 'search',
      arguments: { query: 'UserService', repo: 'ts-express' },
    })) as Result;
    expect(JSON.parse(hits.content[0].text)[0]).toMatchObject({ name: 'UserService', kind: 'class' });

    const pinned = createMcpHandler({ home, repo: 'py-fastapi' });
    const eps = (await rpc(pinned, 'tools/call', { name: 'endpoints' })) as Result;
    expect(JSON.parse(eps.content[0].text).items.length).toBeGreaterThan(0);

    const bad = (await rpc(pinned, 'tools/call', { name: 'search', arguments: {} })) as Result;
    expect(bad).toMatchObject({ isError: true, content: [{ text: 'invalid input: missing "query"' }] });
    expect(await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'rm' } })).toMatchObject({
      error: { code: -32602 },
    });
  });
});
