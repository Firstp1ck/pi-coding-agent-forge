import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionShelfState, SESSION_SHELF_STORAGE_KEY } from "../public/session-shelf-state.mjs";

const defaults = { inbox: true, working: true, settled: false };
const success = { ok: true, reason: null };

function session(id, fields = {}) {
  return { id, identity: `created:${id}:session-file`, state: "idle", completionSerial: 0, ...fields };
}

function fakeStorage(initial = []) {
  const records = new Map(initial);
  const calls = [];
  return {
    records,
    calls,
    getItem(key) { calls.push(["get", key]); return records.get(key) ?? null; },
    setItem(key, value) { calls.push(["set", key, value]); records.set(key, value); },
    removeItem() { assert.fail("shelf state must never erase storage keys"); },
    clear() { assert.fail("shelf state must never clear storage"); },
  };
}

function storedRecord(settled = [], expanded = defaults) {
  return { v: 1, settled, expanded: { ...expanded } };
}

function mark({ id, identity, completionSerial }) {
  return { id, identity, completionSerial };
}

function writeCount(storage) {
  return storage.calls.filter(([operation]) => operation === "set").length;
}

test("empty state uses default expansion without acquiring global storage or writing defaults", () => {
  const storage = fakeStorage();
  const owner = createSessionShelfState({ storage });
  assert.equal(SESSION_SHELF_STORAGE_KEY, "pi-webui-session-shelves-v1");
  assert.deepEqual(owner.snapshot(), { ...storedRecord(), persistence: success });
  assert.deepEqual(owner.reconcile([]), { inbox: [], working: [], settled: [], expanded: defaults });
  assert.deepEqual(storage.calls, [["get", SESSION_SHELF_STORAGE_KEY]]);
  assert.deepEqual(createSessionShelfState().snapshot().persistence, { ok: false, reason: "unavailable" });
});

test("partitioning preserves original objects, per-shelf input order and every field", () => {
  const owner = createSessionShelfState({ storage: fakeStorage() });
  const records = [
    session("idle", { draft: { text: "retain this draft", attachments: ["image"] }, group: "mixed" }),
    session("work-a", { state: "working", run: { active: true } }),
    session("settled-a", { state: "done", completionSerial: 7, unseen: true }),
    session("input", { state: "input", pending: [{ request: "approval" }] }),
    session("settled-b"),
    session("done", { state: "done", completionSerial: 2 }),
    session("work-b", { state: "working" }),
  ];
  const original = JSON.stringify(records);
  for (const record of records) Object.freeze(record);
  Object.freeze(records);
  owner.settle(records[4]);
  owner.settle(records[2]);
  const result = owner.reconcile(records);
  for (const [section, indices] of Object.entries({ inbox: [0, 3, 5], working: [1, 6], settled: [2, 4] })) {
    assert.equal(result[section].length, indices.length);
    indices.forEach((inputIndex, index) => assert.equal(result[section][index], records[inputIndex]));
  }
  assert.equal(new Set([...result.inbox, ...result.working, ...result.settled]).size, records.length);
  assert.equal(JSON.stringify(records), original);
  assert.equal(result.settled[0].unseen, true, "organization does not consume completion attention");
});

test("settlement and expansion survive reload without persisting conversation or layout data", () => {
  const unrelated = [["pi-webui-ui-layout-v3", "workspace"], ["pi-webui-shell-preferences-v1", "preferences"]];
  const storage = fakeStorage(unrelated);
  const owner = createSessionShelfState({ storage });
  const record = session("a", { completionSerial: 3, draft: "private text", messages: ["private message"], groupId: "g" });
  assert.deepEqual(owner.settle(record), success);
  assert.deepEqual(owner.setExpanded("inbox", false), success);
  assert.deepEqual(owner.setExpanded("working", false), success);
  assert.deepEqual(owner.setExpanded("settled", true), success);
  const expanded = { inbox: false, working: false, settled: true };
  assert.deepEqual(JSON.parse(storage.records.get(SESSION_SHELF_STORAGE_KEY)), storedRecord([mark(record)], expanded));
  for (const [key, value] of unrelated) assert.equal(storage.records.get(key), value);
  const writes = writeCount(storage);
  const reloaded = createSessionShelfState({ storage });
  assert.deepEqual(reloaded.reconcile([]), { inbox: [], working: [], settled: [], expanded });
  assert.equal(reloaded.snapshot().settled.length, 1, "an empty initialization retains missing marks");
  const current = { ...record, draft: "new browser draft" };
  assert.equal(reloaded.reconcile([current]).settled[0], current);
  assert.equal(writeCount(storage), writes);
  assert.deepEqual(reloaded.restore("a"), success);
  assert.equal(reloaded.reconcile([current]).inbox[0], current);
  assert.deepEqual(createSessionShelfState({ storage }).snapshot().settled, []);
});

