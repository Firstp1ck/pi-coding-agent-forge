import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";

/** Domain separation for fingerprints owned by this package. */
export const STAGED_FINGERPRINT_DOMAIN = "firstpick/git-guided-workflow/staged-content/v1\0";
/** Default complete-input ceiling, retained as the direct commit threshold and branch/PR limit. */
export const GENERATION_INPUT_MAX_BYTES = 1024 * 1024;
export const COMMIT_MESSAGE_MAX_BYTES = 16 * 1024;
export const CONVENTIONAL_COMMIT_TYPES = Object.freeze([
  "build", "change", "chore", "ci", "docs", "feat", "fix", "perf", "refactor", "revert", "style", "test",
]);

const READ_TIMEOUT_MS = 10_000;
const TERMINATION_TIMEOUT_MS = 5_000;
const READ_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const RAW_FINGERPRINT_ARGS = [
  "-c", "core.quotepath=true",
  "-c", "diff.external=",
  "diff", "--cached", "--raw", "--full-index", "--no-abbrev", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--",
];
const STAGED_DIFF_ARGS = [
  "-c", "core.quotepath=true",
  "-c", "diff.external=",
  "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--",
];

export class GuidedGitError extends Error {
  code: string;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "GuidedGitError";
    this.code = code;
    this.details = details;
  }
}

export interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number | null;
  timedOut: boolean;
}

