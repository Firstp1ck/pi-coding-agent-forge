import { createHash } from "node:crypto";
import type {
  CriterionResult,
  ExecutionReceipt,
  ParsedVerificationResult,
  TaskState,
  TrustedCheckMapping,
  VerificationRecord,
  VerificationStatus,
} from "./types.ts";
import { completionAllowsTransition } from "./completion-gate.ts";
import { inputAuthorityBlockReason } from "./input-authority.ts";
import { nowIso, stableStringify, truncate } from "./utils.ts";
import { captureWorkspaceRevision, revisionsMatch, workspaceBranchIdentity } from "./workspace-revision.ts";

export function refreshWorkspaceRevision(state: TaskState): void {
  state.workspace_revision = captureWorkspaceRevision(state.cwd);
}

export function criterionForId(state: TaskState, criterionId: string | undefined): { id: string; requirement: string } | undefined {
  if (!criterionId) return undefined;
  return state.criteria.find((criterion) => criterion.id === criterionId);
}

/** Stable criterion IDs are the only completion identifiers accepted at runtime. */
export function resolveVerificationCriterion(state: TaskState, criterionId: string): string | undefined {
  return criterionForId(state, criterionId)?.id;
}

export function explicitVerificationFor(state: TaskState, criterionId: string): VerificationRecord | undefined {
  const resolved = resolveVerificationCriterion(state, criterionId);
  if (!resolved) return undefined;
  return [...state.verification].reverse().find((record) => record.criterion_id === resolved && record.source !== "harness" && record.source !== "legacy");
}

export function addOrUpdateVerification(state: TaskState, record: VerificationRecord): void {
  const criterionId = record.criterion_id;
  const index = state.verification.findIndex((item) => item.criterion_id === criterionId && item.source === record.source);
  if (index >= 0) state.verification[index] = record;
  else state.verification.push(record);
  if (state.verification.length > 80) state.verification.splice(0, state.verification.length - 80);
}

function latestResult(state: TaskState, criterionId: string): CriterionResult | undefined {
  return [...state.criterion_results].reverse().find((result) => result.criterion_id === criterionId);
}

function receiptForId(state: TaskState, receiptId: string): ExecutionReceipt | undefined {
  return state.execution_receipts.find((receipt) => receipt.id === receiptId);
}

function sessionProvenanceIsCurrent(
  state: TaskState,
  provenance: Pick<ExecutionReceipt, "session_id" | "session_anchor_entry_id">,
): boolean {
  const taskSessionId = state.task_identity.session_id;
  const current = state.current_session;
  // Direct module fixtures intentionally omit lifecycle identity. An installed
  // host that failed to provide it is distinct and cannot authorize evidence.
  if (current.lifecycle_identity === "unavailable") return false;
  if (!taskSessionId) return provenance.session_id === undefined;
  if (current.session_id !== taskSessionId) return false;
  if (state.task_identity.session_anchor_entry_id && !current.branch_entry_ids.includes(state.task_identity.session_anchor_entry_id)) return false;
  return provenance.session_id === taskSessionId
    && Boolean(provenance.session_anchor_entry_id)
    && current.branch_entry_ids.includes(provenance.session_anchor_entry_id as string);
}

function receiptSessionIsCurrent(state: TaskState, receipt: ExecutionReceipt): boolean {
  // Older receipt shapes may carry the preflight call anchor. They cannot be
  // upgraded implicitly because no persisted result outcome is attributable.
  if (receipt.session_id && typeof receipt.result_is_error !== "boolean") return false;
  return sessionProvenanceIsCurrent(state, receipt);
}

/** Native branch order, never wall-clock age or parsed status, proves post-instruction execution currency. */
export function receiptFollowsCurrentInstructions(state: TaskState, receipt: ExecutionReceipt): boolean {
  const instructions = state.authoritative_instructions;
  const session = state.current_session;
  // Sessionless reducer fixtures have no ordering proof once requirements change.
  if (!state.task_identity.session_id && session.lifecycle_identity !== "available") return instructions.corrections.length === 0;
  if (!receiptSessionIsCurrent(state, receipt) || inputAuthorityBlockReason(state)) return false;
  const resultIndex = session.branch_entry_ids.indexOf(receipt.session_anchor_entry_id ?? "");
  return [instructions.original_user_request, ...instructions.corrections].every((instruction) => {
    const instructionIndex = session.branch_entry_ids.indexOf(instruction.session_entry_id ?? "");
    return instruction.session_id === receipt.session_id && instructionIndex >= 0 && resultIndex > instructionIndex;
  });
}

