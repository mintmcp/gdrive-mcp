import { describe, expect, it, vi } from 'vitest';
import { type PdfText, EXTRACT_TIMEOUT_MS } from './pdfText.js';
import { FOLDER_LISTING_PAGE_SIZE, MAX_FILE_SIZE, MAX_TEXT_CHARS } from './limits.js';
import {
  DOC_URI, EXPECTED_LABELS, ID, LABEL_ROUTES, WEB, asUser, connect, extract, googleError, isList, isMeta, json, keyHeader,
  meta, read, readError, stubFetch, useResourceFixtures, type Handler, type Route,
} from './resourcesTestKit.js';

// resources/read hands PDFs to the unchanged extractor; tests drive its outcome
vi.mock('./pdfText.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pdfText.js')>();
  const { extract } = await import('./pdfExtractStub.js');
  return {
    ...actual,
    extractPdfText: vi.fn((bytes: Uint8Array, options: any) =>
      extract.impl ? extract.impl(bytes, options) : actual.extractPdfText(bytes, options)),
  };
});

useResourceFixtures();

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
    expect(m.searchParams.get('fields')).toBe('name,mimeType,size,webViewLink');
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
      await read(WEB(), 'full');
      for (const c of calls) expect(keyHeader(c.init)).toBeNull();
    });

    it('sends the key on metadata, download and every listLabels page', async () => {
      let page = 0;
      const calls = stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('x', { status: 200 })],
        ['listLabels', () => json(++page === 1 ? { labels: [], nextPageToken: 'lp2' } : { labels: [] })],
      ]);
      await read(KEYED, 'full');
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

    it('reads labels on a profile with the labels scope when both content and labels need the key (R3)', async () => {
      const needsKey = (ok: Handler): Handler => (url, init) =>
        keyHeader(init) === `${ID}/${KEY}` ? ok(url, init) : googleError(404, 'notFound');
      stubFetch([
        [isMeta, needsKey(() => json(meta('text/plain', { size: '1' })))],
        ['alt=media', needsKey(() => new Response('x', { status: 200 }))],
        ['listLabels', needsKey(LABEL_ROUTES[0][1])],
        LABEL_ROUTES[1],
      ]);
      const result = await read(KEYED, 'full');
      expect(result._meta).toEqual(EXPECTED_LABELS);
    });
  });

  describe('labels (D11)', () => {
    async function getFileMeta(fileId: string) {
      const client = await connect('full');
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
      const result = await read(WEB(), 'full');
      expect(result._meta).toEqual(EXPECTED_LABELS);
      expect(result._meta).toEqual(await getFileMeta(ID));
    });

    it('carries labelsError exactly as get_file does', async () => {
      stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('x', { status: 200 })],
        ['listLabels', () => googleError(400, 'badRequest')],
      ]);
      const result = await read(WEB(), 'full');
      expect(result._meta).toEqual({ applied: [], labelsError: 'label read failed' });
      expect(result._meta).toEqual(await getFileMeta(ID));
    });

    it('makes no label call and attaches no _meta on the standard profile', async () => {
      const calls = stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('x', { status: 200 })],
        ...LABEL_ROUTES,
      ]);
      const result = await read(WEB(), 'standard-resources');
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
      const result = await read(WEB(), 'full');
      expect(labelsStartedBeforeMeta).toBe(true);
      expect(result._meta).toEqual(EXPECTED_LABELS);
    });
  });
});
