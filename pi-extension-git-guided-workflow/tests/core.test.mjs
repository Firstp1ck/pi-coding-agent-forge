import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  COMMIT_MESSAGE_MAX_BYTES,
  GENERATION_INPUT_MAX_BYTES,
  GuidedGitError,
  STAGED_FINGERPRINT_DOMAIN,
  acquireStableStagedSnapshot,
  captureBoundStagedState,
  classifyPostCommitHead,
  discoverPushDestination,
  parseGeneratedOutput,
  parsePorcelainStatus,
  planCommit,
  planPush,
  planStageAll,
  planStagePaths,
  preflightRepository,
  prepareCommitPlan,
  readRemotes,
  readStagedFingerprint,
  runGit,
  sanitizeDiagnostic,
  validateManualCommitMessage,
} from "../src/core.ts";

const tempRoots = [];
test.after(async () => Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true }))));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
}

function gitInput(cwd, input, ...args) {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function tempDir(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `guided-git-${label}-`));
  tempRoots.push(root);
  return root;
}

async function repository(label = "repo") {
  const root = await tempDir(label);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Guided Git Test");
  git(root, "config", "user.email", "guided-git@example.invalid");
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", "--", "tracked.txt");
  git(root, "commit", "-m", "test: initial");
  return root;
}

async function assertCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof GuidedGitError && error.code === code);
}

test("preflight resolves a nested root and parses staged, unstaged, untracked, and byte-safe paths", async () => {
  const root = await repository("preflight");
  const nested = path.join(root, "nested", "deep");
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(root, "tracked.txt"), "staged\n");
  git(root, "add", "--", "tracked.txt");
  await writeFile(path.join(root, "tracked.txt"), "unstaged after index\n");
  await writeFile(path.join(root, "new file.txt"), "new\n");
  const oddName = "odd\x01name\ncontinued.txt";
  await writeFile(path.join(root, oddName), "odd\n");
  const state = await preflightRepository(nested);
  assert.equal(state.root, root);
  assert.equal(state.branch, "main");
  assert.match(state.headOid, /^[0-9a-f]{40}$/);
  assert.equal(state.status.staged, 1);
  assert.equal(state.status.unstaged, 1);
  assert.equal(state.status.untracked, 2);
  assert.ok(state.status.entries.some((entry) => entry.path.equals(Buffer.from(oddName))));
  assert.ok(state.status.entries.some((entry) => entry.displayPath.includes("odd name continued.txt")));

  const renameRaw = Buffer.concat([Buffer.from("R  renamed\0original\0", "utf8")]);
  const parsedRename = parsePorcelainStatus(renameRaw);
  assert.equal(parsedRename.entries[0].displayPath, "renamed");
  assert.equal(parsedRename.entries[0].originalPath.toString(), "original");
});

test("preflight rejects non-repositories, bare and detached repositories", async () => {
  const outside = await tempDir("outside");
  await assertCode(preflightRepository(outside), "NOT_REPOSITORY");
  const bare = await tempDir("bare.git");
  git(bare, "init", "--bare");
  await assertCode(preflightRepository(bare), "BARE_REPOSITORY");
  const root = await repository("detached");
  git(root, "checkout", "--detach", "HEAD");
  await assertCode(preflightRepository(root), "DETACHED_HEAD");
});

test("preflight rejects every in-progress operation marker and unresolved conflicts", async () => {
  const root = await repository("operations");
  const gitDir = path.join(root, ".git");
  const markers = [
    ["MERGE_HEAD", false], ["rebase-merge", true], ["rebase-apply", true],
    ["CHERRY_PICK_HEAD", false], ["REVERT_HEAD", false], ["BISECT_START", false],
  ];
  for (const [marker, directory] of markers) {
    const target = path.join(gitDir, marker);
    if (directory) await mkdir(target);
    else await writeFile(target, "marker\n");
    await assertCode(preflightRepository(root), "OPERATION_IN_PROGRESS");
    await rm(target, { recursive: true, force: true });
  }

  const base = git(root, "hash-object", "tracked.txt");
  const oursPath = path.join(root, "ours.tmp");
  const theirsPath = path.join(root, "theirs.tmp");
  await writeFile(oursPath, "ours\n");
  await writeFile(theirsPath, "theirs\n");
  const ours = git(root, "hash-object", "-w", "ours.tmp");
  const theirs = git(root, "hash-object", "-w", "theirs.tmp");
  git(root, "rm", "--cached", "--", "tracked.txt");
  gitInput(root, `100644 ${base} 1\ttracked.txt\n100644 ${ours} 2\ttracked.txt\n100644 ${theirs} 3\ttracked.txt\n`, "update-index", "--index-info");
  await assertCode(preflightRepository(root), "UNRESOLVED_CONFLICTS");
});

