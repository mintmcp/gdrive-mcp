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
import { EXTRACT_TIMEOUT_MS } from './pdfText.js';
import { readPdf } from './pdfRead.js';
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
 * Whatever the work still has in flight when the call settles (a label lookup
 * after a content error) is aborted with it
 */
async function withDeadline<T>(
  ms: number,
  message: string,
  work: (signal: AbortSignal, deadlineAt: number) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const deadlineAt = Date.now() + ms;
  const expire = () => {
    if (!controller.signal.aborted) controller.abort(new DeadlineError(message));
    return controller.signal.reason;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(expire()), ms);
  });
  try {
    const result = await Promise.race([work(controller.signal, deadlineAt), expired]);
    if (Date.now() >= deadlineAt) throw expire();
    return result;
  } catch (err) {
    // Once the deadline has passed, any outcome is the timeout
    if (controller.signal.aborted || Date.now() >= deadlineAt) throw expire();
    throw err;
  } finally {
    clearTimeout(timer);
    if (!controller.signal.aborted) controller.abort(new Error('The read ended'));
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
  return readerFor(driveMimeType)?.mimeType ?? null;
}

// D6: the readable types (READERS and classifyMime's text tables), not trashed
export function resourceListQuery(): string {
  const types = [
    ...Object.keys(READERS).map((m) => `mimeType = '${m}'`),
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
    async (signal, deadlineAt) => {
      // D11: labels exactly as get_file attaches them, in parallel with the read
      const [content, labelsMeta] = await Promise.all([
        readContent(uri, file, accessToken, signal, deadlineAt),
        fetchLabelsMeta(file.id, accessToken, { resourceKey: file.resourceKey, signal }),
      ]);
      return {
        contents: [content],
        ...(labelsMeta ? { _meta: labelsMeta } : {}),
      };
    },
  );
}

async function readContent(
  uri: string,
  file: DriveUri,
  accessToken: string,
  signal: AbortSignal,
  deadlineAt: number,
): Promise<Content> {
  const meta = await makeDriveRequest(
    `/files/${encodeURIComponent(file.id)}?fields=name,mimeType,size,webViewLink&supportsAllDrives=true`,
    accessToken,
    driveRequestInit(file, signal),
  );
  const name: string = meta?.name || 'Untitled';
  const mimeType: string = meta?.mimeType || '';
  const link: string = meta?.webViewLink || uri;
  const size = parseDriveSize(meta?.size);

  const reader = readerFor(mimeType);
  if (!reader) {
    throw new ResourceError(
      RESOURCE_NOT_FOUND,
      `'${sliceChars(name, 200)}' (${typeName(mimeType)}) can't be added as text. Open it directly: ${link}`,
      'unsupported_type',
    );
  }
  const read = await reader.read({ file, accessToken, signal, deadlineAt, name, link, size });
  if ('text' in read) return { uri, mimeType: reader.mimeType, text: read.text };
  return {
    uri,
    mimeType: 'text/markdown',
    text: detailsOnlyText({ name, mimeType, ...(size !== undefined ? { size } : {}), link, why: read.detailsOnly }),
  };
}

type FileRead = {
  file: DriveUri;
  accessToken: string;
  signal: AbortSignal;
  deadlineAt: number;
  name: string;
  link: string;
  size: number | undefined;
};

type Reader = { mimeType: string; read: (r: FileRead) => Promise<TextRead> };

// The Drive types a resource can be, what resources/read returns each as, and
// how. Text files are the one family outside the table (readerFor)
const READERS: Record<string, Reader> = {
  [FOLDER]: { mimeType: 'text/markdown', read: readFolder },
  [DOC]: { mimeType: 'text/markdown', read: (r) => readExport(r, 'text/markdown') },
  [SHEET]: { mimeType: 'text/markdown', read: (r) => readSheet(r) },
  [SLIDES]: { mimeType: 'text/plain', read: (r) => readExport(r, 'text/plain') },
  [PDF]: { mimeType: 'text/plain', read: readPdfFile },
};

