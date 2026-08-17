# gdrive-mcp

Google Drive MCP server for the MintMCP hosted runtime. Wraps the Google
Drive v3 REST API as a streamable-HTTP MCP server that the MintMCP frontend
fronts with OAuth — every request arrives carrying the user's Google access
token as `Authorization: Bearer <token>`, which the server forwards to Drive.
The container is stateless, listens on port 8000, and ships as a multi-stage
`node:22-slim` image.

## Auth contract

The server takes the user's Google access token **per request** from the
HTTP `Authorization` header. There are no per-deployment env vars; the
MintMCP frontend owns OAuth (client ID/secret, refresh, scope grants) and
forwards a short-lived access token to the container for each MCP call.

Required Google OAuth scopes (configured on the MintMCP connector):

- `openid`
- `https://www.googleapis.com/auth/userinfo.email`
- `https://www.googleapis.com/auth/userinfo.profile`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive.file`

## Tools

| Category        | Tool            | Notes                                                      |
|-----------------|-----------------|------------------------------------------------------------|
| Search / find   | `search_files`  | Drive `q` syntax + optional `mime_type` and `drive_id`.    |
| Read / get      | `get_file`      | Up to 20MB; text / image / pdf. Rejects Google-native docs.|
| Move / share    | `move_file`     | True move (removes from old parents) or multi-parent add.  |
|                 | `share_file`    | user / domain / anyone permissions; no email by default.   |
| Create / copy   | `create_folder` | Optional `parent_folder_id` for nesting.                   |
|                 | `copy_file`     | Optional rename + destination folder; not for folders.     |

Every tool declares both `inputSchema` and `outputSchema`. JSON-shaped
results (metadata, IDs, search hits, text file bodies) return
`structuredContent` alongside the text block. Binary results from
`get_file` are returned via MCP image / resource content blocks instead
(images as `type: "image"`, PDFs as `type: "resource"` with the base64
payload). Errors route through a single envelope with HTTP status,
reason, and a corrective hint.

## Local development

```bash
npm install
npm run dev               # tsx watch
npm run build && npm start
npm test                  # vitest unit tests
npm run smoke             # docker build + boot + tools/list smoke
```

## Docker

```bash
# build amd64 (mandatory for MintMCP runtime)
docker buildx build \
  --platform linux/amd64 \
  -t mintmcp/gdrive-mcp:latest \
  -t mintmcp/gdrive-mcp:0.1.0 \
  --push .

# run locally (Docker Desktop emulates amd64 on Apple Silicon)
docker run --rm -p 8000:8000 mintmcp/gdrive-mcp:latest
```

## Deploy to MintMCP

```bash
hosted-cli build-and-push \
  --image mintmcp/gdrive-mcp \
  --tag 1.0.0
```

## Releases and deploys

`.github/workflows/deploy.yml` picks the Fly app from the ref:

| Trigger                    | Env     | Fly app                  |
|----------------------------|---------|--------------------------|
| push to `main`             | staging | `gdrive-mintmcp-staging` |
| tag `v1.x.y`               | prod    | `gdrive-v1-mintmcp`      |
| tag `v2.x.y`               | prod    | `gdrive-v2-mintmcp`      |

**The prod app name pins the major only.** Minor and patch releases redeploy
the same app, so customers already connected to `gdrive-v1-mintmcp.fly.dev`
keep their URL and their connector. A new major is the only thing that moves
prod to a new URL.

### When to bump major

Bump the major **when, and only when, the required Google OAuth scopes
change** (the list under [Auth contract](#auth-contract)). A scope change
means a new MintMCP connector and a re-consent, so existing customers cannot
be carried forward — they need a new endpoint, and the old one has to keep
serving them until they migrate. Everything else (new tools inside the
existing scopes, bug fixes, perf) is a minor or patch.

### Cutting a release

```bash
npm version 1.0.0 --no-git-tag-version   # updates package.json + lock
git commit -am "release: v1.0.0"
# merge to main, then:
git tag v1.0.0 && git push origin v1.0.0
```

The workflow refuses a tag that isn't `vX.Y.Z` or that doesn't match
`package.json`'s `version`, so the tag and the shipped image can't drift.

> `gdrive-mintmcp` (unversioned) is the pre-1.0 prod app. It predates the
> `drive.file` scope and no longer receives deploys — leave it running for
> customers on the old connector until they've moved to `gdrive-v1-mintmcp`.

## Sanity-check the running container

```bash
curl -s http://localhost:8000/healthz
# {"status":"ok"}

curl -s -X POST http://localhost:8000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer fake-token" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}'
# returns 6 tools: search_files, get_file, move_file, share_file,
# create_folder, copy_file
```

A fake token returns a structured 401 from the Drive API (with a "reconnect
your Google account" hint) — the server does not crash.
