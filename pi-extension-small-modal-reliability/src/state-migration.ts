import { CODING_REVIEW_KINDS } from "./types.ts";
import type {
  ApprovalRequest,
  AdvisorAdviceRecord,
  AdvisorReservation,
  AdvisorState,
  CompletionGateRecord,
  Criterion,
  CriterionResult,
  EvidenceAssessmentSummary,
  EvidenceFreshnessPolicy,
  EvidencePackSummary,
  EvidenceRevisionReceipt,
  OutputContractReceipt,
  OutputValidationReceipt,
  QualityGateResolutionReceipt,
  StructuredOutputContract,
  StructuredOutputContractDefinition,
  StructuredOutputState,
  StructuredOutputValidation,
  QualityGateAssessment,
  QualityGateClaim,
  QualityGateEscalation,
  QualityGateResolution,
  QualityGateState,
  ExecutionReceipt,
  ExecutionScope,
  ModelVerificationClaim,
  PendingToolCall,
  RecoveryState,
  ScopeChangeRequest,
  ScopeFreshRead,
  ScopeState,
  DependencyEvidence,
  PlanExitCondition,
  PlanStepScope,
  WorkingContext,
  WorkingContextEntry,
  AuthoritativeInstruction,
  AuthoritativeInstructions,
  CodingBoundary,
  CodingReviewDisposition,
  ContextCheckpointSummary,
  ContextResetCandidate,
  ContextResetState,
  ScopeApprovalReceipt,
  ScopeAuthorizationReceipt,
  SessionBranchIdentity,
  StateMigration,
  TaskIdentity,
  TaskState,
  TaskStateV1,
  TrustedCheckMapping,
  WorkspaceRevision,
} from "./types.ts";
import { captureWorkspaceRevision, workspaceBranchIdentity } from "./workspace-revision.ts";
import { createScopeState } from "./scope-state.ts";
import { createContextResetState } from "./checkpoint-contracts.ts";
import { createAuthoritativeInstructions, createWorkingContext } from "./working-context.ts";
import { createStructuredOutputState } from "./structured-output.ts";
import { stableStringify } from "./utils.ts";
import { createHash } from "node:crypto";

const MAX_USER_CRITERIA = 8;
const MAX_CRITERIA = MAX_USER_CRITERIA + CODING_REVIEW_KINDS.length;
const CRITERION_EVIDENCE = new Set(["behavior", "validation", "artifact", "user-attestation"]);
const TASK_STATUSES = new Set(["planning", "executing", "blocked", "verifying", "complete", "failed"]);
const VERIFICATION_STATUSES = new Set(["passed", "failed", "unknown"]);
const EXECUTION_OUTCOMES = new Set(["success", "error", "cancelled", "blocked", "unknown"]);
const HOST_PROVENANCE = new Set(["pi-builtin-bash", "host-tool", "unknown"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function unique(values: string[]): boolean {
  return new Set(values).size === values.length;
}

function numberedId(value: unknown, prefix: string): value is string {
  return typeof value === "string" && new RegExp(`^${prefix}[1-9][0-9]*$`).test(value);
}

function isWorkspaceRevision(value: unknown): value is WorkspaceRevision {
  if (!isRecord(value)) return false;
  return isNonEmptyString(value.digest)
    && typeof value.inventory_complete === "boolean"
    && isNonEmptyString(value.observed_at)
    && isFiniteNumber(value.file_count)
    && isFiniteNumber(value.directory_count)
    && isFiniteNumber(value.total_bytes)
    && (value.git_head === undefined || typeof value.git_head === "string")
    && (value.git_branch === undefined || typeof value.git_branch === "string")
    && (value.reason === undefined || typeof value.reason === "string");
}

function isCriterion(value: unknown): value is Criterion {
  return isRecord(value)
    && numberedId(value.id, "C")
    && isNonEmptyString(value.requirement)
    && typeof value.expected_evidence === "string"
    && CRITERION_EVIDENCE.has(value.expected_evidence)
    && typeof value.required === "boolean"
    && (value.origin === undefined || value.origin === "user" || value.origin === "host-coding-review");
}

function isPlan(value: unknown): boolean {
  return Array.isArray(value) && value.every((step) => isRecord(step)
    && isNonEmptyString(step.step_id)
    && isNonEmptyString(step.title)
    && typeof step.description === "string"
    && typeof step.status === "string"
    && isStringArray(step.depends_on)
    && typeof step.expected_output === "string"
    && typeof step.verification === "string");
}

function isPlanScope(value: unknown): value is PlanStepScope {
  return isRecord(value)
    && isStringArray(value.allowed_tools) && value.allowed_tools.length <= 24 && unique(value.allowed_tools)
    && isStringArray(value.allowed_read_paths) && value.allowed_read_paths.length <= 32 && unique(value.allowed_read_paths)
    && isStringArray(value.allowed_write_paths) && value.allowed_write_paths.length <= 32 && unique(value.allowed_write_paths);
}

function isPlanExitCondition(value: unknown): value is PlanExitCondition {
  return isRecord(value)
    && (value.kind === "observed-tool-result" || value.kind === "criteria-passed" || value.kind === "artifact-produced")
    && isNonEmptyString(value.description)
    && (value.criterion_ids === undefined || isStringArray(value.criterion_ids))
    && (value.artifact_refs === undefined || isStringArray(value.artifact_refs));
}

function isExecutablePlan(value: unknown): boolean {
  return isPlan(value) && (value as Record<string, unknown>[]).every((step) => Array.isArray(step.exit_conditions)
    && isArrayOf(step.exit_conditions, isPlanExitCondition)
    && (step.allowed_scope === undefined || isPlanScope(step.allowed_scope))
    && isStringArray(step.exit_evidence_receipt_ids)
    && isStringArray(step.exit_evidence_artifact_refs));
}

function isToolHistory(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && isNonEmptyString(item.timestamp)
    && isNonEmptyString(item.tool)
    && isNonEmptyString(item.arguments_hash)
    && typeof item.arguments_preview === "string"
    && typeof item.status === "string");
}

function isVerificationHistory(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => isRecord(item)
    && typeof item.criterion === "string"
    && typeof item.status === "string"
    && typeof item.evidence === "string"
    && typeof item.remaining_work === "string"
    && typeof item.source === "string"
    && isNonEmptyString(item.updated_at));
}

function isArrayOf<T>(value: unknown, guard: (item: unknown) => item is T): value is T[] {
  return Array.isArray(value) && value.every(guard);
}

function isTaskIdentity(value: unknown): value is TaskIdentity {
  return isRecord(value)
    && isNonEmptyString(value.task_id)
    && isNonEmptyString(value.branch_id)
    && isNonEmptyString(value.created_workspace_revision)
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id));
}

function isEvidenceRevisionReceipt(value: unknown): value is EvidenceRevisionReceipt {
  return isRecord(value)
    && isNonEmptyString(value.entry_id)
    && isNonEmptyString(value.task_id)
    && numberedId(value.pack_id, "E")
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && (value.action === "start" || value.action === "add-source" || value.action === "add-claim"
      || value.action === "disposition-conflict" || value.action === "record-dependency" || value.action === "assess" || value.action === "get");
}

function isOutputContractReceipt(value: unknown): value is OutputContractReceipt {
  return isRecord(value)
    && isNonEmptyString(value.entry_id)
    && isNonEmptyString(value.task_id)
    && /^OC[1-9][0-9]*$/.test(String(value.contract_id))
    && typeof value.contract_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.contract_sha256)
    && typeof value.definition_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.definition_sha256)
    && isNonEmptyString(value.contract_path)
    && typeof value.receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.receipt_hash);
}

function isOutputValidationReceipt(value: unknown): value is OutputValidationReceipt {
  return isRecord(value)
    && isNonEmptyString(value.entry_id)
    && isNonEmptyString(value.task_id)
    && /^OV[1-9][0-9]*$/.test(String(value.validation_id))
    && /^OC[1-9][0-9]*$/.test(String(value.contract_id))
    && typeof value.contract_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.contract_sha256)
    && typeof value.candidate_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.candidate_sha256)
    && typeof value.result_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.result_sha256)
    && typeof value.receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.receipt_hash);
}

function isQualityGateResolutionReceipt(value: unknown): value is QualityGateResolutionReceipt {
  return isRecord(value)
    && isNonEmptyString(value.entry_id)
    && isNonEmptyString(value.task_id)
    && /^QGR[1-9][0-9]*$/.test(String(value.resolution_id))
    && (value.target_kind === "escalation" || value.target_kind === "semantic-review")
    && isNonEmptyString(value.target_id)
    && (value.contract_id === undefined || /^OC[1-9][0-9]*$/.test(String(value.contract_id)))
    && (value.candidate_sha256 === undefined || typeof value.candidate_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.candidate_sha256))
    && (value.decision === "approved" || value.decision === "rejected")
    && typeof value.receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.receipt_hash);
}

function isScopeAuthorizationReceipt(value: unknown): value is ScopeAuthorizationReceipt {
  return isRecord(value)
    && isNonEmptyString(value.entry_id)
    && isNonEmptyString(value.task_id)
    && numberedId(value.scope_change_id, "SC")
    && typeof value.scope_hash === "string" && /^[a-f0-9]{64}$/.test(value.scope_hash)
    && typeof value.receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.receipt_hash);
}

function isScopeApprovalReceipt(value: unknown): value is ScopeApprovalReceipt {
  return isRecord(value)
    && isNonEmptyString(value.entry_id)
    && isNonEmptyString(value.task_id)
    && numberedId(value.approval_id, "A")
    && typeof value.scope_hash === "string" && /^[a-f0-9]{64}$/.test(value.scope_hash)
    && typeof value.normalized_effect_hash === "string" && /^[a-f0-9]{16}$/.test(value.normalized_effect_hash)
    && typeof value.receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.receipt_hash);
}

function isSessionBranchIdentity(value: unknown): value is SessionBranchIdentity {
  return isRecord(value)
    && isStringArray(value.branch_entry_ids)
    && (value.evidence_revision_receipts === undefined || isArrayOf(value.evidence_revision_receipts, isEvidenceRevisionReceipt))
    && (value.evidence_revision_receipts === undefined
      || unique(value.evidence_revision_receipts.map((receipt) => receipt.entry_id)))
    && (value.output_contract_receipts === undefined || isArrayOf(value.output_contract_receipts, isOutputContractReceipt))
    && (value.output_contract_receipts === undefined || unique(value.output_contract_receipts.map((receipt) => receipt.entry_id)))
    && (value.output_validation_receipts === undefined || isArrayOf(value.output_validation_receipts, isOutputValidationReceipt))
    && (value.output_validation_receipts === undefined || unique(value.output_validation_receipts.map((receipt) => receipt.entry_id)))
    && (value.quality_gate_resolution_receipts === undefined || isArrayOf(value.quality_gate_resolution_receipts, isQualityGateResolutionReceipt))
    && (value.quality_gate_resolution_receipts === undefined || unique(value.quality_gate_resolution_receipts.map((receipt) => receipt.entry_id)))
    && (value.scope_authorization_receipts === undefined || isArrayOf(value.scope_authorization_receipts, isScopeAuthorizationReceipt))
    && (value.scope_approval_receipts === undefined || isArrayOf(value.scope_approval_receipts, isScopeApprovalReceipt))
    && (value.input_authority_receipts === undefined || isArrayOf(value.input_authority_receipts, (receipt): receipt is NonNullable<SessionBranchIdentity["input_authority_receipts"]>[number] => isRecord(receipt)
      && isNonEmptyString(receipt.entry_id) && isNonEmptyString(receipt.task_id)
      && (receipt.origin === "user-command" || receipt.origin === "native-confirmation")
      && typeof receipt.text_sha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.text_sha256)))
    && (value.input_authority_receipts === undefined || unique(value.input_authority_receipts.map(receipt => receipt.entry_id)))
    && isNonEmptyString(value.observed_at)
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.lifecycle_identity === undefined || value.lifecycle_identity === "available" || value.lifecycle_identity === "unavailable");
}

