import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  ATSPI_LAUNCHER_CANDIDATES,
  detectPackageManager,
  displayLockDir,
  displayNumber,
  ensureDisplayLockDir,
  findExecutable,
  forbiddenHelperEnv,
  HELPER_PATH,
  helperArgv,
  helperEnv,
  installRemediation,
  NEVER_PASSED_ENV,
  resolvePython,
} from "../../../../src/backends/local/host.ts";
import { fakeHost } from "./fakes.mjs";

const DESKTOP = {
  PATH: "/opt/bin:/usr/bin",
  LANG: "de_CH.UTF-8",
  HOME: "/home/user",
  DISPLAY: ":0",
  WAYLAND_DISPLAY: "wayland-0",
  WAYLAND_SOCKET: "7",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  XDG_RUNTIME_DIR: "/run/user/1000",
  XAUTHORITY: "/home/user/.Xauthority",
  SESSION_MANAGER: "local/host:@/tmp/.ICE-unix/1",
  XDG_SESSION_TYPE: "wayland",
  SSH_AUTH_SOCK: "/run/user/1000/ssh",
  PI_GUI_TESTING_TOKEN: "0".repeat(32),
  LD_PRELOAD: "/tmp/evil.so",
};

test("helperEnv never passes the desktop's display, bus, or auth variables (R5)", () => {
  const env = helperEnv({ base: DESKTOP, workspace: "/p", runtimeDir: "/s/runtime", lockDir: "/t/locks" });
  for (const key of NEVER_PASSED_ENV) assert.equal(env[key], undefined, key);
  assert.equal(env.HOME, undefined, "the helper gives children a private HOME");
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.PI_GUI_TESTING_TOKEN, undefined, "HelperSession adds the token itself");
  assert.deepEqual(env, {
    PATH: "/opt/bin:/usr/bin",
    LANG: "de_CH.UTF-8",
    PI_GUI_HELPER_MODE: "host",
    PI_GUI_WORKSPACE: "/p",
    PI_GUI_RUNTIME_DIR: "/s/runtime",
    PI_GUI_DISPLAY_LOCK_DIR: "/t/locks",
  });
  assert.deepEqual(forbiddenHelperEnv(env), []);
  assert.deepEqual(forbiddenHelperEnv({ ...env, DISPLAY: ":0", PI_GUI_TESTING_TOKEN: "x" }), ["DISPLAY", "PI_GUI_TESTING_TOKEN"]);
});

test("helperEnv: default PATH, heartbeat test variable, and exec stays off unless asked", () => {
  const env = helperEnv({ base: {}, workspace: "/p", runtimeDir: "/r", lockDir: "/l", heartbeatTimeoutMs: 900 });
  assert.match(env.PATH, /\/usr\/bin/);
  assert.equal(env.PI_GUI_TESTING_HEARTBEAT_TIMEOUT_MS, "900");
  assert.equal(env.PI_GUI_ALLOW_EXEC, undefined);
  assert.equal(helperEnv({ base: {}, workspace: "/p", runtimeDir: "/r", lockDir: "/l", allowExec: true }).PI_GUI_ALLOW_EXEC, "1");
});

test("helperArgv runs the package's helper isolated and without writing bytecode", () => {
  assert.deepEqual(helperArgv("/usr/bin/python3", ["--probe", "env"]), ["/usr/bin/python3", "-I", "-B", HELPER_PATH, "--probe", "env"]);
  assert.match(readFileSync(HELPER_PATH, "utf8"), /pi_gui_helper\.main import main/);
});

test("displayNumber parses X display strings", () => {
  assert.equal(displayNumber(":0"), 0);
  assert.equal(displayNumber(":1.0"), 1);
  assert.equal(displayNumber("localhost:10.0"), 10);
  assert.equal(displayNumber(undefined), undefined);
  assert.equal(displayNumber("wayland-0"), undefined);
});

test("findExecutable and resolvePython scan PATH like command -v", () => {
  const exec = (p) => p === "/b/python3" || p === "/a/xdotool";
  assert.equal(findExecutable("xdotool", "/a:/b", exec), "/a/xdotool");
  assert.equal(findExecutable("python3", "relative:/b", exec), "/b/python3");
  assert.equal(findExecutable("missing", "/a:/b", exec), undefined);
  assert.equal(resolvePython((n) => findExecutable(n, "/a:/b", exec), exec), "/b/python3");
  assert.equal(resolvePython(() => "/elsewhere/python3", (p) => p === "/usr/bin/python3"), "/usr/bin/python3");
});

test("install remediations are manual sudo commands for the detected distribution", () => {
  const which = (n) => (n === "apt-get" ? "/usr/bin/apt-get" : undefined);
  assert.equal(detectPackageManager(which), "apt");
  assert.deepEqual(installRemediation("xvfb", "Xvfb", "apt"), { summary: "Install Xvfb (Debian/Ubuntu package xvfb)", command: ["sudo", "apt-get", "install", "xvfb"], needsSudo: true, manual: true });
  assert.deepEqual(installRemediation("xvfb", "Xvfb", "pacman").command, ["sudo", "pacman", "-S", "--needed", "xorg-server-xvfb"]);
  const unknown = installRemediation("xvfb", "Xvfb", undefined);
  assert.equal(unknown.command, undefined);
  assert.match(unknown.summary, /pacman xorg-server-xvfb.*apt xvfb.*dnf xorg-x11-server-Xvfb.*zypper xorg-x11-server-Xvfb/);
  assert.equal(unknown.manual, true);
});

test("ensureDisplayLockDir creates a 0700 dir and refuses unsafe ones", (t) => {
  const host = fakeHost(t);
  const dir = displayLockDir(host.tmpRoot, host.uid);
  assert.equal(dir, join(host.tmpRoot, `pi-gui-displays-${host.uid}`));
  ensureDisplayLockDir(dir, host.uid);
  ensureDisplayLockDir(dir, host.uid);
  assert.throws(() => ensureDisplayLockDir(dir, host.uid + 1), /belongs to uid/);
  chmodSync(dir, 0o777);
  assert.throws(() => ensureDisplayLockDir(dir, host.uid), /writable by other users/);
  const target = join(host.root, "elsewhere");
  mkdirSync(target);
  const link = join(host.tmpRoot, "link");
  symlinkSync(target, link);
  assert.throws(() => ensureDisplayLockDir(link, host.uid), /not a directory/);
});

test("the AT-SPI launcher list matches the helper's", () => {
  const source = readFileSync(join(HELPER_PATH, "..", "pi_gui_helper", "session.py"), "utf8");
  const block = /_ATSPI_LAUNCHER_CANDIDATES = \(([^)]*)\)/.exec(source)[1];
  assert.deepEqual([...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]), [...ATSPI_LAUNCHER_CANDIDATES]);
});
