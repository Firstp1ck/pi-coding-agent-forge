import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parseArguments, runCli, writeExplicitOutput } from "../skills/code-quality/scripts/scan.mjs";
import { collectGitInputs } from "../skills/code-quality/scripts/lib/capture.mjs";
import { ScanDeadline } from "../skills/code-quality/scripts/lib/runner.mjs";
import { createGitRepository, removeDirectory, temporaryDirectory, writeFixture } from "./helpers/fixture.mjs";

function stream() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, value: () => value };
}

test("CLI accepts only explicit scan/snapshot/compare contracts", () => {
  assert.deepEqual(parseArguments(["scan", "--base", "HEAD", "--scope", "src", "--scope=lib", "--include-untracked", "--format", "json"]), {
    operation: "scan", base: "HEAD", scopes: ["src", "lib"], includeUntracked: true, format: "json",
  });
  for (const invalid of [
    ["scan", "--scope", "src"],
    ["snapshot", "--base", "HEAD", "--scope", "src"],
    ["compare", "--before", "one.json"],
    ["scan", "--base", "HEAD", "--scope", "src", "--unknown"],
    ["snapshot", "--scope", "src", "--include-untracked=true"],
  ]) assert.throws(() => parseArguments(invalid), /invalid-cli-options/u);
});

test("snapshot writes only an explicit create-only report outside selected source roots", async () => {
  const root = await temporaryDirectory();
  const output = path.join(root, "reports", "snapshot.json");
  const stdout = stream();
  const stderr = stream();
  try {
    await writeFixture(root, "src/value.js", "export const value = 1;\n");
    const exit = await runCli(["snapshot", "--scope", "src", "--format", "json", "--out", output], { cwd: root, stdout, stderr });
    assert.equal(exit, 0);
    assert.equal(stderr.value(), "");
    const saved = JSON.parse(await fs.readFile(output, "utf8"));
    assert.equal(saved.snapshot.current.physicalLines.total, 1);
    assert.equal(saved.snapshot.current.complexity.status, "unavailable");
    assert.equal(saved.snapshot.current.astPatterns.status, "unavailable");
    assert.equal(await fs.access(path.join(root, "src", "value.js")).then(() => true), true);
    const compareOut = path.join(root, "reports", "comparison.json");
    assert.equal(await runCli(["compare", "--before", output, "--after", output, "--format", "json", "--out", compareOut], { cwd: root, stdout: stream(), stderr: stream() }), 0);
    const compared = JSON.parse(await fs.readFile(compareOut, "utf8"));
    assert.equal(compared.comparison.editChurn.status, "unavailable");
  } finally {
    await removeDirectory(root);
  }
});

test("output hazards fail closed and diagnostics do not disclose local paths", async () => {
  const root = await temporaryDirectory();
  try {
    await writeFixture(root, "src/value.js", "export const value = 1;\n");
    const unsafeError = stream();
    assert.equal(await runCli(["snapshot", "--scope", ".", "--out", path.join(root, "report.json")], { cwd: root, stdout: stream(), stderr: unsafeError }), 2);
    assert.match(unsafeError.value(), /invalid-input/u);
    assert.equal(unsafeError.value().includes(root), false);
    const existing = path.join(root, "existing.json");
    await fs.writeFile(existing, "keep");
    assert.equal(await runCli(["snapshot", "--scope", "src", "--out", existing], { cwd: root, stdout: stream(), stderr: stream() }), 2);
    assert.equal(await fs.readFile(existing, "utf8"), "keep");
  } finally {
    await removeDirectory(root);
  }
});

