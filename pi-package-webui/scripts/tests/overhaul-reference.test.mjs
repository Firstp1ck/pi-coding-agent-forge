import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeBaselineReference } from "../browser/overhaul-reference.mjs";
import { compareReports, frozenBudgets, summarize, w7ViewMapping } from "../browser/overhaul-metrics.mjs";

const baseline = JSON.parse(await readFile(new URL("../../docs/overhaul/browser-baseline.json", import.meta.url), "utf8"));
const expectedViews = baseline.views.map(({ name }) => ({ name }));

function completeCapture() {
  const capture = structuredClone(baseline);
  // Historical captures predate these diagnostics; this fixture models a new capture.
  for (const workflow of capture.workflows) workflow.pageErrors = [];
  capture.performance.pageErrors = [];
  capture.performance.inputToPaint.measurementVersion = 2;
  return capture;
}

test("complete measured/partial/unsupported observations can replace a reference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webui-reference-test-"));
  try {
    const path = join(directory, "reference.json");
    const capture = completeCapture();
    await writeBaselineReference(path, capture, expectedViews);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), capture);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const invalidCaptures = [
  ["all nine names with one missing workflow", (capture) => { capture.workflows[0].status = "missing-evidence"; }],
  ["workflow error despite measured status", (capture) => { capture.workflows[0].error = "action timed out"; }],
  ["incomplete action", (capture) => { capture.workflows[0].actions[0].completed = false; }],
  ["duplicate workflow name", (capture) => { capture.workflows[1].name = capture.workflows[0].name; }],
  ["duplicate view name", (capture) => { capture.views[1].name = capture.views[0].name; }],
  ["duplicate state with correct count", (capture) => { capture.views[0].states[1].state = "idle"; }],
  ["view script error", (capture) => { capture.views[0].pageErrors.push("render failed"); }],
  ["workflow script error", (capture) => { capture.workflows[0].pageErrors.push("handler failed"); }],
  ["performance script error", (capture) => { capture.performance.pageErrors.push("stream failed"); }],
  ["missing repeated sample", (capture) => { capture.performance.inputToPaint.ms.raw.pop(); }],
  ["superseded input timing", (capture) => { delete capture.performance.inputToPaint.measurementVersion; }],
  ["missing final stream output", (capture) => { capture.performance.streamRenderGap.runs[0].finalOutputPresent = false; }],
];

for (const [name, invalidate] of invalidCaptures) {
  test(`${name} leaves the existing reference unchanged`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "webui-reference-test-"));
    try {
      const path = join(directory, "reference.json");
      const original = "previous reference must survive\n";
      await writeFile(path, original);
      const capture = completeCapture();
      invalidate(capture);
      await assert.rejects(writeBaselineReference(path, capture, expectedViews));
      assert.equal(await readFile(path, "utf8"), original);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}

test("input comparisons reject superseded samples without changing other metric comparisons", () => {
  const current = completeCapture();
  const previous = completeCapture();
  delete previous.performance.inputToPaint.measurementVersion;
  const comparison = compareReports(previous, current);
  assert.equal(comparison.checks.find((check) => check.name === "inputToPaintP95Ms").status, "missing-evidence");
  assert.ok(comparison.checks.filter((check) => check.name !== "inputToPaintP95Ms").every((check) => check.status === "within-budget"));
});

function completeW7Capture() {
  const capture = completeCapture();
  capture.views = w7ViewMapping.map((identity) => {
    const view = structuredClone(capture.views.find((entry) => entry.name === identity.baseline));
    view.name = identity.current;
    for (const state of view.states) {
      state.countingVersion = 2;
      state.secondaryCount = identity.desktop ? Math.floor(state.secondaryCount * 0.7) : state.secondaryCount;
      state.duplicateExpandedSummaries = 0;
      state.openAuxiliaryRegions = 0;
    }
    return view;
  });
  return capture;
}

const compareW7 = (capture) => compareReports(baseline, capture, { viewMapping: w7ViewMapping });

test("W7 maps focused to frozen Classic and keeps every compact mode/state denominator", () => {
  assert.deepEqual(frozenBudgets, baseline.budgets);
  const comparison = compareW7(completeW7Capture());
  assert.equal(comparison.density.length, 33);
  assert.equal(comparison.completeness, "complete");
  assert.equal(comparison.status, "within-budget");
  const desktop = comparison.density.filter((row) => row.view === "focused-1440x900");
  assert.deepEqual(desktop.map((row) => row.baseline), [29, 31, 0]);
  assert.ok(desktop.every((row) => row.baselineView === "classic-1440x900"));
});

