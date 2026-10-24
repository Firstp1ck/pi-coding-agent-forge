/**
 * Remote checks (spec §5.4) against a scripted ssh: a healthy remote-linux
 * and remote-linux-docker host pass every required check with one platform
 * call; connection failures name their manual remediation (ssh-copy-id,
 * accepting the host key) and block what depends on them; missing remote
 * tools get an automated `sudo -n` install only with passwordless sudo.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks, requiredChecksPass } from "../../../../src/checks/runner.ts";
import { RemoteLinuxBackend } from "../../../../src/backends/remote-linux.ts";
import { RemoteLinuxDockerBackend } from "../../../../src/backends/remote-linux-docker.ts";
import { PLATFORM_SCRIPT } from "../../../../src/backends/remote/checks.ts";
import { XVFB_PROBE_SCRIPT } from "../../../../src/backends/remote/linux-checks.ts";
import { PATH_PROBE_SCRIPT } from "../../../../src/backends/remote/docker.ts";
import { CREATE_SCRIPT, REMOVE_SCRIPT } from "../../../../src/backends/remote/session-dir.ts";
import { FakeSsh } from "../../transport/ssh/fake-ssh.mjs";
import { fakeDocker } from "../fakes.mjs";

const BASE = "/run/user/1000/pi-gui-testing";
const TOOLS = ["Xvfb", "xdotool", "import", "dbus-run-session", "at-spi-bus-launcher", "openbox", "fc-list", "xdpyinfo", "python3", "docker", "tar", "sha256sum", "mktemp", "stat"];

function facts(overrides = {}) {
  const values = {
    os: "Linux",
    arch: "aarch64",
    distro: "debian",
    distro_version: "12",
    distro_name: "Debian GNU/Linux 12 (bookworm)",
    pm: "apt-get",
    mem_kb: "8000000",
    cpus: "4",
    nofile: "1024",
    nproc: "30000",
    sudo: "1",
    path: "/usr/local/bin:/usr/bin:/bin",
    uid: "1000",
    python: "3.11.2",
    gtk3: "1",
    pyatspi: "1",
    fonts: "12",
    ...overrides.values,
  };
  const tools = (overrides.tools ?? TOOLS).map((t) => `tool.${t}=/usr/bin/${t}`);
  return [...Object.entries(values).map(([k, v]) => `${k}=${v}`), ...tools].join("\n");
}

/** A scripted healthy host; `options` override pieces. */
function host(options = {}) {
  const remote = options.docker ? fakeDocker({ bindProbe: () => ({}) }).runner : undefined;
  const fake = new FakeSsh({ ...(remote ? { remote } : {}), ...(options.unreachable ? { unreachable: options.unreachable } : {}) });
  const dirs = new Set();
  fake.local
    .on((argv) => argv.includes("-G"), (argv) => ({ stdout: `user pi\nhostname ${argv.at(-1)}.lan\nport 22\nuserknownhostsfile ${options.knownHosts ?? "/nonexistent"}\n` }))
    .on(["ssh-add", "-l"], { stdout: "256 SHA256:abc pi@client (ED25519)\n" })
    .on((argv) => argv[0] === "ssh-keygen" && argv[1] === "-F", { stdout: "# Host raspi5.lan found: line 1\nraspi5.lan ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexample\n" });
  fake.remote
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === PLATFORM_SCRIPT, () => ({ stdout: facts(options.facts) }))
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === CREATE_SCRIPT, (argv) => {
      dirs.add(argv[4]);
      return { stdout: [`base=${BASE}`, `dir=${BASE}/${argv[4]}`, "uid=1000", "gid=1000", "workspace_id=1 2", "free_kb=99999999"].join("\n") };
    })
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === REMOVE_SCRIPT, (argv) => {
      for (const name of argv.slice(5)) dirs.delete(name);
      return {};
    })
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === XVFB_PROBE_SCRIPT, { stdout: "used= 0\ndisplay=90\nstarted=1\nlock=1\nxtest=1\n" })
    .on((argv) => argv[0] === "/bin/sh" && argv[2] === PATH_PROBE_SCRIPT, (argv) => ({ stdout: argv.slice(4).map((p) => `${p}\t${p}\t0`).join("\n") }))
    .on((argv) => argv[0] === "python3" && argv[1] === "-I" && argv[2] === "-c", { stdout: "ok\n" })
    .on((argv) => argv[0] === "/bin/sh" && argv[2]?.startsWith('sha256sum -- "$@"'), (argv, opts) => {
      const lines = argv.slice(4).map((p) => `${createHash("sha256").update(fake.files.get(`${opts.cwd}/${p}`) ?? "").digest("hex")}  ${p}`);
      const link = fake.entries.get(`${opts.cwd}/link-to-hello`)?.linkTarget ?? "";
      const exec = (fake.entries.get(`${opts.cwd}/bin/run.sh`)?.mode ?? 0) & 0o100 ? 1 : 0;
      return { stdout: `${lines.join("\n")}\nlink=${link}\nexec=${exec}\n` };
    })
    .on((argv) => argv[0] === "stat" && argv[1] === "-c", { stdout: "1000\n" })
    .on((argv) => argv[0] === "docker" && argv.includes("{{.DockerRootDir}}"), { stdout: "/var/lib/docker\n" })
    .on((argv) => argv[0] === "df", { stdout: "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100 1 99999999 1% /\n" })
    .on((argv) => argv[0] === "getent", { stdout: "1.2.3.4 deb.debian.org\n" });
  if (options.connect) fake.remote.on(["true"], options.connect);
  return { fake, dirs };
}

