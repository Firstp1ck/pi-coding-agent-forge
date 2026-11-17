import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathInside } from "../git-worktrees.mjs";

const GIT_CHANGES_COMMAND_TIMEOUT_MS = 5000;
const GIT_CHANGES_DIFF_MAX_OUTPUT = 500_000;
const GIT_FILE_DIFF_CATEGORIES = new Set(["staged", "unstaged", "conflicted", "untracked"]);
const GIT_FILE_DIFF_LABELS = Object.freeze({
  staged: "Staged",
  unstaged: "Unstaged",
  conflicted: "Conflicted",
  untracked: "Untracked",
});
const GIT_STATUS_KIND_RANK = Object.freeze({ changed: 0, untracked: 1, modified: 2, staged: 3, conflicted: 4 });

export function createGitReadService({
  runCommand,
  makeHttpError,
  makeUserFacingError,
  formatBytes,
  sanitizeError,
  formatGitCommand,
}) {
  async function getGitRoot(cwd) {
    const result = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 2000 });
    if (result.exitCode !== 0) {
      throw makeUserFacingError((result.stderr || result.stdout || "Not inside a git repository").trim());
    }
    return path.resolve(result.stdout.trim());
  }

  async function runGitReadCommandDetailed(root, args, { timeoutMs = GIT_CHANGES_COMMAND_TIMEOUT_MS, maxOutputLength = GIT_CHANGES_DIFF_MAX_OUTPUT } = {}) {
    const result = await runCommand("git", args, {
      cwd: root,
      timeoutMs,
      maxOutputLength,
      // Prevent read-only status/diff commands from refreshing the index and
      // feeding their own metadata writes back into the live Git watcher.
      env: { GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.exitCode === 0 && !result.timedOut && !result.error) {
      return { output: result.stdout, truncated: result.stdoutTruncated === true, capBytes: maxOutputLength };
    }
    const command = formatGitCommand(args);
    const message = result.timedOut
      ? `${command} timed out`
      : (result.stderr || result.stdout || result.error || `${command} failed with exit code ${result.exitCode ?? "unknown"}`);
    throw makeUserFacingError(String(message).trim());
  }

  async function runGitReadCommand(root, args, options = {}) {
    return (await runGitReadCommandDetailed(root, args, options)).output;
  }

  function gitBranchFromPorcelainStatus(statusText) {
    for (const line of String(statusText || "").split(/\r?\n/)) {
      if (!line.startsWith("# branch.head ")) continue;
      const branch = line.slice("# branch.head ".length).trim();
      return branch && branch !== "(detached)" ? branch : "detached";
    }
    return "detached";
  }

  function addGitPorcelainTrackedSummary(summary, xy) {
    const x = xy?.[0] || ".";
    const y = xy?.[1] || ".";
    if (x !== ".") summary.staged += 1;
    if (y !== ".") summary.unstaged += 1;
  }

  function summarizeGitPorcelainStatus(statusText) {
    const summary = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0 };
    for (const line of String(statusText || "").split(/\r?\n/)) {
      if (!line) continue;
      if (line.startsWith("# branch.ab ")) {
        const match = line.match(/\+(\d+)\s+-(\d+)/);
        if (match) {
          summary.ahead = Number.parseInt(match[1] || "0", 10) || 0;
          summary.behind = Number.parseInt(match[2] || "0", 10) || 0;
        }
        continue;
      }
      if (line.startsWith("1 ") || line.startsWith("2 ")) {
        addGitPorcelainTrackedSummary(summary, line.split(" ")[1] || "..");
        continue;
      }
      if (line.startsWith("u ")) {
        summary.conflicted += 1;
        continue;
      }
      if (line.startsWith("? ")) summary.untracked += 1;
    }
    return summary;
  }

  function normalizeGitStatusPath(value = "") {
    return String(value || "").replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/g, "");
  }

  function gitStatusKindFromPorcelainEntry(entry = {}) {
    const x = entry.x || " ";
    const y = entry.y || " ";
    if (x === "?" && y === "?") return "untracked";
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
    if (x !== " " && x !== "?" && x !== ".") return "staged";
    if (y !== " " && y !== "?" && y !== ".") return "modified";
    return "changed";
  }

  function gitStatusLabelFromPorcelainEntry(entry = {}) {
    const x = entry.x || " ";
    const y = entry.y || " ";
    if (x === "?" && y === "?") return "??";
    return `${x}${y}`.replace(/\s/g, "").trim() || "•";
  }

  function mergeGitStatusIndexEntry(index, repoPath, patch = {}) {
    const key = normalizeGitStatusPath(repoPath);
    if (!key) return;
    const existing = index.get(key) || { changed: true, kind: "changed", status: "", direct: false, changedDescendants: 0 };
    const existingRank = GIT_STATUS_KIND_RANK[existing.kind] ?? 0;
    const nextRank = GIT_STATUS_KIND_RANK[patch.kind] ?? 0;
    index.set(key, {
      changed: true,
      kind: nextRank > existingRank ? patch.kind : existing.kind,
      status: patch.direct === true ? (patch.status || existing.status || "") : (existing.status || ""),
      direct: existing.direct === true || patch.direct === true,
      changedDescendants: (Number(existing.changedDescendants || 0) || 0) + (Number(patch.changedDescendants || 0) || 0),
    });
  }

  function addGitStatusAncestorEntries(index, repoPath, kind) {
    const parts = normalizeGitStatusPath(repoPath).split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      mergeGitStatusIndexEntry(index, current, { kind, changedDescendants: 1 });
    }
  }

  function buildGitStatusIndexFromPorcelain(statusText = "") {
    const index = new Map();
    for (const entry of parseGitPorcelainZEntries(statusText)) {
      const filePath = normalizeGitStatusPath(entry.path);
      if (!filePath) continue;
      const kind = gitStatusKindFromPorcelainEntry(entry);
      mergeGitStatusIndexEntry(index, filePath, { kind, status: gitStatusLabelFromPorcelainEntry(entry), direct: true });
      addGitStatusAncestorEntries(index, filePath, kind);
      if (entry.oldPath) addGitStatusAncestorEntries(index, entry.oldPath, kind);
    }
    return index;
  }

  async function readWorkspaceGitStatusIndex(workspaceRoot) {
    try {
      const root = await getGitRoot(workspaceRoot);
      const statusText = await runGitReadCommand(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxOutputLength: 120_000 });
      return { root, entries: buildGitStatusIndexFromPorcelain(statusText) };
    } catch {
      return null;
    }
  }

  function gitStatusForWorkspaceEntry(workspaceRoot, entry, gitStatus) {
    if (!gitStatus?.root || !gitStatus.entries?.size || !entry?.path) return null;
    const absolute = path.resolve(workspaceRoot, entry.path);
    if (absolute !== gitStatus.root && !pathInside(gitStatus.root, absolute)) return null;
    const repoPath = normalizeGitStatusPath(path.relative(gitStatus.root, absolute).split(path.sep).join("/"));
    const status = gitStatus.entries.get(repoPath);
    if (!status?.changed) return null;
    return {
      changed: true,
      kind: status.kind || "changed",
      status: status.status || "",
      direct: status.direct === true,
      changedDescendants: Number(status.changedDescendants || 0) || 0,
    };
  }

  function withFileTreeGitStatus(entries = [], workspaceRoot, gitStatus) {
    if (!gitStatus?.entries?.size) return entries;
    return entries.map((entry) => {
      const status = gitStatusForWorkspaceEntry(workspaceRoot, entry, gitStatus);
      return status ? { ...entry, gitStatus: status } : entry;
    });
  }

  async function readWorkspaceGitIgnoredPaths(workspaceRoot, entries = [], gitRoot = "") {
    try {
      const root = path.resolve(gitRoot || await getGitRoot(workspaceRoot));
      const candidates = new Set();
      for (const entry of entries) {
        if (!entry?.path) continue;
        const absolute = path.resolve(workspaceRoot, entry.path);
        if (absolute !== root && !pathInside(root, absolute)) continue;
        const relative = path.relative(root, absolute);
        if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) continue;
        candidates.add(relative.split(path.sep).join("/"));
      }
      if (!candidates.size) return null;
      const input = `${[...candidates].join("\0")}\0`;
      const result = await runCommand("git", ["check-ignore", "-z", "--stdin"], {
        cwd: root,
        timeoutMs: GIT_CHANGES_COMMAND_TIMEOUT_MS,
        maxOutputLength: Math.max(20_000, input.length + 1),
        env: { GIT_OPTIONAL_LOCKS: "0" },
        input,
        utf8Output: true,
      });
      if (![0, 1].includes(result.exitCode) || result.timedOut || result.error || result.stdoutTruncated) return null;
      return { root, paths: new Set(result.stdout.split("\0").filter(Boolean)) };
    } catch {
      return null;
    }
  }

  function withFileTreeGitIgnored(entries = [], workspaceRoot, gitIgnored) {
    if (!gitIgnored?.root || !gitIgnored.paths?.size) return entries;
    return entries.map((entry) => {
      if (!entry?.path) return entry;
      const absolute = path.resolve(workspaceRoot, entry.path);
      if (absolute !== gitIgnored.root && !pathInside(gitIgnored.root, absolute)) return entry;
      const relative = path.relative(gitIgnored.root, absolute).split(path.sep).join("/");
      return gitIgnored.paths.has(relative) ? { ...entry, gitIgnored: true } : entry;
    });
  }

  function fileTreeGitStatusPayload(workspaceRoot, gitStatus) {
    if (!gitStatus?.root || !gitStatus.entries?.size) return null;
    const root = path.resolve(workspaceRoot);
    const entries = [];
    for (const [repoPath, status] of gitStatus.entries.entries()) {
      const absolute = path.resolve(gitStatus.root, repoPath);
      if (absolute !== root && !pathInside(root, absolute)) continue;
      entries.push({
        path: path.relative(root, absolute).split(path.sep).join("/"),
        changed: true,
        kind: status.kind || "changed",
        status: status.status || "",
        direct: status.direct === true,
        changedDescendants: Number(status.changedDescendants || 0) || 0,
      });
    }
    return { root: gitStatus.root, entries };
  }

  function resolveGitRelativePath(root, relativePath) {
    const normalized = String(relativePath || "").trim();
    if (!normalized || normalized.includes("\0")) throw new Error("Invalid git path");
    const resolved = path.resolve(root, normalized);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Git path escapes repository: ${normalized}`);
    return resolved;
  }

  function isLikelyBinaryBuffer(buffer) {
    return Buffer.isBuffer(buffer) && buffer.includes(0);
  }

  function normalizeGitRelativePath(root, relativePath) {
    const resolved = resolveGitRelativePath(root, relativePath);
    return path.relative(root, resolved).split(path.sep).join("/");
  }

  async function readGitUntrackedEntry(root, file, { maxBytes = Number.POSITIVE_INFINITY } = {}) {
    const normalized = normalizeGitRelativePath(root, file);
    const filePath = resolveGitRelativePath(root, normalized);
    const info = await stat(filePath);
    if (!info.isFile()) return { path: normalized, size: info.size, binary: false, content: "", error: "Not a regular file" };
    if (Number.isFinite(maxBytes) && info.size > maxBytes) {
      return { path: normalized, size: info.size, binary: false, content: "", error: `File is too large to preview (limit ${formatBytes(maxBytes)})` };
    }
    const buffer = await readFile(filePath);
    const binary = isLikelyBinaryBuffer(buffer);
    return {
      path: normalized,
      size: info.size,
      binary,
      content: binary ? "" : buffer.toString("utf8"),
    };
  }

  async function readGitUntrackedEntries(root, files) {
    const entries = [];
    for (const file of files) {
      try {
        entries.push(await readGitUntrackedEntry(root, file));
      } catch (error) {
        entries.push({ path: file, size: 0, binary: false, content: "", error: sanitizeError(error) });
      }
    }
    return entries;
  }

  async function readGitUntrackedFile(cwd, requestedPath, options = {}) {
    const root = await getGitRoot(cwd);
    const normalized = normalizeGitRelativePath(root, requestedPath);
    const listed = await runGitReadCommand(root, ["ls-files", "--others", "--exclude-standard", "--", normalized], { maxOutputLength: 120_000 });
    const files = listed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!files.includes(normalized)) throw new Error(`Not an untracked file: ${normalized}`);
    return readGitUntrackedEntry(root, normalized, options);
  }

  function normalizeGitFileDiffCategory(requestedCategory) {
    const category = String(requestedCategory || "").trim();
    if (!GIT_FILE_DIFF_CATEGORIES.has(category)) {
      throw new Error("Git file diff category must be staged, unstaged, conflicted, or untracked");
    }
    return category;
  }

  function gitFileDiffArgs(category, normalizedPath) {
    const args = ["diff"];
    if (category === "staged") args.push("--cached");
    if (category === "conflicted") args.push("--cc");
    args.push("--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/", "--", normalizedPath);
    return args;
  }

  async function readGitFileDiff(cwd, requestedPath, requestedCategory) {
    const root = await getGitRoot(cwd);
    const category = normalizeGitFileDiffCategory(requestedCategory);
    const normalizedPath = normalizeGitRelativePath(root, requestedPath);
    const label = GIT_FILE_DIFF_LABELS[category];

    if (category === "untracked") {
      const untracked = await readGitUntrackedFile(root, normalizedPath, { maxBytes: GIT_CHANGES_DIFF_MAX_OUTPUT });
      return {
        root,
        path: normalizedPath,
        category,
        label,
        command: formatGitCommand(["ls-files", "--others", "--exclude-standard", "--", normalizedPath]),
        diff: "",
        truncated: false,
        capBytes: GIT_CHANGES_DIFF_MAX_OUTPUT,
        ...untracked,
      };
    }

    const args = gitFileDiffArgs(category, normalizedPath);
    const result = await runGitReadCommandDetailed(root, args);
    return {
      root,
      path: normalizedPath,
      category,
      label,
      command: formatGitCommand(args),
      diff: result.output.trimEnd(),
      truncated: result.truncated,
      capBytes: result.capBytes,
    };
  }

  async function gitUpstreamRef(root) {
    try {
      const upstream = await runGitReadCommand(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], { timeoutMs: 5000, maxOutputLength: 10_000 });
      return upstream.trim();
    } catch {
      return "";
    }
  }

  async function readGitIncomingChanges(root, summary) {
    const upstream = await gitUpstreamRef(root);
    const ahead = Number(summary?.ahead || 0) || 0;
    const behind = Number(summary?.behind || 0) || 0;
    const diverged = ahead > 0 && behind > 0;
    const remote = {
      upstream,
      ahead,
      behind,
      diverged,
      // Fast-forward pull is only possible when we are strictly behind.
      canPull: !!upstream && behind > 0 && !diverged,
    };
    if (!upstream || behind <= 0) return { remote, section: null };

    const diffArgs = ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=0", "--src-prefix=a/", "--dst-prefix=b/", "HEAD..@{upstream}"];
    try {
      const diff = await runGitReadCommandDetailed(root, diffArgs);
      return {
        remote,
        section: {
          key: "incoming",
          label: `Incoming from ${upstream}`,
          command: `git diff --unified=0 HEAD..${upstream}`,
          diff: diff.output.trimEnd(),
          truncated: diff.truncated,
          capBytes: diff.capBytes,
        },
      };
    } catch (error) {
      return { remote: { ...remote, error: sanitizeError(error) }, section: null };
    }
  }

  async function readGitChanges(cwd) {
    const root = await getGitRoot(cwd);
    const diffArgs = ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=0", "--src-prefix=a/", "--dst-prefix=b/"];
    const [statusText, porcelainStatusText, unstagedDiff, stagedDiff, untrackedText] = await Promise.all([
      runGitReadCommand(root, ["status", "--short", "--branch", "--untracked-files=all"], { maxOutputLength: 120_000 }),
      runGitReadCommand(root, ["status", "--porcelain=2", "--branch", "--untracked-files=all"], { maxOutputLength: 120_000 }),
      runGitReadCommandDetailed(root, diffArgs),
      runGitReadCommandDetailed(root, ["diff", "--cached", "--no-ext-diff", "--no-color", "--find-renames", "--unified=0", "--src-prefix=a/", "--dst-prefix=b/"]),
      runGitReadCommand(root, ["ls-files", "--others", "--exclude-standard"], { maxOutputLength: 120_000 }),
    ]);
    const summary = summarizeGitPorcelainStatus(porcelainStatusText);
    const incoming = await readGitIncomingChanges(root, summary);
    const untrackedFiles = untrackedText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const untracked = await readGitUntrackedEntries(root, untrackedFiles);
    return {
      cwd,
      root,
      branch: gitBranchFromPorcelainStatus(porcelainStatusText),
      generatedAt: new Date().toISOString(),
      summary,
      remote: incoming.remote,
      status: statusText.trimEnd(),
      sections: [
        incoming.section,
        { key: "staged", label: "Staged", command: "git diff --cached --unified=0", diff: stagedDiff.output.trimEnd(), truncated: stagedDiff.truncated, capBytes: stagedDiff.capBytes },
        { key: "unstaged", label: "Unstaged", command: "git diff --unified=0", diff: unstagedDiff.output.trimEnd(), truncated: unstagedDiff.truncated, capBytes: unstagedDiff.capBytes },
      ].filter(Boolean),
      untracked,
    };
  }

  const GIT_PANEL_HISTORY_LIMIT = 30;
  const GIT_PANEL_MAX_OUTPUT = 240_000;

  function parseGitNumstatZ(text = "") {
    const stats = new Map();
    for (const record of String(text || "").split("\0")) {
      if (!record) continue;
      const firstTab = record.indexOf("\t");
      const secondTab = firstTab < 0 ? -1 : record.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) continue;
      const additionsText = record.slice(0, firstTab);
      const deletionsText = record.slice(firstTab + 1, secondTab);
      const filePath = normalizeGitStatusPath(record.slice(secondTab + 1));
      if (!filePath) continue;
      const binary = additionsText === "-" || deletionsText === "-";
      stats.set(filePath, {
        additions: binary ? 0 : Number.parseInt(additionsText || "0", 10) || 0,
        deletions: binary ? 0 : Number.parseInt(deletionsText || "0", 10) || 0,
        binary,
      });
    }
    return stats;
  }

  function gitPanelPathStats(entry, stagedStats, unstagedStats) {
    const paths = [entry.path, entry.oldPath].map(normalizeGitStatusPath).filter(Boolean);
    const aggregate = (stats) => {
      const value = { additions: 0, deletions: 0, binary: false };
      for (const filePath of paths) {
        const current = stats.get(filePath);
        if (!current) continue;
        value.additions += Number(current.additions || 0) || 0;
        value.deletions += Number(current.deletions || 0) || 0;
        value.binary ||= current.binary === true;
      }
      return value;
    };
    const staged = aggregate(stagedStats);
    const unstaged = aggregate(unstagedStats);
    return {
      additions: staged.additions + unstaged.additions,
      deletions: staged.deletions + unstaged.deletions,
      binary: staged.binary || unstaged.binary,
      stagedAdditions: staged.additions,
      stagedDeletions: staged.deletions,
      stagedBinary: staged.binary,
      unstagedAdditions: unstaged.additions,
      unstagedDeletions: unstaged.deletions,
      unstagedBinary: unstaged.binary,
    };
  }

  function gitPanelChangeEntry(entry, stagedStats, unstagedStats) {
    const x = entry.x || " ";
    const y = entry.y || " ";
    const untracked = x === "?" && y === "?";
    const conflicted = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");
    return {
      path: normalizeGitStatusPath(entry.path),
      oldPath: normalizeGitStatusPath(entry.oldPath || ""),
      status: `${x}${y}`,
      staged: !untracked && x !== " " && x !== "?",
      unstaged: !untracked && y !== " " && y !== "?",
      untracked,
      conflicted,
      ...gitPanelPathStats(entry, stagedStats, unstagedStats),
    };
  }

  function parseGitPanelHistory(text = "") {
    const fields = String(text || "").split("\0").filter(Boolean);
    const history = [];
    for (let index = 0; index + 4 < fields.length && history.length < GIT_PANEL_HISTORY_LIMIT; index += 5) {
      const [hash, shortHash, author, authoredAt, subject] = fields.slice(index, index + 5);
      if (!hash) continue;
      history.push({ hash, shortHash, author, authoredAt, subject });
    }
    return history;
  }

  async function readGitPanel(cwd) {
    const root = await getGitRoot(cwd);
    const historyPromise = runGitReadCommand(root, [
      "log", `-n${GIT_PANEL_HISTORY_LIMIT}`, "-z", "--date=iso-strict", "--format=%H%x00%h%x00%an%x00%aI%x00%s",
    ], { maxOutputLength: GIT_PANEL_MAX_OUTPUT }).catch(() => "");
    const [statusText, porcelainStatusText, stagedNumstatText, unstagedNumstatText, historyText] = await Promise.all([
      runGitReadCommand(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { maxOutputLength: GIT_PANEL_MAX_OUTPUT }),
      runGitReadCommand(root, ["status", "--porcelain=2", "--branch", "--untracked-files=all"], { maxOutputLength: GIT_PANEL_MAX_OUTPUT }),
      runGitReadCommand(root, ["diff", "--cached", "--numstat", "-z", "--no-renames", "--"], { maxOutputLength: GIT_PANEL_MAX_OUTPUT }),
      runGitReadCommand(root, ["diff", "--numstat", "-z", "--no-renames", "--"], { maxOutputLength: GIT_PANEL_MAX_OUTPUT }),
      historyPromise,
    ]);
    const stagedStats = parseGitNumstatZ(stagedNumstatText);
    const unstagedStats = parseGitNumstatZ(unstagedNumstatText);
    const changes = parseGitPorcelainZEntries(statusText)
      .map((entry) => gitPanelChangeEntry(entry, stagedStats, unstagedStats))
      .filter((entry) => entry.path);
    return {
      cwd,
      root,
      branch: gitBranchFromPorcelainStatus(porcelainStatusText),
      generatedAt: new Date().toISOString(),
      summary: summarizeGitPorcelainStatus(porcelainStatusText),
      changes,
      history: parseGitPanelHistory(historyText),
    };
  }

  async function readGitCommit(cwd, requestedHash) {
    const hash = String(requestedHash || "").trim().toLowerCase();
    if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(hash)) throw makeHttpError(400, "A full Git commit hash is required");
    const root = await getGitRoot(cwd);
    const verified = (await runGitReadCommand(root, ["rev-parse", "--verify", `${hash}^{commit}`], { maxOutputLength: 1000 })).trim();
    if (verified.toLowerCase() !== hash) throw makeHttpError(404, "Git commit not found in this repository");
    const [metaText, diff] = await Promise.all([
      runGitReadCommand(root, ["show", "-s", "-z", "--date=iso-strict", "--format=%H%x00%h%x00%an%x00%aI%x00%s", hash], { maxOutputLength: 20_000 }),
      runGitReadCommandDetailed(root, ["show", "--format=", "--no-ext-diff", "--no-color", "--find-renames", "--unified=0", "--src-prefix=a/", "--dst-prefix=b/", hash]),
    ]);
    const [commit] = parseGitPanelHistory(metaText);
    return {
      root,
      branch: "",
      generatedAt: new Date().toISOString(),
      commit: commit || { hash, shortHash: hash.slice(0, 12), author: "", authoredAt: "", subject: "" },
      summary: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0 },
      remote: { upstream: "", ahead: 0, behind: 0, diverged: false, canPull: false },
      sections: [{
        key: "commit",
        label: `Commit ${commit?.shortHash || hash.slice(0, 12)}`,
        command: `git show --unified=0 ${hash}`,
        diff: diff.output.trimEnd(),
        truncated: diff.truncated,
        capBytes: diff.capBytes,
      }],
      untracked: [],
    };
  }

  function parseGitPorcelainZEntries(text) {
    const fields = String(text || "").split("\0").filter(Boolean);
    const entries = [];
    for (let index = 0; index < fields.length; index++) {
      const field = fields[index];
      if (field.length < 4) {
        entries.push({ x: "", y: "", path: field, unsupported: true });
        continue;
      }
      const x = field[0] || " ";
      const y = field[1] || " ";
      const filePath = field.slice(3);
      const entry = { x, y, path: filePath };
      if ((x === "R" || x === "C") && index + 1 < fields.length) entry.oldPath = fields[++index];
      entries.push(entry);
    }
    return entries;
  }

  return {
    getGitRoot,
    runGitReadCommandDetailed,
    runGitReadCommand,
    readGitChanges,
    readGitFileDiff,
    readGitPanel,
    readGitCommit,
    readGitUntrackedFile,
    readWorkspaceGitStatusIndex,
    readWorkspaceGitIgnoredPaths,
    withFileTreeGitStatus,
    withFileTreeGitIgnored,
    fileTreeGitStatusPayload,
    resolveGitRelativePath,
    normalizeGitRelativePath,
    isLikelyBinaryBuffer,
    parseGitPorcelainZEntries,
    gitBranchFromPorcelainStatus,
    summarizeGitPorcelainStatus,
    gitUpstreamRef,
  };
}