for (const [name, mutate] of [
  ["desktop misses 30 percent reduction", (capture) => { capture.views[0].states[0].secondaryCount = 21; }],
  ["duplicate expanded summary", (capture) => { capture.views[0].states[0].duplicateExpandedSummaries = 1; }],
  ["two default auxiliary inspectors", (capture) => { capture.views[0].states[0].openAuxiliaryRegions = 2; }],
  ["phone control increase", (capture) => { capture.views[1].states[0].secondaryCount += 1; }],
  ["tablet control increase", (capture) => { capture.views.at(-1).states[1].secondaryCount += 1; }],
]) {
  test(`W7 rejects ${name}`, () => {
    const capture = completeW7Capture();
    mutate(capture);
    assert.ok(compareW7(capture).density.some((row) => row.status === "over-budget"));
  });
}

for (const [name, mutate] of [
  ["absent view", (capture) => { capture.views.pop(); }],
  ["absent state", (capture) => { capture.views[0].states.pop(); }],
  ["duplicate view", (capture) => { capture.views.push(capture.views[0]); }],
  ["duplicate state", (capture) => { capture.views[0].states.push(capture.views[0].states[0]); }],
  ["wrong view identity", (capture) => { capture.views[0].name = "classic-1440x900"; }],
  ["absent semantic counter", (capture) => { delete capture.views[0].states[0].countingVersion; }],
  ["missing screenshot", (capture) => { delete capture.views[0].states[0].screenshot; }],
  ["failed view", (capture) => { capture.views[0].error = "timed out"; }],
  ["script error", (capture) => { capture.views[0].pageErrors = ["broken handler"]; }],
  ["missing count", (capture) => { delete capture.views[0].states[0].secondaryCount; }],
  ["different companion denominator", (capture) => { capture.fixture.companions = "populated"; }],
]) {
  test(`W7 classifies ${name} as missing evidence`, () => {
    const capture = completeW7Capture();
    mutate(capture);
    const comparison = compareW7(capture);
    assert.equal(comparison.density.length, 33);
    assert.equal(comparison.completeness, "missing-evidence");
    assert.ok(comparison.density.some((row) => row.status === "missing-evidence"));
  });
}

test("missing performance and incomplete raw samples cannot inherit a numeric pass", () => {
  const capture = completeW7Capture();
  capture.performance.firstUsefulRender.coldMs.raw.pop();
  let comparison = compareW7(capture);
  assert.equal(comparison.checks[0].status, "missing-evidence");
  delete capture.performance;
  comparison = compareW7(capture);
  assert.ok(comparison.checks.every((row) => row.status === "missing-evidence"));
  assert.equal(comparison.finalOutput, null);
});

test("W7 preserves nearest-rank p95, cold/warm budgets and raw-sample integrity", () => {
  assert.deepEqual(summarize([7, 1, 3, 2, 6, 5, 4]), { count: 7, p50: 4, p95: 7, raw: [7, 1, 3, 2, 6, 5, 4] });
  const capture = completeW7Capture();
  capture.performance.firstUsefulRender.coldMs = summarize(Array(7).fill(1000));
  const comparison = compareW7(capture);
  assert.equal(comparison.checks[0].limit, baseline.performance.firstUsefulRender.coldMs.p95 + 50);
  assert.equal(comparison.checks[0].status, "over-budget");
  assert.equal(comparison.checks[1].status, "within-budget");
  capture.performance.inputToPaint.ms.p95 = 0;
  assert.equal(compareW7(capture).checks.find((row) => row.name === "inputToPaintP95Ms").status, "missing-evidence");
});

test("incompatible machine blocks timing verdicts while density remains measurable", () => {
  const capture = completeW7Capture();
  capture.machine.chromium = "different";
  const comparison = compareW7(capture);
  assert.equal(comparison.compatibleMachine, false);
  assert.deepEqual(comparison.machineMismatches, ["chromium"]);
  assert.ok(comparison.checks.every((row) => row.status === "missing-evidence"));
  assert.ok(comparison.density.every((row) => row.status === "within-budget"));
});

test("seven stream runs require all four gaps and retain lost final-output failures", () => {
  const capture = completeW7Capture();
  capture.performance.streamRenderGap.runs[0].finalOutputPresent = false;
  assert.equal(compareW7(capture).finalOutputCheck.status, "over-budget");
  capture.performance.streamRenderGap.runs.pop();
  assert.equal(compareW7(capture).checks.find((row) => row.name === "streamRenderGapP95Ms").status, "missing-evidence");
  assert.equal(compareW7(capture).finalOutput, false);
});

test("W7 focused capture cannot overwrite a W0 reference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "webui-w7-reference-test-"));
  try {
    const path = join(directory, "reference.json");
    await writeFile(path, "frozen W0 reference\n");
    await assert.rejects(writeBaselineReference(path, completeW7Capture(), expectedViews));
    assert.equal(await readFile(path, "utf8"), "frozen W0 reference\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
