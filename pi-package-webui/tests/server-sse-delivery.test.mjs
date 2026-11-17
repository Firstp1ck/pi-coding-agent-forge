import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createSseDelivery } from "../lib/server/sse-delivery.mjs";

class ResponseDouble extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.writeResults = [...writeResults];
    this.frames = [];
    this.bytes = 0;
    this.destroyed = false;
    this.writableEnded = false;
    this.endCalls = 0;
    this.destroyCalls = 0;
    this.writeError = undefined;
    this.endError = undefined;
  }

  write(frame) {
    assert.equal(this.destroyed || this.writableEnded, false);
    assert.ok(this.frames.length < 300, "response double write bound");
    assert.ok(this.bytes + Buffer.byteLength(frame) <= 8 * 1024 * 1024, "response double byte bound");
    if (this.writeError) throw this.writeError;
    this.frames.push(frame);
    this.bytes += Buffer.byteLength(frame);
    return this.writeResults.length ? this.writeResults.shift() : true;
  }

  end() {
    this.endCalls += 1;
    if (this.endError) throw this.endError;
    this.writableEnded = true;
  }

  destroy() {
    this.destroyCalls += 1;
    this.destroyed = true;
  }
}

function fixture(t, { writeResults, activeMode = "normal", pendingMode } = {}) {
  const delivery = createSseDelivery();
  const res = new ResponseDouble(writeResults);
  const tab = { sseClients: new Set() };
  const client = { res, tab, activeMode, pendingMode };
  tab.sseClients.add(client);
  t.after(() => delivery.clearSseBackpressureTimer(client));
  return { delivery, res, tab, client };
}

function events(frames) {
  return frames.map((frame) => {
    assert.match(frame, /^data: .+\n\n$/);
    return JSON.parse(frame.slice(6));
  });
}

function assertEvicted({ client, res, tab }) {
  assert.equal(client.evicted, true);
  assert.equal(client.backpressured, false);
  assert.equal(client.backpressureTimer, undefined);
  assert.deepEqual(client.pendingFrames, []);
  assert.equal(client.pendingFrameBytes, 0);
  assert.equal(tab.sseClients.has(client), false);
  assert.equal(res.endCalls, 1);
  assert.equal(res.destroyCalls, 0);
}

test("import and factory construction have no timer or listener effects", async (t) => {
  const timeout = t.mock.method(globalThis, "setTimeout", () => assert.fail("unexpected timer"));
  const interval = t.mock.method(globalThis, "setInterval", () => assert.fail("unexpected interval"));
  const listeners = process.eventNames().map((name) => [name, process.listeners(name)]);
  const module = await import("../lib/server/sse-delivery.mjs?inert-import");
  assert.deepEqual(Object.keys(module), ["createSseDelivery"]);
  const delivery = module.createSseDelivery();
  assert.deepEqual(Object.keys(delivery).sort(), [
    "activateOutputMode", "clearSseBackpressureTimer", "evictSlowSseClient", "flushSseClient",
    "scheduleSseBackpressureTimeout", "sendSse", "sendSseToClient", "writeSseFrame",
  ]);
  assert.equal(timeout.mock.callCount(), 0);
  assert.equal(interval.mock.callCount(), 0);
  assert.deepEqual(process.eventNames().map((name) => [name, process.listeners(name)]), listeners);
});

test("writes normal SSE and raw keepalive frames", (t) => {
  const { delivery, client, res } = fixture(t);
  delete client.activeMode;
  const event = { type: "message_update", text: "hello\nworld", tabId: "tab-a" };
  assert.equal(delivery.sendSse(client, event), true);
  assert.deepEqual(events(res.frames), [event]);
  assert.equal(delivery.writeSseFrame(client, ": keepalive\n\n"), true);
  assert.equal(res.frames[1], ": keepalive\n\n");
  assert.equal(client.backpressureTimer, undefined);
});

test("raw response writes accept false without creating client state", () => {
  const delivery = createSseDelivery();
  const res = new ResponseDouble([false]);
  assert.equal(delivery.sendSse(res, { type: "agent_end" }), true);
  assert.deepEqual(events(res.frames), [{ type: "agent_end" }]);
  assert.equal(res.backpressured, undefined);
  assert.equal(res.backpressureTimer, undefined);
  res.writeError = new Error("closed socket");
  assert.equal(delivery.writeSseFrame(res, "next"), false);
  assert.equal(res.endCalls, 0);
});

