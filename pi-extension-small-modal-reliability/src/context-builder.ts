import type { ContextHeaderResult, ContextSnapshot, ReliabilityConfig, TaskState } from "./types.ts";
import { scratchpadPathFor, statePathFor } from "./paths.ts";
import { getStep } from "./planner.ts";
import { formatEvidenceContextSummary } from "./evidence-state.ts";
import { formatScopeStatus } from "./scope-state.ts";
import { computeVerification } from "./verification-state.ts";

export type ContextBuildOptions = {
  /** Chained system/tool-schema text already reserved by the host for this provider call. */
  reservedChars?: number;
};

export function createContextSnapshot(state: TaskState): ContextSnapshot {
  const verification = computeVerification(state);
  return {
    goal: state.normalized_goal,
    currentStepId: state.current_step_id,
    planStatuses: state.plan.map((step) => `${step.step_id}:${step.status}`).join(","),
    completedSteps: state.completed_steps.join(","),
    blockedSteps: state.blocked_steps.join(","),
    latestFacts: state.working_context.observations.slice(-5).map((item) => item.text).join(" | "),
    latestErrors: state.errors.slice(-5).join(" | "),
    latestWarnings: state.loop_warnings.slice(-5).join(" | "),
    verificationStatuses: verification.map((item) => `${item.status}:${item.criterion}`).join(" | "),
    evidenceSummary: formatEvidenceContextSummary(state, 1_200),
    scopeSummary: formatScopeStatus(state),
    nextAction: state.next_action,
    filesTouched: state.files_touched.slice(-10).join(","),
  };
}

function snapshotDiff(previous: ContextSnapshot | undefined, next: ContextSnapshot): string[] {
  if (!previous) return ["Initial context snapshot."];
  const lines: string[] = [];
  for (const key of Object.keys(next) as Array<keyof ContextSnapshot>) {
    if (previous[key] !== next[key]) lines.push(`${key}: ${previous[key] || "(empty)"} -> ${next[key] || "(empty)"}`);
  }
  return lines.length ? lines : ["No material reliability-state changes since the previous context header."];
}

function compactPlan(state: TaskState): string[] {
  return state.plan.map((step) => `${step.step_id}:${step.status}:${step.title}`);
}

function authoritativeLines(state: TaskState): string[] {
  const original = state.authoritative_instructions.original_user_request;
  const lines = ["Authoritative user requirements (verbatim):", original.text, `Original provenance: ${original.origin}${original.session_entry_id ? ` (${original.session_entry_id})` : ""}`];
  if (state.authoritative_instructions.corrections.length) {
    lines.push("Later authoritative corrections (verbatim):", ...state.authoritative_instructions.corrections.flatMap((item) => [item.text, `Correction provenance: ${item.origin}${item.session_entry_id ? ` (${item.session_entry_id})` : ""}`]));
  }
  return lines;
}

function cannotFitHeader(state: TaskState, requiredChars: number, availableChars: number, reservedChars: number): string {
  return [
    "[RELIABILITY CANNOT-FIT]",
    `Authoritative user requirements require ${requiredChars} characters but only ${availableChars} are available after ${reservedChars} reserved host characters.`,
    `No requirement was truncated or discarded. Inspect canonical task state before mutation: ${statePathFor(state.cwd, state.task_id)}`,
    "Do not claim completion or perform a mutation until the authoritative instructions can be retained in the active context.",
    "[/RELIABILITY CANNOT-FIT]",
  ].join("\n");
}

function appendWholeSection(lines: string[], section: string[], availableChars: number, omitted: string[]): void {
  const candidate = [...lines, ...section];
  if (candidate.join("\n").length <= availableChars) {
    lines.push(...section);
  } else {
    omitted.push(section[0] ?? "optional reliability context");
  }
}

function boundedHeader(
  state: TaskState,
  config: ReliabilityConfig,
  sections: string[][],
  options: ContextBuildOptions,
): string {
  const reservedChars = Math.max(0, Math.trunc(options.reservedChars ?? 0));
  const availableChars = Math.max(0, config.contextBudgetChars - reservedChars);
  const lines = ["[RELIABILITY HARNESS ACTIVE]", ...authoritativeLines(state)];
  if (lines.join("\n").length + "\n[/RELIABILITY HARNESS ACTIVE]".length > availableChars) {
    return cannotFitHeader(state, lines.join("\n").length, availableChars, reservedChars);
  }
  const omitted: string[] = [];
  for (const section of sections) appendWholeSection(lines, section, availableChars - "\n[/RELIABILITY HARNESS ACTIVE]".length, omitted);
  if (omitted.length) {
    const notice = `Optional bounded context omitted for budget: ${omitted.join(", ")}. Canonical state remains available at ${statePathFor(state.cwd, state.task_id)}.`;
    if ([...lines, notice].join("\n").length <= availableChars - "\n[/RELIABILITY HARNESS ACTIVE]".length) lines.push(notice);
  }
  lines.push("[/RELIABILITY HARNESS ACTIVE]");
  return lines.join("\n");
}

