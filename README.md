# gdrive-mcp

Google Drive MCP server for the MintMCP hosted runtime. Wraps the Google
Drive v3 REST API as a streamable-HTTP MCP server that the MintMCP frontend
fronts with OAuth — every request arrives carrying the user's Google access
token as `Authorization: Bearer <token>`, which the server forwards to Drive.
The container is stateless, listens on port 8000, and ships as a multi-stage
`node:22-slim` image.

## Auth contract

The server takes the user's Google access token **per request** from the
HTTP `Authorization` header. Credentials never live in the container; the
MintMCP frontend owns OAuth (client ID/secret, refresh, scope grants) and
forwards a short-lived access token for each MCP call. The only deployment
configuration is the `PROFILE` env var (see [Profiles](#profiles)).

Required Google OAuth scopes (configured on the MintMCP connector):

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/drive.labels.readonly` — optional, only in
  the `labels` and `full` profiles; enables the label enrichment of
  `get_file` and `resources/read` (see [Drive label enrichment](#drive-label-enrichment))

Reading a Google Sheet as a resource uses the Google Sheets API under
`drive.readonly`, so the Google Cloud project behind the OAuth client needs
the Sheets API enabled. No extra scope.

## Tools

| Category        | Tool                   | Notes                                                      |
|-----------------|------------------------|------------------------------------------------------------|
| Search / find   | `search_files`         | Drive `q` syntax + optional `mime_type` and `drive_id`.    |
|                 | `list_recent_files`    | Most recently modified files, newest first; excludes folders/trash. |
| Read / get      | `get_file`             | Up to 20MB; text / image / pdf. Rejects Google-native docs.|
|                 | `export_file`          | Google-native docs to md, pdf, docx, xlsx, csv, pptx, png… |
|                 | `get_file_metadata`    | Full metadata for any file/folder; no download.            |
|                 | `get_file_permissions` | Lists who has access and at what role.                     |
| Move / share    | `move_file`            | True move; removes the item from its previous parents.     |
|                 | `share_file`           | user / domain / anyone permissions; no email by default.   |
|                 | `update_file_metadata` | Rename / set description / star; metadata only.            |
|                 | `trash_file`           | Reversible move to trash (not a permanent delete).         |
| Create / copy   | `create_folder`        | Optional `parent_folder_id` for nesting.                   |
|                 | `copy_file`            | Rename, destination folder, `copy_comments`; not folders.  |
| Upload          | `upload_file`          | Text or base64 content; optional convert to a Google type. |

Every tool declares both `inputSchema` and `outputSchema`. JSON-shaped
results (metadata, IDs, search hits, text file bodies) return
`structuredContent` alongside the text block. Images from `get_file` and
`export_file` also come back as a `type: "image"` block, and `export_file`'s
binary formats (pdf, docx, xlsx, pptx, ...) as a `type: "resource"` block
with the base64 payload and the export link as its `uri`. Errors route
through a single envelope with HTTP status, reason, and a corrective hint.

## Drive label enrichment

On deployments whose grant includes `drive.labels.readonly`, `get_file`
surfaces the file's applied Drive labels on the tool result's
`_meta.applied`: one entry per applied label, `{labelId, revisionId, title,
resolved, values}`, where `values` carries the label's field values
(`selection` with both `choiceId` and `displayName`, plus `text`, `date`,
`integer`; person fields are withheld and flagged via `skippedValueTypes`).
Title-only badge labels appear with a resolved `title` and empty `values`.
`get_file_metadata` additionally returns the same `applied` tree in its
visible result as `labels` (labels are metadata, agents can answer
classification questions from it); `get_file` keeps labels in `_meta` only.
Policy should match ids (labelId/fieldId/choiceId); titles and display names
are human overlays. `_meta.labelsError` flags a failed read or resolution.
Without the scope, the label API calls are skipped entirely and no `_meta`
is returned; absence means "surfacing not enabled", never "no labels".
`resources/read` attaches the same `_meta` as `get_file` (see
[Resources](#resources)).

## Resources

The server also serves MCP resources (capability `resources: {}`, no
`subscribe` or `listChanged`), so a client such as Claude's Project
**Context** picker can list Drive files and add them as text. Resources are
a profile **feature** (see [Profiles](#profiles)): only a profile that lists
`resources` serves them, and the grant must include `drive.readonly`. Today
that is `standard-resources` and `full`; `standard` and `labels` keep the
surface their users connected with. The boot log's `tool_surface` line says
`resources: true|false`.

**`resources/list`** returns one page of recent files, newest first
(`modifiedTime desc`, 50 per page, My Drive and every shared drive, trashed
items excluded): folders, Google Docs, Sheets and Slides, PDFs and text
files. Office files, images and other types aren't listed. Each resource's
`uri` is the file's Drive `webViewLink`; `mimeType` is the type `read`
returns; `_meta` carries `driveFileId`, `driveMimeType`, `modifiedTime` and,
when Drive reports one, `driveSize` (the source file's bytes; there is no
`size`, because `read` returns converted text). Pages chain through
`nextCursor`. When Drive reports an incomplete all-drives search, the page
carries `_meta.incompleteSearch: true`; a file Drive didn't search can still
be added by pasting its link. `resources/templates/list` returns an empty
list.

**`resources/read`** takes a Drive or Docs link, listed or pasted, on
`https://docs.google.com` or `https://drive.google.com`, each with an
optional `/u/<n>`:

- `docs.google.com/{document|spreadsheets|presentation|drawings|forms}/d/<id>/…`
- `drive.google.com/file/d/<id>/…`
- `drive.google.com/drive/folders/<id>`, `drive.google.com/drive/u/<n>/folders/<id>`
- `drive.google.com/open?id=<id>`, `drive.google.com/uc?id=<id>`

A link's `resourcekey` parameter is sent as `X-Goog-Drive-Resource-Keys` on
every request for that file, which older link-shared files need.

| Type | Returned text | `mimeType` |
|---|---|---|
| Google Doc | Drive export as Markdown | `text/markdown` |
| Google Sheet | Every grid tab through the Sheets API: `# <tab name>` (hidden tabs marked) and the tab's CSV in a code block, within the limits below. Non-grid tabs (charts, data sources) are named as skipped | `text/markdown` |
| Google Slides | Drive export as plain text | `text/plain` |
| Folder | `# <folder name>` and its direct children (up to 200, folders first) as links with their type; their contents aren't included | `text/markdown` |
| PDF | The text layer, as `get_file` extracts it, with a note when only some pages carry text | `text/plain` |
| Text file | The file as UTF-8 | the file's own type |
| Anything else | Error `-32002`, saying what the file is, with its link | — |

A file too big to read (over Google's 10 MB export limit, or over 20 MB for
PDFs and text files), a scanned PDF, and a PDF whose text can't be extracted
still read successfully: the text is a short Markdown note with the file's
name, type, size, link and why the content isn't included.

A keyed Sheet link the Sheets API refuses falls back to Drive's CSV export of
the first tab, with a note saying so.

Limits, all in `src/limits.ts`:

- text is capped at 200,000 characters (`MAX_TEXT_CHARS`, as `get_file` and
  `export_file`), notes and links included, with a truncation note and the
  file link;
- Sheets: every tab is requested whole (never split), up to 256 columns and
  50,000 cells per tab, usually all in one `values.batchGet` call (at most
  6). The 50,000-cell budget per read counts the cells with data that Sheets
  returns, charged in sheet order; the tab that crosses it is cut and later
  tabs are left out. Each response is capped at 4 MiB and the read at
  10 MiB, checked while streaming; when a call over several tabs passes the
  cap, tabs are read one per call. A tab read only in part carries a note
  with the range read and the sheet link; tabs left out are named;
- one 45 s deadline per read and 20 s per list. A read that passes it fails
  with "timed out"; there is no partial content.

Errors are JSON-RPC errors: `-32002` for a file Drive can't find or a link
that isn't a Drive file, `-32602` for a stale `cursor`, `-32603` for
anything else, with the same message and hint as the tools (a 401 says to
reconnect Google). Failures are logged as `resource_list_error` /
`resource_read_error` with `status`, `reason` and `code` only.

On a profile with both the `resources` feature and the labels scope (today
`full`), every successful read (including the short notes and folder
listings) carries the same top-level `_meta` labels as `get_file`:
`{ applied, labelsError? }`. `resources/list`
does no label check, like `search_files`. The Google Drive folder allowlist
middleware doesn't cover resources: the list can show files outside the
allowed folders.

## Profiles

A **profile** (`PROFILES` in `src/scopes.ts`) is a frozen, named set of
scopes and features — a connector's contract with its users:

| Profile              | Scopes                                                    | Features    |
|----------------------|-----------------------------------------------------------|-------------|
| `standard`           | `drive.readonly` + `drive.file`                           |             |
| `standard-resources` | `drive.readonly` + `drive.file`                           | `resources` |
| `labels`             | `drive.readonly` + `drive.file` + `drive.labels.readonly` |             |
| `full`               | `drive` + `drive.labels.readonly`                         | all         |

A **feature** (`FEATURES` in `src/scopes.ts`) is a capability no Google
scope distinguishes, so it can't ride on the scope set the way label
enrichment does. `resources` is the first. Two profiles with the same
scopes and different features request the same Google grant, so a user can
move from one connector to the other without a new consent screen.

Each tool declares the Google scope it needs (the first argument to
`requirePermissionSecure` in `src/tools.ts`):

| Scope                   | Tools                                                   |
|-------------------------|---------------------------------------------------------|
| `drive.readonly`        | `search_files`, `list_recent_files`, `get_file`, `export_file`, `get_file_metadata`, `get_file_permissions`, and the [resources](#resources) (with the `resources` feature) |
| `drive.file`            | `copy_file`, `create_folder`, `move_file`, `share_file`, `update_file_metadata`, `trash_file`, `upload_file` |
| `drive.labels.readonly` | `get_file` and `resources/read` label enrichment (`_meta`), no tool of its own |

Each deployment selects a profile via the `PROFILE` env var. At startup the
server registers only the tools that profile's scopes cover and the
features it lists, so a tool is never advertised that can only ever return
403. Full `drive` counts as
covering `drive.file` and `drive.readonly`, because Google's grant is a
superset. An unknown profile name crashes at boot rather than silently
serving every tool; the boot log prints the granted scope set and the
resulting tool list.

**Frozen profiles never change.** Editing a profile's scopes forces every
user of its connectors to re-consent in Google — the thing this design
exists to avoid. Adding a feature to a frozen profile changes what its
existing users get without warning, which is the same kind of break. A new
scope or feature lands in `full` first, and gets a frozen profile of its
own (a new entry in `deployments.yml` plus a new registry entry) only when
someone wants it in isolation. Existing connectors keep working untouched,
forever.

**`full` is the evolving profile.** It always covers everything the
connector can do, and it grows: choosing it is consent to future scope
requests. When `full` gains a scope, existing users see the new tools fail
with a "reconnect your Google account" hint until they reconnect. Update
the brokered registry entry's scopes in the same change — nothing validates
the two against each other yet.

**Unset means every tool and feature registers.** That is the default for
anyone running their own copy who hasn't thought about scopes yet. Shipping
a tool that needs a scope no profile grants, or a feature no profile lists,
is therefore safe: it stays invisible everywhere until a profile lists it.

## Local development

```bash
npm install
npm run dev               # tsx watch
npm test                  # vitest unit tests
PROFILE=standard npm start   # run with a profile's tool surface
npm run smoke             # docker build + boot + tools/list smoke
```

To poke at a locally running server:

```bash
curl -s http://localhost:8000/healthz
# {"status":"ok"}

curl -s -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer fake-token" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}'
# lists the tools the active profile registers (all 12 when PROFILE is unset)
```

A fake token returns a structured 401 from the Drive API (with a "reconnect
your Google account" hint) — the server does not crash.

## Releases and deploys

`.github/workflows/deploy.yml` is branch-driven. There are no release tags.

| Trigger              | Env     | Fly app                  |
|----------------------|---------|--------------------------|
| open / update a PR   | staging | `gdrive-mintmcp-staging` |
| merge to `main`      | prod    | `gdrive-mintmcp`         |

An open PR keeps staging pointed at that branch, so you can test the change
end to end before merging. Two open PRs share one staging app: the last push
wins.

`deployments.yml` is the list of live apps. The workflow builds its matrix
from it, so every live entry for the triggered environment deploys from the
same commit — nothing can quietly fall out of the deploy path. Each entry
names its `profile`, injected as `PROFILE` at deploy time.

Adding a deployment that needs a different scope or feature set (a
connector with `drive.labels.readonly`, say, or one that serves resources)
is one new profile and one new entry, not a branch and not a release:
existing apps redeploy unchanged and withhold the new tools, and the new
app registers them.

## Hosting a copy on MintMCP

To host the current branch as a MintMCP hosted connector — a test connector,
or your own self-deployed copy:

```bash
npx @mintmcp/hosted-cli build-and-push --dockerfile Dockerfile --context .
```

Then set `PROFILE` in the connector's env settings to the profile whose
scopes the connector's OAuth grant requests, or leave it unset to register
every tool.

## Build the image locally

Build the image straight from the repo's `Dockerfile` (from source, on the
current branch) instead of pulling a published tag — handy for testing a
branch or verifying a build. Build for `linux/amd64` to match the MintMCP
runtime (required on Apple Silicon):

```bash
docker build --platform linux/amd64 -t gdrive-mcp:local .
docker run --rm -p 8000:8000 gdrive-mcp:local
```
