import assert from "node:assert/strict";
import test from "node:test";

import { createPiRuntime, assertPublicHttpUrl } from "../src/pi-runtime.ts";
import { createT3Runtime, listT3CatalogTargets, parseT3Catalog } from "../src/t3-runtime.ts";
import { discoverResearchTools, discoverT3Tools } from "../src/tool-bridge.ts";

function target(key, transport = "pi-registry", overrides = {}) {
  return {
    key,
    displayName: key === "a" ? "Alpha" : "Beta",
    modelAuthor: key === "a" ? "Author A" : "Author B",
    model: key === "a" ? "alpha-1" : "beta-1",
    hostingProvider: key === "a" ? "provider-a" : "provider-b",
    transport,
    settings: { thinking: "off" },
    ...overrides,
  };
}

function job(overrides = {}) {
  return {
    key: "research-a",
    requestId: "run-1:research-a",
    target: "a",
    stage: "research",
    prompt: "Research carefully and return JSON.",
    limits: { timeoutMs: 1_000, maxTurns: 4, maxTokens: 1_000 },
    status: "ready",
    ...overrides,
  };
}

function assistant(content, stopReason = "stop", overrides = {}) {
  return {
    role: "assistant",
    content,
    provider: "provider-a",
    model: "alpha-1",
    usage: {
      input: 10,
      output: 5,
      cacheRead: 2,
      cacheWrite: 1,
      totalTokens: 18,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
    },
    stopReason,
    timestamp: Date.now(),
    ...overrides,
  };
}

function streamOf(message) {
  return {
    async *[Symbol.asyncIterator]() { yield { type: "done", reason: message.stopReason, message }; },
    async result() { return message; },
  };
}

function researchTools() {
  return [
    { name: "brave_search", description: "discover", parameters: { type: "object", properties: { query: { type: "string" } } } },
    { name: "mcp__research__web-search", description: "synthesize", parameters: { type: "object" } },
    { name: "mcp__research__fetch_content", description: "fetch", parameters: { type: "object", properties: { url: { type: "string" } } } },
  ];
}

function registryWith(messages, overrides = {}) {
  const model = { provider: "provider-a", id: "alpha-1", maxTokens: 4_000 };
  const contexts = [];
  const streamOptions = [];
  return {
    model,
    contexts,
    streamOptions,
    find(provider, id) { return provider === model.provider && id === model.id ? model : undefined; },
    getAvailable() { return overrides.available === false ? [] : [model]; },
    hasConfiguredAuth() { return overrides.auth !== false; },
    streamSimple(_model, context, options) {
      contexts.push(structuredClone(context));
      streamOptions.push(options);
      const next = messages.shift();
      if (next instanceof Error) throw next;
      if (!next) throw new Error("missing fake response");
      return typeof next === "function" ? next(options) : streamOf(next);
    },
  };
}

test("tool discovery accepts unambiguous namespaced equivalents and rejects ambiguity or missing fetch", () => {
  const discovered = discoverResearchTools(researchTools());
  assert.equal(discovered.searches.length, 2);
  assert.equal(discovered.fetch.name, "mcp__research__fetch_content");
  assert.throws(() => discoverResearchTools([...researchTools(), { name: "other__fetch-content" }]), /Ambiguous/);
  assert.throws(() => discoverResearchTools(researchTools().filter((tool) => !tool.name.includes("fetch"))), /fetch_content/);

  const t3 = discoverT3Tools([
    { name: "mcp__t3-code__orchestrator-capabilities" },
    { name: "mcp__t3_code__delegate_task" },
    { name: "mcp__t3_code__task_status" },
    { name: "mcp__t3_code__task_cancel" },
  ]);
  assert.equal(t3.delegateTask.name, "mcp__t3_code__delegate_task");
});

