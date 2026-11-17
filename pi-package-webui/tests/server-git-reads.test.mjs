import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createGitReadService } from "../lib/server/git-reads.mjs";

const execFileAsync = promisify(execFile);
const ok = (stdout = "", extra = {}) => ({ exitCode: 0, stdout, stderr: "", ...extra });
const failure = { exitCode: 128, stdout: "", stderr: "repository unavailable" };

function service(runCommand = realRunCommand) {
  return createGitReadService({
    runCommand,
    makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    makeUserFacingError: (message) => Object.assign(new Error(message), { userFacing: true }),
    formatBytes: (bytes) => `${bytes} bytes`,
    sanitizeError: (error) => error.message || String(error),
    formatGitCommand: (args) => `git ${args.join(" ")}`,
  });
}

async function realRunCommand(command, args, options = {}) {
  const { cwd, timeoutMs = 2000, maxOutputLength = 20_000, env = {}, input } = options;
  const child = execFileAsync(command, args, {
    cwd,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, ...env, LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull },
    encoding: "utf8",
  });
  if (input !== undefined) child.child.stdin.end(input);
  try {
    const { stdout, stderr } = await child;
    return ok(stdout.slice(-maxOutputLength), { stderr, stdoutTruncated: stdout.length > maxOutputLength });
  } catch (error) {
    return { exitCode: error.code, stdout: error.stdout || "", stderr: error.stderr || "", timedOut: error.killed };
  }
}

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "webui-git-reads-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = async (...args) => {
    const result = await realRunCommand("git", args, { cwd: root, timeoutMs: 5000 });
    assert.equal(result.exitCode, 0, result.stderr);
    return result.stdout.trim();
  };
  await git("init", "-b", "main");
  await git("config", "user.name", "Fixture Author");
  await git("config", "user.email", "fixture@example.invalid");
  return { root, git };
}

test("factory construction is lazy and exposes exactly the contracted service", () => {
  const reads = service(() => { assert.fail("factory must not execute commands"); });
  const names = [
    "getGitRoot", "runGitReadCommandDetailed", "runGitReadCommand", "readGitChanges", "readGitFileDiff",
    "readGitPanel", "readGitCommit", "readGitUntrackedFile", "readWorkspaceGitStatusIndex",
    "readWorkspaceGitIgnoredPaths", "withFileTreeGitStatus", "withFileTreeGitIgnored", "fileTreeGitStatusPayload",
    "resolveGitRelativePath", "normalizeGitRelativePath", "isLikelyBinaryBuffer", "parseGitPorcelainZEntries",
    "gitBranchFromPorcelainStatus", "summarizeGitPorcelainStatus", "gitUpstreamRef",
  ];
  assert.deepEqual(Object.keys(reads).sort(), names.sort());
  for (const name of names) assert.equal(typeof reads[name], "function");
});

test("read command bounds, optional locks, truncation and user-facing errors", async () => {
  const calls = [];
  let result = ok("tail", { stdoutTruncated: true });
  const reads = service(async (...args) => { calls.push(args); return result; });
  assert.deepEqual(await reads.runGitReadCommandDetailed("/repo", ["diff"]), {
    output: "tail", truncated: true, capBytes: 500_000,
  });
  assert.deepEqual(calls[0], ["git", ["diff"], {
    cwd: "/repo", timeoutMs: 5000, maxOutputLength: 500_000, env: { GIT_OPTIONAL_LOCKS: "0" },
  }]);
  assert.equal(await reads.runGitReadCommand("/repo", ["status"], { timeoutMs: 13, maxOutputLength: 17 }), "tail");
  assert.equal(calls[1][2].timeoutMs, 13);
  assert.equal(calls[1][2].maxOutputLength, 17);
  for (const [failed, message] of [
    [ok("", { timedOut: true }), "git diff timed out"],
    [failure, "repository unavailable"],
    [{ exitCode: 2, stdout: " stdout failure \n" }, "stdout failure"],
    [ok("", { error: "spawn error" }), "spawn error"],
    [{ exitCode: 9 }, "git diff failed with exit code 9"],
    [{}, "git diff failed with exit code unknown"],
  ]) {
    result = failed;
    await assert.rejects(reads.runGitReadCommandDetailed("/repo", ["diff"]), (error) => {
      assert.equal(error.message, message);
      assert.equal(error.userFacing, true);
      return true;
    });
  }
  result = ok(" /repo \n");
  assert.equal(await reads.getGitRoot("/repo/sub"), path.resolve("/repo"));
  assert.deepEqual(calls.at(-1), ["git", ["rev-parse", "--show-toplevel"], { cwd: "/repo/sub", timeoutMs: 2000 }]);
  result = failure;
  await assert.rejects(reads.getGitRoot("/repo"), /repository unavailable/);
  result = { exitCode: 1 };
  await assert.rejects(reads.getGitRoot("/repo"), /Not inside a git repository/);
});

