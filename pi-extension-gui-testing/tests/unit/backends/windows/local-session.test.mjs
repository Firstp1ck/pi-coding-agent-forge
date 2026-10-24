import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalWindowsBackend, WINDOWS_COPY_MODE_WARNING } from "../../../../src/backends/local-windows.ts";
import { DEFAULTS } from "../../../../src/config/types.ts";
import { fakeWinHost, fakeWinRunner, ownerRecord, winSpawner, HELPER_DIR, LOCAL, POWERSHELL, PROJECT, SESSION_DIR, SID, SYSTEM_ROOT, TEMP_ROOT, WIN_ENV } from "./local-fakes.mjs";

function config(shared = {}) {
  return {
    shared: { targets: ["windows"], workspaceMode: "mount", network: "default", ...shared },
    limits: { ...DEFAULTS.limits },
    usageCheck: { ...DEFAULTS.usageCheck },
    keepSandbox: false,
    warnings: [],
  };
}

function backend(host, fake, extra = {}) {
  return new LocalWindowsBackend({
    platform: "win32",
    env: WIN_ENV,
    fs: host.fs,
    runner: extra.runner ?? fakeWinRunner(host.world, extra.runnerOptions),
    spawner: fake.spawner,
    helperDir: HELPER_DIR,
    processProbe: host.processProbe,
    genericTmpRoot: "C:\\elsewhere",
    version: "0.2.0",
    readyTimeoutMs: 2_000,
    heartbeatTimeoutMs: 60_000,
    exitWaitMs: 300,
    killWaitMs: 50,
    recordWaitMs: 300,
    ...extra,
  });
}

function startOptions(cfg = config()) {
  const recorded = [];
  const exitCleanup = [];
  const statuses = [];
  return {
    recorded,
    exitCleanup,
    statuses,
    options: {
      sessionId: "gui-test1",
      projectRoot: PROJECT,
      sessionDir: SESSION_DIR,
      config: cfg,
      ownerLabel: "c0ffee:900:1761300100:win32-boot-1761300000",
      recordResource: async (kind, id) => void recorded.push(`${kind} ${id}`),
      onLog: () => {},
      onStatus: (text) => statuses.push(text),
      onExitCleanup: (argv) => exitCleanup.push(argv),
      signal: new AbortController().signal,
    },
  };
}

function runtimeDirs(host) {
  return [...host.fs.entries.values()].filter((e) => e.type === "dir" && /\\pi-gui-testing-win-[0-9a-f]{16}$/.test(e.path)).map((e) => e.path);
}

