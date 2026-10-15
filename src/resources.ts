// MCP resources: Drive files and folders as resources, so clients such as
// Claude's Project "Context" picker can list them and add them as text.
// resources/list is a page of recent files; resources/read takes a Drive link
// (listed or pasted) and returns the file as text. Low-level SDK handlers, so
// cursors work and no listChanged is advertised; everything is per request

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ListResourcesResult,
  type ReadResourceResult,
  type Resource,
} from '@modelcontextprotocol/sdk/types.js';
import { getAccessToken, NOT_CONNECTED_MESSAGE } from './auth.js';
import {
  DriveApiError,
  EXPORT_LIMIT_MESSAGE,
  ResponseTooLargeError,
  describeDriveError,
  driveRequestInit,
  exportFile,
  makeDriveRequest,
} from './driveApi.js';
import { parseDriveUri, type DriveUri } from './driveUri.js';
import { fetchLabelsMeta } from './labels.js';
import { errorFields, log, truncate } from './log.js';
import { EXTRACT_TIMEOUT_MS, extractPdfText, type PdfText } from './pdfText.js';
import { TEXTUAL_APPLICATION_MIMES, classifyMime } from './mime.js';
import { capText, detailsOnlyText, sliceChars, stripBom, typeName, type TextRead } from './resourceText.js';
import { readSheet } from './sheets.js';
import {
  FOLDER_LISTING_PAGE_SIZE,
  MAX_FILE_SIZE,
  RESOURCE_LIST_DEADLINE_MS,
  RESOURCE_LIST_MAX_EXTRA_PAGES,
  RESOURCE_LIST_PAGE_SIZE,
  RESOURCE_READ_DEADLINE_MS,
} from './limits.js';

// MCP's "resource not found"
export const RESOURCE_NOT_FOUND = -32002;

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';
const SHEET = 'application/vnd.google-apps.spreadsheet';
const SLIDES = 'application/vnd.google-apps.presentation';
const PDF = 'application/pdf';

// An McpError we raise ourselves; `tag` is what the failure log line carries
class ResourceError extends McpError {
  tag: string;
  constructor(code: number, message: string, tag: string) {
    super(code, message);
    this.tag = tag;
  }
}

class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineError';
  }
}

/**
 * Runs `work` under one deadline. The signal it gets aborts when the deadline
 * passes, and the call settles at that moment with the timeout, whatever the
 * work is doing (a stalled request, a long PDF extraction). A late result is
 * discarded, also when synchronous work kept the timer from firing on time.
 * Work passed to `track` keeps the deadline after the call settles: it may
 * finish on its own, but is aborted if it outlives the deadline
 */
async function withDeadline<T>(
  ms: number,
  message: string,
  work: (signal: AbortSignal, deadlineAt: number, track: (pending: Promise<unknown>) => void) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + ms;
  const tracked: Promise<unknown>[] = [];
  const expire = () => {
    if (!controller.signal.aborted) controller.abort(new DeadlineError(message));
    return controller.signal.reason;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(expire()), ms);
  });
  try {
    const result = await Promise.race([work(controller.signal, deadlineAt, (p) => tracked.push(p)), expired]);
    if (Date.now() >= deadlineAt) throw expire();
    return result;
  } catch (err) {
    // Once the deadline has passed, any outcome is the timeout
    if (controller.signal.aborted || Date.now() >= deadlineAt) throw expire();
    throw err;
  } finally {
    if (tracked.length) void Promise.allSettled(tracked).then(() => clearTimeout(timer));
    else clearTimeout(timer);
  }
}

function requireAccessToken(): string {
  const accessToken = getAccessToken();
  if (!accessToken) throw new ResourceError(ErrorCode.InternalError, NOT_CONNECTED_MESSAGE, 'not_connected');
  return accessToken;
}

// §3.4: our own McpErrors pass through; Google errors keep describeDriveError's
// text, so a 401 still says to reconnect
function toMcpError(err: unknown): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof DeadlineError) return new McpError(ErrorCode.InternalError, err.message);
  const { error, hint } = describeDriveError(err);
  const message = [error, hint].filter(Boolean).join(' ');
  const code = err instanceof DriveApiError && err.status === 404 ? RESOURCE_NOT_FOUND : ErrorCode.InternalError;
  return new McpError(code, message);
}

