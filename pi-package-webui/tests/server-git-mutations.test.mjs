import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import * as mutations from "../lib/server/git-mutations.mjs";
import { readStableGitMessageArtifactPair } from "../lib/git-message-artifacts.mjs";

const gitConfigRoot = await mkdtemp(path.join(tmpdir(), "webui-g2-config-"));
const previousGitEnvironment = {
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};
process.env.GIT_CONFIG_GLOBAL = path.join(gitConfigRoot, "empty.gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
after(async () => {
  for (const [name, value] of Object.entries(previousGitEnvironment)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  await rm(gitConfigRoot, { recursive: true, force: true });
});

const { createGitMutationService, formatGitCommand } = mutations;
const realGit = process.platform === "win32" ? "git" : execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const summary = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, ahead: 0, behind: 0 };
const expectedMethods = `addGitignoreEntry switchGitBranch pullGitChanges fetchGitChanges integrateGitUpstream gitOperationStageFile gitOperationAction gitBisectAction saveGitStash applyGitStash dropGitStash stageGitFile unstageGitFile stageAllGitChanges unstageAllGitChanges discardGitFile deleteGitUntrackedFile undoLastGitCommit amendLastGitCommitMessage updateGitSubmodules createGitTag gitAddAllPayload readGitOperationSnapshot readGitStashes readGitStashPreview readGitUndoState readGitReflog readGitSubmodules readGitTags readGitSigningDiagnostics readGitBranches readGitWorkflowBranchName readGitWorkflowMessages readGitWorkflowDefaultCommitMessage readGitWorkflowPrDescription initialRepositoryFilesStatus prepareInitialRepositoryFiles readStagedContentHash stagedContentHashForTab expectedStagedContentHashFromBody assertExpectedStagedContentHash gitWorkflowMessageCwd commitMessagePaths cleanGitBranchName validateGitBranchName requestedRemoteRef verifyRemoteGitBranchIntent runGitWorkflowCommand requireConfirmed initializeGitRepository initialGitCommit renameGitMainBranch addGitOrigin pushInitialGitMain commitGitWorkflow pushGitWorkflow publishGitRepository createGitWorkflowPr cancelGitWorkflowProcess`.split(" ");

function git(cwd, ...args) {
  return execFileSync(realGit, args, { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
}

function resolveRelative(root, relative) {
  const resolved = path.resolve(root, relative);
  assert.ok(resolved.startsWith(`${root}${path.sep}`), "test paths must stay inside their disposable repository");
  return resolved;
}

// These are transport adapters and explicit G1 boundary stubs. Parsing remains
// injected; this suite neither implements nor loads a second status parser.
function service(root, overrides = {}) {
  const runGitReadCommand = async (cwd, args) => git(cwd, ...args);
  return createGitMutationService({
    runCommand: async (command, args, { cwd }) => {
      assert.equal(command, "git");
      try {
        return { exitCode: 0, stdout: git(cwd, ...args), stderr: "" };
      } catch (error) {
        return { exitCode: error.status, stdout: String(error.stdout || ""), stderr: String(error.stderr || "") };
      }
    },
    makeHttpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    makeUserFacingError: (message) => new Error(message),
    formatBytes: (value) => `${value} bytes`,
    sanitizeError: (error) => error.message,
    formatCliError: (error) => error.message,
    formatCommandSpawnError: (command, error) => `${command}: ${error.code}`,
    getGitRoot: async () => root,
    runGitReadCommand,
    runGitReadCommandDetailed: async (cwd, args) => ({ output: await runGitReadCommand(cwd, args), truncated: false }),
    readGitChanges: async (cwd) => ({ root: cwd, boundary: "G1" }),
    resolveGitRelativePath: resolveRelative,
    normalizeGitRelativePath: (cwd, relative) => path.relative(cwd, resolveRelative(cwd, relative)).split(path.sep).join("/"),
    isLikelyBinaryBuffer: (buffer) => buffer.includes(0),
    parseGitPorcelainZEntries: () => { throw new Error("Supply G1 parser output for this test"); },
    gitBranchFromPorcelainStatus: () => "main",
    summarizeGitPorcelainStatus: () => ({ ...summary }),
    gitUpstreamRef: async () => "",
    ...overrides,
  });
}

async function disposable(t, { initialized = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "webui-g2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (initialized) {
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "G2 Test");
    git(root, "config", "user.email", "g2@example.invalid");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "core.autocrlf", "false");
  }
  return root;
}

async function baseCommit(root) {
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  git(root, "add", "--", "tracked.txt");
  git(root, "commit", "-qm", "base");
}

async function waitForFile(file) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try { return await readFile(file, "utf8"); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error(`Fake command did not reach its bounded checkpoint: ${file}`);
}

async function fakeCommands(t, initial = {}) {
  const root = await disposable(t, { initialized: false });
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const configFile = path.join(root, "config.json");
  const logFile = path.join(root, "commands.jsonl");
  const executable = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.dirname(__dirname);
const config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
fs.appendFileSync(path.join(root, 'commands.jsonl'), JSON.stringify({command, args, cwd:process.cwd(), env:{LC_ALL:process.env.LC_ALL,GIT_TERMINAL_PROMPT:process.env.GIT_TERMINAL_PROMPT,GH_PROMPT_DISABLED:process.env.GH_PROMPT_DISABLED,GIT_OPTIONAL_LOCKS:process.env.GIT_OPTIONAL_LOCKS,GIT_CONFIG_NOSYSTEM:process.env.GIT_CONFIG_NOSYSTEM}})+'\\n');
if (args[0] === 'hold' || (command === 'gh' && config.holdGh) || (args[0] === 'add' && config.holdAdd)) {
  process.on('SIGTERM', () => { fs.writeFileSync(path.join(root,'terminated'),'yes'); if (!config.ignoreTerm) { process.stdout.write('cancel-tail'); process.exit(0); } });
  fs.writeFileSync(path.join(root,'ready'),'yes');
  setTimeout(() => process.exit(90), 5000);
} else if (args[0] === 'drain') {
  spawn(process.execPath,['-e',"setTimeout(()=>{process.stdout.write('late-tail');process.stderr.write('late-error')},500)"],{stdio:['ignore',1,2]});
  fs.writeFileSync(path.join(root,'ready'),'yes');
} else if (args[0] === 'flood') {
  process.stdout.write('x'.repeat(120000)+'stdout-tail');
  process.stderr.write('y'.repeat(120000)+'stderr-tail');
} else if (args.includes('--cached') && args.includes('diff')) {
  process.stdout.write(config.largeHash ? Buffer.alloc(4*1024*1024+1, 120) : Buffer.from(config.hashBytes || '', 'base64'));
  process.exitCode = config.hashExit || 0;
} else if (args[0] === 'branch' && args[1] === '--show-current') {
  process.stdout.write(config.branch === undefined ? 'main\\n' : config.branch);
} else if (args[0] === 'remote' && args.length === 1) {
  process.stdout.write((config.remotes || []).join('\\n'));
} else if (args[0] === 'add' && config.lockFailures) {
  const counter = path.join(root, 'attempts');
  const attempt = fs.existsSync(counter) ? Number(fs.readFileSync(counter,'utf8'))+1 : 1;
  fs.writeFileSync(counter,String(attempt));
  if (attempt <= config.lockFailures) { process.stderr.write('fatal: Unable to create index.lock: File exists'); process.exitCode=128; }
} else if (config.failure && (args[0] === 'push' || command === 'gh' || args[0] === config.failCommand)) {
  process.stderr.write(config.failure); process.exitCode = 1;
} else {
  process.stdout.write('done\\n');
}
`;
  await writeFile(configFile, JSON.stringify(initial));
  for (const name of ["git", "gh"]) {
    const file = path.join(bin, name);
    await writeFile(file, executable);
    await chmod(file, 0o755);
  }
  const previousPath = process.env.PATH;
  process.env.PATH = bin;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });
  return {
    root,
    service: service(root),
    configure: (config) => writeFile(configFile, JSON.stringify(config)),
    log: async () => (await readFile(logFile, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
  };
}

const unixOnly = { skip: process.platform === "win32" ? "POSIX fake executable and signal behavior; Windows requires native executable fixtures" : false, timeout: 15000 };

test("factory exposes the complete G2 contract and the formatter stays pure", () => {
  assert.deepEqual(Object.keys(mutations).sort(), ["createGitMutationService", "formatGitCommand"]);
  assert.deepEqual(Object.keys(service("/unused")).sort(), [...expectedMethods].sort());
  assert.equal(formatGitCommand(["commit", "-m", "two words\nand a quote\""]), 'git commit -m "two words\\nand a quote\\\""');
  assert.equal(service("/unused").cancelGitWorkflowProcess(), false);
});

test("staged hashes retain exact binary diff bytes, unborn/empty behavior and approval checks", async (t) => {
  const root = await disposable(t);
  const api = service(root);
  assert.deepEqual(await api.readStagedContentHash(root), { stagedDiff: Buffer.alloc(0), hasStagedChanges: false, stagedContentHash: null });
  await writeFile(path.join(root, "raw.bin"), Buffer.from([0, 255, 128, 10]));
  git(root, "add", ".");
  const args = ["-c", "core.quotepath=false", "-c", "diff.external=", "diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "--no-renames", "--"];
  const bytes = execFileSync(realGit, args, { cwd: root, timeout: 5000 });
  const expected = createHash("sha256").update("firstpick/aur-review/staged-content/v1\0").update(bytes).digest("hex");
  const captured = await api.readStagedContentHash(root);
  assert.deepEqual(captured.stagedDiff, bytes);
  assert.equal(captured.stagedContentHash, expected);
  assert.equal(await api.assertExpectedStagedContentHash({ cwd: root }, { expectedStagedContentHash: expected }), expected);
  assert.equal(await api.assertExpectedStagedContentHash({ cwd: "/does-not-exist" }), "");
  for (const expectedStagedContentHash of [null, "", 42, "f".repeat(63)]) {
    assert.throws(() => api.expectedStagedContentHashFromBody({ expectedStagedContentHash }), { statusCode: 400 });
  }
  await assert.rejects(api.assertExpectedStagedContentHash({ cwd: root }, { expectedStagedContentHash: "0".repeat(64) }), { statusCode: 409 });
  await api.unstageAllGitChanges(root);
  await assert.rejects(api.assertExpectedStagedContentHash({ cwd: root }, { expectedStagedContentHash: expected }), { statusCode: 409 });
});

test("raw hash subprocess preserves non-UTF8 bytes, limits and independent command admission", unixOnly, async (t) => {
  const raw = Buffer.from([255, 254, 0, 128, 10]);
  const fake = await fakeCommands(t, { hashBytes: raw.toString("base64") });
  const pending = fake.service.runGitWorkflowCommand(["hold"], { cwd: fake.root });
  t.after(() => fake.service.cancelGitWorkflowProcess());
  await waitForFile(path.join(fake.root, "ready"));
  assert.deepEqual((await fake.service.readStagedContentHash(fake.root)).stagedDiff, raw);
  const hashCommand = (await fake.log()).find((entry) => entry.args.includes("--cached"));
  assert.equal(hashCommand.env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(hashCommand.env.GIT_CONFIG_NOSYSTEM, "1");
  await fake.configure({ largeHash: true });
  await assert.rejects(fake.service.readStagedContentHash(fake.root), /4 MiB staged-content safety limit/);
  await fake.configure({ hashExit: 3 });
  await assert.rejects(fake.service.readStagedContentHash(fake.root), /failed with exit code 3/);
  assert.equal(fake.service.cancelGitWorkflowProcess(), true);
  assert.equal((await pending).cancelled, true);
});

test("gitignore mutations preserve bytes, newline style, escaping and canonical-root serialization", async (t) => {
  const root = await disposable(t);
  const original = Buffer.from([35, 255, 13, 10, 120]);
  await writeFile(path.join(root, ".gitignore"), original);
  const api = service(root);
  const added = await api.addGitignoreEntry(root, { path: "folder/a [b]*?.txt", kind: "file" });
  assert.equal(added.entry, "/folder/a\\ \\[b\\]\\*\\?.txt");
  assert.equal(added.added, true);
  assert.deepEqual(await readFile(path.join(root, ".gitignore")), Buffer.concat([original, Buffer.from(`\r\n${added.entry}\r\n`)]));
  assert.equal((await api.addGitignoreEntry(root, { path: added.path, kind: "file" })).added, false);
  let alias = root;
  if (process.platform !== "win32") {
    alias = `${root}-alias`;
    await symlink(root, alias);
    t.after(() => rm(alias, { force: true }));
  }
  const other = service(alias);
  const same = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? api : other).addGitignoreEntry(root, { path: "same", kind: "folder" })));
  assert.equal(same.filter((result) => result.added).length, 1);
  await Promise.all(Array.from({ length: 8 }, (_, i) => api.addGitignoreEntry(root, { path: `unique-${i}`, kind: "file" })));
  const text = await readFile(path.join(root, ".gitignore"), "latin1");
  for (let i = 0; i < 8; i++) assert.ok(text.includes(`/unique-${i}\r\n`));
  for (const invalid of ["../escape", "/absolute", "C:\\absolute", ".", "a\nb", "a/./b"]) {
    await assert.rejects(api.addGitignoreEntry(root, { path: invalid, kind: "file" }), { statusCode: 400 });
  }
  await assert.rejects(api.addGitignoreEntry(root, { path: "valid", kind: "unknown" }), { statusCode: 400 });
  assert.equal((await api.addGitignoreEntry(root, { path: "after-rejection", kind: "file" })).added, true);
});

test("gitignore rejects links and oversized files without changing their content", async (t) => {
  const root = await disposable(t);
  const api = service(root);
  const target = path.join(root, ".gitignore");
  const outside = path.join(root, "outside");
  await writeFile(outside, "preserve\n");
  if (process.platform !== "win32") {
    await symlink(outside, target);
    await assert.rejects(api.addGitignoreEntry(root, { path: "x", kind: "file" }), /symbolic link/);
    await rm(target);
    await link(outside, target);
    await assert.rejects(api.addGitignoreEntry(root, { path: "x", kind: "file" }), /exactly one hard link/);
    assert.equal(await readFile(outside, "utf8"), "preserve\n");
    await rm(target);
  }
  await writeFile(target, Buffer.alloc(5 * 1024 * 1024 + 1, 120));
  const before = await stat(target);
  await assert.rejects(api.addGitignoreEntry(root, { path: "x", kind: "file" }), /safe modification limit/);
  assert.equal((await stat(target)).size, before.size);
});

test("file mutation success and failures retain confirmation and unborn-index behavior", async (t) => {
  const root = await disposable(t);
  const api = service(root);
  await writeFile(path.join(root, "tracked.txt"), "base\n");
  assert.equal((await api.stageGitFile(root, { path: "tracked.txt" })).ok, true);
  assert.equal((await api.unstageGitFile(root, { path: "tracked.txt" })).ok, true);
  assert.equal(git(root, "ls-files"), "");
  assert.equal((await api.stageAllGitChanges(root)).ok, true);
  assert.equal((await api.initialGitCommit(root)).ok, true);
  await writeFile(path.join(root, "tracked.txt"), "changed\n");
  await assert.rejects(api.discardGitFile(root, { path: "tracked.txt" }), { statusCode: 409 });
  assert.equal((await api.discardGitFile(root, { path: "tracked.txt", confirmed: true })).ok, true);
  assert.equal(await readFile(path.join(root, "tracked.txt"), "utf8"), "base\n");
  await assert.rejects(api.deleteGitUntrackedFile(root, { path: "tracked.txt", confirmed: true }), { statusCode: 409 });
  await writeFile(path.join(root, "untracked.txt"), "delete me");
  assert.equal((await api.deleteGitUntrackedFile(root, { path: "untracked.txt", confirmed: true })).data.deleted, true);
  assert.equal((await api.stageGitFile(root, { path: "absent.txt" })).ok, false);
});

test("initialization and initial files preserve existing content and use exact Git mutations", async (t) => {
  const root = await disposable(t, { initialized: false });
  const api = service(root);
  assert.equal((await api.initializeGitRepository(root)).ok, true);
  await assert.rejects(api.initializeGitRepository(root), /Already inside a git repository/);
  await writeFile(path.join(root, "README.md"), "Keep this readme\n");
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "*" } }));
  const result = await api.prepareInitialRepositoryFiles(root, { stack: "Python" });
  assert.equal(result.ok, true);
  assert.equal(result.data.readme.created, false);
  assert.equal(await readFile(path.join(root, "README.md"), "utf8"), "Keep this readme\n");
  assert.match(await readFile(path.join(root, ".gitignore"), "utf8"), /node_modules\/.*__pycache__\//s);
  assert.equal((await api.prepareInitialRepositoryFiles(root)).data.gitignore.created, false);
  assert.deepEqual(git(root, "diff", "--cached", "--name-only").trim().split("\n").sort(), [".gitignore", "README.md"]);
  assert.equal((await api.renameGitMainBranch(root)).ok, true);
  const remote = await api.addGitOrigin(root, { username: "@example-user", repoName: "https://github.com/example/repo.git" });
  assert.equal(remote.data.remoteUrl, "https://github.com/example-user/repo.git");
  assert.equal(git(root, "remote", "get-url", "origin").trim(), remote.data.remoteUrl);
  await assert.rejects(api.addGitOrigin(root, { username: "bad--user", repoName: "repo" }), /Invalid GitHub username/);
});

test("commit validates variant before hashing, detects drift and preserves all three message variants", async (t) => {
  const root = await disposable(t);
  let requestedCwd;
  const api = service(root, { getGitRoot: async (cwd) => { requestedCwd = cwd; return root; } });
  await assert.rejects(api.commitGitWorkflow(root, { variant: "wrong", expectedStagedContentHash: null }), /variant must/);
  assert.equal(requestedCwd, undefined);
  await writeFile(path.join(root, "tracked.txt"), "one\n");
  git(root, "add", "tracked.txt");
  const approved = (await api.stagedContentHashForTab({ cwd: root })).stagedContentHash;
  await assert.rejects(api.commitGitWorkflow(root, { variant: "input", message: "blocked", expectedStagedContentHash: "0".repeat(64) }), { statusCode: 409 });
  const subdir = path.join(root, "sub");
  await mkdir(subdir);
  assert.equal((await api.commitGitWorkflow(subdir, { variant: "input", message: "input message", expectedStagedContentHash: approved })).ok, true);
  assert.equal(requestedCwd, subdir);
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "input message");
  const paths = api.commitMessagePaths(root);
  await mkdir(path.dirname(paths.shortPath), { recursive: true });
  await writeFile(paths.shortPath, "short message\n");
  await writeFile(paths.longPath, "long subject\n\nlong body\n");
  for (const variant of ["short", "long"]) {
    await writeFile(path.join(root, "tracked.txt"), `${variant}\n`);
    git(root, "add", "tracked.txt");
    assert.equal((await api.commitGitWorkflow(root, { variant })).ok, true);
    assert.equal(git(root, "log", "-1", "--format=%s").trim(), variant === "short" ? "short message" : "long subject");
  }
  await writeFile(paths.shortPath, "\n");
  await assert.rejects(api.commitGitWorkflow(root, { variant: "short" }), /is empty/);
  await assert.rejects(api.commitGitWorkflow(root, { variant: "input", message: "a\0b" }), /NUL byte/);
});

test("artifact readers retain root paths, readiness and injected default-message parsing", async (t) => {
  const root = await disposable(t);
  const entries = [{ x: "A", y: " ", path: "file.txt" }];
  const api = service(root, { parseGitPorcelainZEntries: () => entries });
  const paths = api.commitMessagePaths(root);
  await mkdir(path.dirname(paths.shortPath), { recursive: true });
  assert.equal((await api.readGitWorkflowMessages(root, { generationId: "gone" })).expired, true);
  await writeFile(paths.shortPath, "short\n");
  await writeFile(paths.longPath, "long\n");
  await writeFile(paths.branchPath, "\nfeature/example\n");
  assert.equal((await api.readGitWorkflowBranchName(root)).branch, "feature/example");
  await assert.rejects(api.readGitWorkflowBranchName(root, { generationId: "bad" }), /no longer active/);
  const generation = { id: "commit-1", kind: "commit", cwd: root, terminal: false };
  assert.equal((await api.readGitWorkflowMessages(root, { generationId: generation.id, generation })).running, true);
  generation.terminal = true;
  generation.successful = false;
  assert.equal((await api.readGitWorkflowMessages(root, { generationId: generation.id, generation })).expired, true);
  generation.successful = true;
  generation.baseline = await readStableGitMessageArtifactPair(paths);
  assert.equal((await api.readGitWorkflowMessages(root, { generationId: generation.id, generation })).ready, false);
  await writeFile(paths.shortPath, "fresh short\n");
  await writeFile(paths.longPath, "fresh long\n");
  assert.equal((await api.readGitWorkflowMessages(root, { generationId: generation.id, generation })).ready, true);
  assert.equal((await api.readGitWorkflowDefaultCommitMessage(root)).message, "created file.txt");
  entries.push({ x: "M", y: " ", path: "other.txt" });
  assert.equal((await api.readGitWorkflowDefaultCommitMessage(root)).message, "");
  assert.equal(api.gitWorkflowMessageCwd(root, path.join(root, "nested")), root);
  assert.throws(() => api.gitWorkflowMessageCwd(root, path.dirname(root)), /must stay inside/);
});

test("the global Git/gh slot waits for pipe close and retains complete output tails and environment", unixOnly, async (t) => {
  const fake = await fakeCommands(t);
  const second = service(fake.root);
  const pending = fake.service.runGitWorkflowCommand(["drain"], { cwd: fake.root, label: "draining command" });
  await waitForFile(path.join(fake.root, "ready"));
  await assert.rejects(second.runGitWorkflowCommand(["unused"], { cwd: fake.root }), /already running: draining command/);
  const busy = await second.stageGitFile(fake.root, { path: "file" });
  assert.equal(busy.code, "REPO_BUSY");
  const drained = await pending;
  assert.equal(drained.stdout, "late-tail");
  assert.equal(drained.stderr, "late-error");
  assert.equal(drained.exitCode, 0);
  const flood = await second.runGitWorkflowCommand(["flood"], { cwd: fake.root });
  assert.equal(flood.stdout.length, 100000);
  assert.equal(flood.stderr.length, 100000);
  assert.ok(flood.stdout.endsWith("stdout-tail"));
  assert.ok(flood.stderr.endsWith("stderr-tail"));
  const entry = (await fake.log())[0];
  assert.equal(entry.env.LC_ALL, "C");
  assert.equal(entry.env.GIT_TERMINAL_PROMPT, process.env.GIT_TERMINAL_PROMPT || "0");
  assert.equal(entry.env.GH_PROMPT_DISABLED, process.env.GH_PROMPT_DISABLED || "1");
  assert.equal(second.cancelGitWorkflowProcess(), false);
});

test("cancellation is synchronous, returns occupied state and keeps the slot until child close", unixOnly, async (t) => {
  const fake = await fakeCommands(t);
  const pending = fake.service.runGitWorkflowCommand(["hold"], { cwd: fake.root });
  t.after(() => fake.service.cancelGitWorkflowProcess());
  await waitForFile(path.join(fake.root, "ready"));
  const cancelResult = fake.service.cancelGitWorkflowProcess();
  assert.equal(cancelResult, true);
  assert.equal(cancelResult instanceof Promise, false);
  assert.equal(fake.service.cancelGitWorkflowProcess(), true);
  await assert.rejects(service(fake.root).runGitWorkflowCommand(["unused"], { cwd: fake.root }), /already running/);
  const result = await pending;
  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout, "cancel-tail");
  assert.equal(fake.service.cancelGitWorkflowProcess(), false);
  assert.equal((await fake.service.runGitWorkflowCommand(["next"], { cwd: fake.root })).exitCode, 0);
});

test("timeout escalates after the existing kill grace and releases the slot", unixOnly, async (t) => {
  const fake = await fakeCommands(t, { ignoreTerm: true });
  const pending = fake.service.runGitWorkflowCommand(["hold"], { cwd: fake.root, timeoutMs: 300 });
  t.after(() => fake.service.cancelGitWorkflowProcess());
  await waitForFile(path.join(fake.root, "ready"));
  const started = Date.now();
  await waitForFile(path.join(fake.root, "terminated"));
  await assert.rejects(service(fake.root).runGitWorkflowCommand(["unused"], { cwd: fake.root }), /already running/);
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(Date.now() - started >= 1900, "SIGKILL must retain the two-second grace after SIGTERM");
  assert.equal(fake.service.cancelGitWorkflowProcess(), false);
});

test("Git lock failures retry at most three times and report REPO_BUSY", unixOnly, async (t) => {
  const fake = await fakeCommands(t, { lockFailures: 2 });
  const result = await fake.service.stageGitFile(fake.root, { path: "file" });
  assert.equal(result.ok, true);
  assert.equal((await fake.log()).length, 3);
  await rm(path.join(fake.root, "attempts"));
  await fake.configure({ lockFailures: 10 });
  const busy = await fake.service.stageGitFile(fake.root, { path: "file" });
  assert.equal(busy.ok, false);
  assert.equal(busy.code, "REPO_BUSY");
  assert.match(busy.error, /index.lock/);
  assert.equal((await fake.log()).length, 6);
  await fake.configure({});
  assert.equal((await fake.service.stageGitFile(fake.root, { path: "file" })).ok, true);
});

test("workflow pushes preserve exact flags, guard order and protected-branch metadata without networking", unixOnly, async (t) => {
  const fake = await fakeCommands(t, { remotes: ["backup", "origin"] });
  const api = fake.service;
  await assert.rejects(api.pushGitWorkflow(fake.root, { branch: "other", setUpstream: true }), /Current branch is main/);
  assert.deepEqual((await fake.log()).map((entry) => entry.args), [["branch", "--show-current"]]);
  await assert.rejects(api.pushGitWorkflow(fake.root, { forceWithLease: true }), { statusCode: 409 });
  assert.equal((await fake.log()).length, 2, "confirmation must precede remote lookup and push");
  const upstream = await api.pushGitWorkflow(fake.root, { setUpstream: true, branch: "main", forceWithLease: true });
  assert.equal(upstream.ok, true);
  assert.equal(upstream.data.protectedBranch, true);
  assert.equal(upstream.data.remote, "origin");
  assert.deepEqual((await fake.log()).at(-1).args, ["push", "-u", "origin", "main"]);
  const forced = await api.pushGitWorkflow(fake.root, { forceWithLease: true, confirmed: true });
  assert.equal(forced.data.forceWithLease, true);
  assert.deepEqual((await fake.log()).at(-1).args, ["push", "-u", "--force-with-lease", "origin", "HEAD"]);
  assert.equal((await api.pushInitialGitMain(fake.root)).ok, true);
  assert.deepEqual((await fake.log()).at(-1).args, ["push", "-u", "origin", "main"]);
  await fake.configure({ branch: "feature/x", remotes: ["backup"] });
  const ordinary = await api.pushGitWorkflow(fake.root);
  assert.equal(ordinary.data.protectedBranch, false);
  assert.deepEqual((await fake.log()).at(-1).args, ["push", "-u", "backup", "HEAD"]);
  for (const [failure, code] of [
    ["fatal: No configured push destination.", "NO_REMOTE"],
    ["Authentication failed", "AUTH"],
    ["could not resolve host", "NETWORK"],
    ["GH006 protected branch", "PROTECTED_BRANCH"],
    ["[rejected] non-fast-forward", "NON_FAST_FORWARD"],
    ["has no upstream branch", "NO_UPSTREAM"],
  ]) {
    await fake.configure({ failure });
    const failed = await api.pushGitWorkflow(fake.root);
    assert.equal(failed.code, code);
    assert.equal(failed.data.branch, "main");
    assert.equal(failed.data.repoName, path.basename(fake.root));
    assert.deepEqual((await fake.log()).at(-1).args, ["push"]);
  }
});

test("fetch, pull and integration retain flags, guards and failure classification", unixOnly, async (t) => {
  const fake = await fakeCommands(t);
  const api = service(fake.root, { gitUpstreamRef: async () => "origin/main" });
  assert.equal((await api.fetchGitChanges(fake.root)).ok, true);
  assert.deepEqual((await fake.log()).at(-1).args, ["-c", "credential.interactive=false", "fetch", "--prune"]);
  assert.equal((await api.pullGitChanges(fake.root, { remote: "origin" })).ok, true);
  assert.deepEqual((await fake.log()).at(-1).args, ["pull", "--ff-only", "origin"]);
  await assert.rejects(api.pullGitChanges(fake.root, { remote: "upstream" }), /Unsupported Git pull remote/);
  await assert.rejects(api.integrateGitUpstream(fake.root, { mode: "invalid" }), { statusCode: 400 });
  await assert.rejects(api.integrateGitUpstream(fake.root, { mode: "rebase" }), { statusCode: 409 });
  await assert.rejects(fake.service.integrateGitUpstream(fake.root, { mode: "merge", confirmed: true }), /No upstream/);
  assert.equal((await api.integrateGitUpstream(fake.root, { mode: "rebase", confirmed: true })).ok, true);
  assert.deepEqual((await fake.log()).at(-1).args, ["-c", "core.editor=true", "rebase", "@{upstream}"]);
  await fake.configure({ failCommand: "pull", failure: "fatal: Not possible to fast-forward" });
  assert.equal((await api.pullGitChanges(fake.root)).code, "DIVERGED");
});

test("publication validates visibility, confirmation and no-remotes before fake gh", unixOnly, async (t) => {
  const fake = await fakeCommands(t);
  const api = fake.service;
  await assert.rejects(api.publishGitRepository(fake.root, { visibility: "internal", confirmed: true }), { statusCode: 400 });
  await assert.rejects(api.publishGitRepository(fake.root, { visibility: "public" }), { statusCode: 409 });
  await assert.rejects(readFile(path.join(fake.root, "commands.jsonl")), { code: "ENOENT" });
  await fake.configure({ remotes: ["origin"] });
  await assert.rejects(api.publishGitRepository(fake.root, { visibility: "private", confirmed: true }), /no configured remotes/);
  assert.equal((await fake.log()).some((entry) => entry.command === "gh"), false);
  await fake.configure({});
  const published = await api.publishGitRepository(fake.root, { visibility: "private", confirmed: true });
  assert.equal(published.ok, true);
  assert.equal(published.data.protectedBranch, true);
  assert.equal(published.data.remote, "origin");
  assert.deepEqual((await fake.log()).at(-1).args, ["repo", "create", path.basename(fake.root), "--private", "--source", ".", "--remote", "origin", "--push"]);
  await fake.configure({ failure: "gh auth login" });
  assert.equal((await api.publishGitRepository(fake.root, { visibility: "public", confirmed: true })).code, "AUTH");
  await fake.configure({ failure: "repository example already exists" });
  assert.match((await api.publishGitRepository(fake.root, { visibility: "public", confirmed: true })).hint, /already exists/);
  await rm(path.join(fake.root, "bin", "gh"));
  const missing = await api.publishGitRepository(fake.root, { visibility: "public", confirmed: true });
  assert.equal(missing.data.errorCode, "ENOENT");
  assert.match(missing.hint, /Install GitHub CLI/);
  assert.equal(api.cancelGitWorkflowProcess(), false);
});

test("PR creation validates text and stores the encoded current-branch description before fake gh", unixOnly, async (t) => {
  const fake = await fakeCommands(t, { branch: "feature/one" });
  const api = fake.service;
  await assert.rejects(api.createGitWorkflowPr(fake.root, { title: "", body: "description" }), /PR title is required/);
  await assert.rejects(api.createGitWorkflowPr(fake.root, { title: "title", body: " \n" }), /PR description is required/);
  assert.equal((await fake.log()).some((entry) => entry.command === "gh"), false);
  const created = await api.createGitWorkflowPr(fake.root, { title: " first\nsecond ", body: "description\n\n" });
  assert.equal(created.ok, true);
  assert.equal(created.data.path, path.join(fake.root, "dev", "PR", "feature%2Fone.md"));
  assert.equal(await readFile(created.data.path, "utf8"), "description\n");
  assert.deepEqual((await fake.log()).at(-1).args, ["pr", "create", "--title", "first second", "--body-file", created.data.path, "--head", "feature/one"]);
  assert.equal((await api.readGitWorkflowPrDescription(fake.root)).body, "description");
  await fake.configure({ branch: "feature/one", failure: "PR refused" });
  assert.equal((await api.createGitWorkflowPr(fake.root, { title: "title", body: "changed" })).ok, false);
  assert.equal(await readFile(created.data.path, "utf8"), "changed\n");
});

test("branch reads preserve remote identity, local precedence, occupation and exact requested intent", async (t) => {
  const root = await disposable(t);
  await baseCommit(root);
  git(root, "remote", "add", "origin", "https://example.invalid/origin.git");
  git(root, "remote", "add", "backup", "https://example.invalid/backup.git");
  const head = git(root, "rev-parse", "HEAD").trim();
  for (const ref of ["origin/feature", "backup/feature", "origin/main"]) git(root, "update-ref", `refs/remotes/${ref}`, head);
  git(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  const worktree = await disposable(t, { initialized: false });
  git(root, "worktree", "add", "-q", "-b", "occupied", worktree);
  const api = service(root);
  const data = await api.readGitBranches(root);
  assert.equal(data.current, "main");
  assert.deepEqual(data.branches.filter((entry) => entry.remote).map((entry) => entry.remoteRef), ["backup/feature", "origin/feature"]);
  assert.equal(data.branches.find((entry) => entry.name === "occupied").worktreePath, worktree);
  assert.equal(data.branches.find((entry) => entry.name === "occupied").occupied, true);
  assert.deepEqual(await api.verifyRemoteGitBranchIntent(root, "feature", "backup/feature"), { root, branch: "feature", remoteRef: "backup/feature" });
  await assert.rejects(api.verifyRemoteGitBranchIntent(root, "feature", "missing/feature"), /Unknown remote/);
  await assert.rejects(api.verifyRemoteGitBranchIntent(root, "other", "origin/feature"), /does not match/);
  await assert.rejects(api.verifyRemoteGitBranchIntent(root, "main", "origin/main"), /Local git branch already exists/);
  assert.equal(api.requestedRemoteRef({}), null);
  assert.equal(api.requestedRemoteRef({ remoteRef: "backup/feature" }), "backup/feature");
  for (const remoteRef of [null, "", " origin/feature", 1]) assert.throws(() => api.requestedRemoteRef({ remoteRef }), /non-empty exact/);
  const truncated = service(root, { runGitReadCommandDetailed: async () => ({ output: "refs/remotes/origin/partial", truncated: true }) });
  const limited = await truncated.readGitBranches(root);
  assert.equal(limited.remoteBranchesTruncated, true);
  assert.equal(limited.branches.some((entry) => entry.remote), false);
  const unavailable = service(root, { runGitReadCommandDetailed: async () => { throw new Error("unavailable"); } });
  assert.equal((await unavailable.readGitBranches(root)).remoteBranchesUnavailable, true);
});

test("stash, recovery, tags, reflog, signing and submodule reads use injected G1 boundaries", async (t) => {
  const root = await disposable(t);
  await baseCommit(root);
  const api = service(root);
  await writeFile(path.join(root, "tracked.txt"), "stash me\n");
  await writeFile(path.join(root, "extra.txt"), "untracked stash\n");
  const saved = await api.saveGitStash(root, { message: "local stash", includeUntracked: true });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.stashes.length, 1);
  assert.match((await api.readGitStashPreview(root, "stash@{0}")).patch, /stash me/);
  await assert.rejects(api.applyGitStash(root, { ref: "--bad" }), { statusCode: 400 });
  assert.equal((await api.applyGitStash(root, { ref: "stash@{0}" })).ok, true);
  await assert.rejects(api.dropGitStash(root, { ref: "stash@{0}" }), { statusCode: 409 });
  assert.equal((await api.dropGitStash(root, { ref: "stash@{0}", confirmed: true })).data.stashes.length, 0);
  assert.equal((await api.readGitUndoState(root)).hasParent, false);
  git(root, "add", "tracked.txt");
  git(root, "commit", "-qm", "second");
  assert.equal((await api.readGitUndoState(root)).canUndoLastCommit, true);
  await assert.rejects(api.undoLastGitCommit(root), { statusCode: 409 });
  const staged = service(root, { summarizeGitPorcelainStatus: () => ({ ...summary, staged: 1 }) });
  await assert.rejects(staged.amendLastGitCommitMessage(root, { message: "bad", confirmed: true }), /Staged changes present/);
  const published = service(root, { gitUpstreamRef: async () => "origin/main" });
  await assert.rejects(published.undoLastGitCommit(root, { confirmed: true }), /already pushed/);
  assert.equal((await api.amendLastGitCommitMessage(root, { message: "renamed", confirmed: true })).ok, true);
  assert.equal(git(root, "log", "-1", "--format=%s").trim(), "renamed");
  const undone = await api.undoLastGitCommit(root, { confirmed: true });
  assert.equal(undone.ok, true);
  assert.equal(undone.data.restoreCommand, "git reset --soft ORIG_HEAD");
  assert.match(git(root, "diff", "--cached"), /stash me/);
  const tag = await api.createGitTag(root, { name: "v-test", message: "tag message", confirmed: true });
  assert.equal(tag.ok, true);
  assert.equal(tag.data.tags[0].annotated, true);
  await assert.rejects(api.createGitTag(root, { name: "bad..tag", confirmed: true }), /Invalid tag name/);
  assert.ok((await api.readGitReflog(root)).entries.length > 0);
  assert.equal((await api.readGitSubmodules(root)).hasSubmodules, false);
  await assert.rejects(api.updateGitSubmodules(root), { statusCode: 409 });
  assert.equal((await api.updateGitSubmodules(root, { confirmed: true })).ok, true);
  git(root, "config", "commit.gpgsign", "true");
  const signing = await api.readGitSigningDiagnostics(root);
  assert.equal(signing.commitSignRequired, true);
  assert.equal(signing.mismatch, true);
  assert.ok(signing.suggestions.some((suggestion) => suggestion.command === "git config user.signingkey <KEY-ID>"));
});

test("operation snapshot, conflict staging, continue and abort preserve actual merge recovery", async (t) => {
  const root = await disposable(t);
  await baseCommit(root);
  git(root, "switch", "-qc", "other");
  await writeFile(path.join(root, "tracked.txt"), "other\n");
  git(root, "commit", "-qam", "other");
  git(root, "switch", "-q", "main");
  await writeFile(path.join(root, "tracked.txt"), "main\n");
  git(root, "commit", "-qam", "main");
  git(root, "config", "branch.main.remote", ".");
  git(root, "config", "branch.main.merge", "refs/heads/other");
  const api = service(root, { gitUpstreamRef: async () => "other" });
  const merged = await api.integrateGitUpstream(root, { mode: "merge", confirmed: true });
  assert.equal(merged.ok, false);
  assert.equal(merged.code, "CONFLICTS");
  const state = await api.readGitOperationSnapshot(root);
  assert.equal(state.operation, "merge");
  assert.equal(state.conflicts[0].path, "tracked.txt");
  assert.equal(state.conflicts[0].preview.hasMarkers, true);
  assert.ok(state.conflicts[0].preview.hunks.length > 0);
  assert.equal((await api.gitOperationAction(root, "continue")).code, "UNMERGED_PATHS");
  await assert.rejects(api.gitOperationAction(root, "skip"), /does not support skip/);
  await assert.rejects(api.gitOperationAction(root, "abort"), { statusCode: 409 });
  await assert.rejects(api.undoLastGitCommit(root, { confirmed: true }), /Cannot undo during a merge/);
  await writeFile(path.join(root, "tracked.txt"), "resolved\n");
  assert.equal((await api.gitOperationStageFile(root, { path: "tracked.txt" })).ok, true);
  assert.equal((await api.gitOperationAction(root, "abort", { confirmed: true })).ok, true);
  assert.equal((await api.readGitOperationSnapshot(root)).operation, null);
  await api.integrateGitUpstream(root, { mode: "merge", confirmed: true });
  await writeFile(path.join(root, "tracked.txt"), "resolved\n");
  await api.gitOperationStageFile(root, { path: "tracked.txt" });
  const continued = await api.gitOperationAction(root, "continue");
  assert.equal(continued.ok, true);
  assert.equal(continued.data.operation.operation, null);
  await assert.rejects(api.gitOperationStageFile(root, { path: "tracked.txt" }), /No git operation/);
  await assert.rejects(api.gitBisectAction(root, { verdict: "bad" }), /No git bisect/);
  await assert.rejects(api.gitBisectAction(root, { verdict: "invalid" }), { statusCode: 400 });
  git(root, "bisect", "start");
  assert.equal((await api.readGitOperationSnapshot(root)).operation, "bisect");
  await assert.rejects(api.gitOperationAction(root, "continue"), /Bisect is controlled/);
  await assert.rejects(api.gitBisectAction(root, { verdict: "reset" }), { statusCode: 409 });
  assert.equal((await api.gitBisectAction(root, { verdict: "reset", confirmed: true })).ok, true);
});


test("Git and gh mutations share cancellation and cancellation does not trigger lock retries", unixOnly, async (t) => {
  const fake = await fakeCommands(t, { holdGh: true });
  const pr = fake.service.createGitWorkflowPr(fake.root, { title: "title", body: "description" });
  t.after(async () => { fake.service.cancelGitWorkflowProcess(); await pr; });
  await waitForFile(path.join(fake.root, "ready"));
  await assert.rejects(service(fake.root).runGitWorkflowCommand(["unused"], { cwd: fake.root }), /already running: gh pr create/);
  assert.equal(fake.service.cancelGitWorkflowProcess(), true);
  const cancelledPr = await pr;
  assert.equal(cancelledPr.ok, false);
  assert.equal(cancelledPr.error, "Cancelled");
  assert.equal(cancelledPr.data.cancelled, true);
  await rm(path.join(fake.root, "ready"));
  await fake.configure({ holdAdd: true });
  const add = fake.service.stageGitFile(fake.root, { path: "file" });
  t.after(async () => { fake.service.cancelGitWorkflowProcess(); await add; });
  await waitForFile(path.join(fake.root, "ready"));
  assert.equal(fake.service.cancelGitWorkflowProcess(), true);
  const cancelledAdd = await add;
  assert.equal(cancelledAdd.ok, false);
  assert.equal(cancelledAdd.data.cancelled, true);
  assert.equal((await fake.log()).filter((entry) => entry.args[0] === "add").length, 1);
});


test("branch mutations preserve local switching, creation and occupied-worktree refusals", async (t) => {
  const root = await disposable(t);
  await baseCommit(root);
  const api = service(root);
  const current = await api.switchGitBranch(root, "main");
  assert.equal(current.ok, true);
  assert.equal(current.data.switched, false);
  assert.equal(current.data.created, false);
  await assert.rejects(api.switchGitBranch(root, "unknown"), /Unknown local git branch/);
  await assert.rejects(api.switchGitBranch(root, "main", { create: true }), /already exists/);
  await assert.rejects(api.switchGitBranch(root, "bad..branch", { create: true }), /not a valid branch name/);
  const created = await api.switchGitBranch(root, "new-local", { create: true });
  assert.equal(created.ok, true);
  assert.equal(created.data.created, true);
  assert.equal(created.data.command, "git switch -c new-local");
  assert.equal(git(root, "branch", "--show-current").trim(), "new-local");
  assert.equal((await api.switchGitBranch(root, "main")).data.switched, true);
  const worktree = await disposable(t, { initialized: false });
  git(root, "worktree", "add", "-q", worktree, "new-local");
  const refused = await api.switchGitBranch(root, "new-local");
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "BRANCH_CHECKED_OUT_ELSEWHERE");
  assert.equal(refused.data.worktreePath, worktree);
  assert.equal(git(root, "branch", "--show-current").trim(), "main");
});

test("remote branch mutation validates exact intent then creates tracking without fetching", async (t) => {
  const root = await disposable(t);
  await baseCommit(root);
  const head = git(root, "rev-parse", "HEAD").trim();
  for (const remote of ["origin", "backup"]) {
    git(root, "remote", "add", remote, `https://example.invalid/${remote}.git`);
    git(root, "update-ref", `refs/remotes/${remote}/feature`, head);
  }
  const api = service(root);
  await assert.rejects(api.switchGitBranch(root, "feature", { remoteRef: "unknown/feature" }), /Unknown remote/);
  await assert.rejects(api.switchGitBranch(root, "other", { remoteRef: "backup/feature" }), /does not match/);
  const created = await api.switchGitBranch(root, "feature", { remoteRef: "backup/feature" });
  assert.equal(created.ok, true);
  assert.equal(created.data.created, true);
  assert.equal(created.data.switched, true);
  assert.equal(created.data.command, "git switch --track -c feature backup/feature");
  assert.equal(git(root, "config", "branch.feature.remote").trim(), "backup");
  assert.equal(git(root, "config", "branch.feature.merge").trim(), "refs/heads/feature");
  await assert.rejects(api.switchGitBranch(root, "feature", { remoteRef: "origin/feature" }), /Local git branch already exists/);
});
