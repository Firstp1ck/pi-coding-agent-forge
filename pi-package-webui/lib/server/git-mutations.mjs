import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import path from "node:path";
import { classifyGitPathFailure, findWindowsReservedGitPath, windowsReservedGitPathFailure } from "../git-command-errors.mjs";
import { WORKTREE_ERROR_CODES, isGitLockFailure, listGitWorktrees, pathInside } from "../git-worktrees.mjs";
import { gitMessageArtifactPairReadiness, readStableGitMessageArtifactPair, sameGitMessageArtifactPair } from "../git-message-artifacts.mjs";

let activeGitWorkflowProcess = null;
const GIT_PULL_TIMEOUT_MS = 15 * 60 * 1000;
// Must remain byte-for-byte aligned with pi-extension-aur-review/src/git.ts.
const STAGED_CONTENT_HASH_DOMAIN = "firstpick/aur-review/staged-content/v1\0";
const STAGED_CONTENT_HASH_TIMEOUT_MS = 10_000;
const STAGED_CONTENT_HASH_OUTPUT_LIMIT = 4 * 1024 * 1024;
const STAGED_CONTENT_HASH_ARGS = [
  "-c", "core.quotepath=false",
  "-c", "diff.external=",
  "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--",
];
const GITIGNORE_MAX_BYTES = 5 * 1024 * 1024;
const gitignoreMutationQueues = new Map();
const GIT_LOCK_RETRY_ATTEMPTS = 3;
const GIT_LOCK_RETRY_DELAY_MS = 250;
const GIT_FETCH_TIMEOUT_MS = 2 * 60 * 1000;
const GIT_CONFLICT_PREVIEW_MAX_BYTES = 200_000;
const GIT_STASH_PATCH_MAX_OUTPUT = 200_000;
const PROTECTED_GIT_BRANCHES = new Set(["main", "master"]);
const NO_REMOTE_HINT = "No push destination is configured. Publish this repository or add a Git remote, then retry.";

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const GIT_BISECT_VERDICTS = new Set(["good", "bad", "old", "new", "skip", "reset"]);
const GIT_WORKFLOW_MESSAGE_PAIR_SETTLE_MS = 80;

function formatWorkflowCommand(command, args) {
  return [command, ...args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg))].join(" ");
}

export function formatGitCommand(args) {
  return formatWorkflowCommand("git", args);
}

