// Test-only: the extractor outcome resources/read tests drive. A module of its
// own, with no imports, so a vi.mock factory can load it outside any cycle

import type { PdfText } from './pdfText.js';

export const extract = {
  impl: undefined as undefined | ((bytes: Uint8Array, options: any) => Promise<PdfText>),
};