function isTrustedCheckMapping(value: unknown): value is TrustedCheckMapping {
  return isRecord(value)
    && numberedId(value.id, "M")
    && isNonEmptyString(value.criterion_id)
    && isNonEmptyString(value.operation)
    && (value.command === undefined || typeof value.command === "string")
    && (value.created_by === "host" || value.created_by === "user-command")
    && isNonEmptyString(value.created_at);
}

function isReadTargetObservations(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 4 && value.every((target) => {
    if (!isRecord(target)
      || !isNonEmptyString(target.path)
      || typeof target.content_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(target.content_sha256)
      || !isFiniteNumber(target.content_bytes) || (target.content_bytes as number) < 0
      || typeof target.full_coverage !== "boolean") return false;
    if (target.full_coverage) return target.inspected_span === undefined;
    const span = target.inspected_span;
    return isRecord(span)
      && isPositiveSafeInteger(span.start_line)
      && isPositiveSafeInteger(span.end_line)
      && (span.end_line as number) >= (span.start_line as number)
      && typeof span.content_sha256 === "string" && /^[a-f0-9]{64}$/.test(span.content_sha256);
  });
}

function isPendingToolCall(value: unknown): value is PendingToolCall {
  return isRecord(value)
    && isNonEmptyString(value.tool_call_id)
    && isNonEmptyString(value.batch_id)
    && isNonEmptyString(value.operation)
    && isNonEmptyString(value.started_at)
    && isNonEmptyString(value.workspace_revision_before)
    && isNonEmptyString(value.input_hash)
    && typeof value.host_provenance === "string" && HOST_PROVENANCE.has(value.host_provenance)
    && (value.read_targets === undefined || isReadTargetObservations(value.read_targets))
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id));
}

function isExecutionReceipt(value: unknown): value is ExecutionReceipt {
  return isRecord(value)
    && numberedId(value.id, "R")
    && isNonEmptyString(value.task_id)
    && isNonEmptyString(value.branch_id)
    && isNonEmptyString(value.batch_id)
    && isNonEmptyString(value.operation)
    && isNonEmptyString(value.input_hash)
    && typeof value.outcome === "string" && EXECUTION_OUTCOMES.has(value.outcome)
    && typeof value.execution_observed === "boolean"
    && typeof value.host_provenance === "string" && HOST_PROVENANCE.has(value.host_provenance)
    && isNonEmptyString(value.cwd)
    && isNonEmptyString(value.workspace_revision_before)
    && isNonEmptyString(value.workspace_revision_after)
    && isStringArray(value.criterion_ids)
    && (value.validation_status === undefined || value.validation_status === "passed" || value.validation_status === "failed" || value.validation_status === "unknown")
    && isStringArray(value.artifact_refs)
    && (value.resource_refs === undefined || isStringArray(value.resource_refs))
    && (value.read_targets === undefined || isReadTargetObservations(value.read_targets))
    && typeof value.batch_settled === "boolean"
    && isNonEmptyString(value.started_at)
    && isNonEmptyString(value.finished_at)
    && (value.tool_call_id === undefined || isNonEmptyString(value.tool_call_id))
    && (value.step_id === undefined || isNonEmptyString(value.step_id))
    && (value.command === undefined || typeof value.command === "string")
    && (value.exit_code === undefined || isFiniteNumber(value.exit_code))
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id))
    && (value.result_is_error === undefined || typeof value.result_is_error === "boolean");
}

function isCriterionResult(value: unknown): value is CriterionResult {
  return isRecord(value)
    && isNonEmptyString(value.criterion_id)
    && typeof value.status === "string" && VERIFICATION_STATUSES.has(value.status)
    && isStringArray(value.receipt_ids)
    && isNonEmptyString(value.checked_workspace_revision)
    && typeof value.fresh === "boolean"
    && (value.provenance === "runtime" || value.provenance === "user" || value.provenance === "model" || value.provenance === "legacy")
    && isNonEmptyString(value.recorded_at)
    && typeof value.evidence === "string"
    && typeof value.remaining_work === "string"
    && (value.attestation_id === undefined || isNonEmptyString(value.attestation_id))
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id));
}

function isModelVerificationClaim(value: unknown): value is ModelVerificationClaim {
  return isRecord(value)
    && typeof value.status === "string" && VERIFICATION_STATUSES.has(value.status)
    && typeof value.evidence === "string"
    && typeof value.remaining_work === "string"
    && isNonEmptyString(value.recorded_at)
    && (value.criterion_id === undefined || isNonEmptyString(value.criterion_id))
    && (value.criterion_text === undefined || typeof value.criterion_text === "string");
}

function isCompletionGate(value: unknown): value is CompletionGateRecord {
  return isRecord(value)
    && numberedId(value.id, "G")
    && (value.source === "verify-tool" || value.source === "worker-result" || value.source === "progress-tool" || value.source === "agent-end" || value.source === "plan-mode" || value.source === "message-end" || value.source === "explicit" || value.source === "gate-tool")
    && (value.decision === "pass" || value.decision === "fail" || value.decision === "escalate")
    && isStringArray(value.reasons)
    && isNonEmptyString(value.checked_workspace_revision)
    && isNonEmptyString(value.created_at);
}

function isRecoveryState(value: unknown): value is RecoveryState {
  return isRecord(value)
    && isFiniteNumber(value.total_attempts)
    && isFiniteNumber(value.total_actions)
    && Array.isArray(value.episodes)
    && value.episodes.every((episode) => isRecord(episode)
      && typeof episode.workspace_revision === "string"
      && typeof episode.failure_signature === "string"
      && isFiniteNumber(episode.attempts)
      && isFiniteNumber(episode.actions)
      && isNonEmptyString(episode.started_at)
      && isNonEmptyString(episode.last_attempt_at)
      && (episode.step_id === undefined || typeof episode.step_id === "string"));
}

function isStateMigration(value: unknown): value is StateMigration {
  return isRecord(value)
    && (value.source_schema_version === 1 || value.source_schema_version === 2)
    && typeof value.backup_pending === "boolean"
    && (value.backup_path === undefined || isNonEmptyString(value.backup_path))
    && (value.migrated_at === undefined || isNonEmptyString(value.migrated_at))
    && (value.event_pending === undefined || typeof value.event_pending === "boolean");
}

function isEvidenceFreshnessPolicy(value: unknown): value is EvidenceFreshnessPolicy {
  return isRecord(value)
    && isPositiveSafeInteger(value.max_age_days)
    && value.max_age_days <= 36_500
    && (value.basis === "publishedAt" || value.basis === "retrievedAt");
}

function isEvidenceAssessmentSummary(value: unknown): value is EvidenceAssessmentSummary {
  return isRecord(value)
    && (value.outcome === "supported" || value.outcome === "partial" || value.outcome === "conflicting" || value.outcome === "insufficient")
    && typeof value.integrity_passed === "boolean"
    && typeof value.semantic_review_required === "boolean"
    && (value.freshness_status === "not-constrained" || value.freshness_status === "fresh" || value.freshness_status === "stale" || value.freshness_status === "unknown")
    && isStringArray(value.unresolved_conflict_claim_ids)
    && isStringArray(value.unsupported_material_claim_ids)
    && isFiniteNumber(value.issue_count)
    && isNonEmptyString(value.assessed_at);
}

function isCodingReviewDisposition(value: unknown): value is CodingReviewDisposition {
  return isRecord(value)
    && CODING_REVIEW_KINDS.some((kind) => kind === value.kind)
    && typeof value.diff_hash === "string" && /^[a-f0-9]{64}$/.test(value.diff_hash)
    && (value.status === "pending" || value.status === "attested" || value.status === "superseded")
    && numberedId(value.criterion_id, "C")
    && (value.attestation_id === undefined || isNonEmptyString(value.attestation_id))
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id))
    && (value.superseded_at === undefined || isNonEmptyString(value.superseded_at));
}

function isCodingBoundary(value: unknown): value is CodingBoundary {
  return isRecord(value)
    && (value.status === "pending" || value.status === "captured" || value.status === "missing")
    && isNonEmptyString(value.task_id)
    && isNonEmptyString(value.branch_id)
    && isStringArray(value.allowed_write_paths) && value.allowed_write_paths.length <= 32
    && (value.baseline_path === undefined || value.baseline_path === "coding-baseline.json")
    && (value.baseline_sha256 === undefined || typeof value.baseline_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.baseline_sha256))
    && (value.baseline_workspace_revision === undefined || typeof value.baseline_workspace_revision === "string" && /^[a-f0-9]{64}$/.test(value.baseline_workspace_revision))
    && (value.scope_id === undefined || numberedId(value.scope_id, "S"))
    && (value.scope_hash === undefined || typeof value.scope_hash === "string" && /^[a-f0-9]{64}$/.test(value.scope_hash))
    && (value.captured_at === undefined || isNonEmptyString(value.captured_at))
    && (value.reason === undefined || typeof value.reason === "string")
    && (value.review_dispositions === undefined || isArrayOf(value.review_dispositions, isCodingReviewDisposition))
    && (value.repair_intervals === undefined || Array.isArray(value.repair_intervals) && value.repair_intervals.every((interval) => isRecord(interval)
      && numberedId(interval.failure_receipt_id, "R")
      && typeof interval.failure_revision === "string" && /^[a-f0-9]{64}$/.test(interval.failure_revision)
      && (interval.step_id === undefined || isNonEmptyString(interval.step_id))
      && (interval.repair_receipt_ids === undefined || isStringArray(interval.repair_receipt_ids) && interval.repair_receipt_ids.every((id) => numberedId(id, "R")) && interval.repair_receipt_ids.length <= 120)
      && (interval.cycles === undefined || Array.isArray(interval.cycles) && interval.cycles.length <= 2 && interval.cycles.every((cycle) => isRecord(cycle)
        && numberedId(cycle.started_by_receipt_id, "R")
        && isStringArray(cycle.mutation_receipt_ids) && cycle.mutation_receipt_ids.length > 0 && cycle.mutation_receipt_ids.length <= 120 && cycle.mutation_receipt_ids.every((id) => numberedId(id, "R"))
        && isNonEmptyString(cycle.started_at)
        && (cycle.closed_by_receipt_id === undefined || numberedId(cycle.closed_by_receipt_id, "R"))
        && (cycle.outcome === undefined || cycle.outcome === "failed" || cycle.outcome === "passed")
        && (cycle.closed_at === undefined || isNonEmptyString(cycle.closed_at))))
      && isNonEmptyString(interval.opened_at)
      && (interval.closed_by_receipt_id === undefined || numberedId(interval.closed_by_receipt_id, "R"))
      && (interval.closed_at === undefined || isNonEmptyString(interval.closed_at))));
}

