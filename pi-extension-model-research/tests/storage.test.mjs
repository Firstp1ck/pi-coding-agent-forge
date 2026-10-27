import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { advanceRun, chooseWriter, createRun } from "../src/engine.ts";
import { FIXED_REFERENCE_PATHS, RECIPROCAL_REVIEW_RUBRIC } from "../src/types.ts";
import { createRunStore } from "../src/storage.ts";
import { MODEL_USAGE_TASKS, USAGE_SUMMARY_HEADING } from "../src/scope.ts";
import { usageSummaryFixture } from "./usage-summary.mjs";
import { escapeSubjectLabel, normalizeSubjects } from "../src/subjects.ts";

const AS_OF = "2026-05-20";
const CREATED = "2026-05-20T10:00:00.000Z";
const EXPIRES = "2099-05-20T10:00:00.000Z";

function target(key) {
  return {
    key,
    displayName: key === "a" ? "Alpha" : "Beta",
    modelAuthor: key === "a" ? "Author A" : "Author B",
    model: key === "a" ? "alpha-1" : "beta-1",
    hostingProvider: key === "a" ? "provider-a" : "provider-b",
    transport: "pi-registry",
    settings: { thinking: "off" },
  };
}

function newRun(runId = "storage-run", subjects) {
  return createRun({
    runId,
    task: "Choose a model for writing a reusable Pi skill.",
    asOfDate: AS_OF,
    createdAt: CREATED,
    targets: [target("a"), target("b")],
    ...(subjects === undefined ? {} : { subjects }),
    limits: { maxJobs: 5, perCall: { timeoutMs: 60_000, maxTurns: 8, maxTokens: 12_000 }, expiresAt: EXPIRES },
  });
}

function evidence(key, supportsTarget = key) {
  return {
    id: `${key}-ev-1`,
    url: `https://example.com/${key}/skill-writing`,
    accessedAt: AS_OF,
    sourceAccess: "fetched",
    evidenceClass: "documented",
    topics: ["skill-writing"],
    supportsTarget,
    title: `${key.toUpperCase()} skill-writing documentation`,
    excerptOrGap: `Documented bounded support for target ${supportsTarget}.`,
    conditions: "Same prompt, host tools, model version, and thinking-off setting.",
  };
}

function report(key) {
  const source = evidence(key, key === "a" ? "a" : "b");
  return {
    schemaVersion: 1,
    researcher: target(key),
    subjectTargets: ["a", "b"],
    asOfDate: AS_OF,
    taskSpecificRecommendation: `Use ${key} only under the documented skill-writing condition.`,
    arguments: [{
      id: `${key}-arg-1`,
      task: "Write a portable SKILL.md",
      claim: `Target ${key} is useful for this bounded task.`,
      classification: "documented",
      evidenceIds: [source.id],
      support: `The fetched documentation supports target ${key}.`,
      counterevidence: "No controlled head-to-head trial was performed.",
      conditions: "Use the exact recorded model and host settings.",
      recommendation: `Route to ${key} only while these conditions hold.`,
      confidence: key === "a" ? 78 : 68,
    }],
    evidence: [source],
    counterevidenceAndConditions: ["Model updates can invalidate this recommendation."],
    confidence: key === "a" ? 75 : 65,
    socialCoverage: {
      x: { status: "gap", evidenceIds: [], gap: "X was inaccessible." },
      reddit: { status: "gap", evidenceIds: [], gap: "Reddit was inaccessible." },
      other: { status: "gap", evidenceIds: [], gap: "Other social sources were not verified.", platforms: [] },
    },
    accessGaps: ["No verified social source was treated as fetched."],
  };
}

function review(key) {
  return {
    schemaVersion: 1,
    reviewer: target(key),
    reviewedOriginals: ["a", "b"],
    rubric: [...RECIPROCAL_REVIEW_RUBRIC],
    usefulnessVsOwn: { verdict: "mixed", explanation: `${key} found the peer useful for conditions but weaker on counterevidence.` },
    corrections: [],
    disagreements: [{ topic: "skill-writing evidence", position: `${key} retains a bounded disagreement.`, evidenceIds: ["a-ev-1"] }],
    missingEvidence: ["No controlled comparative writing trial."],
    writerRecommendation: "a",
    writerEvidenceIds: ["a-ev-1"],
    confidence: key === "a" ? 72 : 69,
  };
}

