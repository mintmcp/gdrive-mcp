import { describe, expect, it } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { createServer, logToolSurface } from './server.js';
import { FEATURES, PROFILES, resolveGrant } from './scopes.js';
import { TEXTUAL_APPLICATION_MIMES } from './mime.js';
import { parseDriveSize, resourceListQuery } from './resources.js';
import { RESOURCE_LIST_MAX_EXTRA_PAGES, RESOURCE_LIST_PAGE_SIZE } from './limits.js';
import {
  ID, WEB, asUser, connect, googleError, isList, isMeta, json, list, meta, records, stubFetch, useResourceFixtures,
} from './resourcesTestKit.js';

useResourceFixtures();

describe('registration', () => {
  it.each([undefined, 'standard-resources', 'full'])('advertises resources: {} for profile %s', async (profile) => {
    const client = await connect(profile);
    expect(client.getServerCapabilities()?.resources).toEqual({});
  });

  it.each(['standard', 'labels'])('profile %s keeps its surface: no resources', async (profile) => {
    const client = await connect(profile);
    expect(client.getServerCapabilities()).not.toHaveProperty('resources');
  });

  it('every profile either carries the resources feature or withholds resources', async () => {
    for (const profile of Object.keys(PROFILES)) {
      const client = await connect(profile);
      const advertised = client.getServerCapabilities()?.resources !== undefined;
      expect(advertised).toBe(resolveGrant(profile)!.features.has(FEATURES.RESOURCES));
    }
  });

  it('logs the resource surface with the tool surface', () => {
    logToolSurface(resolveGrant('standard-resources'));
    expect(records()[0]).toMatchObject({ event: 'tool_surface', features: ['resources'], resources: true });
    logToolSurface(resolveGrant('standard'));
    expect(records()[1]).toMatchObject({ event: 'tool_surface', features: [], resources: false });
  });

  it('withholds resources when drive.readonly is not granted, whatever the feature says', () => {
    const fileOnly = { scopes: new Set(['https://www.googleapis.com/auth/drive.file']), features: new Set([FEATURES.RESOURCES]) };
    logToolSurface(fileOnly);
    expect(records()[0]).toMatchObject({ resources: false });
    expect(createServer(fileOnly).server.getCapabilities?.()).not.toHaveProperty('resources');
  });

  it('answers resources/templates/list with an empty list', async () => {
    const client = await connect('standard-resources');
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
    const client = await connect('standard-resources');
    const err = await asUser(() => client.listResources({ cursor: 'stale' })).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.code).toBe(-32602);
    expect(err.message).toContain('Invalid cursor');
  });

  it('maps other list failures to -32603 with the formatDriveError text', async () => {
    stubFetch([[isList, () => googleError(401, 'authError')]]);
    const client = await connect('standard-resources');
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
    const client = await connect('standard-resources');
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
