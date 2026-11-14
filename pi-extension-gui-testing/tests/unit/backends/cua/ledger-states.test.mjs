/**
 * AA1/AA2: the cua ledger's state machine. `deleting` is terminal (never
 * kept, claimed, or reused again, wherever its file is), transitions act only
 * on the exact state they read, and a transition killed at any step leaves
 * either the old or the new record current.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SandboxLedger } from "../../../../src/backends/cua/ledger.ts";
import { auditCuaOrphans, deleteKeptSandboxes, hasDeadOwnerRecords, sweepCuaOrphans } from "../../../../src/backends/cua/orphans.ts";
import { cuaEnv, DEAD_OWNER, FakeCuaApi, HOST_TAG, LIVE_OWNER } from "./fake-cua.mjs";

const NAME = `pi-gui-testing-${HOST_TAG}-gui-old`;
const REF = `aws:${NAME}`;
const LEDGER_MODULE = new URL("../../../../src/backends/cua/ledger.ts", import.meta.url).href;

function record(overrides = {}) {
  return { version: 1, name: NAME, ref: REF, location: "aws", ownerLabel: DEAD_OWNER, sessionId: "gui-old", projectKey: "project", phase: "created", keep: true, createdAt: "2026-10-24T00:00:00.000Z", image: "linux", ...overrides };
}

async function world(t) {
  const env = await cuaEnv(t);
  const api = new FakeCuaApi();
  api.sandboxes.set(REF, { name: NAME, location: "aws", status: "ready", image: "linux" });
  const ledger = new SandboxLedger(env.ledgerDir);
  const options = { api, ledger, hostTag: HOST_TAG, signal: new AbortController().signal, procRoot: env.proc };
  return { env, api, ledger, options };
}

const claimLive = (ledger) => ledger.claimKept("aws", "project", { ownerLabel: LIVE_OWNER, sessionId: "gui-live" }, { image: "linux" });

/** Every record as `[kept|active, phase, sessionId]`; problem files as `[problem]`. */
async function states(ledger) {
  return (await ledger.entries()).map((e) => (e.record ? [e.kept ? "kept" : "active", e.record.phase, e.record.sessionId] : [e.problem]));
}

test("AA1: a delayed stale keep cannot move a record a reset is deleting, so no live session reuses it (reviewer reproduction)", async (t) => {
  const { api, ledger, options } = await world(t);
  await ledger.write(record());
  let enterKeep, resumeKeep, enterDelete, resumeDelete;
  const keepEntered = new Promise((r) => (enterKeep = r));
  const keepGate = new Promise((r) => (resumeKeep = r));
  const deleteEntered = new Promise((r) => (enterDelete = r));
  const deleteGate = new Promise((r) => (resumeDelete = r));
  // Sweep A judged the old owner dead and is delayed before its keep takes the lock.
  class SlowLedger extends SandboxLedger {
    async markKept(name, expect) {
      enterKeep();
      await keepGate;
      return super.markKept(name, expect);
    }
  }
  const realDelete = api.deleteSandbox.bind(api);
  api.deleteSandbox = async (ref) => {
    enterDelete();
    await deleteGate;
    return realDelete(ref);
  };
  const staleSweep = sweepCuaOrphans({ ...options, ledger: new SlowLedger(ledger.dir) });
  await keepEntered;
  // Sweep B keeps it; /gui-reset claims it for deletion, and the deletion is in flight.
  assert.equal(await ledger.markKept(NAME, "gui-old"), true);
  const reset = deleteKeptSandboxes(options);
  await deleteEntered;
  assert.deepEqual(await states(ledger), [["active", "deleting", "gui-old"]]);
  resumeKeep();
  const stale = await staleSweep;
  assert.deepEqual(stale.kept, [], "the stale keep moved nothing");
  assert.deepEqual(await states(ledger), [["active", "deleting", "gui-old"]], "the record is still pending deletion");
  assert.equal(await claimLive(ledger), undefined, "a live session never claims a sandbox being deleted");
  resumeDelete();
  const done = await reset;
  assert.deepEqual(done.deleted, [REF]);
  assert.deepEqual(done.leftovers, []);
  assert.deepEqual(await states(ledger), [], "the deleted sandbox's record is gone, and no live session's record existed");
});

