import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auditLocalOrphans,
  cleanupLock,
  listDisplayLocks,
  lockLiveness,
  lockRecordProblem,
  sweepLocalOrphans,
  taggedProcesses,
} from "../../../../src/backends/local/footprint.ts";
import { addProc, BOOT, fakeHost, writeLock, writeXFiles } from "./fakes.mjs";

const TAG = "abcdef0123456789";

function options(host, extra = {}) {
  return { lockDir: host.lockDir, procRoot: host.procRoot, x11Dir: host.x11Dir, xLockDir: host.xLockDir, uid: host.uid, kill: host.kill, termWaitMs: 50, ...extra };
}

/** A dead helper (pid 4242 gone) that left Xvfb 500, an app 600 (tagged), an untagged infra bus 501, and X files. */
function orphan(host, display = 90) {
  addProc(host.procRoot, 500, 7000, { PI_GUI_TAG: TAG });
  addProc(host.procRoot, 501, 7001, {});
  addProc(host.procRoot, 600, 7002, { PI_GUI_TAG: TAG, OTHER: "1" });
  writeXFiles(host, display, 500);
  return writeLock(host, { display, helper: "4242:5000", tag: TAG, xvfbPid: 500, infra: { xvfb: "500:7000", dbus: "501:7001" } });
}

test("lock records are validated before anyone acts on them", () => {
  assert.equal(lockRecordProblem({ version: 1, display: 90, helper: "1:2", bootId: "b", tag: "t", xvfbPid: null, infra: {} }), undefined);
  assert.match(lockRecordProblem({ version: 2 }), /unknown version/);
  assert.match(lockRecordProblem({ version: 1, display: 90, helper: "x", bootId: "b", tag: "t", xvfbPid: null, infra: {} }), /helper id/);
  assert.match(lockRecordProblem({ version: 1, display: 90, helper: "1:2", bootId: "b", tag: "a b", xvfbPid: null, infra: {} }), /tag/);
});

test("taggedProcesses finds only processes whose environment carries the exact tag", async (t) => {
  const host = fakeHost(t);
  addProc(host.procRoot, 10, 1, { PI_GUI_TAG: TAG });
  addProc(host.procRoot, 11, 1, { PI_GUI_TAG: `${TAG}0` });
  addProc(host.procRoot, 12, 1, { X: `PI_GUI_TAG=${TAG}` });
  addProc(host.procRoot, 13, 1, {});
  assert.deepEqual(await taggedProcesses(TAG, host.procRoot, host.uid), [10]);
  assert.deepEqual(await taggedProcesses(TAG, host.procRoot, host.uid + 1), []);
});

test("lock liveness: dead after reboot, PID gone, or PID reused; alive otherwise", (t) => {
  const host = fakeHost(t);
  const record = { helper: "4242:5000", bootId: BOOT };
  assert.equal(lockLiveness(record, host.procRoot), "dead");
  addProc(host.procRoot, 4242, 5000);
  assert.equal(lockLiveness(record, host.procRoot), "alive");
  assert.equal(lockLiveness({ ...record, bootId: "other-boot" }, host.procRoot), "dead");
  addProc(host.procRoot, 4242, 9999);
  assert.equal(lockLiveness(record, host.procRoot), "dead");
  assert.equal(lockLiveness({ ...record, bootId: null }, host.procRoot), "unknown");
});

test("cleanupLock kills tagged and recorded processes, removes our X files and the lock", async (t) => {
  const host = fakeHost(t);
  const { path, record } = orphan(host);
  addProc(host.procRoot, 700, 1, {}); // unrelated process of the same user
  const leftovers = await cleanupLock(path, record, options(host));
  assert.deepEqual(leftovers, []);
  assert.deepEqual(host.kills.filter(([, s]) => s === "SIGTERM").map(([p]) => p).sort(), [500, 501, 600]);
  assert.ok(!host.kills.some(([pid]) => pid === 700), "an untagged process of the user is never signalled");
  assert.ok(existsSync(join(host.procRoot, "700")));
  assert.ok(!existsSync(join(host.x11Dir, "X90")) && !existsSync(join(host.xLockDir, ".X90-lock")));
  assert.ok(!existsSync(path));
});

test("cleanupLock leaves X files of another X server and of a still running Xvfb alone", async (t) => {
  const host = fakeHost(t);
  writeXFiles(host, 91, 999); // another server took :91 after our Xvfb died
  const other = writeLock(host, { display: 91, tag: TAG, xvfbPid: 500, infra: { xvfb: "500:7000" } });
  assert.deepEqual(await cleanupLock(other.path, other.record, options(host)), []);
  assert.ok(existsSync(join(host.x11Dir, "X91")) && existsSync(join(host.xLockDir, ".X91-lock")));

  const stubborn = fakeHost(t, { unkillable: [500] });
  const { path, record } = orphan(stubborn);
  const leftovers = await cleanupLock(path, record, options(stubborn));
  assert.deepEqual(leftovers.map((l) => l.kind).sort(), ["display-lock", "process"]);
  assert.ok(existsSync(path), "the lock stays until its processes are gone, so a later sweep retries");
  assert.ok(existsSync(join(stubborn.x11Dir, "X90")), "X files of a running Xvfb stay");
});

test("orphan audit is read-only and exempts live helpers; sweep removes only dead ones", async (t) => {
  const host = fakeHost(t);
  const dead = orphan(host, 90);
  addProc(host.procRoot, 4300, 6000);
  addProc(host.procRoot, 800, 8000, { PI_GUI_TAG: "1111222233334444" });
  const live = writeLock(host, { display: 92, helper: "4300:6000", tag: "1111222233334444", xvfbPid: 800, infra: { xvfb: "800:8000" } });

  const audit = await auditLocalOrphans(options(host));
  assert.deepEqual(audit.map((l) => `${l.kind} ${l.id}`).sort(), [
    `display ${join(host.x11Dir, "X90")}`,
    `display ${join(host.xLockDir, ".X90-lock")}`,
    `display-lock ${dead.path}`,
    "process 500",
    "process 501:7001",
    "process 600",
  ]);
  assert.deepEqual(host.kills, [], "the audit signals nothing");

  assert.deepEqual(await sweepLocalOrphans({ ...options(host), signal: new AbortController().signal }), []);
  assert.ok(!existsSync(dead.path));
  assert.ok(existsSync(live.path), "a live helper's lock is never touched");
  assert.ok(!host.kills.some(([pid]) => pid === 800 || pid === 4300));
  assert.deepEqual(await auditLocalOrphans(options(host)), []);
});

test("unknown owners and unreadable locks are reported after a grace period, never removed", async (t) => {
  const host = fakeHost(t);
  const unknown = writeLock(host, { display: 93, bootId: null });
  mkdirSync(host.lockDir, { recursive: true });
  const torn = join(host.lockDir, "display-94.lock");
  writeFileSync(torn, "{");
  writeFileSync(join(host.lockDir, "notes.txt"), "ignored");
  assert.equal((await listDisplayLocks(host.lockDir, host.uid)).length, 2);

  const fresh = await auditLocalOrphans(options(host));
  assert.deepEqual(fresh.map((l) => l.id), [unknown.path], "a just-written lock may still be in progress");
  const old = (Date.now() - 120_000) / 1000;
  utimesSync(torn, old, old);
  const later = await sweepLocalOrphans({ ...options(host), signal: new AbortController().signal });
  assert.deepEqual(later.map((l) => l.id).sort(), [unknown.path, torn].sort());
  assert.ok(later.every((l) => /not removed automatically/.test(l.detail)));
  assert.ok(existsSync(unknown.path) && existsSync(torn));
});
