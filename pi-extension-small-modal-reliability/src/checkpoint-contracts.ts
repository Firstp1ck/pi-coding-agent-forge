import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import type {
  ContextCheckpointSummary,
  ContextCheckpointTrigger,
  ContextResetCandidate,
  ContextResetState,
  ContextTargetLane,
  EvidencePack,
  EvidencePackSummary,
  EvidenceRevisionReceipt,
  TaskState,
  WorkflowLane,
} from "./types.ts";
import { readEvidencePack } from "./evidence-state.ts";
import { taskDir } from "./paths.ts";
import { redactSensitiveText } from "./redaction.ts";
import { stableStringify } from "./utils.ts";

export const CHECKPOINT_SCHEMA_VERSION = 1 as const;
export const CHECKPOINT_REQUIRED_HEADINGS = [
  "# Context checkpoint",
  "## Identity",
  "## Original user request",
  "## Later authoritative user instructions",
  "## Current objective and success criteria",
  "## Material findings",
  "## Conflicts, unknowns, and pending decisions",
  "## Decisions and rejected alternatives",
  "## Active scope and safety boundaries",
  "## Files and artifacts",
  "## Validation and gate state",
  "## Next action",
  "## Recovery references",
  "## Integrity manifest",
] as const;
export const MAX_CHECKPOINT_ARTIFACT_BYTES = 2_000_000;

export type CheckpointSealedEvidencePack = {
  summary: EvidencePackSummary;
  pack: EvidencePack;
  /** Canonical parsed evidence content hash, sealed by the enclosing snapshot. */
  content_sha256: string;
  /** Exact persisted receipt that authorized the evidence summary revision when provenance is required. */
  revision_receipt?: EvidenceRevisionReceipt;
};

/** Immutable state projection with explicit derived values used by Markdown pointers. */
export type CheckpointSnapshotState = TaskState & {
  files_and_artifacts: string[];
  effective_validation: string[];
  sealed_evidence_packs: CheckpointSealedEvidencePack[];
};

export type CheckpointSnapshot = {
  schema_version: 1;
  task_id: string;
  checkpoint_id: string;
  sequence: number;
  artifact_path: string;
  captured_at: string;
  canonical_state_sha256: string;
  candidate: ContextResetCandidate;
  state: CheckpointSnapshotState;
};

/** Raised before any checkpoint artifact is written when persistence would copy secret-like material. */
export class CheckpointSnapshotPrivacyError extends Error {
  constructor() {
    super("Checkpoint retention was refused because required content contains secret-like material; provider-visible context was retained without creating another credential copy.");
    this.name = "CheckpointSnapshotPrivacyError";
  }
}

export type CheckpointSidecarKind = "request" | "receipt" | "restore";

const CHECKPOINT_ID = /^CP[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;
const WORKFLOW_LANES = new Set<WorkflowLane>(["retrieval", "agentic", "coding", "structured-output", "general"]);
const TARGET_LANES = new Set<ContextTargetLane>([...WORKFLOW_LANES, "planning", "review", "final"]);
const TRIGGERS = new Set<ContextCheckpointTrigger>(["phase-boundary", "context-pressure", "manual-retry"]);

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith("/") && !path.startsWith("\\"));
}

function lstatIfExists(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function realWorkspaceRoot(cwd: string): string {
  const root = realpathSync(cwd);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Checkpoint workspace root must be a real directory, not a symlink.");
  return root;
}

function safeTaskSegments(state: TaskState, root: string): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(state.task_id)) throw new Error("Checkpoint task ID is unsafe for task-local storage.");
  const target = resolve(taskDir(state.cwd, state.task_id));
  if (!pathIsWithin(root, target)) throw new Error("Checkpoint task storage escaped the workspace root.");
  const segments = relative(root, target).split(/[\\/]+/).filter(Boolean);
  if (segments.length < 3 || segments.some((segment) => segment === "." || segment === "..")) throw new Error("Checkpoint task storage path is invalid.");
  return segments;
}