test("AA1: deleting is terminal and transitions compare the full state they read (phase and generation, not only the owner)", async (t) => {
  const { ledger } = await world(t);
  await ledger.write(record({ keep: false }));
  const read = await ledger.read(NAME);
  const asRead = { sessionId: read.sessionId, ownerLabel: read.ownerLabel, phase: read.phase, generation: read.generation ?? 0 };
  // Same owner, but another phase and generation since: refused.
  assert.equal((await ledger.update(NAME, { phase: "deleting" }, { sessionId: "gui-old" }))?.phase, "deleting");
  assert.equal(await ledger.markKept(NAME, asRead), false, "a stale read keeps nothing");
  assert.equal(await ledger.markKept(NAME, "gui-old"), false, "the owner itself cannot keep a record pending deletion");
  assert.equal(await ledger.update(NAME, { phase: "created" }, { sessionId: "gui-old" }), undefined, "never back to created");
  assert.equal(await ledger.update(NAME, { keep: true }, { sessionId: "gui-old" }), undefined, "never kept again");
  assert.equal((await ledger.update(NAME, { phase: "deleting" }, { sessionId: "gui-old" }))?.phase, "deleting", "a deletion retry is fine");
  assert.equal(await ledger.remove(NAME, false, asRead), false, "a removal from a stale read removes nothing");
  await assert.rejects(ledger.write(record()), /pending deletion/, "a record pending deletion is not replaced");
  assert.deepEqual(await states(ledger), [["active", "deleting", "gui-old"]]);
  assert.equal(await claimLive(ledger), undefined);
  const now = await ledger.read(NAME);
  assert.equal(await ledger.remove(NAME, false, { sessionId: now.sessionId, phase: "deleting", generation: now.generation }), true, "delete completion");
  assert.deepEqual(await states(ledger), []);
});

test("AA2: a kept record marked deleting (crash residue of an interrupted claim) is pending deletion: gate, audit, sweep, and claim (reviewer reproduction)", async (t) => {
  const { api, ledger, options, env } = await world(t);
  // What a crash between rewriting the kept record and moving it leaves (and what an older version left).
  const residue = record({ phase: "deleting", keep: false });
  await ledger.write(record());
  await ledger.markKept(NAME, "gui-old");
  await writeFile(join(ledger.dir, `${NAME}.kept.json`), JSON.stringify(residue), { mode: 0o600 });
  assert.equal(await hasDeadOwnerRecords(ledger, env.proc), true, "the startup gate schedules the sweep");
  const audit = await auditCuaOrphans(options);
  assert.deepEqual(audit.map((l) => l.id), [REF]);
  assert.match(audit[0].detail, /pending deletion/);
  assert.equal(await claimLive(ledger), undefined, "never reused");
  const swept = await sweepCuaOrphans(options);
  assert.deepEqual(swept.deleted, [REF], "the sweep deletes it");
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await states(ledger), []);
  assert.equal(await hasDeadOwnerRecords(ledger, env.proc), false);
});

test("AA2: a record pending deletion with a running owner is reported by the sweep, deleted by /gui-reset cua, and never claimed", async (t) => {
  const { api, ledger, options, env } = await world(t);
  await ledger.write(record({ ownerLabel: LIVE_OWNER }));
  await ledger.markKept(NAME, "gui-old");
  await writeFile(join(ledger.dir, `${NAME}.kept.json`), JSON.stringify(record({ ownerLabel: LIVE_OWNER, phase: "deleting", keep: false })), { mode: 0o600 });
  assert.equal(await hasDeadOwnerRecords(ledger, env.proc), false, "its owner runs: no startup sweep for it");
  assert.equal(await claimLive(ledger), undefined);
  const swept = await sweepCuaOrphans(options);
  assert.deepEqual(swept.deleted, []);
  assert.deepEqual(swept.leftovers.map((l) => [l.id, /pending deletion; its owner process still runs/.test(l.detail)]), [[REF, true]]);
  const reset = await deleteKeptSandboxes(options);
  assert.deepEqual(reset.deleted, [REF]);
  assert.deepEqual(api.deleted, [REF]);
  assert.deepEqual(await states(ledger), []);
});

/**
 * Runs `action` (source of an async function body taking `ledger`) in a child
 * process that is killed just before its `crashAt`-th file mutation in the
 * ledger dir (lock files aside). Resolves `"crashed"` or `"done"`.
 */
async function runUntilCrash(t, dir, action, crashAt) {
  const code = `import fs from "node:fs/promises"; import { basename } from "node:path"; import { syncBuiltinESMExports } from "node:module";
const dir = ${JSON.stringify(dir)}; let n = 0;
for (const fn of ["rename", "rm", "unlink"]) {
  const original = fs[fn];
  fs[fn] = async (...args) => {
    const target = String(fn === "rename" ? args[1] : args[0]);
    if (target.startsWith(dir + "/") && !basename(target).startsWith(".lock") && ++n === ${crashAt}) {
      process.stdout.write("crash\\n");
      await new Promise(() => setInterval(() => {}, 1000));
    }
    return original(...args);
  };
}
syncBuiltinESMExports();
const { SandboxLedger } = await import(${JSON.stringify(LEDGER_MODULE)});
const ledger = new SandboxLedger(dir);
await (async (ledger) => { ${action} })(ledger);
process.stdout.write("done\\n");`;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => child.kill("SIGKILL"));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let out = "";
  const outcome = await new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (out.includes("crash")) resolve("crashed");
      else if (out.includes("done")) resolve("done");
    });
    child.once("exit", (status) => (out.includes("done") ? resolve("done") : reject(new Error(`worker exited ${status} before a crash point: ${out}`))));
  });
  child.kill("SIGKILL");
  await exited;
  return outcome;
}

