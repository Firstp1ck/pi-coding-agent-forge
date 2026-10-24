/**
 * `cua` sessions with a Windows target on the fake Cua API: target selection,
 * the refusal while the cloud offers no Windows image, recording before
 * creation, the private guest dir, the helper files checked by hash, the
 * workspace sync, the helper over `exec -i` with `-StdinEnv`, `setup` as
 * encoded PowerShell, and the same stop, failed-start, keepSandbox, cost,
 * sweep, check, and drift behaviour as Linux. No `cua` process runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { CuaBackend } from "../../../../src/backends/cua.ts";
import { CuaApiError } from "../../../../src/backends/cua/api.ts";
import { CuaCostLedger } from "../../../../src/backends/cua/cost.ts";
import { SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { hasDeadOwnerRecords } from "../../../../src/backends/cua/orphans.ts";
import { CuaSettingsStore } from "../../../../src/backends/cua/settings.ts";
import { windowsHelperArgv, windowsHelperFiles, windowsSetupCommand } from "../../../../src/backends/cua/windows.ts";
import { runChecks } from "../../../../src/checks/runner.ts";
import { DEFAULTS } from "../../../../src/config/types.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { formatOwnerLabel } from "../../../../src/owner.ts";
import { BOOT, fakeProc } from "../fakes.mjs";
import { cuaEnv, FakeCuaApi, HOST_TAG, LIVE_OWNER, PROVIDERS, tinyHelperArchive } from "./fake-cua.mjs";

const WINDOWS_KIND = { image: "windows", kind: "vm", supported: true, machineType: "m8i.xlarge", usdPerHour: 1.2 };
/** What `cua cloud status` reports for Windows on AWS in cua 0.9 (`cua-byoc/src/aws.rs`). */
const AWS_WINDOWS_TODAY = { image: "windows", kind: "vm", supported: false, reason: "needs a nested-virtualization instance; not offered on AWS yet", usdPerHour: 0 };

/** The fake clouds; `windowsKind` null lists no Windows entry. */
function providers(windowsKind = WINDOWS_KIND) {
  return [{ ...PROVIDERS[0], kinds: [...PROVIDERS[0].kinds, ...(windowsKind ? [windowsKind] : [])] }, PROVIDERS[1]];
}

const WINDOWS_HELLO = (params) => ({
  protocol: params.protocol,
  helperVersion: "0.1.0",
  os: "windows",
  arch: "x64",
  platform: "Windows 10.0.20348 x64; .NET Framework 4.0.30319.42000; PowerShell 5.1.20348.2849",
  capabilities: ["snapshot", "screenshot", "act", "exec", "a11y-uia", "desktop-private"],
});

const ok = (stdout = "") => ({ exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, truncated: false, durationMs: 1 });

/** The fake Cua with a Windows guest: answers the PowerShell guest commands and records their decoded scripts. */
class WindowsFakeCua extends FakeCuaApi {
  constructor(options = {}) {
    const { guest, ...rest } = options;
    super({ providers: providers(), ...rest, behaviour: { ...(rest.behaviour ?? {}), handlers: { hello: WINDOWS_HELLO, ...(rest.behaviour?.handlers ?? {}) } } });
    this.guest = guest ?? {};
    this.scripts = [];
  }

  async exec(ref, argv, options) {
    if (argv[0] !== "powershell.exe") return super.exec(ref, argv, options);
    this.calls.push({ method: "exec", args: [ref, [...argv], options] });
    if (!this.sandboxes.has(ref)) throw new CuaApiError("NOT_FOUND", `no sandbox ${ref}`);
    assert.equal(argv.at(-2), "-EncodedCommand");
    const script = Buffer.from(argv.at(-1), "base64").toString("utf16le");
    this.scripts.push(script);
    if (script.includes("missing:powershell")) return { ...ok(), ...(this.guest.probe ?? { stdout: "build:20348\r\n" }) };
    if (script.includes("Get-FileHash")) return { ...ok("ok:17\r\n"), ...(this.guest.verify ?? {}) };
    return ok();
  }
}

