import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishAllowlist = ["skills", "README.md", "TECHNICAL.md", "DEVELOPMENT.md", "LICENSE"];

function runNpmPack() {
  return new Promise((resolve, reject) => {
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, "npm test must provide npm_execpath for the package pack check");
    const child = spawn(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: packageRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("package manifest preserves the exact publish allowlist and a full package test command", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.deepEqual(manifest.files, publishAllowlist);
  assert.equal(typeof manifest.scripts?.test, "string");
  for (const filename of ["contract.test.mjs", "packaging.test.mjs", "evaluation.test.mjs", "core.test.mjs", "adapters.test.mjs"]) {
    assert.match(manifest.scripts.test, new RegExp(filename.replace(".", "\\."), "u"));
  }
  assert.equal(manifest.version, "0.1.5");
  assert.equal("dependencies" in manifest, false);
  assert.equal("devDependencies" in manifest, false);
});

test("dry-run pack includes user documents and skill resources but excludes contributor material", async () => {
  const result = await runNpmPack();
  assert.equal(result.code, 0, result.stderr);
  const packed = JSON.parse(result.stdout);
  assert.equal(Array.isArray(packed), true);
  assert.equal(packed.length, 1);
  const paths = packed[0].files.map((entry) => entry.path).sort();
  for (const required of [
    "package.json",
    "README.md",
    "TECHNICAL.md",
    "DEVELOPMENT.md",
    "LICENSE",
    "skills/code-quality/SKILL.md",
    "skills/code-quality/references/language-checks.md",
    "skills/code-quality/references/measurement-guide.md",
    "skills/code-quality/scripts/scan.mjs",
  ]) assert.equal(paths.includes(required), true, `packed file missing: ${required}`);
  assert.equal(paths.some((filename) => filename.startsWith("tests/")), false);
  assert.equal(paths.some((filename) => filename.startsWith("plans/")), false);
  assert.equal(paths.some((filename) => filename.includes("node_modules")), false);
});
