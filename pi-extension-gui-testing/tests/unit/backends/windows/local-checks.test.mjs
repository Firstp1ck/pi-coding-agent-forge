import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../../../src/checks/runner.ts";
import { LocalWindowsBackend } from "../../../../src/backends/local-windows.ts";
import { fakeWinHost, fakeWinRunner, winSpawner, HELPER_DIR, POWERSHELL, POWERSHELL_INFO, PROJECT, SYSTEM_ROOT, WIN_ENV } from "./local-fakes.mjs";

const IDS = [
  "pi.version",
  "host.os",
  "config.writable",
  "disk.free",
  "win.powershell",
  "win.execution-policy",
  "helper.present",
  "win.version",
  "win.arch",
  "helper.desktop",
  "helper.job",
  "helper.nonelevated",
  "helper.uia",
  "helper.av",
];

async function run(t, { platform = "win32", runnerOptions, host = fakeWinHost(), env = WIN_ENV } = {}) {
  const configDir = mkdtempSync(join(tmpdir(), "gui-win-checks-"));
  t.after(() => rmSync(configDir, { recursive: true, force: true }));
  const runner = fakeWinRunner(host.world, runnerOptions);
  const backend = new LocalWindowsBackend({
    platform,
    env,
    fs: host.fs,
    runner,
    spawner: winSpawner(host).spawner,
    helperDir: HELPER_DIR,
    processProbe: host.processProbe,
    version: "0.2.0",
    common: { platform, piVersion: "1.5.0", configDir, diskPath: tmpdir() },
  });
  const checks = backend.checks();
  const results = await runChecks(checks, { runner, backend: "local-windows", projectRoot: PROJECT, signal: new AbortController().signal });
  return { checks, runner, byId: Object.fromEntries(results.map((r) => [r.id, r])) };
}

test("the check list matches spec §5.4 plus the PowerShell checks", async (t) => {
  const { checks } = await run(t);
  assert.deepEqual(checks.map((c) => c.id), IDS);
  const required = Object.fromEntries(checks.map((c) => [c.id, c.required]));
  assert.equal(required["helper.av"], false);
  for (const id of IDS.filter((i) => i !== "helper.av")) assert.equal(required[id], true, id);
});

