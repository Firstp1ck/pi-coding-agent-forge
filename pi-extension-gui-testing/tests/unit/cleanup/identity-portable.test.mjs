/**
 * M1c: owner identity and liveness without /proc (macOS, Windows), with the
 * `ps`/`sysctl`/PowerShell outputs simulated. The rule under test: a live
 * owner is never judged dead; anything unreadable or foreign is `unknown`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootFlavor, createOwnerIdentity, darwinProbe, defaultProbe, ownerLiveness, parsePsLstart, win32Probe } from "../../../src/cleanup/identity.ts";
import { fakeProc } from "../backends/fakes.mjs";

/** A scripted SyncExec: `answers(file, args)` returns `{status, stdout}`; calls are recorded. */
function scripted(answers) {
  const calls = [];
  const exec = (file, args, options) => {
    calls.push({ file, args: [...args], env: options.env, timeoutMs: options.timeoutMs });
    return answers(file, args);
  };
  return { exec, calls };
}

test("ps lstart parsing is UTC and locale-independent", () => {
  assert.equal(parsePsLstart("Sat Oct 24 10:00:00 2026"), String(Date.UTC(2026, 9, 24, 10, 0, 0) / 1000));
  assert.equal(parsePsLstart("Sun Oct  4 09:05:07 2026\n"), String(Date.UTC(2026, 9, 4, 9, 5, 7) / 1000));
  assert.equal(parsePsLstart("Sa 24 Okt 10:00:00 2026"), undefined);
  assert.equal(parsePsLstart(""), undefined);
});

test("macOS probe: ps under TZ=UTC0 and LC_ALL=C, sysctl boot session; missing PID is null, failures are undefined", () => {
  const { exec, calls } = scripted((file, args) => {
    if (file === "/usr/sbin/sysctl") return { status: 0, stdout: "4A5B6C7D-1111-2222-3333-444455556666\n" };
    if (args.at(-1) === "4242") return { status: 0, stdout: "Sat Oct 24 10:00:00 2026\n" };
    if (args.at(-1) === "4343") return { status: 1, stdout: "" };
    return { status: null, stdout: "" };
  });
  const probe = darwinProbe(exec);
  assert.equal(probe.flavor, "darwin");
  assert.equal(probe.bootId(), "darwin-4a5b6c7d-1111-2222-3333-444455556666");
  assert.equal(probe.startTime(4242), String(Date.UTC(2026, 9, 24, 10) / 1000));
  assert.equal(probe.startTime(4343), null);
  assert.equal(probe.startTime(4444), undefined, "ps could not run");
  const ps = calls.find((c) => c.file === "/bin/ps");
  assert.deepEqual(ps.args, ["-o", "lstart=", "-p", "4242"]);
  assert.equal(ps.env.TZ, "UTC0");
  assert.equal(ps.env.LC_ALL, "C");
  probe.bootId();
  assert.equal(calls.filter((c) => c.file === "/usr/sbin/sysctl").length, 1, "the boot id is read once");
});

