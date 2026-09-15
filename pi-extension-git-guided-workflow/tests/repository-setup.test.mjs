import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GuidedGitError, preflightRepository, runGit } from "../src/core.ts";
import {
  executeRepositoryInitialization,
  executeRepositoryPublication,
  executeStarterFileStaging,
  executeStarterFiles,
  planRepositoryInitialization,
  planRepositoryPublication,
  planStarterFiles,
} from "../src/repository-setup.ts";

const roots = [];
test.after(async () => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } }).trim();
}

async function temp(label) {
  const root = await mkdtemp(path.join(os.tmpdir(), `guided-git-repository-${label}-`));
  roots.push(root);
  return root;
}

async function repo(label = "repo") {
  const root = await temp(label);
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Repository Setup Test");
  git(root, "config", "user.email", "repository-setup@example.invalid");
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", "--", "tracked.txt");
  git(root, "commit", "-m", "test: initial");
  return root;
}

function result(exitCode = 0, stdout = "", stderr = "") {
  return { exitCode, stdout: Buffer.from(stdout), stderr: Buffer.from(stderr), timedOut: false };
}

async function assertCode(value, code) {
  await assert.rejects(value, (error) => error instanceof GuidedGitError && error.code === code);
}

function fakeGh(createResult = result(0, "created\n")) {
  const calls = [];
  return {
    calls,
    runner: async (cwd, args) => {
      calls.push({ cwd, args: [...args] });
      if (args[0] === "--version") return result(0, "gh version fake\n");
      if (args[0] === "auth") return result(0, "authenticated fake\n");
      if (args[0] === "api") return result(0, "fixture-owner\n");
      if (args[0] === "repo") return createResult;
      throw new Error(`unexpected fake gh invocation: ${args.join(" ")}`);
    },
  };
}

test("repository initialization binds a non-repository directory and verifies unborn main", async () => {
  const root = await temp("init");
  const plan = await planRepositoryInitialization(root);
  assert.equal(plan.root, root);
  assert.deepEqual(plan.command, { command: "git", args: ["init", "--initial-branch=main", "--"] });
  const state = await executeRepositoryInitialization(plan);
  assert.equal(state.root, root);
  assert.equal(state.branch, "main");
  assert.equal(state.headOid, null);
  assert.equal(state.status.entries.length, 0);
  await assertCode(planRepositoryInitialization(root), "ALREADY_REPOSITORY");

  const nested = path.join(root, "nested");
  await mkdir(nested);
  await assertCode(planRepositoryInitialization(nested), "ALREADY_REPOSITORY");
});

test("deferred preflight cancellation prevents initialization, starter creation, staging, and publication mutations", async (t) => {
  const guard = (state) => () => {
    if (!state.current) throw new GuidedGitError("WORKFLOW_CANCELLED", "workflow ended during preflight");
  };
  const deferred = () => {
    let entered;
    let release;
    return {
      entered: new Promise((resolve) => { entered = resolve; }),
      release: new Promise((resolve) => { release = resolve; }),
      markEntered: entered,
      releaseNow: release,
    };
  };

  await t.test("repository initialization", async () => {
    const root = await temp("cancel-init-preflight");
    const plan = await planRepositoryInitialization(root);
    const gate = deferred();
    const state = { current: true };
    let delayed = false;
    const runner = async (cwd, args, options) => {
      if (!delayed && args[0] === "rev-parse" && args[1] === "--show-toplevel") {
        delayed = true;
        gate.markEntered();
        await gate.release;
      }
      return await runGit(cwd, args, options);
    };
    const executing = executeRepositoryInitialization(plan, runner, { assertCurrent: guard(state) });
    await gate.entered;
    state.current = false;
    gate.releaseNow();
    await assertCode(executing, "WORKFLOW_CANCELLED");
    await assert.rejects(readFile(path.join(root, ".git", "HEAD")), (error) => error.code === "ENOENT");
  });

  await t.test("starter creation", async () => {
    const root = await repo("cancel-starter-preflight");
    const plan = await planStarterFiles(root);
    const gate = deferred();
    const state = { current: true };
    let delayed = false;
    const runner = async (cwd, args, options) => {
      if (!delayed) {
        delayed = true;
        gate.markEntered();
        await gate.release;
      }
      return await runGit(cwd, args, options);
    };
    const executing = executeStarterFiles(plan, ["README.md"], runner, { assertCurrent: guard(state) });
    await gate.entered;
    state.current = false;
    gate.releaseNow();
    await assertCode(executing, "WORKFLOW_CANCELLED");
    await assert.rejects(readFile(path.join(root, "README.md")), (error) => error.code === "ENOENT");
  });

  await t.test("starter staging", async () => {
    const root = await repo("cancel-staging-preflight");
    const plan = await planStarterFiles(root);
    const written = await executeStarterFiles(plan, ["README.md"]);
    const gate = deferred();
    const state = { current: true };
    let delayed = false;
    const runner = async (cwd, args, options) => {
      if (!delayed) {
        delayed = true;
        gate.markEntered();
        await gate.release;
      }
      return await runGit(cwd, args, options);
    };
    const executing = executeStarterFileStaging(written, ["README.md"], runner, { assertCurrent: guard(state) });
    await gate.entered;
    state.current = false;
    gate.releaseNow();
    await assertCode(executing, "WORKFLOW_CANCELLED");
    assert.match(git(root, "status", "--porcelain"), /^\?\? README\.md$/mu);
  });

  await t.test("publication", async () => {
    const root = await repo("cancel-publication-preflight");
    const gh = fakeGh();
    const gate = deferred();
    const state = { current: true };
    let authCalls = 0;
    const ghRunner = async (cwd, args) => {
      if (args[0] === "auth" && ++authCalls === 2) {
        gate.markEntered();
        await gate.release;
      }
      return await gh.runner(cwd, args);
    };
    const plan = await planRepositoryPublication(root, "private", { ghRunner });
    const executing = executeRepositoryPublication(plan, { ghRunner, assertCurrent: guard(state) });
    await gate.entered;
    state.current = false;
    gate.releaseNow();
    await assertCode(executing, "WORKFLOW_CANCELLED");
    assert.equal(gh.calls.filter((call) => call.args[0] === "repo").length, 0);
    assert.deepEqual(git(root, "remote").split(/\s+/u).filter(Boolean), []);
  });
});

