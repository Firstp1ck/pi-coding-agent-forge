import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraftConversations, DRAFT_STORAGE_KEY, DRAFT_LIMITS } from "../public/draft-conversations.mjs";

function fixture(initial = null) {
  let raw = initial;
  let blocked = false;
  let serial = 0;
  const storage = {
    getItem: () => raw,
    setItem(key, value) {
      assert.equal(key, DRAFT_STORAGE_KEY);
      if (blocked) throw new Error("Storage denied");
      raw = value;
    },
  };
  const options = { storage: () => storage, randomId: () => `test-${++serial}`, now: () => 100 };
  return { store: createDraftConversations(options), reload: () => createDraftConversations(options), raw: () => raw, block: value => { blocked = value; } };
}

test("blank identities stay separate and only meaningful saved text enters the roster", () => {
  const { store, reload } = fixture();
  const first = store.create();
  store.edit(first, " \n\t");
  store.save(first);
  assert.deepEqual(store.list(), []);
  const second = store.create();
  assert.notEqual(first, second);
  store.edit(second, " Exact text\nwith λ ");
  store.save(second);
  assert.deepEqual(store.list().map(record => record.text), [" Exact text\nwith λ "]);
  const restored = reload();
  assert.equal(restored.activeId, second);
  assert.equal(restored.get(second).text, " Exact text\nwith λ ");
  assert.equal(restored.get(first), null);
});

test("revisions detect edits back to original and returned records cannot mutate ownership", () => {
  const { store } = fixture();
  const id = store.create();
  store.edit(id, "original");
  const captured = store.get(id);
  store.edit(id, "edit");
  store.edit(id, "original");
  assert.ok(store.get(id).revision > captured.revision);
  captured.text = "external";
  assert.equal(store.get(id).text, "original");
  assert.equal(store.select("server-tab"), false);
  assert.equal(store.edit("server-tab", "invalid"), false);
});

test("saved draft edits persist, close discards only one identity, blank selection survives reload", () => {
  const { store, reload } = fixture();
  const first = store.create();
  store.edit(first, "first");
  store.save(first);
  const second = store.create();
  store.edit(second, "second");
  store.save(second);
  store.select(first);
  store.edit(first, "updated");
  assert.equal(reload().get(first).text, "updated");
  store.remove(first);
  assert.deepEqual(reload().list().map(record => record.id), [second]);
  store.select(store.create());
  assert.ok(reload().activeId);
  store.select(null);
  assert.equal(reload().activeId, null);
});

test("denied writes retain all edits in memory and expose failure until recovery", () => {
  const f = fixture();
  const id = f.store.create();
  f.store.edit(id, "saved");
  f.store.save(id);
  const previous = f.raw();
  f.block(true);
  f.store.edit(id, "newer memory edit");
  assert.match(f.store.error, /could not be saved.*Storage denied/);
  assert.equal(f.store.get(id).text, "newer memory edit");
  assert.equal(f.raw(), previous);
  f.block(false);
  assert.equal(f.store.persist(), true);
  assert.equal(f.reload().get(id).text, "newer memory edit");
  assert.equal(f.store.error, "");
});

test("denied reads retain new memory drafts and report storage failure", () => {
  const store = createDraftConversations({ storage: () => { throw new Error("Storage disabled"); }, randomId: () => "new" });
  const id = store.create();
  store.edit(id, "memory");
  assert.equal(store.save(id), false);
  assert.equal(store.get(id).text, "memory");
  assert.match(store.error, /could not be loaded.*Storage disabled/);
});

for (const raw of ["{broken", JSON.stringify({ version: 2, records: [], activeId: null }), JSON.stringify({ version: 1, records: [{ id: "backend-tab", text: "hello" }], activeId: null })]) {
  test(`unreadable data remains untouched: ${raw.slice(0, 30)}`, () => {
    const f = fixture(raw);
    assert.match(f.store.error, /could not be loaded/);
    const id = f.store.create();
    f.store.edit(id, "new draft");
    f.store.save(id);
    assert.equal(f.raw(), raw);
    assert.equal(f.store.get(id).text, "new draft");
  });
}

test("oversized edits stay in memory without truncation or replacing stored drafts", () => {
  const f = fixture();
  const id = f.store.create();
  f.store.edit(id, "stored");
  f.store.save(id);
  const previous = f.raw();
  const oversized = "x".repeat(DRAFT_LIMITS.text + 1);
  f.store.edit(id, oversized);
  assert.equal(f.store.get(id).text, oversized);
  assert.equal(f.raw(), previous);
  assert.match(f.store.error, /storage limit/);
});

