/**
 * The remote session-dir scripts, executed for real through a loopback `ssh`
 * (sandboxed XDG_RUNTIME_DIR/HOME, fake uid): creation in a private 0700
 * root, refusal of a symlinked root, removal with tagged processes (cmdline
 * and environment), read-only audit, orphan decisions and sweep, and the
 * bounded exit-handler argv.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SshTransport } from "../../../../src/transport/ssh/transport.ts";
import {
  auditRemoteOrphans,
  auditRemoteSession,
  createRemoteSessionDir,
  decideOrphans,
  listRemoteSessions,
  remoteSessionName,
  removeRemoteSessions,
  sessionWrappedArgv,
  sweepRemoteOrphans,
} from "../../../../src/backends/remote/session-dir.ts";
import { RemoteResources } from "../../../../src/backends/remote/resources.ts";
import { loopbackSsh } from "../../transport/ssh/fake-ssh.mjs";
import { BOOT, fakeProc } from "../fakes.mjs";

const OWNER_DEAD = `c1:999999:123:${BOOT}`;
const OWNER_ALIVE = `c2:4321:777:${BOOT}`;
const OWNER_FOREIGN = "c3:55:66:ffffffff-0000-0000-0000-000000000000";

async function sandbox(t) {
  const root = await mkdtemp("/tmp/pgt-lb-");
  const lb = await loopbackSsh(root);
  const transport = new SshTransport({ destination: "loop", ssh: lb.ssh });
  const procRoot = join(root, "proc");
  fakeProc(procRoot, { 4321: 777 });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    // The symlinked-root case falls back to the /tmp candidate of the fake uid.
    const fallback = "/tmp/pi-gui-testing-4242424";
    if ((await lstat(fallback).catch(() => undefined))?.uid === process.getuid()) await rm(fallback, { recursive: true, force: true });
  });
  return { root, lb, transport, procRoot, base: join(lb.xdg, "pi-gui-testing") };
}

function create(transport, name, owner = OWNER_DEAD) {
  return createRemoteSessionDir(transport.runner, { name, ownerLabel: owner, sessionId: "gui-test", backend: "remote-linux" });
}

/** A local process tagged with `dir`: through its environment or its command line. */
function tagged(dir, how) {
  const child =
    how === "env"
      ? spawn("sleep", ["60"], { env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: `${dir}/run/xdg` }, stdio: "ignore", detached: true })
      : spawn("/bin/sh", ["-c", "sleep 60; true", `${dir}/tooling/helper`], { stdio: "ignore", detached: true });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { child, exited };
}

test("createRemoteSessionDir: private dir in the first usable root, owner record, layout", async (t) => {
  const s = await sandbox(t);
  const name = remoteSessionName("gui-abc");
  assert.match(name, /^s-gui-abc-[0-9a-f]{8}$/);
  const remote = await create(s.transport, name);
  assert.equal(remote.base, s.base);
  assert.equal(remote.dir, join(s.base, name));
  assert.equal(remote.workspace, join(remote.dir, "workspace"));
  assert.equal(remote.displays, join(s.base, "displays"));
  assert.equal(remote.uid, 4242424, "uid as the remote reports it");
  for (const dir of [s.base, remote.dir, remote.run, remote.workspace, remote.tooling, remote.displays]) {
    assert.equal(((await stat(dir)).mode & 0o777).toString(8), "700", dir);
  }
  const info = await stat(remote.workspace, { bigint: true });
  assert.equal(remote.workspaceId, `${info.dev} ${info.ino}`);
  assert.match(await readFile(join(remote.dir, "owner"), "utf8"), new RegExp(`^owner=${OWNER_DEAD}\nsession=gui-test\nbackend=remote-linux\ncreated=`));
  assert.ok(remote.freeKb > 0);
  await assert.rejects(create(s.transport, name), /cannot create/, "an existing dir is never reused");
  await assert.rejects(create(s.transport, "../evil"), /invalid remote session name/);
});

test("a symlinked session root is never used", async (t) => {
  const s = await sandbox(t);
  const elsewhere = join(s.root, "elsewhere");
  await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, s.base);
  const remote = await create(s.transport, remoteSessionName("gui-link"));
  assert.notEqual(remote.base, s.base);
  assert.notEqual(remote.base, elsewhere);
  assert.equal(remote.base, "/tmp/pi-gui-testing-4242424");
});

