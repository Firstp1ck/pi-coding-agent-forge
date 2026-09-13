import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import { automaticAdvisorIsAuthorized } from "./config.ts";
import { redactSensitiveText } from "./redaction.ts";
import { scopeFingerprint } from "./scope-state.ts";
import type { AdvisorDataScope, AdvisorReservation, AdvisorTrigger, ReliabilityConfig, ReliabilityRole, TaskState, VerificationStatus } from "./types.ts";
import { buildContextHeader, computeVerification, nowIso, stableStringify, truncate } from "./core.ts";
import type { SupervisorAdvice, SupervisorDecision, WorkerResultInput } from "./supervisor.ts";
import { buildSupervisorDecision, buildWorkerContractPrompt, validateSupervisorAdvice } from "./supervisor.ts";

export type RolePromptSet = Record<ReliabilityRole, string>;

export type RoleUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

export type RoleRunResult = {
  role: ReliabilityRole;
  model?: string;
  prompt: string;
  output: string;
  exitCode: number;
  stderr: string;
  messages: Message[];
  usage?: RoleUsage;
  stdoutChars?: number;
  stderrChars?: number;
  cancelled?: boolean;
  timedOut?: boolean;
  overLimit?: boolean;
  error?: string;
};

export type AdvisorTriggerDecision = {
  eligible: boolean;
  trigger?: AdvisorTrigger;
  triggerIdentity?: string;
  reason: string;
};

export type AutomaticAdvisorRecommendation = {
  revised_next_action: string;
  hypotheses: string[];
  evidence_refs?: string[];
};

export type AutomaticAdvisorDiagnosticPacket = {
  schema_version: 1;
  task_id: string;
  session_id?: string;
  session_branch_sha256: string;
  branch_id: string;
  current_step_id: string;
  lane: string;
  scope_sha256?: string;
  requirements_sha256: string;
  failure_episode_sha256: string;
  trigger: AdvisorTrigger;
  /** Current attributable failure/conflict/repair identity reserved before dispatch. */
  trigger_identity: string;
  diagnostic: {
    goal: string;
    requirements: string[];
    constraints: string[];
    failure_summaries: string[];
    conflict_pack_ids: string[];
  };
  identity_sha256: string;
};

export type AutomaticAdvisorAdmission = {
  /** A proven upper bound for all provider-visible input tokens. */
  inputTokens: number;
  /** Provider-enforced output cap included in the durable reservation. */
  maxOutputTokens: number;
  /** A pricing-derived upper bound for the complete call. */
  maxCostUsd: number;
};

export type AutomaticAdvisorAdapter = {
  model: string;
  kind: "native" | "simulated";
  /** Returns no admission when token or price caps cannot be proven before dispatch. */
  admit(diagnostic: AutomaticAdvisorDiagnosticPacket, limits: Readonly<{ remainingTokens: number; remainingCostUsd: number; maxOutputChars: number }>): AutomaticAdvisorAdmission | undefined;
  invoke(packet: Readonly<{ model: string; dataScope: AdvisorDataScope; diagnostic: AutomaticAdvisorDiagnosticPacket; maxOutputChars: number; maxOutputTokens: number; maxCostUsd: number }>, signal: AbortSignal): Promise<{ output: string; usage?: RoleUsage }>;
};

export type AutomaticAdvisorRunResult = {
  outcome: "accepted" | "rejected" | "unavailable" | "cancelled" | "not-eligible";
  reason: string;
  trigger?: AdvisorTrigger;
  attempted: boolean;
  recommendation?: AutomaticAdvisorRecommendation;
  usage?: RoleUsage;
  reservationId?: string;
  triggerIdentity?: string;
};

export type SeparateModelOrchestrationResult = {
  mode: "dry-run" | "separate-model";
  decision: SupervisorDecision;
  prompts: RolePromptSet;
  roleResults: RoleRunResult[];
  supervisorAdvice?: SupervisorAdvice;
  adviceDisposition?: { status: "applied" | "rejected"; reason: string };
  workerResult?: WorkerResultInput;
  verificationEvidence?: Array<{ criterion?: string; status?: VerificationStatus; evidence?: string; remainingWork?: string }>;
  errors: string[];
  /** Only a fully bounded, valid three-role result can affect task state. */
  executionAllowed: boolean;
};

export type RoleInvocationBudget = {
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostUsd: number;
};

export type RoleRunner = (role: ReliabilityRole, prompt: string, state: TaskState, config: ReliabilityConfig, signal?: AbortSignal, budget?: RoleInvocationBudget) => Promise<RoleRunResult>;
export type RoleProcessInvocationFactory = (args: string[]) => { command: string; args: string[] };

const ROLE_ORDER: ReliabilityRole[] = ["supervisor", "worker", "verifier"];
const MAX_ROLE_MESSAGES = 16;

function roleSystemPrompt(role: ReliabilityRole): string {
  if (role === "supervisor") {
    return [
      "You are the reliability supervisor.",
      "Review the persistent task state and selected step. Do not execute tools or modify files.",
      "Return only JSON with keys decision_ok, risks, revised_next_action.",
      "Your response is advisory only: it cannot grant permissions, alter acceptance criteria, or verify work.",
    ].join("\n");
  }
  if (role === "worker") {
    return [
      "You are the reliability worker for exactly one supervisor-selected step.",
      "Use only the context and tools needed for that step. Avoid unrelated changes.",
      "End with a JSON object matching: { step_id, action_taken, result, files_changed, errors, next_recommendation, status }.",
    ].join("\n");
  }
  return [
    "You are the reliability verifier.",
    "Verify the worker result against the task success criteria and current evidence.",
    "Return only JSON with key evidence: [{ criterion, status, evidence, remainingWork }]. Use status passed, failed, or unknown.",
  ].join("\n");
}

function taskStateExcerpt(state: TaskState, config: ReliabilityConfig): string {
  const { header } = buildContextHeader(state, { ...config, contextMode: "compact" });
  return header;
}

