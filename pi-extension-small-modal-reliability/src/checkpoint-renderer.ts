import {
  CHECKPOINT_SCHEMA_VERSION,
  canonicalCheckpointStateHash,
  checkpointDisplayPath,
  checkpointSnapshotPointerHash,
  createCheckpointSnapshot,
  scopeHashForCheckpoint,
  sha256,
  snapshotSha256,
  type CheckpointSnapshot,
} from "./checkpoint-contracts.ts";
import { redactSensitiveText } from "./redaction.ts";
import type { ContextCheckpointSummary, ContextResetCandidate, ReliabilityConfig, TaskState } from "./types.ts";
import { stableStringify } from "./utils.ts";

const INLINE_CHARS = 900;
const REQUIRED_INLINE_CHARS = 8_000;

export type RenderedCheckpoint = {
  snapshot: CheckpointSnapshot;
  summary: ContextCheckpointSummary;
  markdown: string;
  continuation_seed: string;
  continuation_seed_sha256: string;
  /** False when compact recovery would require a generic read of runtime-owned checkpoint state. */
  continuation_seed_available: boolean;
  continuation_manifest: string;
  continuation_manifest_sha256: string;
};

function quote(value: string): string[] {
  return value.split(/\r?\n/).map((line) => `> ${line || " "}`);
}

function snapshotRef(snapshot: CheckpointSnapshot, pointer: string, value?: string): string {
  const hash = checkpointSnapshotPointerHash(snapshot, pointer);
  if (!hash) throw new Error(`Checkpoint renderer referenced missing immutable snapshot pointer: ${pointer}.`);
  if (value !== undefined && sha256(value) !== hash) throw new Error(`Checkpoint renderer value does not match immutable snapshot pointer: ${pointer}.`);
  return `\`${snapshot.artifact_path}#/${pointer}\` (SHA-256: \`${hash}\`)`;
}

function requiredValue(snapshot: CheckpointSnapshot, value: string, pointer: string): { lines: string[]; referenced: boolean } {
  const redacted = redactSensitiveText(value);
  if (redacted === value && value.length <= REQUIRED_INLINE_CHARS) return { lines: quote(value), referenced: false };
  const reason = redacted === value ? "exceeds the bounded display limit" : "contains redacted secret-like content";
  return { lines: [`- Immutable lossless reference: ${snapshotRef(snapshot, pointer, value)}. Display omitted because it ${reason}.`], referenced: true };
}

function optionalValue(snapshot: CheckpointSnapshot, value: string, pointer: string, label = ""): { text: string; referenced: boolean } {
  const redacted = redactSensitiveText(value).replace(/\s+/g, " ").trim();
  if (redacted.length <= INLINE_CHARS) return { text: `${label}${redacted}`, referenced: false };
  return { text: `${label}Immutable lossless reference: ${snapshotRef(snapshot, pointer, value)}.`, referenced: true };
}

function arrayLines(snapshot: CheckpointSnapshot, values: string[], pointer: string, label: string): { lines: string[]; referenced: boolean } {
  if (values.length === 0) return { lines: [`- No ${label.toLowerCase()} are recorded.`], referenced: false };
  if (values.length > 24) {
    return { lines: [`- All ${values.length} ${label.toLowerCase()} are retained by immutable snapshot reference: ${snapshotRef(snapshot, pointer)}.`], referenced: true };
  }
  let referenced = false;
  const lines = values.map((value, index) => {
    const rendered = optionalValue(snapshot, value, `${pointer}/${index}`);
    referenced ||= rendered.referenced;
    return `- ${rendered.text}`;
  });
  return { lines, referenced };
}

function exactEvidenceRefs(packId: string, references: Array<{ source_id: string; passage_ids: string[] }>): string {
  return references.flatMap((reference) => reference.passage_ids.map((passage) => `${packId}:${reference.source_id}:${passage}`)).join(", ");
}

