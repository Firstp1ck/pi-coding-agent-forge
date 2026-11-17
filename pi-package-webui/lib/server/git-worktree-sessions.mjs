import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  WORKTREE_ERROR_CODES,
  createGitWorktree,
  openGitWorktree,
  pathInside,
  pruneGitWorktrees,
  removeGitWorktree,
} from "../git-worktrees.mjs";

export function createGitWorktreeSessionService({
  noSession,
  getGitRoot,
  gitMutations,
  formatGitCommand,
  makeHttpError,
  sanitizeError,
  configuredSessionDir,
  currentSessionState,
  tabRestorableSessionFile,
  requireAllowedSessionPath,
  getOpenTabs,
  createTab,
  tabMeta,
  listTabs,
  scheduleSupervisorMetadataUpdate,
  recordEvent,
  markTabWorking,
  markTabIdle,
  promptRequestTimeoutMs,
}) {
  const {
    readGitOperationSnapshot,
    cleanGitBranchName,
    validateGitBranchName,
    expectedStagedContentHashFromBody,
    readStagedContentHash,
    gitWorkflowMessageCwd,
    commitMessagePaths,
    requestedRemoteRef,
    verifyRemoteGitBranchIntent,
    runGitWorkflowCommand,
    requireConfirmed,
  } = gitMutations;

  function sameResolvedPath(left, right) {
    return Boolean(left && right) && path.resolve(left) === path.resolve(right);
  }

  function gitConflictResolutionAgentPrompt(operation) {
    const conflicts = (operation.conflicts || []).map((conflict) => `- ${conflict.status || "UU"} ${JSON.stringify(String(conflict.path || ""))}`);
    const summary = operation.summary || {};
    return [
      `Resolve the current Git ${operation.operation} conflicts in this working tree.`,
      "",
      `Repository root: ${JSON.stringify(String(operation.root || ""))}`,
      `Branch: ${operation.branch || "detached or unknown"}`,
      `Working tree: ${summary.staged || 0} staged, ${summary.unstaged || 0} unstaged, ${conflicts.length} conflicted`,
      "Conflicted files:",
      ...conflicts,
      "",
      "Requirements:",
      "- Inspect git status plus the staged, unstaged, and unmerged diffs before editing.",
      "- Resolve only the currently unmerged files and preserve the intended changes from both sides.",
      "- Stage each resolved file with git add.",
      `- Do not continue, skip, abort, commit, reset, or push the ${operation.operation}.`,
      "- Verify git diff --name-only --diff-filter=U is empty, then report what you resolved and any uncertainty.",
    ].join("\n");
  }

  async function openGitConflictResolutionAgentTab(sourceTab) {
    const operation = await readGitOperationSnapshot(sourceTab.cwd);
    if (!operation.operation || operation.operation === "bisect") throw makeHttpError(409, "No conflict-resolution Git operation is in progress");
    if (!operation.conflicts?.length) throw makeHttpError(409, "No unmerged files remain to send to an agent");

    const targetTab = await createTab({
      title: `Resolve ${operation.operation} conflicts`,
      titleSource: "explicit",
      conversationStarted: true,
      cwd: operation.root,
    });
    const command = { type: "prompt", message: gitConflictResolutionAgentPrompt(operation) };
    markTabWorking(targetTab);
    let response;
    try {
      response = await targetTab.rpc.send(command, promptRequestTimeoutMs);
    } catch (error) {
      markTabIdle(targetTab);
      throw error;
    }
    if (response.success === false) {
      markTabIdle(targetTab);
      throw makeHttpError(502, response.error || "The conflict-resolution agent rejected the handoff prompt");
    }
    recordEvent({
      type: "webui_git_conflict_agent_started",
      sourceTabId: sourceTab.id,
      tabId: targetTab.id,
      cwd: operation.root,
      operation: operation.operation,
      conflicts: operation.conflicts.length,
    });
    return {
      sourceTabId: sourceTab.id,
      tab: tabMeta(targetTab),
      tabs: listTabs(),
      operation: {
        operation: operation.operation,
        root: operation.root,
        branch: operation.branch,
        conflicts: operation.conflicts.map(({ path: conflictPath, status }) => ({ path: conflictPath, status })),
      },
    };
  }

  function normalizeWorktreeSessionMode(value) {
    const mode = String(value || "fork-current").trim().toLowerCase();
    if (!mode || mode === "fork" || mode === "fork-current") return "fork-current";
    if (mode === "empty" || mode === "new") return "empty";
    if (mode === "clone-current" || mode === "parent-only") {
      throw makeHttpError(400, `sessionMode ${mode} is not supported yet; use fork-current or empty.`);
    }
    throw makeHttpError(400, "sessionMode must be fork-current or empty");
  }

  async function createEmptySessionFileForCwd(cwd) {
    const manager = SessionManager.create(cwd, configuredSessionDir());
    const sessionFile = manager.getSessionFile();
    const header = manager.getHeader();
    if (!sessionFile || !header) return undefined;
    await mkdir(path.dirname(sessionFile), { recursive: true });
    await writeFile(sessionFile, `${JSON.stringify(header)}\n`, { encoding: "utf8", flag: "wx" });
    return sessionFile;
  }

  async function prepareWorktreeSessionFile(sourceTab, targetCwd, requestedMode = "fork-current") {
    if (noSession) return { mode: "none", requestedMode: "none", sessionFile: undefined, warning: "Web UI was started with --no-session." };
    const mode = normalizeWorktreeSessionMode(requestedMode);
    if (mode === "empty") {
      return { mode, requestedMode: mode, sessionFile: await createEmptySessionFileForCwd(targetCwd) };
    }

    const state = await currentSessionState(sourceTab).catch(() => sourceTab?.lastState || {});
    const sourceSessionFile = state.sessionFile || tabRestorableSessionFile(sourceTab);
    if (sourceSessionFile) {
      requireAllowedSessionPath(sourceSessionFile);
      const sourceInfo = await stat(sourceSessionFile).catch(() => null);
      if (sourceInfo?.isFile()) {
        const manager = SessionManager.forkFrom(sourceSessionFile, targetCwd, configuredSessionDir());
        return { mode, requestedMode: mode, sessionFile: manager.getSessionFile(), parentSession: sourceSessionFile };
      }
    }

    return {
      mode: "empty",
      requestedMode: mode,
      sessionFile: await createEmptySessionFileForCwd(targetCwd),
      warning: "Current session is not persisted yet; opened an empty session rooted at the worktree.",
    };
  }

  function gitWorkspaceFromWorktreeResult(result, worktree = result?.worktree) {
    if (!worktree?.path) return null;
    return {
      repoRoot: result.repoRoot || worktree.repoRoot || "",
      commonGitDir: result.commonGitDir || worktree.commonGitDir || "",
      worktreePath: worktree.path,
      branch: worktree.branch || result.branch || null,
      worktreeCount: Array.isArray(result.worktrees) ? result.worktrees.length : undefined,
      isMainWorktree: worktree.isMainWorktree === true,
    };
  }

  async function openWorktreeResultForTab(sourceTab, result, body = {}) {
    const worktree = result?.worktree;
    const worktreePath = worktree?.path || result?.path;
    if (!worktreePath) throw makeHttpError(500, "Git worktree operation did not return a path");
    if (body.openTab === false) return { ...result, session: null, tab: null, tabs: listTabs(), openedTab: false };

    if (sameResolvedPath(worktreePath, sourceTab.cwd)) {
      sourceTab.gitWorkspace = gitWorkspaceFromWorktreeResult(result, worktree);
      scheduleSupervisorMetadataUpdate(sourceTab);
      return { ...result, session: null, tab: tabMeta(sourceTab), tabs: listTabs(), openedTab: false, openedCurrent: true };
    }

    const existingTab = [...getOpenTabs()].find((item) => sameResolvedPath(item.cwd, worktreePath));
    if (existingTab) {
      existingTab.gitWorkspace = gitWorkspaceFromWorktreeResult(result, worktree);
      scheduleSupervisorMetadataUpdate(existingTab);
      return { ...result, session: null, tab: tabMeta(existingTab), tabs: listTabs(), openedTab: false, openedExistingTab: true };
    }

    const session = await prepareWorktreeSessionFile(sourceTab, worktreePath, body.sessionMode || "fork-current");
    const tab = await createTab({
      title: body.title,
      titleSource: body.title ? "explicit" : undefined,
      cwd: worktreePath,
      sessionFile: session.sessionFile,
      gitWorkspace: gitWorkspaceFromWorktreeResult(result, worktree),
    });
    recordEvent({ type: "webui_worktree_opened", tabId: tab.id, tabTitle: tab.title, cwd: tab.cwd, branch: worktree.branch || result.branch || "", sessionMode: session.mode });
    return {
      ...result,
      session,
      tab: tabMeta(tab),
      tabs: listTabs(),
      openedTab: true,
      dependencyHint: "Git worktrees do not share ignored dependency directories such as node_modules or .venv; install/bootstrap dependencies manually if needed.",
    };
  }

  async function cleanupCreatedWorktreeAfterFailure(sourceCwd, worktreePath) {
    try {
      return await removeGitWorktree(sourceCwd, worktreePath, { force: true });
    } catch (error) {
      return { ok: false, error: sanitizeError(error), code: error?.code || WORKTREE_ERROR_CODES.GIT_COMMAND_FAILED };
    }
  }

  async function readGitWorkflowMessageFilesForTransfer(root, messageCwd = root) {
    const { shortPath, longPath } = commitMessagePaths(messageCwd);
    const files = [];
    for (const sourcePath of [shortPath, longPath]) {
      try {
        const content = await readFile(sourcePath, "utf8");
        files.push({ relativePath: path.relative(root, sourcePath).split(path.sep).join("/"), content });
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return files;
  }

  async function snapshotGitWorkflowBranchState(root, cwd = root, expectedStagedContentHash = "") {
    const messageCwd = gitWorkflowMessageCwd(root, cwd);
    // Preserve raw patch bytes: string decoding would corrupt binary staged
    // changes before `git apply --index` can copy them to the PR worktree.
    const staged = await readStagedContentHash(root);
    if (expectedStagedContentHash && (!staged.hasStagedChanges || staged.stagedContentHash !== expectedStagedContentHash)) {
      throw makeHttpError(409, "Staged content changed after manual approval. Return to Stage and request a new manual review before creating a PR worktree.");
    }
    return {
      stagedPatch: staged.stagedDiff,
      stagedContentHash: staged.stagedContentHash,
      messageFiles: await readGitWorkflowMessageFilesForTransfer(root, messageCwd),
    };
  }

  async function applyGitWorkflowBranchStateToWorktree(snapshot, worktreePath) {
    const copiedMessageFiles = [];
    let appliedStagedPatch = false;
    const patchBytes = Buffer.isBuffer(snapshot?.stagedPatch) ? snapshot.stagedPatch : Buffer.alloc(0);
    if (patchBytes.length > 0) {
      const patchPath = path.join(tmpdir(), `pi-webui-staged-worktree-${process.pid}-${Date.now()}-${randomUUID()}.patch`);
      try {
        await writeFile(patchPath, patchBytes);
        const applyResult = await runGitWorkflowCommand(["apply", "--index", "--whitespace=nowarn", patchPath], {
          cwd: worktreePath,
          label: "git apply --index <staged diff>",
          timeoutMs: 5 * 60 * 1000,
        });
        if (applyResult.exitCode !== 0 || applyResult.timedOut || applyResult.cancelled || applyResult.error) {
          throw new Error((applyResult.stderr || applyResult.stdout || applyResult.error || "Unable to apply staged changes in the PR worktree").trim());
        }
        appliedStagedPatch = true;
      } finally {
        await rm(patchPath, { force: true }).catch(() => {});
      }
    }

    for (const file of snapshot?.messageFiles || []) {
      const relativePath = String(file.relativePath || "").replace(/\\/g, "/");
      const targetPath = path.resolve(worktreePath, relativePath);
      if (!relativePath || !pathInside(worktreePath, targetPath)) throw new Error(`Refusing to copy Git workflow file outside the worktree: ${relativePath}`);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await writeFile(targetPath, file.content, "utf8");
      copiedMessageFiles.push(relativePath);
    }

    return { appliedStagedPatch, copiedMessageFiles };
  }

  function gitWorkflowBranchWorktreeStdout({ branch, worktreePath, createdResult, opened, transfer }) {
    const lines = [];
    if (createdResult?.created) lines.push(`Created branch worktree ${branch} at ${worktreePath}.`);
    else if (createdResult?.openedExisting) lines.push(`Opened existing branch worktree ${branch} at ${worktreePath}.`);
    else lines.push(`Opened branch worktree ${branch} at ${worktreePath}.`);
    if (transfer?.appliedStagedPatch) lines.push("Copied the source checkout's staged changes into the worktree index.");
    else if (createdResult?.openedExisting) lines.push("Existing worktree was reused; source staged changes were not copied automatically.");
    else lines.push("No staged changes were copied because the source index was clean.");
    if (transfer?.copiedMessageFiles?.length) lines.push(`Copied ${transfer.copiedMessageFiles.join(", ")} for commit message selection.`);
    if (opened?.tab?.id) lines.push(`Continue the guided Git workflow in Web UI tab ${opened.tab.title || opened.tab.id}.`);
    lines.push("The source checkout was left on its current branch.");
    return lines.join("\n");
  }

  async function createGitWorkflowBranchWorktree(tab, body = {}) {
    const root = await getGitRoot(tab.cwd);
    const branch = cleanGitBranchName(body.branch || body.branchName);
    await validateGitBranchName(root, branch);
    const expectedStagedContentHash = expectedStagedContentHashFromBody(body);
    const snapshot = await snapshotGitWorkflowBranchState(root, tab.cwd, expectedStagedContentHash);
    let createdResult = null;
    try {
      createdResult = await createGitWorktree(tab.cwd, { ...body, branchName: branch });
      const worktreePath = createdResult.worktree?.path || createdResult.path;
      if (!worktreePath) throw makeHttpError(500, "Git workflow worktree creation did not return a path");
      const transfer = createdResult.created
        ? await applyGitWorkflowBranchStateToWorktree(snapshot, worktreePath)
        : { appliedStagedPatch: false, copiedMessageFiles: [] };
      const opened = await openWorktreeResultForTab(tab, createdResult, { openTab: body.openTab !== false, sessionMode: body.sessionMode || "fork-current", ...body });
      if (createdResult.created) {
        recordEvent({ type: "webui_worktree_created", tabId: opened.tab?.id || tab.id, cwd: opened.worktree?.path || opened.path, branch });
      }
      recordEvent({ type: "webui_git_workflow_worktree", tabId: opened.tab?.id || tab.id, cwd: worktreePath, branch, transferredStagedChanges: transfer.appliedStagedPatch });
      return {
        ...opened,
        command: createdResult.created ? formatGitCommand(["worktree", "add", "-b", branch, worktreePath]) : formatGitCommand(["worktree", "list", "--porcelain"]),
        stdout: gitWorkflowBranchWorktreeStdout({ branch, worktreePath, createdResult, opened, transfer }),
        stderr: "",
        exitCode: 0,
        branch: opened.branch || branch,
        carriedStagedChanges: transfer.appliedStagedPatch,
        copiedMessageFiles: transfer.copiedMessageFiles,
      };
    } catch (error) {
      let cleanup = null;
      const createdPath = createdResult?.created && !createdResult?.openedExisting ? createdResult.worktree?.path || createdResult.path : "";
      if (createdPath) cleanup = await cleanupCreatedWorktreeAfterFailure(tab.cwd, createdPath);
      recordEvent({ type: "webui_git_workflow_worktree_failed", tabId: tab.id, cwd: createdPath || tab.cwd, branch, error: sanitizeError(error), cleanup });
      throw error;
    }
  }

  async function createGitWorktreeTab(tab, body = {}) {
    const remoteRef = requestedRemoteRef(body);
    const worktreeRequest = remoteRef === null
      ? body
      : { ...body, branchName: (await verifyRemoteGitBranchIntent(tab.cwd, body.branchName || body.branch, remoteRef)).branch, remoteRef };
    let createdResult = null;
    try {
      createdResult = await createGitWorktree(tab.cwd, worktreeRequest);
      const opened = await openWorktreeResultForTab(tab, createdResult, { openTab: body.openTab !== false, ...body });
      if (createdResult.created) {
        recordEvent({ type: "webui_worktree_created", tabId: opened.tab?.id || tab.id, cwd: opened.worktree?.path || opened.path, branch: opened.branch || body.branchName || "" });
      }
      return opened;
    } catch (error) {
      let cleanup = null;
      const createdPath = createdResult?.created && !createdResult?.openedExisting ? createdResult.worktree?.path || createdResult.path : "";
      if (createdPath) cleanup = await cleanupCreatedWorktreeAfterFailure(tab.cwd, createdPath);
      recordEvent({ type: "webui_worktree_create_failed", tabId: tab.id, cwd: createdPath || tab.cwd, branch: body.branchName || body.branch || "", error: sanitizeError(error), cleanup });
      throw error;
    }
  }

  async function openExistingGitWorktreeTab(tab, body = {}) {
    const requestedPath = String(body.path || body.worktreePath || "").trim();
    if (!requestedPath) throw makeHttpError(400, "worktree path is required");
    const result = await openGitWorktree(tab.cwd, requestedPath);
    return openWorktreeResultForTab(tab, result, { openTab: body.openTab !== false, ...body });
  }

  async function openTabsInsideWorktree(worktreePath) {
    const activeTabs = [];
    for (const tab of getOpenTabs()) {
      const cwd = await realpath(tab.cwd).catch(() => path.resolve(tab.cwd));
      if (pathInside(worktreePath, cwd)) activeTabs.push(tab);
    }
    return activeTabs;
  }

  async function removeGitWorktreeForTab(tab, body = {}) {
    if (body.confirmed !== true) throw makeHttpError(409, "Removing a worktree requires confirmed: true because it deletes files under the worktree path.");
    const requestedPath = String(body.path || body.worktreePath || "").trim();
    if (!requestedPath) throw makeHttpError(400, "worktree path is required");
    const existing = await openGitWorktree(tab.cwd, requestedPath);
    const worktreePath = existing.worktree.path;
    const activeTabs = await openTabsInsideWorktree(worktreePath);
    if (activeTabs.length) {
      const error = makeHttpError(409, `Refusing to remove a worktree that is open in ${activeTabs.length} Web UI tab${activeTabs.length === 1 ? "" : "s"}.`);
      error.code = WORKTREE_ERROR_CODES.WORKTREE_BUSY;
      error.details = { path: requestedPath, tabIds: activeTabs.map((item) => item.id) };
      throw error;
    }
    const result = await removeGitWorktree(tab.cwd, worktreePath, { force: body.force === true });
    recordEvent({ type: "webui_worktree_removed", tabId: tab.id, cwd: result.path || requestedPath, branch: result.branch || "" });
    return { ...result, tabs: listTabs() };
  }

  async function pruneGitWorktreesData(cwd, body = {}, { dryRun = true } = {}) {
    if (!dryRun) requireConfirmed(body, "Pruning stale worktree records");
    return pruneGitWorktrees(cwd, { dryRun });
  }

  return {
    createGitWorkflowBranchWorktree,
    createGitWorktreeTab,
    openExistingGitWorktreeTab,
    removeGitWorktreeForTab,
    openGitConflictResolutionAgentTab,
    pruneGitWorktreesData,
  };
}
