/**
 * X1: the cua ledger's interprocess lock. Holders in other processes are
 * waited for and never superseded while alive; the lock of a holder that is
 * gone (PID gone, or reused with another start time) is recovered.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LedgerLock } from "../../../../src/backends/cua/ledger-lock.ts";
import { SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { readBootId, readProcessStartTime } from "../../../../src/cleanup/identity.ts";
import { withFsFailureOnce } from "./fake-cua.mjs";

const NAME = "pi-gui-testing-demo";
const LOCK_MODULE = new URL("../../../../src/backends/cua/ledger-lock.ts", import.meta.url).href;

function record(overrides = {}) {
  return { version: 1, name: NAME, ref: `aws:${NAME}`, location: "aws", ownerLabel: "old-owner", sessionId: "gui-old", projectKey: "project", phase: "created", keep: true, createdAt: new Date().toISOString(), image: "linux", ...overrides };
}

async function ledgerDir(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-ledger-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "ledger");
}

/** A child process that takes the lock of `dir`; it releases on a stdin line, or exits holding it. */
async function holder(t, dir, { exitHolding = false } = {}) {
  const code = `import { LedgerLock } from ${JSON.stringify(LOCK_MODULE)};
const release = await new LedgerLock(${JSON.stringify(dir)}).acquire();
process.stdout.write("held\\n");
${exitHolding ? "process.exit(0);" : "process.stdin.once('data', async () => { await release(); process.stdout.write('released\\n'); process.exit(0); });"}`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  let out = "";
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("held")) resolve();
    });
    child.once("exit", (status) => (out.includes("held") ? resolve() : reject(new Error(`holder exited ${status}`))));
  });
  return {
    pid: child.pid,
    exited,
    release: async () => {
      child.stdin.write("go\n");
      await exited;
    },
  };
}

/** One acquisition attempt from another process: its error message, or "acquired". */
async function acquireElsewhere(dir, timeoutMs = 150) {
  const code = `import { LedgerLock } from ${JSON.stringify(LOCK_MODULE)};
try { const release = await new LedgerLock(${JSON.stringify(dir)}, { timeoutMs: ${timeoutMs} }).acquire(); await release(); process.stdout.write("acquired"); }
catch (error) { process.stdout.write(error.message); }`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  await new Promise((resolve) => child.once("exit", resolve));
  return out;
}

const lockFiles = async (dir) => (await readdir(dir)).filter((f) => f.startsWith(".lock")).sort();

test("X1: a lock held by a live process in another process is waited for and never stolen", async (t) => {
  const dir = await ledgerDir(t);
  await new SandboxLedger(dir).write(record());
  const child = await holder(t, dir);
  const before = await lockFiles(dir);
  const held = await readFile(join(dir, before[0]), "utf8");
  const impatient = new SandboxLedger(dir, { lock: { timeoutMs: 400 } });
  await assert.rejects(impatient.markKept(NAME, "gui-old"), new RegExp(`locked by process ${child.pid}`));
  assert.deepEqual(await lockFiles(dir), before, "the live holder's lock is untouched");
  assert.equal(await readFile(join(dir, before[0]), "utf8"), held);
  assert.equal((await impatient.read(NAME)).sessionId, "gui-old", "nothing changed while it was held");
  // A patient transition waits for the release and then runs.
  const patient = new SandboxLedger(dir).markKept(NAME, "gui-old");
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(await impatient.read(NAME), "still waiting while the holder lives");
  await child.release();
  assert.equal(await patient, true);
  assert.ok(await impatient.read(NAME, true));
});

test("X1: the lock of a process that exited while holding it is recovered", async (t) => {
  const dir = await ledgerDir(t);
  await new SandboxLedger(dir).write(record());
  const child = await holder(t, dir, { exitHolding: true });
  await child.exited;
  const ledger = new SandboxLedger(dir, { lock: { timeoutMs: 5_000 } });
  assert.equal(await ledger.markKept(NAME, "gui-old"), true);
  const files = await lockFiles(dir);
  assert.equal(files.filter((f) => /^\.lock\.\d+$/.test(f)).length, 1, `old generations are removed: ${files}`);
});

test("X1: a lock naming a reused PID (other start time) is recovered; an unreadable or same-process lock is not", async (t) => {
  const dir = await ledgerDir(t);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const bootId = readBootId();
  const startTime = readProcessStartTime(process.pid);
  // This PID with another start time: the holder that wrote it is gone.
  await writeFile(join(dir, ".lock.7"), JSON.stringify({ version: 1, pid: process.pid, processStartTime: `${Number(startTime) + 1}`, bootId, token: "x" }));
  const release = await new LedgerLock(dir, { timeoutMs: 2_000 }).acquire();
  assert.deepEqual(await lockFiles(dir), [".lock.8"]);
  // Held by this very process (another transition in flight): waited for, not stolen.
  await assert.rejects(new LedgerLock(dir, { timeoutMs: 200 }).acquire(), new RegExp(`locked by process ${process.pid}`));
  await release();
  // An unreadable record could be a live holder: never removed.
  await writeFile(join(dir, ".lock.9"), "{not json");
  await assert.rejects(new LedgerLock(dir, { timeoutMs: 200 }).acquire(), /unreadable lock record/);
  assert.ok((await lockFiles(dir)).includes(".lock.9"));
});