test("Stage all uses argv only and stages tracked changes, deletion, and untracked files", async () => {
  const root = await repository("stage-all");
  await writeFile(path.join(root, "tracked.txt"), "changed\n");
  await writeFile(path.join(root, "delete.txt"), "delete\n");
  git(root, "add", "--", "delete.txt");
  git(root, "commit", "-m", "test: add deletion fixture");
  await unlink(path.join(root, "delete.txt"));
  await writeFile(path.join(root, "untracked.txt"), "new\n");
  const plan = planStageAll();
  assert.deepEqual(plan, { command: "git", args: ["add", "--all", "--"] });
  assert.equal(spawnSync(plan.command, plan.args, { cwd: root }).status, 0);
  const status = (await preflightRepository(root)).status;
  assert.equal(status.staged, 3);
  assert.equal(status.unstaged, 0);
  assert.equal(status.untracked, 0);
});

test("explicit path staging and remote reads retain bounded argv contracts", async () => {
  const root = await repository("explicit-stage-paths");
  await writeFile(path.join(root, "one.txt"), "one\n");
  await writeFile(path.join(root, "two.txt"), "two\n");
  const plan = planStagePaths(["one.txt"]);
  assert.deepEqual(plan, { command: "git", args: ["add", "--", "one.txt"] });
  assert.equal(spawnSync(plan.command, plan.args, { cwd: root }).status, 0);
  const state = await preflightRepository(root);
  assert.equal(state.status.entries.find((entry) => entry.displayPath === "one.txt").staged, true);
  assert.equal(state.status.entries.find((entry) => entry.displayPath === "two.txt").untracked, true);
  for (const invalid of [[], ["-option"], ["../escape"], ["one.txt", "one.txt"], ["nested//file"]]) {
    assert.throws(() => planStagePaths(invalid), GuidedGitError);
  }
  assert.deepEqual(await readRemotes(root), []);
  git(root, "remote", "add", "origin", path.join(root, "unused.git"));
  assert.deepEqual(await readRemotes(root), ["origin"]);
});

test("package-domain fingerprint detects staged path, mode, blob, and content changes, including unborn repositories", async () => {
  assert.equal(STAGED_FINGERPRINT_DOMAIN, "firstpick/git-guided-workflow/staged-content/v1\0");
  const root = await repository("fingerprint");
  await writeFile(path.join(root, "name with spaces.txt"), "one\n");
  const oddName = "odd\x02bytes.txt";
  await writeFile(path.join(root, oddName), "odd\n");
  git(root, "add", "--", "name with spaces.txt", oddName);
  const first = await readStagedFingerprint(root);
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/);

  await writeFile(path.join(root, "name with spaces.txt"), "two\n");
  git(root, "add", "--", "name with spaces.txt");
  const content = await readStagedFingerprint(root);
  assert.notEqual(content.fingerprint, first.fingerprint);

  git(root, "mv", "name with spaces.txt", "renamed.txt");
  const renamed = await readStagedFingerprint(root);
  assert.notEqual(renamed.fingerprint, content.fingerprint);

  await chmod(path.join(root, "renamed.txt"), 0o755);
  git(root, "add", "--", "renamed.txt");
  const mode = await readStagedFingerprint(root);
  assert.notEqual(mode.fingerprint, renamed.fingerprint);

  const unborn = await tempDir("unborn");
  git(unborn, "init", "-b", "main");
  await writeFile(path.join(unborn, "first.txt"), "first\n");
  git(unborn, "add", "--", "first.txt");
  assert.match((await readStagedFingerprint(unborn)).fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await preflightRepository(unborn)).headOid, null);
});

