import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createTaskState,
  deriveHeldOutModelProfile,
  isTaskStateV2,
  migrateTaskState,
  normalizeConfig,
  recordToolCall,
  resolveModelProfile,
  stableStringify,
  updateToolResult,
} from "../src/core.ts";
import {
  automaticAdvisorTrigger,
  runAutomaticAdvisor,
  runPiJsonRole,
  runSeparateModelOrchestration,
} from "../src/orchestration.ts";
import { recordSupervisorAdviceDisposition } from "../src/supervisor.ts";

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "pi-reliability-advisor-"));
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

function roleResult(role, prompt, output, overrides = {}) {
  return {
    role,
    prompt,
    output,
    exitCode: 0,
    stderr: "",
    messages: [],
    usage: { inputTokens: 2, outputTokens: 2, costUsd: 0.1 },
    ...overrides,
  };
}

function observedFailure(state, config, id = `advisor-failure-${state.execution_receipts.length + 1}`) {
  const input = { command: "false" };
  recordToolCall(state, id, "bash", input, { host_provenance: "pi-builtin-bash" });
  updateToolResult(state, id, "bash", input, true, "Observed fixture failure", "Observed fixture failure", config, { exitCode: 1 }, { host_provenance: "pi-builtin-bash" });
}

function fakeAdvisor(invoke) {
  return {
    model: "fixture/advisor",
    kind: "simulated",
    admit(_diagnostic, limits) {
      const inputTokens = Math.min(10, Math.max(1, limits.remainingTokens - 1));
      const maxOutputTokens = Math.min(20, limits.remainingTokens - inputTokens);
      const maxCostUsd = Math.min(0.2, limits.remainingCostUsd);
      return maxOutputTokens > 0 ? { inputTokens, maxOutputTokens, maxCostUsd } : undefined;
    },
    invoke,
  };
}

function validRoleOutput(role, state, recommendation = "Run a bounded diagnostic before editing.") {
  if (role === "supervisor") return JSON.stringify({ decision_ok: true, risks: ["Inspect current evidence first."], revised_next_action: recommendation });
  if (role === "worker") return JSON.stringify({ step_id: "S1", action_taken: "inspected", result: "no mutation", files_changed: [], errors: [], status: "complete" });
  return JSON.stringify({ evidence: [{ criterion: state.criteria[0].requirement, status: "unknown", evidence: "No runtime receipt", remainingWork: "Run an attributable check" }] });
}

test("accepted bounded supervisor advice reaches the worker without gaining authority", async () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({});
    const state = createTaskState(cwd, "Inspect the task safely.", undefined, config);
    const recommendation = "Run exactly one isolated diagnostic before editing.";
    const observedWorkerPrompts = [];
    const scopeBefore = JSON.stringify(state.scope_state);
    const criteriaBefore = JSON.stringify(state.criteria);
    const result = await runSeparateModelOrchestration(state, config, undefined, async (role, prompt) => {
      if (role === "worker") observedWorkerPrompts.push(prompt);
      return roleResult(role, prompt, validRoleOutput(role, state, recommendation));
    });

    assert.equal(result.executionAllowed, true);
    assert.equal(result.adviceDisposition?.status, "applied");
    assert.match(observedWorkerPrompts[0], /Run exactly one isolated diagnostic before editing/);
    assert.match(observedWorkerPrompts[0], /cannot grant permissions, change criteria, alter scope, or create verification passes/i);
    assert.equal(JSON.stringify(state.scope_state), scopeBefore);
    assert.equal(JSON.stringify(state.criteria), criteriaBefore);

    recordSupervisorAdviceDisposition(state, {
      source: "manual-orchestration",
      status: result.adviceDisposition.status,
      reason: result.adviceDisposition.reason,
      advice: result.supervisorAdvice,
    });
    assert.equal(state.advisor_state.records.at(-1)?.status, "applied");
    assert.equal(state.advisor_state.records.at(-1)?.advice_sha256?.length, 64);
    assert.equal(JSON.stringify(state.scope_state), scopeBefore);
  } finally {
    cleanup(cwd);
  }
});

