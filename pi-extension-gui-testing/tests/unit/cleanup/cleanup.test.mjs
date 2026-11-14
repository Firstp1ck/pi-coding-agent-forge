import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createClientId,
  createOwnerIdentity,
  ownerLiveness,
  readBootId,
  readProcessStartTime,
} from "../../../src/cleanup/identity.ts";
import {
  createSessionDir,
  parseProcessResourceId,
  processResourceId,
  readOwnerRecord,
  writeOwnerRecord,
} from "../../../src/cleanup/session-dir.ts";
import { auditClientOrphans, auditSession, scanSessionDirs, sweepClientOrphans } from "../../../src/cleanup/sweep.ts";
import { installExitCleanup, runExitCleanupSync } from "../../../src/cleanup/exit.ts";
import { OWNER_FILE } from "../../../src/owner.ts";

const BOOT = "11111111-2222-3333-4444-555555555555";

/** Fake /proc with a boot id and processes `{pid: startTime}`; the comm field contains spaces and ')' on purpose. */
async function fakeProc(root, processes, bootId = BOOT) {
  await mkdir(join(root, "sys", "kernel", "random"), { recursive: true });
  if (bootId !== null) await writeFile(join(root, "sys", "kernel", "random", "boot_id"), `${bootId}\n`);
  for (const [pid, start] of Object.entries(processes)) {
    await mkdir(join(root, pid), { recursive: true });
    const fields = ["S", "1", ...Array.from({ length: 17 }, (_, i) => String(i)), String(start), "0", "0"];
    await writeFile(join(root, pid, "stat"), `${pid} (pi (node) x) ${fields.join(" ")}\n`);
  }
}

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-cleanup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proc = join(root, "proc");
  const tmp = join(root, "tmp");
  await mkdir(tmp);
  return { root, proc, tmp };
}

function record(overrides = {}) {
  return {
    version: 1,
    pid: 100,
    processStartTime: "5000",
    bootId: BOOT,
    clientId: "c1",
    piSessionId: "pi-session",
    backend: "docker-linux",
    createdAt: "2026-10-24T00:00:00.000Z",
    resources: [],
    ...overrides,
  };
}

async function ownerDir(tmp, name, content) {
  const dir = join(tmp, `pi-gui-testing-${name}`);
  await mkdir(dir, { mode: 0o700 });
  if (content !== undefined) await writeFile(join(dir, OWNER_FILE), typeof content === "string" ? content : JSON.stringify(content));
  return dir;
}

test("reads this process's real identity from /proc", () => {
  const start = readProcessStartTime(process.pid);
  assert.match(start, /^\d+$/);
  assert.match(readBootId(), /^[0-9a-f-]{36}$/);
  const id = createOwnerIdentity();
  assert.equal(id.pid, process.pid);
  assert.equal(id.processStartTime, start);
  assert.notEqual(createClientId(), createClientId());
  assert.equal(ownerLiveness(id), "alive");
});

test("liveness: alive, other boot, missing PID, PID reuse, unreadable data", async (t) => {
  const { proc } = await scratch(t);
  await fakeProc(proc, { 100: 5000, 200: 9999 });
  assert.equal(readProcessStartTime(100, proc), "5000", "parses field 22 despite spaces and ')' in comm");
  assert.equal(ownerLiveness({ pid: 100, processStartTime: "5000", bootId: BOOT }, proc), "alive");
  assert.equal(ownerLiveness({ pid: 100, processStartTime: "5000", bootId: "other-boot" }, proc), "dead");
  assert.equal(ownerLiveness({ pid: 300, processStartTime: "5000", bootId: BOOT }, proc), "dead");
  assert.equal(ownerLiveness({ pid: 200, processStartTime: "5000", bootId: BOOT }, proc), "dead", "PID reused with a different start time");

  await writeFile(join(proc, "200", "stat"), "garbage");
  assert.equal(ownerLiveness({ pid: 200, processStartTime: "5000", bootId: BOOT }, proc), "unknown");
  const noBoot = join(proc, "..", "proc2");
  await fakeProc(noBoot, { 100: 5000 }, null);
  assert.equal(ownerLiveness({ pid: 100, processStartTime: "5000", bootId: BOOT }, noBoot), "unknown");
});

