import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createModelResearchExtension, inferModelAuthor } from "../index.ts";
import { FIXED_REFERENCE_PATHS, RECIPROCAL_REVIEW_RUBRIC } from "../src/types.ts";
import { MODEL_USAGE_TASKS, OVERALL_RESEARCH_TASK } from "../src/scope.ts";
import { escapeSubjectLabel, subjectChoiceLabels } from "../src/subjects.ts";
import { usageSummaryFixture } from "./usage-summary.mjs";

function fixtureOutput(prompt) {
  const subjectBlock = prompt.match(/^BEGIN UNTRUSTED COMPARISON SUBJECTS JSON[^\n]*\n([^\n]+)\nEND UNTRUSTED COMPARISON SUBJECTS JSON/m);
  const subjects = subjectBlock ? JSON.parse(subjectBlock[1]) : undefined;
  const identityLine = prompt.match(/^(?:Researcher|Reviewer) identity: (.+)$/m);
  if (identityLine) {
    const identity = JSON.parse(identityLine[1]);
    const key = identity.key;
    if (prompt.includes("Researcher identity:")) {
      const date = prompt.match(/Research cutoff\/as-of date: (\d{4}-\d{2}-\d{2})/)[1];
      return JSON.stringify({
        schemaVersion: 1, researcher: identity, ...(subjects ? { subjects } : {}), subjectTargets: ["a", "b"], asOfDate: date,
        taskSpecificRecommendation: "Conditional fixture advice; not a real model evaluation.",
        arguments: [{ id: `${key}-arg-1`, task: "Writing a skill", claim: "A bounded fixture claim", classification: "anecdotal", evidenceIds: [`${key}-ev-1`], support: "Synthetic fixture, not measured", counterevidence: "No real evaluation", conditions: "Offline fixture only", recommendation: "Do not treat this as real advice", confidence: 10 }],
        evidence: [{ id: `${key}-ev-1`, url: `https://example.com/${key}`, accessedAt: date, sourceAccess: "snippet", evidenceClass: "anecdotal", topics: ["general-routing"], supportsTarget: "neither", title: "Synthetic test source", excerptOrGap: "This fixture did not fetch a real source.", conditions: "Test only" }],
        counterevidenceAndConditions: ["No real evaluation"], confidence: 10,
        socialCoverage: { x: { status: "gap", evidenceIds: [], gap: "Offline fixture" }, reddit: { status: "gap", evidenceIds: [], gap: "Offline fixture" }, other: { status: "gap", evidenceIds: [], gap: "Offline fixture", platforms: [] } }, accessGaps: ["All live sources omitted"],
      });
    }
    return JSON.stringify({ schemaVersion: 1, reviewer: identity, reviewedOriginals: ["a", "b"], rubric: [...RECIPROCAL_REVIEW_RUBRIC], usefulnessVsOwn: { verdict: "mixed", explanation: "Both fixture reports preserve gaps." }, corrections: [], disagreements: [{ topic: "Suitability", position: "Not established by fixtures", evidenceIds: [] }], missingEvidence: ["Live comparative evidence"], writerRecommendation: "undetermined", writerEvidenceIds: [], confidence: 10 });
  }
  const date = prompt.match(/Evidence as-of date: (\d{4}-\d{2}-\d{2})/)[1];
  const compared = subjects?.map(subject => escapeSubjectLabel(subject.model)) ?? [...new Set([...prompt.matchAll(/"model":"([^"]+)"/g)].map(match => match[1]))];
  let summaryRow = 0;
  const choices = subjects ? subjectChoiceLabels(subjects) : compared;
  const summary = usageSummaryFixture().replace(/\| Insufficient evidence \|/g, () => `| ${choices[(summaryRow++) % choices.length]} |`);
  return `---\nname: model-routing-fixture\ndescription: Use this fixture only to test generated model-routing drafts.\n---\n\n## Routing guidance\n\nEvidence as of ${date}. Compared IDs: ${compared.join(", ")}. This is synthetic test data, not a recommendation to use one real model over another. Consider the task and the conditions in both reports.\n\n## Limits and uncertainty\n\nNo source was fetched and no capability was measured. The writer was selected by an explicit user choice. Do not treat agreement, schema checks, or fixture results as empirical evidence.\n\n## Refresh triggers\n\nReplace all synthetic findings with actual, dated and reviewed evidence before any real use.\n\n## Supporting evidence\n\n${FIXED_REFERENCE_PATHS.map(ref => `- [Record](${ref})`).join("\n")}\n\n${summary}`;
}

const t3Tools = ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"].map(name => ({ name: `mcp__t3-code__${name}`, parameters: { type: "object" } }));
const webTools = ["brave_search"].map(name => ({ name, parameters: { type: "object" } }));

async function setup(t, kind = "pi", options = {}) {
  const temp = await mkdtemp(path.join(tmpdir(), "model-research-integration-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const tools = new Map(); const events = new Map(); const entries = []; const messages = []; const confirmations = []; const inputs = []; const selections = []; const modelCalls = []; const hostCalls = []; const tasks = new Map(); const registryCalls = []; const dialogs = []; const selectionChoices = [];
  const models = options.models ?? [{ provider: "anthropic", id: "claude-test", name: "Alpha", maxTokens: 20000 }, { provider: "openai-codex", id: "gpt-test", name: "Beta", maxTokens: 20000, ...(options.minimalOnly ? { reasoning: true, thinkingLevelMap: { off: null, minimal: "minimal" } } : {}) }];
  const output = prompt => options.transformOutput ? options.transformOutput(fixtureOutput(prompt), prompt) : fixtureOutput(prompt);
  const pi = {
    registerTool(tool) { tools.set(tool.name, tool); }, registerCommand(_name, command) { this.command = command; }, on(name, fn) { events.set(name, fn); },
    appendEntry(customType, data) { entries.push({ type: "custom", customType, data }); }, sendUserMessage(content, settings) { messages.push({ content, settings }); },
  };
  createModelResearchExtension({ stateRoot: path.join(temp, "state"), env: { ...(kind === "t3" ? { T3_MCP_URL: "http://localhost:unused" } : {}), ...(options.allowHeadless ? { PI_MODEL_RESEARCH_ALLOW_HEADLESS: "1" } : {}) } })(pi);
  const catalog = { parentThreadId: "thread-fixture", inheritedProviderInstanceId: "pi", features: { appOwnedSubagents: true, asyncPolling: true, cancellation: true }, providers: [{ providerInstanceId: "claudeAgent", canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], models: [{ id: "claude-fable-test", options: [{ id: "fast", type: "boolean", currentValue: false }] }] }, { providerInstanceId: "pi", canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], models: [{ id: "openai-codex/gpt-test", options: [{ id: "fast", type: "boolean", currentValue: false }] }] }] };
  const ctx = {
    cwd: temp, mode: kind === "pi" ? "tui" : "rpc", hasUI: options.hasUI ?? true,
    sessionManager: { getSessionId: () => "session-fixture", getBranch: () => entries }, scopedModels: [],
    modelRegistry: {
      getAvailable: () => models,
      find: (provider, id) => { registryCalls.push({ action: "find", provider, model: id }); return models.find(model => model.provider === provider && model.id === id); },
      hasConfiguredAuth: model => { registryCalls.push({ action: "auth", provider: model.provider, model: model.id }); return !options.unauthenticated?.includes(model.id); },
      streamSimple(model, context, settings) {
        modelCalls.push({ model, context: structuredClone(context), settings });
        const research = context.messages[0].content.includes("Researcher identity:");
        const search = context.messages.length === 1 && research;
        const policyProbe = options.policyProbe && context.messages.length === 3 && research;
        const content = search ? [{ type: "toolCall", id: "fixture-search", name: "brave_search", arguments: { query: "synthetic fixture source" } }] : policyProbe ? [{ type: "toolCall", id: "fixture-policy", name: "model_research_fetch", arguments: { url: "https://example.com:8080/" } }] : [{ type: "text", text: output(context.messages[0].content) }];
        const message = { role: "assistant", provider: model.provider, model: model.id, content, stopReason: search || policyProbe ? "toolUse" : "stop", usage: { input: 20, output: 10, cacheRead: 2, cacheWrite: 0, totalTokens: 32, cost: { total: 0.01 } } };
        return { async *[Symbol.asyncIterator]() { yield { type: "done", message }; } };
      },
    },
    tools: options.noTools ? [] : [...(kind === "t3" ? t3Tools : webTools), ...[...tools.values()].filter(tool => tool.exposure === "codemode")],
    ui: {
      async select(title, choices) { dialogs.push({ kind: "select", title }); selections.push(title); selectionChoices.push(choices); return options.cancelSelection ? undefined : choices[0]; },
      async input(title) { dialogs.push({ kind: "input", title }); inputs.push(title); return options.subjectInputs ? options.subjectInputs[inputs.length - 1] : ["gpt-6.1-sol", "claude-opus-5.5"][(inputs.length - 1) % 2]; },
      async confirm(title, message) { dialogs.push({ kind: "confirm", title }); confirmations.push({ title, message }); return options.approved !== false; }, setStatus() {}, notify() {},
    },
    async executeTool(name, args) {
      hostCalls.push({ name, args });
      let result;
      if (name === "model_research_fetch") {
        const result = await tools.get(name).execute("nested-reader", args, undefined, undefined, ctx);
        return { result, isError: result.isError === true };
      }
      if (name === "brave_search") return { content: [{ type: "text", text: "Synthetic offline search results at https://example.com/a and https://example.com/b" }] };
      if (name.endsWith("orchestrator_capabilities")) result = catalog;
      else if (name.endsWith("delegate_task")) {
        const taskId = `fixture-task-${tasks.size + 1}`;
        result = { taskId, providerInstanceId: args.target.providerInstanceId, model: args.target.model, status: "running", workState: "working", summary: null };
        tasks.set(taskId, { ...result, summary: output(args.task), status: "completed", workState: "result_available" });
      } else if (name.endsWith("task_status")) result = tasks.get(args.taskId);
      else if (name.endsWith("task_cancel")) result = { ...tasks.get(args.taskId), status: "cancelled" };
      else throw new Error("Synthetic final responses must not call real web tools");
      return { isError: false, content: [{ type: "text", text: kind === "t3" ? `${JSON.stringify(result, null, 2)}\n${JSON.stringify(result)}` : JSON.stringify(result) }] };
    },
  };
  const operation = tools.get("model_research");
  const call = params => tools.get("model_research").execute("call-fixture", params, undefined, undefined, ctx);
  const decoded = response => JSON.parse(response.content[0].text);
  const reload = () => createModelResearchExtension({ stateRoot: path.join(temp, "state"), env: { ...(kind === "t3" ? { T3_MCP_URL: "http://localhost:unused" } : {}), ...(options.allowHeadless ? { PI_MODEL_RESEARCH_ALLOW_HEADLESS: "1" } : {}) } })(pi);
  return { pi, ctx, registryCalls, reload, dialogs, selectionChoices, events, confirmations, inputs, selections, messages, modelCalls, hostCalls, tasks, operation, call, decoded };
}

const SUBJECTS = [{ key: "a", model: "gpt-6.1-sol" }, { key: "b", model: "claude-opus-5.5" }];
const PI_TARGETS = [{ hostingProvider: "anthropic", model: "claude-test" }, { hostingProvider: "openai-codex", model: "gpt-test" }];
const T3_TARGETS = [{ hostingProvider: "claudeAgent", model: "claude-fable-test" }, { hostingProvider: "pi", model: "openai-codex/gpt-test" }];

function assertSeparateIdentities(data, kind) {
  assert.deepEqual(data.subjects, SUBJECTS);
  assert.deepEqual(data.workers, data.models, "models must retain worker compatibility");
  assert.deepEqual(data.workers.map(({ hostingProvider, model }) => ({ hostingProvider, model })), kind === "pi" ? PI_TARGETS : T3_TARGETS);
}

function assertConsent(h, data) {
  const consent = h.confirmations[0].message;
  assert.match(consent, /Compared subjects \(unverified labels\):/);
  assert.match(consent, /Research workers \(execution only\):/);
  for (const subject of data.subjects) assert.ok(consent.includes(JSON.stringify(subject.model)));
  for (const worker of data.workers) assert.ok(consent.includes(worker.displayName));
  assert.ok(consent.includes(data.runId));
}

async function assertSubjectArtifacts(data, kind) {
  const record = JSON.parse(await readFile(data.recordPath, "utf8"));
  assert.deepEqual(record.run.subjects, SUBJECTS);
  assert.equal(record.run.jobs.length, 5);
  assert.deepEqual(record.run.targets, data.workers);
  assert.deepEqual(record.run.jobs.map(job => job.target), ["a", "b", "a", "b", record.run.writerSelection.target]);
  for (const key of ["a", "b"]) {
    assert.deepEqual(record.run.originals[key].parsed.subjects, SUBJECTS);
    assert.equal(record.run.originals[key].parsed.researcher.model, data.workers[key === "a" ? 0 : 1].model);
    assert.equal(record.run.reviews[key].parsed.reviewer.model, data.workers[key === "a" ? 0 : 1].model);
    assert.equal(record.run.reviews[key].parsed.writerRecommendation, "undetermined");
    assert.deepEqual(record.run.reviews[key].parsed.writerEvidenceIds, []);
  }
  const draft = await readFile(data.draftPath, "utf8");
  const comparison = await readFile(data.comparisonPath, "utf8");
  assert.match(comparison, /## Compared subjects/);
  assert.match(comparison, /## Research workers/);
  assert.match(comparison, /Selected research worker/);
  for (const subject of SUBJECTS) assert.ok(draft.includes(subject.model));
  for (const worker of data.workers) assert.equal(draft.includes(worker.model), false, `draft must not route to ${kind} worker`);
  const section = draft.slice(draft.indexOf("## When to use each model"));
  assert.equal(comparison.slice(comparison.indexOf("## When to use each model")).trim(), section.trim());
  const rows = section.split("\n").filter(line => line.startsWith("| ") && !line.startsWith("| Task |"));
  assert.equal(rows.length, 15);
  assert.deepEqual(rows.map(row => row.split("|")[1].trim()), [...MODEL_USAGE_TASKS]);
  assert.ok(rows.every(row => SUBJECTS.some(subject => row.split("|")[2].trim() === subject.model)));
  for (const [index, key] of ["a", "b"].entries()) {
    const original = await readFile(path.join(path.dirname(data.draftPath), FIXED_REFERENCE_PATHS[index]), "utf8");
    assert.equal(original, record.run.originals[key].raw);
    assert.deepEqual(JSON.parse(original).subjects, SUBJECTS);
  }
  return { draft, comparison };
}

test("native Pi free-text subjects, worker dispatch, reload, explicit writer and export work end-to-end offline", async t => {
  const h = await setup(t);
  const started = await h.call({ action: "start" });
  const data = h.decoded(started);
  assert.equal(data.status, "awaiting_writer");
  assert.deepEqual(h.dialogs.map(dialog => dialog.kind), ["input", "input", "select", "select", "confirm"]);
  assertSeparateIdentities(data, "pi");
  assert.equal(started.details.subjects[0].model, "gpt-6.1-sol");
  assertConsent(h, data);
  h.reload();
  const listed = h.decoded(await h.call({ action: "list" }));
  assertSeparateIdentities(listed[0], "pi");
  assert.equal(h.modelCalls.length, 6, "reload/list must not dispatch");
  assert.equal(h.modelCalls.length, 6);
  assert.equal(h.confirmations.length, 1);
  assert.deepEqual(h.inputs, ["Comparison subject A", "Comparison subject B"]);
  assert.equal(h.selections[0], "Research worker A (pi)");
  assert.ok(h.confirmations[0].message.includes(OVERALL_RESEARCH_TASK));
  for (const task of MODEL_USAGE_TASKS) assert.ok(h.modelCalls[0].context.messages[0].content.includes(task));
  assert.match(h.confirmations[0].message, /Both providers receive/);
  assert.ok(h.confirmations[0].message.includes(data.runId));
  assert.ok(h.ctx.tools.some(tool => tool.name === "model_research_fetch"));
  assert.equal(h.operation.executionMode, "sequential");
  assert.equal(started.usage.totalTokens, 192);
  for (const call of h.modelCalls.filter(call => call.context.messages[0].content.includes("Reviewer identity:"))) assert.equal("tools" in call.context, false);
  const status = await h.call({ action: "status", runId: data.runId });
  assert.equal(status.usage.totalTokens, 0);
  assertSeparateIdentities(h.decoded(status), "pi");
  const completed = await h.call({ action: "writer", runId: data.runId });
  assert.match(h.selections.at(-1), /Choose a research worker.*cannot select a worker/);
  assert.ok(h.selectionChoices.at(-1).every(label => label.includes("research worker") && !label.includes("gpt-6.1-sol")));
  assert.equal(h.decoded(completed).writer.target, "a");
  assert.equal(h.decoded(completed).writer.mode, "user");
  assert.equal(h.decoded(completed).status, "complete");
  assert.match(h.decoded(completed).draftPath, /SKILL\.md$/);
  assert.equal(completed.usage.totalTokens, 32);
  assert.equal(h.modelCalls.length, 7);
  const artifacts = await assertSubjectArtifacts(h.decoded(completed), "pi");
  const exported = await h.call({ action: "export", runId: data.runId });
  assert.equal(await readFile(h.decoded(completed).draftPath, "utf8"), artifacts.draft);
  assert.equal(await readFile(h.decoded(completed).comparisonPath, "utf8"), artifacts.comparison);
  assert.deepEqual(h.modelCalls.map(call => call.model.id), ["claude-test", "claude-test", "gpt-test", "gpt-test", "claude-test", "gpt-test", "claude-test"]);
  assert.ok(h.registryCalls.every(call => ["claude-test", "gpt-test"].includes(call.model)));
  assert.equal(exported.usage.totalTokens, 0);
  assert.equal(h.modelCalls.length, 7);
});

test("registered reader policy failures remain fatal across native-shaped host results", async t => {
  const h = await setup(t, "pi", { policyProbe: true });
  const result = h.decoded(await h.call({ action: "start", task: "Fixture policy boundary" }));
  assert.equal(result.status, "error");
  assert.equal(result.error.code, "runtime_error");
  assert.match(result.error.message, /standard web ports/);
  assert.equal(h.modelCalls.length, 2, "no final research claim is accepted after a policy failure");
});

test("native Pi selection chooses the lowest supported thinking level when off is unavailable", async t => {
  const h = await setup(t, "pi", { minimalOnly: true });
  const result = h.decoded(await h.call({ action: "start", task: "Fixture" }));
  assert.equal(result.status, "awaiting_writer");
  assert.equal(result.models[1].settings.thinking, "minimal");
  assert.equal(h.modelCalls.find(call => call.model.id === "gpt-test").settings.reasoning, "minimal");
});

test("T3 RPC setup dispatches exactly five app-owned jobs over explicit continuations", async t => {
  const h = await setup(t, "t3");
  let result = await h.call({ action: "start" });
  assert.deepEqual(h.inputs, ["Comparison subject A", "Comparison subject B"]);
  assert.equal(h.selections[0], "Research worker A (t3)");
  assert.ok(h.confirmations[0].message.includes(OVERALL_RESEARCH_TASK));
  const runId = h.decoded(result).runId;
  assertSeparateIdentities(h.decoded(result), "t3");
  assertConsent(h, h.decoded(result));
  assert.deepEqual(h.dialogs.map(dialog => dialog.kind), ["input", "input", "select", "select", "confirm"]);
  h.reload();
  assertSeparateIdentities(h.decoded(await h.call({ action: "status", runId })), "t3");
  assertSeparateIdentities(h.decoded(await h.call({ action: "list" }))[0], "t3");
  assert.equal(h.hostCalls.filter(call => call.name.endsWith("task_status")).length, 0);
  assert.equal(result.terminate, true);
  assert.equal(h.tasks.size, 2);
  assert.equal(h.modelCalls.length, 0);
  const notices = await h.events.get("before_agent_start")({ messageType: "user", prompt: "Delegated task fixture-task-1 reached a terminal state." }, h.ctx);
  assert.match(notices.message.content, /action=continue/);
  assert.equal(h.tasks.size, 2, "notification hook must not dispatch anything");
  result = await h.call({ action: "continue", runId });
  assert.equal(h.tasks.size, 4);
  assert.equal(h.hostCalls.filter(call => call.name.endsWith("task_status")).length, 2);
  result = await h.call({ action: "continue", runId });
  assert.equal(h.decoded(result).status, "awaiting_writer");
  assert.equal(h.hostCalls.filter(call => call.name.endsWith("task_status")).length, 4);
  result = await h.call({ action: "writer", runId, writer: "b" });
  assert.equal(h.tasks.size, 5);
  assert.match(h.confirmations.at(-1).message, /choose research worker b.*openai-codex\/gpt-test/);
  assert.match(h.confirmations.at(-1).message, /does not choose a comparison winner/);
  assert.equal(result.terminate, true);
  result = await h.call({ action: "continue", runId });
  assert.equal(h.decoded(result).status, "complete");
  assert.equal(h.modelCalls.length, 0);
  assert.equal(h.hostCalls.filter(call => call.name.endsWith("task_status")).length, 5);
  assert.ok(h.decoded(result).jobs.every(job => job.taskId));
  assertSeparateIdentities(h.decoded(result), "t3");
  await assertSubjectArtifacts(h.decoded(result), "t3");
  const delegates = h.hostCalls.filter(call => call.name.endsWith("delegate_task"));
  assert.deepEqual(delegates.map(call => [call.args.target.providerInstanceId, call.args.target.model]), [
    ["claudeAgent", "claude-fable-test"], ["pi", "openai-codex/gpt-test"],
    ["claudeAgent", "claude-fable-test"], ["pi", "openai-codex/gpt-test"], ["pi", "openai-codex/gpt-test"],
  ]);
  for (const call of h.hostCalls.filter(call => call.name.endsWith("delegate_task"))) {
    assert.equal(call.args.mode, "async");
    assert.equal(call.args.runtimeMode, "approval-required");
    assert.equal(call.args.target.options.fast, false);
    assert.match(call.args.clientRequestId, /^study-/);
  }
});

test("T3 notifications match each active run without resurrecting old markers", async t => {
  const h = await setup(t, "t3");
  const first = h.decoded(await h.call({ action: "start", task: "First fixture" }));
  const second = h.decoded(await h.call({ action: "start", task: "Second fixture" }));
  assert.equal(second.status, "running");
  assert.equal(h.tasks.size, 4);
  const notification = { messageType: "user", prompt: "Delegated task fixture-task-1 reached a terminal state." };
  const hook = h.events.get("before_agent_start");
  assert.ok((await hook(notification, h.ctx)).message.content.includes(first.runId));
  await h.call({ action: "cancel", runId: first.runId });
  assert.equal(await hook(notification, h.ctx), undefined);
});

test("native consent shows the complete bounded task, not a silently truncated preview", async t => {
  const h = await setup(t, "pi", { approved: false });
  const task = "A".repeat(19_980) + " END_OF_FULL_TASK";
  await h.call({ action: "start", task });
  assert.ok(h.confirmations[0].message.includes(task));
  assert.equal(h.modelCalls.length, 0);
});

test("declined consent and missing T3 bridge cause no model dispatch", async t => {
  const declined = await setup(t, "pi", { approved: false });
  const response = await declined.call({ action: "start", confirmed: true });
  assert.match(response.content[0].text, /cancelled before model dispatch/);
  assert.equal(declined.modelCalls.length, 0);
  assert.equal(declined.confirmations.length, 1);
  const unavailable = await setup(t, "t3", { noTools: true });
  const denied = await unavailable.call({ action: "start" });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Missing callable T3 tools/);
  assert.equal(unavailable.modelCalls.length, 0);
});

test("headless start requires informed consent and command bridge queues only the dedicated operation", async t => {
  const h = await setup(t, "pi", { hasUI: false, allowHeadless: true });
  const targets = [{ hostingProvider: "anthropic", model: "claude-test" }, { hostingProvider: "openai-codex", model: "gpt-test" }];
  const disabled = await setup(t, "pi", { hasUI: false });
  const blocked = await disabled.call({ action: "start", task: "Fixture", targets, confirmed: true });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /PI_MODEL_RESEARCH_ALLOW_HEADLESS/);
  assert.equal(disabled.modelCalls.length, 0);
  const denied = await h.call({ action: "start", task: "Fixture", targets });
  assert.match(denied.content[0].text, /cancelled before model dispatch/);
  assert.equal(h.modelCalls.length, 0);
  const accepted = await h.call({ action: "start", targets, confirmed: true });
  assert.equal(h.decoded(accepted).status, "awaiting_writer");
  assert.deepEqual(h.inputs, []);
  assert.deepEqual(h.selections, []);
  const legacy = h.decoded(accepted);
  assert.deepEqual(legacy.subjects.map(subject => subject.model), targets.map(target => target.model));
  assert.deepEqual(legacy.workers, legacy.models);
  assert.equal(Object.hasOwn(JSON.parse(await readFile(legacy.recordPath, "utf8")).run, "subjects"), false);
  h.reload();
  const resumed = await h.call({ action: "writer", runId: legacy.runId, writer: "b", confirmed: true });
  assert.equal(h.decoded(resumed).status, "complete");
  assert.deepEqual(h.inputs, []);
  await h.pi.command.handler("", h.ctx);
  await h.pi.command.handler("start", h.ctx);
  await h.pi.command.handler("start Prioritize TypeScript examples", h.ctx);
  await h.pi.command.handler("continue study-test", h.ctx);
  assert.match(h.messages[0].content, /"action":"start"/);
  assert.match(h.messages[1].content, /"action":"start"/);
  assert.match(h.messages[2].content, /"task":"Prioritize TypeScript examples"/);
  assert.match(h.messages[3].content, /"action":"continue","runId":"study-test"/);
  assert.match(h.messages[3].content, /do not poll/);
  assert.equal(inferModelAuthor("pi", "openrouter/anthropic/claude-version"), "anthropic");
  assert.equal(inferModelAuthor("custom", "notclaude-company"), undefined);
});

for (const kind of ["pi", "t3"]) {
  test(`${kind} cancelled and invalid native subjects stop before worker selection, consent or dispatch`, async t => {
    const cases = [
      { labels: [], inputCount: 1, error: /cancelled/ },
      { labels: ["First"], inputCount: 2, error: /cancelled/ },
      { labels: ["  ", "Second"], error: /1 through 200/ },
      { labels: ["First", "\tSecond"], error: /control characters/ },
      { labels: ["First\nline", "Second"], error: /single-line/ },
      { labels: ["First", "Second\u2028line"], error: /single-line/ },
      { labels: ["First", "Second\u200b"], error: /control characters/ },
      { labels: ["First", "Second\u007f"], error: /control characters/ },
      { labels: ["First", "x".repeat(201)], error: /1 through 200/ },
      { labels: ["  Same model  ", "sAME MODEL"], error: /must differ/ },
    ];
    for (const example of cases) await t.test(JSON.stringify(example.labels), async t => {
      const h = await setup(t, kind, { subjectInputs: example.labels });
      const response = await h.call({ action: "start", confirmed: true });
      assert.equal(response.isError, true);
      assert.match(response.content[0].text, example.error);
      assert.equal(h.inputs.length, example.inputCount ?? 2);
      assert.deepEqual(h.selections, []);
      assert.deepEqual(h.confirmations, []);
      assert.equal(h.modelCalls.length, 0);
      assert.equal(h.tasks.size, 0);
      assert.deepEqual(h.decoded(await h.call({ action: "list" })), []);
    });
  });

  test(`${kind} rejects malformed tool subjects before native setup and dispatch`, async t => {
    for (const subjects of [null, [], ["one"], ["one", "two", "three"], ["one", 2], ["one", ""], ["one", "ONE"], ["one", "x".repeat(201)], ["one", "two\r"]]) {
      const h = await setup(t, kind);
      const response = await h.call({ action: "start", subjects, targets: kind === "pi" ? PI_TARGETS : T3_TARGETS, confirmed: true });
      assert.equal(response.isError, true, JSON.stringify(subjects));
      assert.match(response.content[0].text, /subjects/);
      assert.deepEqual(h.dialogs, []);
      assert.equal(h.modelCalls.length, 0);
      assert.equal(h.tasks.size, 0);
    }
  });

  test(`${kind} explicit tool subjects skip label dialogs and retain native run-bound consent`, async t => {
    const h = await setup(t, kind, { approved: false });
    const labels = ["gpt-unknown-one", "gpt-unknown-two"];
    const response = await h.call({ action: "start", subjects: labels, confirmed: true });
    assert.match(response.content[0].text, /cancelled before model dispatch/);
    assert.deepEqual(h.inputs, []);
    assert.equal(h.selections.length, 2);
    assert.equal(h.confirmations.length, 1, "confirmed cannot replace available native approval");
    assert.match(h.confirmations[0].message, /Run ID: study-/);
    for (const label of labels) assert.ok(h.confirmations[0].message.includes(label));
    assert.equal(h.modelCalls.length, 0);
    assert.equal(h.tasks.size, 0);
  });

  test(`${kind} headless explicit subjects require opt-in, exact workers and both authorizations`, async t => {
    const targets = kind === "pi" ? PI_TARGETS : T3_TARGETS;
    const subjects = SUBJECTS.map(subject => subject.model);
    const disabled = await setup(t, kind, { hasUI: false });
    assert.match((await disabled.call({ action: "start", subjects, targets, confirmed: true })).content[0].text, /PI_MODEL_RESEARCH_ALLOW_HEADLESS/);
    const h = await setup(t, kind, { hasUI: false, allowHeadless: true });
    assert.match((await h.call({ action: "start", subjects, confirmed: true })).content[0].text, /two explicit targets/);
    assert.match((await h.call({ action: "start", subjects, targets })).content[0].text, /cancelled before model dispatch/);
    assert.equal(h.modelCalls.length, 0);
    assert.equal(h.tasks.size, 0);
    let data = h.decoded(await h.call({ action: "start", subjects, targets, confirmed: true }));
    if (kind === "t3") {
      data = h.decoded(await h.call({ action: "continue", runId: data.runId }));
      data = h.decoded(await h.call({ action: "continue", runId: data.runId }));
    }
    assert.equal(data.status, "awaiting_writer");
    assertSeparateIdentities(data, kind);
    const countBefore = kind === "pi" ? h.modelCalls.length : h.tasks.size;
    const denied = await h.call({ action: "writer", runId: data.runId, writer: "a" });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /authorized writer choice/);
    assert.equal(kind === "pi" ? h.modelCalls.length : h.tasks.size, countBefore);
    data = h.decoded(await h.call({ action: "writer", runId: data.runId, writer: "a", confirmed: true }));
    if (kind === "t3") data = h.decoded(await h.call({ action: "continue", runId: data.runId }));
    assert.equal(data.status, "complete");
    await assertSubjectArtifacts(data, kind);
    assert.deepEqual(h.dialogs, []);
  });
}

test("native labels are trimmed and accept same-author, unknown and Markdown-like names without registry resolution", async t => {
  for (const labels of [[" gpt-unconfigured-one ", "gpt-unconfigured-two  "], ["Unknown lab model", "Unreleased model"], ["Pretend <worker> | **first**", "Second [label] ($100)"]]) {
    const h = await setup(t, "pi", { subjectInputs: labels });
    let data = h.decoded(await h.call({ action: "start" }));
    assert.equal(data.status, "awaiting_writer");
    assert.deepEqual(data.subjects.map(subject => subject.model), labels.map(label => label.trim()));
    assert.equal(h.inputs.length, 2, "subject authors never trigger registry-author questions");
    data = h.decoded(await h.call({ action: "writer", runId: data.runId, writer: "a" }));
    assert.equal(data.status, "complete");
    const draft = await readFile(data.draftPath, "utf8");
    const record = JSON.parse(await readFile(data.recordPath, "utf8"));
    assert.deepEqual(record.run.subjects, data.subjects);
    for (const subject of data.subjects) assert.ok(draft.includes(escapeSubjectLabel(subject.model)));
    assert.ok(h.registryCalls.every(call => ["claude-test", "gpt-test"].includes(call.model)));
  }
});

test("native consent preserves 200-character subjects, long worker IDs and full additional context", async t => {
  const workerId = `claude-${"x".repeat(1000)}-END_WORKER`;
  const labels = [`a${"x".repeat(186)}END_SUBJECT_A`, `b${"y".repeat(186)}END_SUBJECT_B`];
  assert.ok(labels.every(label => label.length === 200));
  const h = await setup(t, "pi", { approved: false, subjectInputs: labels, models: [
    { provider: "anthropic", id: workerId, name: "Long worker", maxTokens: 20000 },
    { provider: "openai-codex", id: "gpt-test", name: "Other worker", maxTokens: 20000 },
  ] });
  const task = "T".repeat(19_980) + " END_FULL_CONTEXT";
  const result = await h.call({ action: "start", task });
  assert.match(result.content[0].text, /cancelled before model dispatch/);
  for (const label of labels) assert.ok(h.confirmations[0].message.includes(label));
  assert.ok(h.confirmations[0].message.includes(workerId));
  assert.ok(h.confirmations[0].message.includes(task));
  assert.equal(h.modelCalls.length, 0);
});

test("free labels do not bypass worker authentication or different-author restrictions", async t => {
  const unauth = await setup(t, "pi", { unauthenticated: ["gpt-test"] });
  const unavailable = await unauth.call({ action: "start", subjects: SUBJECTS.map(subject => subject.model), targets: PI_TARGETS });
  assert.equal(unavailable.isError, true);
  assert.match(unavailable.content[0].text, /unavailable/);
  assert.equal(unauth.modelCalls.length, 0);
  const sameAuthor = await setup(t, "pi", { models: [
    { provider: "anthropic", id: "claude-test", name: "One", maxTokens: 20000 },
    { provider: "anthropic", id: "claude-other", name: "Two", maxTokens: 20000 },
  ] });
  const refused = await sameAuthor.call({ action: "start", subjects: ["Unknown one", "Unknown two"] });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /model-author families must differ/);
  assert.equal(sameAuthor.modelCalls.length, 0);
  assert.equal(sameAuthor.confirmations.length, 0);
});