function isDependencyEvidence(value: unknown): value is DependencyEvidence {
  return isRecord(value)
    && numberedId(value.pack_id, "E")
    && isNonEmptyString(value.package_name)
    && isNonEmptyString(value.installed_version)
    && isNonEmptyString(value.manifest_path)
    && (value.lockfile_path === undefined || isNonEmptyString(value.lockfile_path))
    && (value.source_kind === "installed-source" || value.source_kind === "installed-types" || value.source_kind === "official-versioned-docs" || value.source_kind === "official-tag")
    && isNonEmptyString(value.source_id)
    && isStringArray(value.passage_ids) && value.passage_ids.length > 0 && value.passage_ids.length <= 4 && unique(value.passage_ids)
    && isStringArray(value.feature_flags) && value.feature_flags.length <= 12 && unique(value.feature_flags)
    && (value.status === "verified" || value.status === "unknown")
    && isStringArray(value.reasons) && value.reasons.length <= 12
    && (value.manifest_receipt_id === undefined || numberedId(value.manifest_receipt_id, "R"))
    && (value.lockfile_receipt_id === undefined || numberedId(value.lockfile_receipt_id, "R"))
    && (value.source_content_sha256 === undefined || typeof value.source_content_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.source_content_sha256))
    && (value.source_receipt_id === undefined || numberedId(value.source_receipt_id, "R"))
    && isNonEmptyString(value.recorded_at);
}

function isAuthoritativeInstruction(value: unknown): value is AuthoritativeInstruction {
  return isRecord(value)
    && typeof value.text === "string" && value.text.length > 0
    && (value.origin === "interactive" || value.origin === "rpc" || value.origin === "user-command" || value.origin === "native-confirmation")
    && isNonEmptyString(value.recorded_at)
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_entry_id === undefined || isNonEmptyString(value.session_entry_id))
    && (value.origin !== "native-confirmation" || isNonEmptyString(value.session_id) && isNonEmptyString(value.session_entry_id));
}

function isAuthoritativeInstructions(value: unknown): value is AuthoritativeInstructions {
  return isRecord(value)
    && isAuthoritativeInstruction(value.original_user_request)
    && isArrayOf(value.corrections, isAuthoritativeInstruction);
}

function isWorkingContextEntry(value: unknown): value is WorkingContextEntry {
  return isRecord(value)
    && isNonEmptyString(value.text)
    && isNonEmptyString(value.recorded_at)
    && isStringArray(value.evidence_refs);
}

function isWorkingContext(value: unknown): value is WorkingContext {
  return isRecord(value)
    && isArrayOf(value.observations, isWorkingContextEntry)
    && isArrayOf(value.claims, isWorkingContextEntry)
    && isArrayOf(value.hypotheses, isWorkingContextEntry)
    && value.observations.length <= 40
    && value.claims.length <= 40
    && value.hypotheses.length <= 40;
}

function isEvidencePackSummary(value: unknown): value is EvidencePackSummary {
  return isRecord(value)
    && numberedId(value.pack_id, "E")
    && isNonEmptyString(value.task_id)
    && isNonEmptyString(value.branch_id)
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id))
    && (value.revision_session_id === undefined || isNonEmptyString(value.revision_session_id))
    && (value.revision_receipt_entry_id === undefined || isNonEmptyString(value.revision_receipt_entry_id))
    && (value.revision_session_id === undefined) === (value.revision_receipt_entry_id === undefined)
    && isNonEmptyString(value.question)
    && value.evidence_path === `evidence/${value.pack_id}.json`
    && typeof value.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.sha256)
    && isFiniteNumber(value.source_count) && value.source_count >= 0 && value.source_count <= 12
    && isFiniteNumber(value.passage_count) && value.passage_count >= 0 && value.passage_count <= 24
    && isFiniteNumber(value.claim_count) && value.claim_count >= 0 && value.claim_count <= 30
    && (value.freshness === undefined || isEvidenceFreshnessPolicy(value.freshness))
    && (value.assessment === undefined || isEvidenceAssessmentSummary(value.assessment))
    && isNonEmptyString(value.created_at)
    && isNonEmptyString(value.updated_at);
}

function isJsonSchemaSubset(value: unknown, depth = 0): boolean {
  if (!isRecord(value) || depth > 8) return false;
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"]);
  if (Object.keys(value).length === 0 || Object.keys(value).some((key) => !allowed.has(key))) return false;
  if (value.type !== undefined && !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(value.type))) return false;
  if (value.properties !== undefined) {
    if (!isRecord(value.properties) || Object.keys(value.properties).length > 64
      || !Object.entries(value.properties).every(([key, child]) => /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) && isJsonSchemaSubset(child, depth + 1))) return false;
  }
  if (value.required !== undefined && (!isStringArray(value.required) || value.required.length === 0 || value.required.length > 64 || !unique(value.required))) return false;
  if (value.required !== undefined && value.properties !== undefined && !(value.required as string[]).every((key) => Object.hasOwn(value.properties as Record<string, unknown>, key))) return false;
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") return false;
  if (value.items !== undefined && !isJsonSchemaSubset(value.items, depth + 1)) return false;
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0 || value.enum.length > 64
    || !value.enum.every((item) => item === null || typeof item === "string" || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)))) return false;
  for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) {
    if (value[key] !== undefined && (!isFiniteNumber(value[key]) || !Number.isSafeInteger(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 1_000)) return false;
  }
  for (const key of ["minimum", "maximum"]) if (value[key] !== undefined && !isFiniteNumber(value[key])) return false;
  return true;
}

function isStructuredOutputDefinition(value: unknown): value is StructuredOutputContractDefinition {
  if (!isRecord(value) || (value.semantic !== "structural-only" && value.semantic !== "human-review-required")) return false;
  if (value.format === "json") return Object.keys(value).length === 3 && isJsonSchemaSubset(value.schema);
  if (value.format === "csv") return Object.keys(value).length === 6
    && isStringArray(value.columns) && value.columns.length > 0 && value.columns.length <= 64 && unique(value.columns)
    && typeof value.hasHeader === "boolean"
    && isPositiveSafeInteger(value.maxRows) && isFiniteNumber(value.minRows) && Number.isSafeInteger(value.minRows) && (value.minRows as number) >= 0 && (value.minRows as number) <= (value.maxRows as number) && (value.maxRows as number) <= 1_000;
  if (value.format === "enum") return Object.keys(value).length === 3 && isStringArray(value.values) && value.values.length > 0 && value.values.length <= 64 && unique(value.values);
  if (value.format === "bounded-string") return Object.keys(value).length === 4
    && isFiniteNumber(value.minLength) && Number.isSafeInteger(value.minLength) && (value.minLength as number) >= 0
    && isPositiveSafeInteger(value.maxLength) && (value.maxLength as number) <= 50_000 && (value.minLength as number) <= (value.maxLength as number);
  if (value.format === "markdown-checklist") return Object.keys(value).length === 4
    && Array.isArray(value.items) && value.items.length > 0 && value.items.length <= 64
    && value.items.every((item) => isRecord(item) && Object.keys(item).length === 2 && isNonEmptyString(item.text) && typeof item.checked === "boolean")
    && unique((value.items as Array<{ text: string }>).map((item) => item.text))
    && typeof value.allowExtraItems === "boolean";
  return false;
}

function isStructuredOutputContract(value: unknown): value is StructuredOutputContract {
  return isRecord(value)
    && value.schema_version === 1
    && /^OC[1-9][0-9]*$/.test(String(value.contract_id))
    && isNonEmptyString(value.task_id)
    && isNonEmptyString(value.branch_id)
    && isNonEmptyString(value.contract_path)
    && typeof value.contract_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.contract_sha256)
    && typeof value.definition_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.definition_sha256)
    && isStructuredOutputDefinition(value.definition)
    && value.definition_sha256 === createHash("sha256").update(stableStringify(value.definition)).digest("hex")
    && isNonEmptyString(value.created_at)
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id))
    && (value.receipt_hash === undefined || typeof value.receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.receipt_hash))
    && (value.session_id === undefined) === (value.session_anchor_entry_id === undefined)
    && (value.session_id === undefined) === (value.receipt_hash === undefined);
}

function isStructuredOutputValidation(value: unknown): value is StructuredOutputValidation {
  return isRecord(value)
    && /^OV[1-9][0-9]*$/.test(String(value.id))
    && isNonEmptyString(value.task_id)
    && isNonEmptyString(value.branch_id)
    && /^OC[1-9][0-9]*$/.test(String(value.contract_id))
    && ["contract_sha256", "candidate_sha256", "result_sha256"].every((key) => typeof value[key] === "string" && /^[a-f0-9]{64}$/.test(value[key] as string))
    && value.validator_version === "structured-output-v1"
    && isFiniteNumber(value.candidate_chars) && Number.isSafeInteger(value.candidate_chars) && value.candidate_chars >= 0 && value.candidate_chars <= 50_000
    && isPositiveSafeInteger(value.attempt) && value.attempt <= 3
    && typeof value.syntax_valid === "boolean"
    && typeof value.schema_valid === "boolean"
    && (value.semantic_check_state === "not-required" || value.semantic_check_state === "review-required" || value.semantic_check_state === "attested")
    && typeof value.semantic_checks_passed === "boolean"
    && typeof value.human_review_required === "boolean"
    && (value.decision === "pass" || value.decision === "fail" || value.decision === "escalate")
    && isStringArray(value.reasons) && value.reasons.length <= 16
    && isNonEmptyString(value.validated_at)
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id))
    && (value.receipt_hash === undefined || typeof value.receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.receipt_hash))
    && (value.session_id === undefined) === (value.session_anchor_entry_id === undefined)
    && (value.session_id === undefined) === (value.receipt_hash === undefined)
    && (value.superseded_by_contract_id === undefined || typeof value.superseded_by_contract_id === "string" && /^OC[1-9][0-9]*$/.test(value.superseded_by_contract_id));
}

function isStructuredOutputState(value: unknown): value is StructuredOutputState {
  if (!isRecord(value)) return false;
  const contracts = value.contracts;
  const validations = value.validations;
  const used = value.total_candidates_used;
  if (!isArrayOf(contracts, isStructuredOutputContract)
    || !isArrayOf(validations, isStructuredOutputValidation)
    || contracts.length > 12
    || validations.length > 12
    || !isFiniteNumber(used) || !Number.isSafeInteger(used) || used < 0 || used > 3
    || validations.length > used
    || (value.active_contract_id !== undefined && (!/^OC[1-9][0-9]*$/.test(String(value.active_contract_id)) || !contracts.some((contract) => contract.contract_id === value.active_contract_id)))) return false;
  return unique(contracts.map((contract) => contract.contract_id))
    && unique(validations.map((validation) => validation.id))
    && validations.every((validation) => contracts.some((contract) => contract.contract_id === validation.contract_id && contract.contract_sha256 === validation.contract_sha256));
}

function isQualityGateClaim(value: unknown): value is QualityGateClaim {
  return isRecord(value)
    && /^QGC[1-9][0-9]*$/.test(String(value.id))
    && ["retrieval", "agentic", "coding", "structured-output", "final"].includes(String(value.gate))
    && numberedId(value.criterion_id, "C")
    && VERIFICATION_STATUSES.has(String(value.status))
    && typeof value.evidence === "string"
    && isStringArray(value.artifact_refs) && value.artifact_refs.length <= 12
    && isNonEmptyString(value.recorded_at);
}

