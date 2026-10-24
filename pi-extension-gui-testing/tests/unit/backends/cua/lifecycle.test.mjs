/**
 * `cua` session lifecycle on the fake Cua API: recording before creation,
 * deploy and sync, the helper over the exec stream, deletion on every stop
 * path, keepSandbox, refusals, and cost tracking. No `cua` process runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CuaBackend } from "../../../../src/backends/cua.ts";
import { CuaCostLedger } from "../../../../src/backends/cua/cost.ts";
import { LedgerLock } from "../../../../src/backends/cua/ledger-lock.ts";
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
  const ledger = new SandboxLedger(env.ledgerDir, options.lockTimeoutMs ? { lock: { timeoutMs: options.lockTimeoutMs } } : {});
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

test("V7: the helper runs in host mode with session-owned runtime, lock, and deps dirs, so no writable /deps or venv is needed", async (t) => {
  const { api, start } = await setup(t);
  const session = await start();
  t.after(() => session.stop());
  const dir = "/tmp/pi-gui-testing/gui-00000001";
  const mkdir = api.calls.find((c) => c.method === "exec" && c.args[1][0] === "mkdir");
  assert.deepEqual(mkdir.args[1], ["mkdir", "-p", "-m", "700", "/tmp/pi-gui-testing/displays", dir, `${dir}/tools`, `${dir}/workspace`, `${dir}/run`]);
  const env = api.calls.find((c) => c.method === "spawnHelper").args[2];
  assert.equal(env.PI_GUI_HELPER_MODE, "host");
  assert.equal(env.PI_GUI_WORKSPACE, `${dir}/workspace`);
  assert.equal(env.PI_GUI_RUNTIME_DIR, `${dir}/run`);
  assert.equal(env.PI_GUI_DISPLAY_LOCK_DIR, "/tmp/pi-gui-testing/displays");
  assert.equal(env.PI_GUI_DEPS_DIR, `${dir}/deps`);
  assert.equal(env.PI_GUI_ALLOW_EXEC, "1", "setup runs through exec");
  assert.ok(!Object.values(env).some((v) => typeof v === "string" && v.startsWith("/deps")), "nothing below /deps");
  // The image needs no python3-venv: it is neither probed nor installed.
  const probe = api.calls.find((c) => c.method === "exec" && c.args[1][2]?.includes("missing:"));
  assert.equal(probe.args[1][4], "0", "no pip needed without a pip setup");
  assert.ok(!probe.args[1].includes("python3-venv"));
});

test("V7: a setup that uses pip probes for pip and installs python3-pip when the image lacks it", async (t) => {
  const { setupUsesPip, HELPER_APT_PACKAGES } = await import("../../../../src/backends/cua/deploy.ts");
  assert.equal(setupUsesPip(["pip install -r requirements.txt"]), true);
  assert.equal(setupUsesPip(["python3 -m pip install ."]), true);
  assert.equal(setupUsesPip(["cd app && pip3 install ."]), true);
  assert.equal(setupUsesPip(["npm ci", "make pipeline"]), false);
  assert.ok(!HELPER_APT_PACKAGES.includes("python3-venv"));
  const { api, start } = await setup(t, { fake: { missing: ["python3-pip"] } });
  const cfg = config();
  cfg.shared.setup = ["pip install -r requirements.txt"];
  const session = await start({ config: cfg });
  t.after(() => session.stop());
  const probe = api.calls.find((c) => c.method === "exec" && c.args[1][2]?.includes("missing:"));
  assert.equal(probe.args[1][4], "1");
  assert.ok(api.installed.includes("python3-pip"));
  assert.ok(!api.installed.includes("python3-venv"));
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

test("V2: a failed lookup of a kept sandbox keeps its record and fails without creating a new sandbox", async (t) => {
  const { api, ledger, start } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  api.options.fail = { get: () => ((api.options.fail = {}), new Error("transient lookup failure")) };
  await assert.rejects(start({ config: config({ keepSandbox: true }) }), (e) => e.code === "START_FAILED" && /checking the kept sandbox/.test(e.message) && /transient lookup failure/.test(e.message));
  assert.equal(api.methods().filter((m) => m === "createSandbox").length, 1, "no new sandbox");
  assert.deepEqual([...api.sandboxes.keys()], [REF], "the kept sandbox is untouched");
  assert.deepEqual(api.deleted, []);
  const entries = await ledger.entries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kept, true, "the record is back in the kept set");
  assert.equal(entries[0].record.ref, REF);

  const coded = await setup(t);
  const kept = await coded.start({ config: config({ keepSandbox: true }) });
  await kept.stop();
  coded.api.options.fail = { get: "TRANSPORT" };
  await assert.rejects(coded.start({ config: config({ keepSandbox: true }) }), /checking the kept sandbox/);
  assert.equal((await coded.ledger.entries())[0].kept, true);
  coded.api.options.fail = {};

  // The next start reuses it.
  const again = await start({ config: config({ keepSandbox: true }) });
  t.after(() => again.stop());
  assert.equal(api.methods().filter((m) => m === "createSandbox").length, 1);
  assert.equal(api.calls.filter((c) => c.method === "spawnHelper").at(-1).args[0], REF);
});

test("V2: a confirmed NOT_FOUND forgets the kept record and creates a new sandbox", async (t) => {
  const { api, ledger, start } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  api.options.fail = { get: "NOT_FOUND" };
  const second = await start({ config: config({ keepSandbox: true }) });
  api.options.fail = {};
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

test("V5: a kept sandbox keeps counting between sessions, reuse never counts twice, and deletion stops it", async (t) => {
  const { backend, start, advance, cost, api } = await setup(t);
  const usage = (session) => ({ session, backend: "cua", startedAt: 0, toolCalls: {}, actions: 0, screenshots: 0, allBlackScreenshots: 0, bytesSynced: 0, warnings: [] });
  const daily = () => cost.dailyUsd();
  const first = await start({ config: config({ keepSandbox: true }) });
  advance(30 * 60_000);
  await first.stop();
  assert.equal(backend.estimateCost(usage(first.id)).sessionUsd, 0.25);
  advance(60 * 60_000); // kept, idle, still billed by the cloud
  assert.equal(backend.estimateCost(usage(first.id)).sessionUsd, 0.25, "the session's share ended at its stop");
  assert.equal(daily(), 0.75, "the kept sandbox keeps billing between sessions");
  const second = await start({ config: config({ keepSandbox: true }) });
  assert.equal(api.methods().filter((m) => m === "createSandbox").length, 1, "reused");
  advance(30 * 60_000);
  assert.equal(backend.estimateCost(usage(second.id)).sessionUsd, 0.25);
  assert.equal(daily(), 1, "reuse is not counted twice");
  await second.stop();
  // /gui-reset deletes the kept sandbox: billing stops there.
  const reset = await backend.resetData(new AbortController().signal);
  assert.deepEqual(reset.leftovers, []);
  advance(60 * 60_000);
  assert.equal(daily(), 1, "nothing counts after the confirmed deletion");
});

test("V5: the reviewer's scenario: a kept sandbox after its session stop is still estimated", async () => {
  let now = new Date("2026-10-24T12:00:00").getTime();
  const cost = new CuaCostLedger(() => now);
  cost.start("gui-cost", 1);
  const { SandboxHandle } = await import("../../../../src/backends/cua/session.ts");
  const handle = new SandboxHandle({ api: { exec: async () => ({ exitCode: 0, stderr: "" }) }, ledger: { markKept: async () => true }, cost, sessionId: "gui-cost", name: "pi-gui-testing-repro", ref: "aws:pi-gui-testing-repro", keep: true });
  handle.markCreated();
  now += 60_000;
  assert.deepEqual(await handle.remove(), []);
  now += 3_600_000;
  assert.equal(Math.round(cost.dailyUsd() * 6000) / 6000, Math.round((61 / 60) * 6000) / 6000);
  assert.equal(cost.sessionUsd("gui-cost"), 1 / 60);
  cost.sandboxDeleted("gui-cost");
  now += 3_600_000;
  assert.equal(Math.round(cost.dailyUsd() * 6000) / 6000, Math.round((61 / 60) * 6000) / 6000);
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

test("X1: a sweep that read a dead owner's record before a newer keep and claim leaves the live session's record alone (reviewer B interleaving)", async (t) => {
  const { sweepCuaOrphans } = await import("../../../../src/backends/cua/orphans.ts");
  const { DEAD_OWNER } = await import("./fake-cua.mjs");
  const { api, ledger, start, env } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  const name = first.handle.name;
  // The owner crashed while the sandbox was in use: an active record of a dead owner that asked to keep it.
  const saved = await ledger.read(name, true);
  await ledger.write({ ...saved, ownerLabel: DEAD_OWNER });
  await ledger.remove(name, true);
  const slow = new SandboxLedger(env.ledgerDir);
  const scan = slow.entries.bind(slow);
  let entered, release;
  const waiting = new Promise((r) => (entered = r));
  const gate = new Promise((r) => (release = r));
  slow.entries = async () => {
    const entries = await scan();
    entered();
    await gate;
    return entries;
  };
  const options = { api, ledger: slow, hostTag: HOST_TAG, procRoot: env.proc, signal: new AbortController().signal };
  const staleSweep = sweepCuaOrphans(options);
  await waiting;
  await sweepCuaOrphans({ ...options, ledger });
  const active = await start({ config: config({ keepSandbox: true }) });
  t.after(() => active.stop());
  assert.equal(active.handle.ref, first.handle.ref, "the kept sandbox was reused");
  release();
  const result = await staleSweep;
  assert.deepEqual(result.kept, [], "the stale sweep moved nothing");
  assert.deepEqual((await ledger.entries()).map((e) => [e.kept, e.record.sessionId]), [[false, active.id]], "the live session's record stays active");
  const third = await start({ config: config({ keepSandbox: true }) });
  t.after(() => third.stop());
  assert.notEqual(third.handle.ref, active.handle.ref, "a second session never gets a sandbox in use");
});

test("X1: a stale sweep never deletes a sandbox whose record another session has claimed since", async (t) => {
  const { sweepCuaOrphans } = await import("../../../../src/backends/cua/orphans.ts");
  const { DEAD_OWNER } = await import("./fake-cua.mjs");
  const { api, ledger, start, env } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  const name = first.handle.name;
  const saved = await ledger.read(name, true);
  // A dead owner's record that did not ask to be kept: the sweep would delete it.
  await ledger.write({ ...saved, ownerLabel: DEAD_OWNER, keep: false });
  await ledger.remove(name, true);
  const slow = new SandboxLedger(env.ledgerDir);
  const scan = slow.entries.bind(slow);
  let release;
  const gate = new Promise((r) => (release = r));
  let read;
  const readDone = new Promise((r) => (read = r));
  slow.entries = async () => {
    const entries = await scan();
    read();
    await gate;
    return entries;
  };
  const staleSweep = sweepCuaOrphans({ api, ledger: slow, hostTag: HOST_TAG, procRoot: env.proc, signal: new AbortController().signal });
  await readDone;
  // Meanwhile the record became a live session's kept record and was claimed again.
  await ledger.write({ ...saved, ownerLabel: LIVE_OWNER, sessionId: "gui-livelive" });
  await ledger.markKept(name, "gui-livelive");
  const active = await start({ config: config({ keepSandbox: true }) });
  t.after(() => active.stop());
  assert.equal(active.handle.ref, first.handle.ref);
  release();
  const result = await staleSweep;
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(api.deleted, [], "the sandbox in use was not deleted");
  assert.equal((await ledger.read(name)).sessionId, active.id);
});

test("X3: a kept sandbox is reused only for the same image (reviewer reproduction)", async (t) => {
  const { api, ledger, backend, start } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  assert.equal((await ledger.read(first.handle.name, true)).image, "linux", "the record names its image");
  await backend.recordSetupInputs({ image: "ghcr.io/me/desktop:2" });
  const second = await start({ config: config({ keepSandbox: true }) });
  t.after(() => second.stop());
  assert.deepEqual(api.calls.filter((c) => c.method === "createSandbox").map((c) => c.args[0].image), ["linux", "ghcr.io/me/desktop:2"]);
  assert.notEqual(second.handle.ref, first.handle.ref);
  assert.equal(api.sandboxes.get(api.calls.filter((c) => c.method === "spawnHelper").at(-1).args[0]).image, "ghcr.io/me/desktop:2");
  assert.equal((await ledger.read(first.handle.name, true))?.image, "linux", "the other image's sandbox stays kept");
  assert.ok(second.warnings?.some((w) => w.includes(first.handle.ref) && w.includes('"linux"') && /gui-reset cua/.test(w)), JSON.stringify(second.warnings));
});

test("X3: a kept record without image metadata is never reused, is reported, and /gui-reset deletes it", async (t) => {
  const { api, ledger, backend, start } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  const old = await ledger.read(first.handle.name, true);
  delete old.image;
  await writeFile(join(ledger.dir, `${old.name}.kept.json`), JSON.stringify(old));
  const second = await start({ config: config({ keepSandbox: true }) });
  assert.equal(api.methods().filter((m) => m === "createSandbox").length, 2, "a new sandbox");
  assert.ok(second.warnings?.some((w) => w.includes(old.ref) && /older version/.test(w)), JSON.stringify(second.warnings));
  await second.stop();
  const audit = await backend.auditOrphans(new AbortController().signal);
  assert.ok(audit.some((l) => l.id === old.ref && /image is not recorded/.test(l.detail)), JSON.stringify(audit));
  const swept = await backend.sweepOrphans(new AbortController().signal);
  assert.ok(swept.some((l) => l.id === old.ref && /gui-reset cua/.test(l.detail)), JSON.stringify(swept));
  await backend.resetData(new AbortController().signal);
  assert.ok(api.deleted.includes(old.ref));
  assert.deepEqual(await ledger.entries(), []);
});

test("X3: a kept sandbox whose reported image differs from the record is not reused and stays kept", async (t) => {
  const { api, ledger, start } = await setup(t);
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  api.sandboxes.get(first.handle.ref).image = "windows";
  const second = await start({ config: config({ keepSandbox: true }) });
  t.after(() => second.stop());
  assert.notEqual(second.handle.ref, first.handle.ref);
  assert.ok(await ledger.read(first.handle.name, true), "back in the kept set");
  assert.ok(second.warnings?.some((w) => w.includes(first.handle.ref) && /"windows"/.test(w)), JSON.stringify(second.warnings));
});

test("X4: a kept sandbox confirmed missing stops billing (reviewer reproduction)", async (t) => {
  for (const missing of ["undefined", "NOT_FOUND"]) {
    const { api, cost, start, advance } = await setup(t);
    const first = await start({ config: config({ keepSandbox: true }) });
    await first.stop();
    api.sandboxes.clear(); // TTL expiry
    if (missing === "NOT_FOUND") api.options.fail = { get: "NOT_FOUND" };
    advance(3_600_000);
    const second = await start({ config: config({ keepSandbox: true }) });
    api.options.fail = {};
    const before = cost.dailyUsd();
    advance(3_600_000);
    assert.equal(cost.dailyUsd() - before, 0.5, `${missing}: only the new $0.50/h sandbox bills`);
    await second.stop();
  }
});

/** Takes the ledger lock (as another Pi process would) right after the next start claims a kept record. */
function lockAfterClaim(api, env) {
  const held = {};
  const getSandbox = api.getSandbox.bind(api);
  api.getSandbox = async (...args) => {
    if (!held.release) held.release = await new LedgerLock(env.ledgerDir).acquire();
    return getSandbox(...args);
  };
  return held;
}

