import assert from "node:assert/strict";
import test from "node:test";
import {
  appendEvidence,
  createManifest,
  createNonTextTarget,
  createReviewState,
  createTextTarget,
  replaceFindings,
  sha256,
  startAttempt,
} from "../src/core.ts";
import { finalizeReadObservation } from "../src/read-evidence.ts";
import { renderReviewReport } from "../src/report.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";

test("report emits deterministic ledger coverage and never turns coverage into a no-defect claim", () => {
  const bytes = Buffer.from("line one\nline two\n");
  const target = createTextTarget({ path: "src/file.ts", version: `sha256:${sha256(bytes)}`, bytes });
  const blocked = createNonTextTarget({
    path: "assets/image.bin",
    version: `metadata:${"a".repeat(64)}`,
    disposition: "blocked",
    reason: "Binary content is unsupported.",
  });
  const manifest = createManifest({ reviewId: "review-report", projectRoot: "/project", createdAt: T0, targets: [target, blocked] });
  let state = startAttempt(createReviewState({ manifest, ownerSessionId: "session-report" }), T1);
  const finalized = finalizeReadObservation(manifest, {
    source: "tracked-read",
    targetId: target.id,
    version: target.version,
    sha256: target.sha256,
    requestedRange: { start: 1, end: 2 },
    returnedRange: { start: 1, end: 2 },
    lines: ["line one", "line two"],
    outcome: "success",
    completeLines: true,
    truncated: false,
    observedAt: T1,
  });
  assert.equal(finalized.accepted, true);
  state = appendEvidence(state, finalized.evidence, T1);
  state = replaceFindings(state, [{
    id: "finding-1",
    severity: "high",
    title: "Unsafe branch",
    detail: "The frozen source needs an explicit guard.",
    targetId: target.id,
    line: 2,
    evidence: "line two",
  }], T1);

  const report = renderReviewReport(state, ["src/file.ts changed after capture"]);
  assert.equal(report.document.summary.covered, 1);
  assert.equal(report.document.summary.blocked, 1);
  assert.match(report.json, /"limitation":"INCOMPLETE reviewing review/);
  assert.match(report.markdown, /does not prove comprehension or absence of defects/);
  assert.match(report.markdown, /HIGH: Unsafe branch/);
  assert.match(report.markdown, /src\/file\.ts changed after capture/);
  assert.deepEqual(report.document.driftWarnings, ["src/file.ts changed after capture"]);
  assert.equal(report.jsonSha256, sha256(report.json));
  assert.equal(report.markdownSha256, sha256(report.markdown));
  assert.equal(renderReviewReport(state, ["src/file.ts changed after capture"]).json, report.json, "same state renders byte-for-byte stable ledger output");
});
