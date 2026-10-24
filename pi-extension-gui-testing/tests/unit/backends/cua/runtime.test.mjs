/**
 * The `cua` backend inside the unchanged runtime (registered in a test
 * registry, as the integration owner will register it): open and stop,
 * shutdown, the synchronous exit-handler commands, a failed start tracked for
 * retry, the startup sweep from the ledger, and the cost hook in
 * `UsageTracker`. The Cua API is the fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { CUA_HOST_SUPPORT, CuaBackend } from "../../../../src/backends/cua.ts";
import { SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { CuaSettingsStore } from "../../../../src/backends/cua/settings.ts";
import { BackendRegistry } from "../../../../src/backends/registry.ts";
import { DEFAULTS } from "../../../../src/config/types.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { GuiRuntime } from "../../../../src/tools/runtime.ts";
import { UsageTracker } from "../../../../src/usage/detector.ts";
import { cuaEnv, DEAD_OWNER, FakeCuaApi, HOST_TAG, tinyHelperArchive } from "./fake-cua.mjs";

function config(keepSandbox = false) {
  return {
    shared: { targets: ["linux"], workspaceMode: "copy", network: "default", launch: { cmd: "python3", args: ["app.py"] } },
    limits: { ...DEFAULTS.limits },
    usageCheck: { ...DEFAULTS.usageCheck },
    keepSandbox,
    warnings: [],
  };
}

/** The registry entry the integration owner adds to `BUILT_IN` (with these options injected by tests only). */
function cuaEntry() {
  return {
    id: "cua",
    description: "Linux apps in a Cua sandbox in your own cloud account (AWS, Google Cloud, Hetzner, Modal; billed by that cloud)",
    hostSupport: CUA_HOST_SUPPORT,
    targets: ["linux"],
    create: (ctx) => new CuaBackend({ ownerLabel: ctx.ownerLabel, ...(ctx.procRoot ? { procRoot: ctx.procRoot } : {}), ...ctx.options }),
  };
}

async function runtimeEnv(t, fake = {}) {
  const env = await cuaEnv(t);
  const tmp = join(env.root, "tmp");
  await mkdir(tmp);
  const api = new FakeCuaApi(fake);
  const ledger = new SandboxLedger(env.ledgerDir);
  const runner = new FakeCommandRunner().on(() => true, { exitCode: 128, stderr: "not a git repository" });
  const runtime = new GuiRuntime({
    registry: new BackendRegistry([cuaEntry()]),
    tmpRoot: tmp,
    globalConfigPath: join(env.root, "agent", "gui", "config.json"),
    backendOptions: {
      cua: {
        api,
        runner,
        ledger,
        settings: new CuaSettingsStore(env.settingsPath),
        hostTag: HOST_TAG,
        version: "0.1.0",
        helperArchive: tinyHelperArchive,
        readyTimeoutMs: 2_000,
        heartbeatIntervalMs: 0,
        exitWaitMs: 200,
        killWaitMs: 50,
        cuaOnPath: async () => true,
      },
    },
  });
  t.after(() => runtime.shutdown());
  const open = (keep = false) => runtime.openSession({ backend: "cua", projectRoot: env.project, config: config(keep), piSessionId: "pi-1" });
  return { env, api, ledger, runtime, open, tmp };
}

test("a runtime session creates one sandbox, lists its delete for the exit handler, and gui_stop removes everything", async (t) => {
  const { api, ledger, runtime, open, tmp } = await runtimeEnv(t);
  const live = await open();
  const ref = [...api.sandboxes.keys()][0];
  assert.match(ref, new RegExp(`^aws:pi-gui-testing-${HOST_TAG}-gui-[0-9a-f]{8}$`));
  assert.deepEqual(runtime.exitCleanupCommands(), [["cua", "sandbox", "rm", ref, "--force"]]);
  const outcome = await runtime.closeSession(live.id);
  assert.deepEqual(outcome, { stopLeftovers: [], audit: [] });
  assert.equal(api.sandboxes.size, 0);
  assert.deepEqual(await ledger.entries(), []);
  assert.deepEqual(runtime.exitCleanupCommands(), []);
  assert.deepEqual((await readdir(tmp)).filter((d) => d.startsWith("pi-gui-testing-")), []);
});

test("shutdown deletes every running sandbox", async (t) => {
  const { api, runtime, open } = await runtimeEnv(t);
  await open();
  await open();
  assert.equal(api.sandboxes.size, 2);
  await runtime.shutdown();
  assert.equal(api.sandboxes.size, 0);
});

test("a start whose cleanup fails stays tracked and gui_stop retries it", async (t) => {
  const { api, runtime, open } = await runtimeEnv(t, { fail: { upload: "TRANSPORT", delete: "TRANSPORT" } });
  await assert.rejects(open(), /stays tracked and is retried/);
  const [failed] = runtime.list();
  assert.equal(failed.state, "failed");
  assert.equal(runtime.exitCleanupCommands()[0].at(-2).startsWith("aws:"), true, "the exit handler still deletes it");
  api.options.fail = {};
  assert.deepEqual(await runtime.closeSession(failed.id), { stopLeftovers: [], audit: [] });
  assert.equal(api.sandboxes.size, 0);
});

test("a kept sandbox survives stop and shutdown and is not in the exit handler", async (t) => {
  const { api, runtime, open, ledger } = await runtimeEnv(t);
  const live = await open(true);
  assert.deepEqual(runtime.exitCleanupCommands(), [[]]);
  await runtime.closeSession(live.id);
  await runtime.shutdown();
  assert.equal(api.sandboxes.size, 1);
  assert.equal((await ledger.entries())[0].kept, true);
});

test("the startup sweep deletes a crashed owner's sandbox from the ledger", async (t) => {
  const { api, ledger, runtime } = await runtimeEnv(t);
  const name = `pi-gui-testing-${HOST_TAG}-gui-deadbeef`;
  await ledger.write({ version: 1, name, ref: `aws:${name}`, location: "aws", ownerLabel: DEAD_OWNER, sessionId: "gui-deadbeef", projectKey: "p", phase: "created", keep: false, createdAt: "2026-10-24T00:00:00.000Z" });
  api.sandboxes.set(`aws:${name}`, { name, location: "aws", status: "ready" });
  await runtime.sweep();
  assert.deepEqual(api.deleted, [`aws:${name}`]);
  assert.deepEqual(await ledger.entries(), []);
});

test("the cost hook feeds UsageTracker's session-cost warning", async (t) => {
  const { runtime, open } = await runtimeEnv(t);
  const backend = runtime.backend("cua");
  const tracker = new UsageTracker({ estimateCost: (u) => backend.estimateCost(u), warnSessionCostUsd: 0.000001, warnDailyCostUsd: 5 });
  const live = await open();
  tracker.startSession(live.id, "cua");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const warnings = tracker.record({ session: live.id, tool: "gui_snapshot", at: Date.now() });
  assert.equal(warnings[0]?.signal, "session-cost");
  await runtime.closeSession(live.id);
});
