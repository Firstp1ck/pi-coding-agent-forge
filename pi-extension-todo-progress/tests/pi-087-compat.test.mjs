import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const runtimeUrl = process.env.PI_GOAL_TEST_RUNTIME || import.meta.resolve("@earendil-works/pi-coding-agent");
const sdk = await import(runtimeUrl);
const supported = typeof sdk.SessionManager.prototype.appendContextEdit === "function";
const nativeTest = (name, run) => test(name, { skip: supported ? false : "Select Pi >=0.87 with PI_GOAL_TEST_RUNTIME", timeout: 15000 }, run);
const textOf = message => typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");

async function fixture(t, { todo = false, enableTools = false, factories = [], entries = [] } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "todo-pi087-"));
  let session;
  t.after(async () => {
    try { if (session) { await session.abort(); session.dispose(); } }
    finally { await rm(cwd, { recursive: true, force: true }); }
  });
  // Resolve the fake provider from the selected SDK, not the repository's older peers.
  const searchPaths = createRequire(runtimeUrl).resolve.paths("@earendil-works/pi-ai");
  const fauxPath = searchPaths.map(dir => join(dir, "@earendil-works/pi-ai/dist/providers/faux.js")).find(existsSync);
  assert.ok(fauxPath, "Selected SDK must include its faux provider test helper");
  const { fauxProvider, fauxAssistantMessage } = await import(pathToFileURL(fauxPath).href);
  const provider = fauxProvider({ provider: "todo-compat-fixture", api: "todo-compat-fixture" });
  const requests = [];
  provider.setResponses(Array.from({ length: 6 }, () => context => {
    requests.push(structuredClone(context));
    // Stop even if a regression accidentally requests repeated continuations.
    return fauxAssistantMessage(requests.length < 6 ? "Partial fixture work." : "Fixture request ceiling reached.", { stopReason: requests.length < 6 ? "stop" : "error" });
  }));
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(provider.provider);
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, enableInstallTelemetry: false });
  const extensionFactories = [];
  if (todo) {
    const source = (await readFile(new URL("../index.ts", import.meta.url), "utf8")).replace('"@firstpick/pi-utils"', JSON.stringify(new URL("../../pi-utils/src/markdown.ts", import.meta.url).href));
    await writeFile(join(cwd, "index.ts"), source);
    await writeFile(join(cwd, "goal-runtime.ts"), await readFile(new URL("../goal-runtime.ts", import.meta.url)));
    extensionFactories.push({ name: "todo", factory: (await import(pathToFileURL(join(cwd, "index.ts")).href)).default });
  }
  extensionFactories.push(...factories);
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories });
  await loader.reload();
  const created = await sdk.createAgentSession({ cwd, agentDir: cwd, model: provider.getModel(), modelRuntime, settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd, { id: "compat-session" }, entries), noTools: enableTools ? "builtin" : "all" });
  session = created.session;
  assert.deepEqual(created.extensionsResult.errors, []);
  const errors = [];
  await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
  return { session, requests, errors, provider, fauxAssistantMessage };
}

nativeTest("native goal_resume continues restored work in the current run and checkpoints the new identity", async t => {
  const { createGoalRuntime } = await import("../goal-runtime.ts");
  const stopped = { ...createGoalRuntime("Verify the original scope", "native-goal", "stopped-run"), status: "paused" };
  let starts = 0;
  const f = await fixture(t, {
    todo: true,
    enableTools: true,
    entries: [{ type: "custom", id: "saved-goal", parentId: null, timestamp: new Date().toISOString(), customType: "todo-progress-goal-state", data: stopped }],
    factories: [{ name: "resume-observer", factory: pi => { pi.on("agent_start", () => { starts++; }); } }],
  });
  let resumed;
  f.provider.setResponses([
    context => {
      f.requests.push(structuredClone(context));
      assert.match(context.messages.map(textOf).join("\n"), /Controller status: paused/);
      return f.fauxAssistantMessage({ type: "toolCall", id: "resume-native", name: "goal_resume", arguments: { goalId: stopped.goalId, runId: stopped.runId } }, { stopReason: "toolUse" });
    },
    context => {
      f.requests.push(structuredClone(context));
      const result = f.session.sessionManager.getEntries().findLast(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "goal_resume").message;
      assert.equal(result.isError, false);
      resumed = result.details;
      assert.equal(resumed.goalId, stopped.goalId);
      assert.notEqual(resumed.runId, stopped.runId);
      assert.match(context.messages.map(textOf).join("\n"), /Controller status: running/);
      return f.fauxAssistantMessage({ type: "toolCall", id: "finish-native", name: "goal_checkpoint", arguments: {
        goalId: resumed.goalId, runId: resumed.runId, status: "completed", summary: "Fixture verified", coverage: ["Original scope"], verificationEvidence: ["Offline fixture assertions passed"],
      } }, { stopReason: "toolUse" });
    },
    f.fauxAssistantMessage("Unexpected extra request", { stopReason: "error" }),
  ]);
  await f.session.prompt("Resume the goal");
  await f.session.waitForIdle();
  assert.deepEqual(f.errors, []);
  assert.equal(f.provider.state.callCount, 2);
  assert.equal(starts, 1, "Tool resume must not dispatch a duplicate run");
  const entries = f.session.sessionManager.getEntries();
  const final = entries.findLast(entry => entry.customType === "todo-progress-goal-state").data;
  assert.equal(final.status, "completed");
  assert.equal(final.runId, resumed.runId);
  assert.equal(final.progressRevision, 0);
  assert.deepEqual(entries.filter(entry => entry.type === "message" && entry.message.role === "user").map(entry => textOf(entry.message)), ["Resume the goal"]);
});

