import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalLinuxBackend, COPY_MODE_WARNING } from "../../../../src/backends/local-linux.ts";
import { LOCAL_LINUX_HOST_SUPPORT } from "../../../../src/backends/local/host.ts";
import { BackendRegistry, DEFAULT_REGISTRY } from "../../../../src/backends/registry.ts";
import { DEFAULTS } from "../../../../src/config/types.ts";
import { GuiRuntime } from "../../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../../src/tools/tools.ts";
import { fakeHost, localSpawner } from "./fakes.mjs";

const HOST_DESKTOP_ENV = {
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  DISPLAY: ":0",
  WAYLAND_DISPLAY: "wayland-0",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
  XDG_RUNTIME_DIR: "/run/user/1000",
  XAUTHORITY: "/home/u/.Xauthority",
  HOME: "/home/u",
};

function config(shared = {}) {
  return {
    shared: { targets: ["linux"], workspaceMode: "mount", network: "default", ...shared },
    limits: { ...DEFAULTS.limits },
    usageCheck: { ...DEFAULTS.usageCheck },
    keepSandbox: false,
    warnings: [],
  };
}

function backend(host, fake, extra = {}) {
  return new LocalLinuxBackend({
    spawner: fake.spawner,
    version: "0.1.0",
    tmpRoot: host.tmpRoot,
    procRoot: host.procRoot,
    uid: host.uid,
    env: HOST_DESKTOP_ENV,
    python: "/usr/bin/python3",
    x11Dir: host.x11Dir,
    xLockDir: host.xLockDir,
    kill: host.kill,
    readyTimeoutMs: 2_000,
    heartbeatTimeoutMs: 60_000,
    exitWaitMs: 300,
    killWaitMs: 50,
    maxSocketPath: 4096,
    ...extra,
  });
}

async function startOptions(host, cfg = config()) {
  const sessionDir = await mkdtemp(join(host.tmpRoot, "pi-gui-testing-"));
  const recorded = [];
  const exitCleanup = [];
  const logs = [];
  return {
    recorded,
    exitCleanup,
    sessionDir,
    options: {
      sessionId: "gui-test1",
      projectRoot: host.project,
      sessionDir,
      config: cfg,
      ownerLabel: "c:1:2:boot",
      recordResource: async (kind, id) => void recorded.push(`${kind} ${id}`),
      onLog: (e) => logs.push(e),
      onExitCleanup: (argv) => exitCleanup.push(argv),
      signal: new AbortController().signal,
    },
  };
}

