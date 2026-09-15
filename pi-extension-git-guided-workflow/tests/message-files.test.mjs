import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuidedGitError, parsePorcelainStatus } from "../src/core.ts";
import {
  DEFAULT_COMMIT_SUBJECT_MAX_CHARACTERS,
  deriveSingleFileCommitDefault,
  readCommitMessageFilePreview,
} from "../src/message-files.ts";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

async function temp(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `guided-git-messages-${label}-`));
  roots.push(root);
  return root;
}

function status(record) {
  return parsePorcelainStatus(Buffer.from(`${record}\0`, "utf8"));
}

test("commit message preview reads paired bounded artifacts and marks freshness unverified", async () => {
  const root = await temp("preview");
  const directory = path.join(root, "dev", "COMMIT");
  await mkdir(directory, { recursive: true });
  const short = "feat(core): add guided preview";
  const long = `${short}\n\n- feat: preview both generated variants`;
  await writeFile(path.join(directory, "staged-commit-short.txt"), `${short}\n`);
  await writeFile(path.join(directory, "staged-commit-long.txt"), `${long}\n`);
  const preview = await readCommitMessageFilePreview(root);
  assert.equal(preview.short.message, short);
  assert.equal(preview.long.message, long);
  assert.equal(preview.short.freshness, "unverified");
  assert.equal(preview.long.freshness, "unverified");
  assert.match(preview.short.sha256, /^[0-9a-f]{64}$/u);
  assert.equal(preview.short.absolutePath, path.join(directory, "staged-commit-short.txt"));
});

test("commit message preview returns null for no artifacts and refuses incomplete or symlinked files", async () => {
  const root = await temp("unsafe-preview");
  assert.equal(await readCommitMessageFilePreview(root), null);
  const directory = path.join(root, "dev", "COMMIT");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "staged-commit-short.txt"), "fix: incomplete\n");
  await assert.rejects(readCommitMessageFilePreview(root), (error) => error instanceof GuidedGitError && error.code === "INCOMPLETE_COMMIT_ARTIFACTS");
  await rm(path.join(directory, "staged-commit-short.txt"));
  const outside = path.join(root, "outside.txt");
  await writeFile(outside, "fix: linked\n");
  await symlink(outside, path.join(directory, "staged-commit-short.txt"));
  await writeFile(path.join(directory, "staged-commit-long.txt"), "fix: linked\n");
  await assert.rejects(readCommitMessageFilePreview(root), (error) => error instanceof GuidedGitError && error.code === "UNSAFE_ARTIFACT_PATH");
});

test("single-file defaults preserve the exact path for clean adds, modifications, and deletions", () => {
  assert.deepEqual(deriveSingleFileCommitDefault(status("A  src/new-file.ts")), {
    operation: "created", path: "src/new-file.ts", message: "created src/new-file.ts",
  });
  assert.deepEqual(deriveSingleFileCommitDefault(status("M  src/existing.ts")), {
    operation: "updated", path: "src/existing.ts", message: "updated src/existing.ts",
  });
  assert.deepEqual(deriveSingleFileCommitDefault(status("D  obsolete.txt")), {
    operation: "deleted", path: "obsolete.txt", message: "deleted obsolete.txt",
  });
});

test("single-file defaults decline ambiguous, renamed, conflicted, unstaged, and untracked states", () => {
  for (const parsed of [
    parsePorcelainStatus("A  one.txt\0M  two.txt\0"),
    parsePorcelainStatus("R  renamed.txt\0original.txt\0"),
    parsePorcelainStatus("UU conflict.txt\0"),
    parsePorcelainStatus("MM both.txt\0"),
    parsePorcelainStatus("M  staged.txt\0?? untracked.txt\0"),
  ]) assert.equal(deriveSingleFileCommitDefault(parsed), null);
});

test("single-file defaults refuse unsafe, invalid UTF-8, and overlong exact paths without truncation", () => {
  const unsafe = status("A  line\nbreak.txt");
  assert.throws(() => deriveSingleFileCommitDefault(unsafe), (error) => error.code === "UNSAFE_DEFAULT_MESSAGE_PATH");
  const invalidUtf8 = parsePorcelainStatus(Buffer.concat([Buffer.from("A  "), Buffer.from([0xff]), Buffer.from([0])]));
  assert.throws(() => deriveSingleFileCommitDefault(invalidUtf8), (error) => error.code === "UNSAFE_DEFAULT_MESSAGE_PATH");
  const longPath = `${"a".repeat(DEFAULT_COMMIT_SUBJECT_MAX_CHARACTERS)}.txt`;
  assert.throws(() => deriveSingleFileCommitDefault(status(`A  ${longPath}`)), (error) => error.code === "DEFAULT_MESSAGE_PATH_TOO_LONG");
});