test("removeRemoteSessions kills tagged processes, removes the dir and the empty root; audit is then empty", async (t) => {
  const s = await sandbox(t);
  const name = remoteSessionName("gui-rm");
  const remote = await create(s.transport, name);
  const byEnv = tagged(remote.dir, "env");
  const byArgv = tagged(remote.dir, "argv");
  const untagged = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  t.after(() => untagged.kill("SIGKILL"));
  await new Promise((r) => setTimeout(r, 200));

  const audit = await auditRemoteSession(s.transport.runner, name, { destination: "loop" });
  assert.ok(audit.some((l) => l.kind === "remote-dir" && l.id === `loop:${remote.dir}`));
  const procs = audit.filter((l) => l.kind === "remote-process").map((l) => l.id);
  assert.ok(procs.includes(`loop:${byEnv.child.pid}`), "tagged through the environment");
  assert.ok(procs.includes(`loop:${byArgv.child.pid}`), "tagged through the command line");
  assert.equal(procs.includes(`loop:${untagged.pid}`), false);

  const left = await removeRemoteSessions(s.transport.runner, [name], { destination: "loop" });
  assert.deepEqual(left, []);
  await byEnv.exited;
  await byArgv.exited;
  assert.equal(untagged.exitCode, null, "an unrelated process is untouched");
  await assert.rejects(stat(remote.dir));
  await assert.rejects(stat(s.base), "the empty root is removed too");
  assert.deepEqual(await auditRemoteSession(s.transport.runner, name, { destination: "loop" }), []);
  assert.deepEqual(await removeRemoteSessions(s.transport.runner, [name], { destination: "loop" }), [], "idempotent");
});

test("removal keeps the root while another session lives in it", async (t) => {
  const s = await sandbox(t);
  const a = await create(s.transport, remoteSessionName("gui-a"));
  const b = await create(s.transport, remoteSessionName("gui-b"));
  assert.deepEqual(await removeRemoteSessions(s.transport.runner, [a.name], { destination: "loop", mode: "fast" }), []);
  await stat(b.dir);
  await stat(b.displays);
});

