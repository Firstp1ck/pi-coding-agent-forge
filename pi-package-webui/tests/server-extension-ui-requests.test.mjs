import assert from "node:assert/strict";
import test from "node:test";
import * as adapter from "../lib/server/extension-ui-requests.mjs";

const serviceFunctions = [
  "pendingExtensionUiMap",
  "isPendingExtensionUiRequest",
  "pruneExpiredPendingExtensionUiRequests",
  "pendingExtensionUiRequests",
  "pendingExtensionUiRequestSummaries",
  "trackPendingExtensionUiRequest",
  "resolvePendingExtensionUiRequest",
  "clearPendingExtensionUiRequests",
  "replayPendingExtensionUiRequests",
  "cancelPendingExtensionUiRequests",
];
const now = Date.parse("2026-11-15T12:00:00.000Z");

function fixture(t) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const calls = { truncate: [], working: [], sse: [], snapshots: [], broadcasts: [], writes: [] };
  const f = { calls, write: () => {}, send: () => {}, broadcast: () => {} };
  f.dependencies = {
    truncateStatusText(value, maxLength) {
      calls.truncate.push({ value, maxLength });
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
    },
    markTabWorking(tab, timestamp) {
      calls.working.push({ tab, timestamp });
      tab.activity = { ...tab.activity, status: "working", isWorking: true, lastStartedAt: timestamp };
    },
    sendSseToClient(client, event) {
      calls.sse.push({ client, event });
      return f.send(client, event);
    },
    tabActivitySnapshot(tab) {
      calls.snapshots.push(tab);
      return { ...tab.activity };
    },
    broadcastTabEvent(tab, event) {
      calls.broadcasts.push({ tab, event });
      return f.broadcast(tab, event);
    },
  };
  f.tab = (id) => {
    const tab = { id, title: `Title ${id}`, activity: { status: "idle", isWorking: false } };
    tab.rpc = {
      writeRaw(payload) {
        calls.writes.push({ tab, payload });
        return f.write(tab, payload);
      },
    };
    return tab;
  };
  f.service = adapter.createExtensionUiRequestService(f.dependencies);
  return f;
}

function request(id, patch = {}) {
  return { type: "extension_ui_request", method: "confirm", id, ...patch };
}

test("the module and inert factory expose exactly the fixed API", () => {
  assert.deepEqual(Object.keys(adapter), ["createExtensionUiRequestService"]);
  const unexpected = () => assert.fail("factory must not invoke dependencies");
  const service = adapter.createExtensionUiRequestService({
    truncateStatusText: unexpected,
    markTabWorking: unexpected,
    sendSseToClient: unexpected,
    tabActivitySnapshot: unexpected,
    broadcastTabEvent: unexpected,
  });
  assert.deepEqual(Object.keys(service).sort(), [...serviceFunctions].sort());
  for (const fn of Object.values(service)) assert.equal(typeof fn, "function");
});

test("maps stay on the original tabs and are shared across service instances", (t) => {
  const f = fixture(t);
  const a = f.tab("a");
  const b = f.tab("b");
  const map = f.service.pendingExtensionUiMap(a);
  assert.ok(map instanceof Map);
  assert.equal(map, a.pendingExtensionUiRequests);
  assert.equal(f.service.pendingExtensionUiMap(a), map);
  const second = adapter.createExtensionUiRequestService(f.dependencies);
  assert.equal(second.pendingExtensionUiMap(a), map);
  assert.notEqual(second.pendingExtensionUiMap(b), map);
  assert.deepEqual(f.calls.working, []);
});

test("only the four blocking methods with truthy IDs qualify, retaining the ID return value", (t) => {
  const { service } = fixture(t);
  for (const method of ["select", "confirm", "input", "editor"]) {
    assert.equal(service.isPendingExtensionUiRequest(request("original", { method })), "original");
    assert.equal(service.isPendingExtensionUiRequest(request(17, { method })), 17);
  }
  for (const event of [undefined, null, {}, request("id", { type: "notification" }),
    request("id", { method: "notify" }), request("id", { method: "setStatus" }),
    request("id", { method: "setWidget" }), request("id", { method: "Confirm" })]) {
    assert.equal(service.isPendingExtensionUiRequest(event), false);
  }
  for (const id of [0, "", false, null, undefined]) {
    assert.equal(service.isPendingExtensionUiRequest(request(id)), id);
  }
});