export function buildContextHeader(
  state: TaskState,
  config: ReliabilityConfig,
  previous?: ContextSnapshot,
  options: ContextBuildOptions = {},
): ContextHeaderResult {
  const snapshot = createContextSnapshot(state);
  const current = getStep(state, state.current_step_id);
  const verification = computeVerification(state);
  const base = [
    `Header mode: ${config.contextMode}`,
    `Task: ${state.task_id}`,
    `Goal label: ${state.normalized_goal}`,
    `Status: ${state.status}`,
    `Current step: ${current ? `${current.step_id} — ${current.title} (${current.status})` : "none"}`,
    formatScopeStatus(state),
  ];
  const observations = state.working_context.observations.slice(-5).map((item) => `- OBSERVED: ${item.text}${item.evidence_refs.length ? ` [${item.evidence_refs.join(", ")}]` : ""}`);
  const claims = state.working_context.claims.slice(-5).map((item) => `- CLAIM (unverified): ${item.text}${item.evidence_refs.length ? ` [${item.evidence_refs.join(", ")}]` : ""}`);
  const hypotheses = state.working_context.hypotheses.slice(-3).map((item) => `- HYPOTHESIS: ${item.text}`);

  if (config.supervisionMode === "lite") {
    return {
      header: boundedHeader(state, config, [
        ["Mode: lite", ...base],
        ["Success criteria:", ...state.success_criteria.map((item) => `- ${item}`)],
        ["Verification:", ...verification.map((item) => `- ${item.status.toUpperCase()}: ${item.criterion}`)],
        observations.length ? ["Observed host results:", ...observations] : [],
        claims.length ? ["Model claims (not evidence):", ...claims] : [],
        ["Rule: work normally; call reliability_verify_completion with evidence before claiming completion."],
      ], options),
      snapshot,
    };
  }

  const sections: string[][] = [[...base]];
  if (config.contextMode === "delta") {
    sections.push(["Delta:", ...snapshotDiff(previous, snapshot).map((item) => `- ${item}`)]);
    sections.push([`Next action: ${state.next_action}`]);
  } else if (config.contextMode === "compact") {
    sections.push(["Plan:", ...compactPlan(state).map((item) => `- ${item}`)]);
    sections.push([formatEvidenceContextSummary(state, 1_600)]);
    if (observations.length) sections.push(["Observed host results:", ...observations]);
    if (claims.length) sections.push(["Model claims (not evidence):", ...claims]);
    sections.push(["Verification:", ...verification.map((item) => `- ${item.status.toUpperCase()}: ${item.criterion}`)]);
    sections.push([`Next action: ${state.next_action}`]);
  } else {
    sections.push(["Plan:", ...state.plan.map((step) => `- ${step.step_id} [${step.status}] ${step.title}: ${step.description} Exit conditions: ${step.exit_conditions.map((condition) => condition.kind).join(",") || "lite"}`)]);
    sections.push(["Success criteria:", ...state.success_criteria.map((item) => `- ${item}`)]);
    sections.push(["Constraints:", ...(state.constraints.length ? state.constraints.map((item) => `- ${item}`) : ["- none"])]);
    sections.push([formatEvidenceContextSummary(state, 2_000)]);
    if (observations.length) sections.push(["Observed host results:", ...observations]);
    if (claims.length) sections.push(["Model claims (not evidence):", ...claims]);
    if (hypotheses.length) sections.push(["Hypotheses (not observations):", ...hypotheses]);
    sections.push(["Errors:", ...(state.errors.length ? state.errors.slice(-10).map((item) => `- ${item}`) : ["- none"])]);
    sections.push(["Verification:", ...verification.map((item) => `- ${item.status.toUpperCase()}: ${item.criterion} — ${item.evidence}`)]);
    sections.push([`Scratchpad: ${scratchpadPathFor(state.cwd, state.task_id)}`, `Next action: ${state.next_action}`]);
  }
  return { header: boundedHeader(state, config, sections, options), snapshot };
}
