import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureGitTargets, parsePatchHunks, parseRawDiff, runGit } from "../src/git.ts";
import { createManifest, reviewReadyForReport } from "../src/core.ts";

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function renameContent(changed = false) {
  return Array.from({ length: 20 }, (_unused, index) => index === 9 && changed ? "edited rename line" : `rename line ${index + 1}`).join("\n") + "\n";
}

async function repository(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `review-git-${name}-`));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Review Test");
  git(root, "config", "user.email", "review@example.invalid");
  await writeFile(path.join(root, "changed.txt"), "before\nkeep\n");
  await writeFile(path.join(root, "deleted.txt"), "gone\n");
  await writeFile(path.join(root, "rename-me.txt"), renameContent());
  git(root, "add", "--", ".");
  git(root, "commit", "-qm", "initial");
  return root;
}

test("Git capture keeps immutable old/new hunk targets, deletions, renames, and untracked UTF-8 paths", async (t) => {
  const root = await repository("changes");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "changed.txt"), "after\nkeep\n");
  await unlink(path.join(root, "deleted.txt"));
  await rename(path.join(root, "rename-me.txt"), path.join(root, "renamed file.txt"));
  await writeFile(path.join(root, "renamed file.txt"), renameContent(true));
  await writeFile(path.join(root, "new ünicode.txt"), "new\nfile\n");
  git(root, "add", "--", "changed.txt", "deleted.txt", "rename-me.txt", "renamed file.txt");

  const capture = await captureGitTargets({ cwd: root, contextLines: 1 });
  assert.match(capture.headObject, /^[a-f0-9]{40}$/);
  assert.ok(capture.changes.some((change) => change.layer === "staged" && change.status.startsWith("M")));
  assert.ok(capture.changes.some((change) => change.layer === "staged" && change.status.startsWith("D")));
  const renameChange = capture.changes.find((change) => change.layer === "staged" && change.status.startsWith("R"));
  assert.ok(renameChange, "Git must retain a rename classification");
  assert.ok(renameChange.oldRanges.length > 0 && renameChange.newRanges.length > 0, "renamed-and-edited files need old and new hunk requirements");
  assert.ok(capture.targets.some((target) => target.path === "rename-me.txt" && target.disposition === "reviewable" && target.requiredRanges.length > 0), "old rename version must remain pending until read");
  assert.ok(capture.changes.some((change) => change.layer === "untracked" && change.newPath === "new ünicode.txt"));
  assert.ok(capture.targets.some((target) => target.path === "changed.txt" && target.version.startsWith("git:")));
  assert.ok(capture.targets.some((target) => target.path === "new ünicode.txt" && target.disposition === "reviewable"));
  const baseline = capture.baselines.find((item) => item.path === "changed.txt");
  assert.equal(baseline?.expected, "present");
  assert.match(baseline?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.ok(capture.targets.some((target) => target.disposition === "metadata" && /Deleted Git version/.test(target.reason)));
  assert.deepEqual(capture.baselines.find((item) => item.path === "deleted.txt"), { path: "deleted.txt", expected: "absent" });

  const changedVersions = capture.targets.filter((target) => target.path === "changed.txt").map((target) => target.version);
  assert.ok(new Set(changedVersions).size >= 2, "old and new Git blob identities must remain separate targets");
  await assert.rejects(() => captureGitTargets({ cwd: root, limits: { maxTargets: 1 } }), /target limit/);
});

test("Git binary classification is blocked instead of covered without reads", async (t) => {
  const root = await repository("binary-classified");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, ".gitattributes"), "*.txt -diff\n");
  git(root, "add", ".gitattributes"); git(root, "commit", "-qm", "attributes");
  await writeFile(path.join(root, "changed.txt"), "after\nkeep\n");
  const capture = await captureGitTargets({ cwd: root });
  const changed = capture.targets.filter((target) => target.path === "changed.txt");
  assert.ok(changed.length > 0);
  assert.ok(changed.every((target) => target.disposition === "blocked"));
  const manifest = createManifest({ reviewId: "binary-review", projectRoot: root, createdAt: new Date().toISOString(), targets: capture.targets });
  assert.equal(reviewReadyForReport(manifest, []), false);
});

test("Git unmerged status is blocked", async (t) => {
  const root = await repository("unmerged");
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "checkout", "-qb", "side");
  await writeFile(path.join(root, "changed.txt"), "side\nkeep\n"); git(root, "commit", "-qam", "side");
  git(root, "checkout", "-q", "main");
  await writeFile(path.join(root, "changed.txt"), "main\nkeep\n"); git(root, "commit", "-qam", "main");
  const merge = spawnSync("git", ["merge", "side"], { cwd: root, encoding: "utf8" });
  assert.notEqual(merge.status, 0);
  const capture = await captureGitTargets({ cwd: root });
  assert.ok(capture.targets.some((target) => target.path === "changed.txt" && target.disposition === "blocked"));
});