test("Pi research uses a fresh exact-model context, host tools only, and accounts input/output/cache usage", async () => {
  const calls = [];
  const traces = [];
  const first = assistant([{ type: "toolCall", id: "call-1", name: "brave_search", arguments: { query: "official model docs" } }], "toolUse");
  const final = assistant([{ type: "text", text: "{\"ok\":true}" }]);
  const registry = registryWith([first, final, first, final]);
  const runtime = createPiRuntime({
    targets: [target("a"), target("b")],
    modelRegistry: registry,
    scopedModels: [{ model: registry.model }],
    callableTools: researchTools(),
    toolTraces: traces,
    async executeTool(name, args, options) {
      calls.push({ name, args, hasSignal: Boolean(options?.signal) });
      return { isError: false, content: [{ type: "text", text: "https://example.com result" }] };
    },
  });

  const result = await runtime.start(job());
  assert.equal(result.text, '{"ok":true}');
  assert.deepEqual(result.usage, { inputTokens: 26, outputTokens: 10, totalTokens: 36, turns: 2, costUsd: 0.02 });
  assert.deepEqual(calls.map((entry) => entry.name), ["brave_search"]);
  assert.equal(traces[0].status, "ok");
  assert.equal(registry.contexts[0].messages.length, 1);
  assert.equal(registry.contexts[1].messages.length, 3);
  assert.deepEqual(registry.contexts[0].tools.map((tool) => tool.name), researchTools().map((tool) => tool.name));
  assert.equal(registry.streamOptions[0].reasoning, undefined);
  assert.equal(registry.streamOptions[0].maxRetries, 0);

  await runtime.start(job({ requestId: "run-2:research-a" }));
  assert.equal(registry.contexts[2].messages.length, 1, "each job must start a fresh conversation");
});

test("Pi refuses research that never executes a successful search", async () => {
  const registry = registryWith([assistant([{ type: "text", text: "Unsupported source claims" }])]);
  const adapter = createPiRuntime({ targets: [target("a"), target("b")], modelRegistry: registry, scopedModels: [], callableTools: researchTools(), executeTool: async () => ({}) });
  await assert.rejects(adapter.start(job()), /without a successful search/);
});

test("Pi preflight enforces exact authentication, model scope, and no tools for review/draft", async () => {
  const unavailable = registryWith([], { auth: false });
  const base = { targets: [target("a"), target("b")], scopedModels: [{ model: unavailable.model }], callableTools: researchTools(), executeTool: async () => ({ content: [{ type: "text", text: "ok" }] }) };
  assert.throws(() => createPiRuntime({ ...base, modelRegistry: unavailable }).preflight(job()), /Authentication/);

  const registry = registryWith([assistant([{ type: "text", text: "review" }])]);
  const outOfScope = createPiRuntime({ ...base, modelRegistry: registry, scopedModels: [{ model: { provider: "other", id: "other" } }] });
  assert.throws(() => outOfScope.preflight(job()), /outside the current model scope/);

  const runtime = createPiRuntime({ ...base, modelRegistry: registry, scopedModels: [{ model: registry.model }] });
  const result = await runtime.start(job({ key: "review-a", requestId: "run-1:review-a", stage: "review" }));
  assert.equal(result.text, "review");
  assert.equal("tools" in registry.contexts[0], false);
  assert.equal(registry.streamOptions[0].toolChoice, "none");
  await assert.rejects(runtime.check(job()), /no known in-process continuation/);
});