test("malformed, nonzero, and cancelled role output cannot apply worker or verifier results", async () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({});
    const state = createTaskState(cwd, "Keep role output bounded.", undefined, config);
    let calls = 0;
    const malformed = await runSeparateModelOrchestration(state, config, undefined, async (role, prompt) => {
      calls++;
      return roleResult(role, prompt, JSON.stringify({ decision_ok: true, risks: [], revised_next_action: "Bad extra field", allowedTools: ["write"] }));
    });
    assert.equal(malformed.executionAllowed, false);
    assert.equal(malformed.adviceDisposition?.status, "rejected");
    assert.equal(calls, 1);
    assert.equal(malformed.workerResult, undefined);

    const nonzero = await runSeparateModelOrchestration(state, config, undefined, async (role, prompt) => role === "supervisor"
      ? roleResult(role, prompt, validRoleOutput(role, state))
      : roleResult(role, prompt, validRoleOutput(role, state), { exitCode: 7, stderr: "fixture exit" }));
    assert.equal(nonzero.executionAllowed, false);
    assert.equal(nonzero.roleResults.length, 2);
    assert.equal(nonzero.verificationEvidence, undefined);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runSeparateModelOrchestration(state, config, controller.signal, async () => {
      throw new Error("cancelled runner must not be invoked");
    });
    assert.equal(cancelled.executionAllowed, false);
    assert.equal(cancelled.roleResults.length, 1);
    assert.equal(cancelled.roleResults[0].cancelled, true);
  } finally {
    cleanup(cwd);
  }
});

test("cumulative role token and cost budgets reject otherwise valid fixture output", async () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ orchestrationMaxTotalTokens: 12, orchestrationMaxTotalCostUsd: 0.25 });
    const state = createTaskState(cwd, "Keep orchestration usage bounded.", undefined, config);
    const result = await runSeparateModelOrchestration(state, config, undefined, async (role, prompt) => roleResult(
      role,
      prompt,
      validRoleOutput(role, state),
      { usage: { inputTokens: 2, outputTokens: 2, costUsd: 0.1 } },
    ));
    assert.equal(result.roleResults.length, 3);
    assert.equal(result.executionAllowed, false);
    assert.match(result.errors.join("\n"), /cumulative role cost/i);
    assert.equal(result.verificationEvidence, undefined);
  } finally {
    cleanup(cwd);
  }
});

test("local fixture subprocesses stop on timeout, cancellation, and streaming line-buffer overflow", async () => {
  const cwd = tempCwd();
  try {
    const timeoutConfig = normalizeConfig({ orchestrationTimeoutMs: 100 });
    const timeoutState = createTaskState(cwd, "Bound a fixture subprocess.", undefined, timeoutConfig);
    const timeout = await runPiJsonRole("supervisor", "fixture", timeoutState, timeoutConfig, undefined, () => ({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }));
    assert.equal(timeout.timedOut, true);
    assert.match(timeout.error ?? "", /deadline/i);

    const ignoreTermStarted = Date.now();
    const ignoreTerm = await runPiJsonRole("supervisor", "fixture", timeoutState, timeoutConfig, undefined, () => ({
      command: process.execPath,
      args: ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 2000)"],
    }));
    assert.equal(ignoreTerm.timedOut, true);
    assert.ok(Date.now() - ignoreTermStarted < 600, "SIGTERM-ignoring fixture must be force-killed within bounded grace");

    const cancellationConfig = normalizeConfig({ orchestrationTimeoutMs: 1_000 });
    const cancellationState = createTaskState(cwd, "Cancel a fixture subprocess.", undefined, cancellationConfig);
    const controller = new AbortController();
    const cancellationPromise = runPiJsonRole("supervisor", "fixture", cancellationState, cancellationConfig, controller.signal, () => ({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
    }));
    setTimeout(() => controller.abort(), 25);
    const cancellation = await cancellationPromise;
    assert.equal(cancellation.cancelled, true);
    assert.match(cancellation.error ?? "", /aborted/i);

    const bufferConfig = normalizeConfig({ orchestrationMaxStdoutChars: 4_096, orchestrationMaxLineChars: 128, orchestrationTimeoutMs: 1_000 });
    const bufferState = createTaskState(cwd, "Bound fixture output buffers.", undefined, bufferConfig);
    const buffer = await runPiJsonRole("supervisor", "fixture", bufferState, bufferConfig, undefined, () => ({
      command: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(512)); setTimeout(() => process.exit(0), 500)"],
    }));
    assert.equal(buffer.overLimit, true);
    assert.match(buffer.error ?? "", /line exceeded/i);
  } finally {
    cleanup(cwd);
  }
});