test("all checks pass on a healthy host, and the env probe runs once for three checks", async (t) => {
  const { byId, runner } = await run(t);
  for (const id of IDS) assert.equal(byId[id].status, "pass", `${id}: ${byId[id].observed}`);
  assert.match(byId["win.version"].observed, /^build 22631 \(Windows 10\.0\.22631 x64/);
  assert.deepEqual(byId["win.version"].facts, { "windows.build": "22631" });
  assert.equal(byId["win.arch"].observed, "x64");
  assert.match(byId["win.powershell"].observed, /PowerShell 5\.1\.\d+.* \(Desktop\), FullLanguage at C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
  const probes = runner.calls.filter((c) => c.argv.includes("-Probe")).map((c) => c.argv.at(-1)).sort();
  assert.deepEqual(probes, ["desktop", "env", "job", "nonelevated", "uia"]);
  for (const call of runner.calls) {
    assert.equal(call.argv[0].startsWith(`${SYSTEM_ROOT}\\System32\\`), true, `absolute system tool: ${call.argv[0]}`);
    assert.equal(call.options.env.ANTHROPIC_API_KEY, undefined, "no secret reaches PowerShell");
    assert.equal(call.options.env.PI_GUI_ALLOW_EXEC, undefined);
    assert.equal(call.options.cwd, `${SYSTEM_ROOT}\\System32`);
  }
  const probe = runner.calls.find((c) => c.argv.includes("-Probe"));
  assert.deepEqual(probe.argv.slice(0, 8), [POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", `${HELPER_DIR}\\helper.ps1`]);
});

test("on a non-Windows host only host.os fails and no PowerShell runs", async (t) => {
  const { byId, runner } = await run(t, { platform: "linux" });
  assert.equal(byId["host.os"].status, "fail");
  assert.match(byId["host.os"].observed, /local-windows runs on Windows hosts only/);
  for (const id of IDS.slice(4)) assert.equal(byId[id].status, "blocked", id);
  assert.equal(runner.calls.length, 0);
});

test("old Windows builds and x86 fail with the observed value", async (t) => {
  const report = { probe: "env", ok: true, arch: "x86", build: 17134, platform: "Windows 10.0.17134 x86", elevated: false };
  const { byId } = await run(t, { runnerOptions: { probes: { env: report } } });
  assert.equal(byId["win.version"].status, "fail");
  assert.match(byId["win.version"].observed, /build 17134 .*17763 or later is required/);
  assert.equal(byId["win.arch"].status, "fail");
  assert.match(byId["win.arch"].observed, /x86; x64 or arm64 is required/);
  assert.equal(byId["helper.desktop"].status, "blocked");
});

test("a Group Policy AllSigned execution policy and Constrained Language mode are named", async (t) => {
  const policy = await run(t, { runnerOptions: { powershellInfo: { ...POWERSHELL_INFO, machinePolicy: "AllSigned" } } });
  assert.equal(policy.byId["win.execution-policy"].status, "fail");
  assert.match(policy.byId["win.execution-policy"].observed, /MachinePolicy AllSigned.*AllSigned blocks helper\.ps1/);
  assert.equal(policy.byId["win.version"].status, "blocked");
  assert.equal(policy.byId["helper.av"].status, "blocked");

  const remote = await run(t, { runnerOptions: { powershellInfo: { ...POWERSHELL_INFO, userPolicy: "RemoteSigned" } } });
  assert.equal(remote.byId["win.execution-policy"].status, "pass", "RemoteSigned allows a local unsigned script");

  const clm = await run(t, { runnerOptions: { powershellInfo: { ...POWERSHELL_INFO, languageMode: "ConstrainedLanguage" } } });
  assert.equal(clm.byId["win.powershell"].status, "fail");
  assert.match(clm.byId["win.powershell"].observed, /ConstrainedLanguage; Add-Type is blocked/);

  const pwsh = await run(t, { runnerOptions: { powershellInfo: { ...POWERSHELL_INFO, version: "7.6.8", edition: "Core" } } });
  assert.equal(pwsh.byId["win.powershell"].status, "fail");
});

test("PowerShell is looked up only under %SystemRoot%", async (t) => {
  const host = fakeWinHost();
  host.fs.remove(POWERSHELL);
  host.fs.addFile("C:\\Tools\\powershell.exe", "");
  const { byId, runner } = await run(t, { host, env: { ...WIN_ENV, Path: `C:\\Tools;${WIN_ENV.Path}` } });
  assert.equal(byId["win.powershell"].status, "fail");
  assert.match(byId["win.powershell"].observed, /powershell\.exe not found .*never uses a powershell\.exe found on PATH/);
  assert.equal(runner.calls.some((c) => c.argv[0] === "C:\\Tools\\powershell.exe"), false);
});

test("missing helper files fail helper.present with a reinstall hint", async (t) => {
  const host = fakeWinHost({ helperFiles: ["helper.ps1", "THIRD_PARTY_NOTICES.md"] });
  const { byId, checks } = await run(t, { host });
  assert.equal(byId["helper.present"].status, "fail");
  assert.match(byId["helper.present"].observed, /missing in .*src\\Json\.cs.* and 10 more/);
  assert.match(checks.find((c) => c.id === "helper.present").remediation.summary, /pi install npm:@firstpick\/pi-extension-gui-testing/);
  assert.equal(byId["helper.job"].status, "blocked");
});

test("a helper that antivirus blocks fails the probes and warns in helper.av", async (t) => {
  const blocked = { result: { exitCode: 1, stderr: "pi-gui-helper: compiling the helper failed (antivirus or application control blocking csc.exe?): Access is denied\r\n" } };
  const { byId } = await run(t, { runnerOptions: { probes: { env: blocked } } });
  assert.equal(byId["win.version"].status, "fail");
  assert.match(byId["win.version"].observed, /could not be compiled; antivirus or application control/);
  assert.equal(byId["helper.av"].status, "warn");
  assert.match(byId["helper.av"].observed, /antivirus/);
  assert.equal(byId["helper.av"].degrades, "sessions may fail to start or be ended by antivirus");
});

test("probe failures report the helper's own error; a forged report for another probe is ignored", async (t) => {
  const { byId } = await run(t, {
    runnerOptions: {
      probes: {
        job: { probe: "job", ok: false, error: "the test process survived the closing of its kill-on-close job" },
        nonelevated: { probe: "nonelevated", ok: false, error: "InvalidOperationException: no Explorer shell token (Explorer is not running)" },
        uia: { probe: "desktop", ok: true },
      },
    },
  });
  assert.equal(byId["helper.job"].status, "fail");
  assert.match(byId["helper.job"].observed, /survived the closing/);
  assert.equal(byId["helper.nonelevated"].status, "fail");
  assert.match(byId["helper.nonelevated"].observed, /Explorer/);
  assert.equal(byId["helper.uia"].status, "fail");
  assert.match(byId["helper.uia"].observed, /answered for probe desktop, not uia/);
});

test("an elevated Pi is reported and fails helper.nonelevated with the helper's reason", async (t) => {
  const { byId } = await run(t, {
    runnerOptions: {
      probes: {
        env: { probe: "env", ok: true, arch: "arm64", build: 26100, platform: "Windows 10.0.26100 arm64", elevated: true },
        nonelevated: {
          probe: "nonelevated",
          ok: false,
          elevated: true,
          detail: "Pi runs elevated (as administrator); local-windows needs Pi started from a normal, non-administrator terminal",
        },
      },
    },
  });
  assert.match(byId["win.version"].observed, /Pi runs elevated \(local-windows refuses this/);
  assert.equal(byId["win.arch"].observed, "arm64");
  assert.equal(byId["helper.nonelevated"].status, "fail");
  assert.match(byId["helper.nonelevated"].observed, /needs Pi started from a normal, non-administrator terminal/);
});
