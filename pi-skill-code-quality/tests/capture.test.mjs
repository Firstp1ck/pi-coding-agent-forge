import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { collectGitInputs, getFrozenEntries, materializeAnalyzerWorkspace, snapshotReportProjection } from "../skills/code-quality/scripts/lib/capture.mjs";
import { createGitRepository, removeDirectory, writeFixture } from "./helpers/fixture.mjs";

test("analyzer workspaces use frozen safe copies and detect analyzer mutation", async () => {
  const root = await createGitRepository({ "src/sample.js": "export const value = 1;\n" });
  let inputs;
  let workspace;
  try {
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    const entries = getFrozenEntries(inputs.current);
    assert.equal(entries.size, 1);
    workspace = await materializeAnalyzerWorkspace(inputs.current);
    assert.equal(workspace.files.length, 1);
    assert.equal(workspace.files[0].filePath.includes(root), false);
    assert.deepEqual(await workspace.verify(), { valid: true, modified: 0 });
    await fs.appendFile(workspace.files[0].filePath, "changed\n");
    assert.deepEqual(await workspace.verify(), { valid: false, modified: 1 });
    const report = snapshotReportProjection(inputs.current);
    assert.equal(JSON.stringify(report).includes("export const"), false);
  } finally {
    await workspace?.dispose();
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("per-file truncation makes capture coverage partial rather than clean", async () => {
  const root = await createGitRepository({ "src/large.js": "export const value = 'long';\n" });
  let inputs;
  try {
    await writeFixture(root, "src/large.js", "export const value = 'this intentionally exceeds the tiny fixture budget';\n");
    inputs = await collectGitInputs({
      cwd: root,
      base: "HEAD",
      scopeRoots: ["src"],
      limits: { maxFileBytes: 8 },
    });
    assert.equal(inputs.coverage.complete, false);
    assert.equal(inputs.current.coverage.counts.truncated > 0, true);
    assert.equal(inputs.lineChanges?.length ?? 0, 0);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("same-size mutation with restored mtime is retried rather than accepted", async () => {
  const original = "export const value = 1;\n";
  const replacement = "export const value = 2;\n";
  const root = await createGitRepository({ "src/value.js": original });
  const target = path.join(root, "src", "value.js");
  const originalOpen = fs.open;
  const originalStat = await fs.stat(target);
  let mutated = false;
  let inputs;
  try {
    fs.open = async function patchedOpen(filename, ...argumentsAfterFilename) {
      const handle = await originalOpen.call(this, filename, ...argumentsAfterFilename);
      if (!mutated && path.resolve(String(filename)) === target) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArguments) => {
          const result = await originalRead(...readArguments);
          if (!mutated) {
            mutated = true;
            await fs.writeFile(target, replacement);
            await fs.utimes(target, originalStat.atime, originalStat.mtime);
          }
          return result;
        };
      }
      return handle;
    };
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(mutated, true);
    assert.equal(inputs.provenance.captureAttempts, 2);
    assert.equal(inputs.coverage.status, "complete");
    assert.equal(getFrozenEntries(inputs.current).values().next().value.bytes.toString("utf8"), replacement);
  } finally {
    fs.open = originalOpen;
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("repeated input instability produces inconsistent evidence after one retry", async () => {
  const root = await createGitRepository({ "src/value.js": "export const value = 1;\n" });
  const target = path.join(root, "src", "value.js");
  const originalOpen = fs.open;
  const originalStat = await fs.stat(target);
  let targetOpens = 0;
  let inputs;
  try {
    fs.open = async function patchedOpen(filename, ...argumentsAfterFilename) {
      const handle = await originalOpen.call(this, filename, ...argumentsAfterFilename);
      if (path.resolve(String(filename)) === target) {
        const mutateThisOpen = targetOpens % 2 === 0;
        targetOpens += 1;
        if (mutateThisOpen) {
          const originalRead = handle.read.bind(handle);
          handle.read = async (...readArguments) => {
            const result = await originalRead(...readArguments);
            if (mutateThisOpen) {
              handle.read = originalRead;
              await fs.writeFile(target, `export const value = ${targetOpens};\n`);
              await fs.utimes(target, originalStat.atime, originalStat.mtime);
            }
            return result;
          };
        }
      }
      return handle;
    };
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(targetOpens >= 4, true);
    assert.equal(inputs.provenance.captureAttempts, 2);
    assert.equal(inputs.coverage.status, "inconsistent");
    assert.equal(inputs.lineChanges, null);
  } finally {
    fs.open = originalOpen;
    await inputs?.dispose();
    await removeDirectory(root);
  }
});
