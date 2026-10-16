// resources/read for a Google Sheet: every grid tab through the Sheets API,
// within the D16 budgets, rendered as Markdown (a heading and a CSV block per
// tab). A keyed link the Sheets API refuses falls back to Drive's first-tab CSV
// export (D19)

import { DriveApiError, EXPORT_LIMIT_MESSAGE, ResponseTooLargeError, driveRequestInit, exportFile, makeDriveRequest } from './driveApi.js';
import type { DriveUri } from './driveUri.js';
import { codeFence, sliceChars, stripBom, type TextRead } from './resourceText.js';
import { log } from './log.js';
import {
  MAX_TEXT_CHARS,
  SHEETS_MAX_BYTES_PER_CALL,
  SHEETS_MAX_BYTES_PER_READ,
  SHEETS_MAX_CELLS,
  SHEETS_MAX_COLUMNS_PER_TAB,
  SHEETS_MAX_URL_CHARS,
  SHEETS_MAX_VALUE_CALLS,
  TEXT_NOTES_RESERVE_CHARS,
} from './limits.js';

export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets';

const TAB_FIELDS = 'sheets.properties(sheetId,title,index,sheetType,hidden,gridProperties(rowCount,columnCount))';

export interface SheetTab {
  sheetId: number;
  title: string;
  index: number;
  sheetType: string;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
}

// One grid tab's request: rows 1..rows and columns A..cols, as one range of a
// values.batchGet call. An empty grid (0 rows or 0 columns) has rows = cols = 0
// and no range: it isn't requested and is rendered as an empty tab
export interface TabRequest {
  tab: SheetTab;
  rows: number;
  cols: number;
  range: string;
}

export interface ReadPlan {
  // Every grid tab, in sheet order
  grid: TabRequest[];
  // The requested tabs, in sheet order, one values.batchGet call each
  batches: TabRequest[][];
  // Tabs past SHEETS_MAX_VALUE_CALLS when the ranges are split by URL length
  overCalls: SheetTab[];
  nonGrid: SheetTab[];
}

export interface SheetsContext {
  file: DriveUri;
  accessToken: string;
  signal: AbortSignal;
  name: string;
  link: string;
}


// 1 → A, 26 → Z, 27 → AA, 256 → IV
export function columnLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) {
    s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  }
  return s;
}

export function a1Range(title: string, r1: number, r2: number, cols: number): string {
  return `'${title.replace(/'/g, "''")}'!A${r1}:${columnLetter(cols)}${r2}`;
}

export function batchGetUrl(fileId: string, ranges: string[]): string {
  const params = new URLSearchParams();
  for (const range of ranges) params.append('ranges', range);
  params.set('valueRenderOption', 'FORMATTED_VALUE');
  params.set('majorDimension', 'ROWS');
  return `${SHEETS_API}/${encodeURIComponent(fileId)}/values:batchGet?${params}`;
}

// A whole tab, within maxCells: cols = min(columnCount,
// SHEETS_MAX_COLUMNS_PER_TAB), rows = min(rowCount, ⌊maxCells / cols⌋)
export function tabRequest(tab: SheetTab, maxCells: number): TabRequest {
  const cols = Math.min(tab.columnCount, SHEETS_MAX_COLUMNS_PER_TAB);
  if (cols <= 0 || tab.rowCount <= 0) return { tab, rows: 0, cols: 0, range: '' };
  const rows = Math.min(tab.rowCount, Math.floor(maxCells / cols));
  return { tab, rows, cols, range: rows > 0 ? a1Range(tab.title, 1, rows, cols) : '' };
}

/**
 * D16/D20 requests. Every grid tab, in sheet order, is requested whole as one
 * range (at most SHEETS_MAX_COLUMNS_PER_TAB columns and SHEETS_MAX_CELLS
 * cells). The ranges go into one values.batchGet call, split into consecutive
 * calls only where the URL would pass SHEETS_MAX_URL_CHARS. Tabs that would
 * need more than SHEETS_MAX_VALUE_CALLS calls are left out. The cell budget is
 * charged later, on what comes back
 */