test("write false accepts the frame once and queues later frames until drain", (t) => {
  const f = fixture(t, { writeResults: [false] });
  const { delivery, client, res } = f;
  assert.equal(delivery.writeSseFrame(client, "accepted"), true);
  assert.equal(client.backpressured, true);
  assert.equal(client.backpressureTimer.hasRef(), false);
  assert.equal(res.listenerCount("drain"), 1);
  const timer = client.backpressureTimer;
  for (const frame of ["é", "last"]) assert.equal(delivery.writeSseFrame(client, frame), true);
  assert.deepEqual(res.frames, ["accepted"]);
  assert.deepEqual(client.pendingFrames, ["é", "last"]);
  assert.equal(client.pendingFrameBytes, 6);
  assert.equal(client.backpressureTimer, timer, "queue growth must not extend the timeout");
  res.emit("drain");
  assert.deepEqual(res.frames, ["accepted", "é", "last"]);
  assert.equal(client.backpressured, false);
  assert.equal(client.backpressureTimer, undefined);
  assert.deepEqual(client.pendingFrames, []);
  assert.equal(client.pendingFrameBytes, 0);
  assert.equal(res.listenerCount("drain"), 0);
  assert.equal(client.evicted, undefined);
});

test("a second write false during flush preserves queue order and byte accounting", (t) => {
  const { delivery, client, res } = fixture(t, { writeResults: [false, true, false] });
  for (const frame of ["initial", "one", "é", "three"]) delivery.writeSseFrame(client, frame);
  const firstTimer = client.backpressureTimer;
  res.emit("drain");
  assert.deepEqual(res.frames, ["initial", "one", "é"]);
  assert.deepEqual(client.pendingFrames, ["three"]);
  assert.equal(client.pendingFrameBytes, 5);
  assert.equal(client.backpressured, true);
  assert.notEqual(client.backpressureTimer, firstTimer);
  assert.equal(res.listenerCount("drain"), 1);
  delivery.writeSseFrame(client, "four");
  res.emit("drain");
  assert.deepEqual(res.frames, ["initial", "one", "é", "three", "four"]);
  assert.equal(client.pendingFrameBytes, 0);
  assert.equal(client.backpressureTimer, undefined);
});

test("client queue and timer state can be used by another factory instance", (t) => {
  const { delivery, client, res } = fixture(t, { writeResults: [false] });
  delivery.writeSseFrame(client, "initial");
  delivery.writeSseFrame(client, "queued");
  createSseDelivery().flushSseClient(client);
  assert.deepEqual(res.frames, ["initial", "queued"]);
  assert.equal(client.pendingFrameBytes, 0);
  assert.equal(client.backpressureTimer, undefined);
  res.emit("drain");
  assert.deepEqual(res.frames, ["initial", "queued"]);
});

test("256 pending frames fit and the next frame evicts with an ended response", (t) => {
  const f = fixture(t, { writeResults: [false] });
  const { delivery, client, res } = f;
  delivery.writeSseFrame(client, "initial");
  for (let i = 0; i < 256; i += 1) assert.equal(delivery.writeSseFrame(client, "x"), true);
  assert.equal(client.pendingFrames.length, 256);
  assert.equal(client.pendingFrameBytes, 256);
  assert.equal(client.evicted, undefined);
  assert.equal(delivery.writeSseFrame(client, "overflow"), false);
  assertEvicted(f);
  assert.equal(res.writableEnded, true);
  res.emit("drain");
  assert.deepEqual(res.frames, ["initial"]);
  delivery.evictSlowSseClient(client);
  assertEvicted(f);
});

test("4 MiB pending bytes fit and one additional UTF-8 byte evicts", (t) => {
  const f = fixture(t, { writeResults: [false] });
  const { delivery, client } = f;
  delivery.writeSseFrame(client, "initial");
  const frame = "é".repeat(2 * 1024 * 1024);
  assert.equal(delivery.writeSseFrame(client, frame), true);
  assert.equal(client.pendingFrames.length, 1);
  assert.equal(client.pendingFrameBytes, 4 * 1024 * 1024);
  assert.equal(client.evicted, undefined);
  assert.equal(delivery.writeSseFrame(client, "x"), false);
  assertEvicted(f);
});

test("a single pending frame over 4 MiB evicts before enqueueing", (t) => {
  const f = fixture(t, { writeResults: [false] });
  f.delivery.writeSseFrame(f.client, "initial");
  assert.equal(f.delivery.writeSseFrame(f.client, "x".repeat(4 * 1024 * 1024 + 1)), false);
  assertEvicted(f);
});

test("a stalled client is evicted at ten seconds without extending for queued frames", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { writeResults: [false] });
  f.delivery.writeSseFrame(f.client, "initial");
  t.mock.timers.tick(9_999);
  assert.equal(f.client.evicted, undefined);
  f.delivery.writeSseFrame(f.client, "queued");
  t.mock.timers.tick(1);
  assertEvicted(f);
  assert.equal(f.res.writableEnded, true);
  f.res.emit("drain");
  assert.deepEqual(f.res.frames, ["initial"]);
});

