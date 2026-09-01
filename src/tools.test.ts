import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  classifyMime,
  escapeDriveQValue,
  isSelfMove,
  validateWorkspaceDomain,
  unsupportedMessage,
  inferMimeTypeFromName,
  decodeUploadContent,
  buildMultipartBody,
  parseMimeType,
  requiresBase64,
  buildFileUpdate,
  formatDriveFile,
  GoogleDriveTools,
} from './tools.js';
import { requestContext } from './auth.js';
import { stubFetch, jsonResponse } from './testStubs.js';

describe('escapeDriveQValue', () => {
  it('escapes apostrophes', () => {
    expect(escapeDriveQValue("O'Brien")).toBe("O\\'Brien");
  });
  it('doubles backslashes', () => {
    expect(escapeDriveQValue('a\\b')).toBe('a\\\\b');
  });
  it('handles a backslash before an apostrophe correctly (order matters)', () => {
    // Input: a\'b — we expect the \\ to be doubled FIRST so the trailing
    // apostrophe is then escaped independently. Otherwise the apostrophe
    // escape would interact with the backslash escape and produce garbage.
    expect(escapeDriveQValue("a\\'b")).toBe("a\\\\\\'b");
  });
  it('passes empty strings through', () => {
    expect(escapeDriveQValue('')).toBe('');
  });
  it('passes newlines and control chars through unchanged', () => {
    expect(escapeDriveQValue('a\nb\tc')).toBe('a\nb\tc');
  });
  it('leaves ordinary mime types untouched', () => {
    expect(escapeDriveQValue('application/pdf')).toBe('application/pdf');
  });
});

describe('classifyMime', () => {
  it('detects native Google Docs by MIME prefix', () => {
    expect(classifyMime('application/vnd.google-apps.document')).toBe('native-doc');
    expect(classifyMime('application/vnd.google-apps.spreadsheet')).toBe('native-doc');
    expect(classifyMime('application/vnd.google-apps.presentation')).toBe('native-doc');
    expect(classifyMime('application/vnd.google-apps.form')).toBe('native-doc');
  });
  it('classifies pdf and images', () => {
    expect(classifyMime('application/pdf')).toBe('pdf');
    expect(classifyMime('image/png')).toBe('image');
    expect(classifyMime('image/jpeg')).toBe('image');
  });
  it('classifies text/* and select application/* as text', () => {
    expect(classifyMime('text/plain')).toBe('text');
    expect(classifyMime('text/markdown')).toBe('text');
    expect(classifyMime('application/json')).toBe('text');
    expect(classifyMime('application/xml')).toBe('text');
    expect(classifyMime('application/yaml')).toBe('text');
  });
  it('falls through to unsupported for unknown / empty', () => {
    expect(classifyMime('application/octet-stream')).toBe('unsupported');
    expect(classifyMime('audio/mp3')).toBe('unsupported');
    expect(classifyMime('')).toBe('unsupported');
  });
  it('classifies Office formats as unsupported — they are routed, not read here', () => {
    expect(
      classifyMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    ).toBe('unsupported');
    expect(
      classifyMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    ).toBe('unsupported');
  });
});

