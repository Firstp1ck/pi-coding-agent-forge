import { createHash } from "node:crypto";

import type { PlanExitCondition, PlanStep, PlanStepScope, StepStatus, TaskState } from "./types.ts";
import { normalizeScopePath, normalizeScopeReadPath } from "./scope-state.ts";
import { computeVerification } from "./verification-state.ts";
import { captureWorkspaceRevision, workspaceBranchIdentity } from "./workspace-revision.ts";
import { addUniqueBounded, firstLines, truncate } from "./utils.ts";

const MAX_PLAN_STEPS = 16;
const MAX_PLAN_DEPENDENCIES = 8;
const MAX_EXIT_CONDITIONS = 4;
const STEP_STATUSES = new Set<StepStatus>(["pending", "in_progress", "complete", "blocked", "skipped"]);

export type PlanCompletionEvidence = {
  receipt_ids?: string[];
  artifact_refs?: string[];
};

export function normalizeGoal(prompt: string): string {
  const lines = firstLines(prompt, 5);
  return truncate(lines.join(" ") || prompt, 500);
}

export function extractSuccessCriteria(prompt: string): string[] {
  const lines = firstLines(prompt, 12);
  const explicit = lines
    .filter((line) => /\b(must|should|need|needs|acceptance|verify|test|ensure|require|required)\b/i.test(line))
    .map((line) => truncate(line.replace(/^[-*\d.)\s]+/, ""), 220));

  const criteria = explicit.length > 0 ? explicit : [
    "The original user goal is addressed.",
    "Important changes are verified with evidence, or unverifiable parts are explicitly disclosed.",
    "The final response summarizes what changed, verification performed, and remaining risks.",
  ];

  return [...new Set(criteria)].slice(0, 8);
}

