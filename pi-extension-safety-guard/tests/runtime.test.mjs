import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { createSafetyGuardExtension, isProtectedPath } from "../index.ts";
import { readSafetyGuardConfig, writeSafetyGuardConfig } from "../src/config.mjs";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-safety-guard-runtime-"));
const configFile = path.join(tempDir, "safety-guard.json");
const previousConfigFile = process.env.PI_SAFETY_GUARD_CONFIG_FILE;
process.env.PI_SAFETY_GUARD_CONFIG_FILE = configFile;

after(() => {
  if (previousConfigFile === undefined) delete process.env.PI_SAFETY_GUARD_CONFIG_FILE;
  else process.env.PI_SAFETY_GUARD_CONFIG_FILE = previousConfigFile;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function saveConfig(autoReviewEnabled = true) {
  writeSafetyGuardConfig({
    autoReview: {
      enabled: autoReviewEnabled,
      model: { provider: "provider-a", modelId: "model-a", thinkingLevel: "low" },
    },
  }, configFile);
}

function makeHarness(requestAutoReviewFn, { hasUI = true, select = async () => "Block" } = {}) {
  const handlers = new Map();
  const commands = new Map();
  const notifications = [];
  const statuses = [];
  const widgets = [];
  let selectCalls = 0;
  const sessionEntries = [];
  const pi = {
    on(name, handler) { handlers.set(name, handler); },
    registerCommand(name, command) { commands.set(name, command); },
    appendEntry(customType, data) { sessionEntries.push({ type: "custom", customType, data: structuredClone(data) }); },
  };
  createSafetyGuardExtension({ requestAutoReviewFn, allowStorePath: path.join(tempDir, "allow.json") })(pi);
  const ctx = {
    cwd: tempDir,
    sessionManager: { getSessionId: () => "runtime-test", getEntries: () => sessionEntries },
    hasUI,
    mode: "tui",
    modelRegistry: {},
    ui: {
      theme: { fg: (_tone, value) => value },
      async select(...args) {
        selectCalls += 1;
        return await select(...args);
      },
      notify(message, type) { notifications.push({ message, type }); },
      setStatus(key, text) { statuses.push({ key, text }); },
      setWidget(key, content, options) { widgets.push({ key, content, options }); },
    },
  };
  return {
    call(command = "git reset --hard", id = "call-1") {
      return handlers.get("tool_call")({ type: "tool_call", toolName: "bash", toolCallId: id, input: { command } }, ctx);
    },
    notifications,
    statuses,
    widgets,
    get selectCalls() { return selectCalls; },
  };
}

test("protected-path detection normalizes Windows separators", () => {
  assert.equal(isProtectedPath("C:\\Users\\alice\\.ssh\\id_rsa", "C:\\workspace"), true);
  assert.equal(isProtectedPath("C:\\workspace\\.env", "C:\\workspace"), true);
  assert.equal(isProtectedPath("C:\\workspace\\src\\app.ts", "C:\\workspace"), false);
});

test("RPC setup selects only an authenticated model and its supported thinking levels", async () => {
  saveConfig(false);
  const commands = new Map();
  const selections = ["provider-a/model-a", "high"];
  const model = { provider: "provider-a", id: "model-a", reasoning: true, thinkingLevelMap: { max: null } };
  const pi = {
    on() {},
    registerCommand(name, command) { commands.set(name, command); },
  };
  createSafetyGuardExtension({ allowStorePath: path.join(tempDir, "allow.json") })(pi);
  const edited = {
    ...readSafetyGuardConfig(configFile),
    autoReview: { enabled: true, model: { provider: "", modelId: "", thinkingLevel: "off" } },
  };
  const ctx = {
    cwd: tempDir,
    hasUI: true,
    mode: "rpc",
    modelRegistry: { getAvailable: () => [model] },
    ui: {
      theme: { fg: (_tone, value) => value },
      editor: async () => JSON.stringify(edited),
      select: async (_title, options) => {
        const selected = selections.shift();
        assert.ok(options.includes(selected));
        return selected;
      },
      notify() {},
      setStatus() {},
      setWidget() {},
    },
  };

  await commands.get("safety-guard-setup").handler("", ctx);
  assert.deepEqual(readSafetyGuardConfig(configFile).autoReview, {
    enabled: true,
    model: { provider: "provider-a", modelId: "model-a", thinkingLevel: "high" },
  });
  assert.deepEqual(selections, []);
});

test("auto-review off retains the existing prompt path", async () => {
  saveConfig(false);
  let reviewCalls = 0;
  const harness = makeHarness(async () => {
    reviewCalls += 1;
    return { verdict: "allow", reason: "ok" };
  }, { select: async () => "Allow once" });

  assert.equal(await harness.call(), undefined);
  assert.equal(reviewCalls, 0);
  assert.equal(harness.selectCalls, 1);
});

test("exact auto-review allow proceeds quietly without a popup", async () => {
  saveConfig(true);
  let reviewCalls = 0;
  const harness = makeHarness(async () => {
    reviewCalls += 1;
    return { verdict: "allow", reason: "Scoped" };
  });

  assert.equal(await harness.call(), undefined);
  assert.equal(reviewCalls, 1);
  assert.equal(harness.selectCalls, 0);
  assert.deepEqual(harness.notifications, []);
  assert.ok(harness.widgets.some((entry) => Array.isArray(entry.content) && entry.content[0].includes("auto-reviewing")));
  assert.equal(harness.widgets.at(-1).content, undefined);
  assert.equal(harness.statuses.at(-1).text, undefined);
});

test("auto-review block blocks and emits the only completion notification", async () => {
  saveConfig(true);
  const harness = makeHarness(async () => ({ verdict: "block", reason: "Too broad" }));

  const result = await harness.call();
  assert.deepEqual(result, { block: true, reason: "Blocked by safety guard auto-review (git reset --hard)" });
  assert.equal(harness.selectCalls, 0);
  assert.deepEqual(harness.notifications, [{
    message: "Safety guard auto-review blocked bash: git reset --hard",
    type: "warning",
  }]);
  assert.equal(harness.widgets.at(-1).content, undefined);
});

test("review failure falls back to the existing prompt and stays fail-closed without UI", async () => {
  saveConfig(true);
  const interactive = makeHarness(async () => { throw new Error("provider unavailable"); }, {
    select: async () => "Allow once",
  });
  assert.equal(await interactive.call(), undefined);
  assert.equal(interactive.selectCalls, 1);
  assert.deepEqual(interactive.notifications, []);
  assert.equal(interactive.widgets.at(-1).content, undefined);

  const nonInteractive = makeHarness(async () => { throw new Error("timeout"); }, { hasUI: false });
  assert.deepEqual(await nonInteractive.call(), {
    block: true,
    reason: "Blocked git command (git reset --hard) in non-interactive mode",
  });
});

test("session allow-list bypass remains ahead of model review", async () => {
  saveConfig(true);
  let reviewCalls = 0;
  const harness = makeHarness(async () => {
    reviewCalls += 1;
    throw new Error("use prompt");
  }, { select: async () => "Allow the command for the current session" });

  assert.equal(await harness.call(), undefined);
  assert.equal(await harness.call(), undefined);
  assert.equal(reviewCalls, 1);
  assert.equal(harness.selectCalls, 1);
});

test("overlapping reviews cannot clear another active indicator", async () => {
  saveConfig(true);
  const resolvers = [];
  const harness = makeHarness(() => new Promise((resolve) => resolvers.push(resolve)));

  const first = harness.call("git reset --hard", "first");
  const second = harness.call("git reset --hard", "second");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(resolvers.length, 2);
  assert.match(harness.widgets.at(-1).content[0], /2 tool calls/);

  resolvers[0]({ verdict: "allow", reason: "Scoped" });
  await first;
  assert.ok(Array.isArray(harness.widgets.at(-1).content), "first cleanup must keep the second indicator visible");
  assert.match(harness.widgets.at(-1).content[0], /tool call/);

  resolvers[1]({ verdict: "allow", reason: "Scoped" });
  await second;
  assert.equal(harness.widgets.at(-1).content, undefined);
  assert.equal(harness.statuses.at(-1).text, undefined);
});
