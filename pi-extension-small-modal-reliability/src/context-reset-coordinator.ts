import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { expireUnusedScopeApprovalsAtContextReset } from "./approval-state.ts";
import {
  candidateIdentity,
  checkpointSidecarDisplayPath,
  CheckpointSnapshotPrivacyError,
  createCheckpointSnapshot,
  createContextResetCandidate,
  findAvailableCheckpointSequence,
  phaseIdForContextReset,
  readCheckpointSnapshot,
  sha256,
  stableBoundaryIdForContextReset,
  writeCheckpointMarkdown,
  writeCheckpointSidecar,
  writeCheckpointSnapshot,
} from "./checkpoint-contracts.ts";
import { renderCheckpointSnapshot, type RenderedCheckpoint } from "./checkpoint-renderer.ts";
import { validateCheckpoint } from "./checkpoint-validator.ts";
import { loadTaskState } from "./task-state.ts";
import type {
  ContextCheckpointSummary,
  ContextCuratorCapability,
  ContextResetCandidate,
  ContextResetReceipt,
  ContextResetRequest,
  ReliabilityConfig,
  TaskState,
  WorkflowLane,
} from "./types.ts";
import { stableStringify } from "./utils.ts";
import { captureWorkspaceRevision, revisionsMatch, workspaceBranchIdentity } from "./workspace-revision.ts";
import type { SessionBranchIdentity } from "./types.ts";

// Object identity is the live process witness. No persisted field can recreate it.
const livePreTransformFailures = new WeakMap<TaskState, { checkpointId: string; summaryHash: string; epoch: number; session: SessionBranchIdentity; workspaceObservedAt: string }>();

export function invalidateLiveCheckpointRecovery(state: TaskState): void {
  livePreTransformFailures.delete(state);
}

export function freezeReloadedCheckpoint(state: TaskState): void {
  invalidateLiveCheckpointRecovery(state);
  if (state.context_reset.mutation_blocked || ["queued", "rendering", "validated", "resetting", "verifying"].includes(state.context_reset.status)) {
    state.context_reset.mutation_blocked = true;
    state.context_reset.status = "paused";
    state.context_reset.freeze_reason = "Reloaded or interrupted checkpoint has no live pre-transform witness; recovery remains blocked.";
  }
}

/** Native confirmation is supplied by the command owner, never by a model or persisted boolean. */
export function recoverLivePreTransformCheckpoint(state: TaskState, checkpointId: string, config: ReliabilityConfig, options: {
  persist: ContextResetPersistence;
  loadPersisted?: () => TaskState | undefined;
  currentSession: () => SessionBranchIdentity;
}): void {
  const witness = livePreTransformFailures.get(state);
  if (!witness || witness.checkpointId !== checkpointId || !state.context_reset.mutation_blocked) throw new Error("No matching live pre-transform recovery witness.");
  const check = () => {
    const session = options.currentSession();
    if (session.lifecycle_identity !== "available" || !session.session_id || session.session_id !== witness.session.session_id
      || state.task_identity.session_id !== session.session_id
      || !state.task_identity.session_anchor_entry_id || !session.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id)
      || witness.session.branch_entry_ids.some((id, index) => session.branch_entry_ids[index] !== id)) throw new Error("Recovery session or branch binding changed.");
    for (const key of ["input_authority_receipts", "evidence_revision_receipts", "output_contract_receipts", "output_validation_receipts", "quality_gate_resolution_receipts", "scope_authorization_receipts", "scope_approval_receipts"] as const) {
      const current = session[key] ?? [];
      if (witness.session[key]?.some(receipt => !current.some(item => stableStringify(item) === stableStringify(receipt)))) throw new Error("Recovery native authority receipt changed or disappeared.");
    }
    const summary = checkpointInCurrentState(state, checkpointId);
    if (state.context_epoch !== witness.epoch || sha256(stableStringify(JSON.parse(JSON.stringify(summary)))) !== witness.summaryHash) throw new Error("Recovery checkpoint identity or epoch changed.");
    const revision = captureWorkspaceRevision(state.cwd);
    if (!revisionsMatch(revision, state.workspace_revision) || workspaceBranchIdentity(state.cwd, revision) !== state.task_identity.branch_id) throw new Error("Recovery workspace or branch changed.");
    // UI/scratchpad probes refresh this diagnostic timestamp even while frozen.
    // Revision content is independently checked above; all other sealed fields must still match.
    const validationState = { ...state, workspace_revision: { ...state.workspace_revision, observed_at: witness.workspaceObservedAt } };
    const validation = validateCheckpoint(validationState, summary, config);
    if (!validation.valid) throw new Error(`Recovery checkpoint is invalid: ${validation.reasons.join(" ")}`);
  };
  check();
  const frozen = structuredClone(state.context_reset);
  const transition = { ...frozen, status: "skipped" as const, mutation_blocked: false, freeze_reason: undefined, freeze_request_id: undefined,
    last_reason: `Live pre-transform durability recovered for ${checkpointId}; provider context retained. Transition ${randomUUID()}.` };
  // The synchronous persistence callback cannot dispatch tools. The live latch is restored before any error escapes.
  try {
    state.context_reset = transition;
    options.persist("context_checkpoint_live_recovery");
    const persisted = options.loadPersisted?.() ?? loadTaskState(state.cwd, state.task_id);
    // Scratchpad rendering after save may refresh only the workspace observation timestamp.
    const comparable = persisted && { ...state, workspace_revision: { ...state.workspace_revision, observed_at: persisted.workspace_revision.observed_at } };
    if (!persisted || stableStringify(JSON.parse(JSON.stringify(persisted.context_reset))) !== stableStringify(JSON.parse(JSON.stringify(transition)))
      || stableStringify(JSON.parse(JSON.stringify(persisted))) !== stableStringify(JSON.parse(JSON.stringify(comparable)))) throw new Error("Recovery transition persistence was not durably observed after save and reread.");
    Object.assign(state, persisted);
    check();
    livePreTransformFailures.delete(state);
  } catch (error) {
    state.context_reset = frozen;
    throw error;
  }
}