export interface GitRunOptions {
  timeoutMs?: number;
  terminationTimeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

export type GitRunner = (cwd: string, args: readonly string[], options?: GitRunOptions) => Promise<GitResult>;

/**
 * Run Git without a shell and refuse oversized output rather than truncating it.
 * Normal timeout/output-limit errors settle after `close` confirms the direct Git
 * child reached its terminal barrier. A bounded watchdog returns a distinct uncertain
 * error when that barrier is not observed. This does not claim descendant-tree termination.
 */
export const runGit: GitRunner = (cwd, args, options = {}) => new Promise((resolve, reject) => {
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS;
  const terminationTimeoutMs = options.terminationTimeoutMs ?? TERMINATION_TIMEOUT_MS;
  const maxStdoutBytes = options.maxStdoutBytes ?? READ_OUTPUT_MAX_BYTES;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const child = spawn("git", [...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let timedOut = false;
  let stopError: GuidedGitError | undefined;
  let terminationTimer: NodeJS.Timeout | undefined;
  const finish = (error?: Error, result?: GitResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(operationTimer);
    if (terminationTimer) clearTimeout(terminationTimer);
    if (error) reject(error);
    else resolve(result!);
  };
  const stop = (error: GuidedGitError) => {
    if (settled || stopError) return;
    stopError = error;
    clearTimeout(operationTimer);
    try { child.kill("SIGKILL"); } catch { /* the close barrier or watchdog decides */ }
    terminationTimer = setTimeout(() => finish(new GuidedGitError(
      "GIT_TERMINATION_UNCONFIRMED",
      "Git was asked to stop, but direct-child termination could not be confirmed; the command result is uncertain",
      { causeCode: error.code, terminationConfirmed: false, processId: child.pid },
    )), terminationTimeoutMs);
  };
  const operationTimer = setTimeout(() => {
    timedOut = true;
    stop(new GuidedGitError("GIT_TIMEOUT", `Git command timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => {
    if (stopError) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      stop(new GuidedGitError("GIT_OUTPUT_TOO_LARGE", `Git output exceeded the complete-input cap of ${maxStdoutBytes} bytes`, { capBytes: maxStdoutBytes }));
      return;
    }
    stdout.push(Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer) => {
    if (stopError) return;
    stderrBytes += chunk.length;
    if (stderrBytes > maxStderrBytes) {
      stop(new GuidedGitError("GIT_DIAGNOSTIC_TOO_LARGE", `Git diagnostic output exceeded ${maxStderrBytes} bytes`));
      return;
    }
    stderr.push(Buffer.from(chunk));
  });
  child.on("error", (error) => {
    if (!stopError) finish(new GuidedGitError("GIT_SPAWN_FAILED", sanitizeDiagnostic(error.message)));
  });
  child.on("close", (exitCode) => {
    if (stopError) {
      stopError.details = { ...stopError.details, terminationConfirmed: true, processId: child.pid, closeExitCode: exitCode };
      finish(stopError);
      return;
    }
    finish(undefined, {
      stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, timedOut,
    });
  });
});

function gitFailure(args: readonly string[], result: GitResult): GuidedGitError {
  const detail = sanitizeDiagnostic(result.stderr.length ? result.stderr.toString("utf8") : result.stdout.toString("utf8"));
  return new GuidedGitError("GIT_COMMAND_FAILED", detail || `git ${args[0] ?? "command"} failed with exit code ${result.exitCode ?? "unknown"}`);
}

async function requireGit(cwd: string, args: readonly string[], runner: GitRunner, options?: GitRunOptions): Promise<Buffer> {
  const result = await runner(cwd, args, options);
  if (result.exitCode !== 0 || result.timedOut) throw gitFailure(args, result);
  return result.stdout;
}

/** Remove terminal escape sequences and unsafe controls from untrusted display text. */
export function sanitizeDiagnostic(value: string | Buffer, maxChars = 4_000): string {
  let text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  text = text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, "")
    .replace(/\x1bP[\s\S]*?\x1b\\/gu, "")
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/gu, "")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, " ");
  return text.slice(0, Math.max(0, maxChars));
}

export interface StatusEntry {
  index: string;
  worktree: string;
  path: Buffer;
  originalPath?: Buffer;
  displayPath: string;
  conflicted: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface StatusSummary {
  entries: StatusEntry[];
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

/** Parse `git status --porcelain=v1 -z`; paths remain Buffers to avoid trusting or losing filename bytes. */
export function parsePorcelainStatus(raw: Buffer | string): StatusSummary {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const fields = bytes.length === 0 ? [] : bytes.subarray(0, bytes.at(-1) === 0 ? -1 : undefined).toString("latin1").split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const record = Buffer.from(fields[i]!, "latin1");
    if (record.length < 3 || record[2] !== 0x20) throw new GuidedGitError("INVALID_STATUS", "Git returned malformed porcelain status");
    const index = String.fromCharCode(record[0]!);
    const worktree = String.fromCharCode(record[1]!);
    const code = `${index}${worktree}`;
    const pathBytes = record.subarray(3);
    let originalPath: Buffer | undefined;
    if (index === "R" || index === "C") {
      i += 1;
      if (i >= fields.length) throw new GuidedGitError("INVALID_STATUS", "Git returned an incomplete rename record");
      originalPath = Buffer.from(fields[i]!, "latin1");
    }
    const conflicted = CONFLICT_CODES.has(code) || index === "U" || worktree === "U";
    const untracked = code === "??";
    const staged = !conflicted && !untracked && index !== " " && index !== "!";
    const unstaged = !conflicted && !untracked && worktree !== " " && worktree !== "!";
    entries.push({
      index, worktree, path: pathBytes, originalPath,
      displayPath: sanitizeDiagnostic(pathBytes.toString("utf8")).replace(/\n/gu, " "),
      conflicted, staged, unstaged, untracked,
    });
  }
  return {
    entries,
    staged: entries.filter((entry) => entry.staged).length,
    unstaged: entries.filter((entry) => entry.unstaged).length,
    untracked: entries.filter((entry) => entry.untracked).length,
    conflicted: entries.filter((entry) => entry.conflicted).length,
  };
}

export interface RepositoryState {
  root: string;
  gitDir: string;
  branch: string;
  headOid: string | null;
  status: StatusSummary;
}

const OPERATION_PATHS = Object.freeze([
  ["merge", "MERGE_HEAD"],
  ["rebase", "rebase-merge"],
  ["rebase", "rebase-apply"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
  ["revert", "REVERT_HEAD"],
  ["bisect", "BISECT_START"],
] as const);

async function exists(file: string): Promise<boolean> {
  try { await access(file); return true; } catch { return false; }
}

/** Resolve and validate a normal repository before staging or committing. */
export async function preflightRepository(cwd: string, runner: GitRunner = runGit): Promise<RepositoryState> {
  const probe = await runner(cwd, ["rev-parse", "--absolute-git-dir"]);
  if (probe.exitCode !== 0) throw new GuidedGitError("NOT_REPOSITORY", "Not inside a Git repository");
  const gitDir = path.resolve(probe.stdout.toString("utf8").trim());
  const bare = (await requireGit(cwd, ["rev-parse", "--is-bare-repository"], runner)).toString("utf8").trim();
  if (bare === "true") throw new GuidedGitError("BARE_REPOSITORY", "Bare repositories are not supported");
  const root = path.resolve((await requireGit(cwd, ["rev-parse", "--show-toplevel"], runner)).toString("utf8").trim());
  const branchResult = await runner(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branchResult.exitCode !== 0) throw new GuidedGitError("DETACHED_HEAD", "Detached HEAD is not supported");
  const branch = branchResult.stdout.toString("utf8").trim();
  if (!branch) throw new GuidedGitError("DETACHED_HEAD", "Detached HEAD is not supported");
  for (const [operation, marker] of OPERATION_PATHS) {
    const markerPath = (await requireGit(root, ["rev-parse", "--git-path", marker], runner)).toString("utf8").trim();
    if (await exists(path.resolve(root, markerPath))) {
      throw new GuidedGitError("OPERATION_IN_PROGRESS", `A Git ${operation} operation is in progress`, { operation });
    }
  }
  const status = parsePorcelainStatus(await requireGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], runner));
  if (status.conflicted > 0) throw new GuidedGitError("UNRESOLVED_CONFLICTS", "Resolve all conflicts before using this workflow");
  const headOid = await readHeadOid(root, runner);
  return { root, gitDir, branch, headOid, status };
}

/** Read HEAD after every commit outcome; an unborn repository has no HEAD OID. */
export async function readHeadOid(root: string, runner: GitRunner = runGit): Promise<string | null> {
  const result = await runner(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (result.exitCode === 1) return null;
  if (result.exitCode !== 0) throw gitFailure(["rev-parse", "--verify", "--quiet", "HEAD"], result);
  const oid = result.stdout.toString("ascii").trim();
  if (!/^[0-9a-f]{40,64}$/u.test(oid)) throw new GuidedGitError("INVALID_HEAD", "Git returned an invalid HEAD object ID");
  return oid;
}

export interface StagedFingerprint {
  fingerprint: string | null;
  hasStagedChanges: boolean;
  evidenceBytes: number;
}

/** Hash raw cached-diff evidence containing staged modes, object IDs, and path bytes. */
export async function readStagedFingerprint(root: string, runner: GitRunner = runGit): Promise<StagedFingerprint> {
  const evidence = await requireGit(root, RAW_FINGERPRINT_ARGS, runner, { maxStdoutBytes: READ_OUTPUT_MAX_BYTES });
  return {
    fingerprint: evidence.length === 0 ? null : createHash("sha256").update(STAGED_FINGERPRINT_DOMAIN).update(evidence).digest("hex"),
    hasStagedChanges: evidence.length > 0,
    evidenceBytes: evidence.length,
  };
}

export interface BoundStagedState {
  state: RepositoryState;
  fingerprint: string;
}

/** Capture status, root, branch, and HEAD between matching bounded staged fingerprints. */
export async function captureBoundStagedState(
  cwd: string,
  runner: GitRunner = runGit,
): Promise<BoundStagedState> {
  const initial = await preflightRepository(cwd, runner);
  const before = await readStagedFingerprint(initial.root, runner);
  if (!before.fingerprint) throw new GuidedGitError("NOTHING_STAGED", "No staged changes are available");
  const state = await preflightRepository(cwd, runner);
  if (state.root !== initial.root) throw new GuidedGitError("REPOSITORY_CHANGED", "The repository root changed while staged state was being captured");
  const after = await readStagedFingerprint(state.root, runner);
  if (before.fingerprint !== after.fingerprint) {
    throw new GuidedGitError("STAGED_STATE_CHANGED", "Staged changes changed while repository status was being captured");
  }
  return { state, fingerprint: before.fingerprint };
}

export interface StagedSnapshot {
  fingerprint: string;
  diff: Buffer;
  generationInput: string;
  byteLength: number;
}

/** Acquire fingerprint A → complete bounded diff → fingerprint B, accepting only a stable staged index. */
export async function acquireStableStagedSnapshot(
  root: string,
  options: { runner?: GitRunner; maxBytes?: number } = {},
): Promise<StagedSnapshot> {
  const runner = options.runner ?? runGit;
  const maxBytes = options.maxBytes ?? GENERATION_INPUT_MAX_BYTES;
  const before = await readStagedFingerprint(root, runner);
  if (!before.fingerprint) throw new GuidedGitError("NOTHING_STAGED", "No staged changes are available");
  let diff: Buffer;
  try {
    diff = await requireGit(root, STAGED_DIFF_ARGS, runner, { maxStdoutBytes: maxBytes });
  } catch (error) {
    if (error instanceof GuidedGitError && error.code === "GIT_OUTPUT_TOO_LARGE") {
      throw new GuidedGitError("GENERATION_INPUT_TOO_LARGE", `The complete staged diff exceeds the ${maxBytes}-byte generation cap; use a manual message`, { capBytes: maxBytes });
    }
    throw error;
  }
  const after = await readStagedFingerprint(root, runner);
  if (before.fingerprint !== after.fingerprint) throw new GuidedGitError("STAGED_STATE_CHANGED", "Staged changes changed while the snapshot was being read");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let generationInput: string;
  try { generationInput = decoder.decode(diff); }
  catch { throw new GuidedGitError("GENERATION_INPUT_ENCODING", "The staged diff is not valid UTF-8; use a manual message"); }
  return { fingerprint: before.fingerprint, diff, generationInput, byteLength: diff.length };
}

export interface CommandPlan { command: "git"; args: string[] }

export function planStageAll(): CommandPlan {
  return { command: "git", args: ["add", "--all", "--"] };
}

function validateRepositoryRelativePath(value: string): string {
  if (typeof value !== "string" || !value || path.isAbsolute(value) || value.startsWith("-")
    || value.split(/[\\/]/u).some((segment) => segment === "" || segment === "." || segment === "..")
    || /\x00|[\u0001-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new GuidedGitError("INVALID_REPOSITORY_PATH", "A repository-relative path is unsafe");
  }
  return value;
}

/** Plan staging for an explicit, non-empty set of repository-relative paths. */
export function planStagePaths(relativePaths: readonly string[]): CommandPlan {
  if (!Array.isArray(relativePaths) || relativePaths.length === 0) {
    throw new GuidedGitError("NO_STAGE_PATHS", "Select at least one path to stage");
  }
  const paths = relativePaths.map(validateRepositoryRelativePath);
  if (new Set(paths).size !== paths.length) throw new GuidedGitError("DUPLICATE_STAGE_PATH", "A path was selected more than once");
  return { command: "git", args: ["add", "--", ...paths] };
}

/** Read the complete configured remote-name list with bounded Git output. */
export async function readRemotes(root: string, runner: GitRunner = runGit): Promise<string[]> {
  const bytes = await requireGit(root, ["remote"], runner, { maxStdoutBytes: 64 * 1024 });
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new GuidedGitError("GIT_OUTPUT_ENCODING", "Git remote names are not valid UTF-8"); }
  const remotes = text.split(/\r?\n/u).filter(Boolean);
  if (remotes.some((remote) => remote.startsWith("-") || /\x00|[\u0001-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(remote))) {
    throw new GuidedGitError("INVALID_REMOTE", "Git returned an unsafe remote name");
  }
  return remotes;
}

function assertNoUnsafeControls(message: string): void {
  if (/\x1b|[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(message)) {
    throw new GuidedGitError("UNSAFE_COMMIT_MESSAGE", "Commit messages may contain newlines but no other control characters, bidirectional controls, or terminal escapes");
  }
}

function validateSubject(subject: string): void {
  if (!subject.trim()) throw new GuidedGitError("INVALID_COMMIT_SUBJECT", "The commit subject must not be empty");
}

/** Validate a manual message for safe, bounded Git input without enforcing style guidance. */
export function validateManualCommitMessage(message: string): string {
  if (typeof message !== "string") throw new GuidedGitError("INVALID_COMMIT_MESSAGE", "The commit message must be text");
  assertNoUnsafeControls(message);
  if (Buffer.byteLength(message, "utf8") > COMMIT_MESSAGE_MAX_BYTES) throw new GuidedGitError("COMMIT_MESSAGE_TOO_LARGE", `The commit message exceeds ${COMMIT_MESSAGE_MAX_BYTES} bytes`);
  if (!message.trim()) throw new GuidedGitError("INVALID_COMMIT_MESSAGE", "The commit message must not be empty");
  validateSubject(message.split("\n", 1)[0]!);
  return message;
}

export interface GeneratedMessages { short: string; long: string }

/** Parse bounded safe model text; framing and presentation are guidance only. */
export function parseGeneratedOutput(output: string): GeneratedMessages {
  if (typeof output !== "string") throw new GuidedGitError("INVALID_GENERATED_OUTPUT", "Generated output must be text");
  if (Buffer.byteLength(output, "utf8") > COMMIT_MESSAGE_MAX_BYTES * 2) {
    throw new GuidedGitError("INVALID_GENERATED_OUTPUT", "Generated output is oversized");
  }
  assertNoUnsafeControls(output);
  let normalized = output.trim();
  if (!normalized) throw new GuidedGitError("INVALID_GENERATED_OUTPUT", "Generated output must not be empty");

  const fenced = normalized.match(/^```[^\n]*\n([\s\S]*)\n```$/u);
  if (fenced) normalized = fenced[1]!.trim();
  const framed = normalized.match(/^<<<SHORT>>>\n([^\n]+)\n<<<LONG>>>\n([\s\S]+)\n<<<END>>>$/u);
  if (framed) {
    const short = framed[1]!;
    const long = framed[2]!;
    validateSubject(short);
    validateManualCommitMessage(long);
    return { short, long };
  }

  const presentationMarkers = new Set(["<<<SHORT>>>", "<<<LONG>>>", "<<<END>>>"]);
  const lines = normalized.split("\n").filter((line) => !presentationMarkers.has(line.trim()));
  const firstContent = lines.findIndex((line) => line.trim().length > 0);
  if (firstContent < 0) throw new GuidedGitError("INVALID_GENERATED_OUTPUT", "Generated output must not be empty");
  const short = lines[firstContent]!.trim();
  const long = lines.slice(firstContent).join("\n").trim();
  validateSubject(short);
  validateManualCommitMessage(long);
  return { short, long };
}

export function planCommit(message: string): CommandPlan {
  return { command: "git", args: ["commit", "-m", validateManualCommitMessage(message)] };
}

export interface CommitBinding {
  root: string;
  branch: string;
  headOid: string | null;
  fingerprint: string;
}

/** Revalidate root, branch, HEAD, operation state, and staged fingerprint before returning a commit plan. */
export async function prepareCommitPlan(
  cwd: string,
  binding: CommitBinding,
  message: string,
  runner: GitRunner = runGit,
): Promise<CommandPlan> {
  const state = await preflightRepository(cwd, runner);
  if (state.root !== path.resolve(binding.root)) throw new GuidedGitError("REPOSITORY_CHANGED", "The repository root changed before commit");
  if (state.branch !== binding.branch) throw new GuidedGitError("BRANCH_CHANGED", "The branch changed before commit");
  if (state.headOid !== binding.headOid) throw new GuidedGitError("HEAD_CHANGED", "HEAD changed before commit");
  const staged = await readStagedFingerprint(state.root, runner);
  if (!staged.fingerprint || staged.fingerprint !== binding.fingerprint) throw new GuidedGitError("STAGED_STATE_CHANGED", "Staged changes changed before commit");
  return planCommit(message);
}

export type CommitCommandOutcome = "success" | "failure" | "timeout";
export interface CommitHeadClassification {
  classification: "head-advanced" | "not-created" | "unexpected-result";
  commitOid: string | null;
  retrySafe: boolean;
}

/** Classify every commit result from the observed before/after HEAD, not the process status alone. */
export function classifyPostCommitHead(before: string | null, after: string | null, outcome: CommitCommandOutcome): CommitHeadClassification {
  if (after !== before && after !== null) return { classification: "head-advanced", commitOid: after, retrySafe: false };
  if (after === before && outcome !== "success") return { classification: "not-created", commitOid: null, retrySafe: true };
  return { classification: "unexpected-result", commitOid: null, retrySafe: false };
}

export interface PushDestination {
  remote: string;
  branch: string;
  refspec: string;
  source: "upstream" | "sole-remote" | "selected-remote";
}

export async function discoverPushDestination(
  root: string,
  options: { branch: string; createdCommitOid: string; currentHeadOid: string | null; selectedRemote?: string; runner?: GitRunner },
): Promise<PushDestination> {
  const runner = options.runner ?? runGit;
  if (!options.currentHeadOid || options.currentHeadOid !== options.createdCommitOid) throw new GuidedGitError("STALE_PUSH_HEAD", "HEAD no longer equals the commit created by this workflow");
  const actualBranchResult = await runner(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (actualBranchResult.exitCode !== 0) throw new GuidedGitError("DETACHED_HEAD", "Detached HEAD cannot be pushed by this workflow");
  const actualBranch = actualBranchResult.stdout.toString("utf8").trim();
  if (!actualBranch || actualBranch !== options.branch) throw new GuidedGitError("BRANCH_CHANGED", "The current branch changed before push");
  const actualHead = await readHeadOid(root, runner);
  if (!actualHead || actualHead !== options.currentHeadOid || actualHead !== options.createdCommitOid) {
    throw new GuidedGitError("STALE_PUSH_HEAD", "HEAD no longer equals the commit created by this workflow");
  }
  const branchCheck = await runner(root, ["check-ref-format", "--branch", options.branch]);
  if (branchCheck.exitCode !== 0) throw new GuidedGitError("INVALID_BRANCH", "The current branch cannot be pushed safely");
  const remoteResult = await runner(root, ["config", "--get", `branch.${options.branch}.remote`]);
  const mergeResult = await runner(root, ["config", "--get", `branch.${options.branch}.merge`]);
  const configuredRemote = remoteResult.exitCode === 0 ? remoteResult.stdout.toString("utf8").trim() : "";
  const configuredMerge = mergeResult.exitCode === 0 ? mergeResult.stdout.toString("utf8").trim() : "";
  const remotesText = (await requireGit(root, ["remote"], runner)).toString("utf8");
  const remotes = remotesText.split(/\r?\n/u).filter(Boolean);
  let remote: string;
  let source: PushDestination["source"];
  if (configuredRemote || configuredMerge) {
    if (!configuredRemote || configuredRemote === "." || configuredMerge !== `refs/heads/${options.branch}` || !remotes.includes(configuredRemote)) {
      throw new GuidedGitError("MISMATCHED_UPSTREAM", "The configured upstream does not match the current branch");
    }
    remote = configuredRemote;
    source = "upstream";
  } else if (remotes.length === 1) {
    remote = remotes[0]!;
    source = "sole-remote";
  } else if (remotes.length > 1 && options.selectedRemote && remotes.includes(options.selectedRemote)) {
    remote = options.selectedRemote;
    source = "selected-remote";
  } else if (remotes.length > 1) {
    throw new GuidedGitError("REMOTE_SELECTION_REQUIRED", "Select an explicit push remote");
  } else {
    throw new GuidedGitError("NO_PUSH_REMOTE", "No Git remote is configured");
  }
  return { remote, branch: options.branch, refspec: `${options.createdCommitOid}:refs/heads/${options.branch}`, source };
}

export function planPush(destination: PushDestination, createdCommitOid: string, currentHeadOid: string | null): CommandPlan {
  if (!currentHeadOid || currentHeadOid !== createdCommitOid) throw new GuidedGitError("STALE_PUSH_HEAD", "HEAD no longer equals the commit created by this workflow");
  if (!destination.remote || destination.remote.startsWith("-")) throw new GuidedGitError("INVALID_REMOTE", "The push remote is invalid");
  if (destination.refspec !== `${createdCommitOid}:refs/heads/${destination.branch}`) throw new GuidedGitError("INVALID_REFSPEC", "The push refspec must explicitly map the created commit to the current branch");
  const plan: CommandPlan = { command: "git", args: ["push", "--", destination.remote, destination.refspec] };
  if (plan.args.some((arg) => arg === "--force" || arg === "--force-with-lease" || arg.startsWith("--force="))) {
    throw new GuidedGitError("FORCE_PUSH_FORBIDDEN", "Force push is forbidden");
  }
  return plan;
}