test("Pi recovers source-access gaps but fails closed on provider errors, bounds, and unsafe fetch destinations", async () => {
  const toolErrorRegistry = registryWith([assistant([{ type: "toolCall", id: "s", name: "brave_search", arguments: { query: "source discussion" } }, { type: "toolCall", id: "x", name: "mcp__research__fetch_content", arguments: { url: "https://x.com/example/status/1" } }], "toolUse"), assistant([{ type: "text", text: "X access gap recorded; use other sources." }])]);
  const toolErrorRuntime = createPiRuntime({
    targets: [target("a"), target("b")], modelRegistry: toolErrorRegistry, scopedModels: [], callableTools: researchTools(),
    executeTool: async name => name === "brave_search" ? { content: [{ type: "text", text: "Synthetic search results" }] } : ({ isError: true, content: [{ type: "text", text: "HTTP 403: source inaccessible" }] }),
  });
  assert.match((await toolErrorRuntime.start(job())).text, /access gap recorded/);
  assert.equal(toolErrorRegistry.contexts[1].messages.at(-1).isError, true);
  assert.match(toolErrorRegistry.contexts[1].messages.at(-1).content[0].text, /403/);

  const providerError = assistant([], "error", { errorMessage: "provider rejected request" });
  const providerRuntime = createPiRuntime({
    targets: [target("a"), target("b")], modelRegistry: registryWith([providerError]), scopedModels: [], callableTools: researchTools(), executeTool: async () => ({}),
  });
  await assert.rejects(providerRuntime.start(job()), /provider rejected/);

  const tokenRuntime = createPiRuntime({
    targets: [target("a"), target("b")], modelRegistry: registryWith([assistant([{ type: "text", text: "too many" }])]), scopedModels: [], callableTools: researchTools(), executeTool: async () => ({}),
  });
  await assert.rejects(tokenRuntime.start(job({ limits: { timeoutMs: 1_000, maxTurns: 1, maxTokens: 10 } })), /Token accounting exceeded/);

  for (const unsafe of [
    "file:///tmp/secret",
    "http://127.0.0.1/a",
    "http://2130706433/a",
    "https://localhost/a",
    "https://localhost./a",
    "http://192.168.1.2/a",
    "http://[::ffff:172.16.0.1]/a",
    "https://[2606:4700:4700::1111]/a",
    "https://user:pass@example.com/a",
  ]) {
    assert.throws(() => assertPublicHttpUrl(unsafe));
  }
  assert.doesNotThrow(() => assertPublicHttpUrl("https://example.com/source"));

  const fetchRegistry = registryWith([assistant([{ type: "toolCall", id: "f", name: "mcp__research__fetch_content", arguments: { url: "http://10.0.0.2/private" } }], "toolUse")]);
  const fetchRuntime = createPiRuntime({ targets: [target("a"), target("b")], modelRegistry: fetchRegistry, scopedModels: [], callableTools: researchTools(), executeTool: async () => ({ content: [{ type: "text", text: "should not run" }] }) });
  await assert.rejects(fetchRuntime.start(job()), /private literal IP/);
});

test("bundled-reader policy and limit metadata remain fatal through native-shaped host outcomes", async () => {
  for (const kind of ["policy", "limit", "invalid_result"]) {
    const registry = registryWith([assistant([{ type: "toolCall", id: "s", name: "brave_search", arguments: { query: "q" } }, { type: "toolCall", id: "f", name: "model_research_fetch", arguments: { url: "https://example.com/" } }], "toolUse"), assistant([{ type: "text", text: "must not complete" }])]);
    const adapter = createPiRuntime({ targets: [target("a"), target("b")], modelRegistry: registry, scopedModels: [], callableTools: [{ name: "brave_search", parameters: { type: "object" } }, { name: "model_research_fetch", parameters: { type: "object" } }], async executeTool(name) {
      return name === "brave_search" ? { content: [{ type: "text", text: "Synthetic search" }] } : { result: { content: [{ type: "text", text: "Reader failure" }], structuredContent: { errorKind: kind, message: "Reader failure" } }, isError: true };
    } });
    await assert.rejects(adapter.start(job()), error => error.kind === kind);
    assert.equal(registry.contexts.length, 1);
  }
});

