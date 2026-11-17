#!/usr/bin/env bash
# Download Mathlib's prebuilt files for only the Mathlib modules this project's .lean files import
# (plus everything those modules import), instead of all of Mathlib.
#
#   bash .devcontainer/fetch-mathlib.sh          # what the current files import
#   bash .devcontainer/fetch-mathlib.sh --all    # all of Mathlib
#
# Run it again after adding imports; files already downloaded are skipped. If any file has a plain
# `import Mathlib`, everything is downloaded, since that import needs all of it. Without the prebuilt
# files, opening a file makes Lean compile the missing modules from source, which can take a long time.
set -euo pipefail
trap 'echo "fetch-mathlib: FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/.."
export PATH="$HOME/.elan/bin:$PATH"

# Make sure Mathlib's source (and its dependencies) are checked out; needed to check module names.
lake env true >/dev/null

if [ "${1:-}" = "--all" ]; then
  echo "fetch-mathlib: downloading all of Mathlib…"
  exec lake exe cache get
fi

# Mathlib modules imported by the project's own .lean files (not dependencies or build output).
mapfile -t files < <(find . -name '*.lean' -not -path './.lake/*' -not -path './node_modules/*' -print | LC_ALL=C sort)
mapfile -t imports < <(
  [ ${#files[@]} -gt 0 ] &&
    sed -nE 's/^[[:space:]]*((public|private|meta)[[:space:]]+)*import[[:space:]]+(all[[:space:]]+)?(Mathlib(\.[A-Za-z0-9_.]+)?)[[:space:]]*(--.*)?$/\4/p' "${files[@]}" |
    LC_ALL=C sort -u || true
)

if [ ${#imports[@]} -eq 0 ]; then
  echo "fetch-mathlib: no file imports Mathlib; nothing to download."
  exit 0
fi
if printf '%s\n' "${imports[@]}" | grep -qx 'Mathlib'; then
  echo "fetch-mathlib: a file has 'import Mathlib', which needs all of Mathlib; downloading everything…"
  grep -lE '^[[:space:]]*((public|private|meta)[[:space:]]+)*import[[:space:]]+Mathlib[[:space:]]*(--.*)?$' "${files[@]}" | sed 's/^/  /'
  exec lake exe cache get
fi

# Keep only modules that exist in this Mathlib version (a typo would make the whole download fail).
MATHLIB_SRC=.lake/packages/mathlib
valid=()
for m in "${imports[@]}"; do
  if [ -f "$MATHLIB_SRC/${m//.//}.lean" ]; then
    valid+=("$m")
  else
    echo "fetch-mathlib: warning: '$m' is not a module in this Mathlib version; skipping it." >&2
  fi
done
[ ${#valid[@]} -eq 0 ] && { echo "fetch-mathlib: nothing valid to download."; exit 0; }

echo "fetch-mathlib: downloading prebuilt files for ${#valid[@]} imported module(s) and what they import:"
printf '  %s\n' "${valid[@]}"
lake exe cache get "${valid[@]}"