test("an unreachable host leaves one leftover per dir; the audit reports it as failed", async (t) => {
  const s = await sandbox(t);
  const name = remoteSessionName("gui-down");
  await create(s.transport, name);
  await writeFile(join(s.root, "unreachable"), "");
  const left = await removeRemoteSessions(s.transport.runner, [name], { destination: "loop" });
  assert.equal(left.length, 1);
  assert.equal(left[0].kind, "remote-dir");
  assert.match(left[0].detail, /removal failed \(exit 255: .*Connection refused/);
  const audit = await auditRemoteSession(s.transport.runner, name, { destination: "loop" });
  assert.equal(audit[0].kind, "audit");
});

test("orphans: dead owners of this boot are swept; live, foreign, and unknown owners are not", async (t) => {
  const s = await sandbox(t);
  const dead = await create(s.transport, remoteSessionName("gui-dead"), OWNER_DEAD);
  const alive = await create(s.transport, remoteSessionName("gui-alive"), OWNER_ALIVE);
  const foreign = await create(s.transport, remoteSessionName("gui-foreign"), OWNER_FOREIGN);
  const oldForeign = await create(s.transport, remoteSessionName("gui-oldforeign"), OWNER_FOREIGN);
  const unknown = await create(s.transport, remoteSessionName("gui-unknown"), "not-a-label");
  const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  await utimes(oldForeign.dir, old, old);
  const busyForeign = await create(s.transport, remoteSessionName("gui-busy"), OWNER_FOREIGN);
  await utimes(busyForeign.dir, old, old);
  const busy = tagged(busyForeign.dir, "env");
  t.after(() => busy.child.kill("SIGKILL"));
  await new Promise((r) => setTimeout(r, 200));

  const entries = await listRemoteSessions(s.transport.runner);
  assert.equal(entries.length, 6);
  const decisions = Object.fromEntries(decideOrphans(entries, s.procRoot).map((d) => [d.entry.name, d.action]));
  assert.deepEqual(decisions, {
    [dead.name]: "remove",
    [alive.name]: "keep",
    [foreign.name]: "report",
    [oldForeign.name]: "remove",
    [unknown.name]: "report",
    [busyForeign.name]: "keep",
  });
  const audit = await auditRemoteOrphans(s.transport.runner, { destination: "loop", procRoot: s.procRoot });
  assert.equal(audit.length, 4, "audit lists removable and reported dirs");
  await stat(dead.dir);

  const leftovers = await sweepRemoteOrphans(s.transport.runner, { destination: "loop", procRoot: s.procRoot });
  assert.deepEqual(leftovers.map((l) => l.id.split("/").at(-1)).sort(), [foreign.name, unknown.name].sort());
  await assert.rejects(stat(dead.dir));
  await assert.rejects(stat(oldForeign.dir));
  for (const kept of [alive, foreign, unknown, busyForeign]) await stat(kept.dir);
});

test("the exit-handler argv removes the dir and kills its processes within 5 s", async (t) => {
  const s = await sandbox(t);
  const name = remoteSessionName("gui-exit");
  const remote = await create(s.transport, name);
  const proc = tagged(remote.dir, "env");
  await new Promise((r) => setTimeout(r, 200));
  const resources = new RemoteResources({ transport: s.transport, auditTransport: s.transport, name });
  const argv = resources.exitArgv();
  const started = Date.now();
  const result = spawnSync(argv[0], argv.slice(1), { timeout: 5_000, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(Date.now() - started < 5_000);
  await proc.exited;
  await assert.rejects(stat(remote.dir));
});

/**
 * A stand-in for the helper (or `docker run`): writes session data, leaves a
 * process tagged with the session dir behind (as a crashed helper would), says
 * READY, and exits at stdin EOF, which is what a dropped SSH connection looks
 * like on the remote host.
 */
const STUB = `#!/bin/sh
mkdir -p "$D/deps/lib" && echo cached > "$D/deps/lib/pkg.txt" && echo work > "$D/workspace/out.txt" || exit 9
XDG_RUNTIME_DIR="$D/run/xdg" sleep 60 </dev/null >/dev/null 2>&1 &
echo $! > "$PIDFILE"
echo READY
cat >/dev/null
exit 0
`;

/** Starts the stub under the session wrapper through the loopback ssh; resolves once it is READY. */
async function wrapped(s, remote) {
  await writeFile(join(remote.tooling, "stub"), STUB, { mode: 0o700 });
  const pidFile = join(s.root, `stub-${remote.name}.pid`);
  const child = s.transport.spawnHelper(sessionWrappedArgv(remote, ["/bin/sh", join(remote.tooling, "stub")]), { D: remote.dir, PIDFILE: pidFile });
  const exited = child.exited;
  let out = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`stub not ready: ${out}`)), 10_000);
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
    void child.exited.then(() => reject(new Error(`stub exited early: ${out}`)));
  });
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  return { child, exited, pid };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function within(promise, ms, what) {
  let timer;
  const bound = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms)));
  try {
    return await Promise.race([promise, bound]);
  } finally {
    clearTimeout(timer);
  }
}

test("V4: a dropped connection (stdin EOF) makes the remote host remove the session dir and its leftover processes itself", async (t) => {
  const s = await sandbox(t);
  const remote = await create(s.transport, remoteSessionName("gui-drop"));
  const run = await wrapped(s, remote);
  t.after(() => alive(run.pid) && process.kill(run.pid, "SIGKILL"));
  await stat(join(remote.dir, "deps", "lib", "pkg.txt"));
  // The SSH channel closes: no stop, no teardown call, no further client command.
  run.child.stdin.end();
  await within(run.exited, 15_000, "the wrapper");
  await assert.rejects(stat(remote.dir), "workspace, tooling, and deps are gone");
  assert.equal(alive(run.pid), false, "the leftover tagged process was ended");
  assert.deepEqual(await auditRemoteSession(s.transport.runner, remote.name, { destination: "loop" }), []);
});