const keptRecords = async (ledger) => (await ledger.entries()).map((e) => ({ kept: e.kept, sessionId: e.record.sessionId }));

test("Y1: a kept sandbox's stop whose keep transition fails is a leftover, audited, and retried until the record is kept", async (t) => {
  const { env, api, ledger, cost, start, advance } = await setup(t, { lockTimeoutMs: 120 });
  const session = await start({ config: config({ keepSandbox: true }) });
  const release = await new LedgerLock(env.ledgerDir).acquire();
  t.after(release);
  const [left] = await session.stop();
  assert.equal(left.kind, "sandbox");
  assert.equal(left.id, REF);
  assert.match(left.detail, /moving its ledger record to the kept set failed.*keeps billing.*is locked by process/);
  assert.deepEqual((await session.auditFootprint()).map((l) => l.detail), [left.detail], "the audit keeps reporting it");
  assert.deepEqual(session.forceRemoveArgv(), [], "a kept sandbox is never in the exit handler");
  assert.deepEqual(await keptRecords(ledger), [{ kept: false, sessionId: "gui-00000001" }]);
  const billed = cost.sessionUsd("gui-00000001");
  advance(3_600_000);
  assert.ok(cost.sessionUsd("gui-00000001") > billed, "the session's share keeps counting until the keep completes");
  await release();
  assert.deepEqual(await session.stop(), []);
  const released = cost.sessionUsd("gui-00000001");
  advance(3_600_000);
  assert.equal(cost.sessionUsd("gui-00000001"), released);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(await keptRecords(ledger), [{ kept: true, sessionId: "gui-00000001" }]);
  assert.equal(api.calls.filter((c) => c.method === "exec" && c.args[1].join(" ").startsWith("rm -rf -- /tmp/pi-gui-testing/gui-00000001")).length, 1, "the session dir is removed once");
  assert.deepEqual(api.deleted, []);
});

