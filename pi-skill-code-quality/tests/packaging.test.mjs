import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { removeDirectory, temporaryDirectory } from "./helpers/fixture.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publishAllowlist = ["skills", "README.md", "TECHNICAL.md", "DEVELOPMENT.md", "LICENSE"];

function runNpmPack({ dryRun = true, cwd = packageRoot } = {}) {
  return new Promise((resolve, reject) => {
    const npmCli = process.env.npm_execpath;
    assert.ok(npmCli, "npm test must provide npm_execpath for the package pack check");
    const args = [npmCli, "pack", "--json", "--ignore-scripts"];
    if (dryRun) args.push("--dry-run");
    const child = spawn(process.execPath, args, {
      cwd,
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

function packedPackage(value, manifest) {
  const identity = `${manifest.name}@${manifest.version}`;
  let entry;
  if (Array.isArray(value)) {
    assert.equal(value.length, 1, "older npm pack JSON must describe exactly one package");
    [entry] = value;
  } else {
    assert.equal(value !== null && typeof value === "object", true, "current npm pack JSON must be a package-name-keyed object");
    assert.deepEqual(Object.keys(value), [manifest.name], "current npm pack JSON must contain only this package identity");
    entry = value[manifest.name];
  }
  assert.equal(entry !== null && typeof entry === "object", true, "pack metadata must be an object");
  assert.equal(entry.id, identity, "packed package ID must match this package");
  assert.equal(entry.name, manifest.name, "packed package name must match this package");
  assert.equal(entry.version, manifest.version, "packed package version must match this package");
  assert.equal(Array.isArray(entry.files), true, "pack metadata must list packed files");
  return entry;
}

function tarString(header, offset, length) {
  const end = header.indexOf(0, offset);
  return header.toString("utf8", offset, end === -1 || end > offset + length ? offset + length : end);
}

function tarSize(header) {
  const value = tarString(header, 124, 12).trim();
  if (!/^[0-7]*$/u.test(value)) throw new TypeError("invalid package tar size");
  return value ? Number.parseInt(value, 8) : 0;
}

function archiveTarget(destination, archivePath) {
  assert.equal(archivePath.startsWith("package/"), true, `unexpected package archive path: ${archivePath}`);
  const target = path.resolve(destination, archivePath);
  const relative = path.relative(destination, target);
  assert.equal(relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), false, `unsafe package archive path: ${archivePath}`);
  return target;
}

async function extractPackageArchive(archive, destination) {
  const contents = gunzipSync(await fs.readFile(archive));
  for (let offset = 0; offset + 512 <= contents.length;) {
    const header = contents.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const archivePath = prefix ? `${prefix}/${name}` : name;
    const size = tarSize(header);
    const type = String.fromCharCode(header[156] || 0);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert.equal(dataEnd <= contents.length, true, `truncated package archive entry: ${archivePath}`);
    const target = archiveTarget(destination, archivePath);
    if (type === "0" || type === "\0") {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents.subarray(dataStart, dataEnd));
    } else if (type === "5") {
      await fs.mkdir(target, { recursive: true });
    } else {
      throw new TypeError(`unsupported package archive entry type: ${type}`);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
}

function runNode(script, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
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

async function packageManifest() {
  return JSON.parse(await fs.readFile(path.join(packageRoot, "package.json"), "utf8"));
}

test("package manifest preserves the exact publish allowlist and a full package test command", async () => {
  const manifest = await packageManifest();
  assert.deepEqual(manifest.files, publishAllowlist);
  assert.equal(typeof manifest.scripts?.test, "string");
  for (const filename of ["contract.test.mjs", "packaging.test.mjs", "evaluation.test.mjs", "core.test.mjs", "adapters.test.mjs"]) {
    assert.match(manifest.scripts.test, new RegExp(filename.replace(".", "\\."), "u"));
  }
  assert.equal(manifest.version, "0.1.5");
  assert.equal("dependencies" in manifest, false);
  assert.equal("devDependencies" in manifest, false);
});

test("package pack JSON accepts only one exact package in older and current npm shapes", async () => {
  const manifest = await packageManifest();
  const metadata = {
    id: `${manifest.name}@${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    files: [],
  };
  assert.equal(packedPackage([metadata], manifest), metadata);
  assert.equal(packedPackage({ [manifest.name]: metadata }, manifest), metadata);
  assert.throws(() => packedPackage({ "@firstpick/other": metadata }, manifest));
  assert.throws(() => packedPackage([{ ...metadata, name: "@firstpick/other" }], manifest));
});

test("dry-run pack includes user documents and skill resources but excludes contributor material", async () => {
  const result = await runNpmPack();
  assert.equal(result.code, 0, result.stderr);
  const packed = packedPackage(JSON.parse(result.stdout), await packageManifest());
  const paths = packed.files.map((entry) => entry.path).sort();
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

test("packed and extracted skill keeps script and references usable without installation", async () => {
  const root = await temporaryDirectory("code-quality-pack-");
  const packageCopy = path.join(root, "package-under-test");
  const extractionRoot = path.join(root, "extracted");
  try {
    await fs.cp(packageRoot, packageCopy, { recursive: true });
    const result = await runNpmPack({ dryRun: false, cwd: packageCopy });
    assert.equal(result.code, 0, result.stderr);
    const packed = packedPackage(JSON.parse(result.stdout), await packageManifest());
    const archive = path.join(packageCopy, path.basename(packed.filename));
    assert.equal(await fs.access(archive).then(() => true, () => false), true, "npm pack writes only the temporary archive");
    await extractPackageArchive(archive, extractionRoot);

    const extractedRoot = path.join(extractionRoot, "package");
    const scanScript = path.join(extractedRoot, "skills", "code-quality", "scripts", "scan.mjs");
    for (const reference of ["language-checks.md", "measurement-guide.md"]) {
      const text = await fs.readFile(path.join(extractedRoot, "skills", "code-quality", "references", reference), "utf8");
      assert.match(text, /\S/u, `extracted reference is readable: ${reference}`);
    }
    assert.equal(await fs.access(path.join(extractedRoot, "tests")).then(() => true, () => false), false);
    assert.equal(await fs.access(path.join(extractedRoot, "node_modules")).then(() => true, () => false), false);
    const smoke = await runNode(scanScript, ["snapshot", "--scope", "skills", "--format", "json"], extractedRoot);
    assert.equal(smoke.code, 0, smoke.stderr);
    assert.equal(JSON.parse(smoke.stdout).operation, "snapshot");
  } finally {
    await removeDirectory(root);
  }
});
