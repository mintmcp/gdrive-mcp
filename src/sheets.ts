// resources/read for a Google Sheet: every grid tab through the Sheets API,
// within the D16 budgets, rendered as Markdown (a heading and a CSV block per
// tab). A keyed link the Sheets API refuses falls back to Drive's first-tab CSV
// export (D19)

import { DriveApiError, ResponseTooLargeError, makeDriveRequest } from './driveApi.js';
import { MAX_TEXT_CHARS } from './pdfText.js';
import { codeFence, sliceChars, stripBom } from './resourceText.js';
import { log } from './log.js';
import {
  SHEETS_BATCH_MAX_CELLS,
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

// The rectangle read from one grid tab: rows 1..rows, columns A..cols
export interface TabPlan {
  tab: SheetTab;
  rows: number;
  cols: number;
}

// Rows r1..r2 of one tab, requested as one range of a values.batchGet call
export interface Chunk {
  plan: TabPlan;
  r1: number;
  r2: number;
  range: string;
}

export interface ReadPlan {
  plans: TabPlan[];
  batches: Chunk[][];
  overBudget: SheetTab[];
  nonGrid: SheetTab[];
}

export interface SheetsContext {
  fileId: string;
  accessToken: string;
  resourceKey?: string;
  signal: AbortSignal;
  name: string;
  link: string;
}

// text: the Markdown to return. detailsOnly: the reason for a D9 text instead
export type SheetRead = { text: string } | { detailsOnly: string };

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

/**
 * D16 allocation and batching. Grid tabs get cells in sheet order: at most
 * SHEETS_MAX_COLUMNS_PER_TAB columns each and SHEETS_MAX_CELLS in total; a tab
 * that gets 0 rows is over budget. The rectangles are cut into row-aligned
 * chunks and packed in order into batches of at most SHEETS_BATCH_MAX_CELLS
 * cells (and SHEETS_MAX_URL_CHARS of URL). A tab's rows can split across
 * batches, a row never does. Past SHEETS_MAX_VALUE_CALLS batches, the tab being
 * packed keeps the rows that fit and later tabs are over budget
 */
export function planRead(tabs: SheetTab[], fileId: string): ReadPlan {
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const nonGrid = sorted.filter((t) => t.sheetType !== 'GRID');
  const overBudget: SheetTab[] = [];
  const allocated: TabPlan[] = [];

  let remaining = SHEETS_MAX_CELLS;
  for (const tab of sorted) {
    if (tab.sheetType !== 'GRID') continue;
    const cols = Math.min(tab.columnCount, SHEETS_MAX_COLUMNS_PER_TAB);
    if (cols <= 0 || tab.rowCount <= 0) {
      // An empty grid: nothing to request, rendered as an empty tab
      allocated.push({ tab, rows: 0, cols: 0 });
      continue;
    }
    const rows = Math.min(tab.rowCount, Math.floor(remaining / cols));
    if (rows <= 0) {
      overBudget.push(tab);
      continue;
    }
    allocated.push({ tab, rows, cols });
    remaining -= rows * cols;
  }

  const baseUrlLength = batchGetUrl(fileId, []).length;
  const rangeCost = (range: string) => new URLSearchParams({ ranges: range }).toString().length + 1;

  const batches: Chunk[][] = [];
  const plans: TabPlan[] = [];
  let batch: Chunk[] = [];
  let cells = 0;
  let urlLength = baseUrlLength;
  let full = false;

  for (const plan of allocated) {
    if (plan.rows === 0) {
      plans.push(plan);
      continue;
    }
    if (full) {
      overBudget.push(plan.tab);
      continue;
    }

    let r1 = 1;
    while (r1 <= plan.rows) {
      const fitRows = Math.floor((SHEETS_BATCH_MAX_CELLS - cells) / plan.cols);
      const take = Math.min(fitRows, plan.rows - r1 + 1);
      const range = take > 0 ? a1Range(plan.tab.title, r1, r1 + take - 1, plan.cols) : '';
      const fitsUrl = take > 0 && (batch.length === 0 || urlLength + rangeCost(range) <= SHEETS_MAX_URL_CHARS);

      if (!fitsUrl) {
        // Close this batch; open a new one unless that would pass the call cap
        batches.push(batch);
        batch = [];
        cells = 0;
        urlLength = baseUrlLength;
        if (batches.length >= SHEETS_MAX_VALUE_CALLS) {
          full = true;
          break;
        }
        continue;
      }

      batch.push({ plan, r1, r2: r1 + take - 1, range });
      cells += take * plan.cols;
      urlLength += rangeCost(range);
      r1 += take;
    }

    const packedRows = r1 - 1;
    if (packedRows === 0) {
      overBudget.push(plan.tab);
    } else {
      const packed = packedRows === plan.rows ? plan : { ...plan, rows: packedRows };
      // Chunks already made point at the original plan; keep them pointing at
      // the one that is rendered
      if (packed !== plan) {
        for (const b of [...batches, batch]) for (const c of b) if (c.plan === plan) c.plan = packed;
      }
      plans.push(packed);
    }
  }
  if (batch.length) batches.push(batch);

  return { plans, batches, overBudget, nonGrid };
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

interface TabResult {
  plan: TabPlan;
  rows: Array<string[] | undefined>;
  // Last row of the last chunk that arrived; chunks of a tab arrive in order
  arrivedThrough: number;
}

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

// D19: a Sheets API refusal that a keyed link's Drive export may get past
export function isKeyedFallbackError(err: unknown): boolean {
  if (!(err instanceof DriveApiError)) return false;
  if (err.status === 404) return true;
  return err.status === 403 && !RATE_LIMIT_REASONS.has(err.reason ?? '');
}

function requestInit(ctx: SheetsContext): RequestInit {
  return {
    signal: ctx.signal,
    ...(ctx.resourceKey ? { headers: { 'X-Goog-Drive-Resource-Keys': `${ctx.fileId}/${ctx.resourceKey}` } } : {}),
  };
}

export async function readSheet(ctx: SheetsContext): Promise<SheetRead> {
  try {
    return await readThroughSheetsApi(ctx);
  } catch (err) {
    if (!ctx.resourceKey || !isKeyedFallbackError(err)) throw err;
    log('info', 'sheets_keyed_fallback', { status: (err as DriveApiError).status });
    return readFirstTabExport(ctx);
  }
}

async function readThroughSheetsApi(ctx: SheetsContext): Promise<SheetRead> {
  const init = requestInit(ctx);
  let used = 0;

  // A Sheets call's body, streamed under the per-call and per-read byte caps
  const fetchJson = async (url: string): Promise<any> => {
    const cap = Math.min(SHEETS_MAX_BYTES_PER_CALL, SHEETS_MAX_BYTES_PER_READ - used);
    if (cap <= 0) throw new ResponseTooLargeError(0);
    const body: Buffer = await makeDriveRequest(url, ctx.accessToken, init, 'bytes', { maxBytes: cap });
    used += body.length;
    return JSON.parse(body.toString('utf8'));
  };

  let meta: any;
  try {
    meta = await fetchJson(`${SHEETS_API}/${encodeURIComponent(ctx.fileId)}?fields=${encodeURIComponent(TAB_FIELDS)}`);
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

  const plan = planRead(tabs, ctx.fileId);
  const results = new Map<TabPlan, TabResult>(
    plan.plans.map((p) => [p, { plan: p, rows: [], arrivedThrough: 0 }]),
  );

  for (const [i, batch] of plan.batches.entries()) {
    let data: any;
    try {
      data = await fetchJson(batchGetUrl(ctx.fileId, batch.map((c) => c.range)));
    } catch (err) {
      if (!(err instanceof ResponseTooLargeError)) throw err;
      if (i === 0) return { detailsOnly: sizeLimitReason() };
      // Dropped: tabs with earlier chunks keep them as a partial range, tabs
      // with none are listed as too large
      break;
    }
    const valueRanges: any[] = Array.isArray(data?.valueRanges) ? data.valueRanges : [];
    batch.forEach((chunk, j) => {
      const result = results.get(chunk.plan)!;
      const values: unknown[] = Array.isArray(valueRanges[j]?.values) ? valueRanges[j].values : [];
      values.slice(0, chunk.r2 - chunk.r1 + 1).forEach((row, k) => {
        result.rows[chunk.r1 - 1 + k] = Array.isArray(row) ? row.map((v) => (v == null ? '' : String(v))) : [];
      });
      result.arrivedThrough = chunk.r2;
    });
  }

  return { text: renderSheet(ctx, plan, [...results.values()]) };
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
function renderSheet(ctx: SheetsContext, plan: ReadPlan, results: TabResult[]): string {
  const contentBudget = MAX_TEXT_CHARS - TEXT_NOTES_RESERVE_CHARS;
  const sections: string[] = [];
  let used = 0;
  let cropNote = '';
  const tooLarge: string[] = [];
  const charCapped: string[] = [];
  let charCapHit = false;

  for (const result of results) {
    const { plan: tabPlan } = result;
    const { tab } = tabPlan;
    const arrivedAll = result.arrivedThrough >= tabPlan.rows;
    if (!arrivedAll && result.arrivedThrough === 0) {
      tooLarge.push(quoteName(tab.title));
      continue;
    }
    if (charCapHit) {
      charCapped.push(quoteName(tab.title));
      continue;
    }

    // Dense: rows Sheets trimmed inside a chunk become empty rows
    const rows = normalizeRows(Array.from({ length: result.arrivedThrough }, (_, i) => result.rows[i]));
    const lines = rows.map(csvRow);
    const csv = lines.join('\n');
    const fence = codeFence(csv);
    const heading = `# ${tab.title}${tab.hidden ? ' (hidden)' : ''}`;
    const tabLink = `${ctx.link}#gid=${tab.sheetId}`;

    const tabNotes: string[] = [];
    if (tabPlan.cols > 0 && (tabPlan.rows < tab.rowCount || tabPlan.cols < tab.columnCount)) {
      tabNotes.push(
        `Read rows 1–${tabPlan.rows} and columns A–${columnLetter(tabPlan.cols)} of a grid of ` +
        `${tab.rowCount} rows × ${tab.columnCount} columns. Cells outside that range aren't included ` +
        `(they may be empty). Open the sheet for the rest: ${tabLink}`,
      );
    }
    if (!arrivedAll) {
      tabNotes.push(`Partial: rows 1–${result.arrivedThrough} arrived before the size limit was reached.`);
    }

    const sep = sections.length ? '\n\n' : '';
    const notesText = tabNotes.length ? `\n\n${tabNotes.join('\n\n')}` : '';
    const build = (body: string) =>
      `${sep}${heading}\n\n${fence}csv\n${body}${body ? '\n' : ''}${fence}${notesText}`;
    const whole = build(csv);
    if (used + whole.length <= contentBudget) {
      sections.push(whole);
      used += whole.length;
      continue;
    }

    // Cut at a row boundary: the most rows whose section, range and partial
    // notes included (R7), still fits
    charCapHit = true;
    const shell = `${sep}${heading}\n\n${fence}csv\n${fence}${notesText}`.length;
    let room = contentBudget - used - shell;
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
    const cut = `${sep}${heading}\n\n${fence}csv\n${lines.slice(0, kept).join('\n')}\n${fence}${notesText}`;
    sections.push(cut);
    used += cut.length;
    cropNote =
      `Cropped: ${quoteName(tab.title)} shows rows 1–${kept} of what was read; the rest didn't fit in the ` +
      `${MAX_TEXT_CHARS}-character limit. Open the sheet for the rest: ${tabLink}`;
  }

  // Notes share the reserve; each gets a slice, name lists shorten to fit
  const pending: Array<(max: number) => string> = [];
  if (cropNote) pending.push((max) => sliceChars(cropNote, max));
  if (plan.nonGrid.length) {
    pending.push((max) => nameListNote(
      "Skipped tabs that aren't grids (no cells to read)",
      plan.nonGrid.map((t) => `${quoteName(t.title)} (${t.sheetType})`),
      '',
      max,
    ));
  }
  if (plan.overBudget.length) {
    pending.push((max) => nameListNote(
      `Not read, over the ${SHEETS_MAX_CELLS}-cell budget for one read`,
      plan.overBudget.map((t) => quoteName(t.title)),
      `Open the sheet to see them: ${ctx.link}`,
      max,
    ));
  }
  if (tooLarge.length) {
    pending.push((max) => nameListNote(
      'Not read, the response size limit was reached',
      tooLarge,
      `Open the sheet to see them: ${ctx.link}`,
      max,
    ));
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
async function readFirstTabExport(ctx: SheetsContext): Promise<SheetRead> {
  let bytes: Buffer;
  try {
    bytes = await makeDriveRequest(
      `/files/${encodeURIComponent(ctx.fileId)}/export?mimeType=${encodeURIComponent('text/csv')}`,
      ctx.accessToken,
      requestInit(ctx),
      'bytes',
    );
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 403 && err.reason === 'exportSizeLimitExceeded') {
      return { detailsOnly: "The export is over Google's 10 MB export limit." };
    }
    throw err;
  }

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