function criteriaLines(snapshot: CheckpointSnapshot): { lines: string[]; referenced: boolean } {
  const criteria = snapshot.state.criteria;
  if (criteria.length === 0) return { lines: ["- No success criteria are recorded."], referenced: false };
  if (criteria.length > 24) {
    return { lines: [`- All ${criteria.length} success criteria are retained by immutable snapshot reference: ${snapshotRef(snapshot, "state/criteria")}.`], referenced: true };
  }
  let referenced = false;
  const lines = criteria.map((criterion, index) => {
    const rendered = optionalValue(snapshot, criterion.requirement, `state/criteria/${index}/requirement`);
    referenced ||= rendered.referenced;
    return `- ${criterion.id}: ${rendered.text}; expected evidence: ${criterion.expected_evidence}.`;
  });
  return { lines, referenced };
}

function materialFindings(snapshot: CheckpointSnapshot): { lines: string[]; referenced: boolean } {
  const state = snapshot.state;
  if (state.sealed_evidence_packs.length === 0) return { lines: ["- No evidence packs are recorded."], referenced: false };
  const lines: string[] = [];
  let referenced = false;
  for (let packIndex = 0; packIndex < state.sealed_evidence_packs.length; packIndex += 1) {
    const sealed = state.sealed_evidence_packs[packIndex];
    const pack = sealed.pack;
    const findings = pack.claims.filter((claim) => claim.material && claim.conflict_disposition?.disposition !== "exclude-claim");
    if (findings.length === 0) {
      lines.push(`- ${pack.pack_id}: no included material claim is recorded.`);
      continue;
    }
    for (const [claimIndex, claim] of pack.claims.entries()) {
      if (!claim.material || claim.conflict_disposition?.disposition === "exclude-claim") continue;
      const status = claim.contradicts.length > 0
        ? claim.conflict_disposition?.disposition ?? "conflict-unresolved"
        : claim.support.length > 0 ? "supported-reference" : "unsupported";
      const display = optionalValue(snapshot, claim.claim, `state/sealed_evidence_packs/${packIndex}/pack/claims/${claimIndex}/claim`, "Claim: ");
      referenced ||= display.referenced;
      const refs = exactEvidenceRefs(pack.pack_id, claim.support);
      const contradictions = exactEvidenceRefs(pack.pack_id, claim.contradicts);
      lines.push(`- ${display.text} (status: ${status}; support: ${refs || "none"}${contradictions ? `; contradicts: ${contradictions}` : ""}).`);
    }
  }
  return { lines, referenced };
}

function unresolvedLines(snapshot: CheckpointSnapshot): { lines: string[]; referenced: boolean } {
  const state = snapshot.state;
  const questions = arrayLines(snapshot, state.open_questions, "state/open_questions", "open questions");
  const errors = arrayLines(snapshot, state.errors, "state/errors", "failures");
  const lines = [
    ...questions.lines.map((line) => line.replace(/^- /, "- Open item: ")),
    ...errors.lines.map((line) => line.replace(/^- /, "- Failure: ")),
    ...state.quality_gate.escalations.flatMap((item) => item.status === "pending" ? [`- Pending escalation ${item.id}: ${stableStringify(item)}.`] : []),
    ...state.scope_state.pending_scope_changes.flatMap((item) => item.status === "pending" ? [`- Pending scope change ${item.id}: ${stableStringify(item)}.`] : []),
    ...state.scope_state.approvals.flatMap((item) => item.status === "pending" || item.status === "approved"
      ? [`- ${item.status === "approved" ? "Unused approved" : "Pending"} effect approval ${item.id}: ${stableStringify(item)}.`]
      : []),
  ];
  return { lines: lines.length ? lines : ["- No unresolved conflicts, decisions, or approvals are recorded."], referenced: questions.referenced || errors.referenced || lines.some((line) => line.includes(snapshot.artifact_path)) };
}

