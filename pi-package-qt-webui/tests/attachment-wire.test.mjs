import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { startBackend } from "./helpers/backend-client.mjs";
import { bridgeHarness } from "./helpers/qml-functions.mjs";
import { LIMITS } from "../lib/backend/protocol.mjs";

test("three maximum-size attachments, bounded text reads, hello and selection fit real frames", async t => {
  const b = await startBackend({ t });
  await b.waitForEvent("pi.status", e => e.ready);
  assert((await b.send("hello", { attachmentMetadata: true })).ok);
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const file = path.join(b.temporary, `large-${i}.txt`);
    await writeFile(file, (i === 2 ? "\u0001" : "x").repeat(LIMITS.maxTextAttachmentBytes));
    const result = await b.send("attachment_add", { path: file });
    assert(result.ok, JSON.stringify(result));
    assert.equal(result.data.attachment.text, undefined);
    ids.push(result.data.attachment.id);
  }
  const hello = await b.send("hello");
  assert.equal(hello.data.attachments.length, 3);
  const selected = await b.send("tab_select", { tab: hello.data.tabs.activeTab });
  assert(selected.ok);
  assert.equal(selected.data.attachments.length, 3);
  let offset = 0;
  let value = "";
  do {
    const result = await b.send("attachment_read", { attachmentId: ids[2], offset });
    assert(result.ok, JSON.stringify(result));
    assert(Buffer.byteLength(JSON.stringify(result) + "\n") < LIMITS.maxOutboundFrameBytes);
    value += result.data.text;
    offset = result.data.nextOffset;
  } while (offset !== null);
  assert.equal(value, "\u0001".repeat(LIMITS.maxTextAttachmentBytes));
  assert((await b.send("attachment_update", { attachmentId: ids[0], text: "edited" })).ok);
  assert((await b.send("attachment_remove", { attachmentId: ids[1] })).ok);
  assert((await b.send("prompt", { message: "__QT_WEBUI_IMMEDIATE__", attachments: [ids[0], ids[2]] })).ok);
  assert.deepEqual((await b.send("hello")).data.attachments, []);
});

test("legacy protocol remains readable and rejects attachment growth before commit", async t => {
  const b = await startBackend({ t });
  await b.waitForEvent("pi.status", e => e.ready);
  const file = path.join(b.temporary, "legacy.txt");
  await writeFile(file, "original");
  const added = await b.send("attachment_add", { path: file });
  assert.equal(added.data.attachment.text, "original");
  await writeFile(file, "x".repeat(LIMITS.maxTextAttachmentBytes));
  const refused = await b.send("attachment_add", { path: file });
  assert.equal(refused.error.code, "limit_exceeded");
  assert.equal((await b.send("hello")).data.attachments.length, 1);
});

for (const unit of ["x", "é", "😀", '"', "\\", "\u0001"]) {
  test(`QML edit preflight agrees with UTF-8 framing for ${JSON.stringify(unit)}`, async () => {
    const payload = n => JSON.stringify({ v: 1, id: "q-1", type: "attachment_update", attachmentId: "id", text: unit.repeat(n), tab: "A" }) + "\n";
    let lo = 0, hi = LIMITS.maxInboundFrameBytes;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (Buffer.byteLength(payload(mid)) <= LIMITS.maxInboundFrameBytes) lo = mid; else hi = mid - 1; }
    for (const n of [lo - 1, lo, lo + 1]) {
      const { context: q, frames } = await bridgeHarness();
      let response;
      const id = q.updateAttachment("id", unit.repeat(n), result => { response = result; });
      assert.equal(q.utf8Bytes(payload(n)), Buffer.byteLength(payload(n)));
      assert.equal(Boolean(id), n <= lo);
      assert.equal(frames.length, n <= lo ? 1 : 0);
      if (n > lo) assert.equal(response.error.code, "limit_exceeded");
    }
  });
}

