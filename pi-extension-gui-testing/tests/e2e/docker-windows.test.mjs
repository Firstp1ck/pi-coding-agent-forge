/**
 * e2e for `docker-windows` (spec §4.4, §5.4, §5.5, §7a) on a real Linux host
 * with KVM and rootful Docker. It downloads Windows from Microsoft and
 * installs it unattended (30+ minutes, ~64 GB of disk, 4 GB of RAM while the
 * VM runs), so it is skipped unless all of these hold:
 *
 * - `PI_GUI_E2E_DOCKER_WINDOWS=1`
 * - `PI_GUI_E2E_ACCEPT_WINDOWS_LICENSE=1`: you are responsible for Windows
 *   licensing (the same acknowledgement as `/gui-setup docker-windows`)
 * - `/dev/kvm` is readable and writable, and `docker info` answers from a
 *   rootful daemon
 *
 *   PI_GUI_E2E_DOCKER_WINDOWS=1 PI_GUI_E2E_ACCEPT_WINDOWS_LICENSE=1 \
 *     npm run test:e2e -- tests/e2e/docker-windows.test.mjs
 *
 * `PI_GUI_E2E_DOCKER_WINDOWS_DIR=<dir>` keeps the backend state (keys,
 * install record) there, so a second run reuses the installed base volume;
 * without it the state lives in a temp dir and the base is removed at the end
 * (`PI_GUI_E2E_DOCKER_WINDOWS_KEEP=1` keeps it). Nothing here has run yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createOwnerIdentity } from "../../src/cleanup/identity.ts";
import { formatOwnerLabel } from "../../src/owner.ts";
import { runChecks } from "../../src/checks/runner.ts";
import { DockerWindowsBackend } from "../../src/backends/docker-windows.ts";
import { baseDiskStamp } from "../../src/backends/docker-windows/docker.ts";
import { decodePng, isUniform } from "../../src/tools/png.ts";

async function prerequisites() {
  if (process.env.PI_GUI_E2E_DOCKER_WINDOWS !== "1") return "set PI_GUI_E2E_DOCKER_WINDOWS=1 to run the docker-windows e2e (30+ minutes, ~64 GB, downloads Windows)";
  if (process.env.PI_GUI_E2E_ACCEPT_WINDOWS_LICENSE !== "1") return "set PI_GUI_E2E_ACCEPT_WINDOWS_LICENSE=1 to acknowledge that you are responsible for Windows licensing";
  if (process.platform !== "linux") return "docker-windows needs a Linux host";
  try {
    await access("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch {
    return "/dev/kvm is missing or not readable and writable";
  }
  try {
    const security = execFileSync("docker", ["info", "--format", "{{json .SecurityOptions}}"], { encoding: "utf8", timeout: 15_000 });
    if (/rootless/.test(security)) return "the Docker daemon is rootless; docker-windows needs a rootful daemon";
  } catch {
    return "docker info failed (Docker missing, not running, or not allowed for this user)";
  }
  return false;
}

const skip = await prerequisites();

const config = {
  shared: { targets: ["windows"], workspaceMode: "mount", network: "default" },
  limits: { maxConcurrentSessions: 2, idleTimeoutMinutes: 15 },
  usageCheck: { warnSessionCostUsd: 1, warnDailyCostUsd: 5 },
  keepSandbox: false,
  warnings: [],
};

test("docker-windows: checks, unattended install, session with the WinForms smoke app, clean teardown, unchanged base disk", { skip, timeout: 4 * 60 * 60_000 }, async (t) => {
  const keepDir = process.env.PI_GUI_E2E_DOCKER_WINDOWS_DIR;
  const stateRoot = keepDir ?? (await mkdtemp(join(tmpdir(), "pgt-e2e-win-")));
  const project = await mkdtemp(join(tmpdir(), "pgt-e2e-win-proj-"));
  const sessionRoot = await mkdtemp(join(tmpdir(), "pi-gui-testing-e2e-"));
  const owner = formatOwnerLabel(createOwnerIdentity());
  const backend = new DockerWindowsBackend({ ownerLabel: () => owner, configDir: stateRoot });
  t.after(async () => {
    if (!keepDir && process.env.PI_GUI_E2E_DOCKER_WINDOWS_KEEP !== "1") await backend.resetData(new AbortController().signal).catch(() => undefined);
    await rm(project, { recursive: true, force: true });
    await rm(sessionRoot, { recursive: true, force: true });
    if (!keepDir) await rm(stateRoot, { recursive: true, force: true });
  });
  await writeFile(join(project, "hello.txt"), "hello from the client\n");
  await writeFile(join(project, ".env"), "SECRET=never-synced\n");

  await backend.acknowledgeLicense();
  const signal = new AbortController().signal;
  const pull = await backend.buildImage(signal, () => {});
  assert.equal(pull.exitCode, 0, pull.stderr);

  const checks = Object.fromEntries((await runChecks(backend.checks(), { runner: backend.runner, backend: "docker-windows", projectRoot: project, signal })).map((r) => [r.id, r]));
  for (const id of ["host.linux", "kvm.device", "kvm.cpu", "mem.available", "ports.free", "license.ack", "image.base", "isolation.inspect", "docker.rootless", "docker.version"]) {
    assert.equal(checks[id].status, "pass", `${id}: ${checks[id].observed}`);
  }

  if (checks["vm.installed"].status !== "pass") {
    const started = Date.now();
    const install = await backend.installBase(signal, (line) => process.stderr.write(`# ${line}\n`));
    assert.equal(install.exitCode, 0, install.stderr);
    process.stderr.write(`# install took ${Math.round((Date.now() - started) / 60_000)} min\n`);
  }

  const endpoint = await backend.endpoint(signal);
  const before = await baseDiskStamp(backend.runner, endpoint, backend.imageTag, signal);
  const sessionDir = join(sessionRoot, "session");
  await mkdir(sessionDir, { mode: 0o700 });
  const session = await backend.startSession({
    sessionId: "e2e-win-0001",
    projectRoot: project,
    sessionDir,
    config,
    ownerLabel: owner,
    recordResource: async () => {},
    onLog: () => {},
    onStatus: (s) => process.stderr.write(`# ${s}\n`),
    signal,
  });
  let stopped = false;
  t.after(async () => {
    if (!stopped) await session.stop().catch(() => undefined);
  });
  assert.equal(session.sync.excluded >= 1, true, ".env excluded");
  const app = backend.smokeApp();
  const launched = await session.request("launch", { cmd: app.cmd, args: app.args, env: {}, cwd: session.workspacePath });
  if (!launched.windows.some((w) => w.title === "Pi GUI smoke")) {
    const waited = await session.request("wait", { for: "window", value: "Pi GUI smoke", timeoutMs: 30_000 });
    assert.ok(waited.matched, "smoke window appeared");
  }
  const snapshot = await session.request("snapshot", { maxNodes: 200 });
  const button = snapshot.tree.find((n) => ["button", "push button"].includes(n.role) && n.name === "Press me");
  assert.ok(button, `button found (coverage ${snapshot.coverage})`);
  await session.request("act", { ref: button.ref, action: "click" });
  const changed = await session.request("wait", { for: "text", value: "Pressed", timeoutMs: 10_000 });
  assert.ok(changed.matched, "label changed");
  const shot = await session.request("screenshot", {});
  const png = decodePng(Buffer.from(shot.png_base64, "base64"));
  assert.ok(!isUniform(png.rgb), "screenshot is not uniform");

  const leftovers = await session.stop();
  stopped = true;
  assert.deepEqual(leftovers, []);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.equal(await baseDiskStamp(backend.runner, endpoint, backend.imageTag, signal), before, "the session overlay kept the installed disk unchanged");
  assert.deepEqual(await backend.auditOrphans(signal), []);
});