function scopeLines(snapshot: CheckpointSnapshot, scopeHash: string | undefined): { lines: string[]; referenced: boolean } {
  const state = snapshot.state;
  const scope = state.scope_state.active_scope;
  if (!scope) return { lines: ["- No active execution scope.", "- Budgets and permissions are not expanded by this checkpoint."], referenced: false };
  const inline = [
    `- Scope: ${scope.scope_id}; lane: ${scope.lane}; authority: ${scope.authority}.`,
    `- Allowed tools: ${scope.allowed_tools.join(", ") || "none"}.`,
    `- Read paths: ${scope.allowed_read_paths.join(", ") || "none"}.`,
    `- Write paths: ${scope.allowed_write_paths.join(", ") || "none"}.`,
    `- Forbidden paths: ${scope.forbidden_paths.join(", ") || "none"}.`,
    `- Budgets: ${state.scope_state.usage.tool_calls_used}/${scope.max_tool_calls} calls, ${state.scope_state.usage.errors_used}/${scope.max_errors} errors, ${state.scope_state.usage.iterations_used}/${scope.max_iterations} turns.`,
    `- Stop conditions: ${scope.stop_conditions.join(" | ") || "none"}.`,
    `- Escalation conditions: ${scope.escalation_conditions.join(" | ") || "none"}.`,
    `- Scope SHA-256: \`${scopeHash}\`.`,
  ];
  if (inline.join("\n").length <= 4_000) return { lines: inline, referenced: false };
  return { lines: [`- Complete active scope, all boundaries, and budgets: ${snapshotRef(snapshot, "state/scope_state/active_scope")}.`, `- Scope SHA-256: \`${scopeHash}\`.`], referenced: true };
}

function artifactLines(snapshot: CheckpointSnapshot): { lines: string[]; referenced: boolean } {
  return arrayLines(snapshot, snapshot.state.files_and_artifacts, "state/files_and_artifacts", "files and artifacts");
}

function validationLines(snapshot: CheckpointSnapshot): { lines: string[]; referenced: boolean } {
  return arrayLines(snapshot, snapshot.state.effective_validation, "state/effective_validation", "validation and gate records");
}

export function checkpointCoverageManifest(snapshot: CheckpointSnapshot, scopeHash: string | undefined): Record<string, unknown> {
  const state = snapshot.state;
  return {
    snapshot_path: snapshot.artifact_path,
    snapshot_sha256: snapshotSha256(snapshot),
    canonical_state_sha256: snapshot.canonical_state_sha256,
    original_sha256: sha256(state.authoritative_instructions.original_user_request.text),
    correction_sha256: state.authoritative_instructions.corrections.map((item) => sha256(item.text)),
    criteria_sha256: sha256(stableStringify(state.criteria)),
    evidence_packs: state.sealed_evidence_packs.map((sealed) => ({
      pack_id: sealed.summary.pack_id,
      sha256: sealed.summary.sha256,
      content_sha256: sealed.content_sha256,
      revision_session_id: sealed.summary.revision_session_id,
      revision_receipt_entry_id: sealed.summary.revision_receipt_entry_id,
      revision_receipt_sha256: sealed.revision_receipt ? sha256(stableStringify(sealed.revision_receipt)) : undefined,
    })),
    decisions_sha256: sha256(stableStringify(state.decisions)),
    unresolved_sha256: sha256(stableStringify({ questions: state.open_questions, errors: state.errors, escalations: state.quality_gate.escalations, approvals: state.scope_state.approvals, scope_changes: state.scope_state.pending_scope_changes })),
    artifacts_sha256: sha256(stableStringify({ files_touched: state.files_touched, receipts: state.execution_receipts.map((item) => ({ id: item.id, artifact_refs: item.artifact_refs, outcome: item.outcome })), evidence: state.evidence_packs.map((item) => item.evidence_path) })),
    validation_sha256: sha256(stableStringify(state.effective_validation)),
    scope_sha256: scopeHash,
    candidate_next_action_sha256: sha256(snapshot.candidate.next_action),
  };
}