function runtimeResultIsFresh(state: TaskState, result: CriterionResult): boolean {
  if (result.provenance !== "runtime" || result.status !== "passed" || !result.fresh) return false;
  if (!state.workspace_revision.inventory_complete || result.checked_workspace_revision !== state.workspace_revision.digest) return false;
  if (workspaceBranchIdentity(state.cwd, state.workspace_revision) !== state.task_identity.branch_id) return false;
  if (result.receipt_ids.length === 0) return false;
  return result.receipt_ids.every((receiptId) => {
    const receipt = receiptForId(state, receiptId);
    return receipt?.task_id === state.task_id
      && receipt.branch_id === state.task_identity.branch_id
      && receipt.outcome === "success"
      && receipt.execution_observed
      && receipt.host_provenance === "pi-builtin-bash"
      && receipt.batch_settled
      && receiptSessionIsCurrent(state, receipt)
      && receipt.criterion_ids.includes(result.criterion_id)
      && receipt.workspace_revision_before === state.workspace_revision.digest
      && receipt.workspace_revision_after === state.workspace_revision.digest;
  });
}

function userResultIsFresh(state: TaskState, result: CriterionResult): boolean {
  return result.provenance === "user"
    && result.status === "passed"
    && Boolean(result.attestation_id)
    && result.fresh
    && state.workspace_revision.inventory_complete
    && result.checked_workspace_revision === state.workspace_revision.digest
    && workspaceBranchIdentity(state.cwd, state.workspace_revision) === state.task_identity.branch_id
    && sessionProvenanceIsCurrent(state, result);
}

function recordFromResult(state: TaskState, result: CriterionResult, source: "runtime" | "user"): VerificationRecord {
  const criterion = criterionForId(state, result.criterion_id);
  return {
    criterion: criterion?.requirement ?? result.criterion_id,
    criterion_id: result.criterion_id,
    status: result.status,
    evidence: result.evidence,
    remaining_work: result.remaining_work,
    source,
    updated_at: result.recorded_at,
  };
}

function verificationForCriterion(state: TaskState, criterionId: string): VerificationRecord {
  const criterion = criterionForId(state, criterionId);
  const result = latestResult(state, criterionId);
  if (!criterion) {
    return {
      criterion: criterionId,
      criterion_id: criterionId,
      status: "unknown",
      evidence: "Unknown criterion ID.",
      remaining_work: "Use a stable criterion ID from the active task state.",
      source: "harness",
      updated_at: nowIso(),
    };
  }
  if (!result) {
    return {
      criterion: criterion.requirement,
      criterion_id: criterion.id,
      status: "unknown",
      evidence: "No attributable verification evidence recorded yet.",
      remaining_work: "Run a trusted mapped check or record a user-originated attestation.",
      source: "harness",
      updated_at: nowIso(),
    };
  }
  if (result.status === "failed" && result.checked_workspace_revision === state.workspace_revision.digest && state.workspace_revision.inventory_complete) {
    return recordFromResult(state, result, result.provenance === "user" ? "user" : "runtime");
  }
  if (runtimeResultIsFresh(state, result) || userResultIsFresh(state, result)) {
    return recordFromResult(state, result, result.provenance === "user" ? "user" : "runtime");
  }
  return {
    criterion: criterion.requirement,
    criterion_id: criterion.id,
    status: "unknown",
    evidence: result.provenance === "legacy" || result.provenance === "model"
      ? "Historic or model-authored verification is unproven."
      : "Verification evidence is stale, incomplete, or belongs to a different task, branch, revision, or unsettled batch.",
    remaining_work: "Run a trusted mapped check or record a current user-originated attestation.",
    source: "harness",
    updated_at: nowIso(),
  };
}

export function computeVerification(state: TaskState): VerificationRecord[] {
  refreshWorkspaceRevision(state);
  return state.criteria.filter((criterion) => criterion.required).map((criterion) => verificationForCriterion(state, criterion.id));
}

function saveCriterionResult(state: TaskState, result: CriterionResult): void {
  const index = state.criterion_results.findIndex((item) => item.criterion_id === result.criterion_id);
  if (index >= 0) state.criterion_results[index] = result;
  else state.criterion_results.push(result);
  if (state.criterion_results.length > 80) state.criterion_results.splice(0, state.criterion_results.length - 80);
  addOrUpdateVerification(state, recordFromResult(state, result, result.provenance === "user" ? "user" : "runtime"));
}

