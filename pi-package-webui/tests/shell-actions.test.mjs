import assert from "node:assert/strict";
import { test } from "node:test";
import { filterActionItems, checkActionTarget } from "../public/shell-actions.mjs";

test("search matches every case-insensitive token across the existing metadata fields", () => {
  const matching = { label: "Files panel", description: "Browse the project", kind: "Action", keywords: "tree explorer" };
  const items = [matching, { label: "Files", description: "Browse", kind: "Action", keywords: "tree" }];
  assert.deepEqual(filterActionItems(items, "  FILES\tproject\nACTION explorer  "), [matching]);
  assert.deepEqual(filterActionItems(items, "files missing"), []);
  assert.deepEqual(filterActionItems([{ label: 42, keywords: ["Alpha", "Beta"] }], "42 alpha beta"), [
    { label: 42, keywords: ["Alpha", "Beta"] },
  ]);
});

test("ranking preserves label prefix, slash prefix, word start, substring and metadata order", () => {
  const items = [
    { label: "Other", description: "model" },
    { label: "Remodel" },
    { label: "Choose model" },
    { label: "/model" },
    { label: "Model picker" },
  ];
  assert.deepEqual(filterActionItems(items, "MODEL"), [items[4], items[3], items[2], items[1], items[0]]);
  assert.deepEqual(filterActionItems(items, "/mod"), [items[3]]);
});

test("word starts include spaces, slashes, underscores and hyphens, with stable ties", () => {
  const items = ["remodel", "choose/model", "choose_model", "choose-model", "choose model"].map((label) => ({ label }));
  assert.deepEqual(filterActionItems(items, "model"), [...items.slice(1), items[0]]);
  const ties = [{ label: "One", keywords: "find" }, { label: "Two", description: "find" }, { label: "Three", kind: "find" }];
  assert.deepEqual(filterActionItems(ties, "find"), ties);
});

test("scores accumulate across tokens rather than favoring only the first token", () => {
  const items = [
    { label: "Open result", keywords: "file" },
    { label: "Open file" },
    { label: "File open" },
  ];
  assert.deepEqual(filterActionItems(items, "open file"), [items[1], items[2], items[0]]);
});

test("regular expression characters in queries stay literal", () => {
  for (const token of [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\", "a+b", "[x]", "foo.bar"]) {
    const items = [{ label: `inside${token}value` }, { label: `choose ${token}value` }, { label: "Unrelated" }];
    assert.deepEqual(filterActionItems(items, token), [items[1], items[0]], token);
  }
});

test("empty queries retain catalog order and both search paths honor default and custom limits", () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ label: `Action ${index}` }));
  for (const query of ["", " \t\n ", undefined, null, "action"]) {
    assert.deepEqual(filterActionItems(items, query), items.slice(0, 80));
    assert.deepEqual(filterActionItems(items, query, { limit: 3 }), items.slice(0, 3));
    assert.deepEqual(filterActionItems(items, query, { limit: 0 }), []);
    assert.deepEqual(filterActionItems(items, query, { limit: 120 }), items);
  }
  const ranked = [{ label: "Other", keywords: "model" }, { label: "Model" }];
  assert.deepEqual(filterActionItems(ranked, "model", { limit: 1 }), [ranked[1]]);
  assert.deepEqual(filterActionItems([], "anything"), []);
});

test("aliases extend discovery without changing labels or label-based ranking", () => {
  const items = [
    { label: "Files", aliases: ["Explorer", "Project browser"] },
    { label: "Other", aliases: "Explorer" },
    { label: "Explorer" },
  ];
  assert.deepEqual(filterActionItems(items, "explorer"), [items[2], items[0], items[1]]);
  assert.deepEqual(filterActionItems(items, "FILES project BROWSER"), [items[0]]);
  assert.deepEqual(filterActionItems(items, "other EXPLORER"), [items[1]]);
});

test("discovery preserves unavailable entries and never mutates records or runs handlers", () => {
  const run = () => assert.fail("Discovery must not execute an action");
  const items = Object.freeze([
    Object.freeze({ label: "Other", keywords: "model", run }),
    Object.freeze({ label: "Model", aliases: Object.freeze(["llm"]), available: false, unavailableReason: "No provider", run }),
  ]);
  const result = filterActionItems(items, "model");
  assert.equal(result[0], items[1]);
  assert.equal(result[1], items[0]);
  assert.equal(items[0].label, "Other");
  assert.equal(items[1].available, false);
  assert.notEqual(filterActionItems(items, ""), items);
});

const currentTarget = Object.freeze({ tabId: "tab-a", generation: 4, sessionIdentity: "session-a", cwd: "/project", liveTabIds: Object.freeze(["tab-a", "tab-b"]) });
const sessionTarget = Object.freeze({ tabId: "tab-a", generation: 4, sessionIdentity: "session-a" });

function assertRejected(action, current, reasonPattern) {
  const result = checkActionTarget(action, current);
  assert.equal(result.ok, false);
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.trim().length > 0);
  if (reasonPattern) assert.match(result.reason, reasonPattern);
}

test("browser and server actions require no session identity", () => {
  for (const scope of ["browser", "server"]) {
    assert.deepEqual(checkActionTarget({ scope }), { ok: true, reason: "" });
    assert.deepEqual(checkActionTarget({ scope, target: { tabId: "old", generation: -1 } }, currentTarget), { ok: true, reason: "" });
  }
});

