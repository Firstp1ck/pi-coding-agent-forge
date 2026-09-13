import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configNormalizationWarnings, createTaskState, normalizeConfig, saveTaskState, loadTaskStateWithRecovery, isTaskStateV2, computeVerification, recordQualityGateClaim, recordToolCall, updateToolResult } from "../src/core.ts";

function workspace() {
  return mkdtempSync(join(tmpdir(), "pi-reliability-release-"));
}

test("genuine v1 plan steps migrate without retaining modern fixture fields", () => {
  const cwd = workspace();
  try {
    const legacy = JSON.parse(readFileSync(new URL("./fixtures/legacy-task-v1.json", import.meta.url), "utf8"));
    legacy.cwd = cwd;
    const directory = join(cwd, ".pi", "tasks", legacy.task_id);
    mkdirSync(directory, { recursive: true });
    const original = JSON.stringify(legacy);
    writeFileSync(join(directory, "state.json"), original);
    const loaded = loadTaskStateWithRecovery(cwd, legacy.task_id);
    assert.equal(loaded.status, "loaded");
    assert.equal(isTaskStateV2(loaded.state), true);
    assert.deepEqual(loaded.state.plan[0].exit_conditions, []);
    assert.deepEqual(loaded.state.plan[0].exit_evidence_receipt_ids, []);
    assert.deepEqual(loaded.state.plan[0].exit_evidence_artifact_refs, []);
    assert.ok(computeVerification(loaded.state).every((record) => record.status !== "passed"));
    saveTaskState(loaded.state, "genuine-v1-migration");
    assert.equal(readFileSync(join(directory, "state.v1.backup.json"), "utf8"), original);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

for (const shape of ["absent", "early", "pre-checkpoint"]) {
  for (const marker of ["authority", "pause", "both", "native-origin", "validation-status"]) {
    test(`RF3 ${shape} advisor omissions with modern ${marker} require non-destructive recovery`, () => {
      const cwd = workspace();
      try {
        const state = createTaskState(cwd, "Preserve consumed advisor usage", undefined, normalizeConfig({}));
        state.advisor_state.automatic_calls_used = 3;
        state.advisor_state.automatic_usage = { input_tokens: 300, output_tokens: 120, cost_usd: 0.25, unknown_usage_calls: 1 };
        if (marker === "authority" || marker === "both") state.current_session.input_authority_receipts = [];
        if (marker === "pause" || marker === "both") state.input_pause = { observation_id: "pending-input", text_sha256: "a".repeat(64) };
        if (marker === "native-origin") Object.assign(state.authoritative_instructions.original_user_request, {
          origin: "native-confirmation", session_id: "native-session", session_entry_id: "native-input",
        });
        if (marker === "validation-status") {
          const input = { command: "npm test" };
          recordToolCall(state, "modern-validation", "bash", input);
          const receipt = updateToolResult(state, "modern-validation", "bash", input, false, "test summary", "Tests: 1 passed", normalizeConfig({}), { exitCode: 0 });
          assert.equal(receipt.validation_status, "passed");
        }
        assert.equal(isTaskStateV2(state), true);
        if (shape === "early") {
          delete state.advisor_state.automatic_reservations;
          delete state.advisor_state.automatic_trigger_ids;
        } else {
          delete state.advisor_state;
          delete state.id_counters.next_advisor_advice;
        }
        if (shape === "pre-checkpoint") {
          for (const field of ["context_epoch", "context_checkpoints", "active_checkpoint_id", "context_reset"]) delete state[field];
          delete state.id_counters.next_checkpoint;
        }
        const directory = join(cwd, ".pi", "tasks", state.task_id);
        mkdirSync(directory, { recursive: true });
        const bytes = JSON.stringify(state);
        writeFileSync(join(directory, "state.json"), bytes);
        const loaded = loadTaskStateWithRecovery(cwd, state.task_id);
        assert.equal(loaded.status, "recovery-required", "modern markers cannot be dropped by any historical recognizer");
        assert.equal(readFileSync(join(directory, "state.json"), "utf8"), bytes);
      } finally { rmSync(cwd, { recursive: true, force: true }); }
    });
  }
}

test("RF3 genuine early-advisor migration preserves consumed calls and usage", async () => {
  const { migrateTaskState } = await import("../src/state-migration.ts");
  const cwd = workspace();
  try {
    const state = createTaskState(cwd, "Preserve genuine historical spending", undefined, normalizeConfig({}));
    state.advisor_state.automatic_calls_used = 2;
    state.advisor_state.automatic_usage = { input_tokens: 200, output_tokens: 100, cost_usd: 0.1, unknown_usage_calls: 1 };
    delete state.advisor_state.automatic_reservations;
    delete state.advisor_state.automatic_trigger_ids;
    const migrated = migrateTaskState(state);
    assert.equal(isTaskStateV2(migrated), true);
    assert.equal(migrated.advisor_state.automatic_calls_used, 2);
    assert.deepEqual(migrated.advisor_state.automatic_usage, state.advisor_state.automatic_usage);
    assert.deepEqual(migrated.advisor_state.automatic_reservations, []);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("task persistence creates a task-local Git exclusion without touching repository ignores", () => {
  const cwd = workspace();
  try {
    const state = createTaskState(cwd, "Preserve task artifact privacy.", undefined, normalizeConfig({}));
    saveTaskState(state, "private-artifact-test");
    assert.equal(readFileSync(join(cwd, ".pi", "tasks", ".gitignore"), "utf8"), "*\n!.gitignore\n");
    assert.equal(existsSync(join(cwd, ".gitignore")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("task persistence rejects a symlinked task artifact ancestor", () => {
  const cwd = workspace();
  const outside = workspace();
  try {
    const state = createTaskState(cwd, "Reject unsafe task storage.", undefined, normalizeConfig({}));
    const configDir = join(cwd, ".pi");
    symlinkSync(outside, configDir, "dir");
    assert.throws(() => saveTaskState(state, "unsafe-artifact-test"), /symlink/i);
    assert.equal(existsSync(join(outside, ".gitignore")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("task persistence rejects a symlinked generated task directory", () => {
  const cwd = workspace();
  const outside = workspace();
  try {
    const state = createTaskState(cwd, "Reject unsafe task storage.", undefined, normalizeConfig({}));
    const tasksDir = join(cwd, ".pi", "tasks");
    mkdirSync(tasksDir, { recursive: true });
    symlinkSync(outside, join(tasksDir, state.task_id), "dir");
    assert.throws(() => saveTaskState(state, "unsafe-task-directory-test"), /symlink/i);
    assert.equal(existsSync(join(outside, "state.json")), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("invalid policy enum values produce visible conservative-fallback warnings", () => {
  const warnings = configNormalizationWarnings({
    profile: "unsafe",
    contextMode: "expanded",
    orchestrationMode: "automatic",
    supervisionMode: "unbounded",
    contextReset: { mode: "always", unsupportedTransport: "reset-now" },
    advisor: { dataScope: "all-data" },
  });
  assert.deepEqual(warnings, [
    "Ignored invalid .pi/reliability.json 'profile' value; using 'balanced'.",
    "Ignored invalid .pi/reliability.json 'contextMode' value; using 'compact'.",
    "Ignored invalid .pi/reliability.json 'orchestrationMode' value; using 'prompt'.",
    "Ignored invalid .pi/reliability.json 'supervisionMode' value; using 'adaptive'.",
    "Ignored invalid .pi/reliability.json 'contextReset.mode' value; using 'automatic'.",
    "Ignored invalid .pi/reliability.json 'contextReset.unsupportedTransport' value; using 'checkpoint-only'.",
    "Ignored invalid .pi/reliability.json 'advisor.dataScope' value; using 'disabled'.",
  ]);
});


for (const field of ["working_context", "coding_boundary", "dependency_evidence", "scope_state", "structured_output", "quality_gate", "context_reset", "advisor_state", "quality_gate.resolutions", "advisor_state.automatic_reservations", "id_counters.next_advisor_advice", "authoritative_instructions", "advisor_state.automatic_usage"]) {
  test(`RF1 A09 mixed modern v2 corruption of ${field} requires non-destructive recovery`, () => {
    const cwd = workspace();
    try {
      const state = createTaskState(cwd, "Preserve all modern requirements.", undefined, normalizeConfig({}));
      state.authoritative_instructions.corrections.push({ text: "Preserve this exact instruction", origin: "user-command", recorded_at: new Date().toISOString() });
      state.plan[0].exit_conditions = [{ kind: "observed-tool-result", description: "Observe validation before advancing" }];
      recordQualityGateClaim(state, { action: "record", gate: "final", criterion: state.criteria[0].id, status: "unknown", evidence: "Retain this model claim without promotion" });
      state.advisor_state.automatic_calls_used = 1;
      assert.equal(isTaskStateV2(state), true);
      const directory = join(cwd, ".pi", "tasks", state.task_id);
      mkdirSync(directory, { recursive: true });
      const keys = field.split(".");
      const container = keys.length === 2 ? state[keys[0]] : state;
      const key = keys.at(-1);
      if (field === "authoritative_instructions" || field === "advisor_state.automatic_usage") container[key] = { corrupt: true };
      else delete container[key];
      const bytes = JSON.stringify(state);
      writeFileSync(join(directory, "state.json"), bytes);
      const loaded = loadTaskStateWithRecovery(cwd, state.task_id);
      assert.equal(loaded.status, "recovery-required");
      assert.equal(readFileSync(join(directory, "state.json"), "utf8"), bytes);
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}
