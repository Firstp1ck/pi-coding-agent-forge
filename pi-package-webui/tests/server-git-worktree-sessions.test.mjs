import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createGitWorktreeSessionService } from "../lib/server/git-worktree-sessions.mjs";
import { createGitWorktree, listGitWorktrees, pathInside } from "../lib/git-worktrees.mjs";

const execute = promisify(execFile);
const approvedHash = "a".repeat(64);

async function git(cwd, args, options = {}) {
  return execute("git", args, { cwd, timeout: 10_000, maxBuffer: 8 * 1024 * 1024, ...options });
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

async function fixture(t, overrides = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "webui-worktree-sessions-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const sessions = path.join(root, "sessions");
  await mkdir(repo);
  await mkdir(sessions);
  await git(repo, ["init", "--initial-branch=main"]);
  for (const [key, value] of Object.entries({
    "user.name": "Worktree tests",
    "user.email": "worktree@example.invalid",
    "commit.gpgsign": "false",
    "core.hooksPath": path.join(root, "no-hooks"),
    "core.autocrlf": "false",
  })) await git(repo, ["config", key, value]);
  await writeFile(path.join(repo, "tracked.txt"), "initial\n");
  await git(repo, ["add", "."]);
  await git(repo, ["commit", "-m", "Initial"]);

  const source = { id: "source", title: "Source", cwd: repo };
  const tabs = new Map([[source.id, source]]);
  const events = [];
  const creates = [];
  const metadata = [];
  const allowed = [];
  const commands = [];
  const busy = [];
  const boundaryCalls = [];
  let serial = 0;
  const gitMutations = {
    cleanGitBranchName: (branch) => String(branch || "").trim(),
    validateGitBranchName: async (...args) => { boundaryCalls.push(["validateGitBranchName", ...args]); },
    expectedStagedContentHashFromBody: (body) => body.expectedStagedContentHash || "",
    readStagedContentHash: async () => ({ stagedDiff: Buffer.alloc(0), hasStagedChanges: false, stagedContentHash: null }),
    gitWorkflowMessageCwd: (root) => root,
    commitMessagePaths: (root) => ({
      shortPath: path.join(root, "dev", "COMMIT", "staged-commit-short.txt"),
      longPath: path.join(root, "dev", "COMMIT", "staged-commit-long.txt"),
    }),
    requestedRemoteRef: (body) => Object.hasOwn(body, "remoteRef") ? body.remoteRef : null,
    verifyRemoteGitBranchIntent: async (...args) => {
      boundaryCalls.push(["verifyRemoteGitBranchIntent", ...args]);
      return { root: repo, branch: args[1], remoteRef: args[2] };
    },
    runGitWorkflowCommand: async (args, options) => {
      commands.push({ args, options, patch: await readFile(args.at(-1)) });
      const result = await git(options.cwd, args);
      return { ...result, exitCode: 0 };
    },
    requireConfirmed: (body, label) => {
      boundaryCalls.push(["requireConfirmed", body, label]);
      if (body.confirmed !== true) throw httpError(409, "Confirmation required");
    },
    readGitOperationSnapshot: async () => ({ root: repo, branch: "main", operation: "merge", summary: { staged: 1, unstaged: 2 }, conflicts: [{ path: "tracked.txt", status: "UU", preview: "private preview" }] }),
    ...overrides.gitMutations,
  };
  const dependencies = {
    noSession: false,
    getGitRoot: async (cwd) => (await git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim(),
    gitMutations,
    formatGitCommand: (args) => `git ${args.join(" ")}`,
    makeHttpError: httpError,
    sanitizeError: (error) => error.message,
    configuredSessionDir: () => sessions,
    currentSessionState: async (tab) => tab.lastState || {},
    tabRestorableSessionFile: (tab) => tab.sessionFile,
    requireAllowedSessionPath: (file) => {
      allowed.push(file);
      if (!pathInside(sessions, file)) throw httpError(403, "Session path denied");
    },
    getOpenTabs: () => tabs.values(),
    createTab: async (request) => {
      creates.push(request);
      const tab = { id: `created-${++serial}`, title: request.title || "Worktree", ...request, rpc: { send: async () => ({ success: true }) } };
      tabs.set(tab.id, tab);
      return tab;
    },
    tabMeta: ({ rpc, ...tab }) => tab,
    listTabs: () => [...tabs.values()].map(({ id }) => ({ id })),
    scheduleSupervisorMetadataUpdate: (tab) => metadata.push(tab),
    recordEvent: (event) => events.push(event),
    markTabWorking: (tab) => busy.push(["working", tab.id]),
    markTabIdle: (tab) => busy.push(["idle", tab.id]),
    promptRequestTimeoutMs: 4321,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "gitMutations")),
  };
  const service = createGitWorktreeSessionService(dependencies);
  return { root, repo, sessions, source, tabs, events, creates, metadata, allowed, commands, busy, boundaryCalls, gitMutations, dependencies, service };
}

