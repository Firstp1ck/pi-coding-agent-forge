import assert from "node:assert/strict";
import { test } from "node:test";
import { createShellHistory } from "../public/shell-navigation.mjs";
import { mobileNavigationTargetFromSearch } from "../public/mobile-shell-state.mjs";

function navigation(overrides = {}) {
  return {
    piMobileShellV2: true,
    mobileShellState: { route: "chat", surface: "none", surfacePage: "root", routeHistory: [], ...overrides },
  };
}

function fakeWindow({ state = { otherFeature: { selected: 3 } }, href = "https://pi.example/?embed=split&tab=tab_12345678&mobileShell=v2#chat" } = {}) {
  const listeners = new Map();
  const calls = [];
  const entries = [{ state: structuredClone(state), href }];
  let index = 0;
  const window = {
    location: { href },
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      calls.push({ method: "removeEventListener", type, listener });
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event) {
      for (const listener of listeners.get(type) || []) listener(event);
    },
  };
  function write(method, args) {
    const [nextState, , url] = args;
    const entry = { state: structuredClone(nextState), href: url === undefined ? window.location.href : new URL(url, window.location.href).href };
    calls.push({ method, args });
    if (method === "pushState") {
      entries.splice(index + 1);
      entries.push(entry);
      index++;
    } else entries[index] = entry;
    window.location.href = entry.href;
  }
  window.history = {
    get state() { return entries[index].state; },
    pushState(...args) { write("pushState", args); },
    replaceState(...args) { write("replaceState", args); },
    back() {
      calls.push({ method: "back" });
      if (index === 0) return;
      index--;
      window.location.href = entries[index].href;
      window.dispatch("popstate", { type: "popstate", state: window.history.state });
    },
  };
  return { window, listeners, calls, entries };
}

test("construction owns one popstate listener and leaves history and URL untouched", () => {
  const { window, listeners, calls, entries } = fakeWindow();
  const history = createShellHistory({ window, onPopState() {} });
  assert.deepEqual([...listeners.keys()], ["popstate"]);
  assert.equal(listeners.get("popstate").size, 1);
  assert.equal(calls.length, 0);
  assert.equal(entries.length, 1);
  assert.deepEqual(window.history.state, { otherFeature: { selected: 3 } });
  history.dispose();
});

test("push and explicit replace merge current unrelated fields and preserve omitted URL", () => {
  const { window, calls, entries } = fakeWindow();
  const history = createShellHistory({ window, onPopState() {} });
  const originalUrl = window.location.href;
  const state = navigation({ route: "sessions", routeHistory: ["chat"] });
  history.write({ state });
  state.mobileShellState.routeHistory.push("project");
  assert.equal(entries.length, 2);
  assert.deepEqual(window.history.state, {
    otherFeature: { selected: 3 }, ...navigation({ route: "sessions", routeHistory: ["chat"] }),
  });
  assert.equal(calls[0].method, "pushState");
  assert.equal(calls[0].args.length, 2, "omitted URL is omitted from the native call");
  assert.equal(window.location.href, originalUrl);
  window.history.state.laterFeature = "retained";
  history.write({ state: { mobileShellState: navigation({ surface: "more", surfacePage: "settings" }).mobileShellState }, replace: true });
  assert.equal(entries.length, 2);
  assert.equal(calls[1].method, "replaceState");
  assert.equal(window.history.state.piMobileShellV2, true);
  assert.equal(window.history.state.laterFeature, "retained");
  assert.equal(window.history.state.mobileShellState.surfacePage, "settings");
  history.dispose();
});

