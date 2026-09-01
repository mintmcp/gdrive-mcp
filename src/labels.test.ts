import { describe, it, expect, vi, afterEach } from 'vitest';
import { getLabelInfo, getFileLabels } from './labels.js';
import { stubFetch, jsonResponse, LABEL_SCHEMA_BODY } from './testStubs.js';

describe('getLabelInfo', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns the label title and maps choiceId -> displayName, skipping nameless choices', async () => {
    stubFetch([['drivelabels.googleapis.com', () => jsonResponse({
      properties: { title: 'Classification' },
      ...LABEL_SCHEMA_BODY,
    })]]);
    const info = await getLabelInfo('lbl1', 'rev7', 'tok');
    expect(info.title).toBe('Classification');
    expect(info.choices).toEqual({ field1: { choiceA: 'Confidential', choiceB: 'Internal' } });
  });

  it('requests the exact applied revision with LABEL_VIEW_FULL', async () => {
    const calls = stubFetch([['drivelabels.googleapis.com', () => jsonResponse(LABEL_SCHEMA_BODY)]]);
    await getLabelInfo('lbl1', 'rev7', 'tok');
    expect(calls[0].url).toContain('/labels/lbl1@rev7?view=LABEL_VIEW_FULL');
  });

  it('never reuses a fetch across calls: each request re-authorizes with its own token', async () => {
    const calls = stubFetch([['drivelabels.googleapis.com', () => jsonResponse(LABEL_SCHEMA_BODY)]]);
    await getLabelInfo('lbl1', 'rev7', 'tokUserA');
    await getLabelInfo('lbl1', 'rev7', 'tokUserB');
    expect(calls.length).toBe(2);
  });
});