describe('unsupportedMessage', () => {
  const link = 'https://drive.google.com/x';

  it('points Google-native files at the dedicated MCP server', () => {
    const msg = unsupportedMessage('Budget', 'application/vnd.google-apps.spreadsheet', link);
    expect(msg).toContain('Google Sheets');
    expect(msg).toContain(link);
    // The generic "text, image and PDF" advice is wrong for these — a dedicated
    // server can read them, so it must not appear.
    expect(msg).not.toContain('supports text, image and PDF');
  });

  it('names the right server per Google-native type', () => {
    expect(unsupportedMessage('D', 'application/vnd.google-apps.document', link)).toContain('Google Docs');
    expect(unsupportedMessage('S', 'application/vnd.google-apps.presentation', link)).toContain('Google Slides');
  });

  it('falls back to a generic message for other Google-native types', () => {
    const msg = unsupportedMessage('F', 'application/vnd.google-apps.form', link);
    expect(msg).toContain('Google Drive-native');
    expect(msg).toContain(link);
  });

  it('routes Office spreadsheets to the Sheets connector', () => {
    const msg = unsupportedMessage(
      'book.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      link
    );
    expect(msg).toContain('Google Sheets MCP server');
    expect(msg).toContain(link);
  });

  it('routes Office documents to the Docs connector', () => {
    const msg = unsupportedMessage(
      'notes.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      link
    );
    expect(msg).toContain('Google Docs MCP server');
  });

  it('routes a legacy .doc to the Docs connector, which now parses it', () => {
    const msg = unsupportedMessage('old.doc', 'application/msword', link);
    expect(msg).toContain('Google Docs MCP server');
    expect(msg).not.toContain('cannot be read');
  });

  it('still tells the caller a legacy .xls must be converted', () => {
    expect(unsupportedMessage('old.xls', 'application/vnd.ms-excel', link))
      .toContain('Save as Google Sheets');
  });

  it('explains the supported kinds for ordinary binary files', () => {
    const msg = unsupportedMessage('clip.mp4', 'video/mp4', link);
    expect(msg).toContain('video/mp4');
    expect(msg).toContain('text, image and PDF');
    expect(msg).toContain(link);
  });
});

describe('isSelfMove', () => {
  it('returns true when ids match', () => {
    expect(isSelfMove('abc', 'abc')).toBe(true);
  });
  it('returns false when ids differ', () => {
    expect(isSelfMove('abc', 'def')).toBe(false);
  });
  it('returns false when either id is missing', () => {
    expect(isSelfMove(undefined, 'abc')).toBe(false);
    expect(isSelfMove('abc', undefined)).toBe(false);
    expect(isSelfMove(undefined, undefined)).toBe(false);
    expect(isSelfMove('', 'abc')).toBe(false);
  });
});

describe('validateWorkspaceDomain', () => {
  it('accepts simple and multi-label domains', () => {
    expect(validateWorkspaceDomain('example.com')).toEqual({ ok: true, domain: 'example.com' });
    expect(validateWorkspaceDomain('sub.example.co.uk')).toEqual({ ok: true, domain: 'sub.example.co.uk' });
  });
  it('trims whitespace', () => {
    expect(validateWorkspaceDomain('  example.com  ')).toEqual({ ok: true, domain: 'example.com' });
  });
  it('rejects empty / whitespace-only / non-string', () => {
    expect(validateWorkspaceDomain('').ok).toBe(false);
    expect(validateWorkspaceDomain('   ').ok).toBe(false);
    expect(validateWorkspaceDomain(undefined).ok).toBe(false);
    expect(validateWorkspaceDomain(42).ok).toBe(false);
  });
  it('rejects malformed shapes', () => {
    expect(validateWorkspaceDomain('notadomain').ok).toBe(false);
    expect(validateWorkspaceDomain('..').ok).toBe(false);
    expect(validateWorkspaceDomain('-leading.com').ok).toBe(false);
    expect(validateWorkspaceDomain('trailing-.com').ok).toBe(false);
  });
});