for (const nextState of ["working", "input"]) {
  test(`new ${nextState} permanently wakes settlement and does not consume unrelated data`, () => {
    const storage = fakeStorage();
    const owner = createSessionShelfState({ storage });
    const record = session("a", { state: "done", completionSerial: 8, unseen: true });
    owner.settle(record);
    const active = Object.freeze({ ...record, state: nextState });
    const result = owner.reconcile([active]);
    assert.equal(result[nextState === "working" ? "working" : "inbox"][0], active);
    assert.deepEqual(result.settled, []);
    assert.deepEqual(owner.snapshot().settled, []);
    assert.equal(active.unseen, true);
    const idle = { ...active, state: "idle" };
    assert.equal(owner.reconcile([idle]).inbox[0], idle, "a later idle update cannot resurrect settlement");
    assert.deepEqual(createSessionShelfState({ storage }).snapshot().settled, []);
    assert.equal(writeCount(storage), 2, "wake is persisted once");
  });
}

test("a newer offline completion wakes on first reconciliation after reload", () => {
  const storage = fakeStorage();
  const record = session("a", { state: "done", completionSerial: 11, unseen: true });
  createSessionShelfState({ storage }).settle(record);
  const owner = createSessionShelfState({ storage });
  for (const completionSerial of [11, 10, 0]) {
    assert.equal(owner.reconcile([{ ...record, completionSerial }]).settled.length, 1);
    assert.equal(owner.snapshot().settled[0].completionSerial, 11, "older metadata never lowers the settlement baseline");
  }
  const completedOffline = Object.freeze({ ...record, completionSerial: 12 });
  assert.equal(owner.reconcile([completedOffline]).inbox[0], completedOffline);
  assert.deepEqual(owner.snapshot().settled, []);
  assert.equal(completedOffline.unseen, true);
  assert.equal(writeCount(storage), 2);
});

test("durable identity replacement wakes a reused ID even when completion serial resets", () => {
  const storage = fakeStorage();
  const record = session("a", { completionSerial: 30 });
  createSessionShelfState({ storage }).settle(record);
  const owner = createSessionShelfState({ storage });
  const replacement = session("a", { identity: "new-creation:new-session-file", completionSerial: 0 });
  assert.equal(owner.reconcile([replacement]).inbox[0], replacement);
  assert.deepEqual(owner.snapshot().settled, []);
  assert.equal(owner.reconcile([record]).inbox[0], record);
  assert.equal(writeCount(storage), 2);
});

test("missing marks survive partial catalogs and are pruned only by an explicit complete catalog", () => {
  const storage = fakeStorage();
  const owner = createSessionShelfState({ storage });
  const a = session("a");
  const b = session("b");
  owner.settle(a);
  owner.settle(b);
  owner.reconcile([]);
  owner.reconcile([a]);
  owner.reconcile([a], { pruneMissing: "true" });
  assert.deepEqual(owner.snapshot().settled, [mark(a), mark(b)]);
  assert.equal(writeCount(storage), 2);
  owner.reconcile([a], { pruneMissing: true });
  assert.deepEqual(owner.snapshot().settled, [mark(a)]);
  owner.reconcile([], { pruneMissing: true });
  assert.deepEqual(owner.snapshot().settled, []);
  assert.equal(writeCount(storage), 4);
});

test("active or invalid settlement is rejected without modifying records or storage", () => {
  const storage = fakeStorage();
  const owner = createSessionShelfState({ storage });
  for (const state of ["working", "input"]) {
    assert.deepEqual(owner.settle(session("active", { state })), { ok: false, reason: state });
  }
  const invalid = [undefined, null, [], false, "a", {},
    ...["", 1, null, undefined, "a".repeat(513)].map((id) => session(id)),
    ...["", 1, null, undefined, "a".repeat(4097)].map((identity) => session("a", { identity })),
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "0", null, undefined]
      .map((completionSerial) => session("a", { completionSerial })),
    ...["stopped", "unknown", "", null, undefined].map((state) => session("a", { state })),
    { get id() { throw new Error("unreadable"); } },
  ];
  for (const value of invalid) assert.deepEqual(owner.settle(value), { ok: false, reason: "invalid-record" });
  assert.deepEqual(owner.snapshot().settled, []);
  assert.equal(writeCount(storage), 0);
});

