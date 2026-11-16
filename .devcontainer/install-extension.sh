#!/usr/bin/env bash
# Build the Lean Proof Fill extension and install it into this Codespace — but only redo the work when
# something changed, so opening the Codespace is quick.
#
#   bash .devcontainer/install-extension.sh               # build if changed, install if changed
#   bash .devcontainer/install-extension.sh --build-only  # deps + build only (used during creation)
#   bash .devcontainer/install-extension.sh --force       # rebuild and reinstall regardless
#
# Change detection uses fingerprints (SHA-256) of the inputs:
#   - dependencies: package-lock.json            -> node_modules/.cache/lean-proof-fill/lock.sha256
#   - package:      everything that goes into it -> node_modules/.cache/lean-proof-fill/vsix.sha256
#   - install:      the package that was installed -> ~/.cache/lean-proof-fill/installed.sha256
# The install stamp lives in $HOME, next to the installed extensions, so both disappear together when
# the container is rebuilt.
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-}"
FORCE=0
[ "$MODE" = "--force" ] && FORCE=1
VSIX=lean-proof-fill.vsix
EXT_ID=local.lean-proof-fill
BUILD_STAMPS=node_modules/.cache/lean-proof-fill
INSTALL_STAMP="$HOME/.cache/lean-proof-fill/installed.sha256"

fingerprint() { # fingerprint of the given files/directories (names and contents)
  find "$@" -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum | sha256sum | cut -d' ' -f1
}
stamp_matches() { [ -f "$1" ] && [ "$(cat "$1")" = "$2" ]; }

# 1. Dependencies: reinstall only when package-lock.json changed (npm ci wipes node_modules,
#    including the build stamps, so a dependency change also forces a rebuild).
LOCK_HASH=$(fingerprint package-lock.json)
if [ "$FORCE" = 1 ] || [ ! -d node_modules ] || ! stamp_matches "$BUILD_STAMPS/lock.sha256" "$LOCK_HASH"; then
  echo "Lean Proof Fill: installing build dependencies…"
  npm ci
  mkdir -p "$BUILD_STAMPS"
  echo "$LOCK_HASH" > "$BUILD_STAMPS/lock.sha256"
fi

# 2. Package: rebuild only when an input changed or the .vsix is missing.
VSIX_HASH=$(fingerprint src package.json package-lock.json tsconfig.json .vscodeignore README.md LICENSE media)
if [ "$FORCE" = 1 ] || [ ! -f "$VSIX" ] || ! stamp_matches "$BUILD_STAMPS/vsix.sha256" "$VSIX_HASH"; then
  echo "Lean Proof Fill: building the extension…"
  npm run package
  mkdir -p "$BUILD_STAMPS"
  echo "$VSIX_HASH" > "$BUILD_STAMPS/vsix.sha256"
else
  echo "Lean Proof Fill: extension is up to date, not rebuilding."
fi

[ "$MODE" = "--build-only" ] && exit 0

# 3. Install: only when this exact package isn't already installed.
if ! command -v code >/dev/null 2>&1; then
  echo "Lean Proof Fill: the 'code' command isn't available here; install $VSIX from the Extensions view."
  exit 0
fi
if [ "$FORCE" = 0 ] && stamp_matches "$INSTALL_STAMP" "$VSIX_HASH" && code --list-extensions 2>/dev/null | grep -qix "$EXT_ID"; then
  echo "Lean Proof Fill: already installed."
  exit 0
fi
code --uninstall-extension "$EXT_ID" >/dev/null 2>&1 || true
code --install-extension "$VSIX" --force
mkdir -p "$(dirname "$INSTALL_STAMP")"
echo "$VSIX_HASH" > "$INSTALL_STAMP"
echo "Lean Proof Fill installed. If a window was already open, run 'Developer: Reload Window'."