export function createGitMutationService({
  runCommand,
  makeHttpError,
  makeUserFacingError,
  formatBytes,
  sanitizeError,
  formatCliError,
  formatCommandSpawnError,
  getGitRoot,
  runGitReadCommandDetailed,
  runGitReadCommand,
  readGitChanges,
  resolveGitRelativePath,
  normalizeGitRelativePath,
  isLikelyBinaryBuffer,
  parseGitPorcelainZEntries,
  gitBranchFromPorcelainStatus,
  summarizeGitPorcelainStatus,
  gitUpstreamRef,
}) {
  /**
   * Keep binary cached-diff bytes separate from runCommand's text buffering.
   * Decoding them would change the staged-content approval token.
   */
  function runGitStagedContentHashCommand(root) {
    return new Promise((resolve, reject) => {
      const child = spawn("git", STAGED_CONTENT_HASH_ARGS, {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C" },
      });
      const stdout = [];
      const stderr = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(result);
      };
      const stop = (message) => {
        try { child.kill("SIGKILL"); } catch { /* process already exited */ }
        finish(makeUserFacingError(message));
      };
      const timeout = setTimeout(() => stop(`git diff --cached timed out after ${STAGED_CONTENT_HASH_TIMEOUT_MS / 1000} seconds`), STAGED_CONTENT_HASH_TIMEOUT_MS);
      child.stdout.on("data", (chunk) => {
        const bytes = Buffer.from(chunk);
        stdoutBytes += bytes.length;
        if (stdoutBytes > STAGED_CONTENT_HASH_OUTPUT_LIMIT) {
          stop(`git diff --cached output exceeded the ${STAGED_CONTENT_HASH_OUTPUT_LIMIT / 1024 / 1024} MiB staged-content safety limit`);
          return;
        }
        stdout.push(bytes);
      });
      child.stderr.on("data", (chunk) => {
        const bytes = Buffer.from(chunk);
        stderrBytes += bytes.length;
        if (stderrBytes <= 64 * 1024) stderr.push(bytes);
      });
      child.on("error", (error) => finish(makeUserFacingError(formatCommandSpawnError("git", error))));
      child.on("close", (exitCode) => {
        if (exitCode !== 0) {
          const detail = Buffer.concat(stderr).toString("utf8").trim().slice(0, 1200);
          finish(makeUserFacingError(detail ? `git diff --cached failed: ${detail}` : `git diff --cached failed with exit code ${exitCode ?? "unknown"}`));
          return;
        }
        finish(null, Buffer.concat(stdout));
      });
    });
  }

  function stagedContentHashFromDiff(stagedDiff) {
    return createHash("sha256").update(STAGED_CONTENT_HASH_DOMAIN).update(stagedDiff).digest("hex");
  }

  async function readStagedContentHash(root) {
    // `git diff --cached` correctly compares the index to the empty tree when
    // HEAD is unborn, so no HEAD lookup is needed (or allowed) here.
    const stagedDiff = await runGitStagedContentHashCommand(root);
    return {
      stagedDiff,
      hasStagedChanges: stagedDiff.length > 0,
      stagedContentHash: stagedDiff.length > 0 ? stagedContentHashFromDiff(stagedDiff) : null,
    };
  }

  /** Read-only same-tab digest of the exact staged content git can commit. */
  async function stagedContentHashForTab(tab) {
    const root = await getGitRoot(tab.cwd);
    const staged = await readStagedContentHash(root);
    return { root, hasStagedChanges: staged.hasStagedChanges, stagedContentHash: staged.stagedContentHash };
  }

  function expectedStagedContentHashFromBody(body = {}) {
    const expected = body?.expectedStagedContentHash;
    if (expected === undefined) return ""; // Legacy Guided Git flow: no review was required.
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) {
      throw makeHttpError(400, "expectedStagedContentHash must be a SHA-256 hex digest");
    }
    return expected;
  }

  async function assertExpectedStagedContentHash(tab, body = {}) {
    const expected = expectedStagedContentHashFromBody(body);
    if (!expected) return "";
    const current = await stagedContentHashForTab(tab);
    if (!current.hasStagedChanges || current.stagedContentHash !== expected) {
      throw makeHttpError(409, "Staged content changed after manual approval. Return to Stage and request a new manual review before continuing.");
    }
    return expected;
  }


  function serializeGitignoreMutation(root, mutation) {
    const previous = gitignoreMutationQueues.get(root) || Promise.resolve();
    const current = previous.catch(() => {}).then(mutation);
    gitignoreMutationQueues.set(root, current);
    return current.finally(() => {
      if (gitignoreMutationQueues.get(root) === current) gitignoreMutationQueues.delete(root);
    });
  }

  function gitignoreEntryForTarget(root, requestedPath, kind) {
    if (kind !== "file" && kind !== "folder") throw makeHttpError(400, "Gitignore target kind must be file or folder");
    if (typeof requestedPath !== "string" || requestedPath.length === 0) throw makeHttpError(400, "Gitignore target path is required");
    if (/[\0-\x1f\x7f]/.test(requestedPath)) throw makeHttpError(400, "Gitignore target path cannot contain control characters");

    const slashPath = requestedPath.replace(/\\/g, "/");
    if (path.posix.isAbsolute(slashPath) || path.win32.isAbsolute(requestedPath) || /^[A-Za-z]:/.test(requestedPath)) {
      throw makeHttpError(400, "Gitignore target path must be repository-relative");
    }
    const segments = slashPath.split("/").filter(Boolean);
    if (!segments.length || segments.some((segment) => segment === "." || segment === "..")) {
      throw makeHttpError(400, "Gitignore target path cannot be the repository root or contain traversal segments");
    }

    const normalized = segments.join("/");
    const target = path.resolve(root, ...segments);
    const relative = path.relative(root, target);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw makeHttpError(400, "Gitignore target path must stay inside the repository");
    }
    const escaped = normalized.replace(/([*?\[\] ])/g, "\\$1");
    return { path: normalized, kind, entry: `/${escaped}${kind === "folder" ? "/" : ""}` };
  }

  function sameFileIdentity(first, second) {
    return first?.dev === second?.dev && first?.ino === second?.ino;
  }

  function gitignoreHasExactEntry(content, entry) {
    const existing = content.toString("latin1").split(/\r\n|\n|\r/);
    return existing.includes(Buffer.from(entry, "utf8").toString("latin1"));
  }

  async function appendGitignoreEntry(root, entry) {
    const target = path.join(root, ".gitignore");
    for (let attempt = 0; attempt < 2; attempt++) {
      let before;
      try {
        before = await lstat(target);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        before = null;
      }

      if (!before) {
        let handle;
        try {
          handle = await open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o666);
          await handle.writeFile(`${entry}\n`, "utf8");
          return true;
        } catch (error) {
          if (error?.code === "EEXIST" && attempt === 0) continue;
          throw error;
        } finally {
          await handle?.close();
        }
      }

      if (before.isSymbolicLink() || !before.isFile()) throw makeHttpError(409, "Repository .gitignore must be a regular file and cannot be a symbolic link");
      if (before.nlink !== 1) throw makeHttpError(409, "Repository .gitignore must have exactly one hard link; replace linked copies with a regular file before retrying");

      let handle;
      try {
        handle = await open(target, fsConstants.O_RDWR | fsConstants.O_APPEND | (fsConstants.O_NOFOLLOW || 0));
        const opened = await handle.stat();
        if (!opened.isFile() || !sameFileIdentity(before, opened)) throw makeHttpError(409, "Repository .gitignore changed while it was being opened");
        if (opened.nlink !== 1) throw makeHttpError(409, "Repository .gitignore must have exactly one hard link; replace linked copies with a regular file before retrying");
        if (opened.size > GITIGNORE_MAX_BYTES) throw makeHttpError(409, `Repository .gitignore exceeds the ${formatBytes(GITIGNORE_MAX_BYTES)} safe modification limit`);
        const content = await handle.readFile();
        if (gitignoreHasExactEntry(content, entry)) return false;
        const newline = content.includes(Buffer.from("\r\n")) ? "\r\n" : "\n";
        const lastByte = content.length ? content[content.length - 1] : null;
        const separator = content.length && lastByte !== 0x0a && lastByte !== 0x0d ? newline : "";
        await handle.writeFile(`${separator}${entry}${newline}`, "utf8");
        return true;
      } catch (error) {
        if (error?.code === "ENOENT" && attempt === 0) continue;
        if (error?.code === "ELOOP") throw makeHttpError(409, "Repository .gitignore cannot be a symbolic link");
        throw error;
      } finally {
        await handle?.close();
      }
    }
  }

  async function addGitignoreEntry(cwd, body = {}) {
    try {
      const root = await realpath(await getGitRoot(cwd));
      const target = gitignoreEntryForTarget(root, body.path, body.kind);
      const added = await serializeGitignoreMutation(root, () => appendGitignoreEntry(root, target.entry));
      return { root, ...target, added, changes: await readGitChanges(root) };
    } catch (error) {
      if (error?.statusCode) throw error;
      const wrapped = makeHttpError(500, formatCliError(error));
      if (error?.code) wrapped.code = error.code;
      throw wrapped;
    }
  }

  async function pullGitChanges(cwd, { remote } = {}) {
    const root = await getGitRoot(cwd);
    const pullArgs = ["pull", "--ff-only"];
    if (remote === "origin") pullArgs.push("origin");
    else if (remote) throw new Error(`Unsupported Git pull remote: ${String(remote)}`);
    const payload = await runGuardedGitMutation(pullArgs, { cwd: root, timeoutMs: GIT_PULL_TIMEOUT_MS });
    if (payload.data) payload.data.root = root;
    if (payload.ok) payload.data.changes = await readGitChanges(root);
    else {
      payload.error = (payload.data?.stderr || payload.data?.stdout || payload.error || "git pull --ff-only failed").trim();
      applyGitSyncFailure(payload);
    }
    return payload;
  }

  function requireConfirmed(body, action) {
    if (body?.confirmed !== true) throw makeHttpError(409, `${action} requires confirmed: true.`);
  }

  // Retry transient index.lock contention before reporting failure; the shared
  // isGitLockFailure classifier keeps this consistent with worktree mutations.
  async function runGitMutationCommand(args, options = {}) {
    let result;
    for (let attempt = 0; attempt < GIT_LOCK_RETRY_ATTEMPTS; attempt++) {
      result = await runGitWorkflowCommand(args, options);
      const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.error;
      if (ok || !isGitLockFailure(result)) return result;
      if (attempt < GIT_LOCK_RETRY_ATTEMPTS - 1) await sleepMs(GIT_LOCK_RETRY_DELAY_MS * (attempt + 1));
    }
    return result;
  }

  function gitMutationPayload(result) {
    const payload = gitWorkflowCommandPayload(result);
    if (!payload.ok) {
      let pathFailure = null;
      if (isGitLockFailure(result)) {
        payload.code = "REPO_BUSY";
        payload.hint = "Another git process is using this repository. Retry once it finishes.";
      } else {
        pathFailure = classifyGitPathFailure(result);
        if (pathFailure) Object.assign(payload, pathFailure);
      }
      payload.error = pathFailure?.error || String(result?.stderr || result?.stdout || payload.error || "git command failed").trim();
    }
    return payload;
  }

  async function gitAddAllPayload(cwd) {
    await getGitRoot(cwd);
    if (platform() === "win32") {
      const untrackedText = await runGitReadCommand(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--", "."]);
      const invalidPath = findWindowsReservedGitPath(untrackedText);
      const pathFailure = windowsReservedGitPathFailure(invalidPath);
      if (pathFailure) return { ok: false, ...pathFailure };
    }
    return gitMutationPayload(await runGitMutationCommand(["add", "."], { cwd }));
  }

  async function runGuardedGitMutation(args, options = {}) {
    try {
      return gitMutationPayload(await runGitMutationCommand(args, options));
    } catch (error) {
      if (/already running/i.test(error?.message || "")) {
        return { ok: false, code: "REPO_BUSY", error: sanitizeError(error), hint: "Another git workflow command is already running in the Web UI." };
      }
      throw error;
    }
  }

  // Turn raw git remote-operation stderr into an actionable state. Returns null
  // when no known pattern matches (caller keeps the raw error).
  function classifyGitSyncFailure(result, { push = false } = {}) {
    const text = `${result?.stderr || ""}\n${result?.stdout || ""}`.toLowerCase();
    if (result?.timedOut) return { code: "NETWORK", hint: "The remote did not respond before the timeout. Check connectivity and retry." };
    if (isGitLockFailure(result)) return { code: "REPO_BUSY", hint: "Another git process is using this repository. Retry once it finishes." };
    if (/terminal prompts disabled|authentication failed|permission denied|access denied|could not read username|could not read password|publickey|invalid credentials/.test(text)) {
      return { code: "AUTH", hint: "Authentication failed and interactive prompts are disabled in the Web UI. Refresh your credentials or SSH agent in a terminal, then retry." };
    }
    if (/could not resolve host|failed to connect|connection (?:refused|reset|timed out)|network is unreachable|operation timed out/.test(text)) {
      return { code: "NETWORK", hint: "The remote could not be reached. Check connectivity and retry." };
    }
    if (push && /fatal:\s+no configured push destination\./.test(text)) {
      return { code: "NO_REMOTE", hint: NO_REMOTE_HINT };
    }
    if (push && /protected branch|gh006/.test(text)) {
      return { code: "PROTECTED_BRANCH", hint: "The remote refused the push because the branch is protected. Push to a feature branch and open a PR instead." };
    }
    if (push && /\[rejected\]|non-fast-forward|fetch first|updates were rejected/.test(text)) {
      return { code: "NON_FAST_FORWARD", hint: "The remote has commits you don't have. Fetch and review the incoming diff, then integrate before pushing." };
    }
    if (push && /has no upstream branch/.test(text)) {
      return { code: "NO_UPSTREAM", hint: "The current branch has no upstream. Push with 'set upstream' to publish it." };
    }
    if (!push && /not possible to fast-forward|divergent branches|need to specify how to reconcile/.test(text)) {
      return { code: "DIVERGED", hint: "Local and remote branches have diverged. Fetch, review the incoming diff, then merge or rebase explicitly — or integrate in a worktree." };
    }
    if (!push && /no tracking information/.test(text)) {
      return { code: "NO_UPSTREAM", hint: "The current branch has no upstream to pull from. Set one or pull with an explicit remote/branch." };
    }
    if (/would be overwritten/.test(text)) {
      return { code: "DIRTY_WORKTREE", hint: "Local changes would be overwritten. Stash or commit them first." };
    }
    if (/conflict/.test(text)) {
      return { code: "CONFLICTS", hint: "Conflicts were created. Resolve them in the conflicts panel, then continue or abort the operation." };
    }
    return null;
  }

  function applyGitSyncFailure(payload, { push = false } = {}) {
    if (payload.ok || payload.code) return payload;
    const classified = classifyGitSyncFailure(payload.data, { push });
    if (classified) {
      payload.code = classified.code;
      payload.hint = classified.hint;
    }
    return payload;
  }

  async function fetchGitChanges(cwd) {
    const root = await getGitRoot(cwd);
    const payload = await runGuardedGitMutation(
      ["-c", "credential.interactive=false", "fetch", "--prune"],
      { cwd: root, timeoutMs: GIT_FETCH_TIMEOUT_MS, label: "git fetch --prune" },
    );
    if (payload.data) payload.data.root = root;
    if (payload.ok) {
      // git fetch reports ref updates on stderr.
      payload.data.summary = `${payload.data.stderr || ""}\n${payload.data.stdout || ""}`.trim();
      payload.data.changes = await readGitChanges(root);
    } else {
      applyGitSyncFailure(payload);
    }
    return payload;
  }

  async function integrateGitUpstream(cwd, body = {}) {
    const mode = String(body.mode || "").trim();
    if (!["merge", "rebase"].includes(mode)) throw makeHttpError(400, "mode must be 'merge' or 'rebase'");
    requireConfirmed(body, `Running git ${mode} against the upstream`);
    const root = await getGitRoot(cwd);
    const upstream = await gitUpstreamRef(root);
    if (!upstream) throw makeHttpError(409, "No upstream is configured for the current branch");
    const args = mode === "merge" ? ["merge", "--no-edit", "@{upstream}"] : ["-c", "core.editor=true", "rebase", "@{upstream}"];
    const payload = await runGuardedGitMutation(args, { cwd: root, timeoutMs: GIT_PULL_TIMEOUT_MS, label: `git ${mode} ${upstream}` });
    if (payload.data) {
      payload.data.root = root;
      payload.data.upstream = upstream;
      payload.data.mode = mode;
    }
    if (payload.ok) payload.data.changes = await readGitChanges(root);
    else applyGitSyncFailure(payload);
    return payload;
  }

  // ---- Git operation (merge/rebase/cherry-pick/revert/bisect) lifecycle ----

  async function pathEntryExists(target) {
    try {
      await stat(target);
      return true;
    } catch {
      return false;
    }
  }

  async function gitDirPath(root) {
    const out = await runGitReadCommand(root, ["rev-parse", "--git-dir"], { maxOutputLength: 10_000 });
    const dir = out.trim();
    return path.isAbsolute(dir) ? dir : path.resolve(root, dir);
  }

  async function detectGitOperationKind(root) {
    const gitDir = await gitDirPath(root);
    if ((await pathEntryExists(path.join(gitDir, "rebase-merge"))) || (await pathEntryExists(path.join(gitDir, "rebase-apply")))) return "rebase";
    if (await pathEntryExists(path.join(gitDir, "MERGE_HEAD"))) return "merge";
    if (await pathEntryExists(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
    if (await pathEntryExists(path.join(gitDir, "REVERT_HEAD"))) return "revert";
    if (await pathEntryExists(path.join(gitDir, "BISECT_LOG"))) return "bisect";
    return null;
  }

  function gitOperationCommands(kind) {
    switch (kind) {
      case "merge":
        return { continue: ["commit", "--no-edit"], abort: ["merge", "--abort"], skip: null };
      case "rebase":
        return { continue: ["-c", "core.editor=true", "rebase", "--continue"], abort: ["rebase", "--abort"], skip: ["-c", "core.editor=true", "rebase", "--skip"] };
      case "cherry-pick":
        return { continue: ["-c", "core.editor=true", "cherry-pick", "--continue"], abort: ["cherry-pick", "--abort"], skip: ["-c", "core.editor=true", "cherry-pick", "--skip"] };
      case "revert":
        return { continue: ["-c", "core.editor=true", "revert", "--continue"], abort: ["revert", "--abort"], skip: ["-c", "core.editor=true", "revert", "--skip"] };
      default:
        return null;
    }
  }

  function parseGitConflictEntries(porcelainText) {
    const entries = [];
    for (const line of String(porcelainText || "").split(/\r?\n/)) {
      if (!line.startsWith("u ")) continue;
      // u XY sub m1 m2 m3 mW h1 h2 h3 path — 10 space-separated fields, then path.
      const fields = [];
      let start = 0;
      for (let index = 0; index < 10; index++) {
        const next = line.indexOf(" ", start);
        if (next === -1) break;
        fields.push(line.slice(start, next));
        start = next + 1;
      }
      fields.push(line.slice(start));
      const entryPath = fields[10] || "";
      if (entryPath) entries.push({ path: entryPath, status: fields[1] || "UU" });
    }
    return entries;
  }

  function extractConflictMarkerHunks(content, { contextLines = 2, maxHunks = 8, maxLinesPerHunk = 80 } = {}) {
    const lines = content.split(/\r?\n/);
    const hunks = [];
    for (let index = 0; index < lines.length && hunks.length < maxHunks; index++) {
      if (!lines[index].startsWith("<<<<<<<")) continue;
      let end = index;
      while (end < lines.length - 1 && !lines[end].startsWith(">>>>>>>")) end++;
      const start = Math.max(0, index - contextLines);
      const stop = Math.min(lines.length - 1, end + contextLines);
      hunks.push({
        startLine: start + 1,
        truncated: stop - start + 1 > maxLinesPerHunk,
        lines: lines.slice(start, Math.min(stop + 1, start + maxLinesPerHunk)),
      });
      index = end;
    }
    return hunks;
  }

  async function readGitConflictPreview(root, relPath) {
    try {
      const filePath = resolveGitRelativePath(root, relPath);
      const info = await stat(filePath).catch(() => null);
      if (!info) return { kind: "missing" };
      if (!info.isFile()) return { kind: "unsupported", size: info.size };
      if (info.size > GIT_CONFLICT_PREVIEW_MAX_BYTES) return { kind: "large", size: info.size };
      const buffer = await readFile(filePath);
      if (isLikelyBinaryBuffer(buffer)) return { kind: "binary", size: info.size };
      const content = buffer.toString("utf8");
      return {
        kind: "text",
        size: info.size,
        hasMarkers: /^<{7}(?: |$)/m.test(content),
        hunks: extractConflictMarkerHunks(content),
      };
    } catch (error) {
      return { kind: "error", error: sanitizeError(error) };
    }
  }

  async function readGitOperationSnapshot(cwd) {
    const root = await getGitRoot(cwd);
    const porcelainText = await runGitReadCommand(root, ["status", "--porcelain=2", "--branch", "--untracked-files=all"], { maxOutputLength: 120_000 });
    const summary = summarizeGitPorcelainStatus(porcelainText);
    const kind = await detectGitOperationKind(root);
    const conflictEntries = parseGitConflictEntries(porcelainText);
    const conflicts = [];
    for (const entry of conflictEntries) {
      conflicts.push({ ...entry, preview: await readGitConflictPreview(root, entry.path) });
    }
    const commands = gitOperationCommands(kind);
    let bisect = null;
    if (kind === "bisect") {
      const log = await runGitReadCommand(root, ["bisect", "log"], { maxOutputLength: 60_000 }).catch(() => "");
      bisect = { log: log.trimEnd().split(/\r?\n/).slice(-20).join("\n") };
    }
    return {
      root,
      branch: gitBranchFromPorcelainStatus(porcelainText),
      operation: kind,
      summary,
      conflicts,
      canContinue: Boolean(kind) && kind !== "bisect" && conflictEntries.length === 0,
      canSkip: Boolean(commands?.skip),
      commands: commands
        ? {
            continue: formatGitCommand(commands.continue.filter((arg) => arg !== "-c" && arg !== "core.editor=true")),
            abort: formatGitCommand(commands.abort),
            ...(commands.skip ? { skip: formatGitCommand(commands.skip.filter((arg) => arg !== "-c" && arg !== "core.editor=true")) } : {}),
          }
        : null,
      bisect,
      generatedAt: new Date().toISOString(),
    };
  }

  async function gitOperationStageFile(cwd, body = {}) {
    const root = await getGitRoot(cwd);
    const kind = await detectGitOperationKind(root);
    if (!kind) throw makeHttpError(409, "No git operation is in progress");
    const rel = normalizeGitRelativePath(root, body.path);
    const payload = await runGuardedGitMutation(["add", "--", rel], { cwd: root, label: `git add -- ${rel}` });
    if (payload.data) payload.data.root = root;
    if (payload.ok) payload.data.operation = await readGitOperationSnapshot(root);
    return payload;
  }

  async function gitOperationAction(cwd, action, body = {}) {
    const root = await getGitRoot(cwd);
    const kind = await detectGitOperationKind(root);
    if (!kind) throw makeHttpError(409, "No git operation is in progress");
    if (kind === "bisect") throw makeHttpError(409, "Bisect is controlled through /api/git-operation/bisect");
    const commands = gitOperationCommands(kind);

    let args;
    if (action === "continue") {
      const porcelainText = await runGitReadCommand(root, ["status", "--porcelain=2"], { maxOutputLength: 120_000 });
      if (parseGitConflictEntries(porcelainText).length > 0) {
        return { ok: false, code: "UNMERGED_PATHS", error: "Unmerged paths remain. Resolve and stage every conflicted file before continuing." };
      }
      args = commands.continue;
    } else if (action === "skip") {
      if (!commands.skip) throw makeHttpError(409, `git ${kind} does not support skip`);
      args = commands.skip;
    } else if (action === "abort") {
      requireConfirmed(body, `Aborting the ${kind} operation discards its in-progress state and`);
      args = commands.abort;
    } else {
      throw makeHttpError(400, "Unknown git operation action");
    }

    const payload = await runGuardedGitMutation(args, { cwd: root, timeoutMs: GIT_PULL_TIMEOUT_MS });
    if (payload.data) {
      payload.data.root = root;
      payload.data.kind = kind;
    }
    if (payload.ok) payload.data.operation = await readGitOperationSnapshot(root);
    else applyGitSyncFailure(payload);
    return payload;
  }


  async function gitBisectAction(cwd, body = {}) {
    const verdict = String(body.verdict || "").trim().toLowerCase();
    if (!GIT_BISECT_VERDICTS.has(verdict)) throw makeHttpError(400, "verdict must be one of good, bad, old, new, skip, reset");
    const root = await getGitRoot(cwd);
    const kind = await detectGitOperationKind(root);
    if (kind !== "bisect") throw makeHttpError(409, "No git bisect is in progress");
    if (verdict === "reset") requireConfirmed(body, "Resetting the bisect session");
    const payload = await runGuardedGitMutation(["bisect", verdict], { cwd: root });
    if (payload.data) payload.data.root = root;
    if (payload.ok) payload.data.operation = await readGitOperationSnapshot(root);
    return payload;
  }

  // ---- Stash ----

  function cleanGitStashRef(value) {
    const ref = String(value || "").trim();
    if (!/^stash@\{\d{1,4}\}$/.test(ref)) throw makeHttpError(400, "stash ref must look like stash@{0}");
    return ref;
  }

  async function readGitStashes(cwd) {
    const root = await getGitRoot(cwd);
    const out = await runGitReadCommand(root, ["stash", "list", "--format=%gd%x09%at%x09%gs"], { maxOutputLength: 120_000 });
    const stashes = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [ref, epoch, ...subject] = line.split("\t");
        return { ref: ref || "", epochSeconds: Number.parseInt(epoch || "0", 10) || 0, subject: subject.join("\t") };
      })
      .filter((entry) => entry.ref);
    return { root, stashes, generatedAt: new Date().toISOString() };
  }

  async function readGitStashPreview(cwd, requestedRef) {
    const root = await getGitRoot(cwd);
    const ref = cleanGitStashRef(requestedRef);
    const [statText, patchText] = await Promise.all([
      runGitReadCommand(root, ["stash", "show", "--include-untracked", "--stat", ref], { maxOutputLength: 120_000 }).catch((error) => `(${sanitizeError(error)})`),
      runGitReadCommand(root, ["stash", "show", "--include-untracked", "-p", ref], { maxOutputLength: GIT_STASH_PATCH_MAX_OUTPUT }).catch(() => ""),
    ]);
    return { root, ref, stat: statText.trimEnd(), patch: patchText.trimEnd() };
  }

  async function saveGitStash(cwd, body = {}) {
    const root = await getGitRoot(cwd);
    const args = ["stash", "push"];
    if (body.includeUntracked === true) args.push("--include-untracked");
    if (body.message) args.push("-m", cleanGitCommitMessageInput(body.message));
    const payload = await runGuardedGitMutation(args, { cwd: root });
    if (payload.data) payload.data.root = root;
    if (payload.ok) payload.data.stashes = (await readGitStashes(root)).stashes;
    return payload;
  }

  async function applyGitStash(cwd, body = {}, { pop = false } = {}) {
    const root = await getGitRoot(cwd);
    const ref = cleanGitStashRef(body.ref);
    const payload = await runGuardedGitMutation(["stash", pop ? "pop" : "apply", ref], { cwd: root });
    if (payload.data) {
      payload.data.root = root;
      payload.data.ref = ref;
    }
    if (payload.ok) payload.data.stashes = (await readGitStashes(root)).stashes;
    else if (!payload.code && /conflict/i.test(payload.error || "")) {
      payload.code = "CONFLICTS";
      payload.hint = pop
        ? "The stash conflicts with the working tree; git kept the stash entry. Resolve the conflicts, then drop the stash manually."
        : "The stash conflicts with the working tree. Resolve the conflicts or reset the working tree.";
    }
    return payload;
  }

  async function dropGitStash(cwd, body = {}) {
    requireConfirmed(body, "Dropping a stash permanently deletes it and");
    const root = await getGitRoot(cwd);
    const ref = cleanGitStashRef(body.ref);
    const payload = await runGuardedGitMutation(["stash", "drop", ref], { cwd: root });
    if (payload.data) {
      payload.data.root = root;
      payload.data.ref = ref;
    }
    if (payload.ok) payload.data.stashes = (await readGitStashes(root)).stashes;
    return payload;
  }

  // ---- File-level staging ----

  async function stageGitFile(cwd, body = {}) {
    const root = await getGitRoot(cwd);
    const rel = normalizeGitRelativePath(root, body.path);
    const payload = await runGuardedGitMutation(["add", "--", rel], { cwd: root, label: `git add -- ${rel}` });
    if (payload.data) payload.data.root = root;
    if (payload.ok) payload.data.changes = await readGitChanges(root);
    return payload;
  }

  async function unstageGitFile(cwd, body = {}) {
    const root = await getGitRoot(cwd);
    const rel = normalizeGitRelativePath(root, body.path);
    let payload = await runGuardedGitMutation(["restore", "--staged", "--", rel], { cwd: root, label: `git restore --staged -- ${rel}` });
    if (!payload.ok && /HEAD/.test(payload.error || "")) {
      // Unborn branch (no commit yet): restore --staged has no HEAD to restore from.
      payload = await runGuardedGitMutation(["rm", "--cached", "-r", "--", rel], { cwd: root, label: `git rm --cached -- ${rel}` });
    }
    if (payload.data) payload.data.root = root;
    if (payload.ok) payload.data.changes = await readGitChanges(root);
    return payload;
  }

  async function stageAllGitChanges(cwd) {
    const root = await getGitRoot(cwd);
    const payload = await gitAddAllPayload(root);
    if (payload.data) payload.data.root = root;
    return payload;
  }

  async function unstageAllGitChanges(cwd) {
    const root = await getGitRoot(cwd);
    let payload = await runGuardedGitMutation(["restore", "--staged", "--", "."], { cwd: root, label: "git restore --staged -- ." });
    if (!payload.ok && /HEAD/.test(payload.error || "")) {
      payload = await runGuardedGitMutation(["rm", "--cached", "-r", "--", "."], { cwd: root, label: "git rm --cached -r -- ." });
    }
    if (payload.data) payload.data.root = root;
    return payload;
  }

  async function discardGitFile(cwd, body = {}) {
    requireConfirmed(body, "Discarding file changes is destructive and");
    const root = await getGitRoot(cwd);
    const rel = normalizeGitRelativePath(root, body.path);
    const payload = await runGuardedGitMutation(["restore", "--", rel], { cwd: root, label: `git restore -- ${rel}` });
    if (payload.data) payload.data.root = root;
    if (payload.ok) payload.data.changes = await readGitChanges(root);
    return payload;
  }

  async function deleteGitUntrackedFile(cwd, body = {}) {
    requireConfirmed(body, "Deleting an untracked file is destructive and");
    const root = await getGitRoot(cwd);
    const rel = normalizeGitRelativePath(root, body.path);
    const listed = await runGitReadCommand(root, ["ls-files", "--others", "--exclude-standard", "--", rel], { maxOutputLength: 120_000 });
    const files = listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!files.includes(rel)) throw makeHttpError(409, `Not an untracked file: ${rel}`);
    await rm(resolveGitRelativePath(root, rel));
    return { ok: true, data: { root, path: rel, deleted: true, changes: await readGitChanges(root) } };
  }

  // ---- Undo / recovery ----

  async function readGitUndoState(cwd) {
    const root = await getGitRoot(cwd);
    const [parentProbe, porcelainText, upstream, operation, lastLog] = await Promise.all([
      runCommand("git", ["rev-parse", "--verify", "--quiet", "HEAD~1"], { cwd: root, timeoutMs: 2000 }),
      runGitReadCommand(root, ["status", "--porcelain=2", "--branch"], { maxOutputLength: 120_000 }),
      gitUpstreamRef(root),
      detectGitOperationKind(root),
      runGitReadCommand(root, ["log", "-1", "--format=%h%x09%s"], { maxOutputLength: 10_000 }).catch(() => ""),
    ]);
    const summary = summarizeGitPorcelainStatus(porcelainText);
    const hasParent = parentProbe.exitCode === 0;
    const [lastHash = "", ...subjectParts] = lastLog.trim().split("\t");
    const lastSubject = subjectParts.join("\t");
    // With an upstream, "unpushed" means ahead > 0; without one nothing has been
    // published through this branch's tracking ref.
    const unpushed = upstream ? summary.ahead > 0 : true;
    return {
      root,
      hasParent,
      upstream,
      operation,
      summary,
      lastCommit: lastHash ? { hash: lastHash, subject: lastSubject } : null,
      canUndoLastCommit: hasParent && unpushed && !operation,
      canAmendMessage: Boolean(lastHash) && unpushed && !operation && summary.staged === 0,
    };
  }

  async function undoLastGitCommit(cwd, body = {}) {
    requireConfirmed(body, "Undoing the last commit rewrites HEAD and");
    const state = await readGitUndoState(cwd);
    if (!state.hasParent) throw makeHttpError(409, "HEAD has no parent commit to undo to");
    if (state.operation) throw makeHttpError(409, `Cannot undo during a ${state.operation} operation`);
    if (!state.canUndoLastCommit) throw makeHttpError(409, "The last commit is already pushed to the upstream; undoing it would rewrite published history");
    const payload = await runGuardedGitMutation(["reset", "--soft", "HEAD~1"], { cwd: state.root });
    if (payload.data) {
      payload.data.root = state.root;
      payload.data.undoneCommit = state.lastCommit;
      payload.data.restoreCommand = "git reset --soft ORIG_HEAD";
    }
    if (payload.ok) payload.data.changes = await readGitChanges(state.root);
    return payload;
  }

  async function amendLastGitCommitMessage(cwd, body = {}) {
    requireConfirmed(body, "Amending the last commit rewrites HEAD and");
    const message = cleanGitCommitMessageInput(body.message);
    const state = await readGitUndoState(cwd);
    if (!state.lastCommit) throw makeHttpError(409, "There is no commit to amend");
    if (state.operation) throw makeHttpError(409, `Cannot amend during a ${state.operation} operation`);
    if (state.summary.staged > 0) throw makeHttpError(409, "Staged changes present; amending now would silently add them to the last commit. Unstage or commit them first.");
    if (!state.canAmendMessage) throw makeHttpError(409, "The last commit is already pushed to the upstream; amending it would rewrite published history");
    const payload = await runGuardedGitMutation(["commit", "--amend", "-m", message], { cwd: state.root, label: "git commit --amend -m <message>" });
    if (payload.data) {
      payload.data.root = state.root;
      payload.data.previousCommit = state.lastCommit;
      payload.data.restoreCommand = "git reset --soft ORIG_HEAD";
    }
    return payload;
  }

  async function readGitReflog(cwd) {
    const root = await getGitRoot(cwd);
    const out = await runGitReadCommand(root, ["reflog", "-n", "20", "--format=%h%x09%gd%x09%cI%x09%gs"], { maxOutputLength: 120_000 });
    const entries = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, selector, date, ...subject] = line.split("\t");
        return { hash: hash || "", selector: selector || "", date: date || "", subject: subject.join("\t") };
      });
    return { root, entries, generatedAt: new Date().toISOString() };
  }

  // ---- Submodules ----

  async function readGitSubmodules(cwd) {
    const root = await getGitRoot(cwd);
    if (!(await regularFileExists(path.join(root, ".gitmodules")))) {
      return { root, hasSubmodules: false, submodules: [], dirty: 0 };
    }
    const out = await runGitReadCommand(root, ["submodule", "status", "--recursive"], { timeoutMs: 30_000, maxOutputLength: 200_000 });
    const submodules = out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const flag = line[0] || " ";
        const rest = line.slice(1).trim();
        const firstSpace = rest.indexOf(" ");
        const sha = firstSpace === -1 ? rest : rest.slice(0, firstSpace);
        const remainder = firstSpace === -1 ? "" : rest.slice(firstSpace + 1);
        const describeMatch = remainder.match(/^(.*?)( \([^)]*\))?$/);
        return {
          sha,
          path: (describeMatch?.[1] ?? remainder).trim(),
          describe: describeMatch?.[2] ? describeMatch[2].trim().replace(/^\(|\)$/g, "") : "",
          state: flag === "-" ? "uninitialized" : flag === "+" ? "out-of-sync" : flag === "U" ? "conflicts" : "clean",
        };
      });
    return { root, hasSubmodules: true, submodules, dirty: submodules.filter((item) => item.state !== "clean").length };
  }

  async function updateGitSubmodules(cwd, body = {}) {
    requireConfirmed(body, "Recursively updating submodules can check out new commits and");
    const root = await getGitRoot(cwd);
    const payload = await runGuardedGitMutation(["submodule", "update", "--init", "--recursive"], { cwd: root, timeoutMs: GIT_PULL_TIMEOUT_MS });
    if (payload.data) payload.data.root = root;
    if (payload.ok) payload.data.submodules = (await readGitSubmodules(root)).submodules;
    return payload;
  }

  // ---- Tags ----

  function cleanGitTagName(value) {
    const name = String(value || "").trim();
    if (!name || name.includes("\0") || name.includes("@{") || name.startsWith("-") || name.startsWith("/") || /\s/.test(name)) {
      throw makeHttpError(400, "Invalid tag name");
    }
    return name;
  }

  async function validateGitTagName(root, name) {
    const result = await runCommand("git", ["check-ref-format", `refs/tags/${name}`], { cwd: root, timeoutMs: 5000 });
    if (result.exitCode !== 0) throw makeHttpError(400, `Invalid tag name: ${name}`);
  }

  async function readGitTags(cwd) {
    const root = await getGitRoot(cwd);
    const [headOut, recentOut] = await Promise.all([
      runGitReadCommand(root, ["tag", "--points-at", "HEAD", "--sort=-creatordate"], { maxOutputLength: 60_000 }).catch(() => ""),
      runGitReadCommand(
        root,
        ["for-each-ref", "refs/tags", "--sort=-creatordate", "--count=30", "--format=%(refname:short)%09%(objecttype)%09%(objectname:short)%09%(*objectname:short)%09%(creatordate:iso8601)%09%(subject)"],
        { maxOutputLength: 120_000 },
      ).catch(() => ""),
    ]);
    const headTags = headOut.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const tags = recentOut
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, objectType, objectName, target, date, ...subject] = line.split("\t");
        return {
          name: name || "",
          annotated: objectType === "tag",
          target: (objectType === "tag" ? target : objectName) || "",
          date: date || "",
          subject: subject.join("\t"),
          atHead: headTags.includes(name || ""),
        };
      });
    return { root, headTags, tags, generatedAt: new Date().toISOString() };
  }

  async function createGitTag(cwd, body = {}) {
    requireConfirmed(body, "Creating a tag");
    const root = await getGitRoot(cwd);
    const name = cleanGitTagName(body.name);
    await validateGitTagName(root, name);
    const message = cleanGitCommitMessageInput(body.message || name);
    const payload = await runGuardedGitMutation(["tag", "-a", name, "-m", message], { cwd: root, label: `git tag -a ${name} -m <message>` });
    if (payload.data) {
      payload.data.root = root;
      payload.data.tag = name;
      // Tags never leave the machine implicitly; pushing stays a separate,
      // explicit action.
      payload.data.pushCommand = `git push ${"origin"} ${name}`;
    }
    if (payload.ok) payload.data.tags = (await readGitTags(root)).tags;
    return payload;
  }

  // ---- Signing diagnostics ----

  async function readGitSigningDiagnostics(cwd) {
    const root = await getGitRoot(cwd);
    const readConfig = async (args) => {
      const result = await runCommand("git", ["config", ...args], { cwd: root, timeoutMs: 2000 });
      return result.exitCode === 0 ? result.stdout.trim() : "";
    };
    const [gpgSign, gpgFormat, signingKey, lastLog] = await Promise.all([
      readConfig(["--bool", "--get", "commit.gpgsign"]),
      readConfig(["--get", "gpg.format"]),
      readConfig(["--get", "user.signingkey"]),
      runGitReadCommand(root, ["log", "-1", "--format=%h%x09%G?%x09%GS"], { maxOutputLength: 10_000 }).catch(() => ""),
    ]);
    const [lastHash = "", signState = "", signer = ""] = lastLog.trim().split("\t");
    const commitSignRequired = gpgSign.toLowerCase() === "true";
    const normalizedState = signState.trim().toUpperCase();
    const mismatch = commitSignRequired && (!normalizedState || normalizedState === "N" || normalizedState === "E");
    const suggestions = [];
    if (mismatch) {
      if (!signingKey) suggestions.push({ label: "Set your signing key (repo only)", command: "git config user.signingkey <KEY-ID>" });
      suggestions.push({ label: "Re-sign the last commit", command: "git commit --amend --no-edit -S" });
      suggestions.push({ label: "Disable signing for this repository", command: "git config commit.gpgsign false" });
    }
    return {
      root,
      commitSignRequired,
      gpgFormat: gpgFormat || "(default: gpg)",
      signingKey: signingKey || "(not set)",
      lastCommit: lastHash ? { hash: lastHash, signState: normalizedState || "N", signer } : null,
      mismatch,
      suggestions,
    };
  }

  function gitWorkflowMessageCwd(root, cwd) {
    const repositoryRoot = path.resolve(root);
    const suppliedCwd = path.resolve(String(cwd || repositoryRoot));
    if (suppliedCwd !== repositoryRoot && !pathInside(repositoryRoot, suppliedCwd)) {
      throw new Error(`Git workflow cwd must stay inside repository root: ${suppliedCwd}`);
    }
    return repositoryRoot;
  }

  function gitWorkflowMessageFileMeta(root, messageCwd, filePath) {
    return {
      path: filePath,
      relativePath: path.relative(messageCwd, filePath).split(path.sep).join("/"),
      repoRelativePath: path.relative(root, filePath).split(path.sep).join("/"),
    };
  }

  function commitMessagePaths(baseDir) {
    return {
      shortPath: path.join(baseDir, "dev", "COMMIT", "staged-commit-short.txt"),
      longPath: path.join(baseDir, "dev", "COMMIT", "staged-commit-long.txt"),
      branchPath: path.join(baseDir, "dev", "COMMIT", "staged-branch-name.txt"),
    };
  }

  function assertGitWorkflowArtifactGenerationReady(generationId, generation, kind) {
    if (!generationId) return;
    if (!generation || generation.id !== generationId || generation.kind !== kind) {
      throw new Error(`This ${kind} generation is no longer active. Regenerate the artifact.`);
    }
    if (!generation.terminal) throw new Error(`The correlated ${kind} generation is still running.`);
    if (!generation.successful) throw new Error(`The correlated ${kind} generation did not finish successfully. Regenerate the artifact.`);
  }

  async function readGitWorkflowBranchName(cwd, { generationId = "", generation = null } = {}) {
    assertGitWorkflowArtifactGenerationReady(generationId, generation, "branch");
    const root = await getGitRoot(cwd);
    const messageCwd = gitWorkflowMessageCwd(root, cwd);
    const { branchPath } = commitMessagePaths(messageCwd);
    try {
      const [branchText, branchStat] = await Promise.all([readFile(branchPath, "utf8"), stat(branchPath)]);
      const branch = branchText.split(/\r?\n/).find((line) => line.trim())?.trim() || "";
      if (!branch) throw new Error(`${branchPath} is empty`);
      const branchFile = gitWorkflowMessageFileMeta(root, messageCwd, branchPath);
      return {
        root,
        cwd: messageCwd,
        branchPath,
        branchRelativePath: branchFile.relativePath,
        branchRepoRelativePath: branchFile.repoRelativePath,
        branch,
        mtimeMs: branchStat.mtimeMs,
        ctimeMs: branchStat.ctimeMs,
        ino: String(branchStat.ino),
      };
    } catch (error) {
      throw new Error(`Missing generated branch name file ${branchPath}. Run /git-branch-name first. ${sanitizeError(error)}`);
    }
  }

  function gitWorkflowMessagePendingPayload(root, messageCwd, paths, generationId, reason, details = {}) {
    const shortFile = gitWorkflowMessageFileMeta(root, messageCwd, paths.shortPath);
    const longFile = gitWorkflowMessageFileMeta(root, messageCwd, paths.longPath);
    return {
      ready: false,
      generationId,
      reason,
      root,
      cwd: messageCwd,
      shortPath: paths.shortPath,
      longPath: paths.longPath,
      shortRelativePath: shortFile.relativePath,
      longRelativePath: longFile.relativePath,
      shortRepoRelativePath: shortFile.repoRelativePath,
      longRepoRelativePath: longFile.repoRelativePath,
      ...details,
    };
  }

  async function readGitWorkflowMessages(cwd, { generationId = "", generation = null } = {}) {
    const root = await getGitRoot(cwd);
    const messageCwd = gitWorkflowMessageCwd(root, cwd);
    const paths = commitMessagePaths(messageCwd);
    if (generationId && (!generation || generation.id !== generationId || generation.kind !== "commit" || generation.cwd !== messageCwd)) {
      return gitWorkflowMessagePendingPayload(root, messageCwd, paths, generationId, "This commit-message generation is no longer active. Regenerate the message files.", { expired: true });
    }
    if (generationId && !generation.terminal) {
      return gitWorkflowMessagePendingPayload(root, messageCwd, paths, generationId, "The correlated commit-message generation is still running.", { running: true });
    }
    if (generationId && !generation.successful) {
      return gitWorkflowMessagePendingPayload(root, messageCwd, paths, generationId, "The correlated commit-message generation did not finish successfully. Regenerate the message files.", { expired: true });
    }
    try {
      let pair = await readStableGitMessageArtifactPair(paths);
      if (generationId) {
        const readiness = gitMessageArtifactPairReadiness(generation.baseline, pair);
        if (!readiness.ready) return gitWorkflowMessagePendingPayload(root, messageCwd, paths, generationId, readiness.reason, readiness);
        await new Promise((resolve) => setTimeout(resolve, GIT_WORKFLOW_MESSAGE_PAIR_SETTLE_MS));
        const settledPair = await readStableGitMessageArtifactPair(paths);
        if (!sameGitMessageArtifactPair(pair, settledPair)) {
          return gitWorkflowMessagePendingPayload(root, messageCwd, paths, generationId, "Generated commit message files are still settling.");
        }
        const settledReadiness = gitMessageArtifactPairReadiness(generation.baseline, settledPair);
        if (!settledReadiness.ready) return gitWorkflowMessagePendingPayload(root, messageCwd, paths, generationId, settledReadiness.reason, settledReadiness);
        pair = settledPair;
      }
      if (!pair.short.exists || !pair.long.exists) {
        throw new Error(`Missing ${!pair.short.exists ? paths.shortPath : paths.longPath}`);
      }
      const shortFile = gitWorkflowMessageFileMeta(root, messageCwd, paths.shortPath);
      const longFile = gitWorkflowMessageFileMeta(root, messageCwd, paths.longPath);
      return {
        ready: true,
        generationId,
        root,
        cwd: messageCwd,
        shortPath: paths.shortPath,
        longPath: paths.longPath,
        shortRelativePath: shortFile.relativePath,
        longRelativePath: longFile.relativePath,
        shortRepoRelativePath: shortFile.repoRelativePath,
        longRepoRelativePath: longFile.repoRelativePath,
        short: pair.short.text.trimEnd(),
        long: pair.long.text.trimEnd(),
        shortMtimeMs: Number(BigInt(pair.short.mtimeNs) / 1_000_000n),
        longMtimeMs: Number(BigInt(pair.long.mtimeNs) / 1_000_000n),
        shortSha256: pair.short.sha256,
        longSha256: pair.long.sha256,
      };
    } catch (error) {
      throw new Error(`Missing or unstable generated commit message files in ${path.join(messageCwd, "dev", "COMMIT")}. Run /git-staged-msg first. ${sanitizeError(error)}`);
    }
  }

  function cleanGitBranchName(value) {
    const branch = String(value || "").trim();
    if (!branch) throw new Error("branch is required");
    if (branch.includes("\0") || branch.includes("@{") || branch.startsWith("-") || branch.startsWith("/")) throw new Error("invalid branch name");
    return branch;
  }

  function cleanGitCommitMessageInput(value) {
    const message = String(value || "").replace(/\r\n?/g, "\n").trim();
    if (!message) throw new Error("commit message is required");
    if (message.includes("\0")) throw new Error("commit message contains a NUL byte");
    if (message.length > 10000) throw new Error("commit message is too long");
    return message;
  }


  function gitWorkflowDefaultCommitAction(entry) {
    if (!entry || entry.y !== " ") return "";
    if (entry.x === "A") return "created";
    if (entry.x === "M" || entry.x === "T") return "updated";
    if (entry.x === "D") return "deleted";
    return "";
  }

  function formatGitWorkflowDefaultCommitPath(filePath) {
    return String(filePath || "").replace(/[\0\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 4000);
  }

  async function readGitWorkflowDefaultCommitMessage(cwd) {
    const root = await getGitRoot(cwd);
    const statusText = await runGitReadCommand(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxOutputLength: 120_000 });
    const entries = parseGitPorcelainZEntries(statusText);
    const empty = (reason, extra = {}) => ({ root, message: "", reason, ...extra });
    if (entries.length === 0) return empty("No changed files are ready for a default commit message.");
    if (entries.length !== 1) return empty(`Expected exactly one changed file for a default commit message; found ${entries.length}.`);
    const [entry] = entries;
    const action = gitWorkflowDefaultCommitAction(entry);
    const displayPath = formatGitWorkflowDefaultCommitPath(entry.path);
    if (!action || !displayPath) {
      return empty("The only changed file is not a staged created, updated, or deleted file.", { path: entry.path || "" });
    }
    return {
      root,
      message: `${action} ${displayPath}`,
      action,
      path: entry.path,
    };
  }

  function cleanGitHubUsername(value) {
    const username = String(value || "").trim().replace(/^@+/, "");
    if (!username) throw new Error("GitHub username is required");
    if (username.length > 39 || !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(username) || username.includes("--")) {
      throw new Error("Invalid GitHub username");
    }
    return username;
  }

  function cleanGitHubRepoName(value) {
    let repoName = String(value || "").trim();
    const githubUrlMatch = repoName.match(/github\.com[:/][^/\s]+\/([^/\s]+?)(?:\.git)?\/?$/i);
    if (githubUrlMatch) repoName = githubUrlMatch[1];
    if (repoName.includes("/")) repoName = repoName.split("/").filter(Boolean).pop() || "";
    repoName = repoName.replace(/\.git$/i, "");
    if (!repoName) throw new Error("GitHub repository name is required");
    if (repoName.length > 100 || repoName === "." || repoName === ".." || !/^[A-Za-z0-9._-]+$/.test(repoName)) {
      throw new Error("Invalid GitHub repository name");
    }
    return repoName;
  }

  function gitHubOriginUrl(username, repoName) {
    return `https://github.com/${cleanGitHubUsername(username)}/${cleanGitHubRepoName(repoName)}.git`;
  }

  function defaultGitRepoNameFromRoot(root) {
    try {
      return cleanGitHubRepoName(path.basename(root));
    } catch {
      return "new-repo";
    }
  }

  async function ensureOutsideGitRepository(cwd) {
    const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 2000 });
    if (result.exitCode === 0 && result.stdout.trim()) throw new Error(`Already inside a git repository: ${path.resolve(result.stdout.trim())}`);
  }

  async function regularFileExists(filePath) {
    try {
      return (await stat(filePath)).isFile();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async function detectRepositoryStack(root) {
    let names = new Set();
    try {
      names = new Set(await readdir(root));
    } catch {
      return "";
    }
    const detected = [];
    if (names.has("package.json")) {
      try {
        const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
        const deps = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
        if (deps.next) detected.push("Next.js");
        else if (deps.react || deps.vite) detected.push("React / Vite");
        else detected.push("Node.js / TypeScript");
        if (deps.typescript || names.has("tsconfig.json")) detected.push("TypeScript");
      } catch {
        detected.push("Node.js");
      }
    }
    if (names.has("pyproject.toml") || names.has("requirements.txt") || names.has("setup.py")) detected.push("Python");
    if (names.has("manage.py")) detected.push("Django");
    if (names.has("Cargo.toml")) detected.push("Rust");
    if (names.has("go.mod")) detected.push("Go");
    if (names.has("pom.xml") || names.has("build.gradle") || names.has("build.gradle.kts")) detected.push("Java / Gradle");
    if (names.has("Dockerfile") || names.has("docker-compose.yml") || names.has("compose.yml")) detected.push("Docker");
    return [...new Set(detected)].join(", ");
  }

  async function initialRepositoryFilesStatus(cwd) {
    const root = await getGitRoot(cwd);
    const readmePath = path.join(root, "README.md");
    const gitignorePath = path.join(root, ".gitignore");
    const [readmeExists, gitignoreExists, detectedStack] = await Promise.all([
      regularFileExists(readmePath),
      regularFileExists(gitignorePath),
      detectRepositoryStack(root),
    ]);
    return { root, readmePath, gitignorePath, readmeExists, gitignoreExists, detectedStack };
  }

  function gitignoreLinesForStack(stackInput, detectedStack = "") {
    const stack = `${stackInput || ""} ${detectedStack || ""}`.toLowerCase();
    const sections = [
      ["# OS / editors", ".DS_Store", "Thumbs.db", ".idea/", ".vscode/", "*.swp", "*.swo"],
      ["# Local env / secrets", ".env", ".env.*", "!.env.example", "*.local"],
      ["# Logs / temp", "*.log", "logs/", "tmp/", "temp/", ".cache/"],
    ];
    if (/node|npm|pnpm|yarn|bun|typescript|javascript|react|vite|next/.test(stack)) {
      sections.push(["# Node / frontend", "node_modules/", "dist/", "build/", ".next/", "out/", "coverage/", ".turbo/", ".vite/", "*.tsbuildinfo"]);
    }
    if (/python|django|fastapi|flask/.test(stack)) {
      sections.push(["# Python", "__pycache__/", "*.py[cod]", ".pytest_cache/", ".ruff_cache/", ".mypy_cache/", ".venv/", "venv/", "htmlcov/", "*.egg-info/"]);
    }
    if (/rust|cargo/.test(stack)) sections.push(["# Rust", "target/"]);
    if (/\bgo\b|golang/.test(stack)) sections.push(["# Go", "bin/", "*.test", "coverage.out"]);
    if (/java|gradle|maven|kotlin/.test(stack)) sections.push(["# Java / JVM", "target/", "build/", ".gradle/", "*.class"]);
    if (/docker|container/.test(stack)) sections.push(["# Docker", ".docker/", "docker-compose.override.yml"]);
    if (sections.length === 3) {
      sections.push(["# Common dependency / build outputs", "node_modules/", ".venv/", "venv/", "target/", "dist/", "build/", "coverage/", "vendor/", "*.tmp"]);
    }
    const seen = new Set();
    const lines = [];
    for (const section of sections) {
      lines.push(section[0]);
      for (const pattern of section.slice(1)) {
        if (seen.has(pattern)) continue;
        seen.add(pattern);
        lines.push(pattern);
      }
      lines.push("");
    }
    return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
  }

  async function prepareInitialRepositoryFiles(cwd, { repoName: repoNameInput, stack = "" } = {}) {
    const before = await initialRepositoryFilesStatus(cwd);
    const repoName = repoNameInput ? cleanGitHubRepoName(repoNameInput) : defaultGitRepoNameFromRoot(before.root);
    if (await regularFileExists(before.readmePath)) {
      // Explicit pre-add check: keep existing README.md unchanged.
    } else {
      await writeFile(before.readmePath, `# ${repoName}\n\nInitialized by Pi Web UI.\n`, "utf8");
    }
    let gitignoreCreated = false;
    let gitignoreSource = before.gitignoreExists ? "existing" : "fallback";
    if (!(await regularFileExists(before.gitignorePath))) {
      await writeFile(before.gitignorePath, gitignoreLinesForStack(stack, before.detectedStack), "utf8");
      gitignoreCreated = true;
    }
    const payload = gitMutationPayload(await runGitMutationCommand(["add", "--", "README.md", ".gitignore"], { cwd: before.root, label: "git add README.md .gitignore" }));
    if (payload.data) {
      payload.data.root = before.root;
      payload.data.readme = { path: before.readmePath, exists: true, created: !before.readmeExists };
      payload.data.gitignore = { path: before.gitignorePath, exists: true, created: gitignoreCreated, source: gitignoreSource };
      payload.data.detectedStack = before.detectedStack;
      payload.data.stack = stack;
      payload.data.stdout = [
        before.readmeExists ? `Using existing ${before.readmePath}` : `Created ${before.readmePath}`,
        before.gitignoreExists ? `Using existing ${before.gitignorePath}` : `Created ${before.gitignorePath} (${gitignoreSource})`,
        payload.data.stdout?.trimEnd(),
      ].filter(Boolean).join("\n");
    }
    return payload;
  }

  async function validateGitBranchName(root, branch) {
    const result = await runGitWorkflowCommand(["check-ref-format", "--branch", branch], { cwd: root, timeoutMs: 5000 });
    if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.error) {
      throw new Error((result.stderr || result.stdout || result.error || `Invalid branch name: ${branch}`).trim());
    }
  }

  async function currentGitBranch(root) {
    const result = await runGitWorkflowCommand(["branch", "--show-current"], { cwd: root, timeoutMs: 5000 });
    const branch = result.stdout.trim();
    if (result.exitCode !== 0 || !branch) throw new Error((result.stderr || result.stdout || "Cannot determine current git branch").trim());
    return branch;
  }

  async function currentGitBranchForPicker(root) {
    try {
      return (await runGitReadCommand(root, ["branch", "--show-current"], { timeoutMs: 5000, maxOutputLength: 10_000 })).trim();
    } catch {
      return "";
    }
  }

  function normalizeGitBranchList(branchText, current = "") {
    const seen = new Set();
    const branches = [];
    for (const line of String(branchText || "").split(/\r?\n/)) {
      const name = line.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      branches.push({ name, current: !!current && name === current });
    }
    return branches.sort((left, right) => {
      if (left.current !== right.current) return left.current ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  function configuredRemoteForRef(remoteRef, remoteNames = []) {
    return remoteNames
      .filter((remoteName) => remoteRef.startsWith(`${remoteName}/`))
      .sort((left, right) => right.length - left.length || left.localeCompare(right))[0] || "";
  }

  function remoteBranchRecord(fullRef, symref = "", remoteNames = []) {
    const prefix = "refs/remotes/";
    const ref = String(fullRef || "");
    if (!ref.startsWith(prefix) || symref) return null;
    const remoteRef = ref.slice(prefix.length);
    const remoteName = configuredRemoteForRef(remoteRef, remoteNames);
    if (!remoteName) return null;
    const name = remoteRef.slice(remoteName.length + 1);
    if (!name) return null;
    return { name, current: false, remote: true, remoteRef, remoteName, displayName: remoteRef };
  }

  async function readRemoteGitBranchData(root) {
    const [remoteNamesText, refs] = await Promise.all([
      runGitReadCommand(root, ["remote"], { timeoutMs: 5000, maxOutputLength: 120_000 }),
      runGitReadCommandDetailed(root, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/remotes"], { timeoutMs: 5000, maxOutputLength: 120_000 }),
    ]);
    return {
      remoteNames: remoteNamesText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      refText: refs.output,
      truncated: refs.truncated === true,
      unavailable: false,
    };
  }

  function normalizeRemoteGitBranches(remoteData, localBranchNames) {
    // Never parse tail-truncated output: the first retained line may be a partial
    // ref. Local branches and worktrees remain available while the UI can expose
    // the truncation flag.
    if (!remoteData || remoteData.truncated) return [];
    const remoteBranches = [];
    for (const line of String(remoteData.refText || "").split(/\r?\n/)) {
      const [fullRef = "", symref = ""] = line.split("\t", 2);
      const branch = remoteBranchRecord(fullRef, symref, remoteData.remoteNames);
      // A local branch takes precedence over every same-named remote ref. Until
      // then, retain each exact remote ref so multiple remotes stay unambiguous.
      if (branch && !localBranchNames.has(branch.name)) remoteBranches.push(branch);
    }
    return remoteBranches.sort((left, right) => left.displayName.localeCompare(right.displayName));
  }

  async function readGitBranches(cwd) {
    const root = await getGitRoot(cwd);
    const [current, branchText, worktreeData, remoteData] = await Promise.all([
      currentGitBranchForPicker(root),
      runGitReadCommand(root, ["branch", "--format=%(refname:lstrip=2)"], { timeoutMs: 5000, maxOutputLength: 120_000 }),
      listGitWorktrees(cwd).catch(() => null),
      readRemoteGitBranchData(root).catch(() => ({ remoteNames: [], refText: "", truncated: false, unavailable: true })),
    ]);
    const occupiedByBranch = new Map();
    for (const item of worktreeData?.occupiedBranches || []) {
      if (!item?.branch || occupiedByBranch.has(item.branch)) continue;
      occupiedByBranch.set(item.branch, item);
    }
    const localBranches = normalizeGitBranchList(branchText, current).map((branch) => {
      const occupied = occupiedByBranch.get(branch.name);
      return occupied ? { ...branch, occupied: true, worktreePath: occupied.path, worktreeCurrent: occupied.current === true, mainWorktree: occupied.isMainWorktree === true } : branch;
    });
    const remoteBranches = normalizeRemoteGitBranches(remoteData, new Set(localBranches.map((branch) => branch.name)));
    return {
      cwd,
      root,
      repoRoot: worktreeData?.repoRoot || root,
      commonGitDir: worktreeData?.commonGitDir || "",
      currentWorktreePath: worktreeData?.currentWorktreePath || root,
      defaultWorktreesRoot: worktreeData?.defaultWorktreesRoot || "",
      current,
      generatedAt: new Date().toISOString(),
      branches: [...localBranches, ...remoteBranches],
      remoteBranchesTruncated: remoteData.truncated === true,
      remoteBranchesUnavailable: remoteData.unavailable === true,
      worktrees: worktreeData?.worktrees || [],
      occupiedBranches: worktreeData?.occupiedBranches || [],
    };
  }

  function requestedRemoteRef(body = {}) {
    if (!Object.hasOwn(body, "remoteRef")) return null;
    if (typeof body.remoteRef !== "string" || !body.remoteRef || body.remoteRef.trim() !== body.remoteRef) {
      throw new Error("remoteRef must be a non-empty exact remote-tracking ref");
    }
    return body.remoteRef;
  }

  async function verifyRemoteGitBranchIntent(cwd, branch, remoteRef) {
    const targetBranch = cleanGitBranchName(branch);
    const branches = await readGitBranches(cwd);
    const localBranch = branches.branches.find((item) => item.remote !== true && item.name === targetBranch);
    if (localBranch) throw new Error(`Local git branch already exists: ${targetBranch}. Refresh the picker and use the local branch instead.`);
    const remoteBranch = branches.branches.find((item) => item.remote === true && item.remoteRef === remoteRef);
    if (!remoteBranch) throw new Error(`Unknown remote git branch: ${remoteRef}`);
    if (remoteBranch.name !== targetBranch) {
      throw new Error(`Remote git branch ${remoteRef} does not match local branch ${targetBranch}`);
    }
    return { root: branches.root, branch: targetBranch, remoteRef: remoteBranch.remoteRef };
  }

  async function switchGitBranch(cwd, branch, { create = false, remoteRef = null } = {}) {
    if (remoteRef !== null) {
      // Re-read the advertised remote-only record immediately before creating a
      // tracking branch. This rejects stale refs and local-name collisions.
      const intent = await verifyRemoteGitBranchIntent(cwd, branch, remoteRef);
      const payload = gitMutationPayload(await runGitMutationCommand(["switch", "--track", "-c", intent.branch, intent.remoteRef], { cwd: intent.root, timeoutMs: 10 * 60 * 1000 }));
      if (payload.ok) {
        payload.data.branch = intent.branch;
        payload.data.root = intent.root;
        payload.data.switched = true;
        payload.data.created = true;
      } else {
        payload.error = (payload.data?.stderr || payload.data?.stdout || payload.error || `Failed to create and switch to ${intent.branch}`).trim();
      }
      return payload;
    }

    const root = await getGitRoot(cwd);
    const targetBranch = cleanGitBranchName(branch);
    await validateGitBranchName(root, targetBranch);
    const branches = await readGitBranches(cwd);
    const branchExists = branches.branches.some((item) => item.remote !== true && item.name === targetBranch);
    if (create && branchExists) throw new Error(`Local git branch already exists: ${targetBranch}`);
    if (!create && !branchExists) throw new Error(`Unknown local git branch: ${targetBranch}`);
    const occupied = branches.branches.find((item) => item.remote !== true && item.name === targetBranch && item.occupied && !item.worktreeCurrent);
    if (!create && occupied?.worktreePath) {
      return {
        ok: false,
        code: WORKTREE_ERROR_CODES.BRANCH_CHECKED_OUT_ELSEWHERE,
        error: `Branch ${targetBranch} is already checked out at ${occupied.worktreePath}. Open that worktree instead of switching this checkout.`,
        data: { branch: targetBranch, root, worktreePath: occupied.worktreePath },
      };
    }
    if (!create && branches.current === targetBranch) {
      return { ok: true, data: { command: `git switch ${targetBranch}`, stdout: "", stderr: "", exitCode: 0, branch: targetBranch, root, switched: false, created: false } };
    }
    const args = create ? ["switch", "-c", targetBranch] : ["switch", targetBranch];
    const payload = gitMutationPayload(await runGitMutationCommand(args, { cwd: root, timeoutMs: 10 * 60 * 1000 }));
    if (payload.ok) {
      payload.data.branch = targetBranch;
      payload.data.root = root;
      payload.data.switched = true;
      payload.data.created = create;
    } else {
      payload.error = (payload.data?.stderr || payload.data?.stdout || payload.error || `Failed to ${create ? "create and switch to" : "switch to"} ${targetBranch}`).trim();
    }
    return payload;
  }

  async function gitRemoteNames(root) {
    const result = await runGitWorkflowCommand(["remote"], { cwd: root, timeoutMs: 5000 });
    if (result.exitCode !== 0) throw new Error((result.stderr || result.stdout || "Cannot list git remotes").trim());
    return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  }

  async function defaultGitRemote(root) {
    const remotes = await gitRemoteNames(root);
    if (!remotes.length) throw new Error("No git remote is configured for this repository");
    return remotes.includes("origin") ? "origin" : remotes[0];
  }

  function prDescriptionPath(root, branch) {
    const base = path.resolve(root, "dev", "PR");
    const target = path.resolve(base, `${encodeURIComponent(branch)}.md`);
    if (path.dirname(target) !== base) throw new Error("Resolved PR description path escapes dev/PR");
    return { base, prPath: target };
  }

  async function readGitWorkflowPrDescription(cwd, { generationId = "", generation = null } = {}) {
    assertGitWorkflowArtifactGenerationReady(generationId, generation, "pr");
    const root = await getGitRoot(cwd);
    const branch = await currentGitBranch(root);
    const { prPath } = prDescriptionPath(root, branch);
    try {
      const [body, info] = await Promise.all([readFile(prPath, "utf8"), stat(prPath)]);
      return {
        root,
        branch,
        path: prPath,
        body: body.trimEnd(),
        mtimeMs: info.mtimeMs,
        ctimeMs: info.ctimeMs,
        ino: String(info.ino),
      };
    } catch (error) {
      throw new Error(`Missing generated PR description ${prPath}. Run /pr first. ${sanitizeError(error)}`);
    }
  }

  function cleanPrTitle(value) {
    const title = String(value || "").replace(/\r?\n/g, " ").trim();
    if (!title) throw new Error("PR title is required");
    return title.slice(0, 300);
  }

  function runWorkflowCommand(command, args, { cwd, label = formatWorkflowCommand(command, args), timeoutMs = 10 * 60 * 1000 } = {}) {
    if (activeGitWorkflowProcess) {
      return Promise.reject(new Error(`A git workflow command is already running: ${activeGitWorkflowProcess.label}`));
    }

    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        // LC_ALL=C keeps git/gh output in English so failure classification
        // (classifyGitSyncFailure, isGitLockFailure) works regardless of locale.
        env: { ...process.env, GIT_TERMINAL_PROMPT: process.env.GIT_TERMINAL_PROMPT || "0", GH_PROMPT_DISABLED: process.env.GH_PROMPT_DISABLED || "1", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      let settled = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (activeGitWorkflowProcess?.child === child) activeGitWorkflowProcess = null;
        resolve({ command: label, stdout, stderr, timedOut, cancelled, ...result });
      };

      const terminate = (reason) => {
        if (reason === "cancelled") cancelled = true;
        if (child.exitCode === null) child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null) child.kill("SIGKILL");
        }, 2000).unref();
      };

      activeGitWorkflowProcess = { child, label, cancel: () => terminate("cancelled") };
      const timeout = setTimeout(() => {
        timedOut = true;
        terminate("timeout");
      }, timeoutMs);

      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
        if (stdout.length > 100000) stdout = stdout.slice(-100000);
      });
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 100000) stderr = stderr.slice(-100000);
      });
      child.on("error", (error) => {
        const message = formatCommandSpawnError(command, error);
        finish({ exitCode: undefined, stderr: stderr || message, error: message, errorCode: error?.code });
      });
      // "close", not "exit": exit can fire before the stdio pipes flush,
      // intermittently truncating collected stdout/stderr.
      child.on("close", (exitCode, signal) => finish({ exitCode, signal }));
    });
  }

  function runGitWorkflowCommand(args, options = {}) {
    return runWorkflowCommand("git", args, { ...options, label: options.label || formatGitCommand(args) });
  }

  function runGitHubWorkflowCommand(args, options = {}) {
    return runWorkflowCommand("gh", args, { ...options, label: options.label || formatWorkflowCommand("gh", args) });
  }

  function gitWorkflowCommandPayload(result) {
    const ok = result.exitCode === 0 && !result.timedOut && !result.cancelled && !result.error;
    return {
      ok,
      error: ok ? undefined : result.error || (result.cancelled ? "Cancelled" : result.timedOut ? "Command timed out" : `Command failed with exit code ${result.exitCode ?? result.signal ?? "unknown"}`),
      data: result,
    };
  }

  function applyGitHubPublicationFailure(payload) {
    if (payload.ok) return payload;
    const text = `${payload.data?.stderr || ""}\n${payload.data?.stdout || ""}\n${payload.data?.error || ""}`.toLowerCase();
    if (payload.data?.errorCode === "ENOENT") {
      payload.hint = "Install GitHub CLI (gh), ensure it is on PATH, then retry.";
    } else if (/not logged into any github hosts|gh auth login|http 401|bad credentials/.test(text)) {
      payload.code = "AUTH";
      payload.hint = "GitHub CLI is not authenticated. Run 'gh auth login' in a terminal, then retry.";
    } else if (/name already exists on this account|repository .+ already exists/.test(text)) {
      payload.hint = "A GitHub repository with this directory name already exists for the authenticated account. Add that repository as a remote, or rename the local directory before retrying.";
    }
    return payload;
  }

  async function initializeGitRepository(cwd) {
    await ensureOutsideGitRepository(cwd);
    return gitMutationPayload(await runGitMutationCommand(["init"], { cwd }));
  }

  async function initialGitCommit(cwd) {
    const root = await getGitRoot(cwd);
    return gitMutationPayload(await runGitMutationCommand(["commit", "-m", "Initial commit"], { cwd: root, label: "git commit -m \"Initial commit\"" }));
  }

  async function renameGitMainBranch(cwd) {
    const root = await getGitRoot(cwd);
    return gitMutationPayload(await runGitMutationCommand(["branch", "-M", "main"], { cwd: root }));
  }

  async function addGitOrigin(cwd, body = {}) {
    const root = await getGitRoot(cwd);
    const username = cleanGitHubUsername(body.username);
    const repoName = cleanGitHubRepoName(body.repoName);
    const remoteUrl = gitHubOriginUrl(username, repoName);
    const payload = gitMutationPayload(await runGitMutationCommand(["remote", "add", "origin", remoteUrl], { cwd: root }));
    if (payload.data) {
      payload.data.root = root;
      payload.data.remote = "origin";
      payload.data.remoteUrl = remoteUrl;
      payload.data.repoName = repoName;
      payload.data.username = username;
    }
    return payload;
  }

  async function pushInitialGitMain(cwd) {
    const root = await getGitRoot(cwd);
    return applyGitSyncFailure(gitMutationPayload(await runGitMutationCommand(["push", "-u", "origin", "main"], { cwd: root, timeoutMs: 15 * 60 * 1000 })), { push: true });
  }

  async function commitGitWorkflow(cwd, body = {}) {
    const variant = String(body.variant || "").trim();
    if (!["short", "long", "input"].includes(variant)) throw new Error("variant must be 'short', 'long', or 'input'");
    // Recheck here as well as in the browser. A staged index can change
    // between the browser's read-only check and this mutating request.
    await assertExpectedStagedContentHash({ cwd }, body);
    if (variant === "input") {
      const root = await getGitRoot(cwd);
      const message = cleanGitCommitMessageInput(body.message);
      return gitMutationPayload(await runGitMutationCommand(["commit", "-m", message], { cwd: root, label: "git commit -m <input message>" }));
    }
    const messages = await readGitWorkflowMessages(cwd);
    if (variant === "short") {
      const message = messages.short.trim();
      if (!message) throw new Error(`${messages.shortPath} is empty`);
      return gitMutationPayload(await runGitMutationCommand(["commit", "-m", message], { cwd: messages.root, label: "git commit -m <dev/COMMIT/staged-commit-short.txt>" }));
    }
    if (!messages.long.trim()) throw new Error(`${messages.longPath} is empty`);
    return gitMutationPayload(await runGitMutationCommand(["commit", "-F", messages.longPath], { cwd: messages.root, label: "git commit -F dev/COMMIT/staged-commit-long.txt" }));
  }

  async function pushGitWorkflow(cwd, body = {}) {
    const root = await getGitRoot(cwd);
    const currentBranch = await currentGitBranch(root);
    const protectedBranch = PROTECTED_GIT_BRANCHES.has(currentBranch);
    if (body.setUpstream) {
      const requestedBranch = body.branch ? cleanGitBranchName(body.branch) : currentBranch;
      if (requestedBranch !== currentBranch) throw new Error(`Current branch is ${currentBranch}, not ${requestedBranch}`);
      const remote = await defaultGitRemote(root);
      const payload = await runGuardedGitMutation(["push", "-u", remote, currentBranch], { cwd: root, label: `git push -u ${remote} ${currentBranch}`, timeoutMs: 15 * 60 * 1000 });
      if (payload.data) {
        payload.data.branch = currentBranch;
        payload.data.protectedBranch = protectedBranch;
        if (payload.ok) payload.data.remote = remote;
      }
      return applyGitSyncFailure(payload, { push: true });
    }
    // Plain --force is never offered; --force-with-lease still refuses to
    // clobber remote commits we have not seen, and requires confirmation.
    const forceWithLease = body.forceWithLease === true;
    if (forceWithLease) requireConfirmed(body, `Force-pushing ${currentBranch} (--force-with-lease) rewrites the remote branch and`);
    const remotes = await gitRemoteNames(root);
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    const args = remote
      ? ["push", "-u", ...(forceWithLease ? ["--force-with-lease"] : []), remote, "HEAD"]
      : ["push", ...(forceWithLease ? ["--force-with-lease"] : [])];
    const label = remote
      ? `git push -u${forceWithLease ? " --force-with-lease" : ""} ${remote} HEAD`
      : undefined;
    const payload = await runGuardedGitMutation(args, { cwd: root, label, timeoutMs: 15 * 60 * 1000 });
    if (payload.data) {
      payload.data.branch = currentBranch;
      payload.data.protectedBranch = protectedBranch;
      payload.data.forceWithLease = forceWithLease;
      if (remote) payload.data.remote = remote;
      else payload.data.repoName = path.basename(root);
    }
    return applyGitSyncFailure(payload, { push: true });
  }

  async function publishGitRepository(cwd, body = {}) {
    const root = await getGitRoot(cwd);
    const repoName = cleanGitHubRepoName(path.basename(root));
    const visibility = String(body.visibility || "").trim();
    if (visibility !== "public" && visibility !== "private") throw makeHttpError(400, "visibility must be 'public' or 'private'");
    requireConfirmed(body, `Publishing GitHub repository ${repoName} as ${visibility}`);
    const remotes = await gitRemoteNames(root);
    if (remotes.length) throw makeHttpError(409, "GitHub publication requires a repository with no configured remotes. Existing remotes are not changed or repaired.");
    const branch = await currentGitBranch(root);
    const protectedBranch = PROTECTED_GIT_BRANCHES.has(branch);
    const payload = applyGitHubPublicationFailure(gitWorkflowCommandPayload(await runGitHubWorkflowCommand(
      ["repo", "create", repoName, `--${visibility}`, "--source", ".", "--remote", "origin", "--push"],
      { cwd: root, timeoutMs: 15 * 60 * 1000 },
    )));
    if (payload.ok) Object.assign(payload.data, { repoName, visibility, remote: "origin", branch, protectedBranch });
    return payload;
  }

  async function createGitWorkflowPr(cwd, body = {}) {
    const root = await getGitRoot(cwd);
    const branch = await currentGitBranch(root);
    const title = cleanPrTitle(body.title);
    const description = String(body.body || "").trimEnd();
    if (!description.trim()) throw new Error("PR description is required");
    const { base, prPath } = prDescriptionPath(root, branch);
    await mkdir(path.dirname(prPath), { recursive: true });
    await writeFile(prPath, `${description}\n`, "utf8");
    const payload = gitWorkflowCommandPayload(await runGitHubWorkflowCommand(["pr", "create", "--title", title, "--body-file", prPath, "--head", branch], { cwd: root, label: "gh pr create --title <title> --body-file <dev/PR/current-branch.md> --head <current-branch>", timeoutMs: 15 * 60 * 1000 }));
    if (payload.ok) {
      payload.data.branch = branch;
      payload.data.path = prPath;
      payload.data.prDirectory = base;
    }
    return payload;
  }

  function cancelGitWorkflowProcess() {
    const occupied = Boolean(activeGitWorkflowProcess);
    if (activeGitWorkflowProcess) activeGitWorkflowProcess.cancel();
    return occupied;
  }

  return {
    addGitignoreEntry,
    switchGitBranch,
    pullGitChanges,
    fetchGitChanges,
    integrateGitUpstream,
    gitOperationStageFile,
    gitOperationAction,
    gitBisectAction,
    saveGitStash,
    applyGitStash,
    dropGitStash,
    stageGitFile,
    unstageGitFile,
    stageAllGitChanges,
    unstageAllGitChanges,
    discardGitFile,
    deleteGitUntrackedFile,
    undoLastGitCommit,
    amendLastGitCommitMessage,
    updateGitSubmodules,
    createGitTag,
    gitAddAllPayload,
    readGitOperationSnapshot,
    readGitStashes,
    readGitStashPreview,
    readGitUndoState,
    readGitReflog,
    readGitSubmodules,
    readGitTags,
    readGitSigningDiagnostics,
    readGitBranches,
    readGitWorkflowBranchName,
    readGitWorkflowMessages,
    readGitWorkflowDefaultCommitMessage,
    readGitWorkflowPrDescription,
    initialRepositoryFilesStatus,
    prepareInitialRepositoryFiles,
    readStagedContentHash,
    stagedContentHashForTab,
    expectedStagedContentHashFromBody,
    assertExpectedStagedContentHash,
    gitWorkflowMessageCwd,
    commitMessagePaths,
    cleanGitBranchName,
    validateGitBranchName,
    requestedRemoteRef,
    verifyRemoteGitBranchIntent,
    runGitWorkflowCommand,
    requireConfirmed,
    initializeGitRepository,
    initialGitCommit,
    renameGitMainBranch,
    addGitOrigin,
    pushInitialGitMain,
    commitGitWorkflow,
    pushGitWorkflow,
    publishGitRepository,
    createGitWorkflowPr,
    cancelGitWorkflowProcess,
  };
}
