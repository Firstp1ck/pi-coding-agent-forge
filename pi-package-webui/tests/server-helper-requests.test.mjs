import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { test } from "node:test";
import * as helperRequests from "../lib/server/helper-requests.mjs";

const { createHelperRequestService, WEBUI_HELPER_COMMAND } = helperRequests;
const responsePrefix = "__PI_WEBUI_HELPER_RESPONSE__:";
const serviceNames = [
  "parseWebuiHelperResponseEvent", "resolveWebuiHelperResponse", "resolveWebuiHelperRpcResponse",
  "webuiHelperRequestMap", "sendWebuiHelperCommand",
];

function notification(payload) {
  return { type: "extension_ui_request", method: "notify", message: responsePrefix + JSON.stringify(payload) };
}

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tabs = [];
  const errors = [];
  const sanitized = [];
  const service = createHelperRequestService({
    makeHttpError(statusCode, message) {
      const error = Object.assign(new Error(message), { statusCode });
      errors.push(error);
      return error;
    },
    sanitizeError(error) {
      sanitized.push(error);
      return "sanitized fixture error";
    },
  });
  function tab(id) {
    const target = {
      id,
      webuiHelperRequests: new Map(),
      webuiHelperResponseIds: new Set(),
      calls: [],
      rpc: {
        send(command, timeoutMs) {
          assert.equal(target.webuiHelperRequests.has(command.id), true, "register before RPC dispatch");
          assert.equal(target.webuiHelperResponseIds.has(command.id), true, "suppress before RPC dispatch");
          return new Promise((resolve, reject) => target.calls.push({ command, timeoutMs, resolve, reject }));
        },
      },
    };
    tabs.push(target);
    return target;
  }
  function send(target, action, payload, timeoutMs) {
    const result = service.sendWebuiHelperCommand(target, action, payload, timeoutMs);
    const call = target.calls.at(-1);
    call.result = result;
    call.state = "pending";
    result.then(() => { call.state = "fulfilled"; }, () => { call.state = "rejected"; });
    return call;
  }
  function acknowledge(target, call, response = { success: true }) {
    const event = { type: "response", command: "prompt", id: call.command.id, ...response };
    assert.equal(service.resolveWebuiHelperRpcResponse(target, event), true);
    call.resolve(event);
    return event;
  }
  function respond(target, call, payload = {}) {
    return service.resolveWebuiHelperResponse(target, notification({ requestId: call.command.id, ...payload }));
  }
  t.after(async () => {
    const disposed = new Error("Disposed helper fixture");
    for (const target of tabs) {
      for (const call of target.calls) call.reject(disposed);
      for (const pending of target.webuiHelperRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(disposed);
      }
      target.webuiHelperRequests.clear();
      target.webuiHelperResponseIds.clear();
    }
    await Promise.allSettled(tabs.flatMap((target) => target.calls.map((call) => call.result)));
  });
  return { service, tab, send, acknowledge, respond, errors, sanitized };
}

function httpError(statusCode, message) {
  return (error) => error.statusCode === statusCode && error.message === message;
}

test("import and factory expose the L3 contract without timers or dependency calls", { timeout: 1_000 }, async (t) => {
  const timer = t.mock.method(globalThis, "setTimeout", () => { throw new Error("Unexpected timer"); });
  const interval = t.mock.method(globalThis, "setInterval", () => { throw new Error("Unexpected interval"); });
  const freshModule = await import("../lib/server/helper-requests.mjs?inert-import");
  const dependency = t.mock.fn(() => { throw new Error("Unexpected dependency call"); });
  const service = freshModule.createHelperRequestService({ makeHttpError: dependency, sanitizeError: dependency });
  assert.deepEqual(Object.keys(freshModule).sort(), ["WEBUI_HELPER_COMMAND", "createHelperRequestService"]);
  assert.deepEqual(Object.keys(service).sort(), [...serviceNames].sort());
  assert.equal(WEBUI_HELPER_COMMAND, "webui-helper");
  assert.equal(timer.mock.callCount(), 0);
  assert.equal(interval.mock.callCount(), 0);
  assert.equal(dependency.mock.callCount(), 0);
});

test("request maps are the real tab records and are lazy without creating suppression Sets", (t) => {
  const { service } = fixture(t);
  const existing = new Map([["existing", {}]]);
  const initialized = { webuiHelperRequests: existing, webuiHelperResponseIds: new Set(["existing"]) };
  assert.equal(service.webuiHelperRequestMap(initialized), existing);
  assert.deepEqual([...initialized.webuiHelperResponseIds], ["existing"]);
  const target = {};
  const requests = service.webuiHelperRequestMap(target);
  assert.ok(requests instanceof Map);
  assert.equal(service.webuiHelperRequestMap(target), requests);
  assert.equal(target.webuiHelperRequests, requests);
  assert.equal(target.webuiHelperResponseIds, undefined);
});

