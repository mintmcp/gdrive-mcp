import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createServer, logToolSurface } from './server.js';
import { requestContext } from './auth.js';
import { grantedScopes, PROFILES } from './scopes.js';
import { EXTRACT_TIMEOUT_MS, MAX_TEXT_CHARS, type PdfText } from './pdfText.js';
import { MAX_FILE_SIZE, TEXTUAL_APPLICATION_MIMES } from './tools.js';
import { parseDriveSize, resourceListQuery } from './resources.js';
import { LABEL_SCHEMA_BODY } from './testStubs.js';
import {
  FOLDER_LISTING_PAGE_SIZE,
  RESOURCE_LIST_MAX_EXTRA_PAGES,
  RESOURCE_LIST_PAGE_SIZE,
  RESOURCE_READ_DEADLINE_MS,
} from './limits.js';

// resources/read hands PDFs to the unchanged extractor; tests drive its outcome
const extract = vi.hoisted(() => ({ impl: undefined as undefined | ((bytes: Uint8Array, options: any) => Promise<PdfText>) }));
vi.mock('./pdfText.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pdfText.js')>();
  return {
    ...actual,
    extractPdfText: vi.fn((bytes: Uint8Array, options: any) =>
      extract.impl ? extract.impl(bytes, options) : actual.extractPdfText(bytes, options)),
  };
});

const SECRET = 'Q3-salaries-secret';
const ID = '1AbCdEfGhIjK_secret';
const TOKEN = `tok-${SECRET}`;
const DOC_URI = `https://docs.google.com/document/d/${ID}/edit`;
const WEB = (id = ID) => `https://drive.google.com/file/d/${id}/view?usp=drivesdk`;

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
type Route = [string | ((url: string) => boolean), Handler];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const googleError = (status: number, reason?: string, message = `error ${status}`) =>
  json({ error: { code: status, message, ...(reason ? { errors: [{ reason, message }] } : {}) } }, status);

