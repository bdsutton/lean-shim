#!/usr/bin/env bash
set -euo pipefail
# Lean toolchain manager; the Lean version itself comes from ./lean-toolchain
curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none
export PATH="$HOME/.elan/bin:$PATH"
# elan only updates login-shell profiles; VS Code terminals read ~/.bashrc / ~/.zshrc
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  grep -qs '.elan/bin' "$rc" || echo 'export PATH="$HOME/.elan/bin:$PATH"' >> "$rc"
done
# Fetch Mathlib and download prebuilt files for just the Mathlib modules the project imports
# (building them from source would take hours). Run the same script again after adding imports.
bash .devcontainer/fetch-mathlib.sh
# Build the extension now, during creation, so the first start only has to install it
bash .devcontainer/install-extension.sh --build-only