test("porcelain parser preserves NUL-delimited rename, copy and unusual paths", () => {
  const reads = service();
  const unusual = "dir/tab\tand\nnewline ü.txt";
  assert.deepEqual(reads.parseGitPorcelainZEntries(`R  ${unusual}\0old name\0C  copy\0source\0?? -leading\0x\0`), [
    { x: "R", y: " ", path: unusual, oldPath: "old name" },
    { x: "C", y: " ", path: "copy", oldPath: "source" },
    { x: "?", y: "?", path: "-leading" },
    { x: "", y: "", path: "x", unsupported: true },
  ]);
  assert.deepEqual(reads.parseGitPorcelainZEntries(), []);
  assert.equal(reads.gitBranchFromPorcelainStatus("# branch.head main\r\n"), "main");
  assert.equal(reads.gitBranchFromPorcelainStatus("# branch.head (detached)\n"), "detached");
  assert.equal(reads.gitBranchFromPorcelainStatus(""), "detached");
  assert.deepEqual(reads.summarizeGitPorcelainStatus([
    "# branch.ab +2 -3", "1 M. tracked", "2 .M renamed", "1 MM both", "u UU conflict", "? new",
  ].join("\n")), { staged: 2, unstaged: 2, untracked: 1, conflicted: 1, ahead: 2, behind: 3 });
});

test("path and binary helpers retain lexical validation", () => {
  const reads = service();
  const root = path.resolve(os.tmpdir(), "git-read-root");
  assert.equal(reads.resolveGitRelativePath(root, " ./folder/../file "), path.join(root, "file"));
  assert.equal(reads.normalizeGitRelativePath(root, "./folder/file"), "folder/file");
  assert.equal(reads.normalizeGitRelativePath(root, "."), "");
  for (const invalid of ["", "  ", "file\0suffix"]) {
    assert.throws(() => reads.resolveGitRelativePath(root, invalid), /Invalid git path/);
  }
  assert.throws(() => reads.resolveGitRelativePath(root, "../git-read-root-other/file"), /escapes repository/);
  assert.equal(reads.isLikelyBinaryBuffer(Buffer.from([1, 0, 2])), true);
  assert.equal(reads.isLikelyBinaryBuffer(Buffer.from("text")), false);
  assert.equal(reads.isLikelyBinaryBuffer("\0"), false);
});

test("real panel and commit reads retain status, rename stats, binary stats and history", async (t) => {
  const { root, git } = await repository(t);
  const reads = service();
  await mkdir(path.join(root, "sub"));
  const original = "sub/original\tü.txt";
  const renamed = "sub/renamed\nü.txt";
  await writeFile(path.join(root, original), "one\ntwo\n");
  await writeFile(path.join(root, "binary"), Buffer.from([0, 1]));
  await git("add", "--", original, "binary");
  await git("commit", "-m", "Fixture subject");
  const hash = await git("rev-parse", "HEAD");
  await git("mv", "--", original, renamed);
  await writeFile(path.join(root, renamed), "one\nthree\n");
  await writeFile(path.join(root, "binary"), Buffer.from([0, 2]));
  await writeFile(path.join(root, "-new.txt"), "new\n");
  const before = await readFile(path.join(root, ".git", "index"));
  const panel = await reads.readGitPanel(path.join(root, "sub"));
  assert.equal(panel.cwd, path.join(root, "sub"));
  assert.equal(panel.root, root);
  assert.equal(panel.branch, "main");
  assert.equal(panel.history[0].hash, hash);
  assert.equal(panel.history[0].author, "Fixture Author");
  assert.equal(panel.history[0].subject, "Fixture subject");
  assert.deepEqual(panel.summary, { staged: 1, unstaged: 2, untracked: 1, conflicted: 0, ahead: 0, behind: 0 });
  const rename = panel.changes.find((entry) => entry.path === renamed);
  assert.equal(rename.oldPath, original);
  assert.equal(rename.status, "RM");
  assert.equal(rename.staged, true);
  assert.equal(rename.unstaged, true);
  assert.equal(rename.additions, 3);
  assert.equal(rename.deletions, 3);
  assert.equal(rename.unstagedAdditions, 1);
  assert.equal(rename.unstagedDeletions, 1);
  assert.equal(panel.changes.find((entry) => entry.path === "binary").binary, true);
  assert.equal(panel.changes.find((entry) => entry.path === "-new.txt").untracked, true);
  const commit = await reads.readGitCommit(root, hash.toUpperCase());
  assert.equal(commit.commit.hash, hash);
  assert.equal(commit.sections[0].key, "commit");
  assert.match(commit.sections[0].diff, /Fixture|original/);
  assert.equal(commit.sections[0].capBytes, 500_000);
  assert.deepEqual(commit.untracked, []);
  assert.deepEqual(await readFile(path.join(root, ".git", "index")), before);
  for (const invalid of ["HEAD", hash.slice(0, 12), "-x", "g".repeat(40)]) {
    await assert.rejects(reads.readGitCommit(root, invalid), { statusCode: 400 });
  }
});

