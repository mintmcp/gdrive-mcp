/**
 * Google Drive MCP Tools
 */

import { z } from 'zod';
import { withGoogleAuth as requirePermissionSecure } from "./auth.js";

const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

const DRIVE_LABELS_API = 'https://drivelabels.googleapis.com/v2';
const LABEL_SCHEMA_TTL_MS = 60 * 60 * 1000; // label schemas change rarely — cache for an hour
const LABEL_SCHEMA_CACHE_MAX = 500; // bound growth: distinct label@revision keys accrue over the process lifetime

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

// Retry tuning for transient Drive errors (429 / 5xx).
const MAX_RETRY_ATTEMPTS = 3;          // total attempts including the first
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4000;
const MAX_RETRY_AFTER_MS = 30_000;     // cap server-supplied Retry-After

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

// Resolved label schema: fieldId -> (choiceId -> human-readable display name)
export type LabelSchema = Record<string, Record<string, string>>;

// Per-process cache: resolve each label's schema once, not on every get_file.
const labelSchemaCache = new Map<string, { schema: LabelSchema; expiresAt: number }>();

/** Test hook — the cache is module state, so tests need a way to isolate runs. */
export function clearLabelSchemaCache(): void {
  labelSchemaCache.clear();
}

/**
 * Fetch (and cache by) the exact label revision the file references, so a later
 * choice rename can't retroactively change how an already-labeled file resolves.
 */
export async function getLabelSchema(
  labelId: string,
  revisionId: string | undefined,
  accessToken: string
): Promise<LabelSchema> {
  const labelResource = revisionId
    ? `${encodeURIComponent(labelId)}@${encodeURIComponent(revisionId)}`
    : encodeURIComponent(labelId);
  const cached = labelSchemaCache.get(labelResource);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.schema;
  }

  const data = await makeDriveRequest(
    `${DRIVE_LABELS_API}/labels/${labelResource}?view=LABEL_VIEW_FULL`,
    accessToken
  ) as {
    fields?: Array<{
      id: string;
      selectionOptions?: { choices?: Array<{ id: string; properties?: { displayName?: string } }> };
    }>;
  };

  const schema: LabelSchema = {};
  for (const field of data?.fields || []) {
    const choices = field.selectionOptions?.choices;
    if (!choices) continue;
    const choiceNames: Record<string, string> = {};
    for (const choice of choices) {
      if (choice.properties?.displayName) {
        choiceNames[choice.id] = choice.properties.displayName;
      }
    }
    schema[field.id] = choiceNames;
  }

  if (labelSchemaCache.size >= LABEL_SCHEMA_CACHE_MAX) {
    // Evict the oldest entry (Map preserves insertion order) so the cache stays bounded.
    const oldest = labelSchemaCache.keys().next().value;
    if (oldest !== undefined) labelSchemaCache.delete(oldest);
  }
  labelSchemaCache.set(labelResource, { schema, expiresAt: Date.now() + LABEL_SCHEMA_TTL_MS });
  return schema;
}

/**
 * Surface the file's Drive label values as human-readable strings: resolved
 * selection-choice names + text-field values (date/integer/user fields are
 * skipped as non-classificatory). `error` set means a genuine read/resolve
 * failure, not a label shape we chose to skip. Policy middleware keys on
 * `_meta.labels` / `_meta.labelsError` — the connector informs, never blocks.
 */
