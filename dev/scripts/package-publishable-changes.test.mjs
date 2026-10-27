import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(scriptDirectory, "package-publishable-changes.sh");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
  assert.equal(result.status, 0, [result.error?.message, result.stderr, result.stdout].filter(Boolean).join("\n"));
  return result.stdout.trim();
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function packFixture(realNpm, packageDirectory, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const filename = run("bash", ["-c", 'exec "$REAL_NPM" "$@"', "pack-fixture", "pack", "--silent", "--pack-destination", destination], {
    cwd: packageDirectory,
    env: { ...process.env, REAL_NPM: realNpm },
  }).split(/\r?\n/u).at(-1);
  assert.ok(filename);
  return path.join(destination, filename);
}

function comparePackage(packageDirectory, packageName, version, env) {
  return run("bash", ["-c", 'source "$1"; package_has_publishable_changes "$2" "$3" "$4"', "compare-package", helperPath, packageDirectory, packageName, version], { env });
}

test("pack lifecycle packages compare generated publish artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publishable-lifecycle-test-"));
  try {
    const realNpm = run("bash", ["-lc", "command -v npm"]);
    const packageDirectory = path.join(root, "lifecycle-package");
    const remoteDirectory = path.join(root, "remote");
    const binDirectory = path.join(root, "bin");
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.mkdirSync(binDirectory, { recursive: true });

    writeJson(path.join(packageDirectory, "package.json"), {
      name: "@test/lifecycle-package",
      version: "1.0.0",
      type: "module",
      files: ["index.js", "resources"],
      scripts: {
        prepack: "node stage.mjs",
        postpack: "node stage.mjs --clean",
      },
    });
    fs.writeFileSync(path.join(packageDirectory, "index.js"), "export const value = true;\n", "utf8");
    fs.writeFileSync(path.join(packageDirectory, "canonical.txt"), "published resource\n", "utf8");
    fs.writeFileSync(path.join(packageDirectory, "stage.mjs"), `
import fs from "node:fs";
import path from "node:path";
const resources = path.resolve("resources");
if (process.argv.includes("--clean")) {
  fs.rmSync(resources, { recursive: true, force: true });
} else {
  fs.mkdirSync(resources, { recursive: true });
  fs.copyFileSync("canonical.txt", path.join(resources, "generated.txt"));
}
`, "utf8");

    const remoteTarball = packFixture(realNpm, packageDirectory, remoteDirectory);
    assert.equal(fs.existsSync(path.join(packageDirectory, "resources")), false);

    const npmWrapper = path.join(binDirectory, "npm");
    fs.writeFileSync(npmWrapper, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "pack" && "\${2:-}" == "@test/lifecycle-package@1.0.0" ]]; then
  cp "$REMOTE_TARBALL" .
  basename "$REMOTE_TARBALL"
  exit 0
