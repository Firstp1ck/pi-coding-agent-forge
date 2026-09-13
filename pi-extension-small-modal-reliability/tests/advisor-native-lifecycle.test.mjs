import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import reliabilityExtension from "../index.ts";

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

for (const replaceTask of [false, true]) {
test(`installed AgentSession ${replaceTask ? "rejects advisor delivery after task replacement" : "delivers one reserved advisor recommendation on the next natural request"}`, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "reliability-advisor-native-"));
  const agentDir = mkdtempSync(join(tmpdir(), "reliability-advisor-agent-"));
  let session;
  let releaseAdvisor = () => {};
  let startupTimer;
  try {
    initTheme(undefined, false);
    const main = fauxProvider({ provider: "advisor-main-fixture", api: "advisor-main-fixture" });
    const advisor = fauxProvider({ provider: "advisor-only-fixture", api: "advisor-only-fixture" });
    const advisorId = `${advisor.getModel().provider}/${advisor.getModel().id}`;
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi", "reliability.json"), JSON.stringify({
      enabled: true,
      contextBudgetChars: 12000,
      advisor: { automatic: true, exactModel: advisorId, dataScope: "diagnostic-summary", maxCalls: 1, maxRuntimeMs: 1000, maxOutputChars: 2000, maxTotalTokens: 100000, maxTotalCostUsd: 1 },
    }));
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(main.provider);
    modelRuntime.registerNativeProvider(advisor.provider);
    await modelRuntime.setRuntimeApiKey(advisor.getModel().provider, "fixture-only-key");
    main.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }, { id: "missing-read" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("Partial: the required file is unavailable."),
    ]);
    const recommendation = "Inspect the missing file path before trying again.";
    let advisorStarted;
    const started = new Promise((resolve) => { advisorStarted = resolve; });
    const release = new Promise((resolve) => { releaseAdvisor = resolve; });
    advisor.setResponses([async () => {
      advisorStarted();
      if (replaceTask) await release;
      return fauxAssistantMessage(JSON.stringify({ revised_next_action: recommendation, hypotheses: ["The file name may be wrong."] }));
    }]);
    const contexts = [];
    const inputs = [];
    const loader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: "",
      extensionFactories: [
        { name: "reliability-test", factory: reliabilityExtension },
        { name: "advisor-lifecycle-observer", factory: (pi) => {
          pi.on("context", (event) => { contexts.push(event.messages.map(textOf).join("\n")); });
          pi.on("input", (event) => { inputs.push(event.source); });
        } },
      ],
    });
    await loader.reload();
    const created = await createAgentSession({ cwd, agentDir, model: main.getModel(), modelRuntime, settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), tools: ["read"] });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    await session.bindExtensions({ mode: "print" });
    await session.prompt("/reliability on Read missing.txt and report partial if unavailable.");
    const run = session.sendCustomMessage({ customType: "fixture-continuation", content: "Execute the explicit task.", display: false }, { triggerTurn: true });
    if (replaceTask) {
      await Promise.race([started, new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Error("Advisor did not start")), 1500);
      })]);
      clearTimeout(startupTimer);
      await session.prompt("/reliability on Replacement task");
      releaseAdvisor();
    }
    await run;
    await session.waitForIdle();
    const taskRoot = join(cwd, ".pi", "tasks");
    const states = readdirSync(taskRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => JSON.parse(readFileSync(join(taskRoot, entry.name, "state.json"), "utf8")));
    const state = states.find((task) => task.user_goal !== "Replacement task");
    assert.equal(advisor.state.callCount, 1, JSON.stringify(state.advisor_state));
    assert.equal(main.state.callCount, 2, "advice must not create a synthetic continuation turn");
    assert.deepEqual(inputs, [], "trusted custom continuations add no user input authority");
    assert.equal(state.advisor_state.automatic_calls_used, 1);
    assert.equal(state.advisor_state.automatic_reservations.length, 0);
    assert.equal(state.advisor_state.records.at(-1).status, replaceTask ? "rejected" : "applied");
    assert.equal(state.scope_state.active_scope, undefined, "advice cannot create execution authority");
    assert.equal(contexts.at(-1).includes(recommendation), !replaceTask);
    if (replaceTask) {
      const replacement = states.find((task) => task.user_goal === "Replacement task");
      assert.ok(replacement);
      assert.equal(replacement.advisor_state.automatic_calls_used, 0);
      assert.equal(replacement.scope_state.active_scope, undefined);
      assert.equal(replacement.working_context.claims.some((claim) => claim.text.includes(recommendation)), false);
    } else {
      assert.ok(state.working_context.claims.some((claim) => claim.text.includes("Advisor recommendation (untrusted)")));
    }
  } finally {
    clearTimeout(startupTimer);
    releaseAdvisor();
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
}
