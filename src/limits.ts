// Budgets, deadlines and page sizes for reading files: the caps get_file and
// export_file share with MCP resources, and the resource-only ones. Tests
// derive their fixtures from these names, so changing a value is a one-line
// edit

const MiB = 1024 * 1024;

export const MAX_FILE_SIZE = 20 * MiB;

// The most characters of text a read returns, notes and links included
export const MAX_TEXT_CHARS = 200_000;

// Sheets: the widest column range read from any one tab. Wider tabs are read
// from column A up to this and carry a bounded-range note
export const SHEETS_MAX_COLUMNS_PER_TAB = 256;

// Sheets: cells with data across every tab of one read, charged in sheet order
// on what Sheets returns (trailing empty rows and columns trimmed). Also the
// most rows × columns any one tab is requested with
export const SHEETS_MAX_CELLS = 50_000;

// Sheets: the longest values.batchGet URL. Many tabs with long names turn into
// many long `ranges` parameters; the ranges go into another call rather than
// send a URL Google rejects
export const SHEETS_MAX_URL_CHARS = 8_000;

// Sheets: response body bytes for one Sheets call, read as a stream and
// checked before JSON parsing
export const SHEETS_MAX_BYTES_PER_CALL = 4 * MiB;

export const SHEETS_MAX_BYTES_PER_READ = 10 * MiB;

// Sheets: the most values.batchGet calls one read can make, the failed one
// included. It bounds the per-tab fallback after a multi-tab call passes the
// byte cap, and the calls a URL-length split may need. With spreadsheets.get,
// a read makes at most this many + 1 Sheets calls
export const SHEETS_MAX_VALUE_CALLS = 6;

export const RESOURCE_READ_DEADLINE_MS = 45_000;

export const RESOURCE_LIST_DEADLINE_MS = 20_000;

// resources/list: extra Drive pages fetched in the same request when a page
// has no usable entries but Drive says more exist
export const RESOURCE_LIST_MAX_EXTRA_PAGES = 2;

export const RESOURCE_LIST_PAGE_SIZE = 50;

export const FOLDER_LISTING_PAGE_SIZE = 200;

// Characters of a Sheets read kept for notes, so notes and fences always fit
// inside MAX_TEXT_CHARS
export const TEXT_NOTES_RESERVE_CHARS = 4_000;
