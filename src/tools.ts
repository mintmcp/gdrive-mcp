/**
 * Google Drive MCP Tools
 */

import { z } from 'zod';
import { withGoogleAuth as requirePermissionSecure } from "./auth.js";
import { extractPdfText, MAX_TEXT_CHARS, type PdfText } from './pdfText.js';

const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

// MIME categorisation for get_file. We derive these from the *actual* metadata
// mimeType, not from caller-supplied input, so the tool can't be lied into
// returning garbled output.
const TEXTUAL_APPLICATION_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/yaml',
  'application/x-yaml',
]);
export function classifyMime(mimeType: string): 'text' | 'image' | 'pdf' | 'native-doc' | 'unsupported' {
  if (!mimeType) return 'unsupported';
  if (mimeType.startsWith('application/vnd.google-apps.')) return 'native-doc';
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('text/')) return 'text';
  if (TEXTUAL_APPLICATION_MIMES.has(mimeType)) return 'text';
  return 'unsupported';
}

const GOOGLE_NATIVE_SERVERS: Record<string, string> = {
  'application/vnd.google-apps.document': 'Google Docs',
  'application/vnd.google-apps.spreadsheet': 'Google Sheets',
  'application/vnd.google-apps.presentation': 'Google Slides',
};

// Readable elsewhere, so route rather than give the generic wrong-type message.
const OFFICE_ROUTES: Record<string, string> = {
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    'This is an Excel spreadsheet — use the Google Sheets MCP server to read it.',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'This is a Word document — use the Google Docs MCP server to read it.',
  'application/vnd.ms-excel':
    'This is a legacy Excel (.xls) file, which cannot be read directly. Open it and use File → Save as Google Sheets first.',
  'application/msword':
    'This is a legacy Word (.doc) file — use the Google Docs MCP server to read it.',
};

/**
 * Message for a file get_file cannot read. Office and Google-native files are
 * readable by a sibling connector, so they get a pointer to the right server
 * instead of the generic "wrong file type" advice.
 */
export function unsupportedMessage(name: string, mimeType: string, webViewLink: string): string {
  const office = OFFICE_ROUTES[mimeType];
  if (office) return `'${name}': ${office} Open it directly: ${webViewLink}`;

  const service = GOOGLE_NATIVE_SERVERS[mimeType];
  if (service) {
    return `'${name}' is a ${service} file, which this connector cannot read. Use the ${service} MCP server to read its contents, or open it directly: ${webViewLink}`;
  }
  if (mimeType.startsWith('application/vnd.google-apps.')) {
    return `'${name}' is a Google Drive-native file ('${mimeType}') with no downloadable contents. Open it directly: ${webViewLink}`;
  }
  return `File '${name}' has unsupported mimeType '${mimeType}'. This tool supports text, image and PDF files. Open it directly: ${webViewLink}`;
}

/**
 * Escape a string for safe interpolation inside Google Drive `q` single-quoted
 * literals. Backslashes are doubled, then internal apostrophes are
 * backslash-escaped. Used by search_files when stitching a caller-supplied
 * `mime_type` into the query.
 */
export function escapeDriveQValue(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Trivial self-move guard for move_file. The Drive API will eventually reject
 * cycles, but catching the obvious "move X into X" case up front gives a
 * cleaner error message and saves a round-trip.
 */
export function isSelfMove(fileId: string | undefined, newParentId: string | undefined): boolean {
  return !!fileId && !!newParentId && fileId === newParentId;
}

/**
 * Validate a Google Workspace domain string for share_file. Trims whitespace,
 * rejects empty/non-string/whitespace-only, and runs the same hostname-shape
 * regex used by the share_file handler. Returns a discriminated result so
 * callers can produce structured error envelopes.
 */
export function validateWorkspaceDomain(
  input: unknown,
): { ok: true; domain: string } | { ok: false; error: string } {
  if (typeof input !== 'string') {
    return { ok: false, error: 'domain is required when type="domain" and must not be empty or whitespace.' };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { ok: false, error: 'domain is required when type="domain" and must not be empty or whitespace.' };
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(trimmed)) {
    return { ok: false, error: `domain "${trimmed}" does not look like a valid Workspace domain (expected e.g. "example.com").` };
  }
  return { ok: true, domain: trimmed };
}

/**
 * Build the PATCH body for update_file from the optional metadata fields.
 * Returns a discriminated result so the handler can reject a no-op update
 * before the round-trip — Drive accepts an empty PATCH, but an update with
 * nothing to change is almost always a caller mistake. The zod schema already
 * enforces the field types; the real work here is the "at least one field"
 * guard, which zod can't express across independent optionals.
 */
export function buildFileUpdate(args: {
  new_name?: unknown;
  description?: unknown;
  starred?: unknown;
}): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const body: Record<string, unknown> = {};

  if (args.new_name !== undefined) {
    if (typeof args.new_name !== 'string' || args.new_name.trim().length === 0) {
      return { ok: false, error: 'new_name must be a non-empty string when provided.' };
    }
    body.name = args.new_name;
  }
  if (args.description !== undefined) {
    if (typeof args.description !== 'string') {
      return { ok: false, error: 'description must be a string when provided.' };
    }
    body.description = args.description;
  }
  if (args.starred !== undefined) {
    if (typeof args.starred !== 'boolean') {
      return { ok: false, error: 'starred must be a boolean when provided.' };
    }
    body.starred = args.starred;
  }

  if (Object.keys(body).length === 0) {
    return { ok: false, error: 'Provide at least one field to update: new_name, description, or starred.' };
  }
  return { ok: true, body };
}

