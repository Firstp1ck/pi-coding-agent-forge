import assert from "node:assert/strict";
import {
  DEFAULT_STREAM_PENDING_BYTE_LIMIT,
  DEFAULT_STREAM_PENDING_ENTRY_LIMIT,
  TRANSCRIPT_STREAM_MESSAGE_UPDATE_TYPES,
  classifyTranscriptStreamEvent,
  createStreamOutputController,
  reconcileTranscriptThinkingSnapshot,
} from "../public/stream-output-controller.mjs";

function messageUpdate(type, delta = "", extra = {}) {
  return { type: "message_update", assistantMessageEvent: { type, delta, ...extra } };
}

class FakeFrames {
  next = 1;
  callbacks = new Map();
  cancelled = [];

  schedule = (callback) => {
    const handle = this.next++;
    this.callbacks.set(handle, callback);
    return handle;
  };

  cancel = (handle) => {
    this.cancelled.push(handle);
    this.callbacks.delete(handle);
  };

  run(handle = this.callbacks.keys().next().value) {
    const callback = this.callbacks.get(handle);
    assert.equal(typeof callback, "function", `frame ${handle} should be pending`);
    this.callbacks.delete(handle);
    callback();
  }
}

assert.deepEqual(TRANSCRIPT_STREAM_MESSAGE_UPDATE_TYPES, [
  "thinking_start", "thinking_delta", "thinking_end",
  "text_start", "text_delta", "text_end",
  "toolcall_start", "toolcall_delta", "toolcall_end",
  "error",
]);
assert.deepEqual(classifyTranscriptStreamEvent(messageUpdate("text_delta")), {
  kind: "text", subtype: "text_delta", recognized: true, barrier: false,
});
assert.equal(classifyTranscriptStreamEvent(messageUpdate("thinking_end")).barrier, true);
assert.equal(classifyTranscriptStreamEvent(messageUpdate("toolcall_end")).kind, "tool-call");
assert.equal(classifyTranscriptStreamEvent({ type: "tool_execution_update" }).kind, "tool-execution");
assert.deepEqual(classifyTranscriptStreamEvent(messageUpdate("future_delta")), {
  kind: "unknown-message-update", subtype: "future_delta", recognized: false, barrier: false,
});
assert.equal(classifyTranscriptStreamEvent({ type: "agent_start" }), null);
assert.equal(DEFAULT_STREAM_PENDING_ENTRY_LIMIT, 128);
assert.equal(DEFAULT_STREAM_PENDING_BYTE_LIMIT, 256 * 1024);
assert.equal(
  reconcileTranscriptThinkingSnapshot("first\n\nsecond\n\nthird\n\nfourth", "first\n\nsecond\n\nthird"),
  "first\n\nsecond\n\nthird",
  "a final thinking snapshot must remove a discarded streamed tail",
);
assert.equal(reconcileTranscriptThinkingSnapshot("draft", ""), "", "explicit empty thinking clears the draft");
assert.equal(reconcileTranscriptThinkingSnapshot("draft", undefined), "draft", "missing snapshots retain the draft");
assert.equal(reconcileTranscriptThinkingSnapshot("short", "shorter complete"), "shorter complete", "a longer compatible final snapshot should win");
assert.equal(reconcileTranscriptThinkingSnapshot("draft reasoning", "provider correction"), "provider correction", "divergent provider corrections must remain authoritative");

