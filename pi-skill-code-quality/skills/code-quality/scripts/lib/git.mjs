import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  CommandFailure,
  DEFAULT_LIMITS,
  DeadlineExceededError,
  ScanDeadline,
  SubprocessTracker,
  resolveTrustedExecutable,
  runBounded,
} from "./runner.mjs";
import { scannerSafetyExclusionPathspecs } from "./classification.mjs";

export const ISOLATED_NUMSTAT_FLAGS = Object.freeze([
  "--no-index",
  "--numstat",
  "-z",
  "--no-ext-diff",
  "--no-textconv",
  "--diff-algorithm=myers",
  "--no-indent-heuristic",
  "--no-renames",
]);

export const GIT_CAPTURE_POLICY_VERSION = "git-capture-v2";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function splitNul(bytes) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new CommandFailure("git", null, "malformed-nul-output");
  const records = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === 0) {
      records.push(bytes.subarray(start, index));
      start = index + 1;
    }
  }
  return records;
}

function parseAsciiPrefix(record, separator) {
  const index = record.indexOf(separator);
  if (index < 0) throw new CommandFailure("git", null, "malformed-metadata-record");
  return [record.subarray(0, index).toString("ascii"), record.subarray(index + 1)];
}

export function parseLsTree(bytes) {
  return splitNul(bytes).map((record) => {
    const [header, rawPath] = parseAsciiPrefix(record, 0x09);
    const match = /^(\d+) (blob|tree|commit) ([0-9a-fA-F]+)$/u.exec(header);
    if (!match) throw new CommandFailure("git", null, "malformed-ls-tree-record");
    return { mode: match[1], type: match[2], objectId: match[3], rawPath: Buffer.from(rawPath) };
  });
}

export function parseLsFilesStage(bytes) {
  return splitNul(bytes).map((record) => {
    const [header, rawPath] = parseAsciiPrefix(record, 0x09);
    const match = /^(?:([A-Z?]) )?(\d+) ([0-9a-fA-F]+) ([0-3])$/u.exec(header);
    if (!match) throw new CommandFailure("git", null, "malformed-ls-files-record");
    return { tag: match[1] ?? null, mode: match[2], objectId: match[3], stage: Number(match[4]), rawPath: Buffer.from(rawPath) };
  });
}

export function parseNulPaths(bytes) {
  return splitNul(bytes).map((rawPath) => Buffer.from(rawPath));
}

/** Removes inherited Git injection and pins only read-safe Git configuration. */
export function createSanitizedGitEnvironment({ emptyConfigPath, baseEnvironment = process.env } = {}) {
  if (!emptyConfigPath || !path.isAbsolute(emptyConfigPath)) throw new TypeError("emptyConfigPath must be absolute.");
  const environment = {};
  for (const [key, value] of Object.entries(baseEnvironment)) {
    if (!key.toUpperCase().startsWith("GIT_")) environment[key] = value;
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: emptyConfigPath,
    GIT_CONFIG_SYSTEM: emptyConfigPath,
    GIT_NO_LAZY_FETCH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_PAGER: "cat",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "4",
    GIT_CONFIG_KEY_0: "core.autocrlf",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "core.attributesFile",
    GIT_CONFIG_VALUE_1: emptyConfigPath,
    GIT_CONFIG_KEY_2: "core.excludesFile",
    GIT_CONFIG_VALUE_2: emptyConfigPath,
    GIT_CONFIG_KEY_3: "core.fsmonitor",
    GIT_CONFIG_VALUE_3: "false",
  });
  return environment;
}

class ByteReader {
  constructor(stream, { maxBytes = DEFAULT_LIMITS.maxAnalyzerOutputBytes, onLimit = null, onStreamError = null } = {}) {
    this.buffer = Buffer.alloc(0);
    this.ended = false;
    this.error = null;
    this.waiters = [];
    this.maxBytes = maxBytes;
    this.onLimit = onLimit;
    this.onStreamError = onStreamError;
    stream.on("data", (chunk) => {
      if (this.error) return;
      if (this.buffer.length + chunk.length > this.maxBytes) {
        const error = new CommandFailure("git cat-file", null, "batch-output-limit");
        this.fail(this.onLimit?.(error) ?? error);
        stream.pause();
        return;
      }
      this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
      this.flush();
    });
    stream.on("end", () => {
      this.ended = true;
      this.flush();
    });
    stream.on("error", (error) => {
      this.fail(this.onStreamError?.(error) ?? error);
    });
  }

