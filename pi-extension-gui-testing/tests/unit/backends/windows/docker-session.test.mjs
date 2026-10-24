import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerWindowsBackend, NETWORK_NONE_MESSAGE } from "../../../../src/backends/docker-windows.ts";
import { ensureKeys } from "../../../../src/backends/docker-windows/keys.ts";
import { helperFiles } from "../../../../src/backends/docker-windows/oem.ts";
import { startLeftovers } from "../../../../src/backends/start-failure.ts";
import { windowsSetupCommand } from "../../../../src/backends/windows/setup-command.ts";
import { BOOT, fakeProc } from "../fakes.mjs";
import { config, fakeWindowsDocker, parseRunArgv, windowsRoot } from "./docker-fakes.mjs";

const OWNER = `c1:100:5000:${BOOT}`;
const INSTALL_ID = "ab".repeat(16);

async function setup(t, { docker = {}, backend = {}, installed = true } = {}) {
  const r = await windowsRoot(t);
  const fake = fakeWindowsDocker(docker);
  fake.state.helperFiles = await helperFiles(r.helperRoot);
  const procRoot = join(r.root, "proc");
  // Pi itself (pid 100) is alive; pid 200 was a Pi that is gone.
  fakeProc(procRoot, { 100: 5000 });
  const b = new DockerWindowsBackend({
    ownerLabel: () => OWNER,
    configDir: r.configDir,
    runner: fake.runner,
    spawner: fake.spawner,
    detached: fake.detached,
    version: "0.1.0",
    endpointSource: {},
    helperRoot: r.helperRoot,
    procRoot,
    bootPollMs: 1,
    sleep: async () => {},
    readyTimeoutMs: 5_000,
    shortControlRoot: r.root,
    ...backend,
  });
  if (installed) {
    await b.acknowledgeLicense();
    await ensureKeys(b.store.dir, fake.runner, { withHostKey: true });
    await b.store.setInstall({ id: INSTALL_ID, state: "installed", startedAt: "2026-10-24T10:00:00.000Z", completedAt: "2026-10-24T10:25:00.000Z", image: b.imageTag, vm: { version: "11", ramGb: 4, cpuCores: 2, diskGb: 64 }, packageVersion: "0.1.0" });
    fake.state.volumes.set("pi-gui-testing-windows-base", { labels: { "pi-gui-testing.windows": "base", "pi-gui-testing.windows.install": INSTALL_ID } });
  }
  const recorded = [];
  const status = [];
  const logs = [];
  let exitArgv;
  const start = (shared = {}, extra = {}) =>
    b.startSession({
      sessionId: "gui-test0001",
      projectRoot: r.project,
      sessionDir: r.sessionDir,
      config: config(shared),
      ownerLabel: OWNER,
      recordResource: async (kind, id) => void recorded.push({ kind, id, containersBefore: fake.state.containers.size }),
      onLog: (e) => logs.push(e),
      onStatus: (x) => status.push(x),
      onExitCleanup: (argv) => (exitArgv = argv),
      signal: new AbortController().signal,
      ...extra,
    });
  return { ...r, ...fake, procRoot, backend: b, recorded, status, logs, start, exitArgv: () => exitArgv };
}

const NAME = "pi-gui-testing-win-gui-test0001";

