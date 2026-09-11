import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { collectGitInputs } from "../skills/code-quality/scripts/lib/capture.mjs";
import { CommandFailure, ScanDeadline, SubprocessTracker, resolveTrustedExecutable, runBounded } from "../skills/code-quality/scripts/lib/runner.mjs";
import { removeDirectory, temporaryDirectory, writeFixture } from "./helpers/fixture.mjs";

async function waitForFileText(filename, timeoutMs) {
  const endsAt = Date.now() + timeoutMs;
  while (Date.now() < endsAt) {
    try {
      return await fs.readFile(filename, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for ${filename}`);
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs) {
  const endsAt = Date.now() + timeoutMs;
  while (Date.now() < endsAt) {
    if (!processExists(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`child process ${pid} survived cancellation`);
}

test("bounded runner terminates a timed-out direct child within its shared deadline", async () => {
  const deadline = new ScanDeadline({ deadlineMs: 800, cleanupReserveMs: 150 });
  const tracker = new SubprocessTracker({ maxGitProcesses: 18, maxSubprocesses: 40 });
  await assert.rejects(
    runBounded(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      deadline,
      tracker,
      timeoutMs: 100,
      maxStdoutBytes: 1024,
      requireTreeTermination: true,
    }),
    (error) => error instanceof CommandFailure && error.reason === "timeout",
  );
  assert.equal(tracker.report().totalProcesses >= 1 && tracker.report().totalProcesses <= 2, true);
});

test("trusted executable resolution rejects a path anywhere inside the checkout", async () => {
  const root = await temporaryDirectory();
  try {
    const executable = await writeFixture(root, "nested/tools/fake.exe", "not executable");
    await assert.rejects(
      resolveTrustedExecutable({ explicitPath: executable, checkoutRoot: root }),
      (error) => error instanceof CommandFailure && error.reason === "trusted-executable-unavailable",
    );
  } finally {
    await removeDirectory(root);
  }
});

test("bounded runner handles a spawn error without a child process-group PID", async () => {
  const root = await temporaryDirectory();
  try {
    await assert.rejects(
      runBounded(path.join(root, "missing-executable"), [], {
        deadline: new ScanDeadline({ deadlineMs: 800, cleanupReserveMs: 100 }),
        tracker: new SubprocessTracker({ maxGitProcesses: 23, maxSubprocesses: 40 }),
        timeoutMs: 200,
        requireTreeTermination: true,
      }),
      (error) => error instanceof CommandFailure && error.reason === "spawn-error",
    );
  } finally {
    await removeDirectory(root);
  }
});

test("tree-termination setup failures prevent analyzer spawn", { skip: process.platform !== "win32" }, async () => {
  const root = await temporaryDirectory();
  const originalSystemRoot = process.env.SystemRoot;
  const tracker = new SubprocessTracker({ maxGitProcesses: 23, maxSubprocesses: 40 });
  try {
    process.env.SystemRoot = root;
    await assert.rejects(
      runBounded(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
        deadline: new ScanDeadline({ deadlineMs: 800, cleanupReserveMs: 100 }),
        tracker,
        timeoutMs: 50,
        kind: "analyzer",
        platform: "win32",
      }),
      (error) => error instanceof CommandFailure && error.reason === "trusted-tree-termination-unavailable",
    );
    assert.equal(tracker.report().totalProcesses, 0);
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    await removeDirectory(root);
  }
});

test("bounded runner honors shared cancellation and reaps its direct child", async () => {
  const controller = new AbortController();
  const deadline = new ScanDeadline({ deadlineMs: 1_000, cleanupReserveMs: 150 });
  const tracker = new SubprocessTracker({ maxGitProcesses: 23, maxSubprocesses: 40 });
  const pending = runBounded(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    deadline,
    tracker,
    timeoutMs: 800,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, (error) => error instanceof CommandFailure && error.reason === "cancelled");
});

test("bounded runner cancellation reaps a live-leader Linux process tree", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryDirectory();
  const pidFile = path.join(root, "child.pid");
  const controller = new AbortController();
  const deadline = new ScanDeadline({ deadlineMs: 1_000, cleanupReserveMs: 150 });
  const tracker = new SubprocessTracker({ maxGitProcesses: 23, maxSubprocesses: 40 });
  const childSource = "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1_000);";
  const parentSource = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(childSource)}, process.argv[1]], { stdio: "ignore" }); setInterval(() => {}, 1_000);`;
  let childPid = null;
  let pending;
  try {
    pending = runBounded(process.execPath, ["-e", parentSource, pidFile], {
      deadline,
      tracker,
      timeoutMs: 800,
      signal: controller.signal,
      requireTreeTermination: true,
    });
    childPid = Number.parseInt(await waitForFileText(pidFile, 500), 10);
    assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true);
    controller.abort();
    await assert.rejects(pending, (error) => error instanceof CommandFailure && error.reason === "cancelled");
    await waitForProcessExit(childPid, 500);
  } finally {
    controller.abort();
    await pending?.catch(() => undefined);
    if (childPid && processExists(childPid)) process.kill(childPid, "SIGKILL");
    await removeDirectory(root);
  }
});

test("bounded runner timeout reaps an exited Linux leader's inherited-stdio descendant", { skip: process.platform !== "linux" }, async () => {
  const root = await temporaryDirectory();
  const pidFile = path.join(root, "child.pid");
  const deadline = new ScanDeadline({ deadlineMs: 600, cleanupReserveMs: 100 });
  const tracker = new SubprocessTracker({ maxGitProcesses: 23, maxSubprocesses: 40 });
  const descendantSource = "const fs = require('node:fs'); fs.writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1_000);";
  const leaderSource = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(descendantSource)}, process.argv[1]], { stdio: "inherit" }); process.exit(0);`;
  let descendantPid = null;
  let pending;
  const startedAt = Date.now();
  try {
    pending = runBounded(process.execPath, ["-e", leaderSource, pidFile], {
      deadline,
      tracker,
      timeoutMs: 200,
      requireTreeTermination: true,
    });
    descendantPid = Number.parseInt(await waitForFileText(pidFile, 300), 10);
    assert.equal(Number.isSafeInteger(descendantPid) && descendantPid > 0, true);
    await assert.rejects(pending, (error) => error instanceof CommandFailure && error.reason === "timeout");
    assert.equal(Date.now() - startedAt < 500, true, "timeout must not wait for the overall deadline after the leader exits");
    await waitForProcessExit(descendantPid, 300);
  } finally {
    await pending?.catch(() => undefined);
    if (descendantPid && processExists(descendantPid)) process.kill(descendantPid, "SIGKILL");
    await removeDirectory(root);
  }
});

test("non-Git traversal marks a bounded file-set omission as partial", async () => {
  const root = await temporaryDirectory();
  let result;
  try {
    await writeFixture(root, "a.js", "export const a = 1;\n");
    await writeFixture(root, "b.js", "export const b = 1;\n");
    result = await collectGitInputs({ cwd: root, limits: { maxFiles: 1 } });
    assert.equal(result.coverage.complete, false);
    assert.equal(result.coverage.status, "partial");
    assert.equal(result.current.coverage.reasons.includes("file-count-limit"), true);
    assert.equal(result.current.coverage.counts.omitted > 0, true);
    assert.equal(result.current.files.length, 1);
  } finally {
    await result?.dispose();
    await removeDirectory(root);
  }
});

test("non-Git capture fails closed to partial when repository ignore inputs exist", async () => {
  const root = await temporaryDirectory();
  let result;
  try {
    await writeFixture(root, ".gitignore", "src/hidden.js\n");
    await writeFixture(root, "src/hidden.js", "export const hidden = 1;\n");
    result = await collectGitInputs({ cwd: root, scopeRoots: ["src"] });
    assert.equal(result.coverage.complete, false);
    assert.equal(result.current.coverage.reasons.includes("non-git-ignore-semantics-unavailable"), true);
  } finally {
    await result?.dispose();
    await removeDirectory(root);
  }
});

test("non-Git capture retries once after a mid-capture ignore-input change", async () => {
  const root = await temporaryDirectory();
  const ignorePath = path.join(root, ".gitignore");
  const originalOpen = fs.open;
  let scheduled = false;
  let result;
  try {
    await writeFixture(root, ".gitignore", "");
    for (let index = 0; index < 300; index += 1) await writeFixture(root, `src/f${String(index).padStart(4, "0")}.js`, `export const f${index} = ${index};\n`);
    fs.open = async function patchedOpen(filename, ...argumentsAfterFilename) {
      const handle = await originalOpen.call(this, filename, ...argumentsAfterFilename);
      if (!scheduled && path.resolve(String(filename)) === ignorePath) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArguments) => {
          const response = await originalRead(...readArguments);
          if (!scheduled) {
            scheduled = true;
            setTimeout(() => { void fs.writeFile(ignorePath, "src/f0000.js\n").catch(() => undefined); }, 20);
          }
          return response;
        };
      }
      return handle;
    };
    result = await collectGitInputs({ cwd: root, scopeRoots: ["src"] });
    assert.equal(scheduled, true);
    assert.equal(result.provenance.captureAttempts, 2);
    assert.equal(result.coverage.status, "partial");
  } finally {
    fs.open = originalOpen;
    await result?.dispose();
    await removeDirectory(root);
  }
});

test("current-only non-Git capture retains report-safe data and no live path", async () => {
  const root = await temporaryDirectory();
  let result;
  try {
    await writeFixture(root, "src/example.js", "export const value = 1;\n");
    await writeFixture(root, "docs/readme.md", "notes\n");
    result = await collectGitInputs({ cwd: root, scopeRoots: ["src"] });
    assert.equal(result.before, null);
    assert.equal(result.current.kind, "filesystem-current");
    assert.deepEqual(result.current.files.map((file) => file.path), ["src/example.js"]);
    assert.equal(result.coverage.complete, true);
    assert.equal(JSON.stringify(result).includes(root), false);
    assert.equal(result.provenance.git, null);
  } finally {
    await result?.dispose();
    await removeDirectory(root);
  }
});