function isQualityGateEscalation(value: unknown): value is QualityGateEscalation {
  return isRecord(value)
    && /^QGE[1-9][0-9]*$/.test(String(value.id))
    && typeof value.reason === "string"
    && typeof value.decision_needed === "string"
    && isStringArray(value.evidence_refs) && value.evidence_refs.length <= 12
    && isNonEmptyString(value.recorded_at)
    && (value.status === "pending" || value.status === "approved" || value.status === "rejected")
    && (value.resolved_at === undefined || isNonEmptyString(value.resolved_at))
    && (value.resolution_id === undefined || /^QGR[1-9][0-9]*$/.test(String(value.resolution_id)));
}

function isQualityGateResolution(value: unknown): value is QualityGateResolution {
  return isRecord(value)
    && /^QGR[1-9][0-9]*$/.test(String(value.id))
    && (value.target_kind === "escalation" || value.target_kind === "semantic-review")
    && isNonEmptyString(value.target_id)
    && (value.contract_id === undefined || /^OC[1-9][0-9]*$/.test(String(value.contract_id)))
    && (value.candidate_sha256 === undefined || typeof value.candidate_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.candidate_sha256))
    && (value.decision === "approved" || value.decision === "rejected")
    && isNonEmptyString(value.task_id)
    && isNonEmptyString(value.branch_id)
    && isNonEmptyString(value.resolved_at)
    && isNonEmptyString(value.session_id)
    && isNonEmptyString(value.session_anchor_entry_id)
    && typeof value.receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.receipt_hash);
}

function isQualityGateAssessment(value: unknown): value is QualityGateAssessment {
  return isRecord(value)
    && /^QGA[1-9][0-9]*$/.test(String(value.id))
    && ["retrieval", "agentic", "coding", "structured-output", "final"].includes(String(value.gate))
    && (value.decision === "pass" || value.decision === "fail" || value.decision === "escalate")
    && ["reasons", "failed_criteria", "unknown_criteria", "unresolved_conflicts", "scope_violations", "approval_requests", "evidence_refs"].every((key) => isStringArray(value[key]))
    && isNonEmptyString(value.assessed_at);
}

function isQualityGateState(value: unknown): value is QualityGateState {
  return isRecord(value)
    && isArrayOf(value.claims, isQualityGateClaim) && value.claims.length <= 80 && unique(value.claims.map((claim) => claim.id))
    && isArrayOf(value.escalations, isQualityGateEscalation) && value.escalations.length <= 40 && unique(value.escalations.map((escalation) => escalation.id))
    && isArrayOf(value.resolutions, isQualityGateResolution) && value.resolutions.length <= 80 && unique(value.resolutions.map((resolution) => resolution.id))
    && isArrayOf(value.assessments, isQualityGateAssessment) && value.assessments.length <= 80 && unique(value.assessments.map((assessment) => assessment.id));
}

function isAdvisorAdviceRecord(value: unknown): value is AdvisorAdviceRecord {
  return isRecord(value)
    && /^AD[1-9][0-9]*$/.test(String(value.id))
    && (value.source === "manual-orchestration" || value.source === "automatic")
    && (value.status === "applied" || value.status === "rejected")
    && typeof value.attempted === "boolean"
    && typeof value.reason === "string" && value.reason.length > 0 && value.reason.length <= 300
    && (value.advice_sha256 === undefined || typeof value.advice_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.advice_sha256))
    && (value.model === undefined || isNonEmptyString(value.model))
    && (value.usage === undefined || isRecord(value.usage)
      && isFiniteNumber(value.usage.input_tokens) && value.usage.input_tokens >= 0
      && isFiniteNumber(value.usage.output_tokens) && value.usage.output_tokens >= 0
      && isFiniteNumber(value.usage.cost_usd) && value.usage.cost_usd >= 0)
    && (value.trigger === undefined || value.trigger === "observed-failure" || value.trigger === "evidence-conflict" || value.trigger === "repair-exhausted")
    && isNonEmptyString(value.recorded_at);
}

function isAdvisorReservation(value: unknown): value is AdvisorReservation {
  return isRecord(value)
    && /^AR[1-9][0-9]*$/.test(String(value.id))
    && isNonEmptyString(value.task_id)
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && isNonEmptyString(value.branch_id)
    && (value.trigger === "observed-failure" || value.trigger === "evidence-conflict" || value.trigger === "repair-exhausted")
    && typeof value.trigger_identity === "string" && /^[a-f0-9]{64}$/.test(value.trigger_identity)
    && isNonEmptyString(value.model)
    && isPositiveSafeInteger(value.reserved_input_tokens)
    && isPositiveSafeInteger(value.reserved_output_tokens)
    && isFiniteNumber(value.reserved_cost_usd) && value.reserved_cost_usd >= 0
    && isNonEmptyString(value.created_at);
}

function isAdvisorUsage(value: unknown): boolean {
  return isRecord(value)
    && ["input_tokens", "output_tokens", "cost_usd", "unknown_usage_calls"].every((key) => isFiniteNumber(value[key]) && value[key] >= 0)
    && Number.isSafeInteger(value.input_tokens)
    && Number.isSafeInteger(value.output_tokens)
    && Number.isSafeInteger(value.unknown_usage_calls);
}

function isAdvisorState(value: unknown): value is AdvisorState {
  return isRecord(value)
    && isArrayOf(value.records, isAdvisorAdviceRecord)
    && value.records.length <= 40
    && unique(value.records.map((record) => record.id))
    && isFiniteNumber(value.automatic_calls_used)
    && Number.isSafeInteger(value.automatic_calls_used)
    && value.automatic_calls_used >= 0
    && isAdvisorUsage(value.automatic_usage)
    && isArrayOf(value.automatic_reservations, isAdvisorReservation)
    && value.automatic_reservations.length <= 10
    && unique(value.automatic_reservations.map((reservation) => reservation.id))
    && isStringArray(value.automatic_trigger_ids)
    && value.automatic_trigger_ids.length <= 40
    && value.automatic_trigger_ids.every((identity) => /^[a-f0-9]{64}$/.test(identity))
    && unique(value.automatic_trigger_ids)
    && (value.last_trigger === undefined || value.last_trigger === "observed-failure" || value.last_trigger === "evidence-conflict" || value.last_trigger === "repair-exhausted");
}

function emptyAdvisorState(): AdvisorState {
  return {
    records: [],
    automatic_calls_used: 0,
    automatic_usage: { input_tokens: 0, output_tokens: 0, cost_usd: 0, unknown_usage_calls: 0 },
    automatic_reservations: [],
    automatic_trigger_ids: [],
  };
}

function normalizeEarlyAdvisorState(value: unknown): AdvisorState {
  if (!isRecord(value)) return emptyAdvisorState();
  const records = Array.isArray(value.records)
    ? value.records.map((record) => isRecord(record) ? { ...record, attempted: typeof record.attempted === "boolean" ? record.attempted : true } : record)
    : [];
  const usage = isRecord(value.automatic_usage) ? value.automatic_usage : {};
  return {
    records: records as AdvisorAdviceRecord[],
    automatic_calls_used: isFiniteNumber(value.automatic_calls_used) ? value.automatic_calls_used : 0,
    automatic_usage: {
      input_tokens: isFiniteNumber(usage.input_tokens) && usage.input_tokens >= 0 ? usage.input_tokens : 0,
      output_tokens: isFiniteNumber(usage.output_tokens) && usage.output_tokens >= 0 ? usage.output_tokens : 0,
      cost_usd: isFiniteNumber(usage.cost_usd) && usage.cost_usd >= 0 ? usage.cost_usd : 0,
      unknown_usage_calls: isFiniteNumber(usage.unknown_usage_calls) && usage.unknown_usage_calls >= 0 ? usage.unknown_usage_calls : 0,
    },
    automatic_reservations: [],
    automatic_trigger_ids: [],
    ...(value.last_trigger === "observed-failure" || value.last_trigger === "evidence-conflict" || value.last_trigger === "repair-exhausted" ? { last_trigger: value.last_trigger } : {}),
  };
}

function isScopeAuthority(value: unknown): value is ExecutionScope["authority"] {
  return value === "model" || value === "user-command" || value === "native-confirmation";
}

function isScope(value: unknown): value is ExecutionScope {
  return isRecord(value)
    && numberedId(value.scope_id, "S")
    && (value.lane === "retrieval" || value.lane === "agentic" || value.lane === "coding" || value.lane === "structured-output" || value.lane === "general")
    && isStringArray(value.allowed_tools) && value.allowed_tools.length > 0 && value.allowed_tools.length <= 24 && unique(value.allowed_tools)
    && isStringArray(value.allowed_read_paths) && value.allowed_read_paths.length <= 32 && unique(value.allowed_read_paths)
    && isStringArray(value.allowed_write_paths) && value.allowed_write_paths.length <= 32 && unique(value.allowed_write_paths)
    && isStringArray(value.forbidden_paths) && value.forbidden_paths.length <= 32 && unique(value.forbidden_paths)
    && isPositiveSafeInteger(value.max_tool_calls) && value.max_tool_calls <= 500
    && isPositiveSafeInteger(value.max_errors) && value.max_errors <= 100
    && isPositiveSafeInteger(value.max_iterations) && value.max_iterations <= 500
    && (value.external_side_effects === "forbidden" || value.external_side_effects === "approval-required" || value.external_side_effects === "pre-approved")
    && isStringArray(value.validation_commands) && value.validation_commands.length <= 12 && unique(value.validation_commands)
    && isStringArray(value.stop_conditions) && value.stop_conditions.length <= 12 && unique(value.stop_conditions)
    && isStringArray(value.escalation_conditions) && value.escalation_conditions.length <= 12 && unique(value.escalation_conditions)
    && isScopeAuthority(value.authority)
    && (value.authority_session_id === undefined || isNonEmptyString(value.authority_session_id))
    && (value.authority_entry_id === undefined || isNonEmptyString(value.authority_entry_id))
    && (value.authority_scope_change_id === undefined || numberedId(value.authority_scope_change_id, "SC"))
    && (value.authority_receipt_hash === undefined || typeof value.authority_receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.authority_receipt_hash))
    && (value.authority_session_id === undefined) === (value.authority_entry_id === undefined)
    && ((value.authority_scope_change_id === undefined && value.authority_receipt_hash === undefined)
      || (numberedId(value.authority_scope_change_id, "SC") && typeof value.authority_receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.authority_receipt_hash)))
    && isNonEmptyString(value.created_at)
    && isNonEmptyString(value.updated_at);
}

function isScopeChange(value: unknown): value is ScopeChangeRequest {
  return isRecord(value)
    && numberedId(value.id, "SC")
    && isScope(value.requested_scope)
    && isNonEmptyString(value.requested_at)
    && (value.status === "pending" || value.status === "approved" || value.status === "rejected")
    && (value.resolved_at === undefined || isNonEmptyString(value.resolved_at))
    && (value.resolved_by === undefined || value.resolved_by === "user-command" || value.resolved_by === "native-confirmation");
}

function isApproval(value: unknown): value is ApprovalRequest {
  return isRecord(value)
    && numberedId(value.id, "A")
    && isNonEmptyString(value.task_id)
    && isNonEmptyString(value.branch_id)
    && isNonEmptyString(value.tool_name)
    && isNonEmptyString(value.requested_normalized_effect)
    && isNonEmptyString(value.description)
    && typeof value.reversible === "boolean"
    && typeof value.scope_hash === "string" && /^[a-f0-9]{64}$/.test(value.scope_hash)
    && (value.status === "pending" || value.status === "approved" || value.status === "rejected" || value.status === "expired" || value.status === "consumed")
    && isNonEmptyString(value.requested_at)
    && (value.approved_at === undefined || isNonEmptyString(value.approved_at))
    && (value.approved_by === undefined || value.approved_by === "user-command" || value.approved_by === "native-confirmation")
    && (value.expires_at === undefined || isNonEmptyString(value.expires_at))
    && (value.consumed_at === undefined || isNonEmptyString(value.consumed_at))
    && (value.rejected_at === undefined || isNonEmptyString(value.rejected_at))
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id))
    && (value.approval_receipt_hash === undefined || typeof value.approval_receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.approval_receipt_hash))
    && (value.session_id === undefined) === (value.session_anchor_entry_id === undefined);
}

