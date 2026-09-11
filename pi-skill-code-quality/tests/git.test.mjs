import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { collectGitInputs } from "../skills/code-quality/scripts/lib/capture.mjs";
import { GitClient, parseLsFilesStage, parseLsTree } from "../skills/code-quality/scripts/lib/git.mjs";
import { ScanDeadline, SubprocessTracker } from "../skills/code-quality/scripts/lib/runner.mjs";
import { createGitRepository, removeDirectory, run, temporaryDirectory, writeFixture } from "./helpers/fixture.mjs";

test("raw NUL metadata parsers retain path bytes and index stages", () => {
  const objectId = "a".repeat(40);
  const tree = parseLsTree(Buffer.concat([Buffer.from(`100644 blob ${objectId}\t`), Buffer.from("src/naïve name.js"), Buffer.from([0])]));
  assert.equal(tree[0].rawPath.toString("utf8"), "src/naïve name.js");
  const stages = parseLsFilesStage(Buffer.from(`H 100644 ${objectId} 1\tsrc/a.js\0`, "utf8"));
  assert.equal(stages[0].tag, "H");
  assert.equal(stages[0].stage, 1);
});

test("batched blob framing failures propagate instead of becoming empty content", async () => {
  const root = await createGitRepository({ "src/a.js": "export const value = 1;\n" });
  const scannerRoot = await temporaryDirectory();
  let batch;
  try {
    const emptyConfigPath = path.join(scannerRoot, "empty-git-config");
    await fs.writeFile(emptyConfigPath, "");
    const client = await GitClient.create({
      cwd: root,
      checkoutRoot: root,
      emptyConfigPath,
      deadline: new ScanDeadline({ deadlineMs: 2_000, cleanupReserveMs: 100 }),
      tracker: new SubprocessTracker({ maxGitProcesses: 23, maxSubprocesses: 40 }),
    });
    batch = client.openBlobBatch();
    await assert.rejects(batch.request("f".repeat(40), { maxBytes: 1024 }), /malformed-or-missing-blob/u);
  } finally {
    await batch?.close();
    await removeDirectory(root);
    await removeDirectory(scannerRoot);
  }
});