test("V4: the wrapper removes only a package-made session dir (mode 0700, owner record, no symlink)", async (t) => {
  const s = await sandbox(t);
  const cases = [
    ["mode 0755", async (r) => spawnSync("chmod", ["0755", r.dir])],
    ["no owner record", async (r) => rm(join(r.dir, "owner"))],
    ["owner record without an owner line", async (r) => writeFile(join(r.dir, "owner"), "something else\n")],
  ];
  for (const [what, spoil] of cases) {
    const remote = await create(s.transport, remoteSessionName("gui-keep"));
    const run = await wrapped(s, remote);
    t.after(() => alive(run.pid) && process.kill(run.pid, "SIGKILL"));
    await spoil(remote);
    run.child.stdin.end();
    await within(run.exited, 15_000, `the wrapper (${what})`);
    await stat(join(remote.dir, "workspace", "out.txt")).catch(() => assert.fail(`${what}: the dir must stay`));
    process.kill(run.pid, "SIGKILL");
  }

  // A symlink in place of the session dir: never followed.
  const real = await create(s.transport, remoteSessionName("gui-real"));
  const linkName = remoteSessionName("gui-link");
  const link = join(real.base, linkName);
  await symlink(real.dir, link);
  const fake = { ...real, name: linkName, dir: link };
  const pidFile = join(s.root, "link.pid");
  await writeFile(join(real.tooling, "stub"), STUB, { mode: 0o700 });
  const child = s.transport.spawnHelper(sessionWrappedArgv(fake, ["/bin/sh", join(real.tooling, "stub")]), { D: real.dir, PIDFILE: pidFile });
  const exited = child.exited;
  child.stdout.once("data", () => child.stdin.end());
  await within(exited, 15_000, "the wrapper (symlink)");
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  if (alive(pid)) process.kill(pid, "SIGKILL");
  await stat(join(real.dir, "owner"));
  assert.ok((await lstat(link)).isSymbolicLink(), "the symlink is left alone");

  assert.throws(() => sessionWrappedArgv({ dir: "/x/s-a-1", name: "s-b-2" }, ["true"]), /does not end in/);
  assert.throws(() => sessionWrappedArgv({ dir: "/x/../s-a", name: "s-a" }, ["true"]));
  assert.throws(() => sessionWrappedArgv({ dir: "/x/s-a", name: "s-a" }, []), /empty argv/);
});

/** `<pid>:<starttime>` of a live process (field 22 of /proc/<pid>/stat), as the helper records it. */
async function procId(pid) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  return `${pid}:${stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19]}`;
}

/** A display lock record as `hostmode.py` writes it (sorted keys). */
async function writeLock(displays, display, fields) {
  await mkdir(displays, { recursive: true, mode: 0o700 });
  const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const record = { version: 1, display, helper: "999999:10", bootId, tag: "0123456789abcdef", runtimeDir: "", workspace: "", createdAt: new Date().toISOString(), xvfbPid: null, infra: {}, ...fields };
  const sorted = Object.fromEntries(Object.keys(record).sort().map((k) => [k, record[k]]));
  const path = join(displays, `display-${display}.lock`);
  await writeFile(path, `${JSON.stringify(sorted, null, 0).replaceAll('":', '": ').replaceAll(',"', ', "')}\n`, { mode: 0o600 });
  return path;
}

const exists = (path) => lstat(path).then(() => true, () => false);

/** A live stand-in for a helper that no session path names; returns its `<pid>:<starttime>`. */
async function liveHelper(t) {
  const child = spawn("sleep", ["60"], { stdio: "ignore", detached: true });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((r) => setTimeout(r, 100));
  return { child, id: await procId(child.pid) };
}

test("W2: a symlinked session dir is never followed: no process is selected through its target, and nothing outside is removed", async (t) => {
  const s = await sandbox(t);
  const keep = await create(s.transport, remoteSessionName("gui-keep"));
  const outside = join(s.root, "outside");
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, "data"), "not yours to remove\n");
  const name = remoteSessionName("gui-symlink");
  await symlink(outside, join(s.base, name));
  // An unrelated process whose environment names the symlink's target.
  const victim = spawn("sleep", ["60"], { env: { PATH: process.env.PATH, MARK: outside }, stdio: "ignore", detached: true });
  t.after(() => victim.kill("SIGKILL"));
  await new Promise((r) => setTimeout(r, 200));

  for (const mode of ["fast", "graceful"]) {
    const left = await removeRemoteSessions(s.transport.runner, [name], { destination: "loop", mode });
    assert.equal(left.length, 1, JSON.stringify(left));
    assert.equal(left[0].kind, "remote-dir");
    assert.match(left[0].detail, /symlink or not your directory; not touched/);
  }
  assert.equal(victim.exitCode, null, "the unrelated process lives");
  assert.equal(victim.signalCode, null);
  assert.equal(await readFile(join(outside, "data"), "utf8"), "not yours to remove\n");
  assert.ok((await lstat(join(s.base, name))).isSymbolicLink());
  const audit = await auditRemoteSession(s.transport.runner, name, { destination: "loop" });
  assert.deepEqual(audit.map((l) => l.kind), ["remote-dir"], "reported, no process selected through it");
  await stat(keep.dir);
});