// Adjacent compatible deltas coalesce, while kind changes retain exact order.
{
  const frames = new FakeFrames();
  const calls = [];
  const controller = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    applyTextUpdate: (event) => calls.push(`text:${event.assistantMessageEvent.delta}`),
    applyThinkingUpdate: (event) => calls.push(`thinking:${event.assistantMessageEvent.delta}`),
    applyToolCallUpdate: (event) => calls.push(`tool-call:${event.assistantMessageEvent.delta}`),
    applyToolExecutionUpdate: (event) => calls.push(`tool-execution:${event.partialResult?.content || ""}`),
    applyFollowScroll: () => calls.push("follow"),
  });
  controller.dispatch(messageUpdate("text_delta", "A"));
  controller.dispatch(messageUpdate("text_delta", "B"));
  controller.dispatch(messageUpdate("thinking_delta", "C"));
  controller.dispatch(messageUpdate("thinking_delta", "D"));
  controller.dispatch(messageUpdate("toolcall_delta", "E", { contentIndex: 2, toolCall: { id: "tool-1" } }));
  controller.dispatch(messageUpdate("toolcall_delta", "F", { contentIndex: 2, toolCall: { id: "tool-1" } }));
  controller.dispatch({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: "partial" } });
  controller.dispatch({ type: "tool_execution_update", toolCallId: "tool-1", partialResult: { content: "complete" } });
  assert.equal(frames.callbacks.size, 1, "all raw updates should share one frame");
  assert.equal(controller.pendingCount(), 4, "four adjacent semantic groups should remain");
  frames.run();
  assert.deepEqual(calls, ["text:AB", "thinking:CD", "tool-call:EF", "tool-execution:complete", "follow"]);
}

// A realistic 1,000-delta burst is lossless and bounded to one sink call.
{
  const frames = new FakeFrames();
  const chunks = Array.from({ length: 1_000 }, (_, index) => `[${index}]`);
  const applied = [];
  const controller = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    applyTextUpdate: (event) => applied.push(event.assistantMessageEvent.delta),
  });
  for (let index = 0; index < chunks.length; index += 1) {
    controller.dispatch({ ...messageUpdate("text_delta", chunks[index]), isolationDeltaIndex: index });
  }
  assert.equal(controller.pendingCount(), 1, "adjacent non-empty text deltas should coalesce to one pending entry");
  assert.ok(controller.pendingBytes() <= controller.limits().maxPendingBytes);
  frames.run();
  assert.deepEqual(applied, [chunks.join("")], "coalescing must preserve exact output bytes and order");
}

// First pressure leaves the primary queue within its configured bound and uses
// one explicit urgent slot. Repeated same-task pressure falls back synchronously
// rather than dropping, reordering, or growing another slot.
{
  const frames = new FakeFrames();
  const pressureTasks = new FakeFrames();
  const calls = [];
  const overflows = [];
  const diagnostics = [];
  const controller = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    schedulePressureDrain: pressureTasks.schedule,
    cancelPressureDrain: pressureTasks.cancel,
    maxPendingEntries: 4,
    maxPendingBytes: 10_000,
    applyTextUpdate: (event) => calls.push(`t${event.assistantMessageEvent.delta}`),
    applyThinkingUpdate: (event) => calls.push(`h${event.assistantMessageEvent.delta}`),
    onOverflow: (overflow) => overflows.push(overflow.reason),
    onDiagnostic: (record) => diagnostics.push(record),
  });
  const expected = [];
  for (let index = 0; index < 21; index += 1) {
    const text = index % 2 === 0;
    expected.push(`${text ? "t" : "h"}${index}`);
    controller.dispatch(messageUpdate(text ? "text_delta" : "thinking_delta", String(index)));
    assert.ok(controller.pendingCount() <= controller.limits().maxPendingEntries + controller.limits().maxUrgentEntries);
    assert.ok(controller.pendingBytes() <= controller.limits().maxPendingBytes + controller.limits().maxUrgentBytes);
    if (index === 4) {
      assert.deepEqual(calls, [], "first pressure must not apply inside dispatch");
      assert.equal(pressureTasks.callbacks.size, 1, "first pressure should schedule one urgent drain task");
      assert.equal(controller.hasScheduledPressureDrain(), true);
    }
  }
  controller.barrier("test-overflow-tail");
  assert.deepEqual(calls, expected);
  assert.ok(overflows.includes("entry-limit"));
  assert.ok(diagnostics.some((record) => record.type === "pressure" && record.action === "deferred"));
  assert.ok(diagnostics.some((record) => record.type === "pressure" && record.action === "synchronous-fallback"));
  assert.equal(frames.callbacks.size, 0);
  assert.equal(pressureTasks.callbacks.size, 0);
}

