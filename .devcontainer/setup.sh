#!/usr/bin/env bash
# "onCreateCommand": tools that don't depend on the repository's content. Runs once when the
# container is created — including in a Codespaces prebuild, so Codespaces created from the
# prebuild skip it.
set -euo pipefail
# Lean toolchain manager; the Lean version itself comes from ./lean-toolchain
curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none
export PATH="$HOME/.elan/bin:$PATH"
# elan only updates login-shell profiles; VS Code terminals read ~/.bashrc / ~/.zshrc
for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
  grep -qs '.elan/bin' "$rc" || echo 'export PATH="$HOME/.elan/bin:$PATH"' >> "$rc"
done