test("W2: processes are selected by whole path words, never by a substring of another session's path", async (t) => {
  const s = await sandbox(t);
  const name = remoteSessionName("gui-ab");
  const remote = await create(s.transport, name);
  // A sibling whose path only starts with this session's path (s-…-1 vs s-…-12).
  const lookalike = spawn("sleep", ["60"], { env: { PATH: process.env.PATH, XDG_RUNTIME_DIR: `${remote.dir}2/run/xdg`, OTHER: `${remote.dir}x` }, stdio: "ignore", detached: true });
  t.after(() => lookalike.kill("SIGKILL"));
  const mine = tagged(remote.dir, "env");
  await new Promise((r) => setTimeout(r, 200));
  const audit = await auditRemoteSession(s.transport.runner, name, { destination: "loop" });
  const procs = audit.filter((l) => l.kind === "remote-process").map((l) => l.id);
  assert.ok(procs.includes(`loop:${mine.child.pid}`));
  assert.equal(procs.includes(`loop:${lookalike.pid}`), false);
  assert.deepEqual(await removeRemoteSessions(s.transport.runner, [name], { destination: "loop", mode: "fast" }), []);
  await mine.exited;
  assert.equal(lookalike.exitCode, null, "the look-alike lives");
});

test("W9: a forced removal also removes the dead helper's display lock and its X files; the audit reports locks until then", async (t) => {
  const s = await sandbox(t);
  const name = remoteSessionName("gui-crash");
  const remote = await create(s.transport, name);
  const display = 9000 + Math.floor(Math.random() * 900);
  const xlock = `/tmp/.X${display}-lock`;
  await writeFile(xlock, "999998\n");
  t.after(() => rm(xlock, { force: true }));
  // A crashed helper: its lock remains, and an app it started still runs with the session tag.
  const app = spawn("sleep", ["60"], { env: { PATH: process.env.PATH, PI_GUI_TAG: "0123456789abcdef" }, stdio: "ignore", detached: true });
  t.after(() => app.kill("SIGKILL"));
  const unrelated = spawn("sleep", ["60"], { env: { PATH: process.env.PATH, PI_GUI_TAG: "0123456789abcdee" }, stdio: "ignore", detached: true });
  t.after(() => unrelated.kill("SIGKILL"));
  const lock = await writeLock(remote.displays, display, { runtimeDir: remote.run, workspace: remote.workspace, xvfbPid: 999998, infra: { xvfb: "999998:5" } });
  // Another session's lock (live helper) is never touched.
  const other = await create(s.transport, remoteSessionName("gui-other"));
  const otherLock = await writeLock(remote.displays, display + 1, { runtimeDir: other.run, helper: (await liveHelper(t)).id, tag: "fedcba9876543210" });
  await new Promise((r) => setTimeout(r, 200));

  const audit = await auditRemoteSession(s.transport.runner, name, { destination: "loop" });
  assert.ok(audit.some((l) => l.kind === "display-lock" && l.id === `loop:${lock}`), JSON.stringify(audit));
  assert.ok(audit.some((l) => l.kind === "remote-process" && l.id === `loop:${app.pid}`), "the tagged app is selected by its session tag");
  assert.equal(audit.some((l) => l.id === `loop:${unrelated.pid}`), false);

  assert.deepEqual(await removeRemoteSessions(s.transport.runner, [name], { destination: "loop", mode: "fast" }), []);
  await new Promise((r) => app.exitCode !== null || app.signalCode !== null ? r() : app.once("exit", r));
  assert.equal(await exists(lock), false, "the dead helper's lock is gone");
  assert.equal(await exists(xlock), false, "the X lock of its dead Xvfb is gone");
  assert.equal(unrelated.exitCode, null);
  assert.equal(await exists(otherLock), true, "another session's lock stays");
  assert.deepEqual(await auditRemoteSession(s.transport.runner, name, { destination: "loop" }), []);
});