// A single oversize event is applied directly after the prior batch. It is not
// retained beyond the byte bound and no content is lost.
{
  const calls = [];
  const overflows = [];
  const controller = createStreamOutputController({
    maxPendingBytes: 80,
    applyTextUpdate: (event) => calls.push(event.assistantMessageEvent.delta),
    onOverflow: (overflow) => overflows.push(overflow.reason),
  });
  controller.dispatch(messageUpdate("text_delta", "x".repeat(200)));
  assert.equal(controller.pendingCount(), 0);
  assert.equal(controller.pendingBytes(), 0);
  assert.deepEqual(calls, ["x".repeat(200)]);
  assert.ok(overflows.includes("oversize-event"));
}

// Raw and semantic barriers preserve text/thinking/tool/error chronology and
// cancel the retained frame before the transition can mutate chrome.
{
  const frames = new FakeFrames();
  const calls = [];
  const controller = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    applyTextUpdate: (event) => calls.push(`text:${event.assistantMessageEvent.delta}`),
    applyThinkingUpdate: (event) => calls.push(`thinking:${event.assistantMessageEvent.delta}`),
    applyToolExecutionUpdate: (event) => calls.push(`tool:${event.partialResult.content}`),
    applyStreamError: () => calls.push("error"),
    applyFollowScroll: () => calls.push("follow"),
  });
  controller.dispatch(messageUpdate("text_delta", "tail"));
  controller.dispatch(messageUpdate("thinking_delta", "thought"));
  controller.dispatch({ type: "tool_execution_update", toolCallId: "t", partialResult: { content: "tool tail" } });
  const queuedHandle = frames.callbacks.keys().next().value;
  assert.equal(controller.barrier("auto_retry_start"), 3);
  assert.deepEqual(calls, ["text:tail", "thinking:thought", "tool:tool tail", "follow"]);
  assert.ok(frames.cancelled.includes(queuedHandle));
  controller.dispatch(messageUpdate("thinking_delta", "before-end"));
  controller.dispatch(messageUpdate("thinking_end"));
  assert.deepEqual(calls.slice(-3), ["thinking:before-end", "thinking:", "follow"]);
  controller.dispatch(messageUpdate("error"));
  assert.deepEqual(calls.slice(-2), ["error", "follow"], "stream errors must never be dropped by batching");
  controller.dispatch(messageUpdate("text_delta", "abort-tail"));
  const abortHandle = frames.callbacks.keys().next().value;
  assert.equal(controller.barrier("user-abort"), 1);
  assert.deepEqual(calls.slice(-2), ["text:abort-tail", "follow"], "user abort must synchronously preserve a pending text tail");
  assert.ok(frames.cancelled.includes(abortHandle));
}

// Hidden-frame delay preserves the tail; a stale owner is rejected both at
// dispatch and if ownership changes before the delayed frame runs.
{
  const frames = new FakeFrames();
  const calls = [];
  let currentOwner = "tab-a:1";
  const controller = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    isOwnerCurrent: (owner) => owner === currentOwner,
    applyTextUpdate: (event) => calls.push(event.assistantMessageEvent.delta),
    onStaleOwner: (_event, owner) => calls.push(`stale:${owner}`),
  });
  controller.dispatch(messageUpdate("text_delta", "hidden-tail"), { owner: currentOwner });
  assert.deepEqual(calls, [], "a throttled/hidden frame may remain pending without losing output");
  controller.barrier("visibility-barrier");
  assert.deepEqual(calls, ["hidden-tail"]);
  controller.dispatch(messageUpdate("text_delta", "stale-later"), { owner: currentOwner });
  currentOwner = "tab-a:2";
  frames.run();
  assert.deepEqual(calls, ["hidden-tail", "stale:tab-a:1"]);
  assert.equal(controller.dispatch(messageUpdate("text_delta", "stale-now"), { owner: "tab-b:1" }), true);
  assert.deepEqual(calls, ["hidden-tail", "stale:tab-a:1", "stale:tab-b:1"]);
}