test("bound staged state encloses fresh status with matching fingerprints", async () => {
  const root = await repository("bound-staged-state");
  await writeFile(path.join(root, "a.txt"), "base a\n");
  await writeFile(path.join(root, "b.txt"), "base b\n");
  git(root, "add", "--", "a.txt", "b.txt");
  git(root, "commit", "-m", "test: add bound-state fixtures");
  await writeFile(path.join(root, "a.txt"), "changed a\n");
  git(root, "add", "--", "a.txt");

  const captured = await captureBoundStagedState(root);
  assert.equal(captured.state.status.entries.find((entry) => entry.displayPath === "a.txt").staged, true);
  assert.equal(captured.fingerprint, (await readStagedFingerprint(root)).fingerprint);

  let statusReads = 0;
  const racingRunner = async (cwd, args, options) => {
    if (args[0] === "status" && ++statusReads === 2) {
      git(root, "restore", "--staged", "--worktree", "--", "a.txt");
      await writeFile(path.join(root, "b.txt"), "changed b\n");
      git(root, "add", "--", "b.txt");
    }
    return await runGit(cwd, args, options);
  };
  await assertCode(captureBoundStagedState(root, racingRunner), "STAGED_STATE_CHANGED");
});

test("stable snapshots bind before/diff/after, refuse races, and refuse rather than truncate above the cap", async () => {
  assert.equal(GENERATION_INPUT_MAX_BYTES, 1024 * 1024);
  const root = await repository("snapshot");
  await writeFile(path.join(root, "tracked.txt"), "snapshot\n");
  git(root, "add", "--", "tracked.txt");
  const stable = await acquireStableStagedSnapshot(root);
  assert.equal(stable.byteLength, stable.diff.length);
  assert.match(stable.generationInput, /snapshot/);

  let changed = false;
  const racingRunner = async (cwd, args, options) => {
    const result = await runGit(cwd, args, options);
    if (!changed && args.includes("--binary")) {
      changed = true;
      await writeFile(path.join(root, "tracked.txt"), "raced\n");
      git(root, "add", "--", "tracked.txt");
    }
    return result;
  };
  await assertCode(acquireStableStagedSnapshot(root, { runner: racingRunner }), "STAGED_STATE_CHANGED");
  await assertCode(acquireStableStagedSnapshot(root, { maxBytes: 32 }), "GENERATION_INPUT_TOO_LARGE");
});

test("runGit settles output-limit errors only after close and bounds unconfirmed termination", async () => {
  const root = await repository("run-git-settlement");
  let closedError;
  await assert.rejects(
    runGit(root, ["--version"], { maxStdoutBytes: 0 }),
    (error) => {
      closedError = error;
      return error instanceof GuidedGitError && error.code === "GIT_OUTPUT_TOO_LARGE";
    },
  );
  assert.equal(closedError.details.terminationConfirmed, true);
  assert.ok("closeExitCode" in closedError.details, "the rejection must be emitted from the close barrier");
  assert.throws(() => process.kill(closedError.details.processId, 0), { code: "ESRCH" }, "runGit must not settle before the direct child exits");

  await assert.rejects(
    runGit(root, ["-c", "alias.hold=!sleep 0.3", "hold"], {
      timeoutMs: 50,
      terminationTimeoutMs: 20,
    }),
    (error) => error instanceof GuidedGitError
      && error.code === "GIT_TERMINATION_UNCONFIRMED"
      && error.details.terminationConfirmed === false
      && error.details.causeCode === "GIT_TIMEOUT",
  );
  await new Promise((resolve) => setTimeout(resolve, 350));
});