async function stagedSnapshot(repo) {
  const { stdout } = await git(repo, ["diff", "--cached", "--binary", "--full-index"], { encoding: "buffer" });
  return { stagedDiff: stdout, hasStagedChanges: stdout.length > 0, stagedContentHash: stdout.length ? approvedHash : null };
}

async function persistedSource(f) {
  const manager = SessionManager.create(f.repo, f.sessions);
  manager.appendMessage({ role: "user", content: "Preserve this conversation", timestamp: Date.now() });
  f.source.sessionFile = manager.getSessionFile();
  return f.source.sessionFile;
}

async function sessionEntries(file) {
  return (await readFile(file, "utf8")).trimEnd().split("\n").map((line) => JSON.parse(line));
}

test("exports only the six G3 entrypoints and creates an empty persisted session rooted at the worktree", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.service).sort(), ["createGitWorkflowBranchWorktree", "createGitWorktreeTab", "openExistingGitWorktreeTab", "removeGitWorktreeForTab", "openGitConflictResolutionAgentTab", "pruneGitWorktreesData"].sort());
  const result = await f.service.createGitWorktreeTab(f.source, { branch: "feature/empty", sessionMode: "new", title: "Feature" });
  assert.equal(result.created, true);
  assert.equal(result.openedTab, true);
  assert.equal(result.session.mode, "empty");
  const entries = await sessionEntries(result.session.sessionFile);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].type, "session");
  assert.equal(entries[0].cwd, result.worktree.path);
  assert.equal(f.creates[0].titleSource, "explicit");
  assert.equal(f.creates[0].sessionFile, result.session.sessionFile);
  assert.equal(f.tabs.get(result.tab.id).gitWorkspace.commonGitDir, result.commonGitDir);
  assert.match(result.dependencyHint, /node_modules/);
  assert.deepEqual(f.events.map(({ type }) => type), ["webui_worktree_opened", "webui_worktree_created"]);
  assert.equal(f.events[0].sessionMode, "empty");
});

test("fork-current copies persisted conversation into a new session and keeps the source untouched", async (t) => {
  const f = await fixture(t);
  const sourceFile = await persistedSource(f);
  const before = await readFile(sourceFile);
  const result = await f.service.createGitWorktreeTab(f.source, { branchName: "forked" });
  assert.equal(result.session.mode, "fork-current");
  assert.equal(result.session.parentSession, sourceFile);
  assert.notEqual(result.session.sessionFile, sourceFile);
  assert.deepEqual(f.allowed, [sourceFile]);
  const entries = await sessionEntries(result.session.sessionFile);
  assert.equal(entries[0].cwd, result.worktree.path);
  assert.equal(entries[0].parentSession, sourceFile);
  assert.ok(entries.some(({ message }) => message?.content === "Preserve this conversation"));
  assert.deepEqual(await readFile(sourceFile), before);
});

test("fork uses last state after RPC state failure, then the restorable session fallback", async (t) => {
  const f = await fixture(t, { currentSessionState: async () => { throw new Error("RPC gone"); } });
  const sourceFile = await persistedSource(f);
  f.source.lastState = { sessionFile: sourceFile };
  const first = await f.service.createGitWorktreeTab(f.source, { branch: "last-state", sessionMode: "fork" });
  assert.equal(first.session.parentSession, sourceFile);
  delete f.source.lastState;
  const second = await f.service.createGitWorktreeTab(f.source, { branch: "restorable" });
  assert.equal(second.session.parentSession, sourceFile);
});