test("back delegates once and forwards the actual event for caller restoration", () => {
  const { window, calls } = fakeWindow();
  const received = [];
  const history = createShellHistory({ window, onPopState: (event) => received.push(event) });
  history.write({ state: navigation(), replace: true });
  history.write({ state: navigation({ route: "activity", routeHistory: ["chat"] }) });
  history.back();
  assert.equal(calls.filter((call) => call.method === "back").length, 1);
  assert.equal(received.length, 1);
  assert.equal(received[0].state.mobileShellState.route, "chat");
  const event = { state: { legacyOrInvalid: true }, marker: Symbol("original event") };
  window.dispatch("popstate", event);
  assert.equal(received[1], event, "the adapter does not normalize or filter incoming events");
  assert.equal(calls.filter((call) => call.method === "pushState").length, 1);
  history.dispose();
});

test("dispose removes only its own listener, is repeatable, and forbids later history calls", () => {
  const { window, calls, listeners } = fakeWindow();
  let otherCalls = 0;
  let ownCalls = 0;
  const unrelated = () => otherCalls++;
  window.addEventListener("popstate", unrelated);
  for (let cycle = 0; cycle < 3; cycle++) {
    const history = createShellHistory({ window, onPopState: () => ownCalls++ });
    assert.equal(listeners.get("popstate").size, 2);
    const ownedListener = [...listeners.get("popstate")].find((listener) => listener !== unrelated);
    window.dispatch("popstate", {});
    history.dispose();
    history.dispose();
    ownedListener({});
    assert.equal(listeners.get("popstate").size, 1);
    assert.throws(() => history.write({ state: navigation() }), /disposed/);
    assert.throws(() => history.back(), /disposed/);
  }
  window.dispatch("popstate", {});
  assert.equal(ownCalls, 3);
  assert.equal(otherCalls, 4);
  assert.equal(calls.filter((call) => call.method === "removeEventListener").length, 3);
  assert.equal(calls.some((call) => ["pushState", "replaceState", "back"].includes(call.method)), false);
});

test("explicit same-origin URLs preserve existing deep-link and rollout query semantics", () => {
  const { window } = fakeWindow();
  const history = createShellHistory({ window, onPopState() {} });
  const search = "?mobileRoute=activity&tab=tab_12345678&run=run_12345678&blocker=blocker_12345678&embed=split&mobileShell=legacy&tabletShell=v2&shell=classic&custom=a%20b";
  history.write({ state: navigation(), url: `/${search}#details` });
  assert.equal(window.location.href, `https://pi.example/${search}#details`);
  assert.deepEqual(mobileNavigationTargetFromSearch(new URL(window.location.href).search), {
    v: 1, route: "activity", tabId: "tab_12345678", runId: "run_12345678", blockerId: "blocker_12345678",
  });
  history.write({ state: navigation(), replace: true, url: new URL("https://pi.example/?embed=split&tab=tab_87654321") });
  assert.equal(new URL(window.location.href).searchParams.get("tab"), "tab_87654321");
  history.dispose();
});

test("foreign URLs and malformed navigation identifiers fail before a history write", () => {
  const { window, calls } = fakeWindow();
  const history = createShellHistory({ window, onPopState() {} });
  for (const url of [
    "https://elsewhere.example/", "//elsewhere.example/", "http://pi.example/", "javascript:alert(1)",
    "data:text/html,hello", "https://pi.example:444/", "/?tab=private%20title", "/?run=short", "/?blocker=",
    "/?tab=tab_12345678&tab=bad", "/?mobileRoute=unknown", "/?mobileRoute=chat&mobileRoute=unknown", null, {},
  ]) assert.throws(() => history.write({ state: navigation(), url }), TypeError, String(url));
  assert.equal(calls.length, 0);
  history.dispose();
});

