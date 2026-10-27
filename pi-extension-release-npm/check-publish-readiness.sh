#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=package-publishable-changes.sh
source "$SCRIPT_DIR/package-publishable-changes.sh"
ROOT_DIR="${PI_NPM_PACKAGES_ROOT:-$SCRIPT_DIR}"
TARGET="all"
PUBLISHER="npm"         # auto|bun|npm
CHECK_AUTH=1
STRICT_AUTH=0
CHECK_REGISTRY=1
CHECK_HARDCODE=1
CHECK_ALT_CLIENT=0       # run extra dry-run check with the non-primary client when available

usage() {
  cat <<'EOF'
Usage:
  check-publish-readiness.sh [package-dir-name]
  check-publish-readiness.sh [options]

Options:
  --publisher <auto|bun|npm>   Select publishing client (default: npm; bun is fallback when available)
  --target <name|all>          Check one package folder or all (default: all)
  --all                        Force checking all package folders
  --check-alt-client           Also run dry-run with the other client if installed

  --skip-auth                  Skip auth check
  --strict-auth                Treat missing auth as failure (default: warn only)
  --skip-registry              Skip npm registry name/version checks
  --skip-hardcode              Skip hardcoded-value heuristic scan

  -h, --help                   Show this help

Examples:
  ./check-publish-readiness.sh
  ./check-publish-readiness.sh pi-extension-notes
  ./check-publish-readiness.sh --publisher bun --check-alt-client
  ./check-publish-readiness.sh --target pi-extension-brave-search --strict-auth
  ./check-publish-readiness.sh --all
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
    --all)
      TARGET="all"
      shift
      ;;
    --check-alt-client)
      CHECK_ALT_CLIENT=1
      shift
      ;;
    --skip-auth)
      CHECK_AUTH=0
      shift
      ;;
    --strict-auth)
      STRICT_AUTH=1
      shift
      ;;
    --skip-registry)
      CHECK_REGISTRY=0
      shift
      ;;
    --skip-hardcode)
      CHECK_HARDCODE=0
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

if [[ "$PUBLISHER" != "auto" && "$PUBLISHER" != "bun" && "$PUBLISHER" != "npm" ]]; then
  echo "ERROR: --publisher must be auto, bun, or npm" >&2
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
  echo "ERROR: --publisher bun selected, but bun is not installed." >&2
  exit 1
fi
if [[ "$PRIMARY_CLIENT" == "npm" && $HAS_NPM -ne 1 ]]; then
  echo "ERROR: --publisher npm selected, but npm is not installed." >&2
  exit 1
fi

SECONDARY_CLIENT=""
if [[ "$PRIMARY_CLIENT" == "bun" && $HAS_NPM -eq 1 ]]; then
  SECONDARY_CLIENT="npm"
elif [[ "$PRIMARY_CLIENT" == "npm" && $HAS_BUN -eq 1 ]]; then
  SECONDARY_CLIENT="bun"
fi

color() {
  local code="$1"; shift
  printf "\033[%sm%s\033[0m" "$code" "$*"
}
ok() { color "32" "PASS"; }
warn() { color "33" "WARN"; }
fail() { color "31" "FAIL"; }

print_check() {
  local status="$1"; shift
  local msg="$*"
  printf "  - [%s] %s\n" "$status" "$msg"
}

json_get() {
  local file="$1"
  local expr="$2"
  node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const v=(function(){return ${expr}})();if(v===undefined||v===null){process.exit(2)};if(typeof v==='object')console.log(JSON.stringify(v));else console.log(String(v));" "$file" 2>/dev/null
}

gather_packages() {
  if [[ "$TARGET" != "all" ]]; then
    if [[ -d "$ROOT_DIR/$TARGET" && -f "$ROOT_DIR/$TARGET/package.json" ]]; then
      printf "%s\n" "$ROOT_DIR/$TARGET"
      return
    fi
    echo "ERROR: package '$TARGET' not found under $ROOT_DIR" >&2
    exit 1
  fi

  find "$ROOT_DIR" -mindepth 1 -maxdepth 1 -type d \
    ! -name ".*" \
    -exec test -f "{}/package.json" ';' -print | sort
}

