#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd -P)"
ROOT_DIR="${PI_NPM_PACKAGES_ROOT:-$DEFAULT_ROOT_DIR}"
TARGET="all"
TARGETS_FILE=""
PUBLISHER="npm"    # auto|bun|npm
ACCESS="public"
APPLY=0
STRICT_AUTH=0

usage() {
  cat <<'EOF'
Usage:
  publish-packages.sh [options]
  publish-packages.sh [package-dir-name]

Options:
  --publisher <auto|bun|npm>   Publishing client (default: npm)
  --target <name|all>          Publish one package dir or all (default: all)
  --targets-file <path>        Publish/check package dirs listed one per line
  --all                        Same as --target all
  --access <public|restricted> Publish access level (default: public)
  --apply                      Actually publish packages (default: plan only)
  --strict-auth                Fail immediately when auth check fails
  -h, --help                   Show help

Examples:
  ./dev/scripts/publish-packages.sh
  ./dev/scripts/publish-packages.sh --all --apply
  ./dev/scripts/publish-packages.sh --publisher bun --apply
  ./dev/scripts/publish-packages.sh pi-extension-notes --apply
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --publisher)
      PUBLISHER="${2:-}"
      shift 2
      ;;
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --targets-file)
      TARGETS_FILE="${2:-}"
      shift 2
      ;;
    --all)
      TARGET="all"
      shift
      ;;
    --access)
      ACCESS="${2:-}"
      shift 2
      ;;
    --apply)
      APPLY=1
      shift
      ;;
    --strict-auth)
      STRICT_AUTH=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --*)
      echo "ERROR: unknown option '$1'" >&2
      usage
      exit 1
      ;;
    *)
      if [[ "$TARGET" != "all" ]]; then
        echo "ERROR: multiple positional targets provided: '$TARGET' and '$1'" >&2
        exit 1
      fi
      TARGET="$1"
      shift
      ;;
  esac
done

if [[ -n "$TARGETS_FILE" && "$TARGET" != "all" ]]; then
  echo "ERROR: --targets-file cannot be combined with --target or a positional target" >&2
  exit 1
fi

if [[ -n "$TARGETS_FILE" && ! -f "$TARGETS_FILE" ]]; then
  echo "ERROR: targets file not found: $TARGETS_FILE" >&2
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

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required but not found in PATH." >&2
  exit 1
fi

HAS_NPM=0
HAS_BUN=0
command -v npm >/dev/null 2>&1 && HAS_NPM=1
command -v bun >/dev/null 2>&1 && HAS_BUN=1

if [[ "$PUBLISHER" == "auto" ]]; then
  if [[ $HAS_NPM -eq 1 ]]; then
    PRIMARY_CLIENT="npm"
  elif [[ $HAS_BUN -eq 1 ]]; then
    PRIMARY_CLIENT="bun"
  else
    echo "ERROR: neither bun nor npm is installed." >&2
    exit 1
  fi
else
  PRIMARY_CLIENT="$PUBLISHER"
fi

if [[ "$PRIMARY_CLIENT" == "bun" && $HAS_BUN -ne 1 ]]; then
  echo "ERROR: bun selected but bun is not installed." >&2
  exit 1
fi
if [[ "$PRIMARY_CLIENT" == "npm" && $HAS_NPM -ne 1 ]]; then
  echo "ERROR: npm selected but npm is not installed." >&2
  exit 1
fi

SECONDARY_CLIENT=""
if [[ "$PRIMARY_CLIENT" == "bun" && $HAS_NPM -eq 1 ]]; then
  SECONDARY_CLIENT="npm"
elif [[ "$PRIMARY_CLIENT" == "npm" && $HAS_BUN -eq 1 ]]; then
  SECONDARY_CLIENT="bun"
fi

REGISTRY_CLIENT=""
if [[ $HAS_NPM -eq 1 ]]; then
  REGISTRY_CLIENT="npm"
elif [[ $HAS_BUN -eq 1 ]]; then
  REGISTRY_CLIENT="bun"