test("scheduling replaces the old timeout and clearing cancels the replacement", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t);
  f.delivery.scheduleSseBackpressureTimeout(f.client);
  const firstTimer = f.client.backpressureTimer;
  t.mock.timers.tick(5_000);
  f.delivery.scheduleSseBackpressureTimeout(f.client);
  assert.notEqual(f.client.backpressureTimer, firstTimer);
  t.mock.timers.tick(5_000);
  assert.equal(f.client.evicted, undefined);
  f.delivery.clearSseBackpressureTimer(f.client);
  assert.equal(f.client.backpressureTimer, undefined);
  f.delivery.clearSseBackpressureTimer(f.client);
  f.delivery.clearSseBackpressureTimer(undefined);
  t.mock.timers.tick(10_000);
  assert.equal(f.client.evicted, undefined);
});

test("successful drain cancels timeout eviction and preserves other clients", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, { writeResults: [false] });
  const peer = { res: new ResponseDouble(), tab: f.tab };
  f.tab.sseClients.add(peer);
  f.delivery.writeSseFrame(f.client, "initial");
  f.delivery.writeSseFrame(f.client, "queued");
  t.mock.timers.tick(9_999);
  f.res.emit("drain");
  t.mock.timers.tick(10_001);
  assert.equal(f.client.evicted, undefined);
  assert.equal(f.tab.sseClients.size, 2);
  f.delivery.evictSlowSseClient(f.client);
  assertEvicted(f);
  assert.equal(f.tab.sseClients.has(peer), true);
  assert.equal(peer.res.endCalls, 0);
});

test("write errors evict, discard queued frames and tolerate an end error", (t) => {
  const f = fixture(t);
  f.res.writeError = new Error("socket write failed");
  f.res.endError = new Error("socket already closed");
  assert.equal(f.delivery.writeSseFrame(f.client, "failed"), false);
  assertEvicted(f);
  assert.equal(f.delivery.writeSseFrame(f.client, "later"), false);
  f.delivery.evictSlowSseClient(f.client);
  assertEvicted(f);
});

test("flush write errors evict without writing remaining queued frames", (t) => {
  const f = fixture(t, { writeResults: [false] });
  for (const frame of ["initial", "failed", "never"]) f.delivery.writeSseFrame(f.client, frame);
  f.res.writeError = new Error("flush failed");
  f.res.emit("drain");
  assertEvicted(f);
  assert.deepEqual(f.res.frames, ["initial"]);
});

for (const closedState of ["destroyed", "writableEnded"]) {
  test(`${closedState} responses reject writes and evict on flush`, (t) => {
    const f = fixture(t, { writeResults: [false] });
    f.delivery.writeSseFrame(f.client, "initial");
    f.delivery.writeSseFrame(f.client, "queued");
    f.res[closedState] = true;
    assert.equal(f.delivery.writeSseFrame(f.client, "later"), false);
    assert.equal(f.client.evicted, undefined);
    f.res.emit("drain");
    assertEvicted(f);
    assert.deepEqual(f.res.frames, ["initial"]);
  });
}

test("missing clients are harmless and missing responses evict on flush", (t) => {
  const delivery = createSseDelivery();
  assert.equal(delivery.writeSseFrame(undefined, "frame"), false);
  delivery.flushSseClient(undefined);
  delivery.evictSlowSseClient(undefined);
  const f = fixture(t);
  delete f.client.res;
  f.delivery.flushSseClient(f.client);
  assert.equal(f.client.evicted, true);
  assert.equal(f.tab.sseClients.has(f.client), false);
});

test("compact mode uses the existing codec and suppressed events do not queue", (t) => {
  const { delivery, client, res } = fixture(t, { activeMode: "compact-v1" });
  const update = {
    type: "message_update", tabId: "tab-a", message: { content: "partial" },
    assistantMessageEvent: { type: "text_delta", delta: "hello", partial: { content: "partial" } },
  };
  assert.equal(delivery.sendSse(client, update), true);
  assert.deepEqual(events(res.frames), [{
    type: "message_update", tabId: "tab-a", assistantMessageEvent: { type: "text_delta", delta: "hello" },
  }]);
  assert.equal(delivery.sendSse(client, { type: "tool_execution_update", partialResult: "large" }), false);
  assert.equal(res.frames.length, 1);
  assert.equal(client.pendingFrames, undefined);
  assert.equal(client.backpressureTimer, undefined);
});

test("mode activation uses the previous codec before changing client state", (t) => {
  const { delivery, client, res } = fixture(t, { pendingMode: "compact-v1" });
  const write = t.mock.method(res, "write", function (frame) {
    assert.equal(client.activeMode, "normal");
    assert.equal(client.pendingMode, "compact-v1");
    return ResponseDouble.prototype.write.call(this, frame);
  });
  delivery.activateOutputMode(client, " compact-v1 ", "explicit-change");
  assert.equal(write.mock.callCount(), 1);
  assert.deepEqual(events(res.frames), [{
    type: "webui_output_mode", protocolVersion: 1, previousMode: "normal",
    activeMode: "compact-v1", reason: "explicit-change",
  }]);
  assert.equal(client.activeMode, "compact-v1");
  assert.equal(client.pendingMode, undefined);
});