describe('getFileLabels', () => {
  afterEach(() => vi.unstubAllGlobals());

  const infoRoute = (title: string): [string, (url: string) => Response] =>
    ['drivelabels.googleapis.com', () => jsonResponse({ properties: { title }, ...LABEL_SCHEMA_BODY })];

  it('returns an empty applied list for an unlabeled file', async () => {
    stubFetch([['listLabels', () => jsonResponse({ labels: [] })]]);
    const res = await getFileLabels('f1', 'tok');
    expect(res).toEqual({ applied: [] });
  });

  it('surfaces a title-only badge label with its resolved title and no values', async () => {
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: [{ id: 'lblBadge', revisionId: 'rev1' }] })],
      infoRoute('Confidential'),
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res).toEqual({ applied: [{
      labelId: 'lblBadge', revisionId: 'rev1', title: 'Confidential', resolved: true, values: [],
    }] });
  });

  it('resolves selection values keeping both choiceId and displayName', async () => {
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: [{
        id: 'lbl1', revisionId: 'rev7',
        fields: { field1: { valueType: 'selection', selection: ['choiceA'] } },
      }] })],
      infoRoute('Classification'),
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res).toEqual({ applied: [{
      labelId: 'lbl1', revisionId: 'rev7', title: 'Classification', resolved: true,
      values: [{ fieldId: 'field1', valueType: 'selection', choiceId: 'choiceA', displayName: 'Confidential', resolved: true }],
    }] });
  });

  it('keeps an unresolved choice id, marks it unresolved, and flags the miss', async () => {
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: [{
        id: 'lbl1', revisionId: 'rev7',
        fields: { field1: { valueType: 'selection', selection: ['choiceUnknown'] } },
      }] })],
      infoRoute('Classification'),
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res.applied[0].values).toEqual([
      { fieldId: 'field1', valueType: 'selection', choiceId: 'choiceUnknown', resolved: false },
    ]);
    expect(res.applied[0].resolved).toBe(true);
    expect(res.error).toBe('incomplete label resolution');
  });

  it('surfaces text, date, and integer values and withholds user fields with a skip code', async () => {
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: [{
        id: 'lbl2',
        fields: {
          t: { valueType: 'text', text: ['Internal note'] },
          d: { valueType: 'dateString', dateString: ['2026-09-30'] },
          i: { valueType: 'integer', integer: ['3'] },
          u: { valueType: 'user', user: [{ emailAddress: 'a@b.c' }] },
        },
      }] })],
      infoRoute('Document Control'),
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res.applied[0].values).toEqual([
      { fieldId: 't', valueType: 'text', value: 'Internal note' },
      { fieldId: 'd', valueType: 'date', value: '2026-09-30' },
      { fieldId: 'i', valueType: 'integer', value: '3' },
    ]);
    expect(res.applied[0].skippedValueTypes).toEqual(['user']);
    expect(res.error).toBeUndefined();
  });

  it('caps text values and flags the truncation', async () => {
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: [{
        id: 'lbl2', fields: { t: { valueType: 'text', text: ['x'.repeat(1000)] } },
      }] })],
      infoRoute('Notes'),
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect((res.applied[0].values[0] as any).value).toHaveLength(256);
    expect(res.applied[0].skippedValueTypes).toEqual(['truncatedText']);
  });

  it('keeps other labels when one label lookup fails, id-only with resolved false', async () => {
    let infoCall = 0;
    stubFetch([
      ['listLabels', () => jsonResponse({ labels: [
        { id: 'lblFail', fields: { f: { valueType: 'selection', selection: ['choiceA'] } } },
        { id: 'lblGood', fields: { t: { valueType: 'text', text: ['Internal'] } } },
      ] })],
      ['drivelabels.googleapis.com', () => {
        infoCall += 1;
        return infoCall === 1
          ? jsonResponse({ error: { message: 'nope' } }, 403)
          : jsonResponse({ properties: { title: 'Good' }, ...LABEL_SCHEMA_BODY });
      }],
    ]);
    const res = await getFileLabels('f1', 'tok');
    const fail = res.applied.find((l) => l.labelId === 'lblFail')!;
    const good = res.applied.find((l) => l.labelId === 'lblGood')!;
    expect(fail.resolved).toBe(false);
    expect(fail.title).toBeUndefined();
    expect(fail.values).toEqual([{ fieldId: 'f', valueType: 'selection', choiceId: 'choiceA', resolved: false }]);
    expect(good).toEqual({
      labelId: 'lblGood', title: 'Good', resolved: true,
      values: [{ fieldId: 't', valueType: 'text', value: 'Internal' }],
    });
    expect(res.error).toBe('incomplete label resolution');
  });

  it('looks up every applied label, the field-less ones included', async () => {
    const calls = stubFetch([
      ['listLabels', () => jsonResponse({ labels: [{ id: 'lblBadge' }, { id: 'lblBadge2' }] })],
      infoRoute('Badge'),
    ]);
    await getFileLabels('f1', 'tok');
    expect(calls.filter((c) => c.url.includes('drivelabels.googleapis.com')).length).toBe(2);
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
      infoRoute('Notes'),
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(page).toBe(2);
    expect(res.applied).toHaveLength(1);
  });

  it('stops at the page cap and reports the partial read as a failure', async () => {
    let page = 0;
    stubFetch([
      ['listLabels', () => {
        page += 1;
        return jsonResponse({
          labels: [{ id: `lbl${page}` }],
          nextPageToken: 'again',
        });
      }],
      infoRoute('Notes'),
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(page).toBe(10);
    expect(res.applied).toHaveLength(10);
    expect(res.error).toBe('label read failed');
  });

  it('flags "label read failed" when listLabels errors (e.g. missing scope 403)', async () => {
    stubFetch([
      ['listLabels', () => jsonResponse({ error: { message: 'insufficient scope' } }, 403)],
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res).toEqual({ applied: [], error: 'label read failed' });
  });

  it('first error wins: a read failure is not overwritten by a later resolve miss', async () => {
    let page = 0;
    stubFetch([
      ['listLabels', () => {
        page += 1;
        return page === 1
          ? jsonResponse({
              labels: [{ id: 'lbl1', revisionId: 'rev7', fields: { field1: { valueType: 'selection', selection: ['choiceUnknown'] } } }],
              nextPageToken: 'p2',
            })
          : jsonResponse({ error: { message: 'insufficient scope' } }, 403);
      }],
      infoRoute('Classification'),
    ]);
    const res = await getFileLabels('f1', 'tok');
    expect(res.applied).toHaveLength(1);
    expect(res.error).toBe('label read failed');
  });
});