fi
exec "$REAL_NPM" "$@"
`, "utf8");
    fs.chmodSync(npmWrapper, 0o755);

    const env = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH || ""}`,
      REAL_NPM: realNpm,
      REMOTE_TARBALL: remoteTarball,
      npm_config_cache: path.join(root, "npm-cache"),
    };

    assert.equal(comparePackage(packageDirectory, "@test/lifecycle-package", "1.0.0", env), "no");
    assert.equal(fs.existsSync(path.join(packageDirectory, "resources")), false);

    fs.writeFileSync(path.join(packageDirectory, "canonical.txt"), "changed resource\n", "utf8");
    assert.equal(comparePackage(packageDirectory, "@test/lifecycle-package", "1.0.0", env), "yes");
    assert.equal(fs.existsSync(path.join(packageDirectory, "resources")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("packages without pack hooks retain the source-file fast path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "publishable-fast-path-test-"));
  try {
    const realNpm = run("bash", ["-lc", "command -v npm"]);
    const packageDirectory = path.join(root, "plain-package");
    const remoteDirectory = path.join(root, "remote");
    const binDirectory = path.join(root, "bin");
    fs.mkdirSync(packageDirectory, { recursive: true });
    fs.mkdirSync(binDirectory, { recursive: true });

    writeJson(path.join(packageDirectory, "package.json"), {
      name: "@test/plain-package",
      version: "1.0.0",
      type: "module",
      files: ["index.js", "binary data.bin"],
    });
    fs.writeFileSync(path.join(packageDirectory, "index.js"), "export const value = true;\n", "utf8");
    fs.writeFileSync(path.join(packageDirectory, "binary data.bin"), Buffer.from([0, 255, 10]));
    const remoteTarball = packFixture(realNpm, packageDirectory, remoteDirectory);

    const npmLog = path.join(root, "npm.log");
    const npmWrapper = path.join(binDirectory, "npm");
    fs.writeFileSync(npmWrapper, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$NPM_LOG"
if [[ "\${FAKE_UNREADABLE_LIST:-}" == 1 && " $* " == *" --dry-run "* ]]; then
  printf '%s\\n' '{"files":[{"path":"index.js"},{"path":"package.json"},{"path":"binary data.bin"}]}'
  exit 0
fi
if [[ "\${1:-}" == "pack" && "\${2:-}" == "@test/plain-package@1.0.0" ]]; then
  cp "$REMOTE_TARBALL" .
  basename "$REMOTE_TARBALL"
  exit 0
fi
exec "$REAL_NPM" "$@"
`, "utf8");
    fs.chmodSync(npmWrapper, 0o755);

    const env = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH || ""}`,
      REAL_NPM: realNpm,
      REMOTE_TARBALL: remoteTarball,
      NPM_LOG: npmLog,
      npm_config_cache: path.join(root, "npm-cache"),
    };

    writeJson(path.join(packageDirectory, "package.json"), {
      name: "@test/plain-package",
      version: "1.0.1",
      type: "module",
      files: ["index.js", "binary data.bin"],
    });
    assert.equal(comparePackage(packageDirectory, "@test/plain-package", "1.0.0", env), "no");
    assert.match(fs.readFileSync(npmLog, "utf8"), /--dry-run --json --ignore-scripts/u);
    assert.doesNotMatch(fs.readFileSync(npmLog, "utf8"), /--pack-destination/u);

    fs.writeFileSync(path.join(packageDirectory, "binary data.bin"), Buffer.from([0, 254, 10]));
    assert.equal(comparePackage(packageDirectory, "@test/plain-package", "1.0.0", env), "yes");
    fs.writeFileSync(path.join(packageDirectory, "binary data.bin"), Buffer.from([0, 255, 10]));

    fs.writeFileSync(path.join(packageDirectory, "index.js"), "export const value = false;\n", "utf8");
    assert.equal(comparePackage(packageDirectory, "@test/plain-package", "1.0.0", env), "yes");

    fs.writeFileSync(path.join(packageDirectory, "index.js"), "export const value = true;\n", "utf8");
    const manifestPath = path.join(packageDirectory, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    writeJson(manifestPath, { ...manifest, description: "Changed metadata" });
    assert.equal(comparePackage(packageDirectory, "@test/plain-package", "1.0.0", env), "yes");
    writeJson(manifestPath, { ...manifest, files: ["index.js", "extra file.bin"] });
    fs.writeFileSync(path.join(packageDirectory, "extra file.bin"), Buffer.from([0, 255, 10]));
    assert.equal(comparePackage(packageDirectory, "@test/plain-package", "1.0.0", env), "yes");
    writeJson(manifestPath, manifest);
    fs.unlinkSync(path.join(packageDirectory, "index.js"));
    assert.equal(comparePackage(packageDirectory, "@test/plain-package", "1.0.0", env), "yes");
    assert.equal(comparePackage(packageDirectory, "@test/plain-package", "1.0.0", { ...env, FAKE_UNREADABLE_LIST: "1" }), "unknown");
    fs.writeFileSync(path.join(packageDirectory, "index.js"), "export const value = true;\n");
    fs.writeFileSync(manifestPath, "{invalid json");
    assert.equal(comparePackage(packageDirectory, "@test/plain-package", "1.0.0", { ...env, FAKE_UNREADABLE_LIST: "1" }), "unknown");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
