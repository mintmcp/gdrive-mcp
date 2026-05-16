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

Every tool declares both `inputSchema` and `outputSchema`, returns
`structuredContent` alongside the text block, and routes errors through a
single envelope with HTTP status, reason, and a corrective hint.

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
  --tag 0.1.0
```

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
