/**
 * Plain-text extraction for Office packages (OOXML and OpenDocument) without
 * a document model: the markup is walked once and only paragraphs, runs,
 * breaks and table cells are interpreted.
 */

import { unzipSync, strFromU8 } from 'fflate';
import { MAX_TEXT_CHARS } from './pdfText.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const ODT = 'application/vnd.oasis.opendocument.text';
const ODS = 'application/vnd.oasis.opendocument.spreadsheet';
const ODP = 'application/vnd.oasis.opendocument.presentation';

export const OFFICE_MIME_TYPES: ReadonlySet<string> = new Set([DOCX, XLSX, PPTX, ODT, ODS, ODP]);

export function isOfficeMime(mimeType: string): boolean {
  return OFFICE_MIME_TYPES.has(mimeType);
}

export interface OfficeText {
  text: string;
  truncated: boolean;
}

// Inflated markup past this is a zip bomb, not a document: the text cap
// would never be reached by a real file this size
const MAX_INFLATED_BYTES = 256 * 1024 * 1024;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, body: string) => {
    if (body[0] !== '#') return ENTITIES[body] ?? whole;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function formatRow(cells: string[], style: 'table' | 'csv'): string {
  if (style === 'table') return `| ${cells.join(' | ')} |`;
  let end = cells.length;
  while (end > 0 && !cells[end - 1]) end--;
  return cells.slice(0, end).map(csvCell).join(',');
}

// Which tags carry structure in a given markup dialect. `text` names the tags
// that hold runs; when absent, every text node inside a paragraph counts
interface Markup {
  paragraph: string[];
  text?: string[];
  breaks: Record<string, string>;
  row?: string;
  cell?: string[];
  cellRepeat?: string;
  rowRepeat?: string;
  rows: 'table' | 'csv';
  section?: { tag: string; attr: string };
}

// Excel's own column limit (XFD). Repeated or far-flung cells past it pad a
// sheet to its edge rather than carry data, so a row never grows wider
const MAX_ROW_CELLS = 16384;
// Rows repeated beyond this are empty filler in practice
const MAX_ROW_REPEAT = 1000;

const WORD: Markup = {
  paragraph: ['w:p'],
  text: ['w:t'],
  breaks: { 'w:tab': '\t', 'w:br': '\n', 'w:cr': '\n' },
  row: 'w:tr',
  cell: ['w:tc'],
  rows: 'table',
};

const DRAWING: Markup = {
  paragraph: ['a:p'],
  text: ['a:t'],
  breaks: { 'a:br': '\n' },
  row: 'a:tr',
  cell: ['a:tc'],
  rows: 'table',
};

const OPENDOCUMENT: Markup = {
  paragraph: ['text:p', 'text:h'],
  breaks: { 'text:tab': '\t', 'text:line-break': '\n', 'text:s': ' ' },
  row: 'table:table-row',
  cell: ['table:table-cell', 'table:covered-table-cell'],
  rows: 'table',
};

// Sheets are the only OpenDocument tables worth naming
const OPENDOCUMENT_SHEETS: Markup = {
  ...OPENDOCUMENT,
  cellRepeat: 'table:number-columns-repeated',
  rowRepeat: 'table:number-rows-repeated',
  rows: 'csv',
  section: { tag: 'table:table', attr: 'table:name' },
};

// Accumulates emitted lines against a character budget shared across parts
class Lines {
  readonly lines: string[] = [];
  truncated = false;
  private chars = 0;

  constructor(private readonly maxChars: number) {}

  push(line: string): boolean {
    if (this.truncated) return false;
    const room = this.maxChars - this.chars;
    if (line.length > room) {
      if (room > 0) this.lines.push(line.slice(0, room));
      this.truncated = true;
      return false;
    }
    this.lines.push(line);
    this.chars += line.length + 1;
    return true;
  }

  text(): string {
    return this.lines.join('\n');
  }
}

const TOKEN = /<[?!][^>]*>|<\/?([\w:.-]+)[^>]*?(\/?)>|([^<]+)/g;

function attribute(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeEntities(m[1]) : undefined;
}

function repeatCount(tag: string, attr: string | undefined, max: number): number {
  const n = attr ? Number(attribute(tag, attr)) : 1;
  return Math.min(n >= 1 ? n : 1, max);
}

function walkMarkup(xml: string, spec: Markup, out: Lines): void {
  const paragraphs = new Set(spec.paragraph);
  const textTags = spec.text && new Set(spec.text);
  const cells = new Set(spec.cell);
  let paragraphDepth = 0;
  let textDepth = 0;
  let cellDepth = 0;
  let cellRepeat = 1;
  let rowRepeat = 1;
  let run: string[] = [];
  let cell: string[] = [];
  let row: string[] = [];

  const flushParagraph = (): boolean => {
    const text = run.join('').trim();
    run = [];
    if (cellDepth > 0) {
      if (text) cell.push(text);
      return true;
    }
    return text ? out.push(text) : true;
  };

  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(xml); m; m = TOKEN.exec(xml)) {
    const [token, name, selfClosing, text] = m;
    if (text !== undefined) {
      if (paragraphDepth > 0 && (!textTags || textDepth > 0)) run.push(decodeEntities(text));
      continue;
    }
    if (!name) continue;
    const closing = token[1] === '/';

    if (name in spec.breaks) {
      if (paragraphDepth > 0) run.push(spec.breaks[name]);
    } else if (paragraphs.has(name)) {
      if (closing) paragraphDepth = Math.max(0, paragraphDepth - 1);
      else if (!selfClosing) paragraphDepth++;
      if ((closing || selfClosing) && !flushParagraph()) return;
    } else if (textTags?.has(name)) {
      if (!selfClosing) textDepth += closing ? -1 : 1;
    } else if (cells.has(name)) {
      if (!closing) {
        cellRepeat = repeatCount(token, spec.cellRepeat, MAX_ROW_CELLS);
        if (!selfClosing) cellDepth++;
      } else {
        cellDepth = Math.max(0, cellDepth - 1);
      }
      if (closing || selfClosing) {
        for (let i = 0; i < cellRepeat && row.length < MAX_ROW_CELLS; i++) row.push(cell.join(' '));
        cell = [];
      }
    } else if (name === spec.row) {
      if (!closing) rowRepeat = repeatCount(token, spec.rowRepeat, MAX_ROW_REPEAT);
      if (closing || selfClosing) {
        if (row.some((c) => c)) {
          const line = formatRow(row, spec.rows);
          for (let i = 0; i < rowRepeat; i++) if (!out.push(line)) return;
        }
        row = [];
      }
    } else if (spec.section && name === spec.section.tag && !closing) {
      const title = attribute(token, spec.section.attr);
      if (title && !out.push(`# ${title}`)) return;
    }
  }
}