test("unpersisted or missing source sessions open an empty header with a warning", async (t) => {
  const f = await fixture(t);
  for (const branch of ["unpersisted", "missing-file"]) {
    if (branch === "missing-file") f.source.sessionFile = path.join(f.sessions, "missing.jsonl");
    const result = await f.service.createGitWorktreeTab(f.source, { branch });
    assert.equal(result.session.mode, "empty");
    assert.equal(result.session.requestedMode, "fork-current");
    assert.match(result.session.warning, /not persisted/);
    assert.equal((await sessionEntries(result.session.sessionFile)).length, 1);
  }
});

test("no-session bypasses mode validation and creates no session file", async (t) => {
  const f = await fixture(t, { noSession: true, configuredSessionDir: () => { throw new Error("Must not access sessions"); } });
  const result = await f.service.createGitWorktreeTab(f.source, { branch: "ephemeral", sessionMode: "unsupported" });
  assert.deepEqual(result.session, { mode: "none", requestedMode: "none", sessionFile: undefined, warning: "Web UI was started with --no-session." });
  assert.equal(f.creates[0].sessionFile, undefined);
  assert.deepEqual(await readdir(f.sessions), []);
});

test("opening current or existing tabs mutates their real metadata without creating sessions", async (t) => {
  const f = await fixture(t);
  const current = await f.service.openExistingGitWorktreeTab(f.source, { path: f.repo });
  assert.equal(current.openedCurrent, true);
  assert.equal(current.openedTab, false);
  assert.equal(f.source.gitWorkspace.isMainWorktree, true);
  const created = await f.service.createGitWorktreeTab(f.source, { branch: "reused", sessionMode: "empty" });
  const sessionBefore = await readFile(created.session.sessionFile);
  const reused = await f.service.openExistingGitWorktreeTab(f.source, { worktreePath: created.worktree.path, sessionMode: "unsupported" });
  assert.equal(reused.openedExistingTab, true);
  assert.equal(reused.tab.id, created.tab.id);
  assert.deepEqual(f.metadata, [f.source, f.tabs.get(created.tab.id)]);
  assert.equal(f.creates.length, 1);
  assert.deepEqual(await readFile(created.session.sessionFile), sessionBefore);
  const unopened = await f.service.createGitWorktreeTab(f.source, { branch: "without-tab", openTab: false, sessionMode: "unsupported" });
  assert.equal(unopened.openedTab, false);
  assert.equal(unopened.tab, null);
  assert.equal(unopened.session, null);
  assert.equal(f.creates.length, 1);
});

test("invalid session modes clean up only new worktrees and retain their branches", async (t) => {
  const f = await fixture(t);
  for (const sessionMode of ["clone-current", "parent-only", "garbage"]) {
    const branch = `invalid-${sessionMode}`;
    await assert.rejects(f.service.createGitWorktreeTab(f.source, { branch, sessionMode }), { statusCode: 400 });
    assert.ok(!(await listGitWorktrees(f.repo)).worktrees.some((item) => item.branch === branch));
    await git(f.repo, ["show-ref", "--verify", `refs/heads/${branch}`]);
    assert.equal(f.events.at(-1).cleanup.removed, true);
  }
  assert.equal(f.creates.length, 0);
});

test("session path denial removes a new worktree but preserves a reused worktree", async (t) => {
  const f = await fixture(t);
  const reused = await createGitWorktree(f.repo, { branch: "existing" });
  f.source.sessionFile = path.join(f.root, "denied.jsonl");
  await assert.rejects(f.service.createGitWorktreeTab(f.source, { branch: "new-denied" }), { statusCode: 403 });
  assert.equal(f.events.at(-1).cleanup.removed, true);
  await assert.rejects(f.service.createGitWorktreeTab(f.source, { branch: "existing" }), { statusCode: 403 });
  assert.equal(f.events.at(-1).cleanup, null);
  assert.ok(existsSync(reused.worktree.path));
});

test("tab admission failure keeps newly persisted session files and removes the new worktree", async (t) => {
  const f = await fixture(t, { createTab: async () => { throw new Error("Tab limit reached"); } });
  await assert.rejects(f.service.createGitWorktreeTab(f.source, { branch: "admission", sessionMode: "empty" }), /Tab limit reached/);
  assert.equal(f.events.at(-1).cleanup.removed, true);
  const sessionFiles = await readdir(f.sessions);
  assert.equal(sessionFiles.length, 1);
  assert.equal((await sessionEntries(path.join(f.sessions, sessionFiles[0]))).length, 1);
  await git(f.repo, ["show-ref", "--verify", "refs/heads/admission"]);
});

