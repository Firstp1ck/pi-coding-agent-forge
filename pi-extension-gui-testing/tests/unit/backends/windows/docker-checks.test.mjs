import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runChecks } from "../../../../src/checks/runner.ts";
import { DockerWindowsBackend } from "../../../../src/backends/docker-windows.ts";
import { cpuVirtFlags, parseMeminfo, windowsRuleViolations } from "../../../../src/backends/docker-windows/checks.ts";
import { ensureKeys } from "../../../../src/backends/docker-windows/keys.ts";
import { fakeWindowsDocker, inspectWindows, OWNER, windowsRoot } from "./docker-fakes.mjs";

const GB = 1024 ** 3;
const meminfo = (total, available) => `MemTotal:       ${total / 1024} kB\nMemFree:        1000 kB\nMemAvailable:   ${available / 1024} kB\n`;

async function setup(t, { docker = {}, backend = {}, cpu = "flags\t\t: fpu vme vmx sse\n", mem = meminfo(16 * GB, 12 * GB), free = 200 * GB } = {}) {
  const r = await windowsRoot(t);
  const fake = fakeWindowsDocker(docker);
  await writeFile(join(r.root, "kvm"), "");
  await writeFile(join(r.root, "cpuinfo"), cpu);
  await writeFile(join(r.root, "meminfo"), mem);
  const b = new DockerWindowsBackend({
    ownerLabel: () => OWNER,
    configDir: r.configDir,
    runner: fake.runner,
    spawner: fake.spawner,
    detached: fake.detached,
    version: "0.1.0",
    endpointSource: {},
    platform: "linux",
    arch: "x64",
    // A character device the user can read and write.
    kvmPath: "/dev/null",
    cpuinfoPath: join(r.root, "cpuinfo"),
    meminfoPath: join(r.root, "meminfo"),
    freeBytes: async (path) => ({ path, free }),
    loopbackProbe: async () => 40999,
    common: { configDir: r.root, diskPath: r.root, minFreeBytes: 1, piVersion: "1.4.0", platform: "linux" },
    helperRoot: r.helperRoot,
    ...backend,
  });
  const run = async () => {
    const report = await runChecks(b.checks(), { runner: fake.runner, backend: "docker-windows", projectRoot: r.project, signal: new AbortController().signal });
    return Object.fromEntries(report.map((x) => [x.id, x]));
  };
  return { ...r, ...fake, backend: b, run };
}

async function markInstalled(s, id = "ab".repeat(16)) {
  await s.backend.store.acknowledgeLicense();
  await ensureKeys(s.backend.store.dir, s.runner, { withHostKey: true });
  await s.backend.store.setInstall({ id, state: "installed", startedAt: "2026-10-24T10:00:00.000Z", completedAt: "2026-10-24T10:25:00.000Z", image: s.backend.imageTag, vm: { version: "11", ramGb: 4, cpuCores: 2, diskGb: 64 }, packageVersion: "0.1.0" });
  s.state.volumes.set("pi-gui-testing-windows-base", { labels: { "pi-gui-testing.windows": "base", "pi-gui-testing.windows.install": id } });
}

test("check list: common, host.linux, the docker-linux Docker checks, then the Windows-VM checks in spec order", async (t) => {
  const s = await setup(t);
  assert.deepEqual(s.backend.checks().map((c) => c.id), [
    "pi.version", "host.os", "config.writable",
    "host.linux",
    "docker.cli", "docker.endpoint", "docker.daemon", "docker.permission", "docker.rootless", "docker.version", "docker.ostype", "docker.arch",
    "kvm.device", "kvm.cpu", "mem.available", "disk.free", "ports.free", "license.ack", "image.base", "isolation.inspect", "vm.installed",
  ]);
  const ids = s.backend.checks().map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "ids are unique");
});

test("fresh healthy host: everything passes except license.ack and vm.installed, whose remediations are the dialog and the install", async (t) => {
  const s = await setup(t);
  const r = await s.run();
  const failing = Object.values(r).filter((x) => x.status !== "pass").map((x) => `${x.id}:${x.status}`);
  assert.deepEqual(failing.sort(), ["license.ack:fail", "vm.installed:blocked"]);
  assert.match(r["license.ack"].remediation.summary, /--accept-windows-license/);
  assert.equal(r["license.ack"].remediation.manual, true);
  assert.match(r["kvm.cpu"].observed, /vmx/);
  assert.match(r["disk.free"].observed, /200\.0 GB free at \/var\/lib\/docker/);
  assert.match(r["ports.free"].observed, /web viewer is not published/);
  assert.equal(r["image.base"].facts["image.base"], s.backend.imageTag);
  assert.match(r["isolation.inspect"].observed, /no rule violations/);
  assert.ok(s.state.removed.some((x) => x.startsWith("pi-gui-testing-win-probe-")), "probe container removed");
  assert.ok(s.state.removed.some((x) => x.startsWith("pi-gui-testing-probe-")), "probe volume removed");
  assert.ok(!s.state.volumes.has("pi-gui-testing-windows-base"), "the probe never creates the base volume");
});

