import assert from "node:assert/strict";
import test from "node:test";
import { advanceRun, cancelRun, createRun } from "../src/engine.ts";
import { createT3Runtime } from "../src/t3-runtime.ts";
import { parseResearchReport } from "../src/validation.ts";

const targets = ["a", "b"].map(key => ({ key, displayName: `Fixture ${key}`, modelAuthor: `fixture-${key}`, model: `model-${key}`, hostingProvider: `provider-${key}`, transport: "t3-delegate", settings: {} }));
function run(id = "recovery-run") {
  return createRun({ runId: id, task: "Offline lifecycle regression", asOfDate: "2026-05-20", createdAt: "2026-05-20T00:00:00.000Z", targets, limits: { maxJobs: 5, perCall: { maxTurns: 5, maxTokens: 1000, timeoutMs: 1000 }, expiresAt: "2099-01-01T00:00:00.000Z" } });
}
function pending() {
  const state = run();
  for (const job of state.jobs) { job.status = "pending"; job.taskId = `task-${job.target}`; }
  return state;
}
function runtime(overrides = {}) {
  return { kind: "t3", async start() { throw new Error("must not start"); }, async check(job) { return { status: "pending", taskId: job.taskId }; }, async cancel() {}, ...overrides };
}

test("O-R1: cancellation intent survives interruption and explicitly reconciles remaining children", async () => {
  const state = pending();
  const calls = [];
  const adapter = runtime({ async cancel(job) { calls.push(job.taskId); } });
  let saved;
  await assert.rejects(cancelRun(state, adapter, snapshot => {
    saved = structuredClone(snapshot);
    throw new Error("interrupted after intent checkpoint");
  }), /interrupted/);
  assert.equal(saved.status, "cancelled");
  await cancelRun(saved, adapter, () => {});
  assert.deepEqual(calls, ["task-a", "task-b"]);
  assert.ok(saved.jobs.every(job => job.cancellationAcknowledgedAt));
  await cancelRun(saved, adapter, () => {});
  assert.equal(calls.length, 2, "acknowledged cleanup must not be repeated");
});

test("O-R1: failed cancellation remains visible and can be retried without stealing completed cleanup", async () => {
  const state = pending();
  const calls = [];
  let fail = true;
  const adapter = runtime({ async cancel(job) {
    calls.push(job.taskId);
    if (job.target === "a" && fail) throw new Error("transport unavailable");
  } });
  await cancelRun(state, adapter, () => {});
  assert.equal(state.jobs[0].status, "pending");
  assert.equal(state.cancellationErrors.length, 1);
  fail = false;
  await cancelRun(state, adapter, () => {});
  assert.deepEqual(calls, ["task-a", "task-b", "task-a"]);
  assert.deepEqual(state.cancellationErrors, []);
});

test("O-R2: abort during a status await enters cleanup before checking another child", async () => {
  const state = pending();
  const controller = new AbortController();
  const checks = []; const cancels = [];
  const adapter = runtime({ async check(job) { checks.push(job.taskId); controller.abort(); throw new Error("aborted transport"); }, async cancel(job, signal) { assert.ok(!signal?.aborted); cancels.push(job.taskId); } });
  await advanceRun(state, adapter, () => {}, controller.signal);
  assert.equal(state.status, "cancelled");
  assert.deepEqual(checks, ["task-a"]);
  assert.deepEqual(cancels, ["task-a", "task-b"]);
});

