import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalWindowsBackend } from "../../../../src/backends/local-windows.ts";
import { fakeWinHost, fakeWinRunner, ownerRecord, sessionRecord, winSpawner, BOOT, HELPER_DIR, TEMP_ROOT, WIN_ENV } from "./local-fakes.mjs";

const DEAD_OWNER = ownerRecord({ pid: 777, processStartTime: "1761000000" });
const LIVE_OWNER = ownerRecord();

/** A runtime dir left by a session: owner copy, session.json, optional live objects in the world. */
function leaveRuntimeDir(host, name, { owner = DEAD_OWNER, record, alive = true } = {}) {
  const dir = `${TEMP_ROOT}\\${name}`;
  host.fs.addDir(`${dir}\\tmp`);
  if (owner) host.fs.addFile(`${dir}\\owner.json`, JSON.stringify(owner));
  const rec = record ?? sessionRecord(dir, {
    jobs: ["Local\\pi-gui-testing-0123456789abcdef-job-00000000000000aa"],
    processes: [{ pid: 7100, created: "133000000000002000" }],
  });
  host.fs.addFile(`${dir}\\session.json`, typeof rec === "string" ? rec : JSON.stringify(rec));
  if (alive && typeof rec === "object") {
    host.world.processes.add(`${rec.helper.pid}:${rec.helper.created}`);
    for (const p of rec.processes) host.world.processes.add(`${p.pid}:${p.created}`);
    for (const j of rec.jobs) host.world.jobs.add(j);
    host.world.desktops.add(rec.desktop);
    host.world.desktopMembers = new Map([[rec.desktop, [`${rec.helper.pid}:${rec.helper.created}`, ...rec.processes.map((p) => `${p.pid}:${p.created}`)]]]);
  }
  return dir;
}

function backend(host, extra = {}) {
  return new LocalWindowsBackend({
    platform: "win32",
    env: WIN_ENV,
    fs: host.fs,
    runner: fakeWinRunner(host.world),
    spawner: winSpawner(host).spawner,
    helperDir: HELPER_DIR,
    processProbe: host.processProbe,
    genericTmpRoot: "C:\\elsewhere",
    version: "0.2.0",
    ...extra,
  });
}

const signal = () => new AbortController().signal;

test("orphan audit lists a dead owner's runtime dir and the objects its record still names; it changes nothing", async () => {
  const host = fakeWinHost();
  const dir = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a1");
  const leftovers = await backend(host).auditOrphans(signal());
  assert.deepEqual(leftovers.map((l) => `${l.kind} ${l.id}`).sort(), [
    "desktop pi-gui-testing-0123456789abcdef-abababababababababababababababab",
    "job Local\\pi-gui-testing-0123456789abcdef-job-00000000000000aa",
    "process 5000:133000000000000000",
    "process 7100:133000000000002000",
    `tempdir ${dir}`,
  ]);
  assert.equal(host.world.killed.length, 0);
  assert.equal(host.fs.has(dir), true);
  assert.equal(host.world.inspections[0].action, "audit");
});

test("orphan sweep ends a dead owner's helper, jobs, and processes, then removes the dir", async () => {
  const host = fakeWinHost();
  const dir = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a2");
  assert.deepEqual(await backend(host).sweepOrphans(signal()), []);
  assert.equal(host.fs.has(dir), false);
  assert.deepEqual(host.world.killed.sort(), ["5000:133000000000000000", "7100:133000000000002000", "Local\\pi-gui-testing-0123456789abcdef-job-00000000000000aa"].sort());
  assert.deepEqual(await backend(host).auditOrphans(signal()), []);
});

test("live owners are never touched; unknown owners are reported, never removed", async () => {
  const host = fakeWinHost();
  const live = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000b1", { owner: LIVE_OWNER });
  const noOwner = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000b2", { owner: null });
  const otherOs = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000b3", { owner: ownerRecord({ bootId: "11111111-2222-3333-4444-555555555555" }) });
  const swept = await backend(host).sweepOrphans(signal());
  assert.deepEqual(swept.map((l) => l.id).sort(), [noOwner, otherOs].sort());
  for (const l of swept) assert.match(l.detail, /owner unknown .*not removed automatically/);
  for (const dir of [live, noOwner, otherOs]) assert.equal(host.fs.has(dir), true);
  assert.equal(host.world.killed.length, 0);
  assert.equal(host.world.inspections.length, 0, "nothing of a live or unknown owner is even inspected");
});