function draft() {
  const links = FIXED_REFERENCE_PATHS.map((reference) => `- [Source record](${reference})`).join("\n");
  return `---\nname: model-routing-skill-writing\ndescription: Use this dated guide to choose between the two recorded model targets for portable skill writing.\n---\n\n## Routing guidance\n\nAs of ${AS_OF}, compare alpha-1 and beta-1 and route only under the recorded task, model, host, and evidence conditions. This draft recommends a model but does not switch one automatically, and documented support does not establish universal superiority.\n\n## Limits and uncertainty\n\nThe evidence has social access gaps and no controlled head-to-head writing trial. Model updates, host settings, thinking controls, tool access, and unresolved disagreements can change the recommendation. Structural validation does not fact-check URLs or claims.\n\n## Refresh triggers\n\nRefresh after model, provider, price, host-tool, skill-format, or evidence changes, and whenever newer fetched counterevidence becomes available.\n\n## Supporting evidence\n\n${links}\n\n${usageSummaryFixture()}`;
}

class CompleteRuntime {
  kind = "pi";
  async start(job) {
    if (job.key === "research-a") return { status: "complete", text: JSON.stringify(report("a")) };
    if (job.key === "research-b") return { status: "complete", text: JSON.stringify(report("b")) };
    if (job.key === "review-a") return { status: "complete", text: JSON.stringify(review("a")) };
    if (job.key === "review-b") return { status: "complete", text: JSON.stringify(review("b")) };
    if (job.key === "draft") return { status: "complete", text: draft() };
    throw new Error(`Unexpected job ${job.key}`);
  }
  async check() { throw new Error("not pending"); }
  async cancel() {}
}

async function completedRun(runId = "complete-run") {
  const run = newRun(runId);
  await advanceRun(run, new CompleteRuntime(), () => {});
  assert.equal(run.status, "complete");
  return run;
}

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "model-research-storage-"));
  const projectRoot = path.join(base, "project");
  const root = path.join(base, "private-store");
  await mkdir(projectRoot, { mode: 0o700 });
  t.after(async () => { await import("node:fs/promises").then(({ rm }) => rm(base, { recursive: true, force: true })); });
  const store = await createRunStore({ root, owner: "user-1", projectRoot, runtimeKind: "pi" });
  return { base, projectRoot, root, store };
}

test("store creates, reads, saves, and lists strict owner-bound canonical envelopes under a lock", async (t) => {
  const { store, root, projectRoot } = await fixture(t);
  const run = newRun();
  const created = await store.create(run);
  assert.equal(created.owner, "user-1");
  assert.equal(created.projectRoot, await import("node:fs/promises").then(({ realpath }) => realpath(projectRoot)));
  assert.equal((await store.read(run.runId)).run.runId, run.runId);

  await store.withRunLock(run.runId, async (lock) => {
    const envelope = await store.read(run.runId);
    envelope.run.updatedAt = "2026-05-20T10:01:00.000Z";
    await store.save(envelope, lock);
  });
  assert.equal((await store.read(run.runId)).run.updatedAt, "2026-05-20T10:01:00.000Z");
  assert.deepEqual((await store.list()).map((envelope) => envelope.run.runId), [run.runId]);

  const otherOwner = await createRunStore({ root, owner: "user-2", projectRoot, runtimeKind: "pi" });
  await assert.rejects(otherOwner.read(run.runId), /owner/);
});

test("locks are exclusive, never auto-steal, and save rejects missing or mismatched locks and immutable rewrites", async (t) => {
  const { store } = await fixture(t);
  const first = newRun("first-run");
  const second = newRun("second-run");
  await store.create(first);
  await store.create(second);
  const lock = await store.acquireRunLock(first.runId);
  await assert.rejects(store.acquireRunLock(first.runId), /never stolen/);

  const envelope = await store.read(first.runId);
  envelope.run.task = "rewritten identity";
  await assert.rejects(store.save(envelope, lock), /immutable/);
  const withoutScope = await store.read(first.runId);
  delete withoutScope.run.scope;
  await assert.rejects(store.save(withoutScope, lock), /immutable/);
  await assert.rejects(store.save(await store.read(second.runId), lock), /matching run lock/);
  await lock.release();
  await assert.rejects(store.save(await store.read(first.runId), lock), /live matching run lock/);
  const next = await store.acquireRunLock(first.runId);
  await next.release();
});