// Only fields that can't hold user data: no URI, file id, name or token
function failureFields(err: unknown): { status?: number; reason?: string; code?: string } {
  if (err instanceof DeadlineError) return { code: 'deadline_exceeded' };
  if (err instanceof ResourceError) return { code: err.tag };
  const { error, status, reason, code } = errorFields(err);
  // A class other than the Error or Drive error we expect points at a bug
  const unexpected = error !== 'Error' && error !== 'DriveApiError' ? error : undefined;
  return { status, reason, code: code ?? unexpected };
}

async function logFailures<T>(event: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const mcpError = toMcpError(err);
    log('warn', event, failureFields(err));
    throw mcpError;
  }
}

// What resources/read returns for a Drive type, or null for types not listed
export function resourceMimeType(driveMimeType: string): string | null {
  if (driveMimeType === FOLDER || driveMimeType === DOC || driveMimeType === SHEET) return 'text/markdown';
  if (driveMimeType === SLIDES || driveMimeType === PDF) return 'text/plain';
  if (driveMimeType && classifyMime(driveMimeType) === 'text') return driveMimeType;
  return null;
}

// D6: folders, Docs, Sheets, Slides, PDFs and text files (classifyMime's text
// tables), not trashed
export function resourceListQuery(): string {
  const types = [
    ...[FOLDER, DOC, SHEET, SLIDES, PDF].map((m) => `mimeType = '${m}'`),
    `mimeType contains 'text/'`,
    ...[...TEXTUAL_APPLICATION_MIMES].map((m) => `mimeType = '${m}'`),
  ];
  return `trashed = false and (${types.join(' or ')})`;
}

const LIST_FIELDS = 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime,webViewLink)';

// D18: Drive's int64 string, kept only as a finite, non-negative safe integer
export function parseDriveSize(size: unknown): number | undefined {
  if (typeof size !== 'string' && typeof size !== 'number') return undefined;
  if (typeof size === 'string' && !/^\d+$/.test(size)) return undefined;
  const n = Number(size);
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}

function toResource(file: any): Resource | null {
  if (!file?.id || typeof file.webViewLink !== 'string' || !file.webViewLink) return null;
  const mimeType = resourceMimeType(file.mimeType ?? '');
  if (!mimeType) return null;
  const name = typeof file.name === 'string' && file.name ? file.name : 'Untitled';
  const driveSize = parseDriveSize(file.size);
  return {
    uri: file.webViewLink,
    name,
    title: name,
    mimeType,
    _meta: {
      driveFileId: file.id,
      driveMimeType: file.mimeType,
      ...(file.modifiedTime ? { modifiedTime: file.modifiedTime } : {}),
      ...(driveSize !== undefined ? { driveSize } : {}),
    },
  };
}

export async function listResources(cursor: string | undefined): Promise<ListResourcesResult> {
  const accessToken = requireAccessToken();
  return withDeadline(
    RESOURCE_LIST_DEADLINE_MS,
    `Listing Drive files timed out after ${RESOURCE_LIST_DEADLINE_MS / 1000} s`,
    async (signal) => {
      const resources: Resource[] = [];
      let pageToken = cursor;
      let incompleteSearch = false;

      // D17: a page with nothing usable but more to come advances, boundedly
      for (let page = 0; page <= RESOURCE_LIST_MAX_EXTRA_PAGES; page++) {
        const params = new URLSearchParams({
          q: resourceListQuery(),
          orderBy: 'modifiedTime desc',
          pageSize: String(RESOURCE_LIST_PAGE_SIZE),
          corpora: 'allDrives',
          supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true',
          fields: LIST_FIELDS,
        });
        if (pageToken) params.set('pageToken', pageToken);

        let data: any;
        try {
          data = await makeDriveRequest(`/files?${params}`, accessToken, { signal });
        } catch (err) {
          if (page === 0 && cursor && err instanceof DriveApiError && err.status === 400) {
            throw new ResourceError(ErrorCode.InvalidParams, 'Invalid cursor', 'invalid_cursor');
          }
          throw err;
        }

        if (data?.incompleteSearch === true) incompleteSearch = true;
        for (const file of Array.isArray(data?.files) ? data.files : []) {
          const resource = toResource(file);
          if (resource) resources.push(resource);
        }
        pageToken = typeof data?.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : undefined;
        if (resources.length || !pageToken) break;
      }

      if (incompleteSearch) log('warn', 'resource_list_incomplete');
      return {
        resources,
        ...(pageToken ? { nextCursor: pageToken } : {}),
        ...(incompleteSearch ? { _meta: { incompleteSearch: true } } : {}),
      };
    },
  );
}

type Content = ReadResourceResult['contents'][number];