test("QML applies confirmed consumption to origin only, retaining later and other-tab files", async () => {
  const { context: q, frames } = await bridgeHarness();
  q.tabs.push({ id: "B", draftId: "draft-B" });
  const a = { id: "att-a" }, b = { id: "att-b" }, other = { id: "att-other" };
  q.attachments = [a];
  q.attachmentViews = { "A:draft-A": [a], "B:draft-B": [other] };
  assert(q.sendPrompt("first", "send"));
  const prompt = frames.at(-1);
  q.attachments = [a, b];
  q.attachmentViews["A:draft-A"] = [a, b];
  q.activeTabId = "B";
  q.attachments = [other];
  q.settlePending(prompt.id, { ok: true, data: { mode: "send" }, consumedAttachmentIds: [a.id] });
  assert.deepEqual(q.attachmentViews["A:draft-A"].map(item => item.id), [b.id]);
  assert.deepEqual(q.attachments.map(item => item.id), [other.id]);
  q.activeTabId = "A";
  q.attachments = q.attachmentViews["A:draft-A"];
  assert.deepEqual(q.attachments.map(item => item.id), [b.id]);
});

test("QML leaves attachments untouched on missing consumption field and requests a fresh list", async () => {
  const { context: q, frames } = await bridgeHarness();
  q.attachments = [{ id: "att-a" }];
  assert(q.sendPrompt("first", "send"));
  const prompt = frames.at(-1);
  q.settlePending(prompt.id, { ok: true, data: {} });
  assert.deepEqual(q.attachments.map(item => item.id), ["att-a"]);
  assert.equal(frames.at(-1).type, "attachments_list");
});

test("QML uses ids on Pi rejection and retains every file on preflight refusal", async () => {
  for (const outcome of [
    { ok: false, error: { code: "pi_error", message: "rejected" }, consumedAttachmentIds: ["att-a"] },
    { ok: false, error: { code: "busy", message: "busy" }, consumedAttachmentIds: [] },
  ]) {
    const { context: q, frames } = await bridgeHarness();
    q.attachments = [{ id: "att-a" }, { id: "att-b" }];
    q.sendPrompt("first", "send");
    q.settlePending(frames[0].id, outcome);
    assert.deepEqual(q.attachments.map(item => item.id), outcome.consumedAttachmentIds.length ? ["att-b"] : ["att-a", "att-b"]);
  }
});

test("QML reconciles a missing consumed field with a selected-tab snapshot on older backends", async () => {
  const { context: q, frames } = await bridgeHarness();
  q.attachments = [{ id: "att-a" }, { id: "att-b" }];
  q.sendPrompt("first", "send");
  q.settlePending(frames[0].id, { ok: true, data: {} });
  assert.equal(frames[1].type, "attachments_list");
  q.settlePending(frames[1].id, { ok: false, error: { code: "unknown_request", message: "unsupported" } });
  assert.equal(frames[2].type, "tab_select");
  q.settlePending(frames[2].id, { ok: true, data: { attachments: [{ id: "att-b" }] } });
  assert.deepEqual(q.attachments.map(item => item.id), ["att-b"]);
});

test("QML timeout without consumption stays unknown, then late settlement removes only A and unlocks B", async () => {
  const { context: q, frames } = await bridgeHarness();
  q.attachments = [{ id: "att-a" }];
  q.sendPrompt("first", "send");
  const id = frames[0].id;
  q.attachments = [{ id: "att-a" }, { id: "att-b" }];
  q.settlePending(id, { ok: false, error: { code: "timeout", message: "unknown" } });
  assert.deepEqual(q.attachments.map(item => item.id), ["att-a", "att-b"]);
  assert.equal(frames[1].type, "attachments_list");
  assert.equal(q.attachmentLocked("att-a"), true);
  q.settlePending(frames[1].id, { ok: true, data: { attachments: [{ id: "att-a" }, { id: "att-b" }] } });
  q.settleTimedOutPrompt({ requestId: id, tab: "A", ok: true, consumedAttachmentIds: ["att-a"] });
  assert.deepEqual(q.attachments.map(item => item.id), ["att-b"]);
  assert.equal(q.attachmentLocked("att-a"), false);
  assert.equal(q.promptSubmissions.length, 0);
  assert.equal(q.sendPrompt("next", "send"), true);
  assert.deepEqual(frames.at(-1).attachments, ["att-b"]);
});

