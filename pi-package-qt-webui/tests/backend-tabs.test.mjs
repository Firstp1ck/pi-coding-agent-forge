import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openLocalPath } from "../lib/backend/desktop.mjs";
import { createDirectory, listDirectory } from "../lib/backend/directories.mjs";
import { createWorktree, defaultWorktreePath, listWorktrees, removeWorktree, runGit, validateBranchName } from "../lib/backend/git.mjs";
import { LIMITS, validateRequest } from "../lib/backend/protocol.mjs";
import { listSessions, sessionDirectoryFor } from "../lib/backend/sessions-index.mjs";
import { createTranscriptMirror, rowsFromHistory } from "../lib/backend/transcript.mjs";
import { startBackend } from "./helpers/backend-client.mjs";

async function waitForAsync(check, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${description}`);
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", HOME: os.tmpdir() };

async function temporary(t, prefix = "qt-webui-tabs-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

async function makeRepository(t, name = "repo") {
  const base = await temporary(t);
  const root = path.join(base, name);
  await mkdir(root);
  git(root, "init", "-q", "-b", "main");
  await writeFile(path.join(root, "README.md"), "hello\n");
  git(root, "add", "README.md");
  git(root, "commit", "-q", "-m", "init");
  return { base, root };
}

function sessionLine(entry) {
  return `${JSON.stringify(entry)}\n`;
}

async function writeSession(directory, fileName, { id, cwd, name, messages = [], timestamp = "2026-08-01T00:00:00.000Z" }) {
  const lines = [sessionLine({ type: "session", version: 3, id, timestamp, cwd })];
  if (name !== undefined) lines.push(sessionLine({ type: "session_info", id: `${id}-info`, parentId: null, timestamp, name }));
  messages.forEach((message, index) => lines.push(sessionLine({ type: "message", id: `${id}-${index}`, parentId: null, timestamp, message })));
  await mkdir(directory, { recursive: true });
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, lines.join(""));
  return filePath;
}

// ---- transcript ----------------------------------------------------------------------------

test("transcript mirror follows live events and history translates every message role", () => {
  const mirror = createTranscriptMirror({ maxRows: 2 });
  mirror.apply("message.user", { messageId: "u1", text: "hi", mode: "send", attachments: ["a.txt"] });
  mirror.apply("part.begin", { messageId: "a1", partId: "a1.1", partKind: "text" });
  mirror.apply("part.render", { messageId: "a1", partId: "a1.1", partKind: "text", text: "**bold**", blocks: [{ type: "paragraph", styled: "<b>bold</b>" }], final: true });
  mirror.apply("tool.start", { toolCallId: "t1", name: "bash", summary: "command=ls", messageId: "a1" });
  mirror.apply("tool.update", { toolCallId: "t1", output: "partial" });
  mirror.apply("tool.end", { toolCallId: "t1", name: "bash", ok: false, durationMs: 12, output: "boom", error: "boom" });
  const rows = mirror.rows();
  assert.deepEqual(rows.map((row) => [row.rowId, row.kind]), [["a1.1", "text"], ["tool-t1", "tool"]], "the oldest row is evicted at the bound");
  assert.equal(rows[0].blocksJson, JSON.stringify([{ type: "paragraph", styled: "<b>bold</b>" }]));
  assert.equal(rows[0].streaming, false);
  assert.deepEqual({ status: rows[1].toolStatus, output: rows[1].toolOutput, error: rows[1].toolError, duration: rows[1].toolDurationMs }, { status: "error", output: "boom", error: "boom", duration: 12 });
  mirror.apply("part.remove", { partId: "a1.1" });
  assert.equal(mirror.count, 1);
  mirror.apply("transcript.reset", {});
  assert.equal(mirror.count, 0);

  const history = rowsFromHistory([
    { role: "user", content: "q1" },
    { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "# heading" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x" } }], stopReason: "toolUse" },
    { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "out" }], isError: false },
    { role: "bashExecution", command: "ls -la", output: "total 0", exitCode: 1, cancelled: false },
    { role: "assistant", content: [{ type: "text", text: "x".repeat(LIMITS.maxMessageCharacters + 1) }, { type: "toolCall", id: "c2", name: "bash", arguments: {} }], stopReason: "aborted" },
    "junk",
  ]);
  assert.deepEqual(history.rows.map((row) => [row.kind, row.rowId]), [
    ["user", "history-user-1"], ["thinking", "history-2.1"], ["text", "history-2.2"], ["tool", "tool-c1"], ["tool", "history-bash-4"], ["text", "history-5.1"], ["tool", "tool-c2"],
  ]);
  assert.equal(JSON.parse(history.rows[2].blocksJson)[0].type, "heading");
  assert.deepEqual({ status: history.rows[3].toolStatus, output: history.rows[3].toolOutput, summary: history.rows[3].toolSummary }, { status: "ok", output: "out", summary: "path=/x" });
  assert.deepEqual({ status: history.rows[4].toolStatus, error: history.rows[4].toolError }, { status: "error", error: "Exit code 1" });
  assert.equal(history.rows[5].truncated, true);
  assert.equal(history.rows[5].text.length, LIMITS.maxMessageCharacters);
  assert.deepEqual({ status: history.rows[6].toolStatus, error: history.rows[6].toolError }, { status: "error", error: "No result was recorded (interrupted)" });
  assert.equal(history.interrupted, true, "an aborted final reply is interrupted");
  assert.equal(history.messageCount, 5);
  assert.equal(rowsFromHistory([{ role: "user", content: "alone" }]).interrupted, true, "a trailing user message is interrupted");
  assert.equal(rowsFromHistory([{ role: "user", content: "q" }, { role: "assistant", content: "a", stopReason: "stop" }]).interrupted, false);
  const many = rowsFromHistory(Array.from({ length: LIMITS.maxTranscriptRows + 5 }, (_, index) => ({ role: "user", content: `m${index}` })));
  assert.equal(many.rows.length, LIMITS.maxTranscriptRows);
  assert.equal(many.rows[0].text, "m5");
});

// ---- sessions index ------------------------------------------------------------------------

test("session listing matches Pi's directory encoding, reads headers and names, and stays bounded", async (t) => {
  const agentDir = await temporary(t, "qt-webui-agent-");
  const cwd = "/home/someone/project with spaces:x";
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const directory = sessionDirectoryFor(cwd, env);
  const { getDefaultSessionDir } = await import("@earendil-works/pi-coding-agent/dist/core/session-manager.js").catch(() => ({ getDefaultSessionDir: null }));
  if (getDefaultSessionDir) {
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    try {
      assert.equal(directory, getDefaultSessionDir(cwd), "the encoding must match Pi exactly");
    } finally {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    }
  }
  assert.deepEqual(await listSessions(cwd, { env }), { sessions: [], omitted: 0, directory });
  const olderPath = await writeSession(directory, "2026-08-01_older.jsonl", { id: "older", cwd, name: "Older [31mred[0m", messages: [{ role: "user", content: "first  question", timestamp: 9000 }, { role: "assistant", content: "answer", timestamp: 10_000 }] });
  const newerPath = await writeSession(directory, "2026-08-02_newer.jsonl", { id: "newer", cwd, messages: [{ role: "user", content: [{ type: "text", text: "array content" }], timestamp: 1000 }] });
  await utimes(olderPath, new Date(2000), new Date(2000));
  await utimes(newerPath, new Date(5000), new Date(5000));
  await writeFile(path.join(directory, "broken.jsonl"), "{\"type\":\"message\"}\n");
  await writeFile(path.join(directory, "notes.txt"), "ignored");
  await mkdir(path.join(directory, "dir.jsonl"));
  const listed = await listSessions(cwd, { env, now: () => 10_000 });
  assert.deepEqual(listed.sessions.map((session) => [session.id, session.name, session.messageCount, session.firstMessage, session.modified, session.ageMs]), [
    ["newer", "", 1, "array content", 5000, 5000],
    ["older", "Older red", 2, "first question", 2000, 8000],
  ]);
  assert.equal(listed.omitted, 0);
  for (let index = 0; index < LIMITS.maxSessionListEntries; index += 1) await writeSession(directory, `bulk-${String(index).padStart(3, "0")}.jsonl`, { id: `bulk-${index}`, cwd });
  const bounded = await listSessions(cwd, { env });
  assert.equal(bounded.sessions.length, LIMITS.maxSessionListEntries);
  assert.equal(bounded.omitted, 3, "files beyond the bound are counted even when they turn out to be invalid");
});

test("all-project session listing pages every valid session and tolerates duplicate, corrupt, and vanished inputs", async (t) => {
  const agentDir = await temporary(t, "qt-webui-global-agent-");
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const firstCwd = "/work/project-a";
  const secondCwd = "/work/project-b";
  const firstDirectory = sessionDirectoryFor(firstCwd, env);
  const secondDirectory = sessionDirectoryFor(secondCwd, env);
  const expectedIds = [];
  for (let index = 0; index < LIMITS.maxSessionListEntries + 2; index += 1) {
    const cwd = index % 2 === 0 ? firstCwd : secondCwd;
    const directory = index % 2 === 0 ? firstDirectory : secondDirectory;
    const id = `global-${String(index).padStart(3, "0")}`;
    expectedIds.push(id);
    const filePath = await writeSession(directory, `${id}.jsonl`, {
      id,
      cwd,
      name: index === 0 ? "Newest global" : undefined,
      messages: [{ role: "user", content: `question ${index}`, timestamp: 1_000_000 - index }],
    });
    const modified = new Date(1_700_000_000_000 + index * 1_000);
    await utimes(filePath, modified, modified);
  }
  await writeFile(path.join(firstDirectory, "broken.jsonl"), "{not-json}\n");
  await symlink(path.join(firstDirectory, "gone.jsonl"), path.join(firstDirectory, "vanished.jsonl"));
  await symlink(firstDirectory, path.join(agentDir, "sessions", "duplicate-project"));
  const externalDirectory = await temporary(t, "qt-webui-external-sessions-");
  const externalFile = await writeSession(externalDirectory, "external.jsonl", { id: "external-file", cwd: "/outside" });
  await symlink(externalFile, path.join(firstDirectory, "external-file.jsonl"));
  await symlink(externalDirectory, path.join(agentDir, "sessions", "external-project"));

  const firstPage = await listSessions(firstCwd, { env, scope: "all", offset: 0, now: () => 2_000_000_000_000 });
  assert.deepEqual({ scope: firstPage.scope, offset: firstPage.offset, nextOffset: firstPage.nextOffset, total: firstPage.total, omitted: firstPage.omitted }, {
    scope: "all", offset: 0, nextOffset: LIMITS.maxSessionListEntries, total: LIMITS.maxSessionListEntries + 3, omitted: 3,
  });
  const secondPage = await listSessions(firstCwd, { env, scope: "all", offset: firstPage.nextOffset, now: () => 2_000_000_000_000 });
  assert.deepEqual({ offset: secondPage.offset, nextOffset: secondPage.nextOffset, omitted: secondPage.omitted }, {
    offset: LIMITS.maxSessionListEntries, nextOffset: null, omitted: 0,
  });
  const listed = [...firstPage.sessions, ...secondPage.sessions];
  assert.equal(listed.length, expectedIds.length, "corrupt and vanished files are skipped without losing valid sessions");
  assert.equal(new Set(listed.map((session) => session.identity)).size, listed.length, "a symlinked project directory does not duplicate sessions");
  assert.deepEqual(listed.map((session) => session.id).sort(), expectedIds.sort());
  assert.deepEqual(listed.map((session) => session.id), expectedIds.slice().reverse(), "page membership and returned rows use filesystem mtime even when message timestamps invert the boundary");
  assert(listed.every((session, index) => index === 0 || listed[index - 1].modified >= session.modified));
  assert.equal(listed.some((session) => session.id.startsWith("external-")), false, "external file and directory symlinks are skipped");
  assert(listed.some((session) => session.cwd === firstCwd));
  assert(listed.some((session) => session.cwd === secondCwd));
});

test("catalog refresh automatically settles exact-threshold sessions while excluding every open tab", async (t) => {
  const cwd = await temporary(t, "qt-webui-auto-cwd-");
  const agentDir = await temporary(t, "qt-webui-auto-agent-");
  const stateHome = await temporary(t, "qt-webui-auto-state-");
  const now = 2_000_000_000_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const env = { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateHome, QT_WEBUI_SMOKE_NOW_MS: String(now) };
  const directory = sessionDirectoryFor(cwd, env);
  const paths = {
    exact: await writeSession(directory, "exact.jsonl", { id: "exact", cwd }),
    below: await writeSession(directory, "below.jsonl", { id: "below", cwd }),
    changedThreshold: await writeSession(directory, "changed-threshold.jsonl", { id: "changed-threshold", cwd }),
    newer: await writeSession(directory, "newer.jsonl", { id: "newer", cwd }),
    idleOpen: await writeSession(directory, "idle-open.jsonl", { id: "idle-open", cwd }),
    runningOpen: await writeSession(directory, "running-open.jsonl", { id: "running-open", cwd }),
  };
  await utimes(paths.exact, new Date(now - 30 * dayMs), new Date(now - 30 * dayMs));
  await utimes(paths.below, new Date(now - 30 * dayMs + 1), new Date(now - 30 * dayMs + 1));
  await utimes(paths.changedThreshold, new Date(now - 15 * dayMs), new Date(now - 15 * dayMs));
  await utimes(paths.newer, new Date(now - dayMs), new Date(now - dayMs));
  await utimes(paths.idleOpen, new Date(now - 60 * dayMs), new Date(now - 60 * dayMs));
  await utimes(paths.runningOpen, new Date(now - 60 * dayMs), new Date(now - 60 * dayMs));
  const beforeFiles = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, filePath]) => [key, await readFile(filePath, "utf8")])));

  const backend = await readyBackend(t, { cwd, env });
  const idle = await backend.send("tab_open", { cwd, sessionPath: paths.idleOpen });
  await backend.waitForEvent("pi.status", (event) => event.tab === idle.data.tab.id && event.statusKind === "ready");
  const running = await backend.send("tab_open", { cwd, sessionPath: paths.runningOpen });
  await backend.waitForEvent("pi.status", (event) => event.tab === running.data.tab.id && event.statusKind === "ready");
  await backend.waitForEvent("tabs.update", event => event.tabs.some(tab => tab.id === running.data.tab.id && tab.sessionFile === paths.runningOpen && tab.ready && !tab.mutating));
  assert.equal((await backend.send("prompt", { tab: running.data.tab.id, message: "__QT_WEBUI_DELAYED_ABORT__" })).ok, true);
  await backend.waitForEvent("run.start", (event) => event.tab === running.data.tab.id);

  const catalog = await backend.send("sessions_list", { scope: "all" });
  const byId = Object.fromEntries(catalog.data.sessions.map((session) => [session.id, session]));
  assert.equal(byId.exact.settled, true, "the exact elapsed threshold qualifies");
  assert.equal(byId.below.settled, false, "one millisecond below the threshold does not qualify");
  assert.equal(byId["changed-threshold"].settled, false, "the default threshold remains authoritative");
  assert.equal(byId.newer.settled, false, "new activity prevents settlement");
  assert.deepEqual({ settled: byId["idle-open"].settled, openTabId: byId["idle-open"].openTabId }, { settled: false, openTabId: idle.data.tab.id });
  assert.deepEqual({ settled: byId["running-open"].settled, openTabId: byId["running-open"].openTabId }, { settled: false, openTabId: running.data.tab.id });
  assert(catalog.data.sessions.every((session) => !("identity" in session)), "canonical identities remain backend-private");

  const statePath = path.join(stateHome, "qt-webui", "state.json");
  const stateText = await readFile(statePath, "utf8");
  const settlementMetadata = JSON.parse(stateText);
  assert.equal(settlementMetadata.settledSessions.length, 0);
  assert.equal(settlementMetadata.automaticSettledSessions.length, 1);
  const privateMetadataText = JSON.stringify({ settledSessions: settlementMetadata.settledSessions, automaticSettledSessions: settlementMetadata.automaticSettledSessions, sessionRestoreGrace: settlementMetadata.sessionRestoreGrace });
  for (const filePath of Object.values(paths)) assert.equal(privateMetadataText.includes(filePath), false, "private settlement metadata must not leak paths");
  const stateMtime = (await stat(statePath, { bigint: true })).mtimeNs;
  await backend.send("sessions_list", { scope: "all" });
  assert.equal((await stat(statePath, { bigint: true })).mtimeNs, stateMtime, "an unchanged refresh does not rewrite automatic-settlement state");
  assert.equal((await backend.send("settings_set", { values: { sessionSettleDays: 10 } })).data.settings.sessionSettleDays, 10);
  const changedCatalog = await backend.send("sessions_list", { scope: "all" });
  assert.equal(changedCatalog.data.sessions.find((session) => session.id === "changed-threshold").settled, true, "the changed threshold applies on the next catalog refresh");
  for (const [key, filePath] of Object.entries(paths)) assert.equal(await readFile(filePath, "utf8"), beforeFiles[key], `catalog settlement does not change ${filePath}`);
  await backend.send("abort", { tab: running.data.tab.id });
  await backend.waitForEvent("run.end", (event) => event.tab === running.data.tab.id);
});

test("catalog refresh excludes startup resumes and explicit session-switch targets for their full transitions", async (t) => {
  const cwd = await temporary(t, "qt-webui-transition-cwd-");
  const agentDir = await temporary(t, "qt-webui-transition-agent-");
  const now = 2_000_000_000_000;
  const dayMs = 24 * 60 * 60 * 1000;
  const env = { PI_CODING_AGENT_DIR: agentDir, QT_WEBUI_SMOKE_NOW_MS: String(now) };
  const directory = sessionDirectoryFor(cwd, env);
  const startupPath = await writeSession(directory, "startup-resume.jsonl", { id: "startup-resume", cwd });
  const switchPath = await writeSession(directory, "switch-target.jsonl", { id: "switch-target", cwd });
  await utimes(startupPath, new Date(now - 60 * dayMs), new Date(now - 60 * dayMs));
  await utimes(switchPath, new Date(now), new Date(now));

  const backend = await readyBackend(t, { cwd, env });
  const beforeOpen = backend.events.length;
  const opened = await backend.send("tab_open", { cwd, sessionPath: startupPath });
  const tabId = opened.data.tab.id;
  const piPid = opened.data.tab.pid;
  let stopped = false;
  const stopPi = () => {
    process.kill(piPid, "SIGSTOP");
    stopped = true;
  };
  const resumePi = () => {
    if (!stopped) return;
    try {
      process.kill(piPid, "SIGCONT");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    stopped = false;
  };
  t.after(resumePi);

  stopPi();
  const pendingCatalog = await backend.send("sessions_list", { tab: tabId, scope: "all" });
  const pendingRow = pendingCatalog.data.sessions.find((session) => session.id === "startup-resume");
  assert.deepEqual({ settled: pendingRow.settled, openTabId: pendingRow.openTabId }, { settled: false, openTabId: tabId }, "a startup resume remains open while Pi is stopped before completing it");
  assert(pendingCatalog.data.sessions.every((session) => !("identity" in session)), "transition identities remain backend-private");
  resumePi();
  await backend.waitForEvent("pi.runtime", (event) => event.tab === tabId && event.sessionFile === startupPath);
  await backend.send("tabs_list");
  const openingFiles = backend.events.slice(beforeOpen)
    .filter((event) => event.type === "tabs.update")
    .map((event) => event.tabs.find((tab) => tab.id === tabId)?.sessionFile)
    .filter(Boolean);
  assert(openingFiles.length > 0, "opening the saved session publishes its tab summary");
  assert.deepEqual([...new Set(openingFiles)], [startupPath], "every loading summary represents the requested session instead of a temporary blank tab");

  await utimes(switchPath, new Date(now - 60 * dayMs), new Date(now - 60 * dayMs));
  stopPi();
  backend.raw(`${JSON.stringify({ v: 1, id: "transition-switch", type: "session_switch", tab: tabId, sessionPath: switchPath })}\n${JSON.stringify({ v: 1, id: "transition-catalog", type: "sessions_list", tab: tabId, scope: "all" })}\n`);
  const switchingCatalog = await backend.waitFor((record) => record.kind === "response" && record.id === "transition-catalog", "catalog response during session switch");
  assert.equal(switchingCatalog.ok, true, JSON.stringify(switchingCatalog));
  const switchingRow = switchingCatalog.data.sessions.find((session) => session.id === "switch-target");
  assert.deepEqual({ settled: switchingRow.settled, openTabId: switchingRow.openTabId }, { settled: false, openTabId: tabId }, "an explicit switch target remains open until Pi completes the switch");
  assert(switchingCatalog.data.sessions.every((session) => !("identity" in session)), "transition identities never reach catalog rows");
  resumePi();
  const switched = await backend.waitFor((record) => record.kind === "response" && record.id === "transition-switch", "session switch response");
  assert.equal(switched.ok, true, JSON.stringify(switched));
});

test("canonical in-root aliases associate with open tabs and settlement without exposing identity keys", async (t) => {
  const cwd = await temporary(t, "qt-webui-alias-cwd-");
  const agentDir = await temporary(t, "qt-webui-alias-agent-");
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const directory = sessionDirectoryFor(cwd, env);
  const sessionPath = await writeSession(directory, "canonical.jsonl", { id: "canonical", cwd });
  const aliasPath = path.join(directory, "z-alias.jsonl");
  await symlink(sessionPath, aliasPath);

  const backend = await readyBackend(t, { cwd, env });
  const opened = await backend.send("tab_open", { cwd, sessionPath: aliasPath });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await backend.waitForEvent("pi.status", (event) => event.tab === opened.data.tab.id && event.statusKind === "ready");
  const catalog = await backend.send("sessions_list", { scope: "all" });
  assert.equal(catalog.data.sessions.length, 1, "in-root aliases remain deduplicated");
  assert.equal(catalog.data.sessions[0].openTabId, opened.data.tab.id, "canonical identity associates an alias spelling with its open tab");
  assert.equal("identity" in catalog.data.sessions[0], false, "canonical identity remains backend-internal");
  assert.equal((await backend.send("session_settled", { sessionPath: aliasPath, settled: true })).data.settled, true);
  assert.equal((await backend.send("sessions_list", { scope: "all" })).data.sessions[0].settled, true);
});

// ---- directories ---------------------------------------------------------------------------

test("directory listing is bounded, marks hidden and git folders, and folder creation is validated", async (t) => {
  const root = await temporary(t);
  await mkdir(path.join(root, "alpha", ".git"), { recursive: true });
  await mkdir(path.join(root, ".hidden"));
  await mkdir(path.join(root, "beta"));
  await writeFile(path.join(root, "file.txt"), "x");
  await symlink(path.join(root, "beta"), path.join(root, "link-to-beta"));
  const listing = listDirectory(root);
  assert.deepEqual(listing.entries.map((entry) => [entry.name, entry.git, entry.hidden]), [["alpha", true, false], ["beta", false, false], ["link-to-beta", false, false]]);
  assert.equal(listing.hiddenCount, 1);
  assert.equal(listing.parent, path.dirname(await realpath(root)));
  assert.equal(listDirectory(root, { showHidden: true }).entries[0].name, ".hidden");
  assert.equal(listDirectory("~").path, await realpath(os.homedir()));
  assert.throws(() => listDirectory(path.join(root, "file.txt")), /not a folder/);
  assert.throws(() => listDirectory(path.join(root, "missing")), /does not exist: .*missing/);
  assert.throws(() => listDirectory("relative"), /absolute/);
  assert.equal(createDirectory(root, "gamma").path, path.join(await realpath(root), "gamma"));
  assert.throws(() => createDirectory(root, "gamma"), /already exists/);
  for (const bad of ["", "a/b", "..", ".", "a\\b"]) assert.throws(() => createDirectory(root, bad), /cannot be empty or contain slashes/, `name ${JSON.stringify(bad)}`);
  for (let index = 0; index < LIMITS.maxDirectoryEntries + 1; index += 1) await mkdir(path.join(root, "beta", `d${String(index).padStart(4, "0")}`));
  const bounded = listDirectory(path.join(root, "beta"));
  assert.equal(bounded.entries.length, LIMITS.maxDirectoryEntries);
  assert.equal(bounded.omitted, 1);
});

async function realpath(target) {
  const { realpath: real } = await import("node:fs/promises");
  return real(target);
}

// ---- git worktrees -------------------------------------------------------------------------

test("worktree creation validates names, handles spaces, detached HEAD, conflicts, nesting, and rolls back failures", async (t) => {
  const { base, root } = await makeRepository(t, "my repo");
  for (const bad of ["", "bad name", "-lead", "a..b", "x/", "/x", "x.lock", "a@{b", "x".repeat(LIMITS.maxBranchNameCharacters + 1)]) assert.equal(validateBranchName(bad), null, `branch ${JSON.stringify(bad)}`);
  assert.equal(validateBranchName("feature/one-2"), "feature/one-2");
  assert.equal(defaultWorktreePath(root, "feature/x"), path.join(base, "my repo-feature-x"));
  assert.equal((await listWorktrees(root)).length, 1);

  const created = await createWorktree({ cwd: root, branch: "feature/spaces" });
  assert.deepEqual({ branch: created.branch, path: created.path, base: created.base, detached: created.detachedBase }, { branch: "feature/spaces", path: path.join(base, "my repo-feature-spaces"), base: "main", detached: false });
  assert(existsSync(path.join(created.path, "README.md")));
  assert.deepEqual((await listWorktrees(root)).map((entry) => entry.branch).sort(), ["feature/spaces", "main"]);
  await assert.rejects(createWorktree({ cwd: root, branch: "feature/spaces", targetPath: path.join(base, "other") }), /already exists; choose another name/);
  await assert.rejects(createWorktree({ cwd: root, branch: "feature/again", targetPath: created.path }), /already exists$/);
  await assert.rejects(createWorktree({ cwd: root, branch: "bad name" }), /not a valid branch name/);
  await assert.rejects(createWorktree({ cwd: base, branch: "x" }), /not inside a Git repository/);
  await assert.rejects(createWorktree({ cwd: root, branch: "feature/base", base: "no such base" }), /base must be a branch name or commit/);

  const nested = await createWorktree({ cwd: root, branch: "feature/nested", targetPath: ".worktrees/nested one" });
  assert.equal(nested.path, path.join(root, ".worktrees", "nested one"));
  assert((await listWorktrees(root)).some((entry) => entry.path === nested.path));

  git(root, "checkout", "-q", "--detach", "HEAD");
  const detached = await createWorktree({ cwd: root, branch: "feature/from-detached" });
  assert.equal(detached.detachedBase, true);
  assert.match(detached.base, /^[0-9a-f]{7,}$/);

  // A failing `git worktree add` must leave the repository unchanged: no directory, no branch.
  const failing = (command, args, options) => {
    if (args.includes("add")) return spawnSyncLike(128, "fatal: simulated failure\n");
    return spawnSyncLike(null, "", command, args, options);
  };
  await assert.rejects(createWorktree({ cwd: root, branch: "feature/failing", spawnImpl: failing }), /simulated failure\. The repository was left unchanged\./);
  assert(!existsSync(path.join(base, "my repo-feature-failing")));
  assert.equal(git(root, "branch", "--list", "feature/failing"), "");

  const removed = await removeWorktree({ cwd: root, worktreePath: nested.path, force: true });
  assert.equal(removed.path, nested.path);
  assert(!existsSync(nested.path));
  await assert.rejects(removeWorktree({ cwd: root, worktreePath: root }), /main worktree cannot be removed/);

  const timedOut = await runGit(["log"], { cwd: root, timeoutMs: 1, spawnImpl: (command, args, options) => spawnSyncLike(null, "", command, args, { ...options, delayMs: 200 }) });
  assert.equal(timedOut.timedOut, true);
});

// A child process stand-in: either a canned failure or the real git invocation.
function spawnSyncLike(forcedCode, stderrText, command, args, options) {
  const { spawn } = require_child_process();
  if (forcedCode !== null) {
    const { EventEmitter } = require_events();
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from(stderrText));
      child.emit("close", forcedCode);
    });
    return child;
  }
  if (options && options.delayMs) {
    return spawn("sleep", ["1"], { stdio: ["ignore", "pipe", "pipe"] });
  }
  return spawn(command, args, { ...options, env: { ...GIT_ENV, ...options.env } });
}

function require_child_process() {
  return process.getBuiltinModule("node:child_process");
}

function require_events() {
  return process.getBuiltinModule("node:events");
}

// ---- protocol ------------------------------------------------------------------------------

test("validateRequest bounds tab, session, directory, and worktree requests", () => {
  const valid = (type, fields) => validateRequest({ v: 1, id: "x", type, ...fields });
  assert.equal(valid("prompt", { message: "hi", tab: "tab-2" }).tab, "tab-2");
  assert.equal(valid("prompt", { message: "hi" }).tab, undefined);
  assert.throws(() => valid("prompt", { message: "hi", tab: "" }), /tab must be/);
  assert.throws(() => valid("prompt", { message: "hi", tab: "t".repeat(LIMITS.maxTabIdCharacters + 1) }), /tab must be/);
  assert.deepEqual(valid("tab_open", {}), { id: "x", type: "tab_open", cwd: "", sessionPath: "", name: "" });
  assert.equal(valid("tab_open", { cwd: "~/x" }).cwd, "~/x");
  assert.throws(() => valid("tab_open", { cwd: "relative" }), /absolute/);
  assert.throws(() => valid("tab_open", { sessionPath: "rel.jsonl" }), /absolute/);
  assert.equal(valid("tab_close", {}).force, false);
  assert.throws(() => valid("tab_close", { force: "yes" }), /force must be boolean/);
  assert.throws(() => valid("tab_rename", { name: "n".repeat(LIMITS.maxTabNameCharacters + 1) }), (error) => error.code === "limit_exceeded");
  assert.throws(() => valid("tab_move", { delta: 2 }), /delta/);
  assert.deepEqual(valid("sessions_list", {}), { id: "x", type: "sessions_list", scope: "workspace", offset: 0 });
  assert.deepEqual(valid("sessions_list", { scope: "all", offset: 200 }), { id: "x", type: "sessions_list", scope: "all", offset: 200 });
  assert.throws(() => valid("sessions_list", { scope: "project" }), /workspace or all/);
  assert.throws(() => valid("sessions_list", { offset: -1 }), /non-negative safe integer/);
  assert.throws(() => valid("sessions_list", { offset: 1.5 }), /non-negative safe integer/);
  assert.equal(valid("sessions_list", { scope: "all", offset: Number.MAX_SAFE_INTEGER }).offset, Number.MAX_SAFE_INTEGER, "every backend-emitted safe offset remains valid");
  assert.throws(() => valid("sessions_list", { offset: Number.MAX_SAFE_INTEGER + 1 }), /non-negative safe integer/);
  assert.throws(() => valid("session_switch", { sessionPath: "/a/b.txt" }), /\.jsonl/);
  assert.equal(valid("session_switch", { sessionPath: "/a/b.jsonl" }).sessionPath, "/a/b.jsonl");
  assert.deepEqual(valid("session_settled", { sessionPath: "/a/b.jsonl", settled: true }), { id: "x", type: "session_settled", sessionPath: "/a/b.jsonl", settled: true });
  assert.throws(() => valid("session_settled", { sessionPath: "/a/b.txt", settled: true }), /\.jsonl/);
  assert.throws(() => valid("session_settled", { sessionPath: "/a/b.jsonl", settled: "yes" }), /boolean settled/);
  assert.equal(valid("directory_list", {}).showHidden, false);
  assert.throws(() => valid("directory_create", { path: "/a" }), /string name/);
  assert.throws(() => valid("directory_pin", { path: "x" }), /absolute/);
  assert.throws(() => valid("worktree_create", { branch: "b" }), /confirmed: true/);
  assert.deepEqual(valid("worktree_create", { branch: "b", confirmed: true }), { id: "x", type: "worktree_create", branch: "b", base: "", path: "", confirmed: true, openTab: true });
  assert.equal(valid("worktree_create", { branch: "b", confirmed: true, openTab: false }).openTab, false);
});

test("open_path validation, session statistics, recent actions, and diagnostics", async (t) => {
  const root = await temporary(t);
  await writeFile(path.join(root, "SKILL.md"), "# skill\n");
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push([command, args]);
    const { EventEmitter } = process.getBuiltinModule("node:events");
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
  assert.deepEqual(await openLocalPath({ path: path.join(root, "SKILL.md"), spawnImpl }), { delivered: true, path: path.join(root, "SKILL.md") });
  assert.deepEqual(calls, [["xdg-open", [path.join(root, "SKILL.md")]]]);
  assert.match((await openLocalPath({ path: path.join(root, "missing.md"), spawnImpl })).reason, /does not exist/);
  assert.match((await openLocalPath({ path: root, spawnImpl })).reason, /regular files/);
  assert.match((await openLocalPath({ path: "relative.md", spawnImpl })).reason, /absolute/);
  assert.equal(calls.length, 1, "invalid paths never reach xdg-open");
  assert.throws(() => validateRequest({ v: 1, id: "o", type: "open_path", path: "x" }), /absolute/);
  assert.throws(() => validateRequest({ v: 1, id: "r", type: "recent_action", action: "bad key!" }), /plain identifiers/);
  assert.equal(validateRequest({ v: 1, id: "r", type: "recent_action", action: "action:toggle-compact" }).action, "action:toggle-compact");

  const backend = await readyBackend(t, { cwd: root });
  const stats = await backend.send("session_stats");
  assert.deepEqual(stats.data, { userMessages: 3, assistantMessages: 2, toolCalls: 1, totalMessages: 7, tokens: { input: 50_000, output: 10_000, cacheRead: 40_000, cacheWrite: 5_000, total: 105_000 }, cost: 0.45, context: { tokens: 60_000, contextWindow: 200_000, percent: 30 } });
  const suppressed = await backend.send("open_path", { path: path.join(root, "SKILL.md") });
  assert.equal(suppressed.data.suppressed, "smoke-mode");
  assert.deepEqual((await backend.send("recent_action", { action: "action:search" })).data.recentActions, ["action:search"]);
  assert.deepEqual((await backend.send("recent_action", { action: "action:events" })).data.recentActions, ["action:events", "action:search"]);
  assert.deepEqual((await backend.send("hello")).data.recentActions, ["action:events", "action:search"]);
  const diagnostics = await backend.send("diagnostics");
  assert.equal(diagnostics.ok, true);
  assert.equal(diagnostics.data.tabs.tabs.length, 1);
  assert(diagnostics.data.stats.sequence > 0);
  assert.equal(typeof diagnostics.data.paths.state, "string");
  assert.equal(diagnostics.data.limits.maxTabs, LIMITS.maxTabs);
});

// ---- backend integration -------------------------------------------------------------------

async function readyBackend(t, options = {}) {
  const backend = await startBackend({ startupTimeoutMs: 1_000, ...options });
  t.after(async () => {
    if (backend.exit) return;
    backend.kill("SIGKILL");
    await backend.exitPromise;
  });
  await backend.waitForEvent("pi.status", (event) => event.statusKind === "ready");
  return backend;
}

test("tabs run isolated sessions, badge inactive tabs, replay transcripts on select, refuse to close busy tabs, and restore after restart", async (t) => {
  const first = await temporary(t);
  const second = await temporary(t);
  const stateHome = await temporary(t, "qt-webui-state-");
  const backend = await readyBackend(t, { cwd: first, env: { XDG_STATE_HOME: stateHome } });
  const hello = await backend.send("hello");
  assert.equal(hello.data.tabs.tabs.length, 1);
  const firstTab = hello.data.tabs.activeTab;
  assert.equal(hello.data.tabs.tabs[0].cwd, await realpath(first));
  assert(backend.events.every((event) => event.type.startsWith("backend.") || event.type === "tabs.update" || event.type === "transcript.reset" || event.type === "settings.changed" || event.type === "appearance.changed" || event.tab === firstTab), "session events carry the tab id");

  const opened = await backend.send("tab_open", { cwd: second });
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const secondTab = opened.data.tab.id;
  assert.notEqual(secondTab, firstTab);
  assert.equal(opened.data.tab.cwd, await realpath(second));
  await backend.waitForEvent("pi.status", (event) => event.tab === secondTab && event.statusKind === "ready");
  assert.deepEqual((await backend.send("tabs_list")).data.tabs.map((tab) => tab.id), [firstTab, secondTab]);
  assert.equal((await backend.send("tabs_list")).data.activeTab, secondTab);

  // Work in the first (inactive) tab: its events are tagged and its unread badge grows.
  const promptInFirst = await backend.send("prompt", { message: "__QT_WEBUI_IMMEDIATE__", tab: firstTab });
  assert.equal(promptInFirst.ok, true);
  await backend.waitForEvent("pi.status", (event) => event.tab === firstTab && event.statusKind === "ready" && event.seq > backend.events.find((entry) => entry.type === "message.user" && entry.tab === firstTab).seq);
  await backend.send("prompt", { message: "__QT_WEBUI_STREAM__", tab: firstTab });
  await backend.waitForEvent("run.end", (event) => event.tab === firstTab);
  const badges = await backend.waitForEvent("tabs.update", (event) => event.tabs.find((tab) => tab.id === firstTab).unread >= 1 && event.tabs.find((tab) => tab.id === firstTab).needsInput === 5);
  assert.equal(badges.tabs.find((tab) => tab.id === secondTab).unread, 0);
  const secondUser = backend.events.filter((event) => event.type === "message.user");
  assert(secondUser.every((event) => event.tab === firstTab));

  // Selecting the first tab replays its bounded transcript and reports pending dialogs.
  const beforeSelect = backend.events.length;
  const selected = await backend.send("tab_select", { tab: firstTab });
  assert.equal(selected.data.tab.id, firstTab);
  assert.equal(selected.data.session.dialogs.length, 5);
  assert.equal(selected.data.session.statusRecords.length, 4);
  const replayed = backend.events.slice(beforeSelect).filter((event) => event.tab === firstTab && (event.type === "transcript.reset" || event.type === "transcript.row"));
  assert.equal(replayed[0].type, "transcript.reset");
  assert.deepEqual(replayed.slice(1).map((event) => event.row.kind), ["user", "user", "thinking", "text", "tool"]);
  assert.equal(replayed.at(-1).row.toolOutput, "final tool output");
  assert.equal((await backend.send("tabs_list")).data.tabs.find((tab) => tab.id === firstTab).unread, 0);
  for (const id of ["dialog-select", "dialog-confirm", "dialog-input", "dialog-editor", "dialog-cancel"]) await backend.send("extension_response", { requestId: id, cancelled: true, tab: firstTab });

  // A busy tab refuses to close without force; force stops its Pi tree.
  await backend.send("prompt", { message: "__QT_WEBUI_DELAYED_ABORT__", tab: secondTab });
  await backend.waitForEvent("run.start", (event) => event.tab === secondTab);
  const selectedBusy = await backend.send("tab_select", { tab: secondTab });
  assert.equal(selectedBusy.data.tab.id, secondTab);
  const refused = await backend.send("tab_close", { tab: secondTab });
  assert.equal(refused.error.code, "busy");
  const secondPid = (await backend.send("tabs_list")).data.tabs.find((tab) => tab.id === secondTab).pid;
  const closed = await backend.send("tab_close", { tab: secondTab, force: true });
  assert.equal(closed.data.closed, secondTab);
  assert.equal(closed.data.activeTab, "");
  await waitUntil(() => !processAlive(secondPid), "second Pi to exit");
  const tabsWithoutSelection = (await backend.send("tabs_list")).data;
  assert.deepEqual(tabsWithoutSelection.tabs.map((tab) => tab.id), [firstTab]);
  assert.equal(tabsWithoutSelection.activeTab, "");

  // An open inactive session stays available but must be selected explicitly before use.
  const reselected = await backend.send("tab_select", { tab: firstTab });
  assert.equal(reselected.data.tab.id, firstTab);

  // Rename reaches Pi and the saved layout; closing the last tab leaves the workspace empty.
  const renamed = await backend.send("tab_rename", { name: "Renamed tab" });
  assert.deepEqual({ name: renamed.data.tab.name, sessionRenamed: renamed.data.sessionRenamed }, { name: "Renamed tab", sessionRenamed: true });
  await backend.waitForEvent("pi.runtime", (event) => event.tab === firstTab && event.sessionName === "Renamed tab");
  const saved = JSON.parse(await readFile(path.join(stateHome, "qt-webui", "state.json"), "utf8"));
  assert.deepEqual(saved.tabs.map(({ draftId, ...tab }) => tab), [{ cwd: await realpath(first), sessionFile: "", name: "Renamed tab" }], "the fixture's unsaved runtime filename is not a durable resume target");
  assert.equal(saved.tabs[0].draftId, reselected.data.tab.draftId, "the unsaved owner is saved with the tab");
  const lastClosed = await backend.send("tab_close", {});
  assert.equal(lastClosed.data.closed, firstTab);
  const emptyTabs = (await backend.send("tabs_list")).data;
  assert.deepEqual(emptyTabs.tabs, []);
  assert.equal(emptyTabs.activeTab, "");
  const emptyCatalog = await backend.send("sessions_list", { scope: "all", offset: 0 });
  assert.equal(emptyCatalog.ok, true, JSON.stringify(emptyCatalog));
  assert.equal(emptyCatalog.data.current, "");
  assert.equal(emptyCatalog.data.cwd, await realpath(first));
  const emptySaved = JSON.parse(await readFile(path.join(stateHome, "qt-webui", "state.json"), "utf8"));
  assert.deepEqual({ tabs: emptySaved.tabs, activeTab: emptySaved.activeTab }, { tabs: [], activeTab: -1 });
  const captured = await backend.readCapture();
  assert.deepEqual(captured.filter((command) => command.type === "set_session_name").map((command) => command.name), ["Renamed tab"]);
  await backend.send("shutdown");
  await backend.exitPromise;

  // Restarting an intentionally empty workspace does not create a replacement session.
  const emptyRestarted = await startBackend({ cwd: first, env: { XDG_STATE_HOME: stateHome }, startupTimeoutMs: 1_000 });
  t.after(async () => {
    if (emptyRestarted.exit) return;
    emptyRestarted.kill("SIGKILL");
    await emptyRestarted.exitPromise;
  });
  const restoredEmpty = await emptyRestarted.waitForEvent("tabs.update", (event) => event.tabs.length === 0 && event.activeTab === "");
  assert.deepEqual(restoredEmpty.tabs, []);
  const emptyHello = await emptyRestarted.send("hello");
  assert.equal(emptyHello.data.session, null);
  assert.deepEqual(emptyHello.data.attachments, []);
  const restoredEmptyCatalog = await emptyRestarted.send("sessions_list", { scope: "all", offset: 0 });
  assert.equal(restoredEmptyCatalog.ok, true, JSON.stringify(restoredEmptyCatalog));
  assert.equal(restoredEmptyCatalog.data.current, "");
  await emptyRestarted.send("shutdown");
  await emptyRestarted.exitPromise;

  // Existing state still restores saved tabs, skips vanished directories, and selects the caller.
  await writeFile(path.join(stateHome, "qt-webui", "state.json"), JSON.stringify({ tabs: [{ cwd: await realpath(second), sessionFile: "/tmp/resume-me.jsonl", name: "Second" }, { cwd: path.join(first, "gone") }], activeTab: 0 }));
  await writeFile("/tmp/resume-me.jsonl", "{\"type\":\"session\",\"id\":\"resume-me\"}\n");
  t.after(() => rm("/tmp/resume-me.jsonl", { force: true }));
  const restarted = await startBackend({ cwd: first, env: { XDG_STATE_HOME: stateHome }, startupTimeoutMs: 1_000 });
  t.after(async () => {
    if (restarted.exit) return;
    restarted.kill("SIGKILL");
    await restarted.exitPromise;
  });
  const tabsAfter = await restarted.waitForEvent("tabs.update", (event) => event.tabs.length === 2);
  assert.deepEqual(tabsAfter.tabs.map((tab) => [tab.cwd, tab.name]), [[await realpath(second), "Second"], [await realpath(first), ""]]);
  assert.equal(tabsAfter.activeTab, tabsAfter.tabs[1].id, "the launch directory is selected");
  await restarted.waitForEvent("notice", (event) => /folder no longer exists/.test(event.message));
  const resumedTab = tabsAfter.tabs[0].id;
  await restarted.waitForEvent("pi.runtime", (event) => event.tab === resumedTab && event.sessionFile === "/tmp/resume-me.jsonl", 10_000);
  const rows = restarted.events.filter((event) => event.type === "transcript.row" && event.tab === resumedTab);
  assert.deepEqual(rows.map((event) => event.row.kind), ["user", "thinking", "text", "tool", "text"], "the restored tab resumed its session history");
  await restarted.send("shutdown");
  await restarted.exitPromise;
});

test("broader resource profiles reconcile every idle matching tab before commit and the next turn sees them", async (t) => {
  const first = await temporary(t);
  const second = await temporary(t);
  const backend = await readyBackend(t, { cwd: first });
  const hello = await backend.send("hello");
  const firstTab = hello.data.tabs.activeTab;
  assert.equal((await backend.send("tools_set", { tab: firstTab, scope: "session", enabledTools: [] })).ok, true);

  const opened = await backend.send("tab_open", { cwd: second });
  const secondTab = opened.data.tab.id;
  await backend.waitForEvent("pi.status", (event) => event.tab === secondTab && event.statusKind === "ready");

  const global = await backend.send("skills_set", { tab: firstTab, scope: "global", enabledSkills: ["review"] });
  assert.equal(global.ok, true, JSON.stringify(global));
  const exactModel = await backend.send("tools_set", { tab: firstTab, scope: "model", enabledTools: ["write"] });
  assert.equal(exactModel.ok, true, JSON.stringify(exactModel));

  // No tab selection and no resources_state refresh occurs before this turn in the other tab.
  const beforeTurn = backend.events.length;
  assert.equal((await backend.send("prompt", { tab: secondTab, message: "__QT_WEBUI_EFFECTIVE__" })).ok, true);
  const applied = await backend.waitForEvent("extension.notify", (event) => event.seq > (backend.events[beforeTurn - 1]?.seq || 0)
    && event.tab === secondTab && event.message.startsWith("QT_WEBUI_HELPER_EFFECTIVE "));
  assert.deepEqual(JSON.parse(applied.message.slice("QT_WEBUI_HELPER_EFFECTIVE ".length)), {
    tools: ["write"], skills: ["review"], sampling: {},
  });
  await backend.waitForEvent("pi.status", (event) => event.tab === secondTab && event.statusKind === "ready" && event.seq > applied.seq);

  const secondState = await backend.send("resources_state", { tab: secondTab });
  assert.deepEqual(secondState.data.profiles.session.tools, null);
  assert.deepEqual(secondState.data.effective.tools, ["write"]);
  assert.deepEqual(secondState.data.effective.skills, ["review"]);
  assert.equal(secondState.data.effective.skillsSource, "global");
  assert.equal((await backend.send("tools_set", { tab: secondTab, scope: "session", enabledTools: ["write"] })).ok, true);

  const firstState = await backend.send("resources_state", { tab: firstTab });
  assert.deepEqual(firstState.data.profiles.session.tools, []);
  assert.deepEqual(firstState.data.effective.tools, []);
  const secondAgain = await backend.send("resources_state", { tab: secondTab });
  assert.deepEqual(secondAgain.data.profiles.session.tools, ["write"]);

  await backend.send("prompt", { message: "__QT_WEBUI_DELAYED_ABORT__", tab: secondTab });
  await backend.waitForEvent("run.start", (event) => event.tab === secondTab);
  const refused = await backend.send("skills_set", { tab: firstTab, scope: "global", enabledSkills: [] });
  assert.equal(refused.error.code, "busy", "a broader change is refused while any affected tab is active");
  await backend.send("abort", { tab: secondTab });
  await backend.waitForEvent("run.end", (event) => event.tab === secondTab);
  assert(backend.events.filter((event) => event.type === "resources.changed").every((event) => event.tab === firstTab || event.tab === secondTab));
});

test("committed broader profiles reconcile retained tools against each affected tab's inventory", async (t) => {
  const first = await temporary(t, "qt-webui-resources-common-");
  const second = await temporary(t, "qt-webui-resources-project-tool-");
  const backend = await readyBackend(t, {
    cwd: first,
    env: {
      QT_WEBUI_FIXTURE_EXTRA_TOOL_CWD: second,
      QT_WEBUI_FIXTURE_HELPER_NOTIFY_DELAY_MS: "120",
    },
  });
  const firstTab = (await backend.send("hello")).data.tabs.activeTab;
  const opened = await backend.send("tab_open", { cwd: second });
  const secondTab = opened.data.tab.id;
  await backend.waitForEvent("pi.status", (event) => event.tab === secondTab && event.statusKind === "ready");

  const baseline = await backend.send("tools_set", { tab: firstTab, scope: "global", enabledTools: ["bash"] });
  assert.equal(baseline.ok, true, JSON.stringify(baseline));
  await writeFile(backend.capturePath, "");

  const pending = backend.send("tools_set", { tab: firstTab, scope: "global", enabledTools: ["read"] });
  const deadline = Date.now() + 2_000;
  let prospectiveApplyStarted = false;
  while (Date.now() < deadline) {
    const requests = (await backend.readCapture())
      .filter((command) => command.type === "prompt" && command.message.startsWith("/qt-webui-helper "))
      .map((command) => JSON.parse(command.message.slice("/qt-webui-helper ".length)));
    if (requests.some((request) => request.action === "apply")) {
      prospectiveApplyStarted = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(prospectiveApplyStarted, true, "the prospective affected-tab apply starts before the concurrent canonical write");

  const canonical = JSON.parse(await readFile(backend.webuiSettingsPath, "utf8"));
  canonical.resourceDefaults.tools.enabledTools = ["bash", "project-only"];
  await writeFile(backend.webuiSettingsPath, JSON.stringify(canonical));

  const committed = await pending;
  assert.equal(committed.ok, true, JSON.stringify(committed));
  assert.deepEqual(committed.data.profiles.global.tools, ["read", "project-only"], "the locked latest-snapshot commit retains the tool unknown to the initiating tab");

  async function effectiveTools(tab) {
    const afterSeq = backend.events.at(-1)?.seq || 0;
    assert.equal((await backend.send("prompt", { tab, message: "__QT_WEBUI_EFFECTIVE__" })).ok, true);
    const notification = await backend.waitForEvent("extension.notify", (event) => event.seq > afterSeq
      && event.tab === tab && event.message.startsWith("QT_WEBUI_HELPER_EFFECTIVE "));
    await backend.waitForEvent("pi.status", (event) => event.tab === tab && event.statusKind === "ready" && event.seq > notification.seq);
    return JSON.parse(notification.message.slice("QT_WEBUI_HELPER_EFFECTIVE ".length)).tools;
  }

  assert.deepEqual(await effectiveTools(firstTab), ["read"], "the initiating tab receives only tools in its own inventory");
  assert.deepEqual(await effectiveTools(secondTab), ["read", "project-only"], "committed-state reconciliation restores the retained project tool where it is available");

  const applications = (await backend.readCapture())
    .filter((command) => command.type === "prompt" && command.message.startsWith("/qt-webui-helper "))
    .map((command) => JSON.parse(command.message.slice("/qt-webui-helper ".length)))
    .filter((request) => request.action === "apply");
  assert(applications.some((request) => request.payload.effective.tools?.includes("project-only")), "the production helper apply path receives the reconciled committed tool");
});

test("broader profile transactions fence compaction and session lifecycle through commit and rollback", async (t) => {
  async function waitForHelperCalls(backend, count) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const calls = (await backend.readCapture()).filter((command) => command.type === "prompt" && command.message.startsWith("/qt-webui-helper "));
      if (calls.length >= count) return calls;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`timed out waiting for ${count} helper calls`);
  }

  async function assertFencedRequests(backend, tab, label) {
    const responses = await Promise.all([
      backend.send("compact", { tab }),
      backend.send("restart", { tab }),
      backend.send("tab_close", { tab, force: true }),
      backend.send("session_switch", { tab, sessionPath: `/tmp/${label}-resume.jsonl` }),
      backend.send("session_new", { tab }),
    ]);
    assert.deepEqual(responses.map((response) => response.error?.code), ["busy", "busy", "busy", "busy", "busy"], `${label} keeps every lifecycle request fenced`);
  }

  async function assertNormalAfterSettlement(backend, tab, label) {
    const compacted = await backend.send("compact", { tab });
    assert.equal(compacted.ok, true, `${label}: compact follows its normal contract after settlement`);
    const switched = await backend.send("session_switch", { tab, sessionPath: `/tmp/${label}-resume.jsonl` });
    assert.equal(switched.ok, true, `${label}: session switch succeeds after settlement`);
    const fresh = await backend.send("session_new", { tab });
    assert.equal(fresh.ok, true, `${label}: new session succeeds after settlement`);
    const beforeRestart = backend.events.at(-1)?.seq || 0;
    const restarted = await backend.send("restart", { tab });
    assert.equal(restarted.ok, true, `${label}: restart succeeds after settlement`);
    await backend.waitForEvent("pi.status", (event) => event.tab === tab && event.statusKind === "ready" && event.seq > beforeRestart);
    const closed = await backend.send("tab_close", { tab });
    assert.equal(closed.ok, true, `${label}: ordinary non-force close retains its normal idle semantics`);
  }

  async function runScenario(label, rollback) {
    const first = await temporary(t, `qt-webui-lifecycle-${label}-a-`);
    const second = await temporary(t, `qt-webui-lifecycle-${label}-b-`);
    const backend = await readyBackend(t, { cwd: first, env: { QT_WEBUI_FIXTURE_HELPER_NOTIFY_DELAY_MS: "100" } });
    const firstTab = (await backend.send("hello")).data.tabs.activeTab;
    const opened = await backend.send("tab_open", { cwd: second });
    const secondTab = opened.data.tab.id;
    await backend.waitForEvent("pi.status", (event) => event.tab === secondTab && event.statusKind === "ready");
    if (rollback) {
      await backend.send("resources_state", { tab: firstTab });
      await writeFile(backend.capturePath, "");
      await writeFile(`${backend.webuiSettingsPath}.lock`, "blocked");
    }

    const transaction = backend.send("skills_set", { tab: firstTab, scope: "global", enabledSkills: ["review"] });
    await waitForHelperCalls(backend, 1);
    await assertFencedRequests(backend, secondTab, `${label}-apply`);
    if (rollback) {
      await waitForHelperCalls(backend, 5);
      await assertFencedRequests(backend, secondTab, `${label}-rollback`);
    }

    const settled = await transaction;
    if (rollback) {
      assert.equal(settled.error.code, "internal_error");
    } else {
      assert.equal(settled.ok, true, JSON.stringify(settled));
    }
    await assertNormalAfterSettlement(backend, secondTab, label);
  }

  await runScenario("commit", false);
  await runScenario("rollback", true);
});

test("persisted sessions can be listed, resumed with history and an interruption warning, and replaced by a new session", async (t) => {
  const cwd = await temporary(t);
  const agentDir = await temporary(t, "qt-webui-agent-");
  const directory = sessionDirectoryFor(cwd, { PI_CODING_AGENT_DIR: agentDir });
  await writeSession(directory, "one_resume-me.jsonl", { id: "resume-me", cwd, name: "Resumable", messages: [{ role: "user", content: "earlier question" }] });
  await writeSession(directory, "two_interrupted.jsonl", { id: "interrupted", cwd, messages: [{ role: "user", content: "please continue" }] });
  await writeSession(directory, "three_cancel-me.jsonl", { id: "cancel-me", cwd });
  const backend = await readyBackend(t, { cwd, env: { PI_CODING_AGENT_DIR: agentDir } });
  const listed = await backend.send("sessions_list");
  assert.deepEqual(listed.data.sessions.map((session) => [session.id, session.name, session.messageCount]).sort(), [["cancel-me", "", 0], ["interrupted", "", 1], ["resume-me", "Resumable", 1]]);
  assert.equal(path.dirname(listed.data.current), backend.temporary);
  assert.match(path.basename(listed.data.current), /^fixture-[0-9]+\.jsonl$/);

  const resumePath = path.join(directory, "one_resume-me.jsonl");
  const before = backend.events.length;
  const resumed = await backend.send("session_switch", { sessionPath: resumePath });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.deepEqual({ file: resumed.data.sessionFile, name: resumed.data.sessionName, rows: resumed.data.rows, interrupted: resumed.data.interrupted }, { file: resumePath, name: "Resumed session", rows: 5, interrupted: false });
  const replay = backend.events.slice(before).filter((event) => event.type === "transcript.reset" || event.type === "transcript.row");
  assert.equal(replay[0].type, "transcript.reset");
  assert.deepEqual(replay.slice(1).map((event) => [event.row.kind, event.row.text || event.row.toolName]), [["user", "earlier question"], ["thinking", "earlier thinking"], ["text", "earlier **answer**"], ["tool", "read"], ["text", "done"]]);
  assert.equal(replay[4].row.toolOutput, "file contents");
  const runtime = backend.events.filter((event) => event.type === "pi.runtime").at(-1);
  assert.equal(runtime.sessionFile, resumePath);

  const interrupted = await backend.send("session_switch", { sessionPath: path.join(directory, "two_interrupted.jsonl") });
  assert.equal(interrupted.data.interrupted, true);
  await backend.waitForEvent("notice", (event) => /did not complete/.test(event.message));
  const interruptedRow = backend.events.filter((event) => event.type === "transcript.row").at(-1);
  assert.deepEqual({ text: interruptedRow.row.text, attachments: interruptedRow.row.attachments }, { text: "please continue", attachments: "1 image" });

  const cancelled = await backend.send("session_switch", { sessionPath: path.join(directory, "three_cancel-me.jsonl") });
  assert.equal(cancelled.error.code, "pi_error");
  assert.match(cancelled.error.message, /cancelled the session switch/);

  const fresh = await backend.send("session_new");
  assert.equal(fresh.ok, true);
  assert.match(fresh.data.sessionFile, /fixture-session-1\.jsonl$/);
  assert.equal(backend.events.filter((event) => event.type === "transcript.reset").length, 3, "two switches plus new (no hello replay in this test)");

  await backend.send("prompt", { message: "__QT_WEBUI_DELAYED_ABORT__" });
  await backend.waitForEvent("run.start");
  assert.equal((await backend.send("session_new")).error.code, "busy");
  assert.equal((await backend.send("session_switch", { sessionPath: resumePath })).error.code, "busy");
  await backend.send("abort");
  await backend.waitForEvent("run.end");
  const commands = await backend.readCapture();
  assert.deepEqual(commands.filter((command) => command.type === "switch_session").map((command) => path.basename(command.sessionPath)), ["one_resume-me.jsonl", "two_interrupted.jsonl", "three_cancel-me.jsonl"]);
  assert.equal(commands.filter((command) => command.type === "get_messages").length, 2, "history is read only after a switch Pi accepted");
});

test("explicit restart and unexpected exit retain the saved identity until the new child resumes", async (t) => {
  const cwd = await temporary(t);
  const agentDir = await temporary(t);
  const stateHome = await temporary(t);
  const env = { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateHome };
  const sessionPath = await writeSession(sessionDirectoryFor(cwd, env), "recovery.jsonl", { id: "recovery", cwd });
  const original = await readFile(sessionPath, "utf8");
  const backend = await readyBackend(t, { cwd, env });
  const stateFile = path.join(stateHome, "qt-webui", "state.json");
  assert.equal((await backend.send("session_switch", { sessionPath })).ok, true);

  async function verifyRestart(trigger) {
    const before = (await backend.readCapture()).length;
    await trigger();
    await waitForAsync(async () => (await backend.readCapture()).slice(before).some(command => command.type === "get_messages"), "resume command and history");
    const resumed = (await backend.readCapture()).slice(before);
    assert.deepEqual(resumed.slice(0, 3).map(command => command.type), ["get_state", "switch_session", "get_messages"]);
    assert.equal(resumed[1].sessionPath, sessionPath);
    await waitForAsync(async () => (await backend.send("tabs_list")).data.tabs[0].sessionFile === sessionPath
      && (await backend.readCapture()).slice(before).filter(command => command.type === "get_state").length >= 2,
    "resume readiness");
    assert.equal((await backend.send("prompt", { message: "__QT_WEBUI_STREAM__" })).ok, true);
    await waitForAsync(async () => (await backend.send("tabs_list")).data.tabs[0].active === false, "run completion");
    assert.equal((await backend.readCapture()).slice(before).filter(command => command.type === "prompt").length, 1);
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tabs[0].sessionFile, sessionPath);
  }

  await verifyRestart(async () => { assert.equal((await backend.send("restart")).ok, true); });
  assert((await backend.send("tabs_list")).data.tabs[0].needsInput > 0, "pending dialogs coexist with the saved identity");
  const exitBefore = backend.events.length;
  assert.equal((await backend.send("prompt", { message: "__QT_WEBUI_EXIT__" })).ok, true);
  await waitUntil(() => backend.events.slice(exitBefore).some(event => event.type === "pi.exit"), { description: "unexpected Pi exit" });
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tabs[0].sessionFile, sessionPath);
  assert.equal((await backend.send("tabs_list")).data.tabs[0].sessionFile, sessionPath);
  await writeFile(backend.statePath, "recovered-state\n");
  await verifyRestart(async () => { assert.equal((await backend.send("restart")).ok, true); });
  assert.equal(await readFile(sessionPath, "utf8"), original, "recovery bookkeeping never rewrites Pi history");

  await backend.send("shutdown");
  await backend.exitPromise;
  const restored = await readyBackend(t, { cwd, env });
  await waitForAsync(async () => (await restored.readCapture()).some(command => command.type === "get_messages"), "saved-state resume");
  const commands = await restored.readCapture();
  assert.deepEqual(commands.slice(0, 3).map(command => command.type), ["get_state", "switch_session", "get_messages"]);
  assert.equal(commands[1].sessionPath, sessionPath);
  assert.equal((await restored.send("tabs_list")).data.tabs[0].sessionFile, sessionPath);
  assert.equal(await readFile(sessionPath, "utf8"), original);
});

test("catalog-opened target survives exit before its first switch, explicit restart, and saved-state restore", async (t) => {
  const cwd = await temporary(t);
  const other = await temporary(t);
  const agentDir = await temporary(t);
  const stateHome = await temporary(t);
  const env = { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateHome, QT_WEBUI_FIXTURE_SWITCH_DELAY_MS: "700" };
  const sessionPath = await writeSession(sessionDirectoryFor(other, env), "catalog-open.jsonl", { id: "catalog-open", cwd: other });
  const backend = await readyBackend(t, { cwd, env });
  const opened = await backend.send("tab_open", { cwd: other, sessionPath });
  assert.equal(opened.ok, true);
  const id = opened.data.tab.id;
  const stateFile = path.join(stateHome, "qt-webui", "state.json");
  await waitForAsync(async () => (await backend.readCapture()).some(command => command.type === "switch_session" && command.sessionPath === sessionPath), "first catalog switch");
  assert.equal((await backend.send("tabs_list")).data.tabs.find(tab => tab.id === id).ready, false);
  assert.equal((await backend.send("tab_select", { tab: id })).data.session.ready, false);
  assert(["busy", "unavailable"].includes((await backend.send("resources_state", { tab: id })).error.code));
  assert.equal((await backend.readCapture()).filter(command => command.type === "prompt").length, 0);
  process.kill(opened.data.session.pid, "SIGKILL");
  await backend.waitForEvent("pi.exit", event => event.tab === id);
  await waitForAsync(async () => (await backend.send("tabs_list")).data.tabs.find(tab => tab.id === id).mutating === false, "failed switch settlement");
  const pendingTab = JSON.parse(await readFile(stateFile, "utf8")).tabs.find(tab => tab.cwd === other);
  assert.equal(pendingTab.draftId, opened.data.tab.draftId);
  assert.deepEqual((( { draftId, ...tab }) => tab)(pendingTab),
    { cwd: other, name: "", sessionFile: "", pendingResume: sessionPath });
  assert.equal((await backend.send("tabs_list")).data.tabs.find(tab => tab.id === id).sessionFile, sessionPath);
  const before = (await backend.readCapture()).length;
  assert.equal((await backend.send("restart", { tab: id })).ok, true);
  await waitForAsync(async () => (await backend.readCapture()).slice(before).some(command => command.type === "switch_session" && command.sessionPath === sessionPath), "restart switch");
  const during = await backend.send("tab_select", { tab: id });
  assert.equal(during.data.session.ready, false);
  assert.equal(during.data.tab.ready, false);
  assert(["busy", "unavailable"].includes((await backend.send("prompt", { tab: id, message: "__QT_WEBUI_IMMEDIATE__" })).error.code));
  await waitForAsync(async () => (await backend.send("tabs_list")).data.tabs.find(tab => tab.id === id).ready === true, "confirmed resume readiness");
  assert.equal((await backend.send("tab_select", { tab: id })).data.session.ready, true);
  assert.equal((await backend.send("resources_state", { tab: id })).ok, true);
  const commands = (await backend.readCapture()).slice(before);
  assert.deepEqual(commands.slice(0, 4).map(command => command.type), ["get_state", "switch_session", "get_messages", "get_state"]);
  assert.equal(commands[1].sessionPath, sessionPath);
  assert.equal(commands.filter(command => command.type === "prompt" && command.message === "__QT_WEBUI_IMMEDIATE__").length, 0);
  assert(backend.events.every(event => event.type !== "notice" || !/resource.*(?:unavailable|resume)/i.test(event.message)), "resume causes no resource error notice");

  await backend.send("shutdown");
  await backend.exitPromise;
  const restored = await startBackend({ cwd, env, startupTimeoutMs: 1_000, t });
  await waitForAsync(async () => (await restored.readCapture()).some(command => command.type === "switch_session" && command.sessionPath === sessionPath), "saved-state switch");
  const restoredTabs = (await restored.send("tabs_list")).data.tabs;
  assert.equal(restoredTabs.find(tab => tab.cwd === other).sessionFile, sessionPath);
  assert.equal((await restored.readCapture()).find(command => command.type === "switch_session").sessionPath, sessionPath);
});

test("closing a catalog tab during its automatic resume or immediately afterwards succeeds", async (t) => {
  const cwd = await temporary(t);
  const agentDir = await temporary(t);
  const env = { PI_CODING_AGENT_DIR: agentDir, QT_WEBUI_FIXTURE_SWITCH_DELAY_MS: "700" };
  const sessionPath = await writeSession(sessionDirectoryFor(cwd, env), "closing-resume.jsonl", { id: "closing-resume", cwd });
  const backend = await readyBackend(t, { cwd, env });
  const first = await backend.send("tab_open", { cwd, sessionPath });
  assert.equal(first.ok, true);
  const firstId = first.data.tab.id;
  await waitForAsync(async () => (await backend.readCapture()).some(command => command.type === "switch_session" && command.sessionPath === sessionPath), "pending catalog switch");
  assert.equal((await backend.send("tabs_list")).data.tabs.find(tab => tab.id === firstId).mutating, true);
  const closingPending = await backend.send("tab_close", { tab: firstId });
  assert.equal(closingPending.ok, true, JSON.stringify(closingPending));
  assert.equal((await backend.send("tabs_list")).data.tabs.some(tab => tab.id === firstId), false);
  assert.equal((await backend.readCapture()).filter(command => command.type === "switch_session" && command.sessionPath === sessionPath).length, 1);
  assert.equal(backend.events.filter(event => event.type === "notice" && /Could not resume/.test(event.message)).length, 0, "closing cancels its private resume without a spurious warning");

  const second = await backend.send("tab_open", { cwd, sessionPath });
  assert.equal(second.ok, true);
  const secondId = second.data.tab.id;
  await waitForAsync(async () => (await backend.send("tabs_list")).data.tabs.find(tab => tab.id === secondId)?.ready === true, "completed catalog resume");
  const commands = (await backend.readCapture()).filter(command => command.type === "switch_session" && command.sessionPath === sessionPath);
  assert.equal(commands.length, 2);
  assert.equal((await backend.send("tab_close", { tab: secondId })).ok, true, "a completed resume closes without waiting for background work");
  assert.equal((await backend.send("tabs_list")).data.tabs.some(tab => tab.id === secondId), false);
});

test("an unconfirmed catalog-open target is resumed after a backend restart", async (t) => {
  const cwd = await temporary(t);
  const other = await temporary(t);
  const agentDir = await temporary(t);
  const stateHome = await temporary(t);
  const env = { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateHome, QT_WEBUI_FIXTURE_SWITCH_DELAY_MS: "700" };
  const sessionPath = await writeSession(sessionDirectoryFor(other, env), "unconfirmed.jsonl", { id: "unconfirmed", cwd: other });
  const backend = await startBackend({ cwd, env, startupTimeoutMs: 1_000, t });
  await backend.waitForEvent("pi.status", event => event.ready);
  const opened = await backend.send("tab_open", { cwd: other, sessionPath });
  assert.equal(opened.ok, true);
  await waitForAsync(async () => (await backend.readCapture()).some(command => command.type === "switch_session" && command.sessionPath === sessionPath), "first unconfirmed switch");
  assert.equal((await backend.send("tab_select", { tab: opened.data.tab.id })).data.session.ready, false);
  backend.kill("SIGKILL");
  await backend.exitPromise;
  const stateFile = path.join(stateHome, "qt-webui", "state.json");
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tabs.find(tab => tab.cwd === other).pendingResume, sessionPath);
  const restored = await startBackend({ cwd, env, startupTimeoutMs: 1_000, t });
  await waitForAsync(async () => (await restored.readCapture()).some(command => command.type === "switch_session" && command.sessionPath === sessionPath), "restored unconfirmed switch");
  const tab = (await restored.send("tabs_list")).data.tabs.find(entry => entry.cwd === other);
  assert.equal(tab.ready, false);
  await waitForAsync(async () => (await restored.send("tabs_list")).data.tabs.find(entry => entry.cwd === other).ready, "restored confirmed switch");
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tabs.find(entry => entry.cwd === other).sessionFile, sessionPath);
  const commands = await restored.readCapture();
  assert.equal(commands.find(command => command.type === "switch_session").sessionPath, sessionPath);
  assert.equal(commands.filter(command => command.type === "prompt").length, 0);
});

test("a filename first saved by a prompt is persisted on run completion or exit and resumed before mutation", async (t) => {
  for (const scenario of ["__QT_WEBUI_SAVE_FIRST__", "__QT_WEBUI_SAVE_AND_EXIT__"]) {
    const cwd = await temporary(t);
    const stateHome = await temporary(t);
    const sessionPath = path.join(cwd, "first-saved.jsonl");
    const backend = await readyBackend(t, { cwd, env: { XDG_STATE_HOME: stateHome, QT_WEBUI_FIXTURE_INITIAL_SESSION_FILE: sessionPath } });
    assert.equal((await backend.send("tabs_list")).data.tabs[0].sessionFile, sessionPath);
    assert.equal(JSON.parse(await readFile(path.join(stateHome, "qt-webui", "state.json"), "utf8")).tabs[0].sessionFile, "", "an unsaved filename is not a resume target yet");
    const before = backend.events.length;
    assert.equal((await backend.send("prompt", { message: scenario })).ok, true);
    await backend.waitForEvent(scenario === "__QT_WEBUI_SAVE_FIRST__" ? "run.end" : "pi.exit", event => backend.events.indexOf(event) >= before);
    const saved = await readFile(sessionPath, "utf8");
    const stateFile = path.join(stateHome, "qt-webui", "state.json");
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tabs[0].sessionFile, sessionPath);
    if (scenario === "__QT_WEBUI_SAVE_FIRST__") {
      assert.equal((await backend.send("prompt", { message: "__QT_WEBUI_EXIT__" })).ok, true);
      await backend.waitForEvent("pi.exit");
      await writeFile(backend.statePath, "recovered-state\n");
    }
    const commandOffset = (await backend.readCapture()).length;
    assert.equal((await backend.send("restart")).ok, true);
    await waitForAsync(async () => (await backend.readCapture()).slice(commandOffset).some(command => command.type === "get_messages"), "saved-first resume history");
    const resumed = (await backend.readCapture()).slice(commandOffset);
    assert.deepEqual(resumed.slice(0, 3).map(command => command.type), ["get_state", "switch_session", "get_messages"]);
    assert.equal(resumed[1].sessionPath, sessionPath);
    await waitForAsync(async () => (await backend.send("tabs_list")).data.tabs[0].ready, "saved-first resume readiness");
    assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tabs[0].sessionFile, sessionPath);
    assert.equal(await readFile(sessionPath, "utf8"), saved, "bookkeeping does not modify Pi's session file");
  }
});

test("restore retains a missing saved session path instead of persisting the fresh child's identity", async (t) => {
  const cwd = await temporary(t);
  const stateHome = await temporary(t);
  const sessionPath = path.join(cwd, "missing.jsonl");
  const stateDirectory = path.join(stateHome, "qt-webui");
  await mkdir(stateDirectory);
  const stateFile = path.join(stateDirectory, "state.json");
  await writeFile(stateFile, JSON.stringify({ tabs: [{ cwd, sessionFile: sessionPath, name: "Recovery" }], activeTab: 0 }));
  const backend = await startBackend({ cwd, env: { XDG_STATE_HOME: stateHome }, startupTimeoutMs: 1_000, t });
  await backend.waitForEvent("notice", event => /missing.jsonl.*missing.*Restore the saved file/.test(event.message));
  const tab = (await backend.send("tabs_list")).data.tabs[0];
  assert.equal(tab.sessionFile, sessionPath);
  assert.equal(tab.ready, false);
  assert.equal(tab.canRecover, true);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tabs[0].sessionFile, sessionPath);
  assert.equal((await backend.send("hello")).data.session.ready, false, "the active snapshot exposes effective readiness");
  assert.deepEqual((await backend.readCapture()).map(command => command.type), ["get_state"], "missing target is never claimed resumed");
  assert.equal((await backend.send("prompt", { message: "__QT_WEBUI_IMMEDIATE__" })).error.code, "unavailable");
  assert.equal((await backend.send("resources_state")).error.code, "unavailable");
  assert.equal((await backend.send("session_new")).ok, true, "the user can explicitly leave an unavailable session");
  assert.equal((await backend.readCapture()).filter(command => command.type === "new_session").length, 1);
  assert.equal((await backend.send("tabs_list")).data.tabs[0].canRecover, false);
});

test("a blocked missing-file tab can switch to another saved session without unlocking prompts first", async (t) => {
  const cwd = await temporary(t);
  const stateHome = await temporary(t);
  const agentDir = await temporary(t);
  const env = { XDG_STATE_HOME: stateHome, PI_CODING_AGENT_DIR: agentDir };
  const target = await writeSession(sessionDirectoryFor(cwd, env), "replacement.jsonl", { id: "replacement", cwd });
  const missing = path.join(cwd, "deleted.jsonl");
  await mkdir(path.join(stateHome, "qt-webui"));
  const stateFile = path.join(stateHome, "qt-webui", "state.json");
  await writeFile(stateFile, JSON.stringify({ tabs: [{ cwd, sessionFile: missing, name: "Recovery" }], activeTab: 0 }));
  const backend = await startBackend({ cwd, env, startupTimeoutMs: 1_000, t });
  await backend.waitForEvent("notice", event => /deleted.jsonl.*missing/.test(event.message));
  assert.equal((await backend.waitForEvent("pi.status", event => event.canRecover === true)).ready, false);
  assert.equal((await backend.send("tabs_list")).data.tabs[0].canRecover, true);
  assert.equal((await backend.send("prompt", { message: "__QT_WEBUI_IMMEDIATE__" })).error.code, "unavailable");
  const switched = await backend.send("session_switch", { sessionPath: target });
  assert.equal(switched.ok, true, JSON.stringify(switched));
  const tab = (await backend.send("tabs_list")).data.tabs[0];
  assert.equal(tab.canRecover, false);
  assert.equal(tab.ready, true);
  assert.equal(tab.sessionFile, target);
  assert.equal(JSON.parse(await readFile(stateFile, "utf8")).tabs[0].sessionFile, target);
  assert.deepEqual((await backend.readCapture()).filter(command => command.type === "switch_session").map(command => command.sessionPath), [target]);
  assert.equal((await backend.readCapture()).filter(command => command.type === "prompt").length, 0);
});

test("cancelled replacement keeps the old identity; confirmed new session never resumes its predecessor", async (t) => {
  const cwd = await temporary(t);
  const agentDir = await temporary(t);
  const stateHome = await temporary(t);
  const env = { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateHome };
  const directory = sessionDirectoryFor(cwd, env);
  const original = await writeSession(directory, "original.jsonl", { id: "original", cwd });
  const cancelled = await writeSession(directory, "cancel-me.jsonl", { id: "cancel-me", cwd });
  const backend = await readyBackend(t, { cwd, env });
  assert.equal((await backend.send("session_switch", { sessionPath: original })).ok, true);
  assert.equal((await backend.send("session_switch", { sessionPath: cancelled })).error.code, "pi_error");
  assert.equal((await backend.send("tabs_list")).data.tabs[0].sessionFile, original);
  assert.equal(JSON.parse(await readFile(path.join(stateHome, "qt-webui", "state.json"), "utf8")).tabs[0].sessionFile, original);
  const newSession = await backend.send("session_new");
  assert.equal(newSession.ok, true);
  assert.notEqual(newSession.data.sessionFile, original);
  const before = (await backend.readCapture()).length;
  assert.equal((await backend.send("restart")).ok, true);
  await waitForAsync(async () => (await backend.readCapture()).slice(before).some(command => command.type === "get_state"), "new child state");
  assert((await backend.readCapture()).slice(before).every(command => command.type !== "switch_session" || command.sessionPath !== original));
  assert.notEqual((await backend.send("tabs_list")).data.tabs[0].sessionFile, original);
});

test("failed readiness and missing resume files retain recovery context and fence fresh-child writes", async (t) => {
  const cwd = await temporary(t);
  const agentDir = await temporary(t);
  const stateHome = await temporary(t);
  const env = { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateHome };
  const sessionPath = await writeSession(sessionDirectoryFor(cwd, env), "lost.jsonl", { id: "lost", cwd });
  const backend = await readyBackend(t, { cwd, env });
  assert.equal((await backend.send("session_switch", { sessionPath })).ok, true);
  await writeFile(backend.statePath, "failed-state\n");
  assert.equal((await backend.send("restart")).ok, true);
  await backend.waitForEvent("pi.error", event => /deterministic startup state failure/.test(event.message));
  let tab = (await backend.send("tabs_list")).data.tabs[0];
  assert.equal(tab.sessionFile, sessionPath);
  assert.equal(tab.ready, false);
  assert.equal(backend.events.filter(event => event.type === "pi.runtime").at(-1).modelId, "", "failed readiness clears volatile model data");
  assert.equal((await backend.send("prompt", { message: "__QT_WEBUI_IMMEDIATE__" })).error.code, "unavailable");
  assert.equal((await backend.readCapture()).at(-1).type, "get_state");

  await rm(sessionPath);
  await writeFile(backend.statePath, "recovered-state\n");
  assert.equal((await backend.send("restart")).ok, true);
  await backend.waitForEvent("notice", event => /lost.jsonl.*missing.*Restore the saved file/.test(event.message));
  tab = (await backend.send("tabs_list")).data.tabs[0];
  assert.equal(tab.sessionFile, sessionPath);
  assert.equal((await backend.send("prompt", { message: "__QT_WEBUI_IMMEDIATE__" })).error.code, "unavailable");
  assert.equal((await backend.readCapture()).at(-1).type, "get_state", "missing target never permits a fresh-session mutation");
  assert.equal(JSON.parse(await readFile(path.join(stateHome, "qt-webui", "state.json"), "utf8")).tabs[0].sessionFile, sessionPath);
});

test("session settlement persists, reverses, and refuses to newly settle an active open session", async (t) => {
  const cwd = await temporary(t);
  const agentDir = await temporary(t, "qt-webui-settlement-agent-");
  const stateHome = await temporary(t, "qt-webui-settlement-state-");
  const env = { PI_CODING_AGENT_DIR: agentDir, XDG_STATE_HOME: stateHome };
  const directory = sessionDirectoryFor(cwd, env);
  const sessionPath = await writeSession(directory, "settle-me.jsonl", {
    id: "settle-me",
    cwd,
    name: "Settlement test",
    messages: [{ role: "user", content: "finish this task", timestamp: 10_000 }],
  });

  const backend = await readyBackend(t, { cwd, env });
  const initial = await backend.send("sessions_list", { scope: "all" });
  assert.deepEqual(initial.data.sessions.map((session) => [session.id, session.settled]), [["settle-me", false]]);
  const settled = await backend.send("session_settled", { sessionPath, settled: true });
  assert.deepEqual(settled.data, { path: sessionPath, settled: true });
  assert(backend.events.some((event) => event.type === "sessions.changed" && event.path === sessionPath && event.settled === true));
  assert.equal((await backend.send("sessions_list", { scope: "all" })).data.sessions[0].settled, true);
  const stateText = await readFile(path.join(stateHome, "qt-webui", "state.json"), "utf8");
  const state = JSON.parse(stateText);
  assert.equal(state.settledSessions.length, 1);
  assert.match(state.settledSessions[0], /^[0-9a-f]{64}$/);
  assert.equal(stateText.includes(sessionPath), false, "settled metadata stores a private fixed-size identity rather than the project path");
  await backend.send("shutdown");
  await backend.exitPromise;

  const restarted = await readyBackend(t, { cwd, env });
  assert.equal((await restarted.send("sessions_list", { scope: "all" })).data.sessions[0].settled, true, "settlement survives a backend restart");
  assert.equal((await restarted.send("session_settled", { sessionPath, settled: true })).data.settled, true, "settling is idempotent while idle");
  const resumed = await restarted.send("session_switch", { sessionPath });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  await restarted.send("prompt", { message: "__QT_WEBUI_DELAYED_ABORT__" });
  await restarted.waitForEvent("run.start");
  assert.equal((await restarted.send("session_settled", { sessionPath, settled: false })).data.settled, false, "unsetting remains available while active");
  assert.equal((await restarted.send("session_settled", { sessionPath, settled: true })).error.code, "busy", "an active session cannot be newly settled");
  await restarted.send("abort");
  await restarted.waitForEvent("run.end");
  assert.equal((await restarted.send("session_settled", { sessionPath, settled: true })).data.settled, true, "the idle session can be settled again");
  assert.equal((await restarted.send("session_settled", { sessionPath, settled: false })).data.settled, false);
  assert.equal((await restarted.send("session_settled", { sessionPath: "/tmp/outside.jsonl", settled: true })).error.code, "invalid_request");
  assert.equal((await restarted.send("session_settled", { sessionPath: path.join(directory, "missing.jsonl"), settled: true })).error.code, "unavailable");
  const externalDirectory = await temporary(t, "qt-webui-settlement-external-");
  const externalPath = await writeSession(externalDirectory, "external.jsonl", { id: "external", cwd: externalDirectory });
  const externalFileAlias = path.join(directory, "external-file.jsonl");
  const externalDirectoryAlias = path.join(path.dirname(directory), "external-directory");
  await symlink(externalPath, externalFileAlias);
  await symlink(externalDirectory, externalDirectoryAlias);
  assert.equal((await restarted.send("session_settled", { sessionPath: externalFileAlias, settled: true })).error.code, "invalid_request");
  assert.equal((await restarted.send("session_settled", { sessionPath: path.join(externalDirectoryAlias, "external.jsonl"), settled: true })).error.code, "invalid_request");
});

test("directories and worktrees are served over the protocol and a worktree opens in a new tab", async (t) => {
  const { base, root } = await makeRepository(t);
  const stateHome = await temporary(t, "qt-webui-state-");
  const backend = await readyBackend(t, { cwd: root, env: { XDG_STATE_HOME: stateHome, ...GIT_ENV } });
  const listing = await backend.send("directory_list", { path: base });
  assert.equal(listing.ok, true, JSON.stringify(listing));
  assert.deepEqual(listing.data.entries.map((entry) => [entry.name, entry.git]), [["repo", true]]);
  assert.deepEqual({ recent: listing.data.recent, pinned: listing.data.pinned }, { recent: [], pinned: [] });
  const created = await backend.send("directory_create", { path: base, name: "new folder" });
  assert.equal(created.data.path, path.join(await realpath(base), "new folder"));
  assert.deepEqual((await backend.send("directory_pin", { path: created.data.path })).data.pinned, [created.data.path]);
  assert.equal((await backend.send("directory_list", { path: "/definitely/missing/path" })).error.code, "rejected");

  assert.equal((await backend.send("worktrees_list")).data.worktrees.length, 1);
  const unconfirmed = await backend.send("worktree_create", { branch: "feature/ui" });
  assert.equal(unconfirmed.error.code, "invalid_request");
  const plan = await backend.send("worktree_plan", { branch: "feature/ui" });
  assert.deepEqual({ branch: plan.data.branch, path: plan.data.path, base: plan.data.base, detached: plan.data.detachedBase, nested: plan.data.nested, problems: plan.data.problems }, { branch: "feature/ui", path: path.join(await realpath(base), "repo-feature-ui"), base: "main", detached: false, nested: false, problems: [] });
  assert.deepEqual((await backend.send("worktree_plan", { branch: "main", path: "." })).data.problems, ["The worktree path must differ from the repository", `${await realpath(root)} already exists`, "Branch main already exists"]);
  assert.equal((await backend.send("worktree_plan", { branch: "bad name" })).error.code, "invalid_request");
  const worktree = await backend.send("worktree_create", { branch: "feature/ui", confirmed: true });
  assert.equal(worktree.ok, true, JSON.stringify(worktree));
  assert.equal(worktree.data.worktree.path, path.join(await realpath(base), "repo-feature-ui"));
  assert.equal(worktree.data.tab.tab.cwd, worktree.data.worktree.path);
  assert.equal((await backend.send("tabs_list")).data.activeTab, worktree.data.tab.tab.id);
  await backend.waitForEvent("pi.status", (event) => event.tab === worktree.data.tab.tab.id && event.statusKind === "ready");
  const conflict = await backend.send("worktree_create", { branch: "feature/ui", confirmed: true, tab: (await backend.send("tabs_list")).data.tabs[0].id });
  assert.equal(conflict.error.code, "rejected");
  const state = JSON.parse(await readFile(path.join(stateHome, "qt-webui", "state.json"), "utf8"));
  assert.deepEqual(state.recentDirectories, [worktree.data.worktree.path]);
  assert.deepEqual(state.tabs.map((tab) => tab.name), ["", "feature/ui"]);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function waitUntil(check, description, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (check()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${description}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}