export function buildRolePrompts(
  state: TaskState,
  config: ReliabilityConfig,
  decision = buildSupervisorDecision(state, config),
  workerOutput = "",
  supervisorAdvice?: SupervisorAdvice,
): RolePromptSet {
  const stateExcerpt = taskStateExcerpt(state, config);
  const verification = computeVerification(state)
    .map((item) => `${item.status.toUpperCase()}: ${item.criterion} — ${item.evidence || item.remaining_work}`)
    .join("\n") || "No verification evidence recorded yet.";
  const workerContract = buildWorkerContractPrompt(decision, supervisorAdvice);

  return {
    supervisor: [
      roleSystemPrompt("supervisor"),
      "",
      stateExcerpt,
      "",
      "Deterministic supervisor decision:",
      JSON.stringify(decision, null, 2),
    ].join("\n"),
    worker: [
      roleSystemPrompt("worker"),
      "",
      workerContract,
      "",
      stateExcerpt,
      "",
      "Return only the worker contract JSON after any necessary tool work.",
    ].join("\n"),
    verifier: [
      roleSystemPrompt("verifier"),
      "",
      stateExcerpt,
      "",
      "Current verification evidence:",
      verification,
      "",
      "Worker output to verify:",
      workerOutput || "(no worker output yet)",
    ].join("\n"),
  };
}

export function buildDryRunOrchestration(state: TaskState, config: ReliabilityConfig): SeparateModelOrchestrationResult {
  const decision = buildSupervisorDecision(state, config);
  return {
    mode: "dry-run",
    decision,
    prompts: buildRolePrompts(state, config, decision),
    roleResults: [],
    errors: [],
    executionAllowed: false,
  };
}

type CurrentAdvisorTrigger = { trigger: AdvisorTrigger; identity: string; reason: string };

