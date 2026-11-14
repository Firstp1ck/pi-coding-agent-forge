import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionEventStream } from "../public/platform-event-stream.mjs";

function harness() {
  let context = Object.freeze({ tabId: "tab-a", generation: 1 });
  const sources = [];
  const calls = [];
  const createSource = (url) => {
    const source = {
      url,
      readyState: 0,
      closes: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      close() { this.closes += 1; this.readyState = 2; },
    };
    sources.push(source);
    return source;
  };
  const stream = createSessionEventStream({
    createSource,
    isCurrent: (captured) => captured === context,
    onOpen: (event, captured) => calls.push(["open", event, captured]),
    onMessage: (event, captured) => calls.push(["message", event, captured]),
    onError: (event, captured) => calls.push(["error", event, captured]),
  });
  return {
    stream, sources, calls,
    get context() { return context; },
    activate(tabId = context.tabId) { context = Object.freeze({ tabId, generation: context.generation + 1 }); },
  };
}

function callbacks(source) {
  return [source.onopen, source.onmessage, source.onerror];
}

function assertReleased(source) {
  assert.equal(source.closes, 1);
  assert.deepEqual(callbacks(source), [null, null, null]);
}

test("constructs no resource until connect and forwards original events and context", () => {
  const h = harness();
  assert.equal(h.stream.source, null);
  assert.equal(h.sources.length, 0);
  const source = h.stream.connect("/events?tab=tab-a&mode=auto", h.context);
  assert.equal(h.stream.source, source);
  assert.equal(source.url, "/events?tab=tab-a&mode=auto");
  const events = [Object.freeze({ type: "open" }), Object.freeze({ data: "not JSON" }), Object.freeze({ type: "error" })];
  callbacks(source).forEach((callback, i) => callback(events[i]));
  assert.deepEqual(h.calls.map(([type]) => type), ["open", "message", "error"]);
  h.calls.forEach(([, event, context], i) => {
    assert.equal(event, events[i]);
    assert.equal(context, h.context);
  });
  assert.equal(source.closes, 0);
});

test("replacement closes the previous resource and suppresses its queued callbacks", async () => {
  const h = harness();
  const first = h.stream.connect("/first", h.context);
  const oldCallbacks = callbacks(first);
  const queued = Promise.resolve().then(() => oldCallbacks.forEach((callback) => callback({ late: true })));
  const second = h.stream.connect("/second", h.context);
  assert.notEqual(first, second);
  assertReleased(first);
  assert.equal(second.closes, 0);
  await queued;
  assert.deepEqual(h.calls, []);
  second.onmessage({ data: "current" });
  assert.equal(h.calls.length, 1);
  assert.equal(h.stream.source, second);
});

test("stale connect cannot close or replace a current source", () => {
  const h = harness();
  const staleContext = h.context;
  h.activate("tab-b");
  const current = h.stream.connect("/tab-b", h.context);
  assert.equal(h.stream.connect("/stale", staleContext), null);
  assert.equal(h.sources.length, 1);
  assert.equal(h.stream.source, current);
  assert.equal(current.closes, 0);
  current.onopen({ type: "open" });
  assert.equal(h.calls.length, 1);
});

test("each callback rechecks context even while its source remains owned", () => {
  const h = harness();
  const source = h.stream.connect("/events", h.context);
  h.activate();
  callbacks(source).forEach((callback) => callback({ stale: true }));
  assert.deepEqual(h.calls, []);
  assert.equal(source.closes, 0);
  assert.equal(h.stream.source, source);
});

test("close detaches handlers, invalidates captured callbacks and permits reconnect", async () => {
  const h = harness();
  const source = h.stream.connect("/first", h.context);
  const oldCallbacks = callbacks(source);
  h.stream.close();
  h.stream.close();
  assertReleased(source);
  assert.equal(h.stream.source, null);
  await Promise.resolve().then(() => oldCallbacks.forEach((callback) => callback({ late: true })));
  assert.deepEqual(h.calls, []);
  const replacement = h.stream.connect("/second", h.context);
  assert.equal(h.stream.source, replacement);
  assert.equal(h.sources.length, 2);
});

test("ownership is invalidated before source.close can deliver callbacks", () => {
  const h = harness();
  const source = h.stream.connect("/events", h.context);
  const oldCallbacks = callbacks(source);
  const close = source.close.bind(source);
  source.close = () => {
    oldCallbacks.forEach((callback) => callback({ duringClose: true }));
    close();
  };
  h.stream.close();
  assertReleased(source);
  assert.deepEqual(h.calls, []);
});

