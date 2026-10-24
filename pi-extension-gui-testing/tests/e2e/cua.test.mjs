/**
 * Live `cua` e2e (spec §11 M3 exit criteria, Linux target): creates ONE real
 * sandbox in the user's connected cloud, which that cloud BILLS. It runs only
 * when explicitly enabled and is skipped everywhere else, including CI:
 *
 *   PI_GUI_TESTING_CUA_E2E=1 npm run test:e2e -- tests/e2e/cua.test.mjs
 *
 * Needs the `cua` CLI, `cua auth login`, a cloud connected with
 * `cua cloud connect <cloud> --default`, and the billing acknowledgement in
 * the global config dir (`/gui-setup cua --accept-billing`). Checks: the
 * smoke test passes with an empty footprint audit, the synced workspace
 * excludes secrets, and after stop no sandbox of this run is left in a
 * `cua sandbox ls` listing that succeeded and parsed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUA_HOST_SUPPORT, CuaBackend } from "../../src/backends/cua.ts";
import { BackendRegistry } from "../../src/backends/registry.ts";
import { DEFAULTS } from "../../src/config/types.ts";
import { runSmokeTest } from "../../src/setup/smoke.ts";
import { GuiRuntime } from "../../src/tools/runtime.ts";

function skipReason() {
  if (process.env.PI_GUI_TESTING_CUA_E2E !== "1") return "live Cua test disabled (it bills your cloud account); set PI_GUI_TESTING_CUA_E2E=1 to run it";
  const cua = spawnSync("cua", ["--version"], { encoding: "utf8" });
  if (cua.error || cua.status !== 0) return "the cua CLI is not installed";
  const auth = spawnSync("cua", ["--json", "auth", "status"], { encoding: "utf8" });
  if (auth.status !== 0) return "not signed in to cua.ai (cua auth login)";
  return false;
}

const skip = skipReason();

/** The parsed `cua sandbox ls` of the user's account; throws when the call or its JSON fails (never an empty pass). */
async function sandboxNames(backend) {
  const listed = await backend.api.listSandboxes(AbortSignal.timeout(120_000));
  assert.ok(Array.isArray(listed), "the sandbox listing parsed");
  return listed.map((s) => s.name);
}

function runtimeFor(root) {
  return new GuiRuntime({
    registry: new BackendRegistry([
      { id: "cua", description: "Cua sandbox (live e2e)", hostSupport: CUA_HOST_SUPPORT, targets: ["linux"], create: (ctx) => new CuaBackend({ ownerLabel: ctx.ownerLabel }) },
    ]),
    tmpRoot: root,
  });
}

test("cua smoke test passes and leaves no sandbox", { skip, timeout: 60 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-e2e-cua-"));
  const runtime = runtimeFor(root);
  t.after(async () => {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const backend = runtime.backend("cua");
  const before = new Set(await sandboxNames(backend));
  const outcome = await runSmokeTest({ runtime, backend: "cua", piSessionId: "e2e-cua", signal: AbortSignal.timeout(45 * 60_000) });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.deepEqual(outcome.leftovers ?? [], [], "the smoke session's footprint audit is empty");
  const after = await sandboxNames(backend);
  assert.deepEqual(after.filter((name) => !before.has(name) && name.startsWith("pi-gui-testing-")), [], "no sandbox of this run is left");
  const leftovers = await backend.auditOrphans(AbortSignal.timeout(60_000));
  assert.deepEqual(leftovers.filter((l) => l.kind === "sandbox" && !before.has(l.id.split(":").at(-1))), []);
});

test("cua sync uploads the project without secrets and stop deletes the sandbox", { skip, timeout: 60 * 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gui-e2e-cua-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "app.py"), "print('hi')\n");
  await writeFile(join(project, ".env"), "SECRET=do-not-upload\n");
  const runtime = runtimeFor(root);
  t.after(async () => {
    await runtime.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  const config = { shared: { targets: ["linux"], workspaceMode: "copy", network: "default" }, limits: { ...DEFAULTS.limits }, usageCheck: { ...DEFAULTS.usageCheck }, keepSandbox: false, warnings: [] };
  const live = await runtime.openSession({ backend: "cua", projectRoot: project, config, piSessionId: "e2e-cua" });
  assert.equal(live.session.sync.files, 1);
  const listing = await live.session.request("exec", { cmd: "ls -A", cwd: live.session.workspacePath, env: {}, timeoutMs: 30_000 });
  assert.equal(listing.exitCode, 0);
  const outcome = await runtime.closeSession(live.id);
  assert.deepEqual(outcome, { stopLeftovers: [], audit: [] });
  const names = await sandboxNames(runtime.backend("cua"));
  assert.ok(!names.some((name) => name.endsWith(live.id)), `the sandbox of this session is gone: ${names.join(", ")}`);
});
