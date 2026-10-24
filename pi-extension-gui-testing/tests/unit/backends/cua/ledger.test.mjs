/**
 * W8: moving a sandbox record between the active and kept sets never erases
 * a record another process wrote (keep vs claim race), and the ledger is private.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxLedger } from "../../../../src/backends/cua/ledger.ts";

const NAME = "pi-gui-testing-demo";

function record(overrides = {}) {
  return { version: 1, name: NAME, ref: `aws:${NAME}`, location: "aws", ownerLabel: "old-owner", sessionId: "gui-old", projectKey: "project", phase: "created", keep: true, createdAt: new Date().toISOString(), ...overrides };
}

async function ledgerDir(t) {
  const root = await mkdtemp(join(tmpdir(), "gui-ledger-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, "ledger");
}

/** Every record of NAME as `[file, ownerLabel]`. */
async function recordsOf(ledger) {
  return (await ledger.entries()).filter((e) => e.record?.name === NAME).map((e) => [e.kept ? "kept" : "active", e.record.ownerLabel]);
}

test("W8: a claim made while markKept runs survives: the new owner's record is never removed", async (t) => {
  const dir = await ledgerDir(t);
  const other = new SandboxLedger(dir);
  let claimed;
  // Another client claims at every step of markKept (reviewer reproduction: right after the kept record appears).
  class RaceLedger extends SandboxLedger {
    async write(r) {
      await super.write(r);
      if (r.keptAt) claimed ??= await other.claimKept("aws", "project", { ownerLabel: "new-live-owner", sessionId: "gui-new" });
    }
    async remove(name, kept = false) {
      claimed ??= await other.claimKept("aws", "project", { ownerLabel: "new-live-owner", sessionId: "gui-new" });
      return super.remove(name, kept);
    }
  }
  const ledger = new RaceLedger(dir);
  await ledger.write(record());
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(dir, `${NAME}.json`))).mode & 0o777, 0o600);
  await ledger.markKept(NAME);
  claimed ??= await other.claimKept("aws", "project", { ownerLabel: "new-live-owner", sessionId: "gui-new" });
  assert.equal(claimed?.ownerLabel, "new-live-owner");
  assert.deepEqual(await recordsOf(other), [["active", "new-live-owner"]], "exactly one record, the new owner's");
  assert.equal((await other.read(NAME)).sessionId, "gui-new");
  assert.equal((await stat(join(dir, `${NAME}.json`))).mode & 0o777, 0o600);
});

test("W8: concurrent markKept and claimKept always leave exactly one consistent record", async (t) => {
  const dir = await ledgerDir(t);
  const a = new SandboxLedger(dir);
  const b = new SandboxLedger(dir);
  for (let i = 0; i < 40; i++) {
    await a.write(record({ sessionId: `gui-old${i}` }));
    const [, claim] = await Promise.all([a.markKept(NAME), new Promise((r) => setTimeout(r, i % 3)).then(() => b.claimKept("aws", "project", { ownerLabel: "new-live-owner", sessionId: `gui-new${i}` }))]);
    const records = await recordsOf(a);
    assert.equal(records.length, 1, `round ${i}: ${JSON.stringify(records)}`);
    assert.deepEqual(records[0], claim ? ["active", "new-live-owner"] : ["kept", "old-owner"], `round ${i}`);
    for (const f of await readdir(dir)) await rm(join(dir, f), { force: true });
  }
});

test("W8: markKept with a session id moves only that session's record", async (t) => {
  const ledger = new SandboxLedger(await ledgerDir(t));
  await ledger.write(record({ sessionId: "gui-new", ownerLabel: "new-live-owner" }));
  await ledger.markKept(NAME, "gui-old");
  assert.deepEqual(await recordsOf(ledger), [["active", "new-live-owner"]]);
  await ledger.markKept(NAME, "gui-new");
  const kept = await ledger.read(NAME, true);
  assert.equal(kept.sessionId, "gui-new");
  assert.ok(kept.keptAt);
  await ledger.markKept(NAME); // Nothing active any more: a no-op.
  assert.deepEqual(await recordsOf(ledger), [["kept", "new-live-owner"]]);
});
