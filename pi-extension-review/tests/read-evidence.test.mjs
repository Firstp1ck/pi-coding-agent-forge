import assert from "node:assert/strict";
import test from "node:test";
import { createManifest, createTextTarget, sha256 } from "../src/core.ts";
import { finalizeReadObservation, readTrackedSnapshot } from "../src/read-evidence.ts";

const TIME = "2026-01-01T00:00:00.000Z";

function fixture() {
  const bytes = Buffer.from("alpha\nbeta\ngamma\n", "utf8");
  const target = createTextTarget({ path: "source.ts", version: `sha256:${sha256(bytes)}`, bytes });
  const manifest = createManifest({ reviewId: "review-evidence", projectRoot: "/project", createdAt: TIME, targets: [target] });
  return { manifest, target };
}

function observation(target, changes = {}) {
  return {
    source: "native-read",
    targetId: target.id,
    version: target.version,
    sha256: target.sha256,
    requestedRange: { start: 1, end: 3 },
    returnedRange: { start: 1, end: 2 },
    lines: ["alpha", "beta"],
    outcome: "success",
    completeLines: true,
    truncated: true,
    observedAt: TIME,
    ...changes,
  };
}

test("native truncation earns only exact complete returned lines", () => {
  const { manifest, target } = fixture();
  const result = finalizeReadObservation(manifest, observation(target));
  assert.equal(result.accepted, true);
  assert.deepEqual(result.evidence.range, { start: 1, end: 2 });
  assert.equal(result.evidence.returnedByteLength, Buffer.byteLength("alpha\nbeta"));
});

test("failed, cancelled, and partial reads receive no coverage", () => {
  const { manifest, target } = fixture();
  for (const changes of [
    { outcome: "failed" },
    { outcome: "cancelled" },
    { completeLines: false },
  ]) {
    const result = finalizeReadObservation(manifest, observation(target, changes));
    assert.equal(result.accepted, false);
  }
});

test("forged identities, ranges, or content cannot become evidence", () => {
  const { manifest, target } = fixture();
  assert.equal(finalizeReadObservation(manifest, observation(target, { sha256: "f".repeat(64) })).accepted, false);
  assert.equal(finalizeReadObservation(manifest, observation(target, { lines: ["forged", "beta"] })).accepted, false);
  assert.equal(finalizeReadObservation(manifest, observation(target, { requestedRange: { start: 1, end: 2 }, returnedRange: { start: 2, end: 3 }, lines: ["beta", "gamma"] })).accepted, false);
  assert.equal(finalizeReadObservation(manifest, observation(target, { lines: ["alpha", "beta"], completeLines: true }), { maxOutputLines: 1 }).accepted, false);
});

test("tracked snapshot reads expose only bounded immutable ranges", () => {
  const { manifest, target } = fixture();
  const tracked = readTrackedSnapshot(manifest, { targetId: target.id, range: { start: 2, end: 3 } });
  assert.deepEqual(tracked.lines, ["beta", "gamma"]);
  assert.equal(tracked.text, "beta\ngamma");
  assert.throws(() => readTrackedSnapshot(manifest, { targetId: target.id, range: { start: 1, end: 3 } }, { maxOutputLines: 2 }), /exceeds output limits/);
});
