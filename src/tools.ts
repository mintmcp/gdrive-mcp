/**
 * Google Drive MCP Tools
 */

import { z } from 'zod';
import { withGoogleAuth as requirePermissionSecure } from "./auth.js";

const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB
const SUPPORTED_MIME_TYPES = [
  // Text
  'text/plain',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/yaml',
  // Images
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  // Documents
  'application/pdf',
] as const;

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
function formatDriveError(err: unknown): { content: Array<{ type: 'text'; text: string }>; structuredContent: any; isError: true } {
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

function parseRetryAfter(headerValue: string | null): number | undefined {
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

function backoffDelayMs(attempt: number): number {
  // attempt is 1-based. exp backoff with ±25% jitter.
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.max(0, Math.round(base + jitter));
}

const RETRY_SAFE_METHODS = new Set(['GET', 'HEAD']);

function isRetryable(status: number, method: string): boolean {
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
}).passthrough();

/**
 * Google Drive Tools class following the same pattern as GoogleCalendarTools
 */
export class GoogleDriveTools {
  static getTools() {
    return {
      search_files: {
        description: 'Search for files and folders in Google Drive using flexible search operators. Supports filtering by name, owner, file type, date, starred status, and more.',
        readOnlyHint: true,
        outputSchema: {
          files: z.array(driveFileSchema),
          nextPageToken: z.string().nullable(),
        },
        schema: {
          query: z.string().describe(`Google Drive API q parameter. Uses Drive query syntax:
- name contains 'budget' and trashed = false
- 'user@example.com' in owners and trashed = false
- mimeType = 'application/vnd.google-apps.document' and modifiedTime > '2025-01-01T00:00:00'
- mimeType = 'application/pdf' and trashed = false
- sharedWithMe and trashed = false
- starred = true and trashed = false
- 'FOLDER_ID' in parents and trashed = false
Operators: name, mimeType, modifiedTime, createdTime, owners, writers, readers, starred, trashed, sharedWithMe, parents.
Comparisons: contains, =, !=, <, >, <=, >=. Combine with: and, or, not.
Always include "trashed = false" unless searching trash.`),
          page_token: z.string().optional().describe('Token for fetching the next page of results'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ query, page_token }: any, context: any) => {
          const { accessToken } = context;

          try {
            const params = new URLSearchParams({
              pageSize: '20',
              fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,parents,webViewLink,owners)',
              supportsAllDrives: 'true',
              includeItemsFromAllDrives: 'true',
              q: query,
              ...(page_token && { pageToken: page_token }),
            });

            let result;
            try {
              result = await makeDriveRequest(
                `/files?${params}`,
                accessToken
              );
            } catch (error: any) {
              if (error instanceof DriveApiError && error.status === 400) {
                throw new DriveApiError(
                  `Invalid query syntax. The query parameter must use Google Drive API query format. ` +
                  `You sent: ${JSON.stringify(query)}. ` +
                  `Examples of valid queries: name contains 'test' and trashed = false, ` +
                  `'user@example.com' in owners and trashed = false, ` +
                  `mimeType = 'application/pdf' and trashed = false`,
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
            }));

            const output = {
              files: formattedFiles,
              nextPageToken: result.nextPageToken || null
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

      copy_file: {
        description: 'Copy a file in Google Drive',
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
        description: 'Create a folder in Google Drive',
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
        description: 'Get the content of a file from Google Drive. Supports text files, images, and PDFs up to 20MB. Does not support Google Docs/Sheets/Slides — use the dedicated MCP servers for those.',
        readOnlyHint: true,
        outputSchema: {
          id: z.string().optional(),
          name: z.string().optional(),
          mimeType: z.string().optional(),
          size: z.number().optional(),
          content: z.string().optional(),
        },
        schema: {
          file_id: z.string().describe('The Google Drive file ID'),
          mime_type: z.enum(SUPPORTED_MIME_TYPES).describe('The MIME type of the file. Use search_files to find this.'),
        },
        handler: requirePermissionSecure("https://www.googleapis.com/auth/drive.readonly", async ({ file_id, mime_type }: any, context: any) => {
          const { accessToken } = context;

          // 1. Fetch metadata
          const meta = await makeDriveRequest(
            `/files/${encodeURIComponent(file_id)}?fields=id,name,mimeType,size,webViewLink,webContentLink&supportsAllDrives=true`,
            accessToken
          );

          const mimeType: string = meta.mimeType || '';
          const size = meta.size ? parseInt(meta.size) : 0;
          const name: string = meta.name || '';

          // Size check
          if (size > MAX_FILE_SIZE) {
            return {
              content: [{ type: 'text' as const, text: `File '${name}' exceeds the 20MB limit. Download it directly: ${meta.webContentLink || meta.webViewLink}` }],
            };
          }

          // Fetch content
          const downloadUrl = `${GOOGLE_DRIVE_API}/files/${encodeURIComponent(file_id)}?alt=media&supportsAllDrives=true`;
          const response = await fetch(downloadUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` },
          });

          if (!response.ok) {
            throw new Error(`Failed to download file (${response.status})`);
          }

          if (mime_type.startsWith('image/') || mime_type === 'application/pdf') {
            const arrayBuffer = await response.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            const base64Data = btoa(binary);

            if (mime_type === 'application/pdf') {
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
              };
            }

            return {
              content: [
                { type: 'image' as const, data: base64Data, mimeType },
              ],
            };
          }

          const textContent = await response.text();
          const result = { id: meta.id, name, mimeType, size, content: textContent };
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }),
      },
    };
  }
}
