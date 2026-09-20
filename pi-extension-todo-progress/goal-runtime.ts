export type GoalStatus = "running" | "paused" | "blocked" | "waiting" | "completed";
export type GoalCheckpointStatus = "continue" | "completed" | "blocked" | "waiting";

export type GoalCheckpoint = {
  status: GoalCheckpointStatus;
  goalId: string;
  runId: string;
  summary: string;
  remainingWork?: string[];
  nextAction?: string;
  coverage?: string[];
  verificationEvidence?: string[];
  blockerCause?: string;
  requiredIntervention?: string;
  waitingFor?: string;
  jobId?: string;
};

export type GoalRuntimeState = {
  version: 1;
  goal: string;
  goalId: string;
  runId: string;
  status: GoalStatus;
  pauseReason?: string;
  checkpoint?: GoalCheckpoint;
  continuations: number;
  noProgressRuns: number;
  progressRevision: number;
  lastSettledProgressRevision: number;
  seenProgress: string[];
  continuationOutstanding: boolean;
};

export type GoalCheckpointInput = {
  status?: unknown;
  goalId?: unknown;
  runId?: unknown;
  summary?: unknown;
  remainingWork?: unknown;
  nextAction?: unknown;
  coverage?: unknown;
  verificationEvidence?: unknown;
  blockerCause?: unknown;
  requiredIntervention?: unknown;
  waitingFor?: unknown;
  jobId?: unknown;
};

export const MAX_GOAL_LENGTH = 100_000;
export const MAX_GOAL_CONTINUATIONS = 20;
export const MAX_NO_PROGRESS_RUNS = 3;
const MAX_PROGRESS_SIGNATURES = 100;
const MAX_PROGRESS_SIGNATURE_LENGTH = 128;
const MAX_REVISION = 1_000_000_000;
const MAX_SUMMARY_LENGTH = 2000;
const MAX_DETAIL_LENGTH = 2000;
const MAX_ID_LENGTH = 200;
const MAX_EVIDENCE_ITEMS = 50;
const MAX_EVIDENCE_LENGTH = 1000;

