// Shared scaffolding for the resources test suites: a fake Drive, a connected
// SDK client per profile, the request context, and captured log lines

import { afterEach, beforeEach, expect, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from './server.js';
import { requestContext } from './auth.js';
import { resolveGrant } from './scopes.js';
import { LABEL_SCHEMA_BODY } from './testStubs.js';
import { extract } from './pdfExtractStub.js';

export { extract };

export const SECRET = 'Q3-salaries-secret';
export const ID = '1AbCdEfGhIjK_secret';
export const TOKEN = `tok-${SECRET}`;
export const DOC_URI = `https://docs.google.com/document/d/${ID}/edit`;
export const WEB = (id = ID) => `https://drive.google.com/file/d/${id}/view?usp=drivesdk`;

export type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
export type Route = [string | ((url: string) => boolean), Handler];

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const googleError = (status: number, reason?: string, message = `error ${status}`) =>
  json({ error: { code: status, message, ...(reason ? { errors: [{ reason, message }] } : {}) } }, status);

// Waits for the signal, then rejects with its reason, like fetch does
export const stall = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

export function stubFetch(routes: Route[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      if (typeof match === 'string' ? url.includes(match) : match(url)) return handler(url, init);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return calls;
}

export const isMeta = (url: string) => /\/drive\/v3\/files\/[^/?]+\?fields=/.test(url);
export const isList = (url: string) => url.includes('/drive/v3/files?');
export const keyHeader = (init?: RequestInit) => new Headers(init?.headers).get('x-goog-drive-resource-keys');

export const LABEL_ROUTES: Route[] = [
  ['listLabels', () => json({ labels: [{ id: 'lbl1', revisionId: 'r1', fields: { field1: { valueType: 'selection', selection: ['choiceA'] } } }] })],
  ['drivelabels.googleapis.com', () => json({ properties: { title: 'Classification' }, ...LABEL_SCHEMA_BODY })],
];
export const EXPECTED_LABELS = {
  applied: [{
    labelId: 'lbl1', revisionId: 'r1', title: 'Classification', resolved: true,
    values: [{ fieldId: 'field1', valueType: 'selection', choiceId: 'choiceA', displayName: 'Confidential', resolved: true }],
  }],
};

export function meta(mimeType: string, extra: Record<string, unknown> = {}) {
  return { id: ID, name: `${SECRET} file`, mimeType, webViewLink: WEB(), ...extra };
}

export async function connect(profile?: string) {
  if (profile === undefined) delete process.env.PROFILE;
  else process.env.PROFILE = profile;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await createServer(resolveGrant()).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

export function asUser<T>(run: () => Promise<T>, accessToken = TOKEN): Promise<T> {
  return requestContext.run({ accessToken, grant: resolveGrant() }, run);
}

export async function read(uri: string, profile = 'standard-resources') {
  const client = await connect(profile);
  return asUser(() => client.readResource({ uri }));
}

export async function readError(uri: string, profile = 'standard-resources'): Promise<McpError> {
  const err = await read(uri, profile).catch((e) => e);
  expect(err).toBeInstanceOf(McpError);
  return err;
}

export async function list(cursor?: string) {
  const client = await connect('standard-resources');
  return asUser(() => client.listResources(cursor ? { cursor } : {}));
}

let written: unknown[][] = [];
export const logLines = () => written.map(([chunk]) => String(chunk));
export const records = () => logLines().map((l: string) => JSON.parse(l));

// Call once at the top of a suite: captures stdout per test and resets the
// profile, fetch stub, mocks, timers and extractor after each
export function useResourceFixtures(): void {
  beforeEach(() => {
    extract.impl = undefined;
    written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true).mock.calls;
  });

  afterEach(() => {
    delete process.env.PROFILE;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
}