test("guided workflow copies raw staged binary bytes and root message files while preserving source state", async (t) => {
  const f = await fixture(t);
  const binary = Buffer.from([0, 255, 254, 128, 1, 10, 0, 200]);
  await writeFile(path.join(f.repo, "binary.dat"), binary);
  await git(f.repo, ["add", "binary.dat"]);
  await mkdir(path.join(f.repo, "nested"));
  f.source.cwd = path.join(f.repo, "nested");
  await mkdir(path.join(f.repo, "dev", "COMMIT"), { recursive: true });
  const short = "feat: preserve binary\n";
  const long = "Copy binary content without decoding.\n";
  await writeFile(f.gitMutations.commitMessagePaths(f.repo).shortPath, short);
  await writeFile(f.gitMutations.commitMessagePaths(f.repo).longPath, long);
  const snapshot = await stagedSnapshot(f.repo);
  f.gitMutations.readStagedContentHash = async () => snapshot;
  const service = createGitWorktreeSessionService(f.dependencies);
  const result = await service.createGitWorkflowBranchWorktree(f.source, { branch: "binary-workflow", expectedStagedContentHash: approvedHash, sessionMode: "empty" });
  assert.equal(result.carriedStagedChanges, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stderr, "");
  assert.match(result.command, /^git worktree add -b binary-workflow /);
  assert.match(result.stdout, /source checkout was left/);
  assert.deepEqual(await readFile(path.join(result.worktree.path, "binary.dat")), binary);
  assert.deepEqual((await git(result.worktree.path, ["show", ":binary.dat"], { encoding: "buffer" })).stdout, binary);
  assert.deepEqual((await git(f.repo, ["diff", "--cached", "--binary", "--full-index"], { encoding: "buffer" })).stdout, snapshot.stagedDiff);
  assert.equal((await git(f.repo, ["branch", "--show-current"])).stdout.trim(), "main");
  assert.deepEqual(result.copiedMessageFiles, ["dev/COMMIT/staged-commit-short.txt", "dev/COMMIT/staged-commit-long.txt"]);
  assert.equal(await readFile(path.join(result.worktree.path, result.copiedMessageFiles[0]), "utf8"), short);
  assert.equal(await readFile(path.join(result.worktree.path, result.copiedMessageFiles[1]), "utf8"), long);
  assert.deepEqual(f.commands[0].patch, snapshot.stagedDiff);
  assert.equal(existsSync(f.commands[0].args.at(-1)), false);
  assert.equal(f.commands[0].options.timeoutMs, 5 * 60 * 1000);
  assert.deepEqual(f.events.map(({ type }) => type), ["webui_worktree_opened", "webui_worktree_created", "webui_git_workflow_worktree"]);
});

test("each guided snapshot rejects approval drift or a now-clean index before creating a branch", async (t) => {
  const f = await fixture(t);
  let snapshot = { stagedDiff: Buffer.from("changed"), hasStagedChanges: true, stagedContentHash: "b".repeat(64) };
  f.gitMutations.readStagedContentHash = async () => snapshot;
  const service = createGitWorktreeSessionService(f.dependencies);
  for (const branch of ["drifted", "now-clean"]) {
    if (branch === "now-clean") snapshot = { stagedDiff: Buffer.alloc(0), hasStagedChanges: false, stagedContentHash: null };
    await assert.rejects(service.createGitWorkflowBranchWorktree(f.source, { branch, expectedStagedContentHash: approvedHash }), { statusCode: 409 });
    assert.equal((await git(f.repo, ["branch", "--list", branch])).stdout, "");
  }
  assert.equal(f.events.length, 0);
  assert.equal(f.creates.length, 0);
});