// Unknown transcript-shaped events remain isolated but reach the fallback with
// bounded diagnostic metadata; indexed coalesced input reports receipt/apply.
{
  const frames = new FakeFrames();
  const unknown = [];
  const diagnostics = [];
  const controller = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    applyTextUpdate: () => {},
    onUnknownStreamEvent: (event, classification, owner) => unknown.push({ event, classification, owner }),
    onDiagnostic: (record) => diagnostics.push(record),
  });
  controller.dispatch({ ...messageUpdate("text_delta", "A"), isolationDeltaIndex: 0 }, { owner: "tab:1" });
  controller.dispatch({ ...messageUpdate("text_delta", "B"), isolationDeltaIndex: 1 }, { owner: "tab:1" });
  controller.dispatch(messageUpdate("future_delta", "preserve me"), { owner: "tab:1" });
  frames.run();
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].event.assistantMessageEvent.delta, "preserve me");
  assert.equal(unknown[0].classification.subtype, "future_delta");
  const receipts = diagnostics.filter((record) => record.type === "receipt");
  assert.deepEqual(receipts.slice(0, 2).map((record) => record.index), [0, 1]);
  const textApply = diagnostics.find((record) => record.type === "apply" && record.kind === "text");
  assert.equal(textApply.sourceCount, 2);
  assert.deepEqual(textApply.sourceIndexes, [0, 1]);
}

for (const mode of ["normal", "compact-v1"]) {
  const frames = new FakeFrames();
  const seen = [];
  const controller = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    applyTextUpdate: (event) => seen.push(`${mode}:${event.assistantMessageEvent.delta}`),
    applyFollowScroll: () => seen.push(`${mode}:follow`),
  });
  controller.dispatch(messageUpdate("text_delta", "same"));
  controller.dispatch(messageUpdate("text_delta", " output"));
  frames.run();
  assert.deepEqual(seen, [`${mode}:same output`, `${mode}:follow`], `${mode} should use the same coalescing and ordering contract`);
}

// Conservative accounting covers supported Unicode, envelope, content-index,
// tool-ID, structured, and unknown message-update shapes without undercounting
// their JSON UTF-16 representation.
{
  const frames = new FakeFrames();
  const samples = [
    messageUpdate("text_delta", "emoji 😀 and newline\nquote \" slash \\ lone \ud800", { contentIndex: 0, provider: "α" }),
    messageUpdate("future_delta", "unknown", { contentIndex: 7, nested: { values: [1, true, null, "雪"] } }),
    { type: "tool_execution_update", toolCallId: "tool-雪", partialResult: { content: "structured 😀", details: [{ ok: true }] } },
  ];
  for (const sample of samples) {
    const controller = createStreamOutputController({ scheduleFrame: frames.schedule, cancelFrame: frames.cancel });
    controller.dispatch(sample);
    assert.ok(controller.pendingBytes() >= JSON.stringify(sample).length * 2, "supported event accounting must not undercount JSON UTF-16 bytes");
    controller.cancel();
  }
}

