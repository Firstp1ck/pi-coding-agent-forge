import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { createToolCallStreamTracker } from "../public/stream-output-controller.mjs";

const isHiddenTool = (name) => name.trim().toLowerCase() === "intercom";
const tracker = (options = {}) => createToolCallStreamTracker({ isHiddenTool, ...options });
const event = (type, contentIndex, fields = {}) => ({ type: "message_update", assistantMessageEvent: { type, contentIndex, ...fields } });
const end = (contentIndex, id, name, args) => event("toolcall_end", contentIndex, { toolCall: { type: "toolCall", id, name, arguments: args } });

test("snapshot-free starts retain identity across bare deltas and completed arguments", () => {
  const state = tracker();
  const start = event("toolcall_start", 2, { id: "read-1", toolName: "read" });
  const before = structuredClone(start);
  assert.equal(state.ingest(start).id, "read-1");
  state.ingest(event("toolcall_delta", 2, { delta: '{"path":' }));
  const delta = state.ingest(event("toolcall_delta", 2, { delta: '"雪.txt"}' }));
  assert.equal(delta.name, "read");
  assert.equal(delta.id, "read-1");
  assert.equal(delta.rawArguments, '{"path":"雪.txt"}');
  const result = state.ingest(end(2, "read-1", "read", {}));
  assert.equal(result.rawArguments, "{}", "completed arguments replace even a longer streamed draft");
  assert.equal(result.complete, true);
  assert.deepEqual(start, before);
});

test("interleaved content indexes do not exchange names, IDs, or arguments", () => {
  const state = tracker();
  state.ingest(event("toolcall_start", 0, { id: "a", toolName: "read" }));
  state.ingest(event("toolcall_start", 1, { id: "b", toolName: "write" }));
  state.ingest(event("toolcall_delta", 0, { delta: "first" }));
  state.ingest(event("toolcall_delta", 1, { delta: "second" }));
  assert.equal(state.ingest(event("toolcall_delta", 0, { delta: " tail" })).rawArguments, "first tail");
  const second = state.ingest(event("toolcall_delta", 1, { delta: " end" }));
  assert.equal(second.rawArguments, "second end");
  assert.equal(second.name, "write");
  assert.equal(second.id, "b");
});

test("Intercom stays hidden for every bare argument delta without retaining its arguments", () => {
  const state = tracker();
  for (const input of [
    event("toolcall_start", 1, { id: "hidden", toolName: " Intercom " }),
    event("toolcall_delta", 1, { delta: '{"message":"PRIVATE"}' }),
    end(1, "hidden", "intercom", { message: "PRIVATE" }),
  ]) {
    const call = state.ingest(input);
    assert.equal(call.visible, false);
    assert.equal(call.rawArguments, "");
    assert.equal(call.id, "hidden");
  }
  assert.equal(state.ingest(event("toolcall_start", 2, { id: "visible", toolName: "read" })).visible, true);
});

test("v0.84 starts with no metadata defer display until toolcall_end identifies the call", () => {
  for (const name of ["intercom", "read"]) {
    const state = tracker();
    assert.equal(state.ingest(event("toolcall_start", 0)).visible, false);
    const unknown = state.ingest(event("toolcall_delta", 0, { delta: '{"message":"PRIVATE"}' }));
    assert.equal(unknown.visible, false);
    assert.equal(unknown.rawArguments, "", "unidentified arguments must not be retained for display");
    const result = state.ingest(end(0, "identified", name, { path: "file.txt" }));
    assert.equal(result.visible, name === "read");
    assert.equal(result.rawArguments, name === "read" ? JSON.stringify({ path: "file.txt" }, null, 2) : "");
  }
});

test("legacy cumulative snapshots use only the indexed tool block", () => {
  const state = tracker();
  const message = { role: "assistant", content: [
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a.txt" } },
    { type: "toolCall", id: "b", name: "intercom", arguments: { message: "PRIVATE" } },
  ] };
  const call = state.ingest(event("toolcall_start", 0, { partial: message }));
  assert.equal(call.name, "read");
  assert.equal(call.rawArguments, JSON.stringify({ path: "a.txt" }, null, 2));
  assert.equal(state.ingest(event("toolcall_start", 2, { partial: message })).visible, false, "never borrow the last block's identity");
});

