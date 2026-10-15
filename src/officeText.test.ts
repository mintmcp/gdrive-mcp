import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { extractOfficeText, isOfficeMime } from './officeText.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const ODT = 'application/vnd.oasis.opendocument.text';
const ODS = 'application/vnd.oasis.opendocument.spreadsheet';
const ODP = 'application/vnd.oasis.opendocument.presentation';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./__fixtures__/${name}`, import.meta.url)));

const pkg = (parts: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(parts).map(([n, s]) => [n, strToU8(s)])));

describe('isOfficeMime', () => {
  it('covers the OOXML and OpenDocument types', () => {
    for (const m of [DOCX, XLSX, PPTX, ODT, ODS, ODP]) expect(isOfficeMime(m)).toBe(true);
  });
  it('leaves legacy binary Office and other types alone', () => {
    expect(isOfficeMime('application/msword')).toBe(false);
    expect(isOfficeMime('application/vnd.ms-excel')).toBe(false);
    expect(isOfficeMime('application/pdf')).toBe(false);
  });
});

describe('extractOfficeText on real files', () => {
  it('reads a Word document with headings, paragraphs and tables', () => {
    const r = extractOfficeText(fixture('tabs.docx'), DOCX);
    expect(r.truncated).toBe(false);
    expect(r.text).toContain('This is the first tab. The word SENTINEL-A appears here.');
    expect(r.text).toContain('| col A | col B |');
    expect(r.text).toContain('| 1 | 2 |');
    expect(r.text).toContain('Yeah this is tab 3');
    expect(r.text).toContain('| sweep | ok |');
  });

  it('reads a workbook as one CSV block per sheet, keeping blank rows out', () => {
    const r = extractOfficeText(fixture('sample.xlsx'), XLSX);
    expect(r.text).toBe([
      '# Q3 Revenue',
      'Region,Q3 Revenue,Growth',
      'EMEA,1284000,0.12',
      'APAC,962500,0.31',
      'AMER,2038900,0.07',
      'MAGIC-PHRASE-XLSX: this row proves the .xlsx cells were read.',
    ].join('\n'));
  });

  it('reads a deck slide by slide', () => {
    const r = extractOfficeText(fixture('deck.pptx'), PPTX);
    expect(r.text).toBe('# Slide 1\ngdrive-mcp create_file\nUploaded as .pptx, converted to Google Slides');
  });
});

describe('extractOfficeText on synthetic packages', () => {
  it('decodes entities, tabs and line breaks in a Word document', () => {
    const bytes = pkg({
      'word/document.xml':
        '<w:document><w:body>' +
        '<w:p><w:r><w:t xml:space="preserve">Tom &amp; Jerry</w:t><w:tab/><w:t>&#233;t&#xE9;</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>line one</w:t><w:br/><w:t>line two</w:t></w:r></w:p>' +
        '<w:p><w:r><w:instrText>HYPERLINK</w:instrText></w:r></w:p>' +
        '</w:body></w:document>',
    });
    expect(extractOfficeText(bytes, DOCX).text).toBe('Tom & Jerry\tété\nline one\nline two');
  });

  it('orders slides as the presentation lists them, falling back to numeric part order', () => {
    const slide = (s: string) => `<p:sld><p:txBody><a:p><a:r><a:t>${s}</a:t></a:r></a:p></p:txBody></p:sld>`;
    const unlisted = pkg({
      'ppt/slides/slide10.xml': slide('ten'),
      'ppt/slides/slide2.xml': slide('two'),
      'ppt/slides/slide1.xml': slide('one'),
      'ppt/slides/_rels/slide1.xml.rels': '<Relationships/>',
    });
    expect(extractOfficeText(unlisted, PPTX).text).toBe('# Slide 1\none\n# Slide 2\ntwo\n# Slide 3\nten');

    const listed = pkg({
      'ppt/presentation.xml': '<p:presentation><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
      'ppt/_rels/presentation.xml.rels':
        '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slide('first file'),
      'ppt/slides/slide2.xml': slide('second file'),
    });
    expect(extractOfficeText(listed, PPTX).text).toBe('# Slide 1\nsecond file\n# Slide 2\nfirst file');
  });

  it('resolves shared strings, booleans and sparse columns in a workbook', () => {
    const bytes = pkg({
      'xl/workbook.xml':
        '<workbook><sheets><sheet name="Second" sheetId="2" r:id="rId2"/><sheet name="First &amp; Co" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels':
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml':
        '<sst><si><t>hello, world</t></si><si><r><t>rich</t></r><r><t> text</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2"><f>SUM(1)</f><v>42</v></c><c r="C2" t="str"><v>say "hi"</v></c></row>' +
        '<row r="3"/>' +
        '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>only</t></is></c></row></sheetData></worksheet>',
    });
    expect(extractOfficeText(bytes, XLSX).text).toBe([
      '# Second',
      'only',
      '# First & Co',
      '"hello, world",,rich text',
      'TRUE,42,"say ""hi"""',
    ].join('\n'));
  });

  it('reads OpenDocument text, including headings and tables', () => {
    const bytes = pkg({
      'content.xml':
        '<office:document-content><office:body><office:text>' +
        '<text:h>Title</text:h>' +
        '<text:p>Hello<text:s/><text:span>there</text:span><text:line-break/>next</text:p>' +
        '<table:table table:name="T"><table:table-row>' +
        '<table:table-cell><text:p>a</text:p></table:table-cell><table:table-cell><text:p>b</text:p></table:table-cell>' +
        '</table:table-row></table:table>' +
        '</office:text></office:body></office:document-content>',
    });
    expect(extractOfficeText(bytes, ODT).text).toBe('Title\nHello there\nnext\n| a | b |');
  });

  it('reads an OpenDocument spreadsheet as CSV per named sheet, expanding repeated cells and dropping trailing blanks', () => {
    const bytes = pkg({
      'content.xml':
        '<office:document-content><office:body><office:spreadsheet>' +
        '<table:table table:name="Data"><table:table-row>' +
        '<table:table-cell><text:p>x,y</text:p></table:table-cell><table:table-cell/><table:table-cell><text:p>3</text:p></table:table-cell>' +
        '</table:table-row><table:table-row>' +
        '<table:table-cell table:number-columns-repeated="3"/><table:table-cell><text:p>D</text:p></table:table-cell>' +
        '<table:table-cell table:number-columns-repeated="1000"/>' +
        '</table:table-row></table:table>' +
        '</office:spreadsheet></office:body></office:document-content>',
    });
    expect(extractOfficeText(bytes, ODS).text).toBe('# Data\n"x,y",,3\n,,,D');
  });

  it('repeats OpenDocument rows, keeps covered (merged) cells in place, and bounds row width', () => {
    const bytes = pkg({
      'content.xml':
        '<office:document-content><office:body><office:spreadsheet>' +
        '<table:table table:name="S">' +
        '<table:table-row table:number-rows-repeated="2"><table:table-cell><text:p>r</text:p></table:table-cell></table:table-row>' +
        '<table:table-row><table:table-cell><text:p>A1</text:p></table:table-cell><table:covered-table-cell/><table:table-cell><text:p>C1</text:p></table:table-cell></table:table-row>' +
        '<table:table-row>' + '<table:table-cell table:number-columns-repeated="1000"/>'.repeat(40) + '<table:table-cell><text:p>far</text:p></table:table-cell></table:table-row>' +
        '</table:table></office:spreadsheet></office:body></office:document-content>',
    });
    const r = extractOfficeText(bytes, ODS);
    expect(r.text).toBe('# S\nr\nr\nA1,,C1');
  });

  it('keeps workbook and presentation parts the relationships name, whatever they are called', () => {
    const bytes = pkg({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/data.xml"/></Relationships>',
      'xl/worksheets/data.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
    });
    expect(extractOfficeText(bytes, XLSX).text).toBe('# Data\nx');
  });

  it('ignores a cell reference past the last Excel column instead of padding to it', () => {
    const bytes = pkg({
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="ZZZZZZZZ1" t="inlineStr"><is><t>far</t></is></c><c r="A1" t="inlineStr"><is><t>near</t></is></c></row></sheetData></worksheet>',
    });
    expect(extractOfficeText(bytes, XLSX).text).toBe('# Sheet1\nnear');
  });

  it('appends Word footnotes and endnotes after the body', () => {
    const bytes = pkg({
      'word/document.xml': '<w:document><w:body><w:p><w:r><w:t>body</w:t></w:r></w:p></w:body></w:document>',
      'word/footnotes.xml': '<w:footnotes><w:footnote><w:p><w:r><w:t>a footnote</w:t></w:r></w:p></w:footnote></w:footnotes>',
      'word/endnotes.xml': '<w:endnotes><w:endnote><w:p><w:r><w:t>an endnote</w:t></w:r></w:p></w:endnote></w:endnotes>',
    });
    expect(extractOfficeText(bytes, DOCX).text).toBe('body\na footnote\nan endnote');
  });

  it('refuses a package whose parts inflate past the size budget', () => {
    const huge = 'x'.repeat(70 * 1024 * 1024);
    const bytes = zipSync({
      'ppt/slides/slide1.xml': strToU8(huge),
      'ppt/slides/slide2.xml': strToU8(huge),
      'ppt/slides/slide3.xml': strToU8(huge),
      'ppt/slides/slide4.xml': strToU8(huge),
    });
    expect(() => extractOfficeText(bytes, PPTX)).toThrow(/inflates past/);
  });

  it('reads an OpenDocument presentation', () => {
    const bytes = pkg({
      'content.xml':
        '<office:document-content><office:body><office:presentation>' +
        '<draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>Slide text</text:p></draw:text-box></draw:frame></draw:page>' +
        '</office:presentation></office:body></office:document-content>',
    });
    expect(extractOfficeText(bytes, ODP).text).toBe('Slide text');
  });

  it('truncates at the character cap and flags it', () => {
    const paras = Array.from({ length: 50 }, (_, i) => `<w:p><w:r><w:t>paragraph ${i}</w:t></w:r></w:p>`).join('');
    const bytes = pkg({ 'word/document.xml': `<w:document><w:body>${paras}</w:body></w:document>` });
    const r = extractOfficeText(bytes, DOCX, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100);
    expect(r.text).toContain('paragraph 0');
  });

  it('rejects bytes that are not a zip package', () => {
    expect(() => extractOfficeText(new TextEncoder().encode('not a zip'), DOCX)).toThrow(/package/);
  });

  it('rejects a package missing its document part', () => {
    expect(() => extractOfficeText(pkg({ 'other.xml': '<x/>' }), DOCX)).toThrow(/word\/document.xml/);
  });

  it('rejects a MIME type it does not know', () => {
    expect(() => extractOfficeText(pkg({}), 'application/zip')).toThrow(/not an Office/);
  });
});