test("installed and acknowledged: vm.installed passes with the install id fact; a foreign or missing volume fails", async (t) => {
  const s = await setup(t);
  await markInstalled(s);
  let r = await s.run();
  assert.equal(r["vm.installed"].status, "pass", r["vm.installed"].observed);
  assert.equal(r["vm.installed"].facts["windows.install"], "ab".repeat(16));
  s.state.volumes.set("pi-gui-testing-windows-base", { labels: { "pi-gui-testing.windows.install": "cd".repeat(16) } });
  r = await s.run();
  assert.match(r["vm.installed"].observed, /belongs to another install/);
  s.state.volumes.clear();
  r = await s.run();
  assert.match(r["vm.installed"].observed, /volume pi-gui-testing-windows-base is missing/);
  assert.match(r["vm.installed"].remediation.summary, /15–30 minutes/);
  assert.ok(r["vm.installed"].remediation.command.includes("--device"), "the install command is shown before confirmation");
  assert.ok(!r["vm.installed"].remediation.command.some((a) => a.startsWith("PASSWORD=")));
});

test("KVM: missing device, unwritable device, no CPU flag, and arm64 hosts", async (t) => {
  let s = await setup(t, { backend: { kvmPath: "/nonexistent/kvm" } });
  let r = await s.run();
  assert.equal(r["kvm.device"].status, "fail");
  assert.match(r["kvm.device"].observed, /does not exist/);
  assert.match(r["kvm.device"].remediation.command.join(" "), /usermod -aG kvm/);
  assert.equal(r["isolation.inspect"].status, "blocked");
  s = await setup(t, { backend: { kvmPath: join((await windowsRoot(t)).root) } });
  r = await s.run();
  assert.match(r["kvm.device"].observed, /not a character device/);
  s = await setup(t, { cpu: "flags\t\t: fpu sse\n" });
  r = await s.run();
  assert.equal(r["kvm.cpu"].status, "fail");
  assert.match(r["kvm.cpu"].remediation.summary, /VT-x or AMD-V/);
  s = await setup(t, { backend: { arch: "arm64" }, cpu: "Features\t: fp asimd\n" });
  r = await s.run();
  assert.equal(r["kvm.cpu"].status, "pass");
  assert.match(r["kvm.cpu"].observed, /arm64/);
  assert.deepEqual(cpuVirtFlags("flags : a svm b\nflags : vmx\n"), ["svm", "vmx"]);
});

test("memory and disk minimums: 8 GB total, the VM's RAM available, 80 GB free before the install", async (t) => {
  let s = await setup(t, { mem: meminfo(6 * GB, 5 * GB) });
  let r = await s.run();
  assert.match(r["mem.available"].observed, /at least 8\.0 GB total/);
  s = await setup(t, { mem: meminfo(16 * GB, 3 * GB) });
  r = await s.run();
  assert.match(r["mem.available"].observed, /at least 4\.0 GB must be available/);
  s = await setup(t, { free: 50 * GB });
  r = await s.run();
  assert.equal(r["disk.free"].status, "fail");
  assert.match(r["disk.free"].observed, /at least 80\.0 GB needed/);
  await markInstalled(s);
  r = await s.run();
  assert.equal(r["disk.free"].status, "pass", "once installed, room for session overlays is enough");
  assert.deepEqual(parseMeminfo("MemTotal: 1024 kB\n"), { total: 1024 * 1024 });
});

test("image.base: the pinned dockurr image; missing image fails with a docker pull remediation", async (t) => {
  const s = await setup(t, { docker: { imageMissing: true } });
  const r = await s.run();
  assert.equal(r["image.base"].status, "fail");
  assert.deepEqual(r["image.base"].remediation.command, ["docker", "pull", s.backend.imageTag]);
  assert.equal(r["isolation.inspect"].status, "blocked");
});

test("isolation.inspect fails on a port bound to all addresses, an extra device, a host bind, or an added capability", async (t) => {
  const s = await setup(t, {
    docker: {
      mutateInspect: (c) => {
        c.HostConfig.PortBindings["8006/tcp"] = [{ HostIp: "0.0.0.0", HostPort: "8006" }];
        c.HostConfig.Devices.push({ PathOnHost: "/dev/dri/renderD128" });
        c.HostConfig.CapAdd.push("SYS_ADMIN");
        c.Mounts.push({ Type: "bind", Source: "/var/run/docker.sock", Destination: "/var/run/docker.sock" });
        return c;
      },
    },
  });
  const r = await s.run();
  assert.equal(r["isolation.inspect"].status, "fail");
  for (const part of ["port 8006/tcp published on 0.0.0.0", "/dev/dri/renderD128", "capability SYS_ADMIN", "docker.sock"]) assert.ok(r["isolation.inspect"].observed.includes(part), part);
  const clean = inspectWindows(["docker", "run", "--rm", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--device", "/dev/kvm", "--device", "/dev/net/tun", "-p", "127.0.0.1::22", "-v", "vol:/storage", "img"]);
  assert.deepEqual(windowsRuleViolations(clean, "vol"), []);
  clean.HostConfig.Privileged = true;
  assert.deepEqual(windowsRuleViolations(clean, "vol"), ["privileged"]);
});

test("host.linux and host.os refuse other client platforms", async (t) => {
  const s = await setup(t, { backend: { platform: "darwin", common: { configDir: "/tmp", diskPath: "/tmp", minFreeBytes: 1, piVersion: "1.4.0", platform: "darwin" } } });
  const r = await s.run();
  assert.equal(r["host.linux"].status, "fail");
  assert.equal(r["host.os"].status, "fail");
  assert.match(r["host.os"].observed, /Linux hosts with KVM/);
});