test("output guards normalize Windows scopes, use the repository root from nested Git cwd, and reject junction ancestry", async () => {
  const root = await createGitRepository({ "src/nested/value.js": "export const value = 1;\n" });
  const outside = await temporaryDirectory();
  try {
    await assert.rejects(
      writeExplicitOutput({ cwd: root, repositoryRoot: root, output: "src/nested/report.json", scopes: ["src\\nested\\"], json: "{}" }),
      /inside-selected-source-scope/u,
    );
    await assert.rejects(
      writeExplicitOutput({ cwd: root, repositoryRoot: root, output: "src/nested/report.json", scopes: ["./src/nested/"], json: "{}" }),
      /inside-selected-source-scope/u,
    );
    const nestedCwd = path.join(root, "src");
    const stderr = stream();
    assert.equal(await runCli(["snapshot", "--scope", "src/nested", "--out", "nested/report.json"], { cwd: nestedCwd, stdout: stream(), stderr }), 2);
    assert.match(stderr.value(), /invalid-input/u);
    if (process.platform === "win32") {
      await assert.rejects(
        writeExplicitOutput({ cwd: root, repositoryRoot: root, output: "src/nested./report.json", scopes: ["src/nested"], json: "{}" }),
        /ambiguous-output-path/u,
      );
      await assert.rejects(
        writeExplicitOutput({ cwd: root, repositoryRoot: root, output: "src/nested /report.json", scopes: ["src/nested"], json: "{}" }),
        /ambiguous-output-path/u,
      );
      await fs.mkdir(path.join(outside, "existing"));
      await fs.symlink(outside, path.join(root, "link"), "junction");
      await assert.rejects(
        writeExplicitOutput({ cwd: root, repositoryRoot: root, output: "link/existing/report.json", scopes: ["src"], json: "{}" }),
        /unsafe-output-parent/u,
      );
    }
  } finally {
    await removeDirectory(root);
    await removeDirectory(outside);
  }
});

