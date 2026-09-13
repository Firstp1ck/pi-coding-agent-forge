import { assessTaskCompletion, type CompletionGatePurpose } from "./completion-gate.ts";
import { criterionForId } from "./verification-state.ts";
import { inputAuthorityBlockReason } from "./input-authority.ts";
import { evaluateScopeCompletionRequirement, nativeAuthorityReceiptHash } from "./scope-state.ts";
import type {
  CompletionDecision,
  QualityGateAssessment,
  QualityGateResolution,
  QualityGateResolutionReceipt,
  ReliabilityGateName,
  SessionBranchIdentity,
  TaskState,
  VerificationStatus,
} from "./types.ts";
import { nowIso, stableStringify, truncate } from "./utils.ts";

const GATE_NAMES = ["retrieval", "agentic", "coding", "structured-output", "final"] as const;
const MAX_GATE_CLAIMS = 80;
const MAX_GATE_ESCALATIONS = 40;
const MAX_GATE_ASSESSMENTS = 80;
const MAX_GATE_RESOLUTIONS = 80;
export const RELIABILITY_QUALITY_GATE_RESOLUTION_ENTRY_TYPE = "reliability-quality-gate-resolution";

export type ReliabilityGateInput =
  | { action: "record"; gate: ReliabilityGateName; criterion: string; status: VerificationStatus; evidence: string; artifactRefs?: string[] }
  | { action: "assess"; gate: ReliabilityGateName }
  | { action: "escalate"; reason: string; decisionNeeded: string; evidence?: string[] }
  | { action: "validate-output"; contractId: string; candidate: string }
  | { action: "status"; gate?: ReliabilityGateName };

export type QualityGateResolutionBinding = { session: SessionBranchIdentity; receipt: QualityGateResolutionReceipt };
export type QualityGateDecisionTarget = { kind: "escalation"; id: string }
  | { kind: "semantic-review"; id: string; contractId: string; candidateSha256: string };

export type GateDecision = {
  decision: CompletionDecision;
  reasons: string[];
  failedCriteria: string[];
  unknownCriteria: string[];
  unresolvedConflicts: string[];
  scopeViolations: string[];
  approvalRequests: string[];
  evidenceRefs: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAllowedKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw new Error(`Unsupported reliability_gate field '${key}'.`);
}