test("when the generic session-dir scan shares the root, unknown owners and the dir line are not repeated", async () => {
  const host = fakeWinHost();
  const dead = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000c1");
  leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000c2", { owner: null, alive: false });
  const leftovers = await backend(host, { genericTmpRoot: TEMP_ROOT.toUpperCase() }).auditOrphans(signal());
  assert.equal(leftovers.some((l) => l.kind === "tempdir"), false);
  assert.ok(leftovers.some((l) => l.kind === "job"));
  assert.deepEqual(await backend(host, { genericTmpRoot: TEMP_ROOT }).sweepOrphans(signal()), []);
  assert.equal(host.fs.has(dead), false);
});

test("only package runtime dirs are considered: other names, links, and files are ignored", async () => {
  const host = fakeWinHost();
  host.fs.addDir(`${TEMP_ROOT}\\pi-gui-testing-Xy12Ab`); // a generic session dir (handled by the client scan)
  host.fs.addDir(`${TEMP_ROOT}\\pi-gui-testing-win-short`);
  host.fs.addDir("D:\\victim");
  host.fs.addFile("D:\\victim\\owner.json", JSON.stringify(DEAD_OWNER));
  host.fs.addLink(`${TEMP_ROOT}\\pi-gui-testing-win-00000000000000d1`, "D:\\victim");
  host.fs.addFile(`${TEMP_ROOT}\\pi-gui-testing-win-00000000000000d2`, "");
  assert.deepEqual(await backend(host).sweepOrphans(signal()), []);
  assert.equal(host.fs.has("D:\\victim\\owner.json"), true);
  assert.equal(host.fs.has(`${TEMP_ROOT}\\pi-gui-testing-Xy12Ab`), true);
  assert.equal(host.fs.has(`${TEMP_ROOT}\\pi-gui-testing-win-short`), true);
});

test("a forged session record is never used to end anything; the dead owner's dir is still removed", async () => {
  const host = fakeWinHost();
  const forged = (dir) =>
    sessionRecord(dir, {
      tag: "0123456789abcdef",
      jobs: ["Local\\SomeOtherProgramJob"],
      processes: [{ pid: 4, created: "1" }],
    });
  const dir = `${TEMP_ROOT}\\pi-gui-testing-win-00000000000000e1`;
  leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000e1", { record: forged(dir), alive: false });
  host.world.jobs.add("Local\\SomeOtherProgramJob");
  host.world.processes.add("4:1");
  const audit = await backend(host).auditOrphans(signal());
  assert.ok(audit.some((l) => /session record lists a job that is not the session's; its objects were not inspected/.test(l.detail)));
  assert.deepEqual(await backend(host).sweepOrphans(signal()), []);
  assert.equal(host.world.killed.length, 0);
  assert.ok(host.world.jobs.has("Local\\SomeOtherProgramJob"));
  assert.ok(host.world.processes.has("4:1"));
  assert.equal(host.fs.has(dir), false);
  assert.equal(host.world.inspections.length, 0);
});

test("a junction inside a runtime dir is removed as a link; its target survives", async () => {
  const host = fakeWinHost();
  const dir = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000f1", { alive: false });
  host.fs.addDir("C:\\Users\\tester\\Documents");
  host.fs.addFile("C:\\Users\\tester\\Documents\\thesis.docx", "precious");
  host.fs.addLink(`${dir}\\tmp\\docs`, "C:\\Users\\tester\\Documents");
  assert.deepEqual(await backend(host).sweepOrphans(signal()), []);
  assert.equal(host.fs.has(dir), false);
  assert.equal(host.fs.read("C:\\Users\\tester\\Documents\\thesis.docx"), "precious");
  assert.ok(host.fs.ops.includes(`unlink ${dir}\\tmp\\docs`));
});

test("a file that cannot be deleted keeps the dir and is reported", async () => {
  const host = fakeWinHost();
  const dir = leaveRuntimeDir(host, "pi-gui-testing-win-0000000000000101", { alive: false });
  host.fs.addFile(`${dir}\\tmp\\locked.log`, "x");
  host.fs.busy.add(host.fs.key(`${dir}\\tmp\\locked.log`));
  const left = await backend(host).sweepOrphans(signal());
  assert.equal(left.length, 1);
  assert.equal(left[0].kind, "tempdir");
  assert.match(left[0].detail, /not fully removed: .*locked\.log: EBUSY/);
  assert.equal(host.fs.has(`${dir}\\owner.json`), true, "the owner record stays, so the next sweep can still judge the dir");
  host.fs.busy.clear();
  assert.deepEqual(await backend(host).sweepOrphans(signal()), []);
});

test("audit and sweep do nothing off Windows", async () => {
  const host = fakeWinHost();
  leaveRuntimeDir(host, "pi-gui-testing-win-0000000000000201");
  const b = backend(host, { platform: "linux" });
  assert.deepEqual(await b.auditOrphans(signal()), []);
  assert.deepEqual(await b.sweepOrphans(signal()), []);
  assert.equal(host.world.inspections.length, 0);
  assert.equal(BOOT.startsWith("win32-boot-"), true);
});