test("frozen isolated diff preserves CRLF accounting and ignores hostile local diff/filter configuration", async () => {
  const root = await createGitRepository({
    "src/naïve name.js": "one\r\ntwo\r\n",
    ".gitattributes": "src/naïve name.js filter=evil\n",
  });
  let inputs;
  try {
    await run("git", ["config", "diff.external", "not-a-real-diff-command"], { cwd: root });
    await run("git", ["config", "filter.evil.clean", "not-a-real-clean-command"], { cwd: root });
    await writeFixture(root, "src/naïve name.js", "one\r\ntwo\r\nthree\r\n");
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(inputs.coverage.complete, true);
    assert.deepEqual(inputs.lineChanges, [{
      kind: "modified",
      beforePath: "src/naïve name.js",
      currentPath: "src/naïve name.js",
      beforeCategory: "production",
      currentCategory: "production",
      added: 1,
      deleted: 0,
      binary: false,
    }]);
    assert.equal(inputs.provenance.processCounts.gitProcesses <= 23, true);
    assert.equal(inputs.provenance.processCounts.totalProcesses <= 40, true);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("exact-content rename detection accepts only one-to-one digest groups", async () => {
  const root = await createGitRepository({
    "src/unique.js": "export const unique = 1;\n",
    "src/a.js": "export const duplicate = 1;\n",
    "src/b.js": "export const duplicate = 1;\n",
  });
  let unique;
  let duplicate;
  try {
    await fs.rm(`${root}/src/unique.js`);
    await writeFixture(root, "src/renamed.js", "export const unique = 1;\n");
    unique = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"], includeUntracked: true });
    assert.deepEqual(unique.renameRecords, [{
      policy: "sha256-one-to-one-v1",
      beforePath: "src/unique.js",
      currentPath: "src/renamed.js",
      beforeCategory: "production",
      currentCategory: "production",
    }]);
    assert.equal(unique.lineChanges.some((change) => change.kind === "rename" && change.added === 0 && change.deleted === 0), true);
    await unique.dispose();
    unique = null;

    await fs.rm(`${root}/src/a.js`);
    await fs.rm(`${root}/src/b.js`);
    await writeFixture(root, "src/c.js", "export const duplicate = 1;\n");
    await writeFixture(root, "src/d.js", "export const duplicate = 1;\n");
    duplicate = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"], includeUntracked: true });
    assert.equal(duplicate.renameRecords.length, 1, "only the separately unique rename is accepted");
    const duplicateChanges = duplicate.lineChanges.filter((change) => ["src/a.js", "src/b.js", "src/c.js", "src/d.js"].includes(change.beforePath ?? change.currentPath));
    assert.equal(duplicateChanges.filter((change) => change.kind === "added").length, 2);
    assert.equal(duplicateChanges.filter((change) => change.kind === "deleted").length, 2);
  } finally {
    await unique?.dispose();
    await duplicate?.dispose();
    await removeDirectory(root);
  }
});

test("the single live ignore policy applies identically to baseline and current", async () => {
  const root = await createGitRepository({
    ".gitignore": "",
    "src/ignored.js": "export const ignored = 1;\n",
    "src/kept.js": "export const kept = 1;\n",
  });
  let inputs;
  try {
    await writeFixture(root, ".gitignore", "src/ignored.js\n");
    await writeFixture(root, "src/kept.js", "export const kept = 2;\n");
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(inputs.before.files.some((file) => file.path === "src/ignored.js"), false);
    assert.equal(inputs.current.files.some((file) => file.path === "src/ignored.js"), false);
    assert.equal(inputs.before.ignoreIdentity, inputs.current.ignoreIdentity);
    assert.equal(inputs.collectionCompatibility.ignorePolicyIdentity, inputs.current.ignoreIdentity);
    assert.deepEqual(inputs.lineChanges.map((change) => change.currentPath ?? change.beforePath), ["src/kept.js"]);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("mid-capture ignore mutation triggers the one allowed recollection", async () => {
  const files = { ".gitignore": "" };
  for (let index = 0; index < 500; index += 1) files[`src/f${String(index).padStart(4, "0")}.js`] = `export const f${index} = ${index};\n`;
  const root = await createGitRepository(files);
  const ignorePath = path.join(root, ".gitignore");
  const originalOpen = fs.open;
  let scheduled = false;
  let inputs;
  try {
    fs.open = async function patchedOpen(filename, ...argumentsAfterFilename) {
      const handle = await originalOpen.call(this, filename, ...argumentsAfterFilename);
      if (!scheduled && path.resolve(String(filename)) === ignorePath) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArguments) => {
          const result = await originalRead(...readArguments);
          if (!scheduled) {
            scheduled = true;
            setTimeout(() => { void fs.writeFile(ignorePath, "src/f0000.js\n").catch(() => undefined); }, 20);
          }
          return result;
        };
      }
      return handle;
    };
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(scheduled, true);
    assert.equal(inputs.provenance.captureAttempts, 2);
    assert.equal(inputs.provenance.processCounts.gitProcesses <= 23, true);
    assert.equal(inputs.coverage.status, "complete");
    assert.equal(inputs.current.files.some((file) => file.path === "src/f0000.js"), false);
  } finally {
    fs.open = originalOpen;
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("Git collection from a subdirectory still reads repository-relative paths", async () => {
  const root = await createGitRepository({ "src/a.js": "export const value = 1;\n" });
  let inputs;
  try {
    await writeFixture(root, "src/a.js", "export const value = 2;\n");
    inputs = await collectGitInputs({ cwd: path.join(root, "src"), base: "HEAD", scopeRoots: ["src"] });
    assert.deepEqual(inputs.current.files.map((file) => file.path), ["src/a.js"]);
    assert.equal(inputs.lineChanges[0].kind, "modified");
    assert.equal(inputs.coverage.complete, true);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("frozen Git ignore evaluation honors directory, bracket, escape, and parent-negation semantics", async () => {
  const root = await createGitRepository({
    ".gitignore": "src/nested/secret/\nsrc/secret[0-9].js\nsrc/\\!literal.js\nsrc/blocked/\n!src/blocked/allowed.js\n",
    "src/nested/secret/hidden.js": "export const hidden = 1;\n",
    "src/secret1.js": "export const secret = 1;\n",
    "src/!literal.js": "export const literal = 1;\n",
    "src/blocked/allowed.js": "export const blocked = 1;\n",
    "src/keep.js": "export const keep = 1;\n",
  });
  let inputs;
  try {
    await run("git", ["add", "--force", "src/nested/secret/hidden.js", "src/secret1.js", "src/!literal.js", "src/blocked/allowed.js"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "force ignored fixture files"], { cwd: root });
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.deepEqual(inputs.current.files.map((file) => file.path), ["src/keep.js"]);
    assert.deepEqual(inputs.before.files.map((file) => file.path), ["src/keep.js"]);
    assert.equal(inputs.current.coverage.counts.exclusions.ignored, 4);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("junctioned worktree ancestors are rejected before external bytes are captured", { skip: process.platform !== "win32" }, async () => {
  const root = await createGitRepository({ "src/a.js": "export const inside = 1;\n" });
  const outside = await createGitRepository({ "a.js": "export const outside = 1;\n" });
  let inputs;
  try {
    await fs.rm(path.join(root, "src"), { recursive: true, force: true });
    await fs.symlink(outside, path.join(root, "src"), "junction");
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(inputs.coverage.complete, false);
    assert.equal(inputs.current.coverage.reasons.includes("unsafe-path"), true);
    assert.equal(inputs.current.files.length, 0);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
    await removeDirectory(outside);
  }
});

test("Git process count is fixed as the frozen file set grows", async () => {
  const smallRoot = await createGitRepository({ "src/a.js": "export const a = 1;\n" });
  const manyFiles = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`src/f${index}.js`, `export const f${index} = ${index};\n`]));
  const largeRoot = await createGitRepository(manyFiles);
  let small;
  let large;
  try {
    await writeFixture(smallRoot, "src/a.js", "export const a = 2;\n");
    await writeFixture(largeRoot, "src/f0.js", "export const f0 = 100;\n");
    small = await collectGitInputs({ cwd: smallRoot, base: "HEAD", scopeRoots: ["src"] });
    large = await collectGitInputs({ cwd: largeRoot, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(small.provenance.processCounts.gitProcesses, large.provenance.processCounts.gitProcesses);
    assert.equal(small.provenance.processCounts.gitProcesses <= 23, true);
  } finally {
    await small?.dispose();
    await large?.dispose();
    await removeDirectory(smallRoot);
    await removeDirectory(largeRoot);
  }
});

test("unmerged index stages and skip-worktree inputs are explicit partial evidence", async () => {
  const root = await createGitRepository({ "src/a.js": "export const value = 1;\n" });
  let unmerged;
  let skipped;
  try {
    const initialBranch = (await run("git", ["branch", "--show-current"], { cwd: root })).toString("utf8").trim();
    await run("git", ["checkout", "--quiet", "-b", "other"], { cwd: root });
    await writeFixture(root, "src/a.js", "export const value = 2;\n");
    await run("git", ["add", "src/a.js"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "other"], { cwd: root });
    await run("git", ["checkout", "--quiet", initialBranch], { cwd: root });
    await writeFixture(root, "src/a.js", "export const value = 3;\n");
    await run("git", ["add", "src/a.js"], { cwd: root });
    await run("git", ["commit", "--quiet", "-m", "main"], { cwd: root });
    await run("git", ["merge", "--no-edit", "other"], { cwd: root, allowedExitCodes: [1] });
    unmerged = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(unmerged.coverage.complete, false);
    assert.equal(unmerged.current.coverage.reasons.includes("unmerged-index"), true);
    assert.equal(unmerged.lineChanges, null);
    await unmerged.dispose();
    unmerged = null;

    await run("git", ["merge", "--abort"], { cwd: root });
    await run("git", ["update-index", "--skip-worktree", "src/a.js"], { cwd: root });
    skipped = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(skipped.coverage.complete, false);
    assert.equal(skipped.current.coverage.reasons.includes("skip-worktree-unsupported"), true);
    assert.equal(skipped.lineChanges, null);
  } finally {
    await unmerged?.dispose();
    await skipped?.dispose();
    await removeDirectory(root);
  }
});

/* legacy test name retained below for a direct skip-worktree fixture */
test("skip-worktree inputs are explicit partial evidence rather than substituted index blobs", async () => {
  const root = await createGitRepository({ "src/a.js": "export const value = 1;\n" });
  let inputs;
  try {
    await run("git", ["update-index", "--skip-worktree", "src/a.js"], { cwd: root });
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.equal(inputs.coverage.complete, false);
    assert.equal(inputs.current.coverage.reasons.includes("skip-worktree-unsupported"), true);
    assert.equal(inputs.lineChanges, null);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});