test("session: container recorded first, overlay + loopback port, boot wait, guest dirs, synced workspace, helper over SSH with stdin env, clean stop", async (t) => {
  const s = await setup(t, { docker: { bootAfter: 3 } });
  await writeFile(join(s.project, ".env"), "SECRET=1\n");
  await mkdir(join(s.project, "src"));
  await writeFile(join(s.project, "src", "main.ps1"), "Write-Output main\n");
  const session = await s.start();

  assert.deepEqual(s.recorded, [{ kind: "container", id: NAME, containersBefore: 0 }]);
  assert.deepEqual(s.exitArgv(), ["docker", "--host", "unix:///var/run/docker.sock", "rm", "-f", NAME]);
  assert.deepEqual(session.forceRemoveArgv(), s.exitArgv());
  const run = s.runner.calls.find((c) => c.argv.includes("run") && c.argv.includes("-d"));
  const p = parseRunArgv(run.argv);
  assert.ok(p.all("-e").includes("ARGUMENTS=-snapshot"));
  assert.deepEqual(p.all("-p"), ["127.0.0.1::22"]);
  assert.ok(p.all("--label").includes("pi-gui-testing.session=gui-test0001"));
  assert.ok(p.all("--label").includes(`pi-gui-testing.owner=${OWNER}`));
  assert.ok(!run.options.env?.PASSWORD);
  assert.equal(s.state.bootProbes, 4, "polled SSH until Windows answered");
  assert.equal(s.state.masters.size, 1, "ControlMaster opened");

  assert.equal(s.state.tars.length, 1);
  assert.equal(s.state.tars[0].dir, "C:\\pi-gui-testing\\sessions\\gui-test0001\\workspace");
  const synced = s.state.tars[0].entries.map((e) => e.path).sort();
  assert.deepEqual(synced, ["app.ps1", "src", "src/main.ps1"]);
  assert.equal(session.sync.files, 2);
  assert.equal(session.sync.excluded, 1, ".env is never synced");
  assert.ok(session.sync.bytes > 0);
  assert.equal(session.workspacePath, "C:\\pi-gui-testing\\sessions\\gui-test0001\\workspace");

  const helper = s.state.helpers[0];
  assert.match(helper.command, /-File C:\\pi-gui-testing\\helper\\helper\.ps1 -StdinEnv PI_GUI_HELPER_MODE,PI_GUI_RUNTIME_DIR,PI_GUI_TESTING_TOKEN,PI_GUI_WORKSPACE$/);
  assert.equal(helper.env.PI_GUI_HELPER_MODE, "guest");
  assert.equal(helper.env.PI_GUI_RUNTIME_DIR, "C:\\pi-gui-testing\\sessions\\gui-test0001\\pi-gui-testing-gui-test0001");
  assert.match(helper.env.PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/);
  assert.equal(helper.env.PI_GUI_ALLOW_EXEC, undefined, "exec stays off without setup commands");
  const spawnArgv = s.spawner.children.find((c) => c.parsed.command.includes("helper.ps1")).argv.join(" ");
  assert.ok(!spawnArgv.includes(helper.env.PI_GUI_TESTING_TOKEN), "token never in argv");
  assert.equal(session.arch, "x64");
  assert.match(session.platform, /^Windows 10\.0\.26100/);
  assert.match(session.workspaceDescription, /synced copy in the Windows guest/);
  assert.equal(session.depsCache, undefined);

  const shot = await session.request("screenshot", {});
  assert.ok(shot.png_base64.length > 0);

  assert.deepEqual(await session.stop(), []);
  assert.ok(s.state.removed.includes(NAME), "container removed with its overlay");
  assert.equal(s.state.containers.size, 0);
  assert.equal(s.state.masters.size, 0, "ControlMaster closed");
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(await session.stop(), [], "idempotent");
});

test("setup commands run in the guest workspace with exec allowed; the deps cache is reported off (no windows-<arch> cache in the helper)", async (t) => {
  const execs = [];
  const s = await setup(t, { docker: { handlers: { exec: (params) => (execs.push(params), { exitCode: 0, elapsedMs: 1 }) } } });
  const session = await s.start({ setup: ["pip install -r requirements.txt", "Set-Content -LiteralPath setup.txt -Value hello"], deps: { env: { PIP_NO_INPUT: "1" } } });
  assert.equal(s.state.helpers[0].env.PI_GUI_ALLOW_EXEC, "1");
  // Review B-F3: each entry runs as a Windows PowerShell 5.1 script (as with cua's Windows sandboxes), never as cmd.exe text.
  assert.deepEqual(execs.map((e) => e.cmd), [windowsSetupCommand("pip install -r requirements.txt"), windowsSetupCommand("Set-Content -LiteralPath setup.txt -Value hello")]);
  const script = Buffer.from(/-EncodedCommand (\S+)$/.exec(execs[1].cmd)[1], "base64").toString("utf16le");
  assert.match(script, /\$ErrorActionPreference = 'Stop'\n[\s\S]*\ntry \{\nSet-Content -LiteralPath setup\.txt -Value hello\n\} catch/);
  assert.ok(execs[1].cmd.startsWith("powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand "));
  assert.equal(execs[0].cwd, session.workspacePath);
  assert.deepEqual(execs[0].env, { PIP_NO_INPUT: "1" });
  assert.ok(s.status.some((x) => x === "setup 1/2 in the Windows guest: pip install -r requirements.txt"), "the status names the command as written");
  assert.equal(session.depsCache.state, "off");
  assert.match(session.depsCache.detail, /no dependency cache/);
  assert.deepEqual(await session.stop(), []);
});

