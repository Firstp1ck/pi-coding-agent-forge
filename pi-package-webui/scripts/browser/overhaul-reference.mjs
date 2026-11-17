import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export const baselineWorkflowNames = [
  "switch session", "change model", "change effort", "attach file",
  "find changed file", "open runner output", "find approval",
  "configure tool profile", "change theme",
];

function assertIdentities(actual, expected, label) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), `refuse incomplete or duplicate ${label}`);
}

function assertNoErrors(record, label) {
  assert.ok(!record.error, `refuse failed ${label}`);
  assert.deepEqual(record.pageErrors, [], `refuse browser errors in ${label}`);
}

function assertSamples(summary, count, label) {
  assert.equal(summary?.count, count, `refuse incomplete ${label}`);
  assert.equal(summary.raw?.length, count, `refuse missing raw ${label}`);
  assert.ok(summary.raw.every((sample) => Number.isFinite(sample) && sample >= 0), `refuse invalid ${label}`);
}

export function assertBaselineComplete(report, expectedViews) {
  assertIdentities(report.views.map((view) => view.name), expectedViews.map((view) => view.name), "view matrix");
  for (const view of report.views) {
    assertNoErrors(view, view.name);
    assertIdentities(view.states.map((state) => state.state), ["idle", "streaming", "blocked"], `${view.name} states`);
    for (const state of view.states) assert.ok(state.screenshot, `refuse missing ${view.name}/${state.state} screenshot`);
  }
  assertIdentities(report.workflows.map((workflow) => workflow.name), baselineWorkflowNames, "workflow matrix");
  for (const workflow of report.workflows) {
    assertNoErrors(workflow, workflow.name);
    assert.ok(["measured", "partial", "unsupported"].includes(workflow.status), `refuse incomplete ${workflow.name}`);
    assert.ok(workflow.actions.every((action) => action.completed === true), `refuse failed action in ${workflow.name}`);
    if (workflow.status === "measured") assert.equal(workflow.actionCount, workflow.actions.length);
    else assert.ok(typeof workflow.reason === "string" && workflow.reason.trim(), `refuse unexplained ${workflow.status} workflow`);
  }
  const performance = report.performance;
  assert.ok(performance, "refuse to freeze without repeated performance samples");
  assertNoErrors(performance, "performance samples");
  assertSamples(performance.firstUsefulRender?.coldMs, 7, "cold render samples");
  assertSamples(performance.firstUsefulRender?.warmMs, 7, "warm render samples");
  assert.equal(performance.inputToPaint?.measurementVersion, 2, "refuse superseded input timing method");
  assertSamples(performance.inputToPaint.ms, 7, "input samples");
  assertSamples(performance.tabSwitchToContent?.ms, 7, "tab-switch samples");
  assertSamples(performance.retainedHeap?.afterBytes, 7, "heap samples");
  assert.equal(performance.streamRenderGap?.runs.length, 7, "refuse incomplete streaming samples");
  assert.ok(performance.streamRenderGap.runs.every((run) => run.finalOutputPresent === true), "refuse lost final output");
}

export async function writeBaselineReference(path, report, expectedViews) {
  assertBaselineComplete(report, expectedViews);
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
}
