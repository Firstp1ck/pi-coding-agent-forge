import assert from "node:assert/strict";
import test from "node:test";
import {
  addRequiredRanges,
  appendEvidence,
  beginReport,
  completeReview,
  coverageFor,
  createManifest,
  createReviewState,
  createTextTarget,
  isReviewState,
  isSnapshotTarget,
  normalizeRanges,
  sha256,
  startAttempt,
  targetIdFor,
  subtractRanges,
} from "../src/core.ts";
import { finalizeReadObservation } from "../src/read-evidence.ts";

const T0 = "2026-01-01T00:00:00.000Z";
const T1 = "2026-01-01T00:00:01.000Z";
const T2 = "2026-01-01T00:00:02.000Z";
const T3 = "2026-01-01T00:00:03.000Z";

function fixture() {
  const bytes = Buffer.from("one\ntwo\nthree\nfour\n", "utf8");
  const target = createTextTarget({ path: "src/example.ts", version: `sha256:${sha256(bytes)}`, bytes });
  const manifest = createManifest({ reviewId: "review-1", projectRoot: "/project", createdAt: T0, targets: [target] });
  return { target, manifest };
}

function observation(target, start, end, at = T1) {
  const lines = ["one", "two", "three", "four"].slice(start - 1, end);
  return {
    source: "tracked-read",
    targetId: target.id,
    version: target.version,
    sha256: target.sha256,
    requestedRange: { start, end },
    returnedRange: { start, end },
    lines,
    outcome: "success",
    completeLines: true,
    truncated: false,
    observedAt: at,
  };
}

test("range unions remove overlap and only uncovered intervals stay pending", () => {
  assert.deepEqual(normalizeRanges([{ start: 5, end: 7 }, { start: 1, end: 3 }, { start: 3, end: 5 }]), [{ start: 1, end: 7 }]);
  assert.deepEqual(subtractRanges([{ start: 1, end: 10 }], [{ start: 2, end: 3 }, { start: 6, end: 8 }]), [
    { start: 1, end: 1 }, { start: 4, end: 5 }, { start: 9, end: 10 },
  ]);
});

test("coverage derives from independently finalized evidence and duplicate reads do not inflate it", () => {
  const { target, manifest } = fixture();
  let state = startAttempt(createReviewState({ manifest, ownerSessionId: "session-1" }), T1);
  const first = finalizeReadObservation(manifest, observation(target, 1, 2));
  assert.equal(first.accepted, true);
  state = appendEvidence(state, first.evidence, T1);
  const duplicate = finalizeReadObservation(manifest, observation(target, 1, 2));
  assert.equal(duplicate.accepted, true);
  state = appendEvidence(state, duplicate.evidence, T1);
  const overlap = finalizeReadObservation(manifest, observation(target, 2, 4, T2));
  assert.equal(overlap.accepted, true);
  state = appendEvidence(state, overlap.evidence, T2);

  assert.equal(state.evidence.length, 2);
  assert.deepEqual(coverageFor(manifest, state.evidence)[0].coveredRanges, [{ start: 1, end: 4 }]);
  const reporting = beginReport(state, T3);
  const completed = completeReview(reporting, { jsonSha256: "a".repeat(64), markdownSha256: "b".repeat(64), generatedAt: T3 }, T3);
  assert.equal(completed.phase, "complete");
});

test("state validation fails closed on forged nested evidence and incomplete reports", () => {
  const { target, manifest } = fixture();
  const state = createReviewState({ manifest, ownerSessionId: "session-1" });
  const forged = structuredClone(state);
  forged.phase = "paused";
  forged.updatedAt = T1;
  forged.evidence.push({
    targetId: target.id,
    version: target.version,
    sha256: target.sha256,
    range: { start: 1, end: 4 },
    source: "native-read",
    returnedSha256: "f".repeat(64),
    returnedByteLength: 1,
    observedAt: T1,
  });
  assert.equal(isReviewState(forged), false, "persisted evidence must match frozen content, not only schema fields");

  const premature = structuredClone(state);
  premature.phase = "reporting";
  premature.updatedAt = T1;
  assert.equal(isReviewState(premature), false, "report phase cannot bypass pending coverage");
});

test("immutable versions and empty files remain explicit instead of fabricated line coverage", () => {
  assert.throws(() => createTextTarget({ path: "../escape", version: `sha256:${"a".repeat(64)}`, bytes: Buffer.from("x") }));
  assert.throws(() => createTextTarget({ path: "directory/..", version: `sha256:${"a".repeat(64)}`, bytes: Buffer.from("x") }));
  assert.throws(() => createTextTarget({ path: "x.txt", version: "main", bytes: Buffer.from("x") }));
  assert.throws(() => createTextTarget({ path: "x.txt", version: `sha256:${"a".repeat(64)}`, bytes: Buffer.from("x") }), /does not match/);
  const nulBytes = Buffer.from([0]);
  assert.equal(isSnapshotTarget({
    id: targetIdFor("restored.txt", `sha256:${sha256(nulBytes)}`),
    path: "restored.txt",
    version: `sha256:${sha256(nulBytes)}`,
    disposition: "reviewable",
    sha256: sha256(nulBytes),
    contentBase64: nulBytes.toString("base64"),
    byteLength: 1,
    lineCount: 1,
    requiredRanges: [{ start: 1, end: 1 }],
  }), false, "restored NUL text must fail closed");
  const empty = createTextTarget({ path: "empty.txt", version: `sha256:${sha256(Buffer.alloc(0))}`, bytes: Buffer.alloc(0) });
  assert.equal(empty.disposition, "empty");
  assert.equal(empty.lineCount, 0);
  assert.deepEqual(empty.requiredRanges, []);
});

test("context expansion is a union-only extension-owned manifest transition", () => {
  const bytes = Buffer.from("one\ntwo\nthree\nfour\n");
  const target = createTextTarget({
    path: "src/context.ts",
    version: `sha256:${sha256(bytes)}`,
    bytes,
    requiredRanges: [{ start: 1, end: 2 }],
  });
  const manifest = createManifest({ reviewId: "review-context", projectRoot: "/project", createdAt: T0, targets: [target] });
  let state = startAttempt(createReviewState({ manifest, ownerSessionId: "session-context" }), T1);
  const spanning = observation(target, 1, 3, T2);
  assert.equal(finalizeReadObservation(state.manifest, spanning).accepted, false, "W2 must expand a frozen requirement before crediting a wider read");
  state = addRequiredRanges(state, target.id, [{ start: 2, end: 4 }], T2);
  assert.deepEqual(state.manifest.targets[0].requiredRanges, [{ start: 1, end: 4 }]);
  const finalized = finalizeReadObservation(state.manifest, spanning);
  assert.equal(finalized.accepted, true);
  state = appendEvidence(state, finalized.evidence, T2);
  assert.deepEqual(coverageFor(state.manifest, state.evidence)[0].pendingRanges, [{ start: 4, end: 4 }]);
});
