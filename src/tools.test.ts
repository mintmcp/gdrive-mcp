import { describe, it, expect } from 'vitest';
import {
  classifyMime,
  escapeDriveQValue,
  isSelfMove,
  validateWorkspaceDomain,
  parseRetryAfter,
  backoffDelayMs,
  isRetryable,
  formatDriveError,
  DriveApiError,
} from './tools.js';

describe('escapeDriveQValue', () => {
  it('escapes apostrophes', () => {
    expect(escapeDriveQValue("O'Brien")).toBe("O\\'Brien");
  });
  it('doubles backslashes', () => {
    expect(escapeDriveQValue('a\\b')).toBe('a\\\\b');
  });
  it('handles a backslash before an apostrophe correctly (order matters)', () => {
    // Input: a\'b — we expect the \\ to be doubled FIRST so the trailing
    // apostrophe is then escaped independently. Otherwise the apostrophe
    // escape would interact with the backslash escape and produce garbage.
    expect(escapeDriveQValue("a\\'b")).toBe("a\\\\\\'b");
  });
  it('passes empty strings through', () => {
    expect(escapeDriveQValue('')).toBe('');
  });
  it('passes newlines and control chars through unchanged', () => {
    expect(escapeDriveQValue('a\nb\tc')).toBe('a\nb\tc');
  });
  it('leaves ordinary mime types untouched', () => {
    expect(escapeDriveQValue('application/pdf')).toBe('application/pdf');
  });
});

describe('classifyMime', () => {
  it('detects native Google Docs by MIME prefix', () => {
    expect(classifyMime('application/vnd.google-apps.document')).toBe('native-doc');
    expect(classifyMime('application/vnd.google-apps.spreadsheet')).toBe('native-doc');
    expect(classifyMime('application/vnd.google-apps.presentation')).toBe('native-doc');
    expect(classifyMime('application/vnd.google-apps.form')).toBe('native-doc');
  });
  it('classifies pdf and images', () => {
    expect(classifyMime('application/pdf')).toBe('pdf');
    expect(classifyMime('image/png')).toBe('image');
    expect(classifyMime('image/jpeg')).toBe('image');
  });
  it('classifies text/* and select application/* as text', () => {
    expect(classifyMime('text/plain')).toBe('text');
    expect(classifyMime('text/markdown')).toBe('text');
    expect(classifyMime('application/json')).toBe('text');
    expect(classifyMime('application/xml')).toBe('text');
    expect(classifyMime('application/yaml')).toBe('text');
  });
  it('falls through to unsupported for unknown / empty', () => {
    expect(classifyMime('application/octet-stream')).toBe('unsupported');
    expect(classifyMime('audio/mp3')).toBe('unsupported');
    expect(classifyMime('')).toBe('unsupported');
  });
});

describe('isSelfMove', () => {
  it('returns true when ids match', () => {
    expect(isSelfMove('abc', 'abc')).toBe(true);
  });
  it('returns false when ids differ', () => {
    expect(isSelfMove('abc', 'def')).toBe(false);
  });
  it('returns false when either id is missing', () => {
    expect(isSelfMove(undefined, 'abc')).toBe(false);
    expect(isSelfMove('abc', undefined)).toBe(false);
    expect(isSelfMove(undefined, undefined)).toBe(false);
    expect(isSelfMove('', 'abc')).toBe(false);
  });
});

describe('validateWorkspaceDomain', () => {
  it('accepts simple and multi-label domains', () => {
    expect(validateWorkspaceDomain('example.com')).toEqual({ ok: true, domain: 'example.com' });
    expect(validateWorkspaceDomain('sub.example.co.uk')).toEqual({ ok: true, domain: 'sub.example.co.uk' });
  });
  it('trims whitespace', () => {
    expect(validateWorkspaceDomain('  example.com  ')).toEqual({ ok: true, domain: 'example.com' });
  });
  it('rejects empty / whitespace-only / non-string', () => {
    expect(validateWorkspaceDomain('').ok).toBe(false);
    expect(validateWorkspaceDomain('   ').ok).toBe(false);
    expect(validateWorkspaceDomain(undefined).ok).toBe(false);
    expect(validateWorkspaceDomain(42).ok).toBe(false);
  });
  it('rejects malformed shapes', () => {
    expect(validateWorkspaceDomain('notadomain').ok).toBe(false);
    expect(validateWorkspaceDomain('..').ok).toBe(false);
    expect(validateWorkspaceDomain('-leading.com').ok).toBe(false);
    expect(validateWorkspaceDomain('trailing-.com').ok).toBe(false);
  });
});

describe('parseRetryAfter', () => {
  it('parses numeric seconds', () => {
    expect(parseRetryAfter('5')).toBe(5000);
  });
  it('returns undefined for null / garbage', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('not-a-number-or-date')).toBeUndefined();
  });
  it('caps numeric values at MAX_RETRY_AFTER_MS', () => {
    expect(parseRetryAfter('9999')).toBeLessThanOrEqual(30_000);
  });
  it('handles an HTTP-date in the past as 0', () => {
    expect(parseRetryAfter('Mon, 01 Jan 2000 00:00:00 GMT')).toBe(0);
  });
});

describe('backoffDelayMs', () => {
  it('produces non-negative delays', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(backoffDelayMs(attempt)).toBeGreaterThanOrEqual(0);
    }
  });
  it('does not exceed the configured ceiling even for huge attempts', () => {
    expect(backoffDelayMs(99)).toBeLessThanOrEqual(4000 * 1.25 + 1);
  });
});

describe('isRetryable', () => {
  it('retries 429 regardless of method', () => {
    expect(isRetryable(429, 'GET')).toBe(true);
    expect(isRetryable(429, 'POST')).toBe(true);
  });
  it('retries 5xx only for safe methods', () => {
    expect(isRetryable(503, 'GET')).toBe(true);
    expect(isRetryable(503, 'POST')).toBe(false);
    expect(isRetryable(502, 'HEAD')).toBe(true);
    expect(isRetryable(500, 'PATCH')).toBe(false);
  });
  it('never retries client errors', () => {
    expect(isRetryable(400, 'GET')).toBe(false);
    expect(isRetryable(404, 'GET')).toBe(false);
  });
});

describe('formatDriveError', () => {
  it('emits structured 401 with reconnect hint', () => {
    const e = formatDriveError(new DriveApiError('unauthorized', 401));
    expect(e.isError).toBe(true);
    expect(e.structuredContent.status).toBe(401);
    expect(e.structuredContent.hint).toMatch(/reconnect/i);
  });
  it('emits structured 404 with not-found hint', () => {
    const e = formatDriveError(new DriveApiError('not found', 404));
    expect(e.structuredContent.status).toBe(404);
    expect(e.structuredContent.hint).toMatch(/not found/i);
  });
  it('emits structured 429 with retry hint', () => {
    const e = formatDriveError(new DriveApiError('too many', 429));
    expect(e.structuredContent.hint).toMatch(/Retried/i);
  });
  it('preserves message for plain Error without status', () => {
    const e = formatDriveError(new Error('boom'));
    expect(e.structuredContent.error).toBe('boom');
    expect(e.structuredContent.status).toBeUndefined();
  });
});

describe('Buffer base64 round-trip (platform sanity)', () => {
  it('encodes "Hello" to SGVsbG8=', () => {
    expect(Buffer.from(new Uint8Array([72, 101, 108, 108, 111])).toString('base64')).toBe('SGVsbG8=');
  });
});
