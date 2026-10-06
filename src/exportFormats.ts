// Short names for Drive's export MIME types. A file's own exportLinks decide
// which of them it accepts, so this only names formats and never gates them
const EXPORT_FORMATS: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  epub: 'application/epub+zip',
  zip: 'application/zip',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odp: 'application/vnd.oasis.opendocument.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  svg: 'image/svg+xml',
  json: 'application/vnd.google-apps.script+json',
};
const EXPORT_FORMAT_NAMES = Object.fromEntries(Object.entries(EXPORT_FORMATS).map(([n, m]) => [m, n]));

/**
 * Resolve export_file's `format` (a short name such as "pdf", or a MIME type)
 * against the file's exportLinks. An unavailable format lists the ones the
 * file does accept, so the caller can retry without guessing
 */
export function resolveExportFormat(
  format: string,
  exportLinks: Record<string, string>,
): { ok: true; mimeType: string; link: string } | { ok: false; error: string } {
  const requested = format.trim().toLowerCase().replace(/^\./, '');
  const mimeType = Object.hasOwn(EXPORT_FORMATS, requested) ? EXPORT_FORMATS[requested] : requested;
  const link = Object.hasOwn(exportLinks, mimeType) ? exportLinks[mimeType] : undefined;
  if (link) return { ok: true, mimeType, link };

  const available = Object.keys(exportLinks).map((m) => EXPORT_FORMAT_NAMES[m] ?? m);
  return {
    ok: false,
    error: `format "${format}" is not available for this file. Available formats: ${available.join(', ')}.`,
  };
}

export function exportKind(mimeType: string): 'text' | 'image' | 'binary' {
  if (mimeType.startsWith('text/') || mimeType === 'image/svg+xml' || mimeType.endsWith('+json')) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  return 'binary';
}
