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

nativeTest("native todo_update delivers full normalized public snapshots and cloned session persistence", async t => {
  const f = await fixture(t, { todo: true, enableTools: true });
  const initial = { tasks: Array.from({ length: 12 }, (_, i) => ({ text: `  Step\n ${i}  `, status: i === 0 ? "in_progress" : "pending" })), goal: "  Checklist\n only  " };
  const normalized = { type: "todo-progress", version: 1, tasks: initial.tasks.map((task, i) => ({ text: `Step ${i}`, status: task.status })), goal: "Checklist only" };
  const tool = (id, args) => f.fauxAssistantMessage({ type: "toolCall", id, name: "todo_update", arguments: args }, { stopReason: "toolUse" });
  const results = () => f.session.sessionManager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo_update").map(entry => entry.message);
  const states = () => f.session.sessionManager.getEntries().filter(entry => entry.customType === "todo-progress-state");
  let firstState;
  let stateCount;
  f.provider.setResponses([
    context => {
      f.requests.push(structuredClone(context));
      assert.match(f.session.systemPrompt, /Use todo_update for checklist creation and changes/);
      assert.doesNotMatch(f.session.systemPrompt, /Emit markdown checklist lines/);
      return tool("create", initial);
    },
    context => {
      f.requests.push(structuredClone(context));
      assert.equal(results()[0].isError, false);
      assert.deepEqual(results()[0].details, normalized);
      assert.equal(results()[0].content[0].text, "Todo progress updated: 0/12 completed.");
      assert.match(context.messages.map(textOf).join("\n"), /Use todo_update for any checklist creation/);
      assert.ok(!f.session.sessionManager.getEntries().some(entry => entry.customType === "todo-progress-goal-state"), "A label never starts a durable goal");
      firstState = states().at(-1).data;
      stateCount = states().length;
      return tool("unchanged", { tasks: normalized.tasks, goal: normalized.goal });
    },
    context => {
      f.requests.push(structuredClone(context));
      assert.equal(states().length, stateCount, "Identical native snapshots do not append state");
      assert.deepEqual(results()[1].details, normalized);
      results()[0].details.tasks[0].text = "Mutated tool result";
      assert.equal(firstState.items[0].text, "Step 0", "Native SessionManager retains independent tool and state objects");
      return tool("replacement", { tasks: [{ text: "Final verification", status: "completed" }] });
    },
    context => {
      f.requests.push(structuredClone(context));
      assert.deepEqual(results()[2].details, { type: "todo-progress", version: 1, tasks: [{ text: "Final verification", status: "completed" }] });
      assert.equal(states().at(-1).data.awaitingGoalCheck, true);
      assert.equal(firstState.items.length, 12);
      assert.equal(firstState.items[0].status, "partial");
      return tool("clear", { tasks: [] });
    },
    context => {
      f.requests.push(structuredClone(context));
      assert.deepEqual(results()[3].details, { type: "todo-progress", version: 1, tasks: [] });
      assert.deepEqual(states().at(-1).data.items, []);
      assert.equal(states().at(-1).data.visible, false);
      return f.fauxAssistantMessage("Verification complete.", { stopReason: "stop" });
    },
  ]);
  await f.session.prompt("Track this work without automatic continuation.");
  await f.session.waitForIdle();
  assert.deepEqual(f.errors, []);
  assert.equal(f.provider.state.callCount, 5, f.session.sessionManager.getEntries().findLast(entry => entry.type === "message" && entry.message.role === "assistant")?.message.errorMessage);
  assert.equal(f.session.sessionManager.getEntries().findLast(entry => entry.type === "message" && entry.message.role === "assistant").message.errorMessage, undefined, "Faux callbacks must not swallow assertion failures");
  assert.deepEqual(initial.tasks[0], { text: "  Step\n 0  ", status: "in_progress" });
});

