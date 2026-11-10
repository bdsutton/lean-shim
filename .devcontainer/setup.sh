#!/usr/bin/env bash
set -euo pipefail
# Lean toolchain (so the Lean 4 extension can check proofs)
curl -sSfL https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh | sh -s -- -y --default-toolchain stable
# Build the extension package from source
npm ci
npm run package