describe('buildFileUpdate', () => {
  it('maps new_name to the Drive "name" field', () => {
    const r = buildFileUpdate({ new_name: 'report.pdf' });
    expect(r).toEqual({ ok: true, body: { name: 'report.pdf' } });
  });
  it('includes description and starred, and combines multiple fields', () => {
    const r = buildFileUpdate({ new_name: 'x', description: 'notes', starred: true });
    expect(r).toEqual({ ok: true, body: { name: 'x', description: 'notes', starred: true } });
  });
  it('allows clearing a description with an empty string', () => {
    expect(buildFileUpdate({ description: '' })).toEqual({ ok: true, body: { description: '' } });
  });
  it('allows unstarring with starred=false', () => {
    expect(buildFileUpdate({ starred: false })).toEqual({ ok: true, body: { starred: false } });
  });
  it('rejects an update with no fields', () => {
    const r = buildFileUpdate({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one field/i);
  });
  it('trims surrounding whitespace off new_name', () => {
    const r = buildFileUpdate({ new_name: '  report.pdf  ' });
    expect(r.ok && r.body.name).toBe('report.pdf');
  });

  it('rejects an empty or whitespace-only new_name', () => {
    expect(buildFileUpdate({ new_name: '' }).ok).toBe(false);
    expect(buildFileUpdate({ new_name: '   ' }).ok).toBe(false);
  });
  it('rejects wrong types for description and starred', () => {
    expect(buildFileUpdate({ description: 123 as any }).ok).toBe(false);
    expect(buildFileUpdate({ starred: 'yes' as any }).ok).toBe(false);
  });
});

describe('formatDriveFile', () => {
  it('parses a numeric string size to a number', () => {
    expect(formatDriveFile({ id: 'x', size: '1024' }).size).toBe(1024);
  });
  it('leaves size undefined when the field is absent', () => {
    expect(formatDriveFile({ id: 'x' }).size).toBeUndefined();
  });
  it('marks isFolder true only for the folder mimeType', () => {
    expect(formatDriveFile({ mimeType: 'application/vnd.google-apps.folder' }).isFolder).toBe(true);
    expect(formatDriveFile({ mimeType: 'application/pdf' }).isFolder).toBe(false);
    expect(formatDriveFile({}).isFolder).toBe(false);
  });
  it('takes owner from owners[0].emailAddress', () => {
    expect(formatDriveFile({ owners: [{ emailAddress: 'a@b.com' }] }).owner).toBe('a@b.com');
  });
  it('leaves owner undefined when there are no owners', () => {
    expect(formatDriveFile({ owners: [] }).owner).toBeUndefined();
    expect(formatDriveFile({}).owner).toBeUndefined();
  });
  it('coerces trashed to a strict boolean', () => {
    expect(formatDriveFile({ trashed: true }).trashed).toBe(true);
    expect(formatDriveFile({}).trashed).toBe(false);
    expect(formatDriveFile({ trashed: 'true' as any }).trashed).toBe(false);
  });
  it('tolerates a sparse object with only id', () => {
    expect(formatDriveFile({ id: 'only-id' })).toEqual({
      id: 'only-id',
      name: undefined,
      mimeType: undefined,
      size: undefined,
      createdTime: undefined,
      modifiedTime: undefined,
      parents: undefined,
      webViewLink: undefined,
      owner: undefined,
      isFolder: false,
      trashed: false,
    });
  });
});

describe('Buffer base64 round-trip (platform sanity)', () => {
  it('encodes "Hello" to SGVsbG8=', () => {
    expect(Buffer.from(new Uint8Array([72, 101, 108, 108, 111])).toString('base64')).toBe('SGVsbG8=');
  });
});

describe('inferMimeTypeFromName', () => {
  it('maps known extensions, case-insensitively', () => {
    expect(inferMimeTypeFromName('deck.pptx', 'base64')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    expect(inferMimeTypeFromName('notes.md', 'text')).toBe('text/markdown');
    expect(inferMimeTypeFromName('logo.PNG', 'base64')).toBe('image/png');
  });
  it('falls back to the encoding default for unknown or missing extensions', () => {
    expect(inferMimeTypeFromName('thing.qqq', 'text')).toBe('text/plain');
    expect(inferMimeTypeFromName('thing.qqq', 'base64')).toBe('application/octet-stream');
    expect(inferMimeTypeFromName('README', 'text')).toBe('text/plain');
    expect(inferMimeTypeFromName('archive.', 'base64')).toBe('application/octet-stream');
  });
  it('infers the OpenDocument types it advertises for conversion', () => {
    expect(inferMimeTypeFromName('report.odt', 'base64')).toBe('application/vnd.oasis.opendocument.text');
    expect(inferMimeTypeFromName('sheet.ods', 'base64')).toBe('application/vnd.oasis.opendocument.spreadsheet');
    expect(inferMimeTypeFromName('deck.odp', 'base64')).toBe('application/vnd.oasis.opendocument.presentation');
  });
  it('uses the last extension of a multi-dot name', () => {
    expect(inferMimeTypeFromName('backup.tar.zip', 'base64')).toBe('application/zip');
  });
});


const UPLOAD_LIMIT = 5 * 1024 * 1024;

describe('decodeUploadContent', () => {
  it('encodes text as UTF-8, multibyte included', () => {
    const r = decodeUploadContent('héllo', 'text', UPLOAD_LIMIT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes).toEqual(Buffer.from('héllo', 'utf8'));
  });
  it('treats missing or empty content as zero bytes', () => {
    for (const [content, encoding] of [[undefined, 'text'], ['', 'text'], ['', 'base64']] as const) {
      const r = decodeUploadContent(content, encoding, UPLOAD_LIMIT);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.bytes.length).toBe(0);
    }
  });
  it('decodes valid base64', () => {
    const r = decodeUploadContent('SGVsbG8=', 'base64', UPLOAD_LIMIT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.toString('utf8')).toBe('Hello');
  });
  it('ignores whitespace and line breaks inside base64', () => {
    const r = decodeUploadContent(' SGVs\nbG8=\n', 'base64', UPLOAD_LIMIT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.toString('utf8')).toBe('Hello');
  });
  it('rejects characters outside the base64 alphabet instead of dropping them', () => {
    const r = decodeUploadContent('SGVs*bG8=', 'base64', UPLOAD_LIMIT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not valid base64/);
  });
  it('rejects bad padding and truncated input', () => {
    expect(decodeUploadContent('SGVsbG8', 'base64', UPLOAD_LIMIT).ok).toBe(false);
    expect(decodeUploadContent('SGVsbG8==', 'base64', UPLOAD_LIMIT).ok).toBe(false);
    expect(decodeUploadContent('=', 'base64', UPLOAD_LIMIT).ok).toBe(false);
  });
  it('does not validate base64 shape when encoding is text', () => {
    const r = decodeUploadContent('SGVs*bG8=', 'text', UPLOAD_LIMIT);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.toString('utf8')).toBe('SGVs*bG8=');
  });
});

