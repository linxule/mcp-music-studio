#!/usr/bin/env bash
# Repeat one browser check to measure a flake, optionally under CPU load (a
# loaded CI runner is where most of ours showed up). Needs the dev harness up
# (bunx vite --config dev/vite.config.ts --port 5177) and, for checks that use
# the Worker, wrangler dev as in ci-browser.sh.
#
#   scripts/diag-loop.sh <check> <browser> <runs> <parallel> <tag> [cpu-burners]
#   scripts/diag-loop.sh score-click chromium 30 3 base 10
#
# Logs go to $DIAG_OUT/runs/<tag>/ (default $TMPDIR); prints the failure count
# and the failing steps.
set -u
check=$1; br=$2; runs=$3; par=$4; tag=$5; burn=${6:-0}
S="${DIAG_OUT:-${TMPDIR:-/tmp}}"
out="$S/runs/$tag"; rm -rf "$out"; mkdir -p "$out"
cd "$(dirname "$0")/.."
bp=()
[ "$burn" -gt 0 ] && for _ in $(seq 1 "$burn"); do (while :; do :; done) & bp+=($!); done
export HARNESS="${HARNESS:-http://127.0.0.1:5177/}" BROWSER=$br
one() { node "scripts/verify-$check.mjs" > "$out/$1.log" 2>&1; echo "exit=$?" >> "$out/$1.log"; }
i=0
while [ $i -lt "$runs" ]; do
  rp=()
  for _ in $(seq 1 "$par"); do i=$((i+1)); if [ $i -le "$runs" ]; then one $i & rp+=($!); fi; done
  wait "${rp[@]}"
done
for p in "${bp[@]:-}"; do kill "$p" 2>/dev/null; done
fails=$(grep -l -E '^✗|exit=[1-9]' "$out"/*.log | wc -l | tr -d ' ')
echo "$tag: $fails/$runs failed"
grep -h '^✗' "$out"/*.log | sort | uniq -c | sort -rn | head -20
