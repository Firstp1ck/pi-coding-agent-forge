/**
 * The sandbox ledger and the `cua` orphan audit, sweep, startup gate, and
 * reset: only this machine's recorded sandboxes of dead owners are deleted;
 * live, unknown, unrecorded, and other machines' sandboxes are left alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CuaBackend } from "../../../../src/backends/cua.ts";
import { hostPrefix, hostTag, projectKey, recordOwnerLiveness, sandboxName, SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { auditCuaOrphans, deleteKeptSandboxes, hasDeadOwnerRecords, sweepCuaOrphans } from "../../../../src/backends/cua/orphans.ts";
import { CuaSettingsStore } from "../../../../src/backends/cua/settings.ts";
import { cuaEnv, DEAD_OWNER, FakeCuaApi, HOST_TAG, LIVE_OWNER } from "./fake-cua.mjs";

function record(name, overrides = {}) {
  return { version: 1, name, ref: `aws:${name}`, location: "aws", ownerLabel: DEAD_OWNER, sessionId: "gui-1", projectKey: "p", phase: "created", keep: false, createdAt: "2026-10-24T00:00:00.000Z", ...overrides };
}

async function world(t) {
  const env = await cuaEnv(t);
  const api = new FakeCuaApi();
  const ledger = new SandboxLedger(env.ledgerDir);
  const add = async (name, overrides = {}, { kept = false, inCloud = true } = {}) => {
    const r = record(name, overrides);
    await ledger.write(r);
    if (kept) await ledger.markKept(name);
    if (inCloud) api.sandboxes.set(r.ref, { name, location: "aws", status: "ready" });
    return r;
  };
  const options = { api, ledger, hostTag: HOST_TAG, signal: new AbortController().signal, procRoot: env.proc };
  return { env, api, ledger, add, options };
}

const NAME = (id) => sandboxName(id, HOST_TAG);

test("names carry this machine's tag; host tags are stable hashes", () => {
  assert.equal(sandboxName("gui-1a2b3c4d", "abcd1234"), "pi-gui-testing-abcd1234-gui-1a2b3c4d");
  assert.ok(sandboxName("gui-1a2b3c4d", "abcd1234").startsWith(hostPrefix("abcd1234")));
  assert.throws(() => sandboxName("../x", "abcd1234"), /valid sandbox name/);
  assert.match(hostTag(), /^[0-9a-f]{8}$/);
  assert.equal(hostTag(), hostTag());
  assert.notEqual(projectKey("/a"), projectKey("/b"));
});

test("the ledger writes 0600 records, claims a kept sandbox once, and reports bad files", async (t) => {
  const { ledger, add, env } = await world(t);
  await add(NAME("gui-1"), { ownerLabel: LIVE_OWNER, keep: true }, { kept: true });
  assert.equal((await stat(join(ledger.dir, `${NAME("gui-1")}.kept.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(ledger.dir)).mode & 0o777, 0o700);
  const owner = { ownerLabel: LIVE_OWNER, sessionId: "gui-2" };
  const [a, b] = await Promise.all([ledger.claimKept("aws", "p", owner), ledger.claimKept("aws", "p", owner)]);
  assert.equal([a, b].filter(Boolean).length, 1, "exactly one claim wins");
  assert.equal((a ?? b).sessionId, "gui-2");
  assert.equal(await ledger.claimKept("aws", "p", owner), undefined);
  assert.equal(await ledger.claimKept("gcp", "p", owner), undefined);
  await writeFile(join(env.ledgerDir, `${NAME("gui-9")}.json`), "{broken");
  const entries = await ledger.entries();
  assert.equal(entries.filter((e) => e.problem).length, 1);
});

test("owner liveness follows the client sweep rules", async (t) => {
  const { env } = await world(t);
  assert.equal(recordOwnerLiveness({ ownerLabel: LIVE_OWNER }, env.proc), "alive");
  assert.equal(recordOwnerLiveness({ ownerLabel: DEAD_OWNER }, env.proc), "dead");
  assert.equal(recordOwnerLiveness({ ownerLabel: LIVE_OWNER.replace(/:[^:]+$/, ":other-boot") }, env.proc), "dead");
  assert.equal(recordOwnerLiveness({ ownerLabel: "garbage" }, env.proc), "unknown");
});

test("the audit lists dead and unknown owners, bad records, and unrecorded sandboxes of this machine only", async (t) => {
  const { api, add, options, env } = await world(t);
  await add(NAME("gui-dead"));
  await add(NAME("gui-live"), { ownerLabel: LIVE_OWNER });
  await add(NAME("gui-unknown"), { ownerLabel: "not-a-label" });
  await add(NAME("gui-kept"), { keep: true }, { kept: true });
  await writeFile(join(env.ledgerDir, `${NAME("gui-bad")}.json`), "[]");
  api.sandboxes.set(`aws:${NAME("gui-lost")}`, { name: NAME("gui-lost"), location: "aws", status: "ready" });
  api.sandboxes.set("aws:pi-gui-testing-ffff0000-gui-other", { name: "pi-gui-testing-ffff0000-gui-other", location: "aws", status: "ready" });
  api.sandboxes.set("aws:someone-else", { name: "someone-else", location: "aws", status: "ready" });
  const leftovers = await auditCuaOrphans(options);
  const byId = Object.fromEntries(leftovers.map((l) => [l.id.split("/").at(-1), l.detail]));
  assert.equal(byId[`aws:${NAME("gui-dead")}`], "owner gone");
  assert.match(byId[`aws:${NAME("gui-unknown")}`], /owner unknown/);
  assert.match(byId[`${NAME("gui-bad")}.json`], /unreadable sandbox record/);
  assert.match(byId[`aws:${NAME("gui-lost")}`], /no record in the local ledger/);
  assert.equal(leftovers.length, 4, JSON.stringify(leftovers));
  assert.deepEqual(api.deleted, [], "the audit deletes nothing");
});

test("the sweep deletes dead owners' sandboxes, keeps keepSandbox ones, and leaves everything else", async (t) => {
  const { api, ledger, add, options } = await world(t);
  await add(NAME("gui-dead"));
  await add(NAME("gui-dead-creating"), { phase: "creating" }, { inCloud: false });
  await add(NAME("gui-dead-keep"), { keep: true });
  await add(NAME("gui-live"), { ownerLabel: LIVE_OWNER });
  await add(NAME("gui-unknown"), { ownerLabel: "not-a-label" });
  await add(NAME("gui-kept-expired"), { keep: true }, { kept: true, inCloud: false });
  api.sandboxes.set(`aws:${NAME("gui-lost")}`, { name: NAME("gui-lost"), location: "aws", status: "ready" });
  const result = await sweepCuaOrphans(options);
  assert.deepEqual(result.deleted.sort(), [`aws:${NAME("gui-dead")}`, `aws:${NAME("gui-dead-creating")}`].sort());
  assert.deepEqual(result.kept, [`aws:${NAME("gui-dead-keep")}`]);
  assert.ok(api.sandboxes.has(`aws:${NAME("gui-live")}`));
  assert.ok(api.sandboxes.has(`aws:${NAME("gui-unknown")}`));
  assert.ok(api.sandboxes.has(`aws:${NAME("gui-lost")}`), "unrecorded sandboxes are never deleted");
  assert.ok(api.sandboxes.has(`aws:${NAME("gui-dead-keep")}`));
  const names = (await ledger.entries()).map((e) => `${e.record.name}${e.kept ? " kept" : ""}`).sort();
  assert.deepEqual(names, [`${NAME("gui-dead-keep")} kept`, NAME("gui-live"), NAME("gui-unknown")].sort());
  assert.deepEqual(result.leftovers.map((l) => l.id).sort(), [`aws:${NAME("gui-lost")}`, `aws:${NAME("gui-unknown")}`].sort());
});

test("a failed sweep deletion stays recorded for the next sweep", async (t) => {
  const { api, ledger, add, options } = await world(t);
  await add(NAME("gui-dead"));
  api.options.fail = { delete: "TRANSPORT" };
  const first = await sweepCuaOrphans(options);
  assert.match(first.leftovers[0].detail, /delete failed/);
  assert.equal((await ledger.read(NAME("gui-dead"))).phase, "deleting");
  api.options.fail = {};
  const second = await sweepCuaOrphans(options);
  assert.deepEqual(second.deleted, [`aws:${NAME("gui-dead")}`]);
  assert.deepEqual(await ledger.entries(), []);
});

test("the startup gate needs `cua` on PATH and a dead owner's record; /gui-cleanup only `cua`", async (t) => {
  const { env, api, ledger, add } = await world(t);
  const make = (onPath) => new CuaBackend({ ownerLabel: () => LIVE_OWNER, api, ledger, settings: new CuaSettingsStore(env.settingsPath), hostTag: HOST_TAG, version: "0.1.0", procRoot: env.proc, cuaOnPath: async () => onPath });
  assert.equal(await make(true).sweepAvailable({ startup: true }), false, "empty ledger: no network at startup");
  await add(NAME("gui-live"), { ownerLabel: LIVE_OWNER });
  assert.equal(await make(true).sweepAvailable({ startup: true }), false);
  assert.equal(await hasDeadOwnerRecords(ledger, env.proc), false);
  await add(NAME("gui-dead"));
  assert.equal(await make(true).sweepAvailable({ startup: true }), true);
  assert.equal(await make(false).sweepAvailable({ startup: true }), false);
  assert.equal(await make(true).sweepAvailable({ startup: false }), true);
  assert.equal(await make(false).sweepAvailable({ startup: false }), false);
  assert.deepEqual(api.calls, [], "the gate runs no Cua call");
  assert.equal(make(true).orphanAuditReady([{ id: "cua.auth", status: "pass" }]), true);
  assert.equal(make(true).orphanAuditReady([{ id: "cua.auth", status: "fail" }]), false);
});

test("reset deletes kept sandboxes and the settings; a failed deletion is retried by the sweep", async (t) => {
  const { env, api, ledger, add, options } = await world(t);
  await add(NAME("gui-kept-1"), { keep: true }, { kept: true });
  await add(NAME("gui-kept-2"), { keep: true }, { kept: true });
  let failOnce = true;
  api.options.fail = { delete: (ref) => (ref.endsWith("gui-kept-2") && failOnce ? ((failOnce = false), "TRANSPORT") : undefined) };
  const backend = new CuaBackend({ ownerLabel: () => LIVE_OWNER, api, ledger, settings: new CuaSettingsStore(env.settingsPath), hostTag: HOST_TAG, version: "0.1.0", procRoot: env.proc });
  const reset = await backend.resetData(new AbortController().signal);
  assert.equal(reset.lines[0], "deleted 1 kept sandbox(es)");
  assert.equal(reset.leftovers.length, 1);
  await assert.rejects(stat(env.settingsPath), /ENOENT/);
  const pending = await ledger.read(NAME("gui-kept-2"));
  assert.equal(pending.phase, "deleting");
  assert.equal(pending.keep, false);
  const swept = await sweepCuaOrphans(options);
  assert.deepEqual(swept.deleted, [`aws:${NAME("gui-kept-2")}`]);
  assert.equal(api.sandboxes.size, 0);
  assert.deepEqual(await deleteKeptSandboxes(options), { deleted: [], kept: [], leftovers: [] });
});
