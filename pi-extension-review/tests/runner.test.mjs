import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerTestSdk } from "./package-test-loader.mjs";

registerTestSdk();

const { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, normalizeContext } = await import("@earendil-works/pi-ai");
const { Agent } = await import("@earendil-works/pi-agent-core");
const { appendEvidence, createTextTarget, createManifest, createReviewState, sha256, startAttempt } = await import("../src/core.ts");
const { finalizeReadObservation } = await import("../src/read-evidence.ts");
const { createReviewStorage } = await import("../src/storage.ts");
const { createReviewRuntimeStore, validateReviewSettings } = await import("../src/settings.ts");
const { createReviewStatusPublisher } = await import("../src/tui.ts");
const {
  DeterministicReviewRuntime,
  createRegistryStreamFn,
  freezeReview,
  nativeReadObservation,
  reviewProgressMark,
  snapshotDrift,
  virtualSnapshotPath,
} = await import("../src/runner.ts");

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function temp(label) { const root = await mkdtemp(path.join(os.tmpdir(), `review-runner-${label}-`)); roots.push(root); return root; }

const model = { id: "reviewer", name: "Reviewer", provider: "fake", api: "fake", baseUrl: "https://invalid.example", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
function terminalMessage(stopReason = "stop") { return { role: "assistant", content: [], api: "fake", provider: "fake", model: "reviewer", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() }; }
async function events(stream) { const result = []; for await (const event of stream) result.push(event); return result; }

function textTarget(text, ranges) {
  const bytes = Buffer.from(text);
  return createTextTarget({ path: "src/a.ts", version: `sha256:${sha256(bytes)}`, bytes, requiredRanges: ranges });
}

function nativeResult(text, truncation) { return { content: [{ type: "text", text }], ...(truncation ? { details: { truncation } } : {}) }; }

test("native read observation matches exact CRLF, BOM, no-final-newline and user-limit output", () => {
  for (const source of ["one\ntwo", "one\r\ntwo\r\n", "\ufeffone\ntwo\n"]) {
    const target = textTarget(source, [{ start: 1, end: 2 }]);
    const output = source;
    const observation = nativeReadObservation(target, { path: virtualSnapshotPath(target) }, nativeResult(output), new Date().toISOString());
    assert.ok(observation, `observation accepted for ${JSON.stringify(source)}`);
    assert.deepEqual(observation.returnedRange, { start: 1, end: 2 });
  }
  const target = textTarget("a\nb\nc", [{ start: 1, end: 3 }]);
  const limited = nativeReadObservation(target, { path: virtualSnapshotPath(target), offset: 2, limit: 1 }, nativeResult("b\n\n[1 more lines in file. Use offset=3 to continue.]"), new Date().toISOString());
  assert.deepEqual(limited.returnedRange, { start: 2, end: 2 });
  assert.equal(nativeReadObservation(target, { path: virtualSnapshotPath(target), offset: 2, limit: 1 }, nativeResult("b"), new Date().toISOString()), undefined, "missing continuation notice is not the finalized native output");
});

test("native truncation credits only exact complete lines and rejects first-long-line or forged notices", () => {
  const target = textTarget("a\nb\nc\nd", [{ start: 1, end: 4 }]);
  const truncation = { content: "a\nb", truncated: true, truncatedBy: "lines", totalLines: 4, totalBytes: 7, outputLines: 2, outputBytes: 3, lastLinePartial: false, firstLineExceedsLimit: false, maxLines: 2, maxBytes: 51200 };
  const accepted = nativeReadObservation(target, { path: virtualSnapshotPath(target) }, nativeResult("a\nb\n\n[Showing lines 1-2 of 4. Use offset=3 to continue.]", truncation), new Date().toISOString());
  assert.deepEqual(accepted.returnedRange, { start: 1, end: 2 });
  assert.equal(nativeReadObservation(target, { path: virtualSnapshotPath(target) }, nativeResult("a\nb\n\nforged", truncation), new Date().toISOString()), undefined);
  assert.equal(nativeReadObservation(target, { path: virtualSnapshotPath(target) }, nativeResult("[Line too long]", { ...truncation, content: "", outputLines: 0, firstLineExceedsLimit: true }), new Date().toISOString()), undefined);
});

test("overlapping rereads do not count as continuation progress", async () => {
  const target = textTarget("a\nb\nc", [{ start: 1, end: 3 }]);
  const manifest = createManifest({ reviewId: "progress-review", projectRoot: process.cwd(), createdAt: new Date().toISOString(), targets: [target] });
  let state = startAttempt(createReviewState({ manifest, ownerSessionId: "session-progress" }), new Date().toISOString());
  const first = finalizeReadObservation(manifest, { source: "tracked-read", targetId: target.id, version: target.version, sha256: target.sha256, requestedRange: { start: 1, end: 2 }, returnedRange: { start: 1, end: 2 }, lines: ["a", "b"], outcome: "success", completeLines: true, truncated: false, observedAt: new Date().toISOString() });
  state = appendEvidence(state, first.evidence, new Date().toISOString());
  const before = reviewProgressMark(state, false);
  const overlap = finalizeReadObservation(manifest, { source: "native-read", targetId: target.id, version: target.version, sha256: target.sha256, requestedRange: { start: 1, end: 1 }, returnedRange: { start: 1, end: 1 }, lines: ["a"], outcome: "success", completeLines: true, truncated: false, observedAt: new Date().toISOString() });
  state = appendEvidence(state, overlap.evidence, new Date().toISOString());
  assert.equal(reviewProgressMark(state, false), before);
});

test("public Agent executes a fake-provider nested tool loop with isolated tools", async () => {
  let requests = 0;
  let toolRuns = 0;
  const streamFn = () => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      requests += 1;
      const message = terminalMessage(requests === 1 ? "toolUse" : "stop");
      if (requests === 1) message.content = [{ type: "toolCall", id: "call-1", name: "inspect", arguments: { value: "x" } }];
      stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
      stream.push({ type: "done", reason: requests === 1 ? "toolUse" : "stop", message });
    });
    return stream;
  };
  const agent = new Agent({
    initialState: {
      model, thinkingLevel: "off", systemPrompt: "isolated", tools: [{
        name: "inspect", label: "inspect", description: "read-only fixture", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        async execute() { toolRuns += 1; return { content: [{ type: "text", text: "ok" }], details: {} }; },
      }],
    },
    streamFn,
  });
  await agent.prompt("review");
  assert.equal(requests, 2);
  assert.equal(toolRuns, 1);
  assert.deepEqual(agent.state.tools.map((tool) => tool.name), ["inspect"]);
});

