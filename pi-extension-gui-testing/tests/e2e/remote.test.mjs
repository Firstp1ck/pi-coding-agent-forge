/**
 * e2e for the remote backends against a real SSH host (spec §4.2a, §5.4,
 * §7a.3). Skipped unless `PI_GUI_E2E_SSH_HOST` names an alias that logs in
 * with a key (BatchMode); `localhost` works when sshd runs here.
 *
 *   PI_GUI_E2E_SSH_HOST=localhost npm run test:e2e -- tests/e2e/remote.test.mjs
 *
 * `PI_GUI_E2E_SSH_SESSION=1` also starts a full `remote-linux` session (the
 * host then needs Xvfb, xdotool, dbus, and python3 with GTK 3); with
 * `PI_GUI_E2E_SSH_DOCKER=1` the `remote-linux-docker` checks run as well.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOwnerIdentity } from "../../src/cleanup/identity.ts";
import { formatOwnerLabel } from "../../src/owner.ts";
import { runChecks } from "../../src/checks/runner.ts";
import { RemoteLinuxBackend } from "../../src/backends/remote-linux.ts";
import { RemoteLinuxDockerBackend } from "../../src/backends/remote-linux-docker.ts";
import { auditRemoteSession, createRemoteSessionDir, remoteSessionName, removeRemoteSessions } from "../../src/backends/remote/session-dir.ts";
import { buildFileSet } from "../../src/sync/fileset.ts";
import { WorkspaceSync } from "../../src/sync/transport/workspace-sync.ts";
import { controlLocation } from "../../src/transport/ssh/options.ts";
import { SshTransport, oneShotTransport } from "../../src/transport/ssh/transport.ts";

const HOST = process.env.PI_GUI_E2E_SSH_HOST;
const skip = HOST ? false : "set PI_GUI_E2E_SSH_HOST to an SSH alias with key login to run the remote e2e tests";
const owner = () => formatOwnerLabel(createOwnerIdentity());

test("ControlMaster lifecycle, remote runner, and helper-style spawn on the real host", { skip, timeout: 120_000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pgt-e2e-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const transport = new SshTransport({ destination: HOST, control: await controlLocation(dir) });
  await transport.open();
  assert.equal(await transport.masterRunning(), true);
  const uname = await transport.runner.run(["uname", "-s"], { timeoutMs: 15_000 });
  assert.equal(uname.exitCode, 0, uname.stderr);
  assert.equal(uname.stdout.trim(), "Linux");
  const quoted = await transport.runner.run(["printf", "%s|", "a b", "it's", "$(id)"], { timeoutMs: 15_000 });
  assert.equal(quoted.stdout, "a b|it's|$(id)|");
  const child = transport.spawnHelper(["/bin/sh", "-c", 'printf "%s:%s" "$SECRET_TOKEN" "${DISPLAY-unset}"'], { SECRET_TOKEN: "0123456789abcdef0123456789abcdef" });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stdin.end();
  await child.exited;
  assert.equal(out, "0123456789abcdef0123456789abcdef:unset");
  await transport.close();
  assert.equal(await transport.masterRunning(), false);
});

test("session dir, tar sync, and removal on the real host leave nothing behind", { skip, timeout: 180_000 }, async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pgt-e2e-proj-"));
  const staging = await mkdtemp(join(tmpdir(), "pgt-e2e-stage-"));
  t.after(async () => {
    await rm(project, { recursive: true, force: true });
    await rm(staging, { recursive: true, force: true });
  });
  await writeFile(join(project, "ünïcødé ✓.txt"), "u\n");
  await mkdir(join(project, "bin"));
  await writeFile(join(project, "bin", "run.sh"), "#!/bin/sh\necho ok\n");
  await chmod(join(project, "bin", "run.sh"), 0o755);
  await symlink("bin/run.sh", join(project, "run"));
  await writeFile(join(project, ".env"), "SECRET=1\n");
  const transport = oneShotTransport(HOST);
  const name = remoteSessionName("gui-e2e");
  const remote = await createRemoteSessionDir(transport.runner, { name, ownerLabel: owner(), sessionId: "gui-e2e", backend: "remote-linux" });
  try {
    for (const method of ["tar", "auto"]) {
      const sync = new WorkspaceSync({ transport, stagingRoot: staging, remoteDir: remote.workspace, method });
      const report = await sync.sync(await buildFileSet(project));
      assert.ok(report.files >= 3);
      const check = await transport.runner.run(["/bin/sh", "-c", './run && [ ! -e .env ] && cat "ünïcødé ✓.txt"'], { cwd: remote.workspace, timeoutMs: 15_000 });
      assert.equal(check.stdout, "ok\nu\n", check.stderr);
    }
  } finally {
    assert.deepEqual(await removeRemoteSessions(transport.runner, [name], { destination: HOST }), []);
  }
  assert.deepEqual(await auditRemoteSession(transport.runner, name, { destination: HOST }), []);
});

test("remote-linux checks on the real host (connection checks must pass)", { skip, timeout: 300_000 }, async () => {
  const backend = new RemoteLinuxBackend({ ownerLabel: owner, host: HOST });
  const results = await runChecks(backend.checks(), { runner: backend.runner, backend: backend.id, projectRoot: process.cwd(), signal: new AbortController().signal });
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id}: ${r.observed}`);
  for (const id of ["local.ssh", "ssh.config", "ssh.hostkey", "ssh.auth", "remote.os", "remote.session-root", "sync.roundtrip", "sync.exclusions"]) {
    assert.equal(results.find((r) => r.id === id)?.status, "pass", id);
  }
});

test("remote-linux-docker checks on the real host", { skip: skip || (process.env.PI_GUI_E2E_SSH_DOCKER ? false : "set PI_GUI_E2E_SSH_DOCKER=1 for the Docker checks"), timeout: 300_000 }, async () => {
  const backend = new RemoteLinuxDockerBackend({ ownerLabel: owner, host: HOST });
  const results = await runChecks(backend.checks(), { runner: backend.runner, backend: backend.id, projectRoot: process.cwd(), signal: new AbortController().signal });
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.id}: ${r.observed}`);
  assert.equal(results.find((r) => r.id === "docker.cli")?.status, "pass");
});

test("a full remote-linux session starts, launches the smoke app, and stops with an empty audit", { skip: skip || (process.env.PI_GUI_E2E_SSH_SESSION ? false : "set PI_GUI_E2E_SSH_SESSION=1 for a full session (needs Xvfb, xdotool, dbus, python3-gi on the host)"), timeout: 300_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pgt-e2e-sess-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  const sessionDir = join(root, "pi-gui-testing-e2e");
  await mkdir(project);
  await mkdir(sessionDir, { mode: 0o700 });
  const label = owner();
  const backend = new RemoteLinuxBackend({ ownerLabel: () => label, host: HOST });
  const session = await backend.startSession({
    sessionId: "gui-e2e00001",
    projectRoot: project,
    sessionDir,
    config: { shared: { targets: ["linux"], workspaceMode: "mount", network: "default" }, limits: { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 }, usageCheck: { warnSessionCostUsd: 1, warnDailyCostUsd: 5 }, keepSandbox: false, remote: { host: HOST }, warnings: [] },
    ownerLabel: label,
    recordResource: async () => {},
    onLog: () => {},
    signal: new AbortController().signal,
  });
  try {
    const app = backend.smokeApp();
    const launched = await session.request("launch", { cmd: app.cmd, args: app.args, env: {}, cwd: session.workspacePath });
    assert.ok(launched.pid > 0);
    const shot = await session.request("screenshot", {});
    assert.ok(shot.width > 0);
  } finally {
    assert.deepEqual(await session.stop(), []);
  }
  assert.deepEqual(await session.auditFootprint(), []);
});