test("late prompt outcome updates only its original tab and ignores stale or duplicate evidence", async () => {
  const { context: q, frames } = await bridgeHarness();
  q.tabs.push({ id: "B", draftId: "draft-B" });
  q.attachments = [{ id: "att-a" }];
  q.attachmentViews = { "A:draft-A": [{ id: "att-a" }], "B:draft-B": [{ id: "att-other" }] };
  q.sendPrompt("first", "send");
  const id = frames[0].id;
  q.activeTabId = "B";
  q.attachments = [{ id: "att-other" }];
  q.settlePending(id, { ok: false, error: { code: "timeout", message: "unknown" } });
  q.settleTimedOutPrompt({ requestId: "unrelated", tab: "A", ok: true, consumedAttachmentIds: ["att-a"] });
  assert.equal(q.promptSubmissions.length, 1);
  q.settleTimedOutPrompt({ requestId: id, tab: "A", ok: false, errorCode: "pi_error", consumedAttachmentIds: ["att-a"] });
  assert.deepEqual(q.attachments.map(item => item.id), ["att-other"]);
  assert.deepEqual(q.attachmentViews["A:draft-A"].map(item => item.id), []);
  assert.equal(q.promptSubmissions.length, 0);
  q.settleTimedOutPrompt({ requestId: id, tab: "A", ok: true, consumedAttachmentIds: ["att-other"] });
  assert.deepEqual(q.attachments.map(item => item.id), ["att-other"]);
});

test("QML restart releases old-backend attachment locks without claiming old ids survive", async () => {
  const { context: q, frames } = await bridgeHarness();
  q.attachments = [{ id: "att-a" }];
  q.sendPrompt("first", "send");
  q.settlePending(frames[0].id, { ok: false, error: { code: "timeout", message: "unknown" } });
  assert.equal(q.attachmentLocked("att-a"), true);
  q.releasePreviousBackendPrompts();
  assert.equal(q.promptSubmissions[0].state, "orphaned");
  assert.equal(q.promptSubmissions[0].text, "first");
  assert.equal(q.attachmentLocked("att-a"), false);
  q.attachments = []; // The replacement backend's authoritative list has no old payloads.
  q.settleTimedOutPrompt({ requestId: frames[0].id, tab: "A", ok: true, consumedAttachmentIds: ["att-a"] });
  assert.deepEqual(q.attachments, []);
});

test("late terminal event releases a timed-out client's pending slot without resending", async () => {
  const { context: q, frames } = await bridgeHarness();
  q.attachments = [{ id: "att-a" }];
  q.sendPrompt("first", "send");
  const id = frames[0].id;
  q.pendingRequests[id].deadline = 0;
  q.sweepPending();
  assert.equal(q.promptSubmissions[0].state, "unknown");
  q.settlePending(frames[1].id, { ok: true, data: { attachments: [{ id: "att-a" }] } });
  assert.equal(q.pendingRequestCount, 1);
  q.settlePending(id, { ok: false, error: { code: "timeout", message: "backend timed out" } });
  q.settlePending(frames[2].id, { ok: true, data: { attachments: [{ id: "att-a" }] } });
  q.settleTimedOutPrompt({ requestId: id, tab: "A", ok: true, consumedAttachmentIds: ["att-a"] });
  assert.equal(q.pendingRequestCount, 0);
  assert.equal(q.promptSubmissions.length, 0);
  assert.deepEqual(q.attachments, []);
  assert.equal(frames.filter(frame => frame.type === "prompt").length, 1);
});

test("a late terminal from a replaced Pi generation cannot consume the new owner's files", async () => {
  const { context: q, frames } = await bridgeHarness();
  q.attachments = [{ id: "att-a" }];
  q.sendPrompt("first", "send");
  const id = frames[0].id;
  q.settlePending(id, { ok: false, error: { code: "timeout", message: "unknown" } });
  q.sessionGenerations.A = 1;
  q.attachments = [{ id: "att-new" }];
  q.settleTimedOutPrompt({ requestId: id, tab: "A", ok: true, consumedAttachmentIds: ["att-a"] });
  assert.equal(q.promptSubmissions[0].state, "orphaned");
  assert.deepEqual(q.attachments.map(item => item.id), ["att-new"]);
  assert.equal(q.attachmentLocked("att-a"), false);
});
