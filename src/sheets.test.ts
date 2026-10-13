import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  a1Range,
  columnLetter,
  csvField,
  normalizeRows,
  planRead,
  readSheet,
  tabRequest,
  type SheetTab,
  type SheetsContext,
} from './sheets.js';
import { DriveApiError } from './driveApi.js';
import { MAX_TEXT_CHARS } from './pdfText.js';
import {
  SHEETS_MAX_BYTES_PER_CALL,
  SHEETS_MAX_BYTES_PER_READ,
  SHEETS_MAX_CELLS,
  SHEETS_MAX_COLUMNS_PER_TAB,
  SHEETS_MAX_URL_CHARS,
  SHEETS_MAX_VALUE_CALLS,
} from './limits.js';

const FILE_ID = 'sheet1234567890';
const LINK = `https://docs.google.com/spreadsheets/d/${FILE_ID}/edit`;

interface FakeTab {
  title: string;
  sheetId?: number;
  sheetType?: string;
  hidden?: boolean;
  rowCount: number;
  columnCount: number;
  // Cell values by [row][col], 0-based; missing means empty
  data?: string[][];
  // Bytes of an extra field the reader ignores, added to this tab's ValueRange:
  // a response size independent of the rendered text
  padBytes?: number;
}

function tabOf(t: Partial<SheetTab> & { title: string; rowCount: number; columnCount: number }, index: number): SheetTab {
  return { sheetId: index, index, sheetType: 'GRID', hidden: false, ...t };
}

function parseRange(range: string) {
  const m = range.match(/^'((?:[^']|'')*)'!A(\d+):([A-Z]+)(\d+)$/);
  if (!m) throw new Error(`bad range ${range}`);
  const cols = [...m[3]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
  return { title: m[1].replace(/''/g, "'"), r1: Number(m[2]), r2: Number(m[4]), cols };
}

// What the Sheets API returns for one range: trailing empty cells and rows
// trimmed, empty rows inside the range kept as []
function valuesFor(tab: FakeTab, r1: number, r2: number, cols: number): string[][] {
  const out: string[][] = [];
  for (let r = r1; r <= r2; r++) {
    const row = (tab.data?.[r - 1] ?? []).slice(0, cols).map((v) => v ?? '');
    while (row.length && row[row.length - 1] === '') row.pop();
    out.push(row);
  }
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

interface FakeOptions {
  getStatus?: number;
  getReason?: string;
  // Fail the nth values.batchGet call (1-based) with this status
  failBatch?: { n: number; status: number; reason?: string };
  export?: Handler;
  // Count body bytes pulled from each streamed response
  stream?: boolean;
}

function errorBody(status: number, reason?: string) {
  return JSON.stringify({ error: { code: status, message: `error ${status}`, ...(reason ? { errors: [{ reason }] } : {}) } });
}

function streamed(body: string, stats: { pulled: number; total: number }): Response {
  const bytes = Buffer.from(body);
  stats.total += bytes.length;
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const chunk = bytes.subarray(offset, offset + 64 * 1024);
      offset += chunk.length;
      stats.pulled += chunk.length;
      controller.enqueue(chunk);
    },
  });
  return new Response(stream, { status: 200 });
}

function fakeSheets(tabs: FakeTab[], options: FakeOptions = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stats = { pulled: 0, total: 0 };
  let batchCalls = 0;
  const respond = (body: string) =>
    options.stream ? streamed(body, stats) : new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });

  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/export?')) {
      if (!options.export) throw new Error(`unexpected export ${url}`);
      return options.export(url, init);
    }
    if (url.includes('values:batchGet')) {
      batchCalls++;
      if (options.failBatch?.n === batchCalls) {
        return new Response(errorBody(options.failBatch.status, options.failBatch.reason), { status: options.failBatch.status });
      }
      const ranges = new URL(url).searchParams.getAll('ranges');
      const valueRanges = ranges.map((range) => {
        const { title, r1, r2, cols } = parseRange(range);
        const tab = tabs.find((t) => t.title === title)!;
        const values = valuesFor(tab, r1, r2, cols);
        return {
          range,
          majorDimension: 'ROWS',
          ...(values.length ? { values } : {}),
          ...(tab.padBytes ? { padding: 'p'.repeat(tab.padBytes) } : {}),
        };
      });
      return respond(JSON.stringify({ spreadsheetId: FILE_ID, valueRanges }));
    }
    if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets/')) {
      if (options.getStatus) return new Response(errorBody(options.getStatus, options.getReason), { status: options.getStatus });
      return respond(JSON.stringify({
        sheets: tabs.map((t, i) => ({
          properties: {
            sheetId: t.sheetId ?? i,
            title: t.title,
            index: i,
            sheetType: t.sheetType ?? 'GRID',
            ...(t.hidden ? { hidden: true } : {}),
            gridProperties: { rowCount: t.rowCount, columnCount: t.columnCount },
          },
        })),
      }));
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return { calls, stats, batchUrls: () => calls.filter((c) => c.url.includes('values:batchGet')).map((c) => c.url) };
}