test("real status and ignored decorations use workspace-relative paths and retain unrelated entries", async (t) => {
  const { root, git } = await repository(t);
  const reads = service();
  await mkdir(path.join(root, "sub"));
  const name = "sub/tab\tline\nü.txt";
  await writeFile(path.join(root, name), "before\n");
  await writeFile(path.join(root, ".gitignore"), "sub/cache ü/\n");
  await git("add", ".");
  await git("commit", "-m", "Initial");
  await writeFile(path.join(root, name), "after\n");
  await mkdir(path.join(root, "sub", "cache ü"));
  const entries = [{ path: "tab\tline\nü.txt" }, { path: "cache ü" }, { path: "../../outside" }, { name: "no path" }];
  const status = await reads.readWorkspaceGitStatusIndex(root);
  const decorated = reads.withFileTreeGitStatus(entries, path.join(root, "sub"), status);
  assert.deepEqual(decorated[0].gitStatus, { changed: true, kind: "modified", status: "M", direct: true, changedDescendants: 0 });
  assert.equal(decorated[2], entries[2]);
  assert.equal(status.entries.get("sub").changedDescendants, 1);
  const payload = reads.fileTreeGitStatusPayload(path.join(root, "sub"), status);
  assert.equal(payload.root, root);
  assert.equal(payload.entries.some((entry) => entry.path === "tab\tline\nü.txt"), true);
  assert.equal(payload.entries.some((entry) => entry.path === ".gitignore"), false);
  const ignored = await reads.readWorkspaceGitIgnoredPaths(path.join(root, "sub"), entries, root);
  assert.deepEqual([...ignored.paths], ["sub/cache ü"]);
  const ignoredEntries = reads.withFileTreeGitIgnored(entries, path.join(root, "sub"), ignored);
  assert.equal(ignoredEntries[1].gitIgnored, true);
  assert.equal(ignoredEntries[0], entries[0]);
  assert.equal(ignoredEntries[2], entries[2]);
  assert.equal(reads.withFileTreeGitStatus(entries, root, null), entries);
  assert.equal(reads.withFileTreeGitIgnored(entries, root, null), entries);
  assert.equal(reads.fileTreeGitStatusPayload(root, null), null);
});

test("status decoration aggregates rank, conflict and old-path ancestors", async () => {
  const root = path.resolve(os.tmpdir(), "git-read-status");
  const reads = service(async (_command, args) => ok(args[0] === "rev-parse" ? root : [
    "?? dir/new", " M dir/modified", "M  dir/staged", "UU dir/conflict", "R  dest/file", "old/file",
  ].join("\0") + "\0"));
  const status = await reads.readWorkspaceGitStatusIndex(root);
  assert.deepEqual(status.entries.get("dir"), { changed: true, kind: "conflicted", status: "", direct: false, changedDescendants: 4 });
  assert.equal(status.entries.get("dir/staged").kind, "staged");
  assert.equal(status.entries.get("dir/new").kind, "untracked");
  assert.equal(status.entries.get("old").changedDescendants, 1);
  assert.equal(status.entries.has("old/file"), false);
});

