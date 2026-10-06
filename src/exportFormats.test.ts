import { describe, it, expect } from 'vitest';
import { resolveExportFormat, exportKind } from './exportFormats.js';

const DOC_EXPORT_LINKS = {
  'text/markdown': 'https://docs.google.com/feeds/download/documents/export/Export?id=d1&exportFormat=md',
  'application/pdf': 'https://docs.google.com/feeds/download/documents/export/Export?id=d1&exportFormat=pdf',
  'application/vnd.oasis.opendocument.text': 'https://docs.google.com/feeds/download/documents/export/Export?id=d1&exportFormat=odt',
  'application/x-custom': 'https://docs.google.com/x',
};

describe('resolveExportFormat', () => {
  it('maps a short name to its MIME type and export link', () => {
    expect(resolveExportFormat('pdf', DOC_EXPORT_LINKS)).toEqual({
      ok: true, mimeType: 'application/pdf', link: DOC_EXPORT_LINKS['application/pdf'],
    });
  });

  it('accepts case, surrounding space and a leading dot', () => {
    const r = resolveExportFormat(' .MD ', DOC_EXPORT_LINKS);
    expect(r.ok && r.mimeType).toBe('text/markdown');
  });

  it('accepts a MIME type the file offers', () => {
    const r = resolveExportFormat('application/vnd.oasis.opendocument.text', DOC_EXPORT_LINKS);
    expect(r.ok && r.mimeType).toBe('application/vnd.oasis.opendocument.text');
  });

  it('does not match an inherited property of exportLinks', () => {
    // exportLinks.constructor exists on every object, so a plain lookup would accept it
    expect(resolveExportFormat('constructor', DOC_EXPORT_LINKS).ok).toBe(false);
  });

  it('lists what the file accepts, by short name where one exists', () => {
    const r = resolveExportFormat('xlsx', DOC_EXPORT_LINKS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('Available formats: md, pdf, odt, application/x-custom.');
  });
});

describe('exportKind', () => {
  it('returns text formats as text', () => {
    for (const m of ['text/markdown', 'text/csv', 'image/svg+xml', 'application/vnd.google-apps.script+json']) {
      expect(exportKind(m)).toBe('text');
    }
  });

  it('returns raster images as images and the rest as binary', () => {
    expect(exportKind('image/png')).toBe('image');
    expect(exportKind('application/pdf')).toBe('binary');
    expect(exportKind('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('binary');
  });
});