function advisorTriggerIdentity(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

/** Returns only current host-observed failure/conflict/repair state; model prose never admits advice. */
function currentAdvisorTrigger(state: TaskState, config: ReliabilityConfig): CurrentAdvisorTrigger | undefined {
  const latestReceipt = state.execution_receipts.at(-1);
  if (latestReceipt?.execution_observed && latestReceipt.outcome === "error" && latestReceipt.result_is_error === true) {
    return {
      trigger: "observed-failure",
      identity: advisorTriggerIdentity({ task_id: state.task_id, branch_id: state.task_identity.branch_id, receipt_id: latestReceipt.id, tool_call_id: latestReceipt.tool_call_id, workspace_revision: latestReceipt.workspace_revision_after }),
      reason: "The current host-observed execution receipt failed.",
    };
  }
  const conflicts = state.evidence_packs
    .filter((pack) => (pack.assessment?.unresolved_conflict_claim_ids.length ?? 0) > 0)
    .map((pack) => ({ pack_id: pack.pack_id, sha256: pack.sha256, unresolved: pack.assessment?.unresolved_conflict_claim_ids ?? [] }));
  if (conflicts.length) {
    return {
      trigger: "evidence-conflict",
      identity: advisorTriggerIdentity({ task_id: state.task_id, branch_id: state.task_identity.branch_id, conflicts }),
      reason: "Current evidence has an unresolved conflict.",
    };
  }
  const exhausted = latestReceipt?.outcome === "success"
    ? undefined
    : [...state.recovery.episodes].reverse().find((episode) => episode.attempts >= config.maxRecoveryAttempts || episode.actions >= config.maxRecoveryActions);
  if (exhausted) {
    return {
      trigger: "repair-exhausted",
      identity: advisorTriggerIdentity({ task_id: state.task_id, branch_id: state.task_identity.branch_id, step_id: exhausted.step_id, workspace_revision: exhausted.workspace_revision, failure_signature: exhausted.failure_signature, attempts: exhausted.attempts, actions: exhausted.actions }),
      reason: "A current host-recorded repair episode exhausted its limit.",
    };
  }
  return undefined;
}

function reservedAdvisorUsage(state: TaskState): { inputTokens: number; outputTokens: number; costUsd: number } {
  return state.advisor_state.automatic_reservations.reduce((total, reservation) => ({
    inputTokens: total.inputTokens + reservation.reserved_input_tokens,
    outputTokens: total.outputTokens + reservation.reserved_output_tokens,
    costUsd: total.costUsd + reservation.reserved_cost_usd,
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
}

/** Automatic advice is eligible only after one current attributable failure, conflict, or exhausted repair episode. */
export function automaticAdvisorTrigger(state: TaskState, config: ReliabilityConfig): AdvisorTriggerDecision {
  if (!automaticAdvisorIsAuthorized(config.advisor)) {
    return { eligible: false, reason: "Automatic advisor is off until an exact model, diagnostic data scope, and positive call/token/cost budgets are user-configured." };
  }
  const usage = state.advisor_state.automatic_usage;
  if (usage.unknown_usage_calls > 0) {
    return { eligible: false, reason: "Automatic advisor usage is unknown after an attempted call, so its token and cost budgets cannot be safely extended." };
  }
  if (state.advisor_state.automatic_calls_used >= config.advisor.maxCalls) {
    return { eligible: false, reason: "Automatic advisor call budget is exhausted." };
  }
  const reserved = reservedAdvisorUsage(state);
  if (usage.input_tokens + usage.output_tokens + reserved.inputTokens + reserved.outputTokens >= config.advisor.maxTotalTokens || usage.cost_usd + reserved.costUsd >= config.advisor.maxTotalCostUsd) {
    return { eligible: false, reason: "Automatic advisor token or cost capacity is fully accounted or reserved." };
  }
  const current = currentAdvisorTrigger(state, config);
  if (!current) return { eligible: false, reason: "No current attributable failed receipt, unresolved evidence conflict, or exhausted repair episode requires advisor assistance." };
  if (state.advisor_state.automatic_trigger_ids.includes(current.identity)) {
    return { eligible: false, reason: "This current failure/conflict/repair episode was already reserved or reconciled for automatic advice." };
  }
  return { eligible: true, trigger: current.trigger, triggerIdentity: current.identity, reason: current.reason };
}

function boundedRedacted(value: string, maximum: number): string {
  return truncate(redactSensitiveText(value), maximum);
}

function diagnosticTriggerIdentity(state: TaskState, trigger: AdvisorTrigger): string {
  const latestReceipt = state.execution_receipts.at(-1);
  const conflicts = state.evidence_packs
    .filter((pack) => (pack.assessment?.unresolved_conflict_claim_ids.length ?? 0) > 0)
    .map((pack) => ({ pack_id: pack.pack_id, sha256: pack.sha256, unresolved: pack.assessment?.unresolved_conflict_claim_ids ?? [] }));
  return advisorTriggerIdentity({
    trigger,
    task_id: state.task_id,
    branch_id: state.task_identity.branch_id,
    latest_receipt: latestReceipt ? { id: latestReceipt.id, outcome: latestReceipt.outcome, observed: latestReceipt.execution_observed, result_is_error: latestReceipt.result_is_error, workspace_revision: latestReceipt.workspace_revision_after } : undefined,
    conflicts,
    recovery: state.recovery.episodes.slice(-2).map((episode) => ({ step_id: episode.step_id, workspace_revision: episode.workspace_revision, failure_signature: episode.failure_signature, attempts: episode.attempts, actions: episode.actions })),
  });
}

function boundedDiagnosticPacket(state: TaskState, trigger: AdvisorTrigger): AutomaticAdvisorDiagnosticPacket {
  const activeScope = state.scope_state.active_scope;
  const requirements = state.criteria.slice(0, 10).map((criterion) => boundedRedacted(criterion.requirement, 500));
  const failureSummaries = state.execution_receipts
    .filter((receipt) => receipt.execution_observed && receipt.outcome === "error" && receipt.result_is_error === true)
    .slice(-4)
    .map((receipt) => boundedRedacted(`${receipt.operation} failed (receipt ${receipt.id}, exit ${receipt.exit_code ?? "unknown"}).`, 600));
  const failureEpisodes = state.recovery.episodes.slice(-2).map((episode) => ({
    step_id: episode.step_id,
    workspace_revision: episode.workspace_revision,
    failure_signature: episode.failure_signature,
    attempts: episode.attempts,
    actions: episode.actions,
  }));
  const draft = {
    schema_version: 1 as const,
    task_id: state.task_id,
    session_id: state.current_session.session_id,
    session_branch_sha256: createHash("sha256").update(stableStringify(state.current_session.branch_entry_ids)).digest("hex"),
    branch_id: state.task_identity.branch_id,
    current_step_id: state.current_step_id,
    lane: state.lane,
    ...(activeScope ? { scope_sha256: scopeFingerprint(activeScope) } : {}),
    requirements_sha256: createHash("sha256").update(stableStringify({ requirements: state.success_criteria, constraints: state.constraints, authoritative: state.authoritative_instructions })).digest("hex"),
    failure_episode_sha256: createHash("sha256").update(stableStringify(failureEpisodes)).digest("hex"),
    trigger,
    trigger_identity: diagnosticTriggerIdentity(state, trigger),
    diagnostic: {
      goal: boundedRedacted(state.normalized_goal, 600),
      requirements,
      constraints: state.constraints.slice(0, 8).map((constraint) => boundedRedacted(constraint, 300)),
      failure_summaries: failureSummaries,
      conflict_pack_ids: state.evidence_packs
        .filter((pack) => (pack.assessment?.unresolved_conflict_claim_ids.length ?? 0) > 0)
        .map((pack) => pack.pack_id)
        .slice(0, 12),
    },
  };
  const identitySha256 = createHash("sha256").update(stableStringify(draft)).digest("hex");
  return { ...draft, identity_sha256: identitySha256 };
}

export function buildAutomaticAdvisorDiagnostic(state: TaskState, trigger: AdvisorTrigger): AutomaticAdvisorDiagnosticPacket {
  const packet = boundedDiagnosticPacket(state, trigger);
  if (JSON.stringify(packet).length > 8_000) throw new Error("Automatic advisor diagnostic packet exceeds its bounded data scope.");
  return packet;
}

export function automaticAdvisorDiagnosticIsCurrent(state: TaskState, packet: AutomaticAdvisorDiagnosticPacket): boolean {
  const current = boundedDiagnosticPacket(state, packet.trigger);
  return current.identity_sha256 === packet.identity_sha256;
}

function automaticRecommendationChangesAuthority(value: AutomaticAdvisorRecommendation): boolean {
  const text = [value.revised_next_action, ...value.hypotheses, ...(value.evidence_refs ?? [])].join("\n");
  return /\b(?:grant|expand|set|mark|approve|pass|modify|change)\b[^\n]{0,80}\b(?:permission|permissions|scope|criterion|criteria|status|verification|approval)\b/i.test(text);
}

export function parseAutomaticAdvisorRecommendation(text: string): { recommendation?: AutomaticAdvisorRecommendation; reason: string } {
  const parsed = parseJsonObject(text);
  if (!parsed || !exactKeys(parsed, ["revised_next_action", "hypotheses", "evidence_refs"])) return { reason: "Automatic advisor output must be one strict JSON recommendation object." };
  if (!isBoundedString(parsed.revised_next_action, 1_000) || !Array.isArray(parsed.hypotheses) || parsed.hypotheses.length > 2 || parsed.hypotheses.some((item) => !isBoundedString(item, 500))) {
    return { reason: "Automatic advisor recommendation or hypotheses exceed their bounds." };
  }
  if (parsed.evidence_refs !== undefined && (!Array.isArray(parsed.evidence_refs) || parsed.evidence_refs.length > 6 || parsed.evidence_refs.some((item) => !isBoundedString(item, 240)))) {
    return { reason: "Automatic advisor evidence references exceed their bounds." };
  }
  const recommendation: AutomaticAdvisorRecommendation = {
    revised_next_action: parsed.revised_next_action,
    hypotheses: parsed.hypotheses,
    ...(parsed.evidence_refs ? { evidence_refs: parsed.evidence_refs } : {}),
  };
  if (automaticRecommendationChangesAuthority(recommendation)) {
    return { reason: "Automatic advisor output attempted to modify permissions, criteria, scope, or verification status." };
  }
  return { recommendation, reason: "Accepted bounded automatic advisor recommendation." };
}

function validRoleUsage(value: unknown): value is RoleUsage {
  return Boolean(value)
    && finiteNonNegative((value as RoleUsage).inputTokens)
    && finiteNonNegative((value as RoleUsage).outputTokens)
    && finiteNonNegative((value as RoleUsage).costUsd);
}

function removeReservation(state: TaskState, reservation: AdvisorReservation): void {
  state.advisor_state.automatic_reservations = state.advisor_state.automatic_reservations
    .filter((item) => item.id !== reservation.id);
}

function rollbackUnattemptedReservation(state: TaskState, reservation: AdvisorReservation): void {
  removeReservation(state, reservation);
  state.advisor_state.automatic_calls_used = Math.max(0, state.advisor_state.automatic_calls_used - 1);
  state.advisor_state.automatic_trigger_ids = state.advisor_state.automatic_trigger_ids
    .filter((identity) => identity !== reservation.trigger_identity);
}

/** Reconciles exactly one durable reservation without permitting non-finite usage into task state. */
function settleAutomaticReservation(state: TaskState, reservation: AdvisorReservation, attempted: boolean, usage: RoleUsage | undefined): void {
  removeReservation(state, reservation);
  if (!attempted) {
    rollbackUnattemptedReservation(state, reservation);
    return;
  }
  if (!validRoleUsage(usage)) {
    state.advisor_state.automatic_usage.unknown_usage_calls += 1;
    return;
  }
  state.advisor_state.automatic_usage.input_tokens += usage.inputTokens;
  state.advisor_state.automatic_usage.output_tokens += usage.outputTokens;
  state.advisor_state.automatic_usage.cost_usd += usage.costUsd;
}

function reserveAutomaticAdvisor(
  state: TaskState,
  trigger: AdvisorTrigger,
  triggerIdentity: string,
  model: string,
  admission: AutomaticAdvisorAdmission,
): AdvisorReservation {
  const reservation: AdvisorReservation = {
    id: `AR${state.id_counters.next_advisor_advice++}`,
    task_id: state.task_id,
    session_id: state.current_session.session_id,
    branch_id: state.task_identity.branch_id,
    trigger,
    trigger_identity: triggerIdentity,
    model,
    reserved_input_tokens: admission.inputTokens,
    reserved_output_tokens: admission.maxOutputTokens,
    reserved_cost_usd: admission.maxCostUsd,
    created_at: nowIso(),
  };
  state.advisor_state.automatic_calls_used += 1;
  state.advisor_state.automatic_reservations.push(reservation);
  state.advisor_state.automatic_trigger_ids.push(triggerIdentity);
  if (state.advisor_state.automatic_trigger_ids.length > 40) state.advisor_state.automatic_trigger_ids.shift();
  return reservation;
}

function validAdmission(value: unknown, remainingTokens: number, remainingCostUsd: number): value is AutomaticAdvisorAdmission {
  if (!value || typeof value !== "object") return false;
  const admission = value as AutomaticAdvisorAdmission;
  return Number.isSafeInteger(admission.inputTokens)
    && admission.inputTokens > 0
    && Number.isSafeInteger(admission.maxOutputTokens)
    && admission.maxOutputTokens > 0
    && finiteNonNegative(admission.maxCostUsd)
    && admission.inputTokens + admission.maxOutputTokens <= remainingTokens
    && admission.maxCostUsd <= remainingCostUsd;
}

/** Invokes only a pre-admitted exact-model advisor; it never starts a worker, tool replay, or continuation turn. */
export async function runAutomaticAdvisor(
  state: TaskState,
  config: ReliabilityConfig,
  adapter: AutomaticAdvisorAdapter | undefined,
  signal?: AbortSignal,
  onReserved?: (reservation: AdvisorReservation) => void,
): Promise<AutomaticAdvisorRunResult> {
  const eligibility = automaticAdvisorTrigger(state, config);
  if (!eligibility.eligible || !eligibility.trigger || !eligibility.triggerIdentity) return { outcome: "not-eligible", reason: eligibility.reason, attempted: false };
  if (!adapter || !config.advisor.exactModel || adapter.model !== config.advisor.exactModel || config.advisor.dataScope !== "diagnostic-summary") {
    return { outcome: "unavailable", reason: "No exact authorized automatic advisor adapter is available; no model substitution occurred.", trigger: eligibility.trigger, triggerIdentity: eligibility.triggerIdentity, attempted: false };
  }
  if (signal?.aborted) return { outcome: "cancelled", reason: "Automatic advisor was cancelled before invocation.", trigger: eligibility.trigger, triggerIdentity: eligibility.triggerIdentity, attempted: false };
  let diagnostic: AutomaticAdvisorDiagnosticPacket;
  try {
    diagnostic = buildAutomaticAdvisorDiagnostic(state, eligibility.trigger);
  } catch (error) {
    return { outcome: "rejected", reason: error instanceof Error ? error.message : String(error), trigger: eligibility.trigger, triggerIdentity: eligibility.triggerIdentity, attempted: false };
  }
  const priorUsage = state.advisor_state.automatic_usage;
  const held = reservedAdvisorUsage(state);
  const remainingTokens = config.advisor.maxTotalTokens - priorUsage.input_tokens - priorUsage.output_tokens - held.inputTokens - held.outputTokens;
  const remainingCostUsd = config.advisor.maxTotalCostUsd - priorUsage.cost_usd - held.costUsd;
  let admission: AutomaticAdvisorAdmission | undefined;
  try {
    admission = adapter.admit(diagnostic, { remainingTokens, remainingCostUsd, maxOutputChars: config.advisor.maxOutputChars });
  } catch (error) {
    return { outcome: "unavailable", reason: `Automatic advisor admission could not prove a safe token/cost cap: ${error instanceof Error ? error.message : String(error)}`, trigger: eligibility.trigger, triggerIdentity: eligibility.triggerIdentity, attempted: false };
  }
  if (!validAdmission(admission, remainingTokens, remainingCostUsd)) {
    return { outcome: "unavailable", reason: "Automatic advisor lacks a safe pre-dispatch input, output, or cost admission cap; no call was made.", trigger: eligibility.trigger, triggerIdentity: eligibility.triggerIdentity, attempted: false };
  }
  const reservation = reserveAutomaticAdvisor(state, eligibility.trigger, eligibility.triggerIdentity, adapter.model, admission);
  try {
    onReserved?.(reservation);
  } catch (error) {
    // A save may have committed before a later bookkeeping error. Retain the
    // reservation rather than risk dispatching or retrying an uncertain attempt.
    return { outcome: "unavailable", reason: `Automatic advisor reservation was not durably confirmed: ${error instanceof Error ? error.message : String(error)}`, trigger: eligibility.trigger, triggerIdentity: eligibility.triggerIdentity, reservationId: reservation.id, attempted: false };
  }
  if (signal?.aborted) {
    rollbackUnattemptedReservation(state, reservation);
    return { outcome: "cancelled", reason: "Automatic advisor was cancelled before invocation.", trigger: eligibility.trigger, triggerIdentity: eligibility.triggerIdentity, reservationId: reservation.id, attempted: false };
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let attempted = false;
  let knownUsage: RoleUsage | undefined;
  const complete = (result: Omit<AutomaticAdvisorRunResult, "reservationId" | "triggerIdentity">): AutomaticAdvisorRunResult => {
    settleAutomaticReservation(state, reservation, attempted, knownUsage);
    return { ...result, reservationId: reservation.id, triggerIdentity: eligibility.triggerIdentity };
  };
  try {
    const invocation = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("Cancelled before advisor invocation.");
      attempted = true;
      return adapter.invoke({
        model: adapter.model,
        dataScope: config.advisor.dataScope!,
        diagnostic,
        maxOutputChars: config.advisor.maxOutputChars,
        maxOutputTokens: admission.maxOutputTokens,
        maxCostUsd: admission.maxCostUsd,
      }, controller.signal);
    }).then((value) => ({ kind: "result" as const, value }), (error) => ({ kind: "error" as const, error }));
    const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ kind: "timeout" });
      }, config.advisor.maxRuntimeMs);
    });
    const callerAbort = new Promise<{ kind: "abort" }>((resolve) => {
      abortListener = () => {
        controller.abort();
        resolve({ kind: "abort" });
      };
      signal?.addEventListener("abort", abortListener, { once: true });
    });
    const settled = await Promise.race([invocation, timeout, callerAbort]);
    if (settled.kind === "timeout") return complete({ outcome: "cancelled", reason: "Automatic advisor exceeded its configured deadline; late output was ignored.", trigger: eligibility.trigger, attempted });
    if (settled.kind === "abort") return complete({ outcome: "cancelled", reason: "Automatic advisor was cancelled; late output was ignored.", trigger: eligibility.trigger, attempted });
    if (settled.kind === "error") return complete({ outcome: controller.signal.aborted ? "cancelled" : "rejected", reason: `Automatic advisor failed: ${settled.error instanceof Error ? settled.error.message : String(settled.error)}`, trigger: eligibility.trigger, attempted });
    if (controller.signal.aborted) return complete({ outcome: "cancelled", reason: "Automatic advisor output was ignored after cancellation.", trigger: eligibility.trigger, attempted });
    const response = settled.value;
    knownUsage = validRoleUsage(response?.usage) ? response.usage : undefined;
    if (!knownUsage) return complete({ outcome: "rejected", reason: "Automatic advisor usage is missing or malformed; the attempted call is now conservatively unknown.", trigger: eligibility.trigger, attempted });
    if (!response || typeof response.output !== "string" || response.output.length > config.advisor.maxOutputChars) {
      return complete({ outcome: "rejected", reason: "Automatic advisor returned malformed or oversized output.", trigger: eligibility.trigger, attempted, usage: knownUsage });
    }
    if (knownUsage.inputTokens > admission.inputTokens || knownUsage.outputTokens > admission.maxOutputTokens || knownUsage.costUsd > admission.maxCostUsd) {
      return complete({ outcome: "rejected", reason: "Automatic advisor exceeded its pre-dispatch reservation; actual finite usage was retained and later calls are blocked by the budget.", trigger: eligibility.trigger, attempted, usage: knownUsage });
    }
    if (!automaticAdvisorDiagnosticIsCurrent(state, diagnostic)) {
      return complete({ outcome: "rejected", reason: "Automatic advisor response is stale for the current task/session/branch/step/scope/failure identity.", trigger: eligibility.trigger, attempted, usage: knownUsage });
    }
    const parsed = parseAutomaticAdvisorRecommendation(response.output);
    if (!parsed.recommendation) return complete({ outcome: "rejected", reason: parsed.reason, trigger: eligibility.trigger, attempted, usage: knownUsage });
    return complete({ outcome: "accepted", reason: parsed.reason, trigger: eligibility.trigger, attempted, recommendation: parsed.recommendation, usage: knownUsage });
  } finally {
    if (timer) clearTimeout(timer);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}


function finalAssistantOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Reads only actual Pi message metadata; generated role text cannot attest token or cost usage. */
export function trustedAssistantUsage(message: unknown): RoleUsage | undefined {
  const usage = (message as { usage?: { input?: unknown; output?: unknown; cost?: { total?: unknown } } } | undefined)?.usage;
  if (!usage || !finiteNonNegative(usage.input) || !finiteNonNegative(usage.output) || !finiteNonNegative(usage.cost?.total)) return undefined;
  return { inputTokens: usage.input, outputTokens: usage.output, costUsd: usage.cost.total };
}

function usageFromMessages(messages: Message[]): RoleUsage | undefined {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let found = false;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const usage = trustedAssistantUsage(message);
    if (!usage) return undefined;
    found = true;
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    costUsd += usage.costUsd;
  }
  return found ? { inputTokens, outputTokens, costUsd } : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)?.[1] ?? trimmed;
  try {
    const value: unknown = JSON.parse(fenced);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function isBoundedString(value: unknown, maximum: number, allowEmpty = false): value is string {
  return typeof value === "string" && value.length <= maximum && (allowEmpty || value.trim().length > 0) && !value.includes("\u0000");
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function parseWorkerResultFromText(text: string): WorkerResultInput | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed || !exactKeys(parsed, ["step_id", "action_taken", "result", "files_changed", "errors", "next_recommendation", "evidence_receipt_ids", "artifact_refs", "status"])) return undefined;
  if (!isBoundedString(parsed.step_id, 96) || !isBoundedString(parsed.action_taken, 2_000) || !isBoundedString(parsed.result, 8_000)) return undefined;
  if (parsed.status !== "complete" && parsed.status !== "blocked" && parsed.status !== "failed") return undefined;
  const stringArray = (value: unknown, maximumItems: number, maximumItemChars: number): string[] | undefined => Array.isArray(value)
    && value.length <= maximumItems
    && value.every((item) => isBoundedString(item, maximumItemChars)) ? value : undefined;
  const filesChanged = parsed.files_changed === undefined ? [] : stringArray(parsed.files_changed, 24, 1_024);
  const errors = parsed.errors === undefined ? [] : stringArray(parsed.errors, 24, 2_000);
  const evidenceReceiptIds = parsed.evidence_receipt_ids === undefined ? undefined : stringArray(parsed.evidence_receipt_ids, 24, 96);
  const artifactRefs = parsed.artifact_refs === undefined ? undefined : stringArray(parsed.artifact_refs, 24, 1_024);
  if (!filesChanged || !errors || (parsed.next_recommendation !== undefined && !isBoundedString(parsed.next_recommendation, 1_000)) || (parsed.evidence_receipt_ids !== undefined && !evidenceReceiptIds) || (parsed.artifact_refs !== undefined && !artifactRefs)) return undefined;
  return {
    step_id: parsed.step_id,
    action_taken: parsed.action_taken,
    result: parsed.result,
    files_changed: filesChanged,
    errors,
    ...(typeof parsed.next_recommendation === "string" ? { next_recommendation: parsed.next_recommendation } : {}),
    ...(evidenceReceiptIds ? { evidence_receipt_ids: evidenceReceiptIds } : {}),
    ...(artifactRefs ? { artifact_refs: artifactRefs } : {}),
    status: parsed.status,
  };
}

