import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractPdfText, PdfTooLargeError } from './pdfText.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

describe('extractPdfText', () => {
  it('returns the text layer for a text-based PDF', async () => {
    const r = await extractPdfText(fixture('text-layer.pdf'));
    expect(r.scanned).toBe(false);
    expect(r.text).toContain('CONFIDENTIAL QUARTERLY REPORT');
    expect(r.pages).toBe(1);
    expect(r.textPages).toBe(1);
  });

  it('marks a scanned PDF as having no text pages', async () => {
    const r = await extractPdfText(fixture('scanned.pdf'));
    expect(r.scanned).toBe(true);
    expect(r.textPages).toBe(0);
    expect(r.text).toBe('');
  });

  it('rejects a PDF above the page cap', async () => {
    await expect(extractPdfText(fixture('text-layer.pdf'), { maxPages: 0 }))
      .rejects.toBeInstanceOf(PdfTooLargeError);
  });

  it('truncates an over-long text layer and flags it', async () => {
    const r = await extractPdfText(fixture('text-layer.pdf'), { maxChars: 20 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(20);
  });

  it('throws on an unparseable PDF rather than returning empty text', async () => {
    await expect(extractPdfText(new TextEncoder().encode('%PDF-not-really')))
      .rejects.toThrow();
  });
});
