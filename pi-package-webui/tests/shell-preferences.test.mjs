import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SHELL_PREFERENCES_STORAGE_KEY,
  effectiveShellPreferences,
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

const serverCohorts = [
  undefined, null, "fresh", "established", "legacy", "unknown", "future", "", "Fresh", "fresh ",
  true, false, 1, 0, {}, { cohort: "fresh" }, ["fresh"], new String("fresh"),
];

test("effective preferences cover every read status and cohort with conservative fallbacks", () => {
  const cases = [
    { name: "absent", record: { status: "absent", value: fallback }, fresh: true },
    { name: "explicit Classic", record: { status: "valid", value: fallback } },
    { name: "explicit focused", record: { status: "valid", value: { v: 1, desktopLayout: "focused" } }, focused: true },
    ...["invalid", "unavailable", "future", "VALID", "", null, undefined].map((status) => ({
      name: `unrecognized or failed status ${status}`, record: { status, value: { v: 1, desktopLayout: "focused" } },
    })),
    ...[undefined, null, false, 0, "absent", [], {}, fallback].map((record, i) => ({
      name: `unrecognized record ${i}`, record,
    })),
    ...[undefined, null, [], true, "focused", {}, { v: 2, desktopLayout: "focused" },
      { v: "1", desktopLayout: "focused" }, { v: 1 }, { v: 1, desktopLayout: "future" },
      { v: 1, desktopLayout: "focused", navigation: "bottom" },
      { v: 1, desktopLayout: "focused", navCollapsed: "false" },
      { v: 1, desktopLayout: "focused", pinnedActions: ["invalid id"] },
      { v: 1, desktopLayout: "focused", inspectorWidth: 641 },
      { v: 1, get desktopLayout() { throw new Error("denied choice"); } },
    ].map((value, i) => ({ name: `invalid explicit value ${i}`, record: { status: "valid", value } })),
    { name: "unreadable status", record: { get status() { throw new Error("denied status"); } } },
    { name: "unreadable value", record: { status: "valid", get value() { throw new Error("denied value"); } } },
  ];
  for (const { name, record, fresh, focused } of cases) {
    for (const cohort of serverCohorts) {
      assert.deepEqual(effectiveShellPreferences(record, cohort), {
        v: 1, desktopLayout: focused || (fresh && cohort === "fresh") ? "focused" : "classic",
      }, `${name}, cohort ${String(cohort)}`);
    }
  }
  assert.deepEqual(effectiveShellPreferences(), fallback);
  assert.deepEqual(effectiveShellPreferences({ status: "absent", value: fallback }), fallback);
});

test("effective explicit preferences preserve validated optional fields without sharing or mutating them", () => {
  const optionals = [
    {}, { navigation: "left" }, { navigation: "top" }, { navCollapsed: false }, { navCollapsed: true },
    { pinnedActions: [] }, { pinnedActions: ["project:files", "session:new"] },
    { inspectorWidth: 240 }, { inspectorWidth: 640 },
    { navigation: "top", navCollapsed: true, pinnedActions: ["project:files", "project:files"], inspectorWidth: 320 },
  ];
  for (const desktopLayout of ["classic", "focused"]) {
    for (const optional of optionals) {
      const value = Object.freeze({ v: 1, desktopLayout, ...optional, unknown: "not a preference" });
      if (value.pinnedActions) Object.freeze(value.pinnedActions);
      const record = Object.freeze({ status: "valid", value });
      const before = JSON.stringify(record);
      const expected = { v: 1, desktopLayout, ...optional };
      if (expected.pinnedActions) expected.pinnedActions = [...new Set(expected.pinnedActions)];
      for (const cohort of serverCohorts) {
        const effective = effectiveShellPreferences(record, cohort);
        assert.deepEqual(effective, expected);
        assert.notEqual(effective, value);
        if (effective.pinnedActions) {
          assert.notEqual(effective.pinnedActions, value.pinnedActions);
          effective.pinnedActions.push("session:other");
        }
        effective.desktopLayout = "changed by caller";
        assert.equal(JSON.stringify(record), before);
        assert.deepEqual(effectiveShellPreferences(record, cohort), expected);
      }
    }
  }
});