function config(overrides = {}) {
  return {
    shared: { targets: ["windows"], workspaceMode: "copy", network: "default", launch: { cmd: "notepad.exe", args: [] }, ...(overrides.shared ?? {}) },
    limits: { ...DEFAULTS.limits },
    usageCheck: { ...DEFAULTS.usageCheck },
    keepSandbox: overrides.keepSandbox ?? false,
    warnings: [],
  };
}

async function setup(t, options = {}) {
  const env = await cuaEnv(t, options);
  const api = options.api ?? new WindowsFakeCua(options.fake);
  const ledger = new SandboxLedger(env.ledgerDir);
  let now = 1_000_000;
  const cost = new CuaCostLedger(() => now);
  const runner = new FakeCommandRunner().on(() => true, { exitCode: 128, stderr: "not a git repository" });
  const backend = new CuaBackend({
    ownerLabel: () => LIVE_OWNER,
    api,
    runner,
    ledger,
    settings: new CuaSettingsStore(env.settingsPath),
    cost,
    hostTag: HOST_TAG,
    version: "0.1.0",
    procRoot: env.proc,
    helperArchive: tinyHelperArchive,
    readyTimeoutMs: 2_000,
    heartbeatIntervalMs: 0,
    exitWaitMs: 200,
    killWaitMs: 50,
    ...(options.backend ?? {}),
  });
  const events = { recorded: [], exitCleanup: [], status: [] };
  let counter = 0;
  const start = (overrides = {}) =>
    backend.startSession({
      sessionId: overrides.sessionId ?? `gui-0000000${++counter}`,
      projectRoot: env.project,
      sessionDir: env.sessionDir,
      config: overrides.config ?? config(),
      ...(overrides.target ? { target: overrides.target } : {}),
      ownerLabel: LIVE_OWNER,
      recordResource: async (kind, id) => {
        events.recorded.push({ kind, id, sandboxes: api.sandboxes.size, ledger: existsSync(ledger.dir) ? (await readdir(ledger.dir)).length : 0 });
      },
      onLog: () => {},
      onStatus: (text) => events.status.push(text),
      onExitCleanup: (argv) => events.exitCleanup.push({ argv, sandboxes: api.sandboxes.size }),
      signal: new AbortController().signal,
    });
  return { env, api, ledger, cost, backend, start, events, advance: (ms) => (now += ms) };
}

const NAME = `pi-gui-testing-${HOST_TAG}-gui-00000001`;
const REF = `aws:${NAME}`;
const DIR = "C:\\pi-gui-testing\\gui-00000001";

