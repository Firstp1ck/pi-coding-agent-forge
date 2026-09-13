import type { CompletionDecision, CompletionGateResult, ReliabilityConfig, TaskState } from "./types.ts";
import { DEFAULT_CONFIG } from "./types.ts";
import { isTaskStateV2 } from "./state-migration.ts";
import { assistantHasToolCall, assistantText, nowIso } from "./utils.ts";
import { computeVerification, formatVerification, refreshWorkspaceRevision } from "./verification-state.ts";
import { evaluateRetrievalEvidenceRequirement } from "./evidence-gate.ts";
import { evaluateScopeCompletionRequirement } from "./scope-state.ts";
import { codingValidationCriteria, evaluateCodingCompletionRequirement } from "./dependency-evidence.ts";
import { evaluateMicroplanCompletion } from "./planner.ts";
import { evaluateStructuredOutputCompletionRequirement } from "./structured-output.ts";
import { qualityGateEscalationIsResolved } from "./quality-gate.ts";
import { workspaceBranchIdentity } from "./workspace-revision.ts";
import { inputAuthorityBlockReason } from "./input-authority.ts";

function assistantClaimsCompletion(text: string): boolean {
  return /\b(done|complete|completed|implemented|fixed|finished|resolved|verified|validated|created)\b/i.test(text)
    && !/\b(partial|partially|not complete|remaining|unknown|cannot verify|unverified)\b/i.test(text);
}

export type CompletionAssessment = {
  decision: CompletionDecision;
  reasons: string[];
  verification: CompletionGateResult["verification"];
  evidence_refs: string[];
};

export type CompletionRequirement = (state: TaskState) => {
  decision: CompletionDecision;
  reasons: string[];
  evidence_refs?: string[];
} | undefined;

const completionRequirements = new Map<string, CompletionRequirement>();

/** Registers a named lane requirement for the sole completion authority. */
export function registerCompletionRequirement(name: string, requirement: CompletionRequirement): void {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) throw new Error("Completion requirement names must be stable lowercase identifiers.");
  completionRequirements.set(name, requirement);
}

export type CompletionGatePurpose = "retrieval" | "agentic" | "coding" | "structured-output" | "final";

export type CompletionAssessmentOptions = {
  /** Only the in-flight reliability control invocation can be ignored. */
  controlToolCallId?: string;
  source?: TaskState["completion_gates"][number]["source"];
  /** A lane assessment may check only its declared phase requirements; final remains exhaustive. */
  purpose?: CompletionGatePurpose;
};

function isOwnControlCall(state: TaskState, toolCallId: string | undefined, source: CompletionAssessmentOptions["source"]): boolean {
  if (!toolCallId || !source) return false;
  const pending = state.pending_tool_calls.find((call) => call.tool_call_id === toolCallId);
  if (!pending) return false;
  return (source === "verify-tool" && pending.operation === "reliability_verify_completion")
    || (source === "progress-tool" && pending.operation === "reliability_record_progress")
    || (source === "worker-result" && pending.operation === "reliability_submit_worker_result")
    || (source === "gate-tool" && pending.operation === "reliability_gate");
}

/**
 * The sole completion authority. It deliberately evaluates current filesystem
 * identity, unsettled batches, and exact criterion coverage before a task can
 * transition to complete.
 */
