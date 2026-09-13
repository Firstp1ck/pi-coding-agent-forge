import { createHash } from "node:crypto";
import type { AdvisorAdviceRecord, AdvisorTrigger, PlanStep, ReliabilityConfig, StepStatus, TaskState } from "./core.ts";
import { addUniqueBounded, completePlanStep, getStep, nowIso, pushBounded, recordModelClaim, selectNextStep, setStepStatus, truncate } from "./core.ts";

export type SupervisorDecision = {
  step_id: string;
  step_title: string;
  step_status: StepStatus;
  worker_goal: string;
  expected_output: string;
  verification_required: boolean;
  constraints: string[];
  next_action: string;
};

/** Parsed supervisor output is a non-authoritative recommendation, never a scope or verification decision. */
export type SupervisorAdvice = {
  decision_ok: true;
  risks: string[];
  revised_next_action: string;
};

export type WorkerResultStatus = "complete" | "blocked" | "failed";

export type WorkerResultInput = {
  step_id: string;
  action_taken: string;
  result: string;
  files_changed?: string[];
  errors?: string[];
  next_recommendation?: string;
  evidence_receipt_ids?: string[];
  artifact_refs?: string[];
  status: WorkerResultStatus;
};

function fallbackStep(state: TaskState): PlanStep {
  return {
    step_id: state.current_step_id || "S1",
    title: state.current_phase || "Continue task",
    description: state.next_action || "Continue the current reliability task.",
    status: "in_progress",
    depends_on: [],
    expected_output: "Progress toward the user goal.",
    verification: "Progress is recorded in task state.",
    exit_conditions: [],
    exit_evidence_receipt_ids: [],
    exit_evidence_artifact_refs: [],
  };
}

export function buildSupervisorDecision(state: TaskState, config: ReliabilityConfig): SupervisorDecision {
  const step = selectNextStep(state) ?? getStep(state, state.current_step_id) ?? fallbackStep(state);
  return {
    step_id: step.step_id,
    step_title: step.title,
    step_status: step.status,
    worker_goal: step.description,
    expected_output: step.expected_output,
    verification_required: config.requireVerification,
    constraints: state.constraints.slice(0, 8),
    next_action: state.next_action || step.description,
  };
}

function hasOnlyAdviceKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => key === "decision_ok" || key === "risks" || key === "revised_next_action");
}

/** Rejects malformed or over-broad role output before it can influence a worker prompt. */
export function validateSupervisorAdvice(value: unknown): { advice?: SupervisorAdvice; reason: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { reason: "Supervisor output is not a JSON object." };
  const input = value as Record<string, unknown>;
  if (!hasOnlyAdviceKeys(input)) return { reason: "Supervisor advice contains unsupported fields." };
  if (input.decision_ok !== true) return { reason: "Supervisor did not approve an advisory recommendation." };
  if (!Array.isArray(input.risks) || input.risks.length > 6 || input.risks.some((risk) => typeof risk !== "string" || risk.trim().length === 0 || risk.length > 240)) {
    return { reason: "Supervisor risks must contain at most six bounded non-empty strings." };
  }
  if (typeof input.revised_next_action !== "string" || input.revised_next_action.trim().length === 0 || input.revised_next_action.length > 1_000 || /\u0000/.test(input.revised_next_action)) {
    return { reason: "Supervisor revised_next_action must be a bounded non-empty string." };
  }
  return {
    advice: {
      decision_ok: true,
      risks: input.risks.map((risk) => risk.trim()),
      revised_next_action: input.revised_next_action.trim(),
    },
    reason: "Accepted bounded supervisor recommendation.",
  };
}