const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "brave_search", "web_search", "fetch_content", "reliability_status"]);
const EXPLORATION_TOOLS = new Set(["grep", "find", "ls", "brave_search", "web_search", "fetch_content"]);
const SEMANTIC_TRANSITIONS: Record<WorkflowLane, ReadonlySet<string>> = {
  retrieval: new Set(["agentic", "coding", "structured-output", "general", "planning", "review", "final"]),
  agentic: new Set(["coding", "structured-output", "general", "review", "final"]),
  coding: new Set(["structured-output", "general", "review", "final"]),
  "structured-output": new Set(["general", "review", "final"]),
  general: new Set(),
};

export type ContextCuratorAdapter = {
  discover(signal?: AbortSignal): Promise<ContextCuratorCapability | undefined>;
  reset(request: ContextResetRequest, signal?: AbortSignal): Promise<ContextResetReceipt>;
  restore(request: ContextResetRequest, signal?: AbortSignal): Promise<{ restored: boolean; request_id: string; reason?: string }>;
};

export type ContextResetPersistence = (reason: string) => void;

export type ContextResetRunOptions = {
  adapter?: ContextCuratorAdapter;
  /** Required durability boundary. A missing/no-op persist blocks provider transformation. */
  persist: ContextResetPersistence;
  loadPersisted?: () => TaskState | undefined;
  signal?: AbortSignal;
  now?: Date;
  automaticEnabled?: boolean;
  /** Test-only escape hatch for contract-faithful fake transports; never supplied by runtime wiring. */
  allowSimulatedTrustedHost?: boolean;
};

export type ContextResetRunResult = {
  outcome: "not-eligible" | "checkpoint-only" | "reset-complete" | "invalid" | "recovery-required";
  reason: string;
  checkpoint?: ContextCheckpointSummary;
};

export type ContextResetEligibility = {
  eligible: boolean;
  reason?: string;
  hard_pressure: boolean;
};

function isDecisionOnlyNextAction(value: string): boolean {
  return /^(ask|await|obtain|request|resolve|confirm)\b/i.test(value.trim());
}

function automaticCheckpointCount(state: TaskState, phaseId: string): number {
  return state.context_checkpoints.filter((checkpoint) => checkpoint.phase_id === phaseId
    && checkpoint.trigger !== "manual-retry"
    && (checkpoint.status === "checkpoint-only" || checkpoint.status === "reset-complete")).length;
}

function candidateIsSemanticBoundary(candidate: ContextResetCandidate): boolean {
  return candidate.from_lane !== candidate.to_lane && SEMANTIC_TRANSITIONS[candidate.from_lane].has(candidate.to_lane);
}

function queuedByCandidate(state: TaskState, candidate: ContextResetCandidate): boolean {
  return state.context_reset.status === "queued" && state.context_reset.pending_candidate !== undefined
    && candidateIdentity(state.context_reset.pending_candidate) === candidateIdentity(candidate);
}

