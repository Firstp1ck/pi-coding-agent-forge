#!/usr/bin/env bash
# install-pi-add.sh
#
# What this script does:
# - Discovers local Pi package.json files in this repository for extensions, skills, and packages
#   (pi-extension-*/, pi-skill-*/, pi-package-*/).
# - Lets you choose which packages to register/install/update (interactive by default), or processes all actionable packages with --non-interactive/--all.
# - Compares npm latest versions with Pi-installed versions and hides unchanged, registered ones unless --force is used.
# - Repairs packages that exist in node_modules but are not registered in Pi's user settings.
# - Runs `pi install npm:<package>` for each selected package (or only prints commands with --dry-run).
#
# How to use:
# - Run `./dev/scripts/install-pi-add.sh` for interactive selection.
# - Run `./dev/scripts/install-pi-add.sh --non-interactive` for non-interactive install/update of actionable packages.
# - `--all` remains supported as a short alias for `--non-interactive`.
# - Add `--dry-run` to preview actions and `--force` to show/reinstall latest-version packages.
#
# Why this script exists:
# - It provides a repeatable, repo-local workflow to install/test this repo's Pi npm packages
#   without manually running install commands for each extension/skill/package.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="${PI_NPM_PACKAGES_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd -P)}"
DRY_RUN=0
INSTALL_ALL=0
FORCE_INSTALL=0
NPM_STATUS_CONCURRENCY="${PI_NPM_STATUS_CONCURRENCY:-8}"

usage() {
  cat <<'EOF'
Usage:
  install-pi-add.sh [options]

Discovers local Pi extension/skill/package npm packages and installs their npm-published versions as unpinned Pi package sources.

Options:
  --non-interactive  Register/install/update all actionable packages without prompting
  --all              Alias for --non-interactive
  --dry-run          Print install commands without running them
  --force            Show and allow reinstalling packages already at the latest npm version
  -h, --help         Show this help

Environment:
  PI_NPM_STATUS_CONCURRENCY  Concurrent npm status queries (default: 8)

Examples:
  ./dev/scripts/install-pi-add.sh
  ./dev/scripts/install-pi-add.sh --non-interactive
  ./dev/scripts/install-pi-add.sh --non-interactive --force
  ./dev/scripts/install-pi-add.sh --all --dry-run
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --all|--non-interactive)
      INSTALL_ALL=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE_INSTALL=1
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

