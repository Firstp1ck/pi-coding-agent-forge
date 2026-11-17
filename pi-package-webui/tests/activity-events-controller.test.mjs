import assert from "node:assert/strict";
import test from "node:test";
import {
  createActivityEventsController,
  EVENT_DISPLAY_MODE_STORAGE_KEY,
  EVENT_FILTER_STORAGE_KEY,
  EVENT_FILTER_VALUES,
  normalizeEventDisplayMode,
  normalizeEventFilter,
} from "../public/activity-events-controller.mjs";

// Only the DOM operations used by the port are modeled. HTML parsing is forbidden
// so a renderer that switches from text nodes to markup fails these tests.
class FixtureNode extends EventTarget {
  constructor(tagName = "", text = "") {
    super();
    this.tagName = tagName.toUpperCase();
    this.nodeType = tagName ? 1 : 3;
    this.data = text;
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.attributes = new Map();
    this.className = "";
    this.hidden = false;
    this.value = "";
    this.classList = { contains: (name) => this.className.split(/\s+/).includes(name) };
    this.clickListeners = new Set();
  }

  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get childElementCount() { return this.children.length; }
  get lastElementChild() { return this.children.at(-1) || null; }
  get textContent() {
    return this.nodeType === 3 ? this.data : this.childNodes.map((node) => node.textContent).join("");
  }
  set textContent(value) {
    if (this.nodeType === 3) {
      this.data = String(value);
      return;
    }
    for (const node of this.childNodes) node.parentNode = null;
    this.childNodes = [];
    if (String(value)) this.append(new FixtureNode("", String(value)));
  }
  set innerHTML(_value) { throw new Error("Event content must use text nodes"); }
  get selectedOptions() { return this.children.filter((option) => option.value === this.value); }

  append(...nodes) {
    for (const node of nodes) {
      node.remove();
      node.parentNode = this;
      this.childNodes.push(node);
    }
  }
  prepend(node) {
    node.remove();
    node.parentNode = this;
    this.childNodes.unshift(node);
  }
  remove() {
    if (!this.parentNode) return;
    const siblings = this.parentNode.childNodes;
    siblings.splice(siblings.indexOf(this), 1);
    this.parentNode = null;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (type === "click") this.clickListeners.add(listener);
  }
  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    if (type === "click") this.clickListeners.delete(listener);
  }
  click() {
    const event = new Event("click");
    Object.defineProperty(event, "target", { value: this });
    for (let node = this; node; node = node.parentNode) node.dispatchEvent(event);
  }
}

