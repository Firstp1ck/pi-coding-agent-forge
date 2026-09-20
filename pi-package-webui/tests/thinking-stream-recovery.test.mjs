import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { ThinkingStreamRecovery, reconcileThinkingSnapshot } from "../lib/thinking-stream-recovery.mjs";

function update(type, fields = {}) {
  return { type: "message_update", assistantMessageEvent: { type, contentIndex: 0, ...fields } };
}

test("explicit snapshots replace streamed thinking, including empty and shortened text", () => {
  for (const snapshot of ["draft", "", "replacement", "draft with a longer tail"]) {
    assert.equal(reconcileThinkingSnapshot("draft with a tail", snapshot), snapshot);
  }
  assert.equal(reconcileThinkingSnapshot("draft", undefined), "draft");
});

test("missing thinking-end content is reconstructed without adding cumulative partial snapshots", () => {
  const recovery = new ThinkingStreamRecovery();
  recovery.ingest({ type: "message_start", message: { role: "assistant", content: [] } });
  recovery.ingest(update("thinking_delta", { delta: "first " }));
  recovery.ingest(update("thinking_delta", { delta: "second" }));
  recovery.ingest(update("thinking_delta", { contentIndex: 1, delta: "separate" }));
  const end = recovery.ingest(update("thinking_end"));
  assert.equal(end.assistantMessageEvent.content, "first second");
  assert.equal(end.assistantMessageEvent.partial, undefined);
  assert.equal(recovery.ingest(update("thinking_end", { contentIndex: 1 })).assistantMessageEvent.content, "separate");
});

test("thinking_end corrections are unchanged with both old and snapshot-free RPC events", () => {
  for (const legacy of [false, true]) {
    for (const content of ["draft", "", "provider correction"]) {
      const recovery = new ThinkingStreamRecovery();
      const partial = legacy ? { partial: { role: "assistant", content: [{ type: "thinking", thinking: "draft removed tail" }] } } : {};
      recovery.ingest(update("thinking_delta", { delta: "draft removed tail", ...partial }));
      const end = update("thinking_end", { content, ...partial });
      assert.equal(recovery.ingest(end), end, "explicit end content must not be patched from the stream or stale partial");
    }
  }
});

test("message_end is authoritative for prefixes, clearing, redaction, removal, and reordered blocks", () => {
  for (const content of [
    [{ type: "thinking", thinking: "draft" }],
    [{ type: "thinking", thinking: "" }],
    [{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "opaque" }],
    [{ type: "text", text: "final answer" }],
    [{ type: "text", text: "answer" }, { type: "thinking", thinking: "replacement" }],
    [],
  ]) {
    const recovery = new ThinkingStreamRecovery();
    recovery.ingest(update("thinking_delta", { delta: "draft removed tail", partial: { role: "assistant", content: [{ type: "thinking", thinking: "draft removed tail" }] } }));
    const end = { type: "message_end", message: { role: "assistant", timestamp: 1, content } };
    const before = structuredClone(end);
    assert.equal(recovery.ingest(end), end);
    assert.deepEqual(end, before);
    assert.equal(recovery.ingest(update("thinking_end")).assistantMessageEvent.content, "", "settlement clears all draft state");
  }
});

test("a new assistant message cannot inherit another message's thinking", () => {
  const recovery = new ThinkingStreamRecovery();
  recovery.ingest(update("thinking_delta", { delta: "old message" }));
  recovery.ingest({ type: "message_start", message: { role: "assistant", content: [] } });
  assert.equal(recovery.ingest(update("thinking_end")).assistantMessageEvent.content, "");
});

test("fetched history bypasses streaming recovery entirely", async () => {
  const server = await readFile(new URL("../bin/pi-webui.mjs", import.meta.url), "utf8");
  assert.match(server, /filterSessionSummaryTranscriptMessages\(filterIntercomTranscriptMessages\(response\.data\.messages\)\)/);
  assert.doesNotMatch(server, /thinkingStreamRecovery\.applyToMessages/);
});
