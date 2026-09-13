import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addTrustedCheckMapping,
  assessTaskCompletion,
  computeVerification,
  captureWorkspaceRevision,
  createTaskState,
  isTaskStateV2,
  loadTaskState,
  loadTaskStateWithRecovery,
  mergeVerificationEvidence,
  normalizeConfig,
  recordToolCall,
  reconcilePersistedToolResults,
  recordUserAttestation,
  replaceTaskCriteria,
  saveTaskState,
  shouldBlockRepeat,
  updateToolResult,
} from "../src/core.ts";
import { runSeparateModelOrchestration } from "../src/orchestration.ts";

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "pi-reliability-foundation-"));
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

const BUILTIN_BASH = { host_provenance: "pi-builtin-bash" };

function passMappedCheck(state, command = "npm test") {
  recordToolCall(state, "check-1", "bash", { command }, BUILTIN_BASH);
  updateToolResult(state, "check-1", "bash", { command }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, BUILTIN_BASH);
}

function legacyFromModern(modern) {
  const legacy = {
    ...modern,
    schema_version: 1,
    counters: {
      context_injections: 0,
      model_responses: 0,
      tool_calls: 0,
      repeated_action_limit: 3,
    },
  };
  for (const key of ["lane", "criteria", "trusted_check_mappings", "execution_receipts", "criterion_results", "model_verification_claims", "completion_gates", "task_identity", "workspace_revision", "pending_tool_calls", "current_session", "recovery", "id_counters", "retired_criterion_ids", "migration"]) delete legacy[key];
  return legacy;
}

test("G1 regression: one mapped passing test cannot certify an unrelated criterion", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Requirement one must be verified.\nRequirement two must be verified.", undefined, normalizeConfig({}));
    assert.equal(state.criteria.length, 2);
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    passMappedCheck(state);

    const verification = computeVerification(state);
    assert.equal(verification.find((item) => item.criterion_id === "C1")?.status, "passed");
    assert.equal(verification.find((item) => item.criterion_id === "C2")?.status, "unknown");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("G2 regression: source edits invalidate a previously passing receipt and a stable retest restores it", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "source.txt"), "before\n");
    const state = createTaskState(cwd, "The source behavior must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    passMappedCheck(state);
    assert.equal(computeVerification(state)[0].status, "passed");

    writeFileSync(join(cwd, "source.txt"), "after\n");
    assert.equal(computeVerification(state)[0].status, "unknown");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");

    recordToolCall(state, "check-2", "bash", { command: "npm test" }, BUILTIN_BASH);
    updateToolResult(state, "check-2", "bash", { command: "npm test" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, BUILTIN_BASH);
    assert.equal(computeVerification(state)[0].status, "passed");
  } finally {
    cleanup(cwd);
  }
});

