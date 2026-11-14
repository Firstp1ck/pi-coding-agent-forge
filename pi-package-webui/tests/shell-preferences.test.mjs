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

test("optional focused fields roundtrip independently without filling absent fields", () => {
  for (const optional of [
    { navigation: "left" }, { navigation: "top" },
    { navCollapsed: false }, { navCollapsed: true },
    { pinnedActions: [] }, { pinnedActions: ["project:files", "Session_New-1", "model:fake/fake-model", "command:with%20space"] },
    { inspectorWidth: 240 }, { inspectorWidth: 320 }, { inspectorWidth: 640 },
  ]) {
    for (const desktopLayout of ["classic", "focused"]) {
      const value = { v: 1, desktopLayout, ...optional };
      const storage = fakeStorage();
      assert.deepEqual(writeShellPreferences(storage, value), { ok: true, reason: null });
      assert.deepEqual(JSON.parse(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY)), value);
      assert.deepEqual(readShellPreferences(storage), { status: "valid", value });
      assert.equal(storage.calls.every(([, key]) => key === SHELL_PREFERENCES_STORAGE_KEY), true);
    }
  }
});

test("pins keep first occurrence order and accept exactly twenty distinct stable IDs", () => {
  const pins = ["a", `Z${"_".repeat(119)}`, "project:files", "Session_New-1",
    ...Array.from({ length: 16 }, (_, i) => `action:${i}`)];
  const input = { v: 1, desktopLayout: "focused", navigation: "top", navCollapsed: true,
    pinnedActions: [pins[0], pins[1], pins[0], ...pins.slice(2), pins[1]], inspectorWidth: 640 };
  const expected = { ...input, pinnedActions: pins };
  const raw = JSON.stringify(input);
  const storage = fakeStorage([[SHELL_PREFERENCES_STORAGE_KEY, raw]]);
  const read = readShellPreferences(storage);
  assert.deepEqual(read, { status: "valid", value: expected });
  assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), raw, "read does not repair duplicate pins");
  read.value.pinnedActions.pop();
  assert.deepEqual(readShellPreferences(storage).value, expected, "reads do not share mutable pin arrays");
  assert.deepEqual(writeShellPreferences(storage, input), { ok: true, reason: null });
  assert.deepEqual(JSON.parse(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY)), expected);
  assert.equal(JSON.stringify(input), raw, "write leaves caller pins intact");
  input.pinnedActions.length = 0;
  assert.deepEqual(readShellPreferences(storage).value, expected);
});

test("invalid optional fields reject the whole record and never write or repair storage", () => {
  const invalid = [
    ...[undefined, null, "bottom", "Left", true, 1].map((navigation) => ({ navigation })),
    ...[undefined, null, "false", 0, 1].map((navCollapsed) => ({ navCollapsed })),
    ...[undefined, null, "project:files", {}, [1], [null], [""], ["1action"], [" leading"],
      ["trailing "], ["é"], ["a\n"], ["a\r"], [`a${"b".repeat(512)}`],
      Array(1), Array.from({ length: 21 }, (_, i) => `action:${i}`)]
      .map((pinnedActions) => ({ pinnedActions })),
    ...[undefined, null, 239, 641, 320.5, "320", true, NaN, Infinity]
      .map((inspectorWidth) => ({ inspectorWidth })),
  ];
  for (const optional of invalid) {
    const original = '{"v":9,"desktopLayout":"future"}';
    const storage = fakeStorage([[SHELL_PREFERENCES_STORAGE_KEY, original], ["other", "untouched"]]);
    const value = { v: 1, desktopLayout: "focused", ...optional };
    assert.deepEqual(writeShellPreferences(storage, value), { ok: false, reason: "invalid" });
    assert.deepEqual(storage.calls, []);
    assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), original);
    assert.equal(storage.records.get("other"), "untouched");
    const raw = JSON.stringify(value);
    // JSON omits undefined, so only explicit fields reach the record reader.
    if (Object.values(optional)[0] !== undefined) {
      const reader = fakeStorage([[SHELL_PREFERENCES_STORAGE_KEY, raw]]);
      assert.deepEqual(readShellPreferences(reader), { status: "invalid", value: fallback }, raw);
      assert.equal(reader.records.get(SHELL_PREFERENCES_STORAGE_KEY), raw);
      assert.deepEqual(reader.calls, [["get", SHELL_PREFERENCES_STORAGE_KEY]]);
    }
  }
});

test("focused optional fields preserve storage failure status and mobile recovery resolution", () => {
  const value = { v: 1, desktopLayout: "focused", navigation: "top", navCollapsed: true,
    pinnedActions: ["project:files"], inspectorWidth: 240 };
  assert.deepEqual(writeShellPreferences({ setItem() { throw new Error("quota exceeded"); } }, value),
    { ok: false, reason: "unavailable" });
  const storage = fakeStorage();
  writeShellPreferences(storage, value);
  const preferences = readShellPreferences(storage).value;
  const raw = storage.records.get(SHELL_PREFERENCES_STORAGE_KEY);
  assert.equal(resolveShellMode(preferences), "focused");
  assert.equal(resolveShellMode({ ...preferences, recovery: true }), "classic");
  assert.equal(resolveShellMode({ ...preferences, viewportMode: "phone", phoneMode: "v2" }), "mobile-v2");
  assert.equal(resolveShellMode({ ...preferences, viewportMode: "tablet", phoneMode: "v2" }), "classic");
  assert.equal(resolveShellMode({ ...preferences, viewportMode: "tablet", tabletMode: "preview" }), "tablet-v2");
  assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), raw);
});