test("legacy guided requests accept a clean index and reused worktrees receive no staged or message transfer", async (t) => {
  const f = await fixture(t);
  const created = await f.service.createGitWorkflowBranchWorktree(f.source, { branch: "clean", openTab: false });
  assert.equal(created.carriedStagedChanges, false);
  assert.match(created.stdout, /index was clean/);
  const existing = await createGitWorktree(f.repo, { branch: "reuse-workflow" });
  await writeFile(path.join(existing.worktree.path, "preserved.txt"), "Keep existing changes");
  await mkdir(path.join(f.repo, "dev", "COMMIT"), { recursive: true });
  await writeFile(f.gitMutations.commitMessagePaths(f.repo).shortPath, "Should not transfer");
  f.gitMutations.readStagedContentHash = async () => ({ stagedDiff: Buffer.from("not a real patch"), hasStagedChanges: true, stagedContentHash: approvedHash });
  const result = await createGitWorktreeSessionService(f.dependencies).createGitWorkflowBranchWorktree(f.source, { branch: "reuse-workflow", openTab: false });
  assert.equal(result.created, false);
  assert.equal(result.carriedStagedChanges, false);
  assert.deepEqual(result.copiedMessageFiles, []);
  assert.equal(f.commands.length, 0);
  assert.match(result.stdout, /reused/);
  assert.equal(await readFile(path.join(existing.worktree.path, "preserved.txt"), "utf8"), "Keep existing changes");
  assert.equal(existsSync(path.join(existing.worktree.path, "dev", "COMMIT")), false);
});

test("failed, timed-out, cancelled, and errored applies clean temporary patches and only new worktrees", async (t) => {
  const f = await fixture(t);
  const patchPaths = [];
  f.gitMutations.readStagedContentHash = async () => ({ stagedDiff: Buffer.from([0, 255]), hasStagedChanges: true, stagedContentHash: approvedHash });
  const failures = [
    { exitCode: 1, stderr: "Apply failed" },
    { exitCode: 0, timedOut: true, stderr: "Apply failed" },
    { exitCode: 0, cancelled: true, stdout: "Apply failed" },
    { exitCode: 0, error: "Apply failed" },
  ];
  for (const [index, failure] of failures.entries()) {
    f.gitMutations.runGitWorkflowCommand = async (args) => {
      patchPaths.push(args.at(-1));
      assert.deepEqual(await readFile(args.at(-1)), Buffer.from([0, 255]));
      return failure;
    };
    const branch = `apply-failure-${index}`;
    const service = createGitWorktreeSessionService(f.dependencies);
    await assert.rejects(service.createGitWorkflowBranchWorktree(f.source, { branch }), /Apply failed/);
    assert.equal(existsSync(patchPaths.at(-1)), false);
    assert.equal(f.events.at(-1).cleanup.removed, true);
    assert.equal(f.events.at(-1).type, "webui_git_workflow_worktree_failed");
    await git(f.repo, ["show-ref", "--verify", `refs/heads/${branch}`]);
  }
  assert.equal(f.creates.length, 0);
});

test("a thrown apply error cleans its patch and cleanup failure does not replace the original error", async (t) => {
  const f = await fixture(t);
  let patchPath;
  const original = new Error("Command slot busy");
  f.gitMutations.readStagedContentHash = async () => ({ stagedDiff: Buffer.from("patch"), hasStagedChanges: true, stagedContentHash: approvedHash });
  f.gitMutations.runGitWorkflowCommand = async (args, { cwd }) => {
    patchPath = args.at(-1);
    await git(f.repo, ["worktree", "lock", cwd]);
    throw original;
  };
  await assert.rejects(createGitWorktreeSessionService(f.dependencies).createGitWorkflowBranchWorktree(f.source, { branch: "locked-cleanup" }), (error) => error === original);
  assert.equal(existsSync(patchPath), false);
  const event = f.events.at(-1);
  assert.equal(event.error, original.message);
  assert.equal(event.cleanup.ok, false);
  assert.equal(event.cleanup.code, "GIT_COMMAND_FAILED");
  assert.ok((await listGitWorktrees(f.repo)).worktrees.some(({ branch }) => branch === "locked-cleanup"));
});

test("message transfer refuses paths outside the worktree and leaves the source message intact", async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, "outside-message.txt");
  await writeFile(outside, "Do not overwrite");
  f.gitMutations.commitMessagePaths = () => ({ shortPath: outside, longPath: path.join(f.root, "missing.txt") });
  await assert.rejects(createGitWorktreeSessionService(f.dependencies).createGitWorkflowBranchWorktree(f.source, { branch: "escape", openTab: false }), /outside the worktree/);
  assert.equal(f.events.at(-1).cleanup.removed, true);
  assert.equal(await readFile(outside, "utf8"), "Do not overwrite");
});