test("terminal diagnostics are safe and generated output parsing keeps quality rules advisory", () => {
  assert.equal(sanitizeDiagnostic("bad\x1b[31mred\x1b[0m\x00\tname\u202e"), "badred  name ");
  const short = "feat(core): add guided commit planning";
  const long = `${short}\n\nBind each commit to the staged snapshot.`;
  assert.deepEqual(parseGeneratedOutput(`<<<SHORT>>>\n${short}\n<<<LONG>>>\n${long}\n<<<END>>>`), { short, long });
  assert.deepEqual(parseGeneratedOutput(long), { short, long });
  assert.deepEqual(parseGeneratedOutput(`\n\`\`\`text\n${long}\n\`\`\`\n`), { short, long });
  assert.deepEqual(parseGeneratedOutput(`<<<SHORT>>>\nfix: handle failure\n<<<LONG>>>\nfix: handle failure\n<<<END>>>`), { short: "fix: handle failure", long: "fix: handle failure" });
  for (const [advisoryShort, advisoryLong] of [
    ["unknown: type", "different body subject"],
    [`feat: ${"x".repeat(70)}`, "body without a typed bullet"],
    ["feat: missing requested scope", "fix: mismatched subject"],
  ]) {
    assert.deepEqual(parseGeneratedOutput(`<<<SHORT>>>\n${advisoryShort}\n<<<LONG>>>\n${advisoryLong}\n<<<END>>>`), { short: advisoryShort, long: advisoryLong });
  }

  const invalid = [
    "   \n",
    "<<<SHORT>>>\nfeat: nul\x00\n<<<LONG>>>\nfeat: nul\n<<<END>>>",
    "<<<SHORT>>>\nfeat: ansi\x1b[31m\n<<<LONG>>>\nfeat: ansi\n<<<END>>>",
    "<<<SHORT>>>\nfeat: tab\tbad\n<<<LONG>>>\nfeat: tab bad\n<<<END>>>",
    "<<<SHORT>>>\nfeat: bidi\u202ebad\n<<<LONG>>>\nfeat: bidi bad\n<<<END>>>",
    "<<<SHORT>>>\nfeat: isolate\u2066bad\n<<<LONG>>>\nfeat: isolate bad\n<<<END>>>",
  ];
  for (const value of invalid) assert.throws(() => parseGeneratedOutput(value), GuidedGitError);
});

test("manual validation rejects only empty, unsafe, and oversized messages while preserving exact argv", () => {
  const message = "A clear manual subject\n\nDetailed body.";
  assert.equal(validateManualCommitMessage(message), message);
  assert.deepEqual(planCommit(message), { command: "git", args: ["commit", "-m", message] });
  for (const advisory of [" padded", "subject\nbody", "x".repeat(73)]) assert.equal(validateManualCommitMessage(advisory), advisory);
  for (const invalid of ["", "   ", `subject\n\n${"x".repeat(COMMIT_MESSAGE_MAX_BYTES)}`, "subject\x00", "subject\x1b[2J", "subject\u202e", "subject\u2069"]) {
    assert.throws(() => validateManualCommitMessage(invalid), GuidedGitError);
  }
});

test("commit preparation rejects staged drift without producing or executing a commit plan", async () => {
  const root = await repository("commit-binding");
  await writeFile(path.join(root, "tracked.txt"), "candidate\n");
  git(root, "add", "--", "tracked.txt");
  const state = await preflightRepository(root);
  const snapshot = await acquireStableStagedSnapshot(root);
  const binding = { root, branch: state.branch, headOid: state.headOid, fingerprint: snapshot.fingerprint };
  const valid = await prepareCommitPlan(root, binding, "feat: candidate");
  assert.deepEqual(valid.args, ["commit", "-m", "feat: candidate"]);
  await writeFile(path.join(root, "tracked.txt"), "drift\n");
  git(root, "add", "--", "tracked.txt");
  const before = git(root, "rev-parse", "HEAD");
  await assertCode(prepareCommitPlan(root, binding, "feat: stale"), "STAGED_STATE_CHANGED");
  assert.equal(git(root, "rev-parse", "HEAD"), before);
});