export function parseSupervisorAdviceFromText(text: string): { advice?: SupervisorAdvice; reason: string } {
  return validateSupervisorAdvice(parseJsonObject(text));
}

export function parseVerificationEvidenceFromText(text: string): Array<{ criterion?: string; status?: VerificationStatus; evidence?: string; remainingWork?: string }> | undefined {
  const parsed = parseJsonObject(text);
  if (!parsed || !exactKeys(parsed, ["evidence"]) || !Array.isArray(parsed.evidence) || parsed.evidence.length > 24) return undefined;
  const evidence = parsed.evidence.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
    const value = item as Record<string, unknown>;
    if (!exactKeys(value, ["criterion", "status", "evidence", "remainingWork", "remaining_work"])) return undefined;
    if (!isBoundedString(value.criterion, 2_000) || (value.status !== "passed" && value.status !== "failed" && value.status !== "unknown") || !isBoundedString(value.evidence, 8_000) || (value.remainingWork !== undefined && !isBoundedString(value.remainingWork, 2_000, true)) || (value.remaining_work !== undefined && !isBoundedString(value.remaining_work, 2_000, true))) return undefined;
    return {
      criterion: value.criterion,
      status: value.status,
      evidence: value.evidence,
      remainingWork: typeof value.remainingWork === "string" ? value.remainingWork : typeof value.remaining_work === "string" ? value.remaining_work : undefined,
    };
  });
  return evidence.some((item) => !item) ? undefined : evidence as Array<{ criterion: string; status: VerificationStatus; evidence: string; remainingWork?: string }>;
}

