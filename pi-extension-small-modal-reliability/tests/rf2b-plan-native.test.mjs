import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, initTheme } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "../node_modules/@earendil-works/pi-ai/dist/providers/faux.js";
import reliabilityExtension from "../index.ts";

const hash = text => createHash("sha256").update(text).digest("hex");

test("RF2b installed host retains native session across all plan phases and verify/report/completion", { timeout: 15000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "rf2b-plan-native-"));
  const agentDir = mkdtempSync(join(tmpdir(), "rf2b-plan-agent-"));
  let session;
  let release;
  try {
    initTheme(undefined, false);
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    const provider = fauxProvider({ provider: "rf2b-plan", api: "rf2b-plan" });
    modelRuntime.registerNativeProvider(provider.provider);
    const phases = [];
    const errors = [];
    let owner;
    let started;
    const firstCall = new Promise(resolve => { started = resolve; });
    const admitted = new Promise(resolve => { release = resolve; });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: "",
      extensionFactories: [{ name: "reliability", factory: reliabilityExtension }, { name: "observer", factory: pi => {
        pi.on("tool_result", event => { if (event.isError) errors.push(JSON.stringify(event)); });
        pi.on("context", () => { if (session) assert.equal(session.sessionManager.getSessionId(), owner); });
      } }],
    });
    await loader.reload();
    const created = await createAgentSession({ cwd, agentDir, model: provider.getModel(), modelRuntime, sessionManager: SessionManager.inMemory(cwd), settingsManager, resourceLoader: loader, tools: ["reliability_status", "reliability_record_progress", "reliability_set_plan", "reliability_verify_completion"] });
    session = created.session;
    owner = session.sessionManager.getSessionId();
    const taskPath = () => join(cwd, ".pi", "tasks", readdirSync(join(cwd, ".pi", "tasks"), { withFileTypes: true }).find(entry => entry.isDirectory()).name);
    const run = () => JSON.parse(readFileSync(join(taskPath(), "plan-mode", "plan-mode-state.json"), "utf8"));
    const slots = { explore: ["exploration", "01-exploration.md"], plan: ["plan", "02-implementation-plan.md"], summarize: ["summary", "03-summary.md"], verify: ["verification", "04-verification.md"], report: ["final-report", "05-final-report.md"] };
    const written = new Set();
    let planned = false;
    let completed = false;
    const response = async () => {
      if (!phases.length) { started(); await admitted; }
      const current = run();
      if (phases.at(-1) !== current.phase) phases.push(current.phase);
      if (current.phase === "plan" && !planned) {
        planned = true;
        return fauxAssistantMessage(fauxToolCall("reliability_set_plan", { steps: [{ step_id: "S1", title: "Review design", description: "Produce the bounded design review", expected_output: "A design review", verification: "User reviews the design" }] }, { id: "native-plan" }), { stopReason: "toolUse" });
      }
      if (current.phase === "implement" && !completed) {
        completed = true;
        return fauxAssistantMessage(fauxToolCall("reliability_record_progress", { step_id: "S1", step_status: "complete" }, { id: "native-step" }), { stopReason: "toolUse" });
      }
      if (slots[current.phase] && !written.has(current.phase)) {
        written.add(current.phase);
        const [slot, name] = slots[current.phase];
        const previous = readFileSync(join(taskPath(), "plan-mode", name), "utf8");
        return fauxAssistantMessage(fauxToolCall("reliability_record_progress", { artifact: { run_id: current.run_id, phase: current.phase, slot, expected_sha256: hash(previous), content: `# Native ${current.phase}\nStatus: ${current.phase === "verify" ? "PASSED" : "COMPLETE"}\n` + "Untrusted phase prose; the user attestation is independent evidence. ".repeat(3) } }, { id: `native-${slot}` }), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("Partial: phase artifact submitted; await the retained-session continuation.");
    };
    provider.setResponses(Array.from({ length: 30 }, () => response));
    const command = session.extensionRunner.getCommand("reliability");
    const base = session.extensionRunner.createCommandContext();
    const ctx = Object.create(base);
    const ui = Object.create(base.ui);
    ui.confirm = async () => true;
    ui.notify = () => {};
    Object.defineProperties(ctx, { hasUI: { value: true }, ui: { value: ui } });
    await command.handler("--mode plan-on Review the supplied design", ctx);
    await firstCall;
    const state = JSON.parse(readFileSync(join(taskPath(), "state.json"), "utf8"));
    for (const criterion of state.criteria) await command.handler(`attest ${criterion.id} Native user reviewed the design`, ctx);
    release();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && run().phase !== "complete") await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(run().phase, "complete", JSON.stringify({ phases, run: run(), errors }));
    await session.waitForIdle();
    assert.deepEqual(phases, ["explore", "plan", "implement", "summarize", "verify", "report"]);
    assert.equal(errors.length, 0, errors.join("\n"));
    const final = JSON.parse(readFileSync(join(taskPath(), "state.json"), "utf8"));
    assert.equal(final.status, "complete");
    assert.equal(final.task_identity.session_id, owner);
    assert.equal(session.sessionManager.getSessionId(), owner);
    assert.equal(final.authoritative_instructions.corrections.length, 0);
    assert.equal(final.input_pause, undefined);
    assert.equal(session.extensionRunner.getAllRegisteredTools().length, 10);
    assert.match(readFileSync(join(taskPath(), "plan-mode", "05-final-report.md"), "utf8"), /Status: COMPLETE/);
  } finally {
    release?.();
    await session?.abort();
    session?.dispose();
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