test("nullable decorations and upstream failures preserve fallback semantics and ignored bounds", async () => {
  const root = path.resolve(os.tmpdir(), "git-read-ignored");
  const calls = [];
  let result = failure;
  const reads = service(async (...args) => { calls.push(args); return result; });
  assert.equal(await reads.readWorkspaceGitStatusIndex(root), null);
  assert.equal(await reads.gitUpstreamRef(root), "");
  assert.equal(await reads.readWorkspaceGitIgnoredPaths(root, [{ path: "file" }], root), null);
  for (const extra of [{ timedOut: true }, { error: "spawn failure" }, { stdoutTruncated: true }]) {
    result = ok("file\0", extra);
    assert.equal(await reads.readWorkspaceGitIgnoredPaths(root, [{ path: "file" }], root), null);
  }
  result = ok("", { exitCode: 1 });
  assert.equal((await reads.readWorkspaceGitIgnoredPaths(root, [{ path: "file" }], root)).paths.size, 0);
  assert.deepEqual(calls.at(-1), ["git", ["check-ignore", "-z", "--stdin"], {
    cwd: root, timeoutMs: 5000, maxOutputLength: 20_000, env: { GIT_OPTIONAL_LOCKS: "0" }, input: "file\0", utf8Output: true,
  }]);
  const count = calls.length;
  assert.equal(await reads.readWorkspaceGitIgnoredPaths(root, [{ path: "../outside" }, { path: "." }], root), null);
  assert.equal(calls.length, count);
  const unusual = "tab\tline\nü.txt";
  result = ok(`${unusual}\0`);
  assert.equal((await reads.readWorkspaceGitIgnoredPaths(root, [{ path: unusual }], root)).paths.has(unusual), true);
  assert.equal(calls.at(-1)[2].input, `${unusual}\0`);
  const longName = "x".repeat(20_001);
  await reads.readWorkspaceGitIgnoredPaths(root, [{ path: longName }], root);
  assert.equal(calls.at(-1)[2].maxOutputLength, longName.length + 2);
  const throwing = service(async () => { throw new Error("command rejected"); });
  assert.equal(await throwing.readWorkspaceGitStatusIndex(root), null);
  assert.equal(await throwing.readWorkspaceGitIgnoredPaths(root, [{ path: "file" }], root), null);
});

test("real untracked previews and per-file diffs retain size, binary, categories and refusal contracts", async (t) => {
  const { root, git } = await repository(t);
  const reads = service();
  await writeFile(path.join(root, "tracked.txt"), "before\n");
  await git("add", ".");
  await git("commit", "-m", "Initial");
  await writeFile(path.join(root, "tracked.txt"), "staged\n");
  await git("add", ".");
  await writeFile(path.join(root, "tracked.txt"), "unstaged\n");
  await writeFile(path.join(root, "new file.txt"), "new text\n");
  await writeFile(path.join(root, "binary"), Buffer.from([0, 1]));
  assert.equal((await reads.readGitUntrackedFile(root, "new file.txt")).content, "new text\n");
  assert.equal((await reads.readGitUntrackedFile(root, "binary")).binary, true);
  assert.equal((await reads.readGitUntrackedFile(root, "binary")).content, "");
  assert.match((await reads.readGitUntrackedFile(root, "new file.txt", { maxBytes: 2 })).error, /limit 2 bytes/);
  await assert.rejects(reads.readGitUntrackedFile(root, "tracked.txt"), /Not an untracked file/);
  await assert.rejects(reads.readGitUntrackedFile(root, "../outside"), /escapes repository/);
  await assert.rejects(reads.readGitFileDiff(root, "tracked.txt", "invalid"), /category must be/);
  for (const [category, expected] of [["staged", "+staged"], ["unstaged", "+unstaged"], ["conflicted", ""]]) {
    const diff = await reads.readGitFileDiff(root, "tracked.txt", category);
    assert.equal(diff.category, category);
    assert.equal(diff.truncated, false);
    assert.equal(diff.capBytes, 500_000);
    if (expected) assert.ok(diff.diff.includes(expected));
  }
  const preview = await reads.readGitFileDiff(root, "new file.txt", "untracked");
  assert.equal(preview.label, "Untracked");
  assert.equal(preview.diff, "");
  assert.equal(preview.content, "new text\n");
  const changes = await reads.readGitChanges(root);
  assert.deepEqual(changes.sections.map((section) => section.key), ["staged", "unstaged"]);
  assert.equal(changes.summary.staged, 1);
  assert.equal(changes.summary.unstaged, 1);
  assert.equal(changes.untracked.length, 2);
  assert.equal(changes.remote.upstream, "");
  assert.equal(changes.remote.canPull, false);
});