test("helper of another package version in the base: this session gets its own verified copy", async (t) => {
  const s = await setup(t, { docker: { guestHelper: "differ" } });
  const session = await s.start();
  const deploy = s.state.tars.find((x) => x.dir.endsWith("\\helper"));
  assert.equal(deploy.dir, "C:\\pi-gui-testing\\sessions\\gui-test0001\\helper");
  assert.deepEqual(deploy.entries.filter((e) => e.type === "file").map((e) => e.path).sort(), ["THIRD_PARTY_NOTICES.md", "helper.ps1", "src/Json.cs", "src/win/Native.cs"]);
  assert.match(s.state.helpers[0].command, /-File C:\\pi-gui-testing\\sessions\\gui-test0001\\helper\\helper\.ps1/);
  await session.stop();
});

test("refusals before anything starts: not installed, no licence, network none, foreign volume, another live session, a running install", async (t) => {
  let s = await setup(t, { installed: false });
  await assert.rejects(s.start(), /Windows licensing acknowledgement is missing/);
  await s.backend.acknowledgeLicense();
  await assert.rejects(s.start(), /not installed yet; run \/gui-setup docker-windows/);

  s = await setup(t);
  await assert.rejects(s.start({ network: "none" }), (e) => e.message === NETWORK_NONE_MESSAGE);
  s.state.volumes.set("pi-gui-testing-windows-base", { labels: { "pi-gui-testing.windows.install": "cd".repeat(16) } });
  await assert.rejects(s.start(), /missing or belongs to another install/);

  s = await setup(t);
  s.state.containers.set("pi-gui-testing-win-other", { name: "pi-gui-testing-win-other", argv: [], labels: { "pi-gui-testing.windows": "session", "pi-gui-testing.session": "other", "pi-gui-testing.owner": OWNER }, running: true });
  await assert.rejects(s.start(), /one session at a time and pi-gui-testing-win-other is still running/);
  // A session of a dead Pi does not block: it is removed before this one is admitted (it holds the base disk).
  s.state.containers.get("pi-gui-testing-win-other").labels["pi-gui-testing.owner"] = `c1:200:6000:${BOOT}`;
  s.state.containers.set("pi-gui-testing-windows-install", { name: "pi-gui-testing-windows-install", argv: [], labels: { "pi-gui-testing.windows": "install" }, running: true });
  await assert.rejects(s.start(), /install is still running/);
  assert.ok(s.state.removed.includes("id-pi-gui-testing-win-other"), "the dead owner's session container was removed");
  assert.equal(await stat(join(s.backend.store.dir, "session-lease.json")).then(() => true, () => false), false, "a refused start writes no lease");
  assert.deepEqual(s.recorded, []);
  assert.ok(!s.runner.calls.some((c) => c.argv.includes("-d")), "no container was started");
});