test("malformed records, symlinks, insecure roots, traversal, and existing user files fail closed", async (t) => {
  const { base, root, projectRoot, store } = await fixture(t);
  const malformed = newRun("malformed");
  await store.create(malformed);
  const recordPath = path.join(root, "runs", malformed.runId, "record.json");
  await writeFile(recordPath, '{"schemaVersion":1,"unexpected":true}\n', { mode: 0o600 });
  await assert.rejects(store.read(malformed.runId), /exactly/);
  await assert.rejects(store.read("../escape"), /Invalid run ID/);

  const linked = newRun("linked");
  await store.create(linked);
  const linkedRecord = path.join(root, "runs", linked.runId, "record.json");
  await unlink(linkedRecord);
  await symlink("/etc/passwd", linkedRecord);
  await assert.rejects(store.read(linked.runId), /non-regular/);

  const occupied = newRun("occupied");
  const occupiedDir = path.join(root, "runs", occupied.runId);
  await mkdir(occupiedDir, { mode: 0o700 });
  await writeFile(path.join(occupiedDir, "keep.txt"), "user data", { mode: 0o600 });
  await assert.rejects(store.create(occupied), /EEXIST|exist/i);
  assert.equal(await readFile(path.join(occupiedDir, "keep.txt"), "utf8"), "user data", "failed create must preserve existing user files");

  const insecureRoot = path.join(base, "insecure");
  await mkdir(insecureRoot, { mode: 0o755 });
  await chmod(insecureRoot, 0o755);
  await assert.rejects(createRunStore({ root: insecureRoot, owner: "u", projectRoot, runtimeKind: "pi" }), /permissions/);

  const real = path.join(base, "real-store");
  const alias = path.join(base, "store-link");
  await mkdir(real, { mode: 0o700 });
  await symlink(real, alias);
  await assert.rejects(createRunStore({ root: alias, owner: "u", projectRoot, runtimeKind: "pi" }), /symlink/);
});

test("lock-release failure preserves the operation error instead of masking it", async t => {
  const { store } = await fixture(t);
  const state = newRun("release-errors");
  await store.create(state);
  await assert.rejects(store.withRunLock(state.runId, async lock => {
    await unlink(lock.path);
    throw new Error("original operation failure");
  }), error => error instanceof AggregateError && error.errors[0].message === "original operation failure" && /lock cleanup/.test(error.message));
});

test("layout substitution is rejected after store construction", async t => {
  const { store, root, base } = await fixture(t);
  const { rename } = await import("node:fs/promises");
  await rename(path.join(root, "runs"), path.join(base, "saved-runs"));
  await symlink(path.join(base, "saved-runs"), path.join(root, "runs"));
  await assert.rejects(store.list(), /symlink/);
  await assert.rejects(store.create(newRun()), /symlink/);
});