export function assessTaskCompletion(
  state: TaskState,
  source?: TaskState["completion_gates"][number]["source"],
  options: CompletionAssessmentOptions = {},
): CompletionAssessment {
  if (!isTaskStateV2(state)) {
    return {
      decision: "escalate",
      reasons: ["Task state is malformed, incomplete, or has no required acceptance criteria and requires recovery."],
      verification: [],
      evidence_refs: [],
    };
  }
  const inputBlock = inputAuthorityBlockReason(state);
  if (inputBlock || state.context_reset.mutation_blocked) return { decision: "escalate", reasons: [inputBlock ?? state.context_reset.freeze_reason ?? "Checkpoint recovery is required."], verification: [], evidence_refs: [] };
  const purpose = options.purpose ?? "final";
  refreshWorkspaceRevision(state);
  const verification = purpose === "final" ? computeVerification(state)
    : purpose === "coding" ? computeVerification(state).filter((item) => codingValidationCriteria(state).includes(item.criterion_id!)) : [];
  const reasons: string[] = [];
  const phaseStarted = purpose === "retrieval" ? state.lane === "retrieval" && state.evidence_packs.length > 0
    : purpose === "agentic" ? state.lane === "agentic" && state.scope_state.active_scope?.lane === "agentic"
    : purpose === "coding" ? state.lane === "coding" && state.scope_state.active_scope?.lane === "coding"
    : purpose === "structured-output" ? state.lane === "structured-output" && state.structured_output.contracts.length > 0
    : true;
  if (purpose !== "final" && !phaseStarted) reasons.push(`${purpose} phase has not started; no lane evidence is available to assess.`);
  if (!state.workspace_revision.inventory_complete) reasons.push(state.workspace_revision.reason || "Workspace revision inventory is incomplete.");
  if (workspaceBranchIdentity(state.cwd, state.workspace_revision) !== state.task_identity.branch_id) {
    reasons.push("Task evidence belongs to a different branch or workspace identity.");
  }
  const hasUnsettledCalls = state.pending_tool_calls.some((call) => !isOwnControlCall(state, options.controlToolCallId === call.tool_call_id ? call.tool_call_id : undefined, source));
  if (hasUnsettledCalls) reasons.push("A relevant tool batch is still unsettled.");
  const failed = verification.filter((item) => item.status === "failed");
  const unknown = verification.filter((item) => item.status === "unknown");
  if (failed.length > 0) reasons.push(`${failed.length} required criterion or criteria failed.`);
  if (unknown.length > 0) reasons.push(`${unknown.length} required criterion or criteria remain unknown.`);

  let requirementFailed = false;
  const evidenceRefs: string[] = [];
  const collectRequirement = (name: string, evaluation: ReturnType<CompletionRequirement>): void => {
    if (!evaluation) return;
    if (evaluation.evidence_refs) evidenceRefs.push(...evaluation.evidence_refs);
    if (evaluation.decision === "fail") {
      requirementFailed = true;
      reasons.push(...evaluation.reasons.map((reason) => `[${name}] ${reason}`));
    } else if (evaluation.decision === "escalate") {
      reasons.push(...evaluation.reasons.map((reason) => `[${name}] ${reason}`));
    }
  };
  const include = (name: CompletionGatePurpose): boolean => purpose === "final" || purpose === name;
  if (include("retrieval")) try {
    collectRequirement("retrieval-evidence", evaluateRetrievalEvidenceRequirement(state));
  } catch (error) {
    requirementFailed = true;
    reasons.push(`[retrieval-evidence] Completion requirement could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (include("agentic")) try {
    collectRequirement("execution-scope", evaluateScopeCompletionRequirement(state));
  } catch (error) {
    requirementFailed = true;
    reasons.push(`[execution-scope] Completion requirement could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (include("coding")) try {
    collectRequirement("coding-dependency", evaluateCodingCompletionRequirement(state));
    collectRequirement("microplan-exits", evaluateMicroplanCompletion(state));
  } catch (error) {
    requirementFailed = true;
    reasons.push(`[coding] Completion requirement could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (include("structured-output")) try {
    collectRequirement("structured-output", evaluateStructuredOutputCompletionRequirement(state, purpose === "final"));
  } catch (error) {
    requirementFailed = true;
    reasons.push(`[structured-output] Completion requirement could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [name, requirement] of completionRequirements) {
    if (name === "retrieval-evidence") continue;
    try {
      collectRequirement(name, requirement(state));
    } catch (error) {
      reasons.push(`[${name}] Completion requirement could not be evaluated: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const pendingQualityEscalations = state.quality_gate.escalations.filter((escalation) => !qualityGateEscalationIsResolved(state, escalation));
  if (pendingQualityEscalations.length) reasons.push(`${pendingQualityEscalations.length} quality escalation(s) require an attributable native decision.`);

  const decision: CompletionDecision = failed.length > 0 || requirementFailed
    ? "fail"
    : reasons.length > 0
      ? "escalate"
      : "pass";
  if (source) {
    state.completion_gates.push({
      id: `G${state.id_counters.next_gate++}`,
      source,
      decision,
      reasons: [...reasons],
      checked_workspace_revision: state.workspace_revision.digest,
      created_at: nowIso(),
    });
    if (state.completion_gates.length > 80) state.completion_gates.splice(0, state.completion_gates.length - 80);
  }
  return { decision, reasons, verification, evidence_refs: [...new Set(evidenceRefs)] };
}

export function completionAllowsTransition(
  state: TaskState,
  source: TaskState["completion_gates"][number]["source"],
  controlToolCallId?: string,
): boolean {
  return assessTaskCompletion(state, source, { controlToolCallId, source }).decision === "pass";
}

export function evaluateCompletionGate(state: TaskState, assistantMessageOrText: unknown, hasToolCallOrConfig: boolean | ReliabilityConfig, maybeConfig?: ReliabilityConfig): CompletionGateResult {
  const text = typeof assistantMessageOrText === "string" ? assistantMessageOrText : assistantText(assistantMessageOrText);
  const hasToolCall = typeof hasToolCallOrConfig === "boolean" ? hasToolCallOrConfig : assistantHasToolCall(assistantMessageOrText);
  const config = typeof hasToolCallOrConfig === "boolean" ? maybeConfig ?? DEFAULT_CONFIG : hasToolCallOrConfig;
  const completionClaim = assistantClaimsCompletion(text) && !hasToolCall;
  const assessment = assessTaskCompletion(state, completionClaim ? "message-end" : undefined);
  const failed = assessment.verification.filter((item) => item.status === "failed").length;
  const unknown = assessment.verification.filter((item) => item.status === "unknown").length;
  const triggered = completionClaim && assessment.decision !== "pass";
  return {
    triggered,
    strict: config.profile === "strict",
    failed,
    unknown,
    decision: assessment.decision,
    reasons: assessment.reasons,
    message: triggered
      ? `Reliability completion gate ${assessment.decision}: ${assessment.reasons.join(" ")}`
      : "Completion gate not triggered.",
    verification: assessment.verification,
  };
}

export function buildCompletionGatePrompt(stateOrResult: TaskState | CompletionGateResult, maybeResult?: CompletionGateResult): string {
  const result = maybeResult ?? stateOrResult as CompletionGateResult;
  return [
    result.message,
    "Do not claim completion yet. Provide a trusted mapped check, a user-originated attestation, or clearly report partial/blocked work.",
    formatVerification(result.verification),
  ].join("\n\n");
}
