import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalWindowsBackend } from "../../../../src/backends/local-windows.ts";
import { filetimeToUnixSeconds } from "../../../../src/backends/windows/footprint.ts";
import { fakeWinHost, fakeWinRunner, ownerRecord, sessionRecord, winSpawner, BOOT, HELPER_DIR, TEMP_ROOT, WIN_ENV } from "./local-fakes.mjs";

/** The helper of the records below as the client recorded it at spawn: FILETIME 133000000000000000 is Unix second 1655526400. */
const SPAWNED_HELPER = { kind: "process", id: "5000:1655526400" };
const DEAD_OWNER = ownerRecord({ pid: 777, processStartTime: "1761000000", resources: [SPAWNED_HELPER] });
const LIVE_OWNER = ownerRecord();

/**
 * The dead client's own session dir (outside the runtime dir): its `owner.json`
 * lists the runtime dir and the helper it spawned. Only this record authorizes
 * the sweep to end a helper by PID.
 */
function leaveClientRecord(host, runtimeDir, { name = `pi-gui-testing-${runtimeDir.slice(-6)}`, owner = DEAD_OWNER, resources = [{ kind: "tempdir", id: runtimeDir }, SPAWNED_HELPER] } = {}) {
  const dir = `${TEMP_ROOT}\\${name}`;
  host.fs.addFile(`${dir}\\owner.json`, JSON.stringify({ ...owner, resources }));
  return dir;
}

/** The job name of a runtime dir's session: its tag is the dir's own hex digits. */
const jobOf = (dir, n = "aa") => `Local\\pi-gui-testing-${dir.slice(-16)}-job-${n.padStart(16, "0")}`;

/** A runtime dir left by a session: owner copy, session.json, optional live objects in the world (the app in its job). */
function leaveRuntimeDir(host, name, { owner = DEAD_OWNER, record, alive = true } = {}) {
  const dir = `${TEMP_ROOT}\\${name}`;
  host.fs.addDir(`${dir}\\tmp`);
  if (owner) host.fs.addFile(`${dir}\\owner.json`, JSON.stringify(owner));
  const rec = record ?? sessionRecord(dir, {
    helper: { pid: 5000, created: "133000000000000000" },
    jobs: [jobOf(dir)],
    processes: [{ pid: 7100, created: "133000000000002000" }],
  });
  host.fs.addFile(`${dir}\\session.json`, typeof rec === "string" ? rec : JSON.stringify(rec));
  if (alive && typeof rec === "object") {
    host.world.processes.add(`${rec.helper.pid}:${rec.helper.created}`);
    for (const p of rec.processes) host.world.processes.add(`${p.pid}:${p.created}`);
    for (const j of rec.jobs) host.world.jobs.add(j);
    host.world.jobMembers = new Map(rec.jobs.map((j) => [j, rec.processes.map((p) => `${p.pid}:${p.created}`)]));
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
    "desktop pi-gui-testing-00000000000000a1-abababababababababababababababab",
    `job ${jobOf(dir)}`,
    "process 5000:133000000000000000",
    "process 7100:133000000000002000",
    `tempdir ${dir}`,
  ]);
  assert.equal(host.world.killed.length, 0);
  assert.equal(host.fs.has(dir), true);
  assert.equal(host.world.inspections[0].action, "audit");
});

test("orphan sweep ends a dead owner's jobs (with their apps) and the helper its client record lists, then removes the dir", async () => {
  const host = fakeWinHost();
  const dir = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a2");
  leaveClientRecord(host, dir);
  assert.deepEqual(await backend(host).sweepOrphans(signal()), []);
  assert.equal(host.fs.has(dir), false);
  // The app process ended with its job; only the helper the owner recorded at spawn is ended by PID.
  assert.deepEqual(host.world.killed.sort(), ["5000:133000000000000000", jobOf(dir)].sort());
  const request = host.world.inspections[0];
  assert.deepEqual(request.processes.map((p) => `${p.pid}:${p.kill === true}`), ["5000:true", "7100:false"]);
  assert.deepEqual(await backend(host).auditOrphans(signal()), []);
});

test("a recorded process outside the session's jobs is reported, never ended; the dir stays", async () => {
  const host = fakeWinHost();
  const dir = `${TEMP_ROOT}\\pi-gui-testing-win-00000000000000a3`;
  // Review A-F2: a record (any app of the session can write it) naming an unrelated process of the user.
  const victim = { pid: 12345, created: "133000000123456789" };
  leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a3", { record: sessionRecord(dir, { jobs: [], processes: [victim] }), alive: false });
  host.world.processes.add(`${victim.pid}:${victim.created}`);
  const left = await backend(host).sweepOrphans(signal());
  assert.equal(host.world.killed.length, 0);
  assert.ok(host.world.processes.has(`${victim.pid}:${victim.created}`));
  assert.ok(left.some((l) => l.kind === "process" && l.id === `${victim.pid}:${victim.created}` && /app process \(orphan\) still exists/.test(l.detail)));
  assert.equal(host.fs.has(dir), true);
});

