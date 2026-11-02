#!/usr/bin/env bash
# Start the Baki tracker + sync server.
#   ./sync.sh            → http://localhost:8787 (and a LAN address for your phone)
#   PORT=9000 ./sync.sh  → different port
set -e
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is needed to run the sync server." >&2
  echo "Install it from https://nodejs.org (LTS), then run ./sync.sh again." >&2
  exit 1
fi
exec node server.mjs "$@"