test("startSession spawns the host-mode helper with an explicit environment and no desktop variables", async (t) => {
  const host = fakeHost(t);
  const fake = localSpawner(host);
  const b = backend(host, fake);
  const start = await startOptions(host);
  const session = await b.startSession(start.options);

  assert.equal(session.backend, "local-linux");
  assert.equal(session.workspacePath, realpathSync(host.project), "mount mode runs the app in the project itself");
  assert.equal(session.display, ":90");
  assert.deepEqual(fake.state.argv.slice(0, 3), ["/usr/bin/python3", "-I", "-B"]);
  assert.match(fake.state.argv[3], /helpers\/linux\/helper$/);
  assert.equal(fake.state.cwd, "/");
  const env = fake.state.env;
  for (const key of ["DISPLAY", "WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR", "XAUTHORITY", "HOME"]) assert.equal(env[key], undefined, key);
  assert.equal(env.PI_GUI_HELPER_MODE, "host");
  assert.equal(env.PI_GUI_WORKSPACE, realpathSync(host.project));
  assert.equal(env.PI_GUI_RUNTIME_DIR, join(realpathSync(start.sessionDir), "runtime"));
  assert.equal(env.PI_GUI_DISPLAY_LOCK_DIR, host.lockDir);
  assert.equal(env.PI_GUI_ALLOW_EXEC, undefined, "local-linux never allows exec (setup)");
  assert.match(env.PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/);
  assert.equal(statSync(env.PI_GUI_RUNTIME_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(host.lockDir).mode & 0o777, 0o700);

  assert.deepEqual(start.recorded, [`process ${fake.helperPid}:5000`, `display-lock ${join(host.lockDir, "display-90.lock")}`]);
  assert.deepEqual(start.exitCleanup, [["kill", "-TERM", "--", `-${fake.helperPid}`]]);
  assert.deepEqual(session.forceRemoveArgv(), ["kill", "-TERM", "--", `-${fake.helperPid}`]);

  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(session.forceRemoveArgv(), []);
  assert.deepEqual(fake.spawner.children[0].requests.map((r) => r.method), ["hello", "stop"]);
});

test("a crashed helper's display, X files, and tagged processes are removed by the client", async (t) => {
  const host = fakeHost(t);
  const fake = localSpawner(host, { dirty: true });
  const session = await backend(host, fake).startSession((await startOptions(host)).options);
  const child = fake.spawner.children[0];
  child.exit(null, "SIGKILL"); // the helper dies without its own teardown
  assert.ok(existsSync(join(host.lockDir, "display-90.lock")));
  assert.deepEqual(await session.stop(), []);
  assert.ok(host.kills.some(([pid]) => pid === fake.xvfbPid), "the tagged Xvfb was killed");
  assert.ok(!existsSync(join(host.lockDir, "display-90.lock")));
  assert.ok(!existsSync(join(host.x11Dir, "X90")));
  assert.deepEqual(await session.auditFootprint(), []);
});

test("verification fails closed when the helper's display is wrong", async (t) => {
  const cases = [
    { name: "desktop display", fake: { display: 90 }, env: { ...HOST_DESKTOP_ENV, DISPLAY: ":90" }, error: /desktop's display/ },
    { name: "low display", fake: { display: 5 }, error: /below :90/ },
    { name: "foreign runtime dir", fake: { runtimeDir: "/elsewhere" }, error: /runtime dir/ },
    { name: "no lock", fake: { noLock: true }, error: /claimed no display lock/ },
  ];
  for (const c of cases) {
    const host = fakeHost(t);
    const fake = localSpawner(host, c.fake);
    const b = backend(host, fake, c.env ? { env: c.env } : {});
    await assert.rejects(b.startSession((await startOptions(host)).options), (error) => {
      assert.equal(error.code, "ISOLATION", c.name);
      assert.match(error.message, c.error, c.name);
      return true;
    });
    assert.ok(!fake.spawner.children[0].running(), `${c.name}: the helper was stopped`);
  }
});

test("setup is never run: a configured setup only adds a warning", async (t) => {
  const host = fakeHost(t);
  const fake = localSpawner(host);
  const cfg = config({ setup: ["pip install -r requirements.txt", "npm ci"] });
  const session = await backend(host, fake).startSession((await startOptions(host, cfg)).options);
  assert.ok(!fake.spawner.children[0].requests.some((r) => r.method === "exec"));
  assert.deepEqual(cfg.warnings, [], "launch warnings belong to the session, not to the shared config");
  assert.equal(session.warnings.length, 1);
  assert.match(session.warnings[0], /never runs setup commands; the 2 setup command\(s\)/);
  assert.equal(session.workspaceDescription, "the project directory itself (writable)");
  await session.stop();
});

test("network none is refused, copy mode runs in a filtered copy", async (t) => {
  const host = fakeHost(t);
  const fake = localSpawner(host);
  const b = backend(host, fake);
  await assert.rejects(b.startSession((await startOptions(host, config({ network: "none" }))).options), /cannot block the app's network/);
  assert.equal(fake.spawner.children.length, 0);

  writeFileSync(join(host.project, "app.py"), "print('hi')\n");
  writeFileSync(join(host.project, ".env"), "SECRET=1\n");
  mkdirSync(join(host.project, "node_modules"));
  writeFileSync(join(host.project, "node_modules", "dep.js"), "");
  const cfg = config({ workspaceMode: "copy" });
  const start = await startOptions(host, cfg);
  const session = await b.startSession(start.options);
  const copy = join(realpathSync(start.sessionDir), "workspace");
  assert.equal(session.workspacePath, copy);
  assert.equal(fake.state.env.PI_GUI_WORKSPACE, copy);
  assert.equal(await readFile(join(copy, "app.py"), "utf8"), "print('hi')\n");
  assert.ok(!existsSync(join(copy, ".env")) && !existsSync(join(copy, "node_modules")));
  assert.ok(session.sync.excluded >= 1);
  assert.deepEqual(session.warnings, [COPY_MODE_WARNING]);
  assert.deepEqual(cfg.warnings, []);
  assert.match(session.workspaceDescription, /writable filtered copy/);
  await session.stop();
});

test("capabilities: host support, smoke app, sweep gate, reset texts, drift versions", async (t) => {
  const host = fakeHost(t);
  const runner = { run: async (argv) => ({ exitCode: 0, signal: null, stdout: argv.includes("-c") ? "3.11.15\n" : "", stderr: "", timedOut: false, truncated: false, durationMs: 1 }) };
  const b = backend(host, localSpawner(host), { runner, common: { piVersion: "1.4.0" } });
  assert.deepEqual(LOCAL_LINUX_HOST_SUPPORT.platforms, ["linux"]);
  const smoke = b.smokeApp();
  assert.equal(smoke.cmd, "/usr/bin/python3");
  assert.match(smoke.args[0], /testapps\/gtk3-smoke\/app\.py$/);
  assert.ok(existsSync(smoke.args[0]));
  assert.equal(b.smokeConfig(config({ network: "none" })).shared.network, "default");
  assert.equal(await b.sweepAvailable({ startup: true }), true);
  assert.equal(await backend(host, localSpawner(host), { platform: "darwin" }).sweepAvailable({ startup: true }), false);
  assert.match(b.resetSummary, /installs nothing/);
  assert.deepEqual(await b.currentVersions(), { "package.version": "0.1.0", "pi.version": "1.4.0", protocol: "1", "python.version": "3.11.15" });
  assert.deepEqual(await b.auditOrphans(new AbortController().signal), []);
});

test("through the runtime and tools: gui_launch and gui_stop on local-linux, docker untouched", async (t) => {
  const host = fakeHost(t);
  const fake = localSpawner(host);
  await mkdir(join(host.project, ".pi"), { recursive: true });
  writeFileSync(join(host.project, ".pi", "gui.json"), JSON.stringify({ launch: { cmd: "python3", args: ["app.py"] }, setup: ["make deps"] }));
  const globalConfigPath = join(host.root, "agent", "gui", "config.json");
  mkdirSync(join(host.root, "agent", "gui"), { recursive: true });
  const verified = { verifiedAt: "2026-10-24T00:00:00.000Z", toolVersions: { "package.version": "0.1.0", "pi.version": "1.4.0", protocol: "1", "python.version": "3.11.15" }, checksPassed: ["linux.xvfb"] };
  writeFileSync(globalConfigPath, JSON.stringify({ version: 1, backend: "local-linux", verified: { "local-linux": verified } }));
  const entry = {
    id: "local-linux",
    description: "Linux apps on this machine under a private virtual display",
    hostSupport: LOCAL_LINUX_HOST_SUPPORT,
    targets: ["linux"],
    create: (ctx) => new LocalLinuxBackend({ ownerLabel: ctx.ownerLabel, ...ctx.options, ...(ctx.tmpRoot ? { tmpRoot: ctx.tmpRoot } : {}) }),
  };
  const dockerCalls = [];
  const runtime = new GuiRuntime({
    registry: new BackendRegistry([DEFAULT_REGISTRY.entry("docker-linux"), entry]),
    tmpRoot: host.tmpRoot,
    globalConfigPath,
    docker: { runner: { run: async (argv) => (dockerCalls.push(argv), { exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false, durationMs: 0 }) }, endpointSource: {} },
    dockerOnPath: async () => false,
    backendOptions: {
      "local-linux": {
        spawner: fake.spawner,
        version: "0.1.0",
        procRoot: host.procRoot,
        uid: host.uid,
        env: HOST_DESKTOP_ENV,
        python: "/usr/bin/python3",
        x11Dir: host.x11Dir,
        xLockDir: host.xLockDir,
        kill: host.kill,
        common: { piVersion: "1.4.0" },
        runner: { run: async () => ({ exitCode: 0, signal: null, stdout: "3.11.15\n", stderr: "", timedOut: false, truncated: false, durationMs: 1 }) },
        readyTimeoutMs: 2_000,
        exitWaitMs: 300,
        killWaitMs: 50,
        maxSocketPath: 4096,
      },
    },
  });
  const exitCode = process.exitCode;
  t.after(async () => {
    await runtime.shutdown();
    process.exitCode = exitCode;
  });
  const tools = Object.fromEntries(createGuiTools(runtime).map((x) => [x.name, x]));
  const ctx = { cwd: host.project, hasUI: false, mode: "json", sessionManager: { getSessionId: () => "pi-local" }, ui: { notify: () => {}, setStatus: () => {} } };
  const launched = await tools.gui_launch.execute("call-1", {}, new AbortController().signal, () => {}, ctx);
  const text = launched.content[0].text;
  assert.match(text, /session gui-[0-9a-f]+ started/);
  assert.match(text, /never runs setup commands/);
  const session = launched.details.session;
  const launch = fake.spawner.children[0].requests.find((r) => r.method === "launch");
  assert.equal(launch.params.cwd, realpathSync(host.project), "the app starts in the project directory");
  const stopped = await tools.gui_stop.execute("call-2", { session }, new AbortController().signal, () => {}, ctx);
  assert.match(stopped.content[0].text, /stopped/);
  assert.deepEqual(dockerCalls, []);
  assert.ok(!existsSync(join(host.lockDir, "display-90.lock")));
});

test("a session dir too deep for the bus sockets is refused before anything starts", async (t) => {
  const host = fakeHost(t);
  const fake = localSpawner(host);
  const b = backend(host, fake, { maxSocketPath: 20 });
  await assert.rejects(b.startSession((await startOptions(host)).options), /too deep for the private bus sockets; set TMPDIR/);
  assert.equal(fake.spawner.children.length, 0);
});