test("starter planning preserves existing files, blocks symlinks, and creates only selected absent paths", async () => {
  const root = await repo("starters");
  await writeFile(path.join(root, "README.md"), "existing readme\n");
  const outside = path.join(root, "outside-ignore");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(root, ".gitignore"));
  const blocked = await planStarterFiles(root);
  assert.equal(blocked.entries.find((entry) => entry.relativePath === "README.md").status, "preserve");
  assert.equal(blocked.entries.find((entry) => entry.relativePath === ".gitignore").status, "blocked");
  await assertCode(executeStarterFiles(blocked, ["README.md"]), "INVALID_STARTER_SELECTION");
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "existing readme\n");
  assert.equal(await readFile(outside, "utf8"), "outside\n");

  await rm(path.join(root, "README.md"));
  await rm(path.join(root, ".gitignore"));
  const create = await planStarterFiles(root);
  const written = await executeStarterFiles(create, ["README.md", ".gitignore"]);
  assert.deepEqual(written.created, ["README.md", ".gitignore"]);
  assert.match(await readFile(path.join(root, "README.md"), "utf8"), /^# guided-git-repository-starters-/u);
  assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), "# Operating system metadata\n.DS_Store\nThumbs.db\n");
});

test("starter staging accepts only paths created by that execution and leaves unrelated files untracked", async () => {
  const root = await repo("starter-stage");
  const plan = await planStarterFiles(root);
  const written = await executeStarterFiles(plan, ["README.md", ".gitignore"]);
  await writeFile(path.join(root, "unrelated.txt"), "unrelated\n");
  const command = await executeStarterFileStaging(written, ["README.md"]);
  assert.deepEqual(command.args, ["add", "--", "README.md"]);
  const state = await preflightRepository(root);
  assert.equal(state.status.entries.find((entry) => entry.displayPath === "README.md").staged, true);
  assert.equal(state.status.entries.find((entry) => entry.displayPath === ".gitignore").untracked, true);
  assert.equal(state.status.entries.find((entry) => entry.displayPath === "unrelated.txt").untracked, true);
  await assertCode(executeStarterFileStaging(written, ["tracked.txt"]), "INVALID_STARTER_SELECTION");

  await writeFile(path.join(root, ".gitignore"), "changed after creation\n");
  await assertCode(executeStarterFileStaging(written, [".gitignore"]), "STARTER_PATH_CHANGED");
  assert.equal((await preflightRepository(root)).status.entries.find((entry) => entry.displayPath === ".gitignore").untracked, true);
});

test("starter creation rolls back a still-owned partial file when writing fails", async () => {
  const root = await repo("starter-partial-write");
  const plan = await planStarterFiles(root);
  await assert.rejects(executeStarterFiles(plan, ["README.md"], undefined, {
    async openFile(file, flags, mode) {
      const handle = await open(file, flags, mode);
      return {
        stat: (...args) => handle.stat(...args),
        async writeFile() {
          await handle.write(Buffer.from("# "));
          throw new Error("injected write failure");
        },
        sync: (...args) => handle.sync(...args),
        close: (...args) => handle.close(...args),
      };
    },
  }), /injected write failure/u);
  await assert.rejects(readFile(path.join(root, "README.md")), (error) => error.code === "ENOENT");
});