test("a Windows session is recorded before creation, deploys the 17 helper files checked by hash, syncs, and starts the helper over -StdinEnv", async (t) => {
  const { api, ledger, start, events, env } = await setup(t);
  const session = await start();
  t.after(() => session.stop());
  assert.equal(events.recorded[0].id, REF);
  assert.equal(events.recorded[0].sandboxes, 0, "owner.json lists the sandbox before it exists");
  assert.equal(events.exitCleanup[0].sandboxes, 0, "the exit handler knows it before it exists");
  assert.deepEqual(events.exitCleanup[0].argv, ["cua", "sandbox", "rm", REF, "--force"]);
  assert.deepEqual(api.calls.find((c) => c.method === "createSandbox").args[0], { name: NAME, location: "aws", image: "windows" });
  const record = await ledger.read(NAME);
  assert.equal(record.phase, "created");
  assert.equal(record.target, "windows");
  assert.equal(record.image, "windows");
  assert.match(events.status.join("\n"), /creating a Windows Cua sandbox in your aws account/);

  // Guest commands, in order: private dir, requirements, unpack + remove the helper archive, hash check, unpack + remove the workspace archive.
  const [prepare, probe, extractTools, removeTools, verify, extractWorkspace, removeWorkspace] = api.scripts;
  assert.match(prepare, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(prepare, new RegExp(`'${DIR.replace(/\\/g, "\\\\")}\\\\pi-gui-testing-gui-00000001'`));
  assert.match(probe, /missing:powershell/);
  assert.match(extractTools, /tar\.exe'\) -x -f \$archive -C \$dir/);
  assert.match(extractTools, /\$dir = 'C:\\pi-gui-testing\\gui-00000001\\tools'/);
  assert.match(removeTools, /Remove-Item -LiteralPath 'C:\\pi-gui-testing\\gui-00000001\\tools\.tar'/);
  for (const file of await windowsHelperFiles()) assert.ok(verify.includes(`'${file.path.replace(/\//g, "\\")}' = '${file.sha256.toUpperCase()}'`), `${file.path} is checked by hash`);
  assert.match(extractWorkspace, /\$dir = 'C:\\pi-gui-testing\\gui-00000001\\workspace'/);
  assert.match(removeWorkspace, /workspace\.tar/);
  assert.equal(api.calls.filter((c) => c.method === "exec").some((c) => c.args[1][0] === "sh" || c.args[1][0] === "rm" || c.args[1][0] === "tar"), false, "no POSIX command on a Windows guest");

  assert.deepEqual(api.uploads.map((u) => u.guestPath), [`${DIR}\\tools.tar`, `${DIR}\\workspace.tar`]);
  assert.equal(api.uploads[0].entries.filter((e) => e.type === "file").length, 17);
  assert.deepEqual(api.uploads[1].entries.filter((e) => e.type === "file").map((e) => e.path).sort(), ["app.py", "src/lib.py"], "secrets are never uploaded");
  assert.deepEqual((await readdir(env.sessionDir)).filter((f) => f.endsWith(".tar")), []);

  const spawn = api.calls.find((c) => c.method === "spawnHelper");
  assert.deepEqual(spawn.args[1], windowsHelperArgv("gui-00000001"));
  assert.deepEqual(
    Object.fromEntries(Object.entries(spawn.args[2]).filter(([k]) => k !== "PI_GUI_TESTING_TOKEN")),
    { PI_GUI_HELPER_MODE: "guest", PI_GUI_WORKSPACE: `${DIR}\\workspace`, PI_GUI_RUNTIME_DIR: `${DIR}\\pi-gui-testing-gui-00000001`, PI_GUI_ALLOW_EXEC: "1" },
  );
  assert.match(spawn.args[2].PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/);
  assert.equal(session.workspacePath, `${DIR}\\workspace`);
  assert.equal(session.target, "windows");
  assert.match(session.platform, /^Windows 10\.0\.20348/);
  const launched = await session.request("launch", { cmd: "notepad.exe", args: [], env: {}, cwd: session.workspacePath });
  assert.equal(launched.pid, 77);
});

test("the stream option -StdinEnv is requested for Windows and never for Linux", async (t) => {
  const seen = [];
  class Spy extends WindowsFakeCua {
    spawnHelper(ref, argv, env, options) {
      seen.push(options);
      return super.spawnHelper(ref, argv, env);
    }
  }
  const api = new Spy();
  const { start } = await setup(t, { api });
  const windows = await start();
  await windows.stop();
  assert.deepEqual(seen, [{ stdinEnv: "powershell" }]);
});

test("the launch's target wins over the project's first target; Linux sessions are unchanged", async (t) => {
  const { api, start } = await setup(t);
  const windows = await start({ target: "windows", config: config({ shared: { targets: ["linux", "windows"] } }) });
  const linux = await start({ target: "linux", config: config({ shared: { targets: ["windows", "linux"] } }) });
  const fallback = await start({ config: config({ shared: { targets: ["linux"] } }) });
  t.after(() => Promise.all([windows.stop(), linux.stop(), fallback.stop()]));
  assert.deepEqual(api.calls.filter((c) => c.method === "createSandbox").map((c) => c.args[0].image), ["windows", "linux", "linux"]);
  const spawns = api.calls.filter((c) => c.method === "spawnHelper");
  assert.deepEqual(spawns[1].args[1], ["python3", "-I", "/tmp/pi-gui-testing/gui-00000002/tools/helper"]);
  assert.equal(linux.workspacePath, "/tmp/pi-gui-testing/gui-00000002/workspace");
  assert.equal(linux.target, "linux");
  assert.equal(windows.target, "windows");
});

test("Windows is refused before anything bills while the cloud offers no Windows image; macOS stays planned", async (t) => {
  for (const [kind, why] of [
    [AWS_WINDOWS_TODAY, /windows on aws: needs a nested-virtualization instance; not offered on AWS yet/],
    [null, /windows on aws: cua cloud status lists no Windows image/],
  ]) {
    const { api, ledger, start, events } = await setup(t, { fake: { providers: providers(kind) } });
    await assert.rejects(start(), (error) => error.code === "UNSUPPORTED" && why.test(error.message) && /\/gui-setup cua/.test(error.message));
    assert.ok(!api.methods().includes("createSandbox"));
    assert.deepEqual(await ledger.entries(), []);
    assert.deepEqual(events.recorded, []);
  }
  const { api, start } = await setup(t);
  await assert.rejects(start({ target: "macos" }), (error) => error.code === "UNSUPPORTED" && /macos: .*planned/.test(error.message));
  assert.deepEqual(api.methods(), [], "refused before any Cua call");
});

test("a Windows image chosen at setup is used; one no kind covers is trusted, one Cua marks unsupported is refused", async (t) => {
  {
    const { api, start } = await setup(t, { settings: { windowsImage: "registry.example/win11-dev:1" }, fake: { providers: providers(null) } });
    const session = await start();
    await session.stop();
    assert.equal(api.calls.find((c) => c.method === "createSandbox").args[0].image, "registry.example/win11-dev:1");
  }
  {
    const { api, start } = await setup(t, { settings: { windowsImage: "ghcr.io/trycua/windows:2022" }, fake: { providers: providers(AWS_WINDOWS_TODAY) } });
    await assert.rejects(start(), /not offered on AWS yet/);
    assert.ok(!api.methods().includes("createSandbox"));
  }
});

test("a guest without PowerShell 5.1, a recent build, or tar.exe fails the start and deletes the sandbox", async (t) => {
  const { api, ledger, start } = await setup(t, { fake: { guest: { probe: { stdout: "missing:windows-build\r\nmissing:tar\r\nbuild:17134\r\n" } } } });
  await assert.rejects(start(), (error) => error.code === "START_FAILED" && /preparing the Windows sandbox/.test(error.message) && /build 17763\) or newer, found build 17134/.test(error.message) && /tar\.exe/.test(error.message));
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await ledger.entries(), []);
  assert.deepEqual(api.uploads, [], "nothing uploaded");
});

