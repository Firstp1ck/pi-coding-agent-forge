import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionContext } from "../public/session-context.mjs";

test("inactive context matches the existing null-tab capture contract", () => {
  const owner = createSessionContext();
  assert.equal(owner.activeTabId, null);
  assert.equal(owner.generation, 0);
  assert.deepEqual(owner.capture(), { tabId: null, generation: 0 });
  assert.equal(owner.isCurrent(owner.capture()), true);
  assert.equal(owner.isCurrent(null), false);
  assert.equal(owner.isCurrent(undefined), false);
  assert.equal(owner.isCurrent({}), false);
  assert.deepEqual(owner.activate(null), { tabId: null, generation: 0 });
  assert.deepEqual(owner.observeSession(null, "session-a"), {
    changed: false, context: { tabId: null, generation: 0 },
  });
});

test("only tab changes advance activation generation and returning rejects old work", () => {
  const owner = createSessionContext();
  const first = owner.activate("a");
  assert.deepEqual(first, { tabId: "a", generation: 1 });
  assert.deepEqual(owner.activate("a"), first);
  assert.equal(owner.isCurrent(first), true);
  assert.deepEqual(owner.capture("b"), { tabId: "b", generation: 1 });
  assert.equal(owner.isCurrent(owner.capture("b")), false);
  assert.deepEqual(owner.activate("b"), { tabId: "b", generation: 2 });
  assert.equal(owner.isCurrent(first), false);
  owner.activate("a");
  assert.equal(owner.generation, 3);
  assert.equal(owner.isCurrent(first), false);
  const current = owner.capture();
  assert.deepEqual(owner.activate(null), { tabId: null, generation: 4 });
  assert.equal(owner.isCurrent(current), false);
  assert.deepEqual(owner.activate(undefined), { tabId: null, generation: 4 });
});

test("first and repeated session identities retain captured work", () => {
  const owner = createSessionContext();
  const captured = owner.activate("a");
  for (const identity of [null, "", "session-1", "session-1", undefined]) {
    assert.deepEqual(owner.observeSession("a", identity), { changed: false, context: captured });
    assert.equal(owner.isCurrent(captured), true);
  }
  assert.deepEqual(owner.observeSession("a", "session-2"), {
    changed: true, context: { tabId: "a", generation: 2 },
  });
  assert.equal(owner.activeTabId, "a");
  assert.equal(owner.isCurrent(captured), false);
  assert.equal(owner.isCurrent(owner.capture()), true);
  assert.equal(owner.observeSession("a", "session-2").changed, false);
  assert.equal(owner.generation, 2);
});

test("background replacement reports a change without invalidating foreground work", () => {
  const owner = createSessionContext();
  const foreground = owner.activate("a");
  owner.observeSession("a", "session-a");
  assert.deepEqual(owner.observeSession("b", "session-b1"), {
    changed: false, context: { tabId: "b", generation: 1 },
  });
  assert.deepEqual(owner.observeSession("b", "session-b2"), {
    changed: true, context: { tabId: "b", generation: 1 },
  });
  assert.equal(owner.activeTabId, "a");
  assert.equal(owner.isCurrent(foreground), true);
  assert.equal(owner.isCurrent(owner.capture("b")), false);
  const backgroundActivated = owner.activate("b");
  assert.equal(owner.observeSession("b", "session-b2").changed, false);
  assert.equal(owner.isCurrent(backgroundActivated), true);
  assert.equal(owner.observeSession("b", "session-b3").changed, true);
  assert.equal(owner.isCurrent(backgroundActivated), false);
});

test("explicit invalidation clears identity and invalidates only the active tab", () => {
  const owner = createSessionContext();
  const captured = owner.activate("a");
  owner.observeSession("a", "session-a1");
  owner.observeSession("b", "session-b1");
  assert.deepEqual(owner.invalidate("b"), { tabId: "b", generation: 1 });
  assert.equal(owner.isCurrent(captured), true);
  assert.equal(owner.observeSession("b", "session-b2").changed, false);
  const invalidated = owner.invalidate();
  assert.deepEqual(invalidated, { tabId: "a", generation: 2 });
  assert.equal(owner.isCurrent(captured), false);
  assert.deepEqual(owner.observeSession("a", "session-a2"), { changed: false, context: invalidated });
  assert.equal(owner.isCurrent(invalidated), true);
  assert.equal(owner.observeSession("a", "session-a3").changed, true);
});

test("switching away preserves the observed identity for later replacement detection", () => {
  const owner = createSessionContext();
  owner.activate("a");
  owner.observeSession("a", "session-a1");
  owner.activate("b");
  const returned = owner.activate("a");
  assert.equal(owner.observeSession("a", "session-a1").changed, false);
  assert.equal(owner.isCurrent(returned), true);
  assert.equal(owner.observeSession("a", "session-a2").changed, true);
  assert.equal(owner.isCurrent(returned), false);
});

test("captures are detached values and public state is read-only and instance-local", () => {
  const owner = createSessionContext();
  const other = createSessionContext();
  const captured = owner.activate("a");
  captured.tabId = "b";
  captured.generation = -1;
  assert.deepEqual(owner.capture(), { tabId: "a", generation: 1 });
  assert.throws(() => { owner.activeTabId = "b"; }, TypeError);
  assert.throws(() => { owner.generation = 99; }, TypeError);
  owner.observeSession("a", "session-a1");
  other.activate("a");
  assert.equal(other.observeSession("a", "session-a2").changed, false);
  assert.deepEqual(owner.capture(), { tabId: "a", generation: 1 });
});