// Waits for the signal, then rejects with its reason, like fetch does
const stall = (init?: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const signal = init?.signal;
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

function stubFetch(routes: Route[]) {
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

const isMeta = (url: string) => /\/drive\/v3\/files\/[^/?]+\?fields=/.test(url);
const isList = (url: string) => url.includes('/drive/v3/files?');
const keyHeader = (init?: RequestInit) => new Headers(init?.headers).get('x-goog-drive-resource-keys');

const LABEL_ROUTES: Route[] = [
  ['listLabels', () => json({ labels: [{ id: 'lbl1', revisionId: 'r1', fields: { field1: { valueType: 'selection', selection: ['choiceA'] } } }] })],
  ['drivelabels.googleapis.com', () => json({ properties: { title: 'Classification' }, ...LABEL_SCHEMA_BODY })],
];
const EXPECTED_LABELS = {
  applied: [{
    labelId: 'lbl1', revisionId: 'r1', title: 'Classification', resolved: true,
    values: [{ fieldId: 'field1', valueType: 'selection', choiceId: 'choiceA', displayName: 'Confidential', resolved: true }],
  }],
};

function meta(mimeType: string, extra: Record<string, unknown> = {}) {
  return { id: ID, name: `${SECRET} file`, mimeType, webViewLink: WEB(), ...extra };
}

async function connect(profile?: string) {
  if (profile === undefined) delete process.env.PROFILE;
  else process.env.PROFILE = profile;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await createServer(grantedScopes()).connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

function asUser<T>(run: () => Promise<T>, accessToken = TOKEN): Promise<T> {
  return requestContext.run({ accessToken }, run);
}

async function read(uri: string, profile = 'standard') {
  const client = await connect(profile);
  return asUser(() => client.readResource({ uri }));
}

async function readError(uri: string, profile = 'standard'): Promise<McpError> {
  const err = await read(uri, profile).catch((e) => e);
  expect(err).toBeInstanceOf(McpError);
  return err;
}

async function list(cursor?: string) {
  const client = await connect('standard');
  return asUser(() => client.listResources(cursor ? { cursor } : {}));
}

let written: ReturnType<typeof vi.spyOn>;
const logLines = () => written.mock.calls.map(([chunk]: unknown[]) => String(chunk));
const records = () => logLines().map((l: string) => JSON.parse(l));

beforeEach(() => {
  extract.impl = undefined;
  written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  delete process.env.PROFILE;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('registration', () => {
  it.each([undefined, ...Object.keys(PROFILES)])('advertises resources: {} for profile %s', async (profile) => {
    const client = await connect(profile);
    expect(client.getServerCapabilities()?.resources).toEqual({});
  });

  it('logs the resource surface with the tool surface', () => {
    logToolSurface(grantedScopes('standard'));
    expect(records()[0]).toMatchObject({ event: 'tool_surface', resources: true });
  });

  it('withholds resources when drive.readonly is not granted', () => {
    logToolSurface(new Set(['https://www.googleapis.com/auth/drive.file']));
    expect(records()[0]).toMatchObject({ resources: false });
    expect(createServer(new Set(['https://www.googleapis.com/auth/drive.file'])).server.getCapabilities?.()).not.toHaveProperty('resources');
  });

  it('answers resources/templates/list with an empty list', async () => {
    const client = await connect('standard');
    expect(await asUser(() => client.listResourceTemplates())).toEqual({ resourceTemplates: [] });
  });
});

describe('resources/list', () => {
  it('sends the exact query, order, page size, corpora and fields', async () => {
    const calls = stubFetch([[isList, () => json({ files: [] })]]);
    await list();
    const params = new URL(calls[0].url).searchParams;
    const types = [
      "mimeType = 'application/vnd.google-apps.folder'",
      "mimeType = 'application/vnd.google-apps.document'",
      "mimeType = 'application/vnd.google-apps.spreadsheet'",
      "mimeType = 'application/vnd.google-apps.presentation'",
      "mimeType = 'application/pdf'",
      "mimeType contains 'text/'",
      ...[...TEXTUAL_APPLICATION_MIMES].map((m) => `mimeType = '${m}'`),
    ];
    expect(params.get('q')).toBe(`trashed = false and (${types.join(' or ')})`);
    expect(params.get('q')).toBe(resourceListQuery());
    expect(params.get('orderBy')).toBe('modifiedTime desc');
    expect(params.get('pageSize')).toBe(String(RESOURCE_LIST_PAGE_SIZE));
    expect(params.get('corpora')).toBe('allDrives');
    expect(params.get('supportsAllDrives')).toBe('true');
    expect(params.get('includeItemsFromAllDrives')).toBe('true');
    expect(params.get('fields')).toBe('nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,webViewLink)');
    expect(params.has('pageToken')).toBe(false);
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('maps each listed type to what read returns', async () => {
    const file = (id: string, mimeType: string) => ({ id, name: `n-${id}`, mimeType, modifiedTime: '2026-10-01T00:00:00Z', webViewLink: WEB(id) });
    stubFetch([[isList, () => json({
      files: [
        file('folder', 'application/vnd.google-apps.folder'),
        file('doc', 'application/vnd.google-apps.document'),
        file('sheet', 'application/vnd.google-apps.spreadsheet'),
        file('slides', 'application/vnd.google-apps.presentation'),
        file('pdf', 'application/pdf'),
        file('txt', 'text/plain'),
        file('csv', 'text/csv'),
        file('json', 'application/json'),
        file('png', 'image/png'),
      ],
    })]]);
    const { resources } = await list();
    expect(resources.map((r) => [r.name, r.mimeType])).toEqual([
      ['n-folder', 'text/markdown'],
      ['n-doc', 'text/markdown'],
      ['n-sheet', 'text/markdown'],
      ['n-slides', 'text/plain'],
      ['n-pdf', 'text/plain'],
      ['n-txt', 'text/plain'],
      ['n-csv', 'text/csv'],
      ['n-json', 'application/json'],
    ]);
    expect(resources[1]).toEqual({
      uri: WEB('doc'),
      name: 'n-doc',
      title: 'n-doc',
      mimeType: 'text/markdown',
      _meta: { driveFileId: 'doc', driveMimeType: 'application/vnd.google-apps.document', modifiedTime: '2026-10-01T00:00:00Z' },
    });
    for (const r of resources) {
      expect(r).not.toHaveProperty('size');
      expect(r).not.toHaveProperty('description');
    }
  });

  it('passes the cursor as pageToken and returns nextPageToken as nextCursor', async () => {
    const calls = stubFetch([[isList, () => json({ files: [{ id: 'a', name: 'a', mimeType: 'text/plain', webViewLink: WEB('a') }], nextPageToken: 'next-2' })]]);
    const page = await list('cursor-1');
    expect(new URL(calls[0].url).searchParams.get('pageToken')).toBe('cursor-1');
    expect(page.nextCursor).toBe('next-2');
  });

  it('returns no nextCursor on the last page', async () => {
    stubFetch([[isList, () => json({ files: [{ id: 'a', name: 'a', mimeType: 'text/plain', webViewLink: WEB('a') }] })]]);
    const page = await list('cursor-1');
    expect(page).not.toHaveProperty('nextCursor');
  });

  it('skips a file without a webViewLink', async () => {
    stubFetch([[isList, () => json({ files: [{ id: 'a', name: 'a', mimeType: 'text/plain' }, { id: 'b', name: 'b', mimeType: 'text/plain', webViewLink: WEB('b') }] })]]);
    expect((await list()).resources.map((r) => r.name)).toEqual(['b']);
  });

  it('advances at most RESOURCE_LIST_MAX_EXTRA_PAGES more pages when a page has nothing usable', async () => {
    let n = 0;
    const calls = stubFetch([[isList, () => json({ files: [{ id: `x${n}`, name: 'x', mimeType: 'text/plain' }], nextPageToken: `t${++n}` })]]);
    const page = await list();
    expect(calls).toHaveLength(1 + RESOURCE_LIST_MAX_EXTRA_PAGES);
    expect(calls.slice(1).map((c) => new URL(c.url).searchParams.get('pageToken'))).toEqual(['t1', 't2']);
    expect(page.resources).toEqual([]);
    expect(page.nextCursor).toBe(`t${1 + RESOURCE_LIST_MAX_EXTRA_PAGES}`);
  });

  it('stops advancing at the first page with a usable entry', async () => {
    let n = 0;
    const calls = stubFetch([[isList, () => {
      n++;
      return json(n === 1
        ? { files: [{ id: 'x', name: 'x', mimeType: 'text/plain' }], nextPageToken: 't1' }
        : { files: [{ id: 'y', name: 'y', mimeType: 'text/plain', webViewLink: WEB('y') }], nextPageToken: 't2' });
    }]]);
    const page = await list();
    expect(calls).toHaveLength(2);
    expect(page.resources.map((r) => r.name)).toEqual(['y']);
    expect(page.nextCursor).toBe('t2');
  });

  it('returns what an incomplete search found, flags it in _meta and logs it', async () => {
    stubFetch([[isList, () => json({ incompleteSearch: true, files: [{ id: 'a', name: 'a', mimeType: 'text/plain', webViewLink: WEB('a') }] })]]);
    const page = await list();
    expect(page.resources).toHaveLength(1);
    expect(page._meta).toEqual({ incompleteSearch: true });
    expect(page).not.toHaveProperty('nextCursor');
    expect(records().some((r: any) => r.event === 'resource_list_incomplete' && r.level === 'warn')).toBe(true);
  });

  it('puts Drive size in _meta.driveSize only when it is a safe non-negative integer', async () => {
    const file = (id: string, size: unknown) => ({ id, name: id, mimeType: 'application/pdf', webViewLink: WEB(id), size });
    stubFetch([[isList, () => json({ files: [file('ok', '123'), file('zero', '0'), file('nan', 'abc'), file('neg', '-5'), file('huge', '99999999999999999999'), file('frac', '1.5')] })]]);
    const { resources } = await list();
    expect(resources.map((r) => r._meta?.driveSize)).toEqual([123, 0, undefined, undefined, undefined, undefined]);
    for (const r of resources) expect(r).not.toHaveProperty('size');
    expect(parseDriveSize(42)).toBe(42);
    expect(parseDriveSize(undefined)).toBeUndefined();
  });

  it('maps a Drive 400 on a cursor to -32602', async () => {
    stubFetch([[isList, () => googleError(400, 'invalid', 'Invalid Value')]]);
    const client = await connect('standard');
    const err = await asUser(() => client.listResources({ cursor: 'stale' })).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32602);
    expect(err.message).toContain('Invalid cursor');
  });

  it('maps other list failures to -32603 with the formatDriveError text', async () => {
    stubFetch([[isList, () => googleError(401, 'authError')]]);
    const client = await connect('standard');
    const err = await asUser(() => client.listResources()).catch((e) => e);
    expect(err.code).toBe(-32603);
    expect(err.message).toMatch(/reconnect/);
    expect(records().find((r: any) => r.event === 'resource_list_error')).toMatchObject({ status: 401, reason: 'authError' });
  });
});

describe('client compatibility (SDK Client over InMemoryTransport)', () => {
  it('lists two pages, reads, and lists templates', async () => {
    stubFetch([
      [isList, (url) => new URL(url).searchParams.get('pageToken')
        ? json({ files: [{ id: 'bbbbbbbbbbbb', name: 'B', mimeType: 'text/plain', webViewLink: WEB('bbbbbbbbbbbb') }] })
        : json({ files: [{ id: ID, name: 'A', mimeType: 'text/plain', webViewLink: WEB() }], nextPageToken: 'p2' })],
      [isMeta, () => json(meta('text/plain', { size: '5' }))],
      ['alt=media', () => new Response('hello', { status: 200 })],
    ]);
    const client = await connect('standard');
    expect(client.getServerCapabilities()?.resources).toEqual({});
    const first = await asUser(() => client.listResources());
    const second = await asUser(() => client.listResources({ cursor: first.nextCursor }));
    expect([...first.resources, ...second.resources].map((r) => r.name)).toEqual(['A', 'B']);
    expect(second.nextCursor).toBeUndefined();
    const result = await asUser(() => client.readResource({ uri: first.resources[0].uri }));
    expect(result.contents).toEqual([{ uri: first.resources[0].uri, mimeType: 'text/plain', text: 'hello' }]);
    expect(await asUser(() => client.listResourceTemplates())).toEqual({ resourceTemplates: [] });
  });
});

describe('resources/read', () => {
  it('reads a Google Doc as Markdown with the BOM stripped', async () => {
    const calls = stubFetch([
      [isMeta, () => json(meta('application/vnd.google-apps.document'))],
      ['/export?', () => new Response('﻿# Title\n\nBody', { status: 200 })],
    ]);
    const result = await read(DOC_URI);
    expect(result.contents).toEqual([{ uri: DOC_URI, mimeType: 'text/markdown', text: '# Title\n\nBody' }]);
    expect(result).not.toHaveProperty('_meta');
    const exp = calls.find((c) => c.url.includes('/export?'))!;
    expect(new URL(exp.url).searchParams.get('mimeType')).toBe('text/markdown');
    const m = new URL(calls.find((c) => isMeta(c.url))!.url);
    expect(m.searchParams.get('fields')).toBe('id,name,mimeType,size,webViewLink,exportLinks');
    expect(m.searchParams.get('supportsAllDrives')).toBe('true');
  });

  it.each([
    ['Doc', 'application/vnd.google-apps.document', DOC_URI],
    ['Slides', 'application/vnd.google-apps.presentation', `https://docs.google.com/presentation/d/${ID}/edit`],
  ])('truncates a %s export at MAX_TEXT_CHARS with the note and link inside the limit', async (_label, mimeType, uri) => {
    stubFetch([
      [isMeta, () => json(meta(mimeType))],
      ['/export?', () => new Response('d'.repeat(MAX_TEXT_CHARS + 10), { status: 200 })],
    ]);
    const { text } = (await read(uri)).contents[0] as { text: string };
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(text).toMatch(/\n\n\[Truncated at \d+ characters\. Full file: https:\/\/drive\.google\.com\/file\/d\/.+\]$/);
  });

  it('reads Slides as plain text', async () => {
    const calls = stubFetch([
      [isMeta, () => json(meta('application/vnd.google-apps.presentation'))],
      ['/export?', () => new Response('Slide 1\nSlide 2', { status: 200 })],
    ]);
    const uri = `https://docs.google.com/presentation/d/${ID}/edit`;
    expect((await read(uri)).contents).toEqual([{ uri, mimeType: 'text/plain', text: 'Slide 1\nSlide 2' }]);
    expect(new URL(calls.find((c) => c.url.includes('/export?'))!.url).searchParams.get('mimeType')).toBe('text/plain');
  });

  it('reads a Sheet through the Sheets API as Markdown', async () => {
    stubFetch([
      [isMeta, () => json(meta('application/vnd.google-apps.spreadsheet'))],
      ['values:batchGet', () => json({ valueRanges: [{ values: [['a', 'b']] }] })],
      ['sheets.googleapis.com', () => json({ sheets: [{ properties: { sheetId: 0, title: 'Tab', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 1, columnCount: 2 } } }] })],
    ]);
    const uri = `https://docs.google.com/spreadsheets/d/${ID}/edit`;
    expect((await read(uri)).contents).toEqual([{ uri, mimeType: 'text/markdown', text: '# Tab\n\n```csv\na,b\n```' }]);
  });

  it('reads a text file as UTF-8 with its own type', async () => {
    stubFetch([
      [isMeta, () => json(meta('application/json', { size: '12' }))],
      ['alt=media', () => new Response(Buffer.from('﻿{"a":"é"}'), { status: 200 })],
    ]);
    const uri = WEB();
    expect((await read(uri)).contents).toEqual([{ uri, mimeType: 'application/json', text: '{"a":"é"}' }]);
  });

  it('truncates a long text file inside MAX_TEXT_CHARS', async () => {
    stubFetch([
      [isMeta, () => json(meta('text/plain', { size: String(MAX_TEXT_CHARS * 2) }))],
      ['alt=media', () => new Response('t'.repeat(MAX_TEXT_CHARS * 2), { status: 200 })],
    ]);
    const { text } = (await read(WEB())).contents[0] as { text: string };
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(text).toContain('[Truncated at');
  });

  describe('folder', () => {
    const FOLDER_URI = `https://drive.google.com/drive/folders/${ID}`;

    it('sends the exact children query and lists direct children', async () => {
      const calls = stubFetch([
        [isMeta, () => json(meta('application/vnd.google-apps.folder', { name: 'Team [2026]', webViewLink: FOLDER_URI }))],
        [isList, () => json({
          files: [
            { id: 'f1', name: 'Sub', mimeType: 'application/vnd.google-apps.folder', webViewLink: 'https://drive.google.com/drive/folders/f1' },
            { id: 'f2', name: 'Plan [v2]', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/f2/edit' },
            { id: 'f3', name: 'scan.png', mimeType: 'image/png' },
          ],
        })],
      ]);
      const result = await read(FOLDER_URI);

      const params = new URL(calls.find((c) => isList(c.url))!.url).searchParams;
      expect(params.get('q')).toBe(`'${ID}' in parents and trashed = false`);
      expect(params.get('corpora')).toBe('allDrives');
      expect(params.get('supportsAllDrives')).toBe('true');
      expect(params.get('includeItemsFromAllDrives')).toBe('true');
      expect(params.get('orderBy')).toBe('folder,name');
      expect(params.get('pageSize')).toBe(String(FOLDER_LISTING_PAGE_SIZE));
      expect(params.get('fields')).toBe('nextPageToken,files(id,name,mimeType,webViewLink)');

      expect(result.contents).toEqual([{
        uri: FOLDER_URI,
        mimeType: 'text/markdown',
        text: [
          '# Team [2026]',
          '',
          'Folder listing: direct children only, their contents are not included.',
          '',
          '- [Sub](https://drive.google.com/drive/folders/f1) — Google Drive folder',
          '- [Plan \\[v2\\]](https://docs.google.com/document/d/f2/edit) — Google Doc',
          '- scan.png — image (image/png)',
        ].join('\n'),
      }]);
    });

    it('says more items exist, with the folder link, when Drive has another page', async () => {
      stubFetch([
        [isMeta, () => json(meta('application/vnd.google-apps.folder', { name: 'F', webViewLink: FOLDER_URI }))],
        [isList, () => json({ files: [{ id: 'a', name: 'a', mimeType: 'text/plain', webViewLink: WEB('a') }], nextPageToken: 'more' })],
      ]);
      const { text } = (await read(FOLDER_URI)).contents[0] as { text: string };
      expect(text.endsWith(`\n\nMore items are in this folder than are listed here. Open the folder to see them all: ${FOLDER_URI}`)).toBe(true);
    });

    it('keeps a huge listing and its note inside MAX_TEXT_CHARS', async () => {
      const files = Array.from({ length: FOLDER_LISTING_PAGE_SIZE }, (_, i) => ({
        id: `c${i}`, name: `${i}-${'n'.repeat(2000)}`, mimeType: 'text/plain', webViewLink: WEB(`c${i}`),
      }));
      stubFetch([
        [isMeta, () => json(meta('application/vnd.google-apps.folder', { webViewLink: FOLDER_URI }))],
        [isList, () => json({ files, nextPageToken: 'more' })],
      ]);
      const { text } = (await read(FOLDER_URI)).contents[0] as { text: string };
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
      expect(text).toContain('[Truncated at');
      expect(text).toMatch(/More items are in this folder/);
    });
  });

  describe('PDF', () => {
    const pdfRoutes = (size = '1000'): Route[] => [
      [isMeta, () => json(meta('application/pdf', { size }))],
      ['alt=media', () => new Response(Buffer.from('%PDF-1.4 fake'), { status: 200 })],
    ];
    const pdfText = (extra: Partial<PdfText>): PdfText => ({
      text: 'pdf words', pages: 2, textPages: 2, charsPerPage: 5, scanned: false, truncated: false, ...extra,
    });

    it('returns the extracted text as text/plain, with the time left as the extractor timeout', async () => {
      let options: any;
      extract.impl = async (_bytes, opts) => {
        options = opts;
        return pdfText({});
      };
      stubFetch(pdfRoutes());
      expect((await read(WEB())).contents).toEqual([{ uri: WEB(), mimeType: 'text/plain', text: 'pdf words' }]);
      expect(options.timeoutMs).toBeGreaterThan(0);
      expect(options.timeoutMs).toBeLessThanOrEqual(EXTRACT_TIMEOUT_MS);
    });

    it('notes a partial text layer and truncation, inside MAX_TEXT_CHARS', async () => {
      extract.impl = async () => pdfText({ text: 'p'.repeat(MAX_TEXT_CHARS), pages: 9, textPages: 4, truncated: true });
      stubFetch(pdfRoutes());
      const { text } = (await read(WEB())).contents[0] as { text: string };
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
      expect(text).toContain('[Truncated at');
      expect(text).toMatch(/Note: only 4 of 9 page\(s\) carry a text layer; the rest appear to be scanned images and are not included\. Full file: https:\/\/drive\.google\.com\/.+$/);
    });

    it('returns the D9 text for a scanned PDF', async () => {
      extract.impl = async () => pdfText({ text: '', textPages: 0, scanned: true });
      stubFetch(pdfRoutes());
      const content = (await read(WEB())).contents[0] as { text: string; mimeType: string };
      expect(content.mimeType).toBe('text/markdown');
      expect(content.text).toContain("It's a scanned (image-only) PDF with 2 page(s) and no text layer");
      expect(content.text).toContain('- Type: PDF');
      expect(content.text).toContain('- Size: 1000 bytes');
      expect(content.text).toContain(`- Link: ${WEB()}`);
    });

    it('returns the D9 text when extraction fails', async () => {
      extract.impl = async () => {
        throw new Error('the PDF is password-protected');
      };
      stubFetch(pdfRoutes());
      const { text } = (await read(WEB())).contents[0] as { text: string };
      expect(text).toContain("Text couldn't be extracted from this PDF because the PDF is password-protected.");
    });

    it('returns the D9 text over MAX_FILE_SIZE without downloading', async () => {
      const calls = stubFetch(pdfRoutes(String(MAX_FILE_SIZE + 1)));
      const { text } = (await read(WEB())).contents[0] as { text: string };
      expect(text).toContain('over the 20 MB limit');
      expect(calls.some((c) => c.url.includes('alt=media'))).toBe(false);
    });

    it('returns the D9 text when the download passes MAX_FILE_SIZE despite the metadata', async () => {
      stubFetch([
        [isMeta, () => json(meta('application/pdf', { size: '10' }))],
        ['alt=media', () => new Response('x', { status: 200, headers: { 'content-length': String(MAX_FILE_SIZE + 1) } })],
      ]);
      const { text } = (await read(WEB())).contents[0] as { text: string };
      expect(text).toContain('over the 20 MB limit');
    });
  });

  it('returns the D9 text when an export is over the export limit', async () => {
    stubFetch([
      [isMeta, () => json(meta('application/vnd.google-apps.document'))],
      ['/export?', () => googleError(403, 'exportSizeLimitExceeded')],
    ]);
    const content = (await read(DOC_URI)).contents[0] as { text: string; mimeType: string };
    expect(content.mimeType).toBe('text/markdown');
    expect(content.text).toContain("The export is over Google's 10 MB export limit.");
    expect(content.text).toContain('- Type: Google Doc');
  });

  it.each([
    ['an Office file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel spreadsheet'],
    ['an image', 'image/png', 'image (image/png)'],
    ['a Form', 'application/vnd.google-apps.form', 'Google Form'],
  ])('refuses %s with -32002, saying what it is and giving the link', async (_label, mimeType, name) => {
    stubFetch([[isMeta, () => json(meta(mimeType))]]);
    const err = await readError(WEB());
    expect(err.code).toBe(-32002);
    expect(err.message).toContain(`(${name}) can't be added as text. Open it directly: ${WEB()}`);
  });

  it('refuses a URI that is not a Drive link with -32002, without calling Google', async () => {
    const calls = stubFetch([]);
    const err = await readError('https://example.com/file/d/1234567890abc/view');
    expect(err.code).toBe(-32002);
    expect(err.message).toContain('Not a Google Drive file link');
    expect(calls).toHaveLength(0);
  });

  it('maps a Drive 404 to -32002 and a 401 to -32603 with the reconnect hint', async () => {
    stubFetch([[isMeta, () => googleError(404, 'notFound')]]);
    expect((await readError(DOC_URI)).code).toBe(-32002);
    vi.unstubAllGlobals();
    stubFetch([[isMeta, () => googleError(401, 'authError')]]);
    const err = await readError(DOC_URI);
    expect(err.code).toBe(-32603);
    expect(err.message).toMatch(/reconnect their Google account/);
  });

  describe('resource keys', () => {
    const KEY = '0-key_A';
    const KEYED = `https://drive.google.com/file/d/${ID}/view?resourcekey=${KEY}`;

    it('sends no key header when the link has none', async () => {
      const calls = stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('x', { status: 200 })],
        ...LABEL_ROUTES,
      ]);
      await read(WEB(), 'labels');
      for (const c of calls) expect(keyHeader(c.init)).toBeNull();
    });

    it('sends the key on metadata, download and every listLabels page', async () => {
      let page = 0;
      const calls = stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('x', { status: 200 })],
        ['listLabels', () => json(++page === 1 ? { labels: [], nextPageToken: 'lp2' } : { labels: [] })],
      ]);
      await read(KEYED, 'labels');
      const drive = calls.filter((c) => c.url.includes('/drive/v3/'));
      expect(drive.map((c) => (c.url.includes('listLabels') ? 'labels' : c.url.includes('alt=media') ? 'download' : 'meta')).sort())
        .toEqual(['download', 'labels', 'labels', 'meta']);
      for (const c of drive) expect(keyHeader(c.init)).toBe(`${ID}/${KEY}`);
    });

    it('sends the key on exports, folder listings and Sheets calls', async () => {
      const seen: string[] = [];
      const record: Handler = (url, init) => {
        seen.push(`${keyHeader(init)} ${new URL(url).hostname}${new URL(url).pathname.replace(ID, ':id')}`);
        return new Response('{}', { status: 200 });
      };
      for (const [mimeType, path] of [
        ['application/vnd.google-apps.document', 'document'],
        ['application/vnd.google-apps.folder', 'folders'],
        ['application/vnd.google-apps.spreadsheet', 'spreadsheets'],
      ]) {
        vi.unstubAllGlobals();
        stubFetch([
          [isMeta, () => json(meta(mimeType))],
          ['/export?', (url, init) => { record(url, init); return new Response('text', { status: 200 }); }],
          [isList, (url, init) => { record(url, init); return json({ files: [] }); }],
          ['values:batchGet', (url, init) => { record(url, init); return json({ valueRanges: [{ values: [['v']] }] }); }],
          ['sheets.googleapis.com', (url, init) => {
            record(url, init);
            return json({ sheets: [{ properties: { sheetId: 0, title: 'T', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 1, columnCount: 1 } } }] });
          }],
        ]);
        const uri = path === 'folders'
          ? `https://drive.google.com/drive/folders/${ID}?resourcekey=${KEY}`
          : `https://docs.google.com/${path}/d/${ID}/edit?resourcekey=${KEY}`;
        await read(uri);
      }
      expect(seen).toEqual([
        `${ID}/${KEY} www.googleapis.com/drive/v3/files/:id/export`,
        `${ID}/${KEY} www.googleapis.com/drive/v3/files`,
        `${ID}/${KEY} sheets.googleapis.com/v4/spreadsheets/:id`,
        `${ID}/${KEY} sheets.googleapis.com/v4/spreadsheets/:id/values:batchGet`,
      ]);
    });

    it('reads labels on the labels profile when both content and labels need the key (R3)', async () => {
      const needsKey = (ok: Handler): Handler => (url, init) =>
        keyHeader(init) === `${ID}/${KEY}` ? ok(url, init) : googleError(404, 'notFound');
      stubFetch([
        [isMeta, needsKey(() => json(meta('text/plain', { size: '1' })))],
        ['alt=media', needsKey(() => new Response('x', { status: 200 }))],
        ['listLabels', needsKey(LABEL_ROUTES[0][1])],
        LABEL_ROUTES[1],
      ]);
      const result = await read(KEYED, 'labels');
      expect(result._meta).toEqual(EXPECTED_LABELS);
    });
  });

  describe('labels (D11)', () => {
    async function getFileMeta(fileId: string) {
      const client = await connect('labels');
      const result = await asUser(() => client.callTool({ name: 'get_file', arguments: { file_id: fileId } }));
      return result._meta;
    }

    it.each([
      ['a successful read', 'text/plain', (): Route[] => [['alt=media', () => new Response('x', { status: 200 })]]],
      ['a D9 text', 'application/pdf', (): Route[] => []],
      ['a folder listing', 'application/vnd.google-apps.folder', (): Route[] => [[isList, () => json({ files: [] })]]],
    ])('attaches the same _meta as get_file on %s', async (_label, mimeType, extra) => {
      const size = mimeType === 'application/pdf' ? String(MAX_FILE_SIZE + 1) : '1';
      stubFetch([[isMeta, () => json(meta(mimeType, { size }))], ...extra(), ...LABEL_ROUTES]);
      const result = await read(WEB(), 'labels');
      expect(result._meta).toEqual(EXPECTED_LABELS);
      expect(result._meta).toEqual(await getFileMeta(ID));
    });

    it('carries labelsError exactly as get_file does', async () => {
      stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('x', { status: 200 })],
        ['listLabels', () => googleError(400, 'badRequest')],
      ]);
      const result = await read(WEB(), 'labels');
      expect(result._meta).toEqual({ applied: [], labelsError: 'label read failed' });
      expect(result._meta).toEqual(await getFileMeta(ID));
    });

    it('makes no label call and attaches no _meta on the standard profile', async () => {
      const calls = stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('x', { status: 200 })],
        ...LABEL_ROUTES,
      ]);
      const result = await read(WEB(), 'standard');
      expect(result).not.toHaveProperty('_meta');
      expect(calls.some((c) => c.url.includes('listLabels') || c.url.includes('drivelabels'))).toBe(false);
    });

    it('starts the label read in parallel with the content read', async () => {
      let releaseMeta!: () => void;
      const metaGate = new Promise<void>((resolve) => (releaseMeta = resolve));
      let labelsStartedBeforeMeta = false;
      let metaDone = false;
      stubFetch([
        [isMeta, async () => {
          await metaGate;
          metaDone = true;
          return json(meta('text/plain', { size: '1' }));
        }],
        ['alt=media', () => new Response('x', { status: 200 })],
        ['listLabels', (url, init) => {
          labelsStartedBeforeMeta = !metaDone;
          releaseMeta();
          return LABEL_ROUTES[0][1](url, init);
        }],
        LABEL_ROUTES[1],
      ]);
      const result = await read(WEB(), 'labels');
      expect(labelsStartedBeforeMeta).toBe(true);
      expect(result._meta).toEqual(EXPECTED_LABELS);
    });
  });

  describe('deadline (D16)', () => {
    async function readWithClock(uri: string, profile: string) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const client = await connect(profile);
      let settled = false;
      const pending = asUser(() => client.readResource({ uri })).then(
        (r) => ({ ok: r }),
        (e) => ({ err: e }),
      ).finally(() => (settled = true));
      return { pending, isSettled: () => settled };
    }

    it('fails at the deadline when the label lookup stalls, and the label request got the abort signal', async () => {
      let labelInit: RequestInit | undefined;
      stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('fast', { status: 200 })],
        ['listLabels', (_url, init) => {
          labelInit = init;
          return stall(init);
        }],
      ]);
      const { pending, isSettled } = await readWithClock(WEB(), 'labels');
      await vi.advanceTimersByTimeAsync(RESOURCE_READ_DEADLINE_MS - 1);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const outcome: any = await pending;
      expect(outcome.err).toBeInstanceOf(McpError);
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain(`Reading this file timed out after ${RESOURCE_READ_DEADLINE_MS / 1000} s`);
      expect(labelInit?.signal?.aborted).toBe(true);
      expect(records().find((r: any) => r.event === 'resource_read_error')).toMatchObject({ code: 'deadline_exceeded' });
    });

    it('fails at the deadline when a Sheets batch stalls', async () => {
      let batchInit: RequestInit | undefined;
      stubFetch([
        [isMeta, () => json(meta('application/vnd.google-apps.spreadsheet'))],
        ['values:batchGet', (_url, init) => {
          batchInit = init;
          return stall(init);
        }],
        ['sheets.googleapis.com', () => json({ sheets: [{ properties: { sheetId: 0, title: 'T', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 1, columnCount: 1 } } }] })],
      ]);
      const { pending } = await readWithClock(`https://docs.google.com/spreadsheets/d/${ID}/edit`, 'standard');
      await vi.advanceTimersByTimeAsync(RESOURCE_READ_DEADLINE_MS);
      const outcome: any = await pending;
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain('timed out');
      expect(batchInit?.signal?.aborted).toBe(true);
    });

    it('fails at the deadline on a stalled PDF page after metadata, download and labels finished, and ignores a late result', async () => {
      let release!: (value: PdfText) => void;
      let extractionStarted = false;
      extract.impl = () => {
        extractionStarted = true;
        return new Promise<PdfText>((resolve) => (release = resolve));
      };
      const calls = stubFetch([
        [isMeta, () => json(meta('application/pdf', { size: '10' }))],
        ['alt=media', () => new Response(Buffer.from('%PDF-1.4'), { status: 200 })],
        ...LABEL_ROUTES,
      ]);
      const { pending, isSettled } = await readWithClock(WEB(), 'labels');
      await vi.advanceTimersByTimeAsync(1);
      expect(extractionStarted).toBe(true);
      expect(calls.some((c) => c.url.includes('drivelabels'))).toBe(true);

      await vi.advanceTimersByTimeAsync(RESOURCE_READ_DEADLINE_MS);
      expect(isSettled()).toBe(true);
      const outcome: any = await pending;
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain('timed out');

      // The abandoned extraction finishing later changes nothing
      release({ text: 'late', pages: 1, textPages: 1, charsPerPage: 4, scanned: false, truncated: false });
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.ok).toBeUndefined();
    });

    it('reports a failed extraction after the deadline as the timeout, not as D9', async () => {
      let fail!: (err: Error) => void;
      extract.impl = () => new Promise<PdfText>((_, reject) => (fail = reject));
      stubFetch([
        [isMeta, () => json(meta('application/pdf', { size: '10' }))],
        ['alt=media', () => new Response(Buffer.from('%PDF-1.4'), { status: 200 })],
      ]);
      const { pending } = await readWithClock(WEB(), 'standard');
      await vi.advanceTimersByTimeAsync(RESOURCE_READ_DEADLINE_MS);
      fail(new Error('text extraction exceeded 10000ms'));
      const outcome: any = await pending;
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain('timed out');
    });
  });

  describe('logging', () => {
    it('logs a failed read with status and reason, never the URI, id, name or token', async () => {
      stubFetch([[isMeta, () => googleError(403, 'insufficientFilePermissions', `No access to ${SECRET}`)]]);
      const err = await readError(`https://docs.google.com/document/d/${ID}/edit?resourcekey=0-${SECRET.slice(0, 5)}`);
      expect(err.message).toContain(SECRET);
      const record = records().find((r: any) => r.event === 'resource_read_error');
      const { ts, ...rest } = record;
      expect(rest).toEqual({ level: 'warn', event: 'resource_read_error', status: 403, reason: 'insufficientFilePermissions' });
      expect(logLines().join('')).not.toContain(SECRET);
      expect(logLines().join('')).not.toContain(ID);
    });

    it('logs a refused link with its own code', async () => {
      stubFetch([]);
      await readError('ui://widget/x');
      const { ts, ...rest } = records().find((r: any) => r.event === 'resource_read_error');
      expect(rest).toEqual({ level: 'warn', event: 'resource_read_error', code: 'not_drive_link' });
    });
  });
});
