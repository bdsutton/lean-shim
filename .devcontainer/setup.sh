#!/usr/bin/env bash
set -euo pipefail
# Lean toolchain manager; the Lean version itself comes from ./lean-toolchain
curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none
export PATH="$HOME/.elan/bin:$PATH"
# elan only updates login-shell profiles; VS Code terminals read ~/.bashrc / ~/.zshrc
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  grep -qs '.elan/bin' "$rc" || echo 'export PATH="$HOME/.elan/bin:$PATH"' >> "$rc"
done
# Fetch Mathlib and download its prebuilt files (building it from source would take hours)
lake exe cache get
# Build the from_base64 tactic library (used by the base64 proof format and Encode Selection; no Mathlib needed)
lake build LeanShim.Base64
# Build the extension now, during creation, so the first start only has to install it
bash .devcontainer/install-extension.sh --build-only