test("only serializable navigation fields are accepted, without silently fixing invalid state", () => {
  const { window, calls } = fakeWindow();
  const history = createShellHistory({ window, onPopState() {} });
  const sparseRoutes = Array(1);
  const invalidStates = [
    undefined, null, [], "chat", { draft: "private prompt" }, { piMobileShellV2: false },
    { ...navigation(), [Symbol("extra")]: true },
    ...[
      { route: "settings" }, { surface: "unknown" }, { surfacePage: "" }, { surfacePage: {} },
      { routeHistory: "chat" }, { routeHistory: ["invalid"] }, { routeHistory: sparseRoutes },
      { routeHistory: Array(17).fill("chat") }, { draft: "private prompt" },
    ].map((overrides) => navigation(overrides)),
    { mobileShellState: { route: "chat" } },
  ];
  for (const state of invalidStates) assert.throws(() => history.write({ state }), TypeError);
  assert.throws(() => history.write({ state: navigation(), replace: "yes" }), TypeError);
  assert.equal(calls.length, 0);
  history.dispose();
});

test("all existing route/surface values and the reducer's sixteen-route bound remain usable", () => {
  const { window } = fakeWindow({ state: null });
  const history = createShellHistory({ window, onPopState() {} });
  for (const route of ["chat", "sessions", "activity", "project"]) {
    for (const surface of ["none", "more", "actionSheet", "file", "dialog"]) {
      const state = navigation({ route, surface, routeHistory: Array(16).fill("chat") });
      history.write({ state });
      assert.deepEqual(window.history.state, state);
    }
  }
  history.dispose();
});

test("native history failures propagate without synthetic callbacks or retries", () => {
  const { window } = fakeWindow();
  const failure = new Error("browser denied history write");
  let attempts = 0;
  window.history.pushState = () => { attempts++; throw failure; };
  const history = createShellHistory({ window, onPopState() { assert.fail("unexpected synthetic event"); } });
  assert.throws(() => history.write({ state: navigation() }), (error) => error === failure);
  assert.equal(attempts, 1);
  history.dispose();
});

test("invalid construction fails before installing a listener", () => {
  const { window, listeners } = fakeWindow();
  assert.throws(() => createShellHistory(), TypeError);
  assert.throws(() => createShellHistory({ window }), TypeError);
  assert.equal(listeners.size, 0);
});

test("focused patches merge with mobile and third-party state without retaining caller objects", () => {
  const { window, listeners, entries } = fakeWindow();
  const history = createShellHistory({ window, onPopState() {} });
  history.write({ state: navigation(), replace: true });
  for (const destination of ["conversation", "home", "project", "activity", "settings"]) {
    for (const inspector of [null, "a", "Project:files_1-2", `z${"_".repeat(119)}`]) {
      const focusedShellState = { destination, inspector };
      history.write({ state: { focusedShellState } });
      focusedShellState.destination = "home";
      assert.deepEqual(window.history.state, {
        otherFeature: { selected: 3 }, ...navigation(), focusedShellState: { destination, inspector },
      });
    }
  }
  const focused = { ...window.history.state.focusedShellState };
  const entryCount = entries.length;
  history.write({ state: navigation({ route: "sessions" }), replace: true });
  assert.equal(entries.length, entryCount);
  assert.deepEqual(window.history.state.focusedShellState, focused, "mobile writes retain focused state");
  assert.equal(window.history.state.mobileShellState.route, "sessions");
  assert.deepEqual([...listeners.keys()], ["popstate"]);
  assert.equal(listeners.get("popstate").size, 1);
  history.dispose();
});

test("focused history back forwards the original saved state and URL, then disposal is terminal", () => {
  const { window, listeners, calls } = fakeWindow();
  const received = [];
  const history = createShellHistory({ window, onPopState: (event) => received.push(event) });
  const focusedShellState = { destination: "conversation", inspector: null };
  history.write({ state: { ...navigation(), focusedShellState }, replace: true });
  const originalUrl = window.location.href;
  history.write({ state: { focusedShellState: { destination: "project", inspector: "files" } },
    url: "/?view=project&inspector=files&tab=tab_12345678" });
  history.back();
  assert.equal(received.length, 1);
  assert.equal(received[0].state, window.history.state);
  assert.deepEqual(received[0].state, { otherFeature: { selected: 3 }, ...navigation(), focusedShellState });
  assert.equal(window.location.href, originalUrl);
  assert.equal(calls.filter((call) => call.method === "back").length, 1);
  const listener = [...listeners.get("popstate")][0];
  history.dispose();
  history.dispose();
  listener({ state: { focusedShellState } });
  assert.equal(received.length, 1, "already queued callback is suppressed after disposal");
  assert.equal(listeners.get("popstate").size, 0);
  assert.throws(() => history.write({ state: { focusedShellState } }), /disposed/);
  assert.throws(() => history.back(), /disposed/);
});

