/**
 * The real host-mode helper started by the real `local-linux` backend on this
 * host, with a stand-in `Xvfb` (a script that honours `-displayfd` and makes a
 * socket file) so it runs without an X server. Exercises the display claim,
 * the private bus (`dbus-daemon`), the optional AT-SPI/openbox paths, the
 * client's isolation checks, clean stop, and cleanup after a killed helper.
 * Skipped without `python3` or `dbus-daemon`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { LocalLinuxBackend } from "../../../../src/backends/local-linux.ts";
import { taggedProcesses, listDisplayLocks } from "../../../../src/backends/local/footprint.ts";
import { displayLockDir, findExecutable, isExecutable, resolvePython } from "../../../../src/backends/local/host.ts";
import { createOwnerIdentity } from "../../../../src/cleanup/identity.ts";
import { createSessionDir } from "../../../../src/cleanup/session-dir.ts";
import { DEFAULTS } from "../../../../src/config/types.ts";

const python = resolvePython();
const SKIP = process.platform !== "linux" ? "Linux only" : !python ? "python3 not found" : !findExecutable("dbus-daemon") ? "dbus-daemon not found" : false;

const FAKE_XVFB = (py) => `#!${py} -I
import os, signal, sys, time
args = sys.argv[1:]
display = args[0][1:]
fd = int(args[args.index("-displayfd") + 1])
sock = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "x11", "X" + display)
open(sock, "w").close()
def bye(*_):
    try:
        os.unlink(sock)
    except OSError:
        pass
    os._exit(0)
signal.signal(signal.SIGTERM, bye)
os.write(fd, (display + "\\n").encode())
os.close(fd)
while True:
    time.sleep(1)
`;

async function setup(t) {
  // Short root: the private bus socket lives below the session dir.
  const root = await mkdtemp(join(existsSync("/tmp") && isExecutable("/tmp") ? "/tmp" : process.env.TMPDIR ?? "/tmp", "pglu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const d of ["bin", "x11", "project"]) mkdirSync(join(root, d));
  writeFileSync(join(root, "bin", "Xvfb"), FAKE_XVFB(python));
  chmodSync(join(root, "bin", "Xvfb"), 0o755);
  const backend = new LocalLinuxBackend({
    tmpRoot: root,
    env: { PATH: `${join(root, "bin")}:${process.env.PATH}`, LANG: "C.UTF-8", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
    x11Dir: join(root, "x11"),
    readyTimeoutMs: 20_000,
    exitWaitMs: 10_000,
  });
  const dir = await createSessionDir({ identity: createOwnerIdentity(), piSessionId: "unit", backend: "local-linux", tmpRoot: root });
  t.after(() => dir.remove());
  const start = {
    sessionId: "gui-hosthelper",
    projectRoot: join(root, "project"),
    sessionDir: dir.path,
    config: { shared: { targets: ["linux"], workspaceMode: "mount", network: "default" }, limits: { ...DEFAULTS.limits }, usageCheck: { ...DEFAULTS.usageCheck }, keepSandbox: false, warnings: [] },
    ownerLabel: dir.ownerLabel,
    recordResource: (kind, id) => dir.recordResource(kind, id),
    onLog: () => {},
    signal: AbortSignal.timeout(30_000),
  };
  return { root, backend, dir, start, lockDir: displayLockDir(root) };
}

test("host helper: private display and bus start, stop removes everything", { skip: SKIP }, async (t) => {
  const { root, backend, dir, start, lockDir } = await setup(t);
  const session = await backend.startSession(start);
  const [lock] = await listDisplayLocks(lockDir);
  assert.ok(lock?.record, "the helper claimed a display lock");
  const { record } = lock;
  assert.ok(record.display >= 90);
  assert.equal(session.display, `:${record.display}`);
  assert.ok(existsSync(join(root, "x11", `X${record.display}`)));
  assert.ok(record.infra.xvfb && record.infra.dbus, JSON.stringify(record.infra));
  const tagged = await taggedProcesses(record.tag);
  assert.ok(tagged.length >= 2, `Xvfb and dbus-daemon carry the session tag (${tagged})`);
  assert.deepEqual(dir.resources.map((r) => r.kind), ["process", "display-lock"]);
  assert.deepEqual(readdirSync(join(dir.path, "runtime")).sort(), ["Xauthority", "home", "tmp", "xdg"]);

  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(await taggedProcesses(record.tag), []);
  assert.deepEqual(readdirSync(lockDir), []);
  assert.deepEqual(readdirSync(join(dir.path, "runtime")), [], "the helper removed what it created");
  assert.ok(!existsSync(join(root, "x11", `X${record.display}`)));
});

test("host helper: after SIGKILL the client removes the display, bus, and lock", { skip: SKIP }, async (t) => {
  const { backend, start, lockDir } = await setup(t);
  const session = await backend.startSession(start);
  const [{ record }] = await listDisplayLocks(lockDir);
  process.kill(session.helperPid, "SIGKILL");
  const orphans = await (async () => {
    for (let i = 0; i < 40; i++) {
      const audit = await backend.auditOrphans(AbortSignal.timeout(5_000));
      if (audit.length > 0) return audit;
      await new Promise((r) => setTimeout(r, 50));
    }
    return [];
  })();
  assert.ok(orphans.some((l) => l.kind === "display-lock"), JSON.stringify(orphans));
  assert.ok(orphans.some((l) => l.kind === "process"), "Xvfb and the bus are reported");
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await taggedProcesses(record.tag), []);
  assert.deepEqual(readdirSync(lockDir), []);
  assert.deepEqual(await backend.auditOrphans(AbortSignal.timeout(5_000)), []);
});
