#!/usr/bin/env bash
# Build the extension from the current source and (re)install it into this Codespace.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -d node_modules ] || npm ci
npm run package
code --uninstall-extension local.lean-proof-fill >/dev/null 2>&1 || true
code --install-extension lean-proof-fill.vsix --force
echo "Lean Proof Fill installed. If a window was already open, run 'Developer: Reload Window'."