test("X1: concurrent transitions from several processes keep exactly one record per sandbox", async (t) => {
  const dir = await ledgerDir(t);
  const ledger = new SandboxLedger(dir);
  await ledger.write(record({ phase: "created" }));
  await ledger.markKept(NAME, "gui-old");
  const LEDGER_MODULE = new URL("../../../../src/backends/cua/ledger.ts", import.meta.url).href;
  const worker = (i) => {
    const code = `import { SandboxLedger } from ${JSON.stringify(LEDGER_MODULE)};
const l = new SandboxLedger(${JSON.stringify(dir)});
let wins = 0;
for (let n = 0; n < 10; n++) {
  const c = await l.claimKept("aws", "project", { ownerLabel: "w${i}", sessionId: "gui-w${i}-" + n });
  if (c) { wins++; if (!(await l.markKept(c.name, c.sessionId))) throw new Error("lost a claimed record"); }
}
process.stdout.write(String(wins));`;
    const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    return new Promise((resolve, reject) => child.once("exit", (s) => (s === 0 ? resolve(Number(out)) : reject(new Error(`worker ${i} exited ${s}`)))));
  };
  const wins = await Promise.all([0, 1, 2].map(worker));
  assert.ok(wins.reduce((a, b) => a + b, 0) > 0);
  const entries = (await ledger.entries()).filter((e) => e.record?.name === NAME);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kept, true);
});

test("a failed release stays retryable: the lock is freed once the marker can be written", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gui-lock-release-"));
  t.after(async () => {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  });
  const lock = new LedgerLock(dir, { timeoutMs: 200 });
  const release = await lock.acquire();
  await chmod(dir, 0o500);
  await assert.rejects(release(), (error) => error.code === "EACCES");
  await chmod(dir, 0o700);
  // Before the retry the lock is still held by this (live) process: another process waits for it.
  assert.match(await acquireElsewhere(dir), new RegExp(`is locked by process ${process.pid}`));
  await release();
  assert.equal(await acquireElsewhere(dir, 2_000), "acquired");
});

const isFree = (path) => path.includes("/.lock.") && path.endsWith(".free");

test("CC2: a release whose marker writes all fail is owed; run() drops the closure, yet this process's next run() settles it once the filesystem recovers", async (t) => {
  const dir = await ledgerDir(t);
  const ledger = new SandboxLedger(dir, { lock: { timeoutMs: 300 } });
  // All three marker writes of one transition fail: the transition committed, but run() rejects and keeps no closure.
  const failed = await withFsFailureOnce("writeFile", isFree, () => ledger.write(record()), 3).catch((error) => error);
  assert.equal(failed.code, "EIO");
  assert.equal((await ledger.read(NAME))?.sessionId, "gui-old", "the transition committed");
  // Another process never supersedes the live holder.
  assert.match(await acquireElsewhere(dir), new RegExp(`is locked by process ${process.pid}`));
  // The filesystem is healthy again: this process's next transition succeeds (no marker written by hand).
  assert.equal(await ledger.markKept(NAME, "gui-old"), true);
  assert.equal((await ledger.read(NAME, true))?.sessionId, "gui-old");
  assert.equal(await acquireElsewhere(dir, 2_000), "acquired");
});

test("CC2: while the owed marker still cannot be written, this process supersedes only its own owed generation; a later run settles everything", async (t) => {
  const dir = await ledgerDir(t);
  const ledger = new SandboxLedger(dir, { lock: { timeoutMs: 300 } });
  await assert.rejects(withFsFailureOnce("writeFile", isFree, () => ledger.write(record()), 3), { code: "EIO" });
  // Still failing: the owed marker (1 write) and this transition's own release (3 writes). The transition still
  // runs (it supersedes the owed generation instead of waiting for itself) and commits.
  const second = await withFsFailureOnce("writeFile", isFree, () => ledger.markKept(NAME, "gui-old"), 4).catch((error) => error);
  assert.equal(second.code, "EIO");
  assert.equal((await ledger.read(NAME, true))?.sessionId, "gui-old", "the second transition ran and committed");
  assert.match(await acquireElsewhere(dir), new RegExp(`is locked by process ${process.pid}`));
  // A lock of this process that is not owed (an acquisition in progress) is waited for, not superseded.
  const lock = new LedgerLock(dir, { timeoutMs: 300 });
  const held = await lock.acquire();
  await assert.rejects(new LedgerLock(dir, { timeoutMs: 100 }).acquire(), new RegExp(`is locked by process ${process.pid}`));
  await held();
  assert.equal(await ledger.claimKept("aws", "project", { ownerLabel: "new-owner", sessionId: "gui-new" }, { image: "linux" }).then((r) => r?.sessionId), "gui-new");
  assert.equal(await acquireElsewhere(dir, 2_000), "acquired");
  const files = await lockFiles(dir);
  assert.equal(files.filter((f) => /^\.lock\.\d+$/.test(f)).length, 1, `one generation left: ${files}`);
});

for (const stage of ["temp file", "old generation's marker", "old generation"]) {
  test(`CC3: a failure removing the ${stage} after the new generation is published does not fail acquire(); the lock is held and released normally`, async (t) => {
    const dir = await ledgerDir(t);
    const lock = new LedgerLock(dir, { timeoutMs: 300 });
    await (await lock.acquire())(); // generation 1, released
    const match = {
      "temp file": (p) => p.includes("/.lock-tmp."),
      "old generation's marker": (p) => p === join(dir, ".lock.1.free"),
      "old generation": (p) => p === join(dir, ".lock.1"),
    }[stage];
    const { value: release, injected } = await withFsFailureOnce("rm", match, () => lock.acquire());
    assert.equal(injected, true);
    assert.equal(typeof release, "function");
    // Held by generation 2 until released; then any process takes it.
    assert.match(await acquireElsewhere(dir), new RegExp(`is locked by process ${process.pid}`));
    await release();
    assert.equal(await acquireElsewhere(dir, 2_000), "acquired");
    // The next holder (generation 3 in the child) removed what the failed cleanup left of generation 1.
    assert.ok(!(await lockFiles(dir)).some((f) => f === ".lock.1" || f === ".lock.1.free"), `${await lockFiles(dir)}`);
  });
}