export function extractConstraints(prompt: string): string[] {
  const constraints = firstLines(prompt, 20)
    .filter((line) => /\b(do not|don't|must not|avoid|only|prefer|without|keep|preserve|ask first|destructive|secret|private)\b/i.test(line))
    .map((line) => truncate(line.replace(/^[-*\d.)\s]+/, ""), 220));
  return [...new Set(constraints)].slice(0, 8);
}

function liteStep(
  stepId: string,
  title: string,
  description: string,
  dependsOn: string[],
  expectedOutput: string,
  verification: string,
): PlanStep {
  return {
    step_id: stepId,
    title,
    description,
    status: "pending",
    depends_on: dependsOn,
    expected_output: expectedOutput,
    verification,
    exit_conditions: [],
    exit_evidence_receipt_ids: [],
    exit_evidence_artifact_refs: [],
    exit_evidence_contract_hash: undefined,
  };
}

/** Lite plans preserve a low-ceremony path for simple tasks. Complex plans are validated by replacePlan. */
export function createInitialPlan(successCriteria: string[]): PlanStep[] {
  return [
    liteStep("S1", "Ground the task", "Restate the goal, inspect only the context needed, and identify concrete success criteria.", [], "Known facts and a focused next action.", "Relevant context or files are identified without drifting from the goal."),
    liteStep("S2", "Execute the requested work", "Make the smallest safe changes or produce the requested answer while staying inside constraints.", ["S1"], "Requested implementation, answer, or artifact.", "Changed files or produced artifacts are recorded in task state."),
    liteStep("S3", "Verify success criteria", "Check each success criterion using tests, commands, file review, or explicit evidence.", ["S2"], "Verification evidence for every criterion.", successCriteria.map((criterion) => `Criterion: ${criterion}`).join(" ")),
    liteStep("S4", "Report outcome", "Give the user a concise final response with changes, verification, and any remaining risks.", ["S3"], "Final answer grounded in state evidence.", "Final response discloses failed or unknown criteria instead of claiming unsupported completion."),
  ];
}

export function getStep(state: TaskState, stepId: string | undefined): PlanStep | undefined {
  if (!stepId) return undefined;
  return state.plan.find((step) => step.step_id === stepId);
}

export function isStepComplete(state: TaskState, stepId: string): boolean {
  return getStep(state, stepId)?.status === "complete";
}

export function dependenciesSatisfied(state: TaskState, step: PlanStep): boolean {
  return step.depends_on.every((dep) => isStepComplete(state, dep));
}

export function isExecutableMicroplan(state: TaskState): boolean {
  return state.plan.some((step) => step.exit_conditions.length > 0);
}

export function selectNextStep(state: TaskState): PlanStep | undefined {
  const current = getStep(state, state.current_step_id);
  if (current && current.status === "in_progress") return current;

  const pending = state.plan.find((step) => step.status === "pending" && dependenciesSatisfied(state, step));
  if (pending) {
    pending.status = "in_progress";
    state.current_step_id = pending.step_id;
    state.current_phase = pending.title;
    return pending;
  }

  const blocked = state.plan.find((step) => step.status === "blocked");
  if (blocked) {
    state.current_step_id = blocked.step_id;
    state.current_phase = blocked.title;
    return blocked;
  }

  return current;
}

export function setStepStatus(state: TaskState, stepId: string | undefined, status: StepStatus): void {
  const step = getStep(state, stepId);
  if (!step) return;
  step.status = status;
  if (status === "complete") addUniqueBounded(state.completed_steps, step.step_id, 100);
  if (status === "blocked") addUniqueBounded(state.blocked_steps, step.step_id, 100);
}

function receiptSessionIsCurrent(state: TaskState, receipt: TaskState["execution_receipts"][number]): boolean {
  if (state.current_session.lifecycle_identity === "unavailable") return false;
  if (!state.task_identity.session_id) return receipt.session_id === undefined && receipt.session_anchor_entry_id === undefined;
  return receipt.session_id === state.task_identity.session_id
    && receipt.session_id === state.current_session.session_id
    && Boolean(receipt.session_anchor_entry_id)
    && state.current_session.branch_entry_ids.includes(receipt.session_anchor_entry_id!);
}

function pathWithin(boundary: string, candidate: string): boolean {
  return candidate === boundary || candidate.startsWith(`${boundary}/`) || candidate.startsWith(`${boundary}\\`);
}

function receiptMatchesStepScope(state: TaskState, step: PlanStep, receipt: TaskState["execution_receipts"][number], artifactProduced = false): boolean {
  const scope = step.allowed_scope;
  if (!scope || !scope.allowed_tools.includes(receipt.operation)) return false;
  const resources = receipt.resource_refs ?? [];
  if (artifactProduced && !["write", "edit"].includes(receipt.operation)) return false;
  if (["read", "grep", "find", "ls"].includes(receipt.operation)) {
    const targets = receipt.read_targets?.map((target) => target.path) ?? resources;
    return targets.length > 0 && targets.every((path) => scope.allowed_read_paths.some((boundary) => pathWithin(boundary, path)));
  }
  if (["write", "edit"].includes(receipt.operation)) {
    return resources.length > 0 && resources.every((path) => scope.allowed_write_paths.some((boundary) => pathWithin(boundary, path)));
  }
  return !artifactProduced && resources.length === 0;
}

function actualReceiptForStep(state: TaskState, step: PlanStep, receiptId: string, artifactProduced = false, requireCurrentRevision = true): TaskState["execution_receipts"][number] | undefined {
  const receipt = state.execution_receipts.find((candidate) => candidate.id === receiptId);
  if (!receipt
    || receipt.task_id !== state.task_id
    || receipt.branch_id !== state.task_identity.branch_id
    || receipt.step_id !== step.step_id
    || receipt.outcome !== "success"
    || !receipt.execution_observed
    || receipt.host_provenance === "unknown"
    || !receipt.batch_settled
    || (requireCurrentRevision && receipt.workspace_revision_after !== state.workspace_revision.digest)
    || !receiptSessionIsCurrent(state, receipt)
    || !receiptMatchesStepScope(state, step, receipt, artifactProduced)) return undefined;
  if (artifactProduced && receipt.workspace_revision_before === receipt.workspace_revision_after) return undefined;
  return receipt;
}

function conditionIsSatisfied(state: TaskState, step: PlanStep, condition: PlanExitCondition, evidence: PlanCompletionEvidence, requireCurrentRevision = true): boolean {
  if (condition.kind === "observed-tool-result") {
    return (evidence.receipt_ids ?? []).some((receiptId) => Boolean(actualReceiptForStep(state, step, receiptId, false, requireCurrentRevision)));
  }
  if (condition.kind === "criteria-passed") {
    const required = condition.criterion_ids ?? [];
    if (required.length === 0) return false;
    const verification = new Map(computeVerification(state).map((record) => [record.criterion_id, record.status]));
    return required.every((criterionId) => verification.get(criterionId) === "passed");
  }
  const expectedArtifacts = condition.artifact_refs ?? [];
  if (expectedArtifacts.length === 0) return false;
  const receipts = (evidence.receipt_ids ?? [])
    .map((receiptId) => actualReceiptForStep(state, step, receiptId, true, requireCurrentRevision))
    .filter((receipt): receipt is NonNullable<typeof receipt> => Boolean(receipt));
  let supplied: Set<string>;
  let expected: string[];
  try {
    supplied = new Set((evidence.artifact_refs ?? []).map((artifact) => normalizeScopePath(state.cwd, artifact)));
    expected = expectedArtifacts.map((artifact) => normalizeScopePath(state.cwd, artifact));
  } catch {
    return false;
  }
  return expected.every((artifact) => supplied.has(artifact) && receipts.some((receipt) => receipt.resource_refs.includes(artifact)));
}

function stepExitContractHash(step: PlanStep): string {
  return createHash("sha256").update(JSON.stringify({
    step_id: step.step_id,
    depends_on: step.depends_on,
    allowed_scope: step.allowed_scope,
    exit_conditions: step.exit_conditions,
  })).digest("hex");
}

/** Complex-step completion is host-checked; Markdown markers and model status are never exit evidence. */
export function completePlanStep(state: TaskState, stepId: string | undefined, evidence: PlanCompletionEvidence = {}): void {
  const step = getStep(state, stepId);
  if (!step) throw new Error(`Plan step ${stepId ?? "(missing)"} does not exist.`);
  const revision = captureWorkspaceRevision(state.cwd);
  state.workspace_revision = revision;
  if (!revision.inventory_complete || workspaceBranchIdentity(state.cwd, revision) !== state.task_identity.branch_id) {
    throw new Error(`Plan step ${step.step_id} cannot complete because current workspace or branch identity is unverified.`);
  }
  if (!dependenciesSatisfied(state, step)) throw new Error(`Plan step ${step.step_id} has incomplete dependencies.`);
  if (step.exit_conditions.length > 0 && !step.exit_conditions.every((condition) => conditionIsSatisfied(state, step, condition, evidence))) {
    throw new Error(`Plan step ${step.step_id} lacks the actual task-, branch-, step-, scope-, and revision-bound exit evidence required by its executable condition.`);
  }
  step.exit_evidence_receipt_ids = [...new Set(evidence.receipt_ids ?? [])].filter((receiptId) => Boolean(actualReceiptForStep(state, step, receiptId) || actualReceiptForStep(state, step, receiptId, true)));
  step.exit_evidence_artifact_refs = [...new Set(evidence.artifact_refs ?? [])];
  step.exit_evidence_contract_hash = stepExitContractHash(step);
  setStepStatus(state, stepId, "complete");
}

/** Final completion revalidates every executable step against current task, branch, scope, resource, and revision state. */
export function evaluateMicroplanCompletion(state: TaskState): { decision: "escalate"; reasons: string[] } | undefined {
  const executable = state.plan.filter((step) => step.exit_conditions.length > 0);
  if (executable.length === 0) return undefined;
  const reasons: string[] = [];
  for (const step of executable) {
    if (step.status !== "complete") {
      reasons.push(`Executable plan step ${step.step_id} is ${step.status}, not complete.`);
      continue;
    }
    if (step.exit_evidence_contract_hash !== stepExitContractHash(step)) {
      reasons.push(`Executable plan step ${step.step_id} no longer has the immutable exit contract it completed.`);
      continue;
    }
    const evidence: PlanCompletionEvidence = { receipt_ids: step.exit_evidence_receipt_ids, artifact_refs: step.exit_evidence_artifact_refs };
    // Historical stages remain attributable to their own immutable contract; only criterion exits must stay fresh now.
    if (!step.exit_conditions.every((condition) => conditionIsSatisfied(state, step, condition, evidence, false))) {
      reasons.push(`Executable plan step ${step.step_id} no longer has attributable exit evidence for its execution contract.`);
    }
  }
  return reasons.length ? { decision: "escalate", reasons } : undefined;
}

export function planProgress(state: TaskState): { done: number; total: number } {
  return {
    done: state.plan.filter((step) => step.status === "complete" || step.status === "skipped").length,
    total: state.plan.length,
  };
}

function stringArray(value: unknown, field: string, maximum: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${field} must contain at most ${maximum} non-empty strings.`);
  }
  const values = value.map((item) => item.trim());
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates.`);
  return values;
}