// Delta merges add only escaped payload bytes while adopting the incoming
// envelope, exactly matching the merged event even when metadata changes.
{
  const frames = new FakeFrames();
  const first = { ...messageUpdate("text_delta", "A😀", { contentIndex: 3 }), envelope: "old-long-envelope" };
  const second = { ...messageUpdate("text_delta", "\nB", { contentIndex: 3 }), envelope: "new", toolCallId: "ignored-for-text" };
  const expected = {
    ...second,
    assistantMessageEvent: { ...second.assistantMessageEvent, delta: "A😀\nB" },
  };
  const controller = createStreamOutputController({ scheduleFrame: frames.schedule, cancelFrame: frames.cancel });
  controller.dispatch(first);
  controller.dispatch(second);
  assert.equal(controller.pendingCount(), 1);
  assert.ok(controller.pendingBytes() >= JSON.stringify(expected).length * 2);

  controller.dispatch(messageUpdate("text_delta", "different-index", { contentIndex: 4 }));
  assert.equal(controller.pendingCount(), 2, "content-index changes must prevent merging");
  controller.cancel();

  const toolController = createStreamOutputController({ scheduleFrame: frames.schedule, cancelFrame: frames.cancel });
  toolController.dispatch(messageUpdate("toolcall_delta", "{", { contentIndex: 2, toolCall: { id: "tool-a" } }));
  toolController.dispatch(messageUpdate("toolcall_delta", "}", { contentIndex: 2, toolCall: { id: "tool-b" } }));
  assert.equal(toolController.pendingCount(), 2, "tool-call IDs must partition adjacent argument deltas");
  toolController.cancel();
}

// Exact merge limits remain meaningful: the merged representation fits at its
// measured limit, while one byte less uses the bounded urgent pressure slot.
{
  const first = messageUpdate("text_delta", "abc", { contentIndex: 0 });
  const second = messageUpdate("text_delta", "雪😀", { contentIndex: 0 });
  const merged = { ...second, assistantMessageEvent: { ...second.assistantMessageEvent, delta: "abc雪😀" } };
  const exactBytes = JSON.stringify(merged).length * 2;
  const frames = new FakeFrames();
  const pressureTasks = new FakeFrames();
  const exact = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    schedulePressureDrain: pressureTasks.schedule,
    cancelPressureDrain: pressureTasks.cancel,
    maxPendingBytes: exactBytes,
  });
  exact.dispatch(first);
  exact.dispatch(second);
  assert.equal(exact.pendingCount(), 1);
  assert.equal(exact.hasScheduledPressureDrain(), false);
  exact.cancel();

  const constrained = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    schedulePressureDrain: pressureTasks.schedule,
    cancelPressureDrain: pressureTasks.cancel,
    maxPendingBytes: exactBytes - 1,
  });
  constrained.dispatch(first);
  constrained.dispatch(second);
  assert.equal(constrained.pendingCount(), 2, "primary plus one urgent entry should retain both source deltas");
  assert.equal(constrained.hasScheduledPressureDrain(), true);
  constrained.barrier("merge-limit");
}

// Superseding partial tool execution remains latest-wins with accounting based
// on the retained latest structured event.
{
  const frames = new FakeFrames();
  const applied = [];
  const latest = { type: "tool_execution_update", toolCallId: "same", partialResult: { content: "latest 😀", nested: { done: false } } };
  const controller = createStreamOutputController({
    scheduleFrame: frames.schedule,
    cancelFrame: frames.cancel,
    applyToolExecutionUpdate: (event) => applied.push(event.partialResult.content),
  });
  controller.dispatch({ type: "tool_execution_update", toolCallId: "same", partialResult: { content: "older" } });
  controller.dispatch(latest);
  assert.equal(controller.pendingCount(), 1);
  assert.ok(controller.pendingBytes() >= JSON.stringify(latest).length * 2);
  frames.run();
  assert.deepEqual(applied, ["latest 😀"]);
}

assert.throws(() => createStreamOutputController({ maxPendingEntries: 0 }), /positive safe integer/);
assert.throws(() => createStreamOutputController({ maxPendingBytes: -1 }), /positive safe integer/);
assert.throws(() => createStreamOutputController({ schedulePressureDrain: null }), /must be functions/);

console.log("stream-output-controller.test.mjs passed");