function isScopeFreshRead(value: unknown): value is ScopeFreshRead {
  const inspectedSpan = value && isRecord(value) ? value.inspected_span : undefined;
  return isRecord(value)
    && isNonEmptyString(value.path)
    && isNonEmptyString(value.workspace_revision)
    && isNonEmptyString(value.observed_at)
    && (value.receipt_id === undefined || numberedId(value.receipt_id, "R"))
    && (value.tool_call_id === undefined || isNonEmptyString(value.tool_call_id))
    && (value.content_sha256 === undefined || typeof value.content_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.content_sha256))
    && (value.content_bytes === undefined || isFiniteNumber(value.content_bytes) && (value.content_bytes as number) >= 0)
    && (value.full_coverage === undefined || typeof value.full_coverage === "boolean")
    && (value.full_coverage !== false || inspectedSpan !== undefined)
    && (inspectedSpan === undefined || (isRecord(inspectedSpan)
      && isPositiveSafeInteger(inspectedSpan.start_line)
      && isPositiveSafeInteger(inspectedSpan.end_line)
      && (inspectedSpan.end_line as number) >= (inspectedSpan.start_line as number)
      && typeof inspectedSpan.content_sha256 === "string" && /^[a-f0-9]{64}$/.test(inspectedSpan.content_sha256)))
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id))
    && (value.session_id === undefined) === (value.session_anchor_entry_id === undefined);
}

function isScopeState(value: unknown): value is ScopeState {
  if (!isRecord(value)
    || (value.initial_scope !== undefined && !isScope(value.initial_scope))
    || (value.active_scope !== undefined && !isScope(value.active_scope))
    || (value.authoritative_scope !== undefined && !isScope(value.authoritative_scope))
    || !isArrayOf(value.pending_scope_changes, isScopeChange)
    || !isArrayOf(value.approvals, isApproval)
    || !isRecord(value.usage)
    || !isArrayOf(value.fresh_reads, isScopeFreshRead)
    || !isStringArray(value.violations)
    || (value.tool_focus_lane !== undefined && value.tool_focus_lane !== "retrieval" && value.tool_focus_lane !== "agentic" && value.tool_focus_lane !== "coding" && value.tool_focus_lane !== "structured-output" && value.tool_focus_lane !== "general")) return false;
  const usage = value.usage;
  return ["tool_calls_used", "blocked_tool_calls", "errors_used", "iterations_used"].every((key) => isFiniteNumber(usage[key]) && (usage[key] as number) >= 0)
    && (usage.active_iteration_batch_id === undefined || isNonEmptyString(usage.active_iteration_batch_id))
    && (usage.last_block_reason === undefined || typeof usage.last_block_reason === "string")
    && (usage.last_block_tool === undefined || isNonEmptyString(usage.last_block_tool))
    && (usage.last_block_normalized_effect === undefined || isNonEmptyString(usage.last_block_normalized_effect))
    && (usage.last_block_scope_hash === undefined || typeof usage.last_block_scope_hash === "string" && /^[a-f0-9]{64}$/.test(usage.last_block_scope_hash))
    && value.pending_scope_changes.length <= 40
    && value.approvals.length <= 80
    && value.fresh_reads.length <= 80
    && value.violations.length <= 40
    && unique(value.pending_scope_changes.map((item) => item.id))
    && unique(value.approvals.map((item) => item.id));
}

function isV2Shape(value: Record<string, unknown>): boolean {
  const stringFields = ["task_id", "created_at", "updated_at", "cwd", "status", "user_goal", "normalized_goal", "current_phase", "current_step_id", "next_action", "lane"];
  const stringArrayFields = ["success_criteria", "constraints", "completed_steps", "blocked_steps", "known_facts", "open_questions", "decisions", "files_touched", "read_files", "modified_files", "errors", "loop_warnings", "final_answer_requirements", "retired_criterion_ids"];
  return stringFields.every((key) => hasOwn(value, key) && typeof value[key] === "string")
    && stringArrayFields.every((key) => hasOwn(value, key) && isStringArray(value[key]))
    && isPlan(value.plan)
    && isToolHistory(value.tool_history)
    && isVerificationHistory(value.verification)
    && Array.isArray(value.criteria)
    && Array.isArray(value.trusted_check_mappings)
    && Array.isArray(value.execution_receipts)
    && Array.isArray(value.criterion_results)
    && Array.isArray(value.model_verification_claims)
    && Array.isArray(value.completion_gates)
    && Array.isArray(value.pending_tool_calls)
    && isWorkspaceRevision(value.workspace_revision)
    && isRecord(value.task_identity)
    && isRecord(value.current_session)
    && isRecord(value.recovery)
    && isRecord(value.id_counters)
    && isRecord(value.migration)
    && isRecord(value.counters);
}

/** Throws on invalid criteria rather than silently dropping user requirements. */
export function createCriteria(successCriteria: string[]): Criterion[] {
  if (successCriteria.length === 0 || successCriteria.length > MAX_USER_CRITERIA) {
    throw new Error(`Reliability tasks require between 1 and ${MAX_USER_CRITERIA} success criteria.`);
  }
  const requirements = successCriteria.map((item) => item.trim());
  if (requirements.some((item) => !item) || !unique(requirements)) {
    throw new Error("Reliability task success criteria must be non-empty and unique.");
  }
  return requirements.map((requirement, index) => ({
    id: `C${index + 1}`,
    requirement,
    expected_evidence: "validation",
    required: true,
    origin: "user",
  }));
}

export function isTaskStateV1(value: unknown): value is TaskStateV1 {
  if (!isRecord(value) || value.schema_version !== 1) return false;
  const stringFields = ["task_id", "created_at", "updated_at", "cwd", "status", "user_goal", "normalized_goal", "current_phase", "current_step_id", "next_action"];
  const stringArrayFields = ["success_criteria", "constraints", "completed_steps", "blocked_steps", "known_facts", "open_questions", "decisions", "files_touched", "read_files", "modified_files", "errors", "loop_warnings", "final_answer_requirements"];
  const counters = value.counters;
  return stringFields.every((key) => isNonEmptyString(value[key]))
    && TASK_STATUSES.has(value.status as string)
    && stringArrayFields.every((key) => isStringArray(value[key]))
    && (value.session_file === undefined || typeof value.session_file === "string")
    && isPlan(value.plan)
    && isToolHistory(value.tool_history)
    && isVerificationHistory(value.verification)
    && isRecord(counters)
    && ["context_injections", "model_responses", "tool_calls", "repeated_action_limit"].every((key) => isFiniteNumber(counters[key]));
}

/**
 * Strictly validates every v2 field used to authorize work or completion. A
 * partially written v2 record is recovery-required, never a valid empty task.
 */
function isFoundationTaskStateV2(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || value.schema_version !== 2 || !isV2Shape(value)) return false;
  const criteria = value.criteria;
  const successCriteria = value.success_criteria;
  const retiredIds = value.retired_criterion_ids;
  const identity = value.task_identity;
  const currentSession = value.current_session;
  const mappings = value.trusted_check_mappings;
  const pendingCalls = value.pending_tool_calls;
  const receipts = value.execution_receipts;
  const results = value.criterion_results;
  const claims = value.model_verification_claims;
  const gates = value.completion_gates;
  const recovery = value.recovery;
  const counters = value.counters;
  const migration = value.migration;
  const idCounters = value.id_counters;
  if (!TASK_STATUSES.has(value.status as string)
    || !isArrayOf(criteria, isCriterion)
    || !isStringArray(successCriteria)
    || !isStringArray(retiredIds)
    || !isTaskIdentity(identity)
    || !isSessionBranchIdentity(currentSession)
    || !isArrayOf(mappings, isTrustedCheckMapping)
    || !isArrayOf(pendingCalls, isPendingToolCall)
    || !isArrayOf(receipts, isExecutionReceipt)
    || !isArrayOf(results, isCriterionResult)
    || !isArrayOf(claims, isModelVerificationClaim)
    || !isArrayOf(gates, isCompletionGate)
    || !isRecoveryState(recovery)
    || !isStateMigration(migration)
    || !isRecord(counters)
    || !isRecord(idCounters)) return false;
  if (criteria.length === 0 || criteria.length > MAX_CRITERIA || !criteria.every((criterion) => criterion.required)) return false;
  const userCriteria = criteria.filter((criterion) => criterion.origin !== "host-coding-review");
  const hostCriteria = criteria.filter((criterion) => criterion.origin === "host-coding-review");
  const criterionIds = criteria.map((item) => item.id);
  const requirements = criteria.map((item) => item.requirement);
  if (userCriteria.length > MAX_USER_CRITERIA || hostCriteria.length > CODING_REVIEW_KINDS.length || !unique(criterionIds) || !unique(requirements) || !unique(successCriteria)) return false;
  if (userCriteria.length !== successCriteria.length || !userCriteria.every((item, index) => item.requirement === successCriteria[index])) return false;
  if (!unique(retiredIds) || retiredIds.some((id) => !numberedId(id, "C") || criterionIds.includes(id))) return false;
  const knownCriterionIds = new Set([...criterionIds, ...retiredIds]);
  if (identity.task_id !== value.task_id) return false;
  if (!mappings.every((mapping) => criterionIds.includes(mapping.criterion_id)) || !unique(mappings.map((mapping) => mapping.id))) return false;
  if (!unique(pendingCalls.map((pending) => pending.tool_call_id))) return false;
  if (!receipts.every((receipt) => receipt.task_id === value.task_id
    && receipt.branch_id === identity.branch_id
    && receipt.criterion_ids.every((id) => knownCriterionIds.has(id)))) return false;
  const receiptIds = receipts.map((receipt) => receipt.id);
  if (!unique(receiptIds)) return false;
  if (!results.every((result) => knownCriterionIds.has(result.criterion_id)
    && result.receipt_ids.every((receiptId) => receiptIds.includes(receiptId)))
    || !unique(results.map((result) => result.criterion_id))) return false;
  if (!claims.every((claim) => claim.criterion_id === undefined || knownCriterionIds.has(claim.criterion_id))) return false;
  if (!["context_injections", "model_responses", "tool_calls", "repeated_action_limit", "blocked_calls", "errors_used", "iterations_used"].every((key) => isFiniteNumber(counters[key]))) return false;
  const nextCriterion = idCounters.next_criterion;
  const nextMapping = idCounters.next_mapping;
  const nextReceipt = idCounters.next_receipt;
  const nextGate = idCounters.next_gate;
  if (!isPositiveSafeInteger(nextCriterion)
    || !isPositiveSafeInteger(nextMapping)
    || !isPositiveSafeInteger(nextReceipt)
    || !isPositiveSafeInteger(nextGate)) return false;
  const hasCounterBeyond = (prefix: string, current: number, ids: string[]): boolean => ids.every((id) => current > Number(id.slice(prefix.length)));
  return hasCounterBeyond("C", nextCriterion, [...criterionIds, ...retiredIds])
    && hasCounterBeyond("M", nextMapping, mappings.map((mapping) => mapping.id))
    && hasCounterBeyond("R", nextReceipt, receiptIds)
    && hasCounterBeyond("G", nextGate, gates.map((gate) => gate.id));
}

