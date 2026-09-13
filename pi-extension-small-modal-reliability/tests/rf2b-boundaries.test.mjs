import assert from "node:assert/strict";
import { mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTaskState, saveTaskState, loadTaskState } from "../src/task-state.ts";
import { normalizeConfig } from "../src/config.ts";
import { createContextResetCandidate } from "../src/checkpoint-contracts.ts";
import * as coordinator from "../src/context-reset-coordinator.ts";
import * as plan from "../src/plan-mode.ts";
import { inputTextHash } from "../src/input-authority.ts";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "rf2b-"));
  const config = normalizeConfig({});
  const state = createTaskState(cwd, "Review the design", undefined, config);
  state.current_session = { session_id: "native", branch_entry_ids: ["anchor"], lifecycle_identity: "available", observed_at: new Date().toISOString() };
  state.task_identity.session_id = "native";
  state.task_identity.session_anchor_entry_id = "anchor";
  Object.assign(state.authoritative_instructions.original_user_request, { session_id: "native", session_entry_id: "anchor" });
  state.current_session.input_authority_receipts = [{ entry_id: "anchor", task_id: state.task_id, origin: "user-command", text_sha256: inputTextHash(state.user_goal) }];
  state.next_action = "Review the design";
  saveTaskState(state, "fixture");
  return { cwd, config, state, close: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("RF2b live pre-transform recovery requires observed save and reread, never a reloaded witness", async () => {
  const f = fixture();
  try {
    const candidate = createContextResetCandidate(f.state, { from_lane: "general", to_lane: "general", trigger: "manual-retry", gate_decision: "pass" });
    let transforms = 0;
    const result = await coordinator.executeContextReset(f.state, candidate, f.config, { persist() {}, adapter: { discover() { transforms++; throw new Error("unexpected discovery"); } } });
    assert.equal(result.outcome, "recovery-required");
    assert.equal(transforms, 0);
    const recover = (state, persist) => coordinator.recoverLivePreTransformCheckpoint(state, result.checkpoint.checkpoint_id, f.config, { persist, currentSession: () => f.state.current_session });
    assert.throws(() => recover(f.state, () => {}), /durab|persist|transition/i);
    assert.equal(f.state.context_reset.mutation_blocked, true);
    recover(f.state, reason => saveTaskState(f.state, reason));
    assert.equal(f.state.context_reset.mutation_blocked, false);
    assert.equal(loadTaskState(f.cwd, f.state.task_id).context_reset.mutation_blocked, false);
    assert.equal(f.state.context_epoch, 0);
    assert.throws(() => recover(loadTaskState(f.cwd, f.state.task_id), () => {}), /live|witness/i);
  } finally { f.close(); }
});

test("RF2b Markdown slots reject stale writes, wrong phase/run, arbitrary paths and symlinks", () => {
  const f = fixture();
  try {
    const run = plan.createPlanModeRun(f.state);
    const input = { run_id: run.run_id, phase: "explore", slot: "exploration" };
    const before = plan.readPlanModeArtifact(f.state, run, input);
    const content = "# Exploration\nStatus: COMPLETE\n" + "Untrusted facts and remaining questions. ".repeat(4);
    plan.writePlanModeArtifact(f.state, run, { ...input, expected_sha256: before.sha256, content });
    assert.throws(() => plan.writePlanModeArtifact(f.state, run, { ...input, expected_sha256: before.sha256, content }), /stale/i);
    for (const bad of [{ slot: "../state.json" }, { phase: "verify" }, { run_id: "other" }, { path: "state.json" }]) {
      assert.throws(() => plan.readPlanModeArtifact(f.state, run, { ...input, ...bad }));
    }
    const current = plan.readPlanModeArtifact(f.state, run, input);
    assert.throws(() => plan.writePlanModeArtifact(f.state, run, { ...input, expected_sha256: current.sha256, content: "é".repeat(17_000) }), /bounded/);
    for (const failure_index of [0, 13]) assert.throws(() => plan.readPlanModeArtifact(f.state, run, { ...input, slot: "failure", failure_index }), /index/);
    const foreign = structuredClone(f.state);
    foreign.current_session.branch_entry_ids = [];
    assert.throws(() => plan.readPlanModeArtifact(foreign, run, input), /anchors/);
    rmSync(run.artifacts.exploration);
    symlinkSync(join(f.cwd, "elsewhere"), run.artifacts.exploration);
    assert.throws(() => plan.readPlanModeArtifact(f.state, run, input), /symlink/i);
    rmSync(run.artifacts.exploration);
    const moved = `${run.artifacts.dir}-moved`;
    renameSync(run.artifacts.dir, moved);
    symlinkSync(moved, run.artifacts.dir);
    assert.throws(() => plan.readPlanModeArtifact(f.state, run, input), /symlink/i);
  } finally { f.close(); }
});