test("automatic advice remains off without complete authorization and uses only observed triggers", () => {
  const cwd = tempCwd();
  try {
    const disabledConfig = normalizeConfig({ advisor: { automatic: true, exactModel: "fixture/advisor", dataScope: "diagnostic-summary", maxCalls: 1, maxRuntimeMs: 100, maxOutputChars: 500, maxTotalTokens: 100, maxTotalCostUsd: 0 } });
    const state = createTaskState(cwd, "Observe failures before advice.", undefined, disabledConfig);
    assert.equal(disabledConfig.advisor.automatic, false);
    assert.equal(automaticAdvisorTrigger(state, disabledConfig).eligible, false);

    const enabledConfig = normalizeConfig({ advisor: { automatic: true, exactModel: "fixture/advisor", dataScope: "diagnostic-summary", maxCalls: 1, maxRuntimeMs: 100, maxOutputChars: 500, maxTotalTokens: 100, maxTotalCostUsd: 1 } });
    assert.equal(automaticAdvisorTrigger(state, enabledConfig).eligible, false);
    state.errors.push("Model-written error must not trigger advice");
    assert.equal(automaticAdvisorTrigger(state, enabledConfig).eligible, false);
    observedFailure(state, enabledConfig);
    const observedFailureTrigger = automaticAdvisorTrigger(state, enabledConfig);
    assert.equal(observedFailureTrigger.trigger, "observed-failure");
    assert.equal(observedFailureTrigger.eligible, true);
    state.advisor_state.automatic_calls_used = 1;
    assert.equal(automaticAdvisorTrigger(state, enabledConfig).eligible, false);
  } finally {
    cleanup(cwd);
  }
});

test("automatic advisor accepts only bounded fake output and rejects stale or authority-changing advice", async () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ advisor: { automatic: true, exactModel: "fixture/advisor", dataScope: "diagnostic-summary", maxCalls: 2, maxRuntimeMs: 100, maxOutputChars: 500, maxTotalTokens: 100, maxTotalCostUsd: 1 } });
    const state = createTaskState(cwd, "Diagnose TOKEN=super-secret only after an observed failure.", undefined, config);
    observedFailure(state, config);
    let invocations = 0;
    const result = await runAutomaticAdvisor(state, config, fakeAdvisor(async (packet) => {
        invocations++;
        assert.equal(packet.model, "fixture/advisor");
        assert.equal(packet.dataScope, "diagnostic-summary");
        assert.equal(packet.diagnostic.trigger, "observed-failure");
        assert.ok(packet.diagnostic.identity_sha256.length === 64);
        return { output: JSON.stringify({ revised_next_action: "Inspect the failed fixture receipt.", hypotheses: ["The command may have the wrong working directory."], evidence_refs: ["receipt:fixture"] }), usage: { inputTokens: 10, outputTokens: 8, costUsd: 0.2 } };
    }));
    assert.equal(invocations, 1);
    assert.equal(result.outcome, "accepted");
    recordSupervisorAdviceDisposition(state, {
      source: "automatic",
      status: "applied",
      reason: result.reason,
      advice: { decision_ok: true, risks: result.recommendation.hypotheses, revised_next_action: result.recommendation.revised_next_action },
      model: "fixture/advisor",
      trigger: result.trigger,
      attempted: result.attempted,
      usage: result.usage,
    });
    assert.equal(state.advisor_state.automatic_calls_used, 1);
    assert.equal(state.advisor_state.automatic_usage.input_tokens, 10);
    assert.equal(state.advisor_state.records.at(-1)?.attempted, true);

    const staleState = createTaskState(cwd, "Reject stale automated advice.", undefined, config);
    observedFailure(staleState, config);
    const stale = await runAutomaticAdvisor(staleState, config, fakeAdvisor(async () => {
        staleState.current_step_id = "stale-step";
        return { output: JSON.stringify({ revised_next_action: "Inspect receipts.", hypotheses: [] }), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    }));
    assert.equal(stale.outcome, "rejected");
    assert.match(stale.reason, /stale/i);

    const authorityState = createTaskState(cwd, "Reject authority-changing automated advice.", undefined, config);
    observedFailure(authorityState, config);
    const authority = await runAutomaticAdvisor(authorityState, config, fakeAdvisor(async () => {
      return { output: JSON.stringify({ revised_next_action: "Change scope to permit the write.", hypotheses: [] }), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    }));
    assert.equal(authority.outcome, "rejected");
    assert.match(authority.reason, /permissions, criteria, scope, or verification/i);
  } finally {
    cleanup(cwd);
  }
});