test("a helper file that does not match its hash fails the start and deletes the sandbox", async (t) => {
  const { api, ledger, start } = await setup(t, { fake: { guest: { verify: { exitCode: 1, stdout: "bad:src\\win\\Native.cs\r\n" } } } });
  await assert.rejects(start(), (error) => /deploying the helper/.test(error.message) && /missing or changed: src\\win\\Native\.cs/.test(error.message));
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await ledger.entries(), []);
  assert.equal(api.uploads.length, 1, "the workspace is never uploaded next to an unverified helper");
});

test("a sandbox that answers with another helper fails closed and is deleted", async (t) => {
  const linuxHello = (params) => ({ protocol: params.protocol, helperVersion: "0.1.0", os: "linux", arch: "x86_64", capabilities: ["snapshot"] });
  const { api, ledger, start } = await setup(t, { fake: { behaviour: { handlers: { hello: linuxHello } } } });
  await assert.rejects(start(), (error) => error.code === "START_FAILED" && /did not start the Windows helper/.test(error.message));
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await ledger.entries(), []);
});

test("setup runs as encoded PowerShell in the Windows workspace; a failure stops the session; an oversized command is refused before anything bills", async (t) => {
  const execs = [];
  const exec = (params) => {
    execs.push(params);
    return { exitCode: params.cmd === windowsSetupCommand("exit 4") ? 4 : 0, elapsedMs: 1 };
  };
  const { api, start } = await setup(t, { fake: { behaviour: { handlers: { exec } } } });
  const session = await start({ config: config({ shared: { setup: ["npm ci", "pip install -r requirements.txt"], deps: { env: { CI: "1" } } } }) });
  await session.stop();
  assert.deepEqual(execs.map((e) => e.cmd), [windowsSetupCommand("npm ci"), windowsSetupCommand("pip install -r requirements.txt")]);
  assert.ok(execs.every((e) => e.cwd === `${DIR}\\workspace` && e.env.CI === "1"));

  await assert.rejects(start({ config: config({ shared: { setup: ["exit 4"] } }) }), (error) => error.code === "SETUP_FAILED" && /setup command "exit 4" exited with 4/.test(error.message));
  assert.equal(api.deleted.length, 2, "the failed session's sandbox is deleted");

  const calls = api.calls.length;
  await assert.rejects(start({ config: config({ shared: { setup: ["x".repeat(4_000)] } }) }), (error) => error.code === "SETUP_FAILED" && /too long for a Windows sandbox/.test(error.message));
  assert.equal(api.calls.length, calls, "no Cua call");
});

