import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createNonTextTarget,
  isCanonicalPath,
  sha256,
  type LineRange,
  type SnapshotTarget,
} from "./core.ts";
import {
  DEFAULT_SNAPSHOT_LIMITS,
  capturePathTarget,
  createMetadataTarget,
  defaultExclusionReason,
  snapshotTargetFromBuffer,
  type PathExcluder,
  type SnapshotLimits,
} from "./snapshot.ts";

export const DEFAULT_GIT_LIMITS = {
  timeoutMs: 10_000,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 64 * 1024,
  contextLines: 3,
  captureAttempts: 2,
} as const;

export type GitCaptureOptions = {
  contextLines?: number;
  limits?: SnapshotLimits;
  signal?: AbortSignal;
  exclude?: PathExcluder;
};

export type GitRawEntry = {
  status: string;
  oldPath?: string;
  newPath?: string;
  oldObject: string;
  newObject: string;
};

export type GitChange = {
  layer: "staged" | "worktree" | "untracked";
  status: string;
  oldPath?: string;
  newPath?: string;
  oldRanges: LineRange[];
  newRanges: LineRange[];
};

export type CurrentPathBaseline =
  | { path: string; expected: "present"; sha256: string; byteLength: number }
  | { path: string; expected: "absent" };

export type GitCapture = {
  repoRoot: string;
  headObject?: string;
  targets: SnapshotTarget[];
  changes: GitChange[];
  baselines: CurrentPathBaseline[];
};

export class ReviewGitError extends Error {}

export type GitRunOptions = {
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  signal?: AbortSignal;
};

function resolvedNumber(value: number | undefined, fallback: number, name: string): number {
  const output = value ?? fallback;
  if (!Number.isInteger(output) || output <= 0) throw new ReviewGitError(`${name} must be a positive integer.`);
  return output;
}

type ResolvedSnapshotLimits = {
  maxTargets: number;
  maxTargetBytes: number;
  maxTotalBytes: number;
  maxPathLength: number;
  maxDirectoryEntries: number;
  maxDirectoryDepth: number;
};

function resolvedSnapshotLimits(input: SnapshotLimits = {}): ResolvedSnapshotLimits {
  const limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...input };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) throw new ReviewGitError(`${name} must be a positive integer.`);
  }
  return limits;
}

/** Run only a caller-supplied Git argv vector, with textconv/external diff disabled. */
export async function runGit(cwd: string, args: readonly string[], options: GitRunOptions = {}): Promise<Buffer> {
  if (!Array.isArray(args) || args.length === 0 || !args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
    throw new ReviewGitError("Git arguments must be a non-empty NUL-free argv array.");
  }
  if (!["diff", "rev-parse", "cat-file", "ls-files", "--version"].includes(args[0])) {
    throw new ReviewGitError("Review Git helper permits only read-only Git commands.");
  }
  if (args[0] === "diff" && args.slice(1).some((arg) => arg === "--output" || arg.startsWith("--output=") || arg === "--ext-diff" || arg === "--textconv")) {
    throw new ReviewGitError("Review Git helper rejects diff options that can write files or invoke external programs.");
  }
  if (options.signal?.aborted) throw new ReviewGitError("Git operation was cancelled.");
  const timeoutMs = resolvedNumber(options.timeoutMs, DEFAULT_GIT_LIMITS.timeoutMs, "Git timeout");
  const maxStdoutBytes = resolvedNumber(options.maxStdoutBytes, DEFAULT_GIT_LIMITS.maxStdoutBytes, "Git stdout limit");
  const maxStderrBytes = resolvedNumber(options.maxStderrBytes, DEFAULT_GIT_LIMITS.maxStderrBytes, "Git stderr limit");
  return await new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "diff.external=", "-c", "core.quotepath=false", ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1" },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let stoppedReason: string | undefined;
    let settled = false;
    const stop = (reason: string) => {
      if (stoppedReason) return;
      stoppedReason = reason;
      try { child.kill("SIGKILL"); } catch { /* Child already exited. */ }
    };
    const timer = setTimeout(() => stop(`Git command timed out after ${timeoutMs}ms.`), timeoutMs);
    const abort = () => stop("Git operation was cancelled.");
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (error?: Error, output?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(output!);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutLength += chunk.length;
      if (stdoutLength > maxStdoutBytes) return stop(`Git output exceeded the ${maxStdoutBytes}-byte limit.`);
      stdout.push(Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength > maxStderrBytes) return stop(`Git error output exceeded the ${maxStderrBytes}-byte limit.`);
      stderr.push(Buffer.from(chunk));
    });
    child.on("error", (error) => finish(new ReviewGitError(`Could not run Git: ${error.message}`)));
    child.on("close", (code) => {
      if (stoppedReason) return finish(new ReviewGitError(stoppedReason));
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 1_200);
        return finish(new ReviewGitError(detail ? `Git ${args[0]} failed: ${detail}` : `Git ${args[0]} failed with exit code ${code ?? "unknown"}.`));
      }
      finish(undefined, Buffer.concat(stdout));
    });
  });
}