nativeTest("native todo_update rejects schema-invalid results without changing prior progress", async t => {
  const f = await fixture(t, { todo: true, enableTools: true });
  const tool = (id, args) => f.fauxAssistantMessage({ type: "toolCall", id, name: "todo_update", arguments: args }, { stopReason: "toolUse" });
  let snapshot;
  f.provider.setResponses([
    tool("valid", { tasks: [{ text: "Keep current work", status: "pending" }] }),
    () => {
      snapshot = structuredClone(f.session.sessionManager.getEntries().findLast(entry => entry.customType === "todo-progress-state").data);
      return tool("invalid", { tasks: [{ text: "Bad", status: "done" }] });
    },
    () => {
      const entries = f.session.sessionManager.getEntries();
      const failed = entries.findLast(entry => entry.type === "message" && entry.message.role === "toolResult").message;
      assert.equal(failed.isError, true);
      assert.equal(failed.details?.type, undefined, "SDK errors must not carry a successful todo-progress discriminator");
      assert.equal(failed.details?.tasks, undefined);
      assert.deepEqual(entries.findLast(entry => entry.customType === "todo-progress-state").data, snapshot);
      return f.fauxAssistantMessage("Preserve recovery state.", { stopReason: "error" });
    },
  ]);
  await f.session.prompt("Track work without automatic continuation.");
  await f.session.waitForIdle();
  assert.deepEqual(f.errors, []);
  assert.equal(f.provider.state.callCount, 3);
  assert.equal(f.session.sessionManager.getEntries().findLast(entry => entry.type === "message" && entry.message.role === "assistant").message.errorMessage, undefined);
});

nativeTest("native active tool selection routes guidelines and disabled mode keeps Markdown parsing", async t => {
  const f = await fixture(t, { todo: true, enableTools: true });
  f.session.setActiveToolsByName([]);
  f.provider.setResponses([
    context => {
      assert.match(f.session.systemPrompt, /If todo_update is unavailable or disabled, emit markdown checklist lines/);
      assert.doesNotMatch(f.session.systemPrompt, /Use todo_update for checklist creation and changes/);
      assert.doesNotMatch(f.session.systemPrompt, /Send the full ordered snapshot/);
      return f.fauxAssistantMessage("Goal: Fallback only\n- [ ] Inspect\n- [-] Verify", { stopReason: "error" });
    },
  ]);
  await f.session.prompt("Track work without automatic continuation.");
  await f.session.waitForIdle();
  const entries = f.session.sessionManager.getEntries();
  assert.equal(entries.findLast(entry => entry.type === "message" && entry.message.role === "assistant").message.errorMessage, undefined);
  assert.deepEqual(entries.findLast(entry => entry.customType === "todo-progress-state").data.items, [
    { text: "Inspect", status: "todo" }, { text: "Verify", status: "partial" },
  ]);
  assert.deepEqual(f.errors, []);
});

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
    context => {
      f.requests.push(structuredClone(context));
      assert.match(context.messages.map(textOf).join("\n"), /Checkpoint recorded/);
      return f.fauxAssistantMessage("The original scope is verified. The offline fixture passed; no further work is needed.", { stopReason: "stop" });
    },
    f.fauxAssistantMessage("Unexpected extra request", { stopReason: "error" }),
  ]);
  await f.session.prompt("Resume the goal");
  await f.session.waitForIdle();
  assert.deepEqual(f.errors, []);
  assert.equal(f.provider.state.callCount, 3, "The checkpoint must allow a final assistant reply, but not an extra run");
  assert.equal(starts, 1, "Tool resume must not dispatch a duplicate run");
  const entries = f.session.sessionManager.getEntries();
  const final = entries.findLast(entry => entry.customType === "todo-progress-goal-state").data;
  assert.equal(final.status, "completed");
  assert.equal(final.runId, resumed.runId);
  assert.equal(final.progressRevision, 0);
  assert.equal(entries.filter(entry => entry.type === "message" && entry.message.role === "assistant").at(-1).message.content[0].text,
    "The original scope is verified. The offline fixture passed; no further work is needed.");
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