if [[ ! "$NPM_STATUS_CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
  echo "ERROR: PI_NPM_STATUS_CONCURRENCY must be a positive integer." >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
  echo "ERROR: pi is required but not found in PATH." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required but not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required but not found in PATH." >&2
  exit 1
fi

format_duration() {
  local seconds="${1:-0}"
  if (( seconds < 0 )); then
    seconds=0
  fi

  local hours=$((seconds / 3600))
  local minutes=$(((seconds % 3600) / 60))
  local secs=$((seconds % 60))

  if (( hours > 0 )); then
    printf "%dh%02dm%02ds" "$hours" "$minutes" "$secs"
  elif (( minutes > 0 )); then
    printf "%dm%02ds" "$minutes" "$secs"
  else
    printf "%ds" "$secs"
  fi
}

render_check_progress() {
  local current="$1"
  local total="$2"
  local start_seconds="$3"
  local bar_width=28

  if (( total <= 0 )); then
    return
  fi

  local elapsed=$((SECONDS - start_seconds))
  local remaining=0
  if (( current > 0 )); then
    remaining=$((elapsed * (total - current) / current))
  fi

  local percent=$((current * 100 / total))
  local filled_width=$((current * bar_width / total))
  local empty_width=$((bar_width - filled_width))
  local filled_bar=""
  local empty_bar=""
  filled_bar="$(printf '%*s' "$filled_width" '' | tr ' ' '#')"
  empty_bar="$(printf '%*s' "$empty_width" '' | tr ' ' '-')"

  printf "\rChecking package statuses: [%s%s] %3d%% (%d/%d) elapsed %s, left %s" \
    "$filled_bar" "$empty_bar" "$percent" "$current" "$total" \
    "$(format_duration "$elapsed")" "$(format_duration "$remaining")"
}

npm_latest_version_for() {
  local package_name="$1"
  local output=""
  local latest=""

  output="$(npm view "${package_name}@latest" version 2>/dev/null || true)"
  while IFS= read -r line; do
    line="${line//$'\r'/}"
    if [[ -n "$line" ]]; then
      latest="$line"
    fi
  done <<< "$output"

  printf '%s' "$latest"
}

PACKAGE_JSON_FILES=()
for package_json in \
  "$ROOT_DIR"/pi-extension-*/package.json \
  "$ROOT_DIR"/pi-skill-*/package.json \
  "$ROOT_DIR"/pi-package-*/package.json
do
  if [[ -f "$package_json" ]]; then
    PACKAGE_JSON_FILES+=("$package_json")
  fi
done

if [[ ${#PACKAGE_JSON_FILES[@]} -eq 0 ]]; then
  echo "No local pi-extension/pi-skill/pi-package package.json files found under $ROOT_DIR"
  exit 0
fi

LEGACY_NPM_GLOBAL_ROOT="$(npm root -g 2>/dev/null || true)"
LEGACY_NPM_GLOBAL_ROOT="${LEGACY_NPM_GLOBAL_ROOT//$'\r'/}"

pi_user_package_state_for() {
  local package_name="$1"

  node - "$package_name" "$LEGACY_NPM_GLOBAL_ROOT" <<'NODE'
const fs = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const packageName = process.argv[2];
const legacyNpmRoot = process.argv[3] || "";

let agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
if (agentDir === "~") {
  agentDir = homedir();
} else if (agentDir.startsWith("~/") || (process.platform === "win32" && agentDir.startsWith("~\\"))) {
  agentDir = join(homedir(), agentDir.slice(2));
}

function npmPackageName(source) {
  if (typeof source !== "string" || !source.startsWith("npm:")) return null;
  const spec = source.slice("npm:".length);
  if (spec.startsWith("@")) {
    const slashIndex = spec.indexOf("/");
    if (slashIndex < 0) return null;
    const versionIndex = spec.indexOf("@", slashIndex + 1);
    return versionIndex < 0 ? spec : spec.slice(0, versionIndex);
  }
  const versionIndex = spec.indexOf("@");
  return versionIndex < 0 ? spec : spec.slice(0, versionIndex);
}

const managedPackageJson = join(agentDir, "npm", "node_modules", ...packageName.split("/"), "package.json");
const legacyPackageJson = legacyNpmRoot
  ? join(legacyNpmRoot, ...packageName.split("/"), "package.json")
  : "";
const installedPackageJson = fs.existsSync(managedPackageJson)
  ? managedPackageJson
  : legacyPackageJson && fs.existsSync(legacyPackageJson)
    ? legacyPackageJson
    : "";

let installedVersion = "";
if (installedPackageJson) {
  try {
    installedVersion = String(JSON.parse(fs.readFileSync(installedPackageJson, "utf8")).version || "");
  } catch {
    installedVersion = "";
  }
}

const settingsFile = join(agentDir, "settings.json");
let configured = false;
if (fs.existsSync(settingsFile)) {
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  } catch (error) {
    console.error(`ERROR: could not parse Pi user settings at ${settingsFile}: ${error.message}`);
    process.exit(1);
  }
  const packages = Array.isArray(settings.packages) ? settings.packages : [];
  configured = packages.some((entry) => {
    const source = typeof entry === "string" ? entry : entry && typeof entry === "object" ? entry.source : null;
    return npmPackageName(source) === packageName;
  });
}

process.stdout.write(`${configured ? "1" : "0"}\t${installedVersion}`);
NODE
}

echo "Discovered ${#PACKAGE_JSON_FILES[@]} local Pi package(s) (extensions/skills/packages)."

PACKAGE_NAMES=()
PACKAGE_REPO_VERSIONS=()
PACKAGE_NPM_LATEST_VERSIONS=()
PACKAGE_KINDS=()
PACKAGE_INSTALLED_VERSIONS=()
PACKAGE_CONFIGURED=()
PACKAGE_STATUS_LABELS=()
REGISTRATION_CANDIDATES=()
NEW_INSTALL_CANDIDATES=()
UPDATE_CANDIDATES=()
UP_TO_DATE_CANDIDATES=()
FORCE_REINSTALL_CANDIDATES=()
NPM_QUERY_FAILED_CANDIDATES=()
SELECTABLE_PACKAGE_INDEXES=()
CHECK_PROGRESS_ENABLED=0
CHECK_PROGRESS_TOTAL=${#PACKAGE_JSON_FILES[@]}
CHECK_PROGRESS_START_SECONDS=$SECONDS
CHECK_PROGRESS_COUNT=0
if [[ -t 1 ]]; then
  CHECK_PROGRESS_ENABLED=1
  render_check_progress 0 "$CHECK_PROGRESS_TOTAL" "$CHECK_PROGRESS_START_SECONDS"
else
  echo "Checking package statuses ($CHECK_PROGRESS_TOTAL packages, up to $NPM_STATUS_CONCURRENCY concurrent npm queries)..."
fi

# npm lookups dominate this check. Resolve them concurrently and cache both the
# npm result and local Pi state so the classification loop below does no network
# work and does not repeatedly launch the state-inspection process.
STATUS_CACHE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/install-pi-add.XXXXXX")"
trap 'rm -rf "$STATUS_CACHE_DIR"' EXIT
STATUS_CHECK_PIDS=()
for status_cache_index in "${!PACKAGE_JSON_FILES[@]}"; do
  package_json="${PACKAGE_JSON_FILES[$status_cache_index]}"
  (
    cached_package_name="$(node -p "require(process.argv[1]).name" "$package_json" 2>/dev/null || true)"
    if [[ -n "$cached_package_name" && "$cached_package_name" != "undefined" ]]; then
      npm_latest_version_for "$cached_package_name" > "$STATUS_CACHE_DIR/$status_cache_index.latest"
      pi_user_package_state_for "$cached_package_name" > "$STATUS_CACHE_DIR/$status_cache_index.state"
    else
      : > "$STATUS_CACHE_DIR/$status_cache_index.latest"
      : > "$STATUS_CACHE_DIR/$status_cache_index.state"
    fi
  ) &
  STATUS_CHECK_PIDS+=("$!")

  if (( ${#STATUS_CHECK_PIDS[@]} >= NPM_STATUS_CONCURRENCY )); then
    for status_check_pid in "${STATUS_CHECK_PIDS[@]}"; do
      wait "$status_check_pid"
      CHECK_PROGRESS_COUNT=$((CHECK_PROGRESS_COUNT + 1))
      if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
        render_check_progress "$CHECK_PROGRESS_COUNT" "$CHECK_PROGRESS_TOTAL" "$CHECK_PROGRESS_START_SECONDS"
      fi
    done
    STATUS_CHECK_PIDS=()
  fi
done
for status_check_pid in "${STATUS_CHECK_PIDS[@]}"; do
  wait "$status_check_pid"
  CHECK_PROGRESS_COUNT=$((CHECK_PROGRESS_COUNT + 1))
  if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
    render_check_progress "$CHECK_PROGRESS_COUNT" "$CHECK_PROGRESS_TOTAL" "$CHECK_PROGRESS_START_SECONDS"
  fi
done
if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
  echo
fi
CHECK_PROGRESS_ENABLED=0
status_cache_index=0

for package_json in "${PACKAGE_JSON_FILES[@]}"; do
  current_status_cache_index="$status_cache_index"
  status_cache_index=$((status_cache_index + 1))
  package_name="$(node -p "require(process.argv[1]).name" "$package_json" 2>/dev/null || true)"
  package_version="$(node -p "require(process.argv[1]).version" "$package_json" 2>/dev/null || true)"
  package_dir_name="$(basename "$(dirname "$package_json")")"
  package_kind="package"
  if [[ "$package_dir_name" == pi-extension-* ]]; then
    package_kind="extension"
  elif [[ "$package_dir_name" == pi-skill-* ]]; then
    package_kind="skill"
  elif [[ "$package_dir_name" == pi-package-* ]]; then
    package_kind="package"
  fi

  if [[ -z "$package_name" || "$package_name" == "undefined" ]]; then
    if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
      echo
    fi
    echo "WARN: skipping '$package_json' because package name could not be read." >&2
    CHECK_PROGRESS_COUNT=$((CHECK_PROGRESS_COUNT + 1))
    if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
      render_check_progress "$CHECK_PROGRESS_COUNT" "$CHECK_PROGRESS_TOTAL" "$CHECK_PROGRESS_START_SECONDS"
    fi
    continue
  fi
  if [[ -z "$package_version" || "$package_version" == "undefined" ]]; then
    if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
      echo
    fi
    echo "WARN: skipping '$package_json' because package version could not be read." >&2
    CHECK_PROGRESS_COUNT=$((CHECK_PROGRESS_COUNT + 1))
    if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
      render_check_progress "$CHECK_PROGRESS_COUNT" "$CHECK_PROGRESS_TOTAL" "$CHECK_PROGRESS_START_SECONDS"
    fi
    continue
  fi

  npm_latest_version="$(<"$STATUS_CACHE_DIR/$current_status_cache_index.latest")"
  if [[ -z "$npm_latest_version" ]]; then
    if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
      echo
    fi
    echo "WARN: skipping '$package_name' because npm latest version could not be resolved." >&2
    NPM_QUERY_FAILED_CANDIDATES+=("$package_name")
    CHECK_PROGRESS_COUNT=$((CHECK_PROGRESS_COUNT + 1))
    if [[ $CHECK_PROGRESS_ENABLED -eq 1 ]]; then
      render_check_progress "$CHECK_PROGRESS_COUNT" "$CHECK_PROGRESS_TOTAL" "$CHECK_PROGRESS_START_SECONDS"
    fi
    continue
  fi

  package_index="${#PACKAGE_NAMES[@]}"
  PACKAGE_NAMES+=("$package_name")
  PACKAGE_REPO_VERSIONS+=("$package_version")
  PACKAGE_NPM_LATEST_VERSIONS+=("$npm_latest_version")
  PACKAGE_KINDS+=("$package_kind")

  package_state="$(<"$STATUS_CACHE_DIR/$current_status_cache_index.state")"
  IFS=$'\t' read -r package_configured installed_version <<< "$package_state"
  package_configured="${package_configured:-0}"
  installed_version="${installed_version:-}"

  target_version="$npm_latest_version"
  version_note=""
  if [[ "$package_version" != "$target_version" ]]; then
    version_note=" (repo package.json $package_version)"
  fi

  PACKAGE_INSTALLED_VERSIONS+=("$installed_version")
  PACKAGE_CONFIGURED+=("$package_configured")
  if [[ "$package_configured" != "1" ]]; then
    installed_note=""
    if [[ -n "$installed_version" ]]; then
      installed_note=" (files already present at $installed_version)"
    fi
    PACKAGE_STATUS_LABELS+=("register with Pi -> $target_version$installed_note$version_note")
    REGISTRATION_CANDIDATES+=("${package_name}@${target_version}")
    SELECTABLE_PACKAGE_INDEXES+=("$package_index")
  elif [[ -z "$installed_version" ]]; then
    PACKAGE_STATUS_LABELS+=("repair missing install -> $target_version$version_note")
    NEW_INSTALL_CANDIDATES+=("${package_name}@${target_version}")
    SELECTABLE_PACKAGE_INDEXES+=("$package_index")
  elif [[ "$installed_version" == "$target_version" ]]; then
    if [[ $FORCE_INSTALL -eq 1 ]]; then
      PACKAGE_STATUS_LABELS+=("force reinstall $target_version$version_note")
      FORCE_REINSTALL_CANDIDATES+=("${package_name}@${target_version}")
      SELECTABLE_PACKAGE_INDEXES+=("$package_index")
    else
      PACKAGE_STATUS_LABELS+=("up to date $target_version$version_note")
      UP_TO_DATE_CANDIDATES+=("${package_name}@${target_version}")
    fi
  else
    PACKAGE_STATUS_LABELS+=("update $installed_version -> $target_version$version_note")
    UPDATE_CANDIDATES+=("${package_name} (${installed_version} -> ${target_version})")
    SELECTABLE_PACKAGE_INDEXES+=("$package_index")
  fi

done

if [[ ${#PACKAGE_NAMES[@]} -eq 0 ]]; then
  echo "No packages with resolvable npm latest versions discovered."
  exit 1
fi

echo "Status before selection:"
echo "  Packages requiring Pi registration: ${#REGISTRATION_CANDIDATES[@]}"
echo "  Missing installs to repair: ${#NEW_INSTALL_CANDIDATES[@]}"
echo "  Updates available: ${#UPDATE_CANDIDATES[@]}"
if [[ $FORCE_INSTALL -eq 1 ]]; then
  echo "  Force reinstalls available: ${#FORCE_REINSTALL_CANDIDATES[@]}"
else
  echo "  Already up to date (hidden; use --force to show/reinstall): ${#UP_TO_DATE_CANDIDATES[@]}"
fi
echo "  Skipped (npm latest unavailable): ${#NPM_QUERY_FAILED_CANDIDATES[@]}"

if [[ ${#SELECTABLE_PACKAGE_INDEXES[@]} -eq 0 ]]; then
  if [[ $FORCE_INSTALL -eq 1 ]]; then
    echo "No packages available to register/install/update/reinstall. Exiting."
  else
    echo "No packages to register/install/update. Use --force to show/reinstall already up-to-date packages."
  fi
  exit 0
fi

SELECTED_PACKAGES=()
if [[ $INSTALL_ALL -eq 1 ]]; then
  for package_index in "${SELECTABLE_PACKAGE_INDEXES[@]}"; do
    SELECTED_PACKAGES+=("${PACKAGE_NAMES[$package_index]}")
  done
else
  if [[ ! -t 0 ]]; then
    echo "ERROR: interactive mode requires a TTY. Use --non-interactive or --all for non-interactive usage." >&2
    exit 1
  fi

  if [[ $FORCE_INSTALL -eq 1 ]]; then
    echo "Select package numbers to register/install/update/reinstall (space/comma separated), or type 'all':"
  else
    echo "Select package numbers to register/install/update (space/comma separated), or type 'all':"
  fi
  for display_idx in "${!SELECTABLE_PACKAGE_INDEXES[@]}"; do
    package_index="${SELECTABLE_PACKAGE_INDEXES[$display_idx]}"
    package_name="${PACKAGE_NAMES[$package_index]}"
    printf "  %2d) %-58s [%s] %s\n" "$((display_idx + 1))" "$package_name" "${PACKAGE_KINDS[$package_index]}" "${PACKAGE_STATUS_LABELS[$package_index]}"
  done
  printf "> "
  read -r selection

  trimmed_selection="${selection//[[:space:]]/}"
  if [[ -z "$trimmed_selection" ]]; then
    echo "No packages selected. Exiting."
    exit 0
  fi

  lower_trimmed_selection="$(printf '%s' "$trimmed_selection" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower_trimmed_selection" == "all" ]]; then
    for package_index in "${SELECTABLE_PACKAGE_INDEXES[@]}"; do
      SELECTED_PACKAGES+=("${PACKAGE_NAMES[$package_index]}")
    done
  else
    # A pasted selection can contain a carriage return on Windows. Remove it
    # before splitting, and avoid regex matching for this simple digit check.
    normalized_selection="${selection//$'\r'/}"
    normalized_selection="${normalized_selection//,/ }"
    for token in $normalized_selection; do
      case "$token" in
        ''|*[!0-9]*)
          printf "ERROR: invalid selection token %q.\n" "$token" >&2
          exit 1
          ;;
      esac
      if (( token < 1 || token > ${#SELECTABLE_PACKAGE_INDEXES[@]} )); then
        echo "ERROR: selection '$token' is out of range." >&2
        exit 1
      fi
      package_index="${SELECTABLE_PACKAGE_INDEXES[$((token - 1))]}"
      SELECTED_PACKAGES+=("${PACKAGE_NAMES[$package_index]}")
    done
  fi

  if [[ ${#SELECTED_PACKAGES[@]} -eq 0 ]]; then
    echo "No packages selected. Exiting."
    exit 0
  fi
fi
NEWLY_INSTALLED=()
UPDATED_PACKAGES=()
REINSTALLED_PACKAGES=()
REGISTERED_PACKAGES=()
SKIPPED_UP_TO_DATE=()
PREVIEWED_PACKAGES=()
FAILED_PACKAGES=()
FAILED_EXIT_CODES=()
FAILED_INSTALL_LOGS=()
install_attempt_index=0

for package_name in "${SELECTED_PACKAGES[@]}"; do
  package_index=-1
  for idx in "${!PACKAGE_NAMES[@]}"; do
    if [[ "${PACKAGE_NAMES[$idx]}" == "$package_name" ]]; then
      package_index="$idx"
      break
    fi
  done
  if [[ "$package_index" -lt 0 ]]; then
    echo "WARN: skipping '$package_name' because its metadata could not be found." >&2
    continue
  fi

  repo_version="${PACKAGE_REPO_VERSIONS[$package_index]}"
  target_version="${PACKAGE_NPM_LATEST_VERSIONS[$package_index]}"
  installed_version="${PACKAGE_INSTALLED_VERSIONS[$package_index]}"
  package_configured="${PACKAGE_CONFIGURED[$package_index]}"
  package_kind="${PACKAGE_KINDS[$package_index]}"

  if [[ $FORCE_INSTALL -eq 0 && "$package_configured" == "1" && -n "$installed_version" && "$installed_version" == "$target_version" ]]; then
    echo "Skipping ${package_kind} npm:${package_name} (already installed at latest npm version $installed_version)"
    SKIPPED_UP_TO_DATE+=("${package_name}@${installed_version}")
    continue
  fi

  install_target="npm:${package_name}"
  repo_note=""
  if [[ "$repo_version" != "$target_version" ]]; then
    repo_note=" (repo package.json $repo_version)"
  fi

  result_category=""
  result_entry=""
  action_description=""
  if [[ "$package_configured" != "1" ]]; then
    installed_note=""
    if [[ -n "$installed_version" ]]; then
      installed_note="; files already present at $installed_version"
    fi
    result_category="registered"
    result_entry="${package_name}@${target_version}"
    action_description="registering with Pi at $target_version$installed_note$repo_note"
  elif [[ $FORCE_INSTALL -eq 1 && -n "$installed_version" && "$installed_version" == "$target_version" ]]; then
    result_category="reinstalled"
    result_entry="${package_name}@${target_version}"
    action_description="force reinstall version $target_version$repo_note"
  elif [[ -n "$installed_version" ]]; then
    result_category="updated"
    result_entry="${package_name} (${installed_version} -> ${target_version})"
    action_description="updating $installed_version -> $target_version$repo_note"
  else
    result_category="new"
    result_entry="${package_name}@${target_version}"
    action_description="target version $target_version$repo_note"
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    printf "[DRY RUN] %-58s pi install %s\n" "$package_name" "$install_target"
    PREVIEWED_PACKAGES+=("$result_entry")
    continue
  fi

  install_log="$STATUS_CACHE_DIR/install-$install_attempt_index.log"
  install_attempt_index=$((install_attempt_index + 1))
  if pi install "$install_target" >"$install_log" 2>&1; then
    printf "[PASS] %-61s %s\n" "$package_name" "$action_description"
    case "$result_category" in
      registered) REGISTERED_PACKAGES+=("$result_entry") ;;
      reinstalled) REINSTALLED_PACKAGES+=("$result_entry") ;;
      updated) UPDATED_PACKAGES+=("$result_entry") ;;
      new) NEWLY_INSTALLED+=("$result_entry") ;;
    esac
  else
    install_exit_code=$?
    printf "[FAILED] %-59s exit code %d\n" "$package_name" "$install_exit_code"
    FAILED_PACKAGES+=("$package_name")
    FAILED_EXIT_CODES+=("$install_exit_code")
    FAILED_INSTALL_LOGS+=("$install_log")
  fi
done

echo
echo "Summary:"
echo "  Registered with Pi: ${#REGISTERED_PACKAGES[@]}"
for entry in ${REGISTERED_PACKAGES[@]+"${REGISTERED_PACKAGES[@]}"}; do
  echo "    - $entry"
done
echo "  Newly installed: ${#NEWLY_INSTALLED[@]}"
for entry in ${NEWLY_INSTALLED[@]+"${NEWLY_INSTALLED[@]}"}; do
  echo "    - $entry"
done
echo "  Updated packages: ${#UPDATED_PACKAGES[@]}"
for entry in ${UPDATED_PACKAGES[@]+"${UPDATED_PACKAGES[@]}"}; do
  echo "    - $entry"
done
echo "  Reinstalled packages: ${#REINSTALLED_PACKAGES[@]}"
for entry in ${REINSTALLED_PACKAGES[@]+"${REINSTALLED_PACKAGES[@]}"}; do
  echo "    - $entry"
done
echo "  Skipped (already up to date): ${#SKIPPED_UP_TO_DATE[@]}"
for entry in ${SKIPPED_UP_TO_DATE[@]+"${SKIPPED_UP_TO_DATE[@]}"}; do
  echo "    - $entry"
done
echo "  Dry-run previews: ${#PREVIEWED_PACKAGES[@]}"
for entry in ${PREVIEWED_PACKAGES[@]+"${PREVIEWED_PACKAGES[@]}"}; do
  echo "    - $entry"
done
echo "  Failed installs: ${#FAILED_PACKAGES[@]}"

if [[ ${#FAILED_PACKAGES[@]} -gt 0 ]]; then
  echo
  echo "Failed package details (last 20 output lines each):"
  for failed_index in "${!FAILED_PACKAGES[@]}"; do
    echo "  - ${FAILED_PACKAGES[$failed_index]} (exit code ${FAILED_EXIT_CODES[$failed_index]})"
    while IFS= read -r output_line; do
      printf "      %s\n" "$output_line"
    done < <(tail -n 20 "${FAILED_INSTALL_LOGS[$failed_index]}")
  done
  echo
  echo "Completed with ${#FAILED_PACKAGES[@]} failed package(s)." >&2
  exit 1
fi

echo "Done."
