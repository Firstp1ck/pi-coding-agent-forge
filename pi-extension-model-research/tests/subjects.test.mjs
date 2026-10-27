import assert from "node:assert/strict";
import test from "node:test";
import { comparisonSubjects, escapeSubjectLabel, normalizeSubjects, validateSubjects } from "../src/subjects.ts";

test("normalizes arbitrary, unknown, and same-author labels without resolving workers", () => {
  const subjects = normalizeSubjects(["  gpt-6.1-sol  ", "claude-opus-5.5"]);
  assert.deepEqual(subjects, [{ key: "a", model: "gpt-6.1-sol" }, { key: "b", model: "claude-opus-5.5" }]);
  assert.deepEqual(normalizeSubjects(["unknown-a", "unknown-b"]).map(subject => subject.model), ["unknown-a", "unknown-b"]);
  assert.doesNotThrow(() => normalizeSubjects(["same-author/model-1", "same-author/model-2"]));
  assert.equal(Object.isFrozen(subjects), true);
  assert.equal(Object.isFrozen(subjects[0]), true);
  assert.throws(() => { subjects[0].model = "rewritten"; }, TypeError);
  assert.doesNotThrow(() => normalizeSubjects(["x".repeat(200), "y"]));
  assert.doesNotThrow(() => normalizeSubjects([`  ${"x".repeat(200)}  `, "y"]));
});

test("rejects blank, cancelled, duplicate, multiline, control, and oversized labels", () => {
  for (const value of [undefined, null, [], ["a"], ["a", "b", "c"], [null, "b"], [1, "b"], ["", "b"], ["  ", "b"], ["a", " A "], ["x".repeat(201), "b"]]) {
    assert.throws(() => normalizeSubjects(value), TypeError, JSON.stringify(value));
  }
  for (const control of ["\0", "\t", "\r", "\n", "\x1b", "\x7f", "\x85", "\u2028", "\u2029", "\u202e", "\u200b"]) {
    for (const label of [`${control}a`, `a${control}b`, `a${control}`]) {
      assert.throws(() => normalizeSubjects([label, "valid"]), /single-line.*control/);
    }
  }
});

test("persisted subjects validate canonical identity without normalization or mutation", () => {
  const subjects = structuredClone(normalizeSubjects(["Alpha", "Beta"]));
  assert.equal(validateSubjects(subjects), subjects);
  for (const invalid of [
    [subjects[1], subjects[0]],
    [{ ...subjects[0], key: "b" }, subjects[1]],
    [{ ...subjects[0], model: " Alpha " }, subjects[1]],
    [{ ...subjects[0], model: "beta" }, subjects[1]],
    [{ ...subjects[0], author: "guessed" }, subjects[1]],
    [Object.assign(Object.create({}), subjects[0]), subjects[1]],
    ["Alpha", "Beta"],
  ]) assert.throws(() => validateSubjects(invalid), TypeError);
  assert.deepEqual(subjects, normalizeSubjects(["Alpha", "Beta"]));
});

test("legacy fallback preserves exact historical IDs and does not add subjects", () => {
  const legacy = { targets: [{ key: "a", model: " legacy-a " }, { key: "b", model: "x".repeat(201) }] };
  assert.deepEqual(comparisonSubjects(legacy), [{ key: "a", model: " legacy-a " }, { key: "b", model: "x".repeat(201) }]);
  assert.equal(Object.hasOwn(legacy, "subjects"), false);
  const explicit = { ...legacy, subjects: normalizeSubjects(["requested-a", "requested-b"]) };
  assert.equal(comparisonSubjects(explicit), explicit.subjects);
});

test("subject rendering keeps HTML and Markdown syntax inert without losing label data", () => {
  assert.equal(escapeSubjectLabel("<script>&[x](url)|a\\b*`~"), "&lt;script&gt;&amp;\\[x\\]\\(url\\)\\|a\\\\b\\*\\`\\~");
});
