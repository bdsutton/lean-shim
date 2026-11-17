#!/usr/bin/env bash
# "updateContentCommand": everything that depends on the repository's content. Runs after setup.sh
# when the container is created, and again whenever a Codespaces prebuild is refreshed for new
# commits — so Codespaces created from the prebuild already have all of this.
set -euo pipefail
trap 'echo "update-content: FAILED at line $LINENO: $BASH_COMMAND" >&2' ERR
cd "$(dirname "$0")/.."
export PATH="$HOME/.elan/bin:$PATH"

# All of Mathlib's prebuilt files, so any import works without compiling Mathlib from source.
# (In a prebuild this cost is paid once, not by each new Codespace.)
bash .devcontainer/fetch-mathlib.sh
# The compressed download cache (~/.cache/mathlib) is no longer needed once unpacked; removing it
# keeps the prebuild, and each Codespace's storage, smaller.
lake exe cache clean! >/dev/null 2>&1 || true

# Build the extension now, so opening the Codespace only has to install it
bash .devcontainer/install-extension.sh --build-only
