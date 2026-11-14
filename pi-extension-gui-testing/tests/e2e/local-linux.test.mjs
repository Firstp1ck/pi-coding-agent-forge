/**
 * local-linux end to end on this host (spec §4.2, §5.5, M2 exit criterion):
 * the real host-mode helper starts a private Xvfb, the GTK 3 smoke app runs on
 * `:N` only (never on the desktop, never with WAYLAND_DISPLAY), and stop or a
 * killed helper leaves nothing behind. Skipped when the host lacks Xvfb, the
 * X tools, D-Bus, or PyGObject with GTK 3.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalLinuxBackend } from "../../src/backends/local-linux.ts";
import { displayLockDir, findExecutable, resolvePython, SMOKE_APP_PATH } from "../../src/backends/local/host.ts";
import { runChecks } from "../../src/checks/runner.ts";
import { createOwnerIdentity } from "../../src/cleanup/identity.ts";
import { createSessionDir } from "../../src/cleanup/session-dir.ts";
import { auditSession } from "../../src/cleanup/sweep.ts";
import { DEFAULTS } from "../../src/config/types.ts";
import { decodePng, isUniform } from "../../src/tools/png.ts";

function skipReason() {
  if (process.platform !== "linux") return "local-linux needs a Linux host";
  for (const tool of ["Xvfb", "xdotool", "xprop", "xwininfo", "dbus-daemon"]) if (!findExecutable(tool)) return `${tool} not found on PATH`;
  if (!findExecutable("magick") && !(findExecutable("import") && findExecutable("convert"))) return "ImageMagick not found on PATH";
  const python = resolvePython();
  if (!python) return "python3 not found";
  const gi = spawnSync(python, ["-I", "-c", "import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk"], { encoding: "utf8", timeout: 20_000 });
  if (gi.status !== 0) return "PyGObject with GTK 3 not available";
  return undefined;
}

const SKIP = skipReason();

function config() {
  return { shared: { targets: ["linux"], workspaceMode: "mount", network: "default" }, limits: { ...DEFAULTS.limits }, usageCheck: { ...DEFAULTS.usageCheck }, keepSandbox: false, warnings: [] };
}

function environOf(pid) {
  return Object.fromEntries(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
  );
}

async function scratch(t) {
  // A short root keeps the private bus socket paths far below the 107-byte limit.
  const root = await mkdtemp(join(existsSync("/tmp") ? "/tmp" : tmpdir(), "pgl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  return { root, project };
}

async function startSession(t, backend, root, project) {
  const dir = await createSessionDir({ identity: createOwnerIdentity(), piSessionId: "e2e", backend: "local-linux", tmpRoot: root });
  t.after(() => dir.remove());
  const logs = [];
  const session = await backend.startSession({
    sessionId: `gui-e2e${Date.now() % 100000}`,
    projectRoot: project,
    sessionDir: dir.path,
    config: config(),
    ownerLabel: dir.ownerLabel,
    recordResource: (kind, id) => dir.recordResource(kind, id),
    onLog: (e) => logs.push(e),
    signal: AbortSignal.timeout(60_000),
  });
  return { session, dir, logs };
}

test("local-linux: required checks pass on this host", { skip: SKIP }, async (t) => {
  const { root, project } = await scratch(t);
  const backend = new LocalLinuxBackend({ tmpRoot: root });
  const results = await runChecks(backend.checks(), { runner: backend.runner, backend: "local-linux", projectRoot: project, signal: AbortSignal.timeout(120_000) });
  for (const r of results.filter((x) => x.required)) assert.equal(r.status, "pass", `${r.id}: ${r.observed}`);
});

test("local-linux: the GTK 3 smoke app runs on the private display only and stop leaves nothing", { skip: SKIP }, async (t) => {
  const { root, project } = await scratch(t);
  const backend = new LocalLinuxBackend({ tmpRoot: root });
  const { session, dir } = await startSession(t, backend, root, project);
  const display = session.display;
  const n = Number(display.slice(1));
  assert.ok(n >= 90, `display ${display}`);
  const runtime = join(dir.path, "runtime");

  const app = backend.smokeApp();
  const launched = await session.request("launch", { cmd: app.cmd, args: app.args, env: { WAYLAND_DISPLAY: "wayland-0", DISPLAY: ":0" }, cwd: session.workspacePath });
  if (!launched.windows.some((w) => w.title === "Pi GUI smoke")) {
    const waited = await session.request("wait", { for: "window", value: "Pi GUI smoke", timeoutMs: 15_000 });
    assert.ok(waited.matched, "smoke window appeared");
  }

  // Wayland-leak criterion: the app process sees only the private session.
  const env = environOf(launched.pid);
  assert.equal(env.DISPLAY, display);
  assert.equal(env.WAYLAND_DISPLAY, undefined);
  assert.equal(env.WAYLAND_SOCKET, undefined);
  assert.equal(env.GDK_BACKEND, "x11");
  assert.equal(env.XAUTHORITY, join(runtime, "Xauthority"));
  assert.ok(env.DBUS_SESSION_BUS_ADDRESS.includes(runtime), env.DBUS_SESSION_BUS_ADDRESS);
  assert.equal(env.XDG_RUNTIME_DIR, join(runtime, "xdg"));
  if (process.env.DISPLAY) assert.notEqual(env.DISPLAY, process.env.DISPLAY);

  // The window exists on :N …
  const xenv = { PATH: process.env.PATH, DISPLAY: display, XAUTHORITY: join(runtime, "Xauthority") };
  const onPrivate = spawnSync("xdotool", ["search", "--pid", String(launched.pid)], { env: xenv, encoding: "utf8", timeout: 10_000 });
  assert.ok(onPrivate.stdout.trim().length > 0, `xdotool search on ${display}: ${onPrivate.stderr}`);
  // … and not on the desktop's X display (when there is one).
  if (process.env.DISPLAY) {
    const onHost = spawnSync("xdotool", ["search", "--pid", String(launched.pid)], { env: { ...process.env }, encoding: "utf8", timeout: 10_000 });
    assert.equal(onHost.stdout.trim(), "", "no window of the app on the desktop display");
  }
  // Without the cookie the private display refuses clients.
  const noCookie = spawnSync("xprop", ["-root"], { env: { PATH: process.env.PATH, DISPLAY: display, XAUTHORITY: "/nonexistent" }, encoding: "utf8", timeout: 10_000 });
  assert.notEqual(noCookie.status, 0, "the display needs the session's cookie");

  const shot = await session.request("screenshot", {});
  const png = decodePng(Buffer.from(shot.png_base64, "base64"));
  assert.ok(!isUniform(png.rgb));

  await assert.rejects(session.request("exec", { cmd: "true", cwd: session.workspacePath, env: {}, timeoutMs: 5_000 }), /exec is disabled in host mode/);

  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.ok(!existsSync(join("/tmp/.X11-unix", `X${n}`)) && !existsSync(`/tmp/.X${n}-lock`));
  assert.ok(!existsSync(join(displayLockDir(root), `display-${n}.lock`)));
  const resources = dir.resources;
  await dir.remove();
  assert.deepEqual(await auditSession({ path: dir.path, resources }), []);
});

test("local-linux: a killed helper's display is swept as an orphan", { skip: SKIP }, async (t) => {
  const { root, project } = await scratch(t);
  const backend = new LocalLinuxBackend({ tmpRoot: root });
  const { session } = await startSession(t, backend, root, project);
  const n = Number(session.display.slice(1));
  const app = backend.smokeApp();
  await session.request("launch", { cmd: app.cmd, args: app.args, env: {}, cwd: session.workspacePath });
  process.kill(session.helperPid, "SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const audit = await backend.auditOrphans(AbortSignal.timeout(10_000));
  assert.ok(audit.some((l) => l.kind === "display-lock"), JSON.stringify(audit));
  assert.deepEqual(await backend.sweepOrphans(AbortSignal.timeout(30_000)), []);
  assert.deepEqual(await backend.auditOrphans(AbortSignal.timeout(10_000)), []);
  assert.ok(!existsSync(join("/tmp/.X11-unix", `X${n}`)));
  await session.stop();
});