test("duplicate IDs are scoped by tab while keys use String and payloads retain original IDs", (t) => {
  const f = fixture(t);
  const a = f.tab("a");
  const b = f.tab("b");
  const original = Object.freeze(request(17, { tabId: "a", title: "A approval" }));
  f.service.trackPendingExtensionUiRequest(a, original);
  f.service.trackPendingExtensionUiRequest(b, request(17, { tabId: "b", title: "B approval" }));
  assert.equal(a.pendingExtensionUiRequests.get("17").id, 17);
  assert.equal(b.pendingExtensionUiRequests.get("17").tabId, "b");
  assert.equal(original.receivedAt, undefined);
  assert.notEqual(a.pendingExtensionUiRequests.get("17"), original);
  f.service.trackPendingExtensionUiRequest(a, request("17", { title: "A replacement" }));
  assert.equal(a.pendingExtensionUiRequests.size, 1);
  assert.equal(a.pendingExtensionUiRequests.get("17").id, "17");
  assert.equal(b.pendingExtensionUiRequests.get("17").title, "B approval");
  assert.deepEqual(f.calls.working.map(({ tab }) => tab), [a, b]);
  assert.equal(f.service.resolvePendingExtensionUiRequest(a, 17), true);
  assert.equal(f.service.resolvePendingExtensionUiRequest(a, "17"), false);
  assert.equal(b.pendingExtensionUiRequests.size, 1);
});

test("tracking starts work only for accepted blockers on an idle tab", (t) => {
  const f = fixture(t);
  const tab = f.tab("activity");
  for (const event of [request("notice", { method: "notify" }), request(0), null]) {
    f.service.trackPendingExtensionUiRequest(tab, event);
  }
  assert.equal(tab.pendingExtensionUiRequests, undefined);
  assert.deepEqual(f.calls.working, []);
  f.service.trackPendingExtensionUiRequest(tab, request("first"));
  assert.deepEqual(f.calls.working, [{ tab, timestamp: new Date(now).toISOString() }]);
  const activity = tab.activity;
  f.service.trackPendingExtensionUiRequest(tab, request("second"));
  assert.equal(tab.activity, activity);
  assert.equal(f.calls.working.length, 1);
  delete tab.activity;
  f.service.trackPendingExtensionUiRequest(tab, request("third"));
  assert.equal(f.calls.working.length, 2);
  assert.deepEqual(f.calls.broadcasts, []);
});

test("timeouts use Number conversion and add exactly one second of grace", (t) => {
  const f = fixture(t);
  const tab = f.tab("timeouts");
  const cases = [
    [250, 1250], ["300", 1300], [true, 1001],
    [undefined, undefined], [null, undefined], ["", undefined], [0, undefined],
    [-2, undefined], ["invalid", undefined], [Infinity, undefined], [NaN, undefined],
  ];
  for (const [index, [timeout, delta]] of cases.entries()) {
    f.service.trackPendingExtensionUiRequest(tab, request(index + 1, {
      timeout, receivedAt: "old", expiresAt: "old",
    }));
    const pending = tab.pendingExtensionUiRequests.get(String(index + 1));
    assert.equal(pending.timeout, timeout);
    assert.equal(pending.receivedAt, new Date(now).toISOString());
    assert.equal(pending.expiresAt, delta === undefined ? undefined : new Date(now + delta).toISOString());
  }
});

test("expiry prunes at the deadline and keeps missing or invalid expiry dates", (t) => {
  const f = fixture(t);
  const tab = f.tab("expiry");
  f.service.trackPendingExtensionUiRequest(tab, request("timed", { timeout: 200 }));
  f.service.trackPendingExtensionUiRequest(tab, request("indefinite"));
  tab.pendingExtensionUiRequests.set("invalid", request("invalid", { expiresAt: "bad date" }));
  const activity = tab.activity;
  f.service.pruneExpiredPendingExtensionUiRequests(tab, now + 1199);
  assert.equal(tab.pendingExtensionUiRequests.size, 3);
  f.service.pruneExpiredPendingExtensionUiRequests(tab, now + 1200);
  assert.deepEqual(f.service.pendingExtensionUiRequests(tab).map(({ id }) => id), ["indefinite", "invalid"]);
  f.service.trackPendingExtensionUiRequest(tab, request("read-pruned", { timeout: 1 }));
  t.mock.timers.tick(1001);
  assert.deepEqual(f.service.pendingExtensionUiRequests(tab).map(({ id }) => id), ["indefinite", "invalid"]);
  assert.equal(tab.activity, activity);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.broadcasts, []);
});