test("remote worktree creation retains exact remote tracking intent and fails stale refs without network access", async (t) => {
  const f = await fixture(t);
  await git(f.repo, ["remote", "add", "team/origin", path.join(f.root, "no-network.git")]);
  await git(f.repo, ["update-ref", "refs/remotes/team/origin/feature/remote", "HEAD"]);
  const result = await f.service.createGitWorktreeTab(f.source, { branchName: "feature/remote", remoteRef: "team/origin/feature/remote", openTab: false });
  assert.equal(result.created, true);
  assert.deepEqual(f.boundaryCalls[0], ["verifyRemoteGitBranchIntent", f.repo, "feature/remote", "team/origin/feature/remote"]);
  assert.equal((await git(f.repo, ["config", "branch.feature/remote.remote"])).stdout.trim(), "team/origin");
  assert.equal((await git(f.repo, ["config", "branch.feature/remote.merge"])).stdout.trim(), "refs/heads/feature/remote");
  await assert.rejects(f.service.createGitWorktreeTab(f.source, { branch: "stale", remoteRef: "team/origin/stale", openTab: false }), /Unknown remote git branch/);
  assert.equal(f.events.at(-1).cleanup, null);
});

test("removal requires confirmation and refuses occupied worktrees or descendants even with force and relative paths", async (t) => {
  const f = await fixture(t);
  const created = await createGitWorktree(f.repo, { branch: "busy" });
  await mkdir(path.join(created.worktree.path, "nested"));
  const occupant = { id: "occupant", cwd: created.worktree.path };
  f.tabs.set(occupant.id, occupant);
  await assert.rejects(f.service.removeGitWorktreeForTab(f.source, { path: created.worktree.path }), { statusCode: 409 });
  for (const cwd of [created.worktree.path, path.join(created.worktree.path, "nested")]) {
    occupant.cwd = cwd;
    await assert.rejects(f.service.removeGitWorktreeForTab(f.source, { path: path.relative(f.repo, created.worktree.path), confirmed: true, force: true }), (error) => error.code === "WORKTREE_BUSY" && error.details.tabIds[0] === occupant.id);
    assert.ok(existsSync(created.worktree.path));
  }
  f.tabs.delete(occupant.id);
  const result = await f.service.removeGitWorktreeForTab(f.source, { worktreePath: created.worktree.path, confirmed: true });
  assert.equal(result.removed, true);
  assert.deepEqual(result.tabs, [{ id: f.source.id }]);
  assert.equal(f.events.at(-1).type, "webui_worktree_removed");
});