test("W9: a live helper's lock and an X lock of another server stay; the removal reports the live helper", async (t) => {
  const s = await sandbox(t);
  const name = remoteSessionName("gui-livelock");
  const remote = await create(s.transport, name);
  const display = 9000 + Math.floor(Math.random() * 900);
  const xlock = `/tmp/.X${display}-lock`;
  await writeFile(xlock, "12345\n");
  t.after(() => rm(xlock, { force: true }));
  const helper = await liveHelper(t);
  const lock = await writeLock(remote.displays, display, { runtimeDir: remote.run, helper: helper.id, xvfbPid: 999998 });
  const left = await removeRemoteSessions(s.transport.runner, [name], { destination: "loop", mode: "fast" });
  assert.deepEqual(left.map((l) => [l.kind, l.id]), [["display-lock", `loop:${lock}`]]);
  assert.match(left[0].detail, /helper \d+ still running/);
  assert.equal(await exists(lock), true);
  assert.equal(helper.child.exitCode, null, "a helper that names no session path is not signalled");
  // The helper is gone now (a dead helper id): the lock goes; the X lock names another server and stays.
  await writeLock(remote.displays, display, { runtimeDir: remote.run, xvfbPid: 999998 });
  assert.deepEqual(await removeRemoteSessions(s.transport.runner, [name], { destination: "loop", mode: "fast" }), []);
  assert.equal(await exists(lock), false);
  assert.equal(await exists(xlock), true, "an X lock naming another server is never removed");
});

test("W9: the orphan audit reports display locks left without a session dir; the sweep removes dead helpers' locks only", async (t) => {
  const s = await sandbox(t);
  const anchor = await create(s.transport, remoteSessionName("gui-anchor"), OWNER_ALIVE);
  const deadLock = await writeLock(anchor.displays, 9901, { runtimeDir: join(s.base, "s-gone-00000001", "run") });
  const liveLock = await writeLock(anchor.displays, 9902, { runtimeDir: join(s.base, "s-gone-00000002", "run"), helper: (await liveHelper(t)).id });
  const strayLock = await writeLock(anchor.displays, 9903, { runtimeDir: "/somewhere/else/run" });
  const audit = await auditRemoteOrphans(s.transport.runner, { destination: "loop", procRoot: s.procRoot });
  const locks = Object.fromEntries(audit.filter((l) => l.kind === "display-lock").map((l) => [l.id, l.detail]));
  assert.deepEqual(Object.keys(locks).sort(), [`loop:${deadLock}`, `loop:${liveLock}`, `loop:${strayLock}`].sort());
  assert.match(locks[`loop:${deadLock}`], /helper is gone/);
  assert.match(locks[`loop:${liveLock}`], /helper still runs/);
  assert.match(locks[`loop:${strayLock}`], /names no session dir/);
  assert.equal(await exists(deadLock), true, "the audit is read-only");

  const leftovers = await sweepRemoteOrphans(s.transport.runner, { destination: "loop", procRoot: s.procRoot });
  assert.deepEqual(leftovers.filter((l) => l.kind === "display-lock").map((l) => l.id).sort(), [`loop:${liveLock}`, `loop:${strayLock}`].sort());
  assert.equal(await exists(deadLock), false);
  assert.equal(await exists(liveLock), true);
  assert.equal(await exists(strayLock), true);
  await stat(anchor.dir);
});

test("V4: remote-linux-docker: when docker run ends, the wrapper removes the session container, then the synced dir", async (t) => {
  const s = await sandbox(t);
  const remote = await create(s.transport, remoteSessionName("gui-docker"));
  // A stand-in docker CLI on the remote PATH: `run` acts like the stub; `rm -f` is logged.
  const log = join(s.root, "docker.log");
  await writeFile(join(s.lb.fakebin, "docker"), `#!/bin/sh\necho "$*" >> '${log}'\ncase " $* " in *" run "*) echo READY; cat >/dev/null ;; esac\nexit 0\n`, { mode: 0o700 });
  const child = s.transport.spawnHelper(sessionWrappedArgv(remote, ["docker", "--host", "unix:///run/docker.sock", "run", "--rm", "-i", "img"], { host: "unix:///run/docker.sock", container: "pi-gui-testing-gui-docker" }), {});
  const exited = child.exited;
  await new Promise((resolve) => child.stdout.once("data", resolve));
  child.stdin.end();
  await within(exited, 15_000, "the wrapper");
  await assert.rejects(stat(remote.dir));
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), ["--host unix:///run/docker.sock run --rm -i img", "--host unix:///run/docker.sock rm -f -- pi-gui-testing-gui-docker"]);
  assert.throws(() => sessionWrappedArgv(remote, ["true"], { host: "-H", container: "x" }), /invalid container/);
  assert.throws(() => sessionWrappedArgv(remote, ["true"], { host: "h", container: "a b" }), /invalid container/);
});
