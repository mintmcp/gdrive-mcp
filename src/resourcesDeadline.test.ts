import { describe, expect, it, vi } from 'vitest';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import type { PdfText } from './pdfText.js';
import { RESOURCE_READ_DEADLINE_MS } from './limits.js';
import {
  ID, LABEL_ROUTES, SECRET, WEB, asUser, connect, extract, googleError, isMeta, json, logLines, meta, readError, records,
  stall, stubFetch, useResourceFixtures,
} from './resourcesTestKit.js';

// resources/read hands PDFs to the unchanged extractor; tests drive its outcome
vi.mock('./pdfText.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./pdfText.js')>();
  const { extract } = await import('./pdfExtractStub.js');
  return {
    ...actual,
    extractPdfText: vi.fn((bytes: Uint8Array, options: any) =>
      extract.impl ? extract.impl(bytes, options) : actual.extractPdfText(bytes, options)),
  };
});

useResourceFixtures();

describe('resources/read', () => {
  describe('deadline (D16)', () => {
    async function readWithClock(uri: string, profile: string) {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const client = await connect(profile);
      let settled = false;
      const pending = asUser(() => client.readResource({ uri })).then(
        (r) => ({ ok: r }),
        (e) => ({ err: e }),
      ).finally(() => (settled = true));
      return { pending, isSettled: () => settled };
    }

    it('fails at the deadline when the label lookup stalls, and the label request got the abort signal', async () => {
      let labelInit: RequestInit | undefined;
      stubFetch([
        [isMeta, () => json(meta('text/plain', { size: '1' }))],
        ['alt=media', () => new Response('fast', { status: 200 })],
        ['listLabels', (_url, init) => {
          labelInit = init;
          return stall(init);
        }],
      ]);
      const { pending, isSettled } = await readWithClock(WEB(), 'full');
      await vi.advanceTimersByTimeAsync(RESOURCE_READ_DEADLINE_MS - 1);
      expect(isSettled()).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const outcome: any = await pending;
      expect(outcome.err).toBeInstanceOf(McpError);
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain(`Reading this file timed out after ${RESOURCE_READ_DEADLINE_MS / 1000} s`);
      expect(labelInit?.signal?.aborted).toBe(true);
      expect(records().find((r: any) => r.event === 'resource_read_error')).toMatchObject({ code: 'deadline_exceeded' });
    });

    it('fails at the deadline when a Sheets batch stalls', async () => {
      let batchInit: RequestInit | undefined;
      stubFetch([
        [isMeta, () => json(meta('application/vnd.google-apps.spreadsheet'))],
        ['values:batchGet', (_url, init) => {
          batchInit = init;
          return stall(init);
        }],
        ['sheets.googleapis.com', () => json({ sheets: [{ properties: { sheetId: 0, title: 'T', index: 0, sheetType: 'GRID', gridProperties: { rowCount: 1, columnCount: 1 } } }] })],
      ]);
      const { pending } = await readWithClock(`https://docs.google.com/spreadsheets/d/${ID}/edit`, 'standard-resources');
      await vi.advanceTimersByTimeAsync(RESOURCE_READ_DEADLINE_MS);
      const outcome: any = await pending;
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain('timed out');
      expect(batchInit?.signal?.aborted).toBe(true);
    });

    it('fails at the deadline on a stalled PDF page after metadata, download and labels finished, and ignores a late result', async () => {
      let release!: (value: PdfText) => void;
      let extractionStarted = false;
      extract.impl = () => {
        extractionStarted = true;
        return new Promise<PdfText>((resolve) => (release = resolve));
      };
      const calls = stubFetch([
        [isMeta, () => json(meta('application/pdf', { size: '10' }))],
        ['alt=media', () => new Response(Buffer.from('%PDF-1.4'), { status: 200 })],
        ...LABEL_ROUTES,
      ]);
      const { pending, isSettled } = await readWithClock(WEB(), 'full');
      await vi.advanceTimersByTimeAsync(1);
      expect(extractionStarted).toBe(true);
      expect(calls.some((c) => c.url.includes('drivelabels'))).toBe(true);

      await vi.advanceTimersByTimeAsync(RESOURCE_READ_DEADLINE_MS);
      expect(isSettled()).toBe(true);
      const outcome: any = await pending;
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain('timed out');

      // The abandoned extraction finishing later changes nothing
      release({ text: 'late', pages: 1, textPages: 1, charsPerPage: 4, scanned: false, truncated: false });
      await vi.advanceTimersByTimeAsync(1);
      expect(outcome.ok).toBeUndefined();
    });

    it('reports a failed extraction after the deadline as the timeout, not as D9', async () => {
      let fail!: (err: Error) => void;
      extract.impl = () => new Promise<PdfText>((_, reject) => (fail = reject));
      stubFetch([
        [isMeta, () => json(meta('application/pdf', { size: '10' }))],
        ['alt=media', () => new Response(Buffer.from('%PDF-1.4'), { status: 200 })],
      ]);
      const { pending } = await readWithClock(WEB(), 'standard-resources');
      await vi.advanceTimersByTimeAsync(RESOURCE_READ_DEADLINE_MS);
      fail(new Error('text extraction exceeded 10000ms'));
      const outcome: any = await pending;
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain('timed out');
    });

    // A synchronous final page blocks the event loop past the deadline, then
    // settles before the deadline timer gets to run
    it.each([false, true])('reports work that blocked past the deadline as the timeout, before the timer fires (extraction fails: %s)', async (fails) => {
      extract.impl = async () => {
        vi.setSystemTime(Date.now() + RESOURCE_READ_DEADLINE_MS + 1);
        if (fails) throw new Error('synthetic final page error');
        return { text: 'late', pages: 1, textPages: 1, charsPerPage: 4, scanned: false, truncated: false };
      };
      stubFetch([
        [isMeta, () => json(meta('application/pdf', { size: '10' }))],
        ['alt=media', () => new Response(Buffer.from('%PDF-1.4'), { status: 200 })],
      ]);
      const { pending } = await readWithClock(WEB(), 'standard-resources');
      const outcome: any = await pending;
      expect(outcome.ok).toBeUndefined();
      expect(outcome.err.code).toBe(-32603);
      expect(outcome.err.message).toContain('timed out');
      expect(records().some((r: any) => r.event === 'pdf_extraction_failed')).toBe(false);
    });

    it('returns a fast PDF read that finishes before the deadline', async () => {
      extract.impl = async () => {
        vi.setSystemTime(Date.now() + RESOURCE_READ_DEADLINE_MS - 1);
        return { text: 'in time', pages: 1, textPages: 1, charsPerPage: 7, scanned: false, truncated: false };
      };
      stubFetch([
        [isMeta, () => json(meta('application/pdf', { size: '10' }))],
        ['alt=media', () => new Response(Buffer.from('%PDF-1.4'), { status: 200 })],
      ]);
      const { pending } = await readWithClock(WEB(), 'standard-resources');
      const outcome: any = await pending;
      expect(outcome.ok.contents[0]).toMatchObject({ mimeType: 'text/plain' });
    });

    it('returns an early content error at once and aborts the pending label lookup with it', async () => {
      let labelInit: RequestInit | undefined;
      stubFetch([
        [isMeta, () => googleError(404, 'notFound')],
        ['listLabels', (_url, init) => {
          labelInit = init;
          return stall(init);
        }],
      ]);
      const { pending, isSettled } = await readWithClock(WEB(), 'full');
      await vi.advanceTimersByTimeAsync(1);
      expect(isSettled()).toBe(true);
      const outcome: any = await pending;
      expect(outcome.err.code).toBe(-32002);
      expect(labelInit?.signal?.aborted).toBe(true);
    });
  });

  describe('logging', () => {
    it('logs a failed read with status and reason, never the URI, id, name or token', async () => {
      stubFetch([[isMeta, () => googleError(403, 'insufficientFilePermissions', `No access to ${SECRET}`)]]);
      const err = await readError(`https://docs.google.com/document/d/${ID}/edit?resourcekey=0-${SECRET.slice(0, 5)}`);
      expect(err.message).toContain(SECRET);
      const record = records().find((r: any) => r.event === 'resource_read_error');
      const { ts, ...rest } = record;
      expect(rest).toEqual({ level: 'warn', event: 'resource_read_error', status: 403, reason: 'insufficientFilePermissions' });
      expect(logLines().join('')).not.toContain(SECRET);
      expect(logLines().join('')).not.toContain(ID);
    });

    it('logs a refused link with its own code', async () => {
      stubFetch([]);
      await readError('ui://widget/x');
      const { ts, ...rest } = records().find((r: any) => r.event === 'resource_read_error');
      expect(rest).toEqual({ level: 'warn', event: 'resource_read_error', code: 'not_drive_link' });
    });
  });
});