test("empty reads, pruning, clearing and resolution do not initialize maps", (t) => {
  const f = fixture(t);
  const tab = f.tab("empty");
  for (const target of [tab, undefined, null]) {
    assert.deepEqual(f.service.pendingExtensionUiRequests(target), []);
    assert.deepEqual(f.service.pendingExtensionUiRequestSummaries(target), []);
    assert.equal(f.service.pruneExpiredPendingExtensionUiRequests(target), undefined);
    assert.equal(f.service.clearPendingExtensionUiRequests(target), undefined);
    assert.equal(f.service.resolvePendingExtensionUiRequest(target, "missing"), false);
  }
  assert.equal(tab.pendingExtensionUiRequests, undefined);
});

test("summaries preserve IDs and timestamps and use the injected title and message bounds", (t) => {
  const f = fixture(t);
  const tab = f.tab("summaries");
  const title = `  ${"T".repeat(150)}\n `;
  const message = `  ${"M".repeat(210)}\n `;
  f.service.trackPendingExtensionUiRequest(tab, request(21, { title, message, timeout: 500, options: ["private"] }));
  f.service.trackPendingExtensionUiRequest(tab, request("fallback", { title: "", placeholder: "  Your\n name ", message: "" }));
  f.service.trackPendingExtensionUiRequest(tab, request("blank", { message: 0 }));
  f.service.trackPendingExtensionUiRequest(tab, request("expired", { timeout: 1 }));
  t.mock.timers.tick(1001);
  assert.deepEqual(f.service.pendingExtensionUiRequestSummaries(tab), [
    { id: 21, method: "confirm", title: `${"T".repeat(119)}…`, message: `${"M".repeat(179)}…`,
      receivedAt: new Date(now).toISOString(), expiresAt: new Date(now + 1500).toISOString() },
    { id: "fallback", method: "confirm", title: "Your name", message: undefined,
      receivedAt: new Date(now).toISOString(), expiresAt: undefined },
    { id: "blank", method: "confirm", title: "", message: undefined,
      receivedAt: new Date(now).toISOString(), expiresAt: undefined },
  ]);
  assert.deepEqual(f.calls.truncate, [
    { value: title, maxLength: 120 }, { value: message, maxLength: 180 },
    { value: "  Your\n name ", maxLength: 120 }, { value: "", maxLength: 120 },
  ]);
  assert.equal(tab.pendingExtensionUiRequests.get("21").title, title);
  assert.deepEqual(tab.pendingExtensionUiRequests.get("21").options, ["private"]);
});

test("resolution and clearing keep activity, map identity and other tabs unchanged", (t) => {
  const f = fixture(t);
  const a = f.tab("a");
  const b = f.tab("b");
  f.service.trackPendingExtensionUiRequest(a, request("shared"));
  f.service.trackPendingExtensionUiRequest(b, request("shared"));
  for (const id of [undefined, null, false, 0, ""]) {
    assert.equal(f.service.resolvePendingExtensionUiRequest(a, id), false);
  }
  const map = a.pendingExtensionUiRequests;
  const activity = a.activity;
  f.service.clearPendingExtensionUiRequests(a);
  f.service.clearPendingExtensionUiRequests(a);
  assert.equal(a.pendingExtensionUiRequests, map);
  assert.equal(map.size, 0);
  assert.equal(a.activity, activity);
  assert.equal(b.pendingExtensionUiRequests.size, 1);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.broadcasts, []);
});

test("replay uses current tab identity, original payload IDs and ordered live requests", (t) => {
  const f = fixture(t);
  const a = f.tab("a");
  const b = f.tab("b");
  const client = { id: "reconnected" };
  f.service.trackPendingExtensionUiRequest(a, request("expired", { timeout: 1 }));
  f.service.trackPendingExtensionUiRequest(a, request(31, {
    method: "select", options: ["one", "two"], tabId: "stale", tabTitle: "Old title",
    tabActivity: { status: "stale" }, replayed: false, pendingExtensionUiRequestCount: 99,
  }));
  f.service.trackPendingExtensionUiRequest(a, request("second", { method: "editor", title: "Edit", value: "original text" }));
  f.service.trackPendingExtensionUiRequest(b, request(31));
  t.mock.timers.tick(1001);
  a.title = "Renamed";
  const pending = f.service.pendingExtensionUiRequests(a);
  f.service.replayPendingExtensionUiRequests(a, client);
  assert.deepEqual(f.calls.sse, pending.map((entry) => ({
    client,
    event: { ...entry, type: "extension_ui_request", replayed: true, tabId: "a", tabTitle: "Renamed",
      pendingExtensionUiRequestCount: 2, tabActivity: { ...a.activity } },
  })));
  assert.equal(f.calls.sse[0].event.id, 31);
  assert.equal(f.calls.sse[0].client, client);
  assert.deepEqual(f.calls.snapshots, [a, a]);
  assert.equal(a.pendingExtensionUiRequests.get("31").tabId, "stale");
  assert.equal(b.pendingExtensionUiRequests.size, 1);
  assert.deepEqual(f.calls.writes, []);
  assert.deepEqual(f.calls.broadcasts, []);
});

