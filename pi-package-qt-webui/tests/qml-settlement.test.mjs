import assert from "node:assert/strict";
import test from "node:test";
import { bridgeHarness, qmlFunctions } from "./helpers/qml-functions.mjs";

for (const code of ["busy", "not_ready", "not_running", "limit_exceeded", "invalid_request", "pi_error", "timeout"]) {
  test(`prompt settlement retains the originating operation on ${code} and tab changes`, async () => {
    const { context: b, frames } = await bridgeHarness();
    let result;
    assert(b.sendPrompt("keep this", "send", (response, submission) => { result = { response, submission }; }));
    b.activeTabId = "B";
    b.settlePending(frames[0].id, { ok: false, error: { code, message: code } });
    assert.equal(result.submission.tab, "A");
    assert.equal(result.submission.draftKey, "draft-A");
    assert.equal(result.submission.text, "keep this");
    assert.equal(result.submission.state, ["timeout", "not_running"].includes(code) ? "unknown" : "rejected");
    assert.equal(frames.length, 1);
  });
}

test("local prompt saturation rejects admission; timeout keeps a bounded late settlement path", async () => {
  const { context: b, frames } = await bridgeHarness();
  b.pendingRequestCount = b.maxPendingRequests;
  let states = [];
  assert.equal(b.sendPrompt("keep", "send", (_, op) => states.push(op.state)), false);
  assert.deepEqual(states, ["rejected"]);
  assert.equal(frames.length, 0);
  b.pendingRequestCount = 0;
  states = [];
  assert(b.sendPrompt("keep", "send", (_, op) => states.push(op.state)));
  const id = frames[0].id;
  b.pendingRequests[id].deadline = 0;
  b.sweepPending();
  assert.deepEqual(states, ["unknown"]);
  assert.equal(b.pendingRequestCount, 1, "unknown outcomes retain one bounded slot");
  assert.equal(b.sendPrompt("keep", "send"), false, "unknown submission is not resent");
  b.activeTabId = "B";
  b.settlePending(id, { ok: true });
  assert.deepEqual(states, ["unknown", "accepted"]);
  assert.equal(b.pendingRequestCount, 0);
});

test("prompt success after a new Pi generation settles but cannot clear an old draft", async () => {
  const { context: b, frames } = await bridgeHarness();
  let operation;
  b.sendPrompt("keep", "send", (_, op) => { operation = op; });
  b.backendGeneration++;
  b.settlePending(frames[0].id, { ok: true });
  assert.equal(operation.state, "accepted");
  assert.equal(operation.superseded, true);
});

test("draft settlement clears only the submitted revision, never a newer edit", async () => {
  let settle;
  const saves = [];
  const editor = { text: "original", clearAndFocus() { this.text = ""; } };
  const bridge = { activeTabId: "A", saveDraftFor(...args) { saves.push(args); }, sendPrompt(_text, _mode, callback) { settle = callback; return true; } };
  const s = await qmlFunctions("shell.qml", { bridge, composer: editor, changingDraft: false, draftRecords: {}, draftKeyInUse: "key-A", draftEditRevision: 0, draftRestoreGeneration: 0, draftTimer: { stop() {} } });
  s.submitComposer("original", "send");
  editor.text = "newer";
  s.rememberDraft(editor.text);
  settle({ ok: true }, { superseded: false });
  assert.equal(editor.text, "newer");
  assert.equal(saves.length, 1);
  s.submitComposer("newer", "send");
  settle({ ok: false }, { superseded: false });
  assert.equal(editor.text, "newer");
  settle({ ok: true }, { superseded: false });
  assert.equal(editor.text, "");
  assert.deepEqual(saves.at(-1), ["key-A", "", "newer"]);
});

test("dialog rejection, unknown outcome, and late terminal settlement retain state across selection", async () => {
  const { context: b, frames } = await bridgeHarness();
  b.enqueueDialog({ requestId: "dialog", method: "editor", prefill: "text" }, false);
  b.presentNextDialog();
  const dialog = b.activeDialog;
  assert.equal(b.answerDialog("dialog", { value: "x".repeat(16385) }), false);
  assert.equal(dialog.state, "open");
  assert(b.answerDialog("dialog", { value: "x".repeat(16384) }));
  b.settlePending(frames[0].id, { ok: false, error: { code: "invalid_request", message: "rejected" } });
  assert.equal(dialog.state, "open");
  b.updateDialogDraft("dialog", "recoverable value");
  assert(b.answerDialog("dialog", { value: "recoverable value" }));
  b.activeTabId = "B";
  b.activeDialog = null;
  const id = frames[1].id;
  b.pendingRequests[id].deadline = 0;
  b.sweepPending();
  assert.equal(dialog.state, "unknown");
  assert.equal(dialog.draftValue, "recoverable value");
  b.settlePending(id, { ok: true });
  assert.equal(dialog.state, "finished");
  b.activeTabId = "A";
  assert.equal(b.enqueueDialog({ requestId: "dialog", method: "editor" }, false), false);
  assert.equal(frames.length, 2);
});