test("stop deletes the Windows sandbox and its record; the audit is empty; stop is idempotent", async (t) => {
  const { api, ledger, start } = await setup(t);
  const session = await start();
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await ledger.entries(), []);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(session.forceRemoveArgv(), []);
});

test("a failed delete is a leftover that keeps the record as deleting, and a retry finishes", async (t) => {
  let failures = 1;
  const { api, ledger, start } = await setup(t, { fake: { fail: { delete: () => (failures-- > 0 ? "TRANSPORT" : undefined) } } });
  const session = await start();
  const leftovers = await session.stop();
  assert.equal(leftovers.length, 1);
  assert.match(leftovers[0].detail, /keep billing/);
  assert.equal((await ledger.entries())[0].record.phase, "deleting");
  assert.deepEqual(session.forceRemoveArgv(), ["cua", "sandbox", "rm", REF, "--force"]);
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await ledger.entries(), []);
  assert.equal(api.sandboxes.size, 0);
});

test("keepSandbox: the session dir is removed without following links, and only a Windows session of the project reuses the sandbox", async (t) => {
  const { api, ledger, start } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  assert.deepEqual(await first.stop(), []);
  assert.match(api.scripts.at(-1), /\$dir = 'C:\\pi-gui-testing\\gui-00000001'/);
  assert.match(api.scripts.at(-1), /rmdir \/s \/q \$dir/);
  const [kept] = await ledger.entries();
  assert.equal(kept.kept, true);
  assert.equal(kept.record.target, "windows");
  assert.deepEqual(api.deleted, []);
  assert.deepEqual(first.forceRemoveArgv(), [], "the exit handler leaves a kept sandbox alone");

  // A Linux session of the same project never claims it (and does not warn about it).
  const linux = await start({ target: "linux", config: config({ keepSandbox: true, shared: { targets: ["linux"] } }) });
  assert.equal(api.calls.filter((c) => c.method === "createSandbox").length, 2);
  assert.deepEqual(linux.warnings ?? [], []);
  await linux.stop();

  // A Windows session reuses it: the old session dirs go first, then the helper is deployed again.
  const scriptsBefore = api.scripts.length;
  const second = await start({ config: config({ keepSandbox: true }) });
  assert.equal(api.calls.filter((c) => c.method === "createSandbox").length, 2, "no new sandbox");
  assert.match(api.scripts[scriptsBefore], /\$dir = 'C:\\pi-gui-testing'\n/);
  assert.match(api.scripts[scriptsBefore], /rmdir \/s \/q \$dir/);
  assert.equal(api.calls.filter((c) => c.method === "spawnHelper").at(-1).args[0], REF);
  assert.deepEqual(await second.stop(), []);
  assert.equal((await ledger.entries()).filter((e) => e.kept).length, 2, "both sandboxes stay kept, one per target");
});