test("public Agent finishTurn stops mixed-tool submission before another request and runs before turn_end", async () => {
  let requests = 0; let submitted = false;
  const boundaries = [];
  const streamFn = () => { const stream = createAssistantMessageEventStream(); queueMicrotask(() => {
    requests += 1;
    // Bound the fixture even if a future SDK silently ignores the stopping hook.
    const message = terminalMessage(requests >= 3 ? "stop" : "toolUse");
    if (message.stopReason === "toolUse") message.content = [
      { type: "toolCall", id: `normal-${requests}`, name: "inspect", arguments: {} },
      { type: "toolCall", id: `submit-${requests}`, name: "submit", arguments: {} },
    ]; stream.push({ type: "start", partial: { ...message, stopReason: "pending" } }); stream.push({ type: "done", reason: message.stopReason, message });
  }); return stream; };
  const tool = (name, execute) => ({ name, label: name, description: name, parameters: { type: "object", properties: {}, additionalProperties: false }, execute });
  const agent = new Agent({
    initialState: { model, thinkingLevel: "off", systemPrompt: "isolated", tools: [tool("inspect", async () => ({ content: [{ type: "text", text: "ok" }], details: {} })), tool("submit", async () => { submitted = true; return { content: [{ type: "text", text: "accepted" }], details: {}, terminate: true }; })] },
    streamFn,
    finishTurn: ({ message, toolResults }) => {
      if (message.stopReason === "error" || message.stopReason === "aborted") return;
      boundaries.push("finishTurn");
      assert.equal(toolResults.length, 2);
      return submitted ? { action: "end" } : undefined;
    },
  });
  agent.subscribe((event) => { if (event.type === "turn_end") boundaries.push("turn_end"); });
  await agent.prompt("review");
  assert.equal(requests, 1);
  assert.deepEqual(boundaries, ["finishTurn", "turn_end"]);
});

test("public Agent cancellation settles inside a tool loop", async () => {
  let toolStarted;
  const started = new Promise((resolve) => { toolStarted = resolve; });
  const streamFn = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      if (options?.signal?.aborted) {
        stream.push({ type: "error", reason: "aborted", error: { ...terminalMessage("aborted"), errorMessage: "cancelled" } });
        return;
      }
      const message = terminalMessage("toolUse");
      message.content = [{ type: "toolCall", id: "call-cancel", name: "wait", arguments: {} }];
      stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
      stream.push({ type: "done", reason: "toolUse", message });
    });
    return stream;
  };
  const agent = new Agent({ initialState: { model, thinkingLevel: "off", systemPrompt: "isolated", tools: [{
    name: "wait", label: "wait", description: "wait fixture", parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_id, _params, signal) => await new Promise((resolve, reject) => {
      toolStarted();
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  }] }, streamFn });
  const prompting = agent.prompt("review");
  await started;
  agent.abort();
  await prompting;
  await agent.waitForIdle();
  assert.equal(agent.state.isStreaming, false);
});

test("registry stream adapter preserves the Agent's normalized prompt and tool declarations", async () => {
  let received;
  const tool = { name: "inspect", label: "inspect", description: "read-only fixture", parameters: { type: "object", properties: {} }, async execute() { throw new Error("not called"); } };
  const streamFn = createRegistryStreamFn({
    getProvider: () => ({ streamSimple(_model, context) {
      received = context;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...terminalMessage(), stopReason: "pending" } });
        stream.push({ type: "done", reason: "stop", message: terminalMessage() });
      });
      return stream;
    } }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
  });
  const agent = new Agent({ initialState: { model, thinkingLevel: "off", systemPrompt: "REVIEW_INSTRUCTIONS", tools: [tool] }, streamFn });
  await agent.prompt("review the snapshot");
  assert.equal(received.systemPrompt, undefined);
  assert.equal(received.tools, undefined);
  assert.equal(getCurrentSystemPrompt(received.messages), "REVIEW_INSTRUCTIONS");
  assert.deepEqual(getCurrentTools(received.messages).map(({ name }) => name), ["inspect"]);
  assert.equal(received.messages.at(-1).role, "user");
});