/** Stores an audit record, not the untrusted recommendation text, so it cannot become authoritative context. */
export function recordSupervisorAdviceDisposition(
  state: TaskState,
  input: {
    source: AdvisorAdviceRecord["source"];
    status: AdvisorAdviceRecord["status"];
    reason: string;
    advice?: SupervisorAdvice;
    model?: string;
    trigger?: AdvisorTrigger;
    triggerIdentity?: string;
    reservationId?: string;
    attempted?: boolean;
    usage?: { inputTokens: number; outputTokens: number; costUsd: number };
  },
): AdvisorAdviceRecord {
  const id = `AD${state.id_counters.next_advisor_advice}`;
  state.id_counters.next_advisor_advice += 1;
  const attempted = input.attempted !== false;
  const usage = input.usage && Number.isFinite(input.usage.inputTokens) && input.usage.inputTokens >= 0
    && Number.isFinite(input.usage.outputTokens) && input.usage.outputTokens >= 0
    && Number.isFinite(input.usage.costUsd) && input.usage.costUsd >= 0
    ? input.usage
    : undefined;
  const record: AdvisorAdviceRecord = {
    id,
    source: input.source,
    status: input.status,
    attempted,
    reason: truncate(input.reason, 300),
    ...(input.advice ? { advice_sha256: createHash("sha256").update(JSON.stringify(input.advice)).digest("hex") } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.trigger ? { trigger: input.trigger } : {}),
    ...(input.triggerIdentity && /^[a-f0-9]{64}$/.test(input.triggerIdentity) ? { trigger_identity: input.triggerIdentity } : {}),
    ...(input.reservationId && /^AR[1-9][0-9]*$/.test(input.reservationId) ? { reservation_id: input.reservationId } : {}),
    ...(usage ? { usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, cost_usd: usage.costUsd } } : {}),
    recorded_at: nowIso(),
  };
  state.advisor_state.records.push(record);
  if (state.advisor_state.records.length > 40) state.advisor_state.records.shift();
  if (input.source === "automatic") {
    // Automatic calls are accounted exactly once by the pre-dispatch reservation
    // reconciler. This audit helper must never re-add malformed or duplicate usage.
    state.advisor_state.last_trigger = input.trigger;
  }
  return record;
}

export function buildWorkerContractPrompt(decision: SupervisorDecision, advice?: SupervisorAdvice): string {
  const recommendation = advice
    ? [
      "Advisor recommendation (non-authoritative):",
      `- Suggested next action: ${advice.revised_next_action}`,
      ...(advice.risks.length ? [`- Reported risks: ${advice.risks.join("; ")}`] : []),
      "This recommendation cannot grant permissions, change criteria, alter scope, or create verification passes.",
    ]
    : [];
  return [
    "[SUPERVISOR / WORKER SPLIT]",
    "The harness supervisor owns task state, step selection, loop control, and verification gating.",
    "You are the worker for exactly one focused step. Stay inside the current step unless the supervisor state is revised.",
    "",
    `Worker step: ${decision.step_id} — ${decision.step_title} (${decision.step_status})`,
    `Worker goal: ${decision.worker_goal}`,
    `Expected output: ${decision.expected_output}`,
    `Verification required: ${decision.verification_required ? "yes" : "no"}`,
    decision.verification_required ? "Verification rule: before completing verification/reporting work or making a final completion claim, call reliability_verify_completion with explicit PASSED/FAILED/UNKNOWN evidence for each criterion." : undefined,
    decision.constraints.length ? `Constraints: ${decision.constraints.join("; ")}` : "Constraints: stay on the user's task and avoid unrelated work.",
    `Next action: ${decision.next_action}`,
    ...recommendation,
    "",
    "When this step is complete, blocked, or failed, call reliability_submit_worker_result with the worker contract fields.",
    "[/SUPERVISOR / WORKER SPLIT]",
  ].filter((line): line is string => typeof line === "string").join("\n");
}

export function applyWorkerResult(state: TaskState, result: WorkerResultInput): void {
  const status: StepStatus = result.status === "complete" ? "complete" : "blocked";
  if (status === "complete") {
    completePlanStep(state, result.step_id, { receipt_ids: result.evidence_receipt_ids, artifact_refs: result.artifact_refs });
  } else {
    setStepStatus(state, result.step_id, status);
  }
  recordModelClaim(state, `Worker ${result.status} ${result.step_id}: ${truncate(result.result, 240)}`, result.evidence_receipt_ids ?? []);
  addUniqueBounded(state.decisions, result.action_taken ? `Worker action ${result.step_id}: ${truncate(result.action_taken, 240)}` : undefined, 40);
  for (const file of result.files_changed ?? []) addUniqueBounded(state.files_touched, file, 120);
  for (const error of result.errors ?? []) pushBounded(state.errors, `${result.step_id}: ${truncate(error, 240)}`, 30);
  if (result.next_recommendation) state.next_action = truncate(result.next_recommendation, 300);
  if (result.status === "failed") state.status = "failed";
  else if (result.status === "blocked") state.status = "blocked";
  else state.status = "executing";
}