test("cohort hydration performs no storage operations and preserves original read results", () => {
  for (const raw of [null, "{", '{"v":9,"desktopLayout":"focused"}',
    '{"v":1,"desktopLayout":"classic"}', '{"v":1,"desktopLayout":"focused"}']) {
    const storage = fakeStorage(raw === null ? [] : [[SHELL_PREFERENCES_STORAGE_KEY, raw]]);
    const record = readShellPreferences(storage);
    const before = JSON.stringify(record);
    for (const cohort of serverCohorts) effectiveShellPreferences(record, cohort);
    assert.deepEqual(storage.calls, [["get", SHELL_PREFERENCES_STORAGE_KEY]]);
    assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), raw ?? undefined);
    assert.equal(JSON.stringify(record), before);
  }
  const storage = fakeStorage();
  storage.getItem = (key) => { storage.calls.push(["get", key]); throw new Error("denied"); };
  const record = readShellPreferences(storage);
  for (const cohort of serverCohorts) assert.deepEqual(effectiveShellPreferences(record, cohort), fallback);
  assert.deepEqual(record, { status: "unavailable", value: fallback });
  assert.deepEqual(storage.calls, [["get", SHELL_PREFERENCES_STORAGE_KEY]]);
  assert.equal(storage.records.size, 0);
});

test("explicit choices survive late cohort changes and only deliberate writes persist", () => {
  const storage = fakeStorage();
  const absent = readShellPreferences(storage);
  assert.deepEqual(effectiveShellPreferences(absent, "fresh"), { v: 1, desktopLayout: "focused" });
  for (const desktopLayout of ["classic", "focused"]) {
    const value = { v: 1, desktopLayout, navigation: "top", navCollapsed: false };
    assert.deepEqual(writeShellPreferences(storage, value), { ok: true, reason: null });
    const explicit = readShellPreferences(storage);
    const callsBeforeHydration = storage.calls.length;
    for (const cohort of serverCohorts) assert.deepEqual(effectiveShellPreferences(explicit, cohort), value);
    assert.equal(storage.calls.length, callsBeforeHydration);
    assert.equal(storage.records.get(SHELL_PREFERENCES_STORAGE_KEY), JSON.stringify(value));
    assert.equal(explicit.status, "valid");
  }
  assert.deepEqual(storage.calls.map(([operation]) => operation), ["get", "set", "get", "set", "get"]);
  assert.deepEqual(absent, { status: "absent", value: fallback });
});

test("effective cohort defaults leave independent compact modes and recovery precedence unchanged", () => {
  const record = Object.freeze({ status: "absent", value: Object.freeze({ ...fallback }) });
  for (const cohort of serverCohorts) {
    const preferences = effectiveShellPreferences(record, cohort);
    for (const phoneMode of ["legacy", "preview", "v2", "unknown"]) {
      for (const tabletMode of ["legacy", "preview", "v2", "unknown"]) {
        const modes = { ...preferences, phoneMode, tabletMode };
        for (const viewportMode of ["desktop", "phone", "tablet", "unknown"]) {
          const expected = viewportMode === "desktop" ? preferences.desktopLayout
            : viewportMode === "phone" && ["preview", "v2"].includes(phoneMode) ? "mobile-v2"
            : viewportMode === "tablet" && ["preview", "v2"].includes(tabletMode) ? "tablet-v2" : "classic";
          assert.equal(resolveShellMode({ ...modes, viewportMode }), expected);
          assert.equal(resolveShellMode({ ...modes, viewportMode, recovery: true }), "classic");
          assert.equal(resolveShellMode({ ...modes, viewportMode, recovery: false }), expected);
        }
      }
    }
  }
  assert.deepEqual(record, { status: "absent", value: fallback });
});

test('sidebar width roundtrips within bounds without changing other preferences', () => {
  for (const navigationWidth of [180, 202, 320, 420]) {
    const storage = fakeStorage();
    const value = { v: 1, desktopLayout: 'focused', navigation: 'left', navigationWidth, inspectorWidth: 320 };
    assert.equal(writeShellPreferences(storage, value).ok, true);
    assert.deepEqual(readShellPreferences(storage).value, value);
  }
  for (const navigationWidth of [179, 421, 202.5, '202', null]) {
    assert.equal(writeShellPreferences(fakeStorage(), { v: 1, desktopLayout: 'focused', navigationWidth }).reason, 'invalid');
  }
});
