import { assessTaskCompletion } from "./completion-gate.ts";
import { createContextResetCandidate } from "./checkpoint-contracts.ts";
import { recordStableContextBoundary } from "./context-reset-coordinator.ts";
import type { ContextResetCandidate, TaskState } from "./types.ts";

const TRANSIENT_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "powershell"]);
const MAX_TRANSIENT_BYTES = 4_000_000;

type RuntimeObservation = { transientBytes: number; outgoing?: TaskState; toLane?: TaskState["lane"] };

/** Host-hook observations only: estimates never represent final provider-visible token accounting. */
export class CheckpointRuntime {
  private readonly observations = new WeakMap<TaskState, RuntimeObservation>();

  private observation(state: TaskState): RuntimeObservation {
    let observation = this.observations.get(state);
    if (!observation) {
      observation = { transientBytes: 0 };
      this.observations.set(state, observation);
    }
    return observation;
  }

  observeLaneChange(state: TaskState, before: TaskState): void {
    if (state.lane === before.lane) return;
    if (before.lane === "general") {
      state.context_reset.stable_boundary_id = undefined;
      return;
    }
    const observation = this.observation(state);
    // Retain the first outgoing obligations, never replace them with incoming lane evidence.
    observation.outgoing ??= before;
    observation.toLane = state.lane;
    state.context_reset.stable_boundary_id = undefined;
  }

  observeContext(state: TaskState, messages: readonly unknown[]): void {
    const observation = this.observation(state);
    observation.transientBytes = 0;
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const value = message as { role?: unknown; toolName?: unknown; content?: unknown };
      if (value.role === "toolResult" && typeof value.toolName === "string") this.observeResult(state, value.toolName, value.content);
      if (observation.transientBytes >= MAX_TRANSIENT_BYTES) break;
    }
  }

  observeResult(state: TaskState, toolName: string, content: unknown): void {
    if (!TRANSIENT_TOOLS.has(toolName) || !Array.isArray(content)) return;
    const observation = this.observation(state);
    for (const part of content) {
      if (part?.type !== "text" || typeof part.text !== "string") continue;
      const remaining = MAX_TRANSIENT_BYTES - observation.transientBytes;
      if (remaining <= 0) break;
      observation.transientBytes += Math.min(remaining, Buffer.byteLength(part.text.slice(0, remaining), "utf8"));
    }
  }

  estimatedTransientTokens(state: TaskState): number {
    return Math.ceil(this.observation(state).transientBytes / 4);
  }

  /** Called after persisted-result reconciliation, never inside the lane-changing control invocation. */
  settledBoundary(state: TaskState): ContextResetCandidate | undefined {
    if (state.pending_tool_calls.length) return undefined;
    recordStableContextBoundary(state);
    const observation = this.observation(state);
    const outgoing = observation.outgoing;
    const toLane = observation.toLane;
    observation.outgoing = undefined;
    observation.toLane = undefined;
    if (!outgoing || toLane !== state.lane || outgoing.lane === state.lane || outgoing.lane === "general") return undefined;
    // All calls have now settled, but incoming changes must not fabricate missing outgoing evidence.
    outgoing.pending_tool_calls = [];
    outgoing.current_session = structuredClone(state.current_session);
    outgoing.scope_state.usage = structuredClone(state.scope_state.usage);
    outgoing.scope_state.pending_scope_changes = structuredClone(state.scope_state.pending_scope_changes);
    outgoing.scope_state.approvals = structuredClone(state.scope_state.approvals);
    outgoing.quality_gate = structuredClone(state.quality_gate);
    const decision = assessTaskCompletion(outgoing, undefined, { purpose: outgoing.lane }).decision;
    return createContextResetCandidate(state, {
      from_lane: outgoing.lane,
      to_lane: state.lane,
      trigger: "phase-boundary",
      gate_decision: decision,
      turn_index: state.context_reset.turn_index,
    });
  }
}
