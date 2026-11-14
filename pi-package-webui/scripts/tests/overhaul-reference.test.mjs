import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { writeBaselineReference } from "../browser/overhaul-reference.mjs";
import { compareReports } from "../browser/overhaul-metrics.mjs";

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