test("replay preserves pending requests if SSE delivery throws", (t) => {
  const f = fixture(t);
  const tab = f.tab("replay-error");
  f.service.trackPendingExtensionUiRequest(tab, request("pending"));
  const error = new Error("SSE write failed");
  f.send = () => { throw error; };
  assert.throws(() => f.service.replayPendingExtensionUiRequests(tab, {}), (thrown) => thrown === error);
  assert.equal(tab.pendingExtensionUiRequests.size, 1);
});

test("empty replay and cancellation have no delivery or activity effects", async (t) => {
  const f = fixture(t);
  const tab = f.tab("empty-cancel");
  f.service.replayPendingExtensionUiRequests(tab, {});
  assert.equal(await f.service.cancelPendingExtensionUiRequests(tab), 0);
  assert.equal(await f.service.cancelPendingExtensionUiRequests(undefined), 0);
  assert.equal(tab.pendingExtensionUiRequests, undefined);
  assert.deepEqual(f.calls, { truncate: [], working: [], sse: [], snapshots: [], broadcasts: [], writes: [] });
});

test("cancellation continues after sync and async write errors and broadcasts string IDs", async (t) => {
  const f = fixture(t);
  const a = f.tab("a");
  const b = f.tab("b");
  f.service.trackPendingExtensionUiRequest(a, request("expired", { timeout: 1 }));
  for (const id of [41, "rejected", "ok"]) f.service.trackPendingExtensionUiRequest(a, request(id));
  f.service.trackPendingExtensionUiRequest(b, request(41));
  t.mock.timers.tick(1001);
  const seen = [];
  f.write = (target, payload) => {
    assert.equal(target, a);
    assert.equal(target.pendingExtensionUiRequests.has(String(payload.id)), true);
    for (const id of seen) assert.equal(target.pendingExtensionUiRequests.has(String(id)), false);
    seen.push(payload.id);
    if (payload.id === 41) throw new Error("process exited");
    if (payload.id === "rejected") return Promise.reject(new Error("write rejected"));
  };
  const activity = a.activity;
  assert.equal(await f.service.cancelPendingExtensionUiRequests(a), 3);
  assert.deepEqual(f.calls.writes, [41, "rejected", "ok"].map((id) => ({
    tab: a, payload: { type: "extension_ui_response", id, cancelled: true },
  })));
  assert.equal(a.pendingExtensionUiRequests.size, 0);
  assert.equal(b.pendingExtensionUiRequests.size, 1);
  assert.equal(a.activity, activity);
  assert.deepEqual(f.calls.broadcasts, [{ tab: a, event: {
    type: "webui_extension_ui_cancelled", tabId: "a", tabTitle: "Title a",
    ids: ["41", "rejected", "ok"], pendingExtensionUiRequestCount: 0, tabActivity: { ...activity },
  } }]);
  assert.deepEqual(f.calls.snapshots, [a]);
});

test("cancellation waits for the RPC write before removing the request", { timeout: 1000 }, async (t) => {
  const f = fixture(t);
  const tab = f.tab("waiting");
  f.service.trackPendingExtensionUiRequest(tab, request("pending"));
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  f.write = () => gate.promise;
  const cancelling = f.service.cancelPendingExtensionUiRequests(tab);
  assert.equal(tab.pendingExtensionUiRequests.size, 1);
  assert.equal(f.calls.broadcasts.length, 0);
  gate.resolve();
  assert.equal(await cancelling, 1);
  assert.equal(tab.pendingExtensionUiRequests.size, 0);
  assert.equal(f.calls.broadcasts.length, 1);
});

test("cancellation tolerates a missing RPC but propagates broadcast failures after removal", async (t) => {
  const f = fixture(t);
  const tab = f.tab("missing-rpc");
  f.service.trackPendingExtensionUiRequest(tab, request("pending"));
  delete tab.rpc;
  assert.equal(await f.service.cancelPendingExtensionUiRequests(tab), 1);
  assert.equal(tab.pendingExtensionUiRequests.size, 0);
  f.service.trackPendingExtensionUiRequest(tab, request("next"));
  const error = new Error("broadcast failed");
  f.broadcast = () => { throw error; };
  await assert.rejects(f.service.cancelPendingExtensionUiRequests(tab), (thrown) => thrown === error);
  assert.equal(tab.pendingExtensionUiRequests.size, 0);
});