test("registry stream adapter translates auth failure, malformed streams, and cancellation without rejecting", async () => {
  const authFailure = createRegistryStreamFn({
    getProvider: () => ({ streamSimple() { throw new Error("must not run"); } }),
    getApiKeyAndHeaders: async () => ({ ok: false, error: "auth denied" }),
  });
  const authEvents = await events(authFailure(model, normalizeContext({ messages: [] })));
  assert.equal(authEvents.at(-1).type, "error");
  assert.match(authEvents.at(-1).error.errorMessage, /auth denied/u);

  const malformed = createRegistryStreamFn({
    getProvider: () => ({ streamSimple() { const stream = createAssistantMessageEventStream(); queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: terminalMessage() })); return stream; } }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
  });
  const malformedEvents = await events(malformed(model, normalizeContext({ messages: [] })));
  assert.equal(malformedEvents.length, 1);
  assert.match(malformedEvents[0].error.errorMessage, /malformed|before starting/u);

  let resolveAuth;
  let providerCalls = 0;
  const cancelled = createRegistryStreamFn({
    getProvider: () => ({ streamSimple() { providerCalls += 1; return createAssistantMessageEventStream(); } }),
    getApiKeyAndHeaders: () => new Promise((resolve) => { resolveAuth = resolve; }),
  });
  const controller = new AbortController();
  const pending = events(cancelled(model, normalizeContext({ messages: [] }), { signal: controller.signal }));
  controller.abort();
  const cancelledEvents = await pending;
  resolveAuth?.({ ok: true });
  assert.equal(cancelledEvents.at(-1).reason, "aborted");
  assert.equal(providerCalls, 0);

  const hangingSource = createAssistantMessageEventStream();
  const hanging = createRegistryStreamFn({
    getProvider: () => ({ streamSimple() { queueMicrotask(() => hangingSource.push({ type: "start", partial: { ...terminalMessage(), stopReason: "pending" } })); return hangingSource; } }),
    getApiKeyAndHeaders: async () => ({ ok: true }),
  });
  const providerAbort = new AbortController();
  const hangingEvents = events(hanging(model, normalizeContext({ messages: [] }), { signal: providerAbort.signal }));
  await new Promise((resolve) => setImmediate(resolve));
  providerAbort.abort();
  assert.equal((await hangingEvents).at(-1).reason, "aborted", "an uncooperative active provider cannot hold the Agent open");
});

class ScriptedAgent {
  state = { messages: [], errorMessage: undefined };
  listeners = new Set();
  aborted = false;
  settled = Promise.resolve();
  constructor(input, script) { this.input = input; this.script = script; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async emit(event) { for (const listener of this.listeners) await listener(event, new AbortController().signal); }
  async prompt() { this.settled = this.script(this); await this.settled; }
  abort() { this.aborted = true; }
  async waitForIdle() { await this.settled.catch(() => undefined); }
}

function completingFactory() {
  let prompts = 0;
  return (input) => new ScriptedAgent(input, async (agent) => {
    prompts += 1;
    if (prompts === 1) {
      const tracked = input.tools.find((tool) => tool.name === "read_snapshot");
      const targetId = trackedTargetId(input.systemPrompt);
      const args = { targetId, start: 1, end: 2 };
      await agent.emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read_snapshot", args });
      const result = await tracked.execute("read-1", args);
      await agent.emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read_snapshot", result, isError: false });
    } else {
      const submit = input.tools.find((tool) => tool.name === "submit_review_report");
      const args = { findings: [] };
      await agent.emit({ type: "tool_execution_start", toolCallId: "report-1", toolName: "submit_review_report", args });
      const result = await submit.execute("report-1", args);
      await agent.emit({ type: "tool_execution_end", toolCallId: "report-1", toolName: "submit_review_report", result, isError: false });
    }
    agent.state.messages.push(terminalMessage());
    await agent.emit({ type: "turn_end", message: terminalMessage(), toolResults: [] });
    await agent.emit({ type: "message_end", message: terminalMessage() });
    await agent.emit({ type: "agent_end", messages: [] });
  });
}
function trackedTargetId(prompt) { return prompt.match(/targetId: ([a-f0-9]{64})/u)[1]; }

function host(root) {
  const notifications = [];
  return {
    cwd: root,
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: { find: (provider, id) => provider === "fake" && id === "reviewer" ? model : undefined, hasConfiguredAuth: () => true },
    ui: { notify(message, type) { notifications.push({ message, type }); } },
    notifications,
  };
}

async function waitFor(check, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 10)); }
  throw new Error("timed out waiting for condition");
}

test("fake agent continuation persists evidence, requires structured report, and completes artifacts", async () => {
  const root = await temp("complete");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src/a.ts"), "a\nb");
  const agentDir = await temp("complete-agent");
  const runtimeStore = createReviewRuntimeStore(agentDir);
  const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["src/a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  const runtime = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), completingFactory());
  await runtime.startFrozen(host(root), frozen.state, frozen.record);
  const complete = await waitFor(async () => { const record = await runtimeStore.read(frozen.state.reviewId); return record && ["complete", "failed"].includes(record.status) ? record : undefined; });
  const state = await storage.readState(frozen.state.reviewId);
  assert.equal(complete.status, "complete", state?.failureReason);
  assert.equal(complete.finalReportSubmitted, true);
  assert.equal(state.phase, "complete");
  assert.equal(state.evidence.length, 1);
  const reportJson = await storage.readArtifact(state.reviewId, "report.json");
  const reportMarkdown = await storage.readArtifact(state.reviewId, "report.md");
  assert.equal(JSON.parse(reportJson).phase, "complete");
  assert.equal(state.report.jsonSha256, sha256(reportJson));
  assert.equal(state.report.markdownSha256, sha256(reportMarkdown));
  assert.equal(state.continuation.turnsUsed, 2, "tool-calling turns count toward the bound");
});

test("provider failure after accepted submission pauses instead of completing", async () => {
  const root = await temp("submit-error"); await writeFile(path.join(root, "a.ts"), "a\nb");
  const agentDir = await temp("submit-error-agent"); const runtimeStore = createReviewRuntimeStore(agentDir); const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  let prompts = 0;
  const factory = (input) => new ScriptedAgent(input, async (agent) => {
    prompts += 1;
    if (prompts === 1) { const tool = input.tools.find((item) => item.name === "read_snapshot"); const targetId = trackedTargetId(input.systemPrompt); const args = { targetId, start: 1, end: 2 }; await agent.emit({ type: "tool_execution_start", toolCallId: "r", toolName: "read_snapshot", args }); const result = await tool.execute("r", args); await agent.emit({ type: "tool_execution_end", toolCallId: "r", toolName: "read_snapshot", result, isError: false }); }
    else { const tool = input.tools.find((item) => item.name === "submit_review_report"); await tool.execute("s", { findings: [] }); agent.state.errorMessage = "provider failed after submit"; }
    agent.state.messages.push(terminalMessage(prompts === 1 ? "stop" : "error")); await agent.emit({ type: "turn_end", message: agent.state.messages.at(-1), toolResults: [] });
  });
  const runtime = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), factory); await runtime.startFrozen(host(root), frozen.state, frozen.record);
  await waitFor(async () => (await runtimeStore.read(frozen.state.reviewId))?.status === "paused");
  assert.equal((await storage.readState(frozen.state.reviewId)).phase, "paused");
});