function roleFailure(result: RoleRunResult, config: ReliabilityConfig): string | undefined {
  if (result.exitCode !== 0) return `exit ${result.exitCode}`;
  if (result.error) return result.error;
  if (result.cancelled) return "cancelled";
  if (result.timedOut) return "timed out";
  if (result.overLimit) return "exceeded a resource limit";
  if (result.output.length > config.orchestrationMaxOutputChars) return "output exceeds the per-role limit";
  if ((result.stdoutChars ?? result.output.length) > config.orchestrationMaxStdoutChars) return "stdout exceeds the role limit";
  if ((result.stderrChars ?? result.stderr.length) > config.orchestrationMaxStderrChars) return "stderr exceeds the role limit";
  if (!result.usage) return "usage metadata is unavailable";
  return undefined;
}

function cumulativeFailure(results: RoleRunResult[], config: ReliabilityConfig): string | undefined {
  const outputChars = results.reduce((total, result) => total + result.output.length, 0);
  const tokens = results.reduce((total, result) => total + (result.usage?.inputTokens ?? 0) + (result.usage?.outputTokens ?? 0), 0);
  const costUsd = results.reduce((total, result) => total + (result.usage?.costUsd ?? 0), 0);
  if (outputChars > config.orchestrationMaxTotalOutputChars) return `cumulative role output exceeded ${config.orchestrationMaxTotalOutputChars} characters`;
  if (tokens > config.orchestrationMaxTotalTokens) return `cumulative role token usage exceeded ${config.orchestrationMaxTotalTokens}`;
  if (costUsd > config.orchestrationMaxTotalCostUsd) return `cumulative role cost exceeded ${config.orchestrationMaxTotalCostUsd}`;
  return undefined;
}

function cancelledResult(role: ReliabilityRole, prompt: string, model: string | undefined): RoleRunResult {
  return { role, model, prompt, output: "", exitCode: 1, stderr: "", messages: [], cancelled: true, error: "Role subprocess aborted before invocation." };
}

