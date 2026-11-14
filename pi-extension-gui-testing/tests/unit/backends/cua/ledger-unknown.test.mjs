/**
 * CC1: a sandbox record with a copy that exists but cannot be read or
 * validated is unknown and fails closed. Its other (readable, possibly stale)
 * copy is never used: nothing claims, keeps, replaces, or removes the record,
 * the audit and sweep report it, and `/gui-reset cua` leaves it with the
 * manual remedy.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SandboxLedger, UnreadableRecordError } from "../../../../src/backends/cua/ledger.ts";
import { auditCuaOrphans, deleteKeptSandboxes, sweepCuaOrphans } from "../../../../src/backends/cua/orphans.ts";
import { cuaEnv, FakeCuaApi, HOST_TAG, LIVE_OWNER, withFsFailureOnce } from "./fake-cua.mjs";

const NAME = `pi-gui-testing-${HOST_TAG}-gui-old`;
const REF = `aws:${NAME}`;

function record(overrides = {}) {
  return { version: 1, name: NAME, ref: REF, location: "aws", ownerLabel: LIVE_OWNER, sessionId: "gui-old", projectKey: "project", phase: "created", keep: true, createdAt: "2026-10-24T00:00:00.000Z", image: "linux", ...overrides };
}

const claim = (ledger, sessionId) => ledger.claimKept("aws", "project", { ownerLabel: LIVE_OWNER, sessionId }, { image: "linux" });

async function snapshot(dir) {
  const files = (await readdir(dir)).filter((f) => !f.startsWith(".lock")).sort();
  return Promise.all(files.map(async (f) => [f, await readFile(join(dir, f), "utf8").catch((e) => e.code)]));
}

/**
 * The reviewer's state: session A claimed the kept sandbox (active copy,
 * generation 3) but the stale kept copy (generation 2) could not be removed.
 */
async function claimedWithStaleKeptCopy(t) {
  const env = await cuaEnv(t);
  const ledger = new SandboxLedger(env.ledgerDir, { lock: { timeoutMs: 500 } });
  await ledger.write(record());
  assert.equal(await ledger.markKept(NAME, "gui-old"), true);
  const { value: a, injected } = await withFsFailureOnce("rm", (p) => p === join(env.ledgerDir, `${NAME}.kept.json`), () => claim(ledger, "session-a"));
  assert.equal(injected, true);
  assert.equal(a.sessionId, "session-a");
  assert.equal(a.generation, 3);
  assert.equal((await ledger.staleCopies()).length, 1);
  return { env, ledger, a };
}

const CORRUPTIONS = [
  { name: "invalid JSON", apply: (file) => writeFile(file, "{ not json") },
  { name: "a record that fails validation", apply: (file) => writeFile(file, JSON.stringify(record({ sessionId: "session-a", phase: "bogus", generation: 3 }))) },
  { name: "a record of another sandbox", apply: (file) => writeFile(file, JSON.stringify(record({ name: `${NAME}x`, ref: `aws:${NAME}x`, generation: 3 }))) },
  // Root reads a file whatever its mode.
  ...(process.getuid?.() === 0 ? [] : [{ name: "a file that cannot be read (EACCES)", apply: (file) => chmod(file, 0) }]),
];