export async function readResource(uri: string): Promise<ReadResourceResult> {
  const file = parseDriveUri(uri);
  if (!file) {
    throw new ResourceError(RESOURCE_NOT_FOUND, 'Not a Google Drive file link', 'not_drive_link');
  }
  const accessToken = requireAccessToken();

  return withDeadline(
    RESOURCE_READ_DEADLINE_MS,
    `Reading this file timed out after ${RESOURCE_READ_DEADLINE_MS / 1000} s`,
    async (signal, deadlineAt, track) => {
      // D11: labels exactly as get_file attaches them, in parallel with the read.
      // On a content error they finish on their own, still under the deadline
      const labels = fetchLabelsMeta(file.id, accessToken, {
        ...(file.resourceKey ? { resourceKey: file.resourceKey } : {}),
        signal,
      });
      if (labels) track(labels);
      const [content, labelsMeta] = await Promise.all([
        readContent(uri, file, accessToken, signal, deadlineAt),
        labels,
      ]);
      return {
        contents: [content],
        ...(labelsMeta ? { _meta: labelsMeta } : {}),
      };
    },
  );
}

const OVER_FILE_LIMIT = `The file is over the ${MAX_FILE_SIZE / (1024 * 1024)} MB limit for reading.`;

async function readContent(
  uri: string,
  file: DriveUri,
  accessToken: string,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<Content> {
  const init = driveRequestInit(file, signal);
  const meta = await makeDriveRequest(
    `/files/${encodeURIComponent(file.id)}?fields=id,name,mimeType,size,webViewLink,exportLinks&supportsAllDrives=true`,
    accessToken,
    init,
  );
  const name: string = meta?.name || 'Untitled';
  const mimeType: string = meta?.mimeType || '';
  const link: string = meta?.webViewLink || uri;
  const size = parseDriveSize(meta?.size);

  const read = await readByType({ file, accessToken, init, signal, deadlineAt, name, mimeType, link, size });
  if ('text' in read) return { uri, mimeType: read.mimeType ?? 'text/markdown', text: read.text };
  return {
    uri,
    mimeType: 'text/markdown',
    text: detailsOnlyText({ name, mimeType, ...(size !== undefined ? { size } : {}), link, why: read.detailsOnly }),
  };
}

type FileRead = {
  file: DriveUri;
  accessToken: string;
  init: RequestInit;
  signal: AbortSignal;
  deadlineAt: number;
  name: string;
  mimeType: string;
  link: string;
  size: number | undefined;
};

async function readByType(r: FileRead): Promise<TextRead> {
  const exported = async (exportMimeType: string): Promise<string | null> => {
    const bytes = await exportFile(r.file.id, exportMimeType, r.accessToken, r.init);
    return bytes && stripBom(bytes.toString('utf8'));
  };

  // Bytes of a file stored as-is, or null when it's over MAX_FILE_SIZE
  const download = async (): Promise<Buffer | null> => {
    if (r.size !== undefined && r.size > MAX_FILE_SIZE) return null;
    try {
      return await makeDriveRequest(
        `/files/${encodeURIComponent(r.file.id)}?alt=media&supportsAllDrives=true`,
        r.accessToken,
        r.init,
        { responseType: 'bytes', maxBytes: MAX_FILE_SIZE },
      );
    } catch (err) {
      if (err instanceof ResponseTooLargeError) return null;
      throw err;
    }
  };

  if (r.mimeType === DOC) {
    const body = await exported('text/markdown');
    return body === null ? { detailsOnly: EXPORT_LIMIT_MESSAGE } : { text: capText(body, r.link) };
  }

  if (r.mimeType === SLIDES) {
    const body = await exported('text/plain');
    return body === null ? { detailsOnly: EXPORT_LIMIT_MESSAGE } : { text: capText(body, r.link), mimeType: 'text/plain' };
  }

  if (r.mimeType === SHEET) {
    return readSheet({
      fileId: r.file.id,
      accessToken: r.accessToken,
      ...(r.file.resourceKey ? { resourceKey: r.file.resourceKey } : {}),
      signal: r.signal,
      name: r.name,
      link: r.link,
    });
  }

  if (r.mimeType === FOLDER) {
    return { text: await folderListing(r.file, r.accessToken, r.init, r.name, r.link) };
  }

  const kind = classifyMime(r.mimeType);

  if (kind === 'pdf') {
    const bytes = await download();
    if (!bytes) return { detailsOnly: OVER_FILE_LIMIT };
    return readPdf(bytes, r.signal, r.deadlineAt, r.link);
  }

  if (kind === 'text') {
    const bytes = await download();
    if (!bytes) return { detailsOnly: OVER_FILE_LIMIT };
    return { text: capText(stripBom(bytes.toString('utf8')), r.link), mimeType: r.mimeType };
  }

  throw new ResourceError(
    RESOURCE_NOT_FOUND,
    `'${sliceChars(r.name, 200)}' (${typeName(r.mimeType)}) can't be added as text. Open it directly: ${r.link}`,
    'unsupported_type',
  );
}

/**
 * R9: the unchanged extractor, given the time left in the read. The deadline
 * race in withDeadline settles the read the moment the deadline passes; an
 * abandoned extraction runs on until the extractor's own timeout stops it, and
 * its result is discarded
 */
async function readPdf(bytes: Buffer, signal: AbortSignal, deadlineAt: number, link: string): Promise<TextRead> {
  const timeoutMs = Math.max(0, Math.min(EXTRACT_TIMEOUT_MS, deadlineAt - Date.now()));
  const byteLength = bytes.byteLength;
  let pdf: PdfText | undefined;
  let failure: string | undefined;
  const startedAt = Date.now();
  try {
    // The parser can detach the buffer it gets: hand it a view only when the
    // Buffer owns its whole ArrayBuffer (never a slice of Node's shared pool)
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const data = owned ? new Uint8Array(bytes.buffer, 0, bytes.byteLength) : new Uint8Array(bytes);
    pdf = await extractPdfText(data, { timeoutMs });
  } catch (err: any) {
    // Precedence: past the deadline, the outcome is the timeout (withDeadline
    // turns this throw into it, even before its timer has fired)
    signal.throwIfAborted();
    if (Date.now() >= deadlineAt) throw err;
    failure = err?.message || 'the PDF could not be parsed';
    log('error', 'pdf_extraction_failed', {
      ...errorFields(err),
      bytes: byteLength,
      elapsedMs: Date.now() - startedAt,
    });
  }
  signal.throwIfAborted();

  if (!pdf) {
    return { detailsOnly: `Text couldn't be extracted from this PDF because ${truncate(failure ?? '', 200)}.` };
  }
  if (pdf.scanned) {
    return {
      detailsOnly: `It's a scanned (image-only) PDF with ${pdf.pages} page(s) and no text layer, so there is no text to extract.`,
    };
  }
  const notes: string[] = [];
  if (pdf.textPages < pdf.pages) {
    notes.push(
      `Note: only ${pdf.textPages} of ${pdf.pages} page(s) carry a text layer; the rest appear to be scanned ` +
      `images and are not included. Full file: ${link}`,
    );
  }
  return { text: capText(pdf.text, link, { notes, truncated: pdf.truncated }), mimeType: 'text/plain' };
}

function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ');
}

