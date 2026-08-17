#!/usr/bin/env bash
# Provision a custom hostname (TLS cert) for a Fly app.
#
# Only needed when you want a vanity domain instead of the default
# <app>.fly.dev hostname. Generic helper — usable from any MCP server repo.
#
# Usage:
#   scripts/setup-fly-domain.sh <app> <hostname>
#
# `fly certs add` prints the DNS records you need to create at your registrar
# (typically a CNAME to <app>.fly.dev plus an _acme-challenge.* CNAME). Once
# DNS propagates, Fly issues the Let's Encrypt cert automatically.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: scripts/setup-fly-domain.sh <app> <hostname>" >&2
  exit 2
fi

APP="$1"
HOST="$2"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "error: flyctl not found on PATH" >&2
  echo "       install: https://fly.io/docs/flyctl/install/" >&2
  exit 127
fi

echo ">>> Adding cert for $HOST on app $APP"
flyctl certs add "$HOST" -a "$APP"

echo
echo ">>> Current cert status (set the DNS records above, then re-check):"
flyctl certs show "$HOST" -a "$APP"
