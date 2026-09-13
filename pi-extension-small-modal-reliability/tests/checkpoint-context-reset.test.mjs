import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CHECKPOINT_REQUIRED_HEADINGS,
  canonicalCheckpointStateHash,
  checkpointSnapshotPointerHash,
  contextPressureCandidate,
  contextResetToolBlockReason,
  createContextResetCandidate,
  createTaskState,
  executeContextReset,
  evidencePackPath,
  expireUnusedScopeApprovalsAtContextReset,
  isTaskStateV2,
  migrateTaskState,
  normalizeConfig,
  queueContextReset,
  readCheckpointMarkdown,
  readCheckpointSnapshot,
  recordStableContextBoundary,
  renderCheckpoint,
  saveTaskState,
  sha256,
  validateCheckpoint,
  writeCheckpointMarkdown,
  writeCheckpointSnapshot,
} from "../src/core.ts";

function tempCwd() {
  return mkdtempSync(join(tmpdir(), "pi-checkpoint-test-"));
}

function cleanup(cwd) {
  rmSync(cwd, { recursive: true, force: true });
}

function initialState(cwd, goal = "Implement the bounded checkpoint protocol.", configInput = {}) {
  const config = normalizeConfig(configInput);
  const state = createTaskState(cwd, goal, undefined, config);
  state.current_phase = "implementation";
  state.next_action = "Implement the bounded checkpoint protocol.";
  saveTaskState(state, "test_initial_state");
  return { config, state };
}

function manualCandidate(state) {
  return createContextResetCandidate(state, {
    from_lane: "general",
    to_lane: "general",
    trigger: "manual-retry",
    gate_decision: "pass",
    turn_index: state.context_reset.turn_index,
  });
}

function persist(state) {
  return (reason) => saveTaskState(state, reason);
}

function writeRendered(state, rendered) {
  writeCheckpointSnapshot(state, rendered.snapshot);
  return writeCheckpointMarkdown(state, rendered.summary, rendered.markdown);
}

function bindTrustedTestSession(state) {
  state.current_session = {
    session_id: "simulated-session",
    branch_entry_ids: ["simulated-anchor"],
    observed_at: new Date().toISOString(),
    lifecycle_identity: "available",
  };
  state.task_identity.session_id = "simulated-session";
  state.task_identity.session_anchor_entry_id = "simulated-anchor";
  state.authoritative_instructions.original_user_request.session_id = "simulated-session";
  state.authoritative_instructions.original_user_request.session_entry_id = "simulated-anchor";
  state.current_session.input_authority_receipts = [{ entry_id: "simulated-anchor", task_id: state.task_id, origin: "user-command", text_sha256: sha256(state.authoritative_instructions.original_user_request.text) }];
  for (const correction of state.authoritative_instructions.corrections) {
    correction.session_id = "simulated-session";
    correction.session_entry_id = "simulated-anchor";
  }
  saveTaskState(state, "simulated_session_bound");
}

function matchingReceipt(request) {
  return {
    schema_version: 1,
    outcome: "reset-complete",
    request_id: request.request_id,
    task_id: request.task_id,
    checkpoint_id: request.checkpoint_id,
    session_id: request.session_id,
    branch_anchor_entry_id: request.branch_anchor_entry_id,
    from_epoch: request.from_epoch,
    to_epoch: request.to_epoch,
    from_lane: request.from_lane,
    to_lane: request.to_lane,
    phase_id: request.phase_id,
    checkpoint_sha256: request.checkpoint_sha256,
    canonical_state_sha256: request.canonical_state_sha256,
    scope_sha256: request.scope_sha256,
    evidence_packs: request.evidence_packs,
    unresolved_decision_count: request.unresolved_decision_count,
    next_action_sha256: request.next_action_sha256,
    continuation_seed_sha256: request.continuation_seed_sha256,
    continuation_manifest_sha256: request.continuation_manifest_sha256,
    provider_visible_manifest: request.continuation_manifest,
    provider_visible_manifest_sha256: sha256(request.continuation_manifest),
  };
}