/** Validates the v2 state after the additive evidence wave. */
function isEvidenceTaskStateV2(value: unknown): value is Record<string, unknown> {
  if (!isFoundationTaskStateV2(value)) return false;
  const evidencePacks = value.evidence_packs;
  const activePackId = value.active_evidence_pack_id;
  const counters = value.id_counters;
  const nextEvidencePack = isRecord(counters) ? counters.next_evidence_pack : undefined;
  if (!isArrayOf(evidencePacks, isEvidencePackSummary) || evidencePacks.length > 12
    || !unique(evidencePacks.map((pack) => pack.pack_id))
    || !evidencePacks.every((pack) => pack.task_id === value.task_id && pack.branch_id === (value.task_identity as TaskIdentity).branch_id)
    || !evidencePacks.every((pack) => (pack.session_id === undefined) === (pack.session_anchor_entry_id === undefined))
    || (activePackId !== undefined && (!numberedId(activePackId, "E") || !evidencePacks.some((pack) => pack.pack_id === activePackId)))
    || !isRecord(counters)
    || !isPositiveSafeInteger(nextEvidencePack)
    || !evidencePacks.every((pack) => nextEvidencePack > Number(pack.pack_id.slice(1)))) return false;
  return true;
}

function isContextResetCandidate(value: unknown): value is ContextResetCandidate {
  return isRecord(value)
    && (value.from_lane === "retrieval" || value.from_lane === "agentic" || value.from_lane === "coding" || value.from_lane === "structured-output" || value.from_lane === "general")
    && (value.to_lane === "retrieval" || value.to_lane === "agentic" || value.to_lane === "coding" || value.to_lane === "structured-output" || value.to_lane === "general" || value.to_lane === "planning" || value.to_lane === "review" || value.to_lane === "final")
    && isNonEmptyString(value.phase_id)
    && (value.trigger === "phase-boundary" || value.trigger === "context-pressure" || value.trigger === "manual-retry")
    && isNonEmptyString(value.next_action) && value.next_action.length <= 300 && !/[\r\n]/.test(value.next_action)
    && (value.gate_decision === "pass" || value.gate_decision === "escalate" || value.gate_decision === "fail")
    && isFiniteNumber(value.turn_index)
    && (value.estimated_transient_tokens === undefined || isFiniteNumber(value.estimated_transient_tokens))
    && (value.context_usage_ratio === undefined || isFiniteNumber(value.context_usage_ratio))
    && (value.stable_boundary_id === undefined || isNonEmptyString(value.stable_boundary_id));
}

function isContextCheckpointSummary(value: unknown): value is ContextCheckpointSummary {
  return isRecord(value)
    && numberedId(value.checkpoint_id, "CP")
    && isPositiveSafeInteger(value.sequence)
    && value.schema_version === 1
    && (value.from_lane === "retrieval" || value.from_lane === "agentic" || value.from_lane === "coding" || value.from_lane === "structured-output" || value.from_lane === "general")
    && (value.to_lane === "retrieval" || value.to_lane === "agentic" || value.to_lane === "coding" || value.to_lane === "structured-output" || value.to_lane === "general" || value.to_lane === "planning" || value.to_lane === "review" || value.to_lane === "final")
    && isNonEmptyString(value.phase_id)
    && isNonEmptyString(value.artifact_path) && value.artifact_path.startsWith("checkpoints/")
    && typeof value.artifact_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.artifact_sha256)
    && typeof value.canonical_state_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.canonical_state_sha256)
    && (value.scope_sha256 === undefined || typeof value.scope_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.scope_sha256))
    && isArrayOf(value.evidence_packs, (pack): pack is { pack_id: string; sha256: string } => isRecord(pack) && numberedId(pack.pack_id, "E") && typeof pack.sha256 === "string" && /^[a-f0-9]{64}$/.test(pack.sha256))
    && isFiniteNumber(value.context_epoch_before) && value.context_epoch_before >= 0
    && (value.context_epoch_after === undefined || isFiniteNumber(value.context_epoch_after) && value.context_epoch_after === value.context_epoch_before + 1)
    && (value.trigger === "phase-boundary" || value.trigger === "context-pressure" || value.trigger === "manual-retry")
    && (value.status === "written" || value.status === "validated" || value.status === "reset-complete" || value.status === "checkpoint-only" || value.status === "invalid" || value.status === "recovery-required")
    && isNonEmptyString(value.created_at)
    && (value.reset_receipt_hash === undefined || typeof value.reset_receipt_hash === "string" && /^[a-f0-9]{64}$/.test(value.reset_receipt_hash))
    && (value.provider_visible_manifest_sha256 === undefined || typeof value.provider_visible_manifest_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.provider_visible_manifest_sha256))
    && (value.session_id === undefined || isNonEmptyString(value.session_id))
    && (value.session_anchor_entry_id === undefined || isNonEmptyString(value.session_anchor_entry_id))
    && (value.snapshot_path === undefined || isNonEmptyString(value.snapshot_path) && value.snapshot_path.startsWith("checkpoints/") && typeof value.snapshot_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.snapshot_sha256))
    && (value.candidate_next_action_sha256 === undefined || typeof value.candidate_next_action_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.candidate_next_action_sha256))
    && (value.request_artifact_path === undefined || isNonEmptyString(value.request_artifact_path) && typeof value.request_artifact_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.request_artifact_sha256))
    && (value.receipt_artifact_path === undefined || isNonEmptyString(value.receipt_artifact_path) && typeof value.receipt_artifact_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.receipt_artifact_sha256))
    && (value.restore_artifact_path === undefined || isNonEmptyString(value.restore_artifact_path) && typeof value.restore_artifact_sha256 === "string" && /^[a-f0-9]{64}$/.test(value.restore_artifact_sha256));
}

function isContextResetState(value: unknown): value is ContextResetState {
  return isRecord(value)
    && (value.status === "idle" || value.status === "queued" || value.status === "rendering" || value.status === "validated" || value.status === "resetting" || value.status === "verifying" || value.status === "complete" || value.status === "skipped" || value.status === "failed" || value.status === "paused")
    && typeof value.auto_enabled === "boolean"
    && isFiniteNumber(value.turn_index) && value.turn_index >= 0
    && (value.phase_id === undefined || isNonEmptyString(value.phase_id))
    && (value.last_attempt_at === undefined || isNonEmptyString(value.last_attempt_at))
    && (value.last_reason === undefined || typeof value.last_reason === "string")
    && (value.cooldown_until_turn === undefined || isFiniteNumber(value.cooldown_until_turn))
    && isFiniteNumber(value.repair_attempts) && value.repair_attempts >= 0
    && typeof value.mutation_blocked === "boolean"
    && (value.freeze_reason === undefined || typeof value.freeze_reason === "string")
    && (value.freeze_request_id === undefined || isNonEmptyString(value.freeze_request_id))
    && (value.stable_boundary_id === undefined || isNonEmptyString(value.stable_boundary_id))
    && (value.pending_candidate === undefined || isContextResetCandidate(value.pending_candidate));
}

/** Validates the current v2 state including scope, budgets, approvals, and checkpoint/reset continuity. */
export function isTaskStateV2(value: unknown): value is TaskState {
  if (!isEvidenceTaskStateV2(value) || !isScopeState(value.scope_state)
    || !isStructuredOutputState(value.structured_output)
    || !isQualityGateState(value.quality_gate)
    || !isAdvisorState(value.advisor_state)
    || !isContextResetState(value.context_reset)
    || !isArrayOf(value.context_checkpoints, isContextCheckpointSummary)
    || !isExecutablePlan(value.plan)
    || !isArrayOf(value.dependency_evidence, isDependencyEvidence)
    || !isCodingBoundary(value.coding_boundary)
    || !isAuthoritativeInstructions(value.authoritative_instructions)
    || (value.input_pause !== undefined && (!isRecord(value.input_pause)
      || Object.keys(value.input_pause).some(key => !["observation_id", "text_sha256", "session_id", "branch_anchor_entry_id"].includes(key))
      || !isNonEmptyString(value.input_pause.observation_id) || value.input_pause.observation_id.length > 64
      || typeof value.input_pause.text_sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.input_pause.text_sha256)
      || (value.input_pause.session_id !== undefined && !isNonEmptyString(value.input_pause.session_id))
      || (value.input_pause.branch_anchor_entry_id !== undefined && !isNonEmptyString(value.input_pause.branch_anchor_entry_id))))
    || !isWorkingContext(value.working_context)) return false;
  const counters = value.id_counters;
  if (!isRecord(counters)
    || !isPositiveSafeInteger(counters.next_advisor_advice)
    || !isPositiveSafeInteger(counters.next_scope)
    || !isPositiveSafeInteger(counters.next_scope_change)
    || !isPositiveSafeInteger(counters.next_approval)
    || !isPositiveSafeInteger(counters.next_output_contract)
    || !isPositiveSafeInteger(counters.next_output_validation)
    || !isPositiveSafeInteger(counters.next_quality_gate_claim)
    || !isPositiveSafeInteger(counters.next_quality_gate_escalation)
    || !isPositiveSafeInteger(counters.next_quality_gate_assessment)
    || !isPositiveSafeInteger(counters.next_quality_gate_resolution)
    || !isPositiveSafeInteger(counters.next_checkpoint)
    || !isFiniteNumber(value.context_epoch) || value.context_epoch < 0) return false;
  const nextAdvisorAdvice = counters.next_advisor_advice as number;
  const nextScope = counters.next_scope as number;
  const nextScopeChange = counters.next_scope_change as number;
  const nextApproval = counters.next_approval as number;
  const nextOutputContract = counters.next_output_contract as number;
  const nextOutputValidation = counters.next_output_validation as number;
  const nextQualityGateClaim = counters.next_quality_gate_claim as number;
  const nextQualityGateEscalation = counters.next_quality_gate_escalation as number;
  const nextQualityGateAssessment = counters.next_quality_gate_assessment as number;
  const nextQualityGateResolution = counters.next_quality_gate_resolution as number;
  const nextCheckpoint = counters.next_checkpoint as number;
  const scopeState = value.scope_state;
  const advisorState = value.advisor_state as AdvisorState;
  const dependencyEvidence = value.dependency_evidence as DependencyEvidence[];
  const evidencePacks = value.evidence_packs as EvidencePackSummary[];
  const codingBoundary = value.coding_boundary as CodingBoundary;
  const checkpoints = value.context_checkpoints as ContextCheckpointSummary[];
  if (checkpoints.length > 100 || !unique(checkpoints.map((checkpoint) => checkpoint.checkpoint_id))
    || new Set(checkpoints.map((checkpoint) => checkpoint.sequence)).size !== checkpoints.length
    || checkpoints.some((checkpoint) => nextCheckpoint <= checkpoint.sequence)
    || (value.active_checkpoint_id !== undefined && (!numberedId(value.active_checkpoint_id, "CP") || !checkpoints.some((checkpoint) => checkpoint.checkpoint_id === value.active_checkpoint_id)))) return false;
  if (codingBoundary.task_id !== value.task_id || codingBoundary.branch_id !== (value.task_identity as TaskIdentity).branch_id) return false;
  if (dependencyEvidence.length > 24
    || !unique(dependencyEvidence.map((item) => `${item.pack_id}\u0000${item.package_name}`))
    || !dependencyEvidence.every((item) => evidencePacks.some((pack) => pack.pack_id === item.pack_id))
    || !dependencyEvidence.every((item) => item.status === "unknown" || Boolean(item.manifest_receipt_id))) return false;
  const scopes = [scopeState.initial_scope, scopeState.active_scope, scopeState.authoritative_scope, ...scopeState.pending_scope_changes.map((item) => item.requested_scope)]
    .filter((scope): scope is ExecutionScope => scope !== undefined);
  const scopeIds = scopes.map((scope) => scope.scope_id);
  const structuredOutput = value.structured_output as StructuredOutputState;
  const qualityGate = value.quality_gate as QualityGateState;
  const activeCriterionIds = (value.criteria as Criterion[]).map((criterion) => criterion.id);
  const knownCriterionIds = new Set([...activeCriterionIds, ...value.retired_criterion_ids as string[]]);
  return advisorState.records.every((record) => nextAdvisorAdvice > Number(record.id.slice(2)))
    && scopeIds.every((id) => nextScope > Number(id.slice(1)))
    && scopeState.pending_scope_changes.every((request) => nextScopeChange > Number(request.id.slice(2)))
    && scopeState.approvals.every((approval) => approval.task_id === value.task_id
      && approval.branch_id === (value.task_identity as TaskIdentity).branch_id
      && nextApproval > Number(approval.id.slice(1)))
    && structuredOutput.contracts.every((contract) => contract.task_id === value.task_id
      && contract.branch_id === (value.task_identity as TaskIdentity).branch_id
      && nextOutputContract > Number(contract.contract_id.slice(2)))
    && structuredOutput.validations.every((validation) => validation.task_id === value.task_id
      && validation.branch_id === (value.task_identity as TaskIdentity).branch_id
      && nextOutputValidation > Number(validation.id.slice(2)))
    && qualityGate.claims.every((claim) => knownCriterionIds.has(claim.criterion_id) && nextQualityGateClaim > Number(claim.id.slice(3)))
    && qualityGate.escalations.every((escalation) => nextQualityGateEscalation > Number(escalation.id.slice(3)))
    && qualityGate.assessments.every((assessment) => nextQualityGateAssessment > Number(assessment.id.slice(3)))
    && qualityGate.resolutions.every((resolution) => resolution.task_id === value.task_id
      && resolution.branch_id === (value.task_identity as TaskIdentity).branch_id
      && nextQualityGateResolution > Number(resolution.id.slice(3)));
}