test("prompt and helper share one UUID and successful RPC alone cannot finish the request", { timeout: 1_000 }, async (t) => {
  const { service, tab, send, acknowledge, respond, errors } = fixture(t);
  const target = tab("a");
  const map = target.webuiHelperRequests;
  const ids = target.webuiHelperResponseIds;
  const call = send(target, "tools-state");
  assert.match(call.command.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(call.command.type, "prompt");
  assert.deepEqual(JSON.parse(call.command.message.slice(`/${WEBUI_HELPER_COMMAND} `.length)), {
    requestId: call.command.id, action: "tools-state", payload: {},
  });
  assert.ok(call.command.message.startsWith(`/${WEBUI_HELPER_COMMAND} `));
  assert.equal(call.timeoutMs, 8_000);
  const event = acknowledge(target, call);
  await nextTurn();
  assert.equal(call.state, "pending");
  assert.equal(map.size, 1);
  assert.equal(ids.size, 0);
  assert.equal(service.resolveWebuiHelperRpcResponse(target, event), false, "consume RPC only once");
  const data = { tools: ["read"], marker: "exact object" };
  assert.equal(respond(target, call, { ok: true, data }), true);
  assert.deepEqual(await call.result, data);
  assert.equal(target.webuiHelperRequests, map);
  assert.equal(target.webuiHelperResponseIds, ids);
  assert.equal(map.size, 0);
  t.mock.timers.tick(8_001);
  assert.deepEqual(errors, [], "successful response cancels the helper timeout");
});

test("overlapping requests in two tabs resolve out of order without cross-tab suppression", { timeout: 1_000 }, async (t) => {
  const { service, tab, send, acknowledge, respond } = fixture(t);
  const a = tab("a");
  const b = tab("b");
  const a1 = send(a, "tools-set", { enabledTools: ["read"] }, 31);
  const a2 = send(a, "skills-state", {}, 47);
  const b1 = send(b, "tools-state", {}, 59);
  assert.equal(new Set([a1.command.id, a2.command.id, b1.command.id]).size, 3);
  assert.deepEqual(JSON.parse(a1.command.message.slice(`/${WEBUI_HELPER_COMMAND} `.length)).payload, { enabledTools: ["read"] });
  assert.equal(respond(b, a1, { data: { wrong: true } }), true, "unmatched helper notices are consumed");
  assert.equal(service.resolveWebuiHelperRpcResponse(b, { type: "response", command: "prompt", id: a1.command.id }), false);
  assert.equal(a.webuiHelperRequests.size, 2);
  assert.equal(b.webuiHelperRequests.size, 1);
  acknowledge(a, a2);
  respond(a, a2, { data: { result: "a2" } });
  assert.deepEqual(await a2.result, { result: "a2" });
  assert.deepEqual([...a.webuiHelperRequests.keys()], [a1.command.id]);
  respond(b, b1, { data: { result: "b1" } });
  acknowledge(b, b1);
  assert.deepEqual(await b1.result, { result: "b1" });
  acknowledge(a, a1);
  respond(a, a1, { data: { result: "a1" } });
  assert.deepEqual(await a1.result, { result: "a1" });
  assert.equal(a.webuiHelperRequests.size + b.webuiHelperRequests.size, 0);
  assert.equal(a.webuiHelperResponseIds.size + b.webuiHelperResponseIds.size, 0);
});

test("notification before RPC waits for RPC, cancels its timer and retains response suppression", { timeout: 1_000 }, async (t) => {
  const { tab, send, acknowledge, respond, errors } = fixture(t);
  const target = tab("a");
  const call = send(target, "sampling-state", {}, 25);
  assert.equal(respond(target, call, { data: { value: "helper first" } }), true);
  assert.equal(target.webuiHelperRequests.size, 0);
  assert.deepEqual([...target.webuiHelperResponseIds], [call.command.id]);
  t.mock.timers.tick(26);
  await nextTurn();
  assert.equal(call.state, "pending");
  assert.deepEqual(errors, []);
  acknowledge(target, call);
  assert.deepEqual(await call.result, { value: "helper first" });
  assert.equal(target.webuiHelperResponseIds.size, 0);
});

test("helper failures wait for RPC and use existing error and fallback payload semantics", { timeout: 1_000 }, async (t) => {
  const { tab, send, acknowledge, respond } = fixture(t);
  const target = tab("a");
  for (const error of ["Helper refused", ""]) {
    const call = send(target, "tools-set");
    respond(target, call, { ok: false, error });
    await nextTurn();
    assert.equal(call.state, "pending");
    acknowledge(target, call);
    await assert.rejects(call.result, httpError(400, error || "Web UI helper command failed"));
    assert.equal(target.webuiHelperResponseIds.size, 0);
  }
  for (const data of [undefined, null, false, 0, "", ["kept"], "kept"]) {
    const call = send(target, "tools-state");
    acknowledge(target, call);
    respond(target, call, { data });
    assert.deepEqual(await call.result, data || {});
  }
});

test("unsuccessful prompt responses clean pending state with existing HTTP errors", { timeout: 1_000 }, async (t) => {
  const { tab, send, acknowledge, errors } = fixture(t);
  const target = tab("a");
  for (const error of ["Prompt refused", ""]) {
    const call = send(target, "tools-state", {}, 20);
    acknowledge(target, call, { success: false, error });
    await assert.rejects(call.result, httpError(400, error || "Web UI helper action failed: tools-state"));
    assert.equal(target.webuiHelperRequests.size, 0);
    assert.equal(target.webuiHelperResponseIds.size, 0);
  }
  assert.equal(errors.length, 2);
  t.mock.timers.tick(21);
  assert.equal(errors.length, 2, "prompt failures cancel their timers");
});

test("prompt exceptions preserve the thrown error and clean only the failed request", { timeout: 1_000 }, async (t) => {
  const { tab, send, acknowledge, respond, errors } = fixture(t);
  const target = tab("a");
  const survivor = send(target, "skills-state", {}, 50);
  const failed = send(target, "tools-state", {}, 20);
  const failure = new Error("RPC transport failed");
  failed.reject(failure);
  await assert.rejects(failed.result, (error) => error === failure);
  assert.deepEqual([...target.webuiHelperRequests.keys()], [survivor.command.id]);
  assert.deepEqual([...target.webuiHelperResponseIds], [survivor.command.id]);
  t.mock.timers.tick(21);
  assert.deepEqual(errors, []);
  acknowledge(target, survivor);
  respond(target, survivor);
  assert.deepEqual(await survivor.result, {});
  target.rpc.send = () => { throw failure; };
  await assert.rejects(createHelperRequestService({ makeHttpError: assert.fail, sanitizeError: assert.fail })
    .sendWebuiHelperCommand(target, "tools-state", {}, 20), (error) => error === failure);
  assert.equal(target.webuiHelperRequests.size, 0);
  assert.equal(target.webuiHelperResponseIds.size, 0);
  t.mock.timers.tick(21);
  assert.deepEqual(errors, []);
});

test("prompt failure still wins after a successful helper notification", { timeout: 1_000 }, async (t) => {
  const { tab, send, respond, errors } = fixture(t);
  const target = tab("a");
  const call = send(target, "tools-state", {}, 20);
  respond(target, call, { data: { premature: true } });
  const failure = new Error("RPC failed after helper notification");
  call.reject(failure);
  await assert.rejects(call.result, (error) => error === failure);
  assert.equal(target.webuiHelperRequests.size, 0);
  assert.equal(target.webuiHelperResponseIds.size, 0);
  t.mock.timers.tick(21);
  assert.deepEqual(errors, []);
});

test("malformed and unmatched helper notifications are consumed without settling other requests", { timeout: 1_000 }, async (t) => {
  const { service, tab, send, acknowledge, respond, sanitized } = fixture(t);
  const target = tab("a");
  const call = send(target, "tools-state");
  acknowledge(target, call);
  const malformed = { type: "extension_ui_request", method: "notify", message: responsePrefix + "{" };
  assert.deepEqual(service.parseWebuiHelperResponseEvent(malformed), {
    ok: false, error: "Invalid Web UI helper response: sanitized fixture error",
  });
  assert.ok(sanitized[0] instanceof SyntaxError);
  for (const event of [malformed, notification({ requestId: "unknown", data: { ignored: true } }),
    notification({}), notification([]), notification("truthy payload"), notification({ requestId: 23 })]) {
    assert.equal(service.resolveWebuiHelperResponse(target, event), true);
  }
  for (const payload of [null, false, 0, ""]) {
    assert.equal(service.parseWebuiHelperResponseEvent(notification(payload)), payload);
    assert.equal(service.resolveWebuiHelperResponse(target, notification(payload)), false);
  }
  await nextTurn();
  assert.equal(call.state, "pending");
  assert.deepEqual([...target.webuiHelperRequests.keys()], [call.command.id]);
  respond(target, call, { data: { accepted: true } });
  assert.deepEqual(await call.result, { accepted: true });
  assert.equal(respond(target, call, { ok: false, error: "duplicate" }), true);
  assert.equal(service.resolveWebuiHelperResponse(undefined, notification({ requestId: "unknown" })), true);
});

test("unrelated notifications and RPC responses preserve active suppression IDs", { timeout: 1_000 }, async (t) => {
  const { service, tab, send, acknowledge, respond } = fixture(t);
  const target = tab("a");
  const call = send(target, "tools-state");
  for (const event of [null, {}, { type: "response" }, { type: "extension_ui_request", method: "setStatus", message: responsePrefix + "{}" },
    { type: "extension_ui_request", method: "notify" }, { type: "extension_ui_request", method: "notify", message: "ordinary notice" },
    { type: "extension_ui_request", method: "notify", message: " " + responsePrefix + "{}" }]) {
    assert.equal(service.parseWebuiHelperResponseEvent(event), undefined);
    assert.equal(service.resolveWebuiHelperResponse(target, event), false);
  }
  for (const event of [null, {}, { type: "response", command: "get_state", id: call.command.id },
    { type: "other", command: "prompt", id: call.command.id }, { type: "response", command: "prompt" },
    { type: "response", command: "prompt", id: "unknown" }]) {
    assert.equal(service.resolveWebuiHelperRpcResponse(target, event), false);
  }
  assert.deepEqual([...target.webuiHelperResponseIds], [call.command.id]);
  acknowledge(target, call);
  respond(target, call);
  await call.result;
  assert.equal(service.resolveWebuiHelperRpcResponse({ webuiHelperResponseIds: new Set(["23"]) },
    { type: "response", command: "prompt", id: 23 }), true);
  assert.equal(service.resolveWebuiHelperRpcResponse(undefined, { type: "response", command: "prompt", id: "unknown" }), false);
});

test("helper timeout removes only its request and suppression ID, then ignores late responses", { timeout: 1_000 }, async (t) => {
  const { service, tab, send, acknowledge, respond, errors } = fixture(t);
  const target = tab("a");
  const expired = send(target, "tools-state", {}, 20);
  const survivor = send(target, "skills-state", {}, 50);
  expired.resolve({ success: true });
  await nextTurn();
  t.mock.timers.tick(19);
  assert.equal(expired.state, "pending");
  t.mock.timers.tick(1);
  await assert.rejects(expired.result, httpError(504, "Timed out waiting for Web UI helper action: tools-state. Try /reload in this tab, then retry."));
  assert.deepEqual([...target.webuiHelperRequests.keys()], [survivor.command.id]);
  assert.deepEqual([...target.webuiHelperResponseIds], [survivor.command.id]);
  assert.equal(service.resolveWebuiHelperRpcResponse(target, { type: "response", command: "prompt", id: expired.command.id }), false);
  assert.equal(respond(target, expired, { data: { late: true } }), true);
  acknowledge(target, survivor);
  respond(target, survivor);
  await survivor.result;
  t.mock.timers.tick(100);
  assert.equal(errors.length, 1);
});

test("default helper deadline is eight seconds and RPC still gates an earlier timeout", { timeout: 1_000 }, async (t) => {
  const { tab, send, errors } = fixture(t);
  const target = tab("a");
  const call = send(target, "skills-state");
  t.mock.timers.tick(7_999);
  assert.equal(target.webuiHelperRequests.size, 1);
  t.mock.timers.tick(1);
  await nextTurn();
  assert.equal(target.webuiHelperRequests.size, 0);
  assert.equal(target.webuiHelperResponseIds.size, 0);
  assert.equal(call.state, "pending", "the helper timeout does not replace RPC settlement");
  call.resolve({ success: true });
  await assert.rejects(call.result, httpError(504, "Timed out waiting for Web UI helper action: skills-state. Try /reload in this tab, then retry."));
  assert.equal(errors.length, 1);
});

test("separate factories and parent reset events retain tab-owned requests until ordinary completion", { timeout: 1_000 }, async (t) => {
  const { service, tab, send, acknowledge } = fixture(t);
  const target = tab("a");
  const call = send(target, "tools-state");
  for (const event of [{ type: "pi_process_exit" }, { type: "pi_process_error" }, { type: "session_start" }]) {
    assert.equal(service.resolveWebuiHelperResponse(target, event), false);
    assert.equal(service.resolveWebuiHelperRpcResponse(target, event), false);
  }
  assert.equal(target.webuiHelperRequests.size, 1);
  assert.equal(target.webuiHelperResponseIds.size, 1);
  const secondService = createHelperRequestService({ makeHttpError: assert.fail, sanitizeError: assert.fail });
  assert.equal(secondService.webuiHelperRequestMap(target), target.webuiHelperRequests);
  assert.equal(secondService.resolveWebuiHelperResponse(target, notification({ requestId: call.command.id, data: { retained: true } })), true);
  acknowledge(target, call);
  assert.deepEqual(await call.result, { retained: true });
});