function t3Fixture(largeReply = false) {
  const names = ["orchestrator_capabilities", "delegate_task", "task_status", "task_cancel"];
  const tools = names.map(name => ({ name: `mcp__t3-code__${name}` }));
  const calls = [];
  const catalog = { inheritedProviderInstanceId: "provider-a", features: { appOwnedSubagents: true, asyncPolling: true, cancellation: true }, providers: targets.map(target => ({ providerInstanceId: target.hostingProvider, canRunChildTask: true, canRunCrossProviderChildTask: true, constraints: [], models: [{ id: target.model, options: [] }] })) };
  const adapter = createT3Runtime({ targets, callableTools: tools, maxToolResultBytes: largeReply ? 1024 : undefined, async executeTool(name, args) {
    calls.push({ name, args });
    const result = name.endsWith("orchestrator_capabilities") ? catalog : name.endsWith("delegate_task") ? { taskId: "known-child", providerInstanceId: "provider-a", model: "substituted-model", ...(largeReply ? { summary: "x".repeat(2000) } : {}) } : { taskId: args.taskId, status: "cancelled" };
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } });
  return { adapter, calls };
}

test("F-R1-03: transient status failures stay pending for explicit reconciliation without new model jobs", async () => {
  const state = pending();
  let unavailable = true; let starts = 0;
  const adapter = runtime({ async start() { starts++; throw new Error("unexpected"); }, async check(job) {
    if (job.target === "a" && unavailable) throw Object.assign(new Error("temporary status transport"), { retryableStatus: true });
    return { status: "pending", taskId: job.taskId };
  } });
  await advanceRun(state, adapter, () => {});
  assert.equal(state.status, "running");
  assert.equal(state.jobs[0].status, "pending");
  assert.match(state.jobs[0].statusError, /temporary status/);
  unavailable = false;
  await advanceRun(state, adapter, () => {});
  assert.equal(state.jobs[0].statusError, undefined);
  assert.equal(starts, 0);
});

test("O-R3: rejected child identity retains its known ID for durable cancellation", async () => {
  const state = run("rejected-identity");
  const { adapter, calls } = t3Fixture();
  await advanceRun(state, adapter, () => {});
  assert.equal(state.status, "error");
  assert.equal(state.jobs[0].taskId, "known-child");
  assert.equal(state.error.code, "runtime_error");
  await cancelRun(state, adapter, () => {});
  assert.ok(calls.some(call => call.name.endsWith("task_cancel") && call.args.taskId === "known-child"));
});

test("F-R1-02: a readable task handle survives response-size rejection", async () => {
  const state = run("response-bound");
  const { adapter, calls } = t3Fixture(true);
  await advanceRun(state, adapter, () => {});
  assert.equal(state.jobs[0].taskId, "known-child");
  assert.match(state.error.message, /exceeds|too large/);
  await cancelRun(state, adapter, () => {});
  assert.ok(calls.some(call => call.name.endsWith("task_cancel") && call.args.taskId === "known-child"));
});

test("O-R4: oversized T3 prompts fail preflight before any dispatch checkpoint or delegate call", async () => {
  const state = run("prompt-bound");
  state.jobs[0].prompt = "x".repeat(120001);
  const { adapter, calls } = t3Fixture();
  const snapshots = [];
  await advanceRun(state, adapter, snapshot => snapshots.push(structuredClone(snapshot)));
  assert.equal(state.status, "error");
  assert.equal(state.error.code, "runtime_error");
  assert.match(state.error.message, /Preflight.*120000/);
  assert.ok(!calls.some(call => call.name.endsWith("delegate_task")));
  assert.ok(!snapshots.some(snapshot => snapshot.jobs.some(job => job.status === "dispatching")));
});

test("O-R4: research outputs have a bounded full-exchange budget rather than silent truncation", () => {
  assert.throws(() => parseResearchReport(" ".repeat(18001), targets[0], targets), /18000 characters/);
});

test("unknown T3 dispatch cancellation stays unresolved rather than claiming child cleanup", async () => {
  const state = run("unknown-dispatch");
  state.jobs[0].status = "dispatching";
  await cancelRun(state, runtime(), () => {});
  assert.equal(state.status, "cancelled");
  assert.match(state.jobs[0].cancellationError, /no task ID/);
  assert.equal(state.jobs[0].cancellationAcknowledgedAt, undefined);
});
