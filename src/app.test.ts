import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, MCP_PATH } from './app.js';
import { resolveGrant } from './scopes.js';

const realFetch = globalThis.fetch;
let httpServer: Server;
let url: string;

beforeAll(async () => {
  // labels.ts reads PROFILE per call; this profile lacks the labels scope, so
  // get_file_metadata makes a single Drive request
  process.env.PROFILE = 'standard-resources';
  httpServer = createApp(resolveGrant()).listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}${MCP_PATH}`;
});

afterAll(async () => {
  delete process.env.PROFILE;
  await new Promise((resolve) => httpServer.close(resolve));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Slow enough that every request is in flight at once; echoes the caller's
// token as the file name so a response carrying another caller's data fails
function stubSlowDrive() {
  vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init?: RequestInit) => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
    return new Response(JSON.stringify({ id: 'f1', name: token }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
}

async function callTool(id: number, token: string) {
  const res = await realFetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'get_file_metadata', arguments: { file_id: 'f1' } },
    }),
  });
  const body = await res.text();
  // Success is an SSE event; the 500 error path is plain JSON
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  return { status: res.status, message: JSON.parse(data ? data.slice(6) : body) };
}

describe('concurrent MCP requests', () => {
  it('serves overlapping tools/call requests, each with its own caller token', async () => {
    stubSlowDrive();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => callTool(i + 1, `token-${i + 1}`)),
    );

    results.forEach(({ status, message }, i) => {
      expect(status).toBe(200);
      expect(message.error).toBeUndefined();
      expect(message.id).toBe(i + 1);
      expect(message.result.isError).toBeUndefined();
      expect(message.result.structuredContent.name).toBe(`token-${i + 1}`);
    });
  });
});

describe('auth gate', () => {
  async function post(body: unknown) {
    return realFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });
  }

  it.each(['resources/list', 'resources/read', 'resources/templates/list'])(
    'answers %s without a token with 401 and WWW-Authenticate',
    async (method) => {
      const res = await post({ jsonrpc: '2.0', id: 7, method, params: method === 'resources/read' ? { uri: 'https://drive.google.com/file/d/1234567890ab/view' } : {} });
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/^Bearer realm="gdrive-mcp", error="invalid_token"/);
      expect((await res.json()).id).toBe(7);
    },
  );

  it('keeps initialize open without a token', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const data = body.split('\n').find((line) => line.startsWith('data: '));
    expect(JSON.parse(data ? data.slice(6) : body).result.capabilities.resources).toEqual({});
  });
});