function buildContinuationSeed(snapshot: CheckpointSnapshot, summary: ContextCheckpointSummary, markdown: string, config: ReliabilityConfig, requiresSnapshotRead: boolean): string | undefined {
  const state = snapshot.state;
  const base = [
    "[RELIABILITY VALIDATED CONTINUATION]",
    `Task ID: ${state.task_id}`,
    `Checkpoint ID: ${summary.checkpoint_id}`,
    `Target lane: ${summary.to_lane}`,
    `Checkpoint SHA-256: ${summary.artifact_sha256}`,
    `Canonical snapshot: ${snapshot.artifact_path} (sha256 ${summary.snapshot_sha256})`,
    `Original user request SHA-256: ${sha256(state.authoritative_instructions.original_user_request.text)}`,
    `Later authoritative instruction hashes: ${state.authoritative_instructions.corrections.map((item) => sha256(item.text)).join(", ") || "none"}`,
    `Canonical next action: ${snapshot.candidate.next_action}`,
  ];
  const closing = "[/RELIABILITY VALIDATED CONTINUATION]";
  const complete = [...base, "", markdown, closing].join("\n");
  if (complete.length <= config.contextReset.maxContinuationSeedChars && !requiresSnapshotRead) return complete;
  // Generic runtime tools deliberately cannot read task-owned checkpoint state.
  // Do not emit a projection that asks a continuation to acquire inaccessible
  // authority. The coordinator writes a checkpoint-only recovery artifact and
  // retains provider-visible context instead.
  return undefined;
}