function parseScope(raw: Record<string, unknown>, field: string, existing?: PlanStepScope): PlanStepScope | undefined {
  if (raw.allowed_scope === undefined) return existing ? structuredClone(existing) : undefined;
  if (!raw.allowed_scope || typeof raw.allowed_scope !== "object" || Array.isArray(raw.allowed_scope)) {
    throw new Error(`${field}.allowed_scope must be an object.`);
  }
  const scope = raw.allowed_scope as Record<string, unknown>;
  const allowed = new Set(["allowed_tools", "allowed_read_paths", "allowed_write_paths"]);
  for (const key of Object.keys(scope)) if (!allowed.has(key)) throw new Error(`${field}.allowed_scope has unsupported field ${key}.`);
  return {
    allowed_tools: stringArray(scope.allowed_tools, `${field}.allowed_scope.allowed_tools`, 24),
    allowed_read_paths: stringArray(scope.allowed_read_paths, `${field}.allowed_scope.allowed_read_paths`, 32),
    allowed_write_paths: stringArray(scope.allowed_write_paths, `${field}.allowed_scope.allowed_write_paths`, 32),
  };
}

function parseExitConditions(raw: Record<string, unknown>, field: string, existing?: PlanExitCondition[]): PlanExitCondition[] {
  if (raw.exit_conditions === undefined) return existing ? structuredClone(existing) : [];
  if (!Array.isArray(raw.exit_conditions) || raw.exit_conditions.length === 0 || raw.exit_conditions.length > MAX_EXIT_CONDITIONS) {
    throw new Error(`${field}.exit_conditions must contain one through ${MAX_EXIT_CONDITIONS} conditions.`);
  }
  return raw.exit_conditions.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field}.exit_conditions[${index}] must be an object.`);
    const condition = value as Record<string, unknown>;
    const kind = condition.kind;
    if (kind !== "observed-tool-result" && kind !== "criteria-passed" && kind !== "artifact-produced") {
      throw new Error(`${field}.exit_conditions[${index}].kind is unsupported.`);
    }
    const description = typeof condition.description === "string" ? condition.description.trim() : "";
    if (!description || description.length > 400) throw new Error(`${field}.exit_conditions[${index}].description must be a bounded non-empty string.`);
    const criterionIds = stringArray(condition.criterion_ids, `${field}.exit_conditions[${index}].criterion_ids`, 8);
    const artifactRefs = stringArray(condition.artifact_refs, `${field}.exit_conditions[${index}].artifact_refs`, 12);
    if (kind === "criteria-passed" && criterionIds.length === 0) throw new Error(`${field}.exit_conditions[${index}] requires criterion_ids.`);
    if (kind === "artifact-produced" && artifactRefs.length === 0) throw new Error(`${field}.exit_conditions[${index}] requires artifact_refs.`);
    return {
      kind,
      description,
      criterion_ids: criterionIds.length ? criterionIds : undefined,
      artifact_refs: artifactRefs.length ? artifactRefs : undefined,
    };
  });
}

function parseStep(raw: Record<string, unknown>, index: number, existing: PlanStep | undefined): PlanStep {
  const field = `steps[${index}]`;
  const stepId = typeof raw.step_id === "string" && raw.step_id.trim() ? raw.step_id.trim() : `S${index + 1}`;
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(stepId)) throw new Error(`${field}.step_id must be a stable identifier.`);
  const title = typeof raw.title === "string" ? truncate(raw.title.trim(), 120) : "";
  if (!title) throw new Error(`${field}.title must be a non-empty string.`);
  const requestedStatus = raw.status === undefined ? existing?.status ?? "pending" : raw.status;
  if (typeof requestedStatus !== "string" || !STEP_STATUSES.has(requestedStatus as StepStatus)) throw new Error(`${field}.status is unsupported.`);
  if (requestedStatus === "complete" && existing?.status !== "complete") {
    throw new Error(`${field}.status cannot create completion; use a host-checked progress or worker result instead.`);
  }
  if (existing?.status === "complete" && requestedStatus !== "complete") {
    throw new Error(`${field}.status cannot downgrade a completed canonical step.`);
  }
  const candidate: PlanStep = {
    step_id: stepId,
    title,
    description: truncate(typeof raw.description === "string" ? raw.description.trim() : existing?.description ?? title, 600),
    status: requestedStatus as StepStatus,
    depends_on: raw.depends_on === undefined ? [...(existing?.depends_on ?? [])] : stringArray(raw.depends_on, `${field}.depends_on`, MAX_PLAN_DEPENDENCIES),
    expected_output: truncate(typeof raw.expected_output === "string" ? raw.expected_output.trim() : existing?.expected_output ?? "Concrete progress toward the goal.", 300),
    verification: truncate(typeof raw.verification === "string" ? raw.verification.trim() : existing?.verification ?? "Evidence is recorded in task state.", 400),
    exit_conditions: parseExitConditions(raw, field, existing?.exit_conditions),
    allowed_scope: parseScope(raw, field, existing?.allowed_scope),
    exit_evidence_receipt_ids: existing?.status === requestedStatus ? [...existing.exit_evidence_receipt_ids] : [],
    exit_evidence_artifact_refs: existing?.status === requestedStatus ? [...existing.exit_evidence_artifact_refs] : [],
    exit_evidence_contract_hash: existing?.status === requestedStatus ? existing.exit_evidence_contract_hash : undefined,
  };
  if (existing?.status === "complete") {
    const definition = ({ status: _status, exit_evidence_receipt_ids: _receipts, exit_evidence_artifact_refs: _artifacts, ...step }: PlanStep) => step;
    if (JSON.stringify(definition(existing)) !== JSON.stringify(definition(candidate))) {
      throw new Error(`${field} cannot redefine a completed canonical step.`);
    }
  }
  return candidate;
}

function validateGraph(steps: PlanStep[]): void {
  if (steps.length === 0 || steps.length > MAX_PLAN_STEPS) throw new Error(`Plans must contain one through ${MAX_PLAN_STEPS} steps.`);
  const ids = new Set(steps.map((step) => step.step_id));
  if (ids.size !== steps.length) throw new Error("Plan step IDs must be unique.");
  for (const step of steps) {
    if (step.depends_on.includes(step.step_id)) throw new Error(`Plan step ${step.step_id} cannot depend on itself.`);
    if (step.depends_on.some((dependency) => !ids.has(dependency))) throw new Error(`Plan step ${step.step_id} has a dangling dependency.`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) throw new Error("Plan dependencies must be acyclic.");
    visiting.add(stepId);
    const step = steps.find((candidate) => candidate.step_id === stepId);
    for (const dependency of step?.depends_on ?? []) visit(dependency);
    visiting.delete(stepId);
    visited.add(stepId);
  };
  for (const step of steps) visit(step.step_id);
  if (!steps.some((step) => step.depends_on.length === 0)) throw new Error("Plan has no reachable root step.");
  if (steps.filter((step) => step.status === "in_progress").length > 1) throw new Error("Plan may have only one in-progress canonical step.");
}

function validateScopes(state: TaskState, steps: PlanStep[]): void {
  const complex = steps.some((step) => step.exit_conditions.length > 0 || step.allowed_scope !== undefined);
  if (complex && !steps.every((step) => step.exit_conditions.length > 0 && step.allowed_scope !== undefined)) {
    throw new Error("Every complex microplan step requires an allowed_scope and at least one executable exit condition.");
  }
  const active = state.scope_state.active_scope;
  if (!active) return;
  for (const step of steps) {
    const scope = step.allowed_scope;
    if (!scope) continue;
    if (scope.allowed_tools.some((tool) => !active.allowed_tools.includes(tool))) {
      throw new Error(`Plan step ${step.step_id} broadens active tool scope.`);
    }
    try {
      scope.allowed_read_paths = scope.allowed_read_paths.map((path) => normalizeScopeReadPath(state.cwd, path));
      scope.allowed_write_paths = scope.allowed_write_paths.map((path) => normalizeScopePath(state.cwd, path));
    } catch (error) {
      throw new Error(`Plan step ${step.step_id} has an invalid scoped path: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const path of scope.allowed_read_paths) {
      if (!active.allowed_read_paths.some((boundary) => pathWithin(boundary, path))) throw new Error(`Plan step ${step.step_id} broadens active read scope.`);
    }
    for (const path of scope.allowed_write_paths) {
      if (!active.allowed_write_paths.some((boundary) => pathWithin(boundary, path))) throw new Error(`Plan step ${step.step_id} broadens active write scope.`);
    }
  }
}

