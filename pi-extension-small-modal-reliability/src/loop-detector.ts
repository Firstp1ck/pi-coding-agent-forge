import type { ReliabilityConfig, TaskState, ToolHistoryItem } from "./types.ts";
import { hashToolCall, nowIso, truncate } from "./utils.ts";
import { captureWorkspaceRevision, revisionsMatch } from "./workspace-revision.ts";

export function toolHistoryForHash(state: TaskState, hash: string): ToolHistoryItem[] {
  return state.tool_history.filter((item) => item.arguments_hash === hash);
}

function currentFailureCount(state: TaskState, revision: string, stepId: string | undefined): number {
  return state.tool_history.filter((item) => item.status === "error"
    && item.workspace_revision_after === revision
    && item.step_id === stepId).length;
}

function alternatingFailures(state: TaskState, revision: string, stepId: string | undefined): ToolHistoryItem[] {
  return state.tool_history
    .filter((item) => item.status === "error" && item.workspace_revision_after === revision && item.step_id === stepId)
    .slice(-4);
}

/**
 * Blocks only no-progress repeats. A new stable workspace revision permits a
 * justified retest, while the total recovery ceiling prevents irrelevant edits
 * from replenishing retries forever.
 */
export function shouldBlockRepeat(state: TaskState, toolName: string, input: unknown, config: ReliabilityConfig): string | undefined {
  if (toolName.startsWith("reliability_")) return undefined;
  const currentRevision = captureWorkspaceRevision(state.cwd);
  const hash = hashToolCall(toolName, input);
  const existing = toolHistoryForHash(state, hash);
  const sameStepRevision = existing.filter((item) => item.step_id === state.current_step_id
    && revisionsMatch(item.workspace_revision_after, currentRevision.digest));
  const priorAttempts = sameStepRevision.filter((item) => item.status !== "blocked").length;
  const priorFailures = sameStepRevision.filter((item) => item.status === "error").length;
  const activeEpisodes = state.recovery.episodes.filter((episode) => episode.step_id === state.current_step_id
    && episode.workspace_revision === currentRevision.digest);

  if (state.recovery.total_actions >= config.maxRecoveryActions) {
    return `Blocked recovery action: the ${config.maxRecoveryActions}-action total recovery budget is exhausted. Request a decision or report the blocker.`;
  }
  if (activeEpisodes.some((episode) => Date.now() - Date.parse(episode.started_at) >= config.maxRecoveryElapsedMs)) {
    return `Blocked recovery action: the ${config.maxRecoveryElapsedMs}ms no-progress recovery time budget is exhausted. Request a decision or report the blocker.`;
  }
  const failures = alternatingFailures(state, currentRevision.digest, state.current_step_id);
  if (failures.length >= config.maxRecoveryAttempts + 1) {
    const signatures = new Set(failures.map((item) => item.failure_signature).filter(Boolean));
    if (signatures.size >= 2) {
      return `Blocked alternating no-progress loop: ${failures.length} failed actions at the same step and workspace revision consumed the recovery budget.`;
    }
  }
  if (activeEpisodes.some((episode) => episode.attempts >= config.maxRecoveryAttempts)) {
    return `Blocked repeated failing action: an equivalent failure reached the ${config.maxRecoveryAttempts}-attempt limit at the same step and workspace revision. Choose a discriminating check or request a decision.`;
  }
  if (priorFailures >= config.maxRecoveryAttempts) {
    return `Blocked repeated failing action: ${toolName} failed ${priorFailures} time(s) at the same step and workspace revision. Choose a discriminating check or request a decision.`;
  }

  if (config.profile !== "relaxed" && priorAttempts >= config.maxRepeatedAction - 1) {
    return `Blocked repeated action: ${toolName} with identical arguments reached the ${config.maxRepeatedAction}x ${config.profile} profile limit without a relevant workspace revision change.`;
  }
  return undefined;
}

/** Counts every post-failure action at the same step/revision, including a
 * superficially successful but non-progressing action. */
export function recordRecoveryAction(state: TaskState, stepId: string | undefined, revision: string): void {
  const activeEpisodes = state.recovery.episodes.filter((episode) => episode.step_id === stepId && episode.workspace_revision === revision);
  if (activeEpisodes.length === 0) return;
  state.recovery.total_actions += 1;
  for (const episode of activeEpisodes) {
    episode.actions += 1;
    episode.last_attempt_at = nowIso();
  }
}

export function recordRecoveryFailure(state: TaskState, item: ToolHistoryItem, summary: string): void {
  const revision = item.workspace_revision_after ?? state.workspace_revision.digest;
  const signature = truncate(summary.toLowerCase().replace(/\b\d+\b/g, "#").replace(/\s+/g, " "), 220);
  item.failure_signature = signature;
  const episode = state.recovery.episodes.find((candidate) => candidate.step_id === item.step_id
    && candidate.workspace_revision === revision
    && candidate.failure_signature === signature);
  if (episode) {
    episode.attempts += 1;
    episode.last_attempt_at = nowIso();
  } else {
    state.recovery.total_actions += 1;
    state.recovery.episodes.push({
      step_id: item.step_id,
      workspace_revision: revision,
      failure_signature: signature,
      attempts: 1,
      actions: 1,
      started_at: nowIso(),
      last_attempt_at: nowIso(),
    });
  }
  if (state.recovery.episodes.length > 40) state.recovery.episodes.splice(0, state.recovery.episodes.length - 40);
  state.recovery.total_attempts += 1;
  state.counters.errors_used += 1;
}

export function recordRecoverySuccess(state: TaskState): void {
  state.counters.iterations_used += 1;
}

export function currentNoProgressFailureCount(state: TaskState): number {
  return currentFailureCount(state, state.workspace_revision.digest, state.current_step_id);
}
