// Budgets, deadlines and page sizes for MCP resources (resources/list and
// resources/read). Every tunable number of the resource code lives here, and
// tests derive their fixtures from these names, so changing a value is a
// one-line edit. The text cap (MAX_TEXT_CHARS) and file cap (MAX_FILE_SIZE) are
// the existing ones shared with get_file and export_file

const MiB = 1024 * 1024;

// Sheets: the widest column range read from any one tab. Wider tabs are read
// from column A up to this and carry a bounded-range note
export const SHEETS_MAX_COLUMNS_PER_TAB = 256;

// Sheets: requested cells across every tab of one read. Allocated to grid tabs
// in sheet order; a tab that gets 0 rows is left out
export const SHEETS_MAX_CELLS = 50_000;

// Sheets: requested cells in one values.batchGet call. Chunks are row-aligned,
// so a batch wastes less than one row (at most SHEETS_MAX_COLUMNS_PER_TAB - 1
// cells)
export const SHEETS_BATCH_MAX_CELLS = 10_000;

// Sheets: the longest values.batchGet URL. Many tabs with long names turn into
// many long `ranges` parameters; a batch closes early rather than send a URL
// Google rejects
export const SHEETS_MAX_URL_CHARS = 8_000;

// Sheets: response body bytes for one Sheets call, read as a stream and
// checked before JSON parsing
export const SHEETS_MAX_BYTES_PER_CALL = 4 * MiB;

// Sheets: response body bytes across every Sheets call of one read
export const SHEETS_MAX_BYTES_PER_READ = 10 * MiB;

// Sheets: the most values.batchGet calls one read can make. Every batch but
// the last holds more than SHEETS_BATCH_MAX_CELLS - SHEETS_MAX_COLUMNS_PER_TAB
// cells, so SHEETS_MAX_CELLS needs at most this many
export const SHEETS_MAX_VALUE_CALLS = Math.ceil(
  SHEETS_MAX_CELLS / (SHEETS_BATCH_MAX_CELLS - SHEETS_MAX_COLUMNS_PER_TAB + 1),
);

// One deadline per resources/read, carried as an AbortSignal through every
// Google call, retry wait and label lookup, and raced against PDF extraction
export const RESOURCE_READ_DEADLINE_MS = 45_000;

// One deadline per resources/list
export const RESOURCE_LIST_DEADLINE_MS = 20_000;

// resources/list: extra Drive pages fetched in the same request when a page
// has no usable entries but Drive says more exist
export const RESOURCE_LIST_MAX_EXTRA_PAGES = 2;

// resources/list: Drive files per page
export const RESOURCE_LIST_PAGE_SIZE = 50;

// resources/read of a folder: direct children listed
export const FOLDER_LISTING_PAGE_SIZE = 200;

// Characters of a Sheets read kept for notes, so notes and fences always fit
// inside MAX_TEXT_CHARS
export const TEXT_NOTES_RESERVE_CHARS = 4_000;
