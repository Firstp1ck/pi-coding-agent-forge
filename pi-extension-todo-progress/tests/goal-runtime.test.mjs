import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_GOAL_CONTINUATIONS,
  beginGoalRun,
  createGoalRuntime,
  pauseGoalRuntime,
  recordObservableProgress,
  recordSettledRun,
  restoreGoalRuntime,
  resumeGoalRuntime,
  validateCheckpoint,
} from "../goal-runtime.ts";

test("goal checkpoints bind to identity and require status-specific evidence", () => {
  const completed = validateCheckpoint({
    status: "completed",
    goalId: "goal-1",
    runId: "run-1",
    summary: "All sections are complete.",
    coverage: ["Section 1", "Section 2"],
    verificationEvidence: ["npm test: passed"],
  }, "goal-1", "run-1");

  assert.equal(completed.status, "completed");
  const continuing = validateCheckpoint({
    status: "continue",
    goalId: "goal-1",
    runId: "run-1",
    summary: "More work remains.",
    remainingWork: ["Verify rollback"],
    nextAction: "Run the rollback check",
  }, "goal-1", "run-1");
  assert.deepEqual(continuing.remainingWork, ["Verify rollback"]);
  assert.equal(continuing.nextAction, "Run the rollback check");
  assert.throws(() => validateCheckpoint({
    status: "continue",
    goalId: "goal-1",
    runId: "run-1",
    summary: "Continue",
  }, "goal-1", "run-1"), /remainingWork/);
  assert.throws(() => validateCheckpoint({
    status: "completed",
    goalId: "goal-1",
    runId: "stale-run",
    summary: "Done",
    coverage: ["all"],
    verificationEvidence: ["tests"],
  }, "goal-1", "run-1"), /does not match/);
  assert.throws(() => validateCheckpoint({
    status: "blocked",
    goalId: "goal-1",
    runId: "run-1",
    summary: "Blocked",
    blockerCause: "Missing approval",
  }, "goal-1", "run-1"), /requiredIntervention/);
  assert.throws(() => validateCheckpoint({
    status: "waiting",
    goalId: "goal-1",
    runId: "run-1",
    summary: "Waiting",
    waitingFor: "Native background job",
  }, "goal-1", "run-1"), /jobId/);
});

test("observable progress is deduplicated and settled runs count no-progress honestly", () => {
  const state = createGoalRuntime("Ship", "goal-1", "run-1");

  recordSettledRun(state);
  assert.equal(state.noProgressRuns, 1);
  assert.equal(recordObservableProgress(state, "bash:test:passed"), true);
  assert.equal(recordObservableProgress(state, "bash:test:passed"), false);
  recordSettledRun(state);
  assert.equal(state.noProgressRuns, 0);
  recordSettledRun(state);
  assert.equal(state.noProgressRuns, 1);
});

test("new low-level runs retain counters while explicit resume resets its retry budget", () => {
  const current = createGoalRuntime("Ship", "goal-1", "run-1");
  current.continuations = 7;
  current.noProgressRuns = 2;
  recordObservableProgress(current, "edit:source");
  current.checkpoint = validateCheckpoint({
    status: "continue",
    goalId: "goal-1",
    runId: "run-1",
    summary: "Continue",
    remainingWork: ["Tests"],
    nextAction: "Run tests",
  }, "goal-1", "run-1");

  const next = beginGoalRun(current, "run-2");
  assert.equal(next.runId, "run-2");
  assert.equal(next.continuations, 7);
  assert.equal(next.noProgressRuns, 2);
  assert.equal(next.progressRevision, 1);
  assert.equal(next.checkpoint?.summary, "Continue");

  const state = createGoalRuntime("Ship", "goal-1", "run-1");
  state.continuations = MAX_GOAL_CONTINUATIONS;
  state.noProgressRuns = 3;
  recordObservableProgress(state, "edit:source");
  pauseGoalRuntime(state, "limit reached");

  const resumed = resumeGoalRuntime(state, "run-2");
  assert.equal(resumed.goalId, "goal-1");
  assert.equal(resumed.runId, "run-2");
  assert.equal(resumed.status, "running");
  assert.equal(resumed.continuations, 0);
  assert.equal(resumed.noProgressRuns, 0);
  assert.equal(resumed.progressRevision, 1);
  assert.equal(resumed.checkpoint, undefined);
});

test("malformed persisted goal state is rejected and numeric/signature fields restore within bounds", () => {
  assert.equal(restoreGoalRuntime({ version: 1, goal: "x", status: "running" }), undefined);
  assert.equal(restoreGoalRuntime({ version: 99 }), undefined);

  const restored = restoreGoalRuntime({
    ...createGoalRuntime("Ship", "goal-1", "run-1"),
    continuations: Number.POSITIVE_INFINITY,
    noProgressRuns: "999999999999999999999",
    progressRevision: Number.POSITIVE_INFINITY,
    lastSettledProgressRevision: Number.POSITIVE_INFINITY,
    seenProgress: ["x".repeat(10_000), "tool:bounded"],
  });
  assert.equal(restored.continuations, MAX_GOAL_CONTINUATIONS);
  assert.equal(restored.noProgressRuns, 3);
  assert.equal(restored.progressRevision, 1_000_000_000);
  assert.equal(restored.lastSettledProgressRevision, 1_000_000_000);
  assert.deepEqual(restored.seenProgress, ["tool:bounded"]);
  assert.equal(recordObservableProgress(restored, "x".repeat(129)), false);
});