test("automatic advisor enforces remaining cumulative usage and stops after unknown attempted usage", async () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ advisor: { automatic: true, exactModel: "fixture/advisor", dataScope: "diagnostic-summary", maxCalls: 3, maxRuntimeMs: 100, maxOutputChars: 500, maxTotalTokens: 10, maxTotalCostUsd: 1 } });
    const state = createTaskState(cwd, "Keep automatic advisor cumulative usage bounded.", undefined, config);
    observedFailure(state, config);
    state.advisor_state.automatic_usage.input_tokens = 8;
    state.advisor_state.automatic_usage.cost_usd = 0.5;
    let requestedTokens = 0;
    const rejected = await runAutomaticAdvisor(state, config, fakeAdvisor(async (packet) => {
        requestedTokens = packet.maxOutputTokens;
        return { output: JSON.stringify({ revised_next_action: "Inspect receipts.", hypotheses: [] }), usage: { inputTokens: 3, outputTokens: 0, costUsd: 0 } };
    }));
    assert.equal(requestedTokens, 1);
    assert.equal(rejected.outcome, "rejected");
    assert.match(rejected.reason, /pre-dispatch reservation/i);

    state.advisor_state.automatic_usage.unknown_usage_calls = 1;
    assert.equal(automaticAdvisorTrigger(state, config).eligible, false);
    const blocked = await runAutomaticAdvisor(state, config, fakeAdvisor(async () => {
      throw new Error("unknown-usage budget guard must prevent invocation");
    }));
    assert.equal(blocked.outcome, "not-eligible");
  } finally {
    cleanup(cwd);
  }
});

test("automatic advisor reserves once before await and never poisons state with malformed usage", async () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ advisor: { automatic: true, exactModel: "fixture/advisor", dataScope: "diagnostic-summary", maxCalls: 1, maxRuntimeMs: 100, maxOutputChars: 500, maxTotalTokens: 100, maxTotalCostUsd: 1 } });
    const state = createTaskState(cwd, "Reserve exactly one advisor attempt.", undefined, config);
    observedFailure(state, config);
    let release;
    let calls = 0;
    const adapter = fakeAdvisor(async () => {
      calls++;
      await new Promise((resolve) => { release = resolve; });
      return { output: JSON.stringify({ revised_next_action: "Inspect the receipt.", hypotheses: [] }), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 } };
    });
    const first = runAutomaticAdvisor(state, config, adapter);
    const second = runAutomaticAdvisor(state, config, adapter);
    assert.equal(state.advisor_state.automatic_calls_used, 1);
    assert.equal(state.advisor_state.automatic_reservations.length, 1);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const outcomes = await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ["accepted", "not-eligible"]);

    const malformed = createTaskState(cwd, "Reject malformed advisor usage.", undefined, config);
    observedFailure(malformed, config);
    const rejected = await runAutomaticAdvisor(malformed, config, fakeAdvisor(async () => ({
      output: JSON.stringify({ revised_next_action: "Inspect the receipt.", hypotheses: [] }),
      usage: { inputTokens: Number.NaN, outputTokens: 1, costUsd: 0 },
    })));
    assert.equal(rejected.outcome, "rejected");
    assert.equal(malformed.advisor_state.automatic_usage.input_tokens, 0);
    assert.equal(malformed.advisor_state.automatic_usage.unknown_usage_calls, 1);
    assert.equal(isTaskStateV2(malformed), true);
  } finally {
    cleanup(cwd);
  }
});