async function run(t, Backend, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "pgt-chk-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "app.py"), "print(1)\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  const h = host(options);
  const backend = new Backend({
    ownerLabel: () => "c1:1:2:boot",
    runner: h.fake.runner,
    spawner: h.fake.spawner,
    detached: h.fake.detached,
    version: "0.1.0",
    tmpRoot: root,
    home: root,
    shortControlRoot: root,
    common: { piVersion: "1.4.0", platform: "linux", configDir: root },
    ...(options.host === null ? {} : { host: options.host ?? "raspi5" }),
  });
  const results = await runChecks(backend.checks(), { runner: backend.runner, backend: backend.id, projectRoot: root, signal: new AbortController().signal });
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  return { results, by, ...h };
}

test("remote-linux: a healthy host passes every required check, with one platform call and no leftovers", async (t) => {
  const { results, by, fake, dirs } = await run(t, RemoteLinuxBackend);
  const failing = results.filter((r) => r.required && !["pass", "warn"].includes(r.status));
  assert.deepEqual(failing.map((r) => `${r.id}: ${r.observed}`), []);
  assert.ok(requiredChecksPass(results));
  for (const id of ["local.ssh", "ssh.config", "local.sshkey", "ssh.hostkey", "ssh.auth", "ssh.jump", "ssh.multiplex", "ssh.latency", "remote.os", "remote.arch", "remote.session-root", "remote.exec", "remote.disk", "sync.roundtrip", "sync.exclusions", "remote.python", "linux.xvfb", "xvfb.start", "xvfb.not-host", "helper.deploy", "linux.gtk-introspection"]) {
    assert.equal(by[id]?.status, "pass", `${id}: ${by[id]?.observed}`);
  }
  assert.equal(by["local.rsync"].status, "warn");
  assert.equal(by["remote.rsync"].status, "blocked");
  assert.equal(by["remote.arch"].facts["remote.arch"], "aarch64");
  assert.equal(by["ssh.config"].facts["remote.host"], "raspi5");
  assert.match(by["sync.exclusions"].observed, /1 of them by the secret patterns/);
  assert.match(by["sync.roundtrip"].observed, /via tar, checksums match/);
  assert.equal(fake.calls.filter((c) => c.decoded?.argv?.[2] === PLATFORM_SCRIPT).length, 1, "one SSH call for all platform facts");
  assert.equal(fake.calls.filter((c) => c.decoded?.argv?.[0] === "true" && c.options.ControlPath === "none").length, 1, "one shared connection probe");
  // Every call that connects (not `-G`, not `-O` against the local socket) never prompts and has a connect timeout.
  for (const call of fake.calls.filter((c) => c.decoded || c.master)) {
    assert.equal(call.options.BatchMode, "yes");
    assert.equal(call.options.StrictHostKeyChecking, "yes");
    assert.ok(Number(call.options.ConnectTimeout) > 0);
  }
  assert.equal(dirs.size, 0, "probe session dirs are removed");
  assert.equal(fake.masters.size, 0, "the multiplex probe closed its ControlMaster");
});

test("no host chosen: ssh.config fails with the --host hint and the rest is blocked", async (t) => {
  const { by } = await run(t, RemoteLinuxBackend, { host: null });
  assert.equal(by["ssh.config"].status, "fail");
  assert.match(by["ssh.config"].remediation.summary, /--host/);
  assert.equal(by["ssh.auth"].status, "blocked");
  assert.equal(by["remote.os"].status, "blocked");
});