export function renderCheckpointSnapshot(snapshot: CheckpointSnapshot, config: ReliabilityConfig): RenderedCheckpoint {
  const state = snapshot.state;
  const candidate = snapshot.candidate;
  const scopeHash = scopeHashForCheckpoint(state);
  const evidencePacks = state.evidence_packs.map((pack) => ({ pack_id: pack.pack_id, sha256: pack.sha256 }));
  const coverage = checkpointCoverageManifest(snapshot, scopeHash);
  const coverageHash = sha256(stableStringify(coverage));
  const summary: ContextCheckpointSummary = {
    checkpoint_id: snapshot.checkpoint_id,
    sequence: snapshot.sequence,
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    from_lane: candidate.from_lane,
    to_lane: candidate.to_lane,
    phase_id: candidate.phase_id,
    artifact_path: checkpointDisplayPath(state, snapshot.sequence, candidate.from_lane, candidate.to_lane),
    artifact_sha256: "0".repeat(64),
    snapshot_path: snapshot.artifact_path,
    snapshot_sha256: snapshotSha256(snapshot),
    canonical_state_sha256: snapshot.canonical_state_sha256,
    scope_sha256: scopeHash,
    candidate_next_action_sha256: sha256(candidate.next_action),
    evidence_packs: evidencePacks,
    context_epoch_before: state.context_epoch,
    trigger: candidate.trigger,
    status: "written",
    created_at: snapshot.captured_at,
    session_id: state.current_session.session_id,
    session_anchor_entry_id: state.current_session.branch_entry_ids.at(-1),
  };
  const original = requiredValue(snapshot, state.authoritative_instructions.original_user_request.text, "state/authoritative_instructions/original_user_request/text");
  const corrections = state.authoritative_instructions.corrections.map((instruction, index) => requiredValue(snapshot, instruction.text, `state/authoritative_instructions/corrections/${index}/text`));
  const objective = optionalValue(snapshot, state.user_goal, "state/user_goal");
  const criteria = criteriaLines(snapshot);
  const findings = materialFindings(snapshot);
  const unresolved = unresolvedLines(snapshot);
  const decisions = arrayLines(snapshot, state.decisions, "state/decisions", "decisions and rejected alternatives");
  const scope = scopeLines(snapshot, scopeHash);
  const artifacts = artifactLines(snapshot);
  const validation = validationLines(snapshot);
  const requiresSnapshotRead = [original, ...corrections, objective, criteria, findings, unresolved, decisions, scope, artifacts, validation].some((item) => item.referenced);
  const lines = [
    "# Context checkpoint",
    "",
    "## Identity",
    `- Task ID: \`${state.task_id}\``,
    `- Checkpoint ID: \`${summary.checkpoint_id}\``,
    `- Schema version: ${CHECKPOINT_SCHEMA_VERSION}`,
    `- Source lane: ${summary.from_lane}; target lane: ${summary.to_lane}`,
    `- Phase ID: \`${summary.phase_id}\``,
    `- Context epoch: ${summary.context_epoch_before}`,
    `- Created at: ${summary.created_at}`,
    `- Task branch: \`${state.task_identity.branch_id}\``,
    "",
    "## Original user request",
    ...original.lines,
    "",
    "## Later authoritative user instructions",
    ...(corrections.length ? corrections.flatMap((entry, index) => [`- Instruction ${index + 1}; origin: ${state.authoritative_instructions.corrections[index].origin}; session reference: ${state.authoritative_instructions.corrections[index].session_entry_id ?? "unavailable"}.`, ...entry.lines]) : ["- None recorded."]),
    "",
    "## Current objective and success criteria",
    `- Objective: ${objective.text}`,
    ...criteria.lines,
    "",
    "## Material findings",
    ...findings.lines,
    "",
    "## Conflicts, unknowns, and pending decisions",
    ...unresolved.lines,
    "",
    "## Decisions and rejected alternatives",
    ...decisions.lines,
    "",
    "## Active scope and safety boundaries",
    ...scope.lines,
    "",
    "## Files and artifacts",
    ...artifacts.lines,
    "",
    "## Validation and gate state",
    ...validation.lines,
    "",
    "## Next action",
    `- ${candidate.next_action}`,
    "",
    "## Recovery references",
    `- Previous context epoch: ${state.context_epoch}.`,
    `- Pi session: ${state.current_session.session_id ?? "unavailable"}; task branch anchor: ${state.task_identity.session_anchor_entry_id ?? "unavailable"}.`,
    `- Current branch entries: ${state.current_session.branch_entry_ids.join(", ") || "none"}.`,
    `- Evidence packs: ${evidencePacks.map((pack) => `${pack.pack_id}:${pack.sha256}`).join(", ") || "none"}.`,
    `- Prior checkpoint: ${state.active_checkpoint_id ?? "none"}.`,
    `- Immutable canonical snapshot: \`${summary.snapshot_path}\` (SHA-256: \`${summary.snapshot_sha256}\`).`,
    "",
    "## Integrity manifest",
    `- Canonical state SHA-256: \`${summary.canonical_state_sha256}\``,
    `- Evidence pack hashes: \`${stableStringify(evidencePacks)}\``,
    `- Scope SHA-256: \`${scopeHash ?? "none"}\``,
    `- Checkpoint artifact path: \`${summary.artifact_path}\` (hash is reopened and recorded in task state).`,
    `- Snapshot coverage SHA-256: \`${coverageHash}\``,
  ];
  const markdown = `${lines.join("\n")}\n`;
  if (markdown.length > config.contextReset.maxCheckpointChars) throw new Error(`Checkpoint exceeds the configured ${config.contextReset.maxCheckpointChars}-character budget; no required field was truncated.`);
  summary.artifact_sha256 = sha256(markdown);
  const continuationSeed = buildContinuationSeed(snapshot, summary, markdown, config, requiresSnapshotRead);
  const continuationSeedAvailable = continuationSeed !== undefined;
  const continuationManifest = stableStringify({
    task_id: state.task_id,
    checkpoint_id: summary.checkpoint_id,
    target_lane: summary.to_lane,
    checkpoint_sha256: summary.artifact_sha256,
    snapshot_sha256: summary.snapshot_sha256,
    scope_sha256: summary.scope_sha256,
    next_action_sha256: summary.candidate_next_action_sha256,
    seed_sha256: sha256(continuationSeed ?? ""),
    seed: continuationSeed ?? "",
  });
  return {
    snapshot,
    summary,
    markdown,
    continuation_seed: continuationSeed ?? "",
    continuation_seed_sha256: sha256(continuationSeed ?? ""),
    continuation_seed_available: continuationSeedAvailable,
    continuation_manifest: continuationManifest,
    continuation_manifest_sha256: sha256(continuationManifest),
  };
}

/** Compatibility helper for deterministic rendering tests; production writes the returned snapshot first. */
export function renderCheckpoint(state: TaskState, candidate: ContextResetCandidate, config: ReliabilityConfig, now = new Date()): RenderedCheckpoint {
  return renderCheckpointSnapshot(createCheckpointSnapshot(state, candidate, state.id_counters.next_checkpoint, now), config);
}