/** Runs one Pi JSON role with bounded lifetime, stream buffers, and process cleanup. */
export async function runPiJsonRole(
  role: ReliabilityRole,
  prompt: string,
  state: TaskState,
  config: ReliabilityConfig,
  signal?: AbortSignal,
  invocationFactory?: RoleProcessInvocationFactory,
): Promise<RoleRunResult> {
  const model = config.orchestrationModels[role];
  if (!invocationFactory) {
    return {
      role,
      model,
      prompt,
      output: "",
      exitCode: 1,
      stderr: "",
      messages: [],
      error: "Standalone CLI roles are unavailable without a verified governed enforcement adapter; no subprocess was started.",
    };
  }
  const tmpDir = await mkdtemp(join(tmpdir(), "pi-reliability-role-"));
  const systemPromptPath = join(tmpDir, `${role}-system.md`);
  await writeFile(systemPromptPath, roleSystemPrompt(role), { encoding: "utf8", mode: 0o600 });

  // Production standalone CLI invocation is intentionally unavailable above.
  // Injected fixtures receive only a tool-free, redacted stdin packet for teardown tests.
  const args = ["--mode", "json", "-p", "--no-session", "--append-system-prompt", systemPromptPath, "--tools", ""];
  if (model) args.push("--model", model);

  const result: RoleRunResult = { role, model, prompt, output: "", exitCode: 1, stderr: "", messages: [], stdoutChars: 0, stderrChars: 0 };
  try {
    if (signal?.aborted) return cancelledResult(role, prompt, model);
    await new Promise<void>((resolve) => {
      const invocation = invocationFactory(args);
      let child: ReturnType<typeof spawn> | undefined;
      let settled = false;
      let lineBuffer = "";
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let timer: ReturnType<typeof setTimeout> | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let abortListener: (() => void) | undefined;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (abortListener) signal?.removeEventListener("abort", abortListener);
      };
      const finish = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };
      const signalProcessTree = (signalName: NodeJS.Signals) => {
        if (!child || child.exitCode !== null) return;
        try {
          if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signalName);
          else child.kill(signalName);
        } catch {
          try { child.kill(signalName); } catch { /* process already exited */ }
        }
      };
      const stop = (reason: "cancelled" | "timedOut" | "overLimit", message: string) => {
        if (settled) return;
        result[reason] = true;
        result.error = message;
        signalProcessTree("SIGTERM");
        // Signal delivery is not process completion: force-kill the complete
        // detached process group and destroy inherited pipes after a short grace.
        killTimer = setTimeout(() => {
          signalProcessTree("SIGKILL");
          child?.stdout?.destroy();
          child?.stderr?.destroy();
          finish();
        }, 100);
      };
      const processStdoutLine = (line: string) => {
        if (!line.trim() || result.error) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          stop("overLimit", "Role emitted malformed JSON-line stdout.");
          return;
        }
        if (!event || typeof event !== "object" || Array.isArray(event)) {
          stop("overLimit", "Role emitted a malformed JSON event.");
          return;
        }
        const parsed = event as { type?: unknown; message?: unknown };
        if ((parsed.type === "message_end" || parsed.type === "tool_result_end") && parsed.message && typeof parsed.message === "object") {
          if (result.messages.length >= MAX_ROLE_MESSAGES) {
            stop("overLimit", "Role emitted too many bounded message events.");
            return;
          }
          result.messages.push(parsed.message as Message);
        }
      };
      const appendStream = (stream: "stdout" | "stderr", data: Buffer | string) => {
        if (settled) return;
        const text = stream === "stdout" ? stdoutDecoder.write(data) : stderrDecoder.write(data);
        if (stream === "stdout") {
          result.stdoutChars = (result.stdoutChars ?? 0) + text.length;
          if (result.stdoutChars > config.orchestrationMaxStdoutChars) {
            stop("overLimit", "Role stdout exceeded its configured limit.");
            return;
          }
          lineBuffer += text;
          if (lineBuffer.length > config.orchestrationMaxLineChars && !lineBuffer.includes("\n")) {
            stop("overLimit", "Role stdout line exceeded its configured limit.");
            return;
          }
          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length > config.orchestrationMaxLineChars) {
              stop("overLimit", "Role stdout line exceeded its configured limit.");
              return;
            }
            processStdoutLine(line);
          }
        } else {
          result.stderrChars = (result.stderrChars ?? 0) + text.length;
          if (result.stderrChars > config.orchestrationMaxStderrChars) {
            stop("overLimit", "Role stderr exceeded its configured limit.");
            return;
          }
          result.stderr += text;
        }
      };

      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: state.cwd,
          shell: false,
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH ?? "",
            PI_RELIABILITY_ORCHESTRATION_CHILD: "1",
            PI_DISABLE_EXTENSIONS: "1",
            PI_DISABLE_SKILLS: "1",
            PI_DISABLE_AUTOMATION: "1",
          },
        });
      } catch (error) {
        result.error = error instanceof Error ? error.message : String(error);
        finish();
        return;
      }
      const spawned = child;
      spawned.stdout?.on("data", (data) => appendStream("stdout", data));
      spawned.stderr?.on("data", (data) => appendStream("stderr", data));
      spawned.stdin?.end(redactSensitiveText(truncate(prompt, config.orchestrationMaxOutputChars)));
      spawned.once("error", (error) => {
        result.error = error.message;
        result.exitCode = 1;
        finish();
      });
      spawned.once("close", (code) => {
        appendStream("stdout", stdoutDecoder.end());
        appendStream("stderr", stderrDecoder.end());
        if (lineBuffer.trim()) {
          if (lineBuffer.length > config.orchestrationMaxLineChars) stop("overLimit", "Role stdout line exceeded its configured limit.");
          else processStdoutLine(lineBuffer);
        }
        result.exitCode = code ?? 1;
        finish();
      });
      timer = setTimeout(() => stop("timedOut", "Role subprocess exceeded its configured deadline."), config.orchestrationTimeoutMs);
      abortListener = () => stop("cancelled", "Role subprocess aborted by caller.");
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) abortListener();
    });
    const output = finalAssistantOutput(result.messages);
    if (output.length > config.orchestrationMaxOutputChars) {
      result.overLimit = true;
      result.error = "Role assistant output exceeded its configured limit.";
    } else {
      result.output = output;
    }
    result.usage = usageFromMessages(result.messages);
    if (!result.usage && !result.error) result.error = "Role output has no trusted usage metadata.";
    return result;
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

function roleFailureMessage(role: ReliabilityRole, result: RoleRunResult, config: ReliabilityConfig): string | undefined {
  const failure = roleFailure(result, config);
  return failure ? `${role[0].toUpperCase()}${role.slice(1)} failed: ${failure}` : undefined;
}

