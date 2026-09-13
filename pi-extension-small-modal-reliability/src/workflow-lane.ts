import type { TaskState, WorkflowLane } from "./types.ts";

const LANES = ["retrieval", "agentic", "coding", "structured-output", "general"] as const;

export function parseWorkflowLane(value: unknown): WorkflowLane {
  if (typeof value === "string" && (LANES as readonly string[]).includes(value)) return value as WorkflowLane;
  throw new Error("lane must be retrieval, agentic, coding, structured-output, or general.");
}

/**
 * Lane changes are explicit task-state transitions. They never alter the active
 * execution scope, so callers must establish a matching scoped lane separately.
 */
export function setWorkflowLane(state: TaskState, value: unknown): WorkflowLane {
  const lane = parseWorkflowLane(value);
  const scope = state.scope_state.active_scope;
  if (scope && scope.lane !== lane) {
    throw new Error(`Active scope ${scope.scope_id} belongs to ${scope.lane}; change scope through reliability_scope before selecting ${lane}.`);
  }
  state.lane = lane;
  state.current_phase = `lane:${lane}`;
  return lane;
}

export function formatWorkflowLaneStatus(state: TaskState): string {
  const scope = state.scope_state.active_scope;
  return `Workflow lane: ${state.lane}${scope ? ` (active scope ${scope.scope_id} is ${scope.lane})` : " (no active scope)"}.`;
}
