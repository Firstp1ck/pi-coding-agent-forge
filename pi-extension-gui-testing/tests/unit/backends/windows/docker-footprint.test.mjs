import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DockerWindowsBackend } from "../../../../src/backends/docker-windows.ts";
import { hasDrift, hasImage, hasOrphanAuditGate, hasReset, hasRunner, hasSmoke, hasSweepAvailability } from "../../../../src/backends/capabilities.ts";
import { ensureKeys } from "../../../../src/backends/docker-windows/keys.ts";
import { BOOT, fakeProc } from "../fakes.mjs";
import { config, fakeWindowsDocker, windowsRoot } from "./docker-fakes.mjs";

const ALIVE = `c1:100:5000:${BOOT}`;
const DEAD = `c1:200:6000:${BOOT}`;

async function setup(t, docker = {}) {
  const r = await windowsRoot(t);
  const fake = fakeWindowsDocker(docker);
  const procRoot = join(r.root, "proc");
  fakeProc(procRoot, { 100: 5000 });
  const backend = new DockerWindowsBackend({ ownerLabel: () => ALIVE, configDir: r.configDir, runner: fake.runner, spawner: fake.spawner, detached: fake.detached, version: "0.1.0", endpointSource: {}, helperRoot: r.helperRoot, procRoot, dockerOnPath: async () => true });
  const add = (name, role, owner, extra = {}) =>
    fake.state.containers.set(name, { name, argv: [], labels: { "pi-gui-testing.windows": role, "pi-gui-testing.owner": owner, ...(role === "session" ? { "pi-gui-testing.session": name.slice(-4) } : {}) }, running: true, ...extra });
  return { ...r, ...fake, backend, add };
}

test("orphan audit and sweep: containers of dead owners (sessions and the install VM) go; live ones stay; unjudgeable ones are only reported", async (t) => {
  const s = await setup(t, { extraContainers: { session: ["id-x\tpi-gui-testing-win-weird\tweird\tnot-an-owner\t\trunning"] } });
  s.add("pi-gui-testing-win-dead", "session", DEAD);
  s.add("pi-gui-testing-win-live", "session", ALIVE);
  s.add("pi-gui-testing-windows-install", "install", DEAD);
  const signal = new AbortController().signal;
  const audit = await s.backend.auditOrphans(signal);
  assert.deepEqual(audit.map((l) => l.id).sort(), ["pi-gui-testing-win-dead", "pi-gui-testing-win-weird", "pi-gui-testing-windows-install"]);
  assert.match(audit.find((l) => l.id === "pi-gui-testing-win-dead").detail, /Windows session dead \(container with its disk overlay\), running: owner gone/);
  assert.match(audit.find((l) => l.id === "pi-gui-testing-win-weird").detail, /cannot be judged/);
  assert.equal(s.state.containers.size, 3, "the audit removes nothing");

  const left = await s.backend.sweepOrphans(signal);
  assert.deepEqual(left.map((l) => l.id), ["pi-gui-testing-win-weird"]);
  assert.deepEqual([...s.state.containers.keys()], ["pi-gui-testing-win-live"]);
  assert.ok(!s.state.removed.some((x) => x.includes("windows-base")), "the base volume is never an orphan");
});

test("sweep gate: at Pi startup only once docker-windows was set up on this machine; on demand whenever docker is on PATH", async (t) => {
  const s = await setup(t);
  assert.equal(await s.backend.sweepAvailable({ startup: true }), false);
  assert.equal(await s.backend.sweepAvailable({ startup: false }), true);
  await mkdir(s.stateDir, { recursive: true });
  assert.equal(await s.backend.sweepAvailable({ startup: true }), true);
  assert.equal(s.backend.orphanAuditReady([{ id: "docker.permission", status: "pass" }]), true);
  assert.equal(s.backend.orphanAuditReady([{ id: "docker.permission", status: "fail" }]), false);
  assert.equal(s.runner.calls.length, 0, "the gate runs no command");
});

test("/gui-reset: install container, base volume, image, keys and settings; keys are kept while a volume could not be removed", async (t) => {
  const s = await setup(t, { volume: { labels: { "pi-gui-testing.windows": "base", "pi-gui-testing.windows.install": "ab".repeat(16) } } });
  await s.backend.acknowledgeLicense();
  await ensureKeys(s.backend.store.dir, s.runner, { withHostKey: true });
  s.add("pi-gui-testing-windows-install", "install", ALIVE);
  const signal = new AbortController().signal;
  const reset = await s.backend.resetData(signal);
  assert.deepEqual(reset.leftovers, []);
  assert.deepEqual(reset.lines, ["removed 1 Windows base volume(s)", "removed the dockurr/windows image", "removed the guest SSH keys and docker-windows settings"]);
  assert.equal(s.state.containers.size, 0);
  assert.equal(s.state.volumes.size, 0);
  assert.equal(await stat(s.stateDir).then(() => true, () => false), false);
  assert.match(s.backend.resetSummary, /pi-gui-testing-windows-base/);
  assert.match(s.backend.resetNote, /installs none/);

  const busy = await setup(t, { volumeBusy: true, volume: { labels: { "pi-gui-testing.windows": "base" } } });
  await busy.backend.acknowledgeLicense();
  const kept = await busy.backend.resetData(signal);
  assert.equal(kept.leftovers[0].kind, "volume");
  assert.match(kept.leftovers[0].detail, /volume is in use .*running docker-windows session/);
  assert.ok(kept.lines.includes("kept the guest SSH keys and settings because something above could not be removed"));
  assert.equal(await stat(busy.stateDir).then(() => true, () => false), true);
});

test("capabilities: image (pinned pull), drift keys, reset, sweep gate, audit gate, runner, smoke app; construction runs nothing", async (t) => {
  const s = await setup(t);
  const b = s.backend;
  assert.equal(s.runner.calls.length, 0);
  for (const guard of [hasImage, hasDrift, hasReset, hasSweepAvailability, hasOrphanAuditGate, hasRunner, hasSmoke]) assert.ok(guard(b), guard.name);
  assert.equal(b.id, "docker-windows");
  assert.match(b.imageTag, /^docker\.io\/dockurr\/windows@sha256:/);
  const versions = await b.currentVersions();
  assert.deepEqual(Object.keys(versions).sort(), ["docker.cli", "docker.server", "image.base", "package.version", "pi.version", "protocol", "windows.install"]);
  assert.equal(versions["windows.install"], "(missing)");
  assert.deepEqual(b.smokeApp(), { cmd: "powershell.exe", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\pi-gui-testing\\smoke\\smoke.ps1"] });
  const smoke = b.smokeConfig({ ...config({ network: "none" }) });
  assert.equal(smoke.shared.network, "default");
  assert.deepEqual(smoke.shared.targets, ["windows"]);
  assert.equal(b.remediate("docker.cli", new AbortController().signal), undefined);
  const status = await b.licenseStatus();
  assert.equal(status.acknowledged, false);
  assert.match(status.text, /responsible for licensing Windows/);
  await b.setVm({ ramGb: 8, cpuCores: 4 });
  assert.deepEqual((await b.store.read()).vm, { ramGb: 8, cpuCores: 4 });
  await assert.rejects(b.setVm({ ramGb: 1 }), /ramGb/);
});