// Retry tuning for transient Drive errors (429 / 5xx).
const MAX_RETRY_ATTEMPTS = 3;          // total attempts including the first
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4000;
const MAX_RETRY_AFTER_MS = 30_000;     // cap server-supplied Retry-After

// Bound get_file_permissions pagination by page COUNT, not just token presence,
// so a buggy/repeating nextPageToken from Drive can't spin forever.
const MAX_PERMISSION_PAGES = 10;

/**
 * Typed error thrown by makeDriveRequest. Carries the HTTP status so
 * handlers can produce status-specific hints to the LLM.
 */
export class DriveApiError extends Error {
  status: number;
  reason?: string;
  retryAfterMs?: number;
  constructor(message: string, status: number, reason?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'DriveApiError';
    this.status = status;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Convert a thrown error into the structured MCP tool error envelope.
 * Adds status-specific hints so the LLM can self-correct.
 */
export function formatDriveError(err: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: any; isError: true } {
  let status: number | undefined;
  let reason: string | undefined;
  let message: string;

  if (err instanceof DriveApiError) {
    status = err.status;
    reason = err.reason;
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }

  let hint: string | undefined;
  switch (status) {
    case 401:
      hint = 'Authentication failed. The Google access token is invalid or expired; the user may need to reconnect their Google account.';
      break;
    case 403:
      hint = reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
        ? 'Rate limited by Google. Retried already — back off and try again later.'
        : 'Permission denied. The user may not have access to this file, the file may be in a shared drive without permission, or the required Drive scope was not granted.';
      break;
    case 404:
      hint = 'File or folder not found. The id may be wrong, the item may be in the trash, or the user may not have permission to see it.';
      break;
    case 429:
      hint = 'Rate limited by Google. Retried already with Retry-After backoff — try again after a short pause.';
      break;
    case 503:
    case 502:
    case 504:
      hint = 'Drive is temporarily unavailable. Retried already — try again shortly.';
      break;
  }

  const payload: any = { error: message };
  if (status !== undefined) payload.status = status;
  if (reason) payload.reason = reason;
  if (hint) payload.hint = hint;

  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true,
  };
}

export function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  // Numeric seconds form.
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(asNumber * 1000, MAX_RETRY_AFTER_MS);
  }
  // HTTP-date form.
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, Math.min(asDate - Date.now(), MAX_RETRY_AFTER_MS));
  }
  return undefined;
}

export function backoffDelayMs(attempt: number): number {
  // attempt is 1-based. exp backoff with ±25% jitter.
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.max(0, Math.round(base + jitter));
}

const RETRY_SAFE_METHODS = new Set(['GET', 'HEAD']);

export function isRetryable(status: number, method: string): boolean {
  if (status === 429) return true; // safe to retry — request was rejected, not processed
  if (status >= 500 && status <= 599) {
    // Only retry idempotent methods on 5xx — writes may have partially succeeded.
    return RETRY_SAFE_METHODS.has(method.toUpperCase());
  }
  return false;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Helper to make authenticated requests to Google Drive API.
 * Throws DriveApiError on non-2xx; retries 429 and (for safe methods) 5xx
 * with bounded exponential backoff that honours Retry-After.
 */
async function makeDriveRequest(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {}
): Promise<any> {
  const url = endpoint.startsWith('http') ? endpoint : `${GOOGLE_DRIVE_API}${endpoint}`;
  const method = (options.method || 'GET').toUpperCase();

  let lastError: DriveApiError | undefined;
  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    const response = await fetch(url, {
      ...options,
      method,
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/json',
        ...options.headers,
      },
    });

    if (response.ok) {
      // No-content responses (e.g. some DELETE/PATCH) — return null.
      if (response.status === 204) return null;
      const text = await response.text();
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        // Non-JSON body on a 2xx — return the raw text.
        return text;
      }
    }

    const errorText = await response.text();
    let errorMessage = `Google Drive API error (${response.status})`;
    let reason: string | undefined;

    try {
      const errorJson = JSON.parse(errorText);
      const apiError = errorJson.error;
      if (apiError) {
        const firstErr = apiError.errors?.[0];
        reason = firstErr?.reason;
        const details = apiError.errors?.map((e: any) =>
          [e.message, e.reason, e.location].filter(Boolean).join(' - ')
        ).join('; ');
        errorMessage = `${apiError.message}${details ? `: ${details}` : ''} (${response.status})`;
      }
    } catch {
      if (errorText) errorMessage = `${errorText} (${response.status})`;
    }

    const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
    lastError = new DriveApiError(errorMessage, response.status, reason, retryAfterMs);

    if (attempt < MAX_RETRY_ATTEMPTS && isRetryable(response.status, method)) {
      const delay = retryAfterMs ?? backoffDelayMs(attempt);
      await sleep(delay);
      continue;
    }
    throw lastError;
  }

  // Unreachable — loop either returns or throws — but TS needs a fallback.
  throw lastError ?? new DriveApiError('Google Drive request failed', 0);
}