function ctx(extra: Partial<SheetsContext> = {}): SheetsContext {
  return {
    fileId: FILE_ID,
    accessToken: 'tok',
    signal: new AbortController().signal,
    name: 'Budget',
    link: LINK,
    ...extra,
  };
}

async function readText(extra: Partial<SheetsContext> = {}): Promise<string> {
  const result = await readSheet(ctx(extra));
  if (!('text' in result)) throw new Error(`expected text, got ${JSON.stringify(result)}`);
  return result.text;
}

function grid(rows: number, cols: number, cell = (r: number, c: number) => `r${r}c${c}`): string[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cell(r + 1, c + 1)));
}

// The CSV lines inside the code block under "# <title>"
function tabCsv(text: string, title: string): string[] {
  const start = text.indexOf(`# ${title}\n\n`);
  if (start < 0) throw new Error(`no tab ${title}`);
  const after = text.slice(start);
  const open = after.match(/\n\n(`{3,})csv\n/)!;
  const body = after.slice(open.index! + open[0].length);
  const close = body.indexOf(`${open[1]}`);
  const csv = body.slice(0, close).replace(/\n$/, '');
  return csv ? csv.split('\n') : [];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Sheets helpers', () => {
  it('names columns', () => {
    expect([1, 26, 27, 52, 256].map(columnLetter)).toEqual(['A', 'Z', 'AA', 'AZ', 'IV']);
  });

  it('quotes a tab title and doubles its apostrophes', () => {
    expect(a1Range("Bob's tab", 3, 9, 28)).toBe("'Bob''s tab'!A3:AB9");
  });

  it('quotes CSV fields per RFC 4180', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('two\nlines')).toBe('"two\nlines"');
    expect(csvField('cr\rhere')).toBe('"cr\rhere"');
  });

  it('pads rows to the widest one and drops trailing empty rows', () => {
    expect(normalizeRows([['a'], undefined, ['b', 'c'], [], ['', '']])).toEqual([
      ['a', ''],
      ['', ''],
      ['b', 'c'],
    ]);
  });
});

describe('planRead', () => {
  it('requests each grid tab whole, columns capped at SHEETS_MAX_COLUMNS_PER_TAB and rows at one cell budget', () => {
    const perTabRows = Math.floor(SHEETS_MAX_CELLS / SHEETS_MAX_COLUMNS_PER_TAB);
    const plan = planRead([
      tabOf({ title: 'Wide', rowCount: perTabRows + 10, columnCount: SHEETS_MAX_COLUMNS_PER_TAB + 44 }, 0),
      tabOf({ title: 'Next', rowCount: 10, columnCount: SHEETS_MAX_COLUMNS_PER_TAB }, 1),
      tabOf({ title: 'Empty', rowCount: 0, columnCount: 26 }, 2),
    ], FILE_ID);

    expect(plan.grid.map((r) => [r.tab.title, r.rows, r.cols, r.range])).toEqual([
      ['Wide', perTabRows, SHEETS_MAX_COLUMNS_PER_TAB, `'Wide'!A1:IV${perTabRows}`],
      // Requests don't share the budget: it is charged on what comes back
      ['Next', 10, SHEETS_MAX_COLUMNS_PER_TAB, "'Next'!A1:IV10"],
      ['Empty', 0, 0, ''],
    ]);
    expect(plan.batches.map((b) => b.map((r) => r.tab.title))).toEqual([['Wide', 'Next']]);
    expect(plan.overCalls).toEqual([]);
  });

  it('gives a tab request at most the cells it is given', () => {
    const tab = tabOf({ title: 'T', rowCount: 100_000, columnCount: 26 }, 0);
    expect(tabRequest(tab, SHEETS_MAX_CELLS).rows).toBe(Math.floor(SHEETS_MAX_CELLS / 26));
    expect(tabRequest(tab, 26 * 7 + 25).rows).toBe(7);
    expect(tabRequest(tab, 25)).toMatchObject({ rows: 0, range: '' });
  });

  it('never exceeds the call, URL or per-tab cell bounds over random tab shapes', () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let trial = 0; trial < 500; trial++) {
      const tabs = Array.from({ length: 1 + rand(rand(2) ? 12 : 200) }, (_, i) =>
        tabOf({
          title: `Tab ${i} ${'x'.repeat(rand(60))}`,
          rowCount: rand(rand(2) ? 50 : 200_000),
          columnCount: rand(rand(2) ? 26 : 400),
        }, i));
      const plan = planRead(tabs, FILE_ID);

      expect(plan.batches.length).toBeLessThanOrEqual(SHEETS_MAX_VALUE_CALLS);
      const requested = plan.batches.flat();
      for (const r of requested) {
        expect(r.rows * r.cols).toBeLessThanOrEqual(SHEETS_MAX_CELLS);
        expect(r.cols).toBeLessThanOrEqual(SHEETS_MAX_COLUMNS_PER_TAB);
      }
      for (const batch of plan.batches) {
        expect(batch.length).toBeGreaterThan(0);
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${FILE_ID}/values:batchGet?` +
          new URLSearchParams([...batch.map((r) => ['ranges', r.range]), ['valueRenderOption', 'FORMATTED_VALUE'], ['majorDimension', 'ROWS']]);
        expect(url.length).toBeLessThanOrEqual(SHEETS_MAX_URL_CHARS);
      }
      // Every non-empty grid tab is requested once, in sheet order, or left out past the call cap
      const nonEmpty = tabs.filter((t) => t.rowCount > 0 && t.columnCount > 0).map((t) => t.title);
      expect([...requested.map((r) => r.tab.title), ...plan.overCalls.map((t) => t.title)]).toEqual(nonEmpty);
      if (plan.overCalls.length) expect(plan.batches).toHaveLength(SHEETS_MAX_VALUE_CALLS);
    }
  });

  it('splits into consecutive calls before a URL passes SHEETS_MAX_URL_CHARS', () => {
    const tabs = Array.from({ length: 150 }, (_, i) =>
      tabOf({ title: `Quarterly report — region ${i} ${'é'.repeat(60)}`, rowCount: 5, columnCount: 4 }, i));
    const plan = planRead(tabs, FILE_ID);
    expect(plan.batches.length).toBeGreaterThan(1);
    expect(plan.batches.length).toBeLessThanOrEqual(SHEETS_MAX_VALUE_CALLS);
    expect(plan.batches.flat().map((r) => r.tab.title)).toEqual(tabs.slice(0, plan.batches.flat().length).map((t) => t.title));
    for (const batch of plan.batches) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${FILE_ID}/values:batchGet?` +
        new URLSearchParams([...batch.map((r) => ['ranges', r.range]), ['valueRenderOption', 'FORMATTED_VALUE'], ['majorDimension', 'ROWS']]);
      expect(url.length).toBeLessThanOrEqual(SHEETS_MAX_URL_CHARS);
    }
  });
});

describe('readSheet', () => {
  it('renders every grid tab in sheet order, marks hidden tabs and names skipped non-grid tabs', async () => {
    fakeSheets([
      { title: 'Summary', rowCount: 3, columnCount: 2, data: [['h1', 'h2'], ['1', '2']] },
      { title: 'Chart 1', sheetType: 'OBJECT', rowCount: 0, columnCount: 0 },
      { title: 'Raw', hidden: true, rowCount: 2, columnCount: 1, data: [['x'], ['y']] },
      { title: 'Source', sheetType: 'DATA_SOURCE', rowCount: 0, columnCount: 0 },
    ]);
    const text = await readText();

    expect(text.indexOf('# Summary\n')).toBeLessThan(text.indexOf('# Raw (hidden)\n'));
    expect(tabCsv(text, 'Summary')).toEqual(['h1,h2', '1,2']);
    expect(tabCsv(text, 'Raw (hidden)')).toEqual(['x', 'y']);
    expect(text).not.toContain('# Chart 1');
    expect(text).toContain("Skipped tabs that aren't grids (no cells to read): 'Chart 1' (OBJECT), 'Source' (DATA_SOURCE).");
  });

  it('asks for formatted values in rows, every tab in one batch when it fits', async () => {
    const fake = fakeSheets([
      { title: "Bob's", rowCount: 2, columnCount: 3, data: [['a']] },
      { title: 'Two', rowCount: 4, columnCount: 2, data: [['b']] },
    ]);
    await readText();
    const urls = fake.batchUrls();
    expect(urls).toHaveLength(1);
    const params = new URL(urls[0]).searchParams;
    expect(params.getAll('ranges')).toEqual(["'Bob''s'!A1:C2", "'Two'!A1:B4"]);
    expect(params.get('valueRenderOption')).toBe('FORMATTED_VALUE');
    expect(params.get('majorDimension')).toBe('ROWS');
    const get = new URL(fake.calls[0].url);
    expect(get.pathname).toBe(`/v4/spreadsheets/${FILE_ID}`);
    expect(get.searchParams.get('fields')).toBe(
      'sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount))',
    );
  });

  it('quotes CSV cells with commas, quotes and newlines', async () => {
    fakeSheets([{ title: 'Q', rowCount: 1, columnCount: 3, data: [['a,b', 'say "hi"', 'two\nlines']] }]);
    const text = await readText();
    expect(text).toContain('```csv\n"a,b","say ""hi""","two\nlines"\n```');
  });

  it('uses a fence longer than any backtick run in the CSV', async () => {
    fakeSheets([{ title: 'Code', rowCount: 1, columnCount: 1, data: [['run ```` this']] }]);
    const text = await readText();
    expect(text).toContain('`````csv\nrun ```` this\n`````');
  });

  it('reads default 1000 × 26 grids with a few rows each in one call, every tab whole, no bounded note (D20)', async () => {
    const tabs: FakeTab[] = Array.from({ length: 6 }, (_, i) => ({
      title: `Tab ${i}`,
      rowCount: 1000,
      columnCount: 26,
      data: [[`mark-${i}`, 'b'], [], ['c', '', 'e']],
    }));
    const fake = fakeSheets(tabs);
    const text = await readText();

    expect(fake.batchUrls()).toHaveLength(1);
    expect(new URL(fake.batchUrls()[0]).searchParams.getAll('ranges')).toEqual(tabs.map((t) => `'${t.title}'!A1:Z1000`));
    for (const [i, t] of tabs.entries()) expect(tabCsv(text, t.title)).toEqual([`mark-${i},b,`, ',,', 'c,,e']);
    expect(text).not.toContain('Read rows');
    expect(text).not.toContain('Not read');
  });

  it('charges the budget on returned cells: the tab that crosses it is cut with the kept rows, later tabs are over', async () => {
    const width = 30;
    const rows = (SHEETS_MAX_CELLS * 3) / 5 / width;
    const keep = Math.floor((SHEETS_MAX_CELLS - rows * width) / width);
    const fake = fakeSheets([
      { title: 'First', rowCount: rows, columnCount: width, data: grid(rows, width, (r, c) => (c === 1 ? `${r}` : '1')) },
      { title: 'Second', sheetId: 9, rowCount: rows, columnCount: width, data: grid(rows, width, (r, c) => (c === 1 ? `${r}` : '1')) },
      { title: 'Third', rowCount: 3, columnCount: 2, data: [['t']] },
    ]);
    const text = await readText();

    expect(fake.batchUrls()).toHaveLength(1);
    expect(tabCsv(text, 'First')).toHaveLength(rows);
    const second = tabCsv(text, 'Second');
    expect(second).toHaveLength(keep);
    expect(second[keep - 1]).toBe([`${keep}`, ...Array(width - 1).fill('1')].join(','));
    expect(text).toContain(
      `Read rows 1–${keep} and columns A–${columnLetter(width)} of a grid of ${rows} rows × ${width} columns. ` +
      `Cells outside that range aren't included (they may be empty). Open the sheet for the rest: ${LINK}#gid=9`,
    );
    expect(text.match(/Read rows/g)).toHaveLength(1);
    expect(text).not.toContain('# Third');
    expect(text).toContain(`Not read, over the ${SHEETS_MAX_CELLS}-cell budget for one read: 'Third'. Open the sheet to see them: ${LINK}`);
  });

  it('charges the width Sheets returned, not the grid width', async () => {
    // Default 1000 × 26 grids with 2 columns of data: charged 2 cells a row, so
    // this many tabs spend the budget exactly and the next one is over it
    const charged = 1000 * 2;
    const fits = Math.floor(SHEETS_MAX_CELLS / charged);
    const tabs: FakeTab[] = Array.from({ length: fits + 1 }, (_, i) => ({
      title: `T${i}`,
      rowCount: 1000,
      columnCount: 26,
      data: grid(1000, 2, () => '1'),
    }));
    fakeSheets(tabs);
    const text = await readText();
    for (const t of tabs.slice(0, fits)) expect(tabCsv(text, t.title)).toHaveLength(1000);
    expect(text).not.toContain('Read rows');
    expect(text).toContain(`Not read, over the ${SHEETS_MAX_CELLS}-cell budget for one read: 'T${fits}'.`);
  });

  it('requests a tall tab up to one cell budget, with the bounded note', async () => {
    const rows = Math.floor(SHEETS_MAX_CELLS / 26);
    const fake = fakeSheets([{ title: 'Tall', rowCount: 100_000, columnCount: 26, data: [['top']] }]);
    const text = await readText();
    expect(new URL(fake.batchUrls()[0]).searchParams.getAll('ranges')).toEqual([`'Tall'!A1:Z${rows}`]);
    expect(tabCsv(text, 'Tall')).toEqual(['top']);
    expect(text).toContain(`Read rows 1–${rows} and columns A–Z of a grid of 100000 rows × 26 columns.`);
  });

  it('adds the bounded-range note when the request is smaller than the grid, also when it returns nothing', async () => {
    const data: string[][] = [];
    data[0] = [];
    data[0][299] = 'far right';
    const fake = fakeSheets([{ title: 'Sparse', sheetId: 77, rowCount: 3, columnCount: 300, data }]);
    const text = await readText();

    expect(new URL(fake.batchUrls()[0]).searchParams.getAll('ranges')).toEqual([
      `'Sparse'!A1:${columnLetter(SHEETS_MAX_COLUMNS_PER_TAB)}3`,
    ]);
    expect(tabCsv(text, 'Sparse')).toEqual([]);
    expect(text).toContain(
      "Read rows 1–3 and columns A–IV of a grid of 3 rows × 300 columns. Cells outside that range aren't included " +
      `(they may be empty). Open the sheet for the rest: ${LINK}#gid=77`,
    );
  });

  it('renders an empty grid as an empty tab without requesting it', async () => {
    const fake = fakeSheets([
      { title: 'None', rowCount: 0, columnCount: 0 },
      { title: 'Some', rowCount: 2, columnCount: 2, data: [['s']] },
    ]);
    const text = await readText();
    expect(new URL(fake.batchUrls()[0]).searchParams.getAll('ranges')).toEqual(["'Some'!A1:B2"]);
    expect(tabCsv(text, 'None')).toEqual([]);
    expect(tabCsv(text, 'Some')).toEqual(['s']);
  });

  it('handles many tabs: every tab is rendered or named, calls and URLs stay bounded', async () => {
    const tabs: FakeTab[] = Array.from({ length: 200 }, (_, i) => ({
      title: `Tab number ${i} with a long descriptive name ${'ü'.repeat(40)}`,
      rowCount: 10,
      columnCount: 5,
      data: [[`v${i}`]],
    }));
    const fake = fakeSheets(tabs);
    const text = await readText();

    expect(fake.batchUrls().length).toBeLessThanOrEqual(SHEETS_MAX_VALUE_CALLS);
    for (const url of fake.batchUrls()) expect(url.length).toBeLessThanOrEqual(SHEETS_MAX_URL_CHARS);
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    const rendered = tabs.filter((t) => text.includes(`# ${t.title}\n`)).length;
    expect(rendered).toBeGreaterThan(0);
    if (rendered < tabs.length) expect(text).toMatch(/Not read, over the \d+-cell budget for one read: .* more\./);
  });

  describe('byte caps', () => {
    // Response bytes for a tab: this share of the per-call cap
    const heavy = (share: number) => Math.floor(SHEETS_MAX_BYTES_PER_CALL * share);

    it('returns the D9 reason when the first call is one tab over the per-call cap, before parsing all of it', async () => {
      const big = 'x'.repeat(SHEETS_MAX_BYTES_PER_CALL);
      const fake = fakeSheets([{ title: 'Long', rowCount: 2, columnCount: 1, data: [[big], [big]] }], { stream: true });
      const result = await readSheet(ctx());
      expect(result).toEqual({ detailsOnly: expect.stringContaining('too large') });
      expect(fake.stats.pulled).toBeLessThan(fake.stats.total);
      expect(fake.batchUrls()).toHaveLength(1);
    });

    it('falls back to one tab per call when a multi-tab call passes the cap', async () => {
      const fake = fakeSheets(['A', 'B', 'C'].map((title) => ({ title, rowCount: 1000, columnCount: 26, data: [['v'], ['x']], padBytes: heavy(0.4) })), { stream: true });
      const text = await readText();

      const urls = fake.batchUrls();
      expect(urls).toHaveLength(4);
      expect(new URL(urls[0]).searchParams.getAll('ranges')).toHaveLength(3);
      expect(urls.slice(1).map((u) => new URL(u).searchParams.getAll('ranges'))).toEqual([
        ["'A'!A1:Z1000"], ["'B'!A1:Z1000"], ["'C'!A1:Z1000"],
      ]);
      for (const title of ['A', 'B', 'C']) expect(tabCsv(text, title)).toHaveLength(2);
      expect(text).not.toContain('Not read');
      expect(text).not.toContain('Read rows');
    });

    it('caps each per-tab call at the cells left and notes the rows read', async () => {
      const width = 30;
      const rows = (SHEETS_MAX_CELLS * 3) / 5 / width;
      const left = SHEETS_MAX_CELLS - rows * width;
      const fake = fakeSheets([
        { title: 'Full', rowCount: rows, columnCount: width, data: grid(rows, width, () => '1') },
        { title: 'Heavy', rowCount: 10, columnCount: 1, data: [['h']], padBytes: heavy(1) },
        { title: 'Later', rowCount: 1000, columnCount: 26, data: [['l']] },
      ], { stream: true });
      const text = await readText();

      const ranges = fake.batchUrls().slice(1).map((u) => new URL(u).searchParams.getAll('ranges')[0]);
      expect(ranges).toEqual([`'Full'!A1:AD${rows}`, "'Heavy'!A1:A10", `'Later'!A1:Z${Math.floor(left / 26)}`]);
      expect(tabCsv(text, 'Full')).toHaveLength(rows);
      expect(tabCsv(text, 'Later')).toEqual(['l']);
      expect(text).toContain(`Read rows 1–${Math.floor(left / 26)} and columns A–Z of a grid of 1000 rows × 26 columns.`);
      expect(text).toContain("Not read, the response size limit was reached: 'Heavy'.");
    });

    it('lists a per-tab call over the cap as too large and still reads later tabs', async () => {
      fakeSheets([
        { title: 'Huge', rowCount: 10, columnCount: 1, data: [['h']], padBytes: heavy(1) },
        { title: 'Small', rowCount: 5, columnCount: 2, data: [['s', 't']] },
      ], { stream: true });
      const text = await readText();
      expect(text).not.toContain('# Huge');
      expect(tabCsv(text, 'Small')).toEqual(['s,t']);
      expect(text).toContain(`Not read, the response size limit was reached: 'Huge'. Open the sheet to see them: ${LINK}`);
    });

    it.each([0.4, 0.9])('never passes SHEETS_MAX_VALUE_CALLS or the per-read cap in the fallback (tabs at %s of the per-call cap)', async (share) => {
      const tabs: FakeTab[] = Array.from({ length: SHEETS_MAX_VALUE_CALLS * 2 }, (_, i) => ({
        title: `T${i}`,
        rowCount: 1000,
        columnCount: 26,
        data: [['v']],
        padBytes: heavy(share),
      }));
      const fake = fakeSheets(tabs, { stream: true });
      const text = await readText();

      expect(fake.batchUrls()).toHaveLength(SHEETS_MAX_VALUE_CALLS);
      const rendered = tabs.filter((t) => text.includes(`# ${t.title}\n`));
      expect(rendered.length * heavy(share)).toBeLessThanOrEqual(SHEETS_MAX_BYTES_PER_READ);
      expect(rendered.map((t) => t.title)).toEqual(tabs.slice(0, rendered.length).map((t) => t.title));
      const notRead = tabs.slice(rendered.length).map((t) => `'${t.title}'`).join(', ');
      expect(text).toContain(`Not read, the response size limit was reached: ${notRead}.`);
      expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    });
  });

  it('cuts at a row boundary at the character cap, closes the fence and keeps the note inside the limit', async () => {
    const rows = 2000;
    fakeSheets([
      { title: 'Text', rowCount: rows, columnCount: 1, data: grid(rows, 1, (r) => `${r}:${'t'.repeat(200)}`) },
      { title: 'Next', rowCount: 1, columnCount: 1, data: [['n']] },
    ]);
    const text = await readText();

    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    const csv = tabCsv(text, 'Text');
    expect(csv.length).toBeGreaterThan(0);
    expect(csv.length).toBeLessThan(rows);
    expect(csv[csv.length - 1]).toMatch(/^\d+:t{200}$/);
    expect((text.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(text).toContain(`Cropped: 'Text' shows rows 1–${csv.length} of what was read`);
    expect(text).toContain(`Not included, the ${MAX_TEXT_CHARS}-character limit was reached: 'Next'.`);
  });

  it('keeps the bounded-range note on a tab cut at the character cap', async () => {
    const perTabRows = Math.floor(SHEETS_MAX_CELLS / SHEETS_MAX_COLUMNS_PER_TAB);
    fakeSheets([{ title: 'Wide', rowCount: 1000, columnCount: 300, data: grid(1000, 1, (r) => `${r}:${'w'.repeat(6000)}`) }]);
    const text = await readText();

    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect((text.match(/^```/gm) ?? []).length % 2).toBe(0);
    const csv = tabCsv(text, 'Wide');
    expect(csv.length).toBeGreaterThan(0);
    expect(csv.length).toBeLessThan(perTabRows);
    expect(text).toContain(`Read rows 1–${perTabRows} and columns A–IV of a grid of 1000 rows × 300 columns.`);
    expect(text).toContain(`Cropped: 'Wide' shows rows 1–${csv.length} of what was read`);
  });

  it('keeps the kept-rows note on a tab cut at the cell budget and then at the character cap', async () => {
    const before = SHEETS_MAX_CELLS - 50;
    fakeSheets([
      { title: 'Ids', rowCount: before, columnCount: 1, data: grid(before, 1, () => '1') },
      { title: 'Long', rowCount: 1000, columnCount: 1, data: grid(1000, 1, (r) => `${r}:${'w'.repeat(6000)}`) },
    ]);
    const text = await readText();

    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect((text.match(/^```/gm) ?? []).length % 2).toBe(0);
    const csv = tabCsv(text, 'Long');
    expect(csv.length).toBeGreaterThan(0);
    expect(csv.length).toBeLessThan(50);
    expect(text).toContain('Read rows 1–50 and columns A–A of a grid of 1000 rows × 1 columns.');
    expect(text).toContain(`Cropped: 'Long' shows rows 1–${csv.length} of what was read`);
  });

  it.each([
    [403, 'forbidden'],
    [429, undefined],
  ])('passes a Sheets API %i through as an error', async (status, reason) => {
    fakeSheets([{ title: 'A', rowCount: 1, columnCount: 1 }], { getStatus: status, getReason: reason });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as any);
    const err = await readSheet(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect(err.status).toBe(status);
  });

  it('sends the resource key and the signal on every Sheets call', async () => {
    const fake = fakeSheets([{ title: 'A', rowCount: 1, columnCount: 1, data: [['a']] }]);
    const signal = new AbortController().signal;
    await readText({ resourceKey: '0-key', signal });
    expect(fake.calls).toHaveLength(2);
    for (const call of fake.calls) {
      expect(new Headers(call.init?.headers).get('x-goog-drive-resource-keys')).toBe(`${FILE_ID}/0-key`);
      expect(call.init?.signal).toBe(signal);
    }
  });

  it('sends no resource key header without a key', async () => {
    const fake = fakeSheets([{ title: 'A', rowCount: 1, columnCount: 1, data: [['a']] }]);
    await readText();
    for (const call of fake.calls) expect(new Headers(call.init?.headers).get('x-goog-drive-resource-keys')).toBeNull();
  });
});