test("auth failure: ssh.auth fails with ssh-copy-id (manual), never a password", async (t) => {
  const { by } = await run(t, RemoteLinuxBackend, { connect: { exitCode: 255, stderr: "pi@raspi5.lan: Permission denied (publickey).\n" } });
  assert.equal(by["ssh.hostkey"].status, "pass");
  assert.equal(by["ssh.auth"].status, "fail");
  assert.equal(by["ssh.auth"].remediation.manual, true);
  assert.match(by["ssh.auth"].remediation.summary, /ssh-copy-id raspi5/);
  assert.equal(by["remote.os"].status, "blocked");
});

test("unknown host key: ssh.hostkey fails and tells the user to connect once", async (t) => {
  const { by } = await run(t, RemoteLinuxBackend, { connect: { exitCode: 255, stderr: "No ED25519 host key is known for raspi5.lan and you have requested strict checking.\nHost key verification failed.\n" } });
  assert.equal(by["ssh.hostkey"].status, "fail");
  assert.match(by["ssh.hostkey"].remediation.summary, /connect once yourself .*: ssh raspi5/);
  assert.equal(by["ssh.auth"].status, "blocked");
});

test("missing remote tools: sudo -n install with passwordless sudo, otherwise the command to run by hand", async (t) => {
  const tools = TOOLS.filter((x) => x !== "Xvfb");
  const auto = await run(t, RemoteLinuxBackend, { facts: { tools } });
  const fix = auto.by["linux.xvfb"].remediation;
  assert.equal(auto.by["linux.xvfb"].status, "fail");
  assert.equal(fix.needsSudo, true);
  assert.deepEqual(fix.command, ["ssh", "-o", "BatchMode=yes", "-T", "--", "raspi5", "sudo -n apt-get install -y xvfb"]);
  assert.equal(auto.by["xvfb.start"].status, "blocked");
  const manual = await run(t, RemoteLinuxBackend, { facts: { tools, values: { sudo: "0", pm: "pacman" } } });
  const hint = manual.by["linux.xvfb"].remediation;
  assert.equal(hint.manual, true);
  assert.match(hint.summary, /ssh -t raspi5 sudo pacman -S --needed --noconfirm xorg-server-xvfb/);
  assert.equal(manual.by["remote.sudo"].status, "warn");
});

test("a non-Linux or 32-bit remote host", async (t) => {
  const mac = await run(t, RemoteLinuxBackend, { facts: { values: { os: "Darwin" } } });
  assert.equal(mac.by["remote.os"].status, "fail");
  assert.equal(mac.by["remote.arch"].status, "blocked");
  const arm = await run(t, RemoteLinuxBackend, { facts: { values: { arch: "armv7l" } } });
  assert.equal(arm.by["remote.arch"].status, "warn");
});

test("remote-linux-docker: Docker checks run on the remote host; image build remediation is ssh-wrapped", async (t) => {
  const { results, by, fake } = await run(t, RemoteLinuxDockerBackend, { docker: true, facts: { values: { arch: "x86_64" } } });
  const failing = results.filter((r) => r.required && !["pass", "warn"].includes(r.status));
  assert.deepEqual(failing.map((r) => `${r.id}: ${r.observed}`), []);
  for (const id of ["docker.cli", "docker.endpoint", "docker.permission", "docker.version", "image.base", "docker.image-arch", "docker.bind-uid", "isolation.inspect", "remote.disk", "docker.rootless", "docker.egress"]) {
    assert.equal(by[id]?.status, "pass", `${id}: ${by[id]?.observed}`);
  }
  assert.equal(fake.local.calls.filter((c) => c.argv[0] === "docker").length, 0, "the client needs no Docker CLI");
  assert.ok(fake.remoteCommands().some((c) => c.startsWith("docker --host unix:///var/run/docker.sock info")));
  assert.deepEqual(by["image.base"].remediation ?? null, null, "passed checks carry no remediation");
});

test("remote-linux-docker: wrong image architecture fails docker.image-arch", async (t) => {
  const { by } = await run(t, RemoteLinuxDockerBackend, { docker: true, facts: { values: { arch: "aarch64" } } });
  assert.equal(by["docker.image-arch"].status, "fail");
  assert.match(by["docker.image-arch"].observed, /image is amd64, remote is aarch64/);
});
