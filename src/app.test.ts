import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp, MCP_PATH } from './app.js';
import { grantedScopes } from './scopes.js';

const realFetch = globalThis.fetch;
let httpServer: Server;
let url: string;

beforeAll(async () => {
  // labels.ts reads PROFILE per call; standard lacks the labels scope, so
  // get_file_metadata makes a single Drive request
  process.env.PROFILE = 'standard';
  httpServer = createApp(grantedScopes()).listen(0, '127.0.0.1');
  await new Promise((resolve) => httpServer.once('listening', resolve));
  url = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}${MCP_PATH}`;
});

afterAll(async () => {
  delete process.env.PROFILE;
  await new Promise((resolve) => httpServer.close(resolve));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

describe('tool error logging', () => {
  it('logs status and reason of a failed tool call, but not its message or the caller token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 404, message: 'File not found: secret-id.', errors: [{ reason: 'notFound' }] } }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )));
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    const { message } = await callTool(1, 'token-1');

    expect(message.result.isError).toBe(true);
    expect(JSON.stringify(message.result)).toContain('secret-id');
    const lines = written.mock.calls.map(([chunk]) => String(chunk)).filter((l) => l.includes('tool_call_error'));
    expect(lines).toHaveLength(1);
    const { ts, ...record } = JSON.parse(lines[0]);
    expect(record).toEqual({
      level: 'warn',
      event: 'tool_call_error',
      tool: 'get_file_metadata',
      status: 404,
      reason: 'notFound',
    });
    expect(lines[0]).not.toContain('token-1');
  });
});