for (const corruption of CORRUPTIONS) {
  test(`CC1: a current copy holding ${corruption.name} makes the record unknown; the stale kept copy is never claimed or acted on (reviewer reproduction)`, async (t) => {
    const { env, ledger } = await claimedWithStaleKeptCopy(t);
    const active = join(env.ledgerDir, `${NAME}.json`);
    await corruption.apply(active);
    t.after(() => chmod(active, 0o600).catch(() => {}));
    const before = await snapshot(env.ledgerDir);

    // Every copy is a problem entry, none a record.
    const entries = await ledger.entries();
    assert.deepEqual(
      entries.map((e) => [e.kept, e.name, e.record === undefined, typeof e.problem]),
      [
        [false, NAME, true, "string"],
        [true, NAME, true, "string"],
      ],
    );
    assert.match(entries[1].problem, /other copy cannot be read/);
    assert.deepEqual(await ledger.staleCopies(), []);

    // A second live session cannot claim the sandbox A uses.
    assert.equal(await claim(ledger, "session-b"), undefined, "the stale kept copy is not claimable");
    assert.equal(await ledger.read(NAME), undefined);
    assert.equal(await ledger.read(NAME, true), undefined);
    // No transition changes it.
    await assert.rejects(ledger.write(record({ sessionId: "session-b" })), UnreadableRecordError);
    await assert.rejects(ledger.update(NAME, { phase: "deleting" }), UnreadableRecordError);
    await assert.rejects(ledger.markKept(NAME, "session-a"), UnreadableRecordError);
    await assert.rejects(ledger.remove(NAME), UnreadableRecordError);
    await assert.rejects(ledger.remove(NAME, true), UnreadableRecordError);
    assert.equal(await ledger.claimForDeletion(NAME), undefined);
    assert.deepEqual(await snapshot(env.ledgerDir), before, "both files are unchanged");

    // The audit, sweep, and reset report both files with the manual remedy and leave the sandbox alone.
    const api = new FakeCuaApi();
    api.sandboxes.set(REF, { name: NAME, location: "aws", status: "ready", image: "linux" });
    const options = { api, ledger, hostTag: HOST_TAG, signal: new AbortController().signal, procRoot: env.proc };
    const remedy = (leftovers) => {
      const rows = leftovers.filter((l) => l.kind === "ledger");
      assert.deepEqual(rows.map((l) => l.id).sort(), [active, join(env.ledgerDir, `${NAME}.kept.json`)]);
      for (const row of rows) {
        assert.match(row.detail, /^unreadable sandbox record/);
        assert.match(row.detail, new RegExp(`cua sandbox rm <location>:${NAME} --force`));
      }
      assert.equal(leftovers.filter((l) => l.kind === "sandbox").length, 0, "not reported as an unrecorded sandbox");
    };
    remedy(await auditCuaOrphans(options));
    const swept = await sweepCuaOrphans(options);
    remedy(swept.leftovers);
    assert.deepEqual([swept.deleted, swept.kept], [[], []]);
    const reset = await deleteKeptSandboxes(options);
    remedy(reset.leftovers);
    assert.deepEqual(reset.deleted, []);
    assert.equal(api.sandboxes.size, 1, "the sandbox is never deleted");
    assert.equal(api.calls.filter((c) => c.method === "deleteSandbox").length, 0);
    assert.deepEqual(await snapshot(env.ledgerDir), before, "both files are still unchanged");

    // Once the user repairs the file, the record is known again and A's claim (generation 3) is current.
    await chmod(active, 0o600);
    await writeFile(active, JSON.stringify(record({ sessionId: "session-a", phase: "created", generation: 3 })));
    assert.equal((await ledger.read(NAME)).sessionId, "session-a");
    assert.equal(await claim(ledger, "session-b"), undefined);
  });
}

test("CC1: an unreadable kept copy alone is unknown too: it is reported, never claimed or reset", async (t) => {
  const env = await cuaEnv(t);
  const ledger = new SandboxLedger(env.ledgerDir, { lock: { timeoutMs: 500 } });
  await ledger.write(record());
  await ledger.markKept(NAME, "gui-old");
  await writeFile(join(env.ledgerDir, `${NAME}.kept.json`), "\0garbage");
  assert.equal(await claim(ledger, "session-b"), undefined);
  assert.equal(await ledger.claimForDeletion(NAME), undefined);
  const api = new FakeCuaApi();
  api.sandboxes.set(REF, { name: NAME, location: "aws", status: "ready", image: "linux" });
  const reset = await deleteKeptSandboxes({ api, ledger, hostTag: HOST_TAG, signal: new AbortController().signal });
  assert.equal(reset.leftovers.length, 1);
  assert.match(reset.leftovers[0].detail, /unreadable sandbox record .*cua sandbox rm/);
  assert.equal(api.sandboxes.size, 1);
});