  fail(error) {
    if (!this.error) this.error = error;
    this.flush();
  }

  flush() {
    for (const resolve of this.waiters.splice(0)) resolve();
  }

  async wait() {
    if (this.error) throw this.error;
    if (this.ended) throw new CommandFailure("git cat-file", null, "unexpected-end-of-output");
    await new Promise((resolve) => this.waiters.push(resolve));
    if (this.error) throw this.error;
  }

  async line(maxBytes = 1_024) {
    while (true) {
      const ending = this.buffer.indexOf(0x0a);
      if (ending >= 0) {
        if (ending > maxBytes) throw new CommandFailure("git cat-file", null, "oversized-batch-header");
        const line = this.buffer.subarray(0, ending);
        this.buffer = this.buffer.subarray(ending + 1);
        return line;
      }
      if (this.buffer.length > maxBytes) throw new CommandFailure("git cat-file", null, "oversized-batch-header");
      await this.wait();
    }
  }

  async exact(size) {
    while (this.buffer.length < size) await this.wait();
    const result = Buffer.from(this.buffer.subarray(0, size));
    this.buffer = this.buffer.subarray(size);
    return result;
  }
}

function waitForBatchClose(closeResult, deadline, reason) {
  const timeoutMs = Math.max(1, deadline.remainingMs());
  let timer;
  return Promise.race([
    closeResult,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceededError(reason)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** One persistent raw-object process. Object data is never filtered or text-converted. */
export class GitBlobBatch {
  constructor({ executable, cwd, environment, deadline, tracker, limits = DEFAULT_LIMITS, signal = null }) {
    this.executable = executable;
    this.deadline = deadline;
    this.tracker = tracker;
    this.limits = limits;
    deadline.assertWorkAvailable();
    tracker.noteSpawn("git");
    this.child = spawn(executable, ["-C", cwd, "cat-file", "--batch"], {
      cwd,
      env: environment,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = [];
    this.stderrBytes = 0;
    this.stderrTruncated = false;
    this.closed = false;
    this.closing = false;
    this.abortPromise = null;
    this.closePromise = null;
    this.failure = null;
    this.signal = signal;
    this.closeResult = new Promise((resolve) => this.child.once("close", (code, closeSignal) => resolve({ code, signal: closeSignal })));
    this.reader = new ByteReader(this.child.stdout, {
      maxBytes: limits.maxAnalyzerOutputBytes,
      onLimit: (error) => {
        const failure = this.recordFailure(error.reason);
        this.observeAbort();
        return failure;
      },
      onStreamError: () => {
        const failure = this.recordFailure("batch-stdout-error");
        this.observeAbort();
        return failure;
      },
    });
    this.cancellation = () => this.observeAbort();
    if (signal?.aborted) this.cancellation();
    else signal?.addEventListener("abort", this.cancellation, { once: true });
    this.child.once("error", () => {
      const failure = this.recordFailure("batch-spawn-error");
      this.reader.fail(failure);
      this.observeAbort();
    });
    this.child.stdin.on("error", () => {
      const failure = this.recordFailure("batch-stdin-error");
      this.reader.fail(failure);
      this.observeAbort();
    });
    this.child.stderr.on("data", (chunk) => {
      const remaining = limits.maxStderrBytes - this.stderrBytes;
      if (remaining > 0) {
        this.stderr.push(chunk.subarray(0, remaining));
        this.stderrBytes += Math.min(remaining, chunk.length);
      }
      if (chunk.length > remaining) this.stderrTruncated = true;
    });
  }

  recordFailure(reason) {
    if (!this.failure) this.failure = new CommandFailure("git cat-file", null, reason);
    return this.failure;
  }

  observeAbort() {
    // Event handlers cannot await, so consume an abort failure here. A later
    // close still awaits the same promise and surfaces it to the caller.
    void this.abort().catch(() => undefined);
  }

  async withinRequestDeadline(operation) {
    const timeoutMs = this.deadline.timeoutFor(this.limits.processTimeoutMs);
    let timer;
    const pending = Promise.resolve().then(operation);
    // A deadline or cancellation can win the race while the pending read later
    // rejects; retain an observer so that rejection is never unhandled.
    void pending.catch(() => undefined);
    const expired = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.observeAbort();
        reject(new DeadlineExceededError("git cat-file did not respond before the deadline."));
      }, timeoutMs);
    });
    try {
      return await Promise.race([pending, expired]);
    } finally {
      clearTimeout(timer);
    }
  }

  async request(objectId, options) {
    return this.withinRequestDeadline(() => this.requestRaw(objectId, options));
  }

  async requestRaw(objectId, { maxBytes }) {
    if (this.failure) throw this.failure;
    if (this.closed) throw new CommandFailure("git cat-file", null, "batch-already-closed");
    this.deadline.assertWorkAvailable();
    if (!/^[0-9a-fA-F]+$/u.test(objectId)) throw new CommandFailure("git cat-file", null, "invalid-object-id");
    let writable;
    try {
      writable = this.child.stdin.write(`${objectId}\n`);
    } catch {
      throw this.recordFailure("batch-stdin-error");
    }
    if (!writable) {
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          this.child.stdin.removeListener("error", onError);
          resolve();
        };
        const onError = (error) => {
          this.child.stdin.removeListener("drain", onDrain);
          reject(error);
        };
        this.child.stdin.once("drain", onDrain);
        this.child.stdin.once("error", onError);
      }).catch(() => {
        throw this.recordFailure("batch-stdin-error");
      });
    }
    const header = (await this.reader.line()).toString("ascii");
    const match = /^([0-9a-fA-F]+) blob ([0-9]+)$/u.exec(header);
    if (!match || match[1].toLowerCase() !== objectId.toLowerCase()) {
      throw new CommandFailure("git cat-file", null, "malformed-or-missing-blob");
    }
    const size = Number(match[2]);
    if (!Number.isSafeInteger(size) || size < 0 || size > maxBytes) {
      await this.abort();
      throw new CommandFailure("git cat-file", null, "blob-exceeds-capture-limit");
    }
    const bytes = await this.reader.exact(size);
    const framing = await this.reader.exact(1);
    if (framing[0] !== 0x0a) throw new CommandFailure("git cat-file", null, "malformed-blob-framing");
    return bytes;
  }

  async abort() {
    if (this.abortPromise) return this.abortPromise;
    this.closed = true;
    this.abortPromise = (async () => {
      try {
        if (process.platform !== "win32") process.kill(-this.child.pid, "SIGKILL");
        else this.child.kill("SIGKILL");
      } catch {
        try {
          this.child.kill("SIGKILL");
        } catch {
          // The child may already have exited; the bounded reap below decides completion.
        }
      }
      return waitForBatchClose(this.closeResult, this.deadline, "git cat-file did not reap.");
    })();
    return this.abortPromise;
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.finishClose();
    return this.closePromise;
  }

  async finishClose() {
    try {
      if (this.closed) {
        if (this.abortPromise) await this.abortPromise;
        return;
      }
      this.closing = true;
      try {
        this.child.stdin.end();
      } catch {
        this.reader.fail(this.recordFailure("batch-stdin-error"));
        await this.abort();
        throw this.failure;
      }
      let result;
      try {
        result = await waitForBatchClose(this.closeResult, this.deadline, "git cat-file did not close before the scan deadline.");
      } catch (error) {
        try {
          await this.abort();
        } catch (abortError) {
          throw abortError;
        }
        throw error;
      }
      this.closed = true;
      if (this.abortPromise) await this.abortPromise;
      if (this.failure) throw this.failure;
      if (result.code !== 0 || result.signal || this.reader.buffer.length !== 0 || this.stderrTruncated) {
        throw new CommandFailure("git cat-file", result.code, "invalid-batch-response");
      }
    } finally {
      this.signal?.removeEventListener("abort", this.cancellation);
    }
  }
}