test("restart restores a paused immutable manifest without automatic model spending", async () => {
  const root = await temp("restart");
  await writeFile(path.join(root, "a.ts"), "a\nb");
  const agentDir = await temp("restart-agent");
  const runtimeStore = createReviewRuntimeStore(agentDir);
  const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 1, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  let calls = 0;
  const pausingFactory = (input) => new ScriptedAgent(input, async (agent) => { calls += 1; agent.state.messages.push(terminalMessage()); await agent.emit({ type: "turn_end", message: terminalMessage(), toolResults: [] }); });
  const first = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), pausingFactory);
  await first.startFrozen(host(root), frozen.state, frozen.record);
  await waitFor(async () => (await runtimeStore.read(frozen.state.reviewId))?.status === "paused");
  const incomplete = await waitFor(async () => storage.readArtifact(frozen.state.reviewId, "report.json"));
  assert.equal(JSON.parse(incomplete).phase, "paused");
  assert.ok(JSON.parse(incomplete).summary.pending > 0);
  const secondFactory = completingFactory();
  const second = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), secondFactory);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1, "constructing a runtime after reload spends no model turn");
  await second.resume(host(root), frozen.state.reviewId);
  const terminal = await waitFor(async () => { const record = await runtimeStore.read(frozen.state.reviewId); return record && ["complete", "failed"].includes(record.status) ? record : undefined; });
  const restored = await storage.readState(frozen.state.reviewId);
  assert.equal(terminal.status, "complete", restored?.failureReason);

  assert.equal(restored.manifest.targets[0].version, frozen.state.manifest.targets[0].version);
});

test("drift compares only bounded current-path baselines and includes empty files", async () => {
  const root = await temp("drift");
  await writeFile(path.join(root, "empty.ts"), "");
  const agentDir = await temp("drift-agent");
  const runtimeStore = createReviewRuntimeStore(agentDir);
  const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["empty.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  assert.equal(frozen.record.baselines[0].byteLength, 0);
  assert.deepEqual(await snapshotDrift(frozen.state, frozen.record.baselines), []);
  await writeFile(path.join(root, "empty.ts"), "changed");
  assert.deepEqual(await snapshotDrift(frozen.state, frozen.record.baselines), ["empty.ts changed after capture"]);
  assert.deepEqual(await snapshotDrift(frozen.state, []), [], "historical snapshot targets are not treated as current-path baselines");
});

test("report persistence failure stays resumable and recovery spends no model turn", async () => {
  const root = await temp("report-recovery");
  await writeFile(path.join(root, "a.ts"), "a\nb");
  const agentDir = await temp("report-recovery-agent");
  const runtimeStore = createReviewRuntimeStore(agentDir);
  const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  const reviewDirectory = await storage.reviewDirectory(frozen.state.reviewId);
  await mkdir(path.join(reviewDirectory, "report.md"));
  const first = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), completingFactory());
  await first.startFrozen(host(root), frozen.state, frozen.record);
  await waitFor(async () => (await runtimeStore.read(frozen.state.reviewId))?.status === "paused");
  assert.equal((await storage.readState(frozen.state.reviewId)).phase, "reporting");
  assert.notEqual(JSON.parse(await storage.readArtifact(frozen.state.reviewId, "report.json")).phase, "complete", "a failed report pair must not leave writable JSON claiming success");
  await rm(path.join(reviewDirectory, "report.md"), { recursive: true, force: true });
  let modelStarts = 0;
  const second = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), () => { modelStarts += 1; throw new Error("report recovery must not start an Agent"); });
  await second.resume(host(root), frozen.state.reviewId);
  assert.equal(modelStarts, 0);
  assert.equal((await storage.readState(frozen.state.reviewId)).phase, "complete");
  assert.match(await storage.readArtifact(frozen.state.reviewId, "report.json"), /"phase":"complete"/u);
});

test("cancellation wins over delayed report completion", async () => {
  const root = await temp("report-cancel"); await writeFile(path.join(root, "a.ts"), "a\nb");
  const agentDir = await temp("report-cancel-agent"); const baseStore = createReviewRuntimeStore(agentDir); const storage = createReviewStorage({ rootDir: baseStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore: baseStore, storage });
  let release; const gate = new Promise((resolve) => { release = resolve; }); let reached; const reachedComplete = new Promise((resolve) => { reached = resolve; });
  const delayedStore = { ...baseStore, async write(record) { if (record.status === "complete") { reached(); await gate; } return baseStore.write(record); } };
  const runtime = new DeterministicReviewRuntime(delayedStore, createReviewStatusPublisher(), completingFactory());
  await runtime.startFrozen(host(root), frozen.state, frozen.record); await reachedComplete;
  const cancelling = runtime.cancel(host(root), frozen.state.reviewId); release(); await cancelling;
  assert.equal((await storage.readState(frozen.state.reviewId)).phase, "cancelled");
  assert.equal((await baseStore.read(frozen.state.reviewId)).status, "cancelled");
});