test("Pi timeout and explicit cancellation abort the tracked controller without an unhandled provider rejection", async () => {
  let observedAbort = 0;
  const waitingStream = (options) => ({
    [Symbol.asyncIterator]() {
      let delivered = false;
      return {
        async next() {
          if (delivered) return { done: true };
          await new Promise((resolve) => {
            if (options.signal.aborted) resolve();
            else options.signal.addEventListener("abort", resolve, { once: true });
          });
          delivered = true;
          observedAbort += 1;
          return { done: false, value: { type: "error", reason: "aborted", error: assistant([], "aborted", { errorMessage: "aborted cleanly" }) } };
        },
      };
    },
  });
  const timeoutRegistry = registryWith([waitingStream]);
  const timeoutRuntime = createPiRuntime({ targets: [target("a"), target("b")], modelRegistry: timeoutRegistry, scopedModels: [], callableTools: researchTools(), executeTool: async () => ({}) });
  await assert.rejects(timeoutRuntime.start(job({ limits: { timeoutMs: 20, maxTurns: 1, maxTokens: 100 } })), /timed out/);

  const cancelRegistry = registryWith([waitingStream]);
  const cancelRuntime = createPiRuntime({ targets: [target("a"), target("b")], modelRegistry: cancelRegistry, scopedModels: [], callableTools: researchTools(), executeTool: async () => ({}) });
  const activeJob = job({ requestId: "cancel-me:research-a" });
  const promise = cancelRuntime.start(activeJob);
  await new Promise((resolve) => setImmediate(resolve));
  await cancelRuntime.cancel(activeJob);
  await assert.rejects(promise, /Cancelled cancel-me/);
  assert.equal(observedAbort, 2);
});

test("Pi timeout bounds an uncooperative provider and preserves reported partial usage on tool failure", async () => {
  const stubborn = registryWith([() => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } })]);
  const runtime = createPiRuntime({ targets: [target("a"), target("b")], modelRegistry: stubborn, scopedModels: [], callableTools: researchTools(), executeTool: async () => ({}) });
  await assert.rejects(runtime.start(job({ limits: { timeoutMs: 10, maxTurns: 1, maxTokens: 100 } })), /timed out/);
  const registry = registryWith([assistant([{ type: "toolCall", id: "x", name: "brave_search", arguments: { query: "q" } }], "toolUse"), new Error("provider continuation failure")]);
  const failed = createPiRuntime({ targets: [target("a"), target("b")], modelRegistry: registry, scopedModels: [], callableTools: researchTools(), executeTool: async () => { throw new Error("host failure"); } });
  await assert.rejects(failed.start(job()), error => error.usage.totalTokens === 18 && /provider continuation failure/.test(error.message));
});

test("tool discovery rejects lookalike prefixes and Pi rejects unrecorded settings", () => {
  assert.throws(() => discoverResearchTools([{ name: "delete_then_brave_search" }, { name: "fetch_content" }]), /requires callable/);
  assert.throws(() => discoverT3Tools(t3Tools().map(tool => ({ ...tool, name: tool.name.replace("t3_code", "not_t3_code") }))), /Missing callable/);
  const registry = registryWith([]);
  const runtime = createPiRuntime({ targets: [target("a", "pi-registry", { settings: { automaticMemory: true } }), target("b")], modelRegistry: registry, scopedModels: [], callableTools: researchTools(), executeTool: async () => ({}) });
  assert.throws(() => runtime.preflight(job()), /unsupported Pi settings/);
});

function t3Tools() {
  return [
    { name: "mcp__t3_code__orchestrator_capabilities" },
    { name: "mcp__t3_code__delegate_task" },
    { name: "mcp__t3_code__task_status" },
    { name: "mcp__t3_code__task_cancel" },
  ];
}

function capabilities(overrides = {}) {
  const thinkingOption = { id: "thinking", label: "Thinking", type: "select", options: [{ id: "off", label: "Off" }, { id: "high", label: "High" }] };
  return {
    inheritedProviderInstanceId: "provider-a",
    features: { appOwnedSubagents: true, asyncPolling: true, cancellation: true },
    providers: [
      { providerInstanceId: "provider-a", canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], models: [{ id: "alpha-1", options: [thinkingOption] }], ...overrides },
      { providerInstanceId: "provider-b", canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], models: [{ id: "beta-1", options: [thinkingOption] }] },
    ],
  };
}

