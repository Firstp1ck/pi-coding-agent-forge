#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REPOSITORY_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
export PI_NPM_PACKAGES_ROOT="${PI_NPM_PACKAGES_ROOT:-$REPOSITORY_ROOT}"
exec node "$REPOSITORY_ROOT/pi-extension-release-npm/release/cli.mjs" "$@"