test("Y1: a kept sandbox whose record vanished before its keep transition is deleted, not left untracked", async (t) => {
  const { api, ledger, start } = await setup(t);
  const session = await start({ config: config({ keepSandbox: true }) });
  await ledger.remove(`pi-gui-testing-${HOST_TAG}-gui-00000001`);
  assert.deepEqual(await session.stop(), []);
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await session.auditFootprint(), []);
  assert.deepEqual(await ledger.entries(), []);
});

test("Y1: a start that cannot return a claimed kept record to the kept set fails with it attached; the retry keeps it", async (t) => {
  const { env, api, ledger, start } = await setup(t, { lockTimeoutMs: 120 });
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  api.options.fail = { get: () => ((api.options.fail = {}), new Error("transient lookup failure")) };
  const held = lockAfterClaim(api, env);
  t.after(() => held.release?.());
  const error = await start({ config: config({ keepSandbox: true }) }).then(() => assert.fail("the start succeeded"), (e) => e);
  assert.match(error.message, /checking the kept sandbox/);
  const attached = startLeftovers(error);
  assert.ok(attached, "the claim is attached for the runtime to track");
  assert.match(attached.leftovers[0].detail, /moving its ledger record to the kept set failed/);
  assert.deepEqual(await keptRecords(ledger), [{ kept: false, sessionId: "gui-00000002" }], "claimed, not yet returned");
  assert.deepEqual((await attached.session.auditFootprint()).length, 1);
  await held.release();
  assert.deepEqual(await attached.session.stop(), []);
  assert.deepEqual(await attached.session.auditFootprint(), []);
  assert.deepEqual(await keptRecords(ledger), [{ kept: true, sessionId: "gui-00000002" }]);
  assert.deepEqual(api.deleted, []);
  assert.equal(api.methods().filter((m) => m === "createSandbox").length, 1, "no new sandbox");
});

test("Y1: a start that cannot forget a claimed kept record whose sandbox is gone fails with it attached; the retry forgets it", async (t) => {
  const { env, api, ledger, start } = await setup(t, { lockTimeoutMs: 120 });
  const first = await start({ config: config({ keepSandbox: true }) });
  await first.stop();
  api.sandboxes.clear(); // expired in the cloud
  const held = lockAfterClaim(api, env);
  t.after(() => held.release?.());
  const error = await start({ config: config({ keepSandbox: true }) }).then(() => assert.fail("the start succeeded"), (e) => e);
  assert.match(error.message, /forgetting the kept sandbox .* failed/);
  const attached = startLeftovers(error);
  assert.equal(attached.leftovers[0].kind, "ledger");
  assert.deepEqual(attached.session.forceRemoveArgv(), [], "nothing to delete at exit");
  assert.equal(api.methods().filter((m) => m === "createSandbox").length, 1, "no new sandbox while the ledger is locked");
  await held.release();
  assert.deepEqual(await attached.session.stop(), []);
  assert.deepEqual(await ledger.entries(), []);
  assert.deepEqual(api.deleted, [], "nothing to delete");
});
