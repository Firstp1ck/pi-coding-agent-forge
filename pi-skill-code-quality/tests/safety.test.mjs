import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { collectGitInputs } from "../skills/code-quality/scripts/lib/capture.mjs";
import { createSanitizedGitEnvironment, GitBlobBatch, GitClient } from "../skills/code-quality/scripts/lib/git.mjs";
import { CommandFailure, DEFAULT_LIMITS, DeadlineExceededError, ScanDeadline, SubprocessTracker } from "../skills/code-quality/scripts/lib/runner.mjs";
import { createGitRepository, removeDirectory, run, temporaryDirectory, withEnvironment, writeFixture } from "./helpers/fixture.mjs";

function batchLimits(overrides = {}) {
  return { ...DEFAULT_LIMITS, ...overrides };
}

function batchOptions(root, overrides = {}) {
  return {
    executable: process.execPath,
    cwd: root,
    environment: process.env,
    deadline: new ScanDeadline({ deadlineMs: 800, cleanupReserveMs: 150 }),
    tracker: new SubprocessTracker({ maxGitProcesses: 23, maxSubprocesses: 40 }),
    limits: batchLimits(overrides),
  };
}

test("missing Git falls back only for current snapshots and rejects an explicit baseline", async () => {
  const root = await temporaryDirectory();
  const missingGit = path.join(root, "missing-git.exe");
  let current;
  try {
    await writeFixture(root, "src/current.js", "export const current = true;\n");
    current = await collectGitInputs({ cwd: root, gitExecutable: missingGit, scopeRoots: ["src"] });
    assert.equal(current.current.kind, "filesystem-current");
    await assert.rejects(
      collectGitInputs({ cwd: root, gitExecutable: missingGit, base: "HEAD", scopeRoots: ["src"] }),
      (error) => error instanceof CommandFailure && error.reason === "trusted-executable-unavailable",
    );
  } finally {
    await current?.dispose();
    await removeDirectory(root);
  }
});

test("unborn repositories and invalid baselines fail without falling back to a Git comparison", async () => {
  const unborn = await temporaryDirectory();
  const repository = await createGitRepository({ "src/value.js": "export const value = 1;\n" });
  try {
    await run("git", ["init", "--quiet"], { cwd: unborn });
    await assert.rejects(
      collectGitInputs({ cwd: unborn, base: "HEAD", scopeRoots: ["src"] }),
      (error) => error instanceof CommandFailure && error.reason === "repository-unavailable",
    );
    await assert.rejects(
      collectGitInputs({ cwd: repository, base: "not-a-commit", scopeRoots: ["src"] }),
      (error) => error instanceof CommandFailure && error.reason === "repository-unavailable",
    );
  } finally {
    await removeDirectory(unborn);
    await removeDirectory(repository);
  }
});