function splitZero(buffer: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(0, start);
    if (end < 0) {
      fields.push(Buffer.from(buffer.subarray(start)));
      break;
    }
    fields.push(Buffer.from(buffer.subarray(start, end)));
    start = end + 1;
  }
  return fields;
}

function strictPath(raw: Buffer): string {
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
    if (!Buffer.from(value, "utf8").equals(raw) || !isCanonicalPath(value)) throw new Error("invalid path");
    return value;
  } catch {
    throw new ReviewGitError("Git reported a path that is not valid project-relative UTF-8.");
  }
}

/** Parse `git diff --raw -z` without filename quoting or shell parsing. */
export function parseRawDiff(buffer: Buffer): GitRawEntry[] {
  const fields = splitZero(buffer);
  const entries: GitRawEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (!header?.length) continue;
    const parts = header.toString("ascii").split(" ");
    if (parts.length < 5 || !parts[0].startsWith(":")) throw new ReviewGitError("Malformed Git raw diff header.");
    const status = parts[4];
    const oldObject = parts[2];
    const newObject = parts[3];
    if (!/^[0-9a-f]+$/i.test(oldObject) || !/^[0-9a-f]+$/i.test(newObject) || !/^[A-Z][0-9]*$/i.test(status)) {
      throw new ReviewGitError("Malformed Git raw diff identity.");
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldRaw = fields[index++];
      const newRaw = fields[index++];
      if (!oldRaw || !newRaw) throw new ReviewGitError("Malformed Git rename/copy diff entry.");
      entries.push({ status, oldPath: strictPath(oldRaw), newPath: strictPath(newRaw), oldObject, newObject });
      continue;
    }
    const pathname = fields[index++];
    if (!pathname) throw new ReviewGitError("Malformed Git raw diff path.");
    const decoded = strictPath(pathname);
    entries.push({
      status,
      oldPath: status.startsWith("A") ? undefined : decoded,
      newPath: status.startsWith("D") ? undefined : decoded,
      oldObject,
      newObject,
    });
  }
  return entries;
}

/** Parse hunk ranges already expanded by Git's requested context. */
export function parsePatchHunks(patch: Buffer): { oldRanges: LineRange[]; newRanges: LineRange[]; binary: boolean; modeOnly: boolean } {
  const text = patch.toString("utf8");
  const oldRanges: LineRange[] = [];
  const newRanges: LineRange[] = [];
  const expression = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (let match; (match = expression.exec(text));) {
    const oldStart = Number(match[1]);
    const oldLength = Number(match[2] ?? "1");
    const newStart = Number(match[3]);
    const newLength = Number(match[4] ?? "1");
    if (oldLength > 0) oldRanges.push({ start: oldStart, end: oldStart + oldLength - 1 });
    if (newLength > 0) newRanges.push({ start: newStart, end: newStart + newLength - 1 });
  }
  const binary = /(?:^|\n)(?:Binary files |GIT binary patch)/.test(text);
  const modeOnly = !binary && oldRanges.length === 0 && newRanges.length === 0
    && /(?:^|\n)old mode [0-7]{6}\nnew mode [0-7]{6}(?:\n|$)/.test(text)
    && !/(?:^|\n)index /.test(text);
  return { oldRanges, newRanges, binary, modeOnly };
}

