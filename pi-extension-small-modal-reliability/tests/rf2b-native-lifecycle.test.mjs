import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import reliabilityExtension from "../index.ts";

const textOf = message => typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function nativeFixture({ before, after, templates = false } = {}) {
  initTheme(undefined, false);
  const cwd = mkdtempSync(join(tmpdir(), "rf2b-native-"));
  const agentDir = mkdtempSync(join(tmpdir(), "rf2b-agent-"));
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const provider = fauxProvider({ provider: "rf2b-fake", api: "rf2b-fake" });
  modelRuntime.registerNativeProvider(provider.provider);
  provider.setResponses(Array.from({ length: 25 }, () => fauxAssistantMessage("Partial: awaiting the next explicit instruction.")));
  if (templates) {
    mkdirSync(join(agentDir, "prompts"), { recursive: true });
    writeFileSync(join(agentDir, "prompts", "review.md"), "Expanded template for $1.\n");
    mkdirSync(join(agentDir, "skills", "fixture-review"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "fixture-review", "SKILL.md"), "---\nname: fixture-review\ndescription: Test-only review skill\n---\nExpanded skill instructions.\n");
  }
  const deliveries = [];
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: !templates, noPromptTemplates: !templates, noThemes: true, noContextFiles: true, systemPrompt: "",
    extensionFactories: [
      ...(before ? [{ name: "before-fixture", factory: before }] : []),
      { name: "reliability", factory: reliabilityExtension },
      { name: "observer", factory: pi => { pi.on("message_start", event => { if (event.message.role === "user") deliveries.push(textOf(event.message)); }); } },
      ...(after ? [{ name: "after-fixture", factory: after }] : []),
    ],
  });
  await resourceLoader.reload();
  const { session, extensionsResult } = await createAgentSession({ cwd, agentDir, model: provider.getModel(), modelRuntime, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), tools: ["read"] });
  assert.deepEqual(extensionsResult.errors, []);
  await session.bindExtensions({ mode: "print", onError: error => { throw new Error(error.error); } });
  const base = session.extensionRunner.createCommandContext();
  const ctx = Object.create(base);
  const ui = Object.create(base.ui);
  const dialogs = [];
  const notifications = [];
  ui.notify = message => { notifications.push(message); };
  ui.confirm = async (title, body) => { dialogs.push({ title, body }); return true; };
  Object.defineProperties(ctx, { hasUI: { value: true, configurable: true }, ui: { value: ui } });
  const command = text => session.extensionRunner.getCommand("reliability").handler(text, ctx);
  const state = () => {
    const taskId = session.sessionManager.getBranch().filter(entry => entry.customType === "reliability-harness-state").at(-1)?.data.taskId
      ?? readdirSync(join(cwd, ".pi", "tasks"), { withFileTypes: true }).filter(entry => entry.isDirectory()).at(-1)?.name;
    return JSON.parse(readFileSync(join(cwd, ".pi", "tasks", taskId, "state.json"), "utf8"));
  };
  const authorities = () => session.sessionManager.getEntries().filter(entry => entry.customType === "reliability-authoritative-input");
  return { cwd, agentDir, session, provider, command, state, authorities, ctx, ui, dialogs, notifications, deliveries, resourceLoader,
    close() { session.dispose(); rmSync(cwd, { recursive: true, force: true }); rmSync(agentDir, { recursive: true, force: true }); } };
}

test("RF2b installed streaming steering and follow-ups (including direct bypass) remain observations", async () => {
  const f = await nativeFixture();
  const started = deferred();
  const release = deferred();
  try {
    await f.command("on Stream the explicit task");
    const sessionId = f.session.sessionManager.getSessionId();
    f.provider.setResponses([
      async () => { started.resolve(); await release.promise; return fauxAssistantMessage("Partial: streaming boundary reached."); },
      fauxAssistantMessage(fauxToolCall("read", { path: "should-not-run" }, { id: "paused-read" }), { stopReason: "toolUse" }),
      ...Array.from({ length: 12 }, () => fauxAssistantMessage("Partial: input confirmation is required.")),
    ]);
    const running = f.session.sendCustomMessage({ customType: "fixture-work", content: "Continue the explicit task", display: false }, { triggerTurn: true });
    await started.promise;
    await f.session.prompt("same queued text", { streamingBehavior: "steer", source: "interactive" });
    await f.session.prompt("same queued text", { streamingBehavior: "followUp", source: "rpc" });
    await f.session.steer("direct steering bypass");
    await f.session.followUp("direct follow-up bypass");
    await assert.rejects(f.session.prompt("rejected admission"), /streamingBehavior|already processing/);
    assert.equal(f.authorities().length, 1);
    release.resolve();
    await running;
    await f.session.waitForIdle();
    assert.ok(f.deliveries.includes("same queued text"));
    assert.ok(f.deliveries.includes("direct steering bypass"));
    assert.ok(f.deliveries.includes("direct follow-up bypass"));
    assert.equal(f.state().authoritative_instructions.corrections.length, 0);
    assert.equal(f.state().execution_receipts.some(receipt => receipt.operation === "read"), false);
    assert.ok(f.state().input_pause);
    assert.equal(f.session.sessionManager.getSessionId(), sessionId);
    await f.command("input confirm This is the exact new correction");
    const state = f.state();
    assert.equal(state.input_pause, undefined);
    assert.equal(state.authoritative_instructions.corrections.length, 1);
    assert.equal(state.authoritative_instructions.corrections[0].origin, "native-confirmation");
    assert.match(f.dialogs.at(-1).body, /new authority, not proof/);
    assert.equal(f.authorities().length, 2);
    await f.command("input confirm");
    assert.equal(f.authorities().length, 2, "duplicate confirmation has no pending observation");
  } finally { release.resolve(); f.close(); }
});