test("Windows probe: PowerShell start time and last boot in UTC seconds; 'none' is a missing PID", () => {
  const { exec, calls } = scripted((file, args) => {
    const script = args.at(-1);
    if (script.includes("Win32_OperatingSystem")) return { status: 0, stdout: "1761300000\r\n" };
    if (script.includes("-Id 4242 ")) return { status: 0, stdout: "1761301234\r\n" };
    if (script.includes("-Id 4343 ")) return { status: 0, stdout: "none\r\n" };
    if (script.includes("-Id 4444 ")) return { status: 0, stdout: "unknown\r\n" };
    return { status: 1, stdout: "" };
  });
  const probe = win32Probe(exec, { SystemRoot: "C:\\Windows", PATH: "C:\\Windows\\System32" });
  assert.equal(probe.bootId(), "win32-boot-1761300000");
  assert.equal(probe.startTime(4242), "1761301234");
  assert.equal(probe.startTime(4343), null);
  assert.equal(probe.startTime(4444), undefined, "access denied to StartTime");
  assert.equal(probe.startTime(4545), undefined, "PowerShell failed");
  assert.equal(calls[0].file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.ok(calls.every((c) => c.args.includes("-NoProfile") && c.args.includes("-NonInteractive")));
  assert.ok(!calls.some((c) => JSON.stringify(c.env).includes("TOKEN")), "a minimal environment");
});

function probeOf(flavor, boot, processes) {
  return { flavor, bootId: () => boot, startTime: (pid) => (pid in processes ? processes[pid] : null) };
}

test("liveness on macOS/Windows: same boot and start time is alive; gone or reused PID is dead; previous boot is dead", () => {
  for (const [flavor, boot, oldBoot] of [
    ["darwin", "darwin-aaaa-bbbb-cccc-dddd-eeee", "darwin-ffff-0000-1111-2222-3333"],
    ["win32", "win32-boot-1761300000", "win32-boot-1761000000"],
  ]) {
    const probe = probeOf(flavor, boot, { 100: "1761301234", 101: "1761309999" });
    assert.equal(ownerLiveness({ pid: 100, processStartTime: "1761301234", bootId: boot }, undefined, probe), "alive", flavor);
    assert.equal(ownerLiveness({ pid: 101, processStartTime: "1761301234", bootId: boot }, undefined, probe), "dead", `${flavor}: reused PID`);
    assert.equal(ownerLiveness({ pid: 102, processStartTime: "1761301234", bootId: boot }, undefined, probe), "dead", `${flavor}: PID gone`);
    assert.equal(ownerLiveness({ pid: 100, processStartTime: "1761301234", bootId: oldBoot }, undefined, probe), "dead", `${flavor}: earlier boot`);
  }
});

test("liveness never sweeps across operating systems or on unreadable state", () => {
  const linuxBoot = "11111111-2222-3333-4444-555555555555";
  const win = probeOf("win32", "win32-boot-1761300000", {});
  // A Pi in WSL labelled this container on the same Docker Desktop engine: the Windows client cannot judge it.
  assert.equal(ownerLiveness({ pid: 77, processStartTime: "123456", bootId: linuxBoot }, undefined, win), "unknown");
  const linux = probeOf("linux", linuxBoot, {});
  assert.equal(ownerLiveness({ pid: 77, processStartTime: "1761301234", bootId: "win32-boot-1761300000" }, undefined, linux), "unknown");
  assert.equal(ownerLiveness({ pid: 77, processStartTime: "1761301234", bootId: "darwin-aaaa" }, undefined, linux), "unknown");
  const blind = { flavor: "darwin", bootId: () => undefined, startTime: () => "1" };
  assert.equal(ownerLiveness({ pid: 1, processStartTime: "1", bootId: "darwin-x" }, undefined, blind), "unknown");
  const noStart = { flavor: "darwin", bootId: () => "darwin-x", startTime: () => undefined };
  assert.equal(ownerLiveness({ pid: 1, processStartTime: "1", bootId: "darwin-x" }, undefined, noStart), "unknown");
  assert.deepEqual([bootFlavor(linuxBoot), bootFlavor("darwin-x"), bootFlavor("win32-boot-1")], ["linux", "darwin", "win32"]);
});

test("owner identity on a Desktop host uses the probe; Linux and fake /proc trees keep reading /proc", async (t) => {
  const identity = createOwnerIdentity(undefined, 4242, probeOf("win32", "win32-boot-1761300000", { 4242: "1761301234" }));
  assert.deepEqual({ ...identity, clientId: "x" }, { clientId: "x", pid: 4242, processStartTime: "1761301234", bootId: "win32-boot-1761300000" });
  assert.throws(() => createOwnerIdentity(undefined, 4242, probeOf("darwin", undefined, {})), /cannot read process identity from ps and sysctl/);
  const root = await mkdtemp(join(tmpdir(), "gui-proc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  fakeProc(root, { 55: 999 });
  // A non-default procRoot always means /proc semantics, whatever the platform.
  const probe = defaultProbe(root, "darwin");
  assert.equal(probe.flavor, "linux");
  assert.equal(probe.startTime(55), "999");
});
