import { describe, expect, it } from 'vitest';
import { capText, codeFence, detailsOnlyText, sliceChars, stripBom, typeName } from './resourceText.js';
import { MAX_TEXT_CHARS } from './pdfText.js';

const LINK = 'https://drive.google.com/file/d/abcdefghijk/view';

describe('codeFence', () => {
  it('is three backticks unless the text has a longer run', () => {
    expect(codeFence('plain')).toBe('```');
    expect(codeFence('a `` b')).toBe('```');
    expect(codeFence('a ``` b')).toBe('````');
    expect(codeFence('x ````` y ``')).toBe('``````');
  });
});

describe('capText (D10)', () => {
  it('returns short text and its notes unchanged', () => {
    expect(capText('body', LINK, { notes: ['Note: x.'] })).toBe('body\n\nNote: x.');
  });

  it('cuts the body so the truncation note, link and notes fit inside MAX_TEXT_CHARS', () => {
    const notes = ['Note: '.padEnd(500, 'n')];
    const out = capText('b'.repeat(MAX_TEXT_CHARS), LINK, { notes });
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(out).toMatch(new RegExp(`^b+\\n\\n\\[Truncated at \\d+ characters\\. Full file: ${LINK.replace(/[.]/g, '\\.')}\\]\\n\\nNote: n+$`));
    const kept = Number(out.match(/Truncated at (\d+)/)![1]);
    expect(out.startsWith('b'.repeat(kept) + '\n')).toBe(true);
  });

  it('adds the truncation note when the body was cut upstream', () => {
    expect(capText('short', LINK, { truncated: true })).toBe(`short\n\n[Truncated at 5 characters. Full file: ${LINK}]`);
  });

  it('never leaves half a surrogate pair', () => {
    const out = capText('😀'.repeat(MAX_TEXT_CHARS), LINK);
    expect(out.length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });
});

describe('small helpers', () => {
  it('strips a leading BOM only', () => {
    expect(stripBom('﻿a﻿')).toBe('a﻿');
  });

  it('slices by characters', () => {
    expect(sliceChars('abc', 2)).toBe('ab');
    expect(sliceChars('a😀', 2)).toBe('a');
    expect(sliceChars('abc', 0)).toBe('');
  });

  it('names types', () => {
    expect(typeName('application/vnd.google-apps.document')).toBe('Google Doc');
    expect(typeName('image/png')).toBe('image (image/png)');
    expect(typeName('application/zip')).toBe('application/zip');
  });
});

describe('detailsOnlyText (D9)', () => {
  it('gives the name, why, type, size and link as Markdown', () => {
    expect(detailsOnlyText({ name: 'Q3.pdf', mimeType: 'application/pdf', size: 123, link: LINK, why: 'It is scanned.' })).toBe(
      `# Q3.pdf\n\nIt is scanned. The content isn't included here. Open the file to read it: ${LINK}\n\n` +
      `- Type: PDF\n- Size: 123 bytes\n- Link: ${LINK}`,
    );
  });

  it('leaves out an unknown size', () => {
    expect(detailsOnlyText({ name: 'D', mimeType: 'application/vnd.google-apps.document', link: LINK, why: 'Big.' })).not.toContain('Size');
  });
});
