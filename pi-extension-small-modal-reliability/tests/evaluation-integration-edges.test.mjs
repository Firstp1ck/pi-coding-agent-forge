import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { normalizeConfig, runBoundedLiveEvaluation } from "../src/core.ts";

const config = normalizeConfig({ evaluation: { liveModels: ["fixture/model"], timeoutMs: 1000, maxCases: 2 } }).evaluation;
const request = { suite: "all", model: "fixture/model" };
const cases = [{ id: "case-1", suite: "coding", prompt: "Return yes", expected_outcome: "supported", evaluateOutput: (output) => output === "yes" ? "supported" : "failed" }];
const resultPacket = { results: [{ id: "case-1", output: "yes" }], aggregate_usage: { input_tokens: 10, output_tokens: 2 } };

test("live evaluation does not invoke an adapter cancelled before its scheduled call", async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = runBoundedLiveEvaluation(request, config, cases, { model: request.model, invoke: async () => { calls++; return resultPacket; } }, controller.signal);
  controller.abort();
  const report = await pending;
  assert.equal(calls, 0);
  assert.equal(report.calls_made, 0);
  assert.equal(report.status, "cancelled");
});

test("live evaluation releases cancellation listeners after successful settlement", async () => {
  const controller = new AbortController();
  const before = getEventListeners(controller.signal, "abort").length;
  await runBoundedLiveEvaluation(request, config, cases, { model: request.model, invoke: async () => resultPacket }, controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, before);
});

test("live evaluation reports malformed adapter results and over-budget usage", async () => {
  for (const packet of [null, 1, { results: null }, { ...resultPacket, aggregate_usage: { input_tokens: 10, output_tokens: 2049 } }]) {
    const report = await runBoundedLiveEvaluation(request, config, cases, { model: request.model, invoke: async () => packet });
    assert.equal(report.status, "failed");
    assert.equal(report.calls_made, 1);
  }
});

test("native adapter provenance is distinct from simulated evaluation", async () => {
  const report = await runBoundedLiveEvaluation(request, config, cases, { model: request.model, kind: "native", invoke: async () => resultPacket });
  assert.equal(report.mode, "live");
  assert.deepEqual(report.aggregate_usage, resultPacket.aggregate_usage);
});
