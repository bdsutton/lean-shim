#!/usr/bin/env bash
# Build the Lean Shim extension and install it into this Codespace — but only redo the work when
# something changed, so opening the Codespace is quick.
#
#   bash .devcontainer/install-extension.sh               # build if changed, install if changed
#   bash .devcontainer/install-extension.sh --build-only  # deps + build only (used during creation)
#   bash .devcontainer/install-extension.sh --force       # rebuild and reinstall regardless
#
# Change detection uses fingerprints (SHA-256) of the inputs:
#   - dependencies: package-lock.json            -> node_modules/.cache/lean-shim/lock.sha256
#   - package:      everything that goes into it -> node_modules/.cache/lean-shim/vsix.sha256
#     (src, package.json, package-lock.json, tsconfig.json, .vscodeignore, README.md, LICENSE)
#   - install:      the package that was installed -> ~/.cache/lean-shim/installed.sha256
# The install stamp lives in $HOME, next to the installed extensions, so both disappear together when
# the container is rebuilt.
set -euo pipefail
trap 'echo "Lean Shim: FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/.."
RELOAD_HINT="VS Code only starts a newly installed extension after you run 'Developer: Reload Window' (Command Palette)."

MODE="${1:-}"
FORCE=0
[ "$MODE" = "--force" ] && FORCE=1
VSIX=lean-shim.vsix
EXT_ID=local.lean-shim
OLD_EXT_ID=local.lean-proof-fill   # the extension's previous name; removed so both aren't installed
BUILD_STAMPS=node_modules/.cache/lean-shim
INSTALL_STAMP="$HOME/.cache/lean-shim/installed.sha256"

fingerprint() { # fingerprint of the given files/directories (names and contents); missing paths are skipped
  local paths=() p
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  if [ ${#paths[@]} -eq 0 ]; then echo none; return; fi
  find "${paths[@]}" -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum | sha256sum | cut -d' ' -f1
}
stamp_matches() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }

# 1. Dependencies: reinstall only when package-lock.json changed (npm ci wipes node_modules,
#    including the build stamps, so a dependency change also forces a rebuild).
LOCK_HASH=$(fingerprint package-lock.json)
if [ "$FORCE" = 1 ] || [ ! -d node_modules ] || ! stamp_matches "$BUILD_STAMPS/lock.sha256" "$LOCK_HASH"; then
  echo "Lean Shim: installing build dependencies…"
  npm ci
  mkdir -p "$BUILD_STAMPS"
  echo "$LOCK_HASH" > "$BUILD_STAMPS/lock.sha256"
fi

# 2. Package: rebuild only when an input changed or the .vsix is missing.
VSIX_HASH=$(fingerprint src package.json package-lock.json tsconfig.json .vscodeignore README.md LICENSE)
if [ "$FORCE" = 1 ] || [ ! -f "$VSIX" ] || ! stamp_matches "$BUILD_STAMPS/vsix.sha256" "$VSIX_HASH"; then
  echo "Lean Shim: building the extension…"
  npm run package
  mkdir -p "$BUILD_STAMPS"
  echo "$VSIX_HASH" > "$BUILD_STAMPS/vsix.sha256"
else
  echo "Lean Shim: extension is up to date, not rebuilding."
fi

[ "$MODE" = "--build-only" ] && exit 0

# 3. Install: only when this exact package isn't already installed.
if ! command -v code >/dev/null 2>&1; then
  echo "Lean Shim: the 'code' command isn't available here (run this script from a VS Code terminal)," 
  echo "  or install $VSIX from the Extensions view (… menu → Install from VSIX…)."
  exit 0
fi
if code --list-extensions 2>/dev/null | grep -qix "$OLD_EXT_ID"; then
  echo "Lean Shim: removing the old 'Lean Proof Fill' extension (renamed to Lean Shim)…"
  code --uninstall-extension "$OLD_EXT_ID" >/dev/null 2>&1 || true
fi
if [ "$FORCE" = 0 ] && stamp_matches "$INSTALL_STAMP" "$VSIX_HASH" && code --list-extensions 2>/dev/null | grep -qix "$EXT_ID"; then
  echo "Lean Shim: already installed and up to date. If its commands are missing, reload the window:"
  echo "  $RELOAD_HINT"
  exit 0
fi
echo "Lean Shim: installing $VSIX…"
code --uninstall-extension "$EXT_ID" >/dev/null 2>&1 || true
code --install-extension "$VSIX" --force
if ! code --list-extensions 2>/dev/null | grep -qix "$EXT_ID"; then
  echo "Lean Shim: the install command finished, but VS Code does not list $EXT_ID as installed." >&2
  echo "  Try installing $VSIX from the Extensions view (… menu → Install from VSIX…)." >&2
  exit 1
fi
mkdir -p "$(dirname "$INSTALL_STAMP")"
echo "$VSIX_HASH" > "$INSTALL_STAMP"
echo "Lean Shim: installed ($(code --list-extensions --show-versions 2>/dev/null | grep -i "^$EXT_ID@" || echo "$EXT_ID"))."
echo "  $RELOAD_HINT"
