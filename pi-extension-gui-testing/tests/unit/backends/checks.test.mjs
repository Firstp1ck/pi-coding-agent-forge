import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../../src/checks/runner.ts";
import { dockerLinuxChecks, normaliseArch } from "../../../src/backends/docker/checks.ts";
import { fakeDocker, HEALTHY_INFO, HOST } from "./fakes.mjs";

const OWNER = "c1:100:5000:boot";

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), "gui-checks-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function run(t, overrides = {}, checkOptions = {}) {
  const tmp = await scratch(t);
  const { runner, state } = fakeDocker(overrides);
  const checks = dockerLinuxChecks({
    runner,
    ownerLabel: () => OWNER,
    version: "0.1.0",
    tmpRoot: tmp,
    endpointSource: { dockerHost: overrides.dockerHost },
    common: { piVersion: "1.4.0", platform: "linux", configDir: tmp, minFreeBytes: 1, diskPath: tmp },
    ...checkOptions,
  });
  const results = await runChecks(checks, { runner, backend: "docker-linux", projectRoot: tmp, signal: new AbortController().signal });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  return { results, byId, runner, state, tmp };
}

const DOCKER_CHECK_IDS = [
  "docker.cli",
  "docker.endpoint",
  "docker.daemon",
  "docker.permission",
  "docker.rootless",
  "docker.version",
  "docker.ostype",
  "docker.arch",
  "image.base",
  "docker.bind-uid",
  "isolation.inspect",
];

test("every spec §5.4 docker-linux check exists, passes on a healthy host, and reports an observed value", async (t) => {
  const { results, byId, runner, state, tmp } = await run(t);
  assert.deepEqual(results.map((r) => r.id), ["pi.version", "host.os", "config.writable", "disk.free", ...DOCKER_CHECK_IDS]);
  for (const r of results) {
    assert.equal(r.status, "pass", `${r.id}: ${r.observed}`);
    assert.ok(r.observed.length > 0, r.id);
    assert.equal(r.required, true, r.id);
  }
  assert.deepEqual(byId["docker.endpoint"].facts, { context: "default", host: HOST });
  assert.equal(byId["docker.version"].facts["docker.server"], "29.9.1");
  assert.equal(byId["docker.arch"].facts["docker.arch"], "amd64");
  assert.match(byId["image.base"].facts["image.id"], /^sha256:/);
  // Every Docker call after docker.endpoint passes the endpoint explicitly.
  for (const cmd of runner.commands()) {
    if (cmd.startsWith("docker ") && cmd !== "docker --version" && !cmd.startsWith("docker context inspect")) assert.ok(cmd.startsWith(`docker --host ${HOST} `), cmd);
  }
  // Probes clean up: the inspect probe container and both probe dirs are gone.
  assert.equal(state.containers.size, 0);
  assert.ok(state.removed.some((id) => id.startsWith("pi-gui-testing-probe-")));
  assert.deepEqual(await readdir(tmp).then((names) => names.filter((n) => n.startsWith("pi-gui-probe-"))), []);
  // The isolation probe used docker create, never run, for the session configuration.
  assert.ok(runner.commands().some((c) => / create -i --rm /.test(c)));
});

test("docker.cli: missing docker fails with the install link and blocks every Docker check", async (t) => {
  const { runner } = fakeDocker();
  runner.on(["docker", "--version"], Object.assign(new Error("spawn docker ENOENT"), { code: "ENOENT" }));
  const tmp = await scratch(t);
  const checks = dockerLinuxChecks({ runner, ownerLabel: () => OWNER, version: "0.1.0", tmpRoot: tmp, endpointSource: {}, common: { piVersion: "1.4.0", platform: "linux", configDir: tmp, minFreeBytes: 1, diskPath: tmp } });
  const results = await runChecks(checks, { runner, backend: "docker-linux", projectRoot: tmp, signal: new AbortController().signal });
  const byId = Object.fromEntries(results.map((r) => [r.id, r]));
  assert.equal(byId["docker.cli"].status, "fail");
  assert.match(byId["docker.cli"].observed, /not found on PATH/);
  assert.match(byId["docker.cli"].remediation.summary, /docs\.docker\.com\/engine\/install/);
  assert.equal(byId["docker.cli"].remediation.manual, true);
  for (const id of DOCKER_CHECK_IDS.slice(1)) assert.equal(byId[id].status, "blocked", id);
});

