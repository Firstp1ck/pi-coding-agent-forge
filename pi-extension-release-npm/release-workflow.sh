#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
export PI_NPM_PACKAGES_ROOT="${PI_NPM_PACKAGES_ROOT:-$PWD}"
exec node "$SCRIPT_DIR/release/cli.mjs" "$@"