export function evaluateContextResetEligibility(
  state: TaskState,
  candidate: ContextResetCandidate,
  config: ReliabilityConfig,
  automaticEnabled = true,
): ContextResetEligibility {
  const hardPressure = (candidate.context_usage_ratio ?? 0) >= config.contextReset.hardContextUsageRatio;
  if (state.context_reset.mutation_blocked) return { eligible: false, reason: state.context_reset.freeze_reason ?? "Context reset recovery is frozen pending verified resume.", hard_pressure: hardPressure };
  if (candidate.next_action !== state.next_action) return { eligible: false, reason: "Candidate next action no longer matches canonical task state.", hard_pressure: hardPressure };
  if (candidate.gate_decision === "fail") return { eligible: false, reason: "The outgoing lane gate failed.", hard_pressure: hardPressure };
  if (candidate.gate_decision === "escalate" && !isDecisionOnlyNextAction(candidate.next_action)) return { eligible: false, reason: "An escalated handoff must have a decision-only next action.", hard_pressure: hardPressure };
  if (state.pending_tool_calls.length > 0) return { eligible: false, reason: "A tool call or parallel result batch remains unresolved.", hard_pressure: hardPressure };
  if (candidate.trigger === "phase-boundary") {
    if (!config.contextReset.phaseBoundaries || config.contextReset.mode !== "automatic" || !automaticEnabled) return { eligible: false, reason: "Automatic phase-boundary checkpointing is disabled for this session.", hard_pressure: hardPressure };
    if (!candidateIsSemanticBoundary(candidate)) return { eligible: false, reason: "The lane change is not an eligible semantic boundary.", hard_pressure: hardPressure };
  }
  if (candidate.trigger === "context-pressure") {
    if (config.contextReset.mode !== "automatic" || !automaticEnabled) return { eligible: false, reason: "Automatic context-pressure checkpointing is disabled for this session.", hard_pressure: hardPressure };
    const tokenPressure = (candidate.estimated_transient_tokens ?? 0) >= config.contextReset.eligibleTransientTokens;
    const ratioPressure = (candidate.context_usage_ratio ?? 0) >= config.contextReset.contextUsageRatio;
    if (!tokenPressure && !ratioPressure) return { eligible: false, reason: "Context pressure has not reached an approved threshold.", hard_pressure: hardPressure };
    const expectedBoundary = stableBoundaryIdForContextReset(state);
    if (!candidate.stable_boundary_id || state.context_reset.stable_boundary_id !== expectedBoundary || candidate.stable_boundary_id !== expectedBoundary) {
      return { eligible: false, reason: "Context pressure requires a lifecycle-recorded stable subphase boundary.", hard_pressure: hardPressure };
    }
  }
  if (candidate.trigger !== "manual-retry" && state.context_reset.cooldown_until_turn !== undefined && candidate.turn_index < state.context_reset.cooldown_until_turn) {
    return { eligible: false, reason: "Context reset cooldown is still active.", hard_pressure: hardPressure };
  }
  if (candidate.trigger !== "manual-retry" && automaticCheckpointCount(state, candidate.phase_id) >= config.contextReset.maxAutomaticResetsPerPhase) {
    return { eligible: false, reason: "This phase already reached its automatic reset limit.", hard_pressure: hardPressure };
  }
  if (candidate.trigger !== "manual-retry" && state.context_reset.status === "paused" && state.context_reset.repair_attempts >= 2) {
    return { eligible: false, reason: "Automatic checkpoint repair is paused after two failures for this phase.", hard_pressure: hardPressure };
  }
  if (["queued", "rendering", "validated", "resetting", "verifying"].includes(state.context_reset.status) && !queuedByCandidate(state, candidate)) {
    return { eligible: false, reason: "A different checkpoint/reset attempt is already pending.", hard_pressure: hardPressure };
  }
  if (state.context_checkpoints.some((checkpoint) => checkpoint.phase_id === candidate.phase_id
    && checkpoint.trigger === candidate.trigger
    && (checkpoint.status === "validated" || checkpoint.status === "checkpoint-only" || checkpoint.status === "reset-complete"))) {
    return { eligible: false, reason: "A matching checkpoint has already been recorded for this phase.", hard_pressure: hardPressure };
  }
  return { eligible: true, hard_pressure: hardPressure };
}

/** Queues one owner candidate without allowing a later automatic trigger to replace it. */
export function queueContextReset(
  state: TaskState,
  input: Omit<ContextResetCandidate, "phase_id" | "next_action" | "turn_index"> & { phase_id?: string; next_action?: string; turn_index?: number },
  config: ReliabilityConfig,
  automaticEnabled = true,
): { candidate: ContextResetCandidate; eligibility: ContextResetEligibility } {
  const candidate = createContextResetCandidate(state, input);
  if (state.context_reset.mutation_blocked) return { candidate, eligibility: { eligible: false, reason: state.context_reset.freeze_reason ?? "Context reset recovery is frozen pending verified resume.", hard_pressure: false } };
  if (["queued", "rendering", "validated", "resetting", "verifying"].includes(state.context_reset.status) && state.context_reset.pending_candidate) {
    if (queuedByCandidate(state, candidate)) return { candidate, eligibility: { eligible: true, hard_pressure: false } };
    return { candidate: state.context_reset.pending_candidate, eligibility: { eligible: false, reason: "A different checkpoint/reset attempt already owns this queue.", hard_pressure: false } };
  }
  const eligibility = evaluateContextResetEligibility(state, candidate, config, automaticEnabled);
  if (!eligibility.eligible) {
    if (!state.context_reset.mutation_blocked) {
      state.context_reset.phase_id = candidate.phase_id;
      state.context_reset.last_attempt_at = new Date().toISOString();
      state.context_reset.pending_candidate = candidate;
      state.context_reset.status = eligibility.hard_pressure ? "paused" : "skipped";
      state.context_reset.last_reason = eligibility.hard_pressure ? `Hard context pressure: ${eligibility.reason ?? "checkpointing is blocked"}` : eligibility.reason;
    }
    return { candidate, eligibility };
  }
  state.context_reset.phase_id = candidate.phase_id;
  state.context_reset.last_attempt_at = new Date().toISOString();
  state.context_reset.pending_candidate = candidate;
  state.context_reset.status = "queued";
  state.context_reset.last_reason = undefined;
  return { candidate, eligibility };
}

function unresolvedDecisionCount(state: TaskState): number {
  return state.open_questions.length
    + state.quality_gate.escalations.filter((item) => item.status === "pending").length
    + state.scope_state.pending_scope_changes.filter((item) => item.status === "pending").length
    + state.scope_state.approvals.filter((item) => item.status === "pending").length;
}