test("the cost estimate uses the Windows price, never the Linux one, and stops at deletion", async (t) => {
  const usage = (id) => ({ session: id, backend: "cua", startedAt: 0, toolCalls: {}, actions: 0, screenshots: 0, allBlackScreenshots: 0, bytesSynced: 0, warnings: [] });
  {
    const { backend, start, advance } = await setup(t);
    const session = await start();
    advance(30 * 60_000);
    assert.equal(backend.estimateCost(usage(session.id)).sessionUsd, 0.6);
    await session.stop();
    advance(60 * 60_000);
    assert.equal(backend.estimateCost(usage(session.id)).sessionUsd, 0.6);
  }
  {
    // No Windows price reported: the rate entered at setup, never the Linux $0.50.
    const { backend, start, advance } = await setup(t, { settings: { windowsRateUsdPerHour: 2, rateUsdPerHour: 0.1 }, fake: { providers: providers({ ...WINDOWS_KIND, usdPerHour: undefined }) } });
    const session = await start();
    advance(30 * 60_000);
    assert.equal(backend.estimateCost(usage(session.id)).sessionUsd, 1);
    await session.stop();
  }
  {
    const { backend, start, advance } = await setup(t, { fake: { providers: providers({ ...WINDOWS_KIND, usdPerHour: undefined }) } });
    const session = await start();
    advance(30 * 60_000);
    assert.equal(backend.estimateCost(usage(session.id)), undefined, "no estimate rather than a Linux price");
    await session.stop();
  }
});

test("the startup sweep deletes a dead owner's Windows sandbox like a Linux one", async (t) => {
  const { api, ledger, backend, env } = await setup(t);
  const dead = formatOwnerLabel({ clientId: "dead00", pid: 999, processStartTime: "5", bootId: BOOT });
  fakeProc(env.proc, { 4242: 1000 });
  await ledger.write({ version: 1, name: NAME, ref: REF, location: "aws", ownerLabel: dead, sessionId: "gui-00000001", projectKey: "p", phase: "created", keep: false, createdAt: "2026-10-24T00:00:00.000Z", image: "windows", target: "windows" });
  api.sandboxes.set(REF, { name: NAME, location: "aws", status: "ready", image: "windows" });
  assert.equal(await hasDeadOwnerRecords(ledger, env.proc), true, "the startup gate sees it without a Cua call");
  assert.deepEqual(await backend.sweepOrphans(new AbortController().signal), []);
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await ledger.entries(), []);
});

test("a ledger record with an unknown target is unreadable, never acted on", async (t) => {
  const { ledger } = await setup(t);
  await ledger.write({ version: 1, name: NAME, ref: REF, location: "aws", ownerLabel: LIVE_OWNER, sessionId: "gui-1", projectKey: "p", phase: "created", keep: false, createdAt: "2026-10-24T00:00:00.000Z", target: "macos" }).catch(() => undefined);
  const entries = await ledger.entries();
  assert.ok(entries.length === 0 || entries.every((e) => e.problem !== undefined && e.record === undefined), JSON.stringify(entries));
});

