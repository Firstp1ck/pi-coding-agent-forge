import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { DockerWindowsBackend } from "../../../../src/backends/docker-windows.ts";
import { helperFiles } from "../../../../src/backends/docker-windows/oem.ts";
import { fakeWindowsDocker, OWNER, parseRunArgv, windowsRoot } from "./docker-fakes.mjs";

async function setup(t, { docker = {}, backend = {} } = {}) {
  const r = await windowsRoot(t);
  const fake = fakeWindowsDocker(docker);
  fake.state.helperFiles = await helperFiles(r.helperRoot);
  const b = new DockerWindowsBackend({
    ownerLabel: () => OWNER,
    configDir: r.configDir,
    runner: fake.runner,
    spawner: fake.spawner,
    detached: fake.detached,
    version: "0.1.0",
    endpointSource: {},
    helperRoot: r.helperRoot,
    installPollMs: 1,
    sleep: async () => {},
    ...backend,
  });
  const lines = [];
  const install = (signal = new AbortController().signal) => b.installBase(signal, (l) => lines.push(l));
  return { ...r, ...fake, backend: b, lines, install };
}

const exists = (path) => stat(path).then(() => true, () => false);

test("no licensing acknowledgement: nothing is created", async (t) => {
  const s = await setup(t);
  const result = await s.install();
  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /--accept-windows-license/);
  assert.ok(!s.runner.commands().some((c) => / run | volume create /.test(c)));
});

test("fresh install: keys, labelled volume, OEM folder, detached container (password from env), progress, marker, helper check, shutdown, record", async (t) => {
  const s = await setup(t, { docker: { markerAfter: 2 } });
  await s.backend.acknowledgeLicense();
  const result = await s.install();
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /Windows 11 installed in the Docker volume pi-gui-testing-windows-base/);

  const settings = await s.backend.store.read();
  assert.equal(settings.install.state, "installed");
  assert.match(settings.install.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(s.state.volumes.get("pi-gui-testing-windows-base").labels, { "pi-gui-testing.windows": "base", "pi-gui-testing.windows.install": settings.install.id });

  const run = s.runner.calls.find((c) => c.argv.includes("run") && c.argv.includes("-d"));
  const p = parseRunArgv(run.argv);
  assert.equal(p.one("--name"), "pi-gui-testing-windows-install");
  assert.ok(p.all("--label").includes("pi-gui-testing.windows=install"));
  assert.ok(p.all("-v").includes(`${join(s.stateDir, "oem")}:/oem:ro`));
  assert.match(run.options.env.PASSWORD, /^[A-Za-z0-9_-]{24}$/, "a random password in the CLI environment");
  assert.ok(!run.argv.join(" ").includes(run.options.env.PASSWORD), "never in argv");
  assert.ok(!JSON.stringify(settings).includes(run.options.env.PASSWORD), "never stored");

  assert.ok(s.lines.some((l) => /starting the unattended Windows 11 install/.test(l)));
  assert.ok(s.lines.some((l) => /Windows install \(\d+ min\): ❯ Windows started successfully/.test(l)), "progress from the container log, escapes removed");
  assert.equal(s.state.markerPolls, 3, "polled until the marker appeared");
  assert.ok(s.state.scripts.some((x) => x.includes("Get-FileHash")), "helper files checked in the guest");
  assert.ok(s.runner.commands().some((c) => c.endsWith("stop -t 300 pi-gui-testing-windows-install")), "graceful shutdown");
  assert.equal(s.state.containers.size, 0);

  assert.ok(!(await exists(join(s.stateDir, "oem"))), "OEM folder removed");
  assert.ok(!(await exists(join(s.stateDir, "ssh_host_ed25519_key"))), "host private key forgotten");
  assert.ok(await exists(join(s.stateDir, "id_ed25519")));
  assert.match(await readFile(join(s.stateDir, "known_hosts"), "utf8"), /^pi-gui-testing-docker-windows ssh-ed25519 /);
  assert.equal((await stat(join(s.stateDir, "settings.json"))).mode & 0o777, 0o600);

  const ssh = s.runner.calls.filter((c) => c.argv[0] === "ssh");
  assert.ok(ssh.every((c) => c.argv.includes("127.0.0.1") && c.argv.includes("StrictHostKeyChecking=yes") && c.argv.includes("none")));

  const again = await s.install();
  assert.equal(again.exitCode, 0);
  assert.match(again.stdout, /already installed/);
});

test("a base volume or a running install that this machine's settings do not know is refused, never taken over", async (t) => {
  const s = await setup(t, { docker: { volume: { labels: { "pi-gui-testing.windows": "base", "pi-gui-testing.windows.install": "77".repeat(16) } } } });
  await s.backend.acknowledgeLicense();
  const foreign = await s.install();
  assert.equal(foreign.exitCode, 1);
  assert.match(foreign.stderr, /belongs to no install recorded here .*\/gui-reset docker-windows/);
  assert.ok(s.state.volumes.has("pi-gui-testing-windows-base"), "kept");

  const r = await setup(t);
  await r.backend.acknowledgeLicense();
  r.state.containers.set("pi-gui-testing-windows-install", { name: "pi-gui-testing-windows-install", argv: [], labels: { "pi-gui-testing.windows": "install" }, running: true, port: 41000 });
  const running = await r.install();
  assert.match(running.stderr, /another docker-windows install .* is running/);
  assert.ok(r.state.containers.has("pi-gui-testing-windows-install"), "not removed");
  assert.ok(!r.runner.commands().some((c) => c.includes("volume create")));
});