export function addTrustedCheckMapping(
  state: TaskState,
  mapping: Pick<TrustedCheckMapping, "criterion_id" | "operation" | "command" | "created_by">,
): TrustedCheckMapping {
  const criterion = criterionForId(state, mapping.criterion_id);
  if (!criterion || !mapping.operation.trim()) throw new Error("Trusted check mappings require an existing stable criterion ID and operation.");
  const normalizedCommand = mapping.command?.trim() || undefined;
  const existing = state.trusted_check_mappings.find((item) => item.criterion_id === criterion.id
    && item.operation === mapping.operation.trim()
    && item.command === normalizedCommand);
  if (existing) return existing;
  const next: TrustedCheckMapping = {
    id: `M${state.id_counters.next_mapping++}`,
    criterion_id: criterion.id,
    operation: mapping.operation.trim(),
    command: normalizedCommand,
    created_by: mapping.created_by,
    created_at: nowIso(),
  };
  state.trusted_check_mappings.push(next);
  return next;
}

function mappedCriteria(state: TaskState, receipt: ExecutionReceipt): string[] {
  return state.trusted_check_mappings
    .filter((mapping) => mapping.operation === receipt.operation && (!mapping.command || mapping.command === receipt.command))
    .map((mapping) => mapping.criterion_id);
}

/**
 * Applies a parsed tool outcome only to exact, host/user-created mappings. A
 * command never promotes unrelated criteria, and a pass needs a settled zero-exit receipt.
 */
export function applyParsedVerificationToCriteria(state: TaskState, parsed: ParsedVerificationResult, receipt: ExecutionReceipt): string[] {
  const criterionIds = mappedCriteria(state, receipt);
  receipt.criterion_ids = criterionIds;
  for (const criterionId of criterionIds) {
    const passed = parsed.status === "passed"
      && receipt.outcome === "success"
      && receipt.exit_code === 0
      && receipt.batch_settled
      && receipt.execution_observed
      && receipt.host_provenance === "pi-builtin-bash"
      && revisionsMatch(receipt.workspace_revision_before, receipt.workspace_revision_after)
      && receipt.workspace_revision_after === state.workspace_revision.digest;
    const status: VerificationStatus = parsed.status === "failed" ? "failed" : passed ? "passed" : "unknown";
    const result: CriterionResult = {
      criterion_id: criterionId,
      status,
      receipt_ids: [receipt.id],
      checked_workspace_revision: state.workspace_revision.digest,
      fresh: status !== "unknown",
      provenance: "runtime",
      recorded_at: nowIso(),
      evidence: truncate(parsed.summary, 800),
      remaining_work: status === "passed"
        ? ""
        : status === "failed"
          ? truncate(parsed.failure_excerpt || parsed.summary, 800)
          : "The check lacked a settled observed zero-exit receipt at one stable workspace revision.",
    };
    saveCriterionResult(state, result);
  }
  return criterionIds;
}

/** Model-facing verification is retained as a claim and cannot produce a passing result. */
export function mergeVerificationEvidence(
  state: TaskState,
  evidence: Array<{ criterionId?: string; criterion?: string; status?: VerificationStatus; evidence?: string; remainingWork?: string }> | undefined,
): void {
  if (!evidence) return;
  for (const item of evidence) {
    if (!item.status) continue;
    const criterionId = item.criterionId && resolveVerificationCriterion(state, item.criterionId);
    state.model_verification_claims.push({
      criterion_id: criterionId,
      criterion_text: item.criterion ? truncate(item.criterion, 220) : undefined,
      status: item.status,
      evidence: truncate(item.evidence || "Model-authored verification claim.", 800),
      remaining_work: truncate(item.remainingWork || "Requires runtime evidence or user attestation.", 800),
      recorded_at: nowIso(),
    });
  }
  if (state.model_verification_claims.length > 80) state.model_verification_claims.splice(0, state.model_verification_claims.length - 80);
}

export type UserAttestationBinding = {
  task_id: string;
  criterion_id: string;
  criterion_hash: string;
  workspace_revision: string;
  session_id: string;
  branch_id: string;
  branch_entry_ids: string[];
};

/** Captures exactly what a native confirmation may attest, before waiting on UI. */
export function captureUserAttestationBinding(state: TaskState, criterionId: string): UserAttestationBinding {
  const criterion = state.criteria.find((item) => item.id === criterionId);
  refreshWorkspaceRevision(state);
  const session = state.current_session;
  if (!criterion || !state.workspace_revision.inventory_complete
    || session.lifecycle_identity !== "available" || !session.session_id || session.session_id !== state.task_identity.session_id
    || workspaceBranchIdentity(state.cwd, state.workspace_revision) !== state.task_identity.branch_id) {
    throw new Error("User attestation requires a current criterion, complete workspace and available task/session identity.");
  }
  return {
    task_id: state.task_id,
    criterion_id: criterionId,
    criterion_hash: createHash("sha256").update(stableStringify(criterion)).digest("hex"),
    workspace_revision: state.workspace_revision.digest,
    session_id: session.session_id,
    branch_id: state.task_identity.branch_id,
    branch_entry_ids: [...session.branch_entry_ids],
  };
}