describe('buildMultipartBody', () => {
  const boundary = 'test-boundary';

  it('emits the metadata part then the content part, CRLF-delimited', () => {
    const body = buildMultipartBody(
      { name: 'a.txt', mimeType: 'text/plain' },
      'text/plain',
      Buffer.from('hi', 'utf8'),
      boundary
    );
    expect(body.toString('utf8')).toBe(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `{"name":"a.txt","mimeType":"text/plain"}\r\n` +
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${boundary}--`
    );
  });

  it('carries the target mime in the metadata and the source mime on the content part', () => {
    const body = buildMultipartBody(
      { name: 'd.pptx', mimeType: 'application/vnd.google-apps.presentation', parents: ['folder1'] },
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      Buffer.alloc(0),
      boundary
    ).toString('utf8');
    expect(body).toContain('"mimeType":"application/vnd.google-apps.presentation"');
    expect(body).toContain('"parents":["folder1"]');
    expect(body).toContain('Content-Type: application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('keeps binary bytes intact', () => {
    const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x80, 0x1a]);
    const body = buildMultipartBody({ name: 'b.bin' }, 'application/octet-stream', bytes, boundary);
    const start = body.indexOf(Buffer.from('\r\n\r\n', 'utf8'), body.indexOf('application/octet-stream')) + 4;
    expect(body.subarray(start, start + bytes.length)).toEqual(bytes);
    expect(body.subarray(start + bytes.length).toString('utf8')).toBe(`\r\n--${boundary}--`);
  });
});

describe('parseMimeType', () => {
  it('accepts a bare type and one with parameters', () => {
    const bare = parseMimeType(' application/pdf ');
    expect(bare).toEqual({ ok: true, mimeType: 'application/pdf', essence: 'application/pdf' });
    const parameterised = parseMimeType('Text/CSV; charset=utf-8');
    expect(parameterised.ok).toBe(true);
    if (parameterised.ok) {
      expect(parameterised.mimeType).toBe('Text/CSV; charset=utf-8');
      expect(parameterised.essence).toBe('text/csv');
    }
  });
  it('trims surrounding whitespace, so a trailing newline is harmless', () => {
    expect(parseMimeType('text/plain\r\n\r\n')).toEqual({ ok: true, mimeType: 'text/plain', essence: 'text/plain' });
  });
  it('rejects header injection and malformed values', () => {
    for (const bad of [
      'text/plain\r\nContent-Transfer-Encoding: base64',
      'textplain',
      'text/',
      '',
      'text/plain; charset',
    ]) {
      expect(parseMimeType(bad).ok).toBe(false);
    }
  });
});



describe('requiresBase64', () => {
  it('flags binary media and Office containers', () => {
    expect(requiresBase64('image/png')).toBe(true);
    expect(requiresBase64('application/pdf')).toBe(true);
    expect(requiresBase64('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(true);
  });
  it('leaves textual types alone, SVG included', () => {
    expect(requiresBase64('text/csv')).toBe(false);
    expect(requiresBase64('application/json')).toBe(false);
    expect(requiresBase64('image/svg+xml')).toBe(false);
  });
});


describe('decodeUploadContent truncation', () => {
  it('reports a cut-off payload as truncated, not malformed', () => {
    const r = decodeUploadContent('QUJDRA'.repeat(500) + 'QUJ', 'base64', UPLOAD_LIMIT);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('cut off');
      expect(r.error).toContain('smaller file');
    }
  });
  it('still calls genuinely malformed content malformed', () => {
    const r = decodeUploadContent('SGVs*bG8=', 'base64', UPLOAD_LIMIT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('not valid base64');
  });
});

describe('decodeUploadContent on large payloads', () => {
  const limit = 5 * 1024 * 1024;

  it('validates a multi-megabyte base64 string without overflowing the stack', () => {
    const payload = Buffer.alloc(4 * 1024 * 1024, 7).toString('base64');
    const r = decodeUploadContent(payload, 'base64', limit);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.bytes.length).toBe(4 * 1024 * 1024);
  });

  it('rejects whitespace-only base64 rather than creating an empty file', () => {
    const r = decodeUploadContent('   \n  ', 'base64', UPLOAD_LIMIT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('whitespace');
  });
  it('rejects an over-limit payload, text or base64, without decoding it', () => {
    expect(decodeUploadContent('x'.repeat(11), 'text', 10).ok).toBe(false);
    expect(decodeUploadContent(Buffer.alloc(11).toString('base64'), 'base64', 10).ok).toBe(false);
  });

  it('accepts a payload exactly at the limit', () => {
    expect(decodeUploadContent('x'.repeat(10), 'text', 10).ok).toBe(true);
  });

  it('rejects non-string content rather than creating an empty file', () => {
    const r = decodeUploadContent(42 as any, 'text', limit);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('must be a string');
  });
});


describe('get_file handler _meta', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PROFILE;
  });

  const getFile = (GoogleDriveTools.getTools() as any).get_file.handler;
  const callGetFile = (fileId: string) =>
    requestContext.run({ accessToken: 'tok' }, () => getFile({ file_id: fileId }));

  const FILE_META = { id: 'f1', name: 'a.txt', mimeType: 'text/plain', size: '5', webViewLink: 'https://x' };
  const metaRoute: [string, (url: string) => Response] = [
    'fields=id,name,mimeType,size,webViewLink', () => jsonResponse(FILE_META),
  ];
  const labelsRoute: [string, (url: string) => Response] = [
    'listLabels', () => jsonResponse({ labels: [{ id: 'lbl2', fields: { t: { valueType: 'text', text: ['Internal'] } } }] }),
  ];
  const labelInfoRoute: [string, (url: string) => Response] = [
    'drivelabels.googleapis.com', () => jsonResponse({ properties: { title: 'Notes' } }),
  ];

  it('attaches _meta.applied on a successful text read', async () => {
    stubFetch([
      metaRoute,
      labelsRoute,
      labelInfoRoute,
      ['alt=media', () => new Response('hello', { status: 200 })],
    ]);
    const res = await callGetFile('f1');
    expect(res.isError).toBeUndefined();
    expect(res._meta.applied).toEqual([{
      labelId: 'lbl2', title: 'Notes', resolved: true,
      values: [{ fieldId: 't', valueType: 'text', value: 'Internal' }],
    }]);
    expect(res.structuredContent.labels).toBeUndefined();
  });

  it('attaches _meta.applied on a download-failure error envelope', async () => {
    stubFetch([
      metaRoute,
      labelsRoute,
      labelInfoRoute,
      ['alt=media', () => new Response('forbidden', { status: 403 })],
    ]);
    const res = await callGetFile('f1');
    expect(res.isError).toBe(true);
    expect(res._meta.applied).toHaveLength(1);
  });

  it('attaches _meta.applied even when the metadata fetch itself fails', async () => {
    stubFetch([
      ['fields=id,name,mimeType,size,webViewLink', () => jsonResponse({ error: { message: 'not found' } }, 404)],
      labelsRoute,
      labelInfoRoute,
    ]);
    const res = await callGetFile('f1');
    expect(res.isError).toBe(true);
    expect(res._meta.applied).toHaveLength(1);
  });

  it('attaches _meta.applied on the unsupported-mime error envelope', async () => {
    stubFetch([
      ['fields=id,name,mimeType,size,webViewLink', () => jsonResponse({ ...FILE_META, mimeType: 'application/zip' })],
      labelsRoute,
      labelInfoRoute,
    ]);
    const res = await callGetFile('f1');
    expect(res.isError).toBe(true);
    expect(res._meta.applied).toHaveLength(1);
  });

  it('skips label calls and omits _meta when the profile lacks the labels scope', async () => {
    process.env.PROFILE = 'standard';
    const calls = stubFetch([
      metaRoute,
      ['alt=media', () => new Response('hello', { status: 200 })],
    ]);
    const res = await callGetFile('f1');
    expect(res.isError).toBeUndefined();
    expect(res._meta).toBeUndefined();
    expect(calls.some((c) => c.url.includes('listLabels'))).toBe(false);
  });

  it('get_file_metadata returns labels in the visible body and in _meta', async () => {
    stubFetch([
      ['md5Checksum', () => jsonResponse(FILE_META)],
      labelsRoute,
      labelInfoRoute,
    ]);
    const res = await requestContext.run({ accessToken: 'tok' }, () =>
      (GoogleDriveTools.getTools() as any).get_file_metadata.handler({ file_id: 'f1' }));
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.labels).toEqual([{
      labelId: 'lbl2', title: 'Notes', resolved: true,
      values: [{ fieldId: 't', valueType: 'text', value: 'Internal' }],
    }]);
    expect(res._meta.applied).toHaveLength(1);
    expect(JSON.parse(res.content[0].text).labels).toHaveLength(1);
  });

  it('get_file_metadata omits labels entirely when the profile lacks the scope', async () => {
    process.env.PROFILE = 'standard';
    const calls = stubFetch([['md5Checksum', () => jsonResponse(FILE_META)]]);
    const res = await requestContext.run({ accessToken: 'tok' }, () =>
      (GoogleDriveTools.getTools() as any).get_file_metadata.handler({ file_id: 'f1' }));
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent.labels).toBeUndefined();
    expect(res._meta).toBeUndefined();
    expect(calls.some((c) => c.url.includes('listLabels'))).toBe(false);
  });


  it('runs label enrichment under the labels profile', async () => {
    process.env.PROFILE = 'labels';
    stubFetch([
      metaRoute,
      labelsRoute,
      labelInfoRoute,
      ['alt=media', () => new Response('hello', { status: 200 })],
    ]);
    const res = await callGetFile('f1');
    expect(res._meta.applied).toHaveLength(1);
  });
});