test("createSessionDir: mode 0700, atomic owner.json, recordResource before creation, idempotent removal", async (t) => {
  const { tmp } = await scratch(t);
  const identity = { clientId: "c1", pid: 100, processStartTime: "5000", bootId: BOOT };
  const dir = await createSessionDir({ identity, piSessionId: "s", backend: "docker-linux", tmpRoot: tmp, now: () => new Date("2026-10-24T00:00:00Z") });
  assert.match(dir.path, /pi-gui-testing-[A-Za-z0-9]{6}$/);
  assert.equal((await stat(dir.path)).mode & 0o777, 0o700);
  assert.equal(dir.ownerLabel, `c1:100:5000:${BOOT}`);
  let read = await readOwnerRecord(dir.path);
  assert.deepEqual(read, { ok: true, record: record({ piSessionId: "s" }) });

  await Promise.all([dir.recordResource("container", "abc"), dir.recordResource("process", "42:7"), dir.recordResource("container", "abc")]);
  read = await readOwnerRecord(dir.path);
  assert.deepEqual(read.record.resources, [{ kind: "container", id: "abc" }, { kind: "process", id: "42:7" }]);
  assert.deepEqual(dir.resources, read.record.resources);
  assert.deepEqual(await readdir(dir.path), [OWNER_FILE], "no temp files left behind");
  assert.equal((await stat(join(dir.path, OWNER_FILE))).mode & 0o777, 0o600);

  await dir.remove();
  await dir.remove();
  assert.equal(existsSync(dir.path), false);
  await assert.rejects(dir.recordResource("container", "late"), /already removed/);
});

test("process resource ids carry the start time", () => {
  const id = processResourceId(process.pid);
  assert.deepEqual(parseProcessResourceId(id), { pid: process.pid, startTime: readProcessStartTime(process.pid) });
  assert.equal(parseProcessResourceId("42"), undefined);
  assert.equal(parseProcessResourceId("0:1"), undefined);
});

test("malformed, partial, or unknown-version owner records are reported as unknown", async (t) => {
  const { proc, tmp } = await scratch(t);
  await fakeProc(proc, {});
  await ownerDir(tmp, "missing");
  await ownerDir(tmp, "broken", "{ nope");
  await ownerDir(tmp, "partial", { version: 1, pid: 100 });
  await ownerDir(tmp, "future", record({ version: 2 }));
  await ownerDir(tmp, "badres", record({ resources: [{ kind: "container" }] }));
  const infos = await scanSessionDirs({ tmpRoot: tmp, procRoot: proc });
  assert.equal(infos.length, 5);
  assert.ok(infos.every((i) => i.liveness === "unknown" && i.reason), JSON.stringify(infos));
  const reasons = infos.map((i) => i.reason).join("\n");
  assert.match(reasons, /owner\.json missing/);
  assert.match(reasons, /unknown version 2/);
  assert.match(reasons, /malformed resource entry/);
});

