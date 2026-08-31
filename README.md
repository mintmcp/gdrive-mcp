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

## Tools

| Category        | Tool                   | Notes                                                      |
|-----------------|------------------------|------------------------------------------------------------|
| Search / find   | `search_files`         | Drive `q` syntax + optional `mime_type` and `drive_id`.    |
|                 | `list_recent_files`    | Most recently modified files, newest first; excludes folders/trash. |
| Read / get      | `get_file`             | Up to 20MB; text / image / pdf. Rejects Google-native docs.|
|                 | `get_file_metadata`    | Full metadata for any file/folder; no download.            |
|                 | `get_file_permissions` | Lists who has access and at what role.                     |
| Move / share    | `move_file`            | True move; removes the item from its previous parents.     |
|                 | `share_file`           | user / domain / anyone permissions; no email by default.   |
|                 | `update_file_metadata` | Rename / set description / star; metadata only.            |
|                 | `trash_file`           | Reversible move to trash (not a permanent delete).         |
| Create / copy   | `create_folder`        | Optional `parent_folder_id` for nesting.                   |
|                 | `copy_file`            | Optional rename + destination folder; not for folders.     |
| Upload          | `upload_file`          | Text or base64 content; optional convert to a Google type. |

Every tool declares both `inputSchema` and `outputSchema`. JSON-shaped
results (metadata, IDs, search hits, text file bodies) return
`structuredContent` alongside the text block. Binary results from
`get_file` are returned via MCP image / resource content blocks instead
(images as `type: "image"`, PDFs as `type: "resource"` with the base64
payload). Errors route through a single envelope with HTTP status,
reason, and a corrective hint.

## Profiles

A **profile** (`PROFILES` in `src/scopes.ts`) is a frozen, named scope set —
a connector's contract with its users:

| Profile    | Scopes                          |
|------------|---------------------------------|
| `standard` | `drive.readonly` + `drive.file` |
| `full`     | `drive`                         |

Each tool declares the Google scope it needs (the first argument to
`requirePermissionSecure` in `src/tools.ts`):

| Scope            | Tools                                                |
|------------------|------------------------------------------------------|
| `drive.readonly` | `search_files`, `list_recent_files`, `get_file`, `get_file_metadata`, `get_file_permissions` |
| `drive.file`     | `copy_file`, `create_folder`, `move_file`, `share_file`, `update_file_metadata`, `trash_file`, `upload_file` |

Each deployment selects a profile via the `PROFILE` env var. At startup the
server registers only the tools that profile's scopes cover, so a tool is
never advertised that can only ever return 403. Full `drive` counts as
covering `drive.file` and `drive.readonly`, because Google's grant is a
superset. An unknown profile name crashes at boot rather than silently
serving every tool; the boot log prints the granted scope set and the
resulting tool list.

**Frozen profiles never change.** Editing a profile's scopes forces every
user of its connectors to re-consent in Google — the thing this design
exists to avoid. A new scope lands in `full` first, and gets a frozen
profile of its own (a new entry in `deployments.yml` plus a new registry
entry) only when someone wants it in isolation. Existing connectors keep
working untouched, forever.

**`full` is the evolving profile.** It always covers everything the
connector can do, and it grows: choosing it is consent to future scope
requests. When `full` gains a scope, existing users see the new tools fail
with a "reconnect your Google account" hint until they reconnect. Update
the brokered registry entry's scopes in the same change — nothing validates
the two against each other yet.

**Unset means every tool registers.** That is the default for anyone running
their own copy who hasn't thought about scopes yet. Shipping a tool that
needs a scope no profile grants is therefore safe: it stays invisible
everywhere until a profile lists that scope.

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

Adding a deployment that needs a different scope set (a connector with
`drive.labels.readonly`, say) is one new profile and one new entry, not a
branch and not a release: existing apps redeploy unchanged and withhold the
new tools, and the new app registers them.

## Hosting a copy on MintMCP

To host the current branch as a MintMCP hosted connector — a test connector,
or your own self-deployed copy:

```bash
npx @mintmcp/hosted-cli build-and-push --dockerfile Dockerfile --context .
```

Then set `PROFILE` in the connector's env settings to the profile whose
scopes the connector's OAuth grant requests, or leave it unset to register
every tool.