test("mark and string limits reject excess explicitly while preserving all existing marks", () => {
  const storage = fakeStorage();
  const owner = createSessionShelfState({ storage });
  const records = Array.from({ length: 512 }, (_, index) => session(`s${index}`));
  for (const record of records) assert.deepEqual(owner.settle(record), success);
  const before = owner.snapshot();
  assert.deepEqual(owner.settle(session("excess")), { ok: false, reason: "limit" });
  assert.deepEqual(owner.snapshot(), before);
  assert.equal(writeCount(storage), 512);
  const updated = { ...records[0], completionSerial: 1 };
  assert.deepEqual(owner.settle(updated), success, "updating an existing mark does not need another slot");
  assert.deepEqual(owner.snapshot().settled[0], mark(updated));
  owner.restore(records[1].id);
  const boundary = session("x".repeat(512), { identity: "\u0000".repeat(4096), completionSerial: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(owner.settle(boundary), success);
  const reloaded = createSessionShelfState({ storage });
  assert.deepEqual(reloaded.snapshot().settled, owner.snapshot().settled);
  assert.equal(reloaded.reconcile(records).settled.length, 511);
  assert.equal(reloaded.reconcile([boundary]).settled[0], boundary);
});

test("unchanged reconciliation and explicit no-ops perform no idle writes", () => {
  const storage = fakeStorage();
  const owner = createSessionShelfState({ storage });
  const record = session("a");
  owner.restore("missing");
  for (const [section, expanded] of Object.entries(defaults)) owner.setExpanded(section, expanded);
  assert.equal(writeCount(storage), 0);
  owner.settle(record);
  for (let index = 0; index < 50; index += 1) {
    owner.reconcile([record]);
    owner.reconcile([]);
    owner.settle({ ...record, state: "done", messages: ["updated transcript"] });
    owner.restore("missing");
    owner.setExpanded("settled", false);
    owner.snapshot();
  }
  assert.deepEqual(storage.calls.map(([operation]) => operation), ["get", "set"]);
});

test("one reconcile batches multiple wake and prune changes into a single write", () => {
  const storage = fakeStorage();
  const owner = createSessionShelfState({ storage });
  const records = [session("a"), session("b"), session("missing")];
  records.forEach((record) => owner.settle(record));
  const current = [{ ...records[0], state: "input" }, { ...records[1], state: "working" }];
  owner.reconcile(current, { pruneMissing: true });
  assert.equal(writeCount(storage), 4);
  assert.deepEqual(JSON.parse(storage.records.get(SESSION_SHELF_STORAGE_KEY)).settled, []);
});

test("corrupt, invalid, oversized and future storage is preserved byte for byte", () => {
  const valid = storedRecord([mark(session("a"))]);
  const invalid = ["", "{", "null", "[]", "true", "1", '"state"', "{}",
    JSON.stringify({ ...valid, v: "1" }), JSON.stringify({ ...valid, v: 0 }),
    JSON.stringify({ ...valid, settled: {} }),
    JSON.stringify({ ...valid, settled: Array.from({ length: 513 }, (_, index) => mark(session(`s${index}`))) }),
    JSON.stringify({ ...valid, settled: [mark(session("a")), mark(session("a"))] }),
    ...[null, {}, [], { ...defaults, inbox: "true" }].map((expanded) => JSON.stringify({ ...valid, expanded })),
    ...[session(""), session("a", { identity: "" }), session("a", { completionSerial: -1 }),
      session("a".repeat(513)), session("a", { identity: "x".repeat(4097) })]
      .map((record) => JSON.stringify(storedRecord([mark(record)]))),
    JSON.stringify(valid) + " ".repeat(16 * 1024 * 1024),
  ];
  const future = [JSON.stringify({ ...valid, v: 2, future: "retain me" }), '{"v":9}'];
  for (const [reason, values] of [["invalid-storage", invalid], ["future-storage", future]]) {
    for (const raw of values) {
      const storage = fakeStorage([[SESSION_SHELF_STORAGE_KEY, raw], ["other", "untouched"]]);
      const owner = createSessionShelfState({ storage });
      const failure = { ok: false, reason };
      assert.deepEqual(owner.snapshot(), { ...storedRecord(), persistence: failure });
      owner.reconcile([], { pruneMissing: true });
      assert.deepEqual(owner.settle(session("b")), failure);
      assert.equal(owner.reconcile([session("b")]).settled.length, 1, "explicit changes still work in memory");
      assert.deepEqual(owner.setExpanded("settled", true), failure);
      assert.deepEqual(owner.restore("b"), failure);
      assert.equal(owner.snapshot().expanded.settled, true);
      assert.equal(storage.records.get(SESSION_SHELF_STORAGE_KEY), raw);
      assert.equal(storage.records.get("other"), "untouched");
      assert.deepEqual(storage.calls, [["get", SESSION_SHELF_STORAGE_KEY]]);
    }
  }
});

test("missing and denied storage support in-memory settlement, wake, disclosure and restore", () => {
  const unavailable = { ok: false, reason: "unavailable" };
  for (const storage of [undefined, null, {},
    { getItem() { throw new Error("denied"); }, setItem() { assert.fail("unknown data must not be overwritten"); } },
    { get getItem() { throw new Error("denied property"); } }]) {
    const owner = createSessionShelfState({ storage });
    const record = session("a");
    assert.deepEqual(owner.snapshot().persistence, unavailable);
    assert.deepEqual(owner.settle(record), unavailable);
    assert.equal(owner.reconcile([record]).settled[0], record);
    assert.deepEqual(owner.setExpanded("settled", true), unavailable);
    owner.reconcile([{ ...record, state: "working" }]);
    assert.deepEqual(owner.snapshot().settled, []);
    owner.settle(record);
    assert.deepEqual(owner.restore("a"), unavailable);
    assert.deepEqual(owner.snapshot(), { ...storedRecord([], { ...defaults, settled: true }), persistence: unavailable });
  }
});

test("a quota failure retains memory, reports failure and retries only on another actual change", () => {
  const storage = fakeStorage();
  const write = storage.setItem;
  let attempts = 0;
  storage.setItem = () => { attempts += 1; throw new Error("quota exceeded"); };
  const owner = createSessionShelfState({ storage });
  const record = session("a");
  const failure = { ok: false, reason: "unavailable" };
  assert.deepEqual(owner.settle(record), failure);
  assert.deepEqual(owner.snapshot().settled, [mark(record)]);
  assert.deepEqual(owner.snapshot().persistence, failure);
  owner.reconcile([record]);
  assert.deepEqual(owner.settle(record), failure);
  owner.setExpanded("inbox", true);
  assert.equal(attempts, 1);
  storage.setItem = write;
  assert.deepEqual(owner.setExpanded("settled", true), success);
  assert.deepEqual(createSessionShelfState({ storage }).snapshot().settled, [mark(record)]);
});

test("snapshots, partition arrays, results and caller records share no mutable state with the store", () => {
  const owner = createSessionShelfState({ storage: fakeStorage() });
  const record = session("__proto__");
  const outcome = owner.settle(record);
  outcome.ok = false;
  record.identity = "caller mutation";
  record.completionSerial = 9;
  const expected = mark(session("__proto__"));
  const copy = owner.snapshot();
  copy.settled[0].identity = "snapshot mutation";
  copy.settled.push(mark(session("injected")));
  copy.expanded.inbox = false;
  copy.persistence.ok = false;
  const partition = owner.reconcile([session("__proto__")]);
  partition.settled.length = 0;
  partition.expanded.settled = true;
  assert.deepEqual(owner.snapshot(), { ...storedRecord([expected]), persistence: success });
  const other = createSessionShelfState({ storage: fakeStorage() });
  assert.deepEqual(other.snapshot(), { ...storedRecord(), persistence: success });
});

test("invalid controls and incomplete catalogs never mutate persisted choices", () => {
  const storage = fakeStorage();
  const owner = createSessionShelfState({ storage });
  const record = session("a");
  owner.settle(record);
  const before = owner.snapshot();
  for (const section of [undefined, null, "", "other", "__proto__", {}, 1]) {
    assert.deepEqual(owner.setExpanded(section, true), { ok: false, reason: "invalid-section" });
  }
  for (const value of [undefined, null, "true", 0, 1, {}]) {
    assert.deepEqual(owner.setExpanded("inbox", value), { ok: false, reason: "invalid-expanded" });
  }
  for (const id of [undefined, null, "", 1, {}, "a".repeat(513)]) {
    assert.deepEqual(owner.restore(id), { ok: false, reason: "invalid-id" });
  }
  const invalid = Object.freeze({ id: "a", state: "done" });
  const result = owner.reconcile([invalid], { pruneMissing: true });
  assert.equal(result.inbox[0], invalid);
  owner.reconcile(null, { pruneMissing: true });
  owner.reconcile(Array(1), { pruneMissing: true });
  assert.deepEqual(owner.snapshot(), before);
  assert.equal(writeCount(storage), 1);
});