test("the sweep removes only dead owners' dirs, kills their recorded processes after re-checking start time, and never touches live or unknown owners", async (t) => {
  const { proc, tmp } = await scratch(t);
  // 100 = live owner; 200 = PID reused (dead owner); 300 = gone. Processes: 400 still matches, 500 reused.
  await fakeProc(proc, { 100: 5000, 200: 1, 400: 777, 500: 2 });
  const live = await ownerDir(tmp, "live", record({ resources: [{ kind: "process", id: "400:777" }] }));
  const reused = await ownerDir(tmp, "reused", record({ pid: 200, processStartTime: "6000", resources: [{ kind: "process", id: "400:777" }, { kind: "process", id: "500:888" }, { kind: "container", id: "c-1" }] }));
  const gone = await ownerDir(tmp, "gone", record({ pid: 300 }));
  const rebooted = await ownerDir(tmp, "rebooted", record({ bootId: "old-boot" }));
  const unknown = await ownerDir(tmp, "unknown", "{");
  await writeFile(join(tmp, "pi-gui-testing-file"), "not a dir");

  const killed = [];
  const sweeperCalls = [];
  const report = await sweepClientOrphans({
    tmpRoot: tmp,
    procRoot: proc,
    signal: new AbortController().signal,
    kill: (pid, signal) => killed.push([pid, signal]),
    sweepers: [
      { id: "docker-linux", sweepOrphans: async () => (sweeperCalls.push("docker"), [{ kind: "container", id: "stuck", detail: "rm failed" }]) },
      { id: "broken", sweepOrphans: async () => { throw new Error("docker not running"); } },
    ],
  });
  assert.deepEqual(killed, [[400, "SIGKILL"]], "only the process whose start time still matches");
  assert.deepEqual(report.killed, ["400:777"]);
  assert.deepEqual(report.removedDirs.sort(), [gone, rebooted, reused].sort());
  assert.ok(existsSync(live), "live owner untouched");
  assert.ok(existsSync(unknown), "unknown owner untouched");
  assert.equal(report.unknown.length, 1);
  assert.equal(report.unknown[0].id, unknown);
  assert.deepEqual(sweeperCalls, ["docker"]);
  assert.deepEqual(report.leftovers, [
    { kind: "container", id: "stuck", detail: "rm failed" },
    { kind: "sweeper", id: "broken", detail: "sweep failed: docker not running" },
  ]);

  const again = await sweepClientOrphans({ tmpRoot: tmp, procRoot: proc, signal: new AbortController().signal, kill: () => {} });
  assert.deepEqual(again.removedDirs, [], "idempotent");
});

test("a dir whose recorded process cannot be killed is kept for the next sweep", async (t) => {
  const { proc, tmp } = await scratch(t);
  await fakeProc(proc, { 400: 777 });
  const dead = await ownerDir(tmp, "dead", record({ pid: 300, resources: [{ kind: "process", id: "400:777" }, { kind: "process", id: "bogus" }] }));
  const report = await sweepClientOrphans({
    tmpRoot: tmp,
    procRoot: proc,
    signal: new AbortController().signal,
    kill: () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    },
  });
  assert.ok(existsSync(dead));
  assert.deepEqual(report.leftovers.map((l) => l.kind), ["process", "process", "tempdir"]);
  assert.match(report.leftovers[0].detail, /kill failed/);
  assert.match(report.leftovers[1].detail, /malformed/);
});

test("audits: session scope reports its dir and live processes; orphan scope skips live owners", async (t) => {
  const { proc, tmp } = await scratch(t);
  await fakeProc(proc, { 100: 5000, 400: 777 });
  const live = await ownerDir(tmp, "live", record());
  await ownerDir(tmp, "dead", record({ pid: 300, resources: [{ kind: "process", id: "400:777" }, { kind: "process", id: "401:1" }] }));
  await ownerDir(tmp, "weird");

  const session = await auditSession({ path: live, resources: [{ kind: "process", id: "400:777" }, { kind: "container", id: "x" }] }, proc);
  assert.deepEqual(session.map((l) => [l.kind, l.id]), [["tempdir", live], ["process", "400:777"]]);
  assert.deepEqual(await auditSession({ path: join(tmp, "gone"), resources: [] }, proc), []);

  const orphans = await auditClientOrphans({ tmpRoot: tmp, procRoot: proc });
  const ids = orphans.map((l) => `${l.kind}:${l.id.replace(tmp, "")}`).sort();
  assert.deepEqual(ids, ["process:400:777", "tempdir:/pi-gui-testing-dead", "tempdir:/pi-gui-testing-weird"]);
  assert.ok(!orphans.some((l) => l.id === live));
});

