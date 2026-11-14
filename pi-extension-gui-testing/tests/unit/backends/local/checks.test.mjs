import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { runChecks } from "../../../../src/checks/runner.ts";
import { localLinuxChecks, scrubProblems } from "../../../../src/backends/local/checks.ts";
import { ATSPI_LAUNCHER_CANDIDATES, findExecutable, HELPER_PATH, isExecutable } from "../../../../src/backends/local/host.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { createSpawnRunner } from "../../../../src/runner/spawn.ts";
import { fakeHost } from "./fakes.mjs";

const IDS = [
  "pi.version",
  "host.os",
  "config.writable",
  "disk.free",
  "linux.python",
  "linux.xvfb",
  "linux.xdotool",
  "linux.xutils",
  "linux.screenshot",
  "linux.dbus",
  "linux.atspi",
  "linux.pyatspi",
  "linux.wm",
  "linux.fonts",
  "linux.gtk-introspection",
  "linux.wayland-scrub",
];

const TOOLS = ["Xvfb", "xdotool", "xprop", "xwininfo", "magick", "dbus-daemon", "dbus-run-session", "openbox", "fc-list", "pacman"];

function goodReport(expectedOverrides = {}, seenOverrides = {}) {
  const expected = { DISPLAY: ":599", DBUS_SESSION_BUS_ADDRESS: "unix:path=/r/xdg/pi-gui-bus", XDG_RUNTIME_DIR: "/r/xdg", XAUTHORITY: "/r/Xauthority", HOME: "/r/home", ...expectedOverrides };
  const seen = { ...expected, GDK_BACKEND: "x11", QT_QPA_PLATFORM: "xcb", SDL_VIDEODRIVER: "x11", ELECTRON_OZONE_PLATFORM_HINT: "x11", XDG_SESSION_TYPE: "x11", ...seenOverrides };
  return { ok: true, seen, expected, tokenPresent: false, contractKeys: [] };
}

function fakeRunner(overrides = {}) {
  const runner = new FakeCommandRunner();
  runner
    .on((argv) => argv.some((a) => a.includes("sys.version_info")), { exitCode: 0, stdout: "3.11.15\n" })
    .on((argv) => argv.includes("--probe") && argv.includes("display"), { exitCode: 0, stdout: `${JSON.stringify({ ok: true, display: ":90", xvfb: "/usr/bin/Xvfb", elapsedMs: 120 })}\n` })
    .on((argv) => argv.includes("--probe") && argv.includes("env"), { exitCode: 0, stdout: `${JSON.stringify(goodReport())}\n` })
    .on(["xdotool", "version"], { exitCode: 0, stdout: "xdotool version 3.20211022.1\n" })
    .on(["fc-list"], { exitCode: 0, stdout: "/usr/share/fonts/DejaVuSans.ttf: DejaVu Sans:style=Book\n" })
    .on((argv) => argv.includes("import pyatspi"), { exitCode: 0 })
    .on((argv) => argv.some((a) => a.includes("gi.require_version")), { exitCode: 0 });
  for (const [match, response] of overrides.rules ?? []) runner.on(match, response);
  return runner;
}