export function assertUserAttestationBinding(state: TaskState, binding: UserAttestationBinding): void {
  const current = captureUserAttestationBinding(state, binding.criterion_id);
  if (stableStringify(current) !== stableStringify(binding)) {
    throw new Error("The criterion, workspace or session branch changed while attestation confirmation was open; inspect and confirm again.");
  }
}

/** Only a user-command/native-confirmation integration may call this helper. */
export function recordUserAttestation(state: TaskState, criterionId: string, evidence: string, attestationId: string, binding?: UserAttestationBinding): void {
  const criterion = criterionForId(state, criterionId);
  if (!criterion || !attestationId.trim()) throw new Error("User attestations require an existing criterion ID and attribution ID.");
  if (binding) {
    const current = captureUserAttestationBinding(state, criterionId);
    // The native receipt itself extends the branch after the UI recheck.
    if (current.task_id !== binding.task_id || current.criterion_hash !== binding.criterion_hash
      || current.workspace_revision !== binding.workspace_revision || current.session_id !== binding.session_id
      || current.branch_id !== binding.branch_id || !binding.branch_entry_ids.every((id, index) => current.branch_entry_ids[index] === id)) {
      throw new Error("User attestation identity changed before its bound result could be recorded.");
    }
  } else {
    refreshWorkspaceRevision(state);
  }
  saveCriterionResult(state, {
    criterion_id: criterion.id,
    status: "passed",
    receipt_ids: [],
    checked_workspace_revision: state.workspace_revision.digest,
    fresh: state.workspace_revision.inventory_complete,
    provenance: "user",
    recorded_at: nowIso(),
    evidence: truncate(evidence, 800),
    remaining_work: "",
    attestation_id: attestationId,
    session_id: state.current_session.session_id,
    session_anchor_entry_id: state.current_session.branch_entry_ids.at(-1),
  });
}

export function invalidateVerificationEvidence(state: TaskState, reason: string): void {
  for (const result of state.criterion_results) {
    if (result.fresh) {
      result.fresh = false;
      result.remaining_work = truncate(reason, 800);
    }
  }
}

/**
 * Host-owned criterion replacement preserves IDs only for exact unchanged
 * requirements and invalidates all current completion evidence conservatively.
 */
export function replaceTaskCriteria(state: TaskState, requirements: string[]): void {
  const normalized = requirements.map((requirement) => requirement.trim()).filter(Boolean);
  if (normalized.length === 0 || normalized.length > 8 || new Set(normalized).size !== normalized.length) {
    throw new Error("Criteria must contain one to eight unique non-empty requirements.");
  }
  const existing = new Map(state.criteria.map((criterion) => [criterion.requirement, criterion]));
  const next = normalized.map((requirement) => {
    const prior = existing.get(requirement);
    if (prior) return prior;
    return { id: `C${state.id_counters.next_criterion++}`, requirement, expected_evidence: "validation" as const, required: true };
  });
  const nextIds = new Set(next.map((criterion) => criterion.id));
  const retired = state.criteria.filter((criterion) => !nextIds.has(criterion.id)).map((criterion) => criterion.id);
  state.retired_criterion_ids = [...new Set([...state.retired_criterion_ids, ...retired])];
  state.criteria = next;
  state.success_criteria = [...normalized];
  // Mappings cannot survive a criterion replacement: an old receipt must never
  // certify a newly introduced requirement, even if the text later repeats.
  state.trusted_check_mappings = state.trusted_check_mappings.filter((mapping) => nextIds.has(mapping.criterion_id));
  invalidateVerificationEvidence(state, "Acceptance criteria changed; prior completion evidence requires revalidation.");
}

export function formatVerification(records: VerificationRecord[]): string {
  if (records.length === 0) return "No verification criteria recorded.";
  return records.map((record) => {
    const status = record.status.toUpperCase();
    const rest = [record.evidence, record.remaining_work].filter(Boolean).join(" Remaining: ");
    return `${status}: ${record.criterion_id ?? "legacy"} — ${record.criterion}${rest ? ` — ${rest}` : ""}`;
  }).join("\n");
}

export function markTaskCompleteIfVerified(
  state: TaskState,
  source: TaskState["completion_gates"][number]["source"] = "explicit",
  controlToolCallId?: string,
): boolean {
  if (!completionAllowsTransition(state, source, controlToolCallId)) return false;
  for (const step of state.plan) {
    if (step.status === "pending" || step.status === "in_progress") step.status = "complete";
  }
  state.completed_steps = state.plan.map((step) => step.step_id);
  state.status = "complete";
  state.current_phase = "complete";
  state.current_step_id = state.plan.at(-1)?.step_id ?? state.current_step_id;
  return true;
}