check_auth() {
  local client="$1"
  if [[ "$client" == "npm" ]]; then
    if npm whoami >/dev/null 2>&1; then
      echo "npm auth: $(ok) logged in as $(npm whoami 2>/dev/null)"
      return 0
    fi
    echo "npm auth: $(warn) not logged in (run: npm login)"
    return 1
  fi

  if [[ "$client" == "bun" ]]; then
    # bun pm whoami may require being inside a package directory.
    if [[ -f "$ROOT_DIR/package.json" ]] && bun pm whoami >/dev/null 2>&1; then
      echo "bun auth: $(ok) logged in as $(bun pm whoami 2>/dev/null)"
      return 0
    fi

    # npm auth is compatible with bun publishing against npm registry.
    if command -v npm >/dev/null 2>&1 && npm whoami >/dev/null 2>&1; then
      echo "bun auth: $(ok) npm credentials detected via npm whoami ($(npm whoami 2>/dev/null))"
      return 0
    fi

    if [[ -n "${NPM_CONFIG_TOKEN:-}" ]]; then
      echo "bun auth: $(ok) NPM_CONFIG_TOKEN is set"
      return 0
    fi

    echo "bun auth: $(warn) not logged in (run: npm whoami / set token in ~/.npmrc or NPM_CONFIG_TOKEN)"
    return 1
  fi

  return 1
}

registry_check_with_npm() {
  local name="$1"
  local version="$2"

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
}

registry_check_with_bun() {
  local name="$1"
  local version="$2"

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
}

run_publish_dry_run() {
  local client="$1"
  local dir="$2"

  if [[ "$client" == "npm" ]]; then
    (cd "$dir" && npm publish --dry-run >/dev/null 2>&1)
    return $?
  fi

  if [[ "$client" == "bun" ]]; then
    (cd "$dir" && bun publish --dry-run >/dev/null 2>&1)
    return $?
  fi

  return 1
}

find_user_specific_values() {
  local pkg_dir="$1"
  local patterns=()

  [[ -n "${HOME:-}" ]] && patterns+=("$HOME")
  [[ -n "${USER:-}" ]] && patterns+=("/home/$USER")

  local tz="${TZ:-}"
  if [[ -z "$tz" ]] && command -v timedatectl >/dev/null 2>&1; then
    tz="$(timedatectl show -p Timezone --value 2>/dev/null || true)"
  fi
  [[ -n "$tz" ]] && patterns+=("$tz")

  local tmpfile
  tmpfile="$(mktemp)"
  trap 'rm -f "$tmpfile"' RETURN

  local pattern
  for pattern in "${patterns[@]}"; do
    [[ -z "$pattern" ]] && continue
    grep -RIlF --exclude-dir='.git' --exclude-dir='node_modules' --exclude-dir='dist' --exclude-dir='build' --exclude='package-lock.json' -- "$pattern" "$pkg_dir" >>"$tmpfile" 2>/dev/null || true
  done

  sort -u "$tmpfile" | sed "s#^$pkg_dir/##"
}


has_fail=0
pkg_count=0
failed_packages=()
failed_details=()

echo "Primary publisher client: $PRIMARY_CLIENT"
if [[ -n "$SECONDARY_CLIENT" ]]; then
  echo "Secondary client available: $SECONDARY_CLIENT"
fi

PRIMARY_AUTH_OK=0
if [[ $CHECK_AUTH -eq 1 ]]; then
  if check_auth "$PRIMARY_CLIENT"; then
    PRIMARY_AUTH_OK=1
  fi
  if [[ $STRICT_AUTH -eq 1 && $PRIMARY_AUTH_OK -ne 1 ]]; then
    echo "Auth policy: $(fail) strict auth enabled and primary client is not authenticated"
    has_fail=1
  fi
else
  echo "Auth check: $(warn) skipped (--skip-auth)"
fi

echo