test("dispose is terminal and suppresses queued callbacks", async () => {
  const h = harness();
  const source = h.stream.connect("/events", h.context);
  const oldCallbacks = callbacks(source);
  h.stream.dispose();
  h.stream.dispose();
  h.stream.close();
  assertReleased(source);
  await Promise.resolve().then(() => oldCallbacks.forEach((callback) => callback({ late: true })));
  assert.deepEqual(h.calls, []);
  assert.equal(h.stream.connect("/after-dispose", h.context), null);
  assert.equal(h.stream.source, null);
  assert.equal(h.sources.length, 1);
});

test("source errors forward without changing resource, retry, or parsing policy", () => {
  const h = harness();
  const source = h.stream.connect("/events", h.context);
  const error = Object.freeze({ type: "error", message: "connection lost" });
  source.onerror(error);
  source.onerror(error);
  source.onmessage({ data: "{malformed" });
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[0][1], error);
  assert.equal(h.calls[1][1], error);
  assert.equal(h.stream.source, source);
  assert.equal(source.closes, 0);
  assert.equal(h.sources.length, 1);
});

test("factory failure propagates after releasing the previous resource", () => {
  const source = { close() { this.closed = true; } };
  const error = new Error("source unavailable");
  let attempts = 0;
  const stream = createSessionEventStream({
    createSource() { if (attempts++ === 0) return source; throw error; },
    isCurrent: () => true,
  });
  stream.connect("/first", {});
  assert.throws(() => stream.connect("/failure", {}), (actual) => actual === error);
  assert.equal(stream.source, null);
  assert.equal(source.closed, true);
});

test("construction that invalidates context or disposes releases the new source", () => {
  for (const action of ["invalidate", "close", "dispose"]) {
    const source = { closes: 0, close() { this.closes += 1; } };
    let current = true;
    const stream = createSessionEventStream({
      createSource() {
        if (action === "invalidate") current = false;
        else stream[action]();
        return source;
      },
      isCurrent: () => current,
    });
    assert.equal(stream.connect("/events", {}), null);
    assert.equal(stream.source, null);
    assertReleased(source);
  }
});

test("reentrant replacement during construction keeps the later resource", () => {
  const first = { closes: 0, close() { this.closes += 1; } };
  const second = { closes: 0, close() { this.closes += 1; } };
  const context = {};
  const stream = createSessionEventStream({
    createSource(url) {
      if (url === "/first") {
        stream.connect("/second", context);
        return first;
      }
      return second;
    },
    isCurrent: () => true,
  });
  assert.equal(stream.connect("/first", context), null);
  assert.equal(stream.source, second);
  assertReleased(first);
  assert.equal(second.closes, 0);
  stream.dispose();
  assertReleased(second);
});

test("source is read-only and callback failures propagate without replacing it", () => {
  const error = new Error("parent callback failed");
  const source = { close() {} };
  const stream = createSessionEventStream({
    createSource: () => source,
    isCurrent: () => true,
    onMessage() { throw error; },
  });
  stream.connect("/events", {});
  assert.throws(() => { stream.source = null; }, TypeError);
  assert.throws(() => source.onmessage({ data: "message" }), (actual) => actual === error);
  assert.equal(stream.source, source);
});

test("invalid factories and callbacks fail before acquiring resources", () => {
  assert.throws(() => createSessionEventStream(), TypeError);
  for (const field of ["createSource", "isCurrent", "onOpen", "onMessage", "onError"]) {
    assert.throws(() => createSessionEventStream({ createSource() {}, isCurrent() {}, [field]: null }), TypeError);
  }
});

test("omitted event callbacks are safe and disposal before connect acquires nothing", () => {
  let created = 0;
  const stream = createSessionEventStream({
    createSource() { created += 1; return { close() {} }; },
    isCurrent: () => true,
  });
  const source = stream.connect("/events", {});
  callbacks(source).forEach((callback) => callback({ type: "ignored" }));
  stream.dispose();
  assert.equal(created, 1);

  const neverConnected = createSessionEventStream({
    createSource() { assert.fail("created after disposal"); },
    isCurrent() { assert.fail("checked context after disposal"); },
  });
  neverConnected.dispose();
  assert.equal(neverConnected.connect("/events", {}), null);
  assert.equal(neverConnected.source, null);
});
