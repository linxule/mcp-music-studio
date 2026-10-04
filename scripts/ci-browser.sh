#!/usr/bin/env bash
# Run the real-browser acceptance checks against a local Worker (wrangler dev
# --local: Durable Objects, KV and rate limits run in workerd, no Cloudflare
# account needed) and the ext-apps dev harness. Same script locally and in CI.
#
#   bun run build && (cd worker && bun install)
#   scripts/ci-browser.sh                 # all checks
#   scripts/ci-browser.sh session swap    # just these (names = verify-<name>.mjs)
#
#   BROWSER=webkit scripts/ci-browser.sh  # Safari's engine
#
# Not here: verify-stage (say() needs Workers AI, which --local cannot reach).
# WebKit skips verify-sensors (Playwright's WebKit has no fake motion sensors or
# microphone) and verify-share-webmcp (WebMCP is a Chromium flag).
set -uo pipefail
cd "$(dirname "$0")/.."

WORKER_PORT="${WORKER_PORT:-8799}"
HARNESS_PORT="${HARNESS_PORT:-5177}"
INSPECTOR_PORT="${INSPECTOR_PORT:-9239}"
LOGS="${LOGS:-${TMPDIR:-/tmp}/ci-browser}"
mkdir -p "$LOGS"

CHECKS=("$@")
if [ ${#CHECKS[@]} -eq 0 ]; then
  if [ "${BROWSER:-chromium}" = "webkit" ]; then
    CHECKS=(plain session controls remember swap studio share-player share-score score-click record)
  else
    CHECKS=(plain session controls sensors remember swap studio share-player share-score share-webmcp score-click record)
  fi
fi

pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done
  # wrangler leaves workerd behind when only its parent is killed.
  pkill -f "wrangler dev --local --port $WORKER_PORT" 2>/dev/null
  pkill -f "workerd.*$WORKER_PORT" 2>/dev/null
  true
}
trap cleanup EXIT

(cd worker && exec bunx wrangler dev --local --port "$WORKER_PORT" --inspector-port "$INSPECTOR_PORT" --ip 127.0.0.1) > "$LOGS/wrangler.log" 2>&1 &
pids+=($!)
bunx vite --config dev/vite.config.ts --host 127.0.0.1 --port "$HARNESS_PORT" --strictPort > "$LOGS/vite.log" 2>&1 &
pids+=($!)

wait_for() { # url, name
  for _ in $(seq 1 90); do curl -sf -o /dev/null "$1" && return 0; sleep 1; done
  echo "✗ $2 did not come up at $1"; cat "$LOGS/$2.log"; exit 1
}
wait_for "http://127.0.0.1:$WORKER_PORT/health" wrangler
wait_for "http://127.0.0.1:$HARNESS_PORT/" vite

export HARNESS="http://127.0.0.1:$HARNESS_PORT/"
export BASE="http://127.0.0.1:$HARNESS_PORT"
export SESSION_ORIGIN="http://127.0.0.1:$WORKER_PORT"
export ORIGIN="http://127.0.0.1:$WORKER_PORT"

failed=()
for name in "${CHECKS[@]}"; do
  echo "── verify-$name"
  # pipefail: the pipeline fails when node does, not only when tee does.
  if ! node "scripts/verify-$name.mjs" 2>&1 | tee "$LOGS/verify-$name.log"; then
    failed+=("$name")
  elif grep -q "^✗" "$LOGS/verify-$name.log"; then
    failed+=("$name")
  fi
done

echo
if [ ${#failed[@]} -eq 0 ]; then
  echo "all ${#CHECKS[@]} browser checks passed (${BROWSER:-chromium})"
else
  echo "FAILED: ${failed[*]} (logs in $LOGS)"
  exit 1
fi
