#!/usr/bin/env bash

# Compare the package npm would actually publish with an existing npm release.
# Packages without pack lifecycle hooks keep the cheaper source-file fast path.

package_has_pack_lifecycle() {
  local pkg_json="$1"
  node -e '
const fs = require("fs");
const pkg = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const scripts = pkg.scripts || {};
process.exit(["prepare", "prepack", "postpack"].some(name => typeof scripts[name] === "string" && scripts[name].trim()) ? 0 : 1);
' "$pkg_json" >/dev/null 2>&1
}

package_has_publishable_changes() {
  local pkg_dir="$1"
  local pkg_name="$2"
  local npm_version="$3"

  if ! command -v npm >/dev/null 2>&1; then
    echo "unknown"
    return 0
  fi

  local tmpdir
  tmpdir="$(mktemp -d)"

  local remote_tarball
  if ! remote_tarball="$(cd "$tmpdir" && npm pack "${pkg_name}@${npm_version}" --silent 2>/dev/null | tail -n 1)"; then
    rm -rf "$tmpdir"
    echo "unknown"
    return 0
  fi

  local remote_root="$tmpdir/remote/package"
  mkdir -p "$tmpdir/remote"
  if ! tar -xzf "$tmpdir/$(basename "$remote_tarball")" -C "$tmpdir/remote" >/dev/null 2>&1; then
    rm -rf "$tmpdir"
    echo "unknown"
    return 0
  fi

  local local_root="$pkg_dir"
  local local_files=()

  if package_has_pack_lifecycle "$pkg_dir/package.json"; then
    local local_tarball
    mkdir -p "$tmpdir/local-tarballs" "$tmpdir/local"
    if ! local_tarball="$(cd "$pkg_dir" && npm pack --silent --pack-destination "$tmpdir/local-tarballs" 2>/dev/null | tail -n 1)"; then
      rm -rf "$tmpdir"
      echo "unknown"
      return 0
    fi
    if ! tar -xzf "$tmpdir/local-tarballs/$(basename "$local_tarball")" -C "$tmpdir/local" >/dev/null 2>&1; then
      rm -rf "$tmpdir"
      echo "unknown"
      return 0
    fi
    local_root="$tmpdir/local/package"
    mapfile -t local_files < <(cd "$local_root" && find . -type f -printf '%P\n' | sort)
  else
    mapfile -t local_files < <(
      cd "$pkg_dir" && npm pack --dry-run --json --ignore-scripts 2>/dev/null | node -e '
const chunks = [];
process.stdin.on("data", c => chunks.push(c));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const report = Array.isArray(data)
      ? data[0]
      : Array.isArray(data?.files)
        ? data
        : Object.values(data ?? {}).find(value => Array.isArray(value?.files));
    const files = report?.files ?? [];
    for (const f of files) {
      if (f?.path) console.log(String(f.path));
    }
  } catch {
    process.exit(1);
  }
});
'
    )
  fi

  if [[ ${#local_files[@]} -eq 0 ]]; then
    rm -rf "$tmpdir"
    echo "unknown"
    return 0
  fi

  # One Node process compares all paths and bytes, avoiding a cmp process per file
  # (particularly expensive under Git Bash on Windows). NUL separates file names.
  printf '%s\0' "${local_files[@]}" > "$tmpdir/local-files"
  local comparison
  comparison="$(node - "$local_root" "$remote_root" "$tmpdir/local-files" <<'NODE'
const fs = require("fs");
const path = require("path");
const [localRoot, remoteRoot, filesPath] = process.argv.slice(2);
try {
  const localFiles = fs.readFileSync(filesPath, "utf8").split("\0").filter(Boolean).sort();
  const remoteFiles = [];
  function list(dir, prefix = "") {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) list(path.join(dir, entry.name), relative + "/");
      else if (entry.isFile()) remoteFiles.push(relative);
    }
  }
  list(remoteRoot);
  remoteFiles.sort();
  let changed = JSON.stringify(localFiles) !== JSON.stringify(remoteFiles);
  for (const file of localFiles) {
    if (changed) break;
    const local = fs.readFileSync(path.join(localRoot, file));
    const remote = fs.readFileSync(path.join(remoteRoot, file));
    if (file === "package.json") {
      const a = JSON.parse(local.toString("utf8"));
      const b = JSON.parse(remote.toString("utf8"));
      delete a.version;
      delete b.version;
      changed = JSON.stringify(a) !== JSON.stringify(b);
    } else {
      changed = !local.equals(remote);
    }
  }
  console.log(changed ? "yes" : "no");
} catch {
  // Read/parse failures cannot establish whether an artifact is safe to release.
  console.log("unknown");
}
NODE
)" || comparison="unknown"

  rm -rf "$tmpdir"
  echo "$comparison"
}