function trustedSimulatedAdapter(overrides = {}) {
  return {
    async discover() {
      return {
        schema_version: 1,
        adapter_id: "simulated-test-adapter",
        provider_id: "simulated-provider",
        transport_id: "simulated-transport",
        session_id: "simulated-session",
        branch_anchor_entry_id: "simulated-anchor",
        can_reset_provider_continuation: true,
        can_restore_previous_epoch: true,
        transport_proof: "simulated",
        integration_origin: "test",
      };
    },
    async reset(request) {
      return overrides.reset?.(request) ?? matchingReceipt(request);
    },
    async restore(request) {
      return overrides.restore?.(request) ?? { restored: true, request_id: request.request_id };
    },
  };
}

test("renders atomic checkpoint Markdown from an immutable snapshot with all required sections", () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd);
    const rendered = renderCheckpoint(state, manualCandidate(state), config, new Date("2026-01-02T03:04:05.000Z"));
    const written = writeRendered(state, rendered);
    assert.equal(written.artifact_sha256, rendered.summary.artifact_sha256);
    assert.equal(canonicalCheckpointStateHash(state), rendered.summary.canonical_state_sha256);
    for (const heading of CHECKPOINT_REQUIRED_HEADINGS) assert.ok(rendered.markdown.includes(heading), heading);
    assert.ok(validateCheckpoint(state, rendered.summary, config).valid);
    assert.equal(readCheckpointMarkdown(state, rendered.summary), rendered.markdown);
  } finally {
    cleanup(cwd);
  }
});

test("retains all decisions and multiline authoritative content through immutable snapshot references", () => {
  const cwd = tempCwd();
  try {
    const original = "First line of original request.\nSecond line is authoritative.";
    const { config, state } = initialState(cwd, original);
    state.decisions = Array.from({ length: 30 }, (_, index) => `DECISION-${index + 1}: ${"x".repeat(1_200)}`);
    const rendered = renderCheckpoint(state, manualCandidate(state), config);
    writeRendered(state, rendered);
    assert.match(rendered.markdown, /All 30 decisions and rejected alternatives are retained by immutable snapshot reference/);
    assert.match(rendered.markdown, /First line of original request/);
    const snapshotBefore = readCheckpointSnapshot(state, rendered.summary);
    assert.equal(snapshotBefore.state.decisions[0].startsWith("DECISION-1"), true);
    state.decisions[0] = "MUTATED_CURRENT_STATE_DECISION";
    assert.equal(readCheckpointSnapshot(state, rendered.summary).state.decisions[0].startsWith("DECISION-1"), true);
    assert.equal(validateCheckpoint(state, rendered.summary, config).valid, false, "current canonical mutation invalidates a stale handoff");
  } finally {
    cleanup(cwd);
  }
});

test("secret-like content refuses a new checkpoint snapshot and retains context without durable credential copies", async () => {
  const cwd = tempCwd();
  try {
    const rawSecret = "token=super-secret-context-value";
    const { config, state } = initialState(cwd, `Implement safely with ${rawSecret}.`);
    assert.throws(() => renderCheckpoint(state, manualCandidate(state), config), /secret-like material/);
    const result = await executeContextReset(state, manualCandidate(state), config, { persist: persist(state) });
    assert.equal(result.outcome, "not-eligible");
    assert.equal(state.context_checkpoints.length, 0);
    assert.doesNotMatch(state.context_reset.last_reason ?? "", /super-secret-context-value/);
    const checkpointDirectory = join(cwd, ".pi", "tasks", state.task_id, "checkpoints");
    assert.deepEqual(existsSync(checkpointDirectory) ? readdirSync(checkpointDirectory) : [], [], "no checkpoint artifact is written for secret-like material");
  } finally {
    cleanup(cwd);
  }
});