test("post-commit classification checks HEAD after success, failure, and timeout", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  assert.deepEqual(classifyPostCommitHead(a, b, "success"), { classification: "head-advanced", commitOid: b, retrySafe: false });
  assert.deepEqual(classifyPostCommitHead(a, b, "failure"), { classification: "head-advanced", commitOid: b, retrySafe: false });
  assert.deepEqual(classifyPostCommitHead(a, b, "timeout"), { classification: "head-advanced", commitOid: b, retrySafe: false });
  assert.deepEqual(classifyPostCommitHead(a, a, "failure"), { classification: "not-created", commitOid: null, retrySafe: true });
  assert.deepEqual(classifyPostCommitHead(null, null, "timeout"), { classification: "not-created", commitOid: null, retrySafe: true });
  assert.deepEqual(classifyPostCommitHead(a, a, "success"), { classification: "unexpected-result", commitOid: null, retrySafe: false });
});

test("push discovery handles sole, matching-upstream, and selected remotes, blocks unsafe states, and pushes only locally", async () => {
  const root = await repository("push");
  const bare = await tempDir("remote.git");
  git(bare, "init", "--bare");
  git(root, "remote", "add", "origin", bare);
  const createdHead = git(root, "rev-parse", "HEAD");
  const sole = await discoverPushDestination(root, { branch: "main", createdCommitOid: createdHead, currentHeadOid: createdHead });
  assert.deepEqual(sole, { remote: "origin", branch: "main", refspec: `${createdHead}:refs/heads/main`, source: "sole-remote" });
  const solePlan = planPush(sole, createdHead, createdHead);
  assert.deepEqual(solePlan.args, ["push", "--", "origin", `${createdHead}:refs/heads/main`]);
  assert.equal(solePlan.args.some((arg) => arg.includes("force")), false);

  await writeFile(path.join(root, "tracked.txt"), "branch advanced after push planning\n");
  git(root, "add", "--", "tracked.txt");
  git(root, "commit", "-m", "test: advance branch after push planning");
  const head = git(root, "rev-parse", "HEAD");
  assert.notEqual(head, createdHead);
  assert.equal(spawnSync(solePlan.command, solePlan.args, { cwd: root, encoding: "utf8" }).status, 0);
  assert.equal(git(bare, "rev-parse", "refs/heads/main"), createdHead, "executed refspec must push the immutable planned OID, not the advanced branch");

  git(root, "config", "branch.main.remote", "origin");
  git(root, "config", "branch.main.merge", "refs/heads/main");
  assert.equal((await discoverPushDestination(root, { branch: "main", createdCommitOid: head, currentHeadOid: head })).source, "upstream");

  git(root, "config", "--unset", "branch.main.remote");
  git(root, "config", "--unset", "branch.main.merge");
  const secondBare = await tempDir("backup.git");
  git(secondBare, "init", "--bare");
  git(root, "remote", "add", "backup", secondBare);
  await assertCode(discoverPushDestination(root, { branch: "main", createdCommitOid: head, currentHeadOid: head }), "REMOTE_SELECTION_REQUIRED");
  const selected = await discoverPushDestination(root, { branch: "main", createdCommitOid: head, currentHeadOid: head, selectedRemote: "backup" });
  assert.equal(selected.source, "selected-remote");
  assert.equal(selected.remote, "backup");

  await assertCode(discoverPushDestination(root, { branch: "main", createdCommitOid: head, currentHeadOid: "f".repeat(40), selectedRemote: "origin" }), "STALE_PUSH_HEAD");
  git(root, "config", "branch.main.remote", "origin");
  git(root, "config", "branch.main.merge", "refs/heads/other");
  await assertCode(discoverPushDestination(root, { branch: "main", createdCommitOid: head, currentHeadOid: head, selectedRemote: "backup" }), "MISMATCHED_UPSTREAM");
  assert.throws(() => planPush(selected, head, "f".repeat(40)), (error) => error.code === "STALE_PUSH_HEAD");

  const missing = await repository("push-missing");
  const missingHead = git(missing, "rev-parse", "HEAD");
  await assertCode(discoverPushDestination(missing, { branch: "main", createdCommitOid: missingHead, currentHeadOid: missingHead }), "NO_PUSH_REMOTE");
  git(root, "checkout", "--detach", "HEAD");
  await assertCode(discoverPushDestination(root, { branch: "main", createdCommitOid: head, currentHeadOid: head }), "DETACHED_HEAD");
});
