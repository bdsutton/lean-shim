#!/usr/bin/env bash
# "postStartCommand": read, in the background, the prebuilt Lean files that the repo's .lean files
# import (including Lean's core library), so the first file opened in a new or restarted Codespace
# doesn't wait minutes for them to come off a cold disk. Returns immediately.
#
#   bash .devcontainer/warm-lean.sh                # start in the background (log: /tmp/lean-shim-warm.log)
#   bash .devcontainer/warm-lean.sh --foreground   # run here and wait
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.elan/bin:$PATH"
LOG=/tmp/lean-shim-warm.log

if [ "${1:-}" != "--foreground" ]; then
  nohup nice -n 10 bash "$0" --foreground > "$LOG" 2>&1 < /dev/null &
  echo "Lean Shim: reading Lean's files in the background so the first file opens faster (log: $LOG)"
  exit 0
fi

start=$(date +%s)
echo "[$(date +%T)] warming Lean's files for the repo's imports…"
prefix=$(timeout 60 lean --print-prefix 2>/dev/null) || prefix=""
[ -n "$prefix" ] || echo "(couldn't find the Lean toolchain; skipping Lean's core library)"
list=$(mktemp)
LEAN_PREFIX="$prefix" node .devcontainer/warm-list.js --stats > "$list"
# Several readers at once: a cold network-backed disk is limited by latency, not bandwidth.
xargs -0 -P 8 -n 16 cat < "$list" > /dev/null 2>&1
rm -f "$list"
echo "[$(date +%T)] done in $(($(date +%s) - start))s"