test("completed core state reconciles a runtime-record write failure without another model turn", async () => {
  const root = await temp("record-recovery");
  await writeFile(path.join(root, "a.ts"), "a\nb");
  const agentDir = await temp("record-recovery-agent");
  const baseStore = createReviewRuntimeStore(agentDir);
  const storage = createReviewStorage({ rootDir: baseStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore: baseStore, storage });
  let failComplete = true;
  const faultStore = {
    ...baseStore,
    async write(record) {
      if (record.status === "complete" && failComplete) { failComplete = false; throw new Error("injected runtime record failure"); }
      return baseStore.write(record);
    },
  };
  const first = new DeterministicReviewRuntime(faultStore, createReviewStatusPublisher(), completingFactory());
  await first.startFrozen(host(root), frozen.state, frozen.record);
  await waitFor(async () => (await baseStore.read(frozen.state.reviewId))?.status === "paused");
  assert.equal((await storage.readState(frozen.state.reviewId)).phase, "complete");
  let modelStarts = 0;
  const second = new DeterministicReviewRuntime(baseStore, createReviewStatusPublisher(), () => { modelStarts += 1; throw new Error("reconciliation must not start an Agent"); });
  await second.resume(host(root), frozen.state.reviewId);
  assert.equal(modelStarts, 0);
  assert.equal((await baseStore.read(frozen.state.reviewId)).status, "complete");
});

test("delayed status observation cannot replace a concurrently started execution state", async () => {
  const root = await temp("status-race"); await writeFile(path.join(root, "a.ts"), "a\nb");
  const agentDir = await temp("status-race-agent"); const baseStore = createReviewRuntimeStore(agentDir); const storage = createReviewStorage({ rootDir: baseStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore: baseStore, storage });
  let release; const gate = new Promise((resolve) => { release = resolve; }); let began; const beganRead = new Promise((resolve) => { began = resolve; });
  const delayedStore = { ...baseStore, async current(owner, project) { began(); await gate; return baseStore.current(owner, project); } };
  const runtime = new DeterministicReviewRuntime(delayedStore, createReviewStatusPublisher(), completingFactory());
  const ctx = host(root);
  const observing = runtime.loadStatus(ctx); await beganRead;
  await runtime.startFrozen(ctx, frozen.state, frozen.record); release(); await observing;
  await waitFor(() => !runtime.isActive());
  const terminal = await baseStore.read(frozen.state.reviewId);
  assert.equal(terminal.status, "complete", JSON.stringify(ctx.notifications));
});

test("cancellation during delayed launch prevents Agent creation and persists cancelled", async () => {
  const root = await temp("launch-cancel"); await writeFile(path.join(root, "a.ts"), "a\n");
  const agentDir = await temp("launch-cancel-agent");
  const baseStore = createReviewRuntimeStore(agentDir); const storage = createReviewStorage({ rootDir: baseStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore: baseStore, storage });
  let release; const gate = new Promise((resolve) => { release = resolve; }); let reached;
  const reachedGate = new Promise((resolve) => { reached = resolve; });
  const delayedStore = { ...baseStore, async write(record) { if (record.status === "running") { reached(); await gate; } return baseStore.write(record); } };
  let created = 0; const runtime = new DeterministicReviewRuntime(delayedStore, createReviewStatusPublisher(), () => { created += 1; throw new Error("must not create"); });
  const controller = new AbortController();
  const starting = runtime.startFrozen(host(root), frozen.state, frozen.record, controller.signal);
  await reachedGate; controller.abort(); release();
  await assert.rejects(starting, /cancelled/u);
  assert.equal(created, 0);
  assert.equal((await storage.readState(frozen.state.reviewId)).phase, "cancelled");
});

test("attempt timeout aborts, settles, and preserves an incomplete paused report", async () => {
  const root = await temp("timeout"); await writeFile(path.join(root, "a.ts"), "a\n");
  const agentDir = await temp("timeout-agent"); const runtimeStore = createReviewRuntimeStore(agentDir); const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 1000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  const factory = (input) => { let release; const agent = new ScriptedAgent(input, async () => new Promise((resolve) => { release = resolve; })); const original = agent.abort.bind(agent); agent.abort = () => { original(); release?.(); }; return agent; };
  const runtime = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), factory); await runtime.startFrozen(host(root), frozen.state, frozen.record);
  await waitFor(async () => (await runtimeStore.read(frozen.state.reviewId))?.status === "paused");
  const timeoutReport = await waitFor(async () => storage.readArtifact(frozen.state.reviewId, "report.json"));
  assert.equal(JSON.parse(timeoutReport).phase, "paused");
});

test("shutdown aborts and settles a running reviewer as paused", async () => {
  const root = await temp("shutdown"); await writeFile(path.join(root, "a.ts"), "a\n");
  const agentDir = await temp("shutdown-agent"); const runtimeStore = createReviewRuntimeStore(agentDir); const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  const factory = (input) => { let release; const agent = new ScriptedAgent(input, async () => new Promise((resolve) => { release = resolve; })); const original = agent.abort.bind(agent); agent.abort = () => { original(); release?.(); }; return agent; };
  const runtime = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), factory); await runtime.startFrozen(host(root), frozen.state, frozen.record); await runtime.pauseForShutdown();
  assert.equal((await storage.readState(frozen.state.reviewId)).phase, "paused");
  assert.equal(JSON.parse(await storage.readArtifact(frozen.state.reviewId, "report.json")).phase, "paused");
});