test("Git mode refuses a repository subdirectory", async (t) => {
  const root = await repository("subdir");
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = path.join(root, "child"); await fs.promises.mkdir(child);
  await assert.rejects(captureGitTargets({ cwd: child }), /repository root/u);
});

test("Git capture applies custom exclusions before materializing either side", async (t) => {
  const root = await repository("excluded");
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "changed.txt"), "private after\nkeep\n");
  const capture = await captureGitTargets({ cwd: root, exclude: (pathname) => pathname === "changed.txt" ? "user exclusion" : undefined });
  const targets = capture.targets.filter((target) => target.path === "changed.txt");
  assert.ok(targets.length > 0);
  assert.ok(targets.every((target) => target.disposition === "excluded" && target.contentBase64 === undefined));
  assert.ok(capture.changes.filter((change) => change.newPath === "changed.txt").every((change) => change.oldRanges.length === 0 && change.newRanges.length === 0));
});

test("Git capture fails instead of mapping a worktree hunk onto source bytes that drift during capture", async (t) => {
  const root = await repository("drift");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "changed.txt");
  await writeFile(source, "candidate\nkeep\n");
  const originalOpen = fs.promises.open;
  let armed = true;
  fs.promises.open = async (candidate, ...args) => {
    if (armed && path.resolve(String(candidate)) === source) {
      armed = false;
      await writeFile(source, "drifted\nkeep\n");
    }
    return await originalOpen.call(fs.promises, candidate, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(() => captureGitTargets({ cwd: root }), /changed (?:before|during) snapshot capture|changed while freezing/);
    assert.equal(armed, false, "test hook must change the worktree after hunk enumeration and before frozen bytes are read");
  } finally {
    fs.promises.open = originalOpen;
    syncBuiltinESMExports();
  }
});

test("Git capture supports staged additions in an unborn repository without inventing an old side", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-git-unborn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  await writeFile(path.join(root, "first.txt"), "first\n");
  git(root, "add", "--", "first.txt");
  const capture = await captureGitTargets({ cwd: root });
  assert.equal(capture.headObject, undefined);
  assert.ok(capture.changes.some((change) => change.status.startsWith("A") && change.newPath === "first.txt"));
  assert.ok(capture.targets.some((target) => target.path === "first.txt" && target.version.startsWith("git:")));
});

test("verified mode-only changes are metadata, not permanent blockers", async (t) => {
  const root = await repository("mode-only");
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "update-index", "--chmod=+x", "changed.txt");
  const capture = await captureGitTargets({ cwd: root });
  assert.ok(capture.targets.some((target) => /mode-only/.test(target.reason ?? "") && target.disposition === "metadata"));
  assert.ok(!capture.targets.some((target) => target.disposition === "blocked"));
});

test("untracked baseline reuses frozen content without a second read", async (t) => {
  const root = await repository("untracked-baseline");
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "untracked.txt");
  await writeFile(source, "first\n");
  const originalReadFile = fs.promises.readFile;
  let reread = false;
  fs.promises.readFile = async (candidate, ...args) => {
    if (path.resolve(String(candidate)) === source) { reread = true; await writeFile(source, "second\n"); }
    return originalReadFile(candidate, ...args);
  };
  syncBuiltinESMExports();
  try {
    const capture = await captureGitTargets({ cwd: root });
    const target = capture.targets.find((item) => item.path === "untracked.txt");
    const baseline = capture.baselines.find((item) => item.path === "untracked.txt");
    assert.equal(reread, false, "a post-freeze baseline read could absorb unreviewed changes");
    assert.equal(baseline.sha256, target.sha256);
  } finally { fs.promises.readFile = originalReadFile; syncBuiltinESMExports(); }
});

test("raw/hunk parsers and Git cancellation fail conservatively", async () => {
  const raw = Buffer.from(":100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb M\0name with spaces.txt\0");
  assert.deepEqual(parseRawDiff(raw), [{
    status: "M",
    oldPath: "name with spaces.txt",
    newPath: "name with spaces.txt",
    oldObject: "a".repeat(40),
    newObject: "b".repeat(40),
  }]);
  assert.deepEqual(parsePatchHunks(Buffer.from("@@ -2,3 +4,2 @@\n context\n")).oldRanges, [{ start: 2, end: 4 }]);
  assert.deepEqual(parsePatchHunks(Buffer.from("@@ -2,3 +4,2 @@\n context\n")).newRanges, [{ start: 4, end: 5 }]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => runGit(process.cwd(), ["--version"], { signal: controller.signal }), /cancelled/);
  await assert.rejects(() => runGit(process.cwd(), ["status"]), /read-only Git commands/);
  await assert.rejects(() => runGit(process.cwd(), ["diff", "--output=would-write.patch"]), /rejects diff options/);
});
