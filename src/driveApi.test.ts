import { describe, it, expect } from 'vitest';
import { parseRetryAfter, backoffDelayMs, isRetryable, formatDriveError, DriveApiError } from './driveApi.js';

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
  const payloadOf = (e: any) => JSON.parse(e.content[0].text);

  it('emits 401 with reconnect hint', () => {
    const e = formatDriveError(new DriveApiError('unauthorized', 401));
    expect(e.isError).toBe(true);
    expect(payloadOf(e).status).toBe(401);
    expect(payloadOf(e).hint).toMatch(/reconnect/i);
  });
  it('emits 404 with not-found hint', () => {
    const e = formatDriveError(new DriveApiError('not found', 404));
    expect(payloadOf(e).status).toBe(404);
    expect(payloadOf(e).hint).toMatch(/not found/i);
  });
  it('emits 429 with retry hint', () => {
    const e = formatDriveError(new DriveApiError('too many', 429));
    expect(payloadOf(e).hint).toMatch(/Retried/i);
  });
  it('preserves message for plain Error without status', () => {
    const e = formatDriveError(new Error('boom'));
    expect(payloadOf(e).error).toBe('boom');
    expect(payloadOf(e).status).toBeUndefined();
  });
  it('omits structuredContent, which a client would validate against outputSchema', () => {
    expect('structuredContent' in formatDriveError(new Error('boom'))).toBe(false);
  });
});