test("validates every rendered immutable pointer against actual derived snapshot fields", () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd);
    state.files_touched = Array.from({ length: 30 }, (_, index) => `src/retained-${index + 1}.ts`);
    state.criteria = Array.from({ length: 30 }, (_, index) => ({ id: `criterion-${index + 1}`, requirement: `retain criterion ${index + 1}`, expected_evidence: "validation", required: true, origin: "user" }));
    const rendered = renderCheckpoint(state, manualCandidate(state), config);
    writeRendered(state, rendered);
    const snapshot = readCheckpointSnapshot(state, rendered.summary);
    assert.deepEqual(snapshot.state.files_and_artifacts, state.files_touched);
    assert.equal(snapshot.state.effective_validation.length, state.criteria.length + 2);
    const references = [...rendered.markdown.matchAll(/`([^`]+)#\/([^`]+)` \(SHA-256: `([a-f0-9]{64})`\)/g)];
    assert.ok(references.length >= 2, "large required sections use immutable pointers");
    for (const [, snapshotPath, pointer, expectedHash] of references) {
      assert.equal(snapshotPath, rendered.summary.snapshot_path);
      assert.equal(checkpointSnapshotPointerHash(snapshot, pointer), expectedHash, pointer);
    }
    assert.equal(validateCheckpoint(state, rendered.summary, config).valid, true);

    state.id_counters.next_checkpoint = 2;
    const invalid = renderCheckpoint(state, manualCandidate(state), config);
    writeCheckpointSnapshot(state, invalid.snapshot);
    const invalidMarkdown = invalid.markdown.replace("#/state/files_and_artifacts", "#/state/missing_files_and_artifacts");
    invalid.summary.artifact_sha256 = sha256(invalidMarkdown);
    writeCheckpointMarkdown(state, invalid.summary, invalidMarkdown);
    const failed = validateCheckpoint(state, invalid.summary, config);
    assert.equal(failed.valid, false);
    assert.match(failed.reasons.join(" "), /reference has no target/i);
  } finally {
    cleanup(cwd);
  }
});

test("seals material evidence content and receipt identity so later mutable pack edits cannot alter checkpoint recovery", () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd);
    const pack = {
      schema_version: 1,
      pack_id: "E1",
      task_id: state.task_id,
      branch_id: state.task_identity.branch_id,
      question: "What evidence is material?",
      requirements: ["Retain the cited material claim."],
      limits: { max_sources: 2, max_passages: 2, max_passages_per_source: 4, max_passage_chars: 400, max_claims: 2 },
      sources: [{ source_id: "S1", title: "Durable source", locator: "https://example.test/evidence", source_kind: "official-doc", retrieved_at: "2026-01-01T00:00:00.000Z", passages: [{ passage_id: "P1", text: "Original durable passage." }] }],
      claims: [{ claim_id: "C1", claim: "Original durable material finding.", material: true, support: [{ source_id: "S1", passage_ids: ["P1"] }], contradicts: [] }],
      dependencies: [],
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    };
    const packBytes = `${JSON.stringify(pack, null, 2)}\n`;
    writeFileSync(evidencePackPath(state, "E1", true), packBytes, "utf8");
    state.evidence_packs = [{
      pack_id: "E1",
      task_id: state.task_id,
      branch_id: state.task_identity.branch_id,
      question: pack.question,
      evidence_path: "evidence/E1.json",
      sha256: sha256(packBytes),
      source_count: 1,
      passage_count: 1,
      claim_count: 1,
      created_at: pack.created_at,
      updated_at: pack.updated_at,
    }];
    const rendered = renderCheckpoint(state, manualCandidate(state), config);
    writeRendered(state, rendered);
    assert.match(rendered.markdown, /Original durable material finding/);
    const sealed = readCheckpointSnapshot(state, rendered.summary);
    assert.equal(sealed.state.sealed_evidence_packs[0].pack.claims[0].claim, "Original durable material finding.");

    pack.claims[0].claim = "Mutated current E1 content must not rewrite the checkpoint.";
    writeFileSync(evidencePackPath(state, "E1"), `${JSON.stringify(pack, null, 2)}\n`, "utf8");
    assert.equal(validateCheckpoint(state, rendered.summary, config).valid, true, "checkpoint validation uses sealed evidence, not later mutable E1.json bytes");
  } finally {
    cleanup(cwd);
  }
});

test("queue ownership executes its own queued candidate once and unsupported transport remains checkpoint-only", async () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd);
    const candidate = manualCandidate(state);
    const queued = queueContextReset(state, candidate, config);
    assert.equal(queued.eligibility.eligible, true);
    const result = await executeContextReset(state, queued.candidate, config, { persist: persist(state) });
    assert.equal(result.outcome, "checkpoint-only");
    assert.equal(state.context_checkpoints.length, 1);
    assert.equal(state.context_checkpoints[0].status, "checkpoint-only");
    assert.equal(state.context_reset.cooldown_until_turn, undefined, "manual retry does not establish automatic cooldown");
  } finally {
    cleanup(cwd);
  }
});

