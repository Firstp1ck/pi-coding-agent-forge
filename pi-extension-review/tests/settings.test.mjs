import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_REVIEW_SETTINGS,
  createReviewRuntimeStore,
  createReviewSettingsStore,
  matchesReviewExclusion,
  validateReviewRuntimeRecord,
  validateReviewSettings,
} from "../src/settings.ts";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
async function temp() { const root = await mkdtemp(path.join(os.tmpdir(), "review-settings-")); roots.push(root); return root; }

test("settings reject unknown fields and enforce finite continuation bounds", () => {
  const valid = validateReviewSettings(DEFAULT_REVIEW_SETTINGS);
  assert.equal(valid.maxTurns, 100);
  assert.throws(() => validateReviewSettings({ ...valid, maxTurns: Infinity }), /Maximum turns/u);
  assert.throws(() => validateReviewSettings({ ...valid, timeoutMs: 0 }), /Attempt timeout/u);
  assert.throws(() => validateReviewSettings({ ...valid, surprise: true }), /unknown fields/u);
  assert.throws(() => validateReviewSettings({ ...valid, mode: "paths", paths: [] }), /at least one path/u);
  assert.throws(() => validateReviewSettings({ ...valid, mode: "paths", paths: ["../outside.ts"] }), /project-relative/u);
  assert.throws(() => validateReviewSettings({ ...valid, exclusions: ["build/../src"] }), /without traversal/u);
});

test("runtime records preserve bounded multiline task context", () => {
  const timestamp = new Date().toISOString();
  const record = validateReviewRuntimeRecord({
    schemaVersion: 1, reviewId: "review-multiline", ownerSessionId: "session-1", projectRoot: path.resolve("project"),
    mode: "work", paths: [], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" },
    limits: { contextLines: 3, maxTurns: 10, timeoutMs: 5_000, maxNoProgress: 2, maxContextBytes: 4_096 },
    taskContext: ["USER:\nPlease inspect both branches.\nKeep exact evidence."], provenanceWarnings: [], baselines: [],
    createdAt: timestamp, updatedAt: timestamp, status: "frozen", finalReportSubmitted: false,
  });
  assert.match(record.taskContext[0], /both branches\.\nKeep/u);
});

test("settings save atomically after compare-and-swap confirmation", async () => {
  const root = await temp();
  const store = createReviewSettingsStore(root);
  const initial = await store.load();
  const changed = { ...initial.settings, mode: "paths", paths: ["src/a file.ts"], exclusions: ["dist/*"] };
  await store.save(initial.raw, changed);
  assert.deepEqual((await store.load()).settings, changed);
  await assert.rejects(store.save(initial.raw, { ...changed, maxTurns: 4 }), /changed while setup was open/u);
});

test("runtime records are separately validated and keyed by owner plus project", async () => {
  const root = await temp();
  const project = path.resolve(root, "project");
  const store = createReviewRuntimeStore(root);
  const timestamp = new Date().toISOString();
  const record = validateReviewRuntimeRecord({
    schemaVersion: 1, reviewId: "review-1", ownerSessionId: "session-1", projectRoot: project,
    mode: "git", paths: [], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" },
    limits: { contextLines: 3, maxTurns: 10, timeoutMs: 5_000, maxNoProgress: 2, maxContextBytes: 4_096 },
    taskContext: [], provenanceWarnings: [], baselines: [], createdAt: timestamp, updatedAt: timestamp,
    status: "frozen", finalReportSubmitted: false,
  });
  assert.throws(() => validateReviewRuntimeRecord({ ...record, reviewId: 42 }), /ownership/u);
  assert.throws(() => validateReviewRuntimeRecord({ ...record, model: null }), /model/u);
  await store.write(record);
  assert.deepEqual(await store.read("review-1"), record);
  assert.deepEqual(await store.current("session-1", project), record);
  const fs = await import("node:fs/promises");
  const misplaced = { ...record, reviewId: "embedded-other" };
  await fs.writeFile(path.join(root, "review", "runs", "requested-id.json"), `${JSON.stringify(misplaced)}\n`);
  await assert.rejects(store.read("requested-id"), /filename and embedded ID/u);
  assert.equal(await store.current("other-session", project), undefined);
});

test("path exclusions are visible, deterministic prefix or wildcard matches", () => {
  assert.equal(matchesReviewExclusion("generated/a.ts", ["generated"]), "User exclusion: generated");
  assert.equal(matchesReviewExclusion("src/a.test.ts", ["src/*.test.ts"]), "User exclusion: src/*.test.ts");
  assert.equal(matchesReviewExclusion("src/a.ts", ["src/*.test.ts"]), undefined);
});