test("file diff command construction retains category flags, path separation and truncated tails", async () => {
  const root = path.resolve(os.tmpdir(), "git-read-diff");
  const calls = [];
  const reads = service(async (_command, args, options) => {
    calls.push({ args, options });
    return args[0] === "rev-parse" ? ok(root) : ok("tail\n\n", { stdoutTruncated: true });
  });
  for (const [category, flags] of [["staged", ["--cached"]], ["unstaged", []], ["conflicted", ["--cc"]]]) {
    const diff = await reads.readGitFileDiff(root, "-strange\tpath\nü", category);
    assert.deepEqual(calls.at(-1).args, [
      "diff", ...flags, "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--src-prefix=a/", "--dst-prefix=b/", "--", "-strange\tpath\nü",
    ]);
    assert.equal(diff.diff, "tail");
    assert.equal(diff.truncated, true);
    assert.equal(diff.capBytes, 500_000);
  }
});

test("incoming reads retain diverged/canPull flags, bounded sections and read error payloads", async () => {
  const root = path.resolve(os.tmpdir(), "git-read-incoming");
  let ahead = 0;
  let incomingFails = false;
  const reads = service(async (_command, args) => {
    if (args[0] === "rev-parse") return ok(args.includes("--show-toplevel") ? root : "origin/main\n");
    if (args.includes("--porcelain=2")) return ok(`# branch.head main\n# branch.ab +${ahead} -2\n`);
    if (args.includes("HEAD..@{upstream}")) return incomingFails ? failure : ok("incoming\n", { stdoutTruncated: true });
    if (args[0] === "diff") return ok("diff\n", { stdoutTruncated: true });
    return ok("");
  });
  const changes = await reads.readGitChanges(root);
  assert.equal(changes.remote.canPull, true);
  assert.equal(changes.sections[0].key, "incoming");
  assert.equal(changes.sections[0].diff, "incoming");
  assert.equal(changes.sections[0].truncated, true);
  assert.equal(changes.sections[0].capBytes, 500_000);
  assert.equal(changes.sections[1].truncated, true);
  ahead = 1;
  const diverged = await reads.readGitChanges(root);
  assert.equal(diverged.remote.diverged, true);
  assert.equal(diverged.remote.canPull, false);
  incomingFails = true;
  const failed = await reads.readGitChanges(root);
  assert.equal(failed.remote.error, "repository unavailable");
  assert.deepEqual(failed.sections.map((section) => section.key), ["staged", "unstaged"]);
});

test("commit fallback supports full SHA-256 hashes and retains command limits and truncation", async () => {
  const root = path.resolve(os.tmpdir(), "git-read-commit");
  const hash = "a".repeat(64);
  const calls = [];
  const reads = service(async (_command, args, options) => {
    calls.push({ args, options });
    if (args.includes("--show-toplevel")) return ok(root);
    if (args.includes("--verify")) return ok(hash);
    if (args.includes("--format=")) return ok("diff tail\n", { stdoutTruncated: true });
    return ok("");
  });
  const commit = await reads.readGitCommit(root, hash);
  assert.deepEqual(commit.commit, { hash, shortHash: hash.slice(0, 12), author: "", authoredAt: "", subject: "" });
  assert.equal(commit.sections[0].diff, "diff tail");
  assert.equal(commit.sections[0].truncated, true);
  assert.equal(calls.find(({ args }) => args.includes("--verify")).options.maxOutputLength, 1000);
  assert.equal(calls.find(({ args }) => args.includes("-s")).options.maxOutputLength, 20_000);
  assert.equal(calls.find(({ args }) => args.includes("--format=")).options.maxOutputLength, 500_000);
});

test("unborn history, missing untracked entries and commit verification keep existing fallbacks", async (t) => {
  const { root } = await repository(t);
  assert.deepEqual((await service().readGitPanel(root)).history, []);
  const reads = service(async (_command, args) => {
    if (args.includes("--show-toplevel")) return ok(root);
    if (args.includes("--verify")) return ok("b".repeat(40));
    if (args[0] === "ls-files") return ok("missing\n.git\n");
    return ok("");
  });
  await assert.rejects(reads.readGitCommit(root, "a".repeat(40)), { statusCode: 404 });
  const changes = await reads.readGitChanges(root);
  assert.match(changes.untracked[0].error, /ENOENT/);
  assert.equal(changes.untracked[1].error, "Not a regular file");
});