test("pressure requires a recorded stable boundary, uses ratio units, and cannot clear a sticky recovery freeze", async () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd, "Implement pressure recovery.", { contextReset: { cooldownTurns: 0 } });
    state.lane = "coding";
    assert.equal(contextPressureCandidate(state, "pass", 0.35, 0), undefined);
    recordStableContextBoundary(state);
    const belowThreshold = contextPressureCandidate(state, "pass", 0.005, 0);
    assert.equal(belowThreshold?.context_usage_ratio, 0.005, "0.5 percent is 0.005 ratio, not 0.5");
    assert.equal(queueContextReset(state, belowThreshold, config).eligibility.eligible, false);
    const candidate = contextPressureCandidate(state, "pass", 0.35, 0);
    assert.ok(candidate);
    state.context_reset.status = "paused";
    state.context_reset.mutation_blocked = true;
    state.context_reset.freeze_reason = "receipt mismatch";
    const result = await executeContextReset(state, candidate, config, { persist: persist(state) });
    assert.equal(result.outcome, "recovery-required");
    assert.equal(state.context_reset.mutation_blocked, true);
    assert.match(contextResetToolBlockReason(state, "write") ?? "", /receipt mismatch/);
    assert.equal(contextResetToolBlockReason(state, "read"), undefined);
  } finally {
    cleanup(cwd);
  }
});

test("simulated trusted-host reset validates observed manifest, expires unused approvals, and retains request/receipt artifacts", async () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd);
    bindTrustedTestSession(state);
    const resetAt = new Date("2026-03-04T05:06:07.000Z");
    state.scope_state.approvals.push(
      { id: "A1", task_id: state.task_id, branch_id: state.task_identity.branch_id, tool_name: "bash", requested_normalized_effect: "bash:{unused}", description: "future-dated unused approval", reversible: true, scope_hash: sha256("scope"), status: "approved", requested_at: "2026-01-01T00:00:00.000Z", approved_at: "2026-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" },
      { id: "A2", task_id: state.task_id, branch_id: state.task_identity.branch_id, tool_name: "bash", requested_normalized_effect: "bash:{pending}", description: "pending request", reversible: true, scope_hash: sha256("scope"), status: "pending", requested_at: "2026-01-01T00:00:00.000Z" },
    );
    state.id_counters.next_approval = 3;
    // This test labels a fake out-of-band transport explicitly; runtime event-bus adapters cannot enter this path.
    const result = await executeContextReset(state, manualCandidate(state), config, {
      adapter: trustedSimulatedAdapter(),
      persist: persist(state),
      allowSimulatedTrustedHost: true,
      now: resetAt,
    });
    assert.equal(result.outcome, "reset-complete", result.reason);
    assert.equal(state.context_epoch, 1);
    assert.equal(state.context_reset.mutation_blocked, false);
    assert.equal(state.scope_state.approvals[0].status, "expired");
    assert.equal(state.scope_state.approvals[0].expires_at, resetAt.toISOString());
    assert.equal(state.scope_state.approvals[1].status, "pending");
    const checkpoint = state.context_checkpoints[0];
    assert.equal(checkpoint.status, "reset-complete");
    assert.ok(checkpoint.request_artifact_path && checkpoint.receipt_artifact_path);
    assert.equal(existsSync(join(cwd, ".pi", "tasks", state.task_id, checkpoint.request_artifact_path)), true);
    assert.equal(existsSync(join(cwd, ".pi", "tasks", state.task_id, checkpoint.receipt_artifact_path)), true);
  } finally {
    cleanup(cwd);
  }
});

