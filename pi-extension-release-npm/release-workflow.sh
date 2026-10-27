#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${PI_NPM_PACKAGES_ROOT:-$SCRIPT_DIR}"

MODE=""
TARGET="all"
TARGETS_LIST=""
PUBLISHER="npm"
ACCESS="public"
CHECK_ALT_CLIENT=0
STRICT_AUTH=1

usage() {
  cat <<'EOF'
Usage:
  ./release-workflow.sh <--check|--plan|--publish> [options]

Modes (choose exactly one):
  --check      Run readiness checks and report required version bumps only
  --plan       Run version bump planning, then publish planning/checks (no writes/publish)
  --publish    Apply required version bumps, then publish; failures are handled per package

Options:
  --target <name|all>          Target one package directory or all (default: all)
  --all                        Same as --target all
  --targets <dir,dir,...>      For --plan: plan only these comma-separated package directories
  --publisher <auto|bun|npm>   Publisher client (default: npm; bun is fallback when available)
  --access <public|restricted> Publish access for --publish/--plan (default: public)
  --check-alt-client           For --check: also dry-run with alternate client
  --no-strict-auth             For --publish/--plan: disable strict auth
  -h, --help                   Show help

Examples:
  ./release-workflow.sh --check --all
  ./release-workflow.sh --plan --target pi-extension-notes
  ./release-workflow.sh --publish --all
EOF
}

require_mode() {
  if [[ -n "$MODE" ]]; then
    echo "ERROR: choose exactly one mode: --check, --plan, or --publish" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)
      require_mode
      MODE="check"
      shift
      ;;
    --plan)
      require_mode
      MODE="plan"
      shift
      ;;
    --publish)
      require_mode
      MODE="publish"
      shift
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --all)
      TARGET="all"
      shift
      ;;
    --targets)
      TARGETS_LIST="${2:-}"
      shift 2
      ;;
    --publisher)
      PUBLISHER="${2:-}"
      shift 2
      ;;
    --access)
      ACCESS="${2:-}"
      shift 2
      ;;
    --check-alt-client)
      CHECK_ALT_CLIENT=1
      shift
      ;;
    --no-strict-auth)
      STRICT_AUTH=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown option '$1'" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$MODE" ]]; then
  echo "ERROR: you must pass one mode: --check, --plan, or --publish" >&2
  usage
  exit 1
fi

if [[ "$PUBLISHER" != "auto" && "$PUBLISHER" != "bun" && "$PUBLISHER" != "npm" ]]; then
  echo "ERROR: --publisher must be auto, bun, or npm" >&2
  exit 1
fi

if [[ "$ACCESS" != "public" && "$ACCESS" != "restricted" ]]; then
  echo "ERROR: --access must be public or restricted" >&2
  exit 1
fi

if [[ -n "$TARGETS_LIST" && "$MODE" != "plan" ]]; then
  echo "ERROR: --targets is only supported with --plan" >&2
  exit 1
fi

CHECK_SCRIPT="$SCRIPT_DIR/check-publish-readiness.sh"
BUMP_SCRIPT="$SCRIPT_DIR/bump-package-versions.sh"
PUBLISH_SCRIPT="$SCRIPT_DIR/publish-packages.sh"

if [[ ! -x "$CHECK_SCRIPT" ]]; then
  echo "ERROR: missing executable $CHECK_SCRIPT" >&2
  exit 1
fi
if [[ ! -x "$BUMP_SCRIPT" ]]; then
  echo "ERROR: missing executable $BUMP_SCRIPT" >&2
  exit 1
fi
if [[ ! -x "$PUBLISH_SCRIPT" ]]; then
  echo "ERROR: missing executable $PUBLISH_SCRIPT" >&2
  exit 1
fi

missing_bundled_dependencies() {
  local pkg_dir="$1"
  node - "$pkg_dir/package.json" <<'NODE'
const fs = require("fs");
const path = require("path");
const manifestPath = process.argv[2];
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
if (!Array.isArray(bundled)) {
  console.error(`ERROR: bundledDependencies must be an array in ${manifestPath}`);
  process.exit(2);
}
const packageDir = path.dirname(manifestPath);
for (const name of bundled) {
  if (typeof name !== "string" || !name) continue;
  const installedManifest = path.join(packageDir, "node_modules", ...name.split("/"), "package.json");
  if (!fs.existsSync(installedManifest)) console.log(name);
}
NODE
}