function jsonResult(value, isError = false) {
  return { isError, content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] };
}

function t3Harness(statuses = []) {
  const calls = [];
  return {
    calls,
    async execute(name, args) {
      calls.push({ name, args: structuredClone(args) });
      if (name.endsWith("orchestrator_capabilities")) return jsonResult(capabilities());
      if (name.endsWith("delegate_task")) return jsonResult({ taskId: "task-123", providerInstanceId: "provider-a", model: "alpha-1" });
      if (name.endsWith("task_status")) return jsonResult({
        taskId: "task-123",
        providerInstanceId: "provider-a",
        model: "alpha-1",
        ...(statuses.shift() ?? { status: "running", workState: "working" }),
      });
      if (name.endsWith("task_cancel")) return jsonResult({ taskId: args.taskId, status: "cancel_requested" });
      throw new Error(`unexpected ${name}`);
    },
  };
}

test("T3 catalog helper exposes exact provider/model choices and respects child-task constraints", async () => {
  const catalog = parseT3Catalog(capabilities());
  assert.deepEqual(listT3CatalogTargets(catalog), [
    { providerInstanceId: "provider-a", model: "alpha-1", canRunChildTask: true, options: [{ id: "thinking", type: "select", values: ["off", "high"] }] },
    { providerInstanceId: "provider-b", model: "beta-1", canRunChildTask: true, options: [{ id: "thinking", type: "select", values: ["off", "high"] }] },
  ]);
  const harness = t3Harness();
  harness.execute = async (name) => name.endsWith("orchestrator_capabilities") ? jsonResult(capabilities({ canRunChildTask: false })) : jsonResult({});
  const runtime = createT3Runtime({ targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(), executeTool: harness.execute });
  await assert.rejects(runtime.preflight(job()), /cannot run child tasks/);

  const unavailableFeatures = capabilities();
  unavailableFeatures.features.cancellation = false;
  const featureRuntime = createT3Runtime({
    targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(),
    executeTool: async (name) => name.endsWith("orchestrator_capabilities") ? jsonResult(unavailableFeatures) : jsonResult({}),
  });
  await assert.rejects(featureRuntime.preflight(job()), /required app-owned async delegation and cancellation/);

  const noCrossProvider = capabilities();
  noCrossProvider.providers[1].canRunCrossProviderChildTask = false;
  const crossRuntime = createT3Runtime({
    targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(),
    executeTool: async (name) => name.endsWith("orchestrator_capabilities") ? jsonResult(noCrossProvider) : jsonResult({}),
  });
  await assert.rejects(crossRuntime.preflight(job({ key: "research-b", requestId: "run-1:research-b", target: "b" })), /cannot run cross-provider/);
});

test("T3 delegates once with exact targeting, modes, stable request ID, and constrained prompt", async () => {
  const harness = t3Harness();
  const runtime = createT3Runtime({ targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(), executeTool: harness.execute });
  const pending = await runtime.start(job());
  const repeated = await runtime.start(job());
  assert.deepEqual(pending, { status: "pending", taskId: "task-123" });
  assert.deepEqual(repeated, pending);
  const delegates = harness.calls.filter((call) => call.name.endsWith("delegate_task"));
  assert.equal(delegates.length, 1, "stable request IDs must not redispatch within one runtime");
  assert.deepEqual(delegates[0].args.target, { providerInstanceId: "provider-a", model: "alpha-1", options: { thinking: "off" } });
  assert.equal(delegates[0].args.mode, "async");
  assert.equal(delegates[0].args.clientRequestId, job().requestId);
  assert.equal(delegates[0].args.runtimeMode, "approval-required");
  assert.equal(delegates[0].args.interactionMode, "inherit");
  assert.equal(delegates[0].args.role, "research");
  for (const phrase of ["Do not write files", "not an operating-system", "hard per-call token", "not by a background daemon"]) assert.ok(delegates[0].args.task.includes(phrase));

  const invalidOptionRuntime = createT3Runtime({
    targets: [target("a", "t3-delegate", { settings: { unsupported: true } }), target("b", "t3-delegate")],
    callableTools: t3Tools(),
    executeTool: harness.execute,
  });
  await assert.rejects(invalidOptionRuntime.start(job({ requestId: "run-2:research-a" })), /does not advertise option unsupported/);
});

