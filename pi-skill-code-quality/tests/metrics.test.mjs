import test from "node:test";
import assert from "node:assert/strict";
import {
  cloneLineUnion,
  compareDirectDependencies,
  directDependencySnapshot,
  erosionSummary,
  matchCallableDeltas,
  physicalLineCount,
  physicalLineTotals,
} from "../skills/code-quality/scripts/lib/metrics.mjs";

function entry(path, bytes, category = "production", language = "javascript") {
  return { path, bytes: Buffer.from(bytes), category, language };
}

test("physical line totals retain raw CRLF/final-newline accounting without calling it SLOC", () => {
  const entries = new Map([
    ["a", entry("src/a.js", "one\r\ntwo\r\n")],
    ["b", entry("tests/a.test.js", "one\n", "test")],
  ]);
  assert.equal(physicalLineCount(Buffer.from("")), 0);
  assert.equal(physicalLineCount(Buffer.from("one\n")), 1);
  assert.equal(physicalLineCount(Buffer.from("one\ntwo")), 2);
  assert.deepEqual(physicalLineTotals(entries), {
    definition: "physical-lines-lf-delimited-raw-bytes-v1",
    files: 2,
    total: 3,
    categories: { production: 2, test: 1 },
    languages: { javascript: 3 },
  });
});

test("direct npm dependency comparison distinguishes additions, versions, sections, and malformed manifests", () => {
  const before = directDependencySnapshot(new Map([["package", entry("package.json", JSON.stringify({ dependencies: { alpha: "1.0.0" }, devDependencies: { beta: "1.0.0" } }))]]), 10);
  const after = directDependencySnapshot(new Map([["package", entry("package.json", JSON.stringify({ dependencies: { alpha: "2.0.0", beta: "1.0.0" } }))]]), 10);
  const changes = compareDirectDependencies(before, after, 10);
  assert.deepEqual(changes.changes, [
    { path: "package.json", kind: "changed", name: "alpha", section: "dependencies", beforeVersion: "1.0.0", afterVersion: "2.0.0" },
    { path: "package.json", kind: "added", name: "beta", section: "dependencies", beforeVersion: null, afterVersion: "1.0.0" },
    { path: "package.json", kind: "removed", name: "beta", section: "devDependencies", beforeVersion: "1.0.0", afterVersion: null },
  ]);
  const malformed = directDependencySnapshot(new Map([["package", entry("package.json", "{not json")]]), 10);
  assert.equal(malformed.status, "unavailable");
  assert.equal(compareDirectDependencies(malformed, after, 10).status, "unavailable");
});

test("clone unique-line accounting unions inclusive spans instead of forwarding jscpd duplicatedLines", () => {
  const union = cloneLineUnion([
    { first: { path: "src/a.js", startLine: 1, endLine: 4 }, second: { path: "src/a.js", startLine: 8, endLine: 10 } },
    { first: { path: "src/a.js", startLine: 3, endLine: 6 }, second: { path: "src/b.js", startLine: 1, endLine: 2 } },
  ]);
  assert.deepEqual(union, {
    definition: "inclusive-physical-span-union-v1",
    lines: 11,
    byPath: [{ path: "src/a.js", lines: 9 }, { path: "src/b.js", lines: 2 }],
  });
});

test("erosion can fall while an existing hotspot grows, and callable rows declare omissions", () => {
  const before = erosionSummary([{ cc: 15, sloc: 10 }, { cc: 1, sloc: 1 }]);
  const after = erosionSummary([{ cc: 16, sloc: 10 }, ...Array.from({ length: 100 }, () => ({ cc: 1, sloc: 1 }))]);
  assert.equal(after.value < before.value, true, "simple additions dilute the ratio despite a larger hotspot");
  const deltas = matchCallableDeltas([
    { path: "src/a.js", identity: "hot", cc: 15, sloc: 10 },
    { path: "src/b.js", identity: "other", cc: 2, sloc: 4 },
    { path: "src/duplicate.js", identity: "same", cc: 1, sloc: 1 },
    { path: "src/duplicate.js", identity: "same", cc: 1, sloc: 1 },
  ], [
    { path: "src/a.js", identity: "hot", cc: 16, sloc: 10 },
    { path: "src/b.js", identity: "other", cc: 3, sloc: 4 },
    { path: "src/new.js", identity: "added", cc: 1, sloc: 1 },
    { path: "src/duplicate.js", identity: "same", cc: 2, sloc: 1 },
    { path: "src/duplicate.js", identity: "same", cc: 2, sloc: 1 },
  ], 1);
  assert.equal(deltas.status, "partial");
  assert.equal(deltas.totalRows, 2);
  assert.equal(deltas.omittedRows, 1);
  assert.equal(deltas.rows[0].identity, "hot");
  assert.equal(deltas.added[0].identity, "added");
  assert.equal(deltas.unmatched[0].identity, "same");
});
