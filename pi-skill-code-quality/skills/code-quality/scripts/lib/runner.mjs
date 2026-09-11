import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { spawn } from "node:child_process";

export const DEFAULT_LIMITS = Object.freeze({
  deadlineMs: 60_000,
  cleanupReserveMs: 3_000,
  maxFiles: 5_000,
  maxRetainedBytes: 64 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024,
  maxAnalyzerOutputBytes: 8 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  maxDivergenceExamples: 20,
  analyzerConcurrency: 1,
  analyzerRetries: 0,
  captureRetries: 1,
  maxGitProcesses: 23,
  maxSubprocesses: 40,
  processTimeoutMs: 20_000,
});

export class DeadlineExceededError extends Error {
  constructor(message = "The scan deadline expired.") {
    super(message);
    this.name = "DeadlineExceededError";
  }
}

export class CommandFailure extends Error {
  constructor(commandName, exitCode, reason = "command-failed") {
    super(`${commandName} ${reason} (exit ${exitCode ?? "unknown"}).`);
    this.name = "CommandFailure";
    this.commandName = commandName;
    this.exitCode = exitCode;
    this.reason = reason;
  }
}

/** A single monotonic deadline shared by collection, processes, and cleanup. */
export class ScanDeadline {
  constructor({ deadlineMs = DEFAULT_LIMITS.deadlineMs, cleanupReserveMs = DEFAULT_LIMITS.cleanupReserveMs } = {}) {
    if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) throw new TypeError("deadlineMs must be positive.");
    if (!Number.isFinite(cleanupReserveMs) || cleanupReserveMs < 0 || cleanupReserveMs >= deadlineMs) {
      throw new TypeError("cleanupReserveMs must be non-negative and smaller than deadlineMs.");
    }
    this.deadlineMs = deadlineMs;
    this.cleanupReserveMs = cleanupReserveMs;
    this.startedAt = performance.now();
    this.endsAt = this.startedAt + deadlineMs;
  }

  remainingMs() {
    return Math.max(0, this.endsAt - performance.now());
  }

  workRemainingMs() {
    return Math.max(0, this.remainingMs() - this.cleanupReserveMs);
  }

  assertWorkAvailable() {
    if (this.workRemainingMs() <= 0) throw new DeadlineExceededError();
  }

  timeoutFor(requestedMs = DEFAULT_LIMITS.processTimeoutMs) {
    this.assertWorkAvailable();
    return Math.max(1, Math.min(requestedMs, this.workRemainingMs()));
  }

  report() {
    return { deadlineMs: this.deadlineMs, cleanupReserveMs: this.cleanupReserveMs };
  }
}

export class SubprocessTracker {
  constructor({ maxGitProcesses = DEFAULT_LIMITS.maxGitProcesses, maxSubprocesses = DEFAULT_LIMITS.maxSubprocesses } = {}) {
    this.maxGitProcesses = maxGitProcesses;
    this.maxSubprocesses = maxSubprocesses;
    this.gitProcesses = 0;
    this.totalProcesses = 0;
  }

  noteSpawn(kind = "other") {
    if (this.totalProcesses >= this.maxSubprocesses) throw new DeadlineExceededError("The subprocess ceiling was reached.");
    if (kind === "git" && this.gitProcesses >= this.maxGitProcesses) {
      throw new DeadlineExceededError("The Git subprocess ceiling was reached.");
    }
    this.totalProcesses += 1;
    if (kind === "git") this.gitProcesses += 1;
  }