test("the runtime dir's owner copy never authorizes a kill: a forged copy naming another process ends nothing", async () => {
  const host = fakeWinHost();
  // Review WG1: an app rewrites both files of its runtime dir; the owner copy claims the victim as the spawned helper.
  const victim = { pid: 12345, created: "133000000123456789" };
  const dir = `${TEMP_ROOT}\\pi-gui-testing-win-1123456789abcdef`;
  const forgedOwner = ownerRecord({ pid: 777, processStartTime: "1761000000", resources: [{ kind: "process", id: `${victim.pid}:${filetimeToUnixSeconds(victim.created)}` }] });
  leaveRuntimeDir(host, "pi-gui-testing-win-1123456789abcdef", { owner: forgedOwner, record: sessionRecord(dir, { helper: victim, jobs: [], processes: [] }), alive: false });
  host.world.processes.add(`${victim.pid}:${victim.created}`);
  const left = await backend(host).sweepOrphans(signal());
  assert.equal(host.world.killed.length, 0, "no client session record lists the dir, so nothing is ended by PID");
  assert.ok(host.world.processes.has(`${victim.pid}:${victim.created}`));
  assert.deepEqual(host.world.inspections[0].processes.map((p) => p.kill === true), [false]);
  assert.ok(left.some((l) => l.kind === "process" && l.id === `${victim.pid}:${victim.created}` && /GUI helper process \(orphan\) still exists/.test(l.detail)));
  assert.equal(host.fs.has(dir), true);
});

test("without its client record (already swept) the dead owner's jobs end, the helper is only reported", async () => {
  const host = fakeWinHost();
  const dir = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a4");
  const left = await backend(host).sweepOrphans(signal());
  assert.deepEqual(host.world.killed, [jobOf(dir)]);
  assert.deepEqual(left.map((l) => `${l.kind} ${l.id}`), ["process 5000:133000000000000000", "desktop pi-gui-testing-00000000000000a4-abababababababababababababababab", `tempdir ${dir}`]);
  assert.equal(host.fs.has(dir), true, "kept until the helper is gone");
});

test("client records decide: a live client owner keeps the dir, a record in a runtime dir or a duplicate claim authorizes nothing", async () => {
  const host = fakeWinHost();
  // The runtime copy says dead, the client's own record says alive: nothing is touched.
  const live = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a5");
  leaveClientRecord(host, live, { owner: LIVE_OWNER });
  // Another runtime dir's owner.json (app-writable) claiming this dir is not a client record.
  const claimed = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a6", { alive: false });
  leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a7", { owner: ownerRecord({ ...DEAD_OWNER, resources: [{ kind: "tempdir", id: claimed }, SPAWNED_HELPER] }), alive: false });
  // Two client records claiming one dir: its owner is unknown.
  const twice = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000a8", { alive: false });
  leaveClientRecord(host, twice, { name: "pi-gui-testing-Dup001" });
  leaveClientRecord(host, twice, { name: "pi-gui-testing-Dup002" });
  host.world.processes.add("5000:133000000000000000");
  const left = await backend(host).sweepOrphans(signal());
  assert.equal(host.fs.has(live), true);
  assert.equal(host.fs.has(twice), true);
  assert.ok(left.some((l) => l.id === twice && /owner unknown \(2 client session records list it/.test(l.detail)));
  assert.equal(host.world.killed.includes("5000:133000000000000000"), false);
  assert.ok(host.world.inspections.every((i) => i.processes.every((p) => p.kill !== true)));
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

test("unknown owners and dead owners' dirs are reported by this backend: the generic session-dir scan skips runtime dirs", async () => {
  const host = fakeWinHost();
  const dead = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000c1");
  leaveClientRecord(host, dead);
  const noOwner = leaveRuntimeDir(host, "pi-gui-testing-win-00000000000000c2", { owner: null, alive: false });
  const leftovers = await backend(host).auditOrphans(signal());
  assert.ok(leftovers.some((l) => l.kind === "tempdir" && l.id === dead));
  assert.ok(leftovers.some((l) => l.kind === "tempdir" && l.id === noOwner && /owner unknown/.test(l.detail)));
  assert.ok(leftovers.some((l) => l.kind === "job"));
  const swept = await backend(host).sweepOrphans(signal());
  assert.deepEqual(swept.map((l) => l.id), [noOwner]);
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
  assert.ok(audit.some((l) => /session record has another session's tag; its objects were not inspected/.test(l.detail)));
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