function boundedText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a nonempty string`);
  }
  const text = value.trim();
  if (text.length > maximum) throw new Error(`${name} must be at most ${maximum} characters`);
  return text;
}

function boundedList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EVIDENCE_ITEMS) {
    throw new Error(`${name} must contain 1-${MAX_EVIDENCE_ITEMS} items`);
  }
  return value.map((item, index) => boundedText(item, `${name}[${index}]`, MAX_EVIDENCE_LENGTH));
}

function boundedInteger(value: unknown, maximum: number): number {
  const numeric = Number(value);
  if (numeric === Number.POSITIVE_INFINITY) return maximum;
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(maximum, Math.floor(numeric));
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return value === "running" || value === "paused" || value === "blocked" || value === "waiting" || value === "completed";
}

function isCheckpointStatus(value: unknown): value is GoalCheckpointStatus {
  return value === "continue" || value === "completed" || value === "blocked" || value === "waiting";
}

function restoreCheckpoint(value: unknown, goalId: string): GoalCheckpoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  try {
    const checkpointRunId = boundedText((value as GoalCheckpointInput).runId, "runId", MAX_ID_LENGTH);
    return validateCheckpoint(value as GoalCheckpointInput, goalId, checkpointRunId);
  } catch {
    return undefined;
  }
}

export function createGoalRuntime(goal: string, goalId: string, runId: string): GoalRuntimeState {
  return {
    version: 1,
    goal,
    goalId,
    runId,
    status: "running",
    continuations: 0,
    noProgressRuns: 0,
    progressRevision: 0,
    lastSettledProgressRevision: 0,
    seenProgress: [],
    continuationOutstanding: false,
  };
}

export function beginGoalRun(state: GoalRuntimeState, runId: string): GoalRuntimeState {
  return {
    ...state,
    runId,
    status: "running",
    pauseReason: undefined,
    continuationOutstanding: false,
  };
}

export function resumeGoalRuntime(state: GoalRuntimeState, runId: string): GoalRuntimeState {
  return {
    ...beginGoalRun(state, runId),
    checkpoint: undefined,
    continuations: 0,
    noProgressRuns: 0,
    lastSettledProgressRevision: state.progressRevision,
  };
}

export function pauseGoalRuntime(state: GoalRuntimeState, reason: string): void {
  state.status = "paused";
  state.pauseReason = reason;
  state.continuationOutstanding = false;
}

export function restoreGoalRuntime(value: unknown): GoalRuntimeState | undefined {
  if (!value || typeof value !== "object") return undefined;
  const snapshot = value as Partial<GoalRuntimeState>;
  if (snapshot.version !== 1 || !isGoalStatus(snapshot.status)) return undefined;

  try {
    const goal = boundedText(snapshot.goal, "goal", MAX_GOAL_LENGTH);
    const goalId = boundedText(snapshot.goalId, "goalId", MAX_ID_LENGTH);
    const runId = boundedText(snapshot.runId, "runId", MAX_ID_LENGTH);
    const progressRevision = boundedInteger(snapshot.progressRevision, MAX_REVISION);
    const seenProgress = Array.isArray(snapshot.seenProgress)
      ? snapshot.seenProgress.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= MAX_PROGRESS_SIGNATURE_LENGTH).slice(-MAX_PROGRESS_SIGNATURES)
      : [];
    const checkpoint = restoreCheckpoint(snapshot.checkpoint, goalId);
    const terminalCheckpointMatches = snapshot.status === "completed"
      ? checkpoint?.status === "completed" && checkpoint.runId === runId
      : snapshot.status === "blocked"
        ? checkpoint?.status === "blocked" && checkpoint.runId === runId
        : snapshot.status === "waiting"
          ? checkpoint?.status === "waiting" && checkpoint.runId === runId
          : true;
    const status = terminalCheckpointMatches ? snapshot.status : "paused";

    return {
      version: 1,
      goal,
      goalId,
      runId,
      status,
      pauseReason: terminalCheckpointMatches
        ? (typeof snapshot.pauseReason === "string" && snapshot.pauseReason.trim() ? snapshot.pauseReason.trim() : undefined)
        : "Persisted terminal state was incomplete; explicit resume required",
      checkpoint: terminalCheckpointMatches ? checkpoint : undefined,
      continuations: boundedInteger(snapshot.continuations, MAX_GOAL_CONTINUATIONS),
      noProgressRuns: boundedInteger(snapshot.noProgressRuns, MAX_NO_PROGRESS_RUNS),
      progressRevision,
      lastSettledProgressRevision: Math.min(progressRevision, boundedInteger(snapshot.lastSettledProgressRevision, MAX_REVISION)),
      seenProgress,
      continuationOutstanding: Boolean(snapshot.continuationOutstanding),
    };
  } catch {
    return undefined;
  }
}

export function validateCheckpoint(input: GoalCheckpointInput, goalId: string, runId: string): GoalCheckpoint {
  if (!isCheckpointStatus(input.status)) throw new Error("status must be continue, completed, blocked, or waiting");
  const checkpointGoalId = boundedText(input.goalId, "goalId", MAX_ID_LENGTH);
  const checkpointRunId = boundedText(input.runId, "runId", MAX_ID_LENGTH);
  if (checkpointGoalId !== goalId || checkpointRunId !== runId) {
    throw new Error("Checkpoint goalId/runId does not match the active goal run");
  }

  const checkpoint: GoalCheckpoint = {
    status: input.status,
    goalId: checkpointGoalId,
    runId: checkpointRunId,
    summary: boundedText(input.summary, "summary", MAX_SUMMARY_LENGTH),
  };

  if (input.status === "continue") {
    checkpoint.remainingWork = boundedList(input.remainingWork, "remainingWork");
    checkpoint.nextAction = boundedText(input.nextAction, "nextAction", MAX_DETAIL_LENGTH);
  } else if (input.status === "completed") {
    checkpoint.coverage = boundedList(input.coverage, "coverage");
    checkpoint.verificationEvidence = boundedList(input.verificationEvidence, "verificationEvidence");
    if (checkpoint.verificationEvidence.every((item) => /^(?:none|skipped|not (?:run|performed)|unverified)\b/i.test(item))) {
      throw new Error("verificationEvidence must describe verification that was actually performed");
    }
  } else if (input.status === "blocked") {
    checkpoint.blockerCause = boundedText(input.blockerCause, "blockerCause", MAX_DETAIL_LENGTH);
    checkpoint.requiredIntervention = boundedText(input.requiredIntervention, "requiredIntervention", MAX_DETAIL_LENGTH);
  } else if (input.status === "waiting") {
    checkpoint.waitingFor = boundedText(input.waitingFor, "waitingFor", MAX_DETAIL_LENGTH);
    checkpoint.jobId = boundedText(input.jobId, "jobId", MAX_ID_LENGTH);
  }

  return checkpoint;
}

export function recordObservableProgress(state: GoalRuntimeState, signature: string): boolean {
  if (!signature || signature.length > MAX_PROGRESS_SIGNATURE_LENGTH || state.seenProgress.includes(signature)) return false;
  state.seenProgress = [...state.seenProgress, signature].slice(-MAX_PROGRESS_SIGNATURES);
  state.progressRevision = Math.min(MAX_REVISION, state.progressRevision + 1);
  return true;
}

export function recordSettledRun(state: GoalRuntimeState): void {
  if (state.progressRevision > state.lastSettledProgressRevision) state.noProgressRuns = 0;
  else state.noProgressRuns += 1;
  state.lastSettledProgressRevision = state.progressRevision;
}