test("startSession creates a private runtime dir and spawns the local helper with an allow-listed environment", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  const runner = fakeWinRunner(host.world);
  const b = backend(host, fake, { runner });
  const start = startOptions();
  const session = await b.startSession(start.options);

  const runtimeDir = fake.state.runtimeDir;
  assert.match(runtimeDir, /^C:\\Users\\tester\\AppData\\Local\\Temp\\pi-gui-testing-win-[0-9a-f]{16}$/);
  assert.equal(session.backend, "local-windows");
  assert.equal(session.workspacePath, PROJECT, "mount mode runs the app in the project itself");
  assert.equal(session.workspaceDescription, "the project directory itself (writable)");

  // PowerShell from %SystemRoot%, never PATH; the helper script from the package; never -StdinEnv locally.
  assert.deepEqual(fake.state.argv, [POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${HELPER_DIR}\\helper.ps1`]);
  assert.equal(fake.state.cwd, `${SYSTEM_ROOT}\\System32`);

  const env = fake.state.env;
  assert.equal(env.PI_GUI_HELPER_MODE, "local");
  assert.equal(env.PI_GUI_WORKSPACE, PROJECT);
  assert.equal(env.PI_GUI_RUNTIME_DIR, runtimeDir);
  assert.equal(env.LOCALAPPDATA, LOCAL, "the helper checks the runtime dir against %LOCALAPPDATA%\\Temp");
  assert.equal(env.TEMP, TEMP_ROOT, "Add-Type needs TEMP");
  assert.match(env.PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/);
  for (const key of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "PI_GUI_ALLOW_EXEC", "PI_GUI_WIN_DESKTOP", "PI_GUI_ALLOW_ELEVATED"]) assert.equal(env[key], undefined, key);

  // Recorded before creation; mkdir after the record; owner-only ACL with the user's SID.
  assert.equal(start.recorded[0], `tempdir ${runtimeDir}`);
  assert.deepEqual(start.recorded.slice(1), [`process ${fake.helperPid}:1761300200`, `desktop ${fake.state.record.desktop}`]);
  const icacls = runner.calls.find((c) => c.argv[0].endsWith("icacls.exe"));
  assert.deepEqual(icacls.argv, [`${SYSTEM_ROOT}\\System32\\icacls.exe`, runtimeDir, "/inheritance:r", "/grant:r", `*${SID}:(OI)(CI)F`, "/q"]);

  // The owner copy in the runtime dir names the dir and the helper process.
  const owner = JSON.parse(host.fs.read(`${runtimeDir}\\owner.json`));
  assert.equal(owner.pid, 900);
  assert.deepEqual(owner.resources, [{ kind: "tempdir", id: runtimeDir }, { kind: "process", id: `${fake.helperPid}:1761300200` }]);

  const taskkill = [`${SYSTEM_ROOT}\\System32\\taskkill.exe`, "/PID", String(fake.helperPid), "/T", "/F"];
  assert.deepEqual(start.exitCleanup, [taskkill]);
  assert.deepEqual(session.forceRemoveArgv(), taskkill);
  assert.equal(session.desktop, fake.state.record.desktop);

  // Foreground probed before the spawn and after hello.
  const probes = runner.calls.filter((c) => c.argv.includes("-Probe")).map((c) => c.argv.at(-1));
  assert.deepEqual(probes, ["foreground", "foreground"]);
  assert.ok(probes.every(Boolean));
  for (const call of runner.calls.filter((c) => c.argv[0] === POWERSHELL)) assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined);

  await session.request("launch", { cmd: "notepad.exe", args: [], env: {}, cwd: PROJECT });
  assert.equal(host.world.jobs.size, 1);
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(session.forceRemoveArgv(), []);
  assert.deepEqual(runtimeDirs(host), [], "the runtime dir is removed");
  assert.deepEqual(fake.spawner.children[0].requests.map((r) => r.method), ["hello", "launch", "stop"]);
});

test("refusals before anything is created: network none, a non-Windows host, a missing helper", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  await assert.rejects(backend(host, fake).startSession(startOptions(config({ network: "none" })).options), (e) => e.code === "UNSUPPORTED" && /network/.test(e.message));
  await assert.rejects(backend(host, fake, { platform: "linux" }).startSession(startOptions().options), (e) => e.code === "START_FAILED" && /Windows hosts only/.test(e.message));
  host.fs.remove(`${HELPER_DIR}\\helper.ps1`);
  await assert.rejects(backend(host, fake).startSession(startOptions().options), (e) => e.code === "START_FAILED" && /reinstall/.test(e.message));
  assert.equal(fake.spawner.children.length, 0);
  assert.deepEqual(runtimeDirs(host), []);
});

test("a missing SystemRoot or LOCALAPPDATA fails closed instead of searching PATH", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  const { SystemRoot, windir, ...noRoot } = WIN_ENV;
  await assert.rejects(backend(host, fake, { env: noRoot }).startSession(startOptions().options), (e) => e.code === "START_FAILED" && /SystemRoot/.test(e.message));
  const { LOCALAPPDATA, ...noLocal } = WIN_ENV;
  await assert.rejects(backend(host, fake, { env: noLocal }).startSession(startOptions().options), (e) => e.code === "START_FAILED" && /LOCALAPPDATA/.test(e.message));
  await assert.rejects(backend(host, fake, { env: { ...WIN_ENV, LOCALAPPDATA: "\\\\server\\share" } }).startSession(startOptions().options), /not an absolute drive path/);
  assert.equal(fake.spawner.children.length, 0);
});

test("setup commands are skipped with a warning and the helper never gets exec", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  const session = await backend(host, fake).startSession(startOptions(config({ setup: ["npm ci", "npm run build"] })).options);
  assert.match(session.warnings[0], /never runs setup commands; the 2 setup command/);
  assert.equal(fake.state.env.PI_GUI_ALLOW_EXEC, undefined);
  assert.deepEqual(await session.stop(), []);
});

test("copy mode copies the project into the private runtime dir", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  const copies = [];
  const copyWorkspace = async (root, dest, rules) => {
    copies.push({ root, dest, rules });
    host.fs.addDir(dest);
    return { files: 3, bytes: 30, excluded: 1 };
  };
  const session = await backend(host, fake, { copyWorkspace }).startSession(startOptions(config({ workspaceMode: "copy", sync: { deny: ["secret.txt"] } })).options);
  assert.equal(copies[0].root, PROJECT);
  assert.equal(copies[0].dest, `${fake.state.runtimeDir}\\workspace`);
  assert.deepEqual(copies[0].rules.deny, ["secret.txt"]);
  assert.equal(session.workspacePath, copies[0].dest);
  assert.equal(fake.state.env.PI_GUI_WORKSPACE, copies[0].dest);
  assert.deepEqual(session.sync, { files: 3, bytes: 30, excluded: 1 });
  assert.ok(session.warnings.includes(WINDOWS_COPY_MODE_WARNING));
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(runtimeDirs(host), [], "the copy goes with the runtime dir");
});

test("a failed copy removes the runtime dir it created and spawns nothing", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  const copyWorkspace = async () => {
    throw new Error("disk full");
  };
  await assert.rejects(backend(host, fake, { copyWorkspace }).startSession(startOptions(config({ workspaceMode: "copy" })).options), (e) => e.code === "START_FAILED" && /disk full/.test(e.message));
  assert.deepEqual(runtimeDirs(host), []);
  assert.equal(fake.spawner.children.length, 0);
});

test("icacls failure fails closed and removes the new dir", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  const b = backend(host, fake, { runnerOptions: { icacls: { exitCode: 5, stderr: "Access is denied." } } });
  await assert.rejects(b.startSession(startOptions().options), (e) => e.code === "START_FAILED" && /icacls could not make .* private.*Access is denied/.test(e.message));
  assert.deepEqual(runtimeDirs(host), []);
  assert.equal(fake.spawner.children.length, 0);
});

test("a junction in place of the temp root or the runtime dir is refused", async () => {
  const host = fakeWinHost();
  host.fs.remove(TEMP_ROOT);
  host.fs.addDir("D:\\redirected");
  host.fs.addLink(TEMP_ROOT, "D:\\redirected");
  host.fs.addFile("C:\\pi-session\\owner.json", host.fs.read(`${SESSION_DIR}\\owner.json`) ?? JSON.stringify(ownerRecord()));
  const fake = winSpawner(host);
  const start = startOptions();
  start.options.sessionDir = "C:\\pi-session";
  await assert.rejects(backend(host, fake).startSession(start.options), (e) => e.code === "START_FAILED" && /junction or symbolic link/.test(e.message));
  assert.equal(fake.spawner.children.length, 0);
  assert.equal(host.fs.has("D:\\redirected"), true, "the link target is never touched");
});

test("an existing dir at the chosen runtime path is never adopted or removed", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  // mkdir fails with EEXIST: simulate by pre-creating every possible name is impossible, so wrap mkdir.
  const original = host.fs.mkdir.bind(host.fs);
  let target;
  host.fs.mkdir = async (path) => {
    target = path;
    host.fs.addFile(`${path}\\someone-elses.txt`, "keep");
    return original(path);
  };
  await assert.rejects(backend(host, fake).startSession(startOptions().options), (e) => e.code === "START_FAILED" && /EEXIST/.test(e.message));
  assert.equal(host.fs.read(`${target}\\someone-elses.txt`), "keep");
});

test("isolation: a changed foreground window, a non-private desktop, or exec fail closed and clean up", async () => {
  const cases = [
    {
      name: "foreground changed",
      runnerOptions: { probes: { foreground: (() => { let n = 0; return () => ({ probe: "foreground", ok: true, hwnd: n++ === 0 ? "win:0x1a2b" : "win:0x99", title: n === 1 ? "Editor" : "Pi GUI smoke" }); })() } },
      error: /foreground window changed .*win:0x1a2b "Editor" to win:0x99/,
    },
    { name: "interactive capability", spawner: { capabilities: ["launch", "desktop-interactive"] }, error: /private desktop/ },
    { name: "exec allowed", spawner: { capabilities: ["launch", "exec", "desktop-private"] }, error: /allows exec/ },
    { name: "record names the interactive desktop", spawner: { record: { privateDesktop: false, desktop: "Default" } }, error: /interactive desktop, not a private one/ },
    { name: "record with a foreign job", spawner: { record: { jobs: ["Local\\pi-gui-testing-ffffffffffffffff-job-0000000000000000"] } }, error: /job that is not the session's/ },
    { name: "no record", spawner: { noRecord: true }, error: /was not written/ },
  ];
  for (const c of cases) {
    const host = fakeWinHost();
    const fake = winSpawner(host, c.spawner);
    const b = backend(host, fake, c.runnerOptions ? { runnerOptions: c.runnerOptions } : {});
    await assert.rejects(b.startSession(startOptions().options), (error) => {
      assert.equal(error.code, "ISOLATION", c.name);
      assert.match(error.message, c.error, c.name);
      return true;
    });
    assert.deepEqual(runtimeDirs(host), [], `${c.name}: runtime dir removed`);
    assert.equal(fake.spawner.children[0].running(), false, `${c.name}: helper stopped`);
  }
});

test("a foreground probe that fails stops the start before anything is created", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host);
  const b = backend(host, fake, { runnerOptions: { probes: { foreground: { result: { exitCode: 1, stderr: "pi-gui-helper: compiling the helper failed (antivirus or application control blocking csc.exe?): denied" } } } } });
  await assert.rejects(b.startSession(startOptions().options), (e) => e.code === "START_FAILED" && /antivirus/.test(e.message));
  assert.deepEqual(runtimeDirs(host), []);
  assert.equal(fake.spawner.children.length, 0);
});

test("after a helper crash the client ends recorded processes and jobs, then removes the dir", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host, { dirty: true });
  const session = await backend(host, fake).startSession(startOptions().options);
  await session.request("launch", { cmd: "app.exe", args: [], env: {}, cwd: PROJECT });
  const [job] = fake.state.record.jobs;
  fake.spawner.children[0].exit(null, "SIGKILL");
  assert.ok(host.world.jobs.has(job));
  assert.deepEqual(await session.stop(), []);
  assert.ok(host.world.killed.includes(job), "the job was terminated");
  assert.ok(host.world.killed.includes("5000:133000000000000000"), "the relaunched helper copy was ended");
  assert.equal(host.world.processes.size, 0);
  assert.deepEqual(runtimeDirs(host), []);
  assert.deepEqual(await session.auditFootprint(), []);
});

test("a leftover that survives keeps the dir for a retry, which then succeeds", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host, { dirty: true });
  const session = await backend(host, fake).startSession(startOptions().options);
  await session.request("launch", { cmd: "app.exe", args: [], env: {}, cwd: PROJECT });
  const proc = `${fake.state.record.processes[0].pid}:${fake.state.record.processes[0].created}`;
  const [job] = fake.state.record.jobs;
  host.world.unkillable.add(proc);
  host.world.unkillable.add(job);
  fake.spawner.children[0].exit(null, "SIGKILL");
  const first = await session.stop();
  // The surviving app process still uses the private desktop, so that stays too.
  assert.deepEqual(first.map((l) => l.kind).sort(), ["desktop", "job", "process", "tempdir"]);
  assert.match(first.find((l) => l.kind === "tempdir").detail, /kept until/);
  assert.equal(runtimeDirs(host).length, 1);
  const audit = await session.auditFootprint();
  assert.ok(audit.some((l) => l.kind === "process" && l.id === proc && /still exists/.test(l.detail)));
  host.world.unkillable.clear();
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(runtimeDirs(host), []);
});

test("objects that cannot be inspected are reported, never assumed gone", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host, { dirty: true });
  const session = await backend(host, fake).startSession(startOptions().options);
  fake.spawner.children[0].exit(null, "SIGKILL");
  host.world.inspectFails = true;
  const leftovers = await session.stop();
  assert.ok(leftovers.some((l) => l.kind === "process" && /could not be inspected .*language mode/.test(l.detail)));
  assert.ok(leftovers.some((l) => l.kind === "tempdir"));
  host.world.inspectFails = false;
  await new Promise((resolve) => setImmediate(resolve)); // the first attempt has settled
  assert.deepEqual(await session.stop(), []);
});

test("smokeApp runs the WinForms app with Windows PowerShell; smokeConfig targets Windows with the host network", () => {
  const host = fakeWinHost();
  const b = backend(host, winSpawner(host), { smokeAppPath: "C:\\pkg\\src\\backends\\windows\\smoke-app.ps1" });
  assert.deepEqual(b.smokeApp(), { cmd: POWERSHELL, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", "C:\\pkg\\src\\backends\\windows\\smoke-app.ps1"] });
  const smoke = b.smokeConfig(config({ network: "none", targets: ["linux"] }));
  assert.equal(smoke.shared.network, "default");
  assert.deepEqual(smoke.shared.targets, ["windows"]);
});

test("sweep gate and drift run no command", async () => {
  const host = fakeWinHost();
  const runner = fakeWinRunner(host.world);
  const fake = winSpawner(host);
  assert.equal(await backend(host, fake, { runner }).sweepAvailable({ startup: true }), true);
  assert.equal(await backend(host, fake, { runner, platform: "linux" }).sweepAvailable({ startup: true }), false);
  assert.equal(await backend(host, fake, { runner, env: { SystemRoot: SYSTEM_ROOT } }).sweepAvailable({ startup: true }), false);
  const versions = await backend(host, fake, { runner, common: { piVersion: "1.5.0" } }).currentVersions();
  assert.deepEqual(versions, { "package.version": "0.2.0", "pi.version": "1.5.0", protocol: "2" });
  assert.equal(runner.calls.length, 0);
});

test("stop still cleans up after the start's abort signal fired", async () => {
  const host = fakeWinHost();
  const fake = winSpawner(host, { dirty: true });
  const start = startOptions();
  const controller = new AbortController();
  start.options.signal = controller.signal;
  const session = await backend(host, fake).startSession(start.options);
  controller.abort();
  fake.spawner.children[0].exit(null, "SIGKILL");
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(runtimeDirs(host), []);
});
