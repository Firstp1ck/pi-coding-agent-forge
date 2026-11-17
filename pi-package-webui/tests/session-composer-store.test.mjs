import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionComposerStore } from "../public/session-composer-store.mjs";

test("missing reads do not create draft, attachment or compaction state", () => {
  const store = createSessionComposerStore();
  assert.equal(store.getDraft("a"), "");
  const absent = store.getAttachments("a");
  absent.push({ id: "unowned" });
  assert.deepEqual(store.getAttachments("a"), []);
  assert.equal(store.hasDraft("a"), false);
  assert.equal(store.hasAttachments("a"), false);
  assert.equal(store.isCompactionPending("a"), false);
  assert.deepEqual([...store.draftEntries()], []);
});

test("drafts are isolated strings and an explicitly empty draft remains present", () => {
  const store = createSessionComposerStore();
  store.setDraft("a", "first\nline");
  store.setDraft("b", "second");
  store.setDraft("empty", "");
  assert.equal(store.getDraft("a"), "first\nline");
  assert.equal(store.getDraft("b"), "second");
  assert.equal(store.hasDraft("empty"), true);
  assert.equal(store.getDraft("empty"), "");
  assert.deepEqual([...store.draftEntries()], [["a", "first\nline"], ["b", "second"], ["empty", ""]]);
  const entry = store.draftEntries().next().value;
  entry[1] = "external change";
  assert.equal(store.getDraft("a"), "first\nline");
  store.setDraft("a", "updated");
  assert.equal(store.getDraft("b"), "second");
  assert.equal(store.deleteDraft("a"), true);
  assert.equal(store.deleteDraft("a"), false);
  assert.equal(store.hasDraft("a"), false);
  assert.equal(store.getDraft("a"), "");
});

test("ensure retains a distinct mutable attachment array for each tab", () => {
  const store = createSessionComposerStore();
  const first = store.ensureAttachments("a");
  const second = store.ensureAttachments("b");
  assert.notEqual(first, second);
  assert.equal(store.hasAttachments("a"), true);
  assert.equal(store.getAttachments("a"), first);
  assert.equal(store.ensureAttachments("a"), first);
  const item = { id: "attachment-a" };
  first.push(item);
  assert.equal(store.getAttachments("a")[0], item);
  assert.deepEqual(store.getAttachments("b"), []);
});

test("setting attachments retains arrays, metadata objects, File and Blob references", () => {
  const store = createSessionComposerStore();
  const file = new File(["file content"], "example.txt", { type: "text/plain" });
  const blob = new Blob(["blob content"], { type: "text/plain" });
  const item = { id: "attachment-a", file, blob, metadata: { source: "picker" } };
  const items = [item];
  store.setAttachments("a", items);
  assert.equal(store.getAttachments("a"), items);
  assert.equal(store.ensureAttachments("a"), items);
  assert.equal(store.getAttachments("a")[0], item);
  assert.equal(store.getAttachments("a")[0].file, file);
  assert.equal(store.getAttachments("a")[0].blob, blob);
  assert.equal(store.getAttachments("a")[0].metadata, item.metadata);
  store.getAttachments("a")[0].metadata.source = "edited";
  assert.equal(item.metadata.source, "edited");
  const replacement = [];
  store.setAttachments("a", replacement);
  assert.equal(store.getAttachments("a"), replacement);
  assert.deepEqual(items, [item]);
  assert.equal(store.deleteAttachments("a"), true);
  assert.equal(store.deleteAttachments("a"), false);
  assert.equal(store.hasAttachments("a"), false);
  assert.notEqual(store.ensureAttachments("a"), replacement);
});

test("pending compaction deduplicates per tab and repeated completion is harmless", () => {
  const store = createSessionComposerStore();
  assert.equal(store.beginCompaction("a"), true);
  assert.equal(store.beginCompaction("a"), false);
  assert.equal(store.beginCompaction("b"), true);
  assert.equal(store.isCompactionPending("a"), true);
  assert.equal(store.endCompaction("a"), true);
  assert.equal(store.endCompaction("a"), false);
  assert.equal(store.isCompactionPending("a"), false);
  assert.equal(store.isCompactionPending("b"), true);
  assert.equal(store.beginCompaction("a"), true);
});

test("clearTab removes only its state and leaves resource cleanup to the caller", (t) => {
  const revoke = t.mock.method(URL, "revokeObjectURL", () => assert.fail("store must not revoke URLs"));
  const store = createSessionComposerStore();
  const item = Object.freeze({
    file: new File(["unsent"], "draft.txt"),
    previewUrl: "blob:owned-by-parent",
    close: () => assert.fail("store must not close resources"),
  });
  const first = Object.freeze([item]);
  const second = [{ id: "b" }];
  for (const tabId of ["a", "b"]) {
    store.setDraft(tabId, `${tabId} draft`);
    store.beginCompaction(tabId);
  }
  store.setAttachments("a", first);
  store.setAttachments("b", second);
  store.clearTab("a");
  store.clearTab("a");
  store.clearTab("missing");
  assert.equal(store.getDraft("a"), "");
  assert.equal(store.hasDraft("a"), false);
  assert.deepEqual(store.getAttachments("a"), []);
  assert.equal(store.hasAttachments("a"), false);
  assert.equal(store.isCompactionPending("a"), false);
  assert.equal(store.endCompaction("a"), false);
  assert.equal(store.getDraft("b"), "b draft");
  assert.equal(store.getAttachments("b"), second);
  assert.equal(store.isCompactionPending("b"), true);
  assert.deepEqual([...store.draftEntries()], [["b", "b draft"]]);
  assert.equal(first[0], item);
  assert.equal(revoke.mock.callCount(), 0);
  assert.equal(store.beginCompaction("a"), true);
});

test("null inactive tabs do not accumulate composer state", () => {
  const store = createSessionComposerStore();
  for (const tabId of [null, undefined, ""]) {
    store.setDraft(tabId, "inactive");
    store.setAttachments(tabId, [{ id: "inactive" }]);
    store.ensureAttachments(tabId).push({ id: "temporary" });
    assert.equal(store.getDraft(tabId), "");
    assert.equal(store.hasDraft(tabId), false);
    assert.deepEqual(store.getAttachments(tabId), []);
    assert.equal(store.hasAttachments(tabId), false);
    assert.equal(store.beginCompaction(tabId), false);
    store.clearTab(tabId);
  }
  assert.deepEqual([...store.draftEntries()], []);
});

test("draft, attachment and compaction state are local to each store instance", () => {
  const first = createSessionComposerStore();
  const second = createSessionComposerStore();
  first.setDraft("a", "first instance");
  first.ensureAttachments("a").push({ id: "first" });
  first.beginCompaction("a");
  assert.equal(second.getDraft("a"), "");
  assert.deepEqual(second.getAttachments("a"), []);
  assert.equal(second.isCompactionPending("a"), false);
  second.clearTab("a");
  assert.equal(first.getDraft("a"), "first instance");
  assert.equal(first.getAttachments("a")[0].id, "first");
  assert.equal(first.isCompactionPending("a"), true);
});
