// Turns a pasted or listed Google Drive link into a file id for resources/read.
// Only https links on Google's two hosts are accepted; anything else is not a
// Drive file as far as resources are concerned

export interface DriveUri {
  id: string;
  // Older link-shared files need their link's resource key on every request
  // (X-Goog-Drive-Resource-Keys)
  resourceKey?: string;
}

const ID = '[A-Za-z0-9_-]{10,}';
const ACCOUNT = '(?:/u/\\d+)?';
const ID_PATTERN = new RegExp(`^${ID}$`);
const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

// docs.google.com/{type}/d/<id>/..., with /u/<n> before or after the type
const DOCS_PATH = new RegExp(
  `^${ACCOUNT}/(?:document|spreadsheets|presentation|drawings|forms)${ACCOUNT}/d/(${ID})(?:/|$)`,
);
// drive.google.com/file/d/<id>/...
const FILE_PATH = new RegExp(`^${ACCOUNT}/file/d/(${ID})(?:/|$)`);
// drive.google.com/drive/folders/<id> and drive.google.com/drive/u/<n>/folders/<id>
const FOLDER_PATH = new RegExp(`^${ACCOUNT}/drive${ACCOUNT}/folders/(${ID})/?$`);
// drive.google.com/open?id=<id> and drive.google.com/uc?id=<id>
const QUERY_ID_PATH = new RegExp(`^${ACCOUNT}/(?:open|uc)/?$`);

export function parseDriveUri(uri: string): DriveUri | null {
  if (typeof uri !== 'string') return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password) return null;

  let id: string | undefined;
  if (url.hostname === 'docs.google.com') {
    id = url.pathname.match(DOCS_PATH)?.[1];
  } else if (url.hostname === 'drive.google.com') {
    id = url.pathname.match(FILE_PATH)?.[1] ?? url.pathname.match(FOLDER_PATH)?.[1];
    if (!id && QUERY_ID_PATH.test(url.pathname)) {
      const fromQuery = url.searchParams.get('id') ?? '';
      if (ID_PATTERN.test(fromQuery)) id = fromQuery;
    }
  }
  if (!id) return null;

  // A malformed key is dropped, not trusted: the read then goes out without it
  const resourceKey = url.searchParams.get('resourcekey') ?? '';
  return RESOURCE_KEY_PATTERN.test(resourceKey) ? { id, resourceKey } : { id };
}