test("record count and total size limits preserve the last stored value and all in-memory drafts", () => {
  const f = fixture();
  for (let index = 0; index < DRAFT_LIMITS.records; index += 1) {
    const id = f.store.create();
    f.store.edit(id, `Draft ${index}`);
    assert.equal(f.store.save(id), true);
  }
  const previous = f.raw();
  const extra = f.store.create();
  f.store.edit(extra, "One more draft");
  assert.equal(f.store.save(extra), false);
  assert.equal(f.raw(), previous);
  assert.equal(f.store.list().length, DRAFT_LIMITS.records + 1);
  f.store.remove(extra);
  for (const record of f.store.list().slice(0, 11)) f.store.edit(record.id, "x".repeat(DRAFT_LIMITS.text));
  assert.match(f.store.error, /storage limit/);
  assert.equal(f.store.list().filter(record => record.text.length === DRAFT_LIMITS.text).length, 11);
});

test("invalid revisions, duplicate identities and invalid selections preserve unreadable storage", () => {
  const record = { id: "draft:example", text: "saved", revision: 1, updatedAt: 100 };
  for (const value of [
    { version: 1, activeId: null, records: [record, record] },
    { version: 1, activeId: "draft:missing", records: [record] },
    { version: 1, activeId: null, records: [{ ...record, revision: -1 }] },
    { version: 1, activeId: null, records: [{ ...record, updatedAt: 1.5 }] },
    { version: 1, activeId: null, records: [{ ...record, text: "" }] },
    { version: 1, activeId: null, records: Array.from({ length: DRAFT_LIMITS.records + 1 }, (_, index) => ({ ...record, id: `draft:${index}` })) },
  ]) {
    const raw = JSON.stringify(value);
    const f = fixture(raw);
    assert.match(f.store.error, /could not be loaded/);
    assert.equal(f.store.persist(), false);
    assert.equal(f.raw(), raw);
  }
});

test("optional workspace survives saved draft navigation and version-1 reload without saving blanks", () => {
  const f = fixture();
  const blank = f.store.create();
  assert.equal(f.store.setCwd(blank, "/tmp/blank workspace"), true);
  assert.equal(f.store.save(blank), true);
  assert.deepEqual(f.store.list(), []);
  assert.deepEqual(JSON.parse(f.raw()).records, []);
  f.store.edit(blank, "Text with a workspace");
  f.store.save(blank);
  const revision = f.store.get(blank).revision;
  f.store.setCwd(blank, "/tmp/updated workspace");
  assert.ok(f.store.get(blank).revision > revision);
  f.store.select(f.store.create());
  const restored = f.reload();
  restored.select(blank);
  assert.equal(restored.get(blank).text, "Text with a workspace");
  assert.equal(restored.get(blank).cwd, "/tmp/updated workspace");
  const copy = restored.get(blank);
  copy.cwd = "/external";
  assert.equal(restored.get(blank).cwd, "/tmp/updated workspace");
  restored.setCwd(blank, "");
  assert.equal(f.reload().get(blank).cwd, undefined);
  assert.equal(restored.setCwd("draft:missing", "/tmp/valid"), false);
});

test("old version-1 drafts remain readable and invalid workspace metadata never replaces storage", () => {
  const record = { id: "draft:legacy", text: "Legacy text", revision: 1, updatedAt: 100 };
  const legacy = fixture(JSON.stringify({ version: 1, records: [record], activeId: record.id }));
  assert.equal(legacy.store.error, "");
  assert.equal(legacy.store.get(record.id).cwd, undefined);
  for (const cwd of [null, 123, "x".repeat(DRAFT_LIMITS.cwd + 1), "/tmp/\u0000bad"]) {
    const raw = JSON.stringify({ version: 1, records: [{ ...record, cwd }], activeId: record.id });
    const f = fixture(raw);
    assert.match(f.store.error, /could not be loaded/);
    assert.equal(f.store.persist(), false);
    assert.equal(f.raw(), raw);
    assert.throws(() => legacy.store.setCwd(record.id, cwd), /invalid or too long/);
    assert.equal(legacy.store.get(record.id).cwd, undefined);
  }
});