test("starter creation closes and preserves an unprovably owned partial file when post-open stat fails", async () => {
  const root = await repo("starter-stat-failure");
  const plan = await planStarterFiles(root);
  let closed = false;
  await assert.rejects(executeStarterFiles(plan, ["README.md"], undefined, {
    async openFile(file, flags, mode) {
      const handle = await open(file, flags, mode);
      return {
        async stat() { throw new Error("injected stat failure"); },
        writeFile: (...args) => handle.writeFile(...args),
        sync: (...args) => handle.sync(...args),
        async close() { closed = true; await handle.close(); },
      };
    },
  }), (error) => error instanceof GuidedGitError
    && error.code === "STARTER_OWNERSHIP_UNVERIFIED"
    && /preserved for manual inspection/iu.test(error.message));
  assert.equal(closed, true, "the exclusively opened handle must be closed after stat failure");
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "", "unprovably owned bytes must not be unlinked");
});

test("publication plans an exact explicit target and invokes injected gh once after revalidation", async () => {
  const root = await repo("publish");
  const gh = fakeGh();
  const plan = await planRepositoryPublication(root, "private", { ghRunner: gh.runner });
  assert.equal(plan.root, root);
  assert.equal(plan.branch, "main");
  assert.match(plan.headOid, /^[0-9a-f]{40}$/u);
  assert.equal(plan.host, "github.com");
  assert.equal(plan.account, "fixture-owner");
  assert.equal(plan.repositoryName, path.basename(root));
  assert.equal(plan.qualifiedRepository, `github.com/fixture-owner/${path.basename(root)}`);
  assert.deepEqual(plan.args, ["repo", "create", plan.qualifiedRepository, "--private", "--source", root, "--remote", "origin", "--push"]);
  const outcome = await executeRepositoryPublication(plan, { ghRunner: gh.runner });
  assert.equal(outcome.status, "published");
  const createCalls = gh.calls.filter((call) => call.args[0] === "repo");
  assert.equal(createCalls.length, 1);
  assert.deepEqual(createCalls[0].args, plan.args);
});

test("publication refuses missing visibility, existing remotes, invalid names, and HEAD drift before gh creation", async () => {
  const root = await repo("publication-guards");
  const gh = fakeGh();
  await assertCode(planRepositoryPublication(root, "" , { ghRunner: gh.runner }), "PUBLICATION_VISIBILITY_REQUIRED");
  git(root, "remote", "add", "origin", path.join(root, "unused.git"));
  await assertCode(planRepositoryPublication(root, "public", { ghRunner: gh.runner }), "PUBLICATION_REMOTE_EXISTS");
  git(root, "remote", "remove", "origin");

  const invalidParent = await temp("invalid-name-parent");
  const invalid = path.join(invalidParent, "bad name");
  await mkdir(invalid);
  git(invalid, "init", "-b", "main");
  git(invalid, "config", "user.name", "Repository Setup Test");
  git(invalid, "config", "user.email", "repository-setup@example.invalid");
  await writeFile(path.join(invalid, "file.txt"), "content\n");
  git(invalid, "add", "--", "file.txt");
  git(invalid, "commit", "-m", "test: initial");
  await assertCode(planRepositoryPublication(invalid, "private", { ghRunner: gh.runner }), "INVALID_PUBLICATION_NAME");

  const plan = await planRepositoryPublication(root, "public", { ghRunner: gh.runner });
  const tampered = { ...plan, args: ["repo", "delete", plan.repositoryName] };
  const beforeTamperedCalls = gh.calls.filter((call) => call.args[0] === "repo").length;
  await assertCode(executeRepositoryPublication(tampered, { ghRunner: gh.runner }), "INVALID_PUBLICATION_PLAN");
  assert.equal(gh.calls.filter((call) => call.args[0] === "repo").length, beforeTamperedCalls);

  await writeFile(path.join(root, "advance.txt"), "advance\n");
  git(root, "add", "--", "advance.txt");
  git(root, "commit", "-m", "test: advance after confirmation");
  const beforeCreateCalls = gh.calls.filter((call) => call.args[0] === "repo").length;
  await assertCode(executeRepositoryPublication(plan, { ghRunner: gh.runner }), "HEAD_CHANGED");
  assert.equal(gh.calls.filter((call) => call.args[0] === "repo").length, beforeCreateCalls);
});

test("publication reports one injected gh failure as uncertain without retry or cleanup", async () => {
  const root = await repo("uncertain");
  const gh = fakeGh(result(1, "", "fake partial failure\n"));
  const plan = await planRepositoryPublication(root, "public", { ghRunner: gh.runner });
  const outcome = await executeRepositoryPublication(plan, { ghRunner: gh.runner });
  assert.deepEqual(outcome, { status: "uncertain", diagnostic: "fake partial failure\n", invoked: true });
  assert.equal(gh.calls.filter((call) => call.args[0] === "repo").length, 1);
  assert.equal((await preflightRepository(root)).headOid, plan.headOid);
  assert.deepEqual(git(root, "remote").split(/\s+/u).filter(Boolean), []);
});