export async function runSeparateModelOrchestration(
  state: TaskState,
  config: ReliabilityConfig,
  signal?: AbortSignal,
  runner: RoleRunner = (role, prompt, taskState, runConfig, runSignal) => runPiJsonRole(role, prompt, taskState, runConfig, runSignal),
): Promise<SeparateModelOrchestrationResult> {
  const decision = buildSupervisorDecision(state, config);
  const initialPrompts = buildRolePrompts(state, config, decision);
  const roleResults: RoleRunResult[] = [];
  const errors: string[] = [];
  let prompts = initialPrompts;
  let supervisorAdvice: SupervisorAdvice | undefined;
  let adviceDisposition: SeparateModelOrchestrationResult["adviceDisposition"];

  const run = async (role: ReliabilityRole, prompt: string): Promise<RoleRunResult> => {
    if (signal?.aborted) return cancelledResult(role, prompt, config.orchestrationModels[role]);
    const usedTokens = roleResults.reduce((total, item) => total + (item.usage?.inputTokens ?? 0) + (item.usage?.outputTokens ?? 0), 0);
    const usedCost = roleResults.reduce((total, item) => total + (item.usage?.costUsd ?? 0), 0);
    const remainingRoles = ROLE_ORDER.length - roleResults.length;
    const tokenShare = Math.floor((config.orchestrationMaxTotalTokens - usedTokens) / remainingRoles);
    const costShare = (config.orchestrationMaxTotalCostUsd - usedCost) / remainingRoles;
    if (tokenShare <= 1 || costShare < 0) {
      return { role, model: config.orchestrationModels[role], prompt, output: "", exitCode: 1, stderr: "", messages: [], error: "No pre-dispatch cumulative role token or cost capacity remains." };
    }
    const budget: RoleInvocationBudget = {
      maxInputTokens: Math.max(1, Math.floor(tokenShare / 2)),
      maxOutputTokens: Math.max(1, tokenShare - Math.max(1, Math.floor(tokenShare / 2))),
      maxCostUsd: costShare,
    };
    try {
      return await runner(role, prompt, state, config, signal, budget);
    } catch (error) {
      return {
        role,
        model: config.orchestrationModels[role],
        prompt,
        output: "",
        exitCode: 1,
        stderr: "",
        messages: [],
        error: `Role runner threw: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  };

  const supervisor = await run("supervisor", prompts.supervisor);
  roleResults.push(supervisor);
  const supervisorFailure = roleFailureMessage("supervisor", supervisor, config) ?? cumulativeFailure(roleResults, config);
  if (supervisorFailure) {
    errors.push(supervisorFailure);
    return { mode: "separate-model", decision, prompts, roleResults, errors, executionAllowed: false };
  }
  const parsedAdvice = parseSupervisorAdviceFromText(supervisor.output);
  if (!parsedAdvice.advice) {
    errors.push(`Supervisor advice rejected: ${parsedAdvice.reason}`);
    adviceDisposition = { status: "rejected", reason: parsedAdvice.reason };
    return { mode: "separate-model", decision, prompts, roleResults, adviceDisposition, errors, executionAllowed: false };
  }
  supervisorAdvice = parsedAdvice.advice;
  adviceDisposition = { status: "applied", reason: parsedAdvice.reason };
  prompts = buildRolePrompts(state, config, decision, "", supervisorAdvice);

  const worker = await run("worker", prompts.worker);
  roleResults.push(worker);
  const workerFailure = roleFailureMessage("worker", worker, config) ?? cumulativeFailure(roleResults, config);
  if (workerFailure) {
    errors.push(workerFailure);
    return { mode: "separate-model", decision, prompts, roleResults, supervisorAdvice, adviceDisposition, errors, executionAllowed: false };
  }
  const workerResult = parseWorkerResultFromText(worker.output);
  if (!workerResult) {
    errors.push("Worker did not return a valid bounded worker-result JSON object.");
    return { mode: "separate-model", decision, prompts, roleResults, supervisorAdvice, adviceDisposition, errors, executionAllowed: false };
  }

  prompts = buildRolePrompts(state, config, decision, worker.output, supervisorAdvice);
  const verifier = await run("verifier", prompts.verifier);
  roleResults.push(verifier);
  const verifierFailure = roleFailureMessage("verifier", verifier, config) ?? cumulativeFailure(roleResults, config);
  if (verifierFailure) {
    errors.push(verifierFailure);
    return { mode: "separate-model", decision, prompts, roleResults, supervisorAdvice, adviceDisposition, workerResult, errors, executionAllowed: false };
  }
  const verificationEvidence = parseVerificationEvidenceFromText(verifier.output);
  if (!verificationEvidence) {
    errors.push("Verifier did not return valid bounded evidence JSON.");
    return { mode: "separate-model", decision, prompts, roleResults, supervisorAdvice, adviceDisposition, workerResult, errors, executionAllowed: false };
  }

  return {
    mode: "separate-model",
    decision,
    prompts,
    roleResults,
    supervisorAdvice,
    adviceDisposition,
    workerResult,
    verificationEvidence,
    errors,
    executionAllowed: true,
  };
}

export function formatOrchestrationResult(result: SeparateModelOrchestrationResult): string {
  const lines = [
    `Orchestration mode: ${result.mode}`,
    `Supervisor step: ${result.decision.step_id} — ${result.decision.step_title}`,
    `Advisor recommendation: ${result.adviceDisposition ? `${result.adviceDisposition.status} (${result.adviceDisposition.reason})` : "not run"}`,
    `Worker status: ${result.workerResult ? result.workerResult.status : "not available"}`,
    `Verifier evidence items: ${result.verificationEvidence ? result.verificationEvidence.length : "not available"}`,
    `Task-state application: ${result.executionAllowed ? "allowed" : "blocked"}`,
  ];
  for (const roleResult of result.roleResults) {
    lines.push(`- ${roleResult.role}: exit ${roleResult.exitCode}${roleResult.model ? ` (${roleResult.model})` : ""}`);
    const output = roleResult.output.trim();
    if (output) lines.push(`  ${truncate(output.replace(/\s+/g, " "), 300)}`);
  }
  if (result.errors.length) lines.push("Errors:\n" + result.errors.map((error) => `- ${error}`).join("\n"));
  if (result.mode === "dry-run") lines.push("Use `/reliability orchestrate --run` to run explicitly confirmed separate Pi subprocess roles.");
  return lines.join("\n");
}