test("session actions require the captured tab and numeric nonnegative integer generation", () => {
  assert.deepEqual(checkActionTarget({ scope: "session", target: sessionTarget }, currentTarget), { ok: true, reason: "" });
  assert.deepEqual(checkActionTarget({ scope: "session", target: { tabId: "tab-a", generation: 0, sessionIdentity: "session-a" } }, { tabId: "tab-a", generation: 0, sessionIdentity: "session-a" }), { ok: true, reason: "" });
  assertRejected({ scope: "session", target: sessionTarget }, { ...currentTarget, generation: 5 }, /session/i);
  assertRejected({ scope: "session", target: sessionTarget }, { ...currentTarget, tabId: "tab-b" }, /thread/i);
  for (const generation of [undefined, null, "4", -1, 1.5, NaN, Infinity, -Infinity, false]) {
    assertRejected({ scope: "session", target: { tabId: "tab-a", generation } }, { ...currentTarget, generation }, /generation/i);
  }
  for (const current of [undefined, null, {}, { tabId: "tab-a" }, { generation: 4 }, { tabId: "tab-a", generation: "4" }]) {
    assertRejected({ scope: "session", target: sessionTarget }, current);
  }
});

test("project actions additionally require the exact captured working directory", () => {
  const action = { scope: "project", target: { ...sessionTarget, cwd: "/project" } };
  assert.deepEqual(checkActionTarget(action, currentTarget), { ok: true, reason: "" });
  for (const cwd of [undefined, null, "", "  ", 42]) {
    assertRejected({ ...action, target: { ...sessionTarget, cwd } }, { ...currentTarget, cwd }, /directory/i);
  }
  for (const cwd of [undefined, "/other", "/Project", "/project/", "/project "]) {
    assertRejected(action, { ...currentTarget, cwd }, /directory/i);
  }
  assertRejected(action, { ...currentTarget, generation: 5 }, /session/i);
  assertRejected(action, { ...currentTarget, tabId: "tab-b" }, /thread/i);
  assert.deepEqual(checkActionTarget({ scope: "session", target: sessionTarget }, { ...currentTarget, cwd: "/other" }), { ok: true, reason: "" });
});

test("missing or unknown scopes and incomplete target identities fail closed", () => {
  for (const action of [undefined, null, {}, { target: sessionTarget }, { scope: "workspace" }, { scope: "Session" }, { scope: "" }]) {
    assertRejected(action, currentTarget, /scope/i);
  }
  for (const scope of ["session", "project", "tab"]) {
    for (const target of [undefined, null, {}, { generation: 4 }, { tabId: "" }, { tabId: " " }, { tabId: 42 }]) {
      assertRejected({ scope, target }, currentTarget, /thread/i);
    }
  }
});

test("availability rejects every scope with an explicit reason or meaningful default", () => {
  for (const scope of ["browser", "server", "session", "project", "tab"]) {
    assert.deepEqual(checkActionTarget({ scope, available: false, unavailableReason: "Enable the companion first" }, currentTarget), {
      ok: false, reason: "Enable the companion first",
    });
    for (const unavailableReason of [undefined, null, "", "  ", 42]) {
      assertRejected({ scope, available: false, unavailableReason }, currentTarget, /unavailable/i);
    }
  }
  assert.deepEqual(checkActionTarget({ scope: "browser", available: true, unavailableReason: "Old reason" }), { ok: true, reason: "" });
});

test("explicit tab selection checks live membership independently of the active tab or generation", () => {
  const action = { scope: "tab", target: { tabId: "tab-b" } };
  assert.deepEqual(checkActionTarget(action, currentTarget), { ok: true, reason: "" });
  assert.deepEqual(checkActionTarget(action, { liveTabIds: ["tab-b"] }), { ok: true, reason: "" });
  assertRejected(action, { ...currentTarget, liveTabIds: ["tab-a"] }, /thread/i);
  for (const current of [undefined, {}, { liveTabIds: "tab-b" }, { liveTabIds: new Set(["tab-b"]) }]) {
    assertRejected(action, current);
  }
  assertRejected({ ...action, available: false }, currentTarget, /unavailable/i);
});

test("target checks retain no state, mutate no records and never execute handlers", () => {
  const action = Object.freeze({ scope: "project", target: Object.freeze({ ...sessionTarget, cwd: "/project" }), run: () => assert.fail("Target checks must not execute actions") });
  assert.deepEqual(checkActionTarget(action, currentTarget), { ok: true, reason: "" });
  assertRejected(action, { ...currentTarget, generation: 5 });
  assert.deepEqual(checkActionTarget(action, currentTarget), { ok: true, reason: "" });
});

test("same-tab session identity changes invalidate session and project actions", () => {
  for (const scope of ["session", "project"]) {
    const action = { scope, target: { ...sessionTarget, cwd: "/project" } };
    for (const sessionIdentity of ["session-b", "", undefined, null]) {
      assertRejected(action, { ...currentTarget, sessionIdentity }, /session/i);
    }
    assertRejected({ ...action, target: { ...action.target, sessionIdentity: undefined } }, currentTarget, /session/i);
  }
});