test("the generic sweep leaves local-windows runtime dirs to their backend, which still reads their records (review B-F4)", async (t) => {
  const { proc, tmp } = await scratch(t);
  await fakeProc(proc, {});
  // A dead owner's Windows runtime dir in the generic temp root (on Windows, os.tmpdir() is %LOCALAPPDATA%\\Temp).
  const runtime = join(tmp, "pi-gui-testing-win-0123456789abcdef");
  await mkdir(runtime);
  await writeFile(join(runtime, OWNER_FILE), JSON.stringify(record({ pid: 300, backend: "local-windows" })));
  await writeFile(join(runtime, "session.json"), JSON.stringify({ jobs: ["Local\\pi-gui-testing-0123456789abcdef-job-0000000000000001"] }));
  // An ordinary dead session dir next to it is still the generic sweep's.
  const generic = await ownerDir(tmp, "AbC123", record({ pid: 300 }));
  let backendSawRecord;
  const report = await sweepClientOrphans({
    tmpRoot: tmp,
    procRoot: proc,
    signal: new AbortController().signal,
    kill: () => {},
    sweepers: [{ id: "local-windows", sweepOrphans: async () => ((backendSawRecord = existsSync(join(runtime, "session.json"))), []) }],
  });
  assert.equal(backendSawRecord, true, "the backend sweeper still finds the session record");
  assert.deepEqual(report.removedDirs, [generic]);
  assert.ok(existsSync(runtime));
  assert.deepEqual((await scanSessionDirs({ tmpRoot: tmp, procRoot: proc })).map((d) => d.path), [], "nothing left for the generic scan");
  assert.equal((await auditClientOrphans({ tmpRoot: tmp, procRoot: proc })).some((l) => l.id === runtime), false, "reported by the backend's audit, not twice");
  // Names that only look similar stay generic.
  const lookalike = await ownerDir(tmp, "win-short", record({ pid: 300 }));
  assert.deepEqual((await sweepClientOrphans({ tmpRoot: tmp, procRoot: proc, signal: new AbortController().signal, kill: () => {} })).removedDirs, [lookalike]);
});

test("scanSessionDirs tolerates a missing tmp root", async () => {
  assert.deepEqual(await scanSessionDirs({ tmpRoot: "/nonexistent/gui-test-root" }), []);
});

test("writeOwnerRecord replaces atomically", async (t) => {
  const { tmp } = await scratch(t);
  await writeOwnerRecord(tmp, record());
  await writeOwnerRecord(tmp, record({ pid: 101 }));
  assert.equal(JSON.parse(await readFile(join(tmp, OWNER_FILE), "utf8")).pid, 101);
  assert.deepEqual(await readdir(tmp), [OWNER_FILE]);
});

test("exit cleanup runs bounded synchronous commands and removes dirs; never throws", async (t) => {
  const { root } = await scratch(t);
  const marker = join(root, "marker");
  const dir = join(root, "leftover");
  await mkdir(dir);
  const started = Date.now();
  runExitCleanupSync(
    {
      commands: () => [
        // sh starts in milliseconds; a node child could need more than the bound on a loaded host.
        ["/bin/sh", "-c", 'printf ran > "$1"', "sh", marker],
        [process.execPath, "-e", "setTimeout(() => {}, 60000)"],
        ["/nonexistent/binary"],
        [],
      ],
      dirs: () => [dir],
    },
    1_000,
  );
  assert.ok(Date.now() - started < 5000, "hanging command bounded");
  assert.equal(await readFile(marker, "utf8"), "ran");
  assert.equal(existsSync(dir), false);
  runExitCleanupSync({ commands: () => { throw new Error("boom"); } });

  const before = process.listenerCount("exit");
  const sigintBefore = process.listenerCount("SIGINT");
  const uninstall = installExitCleanup({ commands: () => [] });
  assert.equal(process.listenerCount("exit"), before + 1);
  assert.equal(process.listenerCount("SIGINT"), sigintBefore, "no SIGINT handler is installed");
  uninstall();
  assert.equal(process.listenerCount("exit"), before);
});

test("the exit handler fires on real process exit", async (t) => {
  const { root } = await scratch(t);
  const marker = join(root, "exit-marker");
  const script = `
    const { installExitCleanup } = await import(${JSON.stringify(new URL("../../../src/cleanup/exit.ts", import.meta.url).href)});
    installExitCleanup({ commands: () => [[process.execPath, "-e", 'require("fs").writeFileSync(${JSON.stringify(marker)}, "x")']] });
    process.exit(0);
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], { stdio: "ignore" });
    child.on("exit", resolve);
    child.on("error", reject);
  });
  assert.equal(await readFile(marker, "utf8"), "x");
});