test("mode activation normalizes input and an unchanged mode only clears pending state", (t) => {
  const { delivery, client, res } = fixture(t, { activeMode: "compact-v1", pendingMode: "normal" });
  delivery.activateOutputMode(client, "compact-v1");
  assert.equal(client.pendingMode, undefined);
  assert.deepEqual(res.frames, []);
  delivery.activateOutputMode(client, "invalid");
  assert.deepEqual(events(res.frames), [{
    type: "webui_output_mode", protocolVersion: 1, previousMode: "compact-v1",
    activeMode: "normal", reason: "server-default-change",
  }]);
  assert.equal(client.activeMode, "normal");
});

test("pending mode waits for an accepted semantic barrier", (t) => {
  const { delivery, client, res } = fixture(t, { pendingMode: "compact-v1" });
  const update = { type: "message_update", message: { content: "snapshot" } };
  assert.equal(delivery.sendSseToClient(client, update), true);
  assert.equal(client.activeMode, "normal");
  assert.equal(client.pendingMode, "compact-v1");
  assert.equal(delivery.sendSseToClient(client, { type: "message_end" }), true);
  assert.deepEqual(events(res.frames).map((event) => event.type), [
    "message_update", "message_end", "webui_output_mode",
  ]);
  assert.equal(client.activeMode, "compact-v1");
  assert.equal(client.pendingMode, undefined);
});

for (const type of [
  "message_end", "tool_execution_end", "agent_end", "agent_settled", "compaction_end", "pi_process_exit", "pi_process_error",
]) {
  test(`${type} keeps barrier, mode notification and new-mode frames in queue order`, (t) => {
    const { delivery, client, res } = fixture(t, { writeResults: [false], pendingMode: "compact-v1" });
    const barrier = { type, tabId: "tab-a" };
    assert.equal(delivery.sendSseToClient(client, barrier), true);
    assert.equal(client.activeMode, "compact-v1", "write false still accepts the barrier");
    assert.equal(client.pendingFrames.length, 1);
    assert.equal(delivery.sendSseToClient(client, {
      type: "message_update", message: { content: "snapshot" },
      assistantMessageEvent: { type: "text_delta", delta: "next", partial: {} },
    }), true);
    assert.equal(res.frames.length, 1);
    res.emit("drain");
    assert.deepEqual(events(res.frames), [
      barrier,
      { type: "webui_output_mode", protocolVersion: 1, previousMode: "normal", activeMode: "compact-v1", reason: "server-default-change" },
      { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "next" } },
    ]);
  });
}

test("a queued barrier activates the new mode behind earlier accepted frames", (t) => {
  const { delivery, client, res } = fixture(t, { writeResults: [false], pendingMode: "compact-v1" });
  delivery.sendSseToClient(client, { type: "message_start" });
  assert.equal(delivery.sendSseToClient(client, { type: "agent_end" }), true);
  assert.equal(client.activeMode, "compact-v1");
  assert.equal(client.pendingFrames.length, 2);
  res.emit("drain");
  assert.deepEqual(events(res.frames).map((event) => event.type), [
    "message_start", "agent_end", "webui_output_mode",
  ]);
});

test("suppressed updates and rejected barriers do not activate pending mode", (t) => {
  const f = fixture(t, { activeMode: "compact-v1", pendingMode: "normal" });
  assert.equal(f.delivery.sendSseToClient(f.client, { type: "tool_execution_update" }), false);
  assert.equal(f.client.pendingMode, "normal");
  f.res.writeError = new Error("cannot accept barrier");
  assert.equal(f.delivery.sendSseToClient(f.client, { type: "agent_end" }), false);
  assert.equal(f.client.activeMode, "compact-v1");
  assert.equal(f.client.pendingMode, "normal");
  assert.deepEqual(f.res.frames, []);
  assertEvicted(f);
});

test("queue overflow rejects the barrier without activating pending mode", (t) => {
  const f = fixture(t, { writeResults: [false], pendingMode: "compact-v1" });
  f.delivery.writeSseFrame(f.client, "initial");
  for (let i = 0; i < 256; i += 1) f.delivery.writeSseFrame(f.client, "queued");
  assert.equal(f.delivery.sendSseToClient(f.client, { type: "agent_end" }), false);
  assert.equal(f.client.activeMode, "normal");
  assert.equal(f.client.pendingMode, "compact-v1");
  assertEvicted(f);
});