function columnIndex(ref: string): number {
  let index = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

// Rich text is a list of runs; only their text matters here
function runsText(xml: string): string {
  return [...xml.matchAll(/<t\b[^>]*>([^<]*)<\/t>/g)].map((t) => decodeEntities(t[1])).join('');
}

function sharedStrings(xml: string | undefined): string[] {
  return [...(xml ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => runsText(m[1]));
}

function cellValue(attrs: string, body: string, strings: string[]): string {
  const type = attribute(attrs, 't') ?? 'n';
  if (type === 'inlineStr') return runsText(body);
  const v = /<v>([^<]*)<\/v>/.exec(body);
  if (!v) return '';
  const raw = decodeEntities(v[1]);
  if (type === 's') return strings[Number(raw)] ?? '';
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

function walkSheet(xml: string, strings: string[], out: Lines): void {
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attribute(c[1], 'r') ?? '';
      const index = columnIndex(ref);
      const value = cellValue(c[1], c[2] ?? '', strings);
      if (index >= 0 && index < MAX_ROW_CELLS) {
        while (cells.length < index) cells.push('');
        cells[index] = value;
      } else if (cells.length < MAX_ROW_CELLS) {
        cells.push(value);
      }
    }
    if (cells.some((c) => c) && !out.push(formatRow(cells, 'csv'))) return;
  }
}

// OOXML lists its sheets and slides in a workbook or presentation part, each
// entry pointing at its content part through the rels file. That list is the
// user-visible order; the parts' own numbering is only a fallback for a
// package missing it
function listedParts(
  parts: Record<string, string>,
  list: { part: string; tag: string; rels: string; base: string },
  fallback: RegExp,
): Array<{ name?: string; part: string }> {
  const rels = new Map<string, string>();
  for (const r of (parts[list.rels] ?? '').matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attribute(r[0], 'Id');
    const target = attribute(r[0], 'Target');
    if (id && target) rels.set(id, target.startsWith('/') ? target.slice(1) : list.base + target);
  }
  const listed: Array<{ name?: string; part: string }> = [];
  for (const entry of (parts[list.part] ?? '').matchAll(new RegExp(`<${list.tag}\\b[^>]*>`, 'g'))) {
    const part = rels.get(attribute(entry[0], 'r:id') ?? '');
    if (part && parts[part] !== undefined) listed.push({ name: attribute(entry[0], 'name'), part });
  }
  return listed.length > 0 ? listed : numberedParts(parts, fallback).map((part) => ({ part }));
}

function numberedParts(parts: Record<string, string>, pattern: RegExp): string[] {
  return Object.keys(parts)
    .map((name) => ({ name, n: Number(pattern.exec(name)?.[1]) }))
    .filter((p) => Number.isFinite(p.n))
    .sort((a, b) => a.n - b.n)
    .map((p) => p.name);
}

function openPackage(bytes: Uint8Array, wanted: RegExp): Record<string, string> {
  let inflated = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (f) => {
        if (!wanted.test(f.name)) return false;
        inflated += f.originalSize;
        if (inflated > MAX_INFLATED_BYTES) throw new RangeError('too large');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof RangeError) throw new Error('the package inflates past the size this tool can read');
    throw new Error('the file is not a valid Office package');
  }
  return Object.fromEntries(Object.entries(entries).map(([name, data]) => [name, strFromU8(data)]));
}