function requestFor(state: TaskState, rendered: RenderedCheckpoint): ContextResetRequest | undefined {
  const summary = rendered.summary;
  const session = state.current_session;
  const sessionId = session.session_id;
  const branchAnchor = session.branch_entry_ids.at(-1);
  if (session.lifecycle_identity !== "available" || !sessionId || !branchAnchor || !summary.snapshot_path || !summary.snapshot_sha256
    || state.task_identity.session_id !== sessionId
    || (state.task_identity.session_anchor_entry_id && !session.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id))) return undefined;
  return {
    schema_version: 1,
    request_id: `CR${randomUUID()}`,
    task_id: state.task_id,
    checkpoint_id: summary.checkpoint_id,
    session_id: sessionId,
    branch_anchor_entry_id: branchAnchor,
    from_epoch: summary.context_epoch_before,
    to_epoch: summary.context_epoch_before + 1,
    from_lane: summary.from_lane,
    to_lane: summary.to_lane,
    phase_id: summary.phase_id,
    checkpoint_path: resolve(state.cwd, ".pi", "tasks", state.task_id, summary.artifact_path),
    checkpoint_sha256: summary.artifact_sha256,
    snapshot_path: resolve(state.cwd, ".pi", "tasks", state.task_id, summary.snapshot_path),
    snapshot_sha256: summary.snapshot_sha256,
    canonical_state_sha256: summary.canonical_state_sha256,
    scope_sha256: summary.scope_sha256,
    evidence_packs: summary.evidence_packs.map((pack) => ({ ...pack })),
    unresolved_decision_count: unresolvedDecisionCount(state),
    next_action_sha256: sha256(rendered.snapshot.candidate.next_action),
    continuation_seed_sha256: rendered.continuation_seed_sha256,
    continuation_seed: rendered.continuation_seed,
    continuation_manifest: rendered.continuation_manifest,
    continuation_manifest_sha256: rendered.continuation_manifest_sha256,
  };
}

function capabilitySupportsReset(capability: ContextCuratorCapability | undefined, request: ContextResetRequest | undefined, options: ContextResetRunOptions): boolean {
  if (!capability || !request || capability.schema_version !== 1 || !capability.can_reset_provider_continuation || !capability.can_restore_previous_epoch
    || capability.session_id !== request.session_id || capability.branch_anchor_entry_id !== request.branch_anchor_entry_id) return false;
  if (capability.integration_origin === "trusted-host" && capability.transport_proof === "real-provider-reset-v1") return true;
  return options.allowSimulatedTrustedHost === true && capability.integration_origin === "test" && capability.transport_proof === "simulated";
}

function receiptMatches(request: ContextResetRequest, receipt: ContextResetReceipt): string | undefined {
  if (receipt.schema_version !== 1 || receipt.outcome !== "reset-complete") return "Adapter did not return a reset-complete receipt.";
  const scalarKeys: Array<keyof Pick<ContextResetRequest, "request_id" | "task_id" | "checkpoint_id" | "session_id" | "branch_anchor_entry_id" | "from_epoch" | "to_epoch" | "from_lane" | "to_lane" | "phase_id" | "checkpoint_sha256" | "canonical_state_sha256" | "unresolved_decision_count" | "next_action_sha256" | "continuation_seed_sha256" | "continuation_manifest_sha256">> = [
    "request_id", "task_id", "checkpoint_id", "session_id", "branch_anchor_entry_id", "from_epoch", "to_epoch", "from_lane", "to_lane", "phase_id", "checkpoint_sha256", "canonical_state_sha256", "unresolved_decision_count", "next_action_sha256", "continuation_seed_sha256", "continuation_manifest_sha256",
  ];
  for (const key of scalarKeys) if (receipt[key] !== request[key]) return `Adapter receipt does not match request field ${key}.`;
  if (receipt.scope_sha256 !== request.scope_sha256) return "Adapter receipt does not match the scope hash.";
  if (JSON.stringify(receipt.evidence_packs) !== JSON.stringify(request.evidence_packs)) return "Adapter receipt does not match evidence pack hashes.";
  if (!receipt.provider_visible_manifest || sha256(receipt.provider_visible_manifest) !== request.continuation_manifest_sha256
    || receipt.provider_visible_manifest !== request.continuation_manifest
    || receipt.provider_visible_manifest_sha256 !== sha256(receipt.provider_visible_manifest)) {
    return "Adapter receipt does not contain the exact observed provider-visible continuation manifest.";
  }
  return undefined;
}

function checkpointInCurrentState(state: TaskState, checkpointId: string): ContextCheckpointSummary {
  const summary = state.context_checkpoints.find((item) => item.checkpoint_id === checkpointId);
  if (!summary) throw new Error(`Durable checkpoint ${checkpointId} disappeared from task state.`);
  return summary;
}

function postResetValidationState(persisted: TaskState, summary: ContextCheckpointSummary, config: ReliabilityConfig, resetAt: Date): TaskState {
  const snapshot = readCheckpointSnapshot(persisted, summary);
  const before = snapshot.state.scope_state.approvals;
  const after = persisted.scope_state.approvals;
  if (before.length !== after.length) throw new Error("Post-reset approval transition changed the approval set.");
  for (let index = 0; index < before.length; index += 1) {
    const prior = before[index];
    const current = after[index];
    if (!current || prior.id !== current.id) throw new Error("Post-reset approval transition changed approval identity or ordering.");
    const { status: _priorStatus, expires_at: _priorExpiry, ...priorRest } = prior;
    const { status: _currentStatus, expires_at: _currentExpiry, ...currentRest } = current;
    if (stableStringify(priorRest) !== stableStringify(currentRest)) throw new Error(`Post-reset approval ${prior.id} changed fields outside the allowed expiry transition.`);
    if (config.contextReset.expireUnusedApprovals && prior.status === "approved") {
      if (current.status !== "expired" || current.expires_at !== resetAt.toISOString()) throw new Error(`Post-reset approval ${prior.id} was not durably expired at the reset boundary.`);
    } else if (prior.status !== current.status || prior.expires_at !== current.expires_at) {
      throw new Error(`Post-reset approval ${prior.id} changed without an allowed reset-expiry transition.`);
    }
  }
  // The reset epoch and approved->expired transitions are the only canonical
  // changes permitted after the immutable pre-reset checkpoint was validated.
  return {
    ...persisted,
    context_epoch: summary.context_epoch_before,
    scope_state: { ...persisted.scope_state, approvals: JSON.parse(JSON.stringify(before)) },
  };
}

