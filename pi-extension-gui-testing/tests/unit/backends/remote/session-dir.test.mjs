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