test("one command budget cancels capture and compare without leaving persistent output", async () => {
  const root = await temporaryDirectory();
  try {
    for (let index = 0; index < 500; index += 1) await writeFixture(root, `src/f${index}.js`, `export const f${index} = ${index};\n`);
    const controller = new AbortController();
    const pending = runCli(["snapshot", "--scope", "src", "--out", "report.json"], { cwd: root, stdout: stream(), stderr: stream(), signal: controller.signal });
    setTimeout(() => controller.abort(), 1);
    assert.equal(await pending, 2);
    assert.equal(await fs.access(path.join(root, "report.json")).then(() => true, () => false), false);
    const expired = new ScanDeadline({ deadlineMs: 10, cleanupReserveMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(await runCli(["compare", "--before", "missing.json", "--after", "missing.json"], { cwd: root, stdout: stream(), stderr: stream(), deadline: expired }), 2);
  } finally {
    await removeDirectory(root);
  }
});

test("analyzer mutation returns a schema-valid inconsistent scan report for both sides", { concurrency: false, skip: process.platform !== "win32" }, async (t) => {
  const astExecutable = process.env.CODE_QUALITY_AST_GREP_EXE;
  if (!astExecutable || !path.isAbsolute(astExecutable) || !(await fs.access(astExecutable).then(() => true, () => false))) {
    t.skip("retained pinned ast-grep candidate is unavailable");
    return;
  }
  const root = await createGitRepository({ "src/value.js": "console.log('inspect');\n" });
  const originalWriteFile = fs.writeFile;
  let mutated = false;
  try {
    fs.writeFile = async function patchedWriteFile(filename, ...args) {
      const result = await originalWriteFile.call(this, filename, ...args);
      if (!mutated && path.basename(String(filename)).startsWith("input-")) {
        mutated = true;
        await fs.appendFile(filename, "\n// mutation during CLI fixture\n");
      }
      return result;
    };
    const stdout = stream();
    assert.equal(await runCli(["scan", "--base", "HEAD", "--scope", "src", "--ast-grep", astExecutable, "--format", "json"], { cwd: root, stdout, stderr: stream() }), 0);
    const report = JSON.parse(stdout.value());
    assert.equal(mutated, true);
    assert.equal(report.coverage.status, "inconsistent");
    assert.equal(report.snapshot.before.capture.coverageStatus, "inconsistent");
    assert.equal(report.snapshot.current.capture.coverageStatus, "inconsistent");
    assert.equal(report.comparison.status, "inconsistent");
  } finally {
    fs.writeFile = originalWriteFile;
    await removeDirectory(root);
  }
});

test("scoped untracked discovery prunes large out-of-scope and nested artifact populations before bounded output", async () => {
  const root = await createGitRepository({ "src/tracked.js": "export const tracked = true;\n" });
  let withoutUntracked;
  let withUntracked;
  let literal;
  try {
    for (let index = 0; index < 200; index += 1) await writeFixture(root, `outside/f${String(index).padStart(3, "0")}.js`, `export const outside${index} = '${"x".repeat(60)}';\n`);
    await writeFixture(root, "src/new.js", "export const current = true;\n");
    await writeFixture(root, "src/nested/node_modules/noise.js", "export const generated = true;\n");
    withoutUntracked = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"], limits: { maxAnalyzerOutputBytes: 1024 } });
    assert.equal(withoutUntracked.current.files.some((file) => file.path === "src/new.js"), false);
    assert.equal(withoutUntracked.provenance.untrackedDiscovery.unenumeratedOutOfScopeCount, "unknown");
    assert.equal(withoutUntracked.provenance.untrackedDiscovery.unenumeratedSafetyExcludedCount, "unknown");
    withUntracked = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"], includeUntracked: true, limits: { maxAnalyzerOutputBytes: 1024 } });
    assert.equal(withUntracked.current.files.some((file) => file.path === "src/new.js"), true);
    assert.equal(withUntracked.current.files.some((file) => file.path.includes("node_modules")), false);
    await writeFixture(root, "src/[literal]/kept.js", "export const literal = true;\n");
    await writeFixture(root, "src/x/kept.js", "export const wildcard = true;\n");
    literal = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src/[literal]"], includeUntracked: true, limits: { maxAnalyzerOutputBytes: 1024 } });
    assert.deepEqual(literal.current.files.map((file) => file.path), ["src/[literal]/kept.js"]);
  } finally {
    await withoutUntracked?.dispose();
    await withUntracked?.dispose();
    await literal?.dispose();
    await removeDirectory(root);
  }
});

test("scoped discovery retains only ancestor and nested ignore inputs needed for frozen eligibility", async () => {
  const root = await createGitRepository({
    ".gitignore": "",
    "src/nested/root-ignored.js": "export const rootIgnored = true;\n",
    "src/nested/local-ignored.js": "export const localIgnored = true;\n",
    "src/nested/kept.js": "export const kept = true;\n",
  });
  let inputs;
  try {
    await writeFixture(root, ".gitignore", "src/nested/root-ignored.js\n");
    await writeFixture(root, "src/.gitignore", "nested/local-ignored.js\n");
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src/nested"], limits: { maxAnalyzerOutputBytes: 1024 } });
    assert.deepEqual(inputs.before.files.map((file) => file.path), ["src/nested/kept.js"]);
    assert.deepEqual(inputs.current.files.map((file) => file.path), ["src/nested/kept.js"]);
    assert.equal(inputs.provenance.processCounts.gitProcesses <= 23, true);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("Git scan preserves frozen numstat evidence while snapshots leave edit churn unavailable", async () => {
  const root = await createGitRepository({ "src/value.js": "export const value = 1;\n" });
  const stdout = stream();
  try {
    await writeFixture(root, "src/value.js", "export const value = 1;\nexport const next = 2;\n");
    assert.equal(await runCli(["scan", "--base", "HEAD", "--scope", "src", "--format", "json"], { cwd: root, stdout, stderr: stream() }), 0);
    const report = JSON.parse(stdout.value());
    assert.equal(report.comparison.editChurn.status, "available");
    assert.deepEqual(report.comparison.editChurn.totals.production, { added: 1, deleted: 0, net: 1 });
  } finally {
    await removeDirectory(root);
  }
});
