import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManifest, createReviewState, createTextTarget, sha256 } from "../src/core.ts";
import { createReviewStorage, ReviewStorageError } from "../src/storage.ts";

const TIME = "2026-01-01T00:00:00.000Z";

function state() {
  const bytes = Buffer.from("content\n");
  const target = createTextTarget({ path: "file.ts", version: `sha256:${sha256(bytes)}`, bytes });
  const manifest = createManifest({ reviewId: "review-storage", projectRoot: "/project", createdAt: TIME, targets: [target] });
  return createReviewState({ manifest, ownerSessionId: "session-storage" });
}

test("storage atomically persists validated state and bounded report artifacts outside the project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createReviewStorage({ rootDir: root, limits: { maxArtifactBytes: 128 } });
  const input = state();
  const statePath = await storage.writeState(input);
  assert.match(statePath, /reviews/);
  assert.deepEqual(await storage.readState(input.reviewId), input);
  await storage.writeArtifact(input.reviewId, "report.md", "# Review\n");
  assert.equal(await storage.readArtifact(input.reviewId, "report.md"), "# Review\n");
  await assert.rejects(() => storage.writeArtifact(input.reviewId, "report.json", "x".repeat(129)), ReviewStorageError);
});

test("storage rejects escaped IDs and malformed nested state rather than silently restoring it", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-storage-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createReviewStorage({ rootDir: root });
  const input = state();
  const directory = await storage.reviewDirectory(input.reviewId);
  await writeFile(path.join(directory, "state.json"), JSON.stringify({ ...input, evidence: [{ targetId: "not-a-hash" }] }));
  await assert.rejects(() => storage.readState(input.reviewId), /malformed|inconsistent/);
  await assert.rejects(() => storage.readState("../escape"), /unsafe path/);
});

test("atomic state replacement retries transient sharing errors without deleting prior state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-storage-sharing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createReviewStorage({ rootDir: root });
  const input = state();
  await storage.writeState(input);
  const original = fs.promises.rename;
  let attempts = 0;
  fs.promises.rename = async (...args) => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error("sharing violation"), { code: "EPERM" });
    return original(...args);
  };
  syncBuiltinESMExports();
  try {
    await storage.writeState(input);
    assert.equal(attempts, 2);
    assert.deepEqual(await storage.readState(input.reviewId), input);
  } finally { fs.promises.rename = original; syncBuiltinESMExports(); }
});

test("state writes enforce a finite persistence boundary", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-storage-bound-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = createReviewStorage({ rootDir: root, limits: { maxStateBytes: 64 } });
  await assert.rejects(() => storage.writeState(state()), /storage limit/);
});
