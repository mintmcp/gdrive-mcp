#!/usr/bin/env bash
# End-to-end smoke test for the gdrive-mcp container.
#
# Builds the Docker image, boots it, hits /healthz, runs an MCP
# `initialize` + `tools/list` handshake, and confirms that calling a tool
# with a fake bearer token returns a structured error envelope (no crash).
#
# Usage:
#   bash scripts/smoke-test.sh
# Optional env vars:
#   SMOKE_PORT        — host port to expose (default 18000)
#   SMOKE_IMAGE       — image tag (default gdrive-mcp-smoke:test)
#   DOCKER_PLATFORM   — pass to `docker build --platform` (default unset)
#
# Exits 0 on success, 1 on any failure.

set -euo pipefail

IMG="${SMOKE_IMAGE:-gdrive-mcp-smoke:test}"
PORT="${SMOKE_PORT:-18000}"
NAME="gdrive-mcp-smoke-$$"
EXPECTED_TOOL_COUNT=12

cleanup() {
  docker stop "$NAME" >/dev/null 2>&1 || true
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

build_args=()
if [ -n "${DOCKER_PLATFORM:-}" ]; then
  build_args+=("--platform" "$DOCKER_PLATFORM")
fi

echo "[smoke] building image $IMG..."
docker build "${build_args[@]}" -t "$IMG" .

echo "[smoke] starting container on host port $PORT..."
docker run -d --name "$NAME" -p "${PORT}:8000" "$IMG" >/dev/null

# Wait up to 20s for /healthz to respond 200.
healthy=0
for i in $(seq 1 20); do
  if curl -sf "http://localhost:${PORT}/healthz" >/dev/null; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  echo "[smoke] FAIL: /healthz did not respond within 20s"
  echo "[smoke] container logs:"
  docker logs "$NAME" 2>&1 | tail -40 || true
  exit 1
fi
echo "[smoke] healthz OK"

# extract_json strips an SSE `data: ` envelope and returns the first JSON
# event, falling back to the raw response when not SSE-wrapped.
extract_json() {
  local raw="$1"
  local line
  line=$(printf '%s\n' "$raw" | sed -n 's/^data: //p' | head -1)
  if [ -z "$line" ]; then
    line="$raw"
  fi
  printf '%s' "$line"
}

MCP_PROTO="2025-06-18"

# MCP initialize.
INIT_RAW=$(curl -s -X POST "http://localhost:${PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer fake-token" \
  -d "{\"jsonrpc\":\"2.0\",\"method\":\"initialize\",\"id\":1,\"params\":{\"protocolVersion\":\"$MCP_PROTO\",\"capabilities\":{},\"clientInfo\":{\"name\":\"smoke\",\"version\":\"1\"}}}")
INIT_JSON=$(extract_json "$INIT_RAW")
if ! printf '%s' "$INIT_JSON" | grep -q "protocolVersion"; then
  echo "[smoke] FAIL: initialize did not return protocolVersion"
  echo "[smoke] response: $INIT_RAW"
  exit 1
fi
echo "[smoke] initialize OK"

# Per MCP lifecycle, the client must send the `notifications/initialized`
# notification after a successful initialize. Compliant servers may reject
# subsequent requests otherwise.
curl -s -o /dev/null -X POST "http://localhost:${PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer fake-token" \
  -H "MCP-Protocol-Version: $MCP_PROTO" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'

# tools/list — assert tool count.
LIST_RAW=$(curl -s -X POST "http://localhost:${PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer fake-token" \
  -H "MCP-Protocol-Version: $MCP_PROTO" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":2,"params":{}}')
LIST_JSON=$(extract_json "$LIST_RAW")
TOOL_COUNT=$(printf '%s' "$LIST_JSON" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).result.tools.length)}catch(e){console.log(-1)}})")
if [ "$TOOL_COUNT" != "$EXPECTED_TOOL_COUNT" ]; then
  echo "[smoke] FAIL: tools/list expected $EXPECTED_TOOL_COUNT tools, got $TOOL_COUNT"
  echo "[smoke] response: $LIST_RAW"
  exit 1
fi
echo "[smoke] tools/list OK ($TOOL_COUNT tools)"

# tools/call search_files with a fake bearer — must return our structured
# tool-error envelope (result.isError === true), NOT a top-level JSON-RPC
# protocol error. Parse the JSON to avoid false positives from a generic
# `"error"` substring match.
CALL_RAW=$(curl -s -X POST "http://localhost:${PORT}/mcp" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Authorization: Bearer fake-token" \
  -H "MCP-Protocol-Version: $MCP_PROTO" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":3,"params":{"name":"search_files","arguments":{"query":"trashed = false"}}}')
CALL_JSON=$(extract_json "$CALL_RAW")
CALL_OK=$(printf '%s' "$CALL_JSON" | node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
  try {
    const p = JSON.parse(d);
    if (p.error) { console.log('jsonrpc-error'); return; }
    if (!p.result) { console.log('no-result'); return; }
    if (p.result.isError !== true) { console.log('not-iserror'); return; }
    // structuredContent should carry our error payload from formatDriveError
    const sc = p.result.structuredContent;
    if (!sc || typeof sc.error !== 'string') { console.log('missing-structured-error'); return; }
    console.log('ok');
  } catch (e) { console.log('parse-error'); }
});")
if [ "$CALL_OK" != "ok" ]; then
  echo "[smoke] FAIL: tools/call did not return a structured tool-error envelope ($CALL_OK)"
  echo "[smoke] response: $CALL_RAW"
  exit 1
fi
echo "[smoke] tools/call returned structured error envelope OK"

echo "[smoke] PASS"
