import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  getLabelSchema,
  getFileLabels,
  clearLabelSchemaCache,
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

// ---------------------------------------------------------------------------
// Drive Labels — getLabelSchema / getFileLabels
// ---------------------------------------------------------------------------

/**
 * Minimal fetch stub: routes by substring match on the URL, in order.
 * Each route's handler returns a Response; unmatched URLs fail the test.
 */
function stubFetch(routes: Array<[string, (url: string) => Response]>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: any) => {
    const url = String(input);
    calls.push(url);
    for (const [substr, handler] of routes) {
      if (url.includes(substr)) return handler(url);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }));
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LABEL_SCHEMA_BODY = {
  fields: [
    {
      id: 'field1',
      selectionOptions: {
        choices: [
          { id: 'choiceA', properties: { displayName: 'Confidential' } },
          { id: 'choiceB', properties: { displayName: 'Internal' } },
          { id: 'choiceNoName', properties: {} },
        ],
      },
    },
    { id: 'textField' }, // non-selection field — no choices to map
  ],
};

describe('getLabelSchema', () => {
  beforeEach(() => clearLabelSchemaCache());
  afterEach(() => vi.unstubAllGlobals());

  it('maps fieldId -> choiceId -> displayName and skips nameless choices', async () => {
    stubFetch([['drivelabels.googleapis.com', () => jsonResponse(LABEL_SCHEMA_BODY)]]);
    const schema = await getLabelSchema('lbl1', 'rev7', 'tok');
    expect(schema).toEqual({ field1: { choiceA: 'Confidential', choiceB: 'Internal' } });
  });

  it('requests the exact applied revision with LABEL_VIEW_FULL', async () => {
    const calls = stubFetch([['drivelabels.googleapis.com', () => jsonResponse(LABEL_SCHEMA_BODY)]]);
    await getLabelSchema('lbl1', 'rev7', 'tok');
    expect(calls[0]).toContain('/labels/lbl1@rev7?view=LABEL_VIEW_FULL');
  });

  it('caches by label@revision — second call does not refetch', async () => {
    const calls = stubFetch([['drivelabels.googleapis.com', () => jsonResponse(LABEL_SCHEMA_BODY)]]);
    await getLabelSchema('lbl1', 'rev7', 'tok');
    await getLabelSchema('lbl1', 'rev7', 'tok');
    expect(calls.length).toBe(1);
    // ...but a different revision is a different cache key.
    await getLabelSchema('lbl1', 'rev8', 'tok');
    expect(calls.length).toBe(2);
  });
});

describe('getFileLabels', () => {
  beforeEach(() => clearLabelSchemaCache());
  afterEach(() => vi.unstubAllGlobals());

  const appliedSelection = {
    id: 'lbl1',
    revisionId: 'rev7',
    fields: {
      field1: { valueType: 'selection', selection: ['choiceA'] },
    },
  };

  it('returns [] and no error for an unlabeled file', async () => {
    stubFetch([['listLabels', () => jsonResponse({ labels: [] })]]);
    const res = await getFileLabels('f1', 'tok');
    expect(res).toEqual({ labels: [] });
  });

  it('resolves selection choice ids to display names', async () => {
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: [appliedSelection] })],
      ['drivelabels.googleapis.com', () => jsonResponse(LABEL_SCHEMA_BODY)],
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res).toEqual({ labels: ['Confidential'] });
  });

  it('surfaces text-field values directly and dedupes across labels', async () => {
    const applied = [
      appliedSelection,
      {
        id: 'lbl2',
        fields: { t: { valueType: 'text', text: ['Confidential', 'Legal Hold'] } },
      },
    ];
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: applied })],
      ['drivelabels.googleapis.com', () => jsonResponse(LABEL_SCHEMA_BODY)],
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res.labels.sort()).toEqual(['Confidential', 'Legal Hold']);
    expect(res.error).toBeUndefined();
  });

  it('skips date/integer/user fields as non-classificatory', async () => {
    const applied = [{
      id: 'lbl3',
      fields: {
        d: { valueType: 'dateString', dateString: ['2026-01-01'] },
        i: { valueType: 'integer', integer: ['5'] },
      },
    }];
    stubFetch([['listLabels', () => jsonResponse({ labels: applied })]]);
    const res = await getFileLabels('f1', 'tok');
    expect(res).toEqual({ labels: [] });
  });

  it('follows listLabels pagination', async () => {
    let page = 0;
    stubFetch([
      ['listLabels', () => {
        page += 1;
        return page === 1
          ? jsonResponse({ labels: [], nextPageToken: 'p2' })
          : jsonResponse({ labels: [{ id: 'lbl2', fields: { t: { valueType: 'text', text: ['Internal'] } } }] });
      }],
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(page).toBe(2);
    expect(res.labels).toEqual(['Internal']);
  });

  it('flags "label read failed" when listLabels errors (e.g. missing scope 403)', async () => {
    stubFetch([
      ['listLabels', () => jsonResponse({ error: { message: 'insufficient scope' } }, 403)],
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res.labels).toEqual([]);
    expect(res.error).toBe('label read failed');
  });

  it('surfaces the raw choice id and flags "incomplete label resolution" when the schema lacks the choice', async () => {
    const applied = [{
      id: 'lbl1',
      revisionId: 'rev7',
      fields: { field1: { valueType: 'selection', selection: ['choiceUnknown'] } },
    }];
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: applied })],
      ['drivelabels.googleapis.com', () => jsonResponse(LABEL_SCHEMA_BODY)],
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res.labels).toEqual(['choiceUnknown']);
    expect(res.error).toBe('incomplete label resolution');
  });

  it('keeps values from other labels when one schema fetch fails', async () => {
    const applied = [
      { id: 'lblGood', fields: { t: { valueType: 'text', text: ['Internal'] } } },
      appliedSelection,
    ];
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: applied })],
      ['drivelabels.googleapis.com', () => jsonResponse({ error: { message: 'nope' } }, 403)],
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res.labels).toEqual(['Internal']);
    expect(res.error).toBe('incomplete label resolution');
  });
});