function persistAndReopen(state: TaskState, reason: string, checkpointId: string, config: ReliabilityConfig, options: ContextResetRunOptions, postResetEpoch = false, resetAt = options.now ?? new Date()): ContextCheckpointSummary {
  options.persist(reason);
  const persisted = options.loadPersisted?.() ?? loadTaskState(state.cwd, state.task_id);
  if (!persisted) throw new Error("Checkpoint state persistence was not observed after save.");
  const summary = checkpointInCurrentState(persisted, checkpointId);
  const validationState = postResetEpoch ? postResetValidationState(persisted, summary, config, resetAt) : persisted;
  const validation = validateCheckpoint(validationState, summary, config);
  if (!validation.valid) throw new Error(`Persisted checkpoint cannot be reopened and validated: ${validation.reasons.join(" ")}`);
  Object.assign(state, persisted);
  return checkpointInCurrentState(state, checkpointId);
}

function revalidateBinding(state: TaskState, request: ContextResetRequest, config: ReliabilityConfig): string | undefined {
  const summary = state.context_checkpoints.find((item) => item.checkpoint_id === request.checkpoint_id);
  if (!summary) return "Durable checkpoint disappeared after an asynchronous adapter stage.";
  const checkpoint = validateCheckpoint(state, summary, config);
  if (!checkpoint.valid) return `Canonical checkpoint changed after an asynchronous adapter stage: ${checkpoint.reasons.join(" ")}`;
  if (state.pending_tool_calls.length > 0) return "A tool batch became pending during reset handshake.";
  if (state.current_session.lifecycle_identity !== "available" || state.current_session.session_id !== request.session_id
    || !state.current_session.branch_entry_ids.includes(request.branch_anchor_entry_id)
    || state.task_identity.session_id !== request.session_id) return "Session or branch identity changed during reset handshake.";
  if (summary.scope_sha256 !== request.scope_sha256 || JSON.stringify(summary.evidence_packs) !== JSON.stringify(request.evidence_packs)
    || sha256(state.next_action) !== request.next_action_sha256 || unresolvedDecisionCount(state) !== request.unresolved_decision_count
    || summary.snapshot_sha256 !== request.snapshot_sha256 || summary.canonical_state_sha256 !== request.canonical_state_sha256) return "Canonical scope, evidence, decisions, snapshot, or next action changed during reset handshake.";
  return undefined;
}

async function boundedAdapterStage<T>(stage: string, config: ReliabilityConfig, signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolveStage, rejectStage) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      controller.abort(signal?.reason);
      finish(() => rejectStage(new Error(`Context-curator ${stage} was cancelled.`)));
    };
    const timer = setTimeout(() => {
      controller.abort(new Error(`Context-curator ${stage} timed out.`));
      finish(() => rejectStage(new Error(`Context-curator ${stage} exceeded ${config.contextReset.adapterTimeoutMs}ms.`)));
    }, config.contextReset.adapterTimeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => finish(() => resolveStage(value)),
      (error) => finish(() => rejectStage(error instanceof Error ? error : new Error(String(error)))),
    );
  });
}