test("G4 regression: model claims and missing exit outcomes never pass a criterion", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "The behavior must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    mergeVerificationEvidence(state, [{ criterionId: "C1", status: "passed", evidence: "The model says it passed." }]);
    assert.equal(computeVerification(state)[0].status, "unknown");

    recordToolCall(state, "unknown-exit", "bash", { command: "npm test" }, BUILTIN_BASH);
    updateToolResult(state, "unknown-exit", "bash", { command: "npm test" }, undefined, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), undefined, BUILTIN_BASH);
    assert.equal(computeVerification(state)[0].status, "unknown");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("concurrent check batches cannot certify a revision until the batch is settled", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "The behavior must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    recordToolCall(state, "test-call", "bash", { command: "npm test" }, BUILTIN_BASH);
    recordToolCall(state, "sibling-write", "write", { path: "source.txt", content: "new value" }, { host_provenance: "host-tool" });
    updateToolResult(state, "test-call", "bash", { command: "npm test" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, BUILTIN_BASH);

    assert.equal(state.execution_receipts.at(-1)?.batch_settled, false);
    assert.equal(computeVerification(state)[0].status, "unknown");
    updateToolResult(state, "sibling-write", "write", { path: "source.txt", content: "new value" }, false, "written", "written", normalizeConfig({}), undefined, { host_provenance: "host-tool" });
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("G3 regression: a changed edit permits one retest while unchanged and alternating failures stay bounded", () => {
  const cwd = tempCwd();
  try {
    writeFileSync(join(cwd, "source.txt"), "before\n");
    const config = normalizeConfig({ profile: "strict", maxRecoveryAttempts: 2, maxRecoveryActions: 4 });
    const state = createTaskState(cwd, "Fix the failing test.", undefined, config);
    for (const callId of ["failure-1", "failure-2"]) {
      recordToolCall(state, callId, "bash", { command: "npm test" }, BUILTIN_BASH);
      updateToolResult(state, callId, "bash", { command: "npm test" }, true, "Tests failed: same assertion", "Tests failed: same assertion", config, { exitCode: 1 }, BUILTIN_BASH);
    }
    assert.match(shouldBlockRepeat(state, "bash", { command: "npm test" }, config), /repeated failing action/i);

    writeFileSync(join(cwd, "source.txt"), "after\n");
    assert.equal(shouldBlockRepeat(state, "bash", { command: "npm test" }, config), undefined);

    const alternatingConfig = normalizeConfig({ profile: "strict", maxRecoveryAttempts: 2, maxRecoveryActions: 10 });
    const alternating = createTaskState(cwd, "Investigate a failing task.", undefined, alternatingConfig);
    for (const [callId, command] of [["a1", "npm test --unit"], ["a2", "npm test --integration"], ["a3", "npm test --unit"]]) {
      recordToolCall(alternating, callId, "bash", { command }, BUILTIN_BASH);
      updateToolResult(alternating, callId, "bash", { command }, true, `${command} failed`, `${command} failed`, alternatingConfig, { exitCode: 1 }, BUILTIN_BASH);
    }
    assert.match(shouldBlockRepeat(alternating, "bash", { command: "npm test --new" }, alternatingConfig), /alternating no-progress loop/i);
  } finally {
    cleanup(cwd);
  }
});

test("recovery bounds stop successful no-progress variations and elapsed episodes", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({ maxRecoveryAttempts: 3, maxRecoveryActions: 3, maxRecoveryElapsedMs: 1_000 });
    const state = createTaskState(cwd, "Investigate the failure.", undefined, config);
    recordToolCall(state, "fail", "bash", { command: "npm test" }, BUILTIN_BASH);
    updateToolResult(state, "fail", "bash", { command: "npm test" }, true, "same assertion", "same assertion", config, { exitCode: 1 }, BUILTIN_BASH);
    for (const [id, command] of [["success-1", "npm test --one"], ["success-2", "npm test --two"]]) {
      recordToolCall(state, id, "bash", { command }, BUILTIN_BASH);
      updateToolResult(state, id, "bash", { command }, false, "no tests found", "no tests found", config, { exitCode: 0 }, BUILTIN_BASH);
    }
    assert.match(shouldBlockRepeat(state, "bash", { command: "npm test --three" }, config), /total recovery budget/i);

    const timedOut = createTaskState(cwd, "Investigate the timeout.", undefined, config);
    recordToolCall(timedOut, "timed", "bash", { command: "npm test" }, BUILTIN_BASH);
    updateToolResult(timedOut, "timed", "bash", { command: "npm test" }, true, "same assertion", "same assertion", config, { exitCode: 1 }, BUILTIN_BASH);
    timedOut.recovery.episodes[0].started_at = new Date(Date.now() - 5_000).toISOString();
    assert.match(shouldBlockRepeat(timedOut, "bash", { command: "npm test --different" }, config), /time budget/i);
  } finally {
    cleanup(cwd);
  }
});

test("workspace inventory has bounded depth and reports incomplete revisions", () => {
  const cwd = tempCwd();
  try {
    let nested = cwd;
    for (let index = 0; index < 35; index += 1) {
      nested = join(nested, "nested");
      mkdirSync(nested);
    }
    const revision = captureWorkspaceRevision(cwd);
    assert.equal(revision.inventory_complete, false);
    assert.match(revision.reason ?? "", /depth bound/i);
  } finally {
    cleanup(cwd);
  }
});

test("malformed or criterion-free v2 state cannot pass the completion gate", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "A requirement must be verified.", undefined, normalizeConfig({}));
    state.criteria = [];
    state.success_criteria = [];
    assert.equal(isTaskStateV2(state), false);
    const assessment = assessTaskCompletion(state, "explicit");
    assert.equal(assessment.decision, "escalate");
    assert.match(assessment.reasons.join(" "), /malformed|no required acceptance criteria/i);
  } finally {
    cleanup(cwd);
  }
});