function nonZeroObject(value: string): boolean {
  return /[1-9a-f]/i.test(value);
}

type TargetAccumulator = {
  targets: Map<string, SnapshotTarget>;
  totalSnapshotBytes: number;
  limits: ResolvedSnapshotLimits;
};

function reserveTarget(accumulator: TargetAccumulator): void {
  if (accumulator.targets.size >= accumulator.limits.maxTargets) throw new ReviewGitError("Git review exceeds the target limit.");
  if (accumulator.totalSnapshotBytes >= accumulator.limits.maxTotalBytes) throw new ReviewGitError("Git review exceeds the total snapshot byte limit.");
}

function effectiveSnapshotLimits(accumulator: TargetAccumulator): ResolvedSnapshotLimits {
  reserveTarget(accumulator);
  return {
    ...accumulator.limits,
    maxTargetBytes: Math.min(accumulator.limits.maxTargetBytes, accumulator.limits.maxTotalBytes - accumulator.totalSnapshotBytes),
  };
}

function mergeTarget(accumulator: TargetAccumulator, target: SnapshotTarget): void {
  const prior = accumulator.targets.get(target.id);
  if (!prior) {
    reserveTarget(accumulator);
    const bytes = target.contentBase64 ? target.byteLength ?? 0 : 0;
    if (accumulator.totalSnapshotBytes + bytes > accumulator.limits.maxTotalBytes) throw new ReviewGitError("Git review exceeds the total snapshot byte limit.");
    accumulator.totalSnapshotBytes += bytes;
    accumulator.targets.set(target.id, target);
    return;
  }
  if (prior.disposition !== target.disposition || prior.version !== target.version || prior.path !== target.path || prior.sha256 !== target.sha256) {
    throw new ReviewGitError("Conflicting frozen target identities were captured.");
  }
  if (prior.disposition === "reviewable" || prior.disposition === "empty") {
    const ranges = [...prior.requiredRanges, ...target.requiredRanges].sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: LineRange[] = [];
    for (const item of ranges) {
      const previous = merged.at(-1);
      if (previous && item.start <= previous.end + 1) previous.end = Math.max(previous.end, item.end);
      else merged.push({ ...item });
    }
    accumulator.targets.set(target.id, { ...prior, requiredRanges: merged });
  }
}

async function gitObjectTarget(input: {
  repoRoot: string;
  pathname: string;
  object: string;
  ranges: LineRange[];
  limits?: SnapshotLimits;
  signal?: AbortSignal;
}): Promise<SnapshotTarget> {
  const exclusion = defaultExclusionReason(input.pathname);
  if (exclusion) {
    return createNonTextTarget({
      path: input.pathname,
      version: `git:${input.object}`,
      disposition: "excluded",
      reason: exclusion,
    });
  }
  const maxTargetBytes = input.limits?.maxTargetBytes ?? 2 * 1024 * 1024;
  const sizeOutput = await runGit(input.repoRoot, ["cat-file", "-s", input.object], { maxStdoutBytes: 128, signal: input.signal });
  const size = Number(sizeOutput.toString("ascii").trim());
  if (!Number.isSafeInteger(size) || size < 0) throw new ReviewGitError("Git returned an invalid object size.");
  if (size > maxTargetBytes) {
    return createNonTextTarget({
      path: input.pathname,
      version: `git:${input.object}`,
      disposition: "blocked",
      reason: `Git blob exceeds the ${maxTargetBytes}-byte snapshot limit.`,
      byteLength: size,
    });
  }
  const bytes = await runGit(input.repoRoot, ["cat-file", "blob", input.object], { maxStdoutBytes: maxTargetBytes + 1, signal: input.signal });
  if (bytes.length !== size) throw new ReviewGitError("Git blob size changed during immutable object capture.");
  return snapshotTargetFromBuffer({ path: input.pathname, version: `git:${input.object}`, bytes, requiredRanges: input.ranges, maxBytes: maxTargetBytes });
}