for pkg_dir in $(gather_packages); do
  pkg_count=$((pkg_count+1))
  echo "$(color "36" "==>") $(basename "$pkg_dir")"

  pkg_json="$pkg_dir/package.json"
  pkg_fail=0
  pkg_reasons=()

  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$pkg_json" >/dev/null 2>&1; then
    print_check "$(ok)" "package.json is valid JSON"
  else
    print_check "$(fail)" "package.json is invalid JSON"
    pkg_fail=1
    pkg_reasons+=("invalid package.json")
  fi

  name="$(json_get "$pkg_json" 'p.name' || true)"
  version="$(json_get "$pkg_json" 'p.version' || true)"
  license="$(json_get "$pkg_json" 'p.license' || true)"

  [[ -n "$name" ]] && print_check "$(ok)" "name: $name" || { print_check "$(fail)" "missing package name"; pkg_fail=1; pkg_reasons+=("missing package name"); }
  [[ -n "$version" ]] && print_check "$(ok)" "version: $version" || { print_check "$(fail)" "missing version"; pkg_fail=1; pkg_reasons+=("missing version"); }
  [[ -n "$license" ]] && print_check "$(ok)" "license: $license" || { print_check "$(fail)" "missing license"; pkg_fail=1; pkg_reasons+=("missing license"); }

  if json_get "$pkg_json" 'Array.isArray(p.keywords) ? p.keywords.includes("pi-package") : false' | grep -q '^true$'; then
    print_check "$(ok)" "keywords include 'pi-package'"
  else
    print_check "$(warn)" "keywords missing 'pi-package' (recommended for discoverability)"
  fi

  if [[ -f "$pkg_dir/README.md" ]]; then
    print_check "$(ok)" "README.md exists"
  else
    print_check "$(fail)" "README.md missing"
    pkg_fail=1
    pkg_reasons+=("README.md missing")
  fi

  if [[ -f "$pkg_dir/LICENSE" ]]; then
    print_check "$(ok)" "LICENSE exists"
  else
    print_check "$(warn)" "LICENSE missing"
  fi

  extensions_json="$(json_get "$pkg_json" 'p.pi && Array.isArray(p.pi.extensions) ? p.pi.extensions : null' || true)"
  if [[ -z "$extensions_json" ]]; then
    print_check "$(fail)" "pi.extensions missing or empty"
    pkg_fail=1
    pkg_reasons+=("pi.extensions missing or empty")
  else
    print_check "$(ok)" "pi.extensions configured: $extensions_json"

    while IFS= read -r ext_path; do
      [[ -z "$ext_path" ]] && continue
      ext_clean="${ext_path#./}"

      if [[ "$ext_clean" == *"*"* || "$ext_clean" == *"?"* || "$ext_clean" == *"["* ]]; then
        shopt -s nullglob
        matches=("$pkg_dir"/$ext_clean)
        shopt -u nullglob
        if [[ ${#matches[@]} -gt 0 ]]; then
          print_check "$(ok)" "extension glob matches ${#matches[@]} file(s): $ext_path"
        else
          print_check "$(fail)" "extension glob has no matches: $ext_path"
          pkg_fail=1
          pkg_reasons+=("extension glob has no matches: $ext_path")
        fi
      else
        if [[ -f "$pkg_dir/$ext_clean" ]]; then
          print_check "$(ok)" "extension entry exists: $ext_path"
        else
          print_check "$(fail)" "extension entry missing: $ext_path"
          pkg_fail=1
          pkg_reasons+=("extension entry missing: $ext_path")
        fi
      fi
    done < <(node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));for(const e of (p.pi?.extensions||[])) console.log(e);" "$pkg_json")
  fi

  if [[ $CHECK_HARDCODE -eq 1 ]]; then
    hardcode_hits="$(find_user_specific_values "$pkg_dir" || true)"
    if [[ -n "$hardcode_hits" ]]; then
      print_check "$(warn)" "package contains potentially user-specific hardcoded values"
      while IFS= read -r hit; do
        [[ -n "$hit" ]] && print_check "$(warn)" "  check file: $hit"
      done <<<"$hardcode_hits"
    else
      print_check "$(ok)" "no obvious user-specific hardcoded paths/timezone"
    fi
  fi

  dry_run_ok=0
  if run_publish_dry_run "$PRIMARY_CLIENT" "$pkg_dir"; then
    dry_run_ok=1
    print_check "$(ok)" "$PRIMARY_CLIENT publish --dry-run succeeds"
  fi

  if [[ $CHECK_ALT_CLIENT -eq 1 ]]; then
    if [[ -n "$SECONDARY_CLIENT" ]]; then
      if run_publish_dry_run "$SECONDARY_CLIENT" "$pkg_dir"; then
        print_check "$(ok)" "$SECONDARY_CLIENT publish --dry-run succeeds"
      else
        print_check "$(warn)" "$SECONDARY_CLIENT publish --dry-run failed"
      fi
    else
      print_check "$(warn)" "alternate client not available"
    fi
  fi

  pkg_exists=0
  latest=""
  version_exists=0

  if [[ $CHECK_REGISTRY -eq 1 && -n "$name" && -n "$version" ]]; then
    if [[ "$PRIMARY_CLIENT" == "npm" || $HAS_NPM -eq 1 ]]; then
      while IFS='|' read -r status payload; do
        case "$status" in
          exists)
            pkg_exists=1
            latest="$payload"
            print_check "$(warn)" "package name already exists on npm (latest: ${payload:-unknown})"
            ;;
          missing)
            pkg_exists=0
            print_check "$(ok)" "package name appears available on npm"
            ;;
          version_exists)
            version_exists=1
            print_check "$(warn)" "version $payload is already published"
            pkg_reasons+=("version already published on npm: $payload")
            ;;
          version_free)
            version_exists=0
            print_check "$(ok)" "version $payload is publishable"
            ;;
        esac
      done < <(registry_check_with_npm "$name" "$version")
    elif [[ "$PRIMARY_CLIENT" == "bun" || $HAS_BUN -eq 1 ]]; then
      while IFS='|' read -r status payload; do
        case "$status" in
          exists)
            pkg_exists=1
            latest="$payload"
            print_check "$(warn)" "package name already exists on npm (latest: ${payload:-unknown})"
            ;;
          missing)
            pkg_exists=0
            print_check "$(ok)" "package name appears available on npm"
            ;;
          version_exists)
            version_exists=1
            print_check "$(warn)" "version $payload is already published"
            pkg_reasons+=("version already published on npm: $payload")
            ;;
          version_free)
            version_exists=0
            print_check "$(ok)" "version $payload is publishable"
            ;;
        esac
      done < <(registry_check_with_bun "$name" "$version")
    else
      print_check "$(warn)" "registry check skipped (no npm/bun registry client available)"
    fi

    if [[ $pkg_exists -eq 1 && -n "$latest" ]]; then
      changed_against_published="$(package_has_publishable_changes "$pkg_dir" "$name" "$latest")"
      case "$changed_against_published" in
        yes)
          print_check "$(ok)" "local publishable package differs from npm latest $latest"
          ;;
        no)
          if [[ $version_exists -eq 1 ]]; then
            print_check "$(ok)" "local publishable package matches npm latest $latest"
          else
            print_check "$(fail)" "local publishable package matches npm latest $latest (no changes to publish)"
            pkg_fail=1
            pkg_reasons+=("no publishable changes vs npm latest: $latest")
          fi
          ;;
        *)
          print_check "$(fail)" "could not compare local package with npm latest $latest"
          pkg_fail=1
          pkg_reasons+=("could not compare local package with npm latest: $latest")
          ;;
      esac
    fi
  elif [[ $CHECK_REGISTRY -eq 0 ]]; then
    print_check "$(warn)" "registry checks skipped (--skip-registry)"
  fi

  if [[ $dry_run_ok -eq 0 ]]; then
    if [[ $version_exists -eq 1 ]]; then
      print_check "$(warn)" "$PRIMARY_CLIENT publish --dry-run failed because version is already published"
    elif [[ $STRICT_AUTH -eq 0 && $CHECK_AUTH -eq 1 && $PRIMARY_AUTH_OK -eq 0 ]]; then
      print_check "$(warn)" "$PRIMARY_CLIENT publish --dry-run failed (likely auth-related; non-strict auth mode)"
    else
      print_check "$(fail)" "$PRIMARY_CLIENT publish --dry-run failed"
      pkg_fail=1
      pkg_reasons+=("$PRIMARY_CLIENT publish --dry-run failed")
    fi
  fi

  if [[ $pkg_fail -eq 1 ]]; then
    has_fail=1
    pkg_name="$(basename "$pkg_dir")"
    failed_packages+=("$pkg_name")
    if [[ ${#pkg_reasons[@]} -gt 0 ]]; then
      failed_details+=("$pkg_name|$(printf '%s; ' "${pkg_reasons[@]}" | sed 's/; $//')")
    else
      failed_details+=("$pkg_name|unknown reason")
    fi
    echo "  Result: $(fail)"
  else
    echo "  Result: $(ok)"
  fi

  echo
done

if [[ $pkg_count -eq 0 ]]; then
  echo "No packages found under $ROOT_DIR" >&2
  exit 1
fi

if [[ $has_fail -eq 1 ]]; then
  echo "Summary: $(fail) readiness check failed for one or more packages."
  echo "Failed packages:"
  for pkg in "${failed_packages[@]}"; do
    echo "  - $pkg"
  done
  echo
  echo "Failure reasons:"

  only_version_collisions=1
  for item in "${failed_details[@]}"; do
    IFS='|' read -r _pkg reason <<< "$item"
    if [[ "$reason" != "version already published on npm:"* ]]; then
      only_version_collisions=0
      break
    fi
  done

  if [[ $only_version_collisions -eq 1 ]]; then
    echo "  Version already published (per package):"
    for item in "${failed_details[@]}"; do
      IFS='|' read -r pkg reason <<< "$item"
      published_version="${reason##*: }"
      echo "    - $pkg@$published_version"
    done
  else
    for item in "${failed_details[@]}"; do
      IFS='|' read -r pkg reason <<< "$item"
      echo "  - $pkg"
      IFS=';' read -ra reason_parts <<< "$reason"
      for part in "${reason_parts[@]}"; do
        trimmed="$(echo "$part" | sed 's/^ *//; s/ *$//')"
        [[ -n "$trimmed" ]] && echo "      • $trimmed"
      done
    done
  fi

  echo
  echo "Hint: if failures are only version collisions, bump versions first:"
  echo "  ./bump-package-versions.sh --all"
  echo "  ./bump-package-versions.sh --all --apply"
  exit 1
fi

echo "Summary: $(ok) all checked packages are publish-ready."
