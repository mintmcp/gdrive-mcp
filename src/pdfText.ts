/**
 * Extracts a PDF's text layer; per-page yield doubles as the scanned detector.
 */

import { getDocumentProxy } from 'unpdf';

export const SCANNED_MAX_CHARS_PER_PAGE = 50;
export const MAX_PDF_PAGES = 500;
export const MAX_TEXT_CHARS = 200_000;
export const EXTRACT_TIMEOUT_MS = 10_000;

export class PdfEncryptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfEncryptedError';
  }
}
export class PdfTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfTooLargeError';
  }
}
export class PdfTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfTimeoutError';
  }
}

export interface PdfText {
  text: string;
  pages: number;
  textPages: number;
  charsPerPage: number;
  scanned: boolean;
  truncated: boolean;
}

export interface ExtractOptions {
  maxPages?: number;
  maxChars?: number;
  timeoutMs?: number;
}

/** Throws PdfEncryptedError, PdfTooLargeError or PdfTimeoutError. */
export async function extractPdfText(bytes: Uint8Array, options: ExtractOptions = {}): Promise<PdfText> {
  const maxPages = options.maxPages ?? MAX_PDF_PAGES;
  const maxChars = options.maxChars ?? MAX_TEXT_CHARS;
  const timeoutMs = options.timeoutMs ?? EXTRACT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let pdf;
  try {
    pdf = await getDocumentProxy(bytes, { verbosity: 0 });
  } catch (err: any) {
    if (err?.name === 'PasswordException') {
      throw new PdfEncryptedError('the PDF is password-protected');
    }
    throw err;
  }

  try {
    const pages = pdf.numPages;
    if (!Number.isInteger(pages) || pages < 1) {
      throw new Error('the PDF reports no pages');
    }
    if (pages > maxPages) {
      throw new PdfTooLargeError(`the PDF has ${pages} pages, above the ${maxPages}-page limit`);
    }

    const parts: string[] = [];
    let chars = 0;
    let textPages = 0;
    let truncated = false;

    for (let pageNum = 1; pageNum <= pages; pageNum++) {
      if (Date.now() > deadline) {
        throw new PdfTimeoutError(`text extraction exceeded ${timeoutMs}ms`);
      }

      const page = await pdf.getPage(pageNum);
      try {
        const content = await page.getTextContent();
        // Items carry an end-of-line flag; keeping those breaks preserves the
        // paragraph layout. Fonts without a glyph map emit NUL for some
        // characters, which is noise rather than text
        const pageText = content.items
          .map((item: any) => (typeof item?.str === 'string' ? item.str + (item.hasEOL ? '\n' : ' ') : ''))
          .join('')
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
          .replace(/[ \t]+/g, ' ')
          .replace(/ ?\n ?/g, '\n')
          .trim();

        if (pageText.length >= SCANNED_MAX_CHARS_PER_PAGE) textPages++;

        if (!truncated && pageText) {
          const room = maxChars - chars;
          if (pageText.length > room) {
            parts.push(pageText.slice(0, Math.max(0, room)));
            truncated = true;
          } else {
            parts.push(pageText);
            chars += pageText.length;
          }
        }
      } finally {
        page.cleanup();
      }
    }

    const text = parts.join('\n').trim();
    return {
      text,
      pages,
      textPages,
      charsPerPage: Math.round(text.length / pages),
      scanned: textPages === 0,
      truncated,
    };
  } finally {
    await pdf.loadingTask.destroy().catch(() => {});
  }
}