async function recoverFromMismatch(state: TaskState, summary: ContextCheckpointSummary, adapter: ContextCuratorAdapter, request: ContextResetRequest, reason: string, config: ReliabilityConfig, options: ContextResetRunOptions): Promise<ContextResetRunResult> {
  state.context_reset.mutation_blocked = true;
  state.context_reset.freeze_reason = reason;
  state.context_reset.freeze_request_id = request.request_id;
  state.context_reset.status = "paused";
  // Do not leave a speculative local epoch advance if the handshake did not
  // become durable. The transport restore result remains as a sidecar record.
  state.context_epoch = request.from_epoch;
  summary.context_epoch_after = undefined;
  summary.status = "recovery-required";
  try {
    const restored = await boundedAdapterStage("restore", config, options.signal, (signal) => adapter.restore(request, signal));
    const stored = writeCheckpointSidecar(state, summary, "restore", { schema_version: 1, request, restored });
    summary.restore_artifact_path = checkpointSidecarDisplayPath(state, summary.sequence, summary.from_lane, summary.to_lane, "restore");
    summary.restore_artifact_sha256 = stored.artifact_sha256;
    state.context_reset.last_reason = restored.restored && restored.request_id === request.request_id
      ? `${reason} Prior provider-visible epoch was restored and retained; explicit verified resume is still required.`
      : `${reason} Previous epoch could not be verified as restored; recovery is required.`;
  } catch (error) {
    state.context_reset.last_reason = `${reason} Restore failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  try {
    persistAndReopen(state, "context_reset_handshake_recovery_required", summary.checkpoint_id, config, options);
  } catch (error) {
    state.context_reset.last_reason = `${state.context_reset.last_reason} Durable recovery record failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { outcome: "recovery-required", reason: state.context_reset.last_reason ?? reason, checkpoint: checkpointInCurrentState(state, summary.checkpoint_id) };
}

function markCheckpointOnly(state: TaskState, summary: ContextCheckpointSummary, candidate: ContextResetCandidate, reason: string, config: ReliabilityConfig, options: ContextResetRunOptions): ContextResetRunResult {
  const durableSummary = checkpointInCurrentState(state, summary.checkpoint_id);
  durableSummary.status = "checkpoint-only";
  state.context_reset.status = "skipped";
  state.context_reset.last_reason = reason;
  // A fallback may never downgrade an unresolved handshake freeze.
  if (!state.context_reset.mutation_blocked && candidate.trigger !== "manual-retry") state.context_reset.cooldown_until_turn = candidate.turn_index + config.contextReset.cooldownTurns;
  persistAndReopen(state, "context_checkpoint_only", summary.checkpoint_id, config, options);
  return { outcome: "checkpoint-only", reason, checkpoint: checkpointInCurrentState(state, summary.checkpoint_id) };
}

/** Writes immutable snapshot+Markdown and observes durability before every possible provider transform. */
export async function executeContextReset(state: TaskState, candidate: ContextResetCandidate, config: ReliabilityConfig, options: ContextResetRunOptions): Promise<ContextResetRunResult> {
  if (!options.persist) throw new Error("Context reset requires an observed task-state persistence callback.");
  const automaticEnabled = options.automaticEnabled ?? true;
  const eligibility = evaluateContextResetEligibility(state, candidate, config, automaticEnabled);
  if (!eligibility.eligible) {
    if (!state.context_reset.mutation_blocked) {
      state.context_reset.status = eligibility.hard_pressure ? "paused" : "skipped";
      state.context_reset.last_reason = eligibility.hard_pressure ? `Hard context pressure: ${eligibility.reason ?? "checkpointing is blocked"}` : eligibility.reason;
      state.context_reset.pending_candidate = candidate;
      options.persist("context_checkpoint_not_eligible");
    }
    return { outcome: state.context_reset.mutation_blocked ? "recovery-required" : "not-eligible", reason: state.context_reset.freeze_reason ?? state.context_reset.last_reason ?? "Checkpoint is not eligible." };
  }
  state.context_reset.status = "rendering";
  state.context_reset.pending_candidate = candidate;
  state.context_reset.phase_id = candidate.phase_id;
  state.context_reset.last_attempt_at = (options.now ?? new Date()).toISOString();

  const resetAt = options.now ?? new Date();
  let rendered: RenderedCheckpoint;
  try {
    const sequence = findAvailableCheckpointSequence(state, candidate.from_lane, candidate.to_lane);
    state.id_counters.next_checkpoint = sequence;
    const snapshot = createCheckpointSnapshot(state, candidate, sequence, resetAt);
    rendered = renderCheckpointSnapshot(snapshot, config);
    const snapshotWrite = writeCheckpointSnapshot(state, snapshot);
    if (snapshotWrite.artifact_sha256 !== rendered.summary.snapshot_sha256) throw new Error("Immutable snapshot write did not match the rendered snapshot hash.");
    const checkpointWrite = writeCheckpointMarkdown(state, rendered.summary, rendered.markdown);
    if (checkpointWrite.artifact_sha256 !== rendered.summary.artifact_sha256) throw new Error("Checkpoint renderer and reopened artifact hashes disagree.");
  } catch (error) {
    if (error instanceof CheckpointSnapshotPrivacyError) {
      state.context_reset.status = "skipped";
      state.context_reset.last_reason = error.message;
      options.persist("context_checkpoint_retained");
      return { outcome: "not-eligible", reason: error.message };
    }
    state.context_reset.repair_attempts += 1;
    state.context_reset.last_reason = `Checkpoint render/write failed: ${error instanceof Error ? error.message : String(error)}`;
    state.context_reset.status = state.context_reset.repair_attempts >= 2 ? "paused" : "failed";
    options.persist("context_checkpoint_invalid");
    return { outcome: "invalid", reason: state.context_reset.last_reason };
  }

  const validation = validateCheckpoint(state, rendered.summary, config);
  if (!validation.valid) {
    state.context_reset.repair_attempts += 1;
    state.context_reset.last_reason = `Checkpoint validation failed: ${validation.reasons.join(" ")}`;
    state.context_reset.status = state.context_reset.repair_attempts >= 2 ? "paused" : "failed";
    options.persist("context_checkpoint_invalid");
    return { outcome: "invalid", reason: state.context_reset.last_reason };
  }

  const summary = rendered.summary;
  summary.status = "validated";
  state.context_checkpoints.push(summary);
  state.active_checkpoint_id = summary.checkpoint_id;
  state.id_counters.next_checkpoint = summary.sequence + 1;
  state.context_reset.status = "validated";
  state.context_reset.repair_attempts = 0;
  state.context_reset.last_reason = undefined;
  let durableSummary: ContextCheckpointSummary;
  try {
    durableSummary = persistAndReopen(state, "context_checkpoint_validated", summary.checkpoint_id, config, options);
  } catch (error) {
    state.context_reset.mutation_blocked = true;
    state.context_reset.freeze_reason = `Validated checkpoint could not be durably observed: ${error instanceof Error ? error.message : String(error)}`;
    state.context_reset.status = "paused";
    state.context_reset.last_reason = state.context_reset.freeze_reason;
    livePreTransformFailures.set(state, { checkpointId: summary.checkpoint_id, summaryHash: sha256(stableStringify(JSON.parse(JSON.stringify(summary)))), epoch: state.context_epoch, session: structuredClone(state.current_session), workspaceObservedAt: rendered.snapshot.state.workspace_revision.observed_at });
    return { outcome: "recovery-required", reason: state.context_reset.freeze_reason, checkpoint: summary };
  }

  if (!rendered.continuation_seed_available) {
    return markCheckpointOnly(
      state,
      durableSummary,
      candidate,
      "Checkpoint was durably validated, but provider-visible context was retained because the full continuation cannot fit without an inaccessible runtime-owned snapshot read.",
      config,
      options,
    );
  }

  let capability: ContextCuratorCapability | undefined;
  try {
    capability = options.adapter ? await boundedAdapterStage("discover", config, options.signal, (signal) => options.adapter!.discover(signal)) : undefined;
  } catch (error) {
    return markCheckpointOnly(state, durableSummary, candidate, `Context-curator capability discovery failed; provider-visible history was retained: ${error instanceof Error ? error.message : String(error)}`, config, options);
  }
  const request = requestFor(state, rendered);
  if (!capabilitySupportsReset(capability, request, options)) return markCheckpointOnly(state, durableSummary, candidate, "No trusted transport-proven context-curator reset capability is available; provider-visible history was retained.", config, options);
  if (!request) return markCheckpointOnly(state, durableSummary, candidate, "Current session/branch identity cannot prove a safe continuation reset; provider-visible history was retained.", config, options);
  const bindingAfterDiscovery = revalidateBinding(state, request, config);
  if (bindingAfterDiscovery) return recoverFromMismatch(state, durableSummary, options.adapter!, request, bindingAfterDiscovery, config, options);

  try {
    const requestRecord = writeCheckpointSidecar(state, durableSummary, "request", { schema_version: 1, request });
    durableSummary.request_artifact_path = checkpointSidecarDisplayPath(state, durableSummary.sequence, durableSummary.from_lane, durableSummary.to_lane, "request");
    durableSummary.request_artifact_sha256 = requestRecord.artifact_sha256;
    state.context_reset.status = "resetting";
    state.context_reset.mutation_blocked = true;
    state.context_reset.freeze_reason = "Provider context reset is in flight pending receipt and manifest handshake.";
    state.context_reset.freeze_request_id = request.request_id;
    durableSummary = persistAndReopen(state, "context_reset_request_durable", durableSummary.checkpoint_id, config, options);
  } catch (error) {
    state.context_reset.mutation_blocked = true;
    state.context_reset.freeze_reason = `Reset request could not be durably recorded: ${error instanceof Error ? error.message : String(error)}`;
    state.context_reset.status = "paused";
    return { outcome: "recovery-required", reason: state.context_reset.freeze_reason, checkpoint: durableSummary };
  }

  try {
    const receipt = await boundedAdapterStage("reset", config, options.signal, (signal) => options.adapter!.reset(request, signal));
    const currentSummary = checkpointInCurrentState(state, request.checkpoint_id);
    const receiptRecord = writeCheckpointSidecar(state, currentSummary, "receipt", { schema_version: 1, request, receipt });
    currentSummary.receipt_artifact_path = checkpointSidecarDisplayPath(state, currentSummary.sequence, currentSummary.from_lane, currentSummary.to_lane, "receipt");
    currentSummary.receipt_artifact_sha256 = receiptRecord.artifact_sha256;
    state.context_reset.status = "verifying";
    const bindingAfterReset = revalidateBinding(state, request, config);
    const mismatch = bindingAfterReset ?? receiptMatches(request, receipt);
    if (mismatch) return recoverFromMismatch(state, currentSummary, options.adapter!, request, mismatch, config, options);
    currentSummary.status = "reset-complete";
    currentSummary.context_epoch_after = request.to_epoch;
    currentSummary.reset_receipt_hash = sha256(stableStringify(receipt));
    currentSummary.provider_visible_manifest_sha256 = sha256(receipt.provider_visible_manifest!);
    state.context_epoch = request.to_epoch;
    if (config.contextReset.expireUnusedApprovals) expireUnusedScopeApprovalsAtContextReset(state, resetAt);
    state.context_reset.status = "complete";
    state.context_reset.mutation_blocked = false;
    state.context_reset.freeze_reason = undefined;
    state.context_reset.freeze_request_id = undefined;
    state.context_reset.cooldown_until_turn = candidate.turn_index + config.contextReset.cooldownTurns;
    state.context_reset.last_reason = "Verified context-curator receipt and observed provider-visible manifest.";
    persistAndReopen(state, "context_reset_complete", currentSummary.checkpoint_id, config, options, true, resetAt);
    return { outcome: "reset-complete", reason: state.context_reset.last_reason, checkpoint: checkpointInCurrentState(state, currentSummary.checkpoint_id) };
  } catch (error) {
    return recoverFromMismatch(state, checkpointInCurrentState(state, request.checkpoint_id), options.adapter!, request, `Context reset transport failed or is unverifiable: ${error instanceof Error ? error.message : String(error)}`, config, options);
  }
}

/** Marks the current lane/phase/step as a lifecycle-observed stable boundary for pressure handling. */
export function recordStableContextBoundary(state: TaskState): string {
  const boundary = stableBoundaryIdForContextReset(state);
  state.context_reset.stable_boundary_id = boundary;
  return boundary;
}

export function contextPressureCandidate(
  state: TaskState,
  gateDecision: ContextResetCandidate["gate_decision"],
  contextUsageRatio: number | undefined,
  estimatedTransientTokens = 0,
): ContextResetCandidate | undefined {
  if (state.lane === "general") return undefined;
  const boundary = stableBoundaryIdForContextReset(state);
  if (state.context_reset.stable_boundary_id !== boundary) return undefined;
  return createContextResetCandidate(state, {
    from_lane: state.lane,
    to_lane: state.lane,
    phase_id: phaseIdForContextReset(state, state.lane, state.lane, state.current_phase),
    trigger: "context-pressure",
    gate_decision: gateDecision,
    context_usage_ratio: contextUsageRatio,
    estimated_transient_tokens: estimatedTransientTokens,
    stable_boundary_id: boundary,
    turn_index: state.context_reset.turn_index,
  });
}

/** A recovery freeze is stronger than pressure and remains until a verified future recovery transition. */
export function contextResetToolBlockReason(state: TaskState, toolName: string): string | undefined {
  if (state.context_reset.mutation_blocked && !READ_ONLY_TOOLS.has(toolName)) return `Context reset is paused: ${state.context_reset.freeze_reason ?? state.context_reset.last_reason ?? "the post-reset handshake requires recovery"}`;
  if (!state.context_reset.mutation_blocked && state.context_reset.status === "paused" && /hard context pressure/i.test(state.context_reset.last_reason ?? "") && EXPLORATION_TOOLS.has(toolName)) {
    return "Context hard-pressure recovery is required before further nonessential exploration.";
  }
  return undefined;
}

export function recordContextResetTurn(state: TaskState): void {
  state.context_reset.turn_index += 1;
}

export function formatCheckpointStatus(state: TaskState, sessionAutomaticEnabled = true): string {
  const reset = state.context_reset;
  return [
    `Context epoch: ${state.context_epoch}.`,
    `Checkpoint/reset: ${reset.status}${reset.phase_id ? ` (phase ${reset.phase_id})` : ""}.`,
    `Automatic checkpoints: ${sessionAutomaticEnabled && reset.auto_enabled ? "on" : "off for this session"}.`,
    `Checkpoint count: ${state.context_checkpoints.length}; active: ${state.active_checkpoint_id ?? "none"}.`,
    `Mutation guard: ${reset.mutation_blocked ? "BLOCKED pending reset recovery" : "clear"}.`,
    ...(reset.last_reason ? [`Last reset note: ${reset.last_reason}`] : []),
  ].join("\n");
}

export function formatCheckpointList(state: TaskState): string {
  if (state.context_checkpoints.length === 0) return "No context checkpoints are recorded.";
  return state.context_checkpoints.map((checkpoint) => `${checkpoint.checkpoint_id} ${checkpoint.status} epoch ${checkpoint.context_epoch_before}${checkpoint.context_epoch_after === undefined ? "" : `→${checkpoint.context_epoch_after}`} ${checkpoint.from_lane}→${checkpoint.to_lane} ${checkpoint.artifact_path}`).join("\n");
}

/** Event-bus capability discovery is advisory; lacking authenticated sender identity it cannot unlock reset. */
export function createEventBusContextCuratorAdapter(events: { emit(channel: string, data: unknown): void; on(channel: string, handler: (data: unknown) => void): () => void }, timeoutMs = 250): ContextCuratorAdapter {
  const waitFor = <T>(channel: string, requestId: string, request: unknown, signal?: AbortSignal): Promise<T | undefined> => new Promise((resolveWait) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      unsubscribe();
      resolveWait(value);
    };
    const unsubscribe = events.on(channel, (data) => {
      if (!data || typeof data !== "object" || (data as { request_id?: unknown }).request_id !== requestId) return;
      finish((data as { value?: T }).value);
    });
    const onAbort = () => finish(undefined);
    const timer = setTimeout(() => finish(undefined), Math.max(10, Math.min(timeoutMs, 5_000)));
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      events.emit(channel.replace(":response", ":request"), { request_id: requestId, value: request });
    } catch {
      finish(undefined);
    }
  });
  return {
    async discover(signal) {
      const value = await waitFor<ContextCuratorCapability>("context-curator:v1:capability:response", `cap-${randomUUID()}`, { schema_version: 1 }, signal);
      return value && { ...value, integration_origin: "event-bus" };
    },
    async reset(request, signal) {
      const value = await waitFor<ContextResetReceipt>("context-curator:v1:reset:response", request.request_id, request, signal);
      return value ?? { ...request, outcome: "recovery-required", provider_visible_manifest_sha256: undefined, reason: "Context-curator event-bus reset receipt timed out." };
    },
    async restore(request, signal) {
      const value = await waitFor<{ restored: boolean; request_id: string; reason?: string }>("context-curator:v1:restore:response", request.request_id, request, signal);
      return value ?? { restored: false, request_id: request.request_id, reason: "Context-curator event-bus restore receipt timed out." };
    },
  };
}