test("checks: cua.targets passes with a Windows image the cloud supports, fails with Cua's reason otherwise; the Windows image is a drift input", async (t) => {
  const run = async (opts) => {
    const env = await cuaEnv(t, { settings: opts.settings });
    const api = new WindowsFakeCua({ providers: opts.providers });
    const backend = new CuaBackend({
      ownerLabel: () => LIVE_OWNER,
      api,
      ledger: new SandboxLedger(env.ledgerDir),
      settings: new CuaSettingsStore(env.settingsPath),
      hostTag: HOST_TAG,
      version: "0.1.0",
      procRoot: env.proc,
      probeNetwork: async () => "ok",
      targets: async () => opts.targets ?? ["linux", "windows"],
      common: { piVersion: "1.4.0", platform: "linux", minFreeBytes: 1, configDir: env.root },
    });
    const results = Object.fromEntries((await runChecks(backend.checks(), { runner: new FakeCommandRunner(), backend: "cua", projectRoot: env.project, signal: new AbortController().signal })).map((r) => [r.id, r]));
    return { results, backend, api };
  };
  const supported = await run({ providers: providers() });
  assert.equal(supported.results["cua.targets"].status, "pass", supported.results["cua.targets"].observed);
  assert.equal(supported.results["cua.targets"].observed, "linux (linux on t3.medium); windows (windows on m8i.xlarge)");
  assert.deepEqual(supported.results["cua.targets"].facts, { "cua.image": "linux", "cua.windowsImage": "windows" });
  assert.equal(supported.results["cua.rate"].status, "pass");
  assert.equal(supported.results["cua.rate"].observed, "linux ~$0.50/h (reported by Cua); windows ~$1.20/h (reported by Cua)");
  assert.ok(!supported.api.methods().some((m) => ["createSandbox", "exec", "upload", "spawnHelper"].includes(m)), "checks create nothing");
  const versions = await supported.backend.currentVersions();
  assert.equal(versions["cua.windowsImage"], "windows", "the Windows image is compared at every launch");
  for (const [key, value] of Object.entries(supported.results["cua.targets"].facts)) assert.equal(versions[key], value, `${key}: setup facts and drift values agree`);

  const today = await run({ providers: providers(AWS_WINDOWS_TODAY) });
  assert.equal(today.results["cua.targets"].status, "fail");
  assert.equal(today.results["cua.targets"].observed, "windows on aws: needs a nested-virtualization instance; not offered on AWS yet");

  const linuxOnly = await run({ providers: providers(AWS_WINDOWS_TODAY), targets: ["linux"] });
  assert.equal(linuxOnly.results["cua.targets"].status, "pass", "a Linux-only project is unaffected by the cloud's Windows support");
  assert.equal(linuxOnly.results["cua.targets"].observed, "linux (linux on t3.medium)");
  assert.equal(linuxOnly.results["cua.rate"].observed, "~$0.50/h (reported by Cua)");

  const custom = await run({ providers: providers({ ...WINDOWS_KIND, usdPerHour: undefined }), settings: { windowsImage: "windows:2025" } });
  assert.equal(custom.results["cua.targets"].facts["cua.windowsImage"], "windows:2025");
  assert.equal(custom.results["cua.rate"].status, "warn");
  assert.match(custom.results["cua.rate"].observed, /windows: no price reported and none entered/);
});

test("setup inputs store the Windows image and rate in cua.json", async (t) => {
  const { backend } = await setup(t);
  await backend.recordSetupInputs({ windowsImage: "windows:2025", windowsRateUsdPerHour: 1.5 });
  const settings = await backend.settings.read();
  assert.equal(settings.windowsImage, "windows:2025");
  assert.equal(settings.windowsRateUsdPerHour, 1.5);
  await assert.rejects(backend.recordSetupInputs({ windowsImage: "-bad" }), /invalid windowsImage/);
  await assert.rejects(backend.recordSetupInputs({ windowsRateUsdPerHour: -1 }), /invalid windowsRateUsdPerHour/);
});
