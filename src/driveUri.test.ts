import { describe, expect, it } from 'vitest';
import { parseDriveUri } from './driveUri.js';

const ID = '1AbC_dEf-GhIjKlMnOp';

describe('parseDriveUri', () => {
  it.each([
    [`https://docs.google.com/document/d/${ID}/edit`],
    [`https://docs.google.com/document/d/${ID}`],
    [`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=0`],
    [`https://docs.google.com/presentation/d/${ID}/edit?usp=drivesdk`],
    [`https://docs.google.com/drawings/d/${ID}/edit`],
    [`https://docs.google.com/forms/d/${ID}/edit`],
    [`https://drive.google.com/file/d/${ID}/view?usp=sharing`],
    [`https://drive.google.com/file/d/${ID}`],
    [`https://drive.google.com/drive/folders/${ID}`],
    [`https://drive.google.com/drive/folders/${ID}?usp=sharing`],
    [`https://drive.google.com/open?id=${ID}`],
    [`https://drive.google.com/uc?id=${ID}&export=download`],
  ])('accepts %s', (uri) => {
    expect(parseDriveUri(uri)).toEqual({ id: ID });
  });

  it.each([
    [`https://docs.google.com/document/u/1/d/${ID}/edit`],
    [`https://docs.google.com/u/2/spreadsheets/d/${ID}/edit`],
    [`https://drive.google.com/u/0/file/d/${ID}/view`],
    [`https://drive.google.com/drive/u/1/folders/${ID}`],
    [`https://drive.google.com/u/0/open?id=${ID}`],
    [`https://drive.google.com/u/3/uc?id=${ID}`],
  ])('accepts the /u/<n> variant %s', (uri) => {
    expect(parseDriveUri(uri)).toEqual({ id: ID });
  });

  it('keeps the resourcekey query parameter', () => {
    expect(parseDriveUri(`https://drive.google.com/file/d/${ID}/view?resourcekey=0-AbC_d-9`)).toEqual({
      id: ID,
      resourceKey: '0-AbC_d-9',
    });
    expect(parseDriveUri(`https://drive.google.com/drive/folders/${ID}?resourcekey=0-k`)).toEqual({ id: ID, resourceKey: '0-k' });
    expect(parseDriveUri(`https://docs.google.com/spreadsheets/d/${ID}/edit?resourcekey=0-k#gid=5`)).toEqual({ id: ID, resourceKey: '0-k' });
  });

  it('drops a malformed or empty resourcekey', () => {
    expect(parseDriveUri(`https://drive.google.com/file/d/${ID}/view?resourcekey=a%0Db`)).toEqual({ id: ID });
    expect(parseDriveUri(`https://drive.google.com/file/d/${ID}/view?resourcekey=`)).toEqual({ id: ID });
  });

  it.each([
    ['http', `http://docs.google.com/document/d/${ID}/edit`],
    ['another host', `https://example.com/document/d/${ID}/edit`],
    ['a lookalike host', `https://docs.google.com.evil.test/document/d/${ID}/edit`],
    ['a subdomain', `https://x.drive.google.com/file/d/${ID}/view`],
    ['a port', `https://drive.google.com:8443/file/d/${ID}/view`],
    ['credentials', `https://user:pw@drive.google.com/file/d/${ID}/view`],
    ['a missing id', 'https://docs.google.com/document/d/'],
    ['a short id', 'https://docs.google.com/document/d/abc123/edit'],
    ['a bad id character', `https://drive.google.com/file/d/${ID}!x/view`],
    ['an unknown docs type', `https://docs.google.com/sites/d/${ID}/edit`],
    ['a docs type on the drive host', `https://drive.google.com/document/d/${ID}/edit`],
    ['a file path on the docs host', `https://docs.google.com/file/d/${ID}/view`],
    ['open without an id', 'https://drive.google.com/open'],
    ['open with a short id', 'https://drive.google.com/open?id=short'],
    ['a published form', `https://docs.google.com/forms/d/e/${ID}/viewform`],
    ['a folder sub-path', `https://drive.google.com/drive/folders/${ID}/extra`],
    ['the drive root', 'https://drive.google.com/drive/my-drive'],
    ['a ui:// URI', 'ui://widget/drive'],
    ['a gdrive:// URI', `gdrive://${ID}`],
    ['garbage', 'not a url'],
    ['an empty string', ''],
  ])('rejects %s', (_label, uri) => {
    expect(parseDriveUri(uri)).toBeNull();
  });
});