test("docker.endpoint: remote DOCKER_HOST and remote contexts fail; a unix DOCKER_HOST passes", async (t) => {
  let { byId } = await run(t, { dockerHost: "tcp://10.0.0.5:2376" });
  assert.equal(byId["docker.endpoint"].status, "fail");
  assert.match(byId["docker.endpoint"].observed, /DOCKER_HOST points to tcp:\/\/10\.0\.0\.5:2376; only a local Docker daemon/);
  assert.equal(byId["docker.daemon"].status, "blocked");
  assert.ok(byId["docker.endpoint"].remediation);

  ({ byId } = await run(t, { contextName: "builder", contextHost: "ssh://me@builder" }));
  assert.equal(byId["docker.endpoint"].status, "fail");
  assert.match(byId["docker.endpoint"].observed, /context "builder" points to ssh:\/\/me@builder.*docker context use default/);

  ({ byId } = await run(t, { dockerHost: "unix:///run/docker.sock" }));
  assert.equal(byId["docker.endpoint"].status, "pass");
  assert.deepEqual(byId["docker.endpoint"].facts, { context: "DOCKER_HOST", host: "unix:///run/docker.sock" });
});

test("docker.daemon fails when the daemon is down; docker.permission fails on permission denied with the docker group hint", async (t) => {
  let { byId } = await run(t, { info: { exitCode: 1, stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" } });
  assert.equal(byId["docker.daemon"].status, "fail");
  assert.match(byId["docker.daemon"].observed, /Cannot connect/);
  assert.deepEqual(byId["docker.daemon"].remediation.command, ["sudo", "systemctl", "start", "docker"]);
  assert.equal(byId["docker.permission"].status, "blocked");

  ({ byId } = await run(t, {
    info: { exitCode: 1, stdout: JSON.stringify({ ServerErrors: ["permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"] }) },
  }));
  assert.equal(byId["docker.daemon"].status, "pass");
  assert.match(byId["docker.daemon"].observed, /refuses this user/);
  assert.equal(byId["docker.permission"].status, "fail");
  assert.match(byId["docker.permission"].observed, /permission denied/);
  assert.equal(byId["docker.permission"].remediation.command.slice(0, 4).join(" "), "sudo usermod -aG docker");
  assert.doesNotMatch(byId["docker.permission"].remediation.summary, /rootless/i);
  for (const id of ["docker.rootless", "docker.version", "docker.ostype", "docker.arch", "image.base", "docker.bind-uid", "isolation.inspect"]) assert.equal(byId[id].status, "blocked", id);
});

test("docker.rootless: a rootless daemon fails with a clear M1 message and blocks the probes", async (t) => {
  const { byId } = await run(t, { info: { ...HEALTHY_INFO, SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless", "name=cgroupns"] } });
  assert.equal(byId["docker.rootless"].status, "fail");
  assert.match(byId["docker.rootless"].observed, /rootless Docker daemon .*needs a rootful daemon.*rootless support is planned/);
  assert.equal(byId["docker.rootless"].remediation, undefined);
  assert.equal(byId["docker.bind-uid"].status, "blocked");
  assert.equal(byId["isolation.inspect"].status, "blocked");
  assert.equal(byId["image.base"].status, "pass");
});

test("docker.version: below 29.0 fails, 29.x passes, an untested newer major warns", async (t) => {
  for (const [server, status] of [["28.5.2", "fail"], ["29.0.0", "pass"], ["29.9.1", "pass"], ["30.1.0", "warn"], ["garbage", "fail"]]) {
    const { byId } = await run(t, { info: { ...HEALTHY_INFO, ServerVersion: server } });
    assert.equal(byId["docker.version"].status, status, `${server}: ${byId["docker.version"].observed}`);
  }
});

test("docker.ostype and docker.arch report what they saw", async (t) => {
  let { byId } = await run(t, { info: { ...HEALTHY_INFO, OSType: "windows" } });
  assert.equal(byId["docker.ostype"].status, "fail");
  assert.equal(byId["docker.ostype"].observed, "OSType windows");
  ({ byId } = await run(t, { info: { ...HEALTHY_INFO, Architecture: "s390x" } }));
  assert.equal(byId["docker.arch"].status, "fail");
  assert.match(byId["docker.arch"].observed, /s390x is not supported/);
  ({ byId } = await run(t, { info: { ...HEALTHY_INFO, Architecture: "aarch64" } }));
  assert.equal(byId["docker.arch"].status, "pass");
  assert.equal(byId["docker.arch"].facts["docker.arch"], "arm64");
  assert.equal(normaliseArch("arm64"), "arm64");
  assert.equal(normaliseArch("armv7l"), undefined);
});

test("image.base: a missing image or wrong labels fail with the build remediation (confirm, no project data)", async (t) => {
  let { byId } = await run(t, { imageMissing: true });
  assert.equal(byId["image.base"].status, "fail");
  assert.match(byId["image.base"].observed, /pi-gui-testing-base:0\.1\.0 not found/);
  const remediation = byId["image.base"].remediation;
  assert.deepEqual(remediation.command.slice(0, 3), ["docker", "build", "--force-rm"]);
  assert.equal(remediation.command.at(-1), "-");
  assert.ok(remediation.command.includes("PACKAGE_VERSION=0.1.0"));
  assert.match(remediation.summary, /no project files/);
  assert.ok(remediation.downloadBytes > 0 && remediation.estimatedSeconds > 0);
  assert.equal(remediation.manual, undefined);
  assert.equal(byId["isolation.inspect"].status, "blocked");

  ({ byId } = await run(t, { imageLabels: { "pi-gui-testing.base": "true", "pi-gui-testing.version": "0.0.9", "pi-gui-testing.protocol": "2" } }));
  assert.equal(byId["image.base"].status, "fail");
  assert.match(byId["image.base"].observed, /pi-gui-testing\.version is 0\.0\.9, this package is 0\.1\.0/);
  ({ byId } = await run(t, { imageLabels: { "pi-gui-testing.base": "true", "pi-gui-testing.version": "0.1.0", "pi-gui-testing.protocol": "1" } }));
  assert.match(byId["image.base"].observed, /protocol is 1, this package speaks 2/);
});

test("docker.bind-uid: a file owned by another uid fails; the probe dir is always removed", async (t) => {
  const { byId, tmp } = await run(t, {}, { uid: 4242, gid: 4242 });
  assert.equal(byId["docker.bind-uid"].status, "fail");
  assert.match(byId["docker.bind-uid"].observed, /owned by uid \d+, expected 4242/);
  assert.deepEqual((await readdir(tmp)).filter((n) => n.startsWith("pi-gui-probe-")), []);
  const failing = await run(t, { bindProbe: () => ({ exitCode: 125, stderr: "docker: Error response from daemon: oci runtime error" }) });
  assert.equal(failing.byId["docker.bind-uid"].status, "fail");
  assert.match(failing.byId["docker.bind-uid"].observed, /probe container failed \(exit 125/);
});

test("isolation.inspect: a container that breaks a hard rule fails with every violation; the probe is removed and never started", async (t) => {
  const { byId, state, runner } = await run(t, {
    mutateInspect: (inspect) => ({
      ...inspect,
      HostConfig: { ...inspect.HostConfig, Privileged: true, IpcMode: "host", CapAdd: ["SYS_ADMIN"] },
      Config: { ...inspect.Config, Env: [...inspect.Config.Env, "WAYLAND_DISPLAY=wayland-0"] },
    }),
  });
  const result = byId["isolation.inspect"];
  assert.equal(result.status, "fail");
  for (const rule of ["privileged", "host-mode: HostConfig.IpcMode=host", "capabilities: HostConfig.CapAdd=SYS_ADMIN", "forbidden-env"]) assert.match(result.observed, new RegExp(rule));
  assert.equal(state.containers.size, 0);
  assert.ok(!runner.commands().some((c) => / start /.test(c)));
});

test("Z4: isolation.inspect fails when Docker reports /workspace bound from another path than the probe's resolved dir", async (t) => {
  const { byId } = await run(t, {
    mutateInspect: (inspect) => ({ ...inspect, Mounts: inspect.Mounts.map((m) => (m.Destination === "/workspace" ? { ...m, Source: "/srv/other" } : m)) }),
  });
  assert.equal(byId["isolation.inspect"].status, "fail");
  assert.match(byId["isolation.inspect"].observed, /workspace: \/workspace is bound from \/srv\/other, expected /);
});
