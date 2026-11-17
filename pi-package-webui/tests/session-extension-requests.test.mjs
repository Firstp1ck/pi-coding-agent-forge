import assert from "node:assert/strict";
import { test } from "node:test";
import { createExtensionRequestStore } from "../public/session-extension-requests.mjs";

function request(tabId, id) {
  return Object.freeze({ tabId, id, method: "confirm", message: "Continue?" });
}

test("requests retain references and FIFO order with one explicit active owner", () => {
  const store = createExtensionRequestStore();
  const first = request("tab-a", "first");
  const second = request("tab-b", "second");
  assert.equal(store.active, null);
  assert.equal(store.takeNext(), null);
  assert.equal(store.enqueue(first), true);
  assert.equal(store.enqueue(second), true);
  assert.equal(store.pending()[0], first);
  assert.equal(store.pending()[1], second);
  assert.equal(store.takeNext(), first);
  assert.equal(store.active, first);
  assert.deepEqual(store.pending(), [second]);
  assert.equal(store.takeNext(), null);
  assert.equal(store.has("tab-a", "first"), true);
  assert.equal(store.has("tab-b", "second"), true);
  assert.deepEqual(store.remove("tab-a", ["first"]), { activeRemoved: true, pendingRemoved: [] });
  assert.equal(store.active, null);
  assert.equal(store.takeNext(), second);
});

test("replay is suppressed only while the exact tab/id remains pending or active", () => {
  const store = createExtensionRequestStore();
  const original = request("tab-a", "id");
  const replay = Object.freeze({ ...original, replayed: true });
  store.enqueue(original);
  assert.equal(store.enqueue(replay), false);
  assert.equal(store.takeNext(), original);
  assert.equal(store.enqueue(replay), false);
  store.remove("tab-a", ["id"]);
  assert.equal(store.enqueue(replay), true);
  assert.equal(store.takeNext(), replay);
  assert.deepEqual(store.clear(), [replay]);
  assert.equal(store.enqueue(original), true);
  assert.equal(store.takeNext(), original);
});

test("same IDs across tabs remain independent through active removal", () => {
  const store = createExtensionRequestStore();
  const first = request("tab-a", "same");
  const second = request("tab-b", "same");
  store.enqueue(first);
  store.enqueue(second);
  store.takeNext();
  const result = store.remove("tab-b", ["same"]);
  assert.equal(result.activeRemoved, false);
  assert.equal(result.pendingRemoved[0], second);
  assert.equal(store.active, first);
  assert.equal(store.has("tab-a", "same"), true);
  assert.equal(store.has("tab-b", "same"), false);
  assert.deepEqual(store.remove("tab-c", ["same"]), { activeRemoved: false, pendingRemoved: [] });
});

test("exact keys do not collide or normalize separator, whitespace or special names", () => {
  const store = createExtensionRequestStore();
  const requests = [
    request("a:b", "c"), request("a", "b:c"),
    request("a", "c"), request(" a", "c"), request("a", "c "),
    request("__proto__", "constructor"), request(" ", " "),
  ];
  requests.forEach((item) => assert.equal(store.enqueue(item), true));
  assert.deepEqual(store.pending(), requests);
  requests.forEach((item) => assert.equal(store.has(item.tabId, item.id), true));
  assert.deepEqual(store.remove("a", ["c"]), { activeRemoved: false, pendingRemoved: [requests[2]] });
  assert.equal(store.has(" a", "c"), true);
  assert.equal(store.has("a", "c "), true);
});

test("remove returns queued references in queue order and never promotes implicitly", () => {
  const store = createExtensionRequestStore();
  const active = request("tab-a", "active");
  const first = request("tab-a", "first");
  const keep = request("tab-b", "first");
  const last = request("tab-a", "last");
  [active, first, keep, last].forEach((item) => store.enqueue(item));
  store.takeNext();
  const ids = Object.freeze(["last", "active", "first", "first", "missing"]);
  const result = store.remove("tab-a", ids);
  assert.equal(result.activeRemoved, true);
  assert.deepEqual(result.pendingRemoved, [first, last]);
  assert.equal(result.pendingRemoved[0], first);
  assert.equal(result.pendingRemoved[1], last);
  assert.equal(store.active, null);
  assert.deepEqual(store.pending(), [keep]);
  assert.equal(store.takeNext(), keep);
});

