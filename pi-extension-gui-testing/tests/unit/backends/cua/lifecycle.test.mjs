/**
 * `cua` session lifecycle on the fake Cua API: recording before creation,
 * deploy and sync, the helper over the exec stream, deletion on every stop
 * path, keepSandbox, refusals, and cost tracking. No `cua` process runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CuaBackend } from "../../../../src/backends/cua.ts";
import { CuaCostLedger } from "../../../../src/backends/cua/cost.ts";
import { SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { CuaSettingsStore } from "../../../../src/backends/cua/settings.ts";
import { startLeftovers } from "../../../../src/backends/start-failure.ts";
import { DEFAULTS } from "../../../../src/config/types.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { cuaEnv, FakeCuaApi, HOST_TAG, LIVE_OWNER, tinyHelperArchive } from "./fake-cua.mjs";

function config(overrides = {}) {
  return {
    shared: { targets: ["linux"], workspaceMode: "copy", network: "default", launch: { cmd: "python3", args: ["app.py"] }, ...(overrides.shared ?? {}) },
    limits: { ...DEFAULTS.limits },
    usageCheck: { ...DEFAULTS.usageCheck },
    keepSandbox: overrides.keepSandbox ?? false,
    warnings: [],
  };
}

async function setup(t, options = {}) {
  const env = await cuaEnv(t, options);
  const api = options.api ?? new FakeCuaApi(options.fake);
  const ledger = new SandboxLedger(env.ledgerDir);
  let now = options.now ?? 1_000_000;
  const cost = new CuaCostLedger(() => now);
  // `git ls-files` fails, so the file set walks the tree.
  const runner = new FakeCommandRunner().on(() => true, { exitCode: 128, stderr: "not a git repository" });
  const backend = new CuaBackend({
    ownerLabel: () => LIVE_OWNER,
    api,
    runner,
    ledger,
    settings: new CuaSettingsStore(env.settingsPath),
    cost,
    hostTag: HOST_TAG,
    version: "0.1.0",
    procRoot: env.proc,
    helperArchive: tinyHelperArchive,
    readyTimeoutMs: 2_000,
    heartbeatIntervalMs: 0,
    exitWaitMs: 200,
    killWaitMs: 50,
  });
  const events = { recorded: [], exitCleanup: [], status: [] };
  let counter = 0;
  const start = (overrides = {}) => {
    const sessionId = overrides.sessionId ?? `gui-0000000${++counter}`;
    return backend.startSession({
      sessionId,
      projectRoot: env.project,
      sessionDir: env.sessionDir,
      config: overrides.config ?? config(),
      ownerLabel: LIVE_OWNER,
      recordResource: async (kind, id) => {
        events.recorded.push({ kind, id, sandboxes: api.sandboxes.size, ledger: existsSync(ledger.dir) ? (await readdir(ledger.dir)).length : 0 });
      },
      onLog: () => {},
      onStatus: (text) => events.status.push(text),
      onExitCleanup: (argv) => events.exitCleanup.push({ argv, sandboxes: api.sandboxes.size }),
      signal: overrides.signal ?? new AbortController().signal,
    });
  };
  return { env, api, ledger, cost, backend, start, events, advance: (ms) => (now += ms) };
}

const REF = `aws:pi-gui-testing-${HOST_TAG}-gui-00000001`;

test("start records the sandbox before creating it, deploys, syncs without secrets, and starts the helper", async (t) => {
  const { api, ledger, start, events, env } = await setup(t);
  const session = await start();
  t.after(() => session.stop());
  assert.equal(events.recorded[0].kind, "sandbox");
  assert.equal(events.recorded[0].id, REF);
  assert.equal(events.recorded[0].sandboxes, 0, "owner.json lists the sandbox before it exists");
  assert.equal(events.exitCleanup[0].sandboxes, 0, "the exit handler knows it before it exists");
  assert.deepEqual(events.exitCleanup[0].argv, ["cua", "sandbox", "rm", REF, "--force"]);
  const create = api.calls.find((c) => c.method === "createSandbox");
  assert.deepEqual(create.args[0], { name: `pi-gui-testing-${HOST_TAG}-gui-00000001`, location: "aws", image: "linux" });
  assert.deepEqual(api.methods().slice(0, 2), ["cloudStatus", "createSandbox"]);
  // Ledger record exists and says created.
  const record = await ledger.read(`pi-gui-testing-${HOST_TAG}-gui-00000001`);
  assert.equal(record.phase, "created");
  assert.equal(record.ownerLabel, LIVE_OWNER);
  // Helper tools and workspace uploaded and unpacked into the session dir.
  assert.deepEqual(api.uploads.map((u) => u.guestPath), ["/tmp/pi-gui-testing/gui-00000001/tools.tar", "/tmp/pi-gui-testing/gui-00000001/workspace.tar"]);
  const files = api.uploads[1].entries.filter((e) => e.type === "file").map((e) => e.path).sort();
  assert.deepEqual(files, ["app.py", "src/lib.py"]);
  assert.deepEqual(session.sync, { files: 2, bytes: 18, excluded: 1 });
  assert.equal(session.workspacePath, "/tmp/pi-gui-testing/gui-00000001/workspace");
  // Staged archives are gone from the client session dir.
  assert.deepEqual((await readdir(env.sessionDir)).filter((f) => f.endsWith(".tar")), []);
  // The helper runs over the exec stream; the token is in env, never in argv.
  const spawn = api.calls.find((c) => c.method === "spawnHelper");
  assert.equal(spawn.args[0], REF);
  assert.deepEqual(spawn.args[1], ["python3", "-I", "/tmp/pi-gui-testing/gui-00000001/tools/helper"]);
  assert.match(spawn.args[2].PI_GUI_TESTING_TOKEN, /^[0-9a-f]{32}$/);
  assert.ok(!spawn.args[1].some((a) => a.includes(spawn.args[2].PI_GUI_TESTING_TOKEN)));
  assert.equal(session.arch, "x86_64");
  assert.deepEqual(session.forceRemoveArgv(), ["cua", "sandbox", "rm", REF, "--force"]);
  const launched = await session.request("launch", { cmd: "python3", args: ["app.py"], env: {}, cwd: session.workspacePath });
  assert.equal(launched.pid, 77);
});

test("gui_stop deletes the sandbox and its record; the audit is empty; stop is idempotent", async (t) => {
  const { api, ledger, start } = await setup(t);
  const session = await start();
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(api.deleted, [REF]);
  assert.equal(api.sandboxes.size, 0);
  assert.deepEqual(await ledger.entries(), []);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(api.deleted, [REF], "a second stop deletes nothing again");
  assert.deepEqual(session.forceRemoveArgv(), []);
});

test("a failed delete is a leftover, keeps the record as deleting, and a retry finishes", async (t) => {
  let failures = 1;
  const { api, ledger, start } = await setup(t, { fake: { fail: { delete: () => (failures-- > 0 ? "TRANSPORT" : undefined) } } });
  const session = await start();
  const leftovers = await session.stop();
  assert.equal(leftovers.length, 1);
  assert.equal(leftovers[0].kind, "sandbox");
  assert.equal(leftovers[0].id, REF);
  assert.match(leftovers[0].detail, /keep billing/);
  assert.equal((await ledger.entries())[0].record.phase, "deleting");
  assert.deepEqual(session.forceRemoveArgv(), ["cua", "sandbox", "rm", REF, "--force"], "the exit handler still has it");
  assert.equal((await session.auditFootprint()).length, 1);
  assert.deepEqual(await session.stop(), []);
  assert.equal(api.sandboxes.size, 0);
  assert.deepEqual(await ledger.entries(), []);
});

test("a failed create deletes whatever exists and forgets the record", async (t) => {
  const { api, ledger, start } = await setup(t, { fake: { fail: { create: "UNSUPPORTED" } } });
  await assert.rejects(start(), (error) => {
    assert.equal(error.code, "START_FAILED");
    assert.match(error.message, /^creating the sandbox: fake create failed/);
    assert.equal(startLeftovers(error), undefined);
    return true;
  });
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await ledger.entries(), []);
});

test("cancelling during create stops with CANCELLED and deletes the sandbox", async (t) => {
  const controller = new AbortController();
  const { api, start } = await setup(t, { fake: { onCreate: (spec, fake) => (fake.sandboxes.set(`aws:${spec.name}`, { name: spec.name, location: "aws", status: "provisioning" }), controller.abort()) } });
  await assert.rejects(start({ signal: controller.signal }), (error) => error.code === "CANCELLED");
  assert.equal(api.sandboxes.size, 0);
});

test("a failure after create (upload, helper start, setup) deletes the sandbox", async (t) => {
  for (const [name, fake, cfg] of [
    ["upload", { fail: { upload: "TRANSPORT" } }, config()],
    ["helper", { behaviour: { noReady: true } }, config()],
    ["helper exits", { behaviour: { spawnError: true } }, config()],
    ["setup", { behaviour: { handlers: { exec: (params) => ({ exitCode: params.cmd === "false" ? 1 : 0, elapsedMs: 1 }) } } }, config({ shared: { setup: ["false"] } })],
  ]) {
    const { api, ledger, start } = await setup(t, { fake });
    await assert.rejects(start({ config: cfg }), (error) => {
      assert.equal(startLeftovers(error), undefined, `${name}: nothing left`);
      return true;
    }, name);
    assert.equal(api.sandboxes.size, 0, `${name}: sandbox deleted`);
    assert.deepEqual(await ledger.entries(), [], `${name}: record removed`);
  }
});

test("a failed start whose delete fails keeps the session handle on the error for retries", async (t) => {
  const { api, ledger, start } = await setup(t, { fake: { fail: { upload: "TRANSPORT", delete: "TRANSPORT" } } });
  let failure;
  await assert.rejects(start(), (error) => ((failure = error), true));
  const remnant = startLeftovers(failure);
  assert.ok(remnant, "the leftovers are attached");
  assert.equal(remnant.leftovers[0].id, REF);
  assert.equal((await ledger.entries())[0].record.phase, "deleting");
  api.options.fail = {};
  assert.deepEqual(await remnant.session.stop(), []);
  assert.equal(api.sandboxes.size, 0);
});

test("missing helper packages are installed in the sandbox; an impossible install fails cleanly", async (t) => {
  const good = await setup(t, { fake: { missing: ["Xvfb", "python3-gi"] } });
  const session = await good.start();
  t.after(() => session.stop());
  assert.ok(good.api.installed.includes("xvfb"));
  assert.ok(good.events.status.some((s) => /installing the helper's packages/.test(s)));

  const bad = await setup(t, { fake: { missing: ["Xvfb"], install: { exitCode: 90, stderr: "needs root" } } });
  await assert.rejects(bad.start(), /not root and has no passwordless sudo/);
  assert.equal(bad.api.sandboxes.size, 0);
});

test("refusals happen before anything is created", async (t) => {
  const noneNetwork = await setup(t);
  await assert.rejects(noneNetwork.start({ config: config({ shared: { network: "none" } }) }), (e) => e.code === "UNSUPPORTED");
  assert.deepEqual(noneNetwork.api.calls, []);

  const noAck = await setup(t, { settings: { billingAcceptedAt: undefined } });
  await assert.rejects(noAck.start(), (e) => e.code === "NOT_SET_UP" && /billing/.test(e.message));
  assert.ok(!noAck.api.methods().includes("createSandbox"));

  const otherCloud = await setup(t, { settings: { billingLocation: "gcp" } });
  await assert.rejects(otherCloud.start(), /acknowledged for gcp/);
  assert.ok(!otherCloud.api.methods().includes("createSandbox"));

  const noCloud = await setup(t, { fake: { providers: [] } });
  await assert.rejects(noCloud.start(), /no cloud is connected/);
});

test("keepSandbox keeps the sandbox on stop, empties the session dir, and the next session of the project reuses it", async (t) => {
  const { api, ledger, start, events } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  assert.deepEqual(events.exitCleanup.at(-1).argv, [], "the exit handler leaves a kept sandbox alone");
  assert.deepEqual(first.forceRemoveArgv(), []);
  assert.deepEqual(await first.stop(), []);
  assert.deepEqual(api.deleted, []);
  assert.equal(api.sandboxes.size, 1);
  const rmDir = api.calls.filter((c) => c.method === "exec").map((c) => c.args[1].join(" ")).find((a) => a.startsWith("rm -rf -- /tmp/pi-gui-testing/gui-00000001"));
  assert.ok(rmDir, "the session dir is removed from the kept sandbox");
  assert.deepEqual(await first.auditFootprint(), []);
  const entries = await ledger.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kept, true);

  const creates = api.methods().filter((m) => m === "createSandbox").length;
  const second = await start({ config: config({ keepSandbox: true }) });
  assert.equal(api.methods().filter((m) => m === "createSandbox").length, creates, "no new sandbox");
  assert.equal(api.calls.filter((c) => c.method === "spawnHelper").at(-1).args[0], REF);
  assert.ok(api.calls.some((c) => c.method === "exec" && c.args[1].join(" ") === "rm -rf -- /tmp/pi-gui-testing"), "old session dirs are cleared");
  const active = await ledger.entries();
  assert.equal(active[0].kept, false);
  assert.equal(active[0].record.sessionId, "gui-00000002");
  await second.stop();
});

test("a kept sandbox that expired is forgotten and a new one is created", async (t) => {
  const { api, ledger, start } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  api.sandboxes.clear(); // expired in the cloud
  const second = await start({ config: config({ keepSandbox: true }) });
  t.after(() => second.stop());
  assert.equal(api.methods().filter((m) => m === "createSandbox").length, 2);
  assert.equal((await ledger.entries()).filter((e) => e.kept).length, 0);
});

test("keepSandbox does not keep a sandbox whose creation failed", async (t) => {
  const { api, start } = await setup(t, { fake: { fail: { create: "FAILED" } } });
  await assert.rejects(start({ config: config({ keepSandbox: true }) }));
  assert.deepEqual(api.deleted, [REF]);
});

test("the cost estimate counts billed sandbox time at the reported rate and stops at deletion", async (t) => {
  const { backend, start, advance } = await setup(t);
  const session = await start();
  advance(30 * 60_000);
  const usage = { session: session.id, backend: "cua", startedAt: 0, toolCalls: {}, actions: 0, screenshots: 0, allBlackScreenshots: 0, bytesSynced: 0, warnings: [] };
  assert.equal(backend.estimateCost(usage).sessionUsd, 0.25);
  await session.stop();
  advance(60 * 60_000);
  assert.equal(backend.estimateCost(usage).sessionUsd, 0.25);
  assert.equal(backend.estimateCost({ ...usage, backend: "docker-linux" }), undefined);
});

test("the settings file stores no credential and records the acknowledgement", async (t) => {
  const { env } = await setup(t);
  const store = new CuaSettingsStore(join(env.root, "fresh", "cua.json"));
  await store.acknowledgeBilling("aws", new Date("2026-10-24T10:00:00Z"));
  const saved = JSON.parse(await readFile(store.path, "utf8"));
  assert.deepEqual(saved, { version: 1, billingAcceptedAt: "2026-10-24T10:00:00.000Z", billingLocation: "aws" });
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(store.path)).mode & 0o777, 0o600);
  await assert.rejects(store.update({ location: "local" }), /invalid location/);
});
