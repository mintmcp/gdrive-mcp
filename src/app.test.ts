import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, MCP_PATH } from './app.js';

const realFetch = globalThis.fetch;
let httpServer: Server;
let url: string;

beforeAll(async () => {
  process.env.PROFILE = 'standard';
  httpServer = createApp(null).listen(0, '127.0.0.1');
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

// Slow Drive API that answers with the caller's token as the file name, so a
// response routed to the wrong request (or a leaked token) is visible
function stubSlowDrive() {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const target = String(input);
    if (!target.includes('googleapis.com')) return realFetch(input, init);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '');
    return new Response(JSON.stringify({ id: 'f1', name: token, mimeType: 'text/plain' }), {
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
  const data = body.split('\n').find((line) => line.startsWith('data: '));
  return { status: res.status, message: JSON.parse(data ? data.slice(6) : body) };
}

describe('concurrent MCP requests', () => {
  it('serves overlapping tools/call requests without "Already connected"', async () => {
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

  it('keeps serving after a burst', async () => {
    stubSlowDrive();
    await Promise.all([callTool(1, 'a'), callTool(2, 'b')]);
    const { message } = await callTool(3, 'c');
    expect(message.result.structuredContent.name).toBe('c');
  });
});