describe('keyed-link fallback (D19)', () => {
  const csvExport: Handler = () => new Response('﻿name,qty\r\n"a,1",2\r\n', { status: 200 });
  const NOTE = 'Only the first tab could be read for this link. Open the sheet once in your browser and add it again to include every tab.';

  it.each([
    ['Sheets 404', { getStatus: 404 }],
    ['Sheets 403 forbidden', { getStatus: 403, getReason: 'forbidden' }],
  ])('%s falls back to the Drive CSV export with the key header', async (_label, opts) => {
    const fake = fakeSheets([], { ...opts, export: csvExport });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const text = await readText({ resourceKey: 'k1' });

    expect(text).toBe(`# Budget (first tab only)\n\n\`\`\`csv\nname,qty\n"a,1",2\n\`\`\`\n\n${NOTE}`);
    const exp = fake.calls.find((c) => c.url.includes('/export?'))!;
    expect(new URL(exp.url).searchParams.get('mimeType')).toBe('text/csv');
    expect(new Headers(exp.init?.headers).get('x-goog-drive-resource-keys')).toBe(`${FILE_ID}/k1`);
    expect(exp.init?.signal).toBeDefined();
  });

  it.each([
    ['403 rateLimitExceeded', 403, 'rateLimitExceeded'],
    ['403 userRateLimitExceeded', 403, 'userRateLimitExceeded'],
    ['429', 429, undefined],
    ['500', 500, undefined],
    ['503', 503, undefined],
  ])('does not fall back on %s', async (_label, status, reason) => {
    const fake = fakeSheets([], { getStatus: status, getReason: reason, export: csvExport });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => { fn(); return 0; }) as any);
    const err = await readSheet(ctx({ resourceKey: 'k1' })).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect(err.status).toBe(status);
    expect(fake.calls.some((c) => c.url.includes('/export?'))).toBe(false);
  });

  it('does not fall back without a key', async () => {
    const fake = fakeSheets([], { getStatus: 404, export: csvExport });
    const err = await readSheet(ctx()).catch((e) => e);
    expect(err).toBeInstanceOf(DriveApiError);
    expect(err.status).toBe(404);
    expect(fake.calls.some((c) => c.url.includes('/export?'))).toBe(false);
  });

  it('drops partial Sheets output when a later call returns 404', async () => {
    // Long tab names split the ranges over more than one call
    const tabs: FakeTab[] = Array.from({ length: 150 }, (_, i) => ({
      title: `Quarterly report — region ${i} ${'é'.repeat(60)}`,
      rowCount: 5,
      columnCount: 4,
      data: [['v']],
    }));
    const fake = fakeSheets(tabs, { failBatch: { n: 2, status: 404 }, export: csvExport });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const text = await readText({ resourceKey: 'k1' });
    expect(fake.batchUrls()).toHaveLength(2);
    expect(text).not.toContain('# Quarterly');
    expect(text).toContain('# Budget (first tab only)');
  });

  it('returns the D9 reason when the fallback export is over the export limit', async () => {
    fakeSheets([], {
      getStatus: 404,
      export: () => new Response(errorBody(403, 'exportSizeLimitExceeded'), { status: 403 }),
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await readSheet(ctx({ resourceKey: 'k1' }))).toEqual({ detailsOnly: expect.stringContaining('10 MB') });
  });

  it('truncates a long fallback CSV at a line boundary inside the limit', async () => {
    const line = `${'c'.repeat(99)}\n`;
    fakeSheets([], { getStatus: 404, export: () => new Response(line.repeat(5000), { status: 200 }) });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const text = await readText({ resourceKey: 'k1' });
    expect(text.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(text).toMatch(/c{99}\n```\n\n\[Truncated at \d+ characters\. Full file: /);
    expect(text.endsWith(NOTE)).toBe(true);
  });

  it('logs the fallback without ids', async () => {
    fakeSheets([], { getStatus: 404, export: csvExport });
    const written = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await readText({ resourceKey: 'k1' });
    const lines = written.mock.calls.map(([chunk]) => String(chunk));
    const record = lines.map((l) => JSON.parse(l)).find((r) => r.event === 'sheets_keyed_fallback');
    expect(record).toMatchObject({ level: 'info', status: 404 });
    expect(lines.join('')).not.toContain(FILE_ID);
    expect(lines.join('')).not.toContain('k1');
  });
});