function requiredString(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maxChars || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty string of at most ${maxChars} characters.`);
  }
  return value.trim();
}

function parseGate(value: unknown, field = "gate"): ReliabilityGateName {
  if (typeof value === "string" && (GATE_NAMES as readonly string[]).includes(value)) return value as ReliabilityGateName;
  throw new Error(`${field} must be retrieval, agentic, coding, structured-output, or final.`);
}

function parseStatus(value: unknown): VerificationStatus {
  if (value === "passed" || value === "failed" || value === "unknown") return value;
  throw new Error("status must be passed, failed, or unknown.");
}

function parseRefs(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) throw new Error(`${field} must contain at most 12 references.`);
  const refs = value.map((item, index) => requiredString(item, `${field}[${index}]`, 1_024));
  if (new Set(refs).size !== refs.length) throw new Error(`${field} must not contain duplicates.`);
  return refs;
}

/** Revalidates action-specific input after provider schema validation. */
export function validateReliabilityGateInput(input: unknown): ReliabilityGateInput {
  if (!isRecord(input) || typeof input.action !== "string") throw new Error("reliability_gate requires an action object.");
  switch (input.action) {
    case "record":
      assertAllowedKeys(input, ["action", "gate", "criterion", "status", "evidence", "artifactRefs"]);
      return {
        action: "record",
        gate: parseGate(input.gate),
        criterion: requiredString(input.criterion, "criterion", 64),
        status: parseStatus(input.status),
        evidence: requiredString(input.evidence, "evidence", 2_000),
        artifactRefs: parseRefs(input.artifactRefs, "artifactRefs"),
      };
    case "assess":
      assertAllowedKeys(input, ["action", "gate"]);
      return { action: "assess", gate: parseGate(input.gate) };
    case "escalate":
      assertAllowedKeys(input, ["action", "reason", "decisionNeeded", "evidence"]);
      return {
        action: "escalate",
        reason: requiredString(input.reason, "reason", 2_000),
        decisionNeeded: requiredString(input.decisionNeeded, "decisionNeeded", 2_000),
        evidence: parseRefs(input.evidence, "evidence"),
      };
    case "validate-output":
      assertAllowedKeys(input, ["action", "contractId", "candidate"]);
      return {
        action: "validate-output",
        contractId: requiredString(input.contractId, "contractId", 64),
        candidate: typeof input.candidate === "string" ? input.candidate : (() => { throw new Error("candidate must be a string."); })(),
      };
    case "status":
      assertAllowedKeys(input, ["action", "gate"]);
      return { action: "status", gate: input.gate === undefined ? undefined : parseGate(input.gate) };
    default:
      throw new Error(`Unsupported reliability_gate action '${input.action}'.`);
  }
}

function knownArtifactRef(state: TaskState, ref: string): boolean {
  if (state.evidence_packs.some((pack) => pack.pack_id === ref)) return true;
  if (state.structured_output.contracts.some((contract) => contract.contract_id === ref)) return true;
  if (state.structured_output.validations.some((validation) => validation.id === ref)) return true;
  return state.execution_receipts.some((receipt) => receipt.artifact_refs.includes(ref) || receipt.resource_refs.includes(ref));
}

/** Keeps model gate records as explicit claims; they are never verification results. */
export function recordQualityGateClaim(state: TaskState, input: Extract<ReliabilityGateInput, { action: "record" }>): void {
  const criterion = criterionForId(state, input.criterion);
  if (!criterion) throw new Error("reliability_gate record requires an exact active criterion ID; free-form criterion text cannot promote a pass.");
  if ((input.artifactRefs ?? []).some((ref) => !knownArtifactRef(state, ref))) {
    throw new Error("reliability_gate record references an unknown artifact or evidence ID.");
  }
  state.quality_gate.claims.push({
    id: `QGC${state.id_counters.next_quality_gate_claim++}`,
    gate: input.gate,
    criterion_id: criterion.id,
    status: input.status,
    evidence: truncate(input.evidence, 2_000),
    artifact_refs: [...(input.artifactRefs ?? [])],
    recorded_at: nowIso(),
  });
  if (state.quality_gate.claims.length > MAX_GATE_CLAIMS) state.quality_gate.claims.splice(0, state.quality_gate.claims.length - MAX_GATE_CLAIMS);
}

export function recordQualityGateEscalation(state: TaskState, input: Extract<ReliabilityGateInput, { action: "escalate" }>): void {
  state.quality_gate.escalations.push({
    id: `QGE${state.id_counters.next_quality_gate_escalation++}`,
    reason: truncate(input.reason, 2_000),
    decision_needed: truncate(input.decisionNeeded, 2_000),
    evidence_refs: [...(input.evidence ?? [])],
    recorded_at: nowIso(),
    status: "pending",
  });
  if (state.quality_gate.escalations.length > MAX_GATE_ESCALATIONS) state.quality_gate.escalations.splice(0, state.quality_gate.escalations.length - MAX_GATE_ESCALATIONS);
}

function unresolvedConflictIds(state: TaskState): string[] {
  return state.evidence_packs.flatMap((pack) => pack.assessment?.unresolved_conflict_claim_ids.map((claimId) => `${pack.pack_id}:${claimId}`) ?? []);
}

function gateScopedReasons(gate: ReliabilityGateName, decision: GateDecision): string[] {
  if (gate === "retrieval") return decision.unresolvedConflicts.length ? [`${decision.unresolvedConflicts.length} retrieval conflict(s) remain unresolved.`] : [];
  if (gate === "agentic") return decision.scopeViolations.length || decision.approvalRequests.length ? ["Agentic scope violations or approvals remain unresolved."] : [];
  if (gate === "structured-output") return decision.reasons.filter((reason) => /structured-output|output contract|output validation/i.test(reason));
  return [];
}

/**
 * Delegates all completion evidence to the sole shared authority, then presents
 * its result in the compact gate shape. Model records are intentionally absent.
 */
export function assessReliabilityGate(state: TaskState, gate: ReliabilityGateName, controlToolCallId?: string, record = true): GateDecision {
  const completion = assessTaskCompletion(state, record ? "gate-tool" : undefined, { source: "gate-tool", controlToolCallId, purpose: gate as CompletionGatePurpose });
  const criterionIdFor = (item: { criterion_id?: string; criterion: string }) => item.criterion_id
    ?? state.criteria.find((criterion) => criterion.requirement === item.criterion)?.id
    ?? item.criterion;
  const failedCriteria = completion.verification.filter((item) => item.status === "failed").map(criterionIdFor);
  const unknownCriteria = completion.verification.filter((item) => item.status === "unknown").map(criterionIdFor);
  const unresolvedConflicts = unresolvedConflictIds(state);
  const scopeViolations = evaluateScopeCompletionRequirement(state)?.reasons ?? [];
  const approvalRequests = [
    ...state.scope_state.pending_scope_changes.filter((request) => request.status === "pending").map((request) => request.id),
    ...state.scope_state.approvals.filter((approval) => approval.status === "pending").map((approval) => approval.id),
  ];
  const escalationReasons = state.quality_gate.escalations
    .filter((escalation) => !qualityGateEscalationIsResolved(state, escalation))
    .map((escalation) => `Escalation ${escalation.id}: ${escalation.reason} Decision needed: ${escalation.decision_needed}`);
  const initial: GateDecision = {
    decision: completion.decision,
    reasons: [...completion.reasons, ...escalationReasons],
    failedCriteria,
    unknownCriteria,
    unresolvedConflicts,
    scopeViolations,
    approvalRequests,
    evidenceRefs: completion.evidence_refs,
  };
  const scoped = gateScopedReasons(gate, initial);
  const reasons = [...new Set([...initial.reasons, ...scoped])].slice(0, 24);
  const decision = completion.decision;
  return { ...initial, decision, reasons };
}

/** Captures immutable disclosure/identity before native UI; recapture before appending any authority. */
export function captureQualityGateDecisionBinding(state: TaskState, target: QualityGateDecisionTarget): { identity: string; disclosure: string } {
  const session = state.current_session;
  const inputBlock = inputAuthorityBlockReason(state);
  if (inputBlock) throw new Error(inputBlock);
  if (session.lifecycle_identity !== "available" || !session.session_id || session.session_id !== state.task_identity.session_id) {
    throw new Error("Quality-gate decision requires current native task/session identity.");
  }
  const escalation = target.kind === "escalation" ? state.quality_gate.escalations.find((item) => item.id === target.id) : undefined;
  const item = target.kind === "escalation" ? escalation
    : state.structured_output.validations.find((validation) => validation.id === target.id && validation.contract_id === target.contractId
      && validation.candidate_sha256 === target.candidateSha256 && validation.human_review_required && !validation.superseded_by_contract_id);
  if (!item) throw new Error("The quality-gate decision target is no longer current.");
  if (escalation && qualityGateEscalationIsResolved(state, escalation)) {
    throw new Error("The quality escalation already has a current native decision.");
  }
  const latestDecision = [...state.quality_gate.resolutions].reverse().find((resolution) => resolution.target_kind === target.kind && resolution.target_id === target.id);
  return {
    identity: stableStringify({
      task_id: state.task_id,
      task_identity: state.task_identity,
      session_id: session.session_id,
      lifecycle_identity: session.lifecycle_identity,
      branch_entry_ids: session.branch_entry_ids,
      authoritative_instructions: state.authoritative_instructions,
      input_pause: state.input_pause,
      mutation_blocked: state.context_reset.mutation_blocked,
      target: item,
      latest_decision: latestDecision,
      next_resolution: state.id_counters.next_quality_gate_resolution,
    }),
    disclosure: stableStringify({ task_id: state.task_id, goal: state.user_goal, kind: target.kind, target: item }),
  };
}

/** Applies a native user decision to one unresolved escalation or semantic-review candidate, retaining history. */
export function resolveQualityGateItem(
  state: TaskState,
  target: QualityGateDecisionTarget,
  decision: "approved" | "rejected",
  binding: QualityGateResolutionBinding,
): QualityGateResolution {
  if (binding.session.lifecycle_identity !== "available" || !state.task_identity.session_id || binding.session.session_id !== state.task_identity.session_id) {
    throw new Error("Quality-gate resolution requires the current available Pi lifecycle identity.");
  }
  const id = `QGR${state.id_counters.next_quality_gate_resolution}`;
  const data = {
    task_id: state.task_id,
    resolution_id: id,
    target_kind: target.kind,
    target_id: target.id,
    ...(target.kind === "semantic-review" ? { contract_id: target.contractId, candidate_sha256: target.candidateSha256 } : {}),
    decision,
  };
  const receipt = binding.receipt;
  if (receipt.task_id !== state.task_id || receipt.resolution_id !== id || receipt.target_kind !== target.kind || receipt.target_id !== target.id
    || receipt.decision !== decision || receipt.contract_id !== data.contract_id || receipt.candidate_sha256 !== data.candidate_sha256
    || receipt.receipt_hash !== nativeAuthorityReceiptHash(RELIABILITY_QUALITY_GATE_RESOLUTION_ENTRY_TYPE, data)
    || !binding.session.branch_entry_ids.includes(receipt.entry_id)
    || !binding.session.quality_gate_resolution_receipts?.some((candidate) => candidate.entry_id === receipt.entry_id && candidate.receipt_hash === receipt.receipt_hash)) {
    throw new Error("Quality-gate resolution receipt was not persisted on the current Pi branch.");
  }
  if (target.kind === "escalation") {
    const escalation = state.quality_gate.escalations.find((item) => item.id === target.id);
    if (!escalation || qualityGateEscalationIsResolved(state, escalation)) throw new Error("Only a quality escalation without a current native decision may be resolved.");
    escalation.status = decision;
    escalation.resolved_at = nowIso();
    escalation.resolution_id = id;
  } else {
    const validation = state.structured_output.validations.find((item) => item.id === target.id && item.contract_id === target.contractId && item.candidate_sha256 === target.candidateSha256 && !item.superseded_by_contract_id);
    if (!validation || !validation.human_review_required) throw new Error("Semantic review resolution must reference one current human-review-required validation.");
  }
  const resolution: QualityGateResolution = {
    id,
    target_kind: target.kind,
    target_id: target.id,
    contract_id: data.contract_id,
    candidate_sha256: data.candidate_sha256,
    decision,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    resolved_at: nowIso(),
    session_id: binding.session.session_id,
    session_anchor_entry_id: receipt.entry_id,
    receipt_hash: receipt.receipt_hash,
  };
  state.id_counters.next_quality_gate_resolution += 1;
  state.quality_gate.resolutions.push(resolution);
  if (state.quality_gate.resolutions.length > MAX_GATE_RESOLUTIONS) state.quality_gate.resolutions.splice(0, state.quality_gate.resolutions.length - MAX_GATE_RESOLUTIONS);
  return resolution;
}

/** Historical resolutions are audit records until their exact native receipt is current. */
export function qualityGateResolutionIsCurrent(state: TaskState, resolution: QualityGateResolution): boolean {
  const session = state.current_session;
  if (session.lifecycle_identity !== "available" || !session.session_id
    || session.session_id !== state.task_identity.session_id || session.session_id !== resolution.session_id
    || resolution.task_id !== state.task_id || resolution.branch_id !== state.task_identity.branch_id
    || !resolution.session_anchor_entry_id || !session.branch_entry_ids.includes(resolution.session_anchor_entry_id)) return false;
  const data = qualityGateResolutionReceiptData(state, resolution.id,
    resolution.target_kind === "escalation"
      ? { kind: "escalation", id: resolution.target_id }
      : { kind: "semantic-review", id: resolution.target_id, contractId: resolution.contract_id!, candidateSha256: resolution.candidate_sha256! },
    resolution.decision);
  const hash = nativeAuthorityReceiptHash(RELIABILITY_QUALITY_GATE_RESOLUTION_ENTRY_TYPE, data);
  return resolution.receipt_hash === hash && Boolean(session.quality_gate_resolution_receipts?.some((receipt) =>
    receipt.entry_id === resolution.session_anchor_entry_id && receipt.receipt_hash === hash
    && Object.entries(data).every(([key, value]) => receipt[key as keyof QualityGateResolutionReceipt] === value)));
}

export function qualityGateEscalationIsResolved(state: TaskState, escalation: TaskState["quality_gate"]["escalations"][number]): boolean {
  const latest = [...state.quality_gate.resolutions].reverse().find((resolution) => resolution.target_kind === "escalation" && resolution.target_id === escalation.id);
  return Boolean(latest && latest.id === escalation.resolution_id && latest.decision === escalation.status && qualityGateResolutionIsCurrent(state, latest));
}

export function qualityGateResolutionReceiptData(state: TaskState, resolutionId: string, target: QualityGateDecisionTarget, decision: "approved" | "rejected"): Record<string, string> {
  return {
    task_id: state.task_id,
    resolution_id: resolutionId,
    target_kind: target.kind,
    target_id: target.id,
    ...(target.kind === "semantic-review" ? { contract_id: target.contractId, candidate_sha256: target.candidateSha256 } : {}),
    decision,
  };
}

export function saveQualityGateAssessment(state: TaskState, gate: ReliabilityGateName, decision: GateDecision): QualityGateAssessment {
  const assessment: QualityGateAssessment = {
    id: `QGA${state.id_counters.next_quality_gate_assessment++}`,
    gate,
    decision: decision.decision,
    reasons: [...decision.reasons],
    failed_criteria: [...decision.failedCriteria],
    unknown_criteria: [...decision.unknownCriteria],
    unresolved_conflicts: [...decision.unresolvedConflicts],
    scope_violations: [...decision.scopeViolations],
    approval_requests: [...decision.approvalRequests],
    evidence_refs: [...decision.evidenceRefs],
    assessed_at: nowIso(),
  };
  state.quality_gate.assessments.push(assessment);
  if (state.quality_gate.assessments.length > MAX_GATE_ASSESSMENTS) state.quality_gate.assessments.splice(0, state.quality_gate.assessments.length - MAX_GATE_ASSESSMENTS);
  return assessment;
}

export function formatGateDecision(gate: ReliabilityGateName, decision: GateDecision): string {
  const lines = [
    `Reliability gate ${gate}: ${decision.decision.toUpperCase()}.`,
    ...decision.reasons.map((reason) => `- ${reason}`),
  ];
  if (decision.failedCriteria.length) lines.push(`Failed criteria: ${decision.failedCriteria.join(", ")}.`);
  if (decision.unknownCriteria.length) lines.push(`Unknown criteria: ${decision.unknownCriteria.join(", ")}.`);
  if (decision.unresolvedConflicts.length) lines.push(`Unresolved conflicts: ${decision.unresolvedConflicts.join(", ")}.`);
  if (decision.scopeViolations.length) lines.push(`Scope violations: ${decision.scopeViolations.join(" | ")}.`);
  if (decision.approvalRequests.length) lines.push(`Pending scope/approval records: ${decision.approvalRequests.join(", ")}.`);
  return lines.join("\n");
}

export function formatQualityGateStatus(state: TaskState, gate?: ReliabilityGateName): string {
  const assessments = state.quality_gate.assessments.filter((assessment) => !gate || assessment.gate === gate).slice(-5);
  const lines = [
    `Gate claims: ${state.quality_gate.claims.length} untrusted model claim/reference record(s).`,
    `Escalations: ${state.quality_gate.escalations.length} unresolved record(s).`,
  ];
  if (assessments.length) lines.push(...assessments.map((assessment) => `${assessment.id} ${assessment.gate}: ${assessment.decision} (${assessment.reasons.length} reason(s)).`));
  else lines.push("No recorded gate assessments.");
  return lines.join("\n");
}