// Reusable output schema fragments — tolerant (all leaves optional, passthrough outer)
const driveFileSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  mimeType: z.string().optional(),
  size: z.number().optional(),
  createdTime: z.string().optional(),
  modifiedTime: z.string().optional(),
  parents: z.array(z.string()).optional(),
  webViewLink: z.string().optional(),
  owner: z.string().optional(),
  isFolder: z.boolean().optional(),
  trashed: z.boolean().optional(),
}).passthrough();

/**
 * Shared normaliser for a raw Drive file resource into the 11 base fields.
 * Extracted so the mapping is unit-testable in isolation and not duplicated
 * across search_files, list_recent_files and get_file_metadata.
 */
// Kept in lockstep with formatDriveFile: this mask must request exactly the
// fields formatDriveFile reads. search_files and list_recent_files share it so
// adding a field is a one-place change.
const DRIVE_FILE_LIST_FIELDS =
  'nextPageToken,incompleteSearch,files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,owners,trashed)';

export function formatDriveFile(file: any) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size ? parseInt(file.size) : undefined,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    parents: file.parents,
    webViewLink: file.webViewLink,
    owner: file.owners?.[0]?.emailAddress,
    isFolder: file.mimeType === 'application/vnd.google-apps.folder',
    trashed: file.trashed === true,
  };
}

// Permission entries returned by get_file_permissions. Tolerant like
// driveFileSchema — Drive omits fields that don't apply to a permission's type
// (e.g. no emailAddress on a "domain" or "anyone" permission).
const permissionSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  role: z.string().optional(),
  emailAddress: z.string().optional(),
  domain: z.string().optional(),
  displayName: z.string().optional(),
  deleted: z.boolean().optional(),
  expirationTime: z.string().optional(),
}).passthrough();

/**
 * Google Drive Tools class following the same pattern as GoogleCalendarTools
 */