nativeTest("todo continuation starts only after every async settled handler finishes", async t => {
  let starts = 0;
  let settlements = 0;
  const observed = [];
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const f = await fixture(t, { todo: true, factories: [{ name: "settlement-observer", factory: pi => {
    pi.on("agent_start", () => { observed.push(`start:${++starts}`); });
    pi.on("agent_settled", async (_event, ctx) => {
      const sequence = ++settlements;
      observed.push(`settled:${sequence}`);
      await new Promise(resolve => setImmediate(resolve));
      observed.push(`idle:${ctx.isIdle()}:starts:${starts}`);
      if (sequence === 2) {
        await f.session.extensionRunner.getCommand("goal-pause").handler("", f.session.extensionRunner.createCommandContext());
        finish();
      }
    });
  } }] });
  await f.session.extensionRunner.getCommand("goal").handler("Complete the offline fixture", f.session.extensionRunner.createCommandContext());
  let timer;
  try {
    await Promise.race([done, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Continuation did not settle")), 10000); })]);
    await f.session.waitForIdle();
  } finally { clearTimeout(timer); }
  assert.deepEqual(f.errors, []);
  assert.deepEqual(observed, ["start:1", "settled:1", "idle:true:starts:1", "start:2", "settled:2", "idle:true:starts:2"]);
  assert.equal(f.requests.length, 2);
  const state = f.session.sessionManager.getEntries().findLast(entry => entry.customType === "todo-progress-goal-state").data;
  assert.equal(state.status, "paused");
  assert.equal(state.continuationOutstanding, false);
});

nativeTest("SessionManager restoration, context edits and navigation override the AgentSession message cache", async t => {
  const entry = (id, parentId, content) => ({ type: "message", id, parentId, timestamp: new Date().toISOString(), message: { role: "user", content, timestamp: Date.now() } });
  const f = await fixture(t, { entries: [entry("original", null, "original-content"), entry("omitted", "original", "omitted-content")] });
  const manager = f.session.sessionManager;
  const beforeEdits = manager.appendCustomEntry("compat-before-edits", {});
  manager.appendContextEdit("original", { content: "replacement-content" });
  manager.appendContextEdit("omitted", null);
  manager.appendMessage({ role: "user", content: "appended-content", timestamp: Date.now() });
  f.session.refreshContext();
  f.session.agent.state.messages = [{ role: "user", content: "cache-only-content", timestamp: Date.now() }];
  await f.session.prompt("first-probe");
  const first = f.requests[0].messages.map(textOf);
  assert.ok(first.includes("replacement-content"));
  assert.ok(first.includes("appended-content"));
  for (const hidden of ["original-content", "omitted-content", "cache-only-content"]) assert.ok(!first.includes(hidden));
  assert.equal(textOf(manager.getEntry("original").message), "original-content", "raw history must remain unchanged");
  await f.session.navigateTree(beforeEdits, { summarize: false });
  await f.session.prompt("second-probe");
  const second = f.requests[1].messages.map(textOf);
  assert.ok(second.includes("original-content"));
  assert.ok(second.includes("omitted-content"));
  assert.ok(!second.includes("replacement-content"));
  assert.ok(!second.includes("appended-content"));
  assert.deepEqual(f.errors, []);
});

nativeTest("native turn and pre-settlement boundaries chain context edits and continuation", async t => {
  const turns = [];
  const previews = [];
  let beforeSettle = 0;
  const f = await fixture(t, { factories: [{ name: "boundary-writer", factory: pi => {
    pi.on("turn_end", event => {
      turns.push(event);
      if (turns.length !== 1) return;
      return { entries: [...event.entries, { type: "context_edit", targetId: event.messageEntryId, replacement: null }, { type: "custom_message", customType: "compat-reminder", content: "boundary-reminder", display: false }], continue: true };
    });
    pi.on("agent_before_settle", event => {
      beforeSettle++;
      return { entries: [...event.entries, { type: "custom", customType: "compat-settlement", data: { checked: true } }] };
    });
  } }, { name: "boundary-observer", factory: pi => {
    pi.on("turn_end", event => { previews.push({ entries: event.entries, continue: event.continue, messages: event.context.contextMessages.map(textOf) }); });
  } }] });
  await f.session.prompt("boundary-probe");
  assert.deepEqual(f.errors, []);
  assert.equal(turns.length, 2);
  assert.equal(beforeSettle, 1);
  for (const event of turns) {
    assert.equal(event.outcome, "completed");
    assert.equal(typeof event.messageEntryId, "string");
    assert.deepEqual(event.toolResultEntryIds, []);
    assert.ok(Array.isArray(event.entries));
    assert.equal(typeof event.continue, "boolean");
    assert.ok(Array.isArray(event.context.contextMessages));
    assert.ok(f.session.sessionManager.getEntry(event.messageEntryId));
  }
  assert.equal(previews[0].continue, true);
  assert.equal(previews[0].entries[0].replacement, null);
  assert.ok(previews[0].messages.includes("boundary-reminder"));
  assert.ok(!previews[0].messages.includes("Partial fixture work."));
  assert.ok(f.requests[1].messages.map(textOf).includes("boundary-reminder"));
  assert.ok(f.session.sessionManager.getEntries().some(entry => entry.customType === "compat-settlement"));
});
