import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { targetLines } from "../src/core.ts";
import { capturePathTarget, capturePathTargets, defaultExclusionReason } from "../src/snapshot.ts";

async function tempProject() {
  const root = await mkdtemp(path.join(os.tmpdir(), "review-snapshot-"));
  return root;
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

test("path snapshots freeze valid UTF-8 bytes under a content-addressed immutable version", async (t) => {
  const root = await tempProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  const source = path.join(root, "src", "file.ts");
  await writeFile(source, "first\nsecond\n");
  const target = await capturePathTarget({ projectRoot: root, requestedPath: "src/file.ts" });
  await writeFile(source, "changed\n");

  assert.equal(target.path, "src/file.ts");
  assert.match(target.version, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(targetLines(target), ["first", "second"]);
  assert.equal(target.requiredRanges[0].end, 2);
});

test("snapshot capture rejects boundary escapes and blocks binary or oversized input explicitly", async (t) => {
  const root = await tempProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0x61, 0, 0x62]));
  await writeFile(path.join(root, "large.txt"), "0123456789");

  await assert.rejects(() => capturePathTarget({ projectRoot: root, requestedPath: "../outside.txt" }), /escapes the project boundary/);
  const binary = await capturePathTarget({ projectRoot: root, requestedPath: "binary.dat" });
  assert.equal(binary.disposition, "blocked");
  assert.match(binary.reason, /Binary/);
  const large = await capturePathTarget({ projectRoot: root, requestedPath: "large.txt", limits: { maxTargetBytes: 4 } });
  assert.equal(large.disposition, "blocked");
  assert.match(large.reason, /4-byte/);
});

test("directory capture is bounded and default generated/vendor/secret exclusions stay visible", async (t) => {
  const root = await tempProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  await mkdir(path.join(root, "src"));
  await mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await writeFile(path.join(root, "src", "visible.ts"), "export {};\n");
  await writeFile(path.join(root, ".env"), "TOKEN=never-copy\n");
  await writeFile(path.join(root, "tracked.txt"), "tracked content\n");
  git(root, "add", "--", "tracked.txt");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\ntracked.txt\n");
  await writeFile(path.join(root, "ignored.txt"), "do not review\n");
  await writeFile(path.join(root, "node_modules", "pkg", "hidden.js"), "module.exports = 1;\n");

  assert.match(defaultExclusionReason("node_modules/pkg/hidden.js"), /vendor/i);
  assert.match(defaultExclusionReason(".env"), /secret/i);
  for (const pathname of ["secrets.json", "credentials.yml", "private-keys.txt"]) assert.match(defaultExclusionReason(pathname), /secret/i);
  const targets = await capturePathTargets({ projectRoot: root, requestedPaths: ["."] });
  assert.equal(targets.length, 7);
  assert.equal(targets.find((target) => target.path === "src/visible.ts")?.disposition, "reviewable");
  assert.equal(targets.find((target) => target.path === ".env")?.disposition, "excluded");
  assert.equal(targets.find((target) => target.path === ".git")?.disposition, "excluded");
  assert.equal(targets.find((target) => target.path === "ignored.txt")?.disposition, "excluded");
  assert.equal(targets.find((target) => target.path === "tracked.txt")?.disposition, "reviewable", "tracked paths must not be hidden by a later ignore rule");
  assert.equal(targets.find((target) => target.path === "node_modules")?.disposition, "excluded");
  const custom = await capturePathTargets({
    projectRoot: root,
    requestedPaths: ["src"],
    exclude: (relativePath) => relativePath === "src/visible.ts" ? "Session-selected exclusion." : undefined,
  });
  assert.equal(custom[0].disposition, "excluded", "W2 can supply session-specific exclusions without changing frozen bytes");
  await assert.rejects(() => capturePathTargets({ projectRoot: root, requestedPaths: ["."], limits: { maxDirectoryEntries: 1 } }), /directory-entry limit/);
  await assert.rejects(() => capturePathTargets({ projectRoot: root, requestedPaths: ["src"], limits: { maxTargets: 0 } }), /positive integer/);
});

test("aggregate snapshot limits block later content before it can be persisted", async (t) => {
  const root = await tempProject();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "first.txt"), "1234");
  await writeFile(path.join(root, "second.txt"), "5678");
  const targets = await capturePathTargets({
    projectRoot: root,
    requestedPaths: ["first.txt", "second.txt"],
    limits: { maxTargetBytes: 4, maxTotalBytes: 5 },
  });
  assert.equal(targets.find((target) => target.path === "first.txt")?.disposition, "reviewable");
  assert.equal(targets.find((target) => target.path === "second.txt")?.disposition, "blocked");
  assert.equal(targets.find((target) => target.path === "second.txt")?.contentBase64, undefined);
});