test("removal recognizes symlink aliases in both request paths and live descendant tabs", async (t) => {
  const f = await fixture(t);
  const created = await createGitWorktree(f.repo, { branch: "alias-busy" });
  await mkdir(path.join(created.worktree.path, "nested"));
  const alias = path.join(f.root, "alias");
  try {
    await symlink(created.worktree.path, alias, "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip(`Directory symlinks unavailable: ${error.code}`);
    throw error;
  }
  f.tabs.set("alias-tab", { id: "alias-tab", cwd: path.join(alias, "nested") });
  for (const requestedPath of [alias, created.worktree.path]) {
    await assert.rejects(f.service.removeGitWorktreeForTab(f.source, { path: requestedPath, confirmed: true, force: true }), { code: "WORKTREE_BUSY" });
  }
});

test("removal retains lower-level dirty and main-worktree guards and supports forced dirty removal", async (t) => {
  const f = await fixture(t);
  const created = await createGitWorktree(f.repo, { branch: "dirty" });
  await writeFile(path.join(created.worktree.path, "untracked.txt"), "dirty");
  await assert.rejects(f.service.removeGitWorktreeForTab(f.source, { path: created.worktree.path, confirmed: true }), { code: "DIRTY_WORKTREE" });
  const removed = await f.service.removeGitWorktreeForTab(f.source, { path: created.worktree.path, confirmed: true, force: true });
  assert.equal(removed.removed, true);
  f.tabs.clear();
  await assert.rejects(f.service.removeGitWorktreeForTab(f.source, { path: f.repo, confirmed: true, force: true }), { code: "IS_MAIN_WORKTREE" });
  await assert.rejects(f.service.openExistingGitWorktreeTab(f.source), { statusCode: 400 });
  await assert.rejects(f.service.removeGitWorktreeForTab(f.source, { confirmed: true }), { statusCode: 400 });
});

test("prune defaults to a read-only preview and requires confirmation before mutating stale records", async (t) => {
  const f = await fixture(t);
  const created = await createGitWorktree(f.repo, { branch: "prunable" });
  await rm(created.worktree.path, { recursive: true, force: true });
  const preview = await f.service.pruneGitWorktreesData(f.repo);
  assert.equal(preview.dryRun, true);
  assert.equal(f.boundaryCalls.length, 0);
  assert.ok((await listGitWorktrees(f.repo)).worktrees.some(({ branch }) => branch === "prunable"));
  await assert.rejects(f.service.pruneGitWorktreesData(f.repo, {}, { dryRun: false }), { statusCode: 409 });
  const result = await f.service.pruneGitWorktreesData(f.repo, { confirmed: true }, { dryRun: false });
  assert.equal(result.dryRun, false);
  assert.ok(!result.worktrees.some(({ branch }) => branch === "prunable"));
  assert.equal(f.boundaryCalls.at(-1)[2], "Pruning stale worktree records");
});

test("conflict agent receives the bounded prompt and preserves tab, event, and operation response metadata", async (t) => {
  const f = await fixture(t);
  let request;
  const create = f.dependencies.createTab;
  f.dependencies.createTab = async (options) => {
    const tab = await create(options);
    tab.rpc.send = async (command, timeout) => { request = { command, timeout }; return { success: true }; };
    return tab;
  };
  const result = await createGitWorktreeSessionService(f.dependencies).openGitConflictResolutionAgentTab(f.source);
  assert.equal(f.creates[0].conversationStarted, true);
  assert.equal(f.creates[0].title, "Resolve merge conflicts");
  assert.equal(f.creates[0].cwd, f.repo);
  assert.equal(request.timeout, 4321);
  assert.equal(request.command.type, "prompt");
  assert.match(request.command.message, /Do not continue, skip, abort, commit, reset, or push the merge/);
  assert.match(request.command.message, /UU "tracked.txt"/);
  assert.deepEqual(f.busy, [["working", result.tab.id]]);
  assert.equal(result.sourceTabId, f.source.id);
  assert.deepEqual(result.operation.conflicts, [{ path: "tracked.txt", status: "UU" }]);
  assert.equal(f.events[0].type, "webui_git_conflict_agent_started");
  assert.equal(f.events[0].conflicts, 1);
});

test("conflict handoff rejects absent, bisect, and already resolved operations before tab creation", async (t) => {
  const f = await fixture(t);
  for (const operation of [{ operation: null }, { operation: "bisect", conflicts: [{}] }, { operation: "merge", conflicts: [] }]) {
    f.gitMutations.readGitOperationSnapshot = async () => operation;
    await assert.rejects(createGitWorktreeSessionService(f.dependencies).openGitConflictResolutionAgentTab(f.source), { statusCode: 409 });
  }
  assert.equal(f.creates.length, 0);
  assert.equal(f.busy.length, 0);
});

test("conflict RPC transport and rejection failures retain their tabs and mark them idle", async (t) => {
  const f = await fixture(t);
  const create = f.dependencies.createTab;
  const transportError = new Error("RPC disconnected");
  for (const failure of [transportError, { success: false, error: "Handoff refused" }, { success: false }]) {
    f.dependencies.createTab = async (options) => {
      const tab = await create(options);
      tab.rpc.send = async () => { if (failure instanceof Error) throw failure; return failure; };
      return tab;
    };
    await assert.rejects(createGitWorktreeSessionService(f.dependencies).openGitConflictResolutionAgentTab(f.source), (error) => failure instanceof Error ? error === failure : error.statusCode === 502 && error.message === (failure.error || "The conflict-resolution agent rejected the handoff prompt"));
    const id = f.busy.at(-1)[1];
    assert.ok(f.tabs.has(id));
    assert.deepEqual(f.busy.slice(-2), [["working", id], ["idle", id]]);
  }
  assert.equal(f.tabs.size, 4);
  assert.equal(f.events.length, 0);
});