export class GoogleDriveTools {
  static getTools() {
    return {
      search_files: {
        description: `Search Google Drive for files and folders. Use this when the user asks to find/locate/list items, or before get_file when only a file name is known. By default searches across My Drive AND every shared drive the user can access (corpora=allDrives). Returns up to page_size items (default 20, max 100) plus a nextPageToken for further pages.`,
        readOnlyHint: true,
        outputSchema: {
          files: z.array(driveFileSchema),
          nextPageToken: z.string().nullable(),
          incompleteSearch: z.boolean().optional(),
        },
        schema: {
          query: z.string().describe(`Drive API 'q' expression. Examples:
- name contains 'budget' and trashed = false
- 'user@example.com' in owners and trashed = false
- mimeType = 'application/pdf' and trashed = false
- 'FOLDER_ID' in parents and trashed = false
- starred = true and trashed = false
- sharedWithMe and trashed = false
Operators: name, mimeType, modifiedTime, createdTime, owners, writers, readers, starred, trashed, sharedWithMe, parents.
Comparisons: contains, =, !=, <, >, <=, >=. Combine with: and, or, not.
String literals use single quotes; escape internal apostrophes as \\' (e.g. name contains 'O\\\\'Brien'). Always include "trashed = false" unless searching trash.`),
          mime_type: z
            .string()
            .optional()
            .describe(`Optional MIME type filter (e.g. 'application/pdf', 'application/vnd.google-apps.folder', 'image/png'). When provided, the tool ANDs "mimeType = '<value>'" onto your query — use this instead of hand-writing mimeType in q to avoid quoting mistakes.`),
          drive_id: z
            .string()
            .optional()
            .describe(`Optional shared drive ID to scope the search to a single shared drive. When omitted, searches across allDrives (My Drive + every accessible shared drive).`),
          page_size: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Number of results per page (1-100, default 20). Cap is 100 to keep responses readable.'),
          page_token: z.string().optional().describe('Token from a previous nextPageToken to fetch the next page'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ query, mime_type, drive_id, page_token, page_size }: any, context: any) => {
          const { accessToken } = context;

          try {
            const effectivePageSize = Math.min(Math.max(Number(page_size) || 20, 1), 100);

            // Compose the final q. When mime_type is provided we wrap the user
            // query in parens before ANDing — necessary because the user q may
            // contain an `or` at top level.
            let effectiveQuery = query;
            if (mime_type) {
              // Single-quote-escape mime_type per Drive q grammar.
              const safeMime = escapeDriveQValue(String(mime_type));
              effectiveQuery = query && query.trim().length > 0
                ? `(${query}) and mimeType = '${safeMime}'`
                : `mimeType = '${safeMime}'`;
            }

            const params = new URLSearchParams({
              pageSize: String(effectivePageSize),
              fields: DRIVE_FILE_LIST_FIELDS,
              supportsAllDrives: 'true',
              includeItemsFromAllDrives: 'true',
              q: effectiveQuery,
              ...(page_token && { pageToken: page_token }),
            });

            // Scope: explicit shared drive, or allDrives across everything.
            // Without setting corpora, Drive defaults to 'user' and silently
            // skips shared-drive content even with supportsAllDrives=true.
            if (drive_id) {
              params.set('corpora', 'drive');
              params.set('driveId', drive_id);
            } else {
              params.set('corpora', 'allDrives');
            }

            let result;
            try {
              result = await makeDriveRequest(
                `/files?${params}`,
                accessToken
              );
            } catch (error: any) {
              if (error instanceof DriveApiError && error.status === 400) {
                // Preserve Drive's own message — it usually identifies the
                // offending field (q, driveId, corpora, mimeType…). Append a
                // hint that lists the round-2 parameters as likely causes so
                // the LLM knows where to look.
                const drive_id_hint = drive_id ? ` (drive_id used: ${JSON.stringify(drive_id)})` : '';
                throw new DriveApiError(
                  `${error.message}. Likely causes: malformed 'query' (Drive q syntax), invalid 'mime_type', or invalid 'drive_id'${drive_id_hint}. ` +
                  `Example valid queries: name contains 'test' and trashed = false; 'user@example.com' in owners and trashed = false.`,
                  400,
                  error.reason,
                );
              }
              throw error;
            }

            // Format the response
            const files = result.files || [];
            const formattedFiles = files.map(formatDriveFile);

            const output: any = {
              files: formattedFiles,
              nextPageToken: result.nextPageToken || null,
            };
            // Drive sets incompleteSearch=true when it couldn't enumerate every
            // corpus in time (common with corpora=allDrives across many shared
            // drives). Surface it so the caller can warn or paginate further.
            if (result.incompleteSearch === true) {
              output.incompleteSearch = true;
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      copy_file: {
        description: 'Duplicate a Drive file. Use this when the user asks to copy/duplicate a file, optionally renaming it or placing the copy in a specific folder. Does NOT work for folders (Drive forbids folder copy); use create_folder + manual re-add for that case.',
        outputSchema: {
          id: z.string(),
          name: z.string(),
          mimeType: z.string(),
          size: z.number().optional(),
          createdTime: z.string().optional(),
          modifiedTime: z.string().optional(),
          parents: z.array(z.string()).optional(),
          webViewLink: z.string().optional(),
          message: z.string(),
        },
        schema: {
          file_id: z.string().describe('ID of the file to copy'),
          name: z.string().optional().describe('New name for the copied file'),
          parent_folder_id: z.string().optional().describe('ID of the folder to place the copy in'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ file_id, name, parent_folder_id }: any, context: any) => {
          const { accessToken } = context;

          try {
            const requestBody: any = {};

            if (name) {
              requestBody.name = name;
            }

            if (parent_folder_id) {
              requestBody.parents = [parent_folder_id];
            }

            const result = await makeDriveRequest(
              `/files/${encodeURIComponent(file_id)}/copy?supportsAllDrives=true&fields=id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink`,
              accessToken,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
              }
            );

            const output = {
              id: result.id,
              name: result.name,
              mimeType: result.mimeType,
              size: result.size ? parseInt(result.size) : undefined,
              createdTime: result.createdTime,
              modifiedTime: result.modifiedTime,
              parents: result.parents,
              webViewLink: result.webViewLink,
              message: `File copied successfully`,
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      create_folder: {
        description: 'Create a new folder in Google Drive. Use this when the user asks to make/create a folder. Optionally nest the folder under an existing parent_folder_id; otherwise it lands in My Drive root.',
        outputSchema: {
          id: z.string(),
          name: z.string(),
          mimeType: z.string(),
          createdTime: z.string().optional(),
          modifiedTime: z.string().optional(),
          parents: z.array(z.string()).optional(),
          webViewLink: z.string().optional(),
          message: z.string(),
        },
        schema: {
          name: z.string().describe('Name of the folder to create'),
          parent_folder_id: z.string().optional().describe('ID of the parent folder'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ name, parent_folder_id }: any, context: any) => {
          const { accessToken } = context;

          try {
            const requestBody: any = {
              name: name,
              mimeType: 'application/vnd.google-apps.folder',
            };

            if (parent_folder_id) {
              requestBody.parents = [parent_folder_id];
            }

            const result = await makeDriveRequest(
              '/files?supportsAllDrives=true&fields=id,name,mimeType,createdTime,modifiedTime,parents,webViewLink',
              accessToken,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody),
              }
            );

            const output = {
              id: result.id,
              name: result.name,
              mimeType: result.mimeType,
              createdTime: result.createdTime,
              modifiedTime: result.modifiedTime,
              parents: result.parents,
              webViewLink: result.webViewLink,
              message: 'Folder created successfully',
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      get_file: {
        description: 'Fetch the contents of a Google Drive file (text, image, or PDF up to 20MB). Use this after search_files when the user wants the file body, not just metadata. PDFs with a text layer are returned as readable text in `content`. Scanned/image-only PDFs have no text to extract: the result says so and carries `scanned: true` plus a `webViewLink` to open the file, rather than returning unreadable bytes. `extraction` tells you which branch produced the result. Does NOT support Google-native docs (Docs/Sheets/Slides/Forms) — use the dedicated MCP servers for those. Files over 20MB, unsupported mime types and Google-native docs are reported as tool errors, not results.',
        readOnlyHint: true,
        outputSchema: {
          id: z.string().optional(),
          name: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().optional(),
          webViewLink: z.string().optional(),
          // Which branch produced this result; everything below varies with it.
          extraction: z.enum(['text', 'image', 'scanned', 'failed']).optional(),
          content: z.string().optional().describe('File text, for text files and PDFs with a text layer'),
          pages: z.number().optional().describe('PDF page count'),
          textPages: z.number().optional().describe('PDF pages carrying a text layer'),
          scanned: z.boolean().optional().describe('True when a PDF is image-only'),
          truncated: z.boolean().optional(),
          message: z.string().optional().describe('Why content is absent or partial'),
        },
        schema: {
          file_id: z.string().describe('The Google Drive file ID (from search_files).'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ file_id }: any, context: any) => {
          const { accessToken } = context;

          try {
            // 1. Fetch metadata so we can branch on the *actual* mimeType.
            const meta = await makeDriveRequest(
              `/files/${encodeURIComponent(file_id)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`,
              accessToken
            );

            const mimeType: string = meta.mimeType || '';
            const size = meta.size ? parseInt(meta.size) : 0;
            const name: string = meta.name || '';
            const kind = classifyMime(mimeType);
            const webViewLink: string =
              meta.webViewLink || `https://drive.google.com/file/d/${meta.id}/view`;

            if (kind === 'native-doc' || kind === 'unsupported') {
              return formatDriveError(new Error(unsupportedMessage(name, mimeType, webViewLink)));
            }

            if (size > MAX_FILE_SIZE) {
              return formatDriveError(new Error(
                `File '${name}' is ${size} bytes which exceeds the 20MB limit. ` +
                `Open in browser instead: ${webViewLink}.`
              ));
            }

            // 2. Download bytes.
            const downloadUrl = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(file_id)}?alt=media&supportsAllDrives=true`;
            const response = await fetch(downloadUrl, {
              headers: { 'Authorization': `Bearer ${accessToken}` },
            });

            if (!response.ok) {
              const bodyText = await response.text().catch(() => '');
              throw new DriveApiError(
                `Failed to download file content${bodyText ? `: ${bodyText}` : ''} (${response.status})`,
                response.status,
              );
            }

            const fileMeta = { id: meta.id, name, mimeType, size, webViewLink };
            const jsonBlock = (payload: unknown) => ({
              type: 'text' as const,
              text: JSON.stringify(payload, null, 2),
            });

            if (kind === 'pdf') {
              const arrayBuffer = await response.arrayBuffer();
              let pdfText: PdfText | undefined;
              let failure: string | undefined;
              const startedAt = Date.now();
              try {
                pdfText = await extractPdfText(new Uint8Array(arrayBuffer));
              } catch (err: any) {
                failure = err?.message || 'the PDF could not be parsed';
                console.error(
                  `[gdrive-hosted] get_file: pdf text extraction failed fileId=${file_id} ` +
                  `bytes=${arrayBuffer.byteLength} type=${err?.name || typeof err} ` +
                  `elapsedMs=${Date.now() - startedAt} error=${err?.message}`
                );
              }

              let result: Record<string, unknown>;
              if (!pdfText) {
                result = {
                  ...fileMeta,
                  extraction: 'failed',
                  message: `Could not extract text from '${name}' because ${failure}. Open the file directly instead: ${webViewLink}`,
                };
              } else if (pdfText.scanned) {
                result = {
                  ...fileMeta,
                  extraction: 'scanned',
                  pages: pdfText.pages,
                  textPages: pdfText.textPages,
                  scanned: true,
                  message:
                    `'${name}' is a scanned (image-only) PDF with ${pdfText.pages} page(s) and no text layer, ` +
                    `so there is no text to extract. Reading its contents would require rendering each page as ` +
                    `an image, which consumes a large number of tokens and is not supported by this connector. ` +
                    `Open the file directly instead: ${webViewLink}`,
                };
              } else {
                const notes: string[] = [];
                if (pdfText.textPages < pdfText.pages) {
                  notes.push(
                    `only ${pdfText.textPages} of ${pdfText.pages} page(s) carry a text layer; ` +
                    `the rest appear to be scanned images and are not included`
                  );
                }
                if (pdfText.truncated) {
                  notes.push(`the text was truncated at ${MAX_TEXT_CHARS} characters`);
                }
                result = {
                  ...fileMeta,
                  extraction: 'text',
                  content: pdfText.text,
                  pages: pdfText.pages,
                  textPages: pdfText.textPages,
                  ...(pdfText.truncated ? { truncated: true } : {}),
                  ...(notes.length
                    ? { message: `Note: ${notes.join('; ')}. Full file: ${webViewLink}` }
                    : {}),
                };
              }

              return { content: [jsonBlock(result)], structuredContent: result };
            }

            if (kind === 'image') {
              const arrayBuffer = await response.arrayBuffer();
              // Node ≥22 is declared in package.json; Buffer is safe and avoids
              // the O(n²) String.fromCharCode chunking required by btoa.
              const base64Data = Buffer.from(arrayBuffer).toString('base64');
              const imageMeta = { ...fileMeta, extraction: 'image' as const };
              return {
                content: [
                  jsonBlock(imageMeta),
                  { type: 'image' as const, data: base64Data, mimeType },
                ],
                structuredContent: imageMeta,
              };
            }

            // kind === 'text'
            const textContent = await response.text();
            const result = { ...fileMeta, extraction: 'text' as const, content: textContent };
            return {
              content: [jsonBlock(result)],
              structuredContent: result,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      move_file: {
        description: 'Move a file or folder into a different parent folder in Google Drive. The item is removed from its previous parents (true Drive "move" semantics); Drive no longer supports keeping a file in several folders at once. Also supports an optional rename via new_name. Use this when the user asks to move, relocate, or reorganise a file.',
        destructiveHint: true,
        outputSchema: {
          id: z.string(),
          name: z.string(),
          parents: z.array(z.string()).optional(),
          previousParents: z.array(z.string()).optional(),
          webViewLink: z.string().optional(),
          message: z.string(),
        },
        schema: {
          file_id: z.string().describe('ID of the file or folder to move.'),
          new_parent_folder_id: z.string().describe('ID of the destination folder.'),
          new_name: z.string().optional().describe('Optional new name for the file (rename while moving).'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ file_id, new_parent_folder_id, new_name }: any, context: any) => {
          const { accessToken } = context;

          try {
            // Cheap circular-move guard: catch the obvious self-move before
            // round-tripping. Deeper cycles (folder into a descendant) need
            // recursive traversal — leave those for Drive to reject.
            if (isSelfMove(file_id, new_parent_folder_id)) {
              return formatDriveError(new Error(
                'Cannot move a file or folder into itself — file_id and new_parent_folder_id are the same.'
              ));
            }

            // 1. Read current parents so we can build removeParents accurately.
            const current = await makeDriveRequest(
              `/files/${encodeURIComponent(file_id)}?fields=id,parents&supportsAllDrives=true`,
              accessToken,
            );
            const previousParents: string[] = current.parents || [];

            const queryParams = new URLSearchParams({
              addParents: new_parent_folder_id,
              fields: 'id,name,parents,webViewLink',
              supportsAllDrives: 'true',
            });
            // Only remove parents we don't already share with the new parent
            // — if the item is already in the destination, leave that link.
            const toRemove = previousParents.filter((p) => p !== new_parent_folder_id);
            if (toRemove.length > 0) {
              queryParams.set('removeParents', toRemove.join(','));
            }

            const body: any = {};
            if (new_name) body.name = new_name;

            const result = await makeDriveRequest(
              `/files/${encodeURIComponent(file_id)}?${queryParams}`,
              accessToken,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              },
            );

            const output = {
              id: result.id,
              name: result.name,
              parents: result.parents,
              previousParents,
              webViewLink: result.webViewLink,
              message: 'File moved successfully',
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      share_file: {
        description: 'Grant access to a Google Drive file or folder by creating a permission. Supports sharing with a specific user (by email), an entire Google Workspace domain (by domain name), or making the item accessible to anyone with the link. By default no email notification is sent — the caller must explicitly set send_notification=true to email the recipient (user type only).',
        outputSchema: {
          permissionId: z.string().optional(),
          fileId: z.string(),
          type: z.string(),
          role: z.string(),
          emailAddress: z.string().optional(),
          domain: z.string().optional(),
          message: z.string(),
        },
        schema: {
          file_id: z.string().describe('ID of the file or folder to share.'),
          type: z.enum(['user', 'anyone', 'domain']).describe('"user" to share with a specific email; "domain" to share with everyone in a Google Workspace domain; "anyone" for link-sharing with the public.'),
          role: z.enum(['reader', 'commenter', 'writer']).describe('Access level to grant. "reader" = view, "commenter" = view+comment, "writer" = edit.'),
          email: z.string().email().optional().describe('Required when type="user": the recipient email address.'),
          domain: z.string().optional().describe('Required when type="domain": the Workspace domain (e.g. "example.com"). The signed-in user must be a member of this domain or have permission to share with it.'),
          send_notification: z
            .boolean()
            .optional()
            .describe('If true and type="user", Google emails the recipient. Defaults to false to avoid accidental notifications — set true only when the user explicitly asked to notify. Ignored for type="anyone" and type="domain".'),
          message: z.string().optional().describe('Optional message included in the notification email (only used when send_notification=true).'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ file_id, type, role, email, domain, send_notification, message }: any, context: any) => {
          const { accessToken } = context;

          try {
            // For "domain must be omitted" checks on type=user/anyone we want
            // to reject ANY truthy domain (string, number, object, ...) — the
            // pre-refactor code passed the raw value through `if (normalised)`,
            // and we preserve that strictness here. For type="domain" we run
            // the full string-shape validation via validateWorkspaceDomain.
            const domainPresent = typeof domain === 'string' ? domain.trim().length > 0 : !!domain;
            let normalisedDomain = '';

            // Per-type required/forbidden field validation.
            if (type === 'user') {
              if (!email) return formatDriveError(new Error('email is required when type="user".'));
              if (domainPresent) return formatDriveError(new Error('domain must be omitted when type="user".'));
            } else if (type === 'domain') {
              const v = validateWorkspaceDomain(domain);
              if (!v.ok) return formatDriveError(new Error(v.error));
              normalisedDomain = v.domain;
              if (email) return formatDriveError(new Error('email must be omitted when type="domain".'));
              if (send_notification === true) {
                return formatDriveError(new Error('send_notification is only valid when type="user" — Drive does not email every member of a domain.'));
              }
            } else { // anyone
              if (email) return formatDriveError(new Error('email must be omitted when type="anyone".'));
              if (domainPresent) return formatDriveError(new Error('domain must be omitted when type="anyone".'));
              if (send_notification === true) {
                return formatDriveError(new Error('send_notification is only valid when type="user" — there is no recipient to notify for link sharing.'));
              }
            }

            // Drive only accepts sendNotificationEmail=true for type=user;
            // force false for the others to avoid 400s from the API.
            const notify = type === 'user' && send_notification === true;
            const body: any = { type, role };
            if (type === 'user') body.emailAddress = email;
            if (type === 'domain') body.domain = normalisedDomain;

            const params = new URLSearchParams({
              fields: 'id,type,role,emailAddress,domain',
              supportsAllDrives: 'true',
              sendNotificationEmail: notify ? 'true' : 'false',
            });
            if (notify && message) params.set('emailMessage', message);

            const result = await makeDriveRequest(
              `/files/${encodeURIComponent(file_id)}/permissions?${params}`,
              accessToken,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              },
            );

            const verb = role === 'reader' ? 'view' : role === 'commenter' ? 'view and comment on' : 'edit';
            const successMessage = type === 'anyone'
              ? `Anyone with the link can ${verb} this file`
              : type === 'domain'
                ? `Anyone in ${normalisedDomain} can ${verb} this file`
                : `Shared with ${email} as ${role}${notify ? ' (notified by email)' : ' (no notification sent)'}`;

            const output = {
              permissionId: result.id,
              fileId: file_id,
              type: result.type,
              role: result.role,
              emailAddress: result.emailAddress,
              domain: result.domain,
              message: successMessage,
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      get_file_metadata: {
        description: 'Fetch the full metadata for a single Google Drive file or folder without downloading its contents. Use this when the user wants details about a file (owner, size, timestamps, parents, sharing state, description, starred) rather than the file body — for the body use get_file. Works for every file type, including Google-native docs and folders.',
        readOnlyHint: true,
        outputSchema: {
          id: z.string().optional(),
          name: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().optional(),
          createdTime: z.string().optional(),
          modifiedTime: z.string().optional(),
          parents: z.array(z.string()).optional(),
          webViewLink: z.string().optional(),
          owner: z.string().optional(),
          isFolder: z.boolean().optional(),
          trashed: z.boolean().optional(),
          starred: z.boolean().optional(),
          shared: z.boolean().optional(),
          description: z.string().optional(),
          version: z.string().optional(),
          md5Checksum: z.string().optional(),
          driveId: z.string().optional(),
          lastModifyingUser: z.string().optional(),
          iconLink: z.string().optional(),
          thumbnailLink: z.string().optional(),
        },
        schema: {
          file_id: z.string().describe('The Google Drive file or folder ID (from search_files).'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ file_id }: any, context: any) => {
          const { accessToken } = context;

          try {
            const fields = [
              'id', 'name', 'mimeType', 'size', 'createdTime', 'modifiedTime',
              'parents', 'webViewLink', 'owners', 'trashed', 'starred', 'shared',
              'description', 'version', 'md5Checksum', 'driveId',
              'lastModifyingUser', 'iconLink', 'thumbnailLink',
            ].join(',');

            const meta = await makeDriveRequest(
              `/files/${encodeURIComponent(file_id)}?fields=${fields}&supportsAllDrives=true`,
              accessToken,
            );

            const output = {
              ...formatDriveFile(meta),
              starred: meta.starred === true,
              shared: meta.shared === true,
              description: meta.description,
              version: meta.version,
              md5Checksum: meta.md5Checksum,
              driveId: meta.driveId,
              lastModifyingUser: meta.lastModifyingUser?.emailAddress,
              iconLink: meta.iconLink,
              thumbnailLink: meta.thumbnailLink,
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      get_file_permissions: {
        description: 'List the permissions (who has access and at what role) on a Google Drive file or folder. Use this to see how an item is shared — the users, groups, domains, or "anyone" links that can view/comment/edit it. Read-only; to grant access use share_file.',
        readOnlyHint: true,
        outputSchema: {
          fileId: z.string(),
          permissions: z.array(permissionSchema),
          incomplete: z.boolean().optional(),
        },
        schema: {
          file_id: z.string().describe('ID of the file or folder whose permissions to list.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ file_id }: any, context: any) => {
          const { accessToken } = context;

          try {
            const permissions: any[] = [];
            let pageToken: string | undefined;
            let pages = 0;
            do {
              const params = new URLSearchParams({
                fields: 'nextPageToken,permissions(id,type,role,emailAddress,domain,displayName,deleted,expirationTime)',
                supportsAllDrives: 'true',
                pageSize: '100',
                ...(pageToken && { pageToken }),
              });

              const result = await makeDriveRequest(
                `/files/${encodeURIComponent(file_id)}/permissions?${params}`,
                accessToken,
              );

              permissions.push(...(result?.permissions || []));
              pageToken = result?.nextPageToken || undefined;
              pages++;
            } while (pageToken && pages < MAX_PERMISSION_PAGES);

            const output: any = {
              fileId: file_id,
              permissions,
            };
            // A token still present means the page cap cut enumeration short —
            // Drive has more permissions we didn't fetch.
            if (pageToken) {
              output.incomplete = true;
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      list_recent_files: {
        description: 'List the most recently modified files in Google Drive, newest first. Use this when the user asks for their recent/latest files without a specific search term. Excludes trashed items and folders; spans My Drive and every accessible shared drive. Returns up to page_size items (default 20, max 100) plus a nextPageToken for further pages. For a targeted search use search_files instead.',
        readOnlyHint: true,
        outputSchema: {
          files: z.array(driveFileSchema),
          nextPageToken: z.string().nullable(),
          incompleteSearch: z.boolean().optional(),
        },
        schema: {
          page_size: z
            .number()
            .int()
            .min(1)
            .max(100)
            .optional()
            .describe('Number of results per page (1-100, default 20).'),
          page_token: z.string().optional().describe('Token from a previous nextPageToken to fetch the next page.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ page_size, page_token }: any, context: any) => {
          const { accessToken } = context;

          try {
            const effectivePageSize = Math.min(Math.max(Number(page_size) || 20, 1), 100);

            const params = new URLSearchParams({
              pageSize: String(effectivePageSize),
              orderBy: 'modifiedTime desc',
              q: "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
              fields: DRIVE_FILE_LIST_FIELDS,
              corpora: 'allDrives',
              supportsAllDrives: 'true',
              includeItemsFromAllDrives: 'true',
              ...(page_token && { pageToken: page_token }),
            });

            const result = await makeDriveRequest(`/files?${params}`, accessToken);

            const files = result.files || [];
            const formattedFiles = files.map(formatDriveFile);

            const output: any = {
              files: formattedFiles,
              nextPageToken: result.nextPageToken || null,
            };
            if (result.incompleteSearch === true) {
              output.incompleteSearch = true;
            }
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      trash_file: {
        description: 'Move a Google Drive file or folder to the trash. This is reversible — the item stays in Drive\'s trash and can be restored from the Drive UI; it is NOT a permanent delete. Use this when the user asks to delete, remove, or trash a file. Trashing a folder trashes everything inside it.',
        destructiveHint: true,
        outputSchema: {
          id: z.string(),
          name: z.string().optional(),
          trashed: z.boolean(),
          webViewLink: z.string().optional(),
          message: z.string(),
        },
        schema: {
          file_id: z.string().describe('ID of the file or folder to move to the trash.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ file_id }: any, context: any) => {
          const { accessToken } = context;

          try {
            const result = await makeDriveRequest(
              `/files/${encodeURIComponent(file_id)}?fields=id,name,trashed,webViewLink&supportsAllDrives=true`,
              accessToken,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trashed: true }),
              },
            );

            const output = {
              id: result.id,
              name: result.name,
              trashed: result.trashed === true,
              webViewLink: result.webViewLink,
              message: `'${result.name ?? file_id}' moved to trash. It can be restored from Google Drive's trash.`,
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      update_file: {
        description: 'Update the metadata of a Google Drive file or folder: rename it (new_name), set its description, or star/unstar it. Provide at least one field to change; omitted fields are left untouched. Use this for metadata edits only — to move an item use move_file, to change sharing use share_file, and to trash it use trash_file.',
        outputSchema: {
          id: z.string(),
          name: z.string().optional(),
          description: z.string().optional(),
          starred: z.boolean().optional(),
          modifiedTime: z.string().optional(),
          webViewLink: z.string().optional(),
          message: z.string(),
        },
        schema: {
          file_id: z.string().describe('ID of the file or folder to update.'),
          new_name: z.string().optional().describe('New name for the file or folder.'),
          description: z.string().optional().describe('New description. Pass an empty string to clear an existing description.'),
          starred: z.boolean().optional().describe('true to star the item, false to unstar it.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ file_id, new_name, description, starred }: any, context: any) => {
          const { accessToken } = context;

          try {
            const update = buildFileUpdate({ new_name, description, starred });
            if (!update.ok) {
              return formatDriveError(new Error(update.error));
            }

            const result = await makeDriveRequest(
              `/files/${encodeURIComponent(file_id)}?fields=id,name,description,starred,modifiedTime,webViewLink&supportsAllDrives=true`,
              accessToken,
              {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(update.body),
              },
            );

            const output = {
              id: result.id,
              name: result.name,
              description: result.description,
              starred: result.starred === true,
              modifiedTime: result.modifiedTime,
              webViewLink: result.webViewLink,
              message: 'File updated successfully',
            };
            return {
              content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
              structuredContent: output,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },
    };
  }
}