test("draft export is fixed, private, complete, and contains raw references plus human-readable evidence and review tables", async (t) => {
  const { store } = await fixture(t);
  const run = await completedRun();
  await store.create(run);
  await store.withRunLock(run.runId, async (lock) => {
    const result = await store.exportDraft(run.runId, lock);
    assert.equal(result.created, true);
    assert.equal(result.skillName, "model-routing-skill-writing");
    assert.deepEqual(result.files.sort(), ["SKILL.md", "comparison.md", ...FIXED_REFERENCE_PATHS].sort());
    assert.equal(await readFile(path.join(result.outputDir, "SKILL.md"), "utf8"), run.skillDraft);
    assert.equal(await readFile(path.join(result.outputDir, FIXED_REFERENCE_PATHS[0]), "utf8"), run.originals.a.raw);
    assert.equal(await readFile(path.join(result.outputDir, FIXED_REFERENCE_PATHS[3]), "utf8"), run.reviews.b.raw);
    assert.deepEqual(JSON.parse(await readFile(path.join(result.outputDir, FIXED_REFERENCE_PATHS[4]), "utf8")), run.writerSelection);
    const comparison = await readFile(path.join(result.outputDir, "comparison.md"), "utf8");
    for (const expected of [
      "https://example.com/a/skill-writing", "fetched", "documented", "Same prompt", "No controlled head-to-head",
      "Confidence", "Usefulness versus own report", "bounded disagreement", "Writer recommendation",
    ]) assert.ok(comparison.includes(expected), `comparison should include ${expected}`);
    assert.ok(comparison.endsWith(usageSummaryFixture()));
    for (const task of MODEL_USAGE_TASKS) assert.ok(comparison.includes(`| ${task} |`));
    assert.ok(comparison.indexOf(USAGE_SUMMARY_HEADING) > comparison.indexOf("## Decision"));

    const repeated = await store.exportDraft(run.runId, lock);
    assert.equal(repeated.created, false, "an identical complete export is idempotently inspectable");
  });
});

test("legacy completed exports keep their pre-summary layout and remain idempotent", async t => {
  const { store } = await fixture(t);
  const run = await completedRun("legacy-export");
  delete run.scope;
  run.skillDraft = run.skillDraft.replace(usageSummaryFixture(), "");
  run.jobs.find(job => job.key === "draft").result = run.skillDraft;
  await store.create(run);
  await store.withRunLock(run.runId, async lock => {
    const result = await store.exportDraft(run.runId, lock);
    const comparison = await readFile(path.join(result.outputDir, "comparison.md"), "utf8");
    assert.equal(comparison.includes(USAGE_SUMMARY_HEADING), false);
    assert.match(comparison, /Evidence IDs: a-ev-1\n$/);
    assert.equal((await store.exportDraft(run.runId, lock)).created, false);
  });
});

test("draft export never overwrites changed or partial artifacts and rejects symlinked content", async (t) => {
  const { store } = await fixture(t);
  const run = await completedRun("immutable-export");
  await store.create(run);
  await store.withRunLock(run.runId, async (lock) => {
    const result = await store.exportDraft(run.runId, lock);
    await writeFile(path.join(result.outputDir, "comparison.md"), "changed by user", { mode: 0o600 });
    await assert.rejects(store.exportDraft(run.runId, lock), /differs/);

    await unlink(path.join(result.outputDir, "comparison.md"));
    await symlink("/etc/passwd", path.join(result.outputDir, "comparison.md"));
    await assert.rejects(store.exportDraft(run.runId, lock), /symlink/);
  });
});

test("incomplete runs cannot export and export paths remain fixed below run draft storage", async (t) => {
  const { store, root } = await fixture(t);
  const run = newRun("not-complete");
  await store.create(run);
  await store.withRunLock(run.runId, async (lock) => {
    await assert.rejects(store.exportDraft(run.runId, lock), /Only a complete run/);
  });
  assert.equal(path.resolve(root, "runs", run.runId, "draft").startsWith(path.resolve(root) + path.sep), true);
});

test("subject labels survive locked save/reload and cannot be changed, removed, reordered, or added to legacy runs", async t => {
  const { store } = await fixture(t);
  const subjects = normalizeSubjects(["gpt-6.1-sol", "claude-opus-5.5"]);
  const run = newRun("explicit-subject-storage", subjects);
  await store.create(run);
  await store.withRunLock(run.runId, async lock => {
    const envelope = await store.read(run.runId);
    assert.deepEqual(envelope.run.subjects, subjects);
    envelope.run.jobs[0].status = "pending";
    envelope.run.jobs[0].taskId = "configured-worker-task";
    await store.save(envelope, lock);
    const reloaded = await store.read(run.runId);
    assert.deepEqual(reloaded.run.subjects, subjects);
    assert.equal(reloaded.run.jobs[0].taskId, "configured-worker-task");
    for (const changed of [
      undefined,
      normalizeSubjects(["replacement", subjects[1].model]),
      normalizeSubjects([subjects[1].model, subjects[0].model]),
    ]) {
      const mutation = await store.read(run.runId);
      if (changed === undefined) delete mutation.run.subjects;
      else mutation.run.subjects = changed;
      await assert.rejects(store.save(mutation, lock), /immutable/);
    }
    assert.deepEqual((await store.read(run.runId)).run.subjects, subjects);
  });

  const legacy = newRun("legacy-cannot-add-subjects");
  await store.create(legacy);
  await store.withRunLock(legacy.runId, async lock => {
    const envelope = await store.read(legacy.runId);
    envelope.run.subjects = subjects;
    await assert.rejects(store.save(envelope, lock), /immutable/);
    assert.equal(Object.hasOwn((await store.read(legacy.runId)).run, "subjects"), false);
  });
});