test("explicit native worker targets without subjects keep legacy setup and old records resume without migration", async t => {
  const h = await setup(t);
  let data = h.decoded(await h.call({ action: "start", targets: PI_TARGETS }));
  assert.equal(data.status, "awaiting_writer");
  assert.deepEqual(h.dialogs.map(dialog => dialog.kind), ["confirm"]);
  assert.deepEqual(data.subjects.map(subject => subject.model), PI_TARGETS.map(target => target.model));
  const record = JSON.parse(await readFile(data.recordPath, "utf8"));
  assert.equal(Object.hasOwn(record.run, "subjects"), false);
  // Fixture for schema-v1 records predating overall scope and explicit subjects.
  delete record.run.scope;
  await writeFile(data.recordPath, JSON.stringify(record));
  const oldBytes = await readFile(data.recordPath, "utf8");
  h.reload();
  const status = h.decoded(await h.call({ action: "status", runId: data.runId }));
  assert.deepEqual(status.subjects, data.subjects);
  assert.equal(await readFile(data.recordPath, "utf8"), oldBytes, "status never rewrites legacy records");
  data = h.decoded(await h.call({ action: "writer", runId: data.runId, writer: "a" }));
  assert.equal(data.status, "complete");
  const completed = JSON.parse(await readFile(data.recordPath, "utf8"));
  assert.equal(Object.hasOwn(completed.run, "subjects"), false);
  assert.equal(Object.hasOwn(completed.run, "scope"), false);
  const comparison = await readFile(data.comparisonPath, "utf8");
  assert.match(comparison, /## Compared models/);
  assert.doesNotMatch(comparison, /## Compared subjects|## Research workers/);
  await h.call({ action: "export", runId: data.runId });
  assert.equal(await readFile(data.comparisonPath, "utf8"), comparison);
  assert.deepEqual(h.inputs, []);
});

test("subject/worker output substitutions fail through the registered operation without extra jobs", async t => {
  for (const fault of ["missing-subjects", "swapped-subjects", "spoofed-researcher", "worker-vote", "draft-worker-choices"]) {
    const h = await setup(t, "pi", { transformOutput(raw, prompt) {
      if (prompt.includes("Researcher identity:")) {
        const value = JSON.parse(raw);
        if (fault === "missing-subjects") delete value.subjects;
        if (fault === "swapped-subjects") value.subjects.reverse();
        if (fault === "spoofed-researcher") value.researcher.model = SUBJECTS[0].model;
        return JSON.stringify(value);
      }
      if (fault === "worker-vote" && prompt.includes("Reviewer identity:")) {
        const value = JSON.parse(raw);
        value.writerRecommendation = "a";
        return JSON.stringify(value);
      }
      return fault === "draft-worker-choices" ? raw.replaceAll("| gpt-6.1-sol |", "| claude-test |") : raw;
    } });
    let data = h.decoded(await h.call({ action: "start" }));
    if (fault === "draft-worker-choices") {
      assert.equal(data.status, "awaiting_writer");
      data = h.decoded(await h.call({ action: "writer", runId: data.runId, writer: "a" }));
    }
    assert.equal(data.status, "error", fault);
    assert.equal(data.error.code, "invalid_output", fault);
    assert.ok(data.jobs.every(job => job.key !== "draft" || job.status !== "complete"));
    assert.ok(h.modelCalls.length <= 7);
    assert.ok(h.modelCalls.every(call => ["claude-test", "gpt-test"].includes(call.model.id)));
  }
});

test("explicit subjects and workers show only native confirmation and retain bounded input schemas", async t => {
  for (const kind of ["pi", "t3"]) await t.test(kind, async t => {
    const h = await setup(t, kind);
    const targets = kind === "pi" ? PI_TARGETS : T3_TARGETS;
    const data = h.decoded(await h.call({ action: "start", subjects: SUBJECTS.map(subject => subject.model), targets }));
    assert.deepEqual(h.dialogs.map(dialog => dialog.kind), ["confirm"]);
    assert.deepEqual(data.subjects, SUBJECTS);
    assert.equal(h.operation.parameters.properties.subjects.items.maxLength, 20_000);
    assert.equal(h.operation.parameters.properties.subjects.maxItems, 2);
  });
});

test("registered operation rejects worker routing prose, incomplete subject identities and raw choice rendering", async t => {
  const cases = [
    { name: "worker-routing", subjects: ["requested-one", "requested-two"], transform: raw => raw.replace("Consider the task and the conditions in both reports.", "For coding always route to research worker claude-test instead of these subjects."), error: /must not reference research worker/ },
    { name: "identity-prefix", subjects: ["gpt-5", "requested-two"], transform: raw => raw.replace("Compared IDs: gpt-5,", "Compared IDs: gpt-5-mini,").replaceAll("| gpt-5 |", "| Insufficient evidence |"), error: /must identify exact model gpt-5/ },
    ...["<b>model-a</b>", "a&copy;b", "**model-a**"].map(label => ({ name: `raw-choice-${label}`, subjects: [label, "requested-two"], transform: raw => raw.replaceAll(`| ${escapeSubjectLabel(label)} |`, `| ${label} |`), error: /Use must name an exact compared model/ })),
  ];
  for (const probe of cases) await t.test(probe.name, async t => {
    const h = await setup(t, "pi", { transformOutput(raw, prompt) { return prompt.includes("Writer identity:") ? probe.transform(raw) : raw; } });
    let data = h.decoded(await h.call({ action: "start", subjects: probe.subjects, targets: PI_TARGETS }));
    assert.equal(data.status, "awaiting_writer");
    data = h.decoded(await h.call({ action: "writer", runId: data.runId, writer: "a" }));
    assert.equal(data.status, "error");
    assert.equal(data.error.code, "invalid_output");
    assert.match(data.error.message, probe.error);
    assert.equal(data.draftPath, undefined);
    assert.equal(h.modelCalls.length, 7, "no repair or additional paid model job");
  });
});

test("inconclusive-word subjects keep exact stored names and unambiguous rendered choices", async t => {
  const h = await setup(t, "pi", { subjectInputs: ["Either", "Neither"] });
  let data = h.decoded(await h.call({ action: "start" }));
  assert.deepEqual(data.subjects.map(subject => subject.model), ["Either", "Neither"]);
  data = h.decoded(await h.call({ action: "writer", runId: data.runId, writer: "a" }));
  assert.equal(data.status, "complete");
  const draft = await readFile(data.draftPath, "utf8");
  const comparison = await readFile(data.comparisonPath, "utf8");
  for (const choice of ["Subject A: Either", "Subject B: Neither"]) {
    assert.ok(draft.includes(`| ${choice} |`));
    assert.ok(comparison.includes(`| ${choice} |`));
  }
  const decision = JSON.parse(await readFile(path.join(path.dirname(data.draftPath), "references/decision.json"), "utf8"));
  assert.match(decision.rationale, /comparison subjects cannot select the writer/);
  assert.doesNotMatch(decision.rationale, /reviews were inconclusive/);
});

test("T3 legacy headless targets resume and export without subject inputs or record migration", async t => {
  const h = await setup(t, "t3", { hasUI: false, allowHeadless: true });
  let data = h.decoded(await h.call({ action: "start", targets: T3_TARGETS, confirmed: true }));
  const runId = data.runId;
  assert.deepEqual(data.subjects.map(subject => subject.model), T3_TARGETS.map(target => target.model));
  h.reload();
  data = h.decoded(await h.call({ action: "continue", runId }));
  data = h.decoded(await h.call({ action: "continue", runId }));
  assert.equal(data.status, "awaiting_writer");
  data = h.decoded(await h.call({ action: "writer", runId, writer: "b", confirmed: true }));
  data = h.decoded(await h.call({ action: "continue", runId }));
  assert.equal(data.status, "complete");
  assert.equal(h.tasks.size, 5);
  const record = JSON.parse(await readFile(data.recordPath, "utf8"));
  assert.equal(Object.hasOwn(record.run, "subjects"), false);
  assert.deepEqual(data.models, data.workers);
  const comparison = await readFile(data.comparisonPath, "utf8");
  assert.match(comparison, /## Compared models/);
  assert.doesNotMatch(comparison, /## Compared subjects|## Research workers/);
  await h.call({ action: "export", runId });
  assert.equal(await readFile(data.comparisonPath, "utf8"), comparison);
  assert.deepEqual(h.dialogs, []);
});
