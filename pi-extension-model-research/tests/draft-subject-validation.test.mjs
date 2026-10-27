import assert from "node:assert/strict";
import test from "node:test";
import { FIXED_REFERENCE_PATHS } from "../src/types.ts";
import { escapeSubjectLabel, normalizeSubjects, subjectChoiceLabels } from "../src/subjects.ts";
import { validateSkillDraft } from "../src/validation.ts";
import { usageSummaryFixture } from "./usage-summary.mjs";

const AS_OF = "2026-05-20";
const WORKERS = ["claude-test", "gpt-test"].map((model, index) => ({ key: index === 0 ? "a" : "b", model }));

function draft(subjects, choice = "Insufficient evidence") {
  return `---\nname: model-routing-validation-fixture\ndescription: Use this offline fixture to check comparison-subject validation.\n---\n\n## Routing guidance\n\nAs of ${AS_OF}, compare ${subjects.map(subject => escapeSubjectLabel(subject.model)).join(" and ")}. Choose only with relevant task-specific evidence, not this synthetic fixture.\n\n## Limits and uncertainty\n\nNo live research, measurements, provider calls, or factual verification occurred. Do not treat this fixture as capability evidence. Structural validation checks identity and shape only.\n\n## Refresh triggers\n\nRefresh when model versions, tools, prices, or reliable evidence change.\n\n## Supporting evidence\n\n${FIXED_REFERENCE_PATHS.map(ref => `- [Record](${ref})`).join("\n")}\n\n${usageSummaryFixture(choice, 0)}`;
}

function validate(raw, subjects) {
  return validateSkillDraft(raw, AS_OF, subjects, true, WORKERS);
}

test("explicit subject choices require canonical inert Markdown, not raw active label spellings", () => {
  for (const label of ["<b>model-a</b>", "a&copy;b", "**model-a**", "[model](url)", "left|right", "path\\model"]) {
    const subjects = normalizeSubjects([label, "other-model"]);
    const encoded = subjectChoiceLabels(subjects)[0];
    assert.doesNotThrow(() => validate(draft(subjects, encoded), subjects), label);
    assert.throws(() => validate(draft(subjects, encoded).replaceAll(`| ${encoded} |`, `| ${label} |`), subjects), /Use must name an exact compared model|five nonempty|unsupported link/, label);
  }
});

test("a subject identity cannot be satisfied by a longer model name", () => {
  const subjects = normalizeSubjects(["gpt-5", "other-model"]);
  assert.doesNotThrow(() => validate(draft(subjects), subjects));
  for (const longer of ["gpt-5-mini", "gpt-5.1", "gpt-5_extra", "longergpt-5"]) {
    assert.throws(() => validate(draft(subjects).replace("compare gpt-5 and", `compare ${longer} and`), subjects), /must identify exact model gpt-5/);
  }
});

test("worker-only identities cannot replace subjects in routing prose or final table explanations", () => {
  const subjects = normalizeSubjects(["requested-one", "requested-two"]);
  const valid = draft(subjects, subjectChoiceLabels(subjects)[0]);
  for (const worker of ["claude-test", "CLAUDE-TEST", "gpt-test"]) {
    assert.throws(() => validate(valid.replace("Choose only with relevant", `Always use ${worker}. Choose only with relevant`), subjects), /must not reference research worker/);
    assert.throws(() => validate(valid.replace("Do not choose from synthetic fixtures;", `Prefer ${worker};`), subjects), /must not reference research worker/);
  }
  assert.doesNotThrow(() => validate(valid.replace("No live research,", "Writer claude-test produced this draft. No live research,"), subjects), "worker provenance remains allowed outside routing guidance");
});

test("worker overlap with comparison labels does not create false-positive routing rejection", () => {
  for (const labels of [["claude-test", "gpt-test"], ["claude-test-v2", "lab/gpt-test-next"], ["Model claude-test edition", "other-model"]]) {
    const subjects = normalizeSubjects(labels);
    assert.doesNotThrow(() => validate(draft(subjects, subjectChoiceLabels(subjects)[0]), subjects));
  }
});

test("inconclusive-word labels stay valid and disambiguate both subject choices", () => {
  for (const labels of [["Either", "Neither"], ["insufficient evidence", "Subject A: insufficient evidence"], ["Either", "Subject A: Either"]]) {
    const subjects = normalizeSubjects(labels);
    const choices = subjectChoiceLabels(subjects);
    assert.deepEqual(choices, subjects.map(subject => `Subject ${subject.key.toUpperCase()}: ${escapeSubjectLabel(subject.model)}`));
    assert.equal(new Set(choices).size, 2);
    for (const choice of [...choices, "Either", "Neither", "Insufficient evidence"]) assert.doesNotThrow(() => validate(draft(subjects, choice), subjects));
    assert.deepEqual(subjects.map(subject => subject.model), labels, "raw identities are never rewritten");
  }
});

test("legacy worker identity validation retains its pre-existing behavior", () => {
  const subjects = normalizeSubjects(["claude-test", "gpt-test"]);
  const raw = draft(subjects, "claude-test");
  const workerIdentities = WORKERS.map(worker => ({ ...worker, hostingProvider: "legacy" }));
  assert.doesNotThrow(() => validateSkillDraft(raw, AS_OF, workerIdentities, true));
});