function literalPathspec(pathname: string): string {
  // Literal magic prevents a filename beginning with pathspec syntax from
  // changing Git's selection semantics. Arguments remain argv elements.
  return `:(literal)${pathname}`;
}

async function patchForEntry(repoRoot: string, layer: "staged" | "worktree", entry: GitRawEntry, contextLines: number, signal?: AbortSignal): Promise<ReturnType<typeof parsePatchHunks>> {
  const paths = [entry.oldPath, entry.newPath].filter((pathname): pathname is string => Boolean(pathname));
  if (paths.length === 0) throw new ReviewGitError("Git diff entry has no path.");
  const args = ["diff", ...(layer === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", `--unified=${contextLines}`, "--find-renames", "--", ...[...new Set(paths)].map(literalPathspec)];
  return parsePatchHunks(await runGit(repoRoot, args, { signal }));
}

async function addDiffLayer(input: {
  repoRoot: string;
  layer: "staged" | "worktree";
  entries: GitRawEntry[];
  contextLines: number;
  limits: ResolvedSnapshotLimits;
  signal?: AbortSignal;
  accumulator: TargetAccumulator;
  changes: GitChange[];
  exclude?: PathExcluder;
}): Promise<void> {
  for (const entry of input.entries) {
    const paths = [...new Set([entry.oldPath, entry.newPath].filter((item): item is string => Boolean(item)))];
    const exclusions = await Promise.all(paths.map(async (pathname) => ({ pathname, reason: defaultExclusionReason(pathname) ?? await input.exclude?.(pathname) })));
    if (exclusions.some((item) => item.reason)) {
      for (const { pathname, reason } of exclusions) mergeTarget(input.accumulator, createNonTextTarget({
        path: pathname,
        version: `metadata:${sha256(`${pathname}\0${reason ?? "related side excluded"}`)}`,
        disposition: "excluded",
        reason: reason ?? "Related side of this Git change is excluded to avoid exposing its patch.",
      }));
      input.changes.push({ layer: input.layer, status: entry.status, oldPath: entry.oldPath, newPath: entry.newPath, oldRanges: [], newRanges: [] });
      continue;
    }
    const status = entry.status[0];
    if (!["A", "M", "D", "R", "C"].includes(status)) {
      const reason = `Unsupported or unmerged Git status ${entry.status}; content was not treated as reviewed.`;
      for (const pathname of paths) mergeTarget(input.accumulator, createNonTextTarget({ path: pathname, version: `metadata:${sha256(`${pathname}\0${reason}`)}`, disposition: "blocked", reason }));
      input.changes.push({ layer: input.layer, status: entry.status, oldPath: entry.oldPath, newPath: entry.newPath, oldRanges: [], newRanges: [] });
      continue;
    }
    const hunk = await patchForEntry(input.repoRoot, input.layer, entry, input.contextLines, input.signal);
    input.changes.push({ layer: input.layer, status: entry.status, oldPath: entry.oldPath, newPath: entry.newPath, oldRanges: hunk.oldRanges, newRanges: hunk.newRanges });
    const changedText = hunk.oldRanges.length > 0 || hunk.newRanges.length > 0;
    const binary = hunk.binary;
    if (binary) {
      const reason = "Git classified this change as binary; text coverage cannot be proven.";
      for (const pathname of paths) mergeTarget(input.accumulator, createNonTextTarget({ path: pathname, version: `metadata:${sha256(`${pathname}\0${reason}`)}`, disposition: "blocked", reason }));
      continue;
    }
    const needsOld = nonZeroObject(entry.oldObject) && (changedText || binary || status === "D");
    const needsNew = (input.layer === "staged" ? nonZeroObject(entry.newObject) : Boolean(entry.newPath)) && (changedText || binary || status === "A");

    if (needsOld && entry.oldPath) {
      const limits = effectiveSnapshotLimits(input.accumulator);
      mergeTarget(input.accumulator, await gitObjectTarget({
        repoRoot: input.repoRoot,
        pathname: entry.oldPath,
        object: entry.oldObject,
        ranges: hunk.oldRanges,
        limits,
        signal: input.signal,
      }));
    }
    if (needsNew && entry.newPath) {
      if (input.layer === "staged") {
        const limits = effectiveSnapshotLimits(input.accumulator);
        mergeTarget(input.accumulator, await gitObjectTarget({
          repoRoot: input.repoRoot,
          pathname: entry.newPath,
          object: entry.newObject,
          ranges: hunk.newRanges,
          limits,
          signal: input.signal,
        }));
      } else {
        const limits = effectiveSnapshotLimits(input.accumulator);
        mergeTarget(input.accumulator, await capturePathTarget({
          projectRoot: input.repoRoot,
          requestedPath: entry.newPath,
          requiredRanges: hunk.newRanges,
          limits,
        }));
      }
    }
    if (!changedText && status === "R") {
      if (entry.oldPath) mergeTarget(input.accumulator, createMetadataTarget(entry.oldPath, "Pure Git rename with no textual hunk."));
      if (entry.newPath && entry.newPath !== entry.oldPath) mergeTarget(input.accumulator, createMetadataTarget(entry.newPath, "Pure Git rename with no textual hunk."));
    } else if (!changedText && status === "M" && hunk.modeOnly) {
      for (const pathname of paths) mergeTarget(input.accumulator, createMetadataTarget(pathname, "Verified Git mode-only change has no textual hunk."));
    } else if (!changedText && status !== "A" && status !== "D") {
      const reason = `Git status ${entry.status} had no parseable text hunk; content was not treated as reviewed.`;
      for (const pathname of paths) mergeTarget(input.accumulator, createNonTextTarget({ path: pathname, version: `metadata:${sha256(`${pathname}\0${reason}`)}`, disposition: "blocked", reason }));
    }
    if (status === "D" && entry.oldPath) mergeTarget(input.accumulator, createMetadataTarget(entry.oldPath, "Deleted Git version has no new-side file."));
    if (status === "A" && entry.newPath && !needsNew) mergeTarget(input.accumulator, createMetadataTarget(entry.newPath, "Added Git version has no old-side file."));
  }
}

async function rawDiffOutput(repoRoot: string, layer: "staged" | "worktree", signal?: AbortSignal): Promise<Buffer> {
  const args = ["diff", ...(layer === "staged" ? ["--cached"] : []), "--raw", "-z", "--abbrev=64", "--no-ext-diff", "--no-textconv", "--find-renames", "--"];
  return await runGit(repoRoot, args, { signal });
}

async function readHeadObject(repoRoot: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    const head = (await runGit(repoRoot, ["rev-parse", "--verify", "HEAD"], { maxStdoutBytes: 128, signal })).toString("ascii").trim();
    if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new ReviewGitError("Git returned an invalid HEAD object ID.");
    return head;
  } catch (error) {
    if (!(error instanceof ReviewGitError) || /cancelled|timed out|exceeded/i.test(error.message)) throw error;
    // An unborn repository is valid: staged additions simply have no old side.
    return undefined;
  }
}

type GitInput = {
  headObject?: string;
  staged: GitRawEntry[];
  worktree: GitRawEntry[];
  untracked: string[];
  fingerprint: string;
};

/** Bind hunk mapping to a before/after Git input fingerprint rather than a moving worktree. */
async function enumerateGitInput(repoRoot: string, contextLines: number, signal?: AbortSignal, exclude?: PathExcluder): Promise<GitInput> {
  const [headObject, stagedRaw, worktreeRaw, untrackedOutput] = await Promise.all([
    readHeadObject(repoRoot, signal),
    rawDiffOutput(repoRoot, "staged", signal),
    rawDiffOutput(repoRoot, "worktree", signal),
    runGit(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"], { signal }),
  ]);
  const staged = parseRawDiff(stagedRaw);
  const worktree = parseRawDiff(worktreeRaw);
  const safeEntries = async (entries: GitRawEntry[]) => {
    const safe: GitRawEntry[] = [];
    for (const entry of entries) {
      const paths = [entry.oldPath, entry.newPath].filter((item): item is string => Boolean(item));
      const reasons = await Promise.all(paths.map((pathname) => defaultExclusionReason(pathname) ?? exclude?.(pathname)));
      if (!reasons.some(Boolean)) safe.push(entry);
    }
    return safe;
  };
  const patchFingerprint = async (layer: "staged" | "worktree", entries: GitRawEntry[]) => {
    const paths = [...new Set(entries.flatMap((entry) => [entry.oldPath, entry.newPath].filter((item): item is string => Boolean(item))))];
    if (!paths.length) return Buffer.alloc(0);
    const args = ["diff", ...(layer === "staged" ? ["--cached"] : []), "--no-ext-diff", "--no-textconv", `--unified=${contextLines}`, "--find-renames", "--", ...paths.map(literalPathspec)];
    return await runGit(repoRoot, args, { signal });
  };
  const [stagedPatch, worktreePatch] = await Promise.all([
    safeEntries(staged).then((entries) => patchFingerprint("staged", entries)),
    safeEntries(worktree).then((entries) => patchFingerprint("worktree", entries)),
  ]);
  const untracked = splitZero(untrackedOutput).filter((item) => item.length > 0).map(strictPath).sort();
  return {
    headObject, staged, worktree, untracked,
    fingerprint: sha256(Buffer.concat([
      Buffer.from(headObject ?? "unborn", "ascii"), Buffer.from([0]), stagedRaw, Buffer.from([0]), worktreeRaw,
      Buffer.from([0]), untrackedOutput, Buffer.from([0]), stagedPatch, Buffer.from([0]), worktreePatch,
    ])),
  };
}

/**
 * Freeze staged, worktree, and untracked Git changes. All old sides are Git
 * blobs; all current-file sides are copied into immutable snapshot targets.
 */
export async function captureGitTargets(input: { cwd: string } & GitCaptureOptions): Promise<GitCapture> {
  const contextLines = resolvedNumber(input.contextLines, DEFAULT_GIT_LIMITS.contextLines, "Git context lines");
  const limits = resolvedSnapshotLimits(input.limits);
  const rootOutput = await runGit(input.cwd, ["rev-parse", "--show-toplevel"], { maxStdoutBytes: 64 * 1024, signal: input.signal });
  const reportedRoot = rootOutput.toString("utf8").trim();
  if (!reportedRoot) throw new ReviewGitError("Git did not report a working-tree root.");
  const repoRoot = await realpath(reportedRoot);
  const requestedRoot = await realpath(input.cwd);
  if (requestedRoot !== repoRoot) throw new ReviewGitError("Git review must be started from the repository root; use /review paths from a subdirectory.");

  const captureBaseline = async (pathname: string): Promise<CurrentPathBaseline | undefined> => {
    const exclusion = defaultExclusionReason(pathname) ?? await input.exclude?.(pathname);
    if (exclusion) return undefined;
    const file = path.join(repoRoot, ...pathname.split("/"));
    try {
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink()) return { path: pathname, expected: "absent" };
      if (before.size > limits.maxTargetBytes) return undefined;
      const resolved = await realpath(file);
      const relative = path.relative(repoRoot, resolved);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new ReviewGitError(`Current-path baseline ${pathname} escapes the repository.`);
      const bytes = await readFile(resolved);
      const after = await lstat(resolved);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) throw new ReviewGitError(`Current-path baseline ${pathname} changed during capture.`);
      return { path: pathname, expected: "present", sha256: sha256(bytes), byteLength: bytes.length };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: pathname, expected: "absent" };
      throw error;
    }
  };

  for (let attempt = 0; attempt < DEFAULT_GIT_LIMITS.captureAttempts; attempt++) {
    const before = await enumerateGitInput(repoRoot, contextLines, input.signal, input.exclude);
    const accumulator: TargetAccumulator = { targets: new Map(), totalSnapshotBytes: 0, limits };
    const changes: GitChange[] = [];
    await addDiffLayer({ repoRoot, layer: "staged", entries: before.staged, contextLines, limits, signal: input.signal, accumulator, changes, exclude: input.exclude });
    await addDiffLayer({ repoRoot, layer: "worktree", entries: before.worktree, contextLines, limits, signal: input.signal, accumulator, changes, exclude: input.exclude });
    for (const pathname of before.untracked) {
      const target = await capturePathTarget({ projectRoot: repoRoot, requestedPath: pathname, limits: effectiveSnapshotLimits(accumulator), exclude: input.exclude });
      mergeTarget(accumulator, target);
      changes.push({ layer: "untracked", status: "A", newPath: pathname, oldRanges: [], newRanges: target.requiredRanges });
    }
    const baselinePaths = [...new Set(changes.flatMap((change) => change.newPath ? [change.newPath] : change.oldPath ? [change.oldPath] : []))].sort();
    const baselines: CurrentPathBaseline[] = [];
    let baselineBytes = 0;
    for (const pathname of baselinePaths) {
      const frozenCurrent = [...accumulator.targets.values()].find((target) => target.path === pathname
        && target.version.startsWith("sha256:") && typeof target.contentBase64 === "string");
      // Untracked names alone cannot detect content drift. Reuse the exact
      // current-side snapshot instead of silently taking a second baseline.
      const baseline: CurrentPathBaseline | undefined = frozenCurrent
        ? { path: pathname, expected: "present", sha256: frozenCurrent.sha256!, byteLength: frozenCurrent.byteLength! }
        : await captureBaseline(pathname);
      if (!baseline) continue;
      baselineBytes += baseline.expected === "present" ? baseline.byteLength : 0;
      if (baselineBytes > limits.maxTotalBytes) throw new ReviewGitError("Current-path baselines exceed the total snapshot byte limit.");
      baselines.push(baseline);
    }
    const after = await enumerateGitInput(repoRoot, contextLines, input.signal, input.exclude);
    if (before.fingerprint === after.fingerprint) {
      return {
        repoRoot,
        headObject: before.headObject,
        targets: [...accumulator.targets.values()].sort((left, right) => left.path.localeCompare(right.path) || left.version.localeCompare(right.version)),
        changes,
        baselines,
      };
    }
  }
  throw new ReviewGitError("Git source or index changed while freezing the review snapshot; retry the review.");
}

/** A content-addressed description for callers that need to detect a fresh Git enumeration. */
export function gitCaptureFingerprint(capture: GitCapture): string {
  return sha256(JSON.stringify({
    repoRoot: capture.repoRoot,
    headObject: capture.headObject,
    changes: capture.changes,
    targets: capture.targets.map((target) => ({ id: target.id, version: target.version, sha256: target.sha256, requiredRanges: target.requiredRanges })),
  }));
}