export class GitClient {
  static async create({ cwd, checkoutRoot = cwd, gitExecutable, emptyConfigPath, deadline = new ScanDeadline(), tracker = new SubprocessTracker(), limits = DEFAULT_LIMITS, signal = null } = {}) {
    const executable = await resolveTrustedExecutable({ command: "git", explicitPath: gitExecutable, checkoutRoot });
    return new GitClient({ cwd, executable, emptyConfigPath, deadline, tracker, limits, signal });
  }

  constructor({ cwd, executable, emptyConfigPath, deadline, tracker, limits = DEFAULT_LIMITS, signal }) {
    this.cwd = path.resolve(cwd);
    this.executable = executable;
    this.deadline = deadline;
    this.tracker = tracker;
    this.limits = limits;
    this.signal = signal;
    this.environment = createSanitizedGitEnvironment({ emptyConfigPath });
    this.version = null;
  }

  async run(args, { allowedExitCodes = [0], cwd = this.cwd, inRepository = true, maxStdoutBytes = this.limits.maxAnalyzerOutputBytes, input = null, signal = null } = {}) {
    const command = inRepository ? ["-C", this.cwd, ...args] : args;
    return runBounded(this.executable, command, {
      cwd,
      env: this.environment,
      deadline: this.deadline,
      tracker: this.tracker,
      kind: "git",
      timeoutMs: this.limits.processTimeoutMs,
      maxStdoutBytes,
      maxStderrBytes: this.limits.maxStderrBytes,
      allowedExitCodes,
      input,
      signal: signal ?? this.signal,
    });
  }

