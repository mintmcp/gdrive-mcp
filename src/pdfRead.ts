// One PDF extraction for get_file and resources/read: the bytes handed to the
// parser safely, a failure logged once and returned as a reason, scanned
// files told apart. Rendering stays with the caller

import { extractPdfText, type ExtractOptions, type PdfText } from './pdfText.js';
import { errorFields, log } from './log.js';

export type PdfOutcome =
  | { outcome: 'failed'; reason: string }
  | { outcome: 'scanned'; pages: number; textPages: number }
  | { outcome: 'text'; pdf: PdfText };

// Under a caller's deadline, a failure once it has passed (or the signal has
// aborted) is rethrown as is: the deadline is the outcome, not a parse error
export async function readPdf(
  bytes: Buffer,
  options: ExtractOptions & { signal?: AbortSignal; deadlineAt?: number } = {},
): Promise<PdfOutcome> {
  const { signal, deadlineAt, ...extract } = options;
  const startedAt = Date.now();
  let pdf: PdfText;
  try {
    // The parser can detach the buffer it gets: hand it a view only when the
    // Buffer owns its whole ArrayBuffer (never a slice of Node's shared pool)
    const owned = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
    const data = owned ? new Uint8Array(bytes.buffer, 0, bytes.byteLength) : new Uint8Array(bytes);
    pdf = await extractPdfText(data, extract);
  } catch (err: any) {
    signal?.throwIfAborted();
    if (deadlineAt !== undefined && Date.now() >= deadlineAt) throw err;
    log('error', 'pdf_extraction_failed', {
      ...errorFields(err),
      bytes: bytes.byteLength,
      elapsedMs: Date.now() - startedAt,
    });
    return { outcome: 'failed', reason: err?.message || 'the PDF could not be parsed' };
  }
  if (pdf.scanned) return { outcome: 'scanned', pages: pdf.pages, textPages: pdf.textPages };
  return { outcome: 'text', pdf };
}