test("focused deep links preserve mobile identifiers, rollout flags, unknown queries and fragments", () => {
  const { window } = fakeWindow();
  const history = createShellHistory({ window, onPopState() {} });
  const identity = "tab=tab_12345678&run=run_12345678&blocker=blocker_12345678";
  for (const destination of ["conversation", "home", "project", "activity", "settings"]) {
    const search = `?view=${destination}&inspector=Project%3Afiles_1-2&mobileRoute=activity&${identity}&embed=split&mobileShell=legacy&tabletShell=v2&shell=classic&custom=a%20b&custom=c`;
    history.write({ state: { focusedShellState: { destination, inspector: "Project:files_1-2" } },
      url: `${search}#details` });
    assert.equal(window.location.href, `https://pi.example/${search}#details`);
    assert.deepEqual(mobileNavigationTargetFromSearch(new URL(window.location.href).search), {
      v: 1, route: "activity", tabId: "tab_12345678", runId: "run_12345678", blockerId: "blocker_12345678",
    });
    history.write({ state: {}, url: new URL(window.location.href), replace: true });
    assert.equal(window.location.href, `https://pi.example/${search}#details`);
  }
  history.dispose();
});

test("malformed focused state and queries fail atomically before push or replace", () => {
  const { window, calls, entries } = fakeWindow();
  const history = createShellHistory({ window, onPopState() {} });
  const focused = { destination: "project", inspector: "files" };
  const invalidFocused = [
    undefined, null, [], "project", {}, { destination: "project" }, { inspector: null },
    { ...focused, destination: "chat" }, { ...focused, destination: "sessions" },
    { ...focused, destination: "Settings" }, { ...focused, destination: null },
    { ...focused, inspector: undefined }, { ...focused, inspector: "" },
    { ...focused, inspector: 1 }, { ...focused, inspector: {} },
    { ...focused, inspector: "a\n" }, { ...focused, inspector: "private title" },
    { ...focused, inspector: `a${"b".repeat(120)}` },
    { ...focused, extra: true }, { ...focused, [Symbol("extra")]: true },
    Object.assign(Object.create({ destination: "project" }), { inspector: null }),
  ];
  const invalidUrls = [
    "/?view=", "/?view=chat", "/?view=sessions", "/?view=Project", "/?view=project&view=invalid",
    "/?inspector=", "/?inspector=1files", "/?inspector=private%20title", "/?inspector=files%0A",
    "/?inspector=%C3%A9", "/?inspector=files&inspector=bad.value", `/?inspector=a${"b".repeat(120)}`,
    "/?view=project&inspector=files&tab=bad", "/?view=project&mobileRoute=unknown",
  ];
  for (const replace of [false, true]) {
    for (const focusedShellState of invalidFocused) {
      assert.throws(() => history.write({ state: { ...navigation(), focusedShellState }, replace }), TypeError);
    }
    for (const url of invalidUrls) {
      assert.throws(() => history.write({ state: { focusedShellState: focused }, replace, url }), TypeError, url);
    }
    assert.throws(() => history.write({ state: { focusedShellState: focused, session: "private" }, replace }), TypeError);
  }
  assert.deepEqual(calls, []);
  assert.equal(entries.length, 1);
  assert.deepEqual(window.history.state, { otherFeature: { selected: 3 } });
  assert.equal(window.location.href, entries[0].href);
  history.dispose();
});
