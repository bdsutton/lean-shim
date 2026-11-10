#!/usr/bin/env bash
set -euo pipefail
# Lean toolchain manager; the Lean version itself comes from ./lean-toolchain
curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain none
export PATH="$HOME/.elan/bin:$PATH"
# Fetch Mathlib and download its prebuilt files (building it from source would take hours)
lake exe cache get
# Dependencies for building the extension
npm ci