function readerFor(driveMimeType: string): Reader | null {
  if (READERS[driveMimeType]) return READERS[driveMimeType];
  if (driveMimeType && classifyMime(driveMimeType) === 'text') return { mimeType: driveMimeType, read: readTextFile };
  return null;
}

const init = (r: FileRead): RequestInit => driveRequestInit(r.file, r.signal);

async function readExport(r: FileRead, exportMimeType: string): Promise<TextRead> {
  const bytes = await exportFile(r.file.id, exportMimeType, r.accessToken, init(r));
  if (!bytes) return { detailsOnly: EXPORT_LIMIT_MESSAGE };
  return { text: capText(stripBom(bytes.toString('utf8')), r.link) };
}

const OVER_FILE_LIMIT = `The file is over the ${MAX_FILE_SIZE / (1024 * 1024)} MB limit for reading.`;

// Bytes of a file stored as-is, or null when it's over MAX_FILE_SIZE
async function download(r: FileRead): Promise<Buffer | null> {
  if (r.size !== undefined && r.size > MAX_FILE_SIZE) return null;
  try {
    return await makeDriveRequest(
      `/files/${encodeURIComponent(r.file.id)}?alt=media&supportsAllDrives=true`,
      r.accessToken,
      init(r),
      { responseType: 'bytes', maxBytes: MAX_FILE_SIZE },
    );
  } catch (err) {
    if (err instanceof ResponseTooLargeError) return null;
    throw err;
  }
}

async function readTextFile(r: FileRead): Promise<TextRead> {
  const bytes = await download(r);
  if (!bytes) return { detailsOnly: OVER_FILE_LIMIT };
  return { text: capText(stripBom(bytes.toString('utf8')), r.link) };
}

/**
 * R9: the unchanged extractor, given the time left in the read. The deadline
 * race in withDeadline settles the read the moment the deadline passes; an
 * abandoned extraction runs on until the extractor's own timeout stops it, and
 * its result is discarded
 */
async function readPdfFile(r: FileRead): Promise<TextRead> {
  const bytes = await download(r);
  if (!bytes) return { detailsOnly: OVER_FILE_LIMIT };
  const timeoutMs = Math.max(0, Math.min(EXTRACT_TIMEOUT_MS, r.deadlineAt - Date.now()));
  const pdf = await readPdf(bytes, { timeoutMs, deadlineAt: r.deadlineAt });

  if (pdf.outcome === 'failed') {
    return { detailsOnly: `Text couldn't be extracted from this PDF because ${truncate(pdf.reason, 200)}.` };
  }
  if (pdf.outcome === 'scanned') {
    return {
      detailsOnly: `It's a scanned (image-only) PDF with ${pdf.pages} page(s) and no text layer, so there is no text to extract.`,
    };
  }
  const notes: string[] = [];
  if (pdf.pdf.textPages < pdf.pdf.pages) {
    notes.push(
      `Note: only ${pdf.pdf.textPages} of ${pdf.pdf.pages} page(s) carry a text layer; the rest appear to be scanned ` +
      `images and are not included. Full file: ${r.link}`,
    );
  }
  return { text: capText(pdf.pdf.text, r.link, { notes, truncated: pdf.pdf.truncated }) };
}

function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ');
}

async function readFolder(r: FileRead): Promise<TextRead> {
  const params = new URLSearchParams({
    q: `'${r.file.id}' in parents and trashed = false`,
    corpora: 'allDrives',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
    orderBy: 'folder,name',
    pageSize: String(FOLDER_LISTING_PAGE_SIZE),
    fields: 'nextPageToken,files(id,name,mimeType,webViewLink)',
  });
  const data = await makeDriveRequest(`/files?${params}`, r.accessToken, init(r));
  const children: any[] = Array.isArray(data?.files) ? data.files : [];

  const lines = [
    `# ${r.name}`,
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
    ? [`More items are in this folder than are listed here. Open the folder to see them all: ${r.link}`]
    : [];
  return { text: capText(lines.join('\n'), r.link, { notes: more }) };
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