test("failed starts remove the container: port on another address (fail closed), container dies while booting, tar fails, setup fails", async (t) => {
  let s = await setup(t, { docker: { publishedOn: "0.0.0.0" } });
  await assert.rejects(s.start(), /published on 0\.0\.0\.0:\d+, not only on 127\.0\.0\.1/);
  assert.equal(s.state.containers.size, 0);
  assert.ok(s.state.removed.includes(NAME));

  s = await setup(t, { docker: { bootAfter: 1_000 } });
  const original = s.runner.run.bind(s.runner);
  let probes = 0;
  s.runner.run = async (argv, o) => {
    if (argv[0] === "ssh" && argv.at(-1) === "echo pi-gui-ready" && ++probes === 3) s.state.containers.get(NAME).running = false;
    return original(argv, o);
  };
  await assert.rejects(s.start(), /container stopped while booting \(last output: ❯ Windows started successfully\)/);
  assert.ok(s.state.removed.includes(NAME));

  s = await setup(t, { docker: { tarFails: true } });
  await assert.rejects(s.start(), /copying the workspace into the Windows guest failed \(exit 1: tar\.exe: Error opening archive\)/);
  assert.equal(s.state.containers.size, 0);

  s = await setup(t, { docker: { handlers: { exec: () => ({ exitCode: 3, elapsedMs: 1 }) } } });
  await assert.rejects(s.start({ setup: ["exit 3"] }), (e) => e.code === "SETUP_FAILED" && /exited with 3 in the Windows guest/.test(e.message));
  assert.equal(s.state.containers.size, 0);
  assert.equal(s.state.masters.size, 0);

  s = await setup(t, { docker: { hostKeyChanged: true } });
  await assert.rejects(s.start(), /refused this machine's pinned SSH identity \(hostkey-changed\)/);
  assert.equal(s.state.containers.size, 0);
});

test("a helper without desktop isolation fails closed (ISOLATION) and the container goes", async (t) => {
  const s = await setup(t, { docker: { capabilities: ["snapshot", "screenshot", "act"] } });
  await assert.rejects(s.start(), (e) => e.code === "ISOLATION" && /no desktop isolation/.test(e.message));
  assert.equal(s.state.containers.size, 0);
});

test("a changed base disk after the session is reported as a leftover; a failed removal stays attached for a retry", async (t) => {
  let s = await setup(t, { docker: { stampChanges: true } });
  const session = await s.start();
  const leftovers = await session.stop();
  assert.equal(leftovers.length, 1);
  assert.equal(leftovers[0].kind, "base-disk");
  assert.match(leftovers[0].detail, /installed Windows disk changed during the session/);

  s = await setup(t, { docker: { tarFails: true } });
  const original = s.runner.run.bind(s.runner);
  let failRm = true;
  s.runner.run = async (argv, o) => (failRm && argv.join(" ").endsWith(`rm -f ${NAME}`) ? { exitCode: 1, signal: null, stdout: "", stderr: "Error: daemon busy", timedOut: false, truncated: false, durationMs: 1 } : original(argv, o));
  const error = await s.start().catch((e) => e);
  const attached = startLeftovers(error);
  assert.ok(attached, "leftovers attached to the start error");
  assert.equal(attached.leftovers[0].id, NAME);
  failRm = false;
  assert.deepEqual(await attached.session.stop(), [], "a retry removes it");
});

test("windows-incompatible names are not synced and named in a launch warning", async (t) => {
  const s = await setup(t);
  await writeFile(join(s.project, "a:b.txt"), "x");
  await writeFile(join(s.project, "CON.md"), "x");
  const session = await s.start();
  assert.deepEqual(s.state.tars[0].entries.map((e) => e.path), ["app.ps1"]);
  assert.equal(session.sync.excluded, 2);
  assert.match(session.warnings[0], /2 file\(s\) were not synced because Windows cannot store their names: (CON\.md, a:b\.txt|a:b\.txt, CON\.md)/);
  await session.stop();
});

/** A second session of the same backend (another id and session dir). */
async function secondStart(s, id) {
  const sessionDir = join(s.root, id);
  await mkdir(sessionDir, { mode: 0o700 });
  return s.start({}, { sessionId: id, sessionDir });
}

test("one session at a time is atomic: two starts that both saw no session container admit exactly one (review A-F5/B-F1)", async (t) => {
  const s = await setup(t);
  // Hold each start at its session-container listing until both arrived (or 300 ms): without an admission lock
  // both see an empty list and both boot the same base disk.
  const original = s.runner.run.bind(s.runner);
  let arrivals = 0;
  let release;
  const barrier = new Promise((r) => {
    release = r;
    setTimeout(r, 300).unref();
  });
  s.runner.run = async (argv, o) => {
    const answer = await original(argv, o);
    if (argv.join(" ").includes("ps -a --no-trunc --filter label=pi-gui-testing.windows=session")) {
      if (++arrivals === 2) release();
      await barrier;
    }
    return answer;
  };
  const results = await Promise.allSettled([secondStart(s, "gui-race0001"), secondStart(s, "gui-race0002")]);
  s.runner.run = original;
  assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
  const refused = results.find((r) => r.status === "rejected").reason;
  assert.match(refused.message, /one session at a time and session gui-race000\d \(container pi-gui-testing-win-gui-race000\d\) is still running or starting/);
  assert.equal([...s.state.containers.values()].filter((c) => c.labels["pi-gui-testing.windows"] === "session").length, 1, "one VM on the base disk");
  const session = results.find((r) => r.status === "fulfilled").value;
  const lease = JSON.parse(await readFile(join(s.backend.store.dir, "session-lease.json"), "utf8"));
  assert.equal(lease.owner, OWNER);
  assert.equal(lease.container, session.containerName);
  assert.deepEqual(await session.stop(), []);
  assert.equal(await stat(join(s.backend.store.dir, "session-lease.json")).then(() => true, () => false), false, "stop gives the lease back");
  // The machine is free again.
  const next = await secondStart(s, "gui-after001");
  assert.deepEqual(await next.stop(), []);
});

test("the lease: a dead owner's is recovered (its container removed first); a live or unjudgeable owner's refuses; this process's abandoned one is reused", async (t) => {
  const s = await setup(t);
  const leaseFile = join(s.backend.store.dir, "session-lease.json");
  const writeLease = (owner, container = "pi-gui-testing-win-gui-old00001") =>
    writeFile(leaseFile, JSON.stringify({ version: 1, owner, session: "gui-old00001", container, token: "0011223344556677", createdAt: "2026-10-24T10:00:00.000Z" }));

  // Dead owner (pid 200 is gone): its container goes before this session is admitted.
  await writeLease(`c1:200:6000:${BOOT}`);
  s.state.containers.set("pi-gui-testing-win-gui-old00001", { name: "pi-gui-testing-win-gui-old00001", argv: [], labels: {}, running: true });
  let session = await s.start();
  assert.ok(s.state.removed.includes("pi-gui-testing-win-gui-old00001"));
  assert.deepEqual(await session.stop(), []);

  // Another live Pi (pid 150) holds it.
  fakeProc(s.procRoot, { 150: 7000 });
  await writeLease(`c2:150:7000:${BOOT}`);
  await assert.rejects(s.start(), /one session at a time and session gui-old00001 \(container pi-gui-testing-win-gui-old00001\) is still running or starting/);
  // An owner label that cannot be judged, and a lease that cannot be read, are never taken over.
  await writeLease("not-a-label");
  await assert.rejects(s.start(), /cannot be judged; run \/gui-cleanup docker-windows/);
  await writeFile(leaseFile, "{");
  await assert.rejects(s.start(), /session lease .* is not a valid lease; if no Pi process runs a docker-windows session, delete that file/);
  assert.ok(!s.runner.calls.some((c) => c.argv.includes("-d") && c.argv.includes("gui-test0001") && s.state.containers.has(NAME)), "nothing started meanwhile");

  // This process's own lease that no session holds any more (a release that could not remove the file).
  await writeLease(OWNER);
  session = await s.start();
  assert.deepEqual(await session.stop(), []);
});

test("a start that fails after admission gives the lease back", async (t) => {
  const s = await setup(t, { docker: { tarFails: true } });
  await assert.rejects(s.start(), /copying the workspace into the Windows guest failed/);
  assert.equal(await stat(join(s.backend.store.dir, "session-lease.json")).then(() => true, () => false), false);
  await assert.rejects(s.start({ setup: ["x".repeat(4_000)] }), (e) => e.code === "SETUP_FAILED" && /too long for a Windows guest/.test(e.message));
  assert.equal(await stat(join(s.backend.store.dir, "session-lease.json")).then(() => true, () => false), false, "refused before admission");
});