function validateExitCriteria(state: TaskState, steps: PlanStep[]): void {
  const criteria = new Set(state.criteria.map((criterion) => criterion.id));
  for (const step of steps) {
    for (const condition of step.exit_conditions) {
      if (condition.criterion_ids?.some((criterionId) => !criteria.has(criterionId))) {
        throw new Error(`Plan step ${step.step_id} references an unknown criterion in an executable exit condition.`);
      }
    }
  }
}

function chooseReachableCurrent(steps: PlanStep[]): string {
  const done = new Set(steps.filter((step) => step.status === "complete" || step.status === "skipped").map((step) => step.step_id));
  const next = steps.find((step) => (step.status === "pending" || step.status === "in_progress") && step.depends_on.every((dependency) => done.has(dependency)));
  if (!next) throw new Error("Plan has no reachable next step; use a blocked outcome instead of checkbox-only completion.");
  return next.step_id;
}

/** Validates the whole DAG before mutating state, so invalid proposals leave the canonical plan untouched. */
export function replacePlan(state: TaskState, proposedSteps: Array<Record<string, unknown>>, replace: boolean): void {
  if (!Array.isArray(proposedSteps) || proposedSteps.length === 0 || proposedSteps.length > MAX_PLAN_STEPS) {
    throw new Error(`Plans must contain one through ${MAX_PLAN_STEPS} steps.`);
  }
  const existing = new Map(state.plan.map((step) => [step.step_id, step]));
  const parsed = proposedSteps.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`steps[${index}] must be an object.`);
    const proposedId = typeof raw.step_id === "string" && raw.step_id.trim() ? raw.step_id.trim() : `S${index + 1}`;
    return parseStep(raw, index, existing.get(proposedId));
  });
  const next = replace ? parsed : [...state.plan, ...parsed];
  validateGraph(next);
  validateScopes(state, next);
  validateExitCriteria(state, next);
  const currentStepId = chooseReachableCurrent(next);
  state.plan = next;
  state.current_step_id = currentStepId;
  state.current_phase = getStep({ ...state, plan: next }, currentStepId)?.title ?? state.current_phase;
}