test("no-required and malformed states return structured completion escalation", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "A requirement must be verified.", undefined, normalizeConfig({}));
    state.criteria[0].required = false;
    assert.equal(isTaskStateV2(state), false);
    assert.doesNotThrow(() => assessTaskCompletion(state, "explicit"));
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
    assert.doesNotThrow(() => assessTaskCompletion({}));
    assert.equal(assessTaskCompletion({}).decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("real reliability_record_progress ignores only its own pending invocation", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "A behavior must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    passMappedCheck(state);
    recordToolCall(state, "progress-call", "reliability_record_progress", {}, { host_provenance: "host-tool" });
    assert.equal(assessTaskCompletion(state, "progress-tool", { source: "progress-tool", controlToolCallId: "progress-call" }).decision, "pass");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("user attestations are session-and-branch scoped", () => {
  const cwd = tempCwd();
  try {
    const sessionA = { session_id: "session-A", branch_entry_ids: ["root", "attestation"], observed_at: new Date().toISOString() };
    const state = createTaskState(cwd, "A user-confirmed behavior must be verified.", undefined, normalizeConfig({}), sessionA);
    recordUserAttestation(state, "C1", "User confirmed it.", "attestation-1");
    assert.equal(computeVerification(state)[0].status, "passed");
    state.current_session = { session_id: "session-B", branch_entry_ids: ["root", "other"], observed_at: new Date().toISOString() };
    assert.equal(computeVerification(state)[0].status, "unknown");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("receipt retention invalidates dependent evidence without making state unsavable", () => {
  const cwd = tempCwd();
  try {
    const config = normalizeConfig({});
    const state = createTaskState(cwd, "A behavior must be verified.", undefined, config);
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    passMappedCheck(state);
    for (let index = 0; index < 121; index += 1) {
      const callId = `read-${index}`;
      recordToolCall(state, callId, "read", { path: `file-${index}.txt` }, { host_provenance: "host-tool" });
      updateToolResult(state, callId, "read", { path: `file-${index}.txt` }, false, "read", "read", config, undefined, { host_provenance: "host-tool" });
    }
    assert.equal(state.execution_receipts.length, 120);
    assert.equal(new Set(state.execution_receipts.map((receipt) => receipt.id)).size, 120);
    assert.equal(isTaskStateV2(state), true);
    assert.equal(computeVerification(state)[0].status, "unknown");
    saveTaskState(state, "retention-regression");
  } finally {
    cleanup(cwd);
  }
});

test("retired criteria, mappings, and receipts cannot be reused after trimming", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Requirement one.\nRequirement two.", undefined, normalizeConfig({}));
    const firstRequirement = state.criteria[0].requirement;
    const removedCriterionId = state.criteria[1].id;
    const largestInitialCriterionId = Math.max(...state.criteria.map((criterion) => Number(criterion.id.slice(1))));
    addTrustedCheckMapping(state, { criterion_id: removedCriterionId, operation: "bash", command: "npm test", created_by: "host" });
    recordToolCall(state, "old-check", "bash", { command: "npm test" }, BUILTIN_BASH);
    updateToolResult(state, "old-check", "bash", { command: "npm test" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, BUILTIN_BASH);
    replaceTaskCriteria(state, [firstRequirement, "Requirement three."]);
    const replacementCriterionId = state.criteria[1].id;
    assert.equal(state.criteria[0].id, "C1");
    assert.ok(Number(replacementCriterionId.slice(1)) > largestInitialCriterionId);
    assert.ok(state.retired_criterion_ids.includes(removedCriterionId));
    assert.equal(state.trusted_check_mappings.length, 0);
    addTrustedCheckMapping(state, { criterion_id: replacementCriterionId, operation: "bash", command: "npm test", created_by: "host" });
    assert.equal(computeVerification(state).find((record) => record.criterion_id === replacementCriterionId)?.status, "unknown");
    state.execution_receipts = [];
    recordToolCall(state, "new-check", "bash", { command: "npm test" }, BUILTIN_BASH);
    updateToolResult(state, "new-check", "bash", { command: "npm test" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, BUILTIN_BASH);
    assert.equal(state.execution_receipts[0].id, "R2");
    assert.equal(state.trusted_check_mappings.at(-1)?.id, "M2");
  } finally {
    cleanup(cwd);
  }
});

test("missing, duplicate, and untrusted tool results cannot settle a mapped check", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "A behavior must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    recordToolCall(state, "expected", "bash", { command: "npm test" }, BUILTIN_BASH);
    updateToolResult(state, undefined, "bash", { command: "npm test" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, BUILTIN_BASH);
    updateToolResult(state, "expected", "bash", { command: "npm test --different" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, BUILTIN_BASH);
    assert.equal(state.pending_tool_calls.length, 1);
    assert.equal(computeVerification(state)[0].status, "unknown");

    const untrusted = createTaskState(cwd, "Another behavior must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(untrusted, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    recordToolCall(untrusted, "spoofed", "bash", { command: "npm test" });
    updateToolResult(untrusted, "spoofed", "bash", { command: "npm test" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), undefined);
    assert.equal(untrusted.execution_receipts[0].execution_observed, false);
    assert.equal(computeVerification(untrusted)[0].status, "unknown");
  } finally {
    cleanup(cwd);
  }
});

test("a completion control call ignores only itself, not other unsettled work", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "A behavior must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    passMappedCheck(state);
    state.pending_tool_calls.push({
      tool_call_id: "verify-call",
      batch_id: "B-control",
      operation: "reliability_verify_completion",
      started_at: new Date().toISOString(),
      workspace_revision_before: state.workspace_revision.digest,
      input_hash: "control",
      host_provenance: "host-tool",
    });
    assert.equal(assessTaskCompletion(state, "verify-tool", { source: "verify-tool", controlToolCallId: "verify-call" }).decision, "pass");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("session-tree branch identity rejects receipts outside the current branch", () => {
  const cwd = tempCwd();
  try {
    const rootSession = { session_id: "session-1", branch_entry_ids: ["root"], observed_at: new Date().toISOString() };
    const state = createTaskState(cwd, "A behavior must be verified.", undefined, normalizeConfig({}), rootSession);
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    const workerSession = { session_id: "session-1", branch_entry_ids: ["root", "worker-call"], lifecycle_identity: "available", observed_at: new Date().toISOString() };
    recordToolCall(state, "branch-check", "bash", { command: "npm test" }, { ...BUILTIN_BASH, session: workerSession });
    updateToolResult(state, "branch-check", "bash", { command: "npm test" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, { ...BUILTIN_BASH, session: workerSession });
    assert.equal(computeVerification(state)[0].status, "unknown");
    const resultEntry = { id: "tool-result", type: "message", message: { role: "toolResult", toolCallId: "branch-check", toolName: "bash", isError: false } };
    const completedSession = { ...workerSession, branch_entry_ids: ["root", "worker-call", resultEntry.id] };
    reconcilePersistedToolResults(state, completedSession, [{ id: "root" }, { id: "worker-call" }, resultEntry]);
    assert.equal(computeVerification(state)[0].status, "passed");
    state.current_session = { session_id: "session-1", branch_entry_ids: ["root", "fork"], lifecycle_identity: "available", observed_at: new Date().toISOString() };
    assert.equal(computeVerification(state)[0].status, "unknown");
  } finally {
    cleanup(cwd);
  }
});

test("unavailable installed lifecycle identity cannot authorize a runtime receipt", () => {
  const cwd = tempCwd();
  try {
    const unavailableSession = { branch_entry_ids: ["root"], lifecycle_identity: "unavailable", observed_at: new Date().toISOString() };
    const state = createTaskState(cwd, "A behavior must be verified.", undefined, normalizeConfig({}), unavailableSession);
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    recordToolCall(state, "missing-lifecycle", "bash", { command: "npm test" }, { ...BUILTIN_BASH, session: unavailableSession });
    updateToolResult(state, "missing-lifecycle", "bash", { command: "npm test" }, false, "Tests: 1 passed", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 }, { ...BUILTIN_BASH, session: unavailableSession });
    assert.equal(computeVerification(state)[0]?.status, "unknown");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("invalid state is recovery-required and an injected migration failure preserves v1 bytes", () => {
  const cwd = tempCwd();
  try {
    const malformedId = "malformed";
    const malformedDir = join(cwd, ".pi", "tasks", malformedId);
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, "state.json"), "{not json");
    assert.equal(loadTaskStateWithRecovery(cwd, malformedId).status, "recovery-required");

    const modern = createTaskState(cwd, "The migrated task must be verified.", undefined, normalizeConfig({}));
    const legacy = { ...modern, schema_version: 1, counters: { context_injections: 0, model_responses: 0, tool_calls: 0, repeated_action_limit: 3 } };
    for (const key of ["lane", "criteria", "trusted_check_mappings", "execution_receipts", "criterion_results", "model_verification_claims", "completion_gates", "task_identity", "workspace_revision", "pending_tool_calls", "current_session", "recovery", "id_counters", "retired_criterion_ids", "migration"]) delete legacy[key];
    const stateDir = join(cwd, ".pi", "tasks", modern.task_id);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(legacy));
    const migrated = loadTaskState(cwd, modern.task_id);
    assert.throws(() => saveTaskState(migrated, "injected-failure", { failBeforeCommit: true }), /Injected task-state commit failure/);
    assert.equal(JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")).schema_version, 1);
    assert.equal(JSON.parse(readFileSync(join(stateDir, "state.v1.backup.json"), "utf8")).schema_version, 1);
  } finally {
    cleanup(cwd);
  }
});

test("migration rejects malformed v1, verifies original backup bytes, and retries pending events", () => {
  const cwd = tempCwd();
  try {
    const malformedId = "malformed-v1";
    const malformedDir = join(cwd, ".pi", "tasks", malformedId);
    mkdirSync(malformedDir, { recursive: true });
    writeFileSync(join(malformedDir, "state.json"), JSON.stringify({ schema_version: 1, task_id: malformedId, cwd }));
    assert.equal(loadTaskStateWithRecovery(cwd, malformedId).status, "recovery-required");

    const wrongBackupModern = createTaskState(cwd, "A migrated task must be verified.", undefined, normalizeConfig({}));
    const wrongBackupLegacy = legacyFromModern(wrongBackupModern);
    const wrongBackupDir = join(cwd, ".pi", "tasks", wrongBackupModern.task_id);
    mkdirSync(wrongBackupDir, { recursive: true });
    const originalBytes = JSON.stringify(wrongBackupLegacy);
    writeFileSync(join(wrongBackupDir, "state.json"), originalBytes);
    writeFileSync(join(wrongBackupDir, "state.v1.backup.json"), "different source bytes");
    const wrongBackupMigrated = loadTaskState(cwd, wrongBackupModern.task_id);
    assert.throws(() => saveTaskState(wrongBackupMigrated, "wrong-backup"), /backup does not match/i);
    assert.equal(readFileSync(join(wrongBackupDir, "state.json"), "utf8"), originalBytes);

    const retryModern = createTaskState(cwd, "A retryable migrated task must be verified.", undefined, normalizeConfig({}));
    const retryLegacy = legacyFromModern(retryModern);
    const retryDir = join(cwd, ".pi", "tasks", retryModern.task_id);
    mkdirSync(retryDir, { recursive: true });
    writeFileSync(join(retryDir, "state.json"), JSON.stringify(retryLegacy));
    const retryState = loadTaskState(cwd, retryModern.task_id);
    assert.throws(() => saveTaskState(retryState, "inject-late", { failAfterCommitAt: "latest-pointer" }), /latest-pointer failure/);
    assert.equal(JSON.parse(readFileSync(join(retryDir, "state.json"), "utf8")).migration.event_pending, true);
    assert.equal(loadTaskStateWithRecovery(cwd, retryModern.task_id).status, "loaded");
    saveTaskState(retryState, "retry-after-late-failure");
    const committed = JSON.parse(readFileSync(join(retryDir, "state.json"), "utf8"));
    assert.equal(committed.migration.event_pending, false);
    assert.match(readFileSync(join(retryDir, "state-events.jsonl"), "utf8"), /state_migrated_v1_to_v2/);
  } finally {
    cleanup(cwd);
  }
});

test("G5 actual fake-provider regression: accepted supervisor advice reaches the worker", async () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Use supervisor advice before changing code.", undefined, normalizeConfig({}));
    const supervisorAdvice = "Run the isolated diagnostic before editing.";
    const observedPrompts = new Map();
    const result = await runSeparateModelOrchestration(state, normalizeConfig({}), undefined, async (role, prompt) => {
      observedPrompts.set(role, prompt);
      const output = role === "supervisor"
        ? JSON.stringify({ decision_ok: true, risks: [], revised_next_action: supervisorAdvice })
        : role === "worker"
          ? JSON.stringify({ step_id: "S1", action_taken: "inspected", result: "no change", files_changed: [], errors: [], status: "complete" })
          : JSON.stringify({ evidence: [{ criterion: state.criteria[0].requirement, status: "unknown", evidence: "No runtime receipt", remainingWork: "Run a check" }] });
      return { role, prompt, output, exitCode: 0, stderr: "", messages: [], usage: { inputTokens: 3, outputTokens: 2, costUsd: 0 } };
    });
    assert.equal(result.roleResults.length, 3);
    assert.equal(result.executionAllowed, true);
    assert.equal(result.adviceDisposition?.status, "applied");
    assert.match(observedPrompts.get("worker"), new RegExp(supervisorAdvice));
    assert.match(result.roleResults.find((item) => item.role === "worker")?.prompt ?? "", new RegExp(supervisorAdvice));
  } finally {
    cleanup(cwd);
  }
});

test("v1 migration preserves the original artifact, records an event, and leaves history unproven", () => {
  const cwd = tempCwd();
  try {
    const modern = createTaskState(cwd, "The legacy task must be verified.", undefined, normalizeConfig({}));
    const legacy = {
      ...modern,
      schema_version: 1,
      counters: {
        context_injections: 0,
        model_responses: 0,
        tool_calls: 0,
        repeated_action_limit: 3,
      },
    };
    for (const key of ["lane", "criteria", "trusted_check_mappings", "execution_receipts", "criterion_results", "model_verification_claims", "completion_gates", "task_identity", "workspace_revision", "pending_tool_calls", "recovery", "migration"]) {
      delete legacy[key];
    }
    legacy.verification = [{
      criterion: legacy.success_criteria[0],
      status: "passed",
      evidence: "Legacy model claim",
      remaining_work: "",
      source: "model",
      updated_at: new Date().toISOString(),
    }];
    const stateDir = join(cwd, ".pi", "tasks", modern.task_id);
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "state.json"), JSON.stringify(legacy));

    const migrated = loadTaskState(cwd, modern.task_id);
    assert.equal(migrated?.schema_version, 2);
    assert.equal(migrated?.migration.backup_pending, true);
    assert.equal(computeVerification(migrated)[0].status, "unknown");
    saveTaskState(migrated, "migration-test-save");

    assert.equal(JSON.parse(readFileSync(join(stateDir, "state.v1.backup.json"), "utf8")).schema_version, 1);
    assert.equal(JSON.parse(readFileSync(join(stateDir, "state.json"), "utf8")).schema_version, 2);
    assert.match(readFileSync(join(stateDir, "state-events.jsonl"), "utf8"), /state_migrated_v1_to_v2/);
  } finally {
    cleanup(cwd);
  }
});

test("criterion changes preserve only exact IDs and invalidate prior evidence", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "Requirement one must be verified.\nRequirement two must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    passMappedCheck(state);
    assert.equal(computeVerification(state).find((item) => item.criterion_id === "C1")?.status, "passed");

    replaceTaskCriteria(state, ["Requirement one must be verified.", "A changed requirement must be verified."]);
    assert.equal(state.criteria[0].id, "C1");
    assert.equal(state.criteria[1].id, "C3");
    assert.equal(computeVerification(state).find((item) => item.criterion_id === "C1")?.status, "unknown");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});

test("task and branch identity reject evidence reused from another branch", () => {
  const cwd = tempCwd();
  try {
    const state = createTaskState(cwd, "The behavior must be verified.", undefined, normalizeConfig({}));
    addTrustedCheckMapping(state, { criterion_id: "C1", operation: "bash", command: "npm test", created_by: "host" });
    passMappedCheck(state);
    state.task_identity.branch_id = "git:other-branch:deadbeef";
    assert.equal(computeVerification(state)[0].status, "unknown");
    assert.equal(assessTaskCompletion(state, "explicit").decision, "escalate");
  } finally {
    cleanup(cwd);
  }
});