export function planRead(tabs: SheetTab[], fileId: string): ReadPlan {
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const nonGrid = sorted.filter((t) => t.sheetType !== 'GRID');
  const grid = sorted.filter((t) => t.sheetType === 'GRID').map((t) => tabRequest(t, SHEETS_MAX_CELLS));

  const baseUrlLength = batchGetUrl(fileId, []).length;
  const rangeCost = (range: string) => new URLSearchParams({ ranges: range }).toString().length + 1;

  const batches: TabRequest[][] = [];
  const overCalls: SheetTab[] = [];
  let batch: TabRequest[] = [];
  let urlLength = baseUrlLength;
  let full = false;

  for (const request of grid) {
    if (request.rows === 0) continue;
    if (!full && batch.length && urlLength + rangeCost(request.range) > SHEETS_MAX_URL_CHARS) {
      batches.push(batch);
      batch = [];
      urlLength = baseUrlLength;
      full = batches.length >= SHEETS_MAX_VALUE_CALLS;
    }
    if (full) {
      overCalls.push(request.tab);
      continue;
    }
    batch.push(request);
    urlLength += rangeCost(request.range);
  }
  if (batch.length) batches.push(batch);

  return { grid, batches, overCalls, nonGrid };
}

// RFC 4180: a field with a comma, quote, CR or LF is quoted, quotes doubled
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function csvRow(row: string[]): string {
  return row.map(csvField).join(',');
}

// Rows as placed: undefined where nothing came back. Pads each row to the
// widest one and drops the tab's trailing empty rows
export function normalizeRows(rows: Array<string[] | undefined>): string[][] {
  const width = rows.reduce((w, r) => Math.max(w, r?.length ?? 0), 0);
  const out = rows.map((r) => {
    const row = (r ?? []).map((v) => (v === undefined || v === null ? '' : String(v)));
    while (row.length < width) row.push('');
    return row;
  });
  while (out.length && out[out.length - 1].every((v) => v === '')) out.pop();
  return out;
}

// What became of one grid tab, in sheet order: rendered (noteRows set when the
// tab gets the bounded-range note, with the rows it says were read), or left
// out over the cell budget or the response size limit
type LeftOut = 'budget' | 'size' | 'calls';

type TabOutcome =
  | { tab: SheetTab; rows: string[][]; cols: number; noteRows?: number }
  | { tab: SheetTab; leftOut: LeftOut };

type TabResolution = { request: TabRequest; values: unknown[] } | { leftOut: LeftOut };

/**
 * D20: charges SHEETS_MAX_CELLS on the cells Sheets returned, in sheet order.
 * Tabs are settled as their values arrive (always in sheet order) and charged
 * returnedRows × returnedWidth after normalizeRows. The tab that crosses the
 * budget keeps ⌊remaining / width⌋ rows; later tabs are over the budget
 */
class CellLedger {
  remaining = SHEETS_MAX_CELLS;
  readonly outcomes: TabOutcome[] = [];
  private next = 0;
  private readonly resolved = new Map<SheetTab, TabResolution>();

  constructor(private readonly grid: TabRequest[]) {}

  get spent(): boolean {
    return this.remaining <= 0;
  }

  settle(tab: SheetTab, resolution: TabResolution): void {
    this.resolved.set(tab, resolution);
    while (this.next < this.grid.length) {
      const request = this.grid[this.next];
      if (request.rows === 0) {
        this.outcomes.push({ tab: request.tab, rows: [], cols: 0 });
      } else {
        const res = this.resolved.get(request.tab);
        if (!res) return;
        this.outcomes.push(this.charge(request.tab, res));
      }
      this.next++;
    }
  }