prepare_package_bundled_dependencies() {
  local pkg_dir="$1"
  local missing remaining
  missing="$(missing_bundled_dependencies "$pkg_dir")"
  [[ -n "$missing" ]] || return 0

  echo "Materializing bundled dependencies for $(basename "$pkg_dir"): $(printf '%s' "$missing" | paste -sd ', ' -)"
  (
    cd "$pkg_dir"
    npm install --ignore-scripts --omit=dev --omit=peer --no-save --package-lock=false
  )

  remaining="$(missing_bundled_dependencies "$pkg_dir")"
  if [[ -n "$remaining" ]]; then
    echo "ERROR: bundled dependencies remain unavailable for $(basename "$pkg_dir"): $(printf '%s' "$remaining" | paste -sd ', ' -)" >&2
    return 1
  fi
}

prepare_bundled_dependencies_from_targets_file() {
  local root_dir="$1"
  local targets_file="$2"
  local raw target pkg_dir
  while IFS= read -r raw || [[ -n "$raw" ]]; do
    target="$(printf '%s' "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [[ -z "$target" || "$target" == \#* ]] && continue
    if [[ "$target" = /* ]]; then
      pkg_dir="$target"
    else
      pkg_dir="$root_dir/$target"
    fi
    if [[ ! -f "$pkg_dir/package.json" ]]; then
      echo "ERROR: package '$target' not found under $root_dir" >&2
      return 1
    fi
    prepare_package_bundled_dependencies "$pkg_dir"
  done < "$targets_file"
}

prepare_bundled_dependencies_for_target() {
  local root_dir="$1"
  local target="$2"
  local pkg_dir
  if [[ "$target" != "all" ]]; then
    if [[ "$target" = /* ]]; then
      pkg_dir="$target"
    else
      pkg_dir="$root_dir/$target"
    fi
    if [[ ! -f "$pkg_dir/package.json" ]]; then
      echo "ERROR: package '$target' not found under $root_dir" >&2
      return 1
    fi
    prepare_package_bundled_dependencies "$pkg_dir"
    return
  fi

  while IFS= read -r pkg_dir; do
    prepare_package_bundled_dependencies "$pkg_dir"
  done < <(find "$root_dir" -mindepth 2 -maxdepth 2 -type f -name package.json -printf '%h\n' | sort)
}

prepare_plan_workspace() {
  node - "$ROOT_DIR" "$workspace_root" "$candidate_targets_file" <<'NODE'
const fs = require("fs");
const path = require("path");
const [root, workspace, targetsFile] = process.argv.slice(2).map(value => path.resolve(value));
const targets = fs.readFileSync(targetsFile, "utf8").split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith("#"));
const candidates = targets.map(target => {
  // Version planning writes direct child directory names, never arbitrary paths.
  if (target === "." || target === ".." || /[\\/]/.test(target)) throw new Error(`Invalid release candidate: ${target}`);
  const source = path.join(root, target);
  return { target, source, manifest: JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8")) };
});
const needsRepository = candidates.some(({ manifest }) => {
  const hooks = ["prepare", "prepack", "postpack", "prepublishOnly", "publish", "postpublish"];
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies };
  return hooks.some(name => manifest.scripts?.[name]?.trim())
    || Object.values(dependencies).some(value => /^(file:|link:|workspace:)/.test(value));
});
if (needsRepository) {
  // Hooks may use sibling resources, ancestor node_modules, or Git metadata.
  console.log("Release progress: Preparing full workspace for release hooks or local dependencies");
  fs.cpSync(root, workspace, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
} else {
  console.log(`Release progress: Preparing workspace for ${candidates.length} release candidate(s)`);
  // Keep ancestor npm configuration and package metadata without copying directories.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile()) fs.copyFileSync(path.join(root, entry.name), path.join(workspace, entry.name));
  }
  for (const { target, source, manifest } of candidates) {
    console.log(`Release progress: Copying release candidate ${target}`);
    const bundled = manifest.bundledDependencies ?? manifest.bundleDependencies ?? [];
    const keepModules = Array.isArray(bundled) && bundled.length > 0;
    fs.cpSync(source, path.join(workspace, target), {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      filter: file => path.basename(file) !== ".git" && (keepModules || path.basename(file) !== "node_modules"),
    });
  }
}
NODE
}

case "$MODE" in
  check)
    check_cmd=("$CHECK_SCRIPT" --target "$TARGET" --publisher "$PUBLISHER")
    if [[ $CHECK_ALT_CLIENT -eq 1 ]]; then
      check_cmd+=(--check-alt-client)
    fi
    echo "Running: ${check_cmd[*]}"
    set +e
    "${check_cmd[@]}"
    check_status=$?
    set -e

    echo
    bump_cmd=("$BUMP_SCRIPT" --target "$TARGET")
    echo "Reporting required version bumps: ${bump_cmd[*]}"
    "${bump_cmd[@]}"

    exit "$check_status"
    ;;

  plan)
    tmp_root="$(mktemp -d)"
    cleanup_plan_tmp() {
      local status=$?
      echo "Release progress: Cleaning up temporary workspace"
      rm -rf "$tmp_root"
      if [[ $status -eq 0 ]]; then
        echo "Release progress: Preflight complete"
      else
        echo "Release progress: Preflight failed"
      fi
    }
    trap cleanup_plan_tmp EXIT

    candidate_targets_file="$tmp_root/publish-targets.txt"
    workspace_root="$tmp_root/workspace"
    mkdir -p "$workspace_root"

    if [[ -n "$TARGETS_LIST" ]]; then
      selected_targets_file="$tmp_root/selected-targets.txt"
      tr ',' '
' <<<"$TARGETS_LIST" > "$selected_targets_file"
      bump_cmd=("$BUMP_SCRIPT" --targets-file "$selected_targets_file" --candidate-targets-file "$candidate_targets_file")
    else
      bump_cmd=("$BUMP_SCRIPT" --target "$TARGET" --candidate-targets-file "$candidate_targets_file")
    fi
    echo "Planning required version bumps: ${bump_cmd[*]}"
    "${bump_cmd[@]}"
    echo

    if [[ ! -s "$candidate_targets_file" ]]; then
      echo "No publish candidates detected by version planning; skipping publish plan checks."
      exit 0
    fi

    echo "Publish candidates from version planning:"
    sed 's/^/  - /' "$candidate_targets_file"
    echo

    echo "Preparing temporary version-bumped workspace: $workspace_root"
    prepare_plan_workspace
    echo "Release progress: Applying planned version changes"
    echo "Applying planned version bumps in temporary workspace for publish candidates: $BUMP_SCRIPT --targets-file $candidate_targets_file --apply"
    PI_NPM_PACKAGES_ROOT="$workspace_root" "$BUMP_SCRIPT" --targets-file "$candidate_targets_file" --apply
    echo

    echo "Release progress: Preparing bundled dependencies"
    prepare_bundled_dependencies_from_targets_file "$workspace_root" "$candidate_targets_file"
    echo

    cmd=("$PUBLISH_SCRIPT" --targets-file "$candidate_targets_file" --publisher "$PUBLISHER" --access "$ACCESS")
    if [[ $STRICT_AUTH -eq 1 ]]; then
      cmd+=(--strict-auth)
    fi
    echo "Running publish plan for preselected targets against version-bumped temp workspace: ${cmd[*]}"
    echo "Release progress: Checking publish readiness"
    PI_NPM_PACKAGES_ROOT="$workspace_root" "${cmd[@]}"
    ;;

  publish)
    bump_cmd=("$BUMP_SCRIPT" --target "$TARGET" --apply)
    echo "Applying required version bumps: ${bump_cmd[*]}"
    "${bump_cmd[@]}"
    echo

    prepare_bundled_dependencies_for_target "$ROOT_DIR" "$TARGET"
    echo

    cmd=("$PUBLISH_SCRIPT" --target "$TARGET" --publisher "$PUBLISHER" --access "$ACCESS" --apply)
    if [[ $STRICT_AUTH -eq 1 ]]; then
      cmd+=(--strict-auth)
    fi
    echo "Running: ${cmd[*]}"
    exec "${cmd[@]}"
    ;;
esac
