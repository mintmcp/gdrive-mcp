#!/usr/bin/env bash
# Deploy gdrive-mcp to Fly.io.
#
# Usage:
#   scripts/deploy-fly.sh [staging|prod]
#
# Defaults to staging. Requires flyctl on PATH and an authenticated session
# (`fly auth login`) or FLY_API_TOKEN in the environment (used by CI).
#
# First-time setup per environment:
#   fly apps create gdrive-mintmcp-staging
#   fly apps create gdrive-mintmcp
set -euo pipefail

ENV="${1:-staging}"
[ $# -gt 0 ] && shift

case "$ENV" in
  staging)
    APP="gdrive-mintmcp-staging"
    ;;
  prod|production)
    APP="gdrive-mintmcp"
    ;;
  *)
    echo "error: unknown environment '$ENV' (expected: staging, prod)" >&2
    exit 2
    ;;
esac

if ! command -v flyctl >/dev/null 2>&1; then
  echo "error: flyctl not found on PATH" >&2
  echo "       install: https://fly.io/docs/flyctl/install/" >&2
  exit 127
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo ">>> Deploying $APP from $REPO_ROOT"
flyctl deploy \
  --app "$APP" \
  --config fly.toml \
  --remote-only \
  --strategy rolling \
  "$@"