test("pending returns independent arrays and exposes no mutable queue", () => {
  const store = createExtensionRequestStore();
  const first = request("tab-a", "first");
  const second = request("tab-a", "second");
  store.enqueue(first);
  store.enqueue(second);
  const pending = store.pending();
  assert.notEqual(pending, store.pending());
  pending.reverse();
  pending.splice(0);
  pending.push(request("other", "injected"));
  assert.deepEqual(store.pending(), [first, second]);
  assert.equal(store.has("other", "injected"), false);
  Object.freeze(store.pending());
  assert.equal(store.takeNext(), first);
  assert.deepEqual(store.pending(), [second]);
  assert.throws(() => { store.active = second; }, TypeError);
  assert.equal(store.active, first);
});

test("clear releases active then queued references without responding or cancelling", () => {
  const store = createExtensionRequestStore();
  const first = Object.freeze({
    ...request("tab-a", "first"),
    respond() { assert.fail("store responded"); },
    cancel() { assert.fail("store cancelled"); },
  });
  const second = request("tab-b", "second");
  store.enqueue(first);
  store.enqueue(second);
  store.takeNext();
  const removed = store.clear();
  assert.equal(removed[0], first);
  assert.equal(removed[1], second);
  assert.equal(store.active, null);
  assert.deepEqual(store.pending(), []);
  assert.equal(store.has("tab-a", "first"), false);
  assert.equal(store.has("tab-b", "second"), false);
  assert.equal(store.takeNext(), null);
  assert.deepEqual(store.clear(), []);
  removed.push(first);
  assert.equal(store.enqueue(second), true);
  assert.deepEqual(store.clear(), [second]);
});

test("invalid request identifiers fail closed without mutating active or queue", () => {
  const store = createExtensionRequestStore();
  const active = request("tab-a", "active");
  const queued = request("tab-b", "queued");
  store.enqueue(active);
  store.enqueue(queued);
  store.takeNext();
  const invalid = [undefined, null, "", 0, 1, false, {}, [], new String("id"), Symbol("id")];
  for (const value of invalid) {
    assert.equal(store.enqueue({ tabId: value, id: "id" }), false);
    assert.equal(store.enqueue({ tabId: "tab-a", id: value }), false);
    assert.equal(store.has(value, "active"), false);
    assert.equal(store.has("tab-a", value), false);
    assert.equal(store.active, active);
    assert.deepEqual(store.pending(), [queued]);
  }
  for (const value of [undefined, null, false, 1, "request"]) assert.equal(store.enqueue(value), false);
});

test("invalid removal batches are atomic no-ops including sparse arrays", () => {
  const store = createExtensionRequestStore();
  const active = request("tab-a", "active");
  const queued = request("tab-a", "queued");
  store.enqueue(active);
  store.enqueue(queued);
  store.takeNext();
  const invalid = [null, "queued", {}, 1, ["active", ""], ["queued", 1], ["active", null], ["queued", , "active"]];
  for (const ids of invalid) {
    assert.deepEqual(store.remove("tab-a", ids), { activeRemoved: false, pendingRemoved: [] });
    assert.equal(store.active, active);
    assert.deepEqual(store.pending(), [queued]);
  }
  for (const tabId of [undefined, null, "", 1]) {
    assert.deepEqual(store.remove(tabId, ["active", "queued"]), { activeRemoved: false, pendingRemoved: [] });
  }
  assert.deepEqual(store.remove("tab-a"), { activeRemoved: false, pendingRemoved: [] });
  assert.deepEqual(store.clear(), [active, queued]);
});

test("ownership keys remain captured while request and payload references stay stable", () => {
  const store = createExtensionRequestStore();
  const options = ["approve", "deny"];
  const original = { tabId: "tab-a", id: "id", options };
  store.enqueue(original);
  original.tabId = "tab-b";
  original.id = "changed";
  assert.equal(store.has("tab-a", "id"), true);
  assert.equal(store.has("tab-b", "changed"), false);
  assert.equal(store.takeNext(), original);
  assert.equal(store.active.options, options);
  assert.deepEqual(store.remove("tab-b", ["changed"]), { activeRemoved: false, pendingRemoved: [] });
  assert.deepEqual(store.remove("tab-a", ["id"]), { activeRemoved: true, pendingRemoved: [] });
});
