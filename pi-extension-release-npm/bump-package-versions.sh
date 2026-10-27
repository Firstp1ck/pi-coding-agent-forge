#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=package-publishable-changes.sh
source "$SCRIPT_DIR/package-publishable-changes.sh"
ROOT_DIR="${PI_NPM_PACKAGES_ROOT:-$SCRIPT_DIR}"
TARGET="all"
TARGETS_FILE=""
CANDIDATE_TARGETS_FILE=""
APPLY=0

usage() {
  cat <<'EOF'
Usage:
  ./bump-package-versions.sh [options]
  ./bump-package-versions.sh [package-dir-name]

Options:
  --target <name|all>            Process one package dir or all (default: all)
  --targets-file <path>          Process package dirs listed one per line
  --candidate-targets-file <path> Write publish candidate dir names discovered during planning
  --all                          Same as --target all
  --apply                        Write bumped versions to package.json (default: plan only)
  -h, --help                     Show help

Rules:
  - Check currently published npm version first.
  - For already-published packages with publishable changes, enforce local version == next release after npm latest.
  - Next release increments patch by +1 until patch 9, then rolls to next minor .0.
  - If local is too high, reduce it back to the enforced next release.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --all)
      TARGET="all"
      shift
      ;;
    --targets-file)
      TARGETS_FILE="${2:-}"
      shift 2
      ;;
    --candidate-targets-file)
      CANDIDATE_TARGETS_FILE="${2:-}"
      shift 2
      ;;
    --apply)
      APPLY=1
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

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node is required but not found in PATH." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required but not found in PATH." >&2
  exit 1
fi

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

npm_latest_version() {
  local pkg_name="$1"
  local out
  if ! out="$(npm view "$pkg_name" version --json 2>/dev/null)"; then
    echo ""
    return 0
  fi

  node -e '
const raw = process.argv[1];
try {
  const v = JSON.parse(raw);
  if (Array.isArray(v)) {
    process.stdout.write(String(v[v.length - 1] ?? ""));
  } else {
    process.stdout.write(String(v ?? ""));
  }
} catch {
  process.stdout.write("");
}
' "$out"
}