async function folderListing(
  folder: DriveUri,
  accessToken: string,
  init: RequestInit,
  name: string,
  link: string,
): Promise<string> {
  const params = new URLSearchParams({
    q: `'${folder.id}' in parents and trashed = false`,
    corpora: 'allDrives',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    orderBy: 'folder,name',
    pageSize: String(FOLDER_LISTING_PAGE_SIZE),
    fields: 'nextPageToken,files(id,name,mimeType,webViewLink)',
  });
  const data = await makeDriveRequest(`/files?${params}`, accessToken, init);
  const children: any[] = Array.isArray(data?.files) ? data.files : [];

  const lines = [
    `# ${name}`,
    '',
    'Folder listing: direct children only, their contents are not included.',
    '',
    ...children.map((child) => {
      const childName = escapeLinkText(typeof child?.name === 'string' && child.name ? child.name : 'Untitled');
      const type = typeName(child?.mimeType ?? '');
      return child?.webViewLink ? `- [${childName}](${child.webViewLink}) — ${type}` : `- ${childName} — ${type}`;
    }),
  ];
  if (!children.length) lines.push('This folder is empty.');
  const more = data?.nextPageToken
    ? [`More items are in this folder than are listed here. Open the folder to see them all: ${link}`]
    : [];
  return capText(lines.join('\n'), link, { notes: more });
}

export function registerResources(server: McpServer): void {
  server.server.registerCapabilities({ resources: {} });
  server.server.setRequestHandler(ListResourcesRequestSchema, (request) =>
    logFailures('resource_list_error', () => listResources(request.params?.cursor)),
  );
  server.server.setRequestHandler(ReadResourceRequestSchema, (request) =>
    logFailures('resource_read_error', () => readResource(request.params.uri)),
  );
  // Nothing to template: the handler is there so a client that asks gets an
  // empty list, not an error
  server.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: [] }));
}
