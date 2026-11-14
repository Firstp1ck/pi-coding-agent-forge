import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  readShellPreferences,
  resolveShellMode,
  writeShellPreferences,
} from "../public/shell-preferences.mjs";

const fallback = { v: 1, desktopLayout: "classic" };

function fakeStorage(initial = []) {
  const records = new Map(initial);
  const calls = [];
  return {
    records,
    calls,
    getItem(key) { calls.push(["get", key]); return records.get(key) ?? null; },
    setItem(key, value) { calls.push(["set", key, value]); records.set(key, value); },
    removeItem() { assert.fail("preferences must never erase storage"); },
    clear() { assert.fail("preferences must never clear storage"); },
  };
}

test("absent storage record falls back to Classic without writing defaults", () => {
  const storage = fakeStorage();
  assert.equal(SHELL_PREFERENCES_STORAGE_KEY, "pi-webui-shell-preferences-v1");
  assert.deepEqual(readShellPreferences(storage), { status: "absent", value: fallback });
  assert.deepEqual(storage.calls, [["get", SHELL_PREFERENCES_STORAGE_KEY]]);
  assert.equal(storage.records.size, 0);
});

test("corrupt, invalid and future data survives reads byte for byte", () => {
  for (const raw of [
    "", "{", "null", "[]", "true", "1", '"focused"', "{}",
    '{"v":2,"desktopLayout":"focused","futureSetting":true}',
    '{"v":"1","desktopLayout":"focused"}', '{"v":1}',
    '{"v":1,"desktopLayout":"unknown"}', '{"v":1,"desktopLayout":null}',
  ]) {
    const storage = fakeStorage([[SHELL_PREFERENCES_STORAGE_KEY, raw]]);
    assert.deepEqual(readShellPreferences(storage), { status: "invalid", value: fallback }, raw);
    assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), raw);
    assert.deepEqual(storage.calls, [["get", SHELL_PREFERENCES_STORAGE_KEY]]);
  }
});

test("missing and denied storage returns unavailable without throwing into chat", () => {
  for (const storage of [undefined, null, {}, { getItem() { throw new Error("denied"); } },
    { get getItem() { throw new Error("denied property access"); } }]) {
    assert.deepEqual(readShellPreferences(storage), { status: "unavailable", value: fallback });
    assert.deepEqual(writeShellPreferences(storage, fallback), { ok: false, reason: "unavailable" });
  }
  const storage = { setItem() { throw new Error("quota exceeded"); } };
  assert.deepEqual(writeShellPreferences(storage, fallback), { ok: false, reason: "unavailable" });
});

test("valid writes roundtrip only the version and desktop choice", () => {
  const otherRecords = [
    ["pi-webui-ui-layout-v3", "durable layout"],
    ["pi-webui-mobile-shell-v2", "preview"],
    ["pi-webui-tablet-shell-v2", "legacy"],
    ["other-browser-preference", "untouched"],
  ];
  const storage = fakeStorage(otherRecords);
  for (const desktopLayout of ["focused", "classic"]) {
    assert.deepEqual(writeShellPreferences(storage, { v: 1, desktopLayout, session: "must not persist", draft: "private" }), { ok: true, reason: null });
    assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), JSON.stringify({ v: 1, desktopLayout }));
    assert.deepEqual(readShellPreferences(storage), { status: "valid", value: { v: 1, desktopLayout } });
  }
  for (const [key, value] of otherRecords) assert.equal(storage.records.get(key), value);
  assert.equal(storage.calls.every(([, key]) => key === SHELL_PREFERENCES_STORAGE_KEY), true);
});

test("valid records normalize extra fields without modifying stored bytes", () => {
  const raw = '{"v":1,"desktopLayout":"focused","unknown":true}';
  const storage = fakeStorage([[SHELL_PREFERENCES_STORAGE_KEY, raw]]);
  assert.deepEqual(readShellPreferences(storage), { status: "valid", value: { v: 1, desktopLayout: "focused" } });
  assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), raw);
  const first = readShellPreferences(fakeStorage());
  first.value.desktopLayout = "focused";
  assert.deepEqual(readShellPreferences(fakeStorage()).value, fallback, "fallback objects are not shared mutable state");
});

test("invalid writes leave prior future records and unrelated records untouched", () => {
  const raw = '{"v":9,"desktopLayout":"future"}';
  const storage = fakeStorage([[SHELL_PREFERENCES_STORAGE_KEY, raw]]);
  for (const value of [undefined, null, [], "focused", {}, { v: 2, desktopLayout: "classic" },
    { v: 1, desktopLayout: "preview" }, { v: 1, get desktopLayout() { throw new Error("invalid accessor"); } }]) {
    assert.deepEqual(writeShellPreferences(storage, value), { ok: false, reason: "invalid" });
  }
  assert.equal(storage.calls.length, 0);
  assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), raw);
});

test("desktop defaults to Classic and requires the explicit focused choice", () => {
  assert.equal(resolveShellMode(), "classic");
  for (const desktopLayout of [undefined, null, "classic", "preview", "future", true]) {
    assert.equal(resolveShellMode({ desktopLayout, phoneMode: "v2", tabletMode: "v2" }), "classic");
  }
  assert.equal(resolveShellMode({ desktopLayout: "focused" }), "focused");
  assert.equal(resolveShellMode({ viewportMode: "unknown", desktopLayout: "focused" }), "classic");
});

test("phone and tablet activation are independent and do not inherit desktop layout", () => {
  for (const desktopLayout of ["classic", "focused"]) {
    for (const phoneMode of ["legacy", "preview", "v2", "unknown"]) {
      for (const tabletMode of ["legacy", "preview", "v2", "unknown"]) {
        const modes = { desktopLayout, phoneMode, tabletMode };
        assert.equal(resolveShellMode({ ...modes, viewportMode: "phone" }),
          ["preview", "v2"].includes(phoneMode) ? "mobile-v2" : "classic");
        assert.equal(resolveShellMode({ ...modes, viewportMode: "tablet" }),
          ["preview", "v2"].includes(tabletMode) ? "tablet-v2" : "classic");
        assert.equal(resolveShellMode({ ...modes, viewportMode: "desktop" }), desktopLayout);
      }
    }
  }
});

test("recovery wins through viewport changes without altering preferences or modes", () => {
  const modes = { recovery: true, desktopLayout: "focused", phoneMode: "preview", tabletMode: "v2" };
  for (const viewportMode of ["desktop", "phone", "tablet", "phone", "desktop"]) {
    assert.equal(resolveShellMode({ ...modes, viewportMode }), "classic");
  }
  assert.deepEqual(modes, { recovery: true, desktopLayout: "focused", phoneMode: "preview", tabletMode: "v2" });
  assert.equal(resolveShellMode({ ...modes, recovery: false, viewportMode: "desktop" }), "focused");
  assert.equal(resolveShellMode({ ...modes, recovery: false, viewportMode: "phone" }), "mobile-v2");
  assert.equal(resolveShellMode({ ...modes, recovery: false, viewportMode: "tablet" }), "tablet-v2");
});
