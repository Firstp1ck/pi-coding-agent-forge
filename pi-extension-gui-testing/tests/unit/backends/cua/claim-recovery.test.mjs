/**
 * A kept-sandbox claim that commits while the ledger becomes unreadable (lock
 * release and the recovery listing both fail) stays tracked: the failed start
 * carries a stand-in session whose stop returns the claim to the kept set.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { CuaBackend } from "../../../../src/backends/cua.ts";
import { SandboxLedger, projectKey } from "../../../../src/backends/cua/ledger.ts";
import { CuaSettingsStore } from "../../../../src/backends/cua/settings.ts";
import { CuaCostLedger } from "../../../../src/backends/cua/cost.ts";
import { SandboxHandle } from "../../../../src/backends/cua/session.ts";
import { startLeftovers } from "../../../../src/backends/start-failure.ts";
import { FakeCuaApi, cuaEnv, HOST_TAG, LIVE_OWNER } from "./fake-cua.mjs";

test("a claim committed while the ledger turns unreadable is attached for retry and goes back to the kept set", { skip: process.getuid?.() === 0 ? "needs a non-root user" : false }, async (t) => {
  const env = await cuaEnv(t);
  const api = new FakeCuaApi();
  const ledger = new SandboxLedger(env.ledgerDir, { lock: { timeoutMs: 150 } });
  const name = `pi-gui-testing-${HOST_TAG}-gui-kept`;
  const ref = `aws:${name}`;
  await ledger.write({ version: 1, name, ref, location: "aws", ownerLabel: LIVE_OWNER, sessionId: "gui-old", projectKey: projectKey(env.project), phase: "created", keep: true, createdAt: new Date().toISOString(), image: "linux" });
  assert.equal(await ledger.markKept(name, "gui-old"), true);
  api.sandboxes.set(ref, { name, location: "aws", status: "ready", image: "linux" });
  const backend = new CuaBackend({ ownerLabel: () => LIVE_OWNER, api, ledger, settings: new CuaSettingsStore(env.settingsPath), hostTag: HOST_TAG, procRoot: env.proc, version: "0.2.0" });

  // After the claim commits and removes the old kept copy, the ledger dir loses read/write access.
  const rm = fs.rm;
  let injected = false;
  fs.rm = async (path, ...rest) => {
    const value = await rm(path, ...rest);
    if (!injected && path === join(ledger.dir, `${name}.kept.json`)) {
      injected = true;
      await fs.chmod(ledger.dir, 0o100);
    }
    return value;
  };
  syncBuiltinESMExports();
  let failure;
  try {
    failure = await backend
      .startSession({ sessionId: "gui-failed", projectRoot: env.project, sessionDir: env.sessionDir, config: { shared: { network: "default" }, keepSandbox: true }, ownerLabel: LIVE_OWNER, recordResource: async () => {}, onLog() {}, onExitCleanup() {}, signal: new AbortController().signal })
      .then(() => assert.fail("the start succeeded"), (error) => error);
    assert.equal(injected, true);
    const attached = startLeftovers(failure);
    assert.ok(attached, "the possible claim is attached for the runtime to retry");
    assert.match(attached.leftovers[0].detail, /could not be read/);
    assert.deepEqual(await attached.session.auditFootprint(), attached.leftovers, "reported while the records stay unreadable");
    assert.deepEqual(await attached.session.stop(), attached.leftovers, "a retry while still unreadable keeps it owed");

    await fs.chmod(ledger.dir, 0o700);
    assert.match((await attached.session.auditFootprint())[0].detail, /goes back to the kept set/);
    assert.deepEqual(await attached.session.stop(), [], "the retry returns the claim");
  } finally {
    fs.rm = rm;
    syncBuiltinESMExports();
    await fs.chmod(ledger.dir, 0o700).catch(() => {});
  }
  const record = await ledger.read(name, true);
  assert.equal(record?.keep, true, "back in the kept set");
  assert.equal(api.sandboxes.has(ref), true, "the kept sandbox is not deleted");
});

const nonRoot = { skip: process.getuid?.() === 0 ? "needs a non-root user" : false };

function keptRecord(env, name, fields = {}) {
  return { version: 1, name, ref: `aws:${name}`, location: "aws", ownerLabel: LIVE_OWNER, sessionId: "gui-old", projectKey: projectKey(env.project), phase: "created", keep: true, createdAt: new Date().toISOString(), image: "linux", ...fields };
}

test("recorded() counts an active, kept, or unreadable record as present", nonRoot, async (t) => {
  const env = await cuaEnv(t);
  const ledger = new SandboxLedger(env.ledgerDir, { lock: { timeoutMs: 150 } });
  const name = `pi-gui-testing-${HOST_TAG}-gui-rec`;
  assert.equal(await ledger.recorded(name), false);
  await ledger.write(keptRecord(env, name));
  assert.equal(await ledger.recorded(name), true, "active");
  assert.equal(await ledger.markKept(name, "gui-old"), true);
  assert.equal(await ledger.recorded(name), true, "kept");
  const file = join(ledger.dir, `${name}.kept.json`);
  await fs.chmod(file, 0o000);
  t.after(() => fs.chmod(file, 0o600).catch(() => {}));
  assert.equal(await ledger.recorded(name), true, "unreadable counts as present");
});

test("keeping with an expected owner never moves another owner's record and never deletes its sandbox", async (t) => {
  const env = await cuaEnv(t);
  const api = new FakeCuaApi();
  const ledger = new SandboxLedger(env.ledgerDir, { lock: { timeoutMs: 150 } });
  const name = `pi-gui-testing-${HOST_TAG}-gui-own`;
  const ref = `aws:${name}`;
  // Same session id, another owner: a collision across Pi processes.
  await ledger.write(keptRecord(env, name, { sessionId: "gui-same", ownerLabel: "other:1:2:boot", keep: true }));
  api.sandboxes.set(ref, { name, location: "aws", status: "ready", image: "linux" });
  const handle = new SandboxHandle({ api, ledger, cost: new CuaCostLedger(), sessionId: "gui-same", name, ref, keep: true, ownerLabel: LIVE_OWNER });
  await handle.returnToKept();
  const active = await ledger.read(name);
  assert.equal(active?.ownerLabel, "other:1:2:boot", "the other owner's claim stays active");
  assert.equal(await ledger.read(name, true), undefined);
  assert.deepEqual(api.deleted ?? [], [], "nothing deleted");
  assert.equal(api.sandboxes.has(ref), true);
});

test("an unreadable record during recovery is reported, never read as \"no claim\"", nonRoot, async (t) => {
  const env = await cuaEnv(t);
  const api = new FakeCuaApi();
  const ledger = new SandboxLedger(env.ledgerDir, { lock: { timeoutMs: 150 } });
  const name = `pi-gui-testing-${HOST_TAG}-gui-kept`;
  const ref = `aws:${name}`;
  await ledger.write(keptRecord(env, name));
  assert.equal(await ledger.markKept(name, "gui-old"), true);
  api.sandboxes.set(ref, { name, location: "aws", status: "ready", image: "linux" });
  const backend = new CuaBackend({ ownerLabel: () => LIVE_OWNER, api, ledger, settings: new CuaSettingsStore(env.settingsPath), hostTag: HOST_TAG, procRoot: env.proc, version: "0.2.0" });
  const rm = fs.rm;
  let injected = false;
  fs.rm = async (path, ...rest) => {
    const value = await rm(path, ...rest);
    if (!injected && path === join(ledger.dir, `${name}.kept.json`)) {
      injected = true;
      await fs.chmod(ledger.dir, 0o100);
    }
    return value;
  };
  syncBuiltinESMExports();
  const active = join(ledger.dir, `${name}.json`);
  try {
    const failure = await backend
      .startSession({ sessionId: "gui-failed", projectRoot: env.project, sessionDir: env.sessionDir, config: { shared: { network: "default" }, keepSandbox: true }, ownerLabel: LIVE_OWNER, recordResource: async () => {}, onLog() {}, onExitCleanup() {}, signal: new AbortController().signal })
      .then(() => assert.fail("the start succeeded"), (error) => error);
    const attached = startLeftovers(failure);
    assert.ok(attached);
    await fs.chmod(ledger.dir, 0o700);
    await fs.chmod(active, 0o000);
    assert.match((await attached.session.auditFootprint())[0]?.detail ?? "", /could not be read/);
    assert.match((await attached.session.stop())[0]?.detail ?? "", /could not be read/, "still owed");
    await fs.chmod(active, 0o600);
    assert.deepEqual(await attached.session.stop(), []);
  } finally {
    fs.rm = rm;
    syncBuiltinESMExports();
    await fs.chmod(ledger.dir, 0o700).catch(() => {});
    await fs.chmod(active, 0o600).catch(() => {});
  }
  assert.equal((await ledger.read(name, true))?.keep, true, "back in the kept set");
  assert.equal(api.sandboxes.has(ref), true);
});