test("resume: a running install container is adopted (same id, no second docker run)", async (t) => {
  const s = await setup(t);
  await s.backend.acknowledgeLicense();
  const id = "ef".repeat(16);
  await s.backend.store.setInstall({ id, state: "installing", startedAt: "2026-10-24T10:00:00.000Z", image: s.backend.imageTag, vm: { version: "11", ramGb: 4, cpuCores: 2, diskGb: 64 }, packageVersion: "0.1.0" });
  s.state.volumes.set("pi-gui-testing-windows-base", { labels: { "pi-gui-testing.windows": "base", "pi-gui-testing.windows.install": id } });
  s.state.containers.set("pi-gui-testing-windows-install", { name: "pi-gui-testing-windows-install", argv: [], labels: { "pi-gui-testing.windows": "install", "pi-gui-testing.windows.install": id }, running: true, port: 41000, viewerPort: 41001 });
  const result = await s.install();
  assert.equal(result.exitCode, 0, result.stderr);
  assert.ok(s.lines.includes("resuming the running Windows install"));
  assert.ok(!s.runner.calls.some((c) => c.argv.includes("run") && c.argv.includes("-d")));
  assert.equal((await s.backend.store.read()).install.id, id);
});

test("install container stops: run again resumes on the same volume; the record is kept", async (t) => {
  const s = await setup(t, { docker: { markerAfter: 1000 } });
  await s.backend.acknowledgeLicense();
  // The container dies after it started.
  const original = s.runner.run.bind(s.runner);
  let inspections = 0;
  s.runner.run = async (argv, o) => {
    if (argv.join(" ").includes("container inspect --format") && argv.at(-1) === "pi-gui-testing-windows-install" && ++inspections > 2) s.state.containers.delete("pi-gui-testing-windows-install");
    return original(argv, o);
  };
  const first = await s.install();
  assert.equal(first.exitCode, 1);
  assert.match(first.stderr, /install container stopped \(gone\).*run \/gui-setup docker-windows again to resume/s);
  const record = (await s.backend.store.read()).install;
  assert.equal(record.state, "installing");
  assert.ok(s.state.volumes.has("pi-gui-testing-windows-base"), "volume kept for the resume");
  s.runner.run = original;
  // Resume: same record, a new container on the same volume; the marker answers now.
  s.state.markerPolls = 1000;
  const resumed = await s.install();
  assert.equal(resumed.exitCode, 0, resumed.stderr);
  assert.equal((await s.backend.store.read()).install.id, record.id);
  assert.equal(s.runner.calls.filter((c) => c.argv.includes("run") && c.argv.includes("-d")).length, 2);
});

test("timeout and a foreign guest discard the attempt (container, volume, record) so the next run starts fresh", async (t) => {
  let now = 0;
  // Time advances only through the injected sleep.
  const s = await setup(t, { docker: { markerAfter: 1_000_000 }, backend: { installTimeoutMs: 50, sleep: async () => void (now += 20), now: () => now } });
  await s.backend.acknowledgeLicense();
  const timedOut = await s.install();
  assert.equal(timedOut.exitCode, 1);
  assert.match(timedOut.stderr, /did not finish within .* the next \/gui-setup docker-windows starts a fresh one/s);
  assert.equal((await s.backend.store.read()).install, undefined);
  assert.equal(s.state.volumes.size, 0);
  assert.equal(s.state.containers.size, 0);

  const f = await setup(t, { docker: { foreignMarker: "99".repeat(16) } });
  await f.backend.acknowledgeLicense();
  const foreign = await f.install();
  assert.match(foreign.stderr, /belongs to another install/);
  assert.equal(f.state.containers.size, 0);
  assert.equal((await f.backend.store.read()).install, undefined);
});

test("wrong host key or a helper mismatch fails closed; cancel removes the VM but keeps the install for a resume", async (t) => {
  const k = await setup(t, { docker: { hostKeyChanged: true } });
  await k.backend.acknowledgeLicense();
  const key = await k.install();
  assert.match(key.stderr, /host key other than the pinned one/);
  assert.equal(k.state.containers.size, 0);

  const h = await setup(t, { docker: { guestHelper: "differ" } });
  await h.backend.acknowledgeLicense();
  const helper = await h.install();
  assert.match(helper.stderr, /helper files differ from this package \(THIRD_PARTY_NOTICES\.md, helper\.ps1, src\/Json\.cs, …\)/);

  const c = await setup(t, { docker: { markerAfter: 1_000_000 } });
  await c.backend.acknowledgeLicense();
  const controller = new AbortController();
  let polls = 0;
  const cancelled = await c.backend.installBase(controller.signal, () => {
    if (++polls === 4) controller.abort();
  });
  assert.equal(cancelled.exitCode, 1);
  assert.match(cancelled.stderr, /cancelled; run \/gui-setup docker-windows again to resume/);
  assert.equal(c.state.containers.size, 0, "no VM left running");
  assert.equal((await c.backend.store.read()).install.state, "installing");
  assert.ok(c.state.volumes.has("pi-gui-testing-windows-base"));
});
