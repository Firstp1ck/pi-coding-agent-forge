/**
 * The `cua` backend inside the unchanged runtime (registered in a test
 * registry, as the integration owner will register it): open and stop,
 * shutdown, the synchronous exit-handler commands, a failed start tracked for
 * retry, the startup sweep from the ledger, and the cost hook in
 * `UsageTracker`. The Cua API is the fake.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CUA_HOST_SUPPORT, CuaBackend } from "../../../../src/backends/cua.ts";
import { LedgerLock } from "../../../../src/backends/cua/ledger-lock.ts";
import { SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { CuaSettingsStore } from "../../../../src/backends/cua/settings.ts";
import { BackendRegistry } from "../../../../src/backends/registry.ts";
import { createGuiCommands } from "../../../../src/commands/commands.ts";
import { DEFAULTS } from "../../../../src/config/types.ts";
import { FakeCommandRunner } from "../../../../src/runner/fake.ts";
import { GuiRuntime } from "../../../../src/tools/runtime.ts";
import { createGuiTools } from "../../../../src/tools/tools.ts";
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

async function runtimeEnv(t, fake = {}, options = {}) {
  const env = await cuaEnv(t);
  const tmp = join(env.root, "tmp");
  await mkdir(tmp);
  const api = new FakeCuaApi(fake);
  const ledger = new SandboxLedger(env.ledgerDir, options.lockTimeoutMs ? { lock: { timeoutMs: options.lockTimeoutMs } } : {});
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

/** `gui_stop` through the tool, as the agent calls it. */
async function guiStop(runtime, env, session) {
  const stop = createGuiTools(runtime).find((tool) => tool.name === "gui_stop");
  const ctx = { cwd: env.project, hasUI: false, mode: "json", sessionManager: { getSessionId: () => "pi-1" }, ui: { notify() {}, setStatus() {} } };
  return stop.execute("call", { session }, undefined, undefined, ctx);
}

/** Holds the ledger's interprocess lock (as another Pi process would) until the returned function runs. */
const holdLedgerLock = (env) => new LedgerLock(env.ledgerDir).acquire();

const records = async (ledger) => (await ledger.entries()).map((e) => ({ kept: e.kept, sessionId: e.record?.sessionId }));

test("Y1: gui_stop of a kept sandbox while the ledger is locked reports it, keeps the session, and a retry after the lock is released keeps it (reviewer reproduction)", async (t) => {
  const { env, api, ledger, runtime, open } = await runtimeEnv(t, {}, { lockTimeoutMs: 150 });
  const live = await open(true);
  const release = await holdLedgerLock(env);
  t.after(release);
  await assert.rejects(guiStop(runtime, env, live.id), (e) => /footprint audit is not empty/.test(e.message) && /moving its ledger record to the kept set failed/.test(e.message) && /is locked by process/.test(e.message) && /run gui_stop again/.test(e.message));
  assert.deepEqual(runtime.list().map((s) => [s.id, s.state]), [[live.id, "failed"]], "the session stays tracked for a retry");
  assert.deepEqual(await records(ledger), [{ kept: false, sessionId: live.id }]);
  assert.equal(api.sandboxes.size, 1);
  // /gui-cleanup's stop step retries too, and reports the same leftover while the lock is held.
  assert.match(JSON.stringify(await runtime.stopAll("cua")), /moving its ledger record to the kept set failed/);
  assert.equal(runtime.list().length, 1);

  await release();
  const stopped = await guiStop(runtime, env, live.id);
  assert.match(stopped.content[0].text, /footprint audit: empty/);
  assert.deepEqual(runtime.list(), []);
  assert.deepEqual(await records(ledger), [{ kept: true, sessionId: live.id }]);
  assert.deepEqual(api.deleted, [], "the kept sandbox is kept, not deleted");
  // Now /gui-reset cua finds and deletes it.
  const reset = await runtime.backend("cua").resetData(new AbortController().signal);
  assert.deepEqual(reset.lines[0], "deleted 1 kept sandbox(es)");
  assert.equal(api.sandboxes.size, 0);
  assert.deepEqual(await ledger.entries(), []);
});

test("Y1: shutdown with the ledger locked keeps the kept sandbox's session tracked; /gui-cleanup and a later shutdown finish the keep", async (t) => {
  const { env, api, ledger, runtime, open } = await runtimeEnv(t, {}, { lockTimeoutMs: 150 });
  const first = await open(true);
  const second = await open(true);
  const release = await holdLedgerLock(env);
  t.after(release);
  await runtime.shutdown();
  assert.deepEqual(runtime.list().map((s) => s.state), ["failed", "failed"]);
  assert.deepEqual(await records(ledger), [
    { kept: false, sessionId: first.id },
    { kept: false, sessionId: second.id },
  ].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1)));
  await release();
  // /gui-cleanup's stop step finishes both.
  assert.deepEqual(await runtime.stopAll("cua").then(() => runtime.list()), []);
  assert.deepEqual((await records(ledger)).map((r) => r.kept), [true, true]);
  assert.equal(api.sandboxes.size, 2);
  assert.deepEqual(api.deleted, []);

  // A later shutdown retries the same way.
  const third = await open(true);
  assert.equal(api.sandboxes.size, 2, "the next launch reuses a kept sandbox");
  const again = await holdLedgerLock(env);
  t.after(again);
  await runtime.shutdown();
  assert.deepEqual(runtime.list().map((s) => [s.id, s.state]), [[third.id, "failed"]]);
  await again();
  await runtime.shutdown();
  assert.deepEqual(runtime.list(), []);
  assert.deepEqual((await records(ledger)).map((r) => r.kept), [true, true]);
});