test("explicit exports separate compared subjects and research workers, retain raw identities, and are byte-identical on repeat", async t => {
  const { store, root } = await fixture(t);
  const subjects = normalizeSubjects(["<unknown>&[model]|a\\b", "same-author/unknown-2"]);
  const run = newRun("explicit-subject-export", subjects);
  const legacyRuntime = new CompleteRuntime();
  const runtime = {
    kind: "pi",
    async start(job) {
      const outcome = await legacyRuntime.start(job);
      if (job.stage === "research") outcome.text = JSON.stringify({ ...JSON.parse(outcome.text), subjects });
      else if (job.stage === "review") outcome.text = JSON.stringify({ ...JSON.parse(outcome.text), writerRecommendation: "undetermined", writerEvidenceIds: [] });
      else outcome.text = outcome.text.replace("alpha-1 and beta-1", subjects.map(subject => escapeSubjectLabel(subject.model)).join(" and "))
        .replace(usageSummaryFixture(), usageSummaryFixture(escapeSubjectLabel(subjects[0].model), 73));
      return outcome;
    },
    async check() { throw new Error("not pending"); },
    async cancel() {},
  };
  await advanceRun(run, runtime, () => {});
  assert.equal(run.status, "awaiting_writer");
  chooseWriter(run, "b");
  await advanceRun(run, runtime, () => {});
  assert.equal(run.status, "complete");
  await store.create(run);
  const recordPath = path.join(root, "runs", run.runId, "record.json");
  const originalRecord = await readFile(recordPath, "utf8");
  await store.withRunLock(run.runId, async lock => {
    const result = await store.exportDraft(run.runId, lock);
    const comparison = await readFile(path.join(result.outputDir, "comparison.md"), "utf8");
    assert.ok(comparison.includes("## Compared subjects"));
    assert.ok(comparison.includes("## Research workers"));
    assert.ok(comparison.includes("not proof of existence, availability, or capability"));
    const subjectSection = comparison.split("## Compared subjects")[1].split("## Research workers")[0];
    for (const subject of subjects) assert.ok(subjectSection.includes(escapeSubjectLabel(subject.model)));
    assert.equal(subjectSection.includes("alpha-1"), false);
    const workersSection = comparison.split("## Research workers")[1].split("## Research arguments")[0];
    for (const worker of run.targets) assert.ok(workersSection.includes(worker.model));
    assert.ok(comparison.includes("Selected research worker **B** by **user** decision."));
    assert.ok(comparison.endsWith(usageSummaryFixture(escapeSubjectLabel(subjects[0].model), 73)));
    for (const key of ["a", "b"]) {
      const raw = await readFile(path.join(result.outputDir, `references/research-${key}.json`), "utf8");
      assert.equal(raw, run.originals[key].raw);
      assert.deepEqual(JSON.parse(raw).subjects, subjects);
      assert.deepEqual(JSON.parse(raw).researcher, target(key));
    }
    const before = await Promise.all(result.files.map(file => readFile(path.join(result.outputDir, file), "utf8")));
    assert.equal((await store.exportDraft(run.runId, lock)).created, false);
    const after = await Promise.all(result.files.map(file => readFile(path.join(result.outputDir, file), "utf8")));
    assert.deepEqual(after, before);
    assert.equal(await readFile(recordPath, "utf8"), originalRecord, "export must not migrate or rewrite persisted records");
    await writeFile(path.join(result.outputDir, "comparison.md"), "user edit", { mode: 0o600 });
    await assert.rejects(store.exportDraft(run.runId, lock), /differs/);
  });
});