// A historical shape must lack the entire later-wave field set. Missing one
// modern field is corruption, never permission to reset newer authority.
const V2_WAVE_FIELDS = [
  { fields: ["scope_state"], counters: ["next_scope", "next_scope_change", "next_approval"], session: [] },
  { fields: ["dependency_evidence", "coding_boundary", "working_context"], counters: [], session: [] },
  { fields: ["structured_output", "quality_gate"], counters: ["next_output_contract", "next_output_validation", "next_quality_gate_claim", "next_quality_gate_escalation", "next_quality_gate_assessment", "next_quality_gate_resolution"], session: ["output_contract_receipts", "output_validation_receipts", "quality_gate_resolution_receipts"] },
  { fields: ["context_epoch", "context_checkpoints", "active_checkpoint_id", "context_reset"], counters: ["next_checkpoint"], session: [] },
  { fields: ["advisor_state"], counters: ["next_advisor_advice"], session: [] },
  { fields: ["input_pause"], counters: [], session: ["input_authority_receipts"] },
] as const;

function lacksLaterWaveFields(value: Record<string, unknown>, firstWave: number): boolean {
  if (!isRecord(value.id_counters) || !isRecord(value.current_session)) return false;
  const counters = value.id_counters;
  const session = value.current_session;
  const instructions = isRecord(value.authoritative_instructions) ? value.authoritative_instructions : undefined;
  const instructionEntries = [instructions?.original_user_request, ...(Array.isArray(instructions?.corrections) ? instructions.corrections : [])];
  // Later enum values and receipt members also prove modern provenance when top-level markers are missing.
  if (instructionEntries.some((entry) => isRecord(entry) && entry.origin === "native-confirmation")
    || Array.isArray(value.execution_receipts) && value.execution_receipts.some((receipt) => isRecord(receipt) && hasOwn(receipt, "validation_status"))) return false;
  return V2_WAVE_FIELDS.slice(firstWave).every((wave) => wave.fields.every((key) => !hasOwn(value, key))
    && wave.counters.every((key) => !hasOwn(counters, key))
    && wave.session.every((key) => !hasOwn(session, key)));
}

function hasLegacyCodingFields(value: Record<string, unknown>): boolean {
  const instructions = value.authoritative_instructions;
  return (instructions === undefined || isRecord(instructions)
      && typeof instructions.original_user_request === "string" && isStringArray(instructions.corrections))
    && Array.isArray(value.plan) && value.plan.every((step) => isRecord(step)
      && !hasOwn(step, "exit_conditions") && !hasOwn(step, "exit_evidence_receipt_ids") && !hasOwn(step, "exit_evidence_artifact_refs"));
}

function isPreEvidenceV2State(value: unknown): value is Record<string, unknown> {
  if (!isFoundationTaskStateV2(value) || !lacksLaterWaveFields(value, 0) || !hasLegacyCodingFields(value)) return false;
  const counters = value.id_counters;
  return !hasOwn(value, "evidence_packs")
    && !hasOwn(value, "active_evidence_pack_id")
    && isRecord(counters)
    && !hasOwn(counters, "next_evidence_pack");
}

function migratePreEvidenceV2State(value: Record<string, unknown>): Record<string, unknown> {
  const counters = value.id_counters as Record<string, unknown>;
  return {
    ...value,
    evidence_packs: [],
    active_evidence_pack_id: undefined,
    id_counters: {
      ...counters,
      next_evidence_pack: 1,
    },
  };
}

/** Existing v2 records remain valid migration inputs only when every new scope field is absent. */
function isPreScopeV2State(value: unknown): value is Record<string, unknown> {
  if (!isEvidenceTaskStateV2(value) || !lacksLaterWaveFields(value, 0) || !hasLegacyCodingFields(value)) return false;
  const counters = value.id_counters;
  return !hasOwn(value, "scope_state")
    && isRecord(counters)
    && !hasOwn(counters, "next_scope")
    && !hasOwn(counters, "next_scope_change")
    && !hasOwn(counters, "next_approval");
}

function migratePreScopeV2State(value: Record<string, unknown>): Record<string, unknown> {
  const counters = value.id_counters as Record<string, unknown>;
  return {
    ...value,
    scope_state: createScopeState(),
    id_counters: {
      ...counters,
      next_scope: 1,
      next_scope_change: 1,
      next_approval: 1,
    },
  };
}

/** Adds Wave 3 state only to a complete pre-coding shape. */
function isPreCodingV2State(value: unknown): value is Record<string, unknown> {
  return isEvidenceTaskStateV2(value)
    && isScopeState(value.scope_state)
    && lacksLaterWaveFields(value, 1)
    && hasLegacyCodingFields(value);
}

function migratePreCodingV2State(value: Record<string, unknown>): TaskState {
  const legacyClaims = isStringArray(value.known_facts)
    ? value.known_facts.slice(-40).filter((text) => text.trim()).map((text) => ({ text, recorded_at: new Date().toISOString(), evidence_refs: [] }))
    : [];
  const plan = Array.isArray(value.plan)
    ? value.plan.map((step) => ({
      ...(step as Record<string, unknown>),
      exit_conditions: [],
      exit_evidence_receipt_ids: [],
      exit_evidence_artifact_refs: [],
    }))
    : value.plan;
  const legacyAuthoritative = isRecord(value.authoritative_instructions) ? value.authoritative_instructions : undefined;
  const original = typeof legacyAuthoritative?.original_user_request === "string"
    ? legacyAuthoritative.original_user_request
    : typeof value.user_goal === "string" ? value.user_goal : "";
  const legacyCorrections = isStringArray(legacyAuthoritative?.corrections)
    ? legacyAuthoritative.corrections.map((text) => ({ text, origin: "user-command" as const, recorded_at: new Date().toISOString() }))
    : [];
  const identity = value.task_identity as TaskIdentity;
  return {
    ...(value as unknown as TaskState),
    plan: plan as TaskState["plan"],
    dependency_evidence: Array.isArray(value.dependency_evidence) ? value.dependency_evidence as TaskState["dependency_evidence"] : [],
    coding_boundary: {
      status: "missing",
      task_id: typeof value.task_id === "string" ? value.task_id : "unknown",
      branch_id: identity?.branch_id ?? "unknown",
      allowed_write_paths: [],
      reason: "Legacy task has no pre-mutation coding baseline; require explicit user-reviewed recovery.",
    },
    authoritative_instructions: {
      ...createAuthoritativeInstructions(original),
      corrections: legacyCorrections,
    },
    working_context: isWorkingContext(value.working_context) ? value.working_context : { ...createWorkingContext(), claims: legacyClaims },
  };
}

/** Adds Wave 4 state without reinterpreting prior model records as validator evidence. */
function isPreStructuredOutputV2State(value: unknown): value is Record<string, unknown> {
  if (!isEvidenceTaskStateV2(value) || !isScopeState(value.scope_state) || !isExecutablePlan(value.plan)
    || !isArrayOf(value.dependency_evidence, isDependencyEvidence)
    || !isCodingBoundary(value.coding_boundary)
    || !isAuthoritativeInstructions(value.authoritative_instructions)
    || !isWorkingContext(value.working_context)
    || !isRecord(value.id_counters) || !lacksLaterWaveFields(value, 2)) return false;
  const counters = value.id_counters;
  return !hasOwn(value, "structured_output")
    && !hasOwn(value, "quality_gate")
    && !hasOwn(counters, "next_output_contract")
    && !hasOwn(counters, "next_output_validation")
    && !hasOwn(counters, "next_quality_gate_claim")
    && !hasOwn(counters, "next_quality_gate_escalation")
    && !hasOwn(counters, "next_quality_gate_assessment");
}

function migratePreStructuredOutputV2State(value: Record<string, unknown>): TaskState {
  const counters = value.id_counters;
  if (!isRecord(counters)) throw new Error("Legacy Wave 3 state has no durable ID counters.");
  const counter = (key: string): number => {
    const candidate = counters[key];
    if (!isPositiveSafeInteger(candidate)) throw new Error(`Legacy Wave 3 counter ${key} is invalid.`);
    return candidate;
  };
  return {
    ...(value as unknown as TaskState),
    structured_output: createStructuredOutputState(),
    quality_gate: { claims: [], escalations: [], resolutions: [], assessments: [] },
    id_counters: {
      next_advisor_advice: 1,
      next_criterion: counter("next_criterion"),
      next_mapping: counter("next_mapping"),
      next_receipt: counter("next_receipt"),
      next_gate: counter("next_gate"),
      next_evidence_pack: counter("next_evidence_pack"),
      next_scope: counter("next_scope"),
      next_scope_change: counter("next_scope_change"),
      next_approval: counter("next_approval"),
      next_output_contract: 1,
      next_output_validation: 1,
      next_quality_gate_claim: 1,
      next_quality_gate_escalation: 1,
      next_quality_gate_assessment: 1,
      next_quality_gate_resolution: 1,
      next_checkpoint: 1,
    },
  };
}