function requirePart(parts: Record<string, string>, name: string): string {
  const part = parts[name];
  if (part === undefined) throw new Error(`the package has no ${name} part`);
  return part;
}

/** Throws when the bytes are not a package of the given type. */
export function extractOfficeText(bytes: Uint8Array, mimeType: string, maxChars = MAX_TEXT_CHARS): OfficeText {
  const out = new Lines(maxChars);
  switch (mimeType) {
    case DOCX: {
      const parts = openPackage(bytes, /^word\/(document|footnotes|endnotes)\.xml$/);
      walkMarkup(requirePart(parts, 'word/document.xml'), WORD, out);
      for (const notes of ['word/footnotes.xml', 'word/endnotes.xml']) {
        if (parts[notes] !== undefined) walkMarkup(parts[notes], WORD, out);
      }
      break;
    }
    case PPTX: {
      const parts = openPackage(bytes, /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/[^/]+\.xml)$/);
      const slides = listedParts(
        parts,
        { part: 'ppt/presentation.xml', tag: 'p:sldId', rels: 'ppt/_rels/presentation.xml.rels', base: 'ppt/' },
        /^ppt\/slides\/slide(\d+)\.xml$/,
      );
      if (slides.length === 0) throw new Error('the package has no ppt/slides/slideN.xml part');
      slides.forEach((slide, i) => {
        if (out.push(`# Slide ${i + 1}`)) walkMarkup(parts[slide.part], DRAWING, out);
      });
      break;
    }
    case XLSX: {
      const parts = openPackage(bytes, /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/);
      const sheets = listedParts(
        parts,
        { part: 'xl/workbook.xml', tag: 'sheet', rels: 'xl/_rels/workbook.xml.rels', base: 'xl/' },
        /^xl\/worksheets\/sheet(\d+)\.xml$/,
      );
      if (sheets.length === 0) throw new Error('the package has no xl/worksheets/sheetN.xml part');
      const strings = sharedStrings(parts['xl/sharedStrings.xml']);
      sheets.forEach((sheet, i) => {
        if (out.push(`# ${sheet.name ?? `Sheet${i + 1}`}`)) walkSheet(parts[sheet.part], strings, out);
      });
      break;
    }
    case ODT:
    case ODP:
    case ODS: {
      const parts = openPackage(bytes, /^content\.xml$/);
      walkMarkup(requirePart(parts, 'content.xml'), mimeType === ODS ? OPENDOCUMENT_SHEETS : OPENDOCUMENT, out);
      break;
    }
    default:
      throw new Error(`'${mimeType}' is not an Office document type`);
  }
  return { text: out.text(), truncated: out.truncated };
}