  report() {
    return {
      gitProcesses: this.gitProcesses,
      totalProcesses: this.totalProcesses,
      maxGitProcesses: this.maxGitProcesses,
      maxSubprocesses: this.maxSubprocesses,
    };
  }
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

async function realpathIfPossible(candidate) {
  try {
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

function candidateNames(command, platform) {
  if (path.extname(command)) return [command];
  return platform === "win32" ? [`${command}.exe`, command] : [command];
}

/**
 * Resolves one regular executable outside the reviewed checkout. It deliberately
 * does not use a shell, current-directory PATH entries, or Windows .cmd shims.
 */
export async function resolveTrustedExecutable({ command, explicitPath, pathEnv = process.env.PATH ?? "", checkoutRoot, platform = process.platform } = {}) {
  if (!command && !explicitPath) throw new TypeError("An executable command or explicitPath is required.");
  const requested = explicitPath ?? command;
  const root = checkoutRoot ? await realpathIfPossible(checkoutRoot) : null;
  const candidates = [];
  if (path.isAbsolute(requested)) {
    candidates.push(requested);
  } else {
    for (const directory of pathEnv.split(path.delimiter)) {
      if (!directory || directory === ".") continue;
      for (const name of candidateNames(requested, platform)) candidates.push(path.resolve(directory, name));
    }
  }

  for (const candidate of candidates) {
    if (platform === "win32" && path.extname(candidate).toLowerCase() === ".cmd") continue;
    const resolved = await realpathIfPossible(candidate);
    if (!resolved || (root && isInside(root, resolved))) continue;
    try {
      const stats = await fs.stat(resolved);
      if (!stats.isFile()) continue;
      if (platform !== "win32" && (stats.mode & 0o111) === 0) continue;
      return resolved;
    } catch {
      // Continue searching PATH candidates only.
    }
  }
  throw new CommandFailure(command ?? "executable", null, "trusted-executable-unavailable");
}

export async function createScannerTempRoot(prefix = "pi-code-quality-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function sha256File(filePath, { deadline, maxBytes = DEFAULT_LIMITS.maxRetainedBytes } = {}) {
  const handle = await fs.open(filePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new CommandFailure("file", null, "hash-input-exceeds-limit");
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      deadline?.assertWorkAvailable();
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (bytesRead === 0) throw new CommandFailure("file", null, "hash-input-short-read");
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    deadline?.assertWorkAvailable();
    const extra = await handle.read(chunk, 0, 1, offset);
    const after = await handle.stat();
    if (extra.bytesRead !== 0 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new CommandFailure("file", null, "hash-input-modified-during-read");
    }
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function appendBounded(chunks, chunk, state, limit) {
  if (state.bytes >= limit) {
    state.truncated = true;
    return true;
  }
  const permitted = Math.min(chunk.length, limit - state.bytes);
  if (permitted > 0) chunks.push(chunk.subarray(0, permitted));
  state.bytes += permitted;
  if (permitted !== chunk.length) state.truncated = true;
  return state.truncated;
}

async function taskkillPath(platform) {
  if (platform !== "win32") return null;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) return null;
  const candidate = path.join(systemRoot, "System32", "taskkill.exe");
  const resolved = await realpathIfPossible(candidate);
  if (!resolved || !path.isAbsolute(resolved)) return null;
  const stats = await fs.stat(resolved).catch(() => null);
  return stats?.isFile() ? resolved : null;
}

function waitForClose(child) {
  return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

function killDirect(child) {
  try {
    child.kill("SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function hasChildPid(child) {
  return Number.isSafeInteger(child?.pid) && child.pid > 0;
}

function waitForReap(closeResult, deadline, reason) {
  const timeoutMs = Math.max(1, deadline.remainingMs());
  let timer;
  return Promise.race([
    closeResult,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new CommandFailure("process", null, reason)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function terminateChild(child, { platform, tracker, deadline, requireTreeTermination, treeTerminator = null, closeResult = null }) {
  const leaderExited = child.exitCode !== null || child.signalCode !== null;
  if (platform !== "win32") {
    if (!hasChildPid(child)) {
      if (!leaderExited) killDirect(child);
      return;
    }
    try {
      // The detached process group remains owned by this child PID after its
      // leader exits, while inherited stdio descendants can still keep close open.
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (leaderExited && error?.code === "ESRCH") return;
      if (!leaderExited) killDirect(child);
      if (requireTreeTermination) throw new CommandFailure("process", null, "tree-termination-failed");
      return;
    }
    if (closeResult) await waitForReap(closeResult, deadline, "tree-termination-timeout");
    return;
  }

  if (leaderExited || !hasChildPid(child)) return;
  const executable = treeTerminator ?? await taskkillPath(platform);
  if (!executable) {
    killDirect(child);
    if (requireTreeTermination) throw new CommandFailure("taskkill", null, "trusted-tree-termination-unavailable");
    return;
  }
  tracker?.noteSpawn("termination");
  const timeoutMs = Math.max(1, Math.min(1_000, deadline?.remainingMs() ?? 1_000));
  const helper = spawn(executable, ["/PID", String(child.pid), "/T", "/F"], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
  });
  const helperClose = new Promise((resolve, reject) => {
    helper.once("close", (code, signal) => resolve({ code, signal }));
    helper.once("error", reject);
  });
  let timer;
  let result;
  try {
    result = await Promise.race([
      helperClose,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          helper.kill();
          reject(new CommandFailure("taskkill", null, "tree-termination-timeout"));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    killDirect(child);
    if (requireTreeTermination) throw error;
    return;
  } finally {
    clearTimeout(timer);
  }
  if (result.code !== 0 || result.signal) {
    killDirect(child);
    if (requireTreeTermination) throw new CommandFailure("taskkill", result.code, "tree-termination-failed");
  }
}

/**
 * Runs an already trusted executable with a bounded capture. Callers receive
 * bytes only; no command output is automatically placed in report objects.
 */
export async function runBounded(executable, args, {
  cwd,
  env,
  deadline = new ScanDeadline(),
  tracker = new SubprocessTracker(),
  kind = "other",
  timeoutMs = DEFAULT_LIMITS.processTimeoutMs,
  maxStdoutBytes = DEFAULT_LIMITS.maxAnalyzerOutputBytes,
  maxStderrBytes = DEFAULT_LIMITS.maxStderrBytes,
  allowedExitCodes = [0],
  requireTreeTermination = false,
  platform = process.platform,
  input = null,
  signal = null,
} = {}) {
  deadline.assertWorkAvailable();
  const mustTerminateTree = requireTreeTermination || kind === "analyzer";
  // On Windows an analyzer cannot be safely started unless its whole process
  // tree can be terminated. Checking this before spawn avoids executing it at all.
  const treeTerminator = mustTerminateTree && platform === "win32" ? await taskkillPath(platform) : null;
  if (mustTerminateTree && platform === "win32" && !treeTerminator) {
    throw new CommandFailure("taskkill", null, "trusted-tree-termination-unavailable");
  }
  tracker.noteSpawn(kind);
  const effectiveTimeout = deadline.timeoutFor(timeoutMs);
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdoutState = { bytes: 0, truncated: false };
  const stderrState = { bytes: 0, truncated: false };
  let stopReason = null;
  let termination = null;
  let terminationError = null;

  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    detached: platform !== "win32",
    windowsHide: true,
    stdio: [input === null ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const close = waitForClose(child);
  const requestTermination = (reason) => {
    if (!stopReason) stopReason = reason;
    if (!termination) {
      termination = terminateChild(child, {
        platform,
        tracker,
        deadline,
        requireTreeTermination: mustTerminateTree,
        treeTerminator,
        closeResult: close,
      }).catch((error) => {
        terminationError = error;
      });
    }
  };
  const cancellation = () => requestTermination("cancelled");
  if (signal?.aborted) cancellation();
  else signal?.addEventListener("abort", cancellation, { once: true });
  const timer = setTimeout(() => requestTermination("timeout"), effectiveTimeout);

  child.stdout.on("data", (chunk) => {
    if (appendBounded(stdoutChunks, chunk, stdoutState, maxStdoutBytes)) requestTermination("stdout-limit");
  });
  child.stderr.on("data", (chunk) => {
    appendBounded(stderrChunks, chunk, stderrState, maxStderrBytes);
  });
  child.on("error", () => requestTermination("spawn-error"));

  if (input !== null) {
    child.stdin.on("error", () => requestTermination("stdin-error"));
    child.stdin.end(input);
  }

  let closeTimer;
  const boundedClose = new Promise((_, reject) => {
    closeTimer = setTimeout(() => {
      killDirect(child);
      reject(new DeadlineExceededError("A subprocess did not reap before the scan deadline."));
    }, Math.max(1, deadline.remainingMs()));
  });
  let result;
  let closeError = null;
  try {
    result = await Promise.race([close, boundedClose]);
  } catch (error) {
    closeError = error;
  } finally {
    clearTimeout(timer);
    clearTimeout(closeTimer);
    signal?.removeEventListener("abort", cancellation);
  }
  if (termination) await termination;
  if (terminationError) throw terminationError;
  if (closeError) throw closeError;
  const response = {
    code: result.code,
    signal: result.signal,
    stdout: Buffer.concat(stdoutChunks),
    stderr: Buffer.concat(stderrChunks),
    stdoutTruncated: stdoutState.truncated,
    stderrTruncated: stderrState.truncated,
    timedOut: stopReason === "timeout",
  };
  if (stopReason || !allowedExitCodes.includes(result.code)) {
    throw new CommandFailure(path.basename(executable), result.code, stopReason ?? "command-failed");
  }
  return response;
}
