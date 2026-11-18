#!/usr/bin/env bash
# Read ahead of time the files Lean needs first, so the first Lean start in a new or restarted
# Codespace isn't slow. A Codespace created from a prebuild fetches each file's data the first time it
# is read, at only a few MB/s, which made the first file take minutes to load.
#
# Started by "postStartCommand" and, as a backup, by the Lean Shim extension when it loads. Runs at
# most once per boot. Returns immediately; the reading continues in the background.
#
#   bash .devcontainer/warm-lean.sh                # start in the background (log: /tmp/lean-shim-warm.log)
#   bash .devcontainer/warm-lean.sh --foreground   # run here and wait
#   bash .devcontainer/warm-lean.sh --force        # run again even if it already ran since boot
#
# Order: Lean's program and libraries, then all of the toolchain's prebuilt files (Lake needs many of
# them before the server is ready), then the many small files Lake checks (lakefiles, module sources,
# .trace/.hash files), then the imported modules' .olean files, dependencies first. .ilean files are
# left to the Lean server, which reads them in the background.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.elan/bin:$PATH"
LOG=/tmp/lean-shim-warm.log
STAMP=/tmp/lean-shim-warm.boot
BOOT=$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)

case "${1:-}" in
  --foreground) ;;
  --force) rm -f "$STAMP"; exec bash "$0" ;;
  *)
    if [ "$(cat "$STAMP" 2>/dev/null)" = "$BOOT" ]; then
      echo "Lean Shim: Lean's files were already read since this machine started (log: $LOG)"
      exit 0
    fi
    # setsid: a new session, so the reading isn't stopped when the command that started it finishes.
    setsid -f nice -n 10 bash "$0" --foreground > "$LOG" 2>&1 < /dev/null
    echo "Lean Shim: reading Lean's files in the background so the first file opens faster (log: $LOG)"
    exit 0
    ;;
esac

# Only one reader at a time, once per boot.
exec 9> /tmp/lean-shim-warm.lock
flock -n 9 || { echo "already running"; exit 0; }
[ "$(cat "$STAMP" 2>/dev/null)" = "$BOOT" ] && { echo "already done since boot"; exit 0; }
echo "$BOOT" > "$STAMP"

t0=$(date +%s)
phase() { echo "[$(date +%T)] $1 (+$(($(date +%s) - t0))s)"; }
readall() { xargs -0 -r -P "$1" -n "$2" cat > /dev/null 2>&1; }

phase "start"
prefix=$(timeout 120 lean --print-prefix 2>/dev/null) || prefix=""
if [ -n "$prefix" ]; then
  # 1. Lean's and Lake's programs and the libraries they load (libleanshared.so alone is ~230 MB).
  {
    for b in lean lake; do
      [ -f "$prefix/bin/$b" ] || continue
      printf '%s\0' "$prefix/bin/$b"
      ldd "$prefix/bin/$b" 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i ~ /^\//) print $i}' |
        while read -r f; do [ -f "$f" ] && printf '%s\0' "$(readlink -f "$f")"; done
    done
  } | sort -zu | readall 2 1
  phase "Lean's program and libraries read"
  # 2. All of the toolchain's prebuilt .olean files (~350 MB): before the server is ready, Lake loads
  #    Mathlib's lakefile.lean, which needs Lake's and much of Lean's own modules. Lake ships without
  #    sources, so those can't be found by following imports; reading them all is simpler and cheap.
  find "$prefix/lib/lean" -name '*.olean' -print0 | readall 2 32
  phase "Lean's and Lake's prebuilt files read"
else
  echo "(couldn't find the Lean toolchain; skipping Lean's own files)"
fi

# 3. Small files Lake checks before Lean loads anything. Thousands of tiny files: limited by the number
#    of files rather than their size, so many readers at once help.
LEAN_PREFIX="$prefix" node .devcontainer/warm-list.js small --stats | readall 16 32
phase "Lake's small files read"

# 4. The imported modules' .olean files, dependencies first (Lean's own were read in step 2).
LEAN_PREFIX="$prefix" node .devcontainer/warm-list.js olean --stats | readall 2 16
phase "done"
