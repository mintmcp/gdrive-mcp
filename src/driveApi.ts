export const GOOGLE_DRIVE_API = 'https://www.googleapis.com/drive/v3';

// Retry tuning for transient Drive errors (429 / 5xx)
const MAX_RETRY_ATTEMPTS = 3;          // total attempts including the first
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 4000;
const MAX_RETRY_AFTER_MS = 30_000;     // cap server-supplied Retry-After

// Thrown by makeDriveRequest's opt-in maxBytes cap, before any parsing.
// bytesRead is what was pulled before giving up, so a budget across calls can
// charge the failed one too
export class ResponseTooLargeError extends Error {
  maxBytes: number;
  bytesRead: number;
  constructor(maxBytes: number, bytesRead = 0) {
    super(`The response body is over the ${maxBytes}-byte limit`);
    this.name = 'ResponseTooLargeError';
    this.maxBytes = maxBytes;
    this.bytesRead = bytesRead;
  }
}

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

// The `code` for an error that isn't Google's. A failed fetch is a TypeError like
// a bug in our code, so the system code on its cause (ECONNRESET, ENOTFOUND,
// UND_ERR_CONNECT_TIMEOUT) comes first. A plain Error is a message we wrote,
// usually a rejected input, so it gets no code; any other class (TypeError,
// RangeError) points at a bug
function errorClass(err: Error): string | undefined {
  const cause = (err as { cause?: { code?: unknown } }).cause;
  if (typeof cause?.code === "string") return cause.code;
  return err.name === "Error" ? undefined : err.name;
}

export interface DriveErrorInfo {
  error: string;
  status?: number;
  reason?: string;
  code?: string;
  hint?: string;
}

// The message and hint for a failed Drive call, whatever threw: the tool
// result and the MCP resource error are both built from it
export function describeDriveError(err: unknown): DriveErrorInfo {
  let status: number | undefined;
  let reason: string | undefined;
  let code: string | undefined;
  let message: string;

  if (err instanceof DriveApiError) {
    status = err.status;
    reason = err.reason;
    message = err.message;
  } else if (err instanceof Error) {
    message = err.message;
    code = errorClass(err);
  } else {
    message = String(err);
  }

  // status-specific hints so the LLM can self-correct
  let hint: string | undefined;
  switch (status) {
    case 401:
      hint = 'Authentication failed. The Google access token is invalid or expired; the user may need to reconnect their Google account.';
      break;
    case 403:
      hint = reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded'
        ? 'Rate limited by Google. Retried already — back off and try again later.'
        : reason === 'exportSizeLimitExceeded'
        ? 'The export is over Google\'s 10MB export limit. Try a lighter format (for a Doc, md or txt instead of pdf or docx), or open the file directly.'
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

  const info: DriveErrorInfo = { error: message };
  if (status !== undefined) info.status = status;
  if (reason) info.reason = reason;
  if (code) info.code = code;
  if (hint) info.hint = hint;
  return info;
}

export function formatDriveError(err: unknown): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return {
    content: [{ type: 'text', text: JSON.stringify(describeDriveError(err)) }],
    isError: true,
  };
}

export function parseRetryAfter(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.min(asNumber * 1000, MAX_RETRY_AFTER_MS);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    return Math.max(0, Math.min(asDate - Date.now(), MAX_RETRY_AFTER_MS));
  }
  return undefined;
}

export function backoffDelayMs(attempt: number): number {
  // attempt is 1-based; exp backoff with ±25% jitter
  const base = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = base * (Math.random() * 0.5 - 0.25);
  return Math.max(0, Math.round(base + jitter));
}

const RETRY_SAFE_METHODS = new Set(['GET', 'HEAD']);

export function isRetryable(status: number, method: string): boolean {
  if (status === 429) return true; // safe to retry, request was rejected not processed
  if (status >= 500 && status <= 599) {
    // only retry idempotent methods on 5xx, writes may have partially succeeded
    return RETRY_SAFE_METHODS.has(method.toUpperCase());
  }
  return false;
}

// Without a signal, a plain wait. With one, it rejects with the signal's
// reason as soon as the signal aborts, so a deadline never waits out a backoff
async function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Reads a body as a stream and gives up once it passes maxBytes, so an
// oversized response is never held in memory or parsed
async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError(maxBytes, total);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}

export interface DriveResponseOptions {
  // `bytes` returns the raw body for downloads such as files.export, which
  // text decoding would corrupt. Default: JSON, or the text of a non-JSON body
  responseType?: 'json' | 'bytes';
  maxBytes?: number;
}

// The request's resource-key header (older link-shared files need it on every
// call) and abort signal, for a call about one file
export function driveRequestInit(file: { id: string; resourceKey?: string }, signal?: AbortSignal): RequestInit {
  return {
    ...(signal ? { signal } : {}),
    ...(file.resourceKey ? { headers: { 'X-Goog-Drive-Resource-Keys': `${file.id}/${file.resourceKey}` } } : {}),
  };
}

export const EXPORT_LIMIT_MESSAGE = "The export is over Google's 10 MB export limit.";

export async function exportFile(
  fileId: string,
  mimeType: string,
  accessToken: string,
  init: RequestInit = {},
): Promise<Buffer | null> {
  try {
    return await makeDriveRequest(
      `/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(mimeType)}`,
      accessToken,
      init,
      { responseType: 'bytes' },
    );
  } catch (err) {
    if (err instanceof DriveApiError && err.status === 403 && err.reason === 'exportSizeLimitExceeded') return null;
    throw err;
  }
}

// throws DriveApiError on non-2xx; retries 429 and (for safe methods) 5xx
// with bounded backoff honouring Retry-After. options.signal reaches fetch and
// also ends a retry wait early
export async function makeDriveRequest(
  endpoint: string,
  accessToken: string,
  options: RequestInit = {},
  { responseType = 'json', maxBytes }: DriveResponseOptions = {},
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
        ...(responseType === 'json' && { 'Accept': 'application/json' }),
        ...options.headers,
      },
    });

    if (response.ok) {
      const body = maxBytes === undefined
        ? Buffer.from(await response.arrayBuffer())
        : await readCapped(response, maxBytes);
      if (responseType === 'bytes') return body;
      // no-content responses (e.g. some DELETE/PATCH)
      if (response.status === 204 || body.length === 0) return null;
      const text = body.toString('utf8');
      try {
        return JSON.parse(text);
      } catch {
        // non-JSON body on a 2xx, return the raw text
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
      await sleep(delay, options.signal);
      continue;
    }
    throw lastError;
  }

  // unreachable, but TS needs a fallback
  throw lastError ?? new DriveApiError('Google Drive request failed', 0);
}