  private charge(tab: SheetTab, res: TabResolution): TabOutcome {
    if ('leftOut' in res) return { tab, leftOut: res.leftOut };
    if (this.spent) return { tab, leftOut: 'budget' };
    const { request } = res;
    const rows = normalizeRows(
      res.values.slice(0, request.rows).map((row) =>
        Array.isArray(row) ? row.slice(0, request.cols).map((v) => (v == null ? '' : String(v))) : [],
      ),
    );
    const width = rows[0]?.length ?? 0;
    const bounded = request.rows < tab.rowCount || request.cols < tab.columnCount;
    if (rows.length * width <= this.remaining) {
      this.remaining -= rows.length * width;
      return { tab, rows, cols: request.cols, ...(bounded ? { noteRows: request.rows } : {}) };
    }
    const keep = Math.floor(this.remaining / width);
    this.remaining = 0;
    if (keep === 0) return { tab, leftOut: 'budget' };
    return { tab, rows: rows.slice(0, keep), cols: request.cols, noteRows: keep };
  }
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

// D19: a Sheets API refusal that a keyed link's Drive export may get past
export function isKeyedFallbackError(err: unknown): boolean {
  if (!(err instanceof DriveApiError)) return false;
  if (err.status === 404) return true;
  return err.status === 403 && !RATE_LIMIT_REASONS.has(err.reason ?? '');
}

function requestInit(ctx: SheetsContext): RequestInit {
  return driveRequestInit(ctx.file, ctx.signal);
}

export async function readSheet(ctx: SheetsContext): Promise<TextRead> {
  try {
    return await readThroughSheetsApi(ctx);
  } catch (err) {
    if (!ctx.file.resourceKey || !isKeyedFallbackError(err)) throw err;
    log('info', 'sheets_keyed_fallback', { status: (err as DriveApiError).status });
    return readFirstTabExport(ctx);
  }
}

async function readThroughSheetsApi(ctx: SheetsContext): Promise<TextRead> {
  const init = requestInit(ctx);
  let used = 0;

  // A Sheets call's body, streamed under the per-call and per-read byte caps.
  // A call over its cap still pulled bytes, charged to the read as well
  const fetchJson = async (url: string): Promise<any> => {
    const cap = Math.min(SHEETS_MAX_BYTES_PER_CALL, SHEETS_MAX_BYTES_PER_READ - used);
    if (cap <= 0) throw new ResponseTooLargeError(0);
    let body: Buffer;
    try {
      body = await makeDriveRequest(url, ctx.accessToken, init, { responseType: 'bytes', maxBytes: cap });
    } catch (err) {
      if (err instanceof ResponseTooLargeError) used += err.bytesRead;
      throw err;
    }
    used += body.length;
    return JSON.parse(body.toString('utf8'));
  };

  let meta: any;
  try {
    meta = await fetchJson(`${SHEETS_API}/${encodeURIComponent(ctx.file.id)}?fields=${encodeURIComponent(TAB_FIELDS)}`);
  } catch (err) {
    if (err instanceof ResponseTooLargeError) return { detailsOnly: sizeLimitReason() };
    throw err;
  }

  const tabs: SheetTab[] = (meta?.sheets ?? []).map((s: any, i: number) => {
    const p = s?.properties ?? {};
    return {
      sheetId: Number(p.sheetId ?? 0),
      title: String(p.title ?? `Sheet ${i + 1}`),
      index: Number.isFinite(p.index) ? p.index : i,
      sheetType: String(p.sheetType ?? 'GRID'),
      hidden: p.hidden === true,
      rowCount: Number(p.gridProperties?.rowCount ?? 0),
      columnCount: Number(p.gridProperties?.columnCount ?? 0),
    };
  });

  const plan = planRead(tabs, ctx.file.id);
  const ledger = new CellLedger(plan.grid);
  const leaveOut = (requests: TabRequest[], leftOut: LeftOut) => {
    for (const r of requests) ledger.settle(r.tab, { leftOut });
  };
  let calls = 0;

  const fetchValues = async (requests: TabRequest[]) => {
    calls++;
    const data = await fetchJson(batchGetUrl(ctx.file.id, requests.map((r) => r.range)));
    const valueRanges: any[] = Array.isArray(data?.valueRanges) ? data.valueRanges : [];
    requests.forEach((request, j) => {
      const values: unknown[] = Array.isArray(valueRanges[j]?.values) ? valueRanges[j].values : [];
      ledger.settle(request.tab, { request, values });
    });
  };

  // Usually one call for every tab; more only where the URL got too long
  let fallback: TabRequest[] = [];
  for (const [b, batch] of plan.batches.entries()) {
    if (ledger.spent) {
      leaveOut(plan.batches.slice(b).flat(), 'budget');
      break;
    }
    try {
      await fetchValues(batch);
    } catch (err) {
      if (!(err instanceof ResponseTooLargeError)) throw err;
      if (batch.length > 1) {
        fallback = plan.batches.slice(b).flat();
        break;
      }
      if (calls === 1) return { detailsOnly: sizeLimitReason() };
      ledger.settle(batch[0].tab, { leftOut: 'size' });
    }
  }

  // A multi-tab call passed the byte cap: one tab per call, in sheet order,
  // each within the cells still left, until the calls, the budget or the
  // per-read bytes run out
  for (const [i, whole] of fallback.entries()) {
    const rest = fallback.slice(i);
    if (ledger.spent) {
      leaveOut(rest, 'budget');
      break;
    }
    if (calls >= SHEETS_MAX_VALUE_CALLS || used >= SHEETS_MAX_BYTES_PER_READ) {
      leaveOut(rest, 'size');
      break;
    }
    const request = tabRequest(whole.tab, ledger.remaining);
    if (request.rows === 0) {
      // Fewer cells left than one row of this tab: it and later tabs are over
      leaveOut(rest, 'budget');
      break;
    }
    try {
      await fetchValues([request]);
    } catch (err) {
      if (!(err instanceof ResponseTooLargeError)) throw err;
      ledger.settle(whole.tab, { leftOut: 'size' });
    }
  }

  for (const tab of plan.overCalls) ledger.settle(tab, { leftOut: 'calls' });

  return { text: renderSheet(ctx, plan.nonGrid, ledger.outcomes) };
}

function sizeLimitReason(): string {
  return `The sheet's data is too large to read here (over the ${SHEETS_MAX_BYTES_PER_CALL / (1024 * 1024)} MiB limit for one Sheets response).`;
}

const MAX_NOTE_NAME_CHARS = 100;

function quoteName(name: string): string {
  return `'${sliceChars(name, MAX_NOTE_NAME_CHARS)}'`;
}

// "prefix: 'a', 'b' and 3 more. suffix" within maxChars
function nameListNote(prefix: string, names: string[], suffix: string, maxChars: number): string {
  const build = (shown: number) => {
    const list = names.slice(0, shown).join(', ');
    const more = names.length - shown;
    return `${prefix}: ${list}${more ? `${shown ? ' and ' : ''}${more} more` : ''}.${suffix ? ` ${suffix}` : ''}`;
  };
  for (let shown = names.length; shown >= 0; shown--) {
    const note = build(shown);
    if (note.length <= maxChars) return note;
  }
  return sliceChars(build(0), maxChars);
}

// Markdown for every tab, closing notes, all within MAX_TEXT_CHARS: tab
// sections within the limit minus TEXT_NOTES_RESERVE_CHARS, notes within the
// reserve
function renderSheet(ctx: SheetsContext, nonGrid: SheetTab[], outcomes: TabOutcome[]): string {
  const contentBudget = MAX_TEXT_CHARS - TEXT_NOTES_RESERVE_CHARS;
  const sections: string[] = [];
  let used = 0;
  let cropNote = '';
  const leftOut: Record<LeftOut, string[]> = { budget: [], size: [], calls: [] };
  const charCapped: string[] = [];
  let charCapHit = false;

  for (const outcome of outcomes) {
    const { tab } = outcome;
    if ('leftOut' in outcome) {
      leftOut[outcome.leftOut].push(quoteName(tab.title));
      continue;
    }
    if (charCapHit) {
      charCapped.push(quoteName(tab.title));
      continue;
    }

    const lines = outcome.rows.map(csvRow);
    const csv = lines.join('\n');
    const fence = codeFence(csv);
    const heading = `# ${tab.title}${tab.hidden ? ' (hidden)' : ''}`;
    const tabLink = `${ctx.link}#gid=${tab.sheetId}`;

    const tabNotes: string[] = [];
    if (outcome.noteRows !== undefined) {
      tabNotes.push(
        `Read rows 1–${outcome.noteRows} and columns A–${columnLetter(outcome.cols)} of a grid of ` +
        `${tab.rowCount} rows × ${tab.columnCount} columns. Cells outside that range aren't included ` +
        `(they may be empty). Open the sheet for the rest: ${tabLink}`,
      );
    }

    const sep = sections.length ? '\n\n' : '';
    const notesText = tabNotes.length ? `\n\n${tabNotes.join('\n\n')}` : '';
    const build = (rows: string[]) =>
      `${sep}${heading}\n\n${fence}csv\n${rows.join('\n')}${rows.length ? '\n' : ''}${fence}${notesText}`;
    const whole = build(lines);
    if (used + whole.length <= contentBudget) {
      sections.push(whole);
      used += whole.length;
      continue;
    }

    // Cut at a row boundary: the most rows whose section, bounded-range note
    // included (R7), still fits
    charCapHit = true;
    let room = contentBudget - used - build([]).length;
    let kept = 0;
    let keptLength = 0;
    while (kept < lines.length && keptLength + lines[kept].length + 1 <= room) {
      keptLength += lines[kept].length + 1;
      kept++;
    }
    if (kept === 0) {
      charCapped.push(quoteName(tab.title));
      continue;
    }
    const cut = build(lines.slice(0, kept));
    sections.push(cut);
    used += cut.length;
    cropNote =
      `Cropped: ${quoteName(tab.title)} shows rows 1–${kept} of what was read; the rest didn't fit in the ` +
      `${MAX_TEXT_CHARS}-character limit. Open the sheet for the rest: ${tabLink}`;
  }

  // Notes share the reserve; each gets a slice, name lists shorten to fit
  const pending: Array<(max: number) => string> = [];
  if (cropNote) pending.push((max) => sliceChars(cropNote, max));
  if (nonGrid.length) {
    pending.push((max) => nameListNote(
      "Skipped tabs that aren't grids (no cells to read)",
      nonGrid.map((t) => `${quoteName(t.title)} (${t.sheetType})`),
      '',
      max,
    ));
  }
  const leftOutPrefix: Record<LeftOut, string> = {
    budget: `Not read, over the ${SHEETS_MAX_CELLS}-cell budget for one read`,
    size: 'Not read, the response size limit was reached',
    calls: `Not read, over the ${SHEETS_MAX_VALUE_CALLS}-call limit for one read`,
  };
  for (const kind of ['budget', 'size', 'calls'] as const) {
    if (!leftOut[kind].length) continue;
    pending.push((max) => nameListNote(leftOutPrefix[kind], leftOut[kind], `Open the sheet to see them: ${ctx.link}`, max));
  }
  if (charCapped.length) {
    pending.push((max) => nameListNote(
      `Not included, the ${MAX_TEXT_CHARS}-character limit was reached`,
      charCapped,
      `Open the sheet to see them: ${ctx.link}`,
      max,
    ));
  }

  const separators = (sections.length ? 2 : 0) + Math.max(0, pending.length - 1) * 2;
  const share = pending.length ? Math.floor((TEXT_NOTES_RESERVE_CHARS - separators) / pending.length) : 0;
  const notes = pending.map((render) => render(share));
  const body = sections.join('');
  const text = notes.length ? `${body}${body ? '\n\n' : ''}${notes.join('\n\n')}` : body;
  return text || `# ${ctx.name}\n\nThis sheet has no tabs with cells to read.`;
}

// D19: Drive's CSV export of the first tab, for a keyed link the Sheets API
// refused
async function readFirstTabExport(ctx: SheetsContext): Promise<TextRead> {
  const bytes = await exportFile(ctx.file.id, 'text/csv', ctx.accessToken, requestInit(ctx));
  if (!bytes) return { detailsOnly: EXPORT_LIMIT_MESSAGE };

  const csv = stripBom(bytes.toString('utf8')).replace(/\r\n/g, '\n').replace(/\n$/, '');
  const fence = codeFence(csv);
  const heading = `# ${ctx.name} (first tab only)`;
  const note =
    'Only the first tab could be read for this link. Open the sheet once in your browser and add it again ' +
    'to include every tab.';

  const render = (body: string) => `${heading}\n\n${fence}csv\n${body}${body ? '\n' : ''}${fence}\n\n${note}`;
  const whole = render(csv);
  if (whole.length <= MAX_TEXT_CHARS) return { text: whole };

  // D10 inside the fence: cut at a line boundary, close the fence, then the
  // truncation note and the D19 note, all within MAX_TEXT_CHARS
  const truncation = (kept: number) => `[Truncated at ${kept} characters. Full file: ${ctx.link}]`;
  const room = MAX_TEXT_CHARS - render('').length - 1 - truncation(MAX_TEXT_CHARS).length - 2;
  let kept = sliceChars(csv, room);
  if (kept.lastIndexOf('\n') > 0) kept = kept.slice(0, kept.lastIndexOf('\n'));
  return { text: `${heading}\n\n${fence}csv\n${kept}\n${fence}\n\n${truncation(kept.length)}\n\n${note}` };
}
