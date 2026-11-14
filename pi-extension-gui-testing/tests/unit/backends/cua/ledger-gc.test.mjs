/**
 * BB1: removing the stale copy a two-file ledger transition replaced is
 * garbage collection after the commit. A failure there (one injected EIO on
 * that unlink) never fails the committed transition: it returns its result,
 * readers ignore the stale copy by generation, the audit reports it, and the
 * sandbox's next transition removes it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { expectedState, SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { auditCuaOrphans, STALE_COPY } from "../../../../src/backends/cua/orphans.ts";
import { cuaEnv, FakeCuaApi, HOST_TAG, LIVE_OWNER, withFsFailureOnce } from "./fake-cua.mjs";

const NAME = `pi-gui-testing-${HOST_TAG}-gui-old`;
const REF = `aws:${NAME}`;

function record(overrides = {}) {
  return { version: 1, name: NAME, ref: REF, location: "aws", ownerLabel: LIVE_OWNER, sessionId: "gui-old", projectKey: "project", phase: "created", keep: true, createdAt: "2026-10-24T00:00:00.000Z", image: "linux", ...overrides };
}

const states = async (ledger) => (await ledger.entries()).map((e) => (e.record ? [e.kept ? "kept" : "active", e.record.phase, e.record.sessionId] : [e.problem]));

const TRANSITIONS = [
  {
    name: "markKept (active to kept)",
    from: "active",
    run: (ledger) => ledger.markKept(NAME, "gui-old"),
    committed: (value) => assert.equal(value, true),
    post: ["kept", "created", "gui-old"],
    // The next transition: a new session claims it.
    next: async (ledger) => assert.equal((await ledger.claimKept("aws", "project", { ownerLabel: LIVE_OWNER, sessionId: "gui-new" }, { image: "linux" }))?.sessionId, "gui-new"),
    after: [["active", "created", "gui-new"]],
  },
  {
    name: "claimKept (kept to active)",
    from: "kept",
    run: (ledger) => ledger.claimKept("aws", "project", { ownerLabel: LIVE_OWNER, sessionId: "gui-new" }, { image: "linux" }),
    committed: (value) => assert.equal(value?.sessionId, "gui-new"),
    post: ["active", "created", "gui-new"],
    next: async (ledger) => assert.equal(await ledger.markKept(NAME, "gui-new"), true),
    after: [["kept", "created", "gui-new"]],
  },
  {
    name: "claimForDeletion (kept to active, deleting)",
    from: "kept",
    run: (ledger) => ledger.claimForDeletion(NAME),
    committed: (value) => assert.equal(value?.phase, "deleting"),
    post: ["active", "deleting", "gui-old"],
    next: async (ledger) => assert.equal(await ledger.remove(NAME, false, expectedState(await ledger.read(NAME))), true),
    after: [],
  },
];

test("BB1: a two-file transition whose stale-copy unlink fails after the commit returns its committed result; the stale copy is ignored, audited, and removed by the next transition", async (t) => {
  for (const transition of TRANSITIONS) {
    const env = await cuaEnv(t);
    const api = new FakeCuaApi();
    api.sandboxes.set(REF, { name: NAME, location: "aws", status: "ready", image: "linux" });
    const ledger = new SandboxLedger(env.ledgerDir);
    await ledger.write(record());
    if (transition.from === "kept") await ledger.markKept(NAME, "gui-old");
    const stale = join(ledger.dir, `${NAME}${transition.from === "kept" ? ".kept.json" : ".json"}`);
    const label = transition.name;

    const { value, injected } = await withFsFailureOnce("rm", (path) => path === stale, () => transition.run(ledger));
    assert.equal(injected, true, `${label}: the stale-copy unlink was attempted and failed`);
    transition.committed(value);
    assert.deepEqual(await states(ledger), [transition.post], `${label}: one current record, the committed one`);
    assert.equal((await ledger.read(NAME, transition.post[0] === "kept"))?.sessionId, transition.post[2], `${label}: read agrees`);
    assert.equal(await ledger.read(NAME, transition.from === "kept"), undefined, `${label}: the stale copy is not read as current`);
    assert.deepEqual(await ledger.staleCopies(), [stale], `${label}: the stale copy is listed`);
    const audit = await auditCuaOrphans({ api, ledger, hostTag: HOST_TAG, signal: new AbortController().signal, procRoot: env.proc });
    assert.deepEqual(
      audit.filter((l) => l.kind === "ledger").map((l) => [l.id, l.detail]),
      [[stale, STALE_COPY]],
      `${label}: the audit reports the stale copy`,
    );

    await transition.next(ledger);
    assert.deepEqual(await ledger.staleCopies(), [], `${label}: the next transition removed the stale copy`);
    assert.deepEqual(await states(ledger), transition.after, `${label}: next transition`);
  }
});