test("RF2b installed real template/skill expansion and transformations on both sides never become ingress proof", async () => {
  const f = await nativeFixture({ templates: true,
    before: pi => pi.on("input", event => event.text === "transform me" ? { action: "transform", text: "observed intermediate" } : undefined),
    after: pi => pi.on("input", event => event.text === "observed intermediate" ? { action: "transform", text: "delivered expansion" } : undefined),
  });
  try {
    await f.command("on");
    await f.session.prompt("transform me");
    await f.session.waitForIdle();
    assert.equal(f.authorities().length, 0);
    assert.ok(f.deliveries.includes("delivered expansion"));
    await f.command("input confirm");
    assert.equal(f.state().authoritative_instructions.original_user_request.text, "observed intermediate");
    assert.equal(f.state().authoritative_instructions.original_user_request.origin, "native-confirmation");
    assert.match(f.dialogs.at(-1).body, /observed intermediate/);
    assert.equal(f.resourceLoader.getPrompts().prompts.some(item => item.name === "review"), true);
    assert.equal(f.resourceLoader.getSkills().skills.some(item => item.name === "fixture-review"), true);
    for (const input of ["/review files", "/skill:fixture-review inspect", "/review files"]) {
      await f.session.prompt(input);
      await f.session.waitForIdle();
      const previous = f.authorities().length;
      await f.command("input confirm");
      assert.equal(f.authorities().length, previous + 1);
      assert.equal(f.state().authoritative_instructions.corrections.at(-1).text, input);
      assert.equal(f.state().authoritative_instructions.corrections.at(-1).origin, "native-confirmation");
    }
    assert.ok(f.deliveries.some(text => text.includes("Expanded template for files")));
    assert.ok(f.deliveries.some(text => text.includes("Expanded skill instructions")));
    const before = f.authorities().length;
    await f.session.sendCustomMessage({ customType: "fixture-extension", content: "Internal continuation", display: false }, { triggerTurn: true });
    await f.session.waitForIdle();
    assert.equal(f.authorities().length, before);
    assert.equal(f.state().input_pause, undefined);
  } finally { f.close(); }
});

test("RF2b handled/canceled input, native cancellation, queue clearing, and late UI decisions preserve the pause", async () => {
  const f = await nativeFixture({ after: pi => pi.on("input", event => event.text === "handled after observation" ? { action: "handled" } : undefined) });
  const started = deferred();
  const release = deferred();
  try {
    await f.command("on Retain this task");
    await f.session.prompt("handled after observation");
    assert.ok(f.state().input_pause);
    assert.equal(f.deliveries.length, 0);
    assert.equal(JSON.stringify(f.state()).includes("handled after observation"), false);
    f.ui.confirm = async () => false;
    await f.command("input confirm");
    assert.equal(f.authorities().length, 1);
    assert.ok(f.state().input_pause);
    Object.defineProperty(f.ctx, "hasUI", { value: false, configurable: true });
    await f.command("input confirm");
    assert.equal(f.authorities().length, 1);
    Object.defineProperty(f.ctx, "hasUI", { value: true, configurable: true });
    f.ui.confirm = async () => { started.resolve(); return release.promise; };
    const confirming = f.command("input confirm");
    await started.promise;
    f.session.sessionManager.appendCustomEntry("fixture-branch-change", {});
    release.resolve(true);
    await confirming;
    assert.equal(f.authorities().length, 1);
    assert.ok(f.state().input_pause);
    const streaming = deferred();
    const finish = deferred();
    f.provider.setResponses([async () => { streaming.resolve(); await finish.promise; return fauxAssistantMessage("Partial: retained context."); }]);
    const running = f.session.sendCustomMessage({ customType: "fixture-work", content: "Wait", display: false }, { triggerTurn: true });
    await streaming.promise;
    await f.session.prompt("canceled queue secret", { streamingBehavior: "steer" });
    f.session.clearQueue();
    finish.resolve();
    await running;
    await f.session.waitForIdle();
    assert.equal(f.deliveries.includes("canceled queue secret"), false);
    assert.equal(f.authorities().length, 1);
    assert.equal(JSON.stringify(f.state()).includes("canceled queue secret"), false);
    assert.ok(f.state().input_pause);
  } finally { release.resolve(false); f.close(); }
});

test("RF2b installed reload loses live text and requires explicit new reaffirmation", async () => {
  const f = await nativeFixture();
  try {
    await f.command("on Retain original authority");
    await f.session.prompt("live candidate not reconstructible after reload");
    await f.session.waitForIdle();
    const sessionId = f.session.sessionManager.getSessionId();
    const count = f.authorities().length;
    await f.session.reload();
    const base = f.session.extensionRunner.createCommandContext();
    const ctx = Object.create(base);
    const ui = Object.assign(Object.create(base.ui), { confirm: f.ui.confirm, notify: f.ui.notify });
    Object.defineProperties(ctx, { hasUI: { value: true }, ui: { value: ui } });
    const command = text => f.session.extensionRunner.getCommand("reliability").handler(text, ctx);
    await command("input confirm");
    assert.equal(f.authorities().length, count);
    assert.ok(f.state().input_pause);
    await command("input confirm Newly supplied exact correction");
    assert.equal(f.authorities().length, count + 1, f.notifications.join("\n"));
    assert.equal(f.state().authoritative_instructions.corrections.at(-1).text, "Newly supplied exact correction");
    assert.equal(f.state().input_pause, undefined);
    assert.equal(f.session.sessionManager.getSessionId(), sessionId);
  } finally { f.close(); }
});