test("a detached HEAD resolves the requested baseline once and captures safely", async () => {
  const root = await createGitRepository({ "src/value.js": "export const value = 1;\n" });
  let inputs;
  try {
    await run("git", ["checkout", "--quiet", "--detach"], { cwd: root });
    inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    assert.match(inputs.provenance.baselineCommit, /^[0-9a-f]{40,}$/u);
    assert.equal(inputs.coverage.complete, true);
    assert.deepEqual(inputs.current.files.map((file) => file.path), ["src/value.js"]);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("inherited Git injection variables are removed before all collection commands", { concurrency: false }, async () => {
  const root = await createGitRepository({ "src/value.js": "export const value = 1;\n" });
  const emptyConfig = path.join(root, "scanner-empty-config");
  const marker = path.join(root, "external-diff-ran");
  let inputs;
  try {
    await fs.writeFile(emptyConfig, "");
    await writeFixture(root, "external-diff.mjs", "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.CODE_QUALITY_DIFF_MARKER, 'ran');\n");
    const sanitized = createSanitizedGitEnvironment({
      emptyConfigPath: emptyConfig,
      baseEnvironment: {
        GIT_DIR: "injected-directory",
        GIT_INDEX_FILE: "injected-index",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.autocrlf",
        GIT_CONFIG_VALUE_0: "true",
        GIT_EXTERNAL_DIFF: "injected-diff",
        SAFE_VALUE: "retained",
      },
    });
    assert.equal(sanitized.GIT_DIR, undefined);
    assert.equal(sanitized.GIT_INDEX_FILE, undefined);
    assert.equal(sanitized.GIT_EXTERNAL_DIFF, undefined);
    assert.equal(sanitized.SAFE_VALUE, "retained");
    await withEnvironment({
      GIT_DIR: path.join(root, "not-a-repository"),
      GIT_INDEX_FILE: path.join(root, "not-an-index"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.autocrlf",
      GIT_CONFIG_VALUE_0: "true",
      GIT_EXTERNAL_DIFF: `${process.execPath} ${path.join(root, "external-diff.mjs")}`,
      CODE_QUALITY_DIFF_MARKER: marker,
    }, async () => {
      inputs = await collectGitInputs({ cwd: root, base: "HEAD", scopeRoots: ["src"] });
    });
    assert.equal(inputs.coverage.complete, true);
    assert.equal(await fs.access(marker).then(() => true, () => false), false);
  } finally {
    await inputs?.dispose();
    await removeDirectory(root);
  }
});

test("batch spawn failures are observed and do not leave an unreaped close", async () => {
  const root = await temporaryDirectory();
  let batch;
  try {
    batch = new GitBlobBatch({
      ...batchOptions(root),
      executable: path.join(root, "missing-git.exe"),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      batch.request("a".repeat(40), { maxBytes: 32 }),
      (error) => error instanceof CommandFailure && error.reason === "batch-spawn-error",
    );
    await batch.close();
  } finally {
    await batch?.close().catch(() => undefined);
    await removeDirectory(root);
  }
});

test("truncated cat-file responses are failures rather than empty blobs", async () => {
  const root = await temporaryDirectory();
  let batch;
  try {
    const objectId = "a".repeat(40);
    await writeFixture(root, "cat-file", `process.stdin.once('data', () => process.stdout.end('${objectId} blob 5\nab', () => process.exit(0)));\n`);
    batch = new GitBlobBatch(batchOptions(root));
    await assert.rejects(
      batch.request(objectId, { maxBytes: 32 }),
      (error) => error instanceof CommandFailure && error.reason === "unexpected-end-of-output",
    );
    await assert.rejects(
      batch.close(),
      (error) => error instanceof CommandFailure && error.reason === "invalid-batch-response",
    );
  } finally {
    await batch?.close().catch(() => undefined);
    await removeDirectory(root);
  }
});

test("configured Git process and output limits stop trusted synthetic Git", { skip: process.platform !== "win32" }, async () => {
  const root = await temporaryDirectory();
  const emptyConfig = path.join(root, "empty-config");
  let client;
  let batch;
  try {
    await fs.writeFile(emptyConfig, "");
    await writeFixture(root, "cat-file", "process.stdout.write('x'.repeat(128)); setInterval(() => {}, 1_000);\n");
    client = await GitClient.create({
      cwd: root,
      checkoutRoot: root,
      gitExecutable: process.execPath,
      emptyConfigPath: emptyConfig,
      deadline: new ScanDeadline({ deadlineMs: 800, cleanupReserveMs: 150 }),
      tracker: new SubprocessTracker({ maxGitProcesses: 23, maxSubprocesses: 40 }),
      limits: batchLimits({ maxAnalyzerOutputBytes: 16, processTimeoutMs: 600 }),
    });
    await assert.rejects(
      client.run(["cat-file", "--batch"]),
      (error) => error instanceof CommandFailure && error.reason === "stdout-limit",
    );

    await fs.writeFile(path.join(root, "cat-file"), "process.stdin.resume(); setInterval(() => {}, 1_000);\n");
    const started = performance.now();
    batch = new GitBlobBatch(batchOptions(root, { processTimeoutMs: 50 }));
    await assert.rejects(
      batch.request("a".repeat(40), { maxBytes: 32 }),
      (error) => error instanceof DeadlineExceededError,
    );
    await batch.close();
    assert.equal(performance.now() - started < 800, true);
  } finally {
    await batch?.close().catch(() => undefined);
    await removeDirectory(root);
  }
});

test("batch cancellation reaps a hanging trusted child without an unobserved request", { skip: process.platform !== "win32" }, async () => {
  const root = await temporaryDirectory();
  const controller = new AbortController();
  let batch;
  try {
    await writeFixture(root, "cat-file", "process.stdin.resume(); setInterval(() => {}, 1_000);\n");
    batch = new GitBlobBatch({ ...batchOptions(root, { processTimeoutMs: 500 }), signal: controller.signal });
    const request = batch.request("a".repeat(40), { maxBytes: 32 });
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(request, (error) => error instanceof CommandFailure || error instanceof DeadlineExceededError);
    await batch.close();
  } finally {
    await batch?.close().catch(() => undefined);
    await removeDirectory(root);
  }
});

test("capture rejects non-positive resource limits and fixed retry policy changes", async () => {
  const root = await temporaryDirectory();
  try {
    await writeFixture(root, "src/value.js", "export const value = 1;\n");
    await assert.rejects(collectGitInputs({ cwd: root, limits: { maxFileBytes: 0 } }), /Invalid limit: maxFileBytes/u);
    await assert.rejects(collectGitInputs({ cwd: root, limits: { captureRetries: 0 } }), /Invalid limit: captureRetries/u);
    await assert.rejects(collectGitInputs({ cwd: root, limits: { captureRetries: 2 } }), /fixed by the scanner contract/u);
  } finally {
    await removeDirectory(root);
  }
});
