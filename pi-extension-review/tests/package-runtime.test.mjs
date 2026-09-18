import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTestSdk } from "./package-test-loader.mjs";

registerTestSdk();

const agentDir = await mkdtemp(path.join(os.tmpdir(), "review-extension-agent-"));
const previous = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../index.ts");
test.after(async () => {
  if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  await rm(agentDir, { recursive: true, force: true });
});

function registration() {
  const commands = new Map();
  const handlers = new Map();
  extension({ registerCommand(name, definition) { commands.set(name, definition); }, on(name, handler) { handlers.set(name, handler); } });
  return { commands, handlers };
}

test("extension registers the three exact commands and lifecycle provenance handlers", () => {
  const { commands, handlers } = registration();
  assert.deepEqual([...commands.keys()], ["review-setup", "review", "review-status"]);
  assert.deepEqual([...handlers.keys()], ["tool_call", "tool_result", "user_bash", "session_shutdown"]);
});

test("cancel invalidates a start still awaiting saved settings", async () => {
  const { commands } = registration();
  let release; let reached;
  const pending = new Promise((resolve) => { release = resolve; });
  const observed = new Promise((resolve) => { reached = resolve; });
  const original = fs.promises.lstat;
  let delayed = false;
  fs.promises.lstat = async (file, ...args) => {
    if (!delayed && path.basename(String(file)) === "settings.json") { delayed = true; reached(); await pending; }
    return original(file, ...args);
  };
  syncBuiltinESMExports();
  const notices = [];
  const ctx = { ui: { notify: (message) => notices.push(message) }, modelRegistry: { find: () => { throw new Error("must not resolve model after cancellation"); } } };
  try {
    const starting = commands.get("review").handler("", ctx);
    await observed;
    await commands.get("review").handler("cancel", ctx);
    release();
    await starting;
    assert.ok(notices.some((message) => /initialization cancelled/.test(message)));
    assert.ok(notices.some((message) => /initialization was cancelled/.test(message)));
  } finally { release(); fs.promises.lstat = original; syncBuiltinESMExports(); }
});

test("status fallback reads state without waiting, aborting, or invoking a model", async () => {
  const { commands } = registration();
  const notifications = [];
  let waits = 0;
  let aborts = 0;
  let modelCalls = 0;
  const ctx = {
    cwd: process.cwd(), mode: "print", hasUI: false,
    sessionManager: { getSessionId: () => "session-status" },
    modelRegistry: { find() { modelCalls += 1; }, getAvailable() { modelCalls += 1; return []; } },
    waitForIdle: async () => { waits += 1; }, abort: () => { aborts += 1; },
    ui: { notify(message, type) { notifications.push({ message, type }); }, custom() { throw new Error("non-TUI status must not open an overlay"); } },
  };
  await commands.get("review-status").handler("", ctx);
  assert.equal(waits, 0);
  assert.equal(aborts, 0);
  assert.equal(modelCalls, 0);
  assert.match(notifications[0].message, /No saved review/u);
});