/** Conservatively upgrades an unaccepted early Wave 4 record: old output receipts are retained only in session history, never reinterpreted as current authority. */
function isPreCorrectedWave4State(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.schema_version === 2
    && isRecord(value.structured_output)
    && isRecord(value.quality_gate)
    && !hasOwn(value.quality_gate, "resolutions")
    && lacksLaterWaveFields(value, 3)
    && isRecord(value.id_counters) && !hasOwn(value.id_counters, "next_quality_gate_resolution")
    && isRecord(value.current_session) && !hasOwn(value.current_session, "quality_gate_resolution_receipts")
    && isArrayOf(value.structured_output.contracts, (contract): contract is Record<string, unknown> => isRecord(contract) && !hasOwn(contract, "definition_sha256"));
}

function migratePreCorrectedWave4State(value: Record<string, unknown>): TaskState {
  const output = value.structured_output as Record<string, unknown>;
  const quality = value.quality_gate as Record<string, unknown>;
  const contracts = Array.isArray(output.contracts) ? output.contracts.filter(isRecord).map((contract) => ({
    ...contract,
    definition_sha256: isStructuredOutputDefinition(contract.definition)
      ? createHash("sha256").update(stableStringify(contract.definition)).digest("hex")
      : "0".repeat(64),
  })) : [];
  const validations = Array.isArray(output.validations) ? output.validations.filter(isRecord).map((validation) => ({
    ...validation,
    semantic_check_state: validation.human_review_required === true ? "review-required" : "not-required",
    semantic_checks_passed: false,
    session_id: undefined,
    session_anchor_entry_id: undefined,
    receipt_hash: undefined,
  })) : [];
  const counters = isRecord(value.id_counters) ? value.id_counters : {};
  const currentSession = isRecord(value.current_session) ? value.current_session : {};
  return {
    ...(value as unknown as TaskState),
    structured_output: {
      ...output,
      contracts,
      validations,
      final_candidate_contract_id: undefined,
      final_candidate_sha256: undefined,
    } as StructuredOutputState,
    quality_gate: {
      claims: Array.isArray(quality.claims) ? quality.claims : [],
      escalations: Array.isArray(quality.escalations) ? quality.escalations.map((entry) => isRecord(entry) ? { ...entry, status: "pending" } : entry) : [],
      resolutions: [],
      assessments: Array.isArray(quality.assessments) ? quality.assessments : [],
    },
    current_session: {
      ...(currentSession as unknown as TaskState["current_session"]),
      output_contract_receipts: [],
      output_validation_receipts: [],
      quality_gate_resolution_receipts: [],
    },
    id_counters: {
      ...(counters as TaskState["id_counters"]),
      next_quality_gate_resolution: 1,
    },
  };
}

/** Strictly upgrades prior accepted v2 records only when every checkpoint/reset field is absent. */
function isPreContextResetV2State(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !lacksLaterWaveFields(value, 3) || hasOwn(value, "context_epoch") || hasOwn(value, "context_checkpoints")
    || hasOwn(value, "active_checkpoint_id") || hasOwn(value, "context_reset") || !isRecord(value.id_counters)
    || hasOwn(value.id_counters, "next_checkpoint")) return false;
  return isTaskStateV2({
    ...value,
    context_epoch: 0,
    context_checkpoints: [],
    active_checkpoint_id: undefined,
    context_reset: createContextResetState(),
    advisor_state: emptyAdvisorState(),
    id_counters: { ...value.id_counters, next_advisor_advice: hasOwn(value.id_counters, "next_advisor_advice") ? value.id_counters.next_advisor_advice : 1, next_checkpoint: 1 },
  });
}

function migratePreContextResetV2State(value: Record<string, unknown>): TaskState {
  const counters = value.id_counters;
  if (!isRecord(counters)) throw new Error("Prior v2 state has no durable ID counters for checkpoint migration.");
  return {
    ...(value as unknown as TaskState),
    context_epoch: 0,
    context_checkpoints: [],
    active_checkpoint_id: undefined,
    context_reset: createContextResetState(),
    advisor_state: hasOwn(value, "advisor_state") ? normalizeEarlyAdvisorState(value.advisor_state) : emptyAdvisorState(),
    id_counters: { ...(counters as TaskState["id_counters"]), next_advisor_advice: hasOwn(counters, "next_advisor_advice") ? counters.next_advisor_advice as number : 1, next_checkpoint: 1 },
  };
}

/** Adds Wave 4B audit state while keeping schema version 2 and old evidence unproven. */
function isPreAdvisorV2State(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value) || !isRecord(value.id_counters) || !lacksLaterWaveFields(value, 5)) return false;
  const advisor = value.advisor_state;
  const absent = !hasOwn(value, "advisor_state") && !hasOwn(value.id_counters, "next_advisor_advice");
  const early = isRecord(advisor)
    && hasOwn(value.id_counters, "next_advisor_advice")
    && !hasOwn(advisor, "automatic_reservations") && !hasOwn(advisor, "automatic_trigger_ids")
    && isAdvisorUsage(advisor.automatic_usage)
    && (advisor.last_trigger === undefined || advisor.last_trigger === "observed-failure" || advisor.last_trigger === "evidence-conflict" || advisor.last_trigger === "repair-exhausted")
    && isFiniteNumber(advisor.automatic_calls_used) && Number.isSafeInteger(advisor.automatic_calls_used) && advisor.automatic_calls_used >= 0
    && Array.isArray(advisor.records) && advisor.records.every((record) => isRecord(record) && !hasOwn(record, "attempted"));
  if (!absent && !early) return false;
  return isTaskStateV2({
    ...value,
    advisor_state: absent ? emptyAdvisorState() : normalizeEarlyAdvisorState(advisor),
    id_counters: { ...value.id_counters, next_advisor_advice: absent ? 1 : value.id_counters.next_advisor_advice },
  });
}

function migratePreAdvisorV2State(value: Record<string, unknown>): TaskState {
  const counters = value.id_counters;
  if (!isRecord(counters)) throw new Error("Prior v2 state has no durable ID counters for advisor migration.");
  const advisorState = normalizeEarlyAdvisorState(value.advisor_state);
  return {
    ...(value as unknown as TaskState),
    advisor_state: advisorState,
    id_counters: { ...(counters as TaskState["id_counters"]), next_advisor_advice: hasOwn(counters, "next_advisor_advice") ? counters.next_advisor_advice as number : 1 },
  };
}

function migrationRevision(state: TaskStateV1): WorkspaceRevision {
  try {
    return captureWorkspaceRevision(state.cwd);
  } catch {
    return {
      digest: "unknown",
      inventory_complete: false,
      observed_at: new Date().toISOString(),
      file_count: 0,
      directory_count: 0,
      total_bytes: 0,
      reason: "workspace revision capture failed during migration",
    };
  }
}

/**
 * Migrates only well-formed v1 records. A legacy complete status is blocked
 * until new receipts prove its criteria; old model claims remain history only.
 */
export function migrateTaskStateV1(state: TaskStateV1): TaskState {
  if (!isTaskStateV1(state)) throw new Error("Cannot migrate an invalid v1 reliability task state.");
  const workspaceRevision = migrationRevision(state);
  const criteria = createCriteria(state.success_criteria);
  const legacyVerification = state.verification.map((record) => ({ ...record, source: "legacy" as const }));
  const createdAt = new Date().toISOString();
  return {
    ...state,
    schema_version: 2,
    status: state.status === "complete" ? "blocked" : state.status,
    open_questions: state.status === "complete"
      ? [...state.open_questions, "Legacy completion must be re-verified with v2 receipts."]
      : state.open_questions,
    verification: legacyVerification,
    plan: state.plan.map((step) => ({
      ...step,
      exit_conditions: [],
      exit_evidence_receipt_ids: [],
      exit_evidence_artifact_refs: [],
    })),
    lane: "general",
    evidence_packs: [],
    active_evidence_pack_id: undefined,
    structured_output: createStructuredOutputState(),
    quality_gate: { claims: [], escalations: [], resolutions: [], assessments: [] },
    advisor_state: emptyAdvisorState(),
    dependency_evidence: [],
    coding_boundary: {
      status: "missing",
      task_id: state.task_id,
      branch_id: workspaceBranchIdentity(state.cwd, workspaceRevision),
      allowed_write_paths: [],
      reason: "Migrated v1 task has no pre-mutation coding baseline; require explicit user-reviewed recovery.",
    },
    scope_state: createScopeState(),
    criteria,
    trusted_check_mappings: [],
    execution_receipts: [],
    criterion_results: [],
    model_verification_claims: [],
    completion_gates: [],
    task_identity: {
      task_id: state.task_id,
      branch_id: workspaceBranchIdentity(state.cwd, workspaceRevision),
      created_workspace_revision: workspaceRevision.digest,
    },
    workspace_revision: workspaceRevision,
    pending_tool_calls: [],
    current_session: { branch_entry_ids: [], observed_at: createdAt },
    recovery: { total_attempts: 0, total_actions: 0, episodes: [] },
    id_counters: {
      next_advisor_advice: 1,
      next_criterion: criteria.length + 1,
      next_mapping: 1,
      next_receipt: 1,
      next_gate: 1,
      next_evidence_pack: 1,
      next_scope: 1,
      next_scope_change: 1,
      next_approval: 1,
      next_output_contract: 1,
      next_output_validation: 1,
      next_quality_gate_claim: 1,
      next_quality_gate_escalation: 1,
      next_quality_gate_assessment: 1,
      next_quality_gate_resolution: 1,
      next_checkpoint: 1,
    },
    context_epoch: 0,
    context_checkpoints: [],
    active_checkpoint_id: undefined,
    context_reset: createContextResetState(),
    retired_criterion_ids: [],
    authoritative_instructions: createAuthoritativeInstructions(state.user_goal),
    working_context: createWorkingContext(),
    migration: {
      source_schema_version: 1,
      backup_pending: true,
      migrated_at: createdAt,
      event_pending: true,
    },
    counters: {
      ...state.counters,
      blocked_calls: 0,
      errors_used: 0,
      iterations_used: 0,
    },
  };
}

function recognizeAndMigrateTaskState(value: unknown): TaskState | undefined {
  if (isTaskStateV2(value)) return value;
  if (isPreAdvisorV2State(value)) return migratePreAdvisorV2State(value);
  if (isPreContextResetV2State(value)) return migratePreContextResetV2State(value);
  if (isPreCorrectedWave4State(value)) return migratePreContextResetV2State(migratePreCorrectedWave4State(value));
  if (isPreStructuredOutputV2State(value)) return migratePreContextResetV2State(migratePreStructuredOutputV2State(value));
  if (isPreCodingV2State(value)) return migratePreContextResetV2State(migratePreStructuredOutputV2State(migratePreCodingV2State(value)));
  if (isPreScopeV2State(value)) return migratePreContextResetV2State(migratePreStructuredOutputV2State(migratePreCodingV2State(migratePreScopeV2State(value))));
  if (isPreEvidenceV2State(value)) return migratePreContextResetV2State(migratePreStructuredOutputV2State(migratePreCodingV2State(migratePreScopeV2State(migratePreEvidenceV2State(value)))));
  if (isTaskStateV1(value)) return migrateTaskStateV1(value);
  return undefined;
}


export function migrateTaskState(value: unknown): TaskState | undefined {
  const migrated = recognizeAndMigrateTaskState(value);
  return migrated && isTaskStateV2(migrated) ? migrated : undefined;
}