test("simulated manifest mismatch freezes mutation, retains request/receipt/restore artifacts, and fallback cannot clear it", async () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd);
    bindTrustedTestSession(state);
    const adapter = trustedSimulatedAdapter({
      reset(request) {
        return { ...matchingReceipt(request), provider_visible_manifest: "tampered manifest", provider_visible_manifest_sha256: sha256("tampered manifest") };
      },
    });
    const result = await executeContextReset(state, manualCandidate(state), config, {
      adapter,
      persist: persist(state),
      allowSimulatedTrustedHost: true,
    });
    assert.equal(result.outcome, "recovery-required", result.reason);
    assert.equal(state.context_reset.mutation_blocked, true);
    assert.match(contextResetToolBlockReason(state, "write") ?? "", /manifest|paused|reset/i);
    const checkpoint = state.context_checkpoints[0];
    assert.equal(checkpoint.status, "recovery-required");
    for (const path of [checkpoint.request_artifact_path, checkpoint.receipt_artifact_path, checkpoint.restore_artifact_path]) {
      assert.ok(path && existsSync(join(cwd, ".pi", "tasks", state.task_id, path)));
    }
    const queued = queueContextReset(state, { ...manualCandidate(state), trigger: "context-pressure", context_usage_ratio: 0.9, stable_boundary_id: "irrelevant" }, config);
    assert.equal(queued.eligibility.eligible, false);
    assert.equal(state.context_reset.mutation_blocked, true);
  } finally {
    cleanup(cwd);
  }
});

test("automatic boundary ownership applies cooldown and one-reset-per-phase after checkpoint-only fallback", async () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd);
    state.lane = "agentic";
    const boundary = createContextResetCandidate(state, {
      from_lane: "retrieval",
      to_lane: "agentic",
      trigger: "phase-boundary",
      gate_decision: "pass",
      turn_index: 0,
    });
    const queued = queueContextReset(state, boundary, config);
    assert.equal(queued.eligibility.eligible, true);
    const competing = createContextResetCandidate(state, {
      from_lane: "agentic",
      to_lane: "coding",
      trigger: "phase-boundary",
      gate_decision: "pass",
      turn_index: 0,
    });
    assert.equal(queueContextReset(state, competing, config).candidate.phase_id, boundary.phase_id, "a later trigger cannot replace the queue owner");
    assert.equal((await executeContextReset(state, queued.candidate, config, { persist: persist(state) })).outcome, "checkpoint-only");
    assert.equal(state.context_reset.cooldown_until_turn, config.contextReset.cooldownTurns);
    const afterCooldown = createContextResetCandidate(state, {
      from_lane: "retrieval",
      to_lane: "agentic",
      trigger: "phase-boundary",
      gate_decision: "pass",
      turn_index: config.contextReset.cooldownTurns,
    });
    assert.equal(queueContextReset(state, afterCooldown, config).eligibility.eligible, false, "epoch-independent phase identity retains one automatic reset cap");
  } finally {
    cleanup(cwd);
  }
});

test("oversize recovery seed remains checkpoint-only rather than instructing an inaccessible runtime snapshot read", async () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd, "Preserve compact seed content.", { contextReset: { maxContinuationSeedChars: 4_000 } });
    state.decisions = Array.from({ length: 20 }, (_, index) => `RETENTION-${index + 1}: ${"d".repeat(850)}`);
    const rendered = renderCheckpoint(state, manualCandidate(state), config);
    assert.ok(rendered.markdown.length > config.contextReset.maxContinuationSeedChars * 2);
    assert.equal(rendered.continuation_seed_available, false);
    assert.equal(rendered.continuation_seed, "");
    assert.doesNotMatch(rendered.markdown, /Required first action: read the immutable snapshot/);
    const result = await executeContextReset(state, manualCandidate(state), config, { persist: persist(state) });
    assert.equal(result.outcome, "checkpoint-only");
    assert.match(result.reason, /inaccessible runtime-owned snapshot read/);
  } finally {
    cleanup(cwd);
  }
});

test("context reset refuses no-op durability and bounds an unresponsive discovery stage", async () => {
  const cwd = tempCwd();
  try {
    const { config, state } = initialState(cwd, "Verify durable reset.", { contextReset: { adapterTimeoutMs: 100 } });
    let resetCalled = false;
    const noOp = await executeContextReset(state, manualCandidate(state), config, {
      persist() {},
      adapter: trustedSimulatedAdapter({ reset() { resetCalled = true; throw new Error("must not run"); } }),
      allowSimulatedTrustedHost: true,
    });
    assert.equal(noOp.outcome, "recovery-required");
    assert.equal(resetCalled, false);

    const { state: timeoutState } = initialState(tempCwd(), "Bound adapter discovery.", { contextReset: { adapterTimeoutMs: 100 } });
    const started = Date.now();
    const timeout = await executeContextReset(timeoutState, manualCandidate(timeoutState), config, {
      persist: persist(timeoutState),
      adapter: { discover: () => new Promise(() => {}), reset: async () => { throw new Error("not reached"); }, restore: async () => ({ restored: false, request_id: "none" }) },
    });
    assert.equal(timeout.outcome, "checkpoint-only");
    assert.ok(Date.now() - started < 1_000, "unresponsive discovery is bounded by adapter timeout");
    cleanup(timeoutState.cwd);
  } finally {
    cleanup(cwd);
  }
});