test("explicit cancellation aborts a nested run, settles it, and rejects late success", async () => {
  const root = await temp("cancel");
  await writeFile(path.join(root, "a.ts"), "a\nb");
  const agentDir = await temp("cancel-agent");
  const runtimeStore = createReviewRuntimeStore(agentDir);
  const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 });
  const frozen = await freezeReview({ host: host(root), settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  let release;
  const factory = (input) => new ScriptedAgent(input, async (agent) => await new Promise((resolve) => { release = resolve; if (agent.aborted) resolve(); }));
  const runtime = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), factory);
  await runtime.startFrozen(host(root), frozen.state, frozen.record);
  const cancellation = runtime.cancel(host(root), frozen.state.reviewId);
  release?.();
  await cancellation;
  const state = await storage.readState(frozen.state.reviewId);
  assert.equal(state.phase, "cancelled");
  assert.equal((await runtimeStore.read(state.reviewId)).status, "cancelled");
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function lifecycleFixture(label, overrides = {}) {
  const root = await temp(label);
  await writeFile(path.join(root, "a.ts"), "");
  const runtimeStore = createReviewRuntimeStore(await temp(`${label}-agent`));
  const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  const settings = validateReviewSettings({ mode: "paths", paths: ["a.ts"], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 2, maxContextBytes: 4096, ...overrides });
  const ctx = host(root);
  const frozen = await freezeReview({ host: ctx, settings, mode: "paths", paths: settings.paths, model: settings.model, runtimeStore, storage });
  return { root, runtimeStore, storage, settings, ctx, frozen };
}

const submitOnly = (input) => new ScriptedAgent(input, async (agent) => {
  await input.tools.find((tool) => tool.name === "submit_review_report").execute("submit", { findings: [] });
  agent.state.messages.push(terminalMessage());
  await agent.emit({ type: "turn_end", message: terminalMessage(), toolResults: [] });
});

test("context-cap failure preserves paused evidence and partial reports", async () => {
  const f = await lifecycleFixture("context-cap");
  const factory = (input) => new ScriptedAgent(input, async (agent) => {
    agent.state.messages = [{ role: "user", content: "x".repeat(3 * 1024 * 1024), timestamp: Date.now() }];
    await agent.emit({ type: "message_end", message: agent.state.messages[0] });
  });
  const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher(), factory);
  await runtime.startFrozen(f.ctx, f.frozen.state, f.frozen.record);
  await waitFor(() => !runtime.isActive());
  assert.equal((await f.storage.readState(f.frozen.state.reviewId)).phase, "paused");
  assert.equal((await f.storage.readState(f.frozen.state.reviewId)).reviewerContext.length, 0);
  assert.equal(JSON.parse(await f.storage.readArtifact(f.frozen.state.reviewId, "report.json")).phase, "paused");
  const resumed = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher(), submitOnly);
  await resumed.resume(f.ctx, f.frozen.state.reviewId);
  await waitFor(() => !resumed.isActive());
  assert.equal((await f.storage.readState(f.frozen.state.reviewId)).phase, "complete");
});

test("shutdown invalidates resume before its first asynchronous lookup finishes", async () => {
  const f = await lifecycleFixture("early-resume");
  const reached = deferred(); const release = deferred();
  const store = { ...f.runtimeStore, async read(id) { reached.resolve(); await release.promise; return f.runtimeStore.read(id); } };
  let starts = 0;
  const runtime = new DeterministicReviewRuntime(store, createReviewStatusPublisher(), () => { starts++; throw new Error("unexpected Agent"); });
  const resuming = assert.rejects(runtime.resume(f.ctx, f.frozen.state.reviewId), /cancelled/);
  await reached.promise;
  const shutdown = runtime.pauseForShutdown();
  release.resolve();
  await Promise.all([resuming, shutdown]);
  assert.equal(starts, 0);
  assert.equal((await f.storage.readState(f.frozen.state.reviewId)).phase, "frozen");
});

test("explicit cancellation commits after a delayed launch runtime write", async () => {
  const f = await lifecycleFixture("launch-write");
  const reached = deferred(); const release = deferred();
  const store = { ...f.runtimeStore, async write(record) { if (record.status === "running") { reached.resolve(); await release.promise; } return f.runtimeStore.write(record); } };
  let starts = 0;
  const runtime = new DeterministicReviewRuntime(store, createReviewStatusPublisher(), () => { starts++; throw new Error("unexpected Agent"); });
  const starting = assert.rejects(runtime.startFrozen(f.ctx, f.frozen.state, f.frozen.record), /cancelled/);
  await reached.promise;
  const cancelling = runtime.cancel(f.ctx, f.frozen.state.reviewId);
  release.resolve();
  await Promise.all([starting, cancelling]);
  assert.equal(starts, 0);
  assert.equal((await f.storage.readState(f.frozen.state.reviewId)).phase, "cancelled");
  assert.equal((await f.runtimeStore.read(f.frozen.state.reviewId)).status, "cancelled");
});