test("T3 check performs one status read, returns only original result_available summary, and keeps it stable", async () => {
  const harness = t3Harness([
    { status: "running", workState: "working" },
    { status: "completed", workState: "result_available", summary: "original child summary", latestTerminalSummary: "later turn" },
  ]);
  const runtime = createT3Runtime({ targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(), executeTool: harness.execute });
  const pending = await runtime.start(job());
  const pendingJob = job({ taskId: pending.taskId, status: "pending" });
  assert.deepEqual(await runtime.check(pendingJob), pending);
  assert.deepEqual(await runtime.check(pendingJob), { status: "complete", text: "original child summary" });
  assert.deepEqual(await runtime.check(pendingJob), { status: "complete", text: "original child summary" });
  assert.equal(harness.calls.filter((call) => call.name.endsWith("task_status")).length, 2, "cached completed summaries must not read a later terminal turn");
});

test("T3 status-access failures are explicitly retryable without replacing the child", async () => {
  const adapter = createT3Runtime({ targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(), executeTool: async () => ({ isError: true, content: [{ type: "text", text: "status service unavailable" }] }) });
  await assert.rejects(adapter.check(job({ taskId: "known-pending" })), error => error.retryableStatus === true);
});

test("T3 fails closed on identity/schema/tool errors and never silently falls back", async () => {
  const calls = [];
  const runtime = createT3Runtime({
    targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(),
    async executeTool(name) {
      calls.push(name);
      if (name.endsWith("orchestrator_capabilities")) return jsonResult(capabilities());
      if (name.endsWith("delegate_task")) return jsonResult({ taskId: "x", providerInstanceId: "wrong-provider", model: "alpha-1" });
      throw new Error("no other path expected");
    },
  });
  await assert.rejects(runtime.start(job()), /expected provider-a/);
  assert.deepEqual(calls.map((name) => name.split("__").at(-1)), ["orchestrator_capabilities", "delegate_task"]);

  const schemaRuntime = createT3Runtime({ targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(), executeTool: async () => jsonResult("not json") });
  await assert.rejects(schemaRuntime.preflight(job()), /expected JSON/);

  const missingIdentityHarness = t3Harness();
  missingIdentityHarness.execute = async (name) => {
    if (name.endsWith("orchestrator_capabilities")) return jsonResult(capabilities());
    if (name.endsWith("delegate_task")) return jsonResult({ taskId: "x" });
    throw new Error("no other path expected");
  };
  const missingIdentityRuntime = createT3Runtime({ targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(), executeTool: missingIdentityHarness.execute });
  await assert.rejects(missingIdentityRuntime.start(job()), /omitted the provider instance identity/);

  const failedHarness = t3Harness([{ status: "failed", workState: "result_available", summary: "provider quota" }]);
  const failedRuntime = createT3Runtime({ targets: [target("a", "t3-delegate"), target("b", "t3-delegate")], callableTools: t3Tools(), executeTool: failedHarness.execute });
  const pending = await failedRuntime.start(job());
  await assert.rejects(failedRuntime.check(job({ taskId: pending.taskId, status: "pending" })), /failed: provider quota/);

  await failedRuntime.cancel(job({ taskId: pending.taskId, status: "pending" }));
  const cancel = failedHarness.calls.find((call) => call.name.endsWith("task_cancel"));
  assert.equal(cancel.args.clientRequestId, `${job().requestId}:cancel`);
});