/** Creates task-local checkpoint ancestors only after rejecting every symlink traversal. */
function checkedDirectoryChain(root: string, segments: string[], create: boolean): string | undefined {
  let current = root;
  for (const segment of segments) {
    const candidate = join(current, segment);
    if (!pathIsWithin(root, candidate)) throw new Error("Checkpoint storage path escaped the workspace root.");
    let stat = lstatIfExists(candidate);
    if (!stat) {
      if (!create) return undefined;
      const parent = lstatSync(current);
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error("Checkpoint storage ancestor is not a real directory.");
      mkdirSync(candidate, { mode: 0o700 });
      stat = lstatSync(candidate);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Checkpoint storage cannot traverse a symlink.");
    const canonical = realpathSync(candidate);
    if (!pathIsWithin(root, canonical)) throw new Error("Checkpoint storage ancestor resolves outside the workspace.");
    current = canonical;
  }
  return current;
}

export function checkpointDirectory(state: TaskState, create = false): string | undefined {
  const root = realWorkspaceRoot(state.cwd);
  return checkedDirectoryChain(root, [...safeTaskSegments(state, root), "checkpoints"], create);
}

export function checkpointArtifactName(sequence: number, fromLane: WorkflowLane, toLane: ContextTargetLane): string {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("Checkpoint sequence must be a positive integer.");
  if (!WORKFLOW_LANES.has(fromLane) || !TARGET_LANES.has(toLane)) throw new Error("Checkpoint lane is invalid.");
  return `${sequence}-${fromLane}-to-${toLane}.md`;
}

function checkpointBasePath(state: TaskState, sequence: number, fromLane: WorkflowLane, toLane: ContextTargetLane, create = false): string {
  const directory = checkpointDirectory(state, create);
  if (!directory) throw new Error("Checkpoint directory does not exist.");
  const path = resolve(directory, checkpointArtifactName(sequence, fromLane, toLane));
  if (!pathIsWithin(directory, path) || lstatIfExists(path)?.isSymbolicLink()) throw new Error("Checkpoint artifact path is unsafe.");
  return path;
}

export function checkpointArtifactPath(state: TaskState, sequence: number, fromLane: WorkflowLane, toLane: ContextTargetLane, create = false): string {
  return checkpointBasePath(state, sequence, fromLane, toLane, create);
}

export function checkpointDisplayPath(state: TaskState, sequence: number, fromLane: WorkflowLane, toLane: ContextTargetLane): string {
  void state;
  return `checkpoints/${checkpointArtifactName(sequence, fromLane, toLane)}`;
}

export function checkpointSnapshotDisplayPath(state: TaskState, sequence: number, fromLane: WorkflowLane, toLane: ContextTargetLane): string {
  return `${checkpointDisplayPath(state, sequence, fromLane, toLane)}.snapshot.json`;
}

export function checkpointSidecarDisplayPath(state: TaskState, sequence: number, fromLane: WorkflowLane, toLane: ContextTargetLane, kind: CheckpointSidecarKind): string {
  return `${checkpointDisplayPath(state, sequence, fromLane, toLane)}.${kind}.json`;
}

function sidecarPath(state: TaskState, sequence: number, fromLane: WorkflowLane, toLane: ContextTargetLane, suffix: ".snapshot.json" | ".request.json" | ".receipt.json" | ".restore.json", create = false): string {
  const base = checkpointBasePath(state, sequence, fromLane, toLane, create);
  const path = `${base}${suffix}`;
  if (lstatIfExists(path)?.isSymbolicLink()) throw new Error("Checkpoint sidecar cannot be a symlink.");
  return path;
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Excludes checkpoint bookkeeping, timestamps, and snapshot-only derived fields from canonical task facts. */
export function canonicalCheckpointStateHash(state: TaskState | CheckpointSnapshotState): string {
  const snapshotState = state as TaskState & Partial<CheckpointSnapshotState>;
  const {
    updated_at: _updatedAt,
    context_checkpoints: _checkpoints,
    active_checkpoint_id: _activeCheckpoint,
    context_reset: _reset,
    id_counters,
    files_and_artifacts: _filesAndArtifacts,
    effective_validation: _effectiveValidation,
    sealed_evidence_packs: _sealedEvidence,
    ...canonical
  } = snapshotState;
  const { next_checkpoint: _nextCheckpoint, ...stableCounters } = id_counters;
  // Snapshot JSON deliberately omits undefined object members. Normalize the
  // live projection the same way so a reopened immutable snapshot hashes to
  // the same canonical task facts.
  const normalized = JSON.parse(JSON.stringify({ ...canonical, id_counters: stableCounters }));
  return sha256(stableStringify(normalized));
}

export function scopeHashForCheckpoint(state: TaskState): string | undefined {
  const scope = state.scope_state.active_scope;
  if (!scope) return undefined;
  return sha256(stableStringify({
    lane: scope.lane,
    allowed_tools: [...scope.allowed_tools].sort(),
    allowed_read_paths: [...scope.allowed_read_paths].sort(),
    allowed_write_paths: [...scope.allowed_write_paths].sort(),
    forbidden_paths: [...scope.forbidden_paths].sort(),
    max_tool_calls: scope.max_tool_calls,
    max_errors: scope.max_errors,
    max_iterations: scope.max_iterations,
    external_side_effects: scope.external_side_effects,
    validation_commands: [...scope.validation_commands].sort(),
    stop_conditions: [...scope.stop_conditions].sort(),
    escalation_conditions: [...scope.escalation_conditions].sort(),
  }));
}

export function createContextResetState(): ContextResetState {
  return { status: "idle", auto_enabled: true, turn_index: 0, repair_attempts: 0, mutation_blocked: false };
}

/** Phase identity deliberately excludes context epoch, so a reset cannot reopen its own phase cap. */
export function phaseIdForContextReset(state: TaskState, fromLane: WorkflowLane, toLane: ContextTargetLane, subphase = state.current_phase): string {
  return `P${sha256(stableStringify({
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    from_lane: fromLane,
    to_lane: toLane,
    subphase,
    current_step_id: state.current_step_id,
  })).slice(0, 24)}`;
}

export function stableBoundaryIdForContextReset(state: TaskState): string {
  return `B${sha256(stableStringify({
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    lane: state.lane,
    phase: state.current_phase,
    step: state.current_step_id,
  })).slice(0, 24)}`;
}

export function createContextResetCandidate(
  state: TaskState,
  input: Omit<ContextResetCandidate, "phase_id" | "next_action" | "turn_index"> & { phase_id?: string; next_action?: string; turn_index?: number },
): ContextResetCandidate {
  if (!WORKFLOW_LANES.has(input.from_lane) || !TARGET_LANES.has(input.to_lane) || !TRIGGERS.has(input.trigger)) throw new Error("Context reset candidate has an unsupported lane or trigger.");
  const canonicalNextAction = state.next_action.trim();
  const suppliedNextAction = input.next_action?.trim();
  if (!canonicalNextAction || canonicalNextAction.length > 300 || /[\r\n]/.test(canonicalNextAction)) throw new Error("Context reset requires one bounded, single-line canonical next action.");
  if (suppliedNextAction !== undefined && suppliedNextAction !== canonicalNextAction) throw new Error("Context reset candidate next action must equal the current canonical next action.");
  if (input.gate_decision !== "pass" && input.gate_decision !== "escalate" && input.gate_decision !== "fail") throw new Error("Context reset candidate has an invalid gate decision.");
  return {
    ...input,
    phase_id: input.phase_id ?? phaseIdForContextReset(state, input.from_lane, input.to_lane),
    next_action: canonicalNextAction,
    turn_index: input.turn_index ?? state.context_reset.turn_index,
  };
}

export function candidateIdentity(candidate: ContextResetCandidate): string {
  // Persistence omits optional undefined fields; identity must survive that lossless normalization.
  return sha256(stableStringify(JSON.parse(JSON.stringify(candidate))));
}

export function assertCheckpointSummary(summary: ContextCheckpointSummary): void {
  if (!CHECKPOINT_ID.test(summary.checkpoint_id)
    || !Number.isSafeInteger(summary.sequence) || summary.sequence < 1
    || summary.schema_version !== CHECKPOINT_SCHEMA_VERSION
    || !WORKFLOW_LANES.has(summary.from_lane) || !TARGET_LANES.has(summary.to_lane)
    || !summary.phase_id || !summary.artifact_path.startsWith("checkpoints/")
    || !SHA256.test(summary.artifact_sha256) || !SHA256.test(summary.canonical_state_sha256)
    || (summary.scope_sha256 !== undefined && !SHA256.test(summary.scope_sha256))
    || !TRIGGERS.has(summary.trigger)
    || !["written", "validated", "reset-complete", "checkpoint-only", "invalid", "recovery-required"].includes(summary.status)
    || !Number.isSafeInteger(summary.context_epoch_before) || summary.context_epoch_before < 0
    || (summary.context_epoch_after !== undefined && (!Number.isSafeInteger(summary.context_epoch_after) || summary.context_epoch_after !== summary.context_epoch_before + 1))
    || !summary.created_at
    || !Array.isArray(summary.evidence_packs)
    || summary.evidence_packs.some((pack) => !/^E[1-9][0-9]*$/.test(pack.pack_id) || !SHA256.test(pack.sha256))
    || (summary.snapshot_path !== undefined && (!summary.snapshot_path.startsWith("checkpoints/") || !SHA256.test(summary.snapshot_sha256 ?? "")))
    || (summary.candidate_next_action_sha256 !== undefined && !SHA256.test(summary.candidate_next_action_sha256))
    || [summary.request_artifact_sha256, summary.receipt_artifact_sha256, summary.restore_artifact_sha256].some((hash) => hash !== undefined && !SHA256.test(hash))) {
    throw new Error("Checkpoint summary is structurally invalid.");
  }
}

function writeAtomic(path: string, value: string): { path: string; sha256: string } {
  if (Buffer.byteLength(value, "utf8") > MAX_CHECKPOINT_ARTIFACT_BYTES) throw new Error("Checkpoint artifact exceeds the task-local artifact bound.");
  if (existsSync(path)) throw new Error(`Checkpoint artifact already exists: ${path}`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const expectedHash = sha256(value);
  try {
    writeFileSync(temporary, value, { encoding: "utf8", mode: 0o600 });
    if (sha256(readFileSync(temporary, "utf8")) !== expectedHash) throw new Error("Checkpoint temporary write did not verify.");
    renameSync(temporary, path);
    if (sha256(readFileSync(path, "utf8")) !== expectedHash) throw new Error("Checkpoint reopen hash did not verify.");
    return { path, sha256: expectedHash };
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readBounded(path: string, expectedHash: string, maximumBytes = MAX_CHECKPOINT_ARTIFACT_BYTES): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error("Checkpoint artifact is not a bounded regular file.");
  const value = readFileSync(path, "utf8");
  if (sha256(value) !== expectedHash) throw new Error("Checkpoint artifact hash does not match task state.");
  return value;
}

export function findAvailableCheckpointSequence(state: TaskState, fromLane: WorkflowLane, toLane: ContextTargetLane): number {
  for (let sequence = state.id_counters.next_checkpoint; sequence < state.id_counters.next_checkpoint + 128; sequence += 1) {
    const artifact = checkpointArtifactPath(state, sequence, fromLane, toLane, true);
    const snapshot = sidecarPath(state, sequence, fromLane, toLane, ".snapshot.json", true);
    if (!existsSync(artifact) && !existsSync(snapshot)) return sequence;
  }
  throw new Error("Unable to allocate a fresh checkpoint sequence without overwriting an orphan artifact.");
}

function hasSensitiveText(value: unknown, seen = new Set<unknown>()): boolean {
  if (typeof value === "string") return redactSensitiveText(value) !== value;
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  return Array.isArray(value)
    ? value.some((entry) => hasSensitiveText(entry, seen))
    : Object.values(value).some((entry) => hasSensitiveText(entry, seen));
}

function effectiveValidationRecords(state: TaskState): string[] {
  const currentCriteria = state.criteria.map((criterion) => {
    const result = [...state.criterion_results].reverse().find((item) => item.criterion_id === criterion.id);
    return result
      ? `Criterion ${criterion.id}: ${result.status}; fresh: ${result.fresh}; provenance: ${result.provenance}; evidence: ${result.evidence}; remaining work: ${result.remaining_work}`
      : `Criterion ${criterion.id}: unknown; no current authoritative criterion result is recorded.`;
  });
  return [
    ...currentCriteria,
    ...state.quality_gate.assessments.map((assessment) => `Gate ${assessment.gate}: ${assessment.decision}; ${assessment.reasons.join(" | ")}`),
    ...state.completion_gates.map((gate) => `Completion ${gate.source}: ${gate.decision}; ${gate.reasons.join(" | ")}`),
    `Coding boundary: ${stableStringify(state.coding_boundary)}`,
    `Structured output: ${stableStringify({ contracts: state.structured_output.contracts, validations: state.structured_output.validations })}`,
  ];
}

function filesAndArtifacts(state: TaskState): string[] {
  return [...new Set([
    ...state.files_touched,
    ...state.execution_receipts.flatMap((receipt) => receipt.artifact_refs),
    ...state.evidence_packs.map((pack) => pack.evidence_path),
  ])];
}

function evidenceProvenanceIsRequired(state: TaskState): boolean {
  return Boolean(state.task_identity.session_id || state.current_session.session_id || state.current_session.lifecycle_identity === "available");
}

function sealEvidencePacks(state: TaskState): CheckpointSealedEvidencePack[] {
  return state.evidence_packs.map((summary) => {
    const pack = readEvidencePack(state, summary.pack_id);
    const hasRevision = Boolean(summary.revision_session_id || summary.revision_receipt_entry_id);
    if ((summary.revision_session_id === undefined) !== (summary.revision_receipt_entry_id === undefined)) {
      throw new Error(`Evidence pack ${summary.pack_id} has incomplete authoritative revision provenance.`);
    }
    if (evidenceProvenanceIsRequired(state) && !hasRevision) {
      throw new Error(`Evidence pack ${summary.pack_id} has no authoritative revision receipt for its current hash.`);
    }
    const receipt = hasRevision
      ? state.current_session.evidence_revision_receipts?.find((item) => item.entry_id === summary.revision_receipt_entry_id)
      : undefined;
    if (hasRevision && (!receipt
      || receipt.task_id !== state.task_id
      || receipt.pack_id !== summary.pack_id
      || receipt.sha256 !== summary.sha256
      || summary.revision_session_id !== state.current_session.session_id
      || !state.current_session.branch_entry_ids.includes(receipt.entry_id))) {
      throw new Error(`Evidence pack ${summary.pack_id} has no exact current-session authoritative revision receipt.`);
    }
    return {
      summary: JSON.parse(JSON.stringify(summary)) as EvidencePackSummary,
      pack: JSON.parse(JSON.stringify(pack)) as EvidencePack,
      content_sha256: sha256(stableStringify(pack)),
      ...(receipt ? { revision_receipt: JSON.parse(JSON.stringify(receipt)) as EvidenceRevisionReceipt } : {}),
    };
  });
}

export function createCheckpointSnapshot(state: TaskState, candidate: ContextResetCandidate, sequence: number, now = new Date()): CheckpointSnapshot {
  const sealedEvidence = sealEvidencePacks(state);
  // The checkpoint is an additional durable artifact. Do not duplicate any
  // secret-like task or evidence content into it, even when Markdown redacts display.
  if (hasSensitiveText(state) || hasSensitiveText(sealedEvidence)) throw new CheckpointSnapshotPrivacyError();
  const snapshotState = JSON.parse(JSON.stringify(state)) as CheckpointSnapshotState;
  snapshotState.files_and_artifacts = filesAndArtifacts(state);
  snapshotState.effective_validation = effectiveValidationRecords(state);
  snapshotState.sealed_evidence_packs = sealedEvidence;
  return {
    schema_version: 1,
    task_id: state.task_id,
    checkpoint_id: `CP${sequence}`,
    sequence,
    artifact_path: checkpointSnapshotDisplayPath(state, sequence, candidate.from_lane, candidate.to_lane),
    captured_at: now.toISOString(),
    canonical_state_sha256: canonicalCheckpointStateHash(state),
    candidate: JSON.parse(JSON.stringify(candidate)) as ContextResetCandidate,
    state: snapshotState,
  };
}

/** Resolves one renderer-emitted JSON pointer only against the immutable snapshot. */
export function checkpointSnapshotPointerValue(snapshot: CheckpointSnapshot, pointer: string): unknown {
  if (!pointer || pointer.startsWith("/") || pointer.split("/").some((segment) => !segment || segment.includes("~"))) return undefined;
  let current: unknown = snapshot as unknown;
  for (const segment of pointer.split("/")) {
    if (Array.isArray(current)) {
      if (!/^(0|[1-9][0-9]*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (current && typeof current === "object" && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function checkpointSnapshotPointerHash(snapshot: CheckpointSnapshot, pointer: string): string | undefined {
  const value = checkpointSnapshotPointerValue(snapshot, pointer);
  if (value === undefined) return undefined;
  return sha256(typeof value === "string" ? value : stableStringify(value));
}

export function snapshotSha256(snapshot: CheckpointSnapshot): string {
  return sha256(`${stableStringify(snapshot)}\n`);
}

export function writeCheckpointSnapshot(state: TaskState, snapshot: CheckpointSnapshot): { path: string; artifact_sha256: string } {
  const path = sidecarPath(state, snapshot.sequence, snapshot.candidate.from_lane, snapshot.candidate.to_lane, ".snapshot.json", true);
  const value = `${stableStringify(snapshot)}\n`;
  const written = writeAtomic(path, value);
  return { path: written.path, artifact_sha256: written.sha256 };
}

export function readCheckpointSnapshot(state: TaskState, summary: ContextCheckpointSummary): CheckpointSnapshot {
  if (!summary.snapshot_path || !summary.snapshot_sha256) throw new Error("Checkpoint has no immutable canonical snapshot.");
  const expected = sidecarPath(state, summary.sequence, summary.from_lane, summary.to_lane, ".snapshot.json", false);
  const actual = resolve(taskDir(state.cwd, state.task_id), summary.snapshot_path);
  if (actual !== expected) throw new Error("Checkpoint snapshot path does not match immutable checkpoint identity.");
  const value = readBounded(actual, summary.snapshot_sha256);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(value);
  } catch {
    throw new Error("Checkpoint snapshot is invalid JSON.");
  }
  if (!snapshot || typeof snapshot !== "object") throw new Error("Checkpoint snapshot is structurally invalid.");
  const typed = snapshot as CheckpointSnapshot;
  if (typed.schema_version !== 1 || typed.task_id !== state.task_id || typed.checkpoint_id !== summary.checkpoint_id
    || typed.sequence !== summary.sequence || typed.artifact_path !== summary.snapshot_path
    || typed.canonical_state_sha256 !== summary.canonical_state_sha256
    || !typed.state || !typed.candidate || canonicalCheckpointStateHash(typed.state) !== typed.canonical_state_sha256) {
    throw new Error("Checkpoint snapshot identity or canonical state hash is invalid.");
  }
  return typed;
}

export function writeCheckpointMarkdown(state: TaskState, summary: Pick<ContextCheckpointSummary, "sequence" | "from_lane" | "to_lane">, markdown: string): { path: string; artifact_sha256: string } {
  if (!markdown.length) throw new Error("Checkpoint Markdown cannot be empty.");
  const written = writeAtomic(checkpointArtifactPath(state, summary.sequence, summary.from_lane, summary.to_lane, true), markdown);
  return { path: written.path, artifact_sha256: written.sha256 };
}

export function writeCheckpointSidecar(state: TaskState, summary: Pick<ContextCheckpointSummary, "sequence" | "from_lane" | "to_lane">, kind: CheckpointSidecarKind, data: unknown): { path: string; artifact_sha256: string } {
  const suffix = `.${kind}.json` as const;
  const written = writeAtomic(sidecarPath(state, summary.sequence, summary.from_lane, summary.to_lane, suffix, true), `${stableStringify(data)}\n`);
  return { path: written.path, artifact_sha256: written.sha256 };
}

export function readCheckpointMarkdown(state: TaskState, summary: Pick<ContextCheckpointSummary, "sequence" | "from_lane" | "to_lane" | "artifact_sha256">, maximumBytes = MAX_CHECKPOINT_ARTIFACT_BYTES): string {
  const path = checkpointArtifactPath(state, summary.sequence, summary.from_lane, summary.to_lane, false);
  if (!existsSync(path)) throw new Error("Checkpoint artifact is missing.");
  return readBounded(path, summary.artifact_sha256, maximumBytes);
}

/** Validation failures happen before the summary is durable; remove only our exact regular artifacts. */
export function deleteUncommittedCheckpoint(state: TaskState, summary: Pick<ContextCheckpointSummary, "sequence" | "from_lane" | "to_lane">): void {
  for (const suffix of ["", ".snapshot.json"] as const) {
    const path = suffix
      ? sidecarPath(state, summary.sequence, summary.from_lane, summary.to_lane, suffix, false)
      : checkpointArtifactPath(state, summary.sequence, summary.from_lane, summary.to_lane, false);
    const stat = lstatIfExists(path);
    if (stat?.isFile() && !stat.isSymbolicLink()) unlinkSync(path);
  }
}