const TRANSITIONS = [
  { name: "claimForDeletion", kept: true, action: `await ledger.claimForDeletion(${JSON.stringify(NAME)});`, post: ["active", "deleting", "gui-old"] },
  { name: "claimKept", kept: true, action: `await ledger.claimKept("aws", "project", { ownerLabel: ${JSON.stringify(DEAD_OWNER)}, sessionId: "gui-new" }, { image: "linux" });`, post: ["active", "created", "gui-new"] },
  { name: "markKept", kept: false, action: `await ledger.markKept(${JSON.stringify(NAME)}, "gui-old");`, post: ["kept", "created", "gui-old"] },
  { name: "update to deleting", kept: false, keep: false, action: `await ledger.update(${JSON.stringify(NAME)}, { phase: "deleting" }, { sessionId: "gui-old" });`, post: ["active", "deleting", "gui-old"] },
];

test("AA2: a transition killed at any step leaves the old or the new record current; a deleting one is swept, never claimed", async (t) => {
  for (const transition of TRANSITIONS) {
    const pre = [transition.kept ? "kept" : "active", "created", "gui-old"];
    let crashes = 0;
    for (let crashAt = 1; crashAt < 10; crashAt++) {
      const { api, ledger, options, env } = await world(t);
      await ledger.write(record({ keep: transition.keep ?? true }));
      if (transition.kept) await ledger.markKept(NAME, "gui-old");
      const outcome = await runUntilCrash(t, ledger.dir, transition.action, crashAt);
      const label = `${transition.name}, killed before mutation ${crashAt}`;
      const now = await states(ledger);
      assert.equal(now.length, 1, `${label}: one current record, no problem file: ${JSON.stringify(now)}`);
      if (outcome === "done") {
        assert.deepEqual(now[0], transition.post, label);
        break;
      }
      crashes++;
      assert.ok([JSON.stringify(pre), JSON.stringify(transition.post)].includes(JSON.stringify(now[0])), `${label}: the old or the new state, got ${JSON.stringify(now[0])}`);
      assert.deepEqual((await ledger.read(NAME, now[0][0] === "kept")).sessionId, now[0][2], `${label}: read agrees with entries`);
      if (now[0][1] === "deleting") {
        assert.equal(await claimLive(ledger), undefined, `${label}: never claimed`);
        assert.equal(await hasDeadOwnerRecords(ledger, env.proc), true, `${label}: the startup gate schedules the sweep`);
        assert.deepEqual((await sweepCuaOrphans(options)).deleted, [REF], `${label}: the sweep deletes it`);
        assert.deepEqual(await states(ledger), [], `${label}: no copy is left`);
      } else if (JSON.stringify(now[0]) === JSON.stringify(pre)) {
        // The dead worker's lock is recovered, and the transition runs again from the old state.
        assert.equal(await runUntilCrash(t, ledger.dir, transition.action, 0), "done", label);
        assert.deepEqual(await states(ledger), [transition.post], `${label}: retried`);
      } else if (now[0][0] === "kept") {
        assert.equal((await claimLive(ledger))?.sessionId, "gui-live", `${label}: a completed keep is claimable`);
      }
      assert.equal(api.deleted.filter((r) => r !== REF).length, 0);
    }
    t.diagnostic(`${transition.name}: ${crashes} crash point(s)`);
    // Moves between the sets commit, then remove the old copy: two crash points; an in-place update has one.
    assert.equal(crashes, transition.post[0] === pre[0] ? 1 : 2, `${transition.name}: every crash point was exercised`);
  }
});

test("BB2: a removal killed between its unlinks never resurrects the stale copy: the stale copy goes first, the current record last (reviewer reproduction)", async (t) => {
  const action = `const now = await ledger.read(${JSON.stringify(NAME)});
await ledger.remove(${JSON.stringify(NAME)}, false, { sessionId: now.sessionId, phase: now.phase, generation: now.generation });`;
  let crashes = 0;
  for (let crashAt = 1; crashAt < 10; crashAt++) {
    const { ledger } = await world(t);
    // What a claim for deletion interrupted after its commit leaves: the current deleting record and an older kept copy.
    await mkdir(ledger.dir, { recursive: true, mode: 0o700 });
    await writeFile(join(ledger.dir, `${NAME}.kept.json`), JSON.stringify(record({ generation: 2, keptAt: "2026-10-24T01:00:00.000Z" })), { mode: 0o600 });
    await writeFile(join(ledger.dir, `${NAME}.json`), JSON.stringify(record({ phase: "deleting", keep: false, generation: 3 })), { mode: 0o600 });
    assert.deepEqual(await states(ledger), [["active", "deleting", "gui-old"]]);
    const outcome = await runUntilCrash(t, ledger.dir, action, crashAt);
    const label = `remove, killed before mutation ${crashAt}`;
    const now = await states(ledger);
    assert.equal(await claimLive(ledger), undefined, `${label}: nothing claimable is left`);
    if (outcome === "done") {
      assert.deepEqual(now, [], label);
      break;
    }
    crashes++;
    assert.deepEqual(now, [["active", "deleting", "gui-old"]], `${label}: the record is still pending deletion, never the stale kept copy`);
  }
  assert.equal(crashes, 2, "both unlinks were crash points");
});