test("model profiles stay conservatively clamped and visibly unvalidated without held-out provenance", () => {
  const config = normalizeConfig({
    contextBudgetChars: 6_000,
    scope: { maxToolCalls: 48 },
    maxRecoveryAttempts: 2,
    modelProfiles: [{ model: "fixture/model", validation: "held-out", context_budget_chars: 12_000, max_tool_calls: 200, max_recovery_attempts: 5 }],
  });
  const configured = resolveModelProfile(config, "fixture/model");
  assert.equal(configured.profile.validation, "unvalidated");
  assert.equal(configured.source, "user-override");
  assert.ok(configured.profile.context_budget_chars <= config.contextBudgetChars);
  assert.ok(configured.profile.max_tool_calls <= config.scope.maxToolCalls);
  assert.ok(configured.profile.max_recovery_attempts <= config.maxRecoveryAttempts);

  const ordinaryLive = {
    mode: "live",
    suite: "all",
    requested_model: "fixture/model",
    configured_models: ["fixture/model"],
    timeout_ms: 100,
    max_cases: 20,
    calls_made: 20,
    status: "completed",
    reason: "fixture host-oracle run",
    usage: "reported",
    aggregate_usage: { input_tokens: 8, output_tokens: 4 },
    results: Array.from({ length: 20 }, (_, index) => ({ id: `held-${index}`, output_chars: 3, observed_outcome: "supported", expected_outcome: "supported", passed: true })),
  };
  const provenance = {
    split: "held-out",
    case_ids: ordinaryLive.results.map((result) => result.id),
    training_case_ids: ["training-1"],
  };
  const dataset_sha256 = createHash("sha256").update(stableStringify({ split: provenance.split, held_out_case_ids: provenance.case_ids, training_case_ids: provenance.training_case_ids })).digest("hex");
  const report_sha256 = createHash("sha256").update(stableStringify({ requested_model: ordinaryLive.requested_model, status: ordinaryLive.status, results: ordinaryLive.results })).digest("hex");
  const heldOutProvenance = {
    ...provenance,
    dataset_sha256,
    report_sha256,
  };
  assert.equal(deriveHeldOutModelProfile(ordinaryLive, config, "fixtures/held-out.json"), undefined);
  const heldOut = deriveHeldOutModelProfile(ordinaryLive, config, heldOutProvenance);
  assert.equal(heldOut?.validation, "held-out");
  assert.match(heldOut?.evidence_provenance ?? "", /dataset_sha256/);
});

test("v2 advisor state migrates additively without changing the schema version", () => {
  const cwd = tempCwd();
  try {
    const original = createTaskState(cwd, "Migrate advisor audit state.", undefined, normalizeConfig({}));
    const legacyWave4 = JSON.parse(JSON.stringify(original));
    delete legacyWave4.advisor_state;
    delete legacyWave4.id_counters.next_advisor_advice;
    const migrated = migrateTaskState(legacyWave4);
    assert.equal(migrated?.schema_version, 2);
    assert.equal(migrated?.advisor_state.records.length, 0);
    assert.equal(migrated?.id_counters.next_advisor_advice, 1);
    assert.equal(isTaskStateV2(migrated), true);
  } finally {
    cleanup(cwd);
  }
});