test("reset transition expires all unused approvals but preserves pending requests", () => {
  const cwd = tempCwd();
  try {
    const { state } = initialState(cwd);
    state.scope_state.approvals.push(
      { id: "A1", task_id: state.task_id, branch_id: state.task_identity.branch_id, tool_name: "bash", requested_normalized_effect: "bash:{}", description: "unused", reversible: true, scope_hash: "scope", status: "approved", requested_at: "2026-01-01T00:00:00.000Z", expires_at: "2099-01-01T00:00:00.000Z" },
      { id: "A2", task_id: state.task_id, branch_id: state.task_identity.branch_id, tool_name: "bash", requested_normalized_effect: "bash:{pending}", description: "pending", reversible: true, scope_hash: "scope", status: "pending", requested_at: "2026-01-01T00:00:00.000Z" },
    );
    assert.deepEqual(expireUnusedScopeApprovalsAtContextReset(state, new Date("2026-01-02T00:00:00.000Z")), ["A1"]);
    assert.equal(state.scope_state.approvals[0].status, "expired");
    assert.equal(state.scope_state.approvals[1].status, "pending");
  } finally {
    cleanup(cwd);
  }
});

test("migration initializes checkpoint/reset state and a failed handshake guard blocks mutation only", () => {
  const cwd = tempCwd();
  try {
    const { state } = initialState(cwd);
    const prior = JSON.parse(JSON.stringify(state));
    delete prior.advisor_state;
    delete prior.id_counters.next_advisor_advice;
    delete prior.context_epoch;
    delete prior.context_checkpoints;
    delete prior.active_checkpoint_id;
    delete prior.context_reset;
    delete prior.id_counters.next_checkpoint;
    const migrated = migrateTaskState(prior);
    assert.ok(migrated);
    assert.ok(isTaskStateV2(migrated));
    assert.equal(migrated.context_epoch, 0);
    migrated.context_reset.status = "paused";
    migrated.context_reset.mutation_blocked = true;
    migrated.context_reset.freeze_reason = "receipt mismatch";
    assert.match(contextResetToolBlockReason(migrated, "write") ?? "", /receipt mismatch/);
    assert.equal(contextResetToolBlockReason(migrated, "read"), undefined);
  } finally {
    cleanup(cwd);
  }
});

test("RF2b reset timeout, late completion and failed restore have no live recovery authority", async () => {
  const cwd = tempCwd();
  let completeLate;
  try {
    const { config, state } = initialState(cwd, "Retain unknown provider state", { contextReset: { adapterTimeoutMs: 100 } });
    bindTrustedTestSession(state);
    let request;
    const adapter = trustedSimulatedAdapter({
      reset(value) { request = value; return new Promise(resolve => { completeLate = resolve; }); },
      async restore(value) { return { restored: false, request_id: value.request_id, reason: "simulated failed restore" }; },
    });
    const result = await executeContextReset(state, manualCandidate(state), config, { persist: persist(state), adapter, allowSimulatedTrustedHost: true });
    assert.equal(result.outcome, "recovery-required");
    completeLate(matchingReceipt(request));
    await new Promise(resolve => setTimeout(resolve, 10));
    const { recoverLivePreTransformCheckpoint } = await import("../src/context-reset-coordinator.ts");
    assert.throws(() => recoverLivePreTransformCheckpoint(state, result.checkpoint.checkpoint_id, config, { persist: persist(state), currentSession: () => state.current_session }), /live.*witness/);
    assert.equal(state.context_reset.mutation_blocked, true);
    assert.equal(state.context_epoch, 0);
  } finally { cleanup(cwd); }
});
