import type { AuthoritativeInstruction, AuthoritativeInstructions, TaskState, WorkingContext, WorkingContextEntry } from "./types.ts";
import { nowIso, truncate } from "./utils.ts";
import { invalidateVerificationEvidence } from "./verification-state.ts";

const MAX_WORKING_CONTEXT_ENTRIES = 40;
const MAX_WORKING_CONTEXT_TEXT = 800;

export type TrustedAuthoritativeInput = Pick<AuthoritativeInstruction, "origin" | "session_id" | "session_entry_id">;

export function createAuthoritativeInstruction(text: string, input: TrustedAuthoritativeInput): AuthoritativeInstruction {
  if (!text) throw new Error("Authoritative user input must preserve non-empty exact text.");
  return {
    text,
    origin: input.origin,
    recorded_at: nowIso(),
    session_id: input.session_id,
    session_entry_id: input.session_entry_id,
  };
}

export function createAuthoritativeInstructions(originalUserRequest: string, input: TrustedAuthoritativeInput = { origin: "user-command" }): AuthoritativeInstructions {
  return { original_user_request: createAuthoritativeInstruction(originalUserRequest, input), corrections: [] };
}

export function createWorkingContext(): WorkingContext {
  return { observations: [], claims: [], hypotheses: [] };
}

function appendBounded(entries: WorkingContextEntry[], text: string, evidenceRefs: string[] = []): void {
  const normalized = text.trim();
  if (!normalized) return;
  const entry: WorkingContextEntry = {
    text: truncate(normalized, MAX_WORKING_CONTEXT_TEXT),
    recorded_at: nowIso(),
    evidence_refs: [...new Set(evidenceRefs)].slice(0, 12),
  };
  entries.push(entry);
  if (entries.length > MAX_WORKING_CONTEXT_ENTRIES) entries.splice(0, entries.length - MAX_WORKING_CONTEXT_ENTRIES);
}

/** Trusted user-originated corrections remain lossless and invalidate all downstream proof. */
export function recordAuthoritativeCorrection(state: TaskState, correction: string, input: TrustedAuthoritativeInput): boolean {
  if (!correction) return false;
  if (state.authoritative_instructions.corrections.some((item) => item.text === correction && item.session_entry_id === input.session_entry_id)) return false;
  state.authoritative_instructions.corrections.push(createAuthoritativeInstruction(correction, input));
  invalidateVerificationEvidence(state, "A later authoritative user correction was recorded; prior completion evidence requires revalidation.");
  state.status = state.status === "complete" ? "verifying" : state.status;
  // Requirement impact is not safely inferable from arbitrary custom microplans. Reopen every completed proof.
  for (const step of state.plan) {
    if (step.status !== "complete") continue;
    step.status = "pending";
    step.exit_evidence_receipt_ids = [];
    step.exit_evidence_artifact_refs = [];
    delete step.exit_evidence_contract_hash;
  }
  state.completed_steps = [];
  return true;
}

export function recordHostObservation(state: TaskState, observation: string, evidenceRefs: string[] = []): void {
  appendBounded(state.working_context.observations, observation, evidenceRefs);
}

export function recordModelClaim(state: TaskState, claim: string, evidenceRefs: string[] = []): void {
  appendBounded(state.working_context.claims, claim, evidenceRefs);
}

export function recordHypothesis(state: TaskState, hypothesis: string, evidenceRefs: string[] = []): void {
  appendBounded(state.working_context.hypotheses, hypothesis, evidenceRefs);
}