  async tryRepositoryInfo(base = null) {
    const arguments_ = ["rev-parse", "--show-toplevel", "--git-path", "index", "--git-path", "info/exclude"];
    if (base !== null) {
      if (typeof base !== "string" || !base || base.includes("\0")) throw new TypeError("A non-empty Git baseline is required.");
      arguments_.push("--verify", "--end-of-options", `${base}^{commit}`);
    }
    const response = await this.run(arguments_, { allowedExitCodes: [0, 1, 128] });
    if (response.code !== 0) return null;
    const lines = response.stdout.toString("utf8").trimEnd().split(/\r?\n/u);
    if (lines.length !== (base === null ? 3 : 4) || lines.some((line) => !line)) throw new CommandFailure("git", response.code, "malformed-repository-info");
    const root = path.resolve(this.cwd, lines[0]);
    const baseCommit = base === null ? null : lines[3];
    if (baseCommit !== null && !/^[0-9a-fA-F]+$/u.test(baseCommit)) throw new CommandFailure("git", response.code, "invalid-baseline-object");
    return {
      root,
      indexPath: path.resolve(this.cwd, lines[1]),
      infoExcludePath: path.resolve(this.cwd, lines[2]),
      baseCommit,
    };
  }

  async setRepositoryRoot(root) {
    await resolveTrustedExecutable({ explicitPath: this.executable, checkoutRoot: root });
    this.cwd = path.resolve(root);
  }

  async getVersion() {
    if (this.version) return this.version;
    const response = await this.run(["--version"]);
    const version = response.stdout.toString("ascii").trim();
    if (!/^git version [^\s]+/u.test(version)) throw new CommandFailure("git", response.code, "unrecognized-git-version");
    this.version = version;
    return version;
  }

  async listTree(commit) {
    const response = await this.run(["ls-tree", "-r", "-z", "--full-tree", commit]);
    return parseLsTree(response.stdout);
  }

  async listIndex() {
    const response = await this.run(["ls-files", "--cached", "--stage", "-v", "-z"]);
    return parseLsFilesStage(response.stdout);
  }

  /**
   * Bounds untracked discovery before output capture. It never asks Git to apply
   * repository/global ignore rules: scanner-owned literal scope and canonical
   * safety pathspecs only reduce the candidate universe. Frozen check-ignore
   * still decides eligibility for every returned path.
   */
  async listUntracked({ scopeRoots = [""], includeUntracked = false } = {}) {
    if (!Array.isArray(scopeRoots) || scopeRoots.length === 0 || scopeRoots.some((root) => typeof root !== "string" || root.includes("\\") || root.includes("\0"))) {
      throw new TypeError("Untracked discovery requires normalized scope roots.");
    }
    const literal = (reportPath) => `:(top,literal)${reportPath}`;
    const globEscape = (reportPath) => reportPath.replace(/[\\*?\[\]]/gu, "\\$&");
    const ignorePathspecs = new Set();
    for (const root of scopeRoots) {
      const segments = root ? root.split("/") : [];
      let ancestor = "";
      ignorePathspecs.add(literal(".gitignore"));
      for (const segment of segments) {
        ancestor = ancestor ? `${ancestor}/${segment}` : segment;
        ignorePathspecs.add(literal(`${ancestor}/.gitignore`));
      }
      ignorePathspecs.add(`:(top,glob)${root ? `${globEscape(root)}/**/.gitignore` : "**/.gitignore"}`);
    }
    const scopePathspecs = includeUntracked
      ? scopeRoots.map((root) => root ? literal(root) : ":(top,glob)**")
      : [];
    const pathspecs = [...new Set([...scopePathspecs, ...ignorePathspecs]), ...scannerSafetyExclusionPathspecs()];
    const response = await this.run(["ls-files", "--others", "-z", "--", ...pathspecs]);
    return {
      paths: parseNulPaths(response.stdout),
      discovery: Object.freeze({
        version: "scoped-untracked-discovery-v1",
        includeUntracked: Boolean(includeUntracked),
        scopePathspecs: includeUntracked ? "literal-top-roots-v1" : "ignore-inputs-only-v1",
        safetyExclusions: "canonical-classification-pathspecs-v1",
        unenumeratedSafetyExcludedCount: "unknown",
        unenumeratedOutOfScopeCount: "unknown",
      }),
    };
  }