test("message resets and replacement calls clear stale identities", () => {
  const state = tracker();
  state.ingest(event("toolcall_start", 0, { id: "a", toolName: "read" }));
  state.ingest(event("toolcall_delta", 0, { delta: "old" }));
  const replaced = state.ingest(event("toolcall_start", 0, { id: "b", toolName: "write" }));
  assert.equal(replaced.rawArguments, "");
  assert.equal(replaced.id, "b");
  state.reset();
  assert.equal(state.ingest(event("toolcall_delta", 0, { delta: "new" })).visible, false);
});

test("retained calls and argument previews are bounded and resettable", () => {
  const state = tracker({ maxCalls: 1, maxArgumentChars: 4 });
  state.ingest(event("toolcall_start", 0, { id: "a", toolName: "read" }));
  const preview = state.ingest(event("toolcall_delta", 0, { delta: "123456" }));
  assert.equal(preview.rawArguments, "1234");
  assert.equal(preview.truncated, true);
  assert.equal(state.ingest(event("toolcall_start", 1, { id: "b", toolName: "write" })), null);
  assert.equal(state.ingest(end(0, "a", "read", {})).truncated, false);
  state.reset();
  assert.equal(state.ingest(event("toolcall_start", 1, { id: "b", toolName: "write" })).visible, true);
  assert.equal(state.ingest(event("toolcall_delta", -1, { delta: "invalid" })), null);
  assert.throws(() => tracker({ maxCalls: 0 }));
});

const app = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0);
  const rest = app.slice(start + 1);
  const next = rest.search(/\n(?:async )?function \w+\(/);
  return app.slice(start, next < 0 ? app.length : start + 1 + next);
}

test("browser tool sink withholds unknown and Intercom calls in normal and compact modes", () => {
  const start = app.indexOf("  applyToolCallUpdate: (event) => {");
  const finish = app.indexOf("  applyToolExecutionUpdate:", start);
  assert.ok(start >= 0 && finish > start);
  for (const compact of [false, true]) {
    const rendered = [];
    const compactEvents = [];
    const context = vm.createContext({
      streamToolCalls: tracker(),
      suppressStreamingAssistantTextBeforeToolCall() {},
      compactOutputActive: () => compact,
      handleCompactMessageUpdate: (input) => compactEvents.push(input),
      rendered,
    });
    vm.runInContext(`
      let streamToolCallSeen = false, streamToolCallBubble = null, streamToolCallText = null;
      let streamToolCallRawArguments = "", streamToolCallName = "", streamToolCallId = "", streamToolCallContentIndex = null, streamToolCallComplete = false;
      function renderStreamingToolCallCard() { rendered.push({ name: streamToolCallName, id: streamToolCallId, args: streamToolCallRawArguments }); }
      ${functionSource("resetStreamingToolCallState")}
      ${functionSource("updateStreamingToolCallFromState")}
      const sink = { ${app.slice(start, finish)} };
      globalThis.apply = sink.applyToolCallUpdate;
    `, context);
    for (const name of [undefined, "intercom"]) {
      context.apply(event("toolcall_start", 0, name ? { id: "hidden", toolName: name } : {}));
      context.apply(event("toolcall_delta", 0, { delta: "PRIVATE" }));
      context.apply(end(0, "hidden", "intercom", { message: "PRIVATE" }));
    }
    assert.equal(rendered.length, 0);
    assert.equal(compactEvents.length, 0);
    context.apply(event("toolcall_start", 1, { id: "visible", toolName: "read" }));
    context.apply(event("toolcall_delta", 1, { delta: "visible args" }));
    if (compact) assert.equal(compactEvents.length, 2);
    else assert.equal(JSON.stringify(rendered.at(-1)), JSON.stringify({ name: "read", id: "visible", args: "visible args" }));
  }
  assert.match(functionSource("resetStreamBubble"), /streamToolCalls\.reset\(\)/);
  assert.match(app, /case "message_end": \{\s+if \(event\.message\?\.role === "assistant"\) streamToolCalls\.reset\(\)/);
});
