#!/usr/bin/env bash
# Run every Baki test against a throwaway server.
#
#   ./tools/test.sh              # everything
#   ./tools/test.sh ui3 ui7      # just those suites
#
# The server is started on its own port with its own data file and is killed on exit,
# so this can never touch the real data.json on 8787.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEV="$ROOT/../.dev"
PORT="${TEST_PORT:-8790}"
LIVE_PORT=8787

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }

if ! command -v node >/dev/null 2>&1; then
  red "Node.js is not installed."; exit 1
fi
if [ ! -d "$DEV" ]; then
  red "Test suites not found at $DEV"; exit 1
fi

DATA_FILE="$(mktemp -t baki-test-XXXXXX)"
LOG_FILE="$(mktemp -t baki-test-log-XXXXXX)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -f "$DATA_FILE" "$LOG_FILE"
}
trap cleanup EXIT INT TERM

# never collide with the live server's port
if [ "$PORT" = "$LIVE_PORT" ]; then
  red "Refusing to test on $LIVE_PORT — that is the live server. Use TEST_PORT."
  exit 1
fi

# find a free port, starting at $PORT
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
for _ in 1 2 3 4 5; do
  if port_free "$PORT"; then break; fi
  PORT=$((PORT + 1))
  [ "$PORT" = "$LIVE_PORT" ] && PORT=$((PORT + 1))
done

bold "Baki test run"
dim "  server  http://127.0.0.1:$PORT (throwaway data)"
dim "  suites  ${DEV}"

PORT="$PORT" TLS_PORT="$((PORT + 100))" DATA_FILE="$DATA_FILE" ALLOW_RESET=1 \
  node "$ROOT/server.mjs" >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

# wait for it to answer
for _ in $(seq 1 40); do
  if node -e "fetch('http://127.0.0.1:$PORT/api/ping').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if ! node -e "fetch('http://127.0.0.1:$PORT/api/ping').then(()=>process.exit(0)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
  red "Server did not start. Log:"; cat "$LOG_FILE"; exit 1
fi
echo

# ---- which suites ----
UNKNOWN=0
UNITS=(shifts fund cover)
UI=(ui3 ui5 ui6 ui7 ui14 ui16 ui17 quicklog coverflow snap storage motion contrast polish headertest hairline theme)
if [ "$#" -gt 0 ]; then
  UNITS=(); UI=()
  for arg in "$@"; do
    if [ -f "$DEV/unit/$arg.mjs" ]; then UNITS+=("$arg")
    elif [ -f "$DEV/$arg.mjs" ]; then UI+=("$arg")
    else red "Unknown suite: $arg"; UNKNOWN=1; fi
  done
fi

PASSED=0; FAILED=0; FAILED_NAMES=()
SUMMARY=()

run_unit() {
  local name="$1" out rc line
  out="$(node "$DEV/unit/$name.mjs" 2>&1)"; rc=$?
  line="$(printf '%s\n' "$out" | grep -E 'passed,' | tail -1)"
  if [ "$rc" -eq 0 ]; then PASSED=$((PASSED+1)); else FAILED=$((FAILED+1)); FAILED_NAMES+=("$name"); fi
  SUMMARY+=("$(printf '%-12s %s' "$name" "${line:-no summary}")")
}

run_ui() {
  local name="$1" out rc line
  out="$(BASE="http://127.0.0.1:$PORT" ALLOW_WIPE=1 PLAYWRIGHT_BROWSERS_PATH="$DEV/browsers" \
        node "$DEV/$name.mjs" 2>&1)"; rc=$?
  line="$(printf '%s\n' "$out" | grep -E 'passed,' | tail -1)"
  if [ "$rc" -eq 0 ]; then PASSED=$((PASSED+1)); else FAILED=$((FAILED+1)); FAILED_NAMES+=("$name"); fi
  SUMMARY+=("$(printf '%-12s %s' "$name" "${line:-no summary}")")
  if [ "$rc" -ne 0 ]; then
    printf '%s\n' "$out" | grep -E 'FAIL|Error|Timeout' | head -4 | sed 's/^/             /'
  fi
}

bold "Unit"
for u in "${UNITS[@]}"; do run_unit "$u"; done

bold "UI"
for s in "${UI[@]}"; do run_ui "$s"; done

echo
bold "Summary"
for row in "${SUMMARY[@]}"; do dim "  $row"; done
echo
TOTAL=$((PASSED+FAILED))
if [ "$UNKNOWN" -eq 1 ]; then
  red "One or more suite names were not recognised."
  exit 1
fi
if [ "$TOTAL" -eq 0 ]; then
  red "No suites ran."
  exit 1
fi
if [ "$FAILED" -eq 0 ]; then
  green "All $TOTAL suites passed."
  exit 0
else
  red "$FAILED of $TOTAL suites failed: ${FAILED_NAMES[*]}"
  exit 1
fi
