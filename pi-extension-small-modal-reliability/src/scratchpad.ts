import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { TaskState } from "./types.ts";
import { scratchpadPathFor } from "./paths.ts";
import { getStep, planProgress } from "./planner.ts";
import { computeVerification } from "./verification-state.ts";

export function writeScratchpad(state: TaskState): void {
  const path = scratchpadPathFor(state.cwd, state.task_id);
  mkdirSync(dirname(path), { recursive: true });
  const current = getStep(state, state.current_step_id);
  const progress = planProgress(state);
  const verification = computeVerification(state);
  const lines = [
    "# Task Scratchpad",
    "",
    `Task ID: ${state.task_id}`,
    `Updated: ${state.updated_at}`,
    `Status: ${state.status}`,
    `Goal label: ${state.normalized_goal}`,
    `Current step: ${current ? `${current.step_id} — ${current.title} (${current.status})` : "none"}`,
    `Plan progress: ${progress.done}/${progress.total}`,
    "",
    "## Plan",
    ...state.plan.map((step) => `- [${step.status === "complete" ? "x" : step.status === "in_progress" ? "-" : " "}] ${step.step_id}: ${step.title} — ${step.verification}`),
    "",
    "## Authoritative user requirements",
    state.authoritative_instructions.original_user_request.text,
    `Provenance: ${state.authoritative_instructions.original_user_request.origin}${state.authoritative_instructions.original_user_request.session_entry_id ? ` (${state.authoritative_instructions.original_user_request.session_entry_id})` : ""}`,
    ...(state.authoritative_instructions.corrections.length ? ["", "### Later corrections", ...state.authoritative_instructions.corrections.flatMap((item) => [`- ${item.text}`, `  Provenance: ${item.origin}${item.session_entry_id ? ` (${item.session_entry_id})` : ""}`])] : []),
    "",
    "## Observations",
    ...(state.working_context.observations.length ? state.working_context.observations.map((item) => `- ${item.text}`) : ["- none"]),
    "",
    "## Claims and hypotheses (not evidence)",
    ...(state.working_context.claims.length ? state.working_context.claims.map((item) => `- Claim: ${item.text}`) : ["- no model claims recorded"]),
    ...(state.working_context.hypotheses.length ? state.working_context.hypotheses.map((item) => `- Hypothesis: ${item.text}`) : []),
    "",
    "## Verification",
    ...verification.map((item) => `- ${item.status.toUpperCase()}: ${item.criterion} — ${item.evidence}`),
    "",
    "## Next action",
    state.next_action || "Continue current step.",
  ];
  writeFileSync(path, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}