semver_cmp() {
  local a="$1"
  local b="$2"
  node -e '
const [a,b] = process.argv.slice(1);
const parse = (v) => {
  const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
const pa = parse(a);
const pb = parse(b);
if (!pa || !pb) process.exit(2);
for (let i=0; i<3; i++) {
  if (pa[i] > pb[i]) { console.log(1); process.exit(0); }
  if (pa[i] < pb[i]) { console.log(-1); process.exit(0); }
}
console.log(0);
' "$a" "$b"
}

next_release_version() {
  local version="$1"
  node -e '
const v = process.argv[1];
const m = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
if (!m) process.exit(2);
let major = Number(m[1]);
let minor = Number(m[2]);
let patch = Number(m[3]);
if (patch >= 9) {
  minor += 1;
  patch = 0;
} else {
  patch += 1;
}
console.log(`${major}.${minor}.${patch}`);
' "$version"
}

set_package_version() {
  local pkg_json="$1"
  local next_version="$2"
  node -e '
const fs = require("fs");
const file = process.argv[1];
const nextVersion = process.argv[2];
const data = JSON.parse(fs.readFileSync(file, "utf8"));
data.version = nextVersion;
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
' "$pkg_json" "$next_version"
}


mapfile -t PACKAGE_DIRS < <(gather_packages)
if [[ ${#PACKAGE_DIRS[@]} -eq 0 ]]; then
  echo "No packages found under $ROOT_DIR" >&2
  exit 1
fi

declare -A RECORDED_PUBLISH_CANDIDATES=()
PUBLISH_CANDIDATES=0

if [[ -n "$CANDIDATE_TARGETS_FILE" ]]; then
  mkdir -p "$(dirname "$CANDIDATE_TARGETS_FILE")"
  : > "$CANDIDATE_TARGETS_FILE"
fi

record_publish_candidate() {
  local pkg_dir="$1"
  local target
  target="$(basename "$pkg_dir")"
  if [[ -z "${RECORDED_PUBLISH_CANDIDATES[$target]+x}" ]]; then
    RECORDED_PUBLISH_CANDIDATES[$target]=1
    PUBLISH_CANDIDATES=$((PUBLISH_CANDIDATES+1))
    if [[ -n "$CANDIDATE_TARGETS_FILE" ]]; then
      printf "%s\n" "$target" >> "$CANDIDATE_TARGETS_FILE"
    fi
  fi
}

echo "Mode: $([[ $APPLY -eq 1 ]] && echo "apply" || echo "plan")"
echo

UPDATED_UP=0
UPDATED_DOWN=0
UNCHANGED=0
FIRST_RELEASE=0
ERRORS=0

for pkg_dir in "${PACKAGE_DIRS[@]}"; do
  pkg_json="$pkg_dir/package.json"

  if ! node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$pkg_json" >/dev/null 2>&1; then
    echo "==> $(basename "$pkg_dir"): ERROR invalid package.json"
    ERRORS=$((ERRORS+1))
    echo
    continue
  fi

  name="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.name||"")' "$pkg_json" 2>/dev/null || true)"
  local_version="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.version||"")' "$pkg_json" 2>/dev/null || true)"

  echo "==> $(basename "$pkg_dir")"
  echo "  - package: ${name:-<missing>}"
  echo "  - local version: ${local_version:-<missing>}"

  if [[ -z "$name" || -z "$local_version" ]]; then
    echo "  - action: ERROR missing name/version"
    ERRORS=$((ERRORS+1))
    echo
    continue
  fi

  npm_version="$(npm_latest_version "$name")"
  if [[ -z "$npm_version" ]]; then
    echo "  - npm version: <not published>"
    echo "  - action: no bump (first release)"
    record_publish_candidate "$pkg_dir"
    FIRST_RELEASE=$((FIRST_RELEASE+1))
    UNCHANGED=$((UNCHANGED+1))
    echo
    continue
  fi

  echo "  - npm version: $npm_version"

  target_version="$(next_release_version "$npm_version")"
  target_cmp="$(semver_cmp "$local_version" "$target_version" 2>/dev/null || true)"
  if [[ -z "$target_cmp" ]]; then
    echo "  - action: ERROR non-semver comparison for target version"
    ERRORS=$((ERRORS+1))
    echo
    continue
  fi

  changed_against_published="$(package_has_publishable_changes "$pkg_dir" "$name" "$npm_version")"
  if [[ "$changed_against_published" == "unknown" ]]; then
    echo "  - action: ERROR could not compare package with npm tarball"
    ERRORS=$((ERRORS+1))
    echo
    continue
  fi

  echo "  - publishable changes vs npm: $changed_against_published"

  if [[ "$changed_against_published" == "no" ]]; then
    echo "  - action: unchanged (no publishable changes)"
    UNCHANGED=$((UNCHANGED+1))
    echo
    continue
  fi

  record_publish_candidate "$pkg_dir"
  echo "  - enforced target when changed: $target_version (patch +1, rolls patch 9 to next minor .0)"

  if [[ "$target_cmp" == "0" ]]; then
    echo "  - action: unchanged (already at enforced target)"
    UNCHANGED=$((UNCHANGED+1))
    echo
    continue
  fi

  if [[ "$target_cmp" == "-1" ]]; then
    if [[ $APPLY -eq 1 ]]; then
      set_package_version "$pkg_json" "$target_version"
      echo "  - action: bumped up -> $target_version"
      UPDATED_UP=$((UPDATED_UP+1))
    else
      echo "  - action: would bump up -> $target_version"
      UPDATED_UP=$((UPDATED_UP+1))
    fi
    echo
    continue
  fi

  if [[ "$target_cmp" == "1" ]]; then
    if [[ $APPLY -eq 1 ]]; then
      set_package_version "$pkg_json" "$target_version"
      echo "  - action: reduced down -> $target_version (local was too high)"
      UPDATED_DOWN=$((UPDATED_DOWN+1))
    else
      echo "  - action: would reduce down -> $target_version (local is too high)"
      UPDATED_DOWN=$((UPDATED_DOWN+1))
    fi
    echo
    continue
  fi

done

echo "Summary:"
echo "  - $([[ $APPLY -eq 1 ]] && echo "bumped up" || echo "would bump up"): $UPDATED_UP"
echo "  - $([[ $APPLY -eq 1 ]] && echo "reduced down" || echo "would reduce down"): $UPDATED_DOWN"
echo "  - unchanged: $UNCHANGED"
echo "  - first release (no npm version): $FIRST_RELEASE"
echo "  - publish candidates: $PUBLISH_CANDIDATES"
if [[ -n "$CANDIDATE_TARGETS_FILE" ]]; then
  echo "  - publish candidates file: $CANDIDATE_TARGETS_FILE"
fi
echo "  - errors: $ERRORS"

if [[ $ERRORS -gt 0 ]]; then
  exit 1
fi