for (const stop of ["cancel", "shutdown", "timeout"]) {
  test(`${stop} during a delayed final artifact rename leaves no complete artifact`, async () => {
    const f = await lifecycleFixture(`artifact-${stop}`, { timeoutMs: stop === "timeout" ? 1000 : 5000 });
    const reached = deferred(); const release = deferred();
    const originalRename = fs.promises.rename;
    let delayed = false;
    fs.promises.rename = async (from, to) => {
      if (!delayed && String(to).includes(f.frozen.state.reviewId) && path.basename(String(to)) === "report.json") {
        delayed = true; reached.resolve(); await release.promise;
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher(), submitOnly);
    try {
      await runtime.startFrozen(f.ctx, f.frozen.state, f.frozen.record);
      await reached.promise;
      let stopping;
      if (stop === "cancel") stopping = runtime.cancel(f.ctx, f.frozen.state.reviewId);
      else if (stop === "shutdown") stopping = runtime.pauseForShutdown();
      else await new Promise((resolve) => setTimeout(resolve, 1100));
      release.resolve();
      await stopping;
      await waitFor(() => !runtime.isActive());
      const state = await f.storage.readState(f.frozen.state.reviewId);
      assert.notEqual(state.phase, "complete");
      for (const name of ["report.json", "report.md"]) {
        const text = await f.storage.readArtifact(state.reviewId, name);
        assert.ok(text);
        if (name.endsWith("json")) assert.notEqual(JSON.parse(text).phase, "complete");
        else assert.doesNotMatch(text, /State: \*\*complete\*\*/);
      }
      assert.ok(!f.ctx.notifications.some((item) => / complete\. Reviewed:/.test(item.message)));
    } finally {
      release.resolve(); fs.promises.rename = originalRename; syncBuiltinESMExports();
      await runtime.pauseForShutdown();
    }
  });
}

for (const stop of ["cancel", "shutdown"]) {
  test(`${stop} settles report-only recovery before returning`, async () => {
    const f = await lifecycleFixture(`report-only-${stop}`);
    await f.storage.writeState({ ...startAttempt(f.frozen.state, new Date().toISOString()), phase: "reporting" });
    await f.runtimeStore.write({ ...f.frozen.record, status: "paused", finalReportSubmitted: true });
    const reached = deferred(); const release = deferred();
    const originalRename = fs.promises.rename;
    let delayed = false;
    fs.promises.rename = async (from, to) => {
      if (!delayed && String(to).includes(f.frozen.state.reviewId) && path.basename(String(to)) === "report.json") {
        delayed = true; reached.resolve(); await release.promise;
      }
      return originalRename(from, to);
    };
    syncBuiltinESMExports();
    const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher(), () => { throw new Error("report recovery must not start an Agent"); });
    try {
      const recovery = assert.rejects(runtime.resume(f.ctx, f.frozen.state.reviewId), /cancelled/);
      await reached.promise;
      const stopping = stop === "cancel" ? runtime.cancel(f.ctx, f.frozen.state.reviewId) : runtime.pauseForShutdown();
      release.resolve();
      await Promise.all([recovery, stopping]);
      assert.notEqual((await f.storage.readState(f.frozen.state.reviewId)).phase, "complete");
      assert.notEqual(JSON.parse(await f.storage.readArtifact(f.frozen.state.reviewId, "report.json")).phase, "complete");
    } finally { release.resolve(); fs.promises.rename = originalRename; syncBuiltinESMExports(); }
  });
}

function installReviewProvider(ctx, response) {
  const contexts = [];
  ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true });
  ctx.modelRegistry.getProvider = () => ({ streamSimple(_model, context) {
    contexts.push(structuredClone(context));
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = contexts.length > 6
        ? { ...terminalMessage("error"), errorMessage: "fixture request ceiling exceeded" }
        : response(contexts.length);
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        stream.push({ type: "error", reason: message.stopReason, error: message });
      } else {
        stream.push({ type: "start", partial: { ...message, stopReason: "pending" } });
        stream.push({ type: "done", reason: message.stopReason, message });
      }
    });
    return stream;
  } });
  return contexts;
}

for (const maxTurns of [1, 2]) {
  test(`native reviewer enforces exactly ${maxTurns} tool turns per attempt and restores context on resume`, async () => {
    const f = await lifecycleFixture(`native-limit-${maxTurns}`, { maxTurns });
    const contexts = installReviewProvider(f.ctx, (request) => ({ ...terminalMessage("toolUse"), content: [
      { type: "toolCall", id: `findings-${request}`, name: "record_review_findings", arguments: { findings: [] } },
    ] }));
    const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher());
    try {
      await runtime.startFrozen(f.ctx, f.frozen.state, f.frozen.record);
      await waitFor(() => !runtime.isActive());
      assert.equal(contexts.length, maxTurns);
      let state = await f.storage.readState(f.frozen.state.reviewId);
      assert.equal(state.phase, "paused");
      assert.equal(state.continuation.turnsUsed, maxTurns);
      assert.match(f.ctx.notifications.at(-1).message, /turn limit/);
      await runtime.resume(f.ctx, f.frozen.state.reviewId);
      await waitFor(() => !runtime.isActive());
      assert.equal(contexts.length, maxTurns * 2);
      assert.ok(contexts[maxTurns].messages.some(message => message.role === "toolResult" && message.toolCallId === "findings-1"), "standalone Agent restoration must preserve previous tool results");
      state = await f.storage.readState(f.frozen.state.reviewId);
      assert.equal(state.phase, "paused");
      assert.equal(state.continuation.turnsUsed, maxTurns * 2);
    } finally { await runtime.pauseForShutdown(); }
  });
}

for (const maxTurns of [1, 3]) {
  test(`native reviewer stops a mixed-tool final submission with turn limit ${maxTurns}`, async () => {
    const f = await lifecycleFixture(`native-mixed-${maxTurns}`, { maxTurns });
    const contexts = installReviewProvider(f.ctx, request => ({ ...terminalMessage("toolUse"), content: [
      { type: "toolCall", id: `findings-${request}`, name: "record_review_findings", arguments: { findings: [] } },
      { type: "toolCall", id: `submit-${request}`, name: "submit_review_report", arguments: { findings: [] } },
    ] }));
    const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher());
    try {
      await runtime.startFrozen(f.ctx, f.frozen.state, f.frozen.record);
      await waitFor(() => !runtime.isActive());
      assert.equal(contexts.length, 1);
      const state = await f.storage.readState(f.frozen.state.reviewId);
      assert.equal(state.phase, "complete");
      assert.equal(state.continuation.turnsUsed, 1);
      assert.equal(state.reviewerContext.filter(message => message.role === "toolResult").length, 2);
      assert.equal(JSON.parse(await f.storage.readArtifact(state.reviewId, "report.json")).phase, "complete");
    } finally { await runtime.pauseForShutdown(); }
  });
}