function fixture({ preferences = new Map(), denyReads = false, denyWrites = false } = {}) {
  const document = {
    createElement: (tag) => new FixtureNode(tag),
    createTextNode: (text) => new FixtureNode("", String(text)),
  };
  const nodes = Object.fromEntries([
    ["eventLog", "div"], ["eventFilterSelect", "select"],
    ["eventFilterStatus", "span"], ["eventFilterEmpty", "p"],
    ["eventDisplayDetailedAction", "button"], ["eventDisplayCompactAction", "button"],
    ["eventsUnreadBadge", "span"],
  ].map(([key, tag]) => [key, document.createElement(tag)]));
  for (const [value, text] of [
    ["all", "All events"], ["errors", "Errors / failures"], ["warnings", "Warnings"],
    ["tools", "Tool activity"], ["tree", "Tree available"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    nodes.eventFilterSelect.append(option);
  }
  const reads = [];
  const writes = [];
  const jumps = [];
  const notices = [];
  const unreadChanges = [];
  let visible = false;
  const controller = createActivityEventsController({
    document,
    nodes,
    readPreference(key) {
      reads.push(key);
      if (denyReads) throw new Error("Storage access denied");
      return preferences.get(key) ?? null;
    },
    writePreference(key, value) {
      writes.push([key, value]);
      if (denyWrites) throw new Error("Storage access denied");
      preferences.set(key, value);
    },
    isVisible: () => visible,
    onJump: (row) => jumps.push(row),
    onNotice: (message, level) => notices.push([message, level]),
    onUnreadChange: (count) => unreadChanges.push(count),
  });
  return {
    document, nodes, controller, reads, writes, jumps, notices, unreadChanges,
    setVisible(value) { visible = value; },
    rows: () => nodes.eventLog.children,
  };
}

function summary(row) { return row.children[0].children[1].textContent; }

function assertDisplay(nodes, mode) {
  assert.equal(nodes.eventLog.dataset.displayMode, mode);
  assert.equal(nodes.eventDisplayDetailedAction.getAttribute("aria-checked"), String(mode === "detailed"));
  assert.equal(nodes.eventDisplayCompactAction.getAttribute("aria-checked"), String(mode === "compact"));
}

test("exports the exact preference keys, filter values, normalizers and controller API", () => {
  assert.equal(EVENT_DISPLAY_MODE_STORAGE_KEY, "pi-webui-event-display-mode-v1");
  assert.equal(EVENT_FILTER_STORAGE_KEY, "pi-webui-event-filter-v1");
  assert.deepEqual([...EVENT_FILTER_VALUES], ["all", "errors", "warnings", "tools", "tree"]);
  for (const value of EVENT_FILTER_VALUES) assert.equal(normalizeEventFilter(value), value);
  for (const value of [null, undefined, "ERRORS", "unknown", 0]) assert.equal(normalizeEventFilter(value), "all");
  assert.equal(normalizeEventDisplayMode("compact"), "compact");
  for (const value of [null, undefined, "COMPACT", "unknown", "detailed"]) assert.equal(normalizeEventDisplayMode(value), "detailed");
  const { controller } = fixture();
  assert.deepEqual(Object.keys(controller).sort(), [
    "add", "setFilter", "setDisplayMode", "syncUi", "clearUnread", "syncVisibility", "getSnapshot", "dispose",
  ].sort());
  assert.deepEqual(controller.getSnapshot(), { filter: "all", displayMode: "detailed", unreadCount: 0 });
  const snapshot = controller.getSnapshot();
  snapshot.filter = "errors";
  assert.equal(controller.getSnapshot().filter, "all");
});

test("restores preferences, synchronizes existing controls and persists only requested changes", () => {
  const f = fixture({ preferences: new Map([
    [EVENT_FILTER_STORAGE_KEY, "tools"], [EVENT_DISPLAY_MODE_STORAGE_KEY, "compact"],
  ]) });
  const { controller: c, nodes } = f;
  assert.deepEqual(f.reads.sort(), [EVENT_FILTER_STORAGE_KEY, EVENT_DISPLAY_MODE_STORAGE_KEY].sort());
  assert.equal(nodes.eventFilterSelect.value, "tools");
  assertDisplay(nodes, "compact");
  assert.equal(nodes.eventFilterStatus.textContent, "No events yet");
  assert.equal(nodes.eventFilterEmpty.hidden, true);
  assert.equal(nodes.eventsUnreadBadge.hidden, true);
  assert.deepEqual(f.writes, []);

  c.setFilter("errors");
  c.setDisplayMode("detailed");
  assert.deepEqual(f.writes, [[EVENT_FILTER_STORAGE_KEY, "errors"], [EVENT_DISPLAY_MODE_STORAGE_KEY, "detailed"]]);
  c.setFilter("warnings", { persist: false });
  c.setDisplayMode("compact", { persist: false });
  assert.equal(f.writes.length, 2);
  assert.equal(nodes.eventFilterSelect.value, "warnings");
  assertDisplay(nodes, "compact");

  nodes.eventFilterSelect.value = "tree";
  nodes.eventLog.dataset.displayMode = "detailed";
  nodes.eventDisplayCompactAction.setAttribute("aria-checked", "false");
  c.syncUi();
  assert.equal(nodes.eventFilterSelect.value, "warnings");
  assertDisplay(nodes, "compact");
  assert.equal(f.writes.length, 2);
  c.setFilter("invalid");
  c.setDisplayMode("invalid");
  assert.equal(nodes.eventFilterSelect.value, "all");
  assertDisplay(nodes, "detailed");
});

test("denied or invalid preference reads fall back and denied writes retain page-local choices", () => {
  for (const options of [
    { denyReads: true, denyWrites: true },
    { preferences: new Map([[EVENT_FILTER_STORAGE_KEY, "bad"], [EVENT_DISPLAY_MODE_STORAGE_KEY, "bad"]]), denyWrites: true },
  ]) {
    const f = fixture(options);
    assert.deepEqual(f.controller.getSnapshot(), { filter: "all", displayMode: "detailed", unreadCount: 0 });
    f.controller.setFilter("errors");
    f.controller.setDisplayMode("compact");
    f.controller.add("failed", "error");
    assert.deepEqual(f.controller.getSnapshot(), { filter: "errors", displayMode: "compact", unreadCount: 1 });
    assert.equal(f.nodes.eventFilterStatus.textContent, "1 of 1");
    assert.equal(f.rows()[0].hidden, false);
    assertDisplay(f.nodes, "compact");
  }
});

test("renders safe text, exact navigation metadata, details and accessible tool rows", () => {
  const f = fixture();
  const occurredAt = 1_700_000_000_123;
  const message = '<img src=x onerror="bad()">';
  const target = '<script>bad()</script>';
  f.controller.add(message, "error", {
    toolCallId: "  tool-id:<exact>  ", toolEventPhase: "finish", occurredAt,
    details: [
      { label: "target", value: target }, { label: "status", value: "failed", tone: "error" },
      null, { label: "empty", value: "" }, { label: "", value: "skip" }, { label: "zero", value: 0 },
    ],
  });
  const row = f.rows()[0];
  assert.equal(row.tagName, "BUTTON");
  assert.equal(row.type, "button");
  assert.equal(row.className, "event error");
  assert.deepEqual(row.dataset, {
    eventLevel: "error", chatEventTimestamp: String(occurredAt),
    eventTreeAvailable: "true", chatToolCallId: "tool-id:<exact>", eventToolPhase: "finish",
  });
  assert.equal(row.getAttribute("aria-keyshortcuts"), "ContextMenu Shift+F10");
  assert.equal(row.children[0].className, "event-main");
  assert.equal(row.children[0].children[0].textContent, `[${new Date(occurredAt).toLocaleTimeString()}]`);
  assert.equal(summary(row), message);
  assert.equal(row.children[0].children[1].childElementCount, 0);
  const details = row.children[1];
  assert.equal(details.className, "event-details");
  assert.equal(details.childElementCount, 2);
  assert.equal(details.children[0].textContent, `target: ${target}`);
  assert.equal(details.children[0].children[0].className, "event-detail-label");
  assert.equal(details.children[0].childNodes[1].nodeType, 3);
  assert.equal(details.children[1].className, "event-detail error");
  assert.equal(row.title, "Jump to this event in the chat; open the context menu for display options and Tree navigation");
  assert.equal(row.getAttribute("aria-label"), `${row.textContent.trim()}. Jump to this event in the chat. Context menu: display options and Tree navigation.`);
  assert.deepEqual(f.notices, [[message, "error"]]);

  row.click();
  details.children[0].children[0].click();
  assert.equal(f.jumps.length, 2);
  assert.equal(f.jumps[0], row);
  assert.equal(f.jumps[1], row);
});

test("keeps tool phase and Tree eligibility distinct and skips invalid or empty details", () => {
  const f = fixture();
  for (const [options, expected] of [
    [{ toolCallId: " id ", toolEventPhase: "start" }, { eventTreeAvailable: "true", chatToolCallId: "id", eventToolPhase: "start" }],
    [{ toolCallId: "id", toolEventPhase: "update", details: "not an array" }, { eventTreeAvailable: "false", chatToolCallId: "id" }],
    [{ toolEventPhase: "finish", details: [{ label: "missing value" }] }, { eventTreeAvailable: "false", eventToolPhase: "finish" }],
    [{ toolCallId: "   " }, { eventTreeAvailable: "false" }],
  ]) {
    f.controller.add("row", "info", options);
    const row = f.rows()[0];
    const { eventLevel, chatEventTimestamp, ...metadata } = row.dataset;
    assert.equal(eventLevel, "info");
    assert.ok(Number.isFinite(Number(chatEventTimestamp)));
    assert.deepEqual(metadata, expected);
    assert.equal(row.childElementCount, 1);
    assert.equal(row.title.includes("and Tree navigation"), expected.eventTreeAvailable === "true");
    assert.equal(row.getAttribute("aria-label").includes("and Tree navigation"), expected.eventTreeAvailable === "true");
  }
});

test("prepends arrivals, caps retained DOM at 120 and leaves no listeners on evicted rows", () => {
  const f = fixture();
  f.controller.add("oldest");
  const oldest = f.rows()[0];
  for (let i = 0; i < 120; i += 1) f.controller.add(`event ${i}`);
  assert.equal(f.rows().length, 120);
  assert.equal(summary(f.rows()[0]), "event 119");
  assert.equal(summary(f.rows().at(-1)), "event 0");
  assert.equal(f.nodes.eventFilterStatus.textContent, "120 events");
  assert.equal(oldest.parentNode, null);
  assert.equal(oldest.clickListeners.size, 0);
  oldest.click();
  assert.deepEqual(f.jumps, []);
});

test("aggregates from retained DOM, promotes replacement rows and preserves latest metadata", () => {
  const f = fixture();
  const options = { aggregateKey: "  warnings  ", aggregateSingular: "warning", aggregatePlural: "warnings" };
  f.controller.add("Received", "warn", { ...options, occurredAt: 10 });
  const original = f.rows()[0];
  assert.equal(summary(original), "Received 1 warning");
  f.controller.add("unrelated");
  f.controller.add("Received", "error", {
    ...options, aggregateIncrement: 2.9, occurredAt: 20, toolCallId: "latest-call", toolEventPhase: "finish",
  });
  const replacement = f.rows()[0];
  assert.equal(f.rows().length, 2);
  assert.equal(summary(replacement), "Received 3 warnings");
  assert.equal(replacement.dataset.eventAggregateKey, "warnings");
  assert.equal(replacement.dataset.eventAggregateCount, "3");
  assert.equal(replacement.dataset.chatEventTimestamp, "20");
  assert.equal(replacement.dataset.chatToolCallId, "latest-call");
  assert.equal(replacement.dataset.eventLevel, "error");
  assert.equal(original.parentNode, null);
  assert.equal(original.clickListeners.size, 0);
  original.click();
  replacement.click();
  assert.deepEqual(f.jumps, [replacement]);
  assert.deepEqual(f.notices, [["Received 1 warning", "warn"], ["Received 3 warnings", "error"]]);
  assert.deepEqual(f.unreadChanges, [1, 2]);
  f.controller.setFilter("warnings");
  assert.equal(replacement.hidden, true);
  assert.equal(f.nodes.eventFilterStatus.textContent, "0 of 2");

  // The DOM is the sole history. Removing it retires the aggregate count.
  replacement.remove();
  f.controller.add("Received", "info", { ...options, aggregateIncrement: -4 });
  assert.equal(summary(f.rows()[0]), "Received 1 warning");
  f.controller.add("Received", "info", { ...options, aggregateIncrement: "bad", aggregatePlural: "" });
  assert.equal(summary(f.rows()[0]), "Received 2 warning");
  f.controller.add("plain summary", "info", { aggregateKey: "warnings", aggregateIncrement: 0 });
  assert.equal(summary(f.rows()[0]), "plain summary");
  assert.equal(f.rows()[0].dataset.eventAggregateCount, "3");
});

test("all five filters use row metadata, update on arrivals and expose counts and empty states", () => {
  const f = fixture();
  const c = f.controller;
  c.setFilter("errors");
  assert.equal(f.nodes.eventFilterEmpty.hidden, true);
  c.add("ordinary");
  assert.equal(f.nodes.eventFilterStatus.textContent, "0 of 1");
  assert.equal(f.nodes.eventFilterEmpty.hidden, false);
  assert.equal(f.nodes.eventFilterEmpty.textContent, "No events match errors / failures.");
  c.add("failure", "error", { notify: false });
  c.add("warning", "warn", { notify: false });
  c.add("started", "info", { toolCallId: "start-id", toolEventPhase: "start" });
  c.add("finished", "error", { toolCallId: "finish-id", toolEventPhase: "finish", notify: false });
  c.add("phase only", "info", { toolEventPhase: "start" });
  c.add("id only", "info", { toolCallId: "not-a-boundary" });
  c.add("normalized level", " ERROR ", { notify: false });
  const expected = {
    all: ["normalized level", "id only", "phase only", "finished", "started", "warning", "failure", "ordinary"],
    errors: ["normalized level", "finished", "failure"],
    warnings: ["warning"],
    tools: ["phase only", "finished", "started"],
    tree: ["finished", "started"],
  };
  const rows = f.rows();
  for (const [filter, messages] of Object.entries(expected)) {
    c.setFilter(filter);
    assert.deepEqual(f.rows().filter((row) => !row.hidden).map(summary), messages);
    assert.equal(f.nodes.eventFilterStatus.textContent, filter === "all" ? "8 events" : `${messages.length} of 8`);
    assert.equal(f.nodes.eventFilterEmpty.hidden, true);
    for (let i = 0; i < rows.length; i += 1) assert.equal(f.rows()[i], rows[i]);
  }
  for (const row of f.rows()) row.remove();
  c.syncUi();
  assert.equal(f.nodes.eventFilterStatus.textContent, "No events yet");
  assert.equal(f.nodes.eventFilterEmpty.hidden, true);
  c.setFilter("all");
  c.add("one");
  assert.equal(f.nodes.eventFilterStatus.textContent, "1 event");
});

test("unread uses actual host visibility only and notifies on count changes", () => {
  const f = fixture();
  const c = f.controller;
  assert.equal(f.nodes.eventsUnreadBadge.textContent, "0");
  c.add("info");
  c.add("success", "success");
  c.add("quiet error", "error", { notify: false });
  c.add("quiet warning", "warn", { notify: false });
  assert.deepEqual(f.unreadChanges, []);
  assert.deepEqual(f.notices, []);
  c.add("hidden warning", "warn");
  assert.equal(f.nodes.eventsUnreadBadge.textContent, "1");
  assert.equal(f.nodes.eventsUnreadBadge.hidden, false);
  assert.equal(f.nodes.eventsUnreadBadge.getAttribute("aria-label"), "1 unread warning or errors");
  c.syncVisibility();
  assert.equal(c.getSnapshot().unreadCount, 1);

  f.setVisible(true);
  c.add("visible error", "error");
  assert.equal(c.getSnapshot().unreadCount, 1);
  c.syncVisibility();
  assert.equal(c.getSnapshot().unreadCount, 0);
  assert.equal(f.nodes.eventsUnreadBadge.hidden, true);
  assert.equal(f.nodes.eventsUnreadBadge.getAttribute("aria-label"), "0 unread warnings or errors");
  c.syncVisibility();
  c.clearUnread();
  assert.deepEqual(f.unreadChanges, [1, 0]);
  assert.deepEqual(f.notices, [["hidden warning", "warn"], ["visible error", "error"]]);

  // A stale Classic wrapper must not override the parent's focused-host answer.
  f.nodes.eventLog.hidden = true;
  c.add("focused warning", "warn");
  assert.equal(c.getSnapshot().unreadCount, 0);
  f.nodes.eventLog.hidden = false;
  f.setVisible(false);
  c.setFilter("tools");
  c.add("filtered error", "error");
  assert.equal(f.rows()[0].hidden, true);
  assert.equal(c.getSnapshot().unreadCount, 1);
  c.clearUnread();
  assert.deepEqual(f.unreadChanges, [1, 0, 1, 0]);
});

test("unread counts arrivals beyond the history limit and caps only the badge label", () => {
  const f = fixture();
  for (let i = 0; i < 125; i += 1) f.controller.add(`failure ${i}`, "error");
  assert.equal(f.rows().length, 120);
  assert.equal(f.controller.getSnapshot().unreadCount, 125);
  assert.equal(f.nodes.eventsUnreadBadge.textContent, "99+");
  assert.equal(f.nodes.eventsUnreadBadge.getAttribute("aria-label"), "125 unread warnings or errors");
  assert.deepEqual(f.unreadChanges, Array.from({ length: 125 }, (_, i) => i + 1));
  f.setVisible(true);
  f.controller.syncVisibility();
  assert.equal(f.nodes.eventsUnreadBadge.textContent, "0");
  assert.equal(f.unreadChanges.at(-1), 0);
});

test("canonical rows and click targets survive host moves and UI synchronization", () => {
  const f = fixture();
  f.controller.add("canonical", "info", { toolCallId: "kept-id", toolEventPhase: "start" });
  const row = f.rows()[0];
  const content = f.document.createElement("div");
  content.append(f.nodes.eventLog);
  const classic = f.document.createElement("section");
  const focused = f.document.createElement("section");
  classic.append(content);
  focused.append(content);
  f.controller.setDisplayMode("compact");
  f.controller.syncUi();
  row.children[0].children[1].click();
  classic.append(content);
  f.controller.setDisplayMode("detailed");
  f.controller.syncUi();
  row.click();
  assert.equal(f.rows()[0], row);
  assert.equal(row.dataset.chatToolCallId, "kept-id");
  assert.deepEqual(f.jumps, [row, row]);
});

test("dispose removes only owned listeners, retains nodes and makes every mutation a no-op", () => {
  const f = fixture();
  const c = f.controller;
  c.add("kept", "warn");
  c.setFilter("errors");
  c.setDisplayMode("compact");
  const row = f.rows()[0];
  const snapshot = c.getSnapshot();
  const writes = [...f.writes];
  const notices = [...f.notices];
  const changes = [...f.unreadChanges];
  const rowText = row.textContent;
  let parentClicks = 0;
  row.addEventListener("click", () => { parentClicks += 1; });
  assert.equal(row.clickListeners.size, 1);
  assert.equal(f.nodes.eventLog.clickListeners.size, 1);
  c.dispose();
  c.dispose();
  assert.equal(row.clickListeners.size, 1);
  assert.equal(f.nodes.eventLog.clickListeners.size, 0);
  row.click();
  assert.equal(parentClicks, 1);
  assert.deepEqual(f.jumps, []);
  f.setVisible(true);
  c.add("ignored", "error", { aggregateKey: "ignored" });
  c.setFilter("all");
  c.setDisplayMode("detailed");
  c.clearUnread();
  c.syncVisibility();
  c.syncUi();
  assert.deepEqual(c.getSnapshot(), snapshot);
  assert.deepEqual(f.writes, writes);
  assert.deepEqual(f.notices, notices);
  assert.deepEqual(f.unreadChanges, changes);
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0], row);
  assert.equal(row.textContent, rowText);
  assert.equal(row.hidden, true);
  assert.equal(f.nodes.eventFilterSelect.value, "errors");
  assertDisplay(f.nodes, "compact");
  assert.equal(f.nodes.eventsUnreadBadge.textContent, "1");
});

test("delegated navigation ignores the log background and retains no listener on detached rows", () => {
  const f = fixture();
  f.nodes.eventLog.click();
  assert.deepEqual(f.jumps, []);
  f.controller.add("detached");
  const detached = f.rows()[0];
  // A detail tone may share a class name; navigation must still use the row.
  f.controller.add("nested", "info", { details: [{ label: "target", value: "safe", tone: "event" }] });
  const canonical = f.rows()[0];
  canonical.children[1].children[0].click();
  assert.deepEqual(f.jumps, [canonical]);
  detached.remove();
  assert.equal(detached.clickListeners.size, 0);
  f.controller.dispose();
  detached.click();
  canonical.click();
  assert.deepEqual(f.jumps, [canonical]);
  assert.equal(f.nodes.eventLog.clickListeners.size, 0);
});