fi

color() {
  local code="$1"; shift
  printf "\033[%sm%s\033[0m" "$code" "$*"
}
ok() { color "32" "PASS"; }
warn() { color "33" "WARN"; }
fail() { color "31" "FAIL"; }
info() { color "36" "$*"; }

print_check() {
  local status="$1"; shift
  local msg="$*"
  printf "  - [%s] %s\n" "$status" "$msg"
}

release_event() {
  local status="$1"
  local name="$2"
  local version="$3"
  local action="$4"
  local detail="${5:-}"
  node -e '
    const [, , status, name, version, action, detail] = process.argv;
    console.log("RELEASE_NPM_EVENT " + JSON.stringify({ status, name, version, action, detail }));
  ' "$status" "$name" "$version" "$action" "$detail"
}

json_get() {
  local file="$1"
  local expr="$2"
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const v=(function(){return ${expr}})();if(v===undefined||v===null){process.exit(2)};if(typeof v==='object')console.log(JSON.stringify(v));else console.log(String(v));" "$file" 2>/dev/null
}

is_optional_node_module_resource() {
  local pkg_json="$1"
  local resource_path="$2"
  [[ "$resource_path" == node_modules/* ]] || return 1
  node -e '
    const fs = require("fs");
    const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const resource = process.argv[2];
    if (!resource.startsWith("node_modules/")) process.exit(1);
    const rest = resource.slice("node_modules/".length);
    const parts = rest.split("/").filter(Boolean);
    const dependency = rest.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
    process.exit(pkg.optionalDependencies && Object.prototype.hasOwnProperty.call(pkg.optionalDependencies, dependency) ? 0 : 1);
  ' "$pkg_json" "$resource_path" 2>/dev/null
}

check_auth() {
  local client="$1"
  local dir="$2"

  if [[ "$client" == "npm" ]]; then
    npm whoami >/dev/null 2>&1
    return $?
  fi

  if [[ "$client" == "bun" ]]; then
    (cd "$dir" && bun pm whoami >/dev/null 2>&1)
    if [[ $? -eq 0 ]]; then
      return 0
    fi
    [[ -n "${NPM_CONFIG_TOKEN:-}" ]]
    return $?
  fi

  return 1
}

# Captures the client's output in DRY_RUN_OUTPUT instead of discarding it, so a
# blocked package can show the actual error. The caller prints it only for real
# failures, because an already-published version also fails the dry run.
DRY_RUN_OUTPUT=""
run_publish_dry_run() {
  local client="$1"
  local dir="$2"
  local access="$3"
  local status=0

  DRY_RUN_OUTPUT=""
  case "$client" in
    npm|bun) ;;
    *) return 1 ;;
  esac

  DRY_RUN_OUTPUT="$(cd "$dir" && "$client" publish --dry-run --access "$access" 2>&1)" || status=$?
  return $status
}

print_dry_run_tail() {
  [[ -n "$DRY_RUN_OUTPUT" ]] || return 0
  printf '%s\n' "$DRY_RUN_OUTPUT" | tail -n 15 | sed 's/^/      | /'
}

run_publish() {
  local client="$1"
  local dir="$2"
  local access="$3"

  if [[ "$client" == "npm" ]]; then
    (cd "$dir" && npm publish --access "$access")
    return $?
  fi

  if [[ "$client" == "bun" ]]; then
    (cd "$dir" && bun publish --access "$access")
    return $?
  fi

  return 1
}

registry_check() {
  local name="$1"
  local version="$2"

  if [[ "$REGISTRY_CLIENT" == "npm" ]]; then
    if npm view "$name" version >/dev/null 2>&1; then
      local latest
      latest="$(npm view "$name" version 2>/dev/null | tail -n1)"
      echo "exists|$latest"
      if npm view "$name@$version" version >/dev/null 2>&1; then
        echo "version_exists|$version"
      else
        echo "version_free|$version"
      fi
    else
      echo "missing|"
      echo "version_free|$version"
    fi
    return 0
  fi

  if [[ "$REGISTRY_CLIENT" == "bun" ]]; then
    if bun pm view "$name" version >/dev/null 2>&1; then
      local latest
      latest="$(bun pm view "$name" version 2>/dev/null | tail -n1 | tr -d '[:space:]')"
      echo "exists|$latest"
      if bun pm view "$name@$version" version >/dev/null 2>&1; then
        echo "version_exists|$version"
      else
        echo "version_free|$version"
      fi
    else
      echo "missing|"
      echo "version_free|$version"
    fi
    return 0
  fi

  return 1
}

resolve_package_target() {
  local target="$1"
  local pkg_dir
  if [[ "$target" = /* ]]; then
    pkg_dir="$target"
  else
    pkg_dir="$ROOT_DIR/$target"
  fi

  if [[ -d "$pkg_dir" && -f "$pkg_dir/package.json" ]]; then
    printf "%s\n" "$pkg_dir"
    return 0
  fi

  echo "ERROR: package '$target' not found under $ROOT_DIR" >&2
  return 1
}

gather_packages() {
  if [[ -n "$TARGETS_FILE" ]]; then
    local raw target pkg_dir
    declare -A seen=()
    while IFS= read -r raw || [[ -n "$raw" ]]; do
      target="$(printf '%s' "$raw" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
      [[ -z "$target" || "$target" == \#* ]] && continue
      pkg_dir="$(resolve_package_target "$target")" || exit 1
      if [[ -z "${seen[$pkg_dir]+x}" ]]; then
        seen[$pkg_dir]=1
        printf "%s\n" "$pkg_dir"
      fi
    done < "$TARGETS_FILE"
    return
  fi

  if [[ "$TARGET" != "all" ]]; then
    resolve_package_target "$TARGET" || exit 1
    return
  fi

  find "$ROOT_DIR" -mindepth 1 -maxdepth 1 -type d \
    ! -name ".*" \
    -exec test -f "{}/package.json" ';' -print | sort
}

mapfile -t PACKAGE_DIRS < <(gather_packages)
if [[ ${#PACKAGE_DIRS[@]} -eq 0 ]]; then
  echo "No packages found under $ROOT_DIR" >&2
  exit 1
fi

echo "Publisher client: $PRIMARY_CLIENT"
echo "Fallback client: ${SECONDARY_CLIENT:-none}"
echo "Registry check client: ${REGISTRY_CLIENT:-none}"
echo "Mode: $([[ $APPLY -eq 1 ]] && echo "apply" || echo "plan")"
echo

AUTH_OK=0
if check_auth "$PRIMARY_CLIENT" "${PACKAGE_DIRS[0]}"; then
  AUTH_OK=1
  echo "Auth: $(ok) $PRIMARY_CLIENT credentials detected"
else
  echo "Auth: $(warn) $PRIMARY_CLIENT credentials not detected"
  if [[ $STRICT_AUTH -eq 1 ]]; then
    echo "Auth policy: $(fail) strict auth enabled"
    exit 1
  fi
fi

echo

# plans: each item is "dir|name|version|action"
PLANS=()
HAS_FAIL=0
FAILED_CHECK_ITEMS=()

for pkg_dir in "${PACKAGE_DIRS[@]}"; do
  echo "$(info "==>") $(basename "$pkg_dir")"
  pkg_fail=0
  action=""

  pkg_json="$pkg_dir/package.json"
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$pkg_json" >/dev/null 2>&1; then
    print_check "$(ok)" "package.json is valid JSON"
  else
    print_check "$(fail)" "package.json is invalid JSON"
    HAS_FAIL=1
    echo
    continue
  fi

  name="$(json_get "$pkg_json" 'p.name' || true)"
  version="$(json_get "$pkg_json" 'p.version' || true)"

  [[ -n "$name" ]] && print_check "$(ok)" "name: $name" || { print_check "$(fail)" "missing package name"; pkg_fail=1; }
  [[ -n "$version" ]] && print_check "$(ok)" "version: $version" || { print_check "$(fail)" "missing version"; pkg_fail=1; }

  if [[ -f "$pkg_dir/README.md" ]]; then
    print_check "$(ok)" "README.md exists"
  else
    print_check "$(warn)" "README.md missing"
  fi

  if [[ -f "$pkg_dir/LICENSE" ]]; then
    print_check "$(ok)" "LICENSE exists"
  else
    print_check "$(warn)" "LICENSE missing"
  fi

  resource_count="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));let n=0;for(const k of ["extensions","skills","prompts","themes"]){if(Array.isArray(p.pi?.[k])) n+=p.pi[k].length}console.log(n)' "$pkg_json" 2>/dev/null || echo 0)"
  has_bin="$(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const b=p.bin;console.log(typeof b==="string" || (b && typeof b==="object" && Object.keys(b).length>0) ? "true" : "false")' "$pkg_json" 2>/dev/null || echo false)"
  if [[ "$resource_count" -eq 0 ]]; then
    if [[ "$has_bin" == "true" ]]; then
      print_check "$(ok)" "CLI/bin companion package (no pi manifest resources)"
    else
      print_check "$(fail)" "pi manifest has no extensions, skills, prompts, or themes"
      pkg_fail=1
    fi
  else
    print_check "$(ok)" "pi manifest resource entries: $resource_count"
    while IFS='|' read -r resource_type resource_path; do
      [[ -z "$resource_path" ]] && continue
      resource_clean="${resource_path#./}"

      if [[ "$resource_clean" == *"*"* || "$resource_clean" == *"?"* || "$resource_clean" == *"["* ]]; then
        shopt -s nullglob
        matches=("$pkg_dir"/$resource_clean)
        shopt -u nullglob
        if [[ ${#matches[@]} -gt 0 ]]; then
          print_check "$(ok)" "$resource_type glob matches ${#matches[@]} path(s): $resource_path"
        else
          print_check "$(fail)" "$resource_type glob has no matches: $resource_path"
          pkg_fail=1
        fi
      else
        if [[ -e "$pkg_dir/$resource_clean" ]]; then
          print_check "$(ok)" "$resource_type entry exists: $resource_path"
        elif is_optional_node_module_resource "$pkg_json" "$resource_clean"; then
          print_check "$(warn)" "$resource_type optional dependency entry not installed in source workspace: $resource_path"
        else
          print_check "$(fail)" "$resource_type entry missing: $resource_path"
          pkg_fail=1
        fi
      fi
    done < <(node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));for(const k of ["extensions","skills","prompts","themes"]){for(const e of (p.pi?.[k]||[])) console.log(`${k}|${e}`)}' "$pkg_json")
  fi

  dry_run_ok=1
  if run_publish_dry_run "$PRIMARY_CLIENT" "$pkg_dir" "$ACCESS"; then
    print_check "$(ok)" "$PRIMARY_CLIENT publish --dry-run succeeds"
  else
    dry_run_ok=0
  fi

  pkg_exists=0
  version_exists=0
  latest=""

  if [[ -n "$name" && -n "$version" && -n "$REGISTRY_CLIENT" ]]; then
    while IFS='|' read -r status payload; do
      case "$status" in
        exists)
          pkg_exists=1
          latest="$payload"
          ;;
        missing)
          pkg_exists=0
          ;;
        version_exists)
          version_exists=1
          ;;
        version_free)
          version_exists=0
          ;;
      esac
    done < <(registry_check "$name" "$version")

    if [[ $pkg_exists -eq 1 ]]; then
      print_check "$(ok)" "package exists on npm (latest: ${latest:-unknown})"
    else
      print_check "$(ok)" "package not found on npm (first publish)"
    fi

    if [[ $version_exists -eq 1 ]]; then
      print_check "$(info "INFO")" "version $version already published"
    else
      print_check "$(ok)" "version $version not published yet"
    fi
  else
    print_check "$(warn)" "registry checks skipped"
    pkg_fail=1
  fi

  if [[ $dry_run_ok -eq 0 ]]; then
    if [[ $version_exists -eq 1 ]]; then
      print_check "$(info "INFO")" "$PRIMARY_CLIENT publish --dry-run failed because version is already published"
    elif [[ $AUTH_OK -eq 0 && $STRICT_AUTH -eq 0 ]]; then
      print_check "$(warn)" "$PRIMARY_CLIENT publish --dry-run failed (likely auth-related)"
      print_dry_run_tail
    else
      print_check "$(fail)" "$PRIMARY_CLIENT publish --dry-run failed"
      print_dry_run_tail
      pkg_fail=1
    fi
  fi

  if [[ $pkg_fail -eq 0 ]]; then
    if [[ $pkg_exists -eq 0 ]]; then
      action="publish-first"
      print_check "$(ok)" "action: publish (first release)"
    elif [[ $version_exists -eq 0 ]]; then
      action="publish-update"
      print_check "$(ok)" "action: publish (new version)"
    else
      action="skip"
      print_check "$(ok)" "action: skip (same version already published)"
    fi
  else
    action="error"
    print_check "$(fail)" "action: blocked (fix checks first)"
  fi

  PLANS+=("$pkg_dir|$name|$version|$action")

  if [[ "$action" == "error" ]]; then
    HAS_FAIL=1
    FAILED_CHECK_ITEMS+=("$name@$version")
    echo "  Result: $(fail)"
  elif [[ "$action" == "skip" ]]; then
    echo "  Result: $(info "INFO") up-to-date (already published)"
  else
    echo "  Result: $(ok) ready"
  fi

  echo
done

echo "Plan summary:"
for item in "${PLANS[@]}"; do
  IFS='|' read -r dir name version action <<< "$item"
  printf "  - %s@%s -> %s\n" "$name" "$version" "$action"
done

echo

if [[ $APPLY -ne 1 ]]; then
  echo "Plan-only mode. Re-run with --apply to publish required packages."
  if [[ $HAS_FAIL -eq 1 ]]; then
    echo "Plan failures:"
    for item in "${FAILED_CHECK_ITEMS[@]}"; do
      echo "  - $item"
    done
    exit 1
  fi
  exit 0
fi

if [[ $STRICT_AUTH -eq 1 && $AUTH_OK -eq 0 ]]; then
  echo "Publish phase: $(fail) strict auth enabled and auth failed."
  exit 1
fi

echo "Starting publish phase with $PRIMARY_CLIENT..."
PUBLISH_FAIL=0
PUBLISHED_COUNT=0
PUBLISHED_PRIMARY_COUNT=0
PUBLISHED_FALLBACK_COUNT=0
PUBLISHED_FIRST_COUNT=0
PUBLISHED_UPDATE_COUNT=0
SKIPPED_COUNT=0
FAILED_COUNT=0
FALLBACK_ATTEMPT_COUNT=0
FAILED_ITEMS=()

for item in "${PLANS[@]}"; do
  IFS='|' read -r dir name version action <<< "$item"

  if [[ "$action" == "skip" ]]; then
    SKIPPED_COUNT=$((SKIPPED_COUNT+1))
    release_event "skipped" "$name" "$version" "$action" "already published"
    echo "$(info "INFO") Skipping $name@$version (already published)"
    continue
  fi

  if [[ "$action" == "error" ]]; then
    SKIPPED_COUNT=$((SKIPPED_COUNT+1))
    release_event "failed" "$name" "$version" "$action" "failed checks"
    echo "$(fail) Skipping $name@$version (failed checks)"
    PUBLISH_FAIL=1
    continue
  fi

  echo "$(info "Publishing") $name@$version ($action)"
  if run_publish "$PRIMARY_CLIENT" "$dir" "$ACCESS"; then
    PUBLISHED_COUNT=$((PUBLISHED_COUNT+1))
    PUBLISHED_PRIMARY_COUNT=$((PUBLISHED_PRIMARY_COUNT+1))
    if [[ "$action" == "publish-first" ]]; then
      PUBLISHED_FIRST_COUNT=$((PUBLISHED_FIRST_COUNT+1))
    elif [[ "$action" == "publish-update" ]]; then
      PUBLISHED_UPDATE_COUNT=$((PUBLISHED_UPDATE_COUNT+1))
    fi
    release_event "published" "$name" "$version" "$action" "via $PRIMARY_CLIENT"
    echo "$(ok) Published $name@$version via $PRIMARY_CLIENT"
  else
    if [[ -n "$SECONDARY_CLIENT" ]]; then
      FALLBACK_ATTEMPT_COUNT=$((FALLBACK_ATTEMPT_COUNT+1))
      echo "$(warn) $PRIMARY_CLIENT publish failed for $name@$version, trying fallback: $SECONDARY_CLIENT"
      if run_publish "$SECONDARY_CLIENT" "$dir" "$ACCESS"; then
        PUBLISHED_COUNT=$((PUBLISHED_COUNT+1))
        PUBLISHED_FALLBACK_COUNT=$((PUBLISHED_FALLBACK_COUNT+1))
        if [[ "$action" == "publish-first" ]]; then
          PUBLISHED_FIRST_COUNT=$((PUBLISHED_FIRST_COUNT+1))
        elif [[ "$action" == "publish-update" ]]; then
          PUBLISHED_UPDATE_COUNT=$((PUBLISHED_UPDATE_COUNT+1))
        fi
        release_event "published" "$name" "$version" "$action" "via fallback $SECONDARY_CLIENT"
        echo "$(ok) Published $name@$version via fallback $SECONDARY_CLIENT"
      else
        PUBLISH_FAIL=1
        FAILED_COUNT=$((FAILED_COUNT+1))
        FAILED_ITEMS+=("$name@$version")
        release_event "failed" "$name" "$version" "$action" "via both $PRIMARY_CLIENT and $SECONDARY_CLIENT"
        echo "$(fail) Failed to publish $name@$version via both $PRIMARY_CLIENT and $SECONDARY_CLIENT"
      fi
    else
      PUBLISH_FAIL=1
      FAILED_COUNT=$((FAILED_COUNT+1))
      FAILED_ITEMS+=("$name@$version")
      release_event "failed" "$name" "$version" "$action" "via $PRIMARY_CLIENT"
      echo "$(fail) Failed to publish $name@$version via $PRIMARY_CLIENT"
    fi
  fi

done

echo
echo "Publish summary:"
echo "  - published total: $PUBLISHED_COUNT"
echo "    - first-time publishes: $PUBLISHED_FIRST_COUNT"
echo "    - updates: $PUBLISHED_UPDATE_COUNT"
echo "  - published via primary ($PRIMARY_CLIENT): $PUBLISHED_PRIMARY_COUNT"
echo "  - published via fallback (${SECONDARY_CLIENT:-none}): $PUBLISHED_FALLBACK_COUNT"
echo "  - fallback attempts: $FALLBACK_ATTEMPT_COUNT"
echo "  - skipped: $SKIPPED_COUNT"
echo "  - failed: $FAILED_COUNT"

if [[ ${#FAILED_ITEMS[@]} -gt 0 ]]; then
  echo "  - failed packages:"
  for item in "${FAILED_ITEMS[@]}"; do
    echo "    * $item"
  done
fi

if [[ $PUBLISH_FAIL -eq 1 || $HAS_FAIL -eq 1 ]]; then
  if [[ ${#FAILED_CHECK_ITEMS[@]} -gt 0 ]]; then
    echo "  - failed pre-publish checks:"
    for item in "${FAILED_CHECK_ITEMS[@]}"; do
      echo "    * $item"
    done
  fi
  echo "Final result: $(fail) completed with errors"
  exit 1
fi

echo "Final result: $(ok) done"