for (const stopReason of ["error", "aborted"]) {
  test(`review finishTurn leaves ${stopReason} responses to the native hard exit`, async () => {
    const f = await lifecycleFixture(`finish-${stopReason}`, { maxTurns: 1 });
    let decision = "not called";
    const factory = input => new ScriptedAgent(input, async agent => {
      const message = terminalMessage(stopReason);
      agent.state.messages.push(message);
      decision = await input.finishTurn({ message, toolResults: [], context: { messages: agent.state.messages, tools: input.tools }, newMessages: [message] });
      await agent.emit({ type: "turn_end", message, toolResults: [] });
    });
    const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher(), factory);
    try {
      await runtime.startFrozen(f.ctx, f.frozen.state, f.frozen.record);
      await waitFor(() => !runtime.isActive());
      assert.equal(decision, undefined, "hard exits must bypass the reached turn limit predicate");
      assert.equal((await f.storage.readState(f.frozen.state.reviewId)).phase, "paused");
    } finally { await runtime.pauseForShutdown(); }
  });
}

test("valid final submission on the final allowed turn completes", async () => {
  const f = await lifecycleFixture("last-turn", { maxTurns: 1 });
  const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher(), submitOnly);
  await runtime.startFrozen(f.ctx, f.frozen.state, f.frozen.record);
  await waitFor(() => !runtime.isActive());
  assert.equal((await f.storage.readState(f.frozen.state.reviewId)).phase, "complete");
});

test("status and cancellation reject mismatched persisted core ownership", async () => {
  const f = await lifecycleFixture("paired-load");
  await f.storage.writeState({ ...f.frozen.state, ownerSessionId: "another-session" });
  const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher(), submitOnly);
  await assert.rejects(runtime.loadStatus(f.ctx, f.frozen.state.reviewId), /identity do not match/);
  await assert.rejects(runtime.cancel(f.ctx, f.frozen.state.reviewId), /identity do not match/);
  assert.equal((await f.storage.readState(f.frozen.state.reviewId)).phase, "frozen");
});

test("unverifiable native output directs the next turn to tracked reading", async () => {
  const f = await lifecycleFixture("read-guidance");
  await writeFile(path.join(f.root, "a.ts"), "source\n");
  const frozen = await freezeReview({ host: f.ctx, settings: f.settings, mode: "paths", paths: f.settings.paths, model: f.settings.model, runtimeStore: f.runtimeStore, storage: f.storage });
  const prompts = [];
  const factory = (input) => {
    const agent = new ScriptedAgent(input, async (a) => {
      await a.emit({ type: "tool_execution_start", toolCallId: "bad", toolName: "read", args: { path: virtualSnapshotPath(frozen.state.manifest.targets[0]) } });
      await a.emit({ type: "tool_execution_end", toolCallId: "bad", toolName: "read", isError: false, result: nativeResult("not the frozen output") });
      a.state.messages.push(terminalMessage());
      await a.emit({ type: "turn_end", message: terminalMessage(), toolResults: [] });
    });
    const prompt = agent.prompt.bind(agent);
    agent.prompt = async (message) => { prompts.push(message); await prompt(message); };
    return agent;
  };
  const runtime = new DeterministicReviewRuntime(f.runtimeStore, createReviewStatusPublisher(), factory);
  await runtime.startFrozen(f.ctx, frozen.state, frozen.record);
  await waitFor(() => !runtime.isActive());
  assert.match(prompts[1], /could not be verified.*read_snapshot/);
  assert.equal((await f.storage.readState(frozen.state.reviewId)).evidence.length, 0);
});

test("unknown reviewer model fails before an Agent is created", async () => {
  const root = await temp("unknown");
  const timestamp = new Date().toISOString();
  const target = textTarget("a\nb", [{ start: 1, end: 2 }]);
  const manifest = createManifest({ reviewId: "review-x", projectRoot: root, createdAt: timestamp, targets: [target] });
  const state = createReviewState({ manifest, ownerSessionId: "session-1", createdAt: timestamp });
  const record = { schemaVersion: 1, reviewId: "review-x", ownerSessionId: "session-1", projectRoot: root, mode: "paths", paths: ["src/a.ts"], exclusions: [], model: { provider: "missing", modelId: "none", thinkingLevel: "off" }, limits: { contextLines: 3, maxTurns: 10, timeoutMs: 5000, maxNoProgress: 3, maxContextBytes: 4096 }, taskContext: [], provenanceWarnings: [], baselines: [], createdAt: timestamp, updatedAt: timestamp, status: "frozen", finalReportSubmitted: false };
  const agentDir = await temp("unknown-agent");
  const runtimeStore = createReviewRuntimeStore(agentDir);
  const storage = createReviewStorage({ rootDir: runtimeStore.stateRoot });
  await storage.writeState(state); await runtimeStore.write(record);
  let created = false;
  const runtime = new DeterministicReviewRuntime(runtimeStore, createReviewStatusPublisher(), () => { created = true; throw new Error("should not create"); });
  const badHost = { ...host(root), modelRegistry: { find: () => undefined, hasConfiguredAuth: () => false } };
  await assert.rejects(runtime.startFrozen(badHost, state, record), /unavailable, out of scope, or unauthenticated/u);
  assert.equal(created, false);

  const scopedOut = { ...host(root), scopedModels: [{ model: { ...model, id: "other" } }] };
  await assert.rejects(runtime.startFrozen(scopedOut, state, { ...record, model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" } }), /out of scope/u);
  assert.equal(created, false);
});
