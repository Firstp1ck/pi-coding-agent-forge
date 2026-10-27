import assert from "node:assert/strict";
import test from "node:test";
import { advanceRun, cancelRun, createRun } from "../src/engine.ts";
import { createT3Runtime } from "../src/t3-runtime.ts";
import { createInjectedToolBridge } from "../src/tool-bridge.ts";

const targets = ["a", "b"].map(key => ({ key, displayName: key, modelAuthor: `author-${key}`, model: `model-${key}`, hostingProvider: `provider-${key}`, transport: "t3-delegate", settings: {} }));
const tools = ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"].map(name => ({ name: `mcp__t3-code__${name}` }));
const envelope = value => ({ content: [{ type: "text", text: JSON.stringify(value) }], isError: false });
function run(id) {
  return createRun({ runId: id, task: "Offline native-contract regression", asOfDate: "2026-05-20", createdAt: "2026-05-20T00:00:00.000Z", targets, limits: { maxJobs: 5, perCall: { timeoutMs: 1000, maxTokens: 1000, maxTurns: 4 }, expiresAt: "2099-01-01T00:00:00.000Z" } });
}
function pending(id) {
  const state = run(id);
  for (const job of state.jobs) { job.status = "pending"; job.taskId = `task-${job.target}`; }
  return state;
}

test("F-R2-01: actual T3 text-plus-structured flattening accepts only deeply identical JSON documents", async () => {
  const object = { taskId: "known", nested: { summary: 'Quoted } and { and \\" text', values: [1, true, null] } };
  const bridge = createInjectedToolBridge(async () => ({ content: [{ type: "text", text: `${JSON.stringify(object, null, 2)}\n${JSON.stringify(object)}` }] }));
  assert.deepEqual(await bridge.callJson("mcp__t3-code__task_status", {}), object);
  const conflict = createInjectedToolBridge(async () => ({ content: [{ type: "text", text: '{"taskId":"first"}\n{"taskId":"other"}' }] }));
  await assert.rejects(conflict.callJson("mcp__t3-code__task_status", {}), /Conflicting/);
  const prose = createInjectedToolBridge(async () => ({ content: [{ type: "text", text: 'Here is a result: {"taskId":"first"}' }] }));
  await assert.rejects(prose.callJson("mcp__t3-code__task_status", {}), /expected JSON/i);
});

test("F-R2-01: duplicate transport JSON also preserves a readable task handle on size rejection", async () => {
  const object = { taskId: "known-child", summary: "x".repeat(2000) };
  const bridge = createInjectedToolBridge(async () => ({ content: [{ type: "text", text: `${JSON.stringify(object)}\n${JSON.stringify(object)}` }] }), { maxResultBytes: 1024 });
  await assert.rejects(bridge.callJson("mcp__t3-code__delegate_task", {}), error => error.kind === "limit" && error.taskId === "known-child");
});

test("O-R2-01: cleanup bypasses the actual installed Pi runner's aborted-parent default", async () => {
  const sdk = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { ExtensionRunner } = await import(new URL("./core/extensions/runner.js", sdk).href);
  const owner = new AbortController();
  const cancellations = [];
  const facade = {
    createContext: () => ({}), assertActive() {}, getCallableToolsFn: () => tools,
    async executeToolFn(_parent, name, args, options) {
      if (name.endsWith("task_status")) { owner.abort(); throw new Error("Status read aborted at native boundary"); }
      cancellations.push({ taskId: args.taskId, aborted: options.signal.aborted, inherited: options.signal === owner.signal });
      if (options.signal.aborted) return { result: { content: [{ type: "text", text: "Aborted parent signal" }], details: {} }, isError: true };
      return { result: envelope({ taskId: args.taskId, status: "cancel_requested" }), isError: false };
    },
  };
  const context = ExtensionRunner.prototype.createToolContext.call(facade, "native-fixture", owner.signal);
  const adapter = createT3Runtime({ targets, callableTools: tools, executeTool: (name, args, options) => context.executeTool(name, args, options) });
  const state = pending("native-abort-cleanup");
  await advanceRun(state, adapter, () => {}, owner.signal);
  assert.equal(state.status, "cancelled");
  assert.equal(cancellations.length, 2);
  assert.ok(cancellations.every(item => !item.aborted && !item.inherited));
  assert.ok(state.jobs.every(job => job.cancellationAcknowledgedAt));
});

test("O-R2-02: malformed or wrong cancellation acknowledgements remain unresolved and retryable", async () => {
  for (const [index, invalid] of [{}, { taskId: "other", status: "cancel_requested" }, { taskId: "task-a", status: "running" }].entries()) {
    let valid = false;
    const adapter = createT3Runtime({ targets, callableTools: tools, executeTool: async (_name, args) => envelope(valid ? { taskId: args.taskId, status: "cancel_requested" } : invalid) });
    const state = pending(`cancel-contract-${index}`);
    await cancelRun(state, adapter, () => {});
    assert.ok(state.jobs.every(job => !job.cancellationAcknowledgedAt));
    assert.equal(state.cancellationErrors.length, 2);
    valid = true;
    await cancelRun(state, adapter, () => {});
    assert.ok(state.jobs.every(job => job.cancellationAcknowledgedAt));
    assert.deepEqual(state.cancellationErrors, []);
  }
});

test("O-R2-03: reader policy and size failures retain machine classifications through native-shaped results", async () => {
  for (const kind of ["policy", "limit", "invalid_result", "access"]) {
    const bridge = createInjectedToolBridge(async () => ({ result: { isError: true, content: [{ type: "text", text: "Reader failed" }], structuredContent: { errorKind: kind, message: "Reader failed" } }, isError: true }));
    await assert.rejects(bridge.callText("model_research_fetch", { url: "https://example.com" }), error => error.kind === kind);
  }
  const unclassified = createInjectedToolBridge(async () => ({ isError: true, content: [{ type: "text", text: "Reader failed without metadata" }] }));
  await assert.rejects(unclassified.callText("model_research_fetch", {}), error => error.kind === "invalid_result");
});

test("F-R2-03: definite Pi failures retain runtime_error and usage even after cancellation", async () => {
  const state = run("pi-definite-failure");
  for (const target of state.targets) target.transport = "pi-registry";
  const adapter = { kind: "pi", async start() { throw Object.assign(new Error("Known provider failure"), { usage: { totalTokens: 25 } }); }, async check() { throw new Error("unexpected"); }, async cancel() {} };
  await advanceRun(state, adapter, () => {});
  assert.equal(state.error.code, "runtime_error");
  assert.equal(state.jobs[0].status, "error");
  assert.equal(state.jobs[0].usage.totalTokens, 25);
  assert.match(state.jobs[0].error, /Known provider/);
  await cancelRun(state, adapter, () => {});
  assert.equal(state.jobs[0].status, "error");
  assert.match(state.jobs[0].error, /Known provider/);
});
