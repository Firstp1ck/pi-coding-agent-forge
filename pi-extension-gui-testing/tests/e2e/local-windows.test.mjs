/**
 * local-windows end to end on this host (spec §4.5, §5.5, M5 exit criterion):
 * the real Windows helper starts in `local` mode, the WinForms smoke app runs
 * on the session's private desktop, the button is found through UI
 * Automation and clicked, the user's foreground window does not change, and
 * stop or a killed helper leaves nothing behind. Skipped unless this is a
 * Windows host; never run on Windows yet (see plans/handoffs/windows-WL.md).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalWindowsBackend } from "../../src/backends/local-windows.ts";
import { localTempRoot } from "../../src/backends/windows/paths.ts";
import { runChecks } from "../../src/checks/runner.ts";
import { createOwnerIdentity } from "../../src/cleanup/identity.ts";
import { createSessionDir } from "../../src/cleanup/session-dir.ts";
import { auditSession } from "../../src/cleanup/sweep.ts";
import { DEFAULTS } from "../../src/config/types.ts";
import { decodePng, isUniform } from "../../src/tools/png.ts";

const SKIP = process.platform === "win32" ? undefined : "local-windows needs a Windows host";

function config() {
  return { shared: { targets: ["windows"], workspaceMode: "mount", network: "default" }, limits: { ...DEFAULTS.limits }, usageCheck: { ...DEFAULTS.usageCheck }, keepSandbox: false, warnings: [] };
}

async function scratch(t) {
  const root = await mkdtemp(join(tmpdir(), "pgw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, "project");
  await mkdir(project);
  return { root, project };
}

async function startSession(t, backend, project) {
  const dir = await createSessionDir({ identity: createOwnerIdentity(), piSessionId: "e2e", backend: "local-windows" });
  let session;
  // Unconditional teardown, also when an assertion fails before the test's own stop(): helper, jobs, runtime dir, then the session dir.
  t.after(async () => {
    await session?.stop().catch(() => undefined);
    await dir.remove();
  });
  const logs = [];
  session = await backend.startSession({
    sessionId: `gui-e2e${Date.now() % 100000}`,
    projectRoot: project,
    sessionDir: dir.path,
    config: config(),
    ownerLabel: dir.ownerLabel,
    recordResource: (kind, id) => dir.recordResource(kind, id),
    onLog: (e) => logs.push(e),
    signal: AbortSignal.timeout(120_000),
  });
  return { session, dir, logs };
}

test("local-windows: required checks pass on this host", { skip: SKIP }, async (t) => {
  const { project } = await scratch(t);
  const backend = new LocalWindowsBackend();
  const results = await runChecks(backend.checks(), { runner: backend.runner, backend: "local-windows", projectRoot: project, signal: AbortSignal.timeout(300_000) });
  for (const r of results.filter((x) => x.required)) assert.equal(r.status, "pass", `${r.id}: ${r.observed}`);
});

test("local-windows: smoke app on the private desktop, foreground unchanged, clean stop", { skip: SKIP }, async (t) => {
  const { project } = await scratch(t);
  const backend = new LocalWindowsBackend();
  const { session, dir } = await startSession(t, backend, project);
  assert.ok(session.capabilities.includes("desktop-private"));
  assert.ok(session.runtimeDir.toLowerCase().startsWith(localTempRoot(process.env).toLowerCase()));
  const app = backend.smokeApp();
  const launched = await session.request("launch", { cmd: app.cmd, args: app.args, env: {}, cwd: project });
  if (!launched.windows.some((w) => w.title === "Pi GUI smoke")) {
    assert.equal((await session.request("wait", { for: "window", value: "Pi GUI smoke", timeoutMs: 20_000 })).matched, true);
  }
  const snapshot = await session.request("snapshot", { maxNodes: 500 });
  const button = snapshot.tree.find((n) => n.name === "Press me" && /button/.test(n.role));
  assert.ok(button, `button not found (coverage ${snapshot.coverage})`);
  await session.request("act", { ref: button.ref, action: "click" });
  assert.equal((await session.request("wait", { for: "text", value: "Pressed", timeoutMs: 5_000 })).matched, true);
  const shot = await session.request("screenshot", {});
  const png = decodePng(Buffer.from(shot.png_base64, "base64"));
  assert.equal(isUniform(png.rgb), false, "screenshot is not a single colour");
  const foreground = await session.foregroundUnchanged(AbortSignal.timeout(60_000));
  assert.equal(foreground.ok, true, foreground.observed);
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual((await auditSession({ path: dir.path, resources: dir.resources })).filter((l) => l.kind === "process"), []);
});

test("local-windows: a killed helper's jobs, processes, and runtime dir are removed by the client", { skip: SKIP }, async (t) => {
  const { project } = await scratch(t);
  const backend = new LocalWindowsBackend();
  const { session } = await startSession(t, backend, project);
  const app = backend.smokeApp();
  await session.request("launch", { cmd: app.cmd, args: app.args, env: {}, cwd: project });
  process.kill(session.helperPid, "SIGKILL");
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(await session.auditFootprint(), []);
});