export async function getFileLabels(
  fileId: string,
  accessToken: string
): Promise<{ labels: string[]; error?: string }> {
  type AppliedLabel = {
    id: string;
    revisionId?: string;
    fields?: Record<string, { valueType?: string; selection?: string[]; text?: string[] }>;
  };

  const applied: AppliedLabel[] = [];
  const labels: string[] = [];
  // `error` is a stable code (never a raw provider message — that stays in logs) so the
  // _meta contract is stable and no upstream detail leaks into model-visible responses.
  let error: string | undefined;

  // Page through all applied labels. A mid-pagination failure keeps the labels already read
  // (partial) and flags the error, rather than discarding everything.
  try {
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({ maxResults: '100' });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await makeDriveRequest(
        `/files/${encodeURIComponent(fileId)}/listLabels?${params}`,
        accessToken
      ) as { labels?: AppliedLabel[]; nextPageToken?: string };
      if (page?.labels) applied.push(...page.labels);
      pageToken = page?.nextPageToken;
    } while (pageToken);
  } catch (err: any) {
    error = 'label read failed';
    console.warn(`getFileLabels: label read failed fileId=${fileId} error=${err?.message}`);
  }

  for (const label of applied) {
    const fields = Object.entries(label.fields || {});

    // Text fields are already human-readable — surface their values directly.
    for (const [, field] of fields) {
      if (field.valueType === 'text' && field.text) {
        labels.push(...field.text.filter(Boolean));
      }
    }

    // Selection fields carry opaque choice IDs; resolve them via the label schema.
    const selectionFields = fields.filter(([, f]) => f.valueType === 'selection' && f.selection?.length);
    if (selectionFields.length === 0) continue;
    try {
      const schema = await getLabelSchema(label.id, label.revisionId, accessToken);
      for (const [fieldId, field] of selectionFields) {
        for (const choiceId of field.selection!) {
          const name = schema[fieldId]?.[choiceId];
          if (name) {
            labels.push(name);
          } else {
            // Can't name this choice: surface the raw id so nothing's lost, and flag the miss.
            labels.push(choiceId);
            error = 'incomplete label resolution';
            console.warn(`getFileLabels: unresolved choice fileId=${fileId} labelId=${label.id}`);
          }
        }
      }
    } catch (e: any) {
      // One label's schema failure shouldn't discard values already collected from others.
      error = 'incomplete label resolution';
      console.warn(`getFileLabels: label resolve failed fileId=${fileId} labelId=${label.id} error=${e?.message}`);
    }
  }

  const deduped = [...new Set(labels)];
  return error ? { labels: deduped, error } : { labels: deduped };
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
              fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,owners,trashed,driveId)',
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
            const formattedFiles = files.map((file: any) => ({
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
            }));

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
        description: 'Fetch the contents of a Google Drive file (text, image, or PDF up to 20MB). Use this after search_files when the user wants the file body, not just metadata. Does NOT support Google-native docs (Docs/Sheets/Slides/Forms) — use the dedicated MCP servers for those.',
        readOnlyHint: true,
        outputSchema: {
          id: z.string().optional(),
          name: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().optional(),
          content: z.string().optional(),
          labels: z.array(z.string()).optional(),
          labelsError: z.string().optional(),
        },
        schema: {
          file_id: z.string().describe('The Google Drive file ID (from search_files).'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ file_id }: any, context: any) => {
          const { accessToken } = context;

          try {
            // 1. Fetch metadata (to branch on the *actual* mimeType) and the file's
            // Drive labels in parallel.
            const [meta, { labels, error: labelsError }] = await Promise.all([
              makeDriveRequest(
                `/files/${encodeURIComponent(file_id)}?fields=id,name,mimeType,size,webViewLink&supportsAllDrives=true`,
                accessToken
              ),
              getFileLabels(file_id, accessToken),
            ]);

            // Expose label values on _meta on every return path — including error
            // envelopes that leak metadata (name, webViewLink) — so policy
            // middleware can act on them.
            const resultMeta: Record<string, unknown> = { labels };
            if (labelsError) {
              resultMeta.labelsError = labelsError;
            }

            const mimeType: string = meta.mimeType || '';
            const size = meta.size ? parseInt(meta.size) : 0;
            const name: string = meta.name || '';
            const kind = classifyMime(mimeType);

            if (kind === 'native-doc') {
              return {
                ...formatDriveError(new Error(
                  `File '${name}' is a Google-native document (${mimeType}) and is not supported by this server. ` +
                  `Use the dedicated MCP server: Google Docs for .document, Google Sheets for .spreadsheet, ` +
                  `Google Slides for .presentation. Open in browser: ${meta.webViewLink || 'n/a'}.`
                )),
                _meta: resultMeta,
              };
            }

            if (kind === 'unsupported') {
              return {
                ...formatDriveError(new Error(
                  `File '${name}' has unsupported mimeType '${mimeType}'. ` +
                  `This tool supports text/*, application/json|xml|javascript|yaml, image/*, and application/pdf. ` +
                  `Open in browser: ${meta.webViewLink || 'n/a'}.`
                )),
                _meta: resultMeta,
              };
            }

            if (size > MAX_FILE_SIZE) {
              return {
                ...formatDriveError(new Error(
                  `File '${name}' is ${size} bytes which exceeds the 20MB limit. ` +
                  `Open in browser instead: ${meta.webViewLink || 'n/a'}.`
                )),
                _meta: resultMeta,
              };
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

            if (kind === 'image' || kind === 'pdf') {
              const arrayBuffer = await response.arrayBuffer();
              // Node ≥22 is declared in package.json; Buffer is safe and avoids
              // the O(n²) String.fromCharCode chunking required by btoa.
              const base64Data = Buffer.from(arrayBuffer).toString('base64');

              // The SDK rejects results that declare an outputSchema but omit
              // structuredContent, so binary paths return the metadata envelope
              // there (the bytes stay in the content blocks).
              const binaryMeta: Record<string, unknown> = { id: meta.id, name, mimeType, size, labels };
              if (labelsError) binaryMeta.labelsError = labelsError;

              if (kind === 'pdf') {
                return {
                  content: [
                    { type: 'text' as const, text: JSON.stringify({ id: meta.id, name, mimeType, size }, null, 2) },
                    {
                      type: 'resource' as const,
                      resource: {
                        uri: `gdrive://file/${meta.id}`,
                        mimeType,
                        blob: base64Data,
                      },
                    },
                  ],
                  structuredContent: binaryMeta,
                  _meta: resultMeta,
                };
              }

              return {
                content: [
                  { type: 'image' as const, data: base64Data, mimeType },
                ],
                structuredContent: binaryMeta,
                _meta: resultMeta,
              };
            }

            // kind === 'text'
            const textContent = await response.text();
            // Keep labelsError beside labels in the visible body too, so a consumer
            // reading structuredContent can't mistake a failed resolution for a clean [].
            const result: Record<string, unknown> = { id: meta.id, name, mimeType, size, content: textContent, labels };
            if (labelsError) result.labelsError = labelsError;
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
              structuredContent: result,
              _meta: resultMeta,
            };
          } catch (err) {
            return formatDriveError(err);
          }
        }),
      },

      move_file: {
        description: 'Move a file or folder into a different parent folder in Google Drive. By default the item is removed from its previous parents (true Drive "move" semantics). Also supports an optional rename via new_name. Use this when the user asks to move, relocate, or reorganise a file.',
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
          remove_from_current_parents: z
            .boolean()
            .optional()
            .describe('If true (default), remove the item from its current parents — a true move. If false, the item is added to the new folder while staying in its current parents (multi-parent).'),
          new_name: z.string().optional().describe('Optional new name for the file (rename while moving).'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.file", async ({ file_id, new_parent_folder_id, remove_from_current_parents, new_name }: any, context: any) => {
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

            const shouldRemove = remove_from_current_parents !== false; // default true

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
            if (shouldRemove && previousParents.length > 0) {
              // Only remove parents we don't already share with the new parent
              // — if the item is already in the destination, leave that link.
              const toRemove = previousParents.filter((p) => p !== new_parent_folder_id);
              if (toRemove.length > 0) {
                queryParams.set('removeParents', toRemove.join(','));
              }
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
              message: shouldRemove ? 'File moved successfully' : 'File added to new folder (kept in original parents)',
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
    };
  }
}