test("Y1: a deleted sandbox whose ledger record cannot be removed stays tracked (without an exit-handler delete) until a retry removes the record", async (t) => {
  const { env, api, ledger, runtime, open } = await runtimeEnv(t, {}, { lockTimeoutMs: 150 });
  const live = await open(false);
  const release = await holdLedgerLock(env);
  t.after(release);
  await assert.rejects(guiStop(runtime, env, live.id), /sandbox deleted, but removing its ledger record failed/);
  assert.equal(api.sandboxes.size, 0, "the sandbox itself is deleted");
  assert.deepEqual(runtime.list().map((s) => s.state), ["failed"]);
  assert.deepEqual(runtime.exitCleanupCommands(), [[]], "no second delete at exit");
  assert.equal((await ledger.entries()).length, 1);
  await release();
  assert.deepEqual(await runtime.closeSession(live.id), { stopLeftovers: [], audit: [] });
  assert.deepEqual(runtime.list(), []);
  assert.deepEqual(await ledger.entries(), []);
  assert.deepEqual(api.deleted, [live.session.handle.ref], "deleted once");
});

/** `/gui-reset cua` from a second Pi instance sharing the ledger and cloud account; resolves the report text. */
async function resetFromAnotherPi(t, runtime, env) {
  const other = new GuiRuntime({ registry: new BackendRegistry([cuaEntry()]), tmpRoot: runtime.options.tmpRoot, globalConfigPath: runtime.options.globalConfigPath, backendOptions: runtime.options.backendOptions });
  t.after(() => other.shutdown());
  const messages = [];
  const ctx = { cwd: env.project, hasUI: true, mode: "rpc", sessionManager: { getSessionId: () => "pi-2" }, ui: { confirm: async () => true, notify() {}, setStatus() {}, select: async () => undefined } };
  const reset = createGuiCommands({ sendMessage: (m) => messages.push(m) }, other).find((c) => c.name === "gui-reset");
  await reset.handler("cua", ctx);
  return messages.at(-1).content;
}

test("BB3: /gui-reset cua lists only what remains: a pending deletion it deletes is not a leftover, one it cannot delete still is (reviewer reproduction)", async (t) => {
  const { env, api, ledger, runtime, open } = await runtimeEnv(t);
  const live = await open(false);
  const ref = live.session.handle.ref;
  // The first delete fails: an active record pending deletion, owned by this (running) Pi.
  api.options.fail = { delete: "TRANSPORT" };
  await runtime.closeSession(live.id);
  assert.equal((await ledger.entries())[0].record.phase, "deleting");

  // Still failing: the reset cannot delete it, so it remains and is reported once.
  const failed = await resetFromAnotherPi(t, runtime, env);
  assert.equal(api.sandboxes.size, 1);
  const lines = failed.split("\n").filter((l) => l.includes(ref));
  assert.equal(lines.length, 1, `reported once: ${failed}`);
  assert.match(lines[0], /delete failed/, "with the reset's own failure, not the sweep's earlier finding");

  // The reset deletes it: the sweep's "pending deletion" finding is resolved, not a leftover.
  api.options.fail = {};
  const report = await resetFromAnotherPi(t, runtime, env);
  assert.equal(api.sandboxes.size, 0);
  assert.deepEqual(await ledger.entries(), []);
  assert.doesNotMatch(report, /pending deletion/);
  assert.match(report, /Leftovers: empty/, report);
});

test("CC4: /gui-reset cua keeps an audit failure reported in-band: an unrecorded sandbox the sweep found stays listed when the post-reset listing fails (reviewer reproduction)", async (t) => {
  const { env, api, ledger, runtime } = await runtimeEnv(t);
  const name = `pi-gui-testing-${HOST_TAG}-gui-unrecorded`;
  const ref = `aws:${name}`;
  api.sandboxes.set(ref, { name, location: "aws", status: "ready", image: "linux" });
  let lists = 0;
  // The sweep lists the real unrecorded sandbox; the audit after the reset fails its read-only listing.
  api.options.fail = { list: () => (++lists === 2 ? new Error("injected post-reset list failure") : undefined) };
  const report = await resetFromAnotherPi(t, runtime, env);
  assert.equal(lists, 2);
  assert.equal(api.sandboxes.size, 1, "an unrecorded sandbox is never deleted");
  assert.deepEqual(await ledger.entries(), []);
  assert.doesNotMatch(report, /Leftovers: empty/, report);
  assert.match(report, new RegExp(`${ref}.*no record in the local ledger`), "the sweep's finding stays");
  assert.match(report, /listing sandboxes failed: injected post-reset list failure/, "the audit failure is reported");
  assert.match(report, /may be incomplete/, report);
});

test("CC1: /gui-reset cua leaves a sandbox whose ledger record cannot be read and reports it with the manual remedy", async (t) => {
  const { env, api, ledger, runtime, open } = await runtimeEnv(t);
  const live = await open(true);
  const ref = live.session.handle.ref;
  await runtime.closeSession(live.id);
  const [entry] = await ledger.entries();
  assert.equal(entry.kept, true);
  await writeFile(entry.file, "{ truncated");
  const report = await resetFromAnotherPi(t, runtime, env);
  assert.equal(api.sandboxes.size, 1, "the sandbox is not deleted");
  assert.deepEqual(api.deleted, []);
  assert.equal(await readFile(entry.file, "utf8"), "{ truncated", "the record file is unchanged");
  const lines = report.split("\n").filter((l) => l.includes("unreadable sandbox record"));
  assert.equal(lines.length, 1, report);
  assert.match(lines[0], new RegExp(`cua sandbox rm <location>:${ref.split(":")[1]} --force`));
  assert.doesNotMatch(report, /Leftovers: empty/);
});