async function run(t, overrides = {}) {
  const host = fakeHost(t);
  const tools = new Set(overrides.tools ?? TOOLS);
  const runner = overrides.runner ?? fakeRunner(overrides);
  const checks = localLinuxChecks({
    runner,
    which: (name) => (tools.has(name) ? `/usr/bin/${name}` : undefined),
    executable: (p) => p === "/usr/bin/python3" || (overrides.atspi !== false && p === ATSPI_LAUNCHER_CANDIDATES[0]),
    tmpRoot: host.tmpRoot,
    uid: host.uid,
    env: { PATH: "/usr/bin", DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" },
    common: { piVersion: "1.4.0", platform: overrides.platform ?? "linux", configDir: host.tmpRoot, minFreeBytes: 1, diskPath: host.tmpRoot },
  });
  const results = await runChecks(checks, { runner, backend: "local-linux", projectRoot: host.project, signal: new AbortController().signal });
  return { byId: Object.fromEntries(results.map((r) => [r.id, r])), results, runner, host };
}

test("local-linux runs the spec §5.4 checks in order, all passing on a complete host", async (t) => {
  const { results, byId, runner, host } = await run(t);
  assert.deepEqual(results.map((r) => r.id), IDS);
  for (const r of results) assert.equal(r.status, "pass", `${r.id}: ${r.observed}`);
  assert.deepEqual(byId["linux.python"].facts, { "python.version": "3.11.15" });
  assert.match(byId["linux.xvfb"].observed, /started and stopped on :90/);
  assert.match(byId["linux.wayland-scrub"].observed, /DISPLAY=:599/);
  const probe = runner.calls.find((c) => c.argv.includes("display"));
  assert.deepEqual(probe.argv.slice(0, 4), ["/usr/bin/python3", "-I", "-B", HELPER_PATH]);
  assert.equal(probe.options.env.PI_GUI_DISPLAY_LOCK_DIR, host.lockDir);
  const scrub = runner.calls.find((c) => c.argv.includes("env"));
  assert.equal(scrub.options.env.PI_GUI_HELPER_MODE, "host");
  assert.equal(scrub.options.env.WAYLAND_DISPLAY, "wayland-0", "the probe deliberately pollutes the helper to prove it scrubs");
  assert.deepEqual(readdirSync(host.tmpRoot).filter((n) => n.startsWith("pi-gui-probe-")), [], "probe dirs are removed");
});

test("missing tools fail with a manual install command for the detected distribution", async (t) => {
  const { byId } = await run(t, { tools: ["dbus-run-session", "pacman"], atspi: false });
  assert.equal(byId["linux.xvfb"].status, "fail");
  assert.equal(byId["linux.xvfb"].observed, "Xvfb not found on PATH");
  assert.deepEqual(byId["linux.xvfb"].remediation.command, ["sudo", "pacman", "-S", "--needed", "xorg-server-xvfb"]);
  assert.equal(byId["linux.xvfb"].remediation.manual, true);
  assert.equal(byId["linux.xutils"].status, "fail");
  assert.equal(byId["linux.screenshot"].status, "fail");
  assert.match(byId["linux.dbus"].observed, /dbus-daemon not found on PATH \(dbus-run-session is at/);
  for (const id of ["linux.atspi", "linux.wm"]) {
    assert.equal(byId[id].status, "warn", id);
    assert.ok(byId[id].degrades, id);
  }
  assert.match(byId["linux.atspi"].degrades, /coverage none/);
});

test("python, GTK, and pyatspi problems; blocked dependants without python", async (t) => {
  const old = await run(t, { rules: [[(argv) => argv.some((a) => a.includes("sys.version_info")), { exitCode: 0, stdout: "3.8.10\n" }]] });
  assert.equal(old.byId["linux.python"].status, "fail");
  const noGi = await run(t, {
    rules: [
      [(argv) => argv.some((a) => a.includes("gi.require_version")), { exitCode: 1, stderr: "Traceback…\nModuleNotFoundError: No module named 'gi'\n" }],
      [(argv) => argv.includes("import pyatspi"), { exitCode: 1, stderr: "ModuleNotFoundError: No module named 'pyatspi'\n" }],
    ],
  });
  assert.equal(noGi.byId["linux.gtk-introspection"].status, "fail");
  assert.match(noGi.byId["linux.gtk-introspection"].observed, /No module named 'gi'/);
  assert.equal(noGi.byId["linux.pyatspi"].status, "warn");

  const host = fakeHost(t);
  const runner = new FakeCommandRunner();
  const checks = localLinuxChecks({ runner, which: () => undefined, executable: () => false, tmpRoot: host.tmpRoot, uid: host.uid, packageManager: null, common: { piVersion: "1.4.0", platform: "linux", configDir: host.tmpRoot, minFreeBytes: 1, diskPath: host.tmpRoot } });
  const results = Object.fromEntries((await runChecks(checks, { runner, backend: "local-linux", projectRoot: host.project, signal: new AbortController().signal })).map((r) => [r.id, r]));
  assert.equal(results["linux.python"].status, "fail");
  for (const id of ["linux.xvfb", "linux.gtk-introspection", "linux.wayland-scrub"]) assert.equal(results[id].status, "blocked", id);
  assert.equal(results["linux.pyatspi"].status, "blocked");
  assert.equal(results["linux.python"].remediation.command, undefined, "no package manager → package names only");
});

test("host.os fails on other systems", async (t) => {
  const { byId } = await run(t, { platform: "darwin" });
  assert.equal(byId["host.os"].status, "fail");
  assert.match(byId["host.os"].observed, /Linux hosts only/);
});

test("a failed display probe reports the helper's error", async (t) => {
  const { byId } = await run(t, { rules: [[(argv) => argv.includes("display"), { exitCode: 1, stdout: `${JSON.stringify({ ok: false, error: "Xvfb did not report readiness within 10 s" })}\n` }]] });
  assert.equal(byId["linux.xvfb"].status, "fail");
  assert.match(byId["linux.xvfb"].observed, /did not report readiness/);
});

test("wayland-scrub fails on any leak, wrong display, token, or contract variable", async (t) => {
  assert.deepEqual(scrubProblems(goodReport()), []);
  assert.match(scrubProblems(goodReport({}, { WAYLAND_DISPLAY: "wayland-0" })).join(), /WAYLAND_DISPLAY=wayland-0/);
  assert.match(scrubProblems(goodReport({}, { DISPLAY: ":0" })).join(), /DISPLAY is ":0", expected ":599"/);
  assert.match(scrubProblems(goodReport({}, { GDK_BACKEND: "wayland" })).join(), /GDK_BACKEND/);
  assert.match(scrubProblems({ ...goodReport(), tokenPresent: true }).join(), /token/);
  assert.match(scrubProblems({ ...goodReport(), contractKeys: ["PI_GUI_WORKSPACE"] }).join(), /PI_GUI_WORKSPACE/);
  const leak = goodReport({}, { WAYLAND_DISPLAY: "wayland-0" });
  const { byId } = await run(t, { rules: [[(argv) => argv.includes("env"), { exitCode: 0, stdout: `${JSON.stringify(leak)}\n` }]] });
  assert.equal(byId["linux.wayland-scrub"].status, "fail");
  assert.equal(byId["linux.wayland-scrub"].required, true);
});

// Spec M2 exit criterion: a real child started by the real helper code on this host never sees the desktop.
const python = isExecutable("/usr/bin/python3") ? "/usr/bin/python3" : findExecutable("python3");
test("host: the real helper's env probe passes linux.wayland-scrub (no Xvfb needed)", { skip: python ? false : "python3 not found" }, async (t) => {
  const host = fakeHost(t);
  const runner = createSpawnRunner({ baseEnv: { ...process.env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/0/bus" } });
  const checks = localLinuxChecks({ runner, tmpRoot: host.tmpRoot, uid: host.uid, env: { ...process.env, DISPLAY: ":0", WAYLAND_DISPLAY: "wayland-0" } }).filter((c) => ["linux.python", "linux.wayland-scrub"].includes(c.id));
  const results = await runChecks(checks, { runner, backend: "local-linux", projectRoot: host.project, signal: new AbortController().signal });
  const scrub = results.find((r) => r.id === "linux.wayland-scrub");
  assert.equal(scrub.status, "pass", scrub.observed);
  assert.match(scrub.observed, /DISPLAY=:599/);
  assert.deepEqual(readdirSync(host.tmpRoot), [], "the probe left nothing behind");
});