  openBlobBatch({ signal = null } = {}) {
    return new GitBlobBatch({
      executable: this.executable,
      cwd: this.cwd,
      environment: this.environment,
      deadline: this.deadline,
      tracker: this.tracker,
      limits: this.limits,
      signal: signal ?? this.signal,
    });
  }
}

function parseNumstat(bytes, ids) {
  const records = [];
  let offset = 0;
  const readNul = () => {
    const ending = bytes.indexOf(0x00, offset);
    if (ending < 0) throw new CommandFailure("git diff", null, "malformed-numstat-record");
    const value = bytes.subarray(offset, ending);
    offset = ending + 1;
    return value;
  };
  while (offset < bytes.length) {
    const firstTab = bytes.indexOf(0x09, offset);
    const secondTab = firstTab < 0 ? -1 : bytes.indexOf(0x09, firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new CommandFailure("git diff", null, "malformed-numstat-record");
    const addedText = bytes.subarray(offset, firstTab).toString("ascii");
    const deletedText = bytes.subarray(firstTab + 1, secondTab).toString("ascii");
    offset = secondTab + 1;
    const names = [];
    // With --no-index Git emits a NUL marker followed by both compared names,
    // even when rename detection is disabled. Ordinary numstat has one name.
    if (bytes[offset] === 0x00) {
      offset += 1;
      names.push(readNul(), readNul());
    } else {
      names.push(readNul());
    }
    const idsForRecord = new Set(names.map((name) => name.toString("ascii").split(/[\\/]/u).at(-1)).filter((id) => ids.has(id)));
    if (idsForRecord.size !== 1) throw new CommandFailure("git diff", null, "unmapped-numstat-path");
    const parseCount = (text) => (text === "-" ? null : Number(text));
    const added = parseCount(addedText);
    const deleted = parseCount(deletedText);
    if ((added !== null && (!Number.isSafeInteger(added) || added < 0)) || (deleted !== null && (!Number.isSafeInteger(deleted) || deleted < 0))) {
      throw new CommandFailure("git diff", null, "invalid-numstat-count");
    }
    records.push({ id: [...idsForRecord][0], added, deleted });
  }
  return records;
}

function changeRecord({ beforeEntry, currentEntry, added, deleted }) {
  return {
    kind: beforeEntry && currentEntry ? "modified" : beforeEntry ? "deleted" : "added",
    beforePath: beforeEntry?.path ?? null,
    currentPath: currentEntry?.path ?? null,
    beforeCategory: beforeEntry?.category ?? null,
    currentCategory: currentEntry?.category ?? null,
    added,
    deleted,
    binary: added === null || deleted === null,
  };
}

/**
 * Computes physical line changes only from frozen bytes in scanner-owned paths.
 * The reviewed repository is never a diff input.
 */
export async function computeIsolatedLineChanges({ git, beforeEntries, currentEntries, renameRecords = [], tempRoot, deadline = git.deadline }) {
  const beforeRoot = path.join(tempRoot, "isolated-before");
  const currentRoot = path.join(tempRoot, "isolated-current");
  await fs.mkdir(beforeRoot, { recursive: true });
  await fs.mkdir(currentRoot, { recursive: true });

  const union = new Map();
  for (const entry of beforeEntries.values()) union.set(entry.key, { before: entry, current: null });
  for (const entry of currentEntries.values()) union.set(entry.key, { ...(union.get(entry.key) ?? { before: null }), current: entry });
  const pairs = [...union.values()].sort((left, right) => {
    const leftPath = left.current?.path ?? left.before?.path;
    const rightPath = right.current?.path ?? right.before?.path;
    return leftPath.localeCompare(rightPath);
  });
  if (pairs.length === 0) return [];

  const ids = new Map();
  await Promise.all(pairs.map(async (pair, index) => {
    const id = `f${String(index + 1).padStart(6, "0")}`;
    ids.set(id, pair);
    if (pair.before) await fs.writeFile(path.join(beforeRoot, id), pair.before.bytes, { flag: "wx", mode: 0o600 });
    if (pair.current) await fs.writeFile(path.join(currentRoot, id), pair.current.bytes, { flag: "wx", mode: 0o600 });
  }));

  const response = await git.run([
    "-c", "core.autocrlf=false",
    "-c", `core.attributesFile=${path.join(tempRoot, "empty-attributes")}`,
    "--no-pager",
    "diff",
    ...ISOLATED_NUMSTAT_FLAGS,
    beforeRoot,
    currentRoot,
  ], {
    cwd: tempRoot,
    inRepository: false,
    allowedExitCodes: [0, 1],
  });
  if (response.stdoutTruncated) throw new CommandFailure("git diff", response.code, "numstat-output-limit");

  const changesByKey = new Map();
  for (const parsed of parseNumstat(response.stdout, ids)) {
    const pair = ids.get(parsed.id);
    const key = pair.current?.key ?? pair.before.key;
    changesByKey.set(key, changeRecord({ beforeEntry: pair.before, currentEntry: pair.current, ...parsed }));
  }

  for (const rename of renameRecords) {
    const deleted = changesByKey.get(rename.beforeKey);
    const added = changesByKey.get(rename.currentKey);
    if (!deleted || !added) continue;
    changesByKey.delete(rename.beforeKey);
    changesByKey.delete(rename.currentKey);
    changesByKey.set(`rename:${rename.beforeKey}:${rename.currentKey}`, {
      kind: "rename",
      beforePath: rename.beforePath,
      currentPath: rename.currentPath,
      beforeCategory: rename.beforeCategory,
      currentCategory: rename.currentCategory,
      added: 0,
      deleted: 0,
      binary: false,
    });
  }
  return [...changesByKey.values()].sort((left, right) => {
    const leftPath = left.currentPath ?? left.beforePath;
    const rightPath = right.currentPath ?? right.beforePath;
    return leftPath.localeCompare(rightPath) || left.kind.localeCompare(right.kind);
  });
}

export function uniqueExactRenames(beforeEntries, currentEntries) {
  const missingBefore = [...beforeEntries.values()].filter((entry) => !currentEntries.has(entry.key));
  const missingCurrent = [...currentEntries.values()].filter((entry) => !beforeEntries.has(entry.key));
  const group = (entries) => {
    const groups = new Map();
    for (const entry of entries) {
      const existing = groups.get(entry.sha256) ?? [];
      existing.push(entry);
      groups.set(entry.sha256, existing);
    }
    return groups;
  };
  const beforeGroups = group(missingBefore);
  const currentGroups = group(missingCurrent);
  const records = [];
  for (const [digest, oldEntries] of beforeGroups) {
    const newEntries = currentGroups.get(digest);
    if (oldEntries.length !== 1 || newEntries?.length !== 1) continue;
    const before = oldEntries[0];
    const current = newEntries[0];
    records.push({
      policy: "sha256-one-to-one-v1",
      beforeKey: before.key,
      currentKey: current.key,
      beforePath: before.path,
      currentPath: current.path,
      beforeCategory: before.category,
      currentCategory: current.category,
    });
  }
  return records.sort((left, right) => left.beforePath.localeCompare(right.beforePath));
}

export function gitCompatibility() {
  return {
    version: GIT_CAPTURE_POLICY_VERSION,
    metadata: "nul-delimited-raw-paths-v1",
    blobRead: "single-persistent-cat-file-batch-v1",
    lineDiff: {
      flags: [...ISOLATED_NUMSTAT_FLAGS],
      attributes: "scanner-owned-empty-file-v1",
      rawBytes: "preserved-v1",
    },
    renamePolicy: "sha256-one-to-one-v1",
    gitRenames: "disabled",
    configIsolation: "nosystem-empty-global-and-pinned-core-v1",
  };
}

export function hashBytes(bytes) {
  return sha256(bytes);
}
