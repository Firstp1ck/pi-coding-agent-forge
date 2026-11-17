import assert from "node:assert/strict";
import { test } from "node:test";
import { createActivityAgentsController } from "../public/activity-agents-controller.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tab = { groupId: "tab:parent-a", tabId: "parent-a" };
const running = (id = "run-a") => ({ id, status: "running", capabilities: { cancel: true }, agents: [{ id: "agent-a" }] });
const done = (id = "done-a") => ({ id, status: "done", capabilities: { open: true } });
const overview = (runs = [], extra = {}) => ({
  version: 2,
  runningAgents: 0,
  tabs: [{ tabId: "parent-a", gates: [] }],
  groups: [{ id: "tab:parent-a", kind: "tab", tabId: "parent-a", runs }],
  ...extra,
});

function fakeTimers() {
  let serial = 0;
  const pending = new Map();
  const history = new Map();
  return {
    pending, history,
    setTimeout(callback, delay) {
      const id = ++serial;
      const timer = { callback, delay };
      pending.set(id, timer);
      history.set(id, timer);
      return id;
    },
    clearTimeout(id) { pending.delete(id); },
    fire(id = [...pending.keys()][0]) {
      const timer = pending.get(id);
      assert.ok(timer, `timer ${id} must be pending`);
      pending.delete(id);
      return timer.callback();
    },
    delay() {
      assert.equal(pending.size, 1);
      return [...pending.values()][0].delay;
    },
  };
}

function fixture(overrides = {}) {
  const calls = [];
  const changes = [];
  const overviews = [];
  const settled = [];
  const events = [];
  const statuses = [];
  const closed = [];
  const policyInputs = [];
  const settings = { visibility: "visible", autoClear: false };
  const timers = fakeTimers();
  let controller;
  controller = createActivityAgentsController({
    api(path, options) {
      let resolve;
      let reject;
      const pending = new Promise((accept, fail) => { resolve = accept; reject = fail; });
      calls.push({ path, options, resolve: (data = null) => resolve({ data }), reject });
      return pending;
    },
    getVisibility: () => settings.visibility,
    getAutoClear: () => settings.autoClear,
    finishedSelections(data) {
      policyInputs.push(data);
      return (data?.groups || []).flatMap((group) => group.runs
        .filter((run) => ["done", "failed", "cancelled"].includes(run.status) && run.capabilities?.open)
        .map((run) => ({ groupId: group.id, runId: run.id })));
    },
    canCancel: (run, agent) => ["queued", "running"].includes(agent?.status || run.status) && (agent?.capabilities || run.capabilities)?.cancel === true,
    canDismiss: (run) => run.attached === true || ["done", "failed", "cancelled"].includes(run.status) && run.capabilities?.open === true,
    isAttachedProjection: (run) => run.attached === true,
    agentCount: (run) => run.agents?.length || 0,
    onOverview: (data) => overviews.push(data),
    onRefreshSettled: () => settled.push(controller.getSnapshot()),
    onChange: () => changes.push(controller.getSnapshot()),
    onEvent: (...args) => events.push(args),
    onCancelStatus: (...args) => statuses.push(args),
    onCancelClosed: (selection) => closed.push(selection),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    ...overrides,
  });
  return {
    controller, calls, changes, overviews, settled, events, statuses, closed, settings, timers, policyInputs,
    async seed(data = overview()) {
      const request = controller.refresh();
      calls.at(-1).resolve(data);
      await request;
      return data;
    },
  };
}

test("construction is inert and snapshots borrow the one overview without cloning", async () => {
  const f = fixture();
  const c = f.controller;
  assert.deepEqual(Object.keys(c).sort(), ["start", "refresh", "schedule", "getSnapshot", "beginCancel", "resetCancel", "submitCancel", "dismiss", "clearFinished", "dispose"].sort());
  assert.deepEqual(c.getSnapshot(), { data: null, error: null, loading: false, clearingFinished: false, cancelSelection: null, cancelSubmitting: false });
  assert.equal(f.calls.length, 0);
  assert.equal(f.timers.pending.size, 0);
  const data = await f.seed(overview([running()]));
  const snapshot = c.getSnapshot();
  assert.ok(Object.isFrozen(snapshot));
  assert.throws(() => { snapshot.data = null; }, TypeError);
  assert.strictEqual(snapshot.data, data);
  assert.strictEqual(c.getSnapshot().data, data);
  assert.equal(f.calls[0].path, "/api/subagents");
  assert.deepEqual(f.calls[0].options, { scoped: false });
  assert.deepEqual(f.overviews, [data]);
  assert.equal(f.settled.length, 1);
  assert.equal(f.changes[0].loading, true);
  assert.equal(f.changes.at(-1).loading, false);
});

test("overlapping refreshes coalesce into one follow-up per in-flight batch", async () => {
  const f = fixture();
  const c = f.controller;
  const first = c.refresh();
  const second = c.refresh();
  const third = c.refresh();
  assert.equal(f.calls.length, 1);
  const early = overview([running()], { updatedAt: 1 });
  f.calls[0].resolve(early);
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(c.getSnapshot().loading, true);
  assert.deepEqual(f.overviews, [early]);
  assert.equal(f.settled.length, 0);
  const fourth = c.refresh();
  const fifth = c.refresh();
  f.calls[1].resolve(overview([], { updatedAt: 2 }));
  await tick();
  assert.equal(f.calls.length, 3);
  const last = overview([done()], { updatedAt: 3 });
  f.calls[2].resolve(last);
  await Promise.all([first, second, third, fourth, fifth]);
  assert.strictEqual(c.getSnapshot().data, last);
  assert.equal(c.getSnapshot().loading, false);
  assert.equal(f.settled.length, 1);
  assert.equal(f.overviews.length, 3);
  assert.equal(f.timers.pending.size, 0);
});

test("refresh failure retains the overview and a later success clears the error", async () => {
  const f = fixture();
  const data = await f.seed();
  const failure = new Error("overview unavailable");
  const failed = f.controller.refresh();
  f.calls[1].reject(failure);
  await failed;
  assert.strictEqual(f.controller.getSnapshot().data, data);
  assert.strictEqual(f.controller.getSnapshot().error, failure);
  assert.equal(f.controller.getSnapshot().loading, false);
  assert.equal(f.overviews.length, 1);
  assert.equal(f.settled.length, 2);
  const recovered = f.controller.refresh();
  f.calls[2].resolve();
  await recovered;
  assert.equal(f.controller.getSnapshot().data, null);
  assert.equal(f.controller.getSnapshot().error, null);
});

test("start is idempotent and schedules only after its initial request settles", async () => {
  const f = fixture();
  const initial = f.controller.start();
  f.controller.start();
  f.controller.start();
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.pending.size, 0);
  f.calls[0].resolve(overview());
  await initial;
  assert.equal(f.timers.delay(), 4000);
  f.controller.start();
  assert.equal(f.calls.length, 1);
  assert.equal(f.timers.pending.size, 1);
});

test("polling retains active, running-gate, idle and hidden cadence with one replaceable timer", async () => {
  const f = fixture();
  const c = f.controller;
  await f.seed(overview([], { runningAgents: 2 }));
  c.schedule();
  assert.equal(f.timers.delay(), 1500);
  await f.seed(overview([], { tabs: [{ tabId: "parent-a", gates: [{ status: "running" }] }] }));
  c.schedule();
  assert.equal(f.timers.delay(), 1500);
  await f.seed(overview());
  c.schedule();
  assert.equal(f.timers.delay(), 4000);
  const requests = f.calls.length;
  f.settings.visibility = "hidden";
  c.schedule();
  assert.equal(f.timers.delay(), 10_000);
  assert.equal(f.calls.length, requests, "hiding does not dismiss or cancel");
  c.schedule(0);
  assert.equal(f.timers.delay(), 0);
  const poll = f.timers.fire();
  f.calls.at(-1).resolve(overview());
  await poll;
  assert.equal(f.timers.delay(), 10_000);
});

test("a newer explicit schedule survives both initial and timer refresh finalizers", async () => {
  const f = fixture();
  const c = f.controller;
  const initial = c.start();
  c.schedule(71);
  f.calls[0].resolve(overview());
  await initial;
  assert.equal(f.timers.delay(), 71);
  const oldId = [...f.timers.pending.keys()][0];
  const poll = f.timers.fire(oldId);
  c.schedule(83);
  f.calls[1].resolve(overview());
  await poll;
  assert.equal(f.timers.delay(), 83);
  const count = f.calls.length;
  await f.timers.history.get(oldId).callback();
  assert.equal(f.calls.length, count, "a superseded callback cannot refresh");
});

test("cancel selection preserves explicit group/run/agent identity and checks supplied policy", () => {
  const policyCalls = [];
  const countCalls = [];
  const f = fixture({
    canCancel: (...args) => { policyCalls.push(args); return args[1]?.allowed === true; },
    agentCount: (run) => { countCalls.push(run); return 3; },
  });
  const run = running();
  const agent = { id: "display-id", instanceId: "instance-id", allowed: true };
  const external = { groupId: "external", tabId: "display-tab" };
  assert.equal(f.controller.beginCancel({}, run, agent), null);
  assert.equal(f.controller.beginCancel(external, {}, agent), null);
  assert.equal(f.controller.beginCancel(external, run), null);
  const selection = f.controller.beginCancel(external, run, agent);
  assert.deepEqual(selection, { groupId: "external", tabId: "display-tab", runId: "run-a", agentId: "instance-id", agentCount: 3 });
  assert.ok(Object.isFrozen(selection));
  assert.strictEqual(f.controller.getSnapshot().cancelSelection, selection);
  assert.deepEqual(policyCalls, [[run, null], [run, agent]]);
  assert.deepEqual(countCalls, [run]);
  assert.equal(f.calls.length, 0);
  const replacement = f.controller.beginCancel(tab, running("run-b"), agent);
  assert.equal(replacement.runId, "run-b");
  assert.notStrictEqual(replacement, selection);
});

test("cancel submits the captured unscoped whole-run request, locks duplicates, then refreshes", async () => {
  const f = fixture();
  const c = f.controller;
  const external = { groupId: "external", tabId: "parent-a" };
  const run = running();
  run.agents.push({ id: "agent-b" });
  const selection = c.beginCancel(external, run, { id: "agent-id", instanceId: "instance-id" });
  const cancel = c.submitCancel({ reason: "  duplicate work  ", note: "  keep artifacts \n" });
  assert.equal(c.getSnapshot().cancelSubmitting, true);
  assert.equal(c.beginCancel(tab, running("replacement")), null);
  assert.equal(await c.submitCancel(), false);
  external.groupId = "changed";
  run.id = "changed";
  assert.deepEqual(f.calls[0].options, {
    method: "POST", scoped: false,
    body: { group: "external", runId: "run-a", agentId: "instance-id", reason: "duplicate work", note: "keep artifacts" },
  });
  assert.equal(f.calls[0].path, "/api/subagents/cancel");
  assert.deepEqual(f.statuses.at(-1), ["Cancelling subagent…"]);
  f.calls[0].resolve();
  await tick();
  assert.deepEqual(f.closed, [selection]);
  assert.deepEqual(f.events, [["cancelled run run-a; the parent agent was notified", "info"]]);
  assert.equal(f.calls[1].path, "/api/subagents");
  f.calls[1].resolve(overview());
  assert.equal(await cancel, true);
  assert.equal(c.getSnapshot().cancelSubmitting, false);
  assert.equal(f.timers.delay(), 4000);
});

test("cancel omits empty optional fields and prefers the agent id when no instance id exists", async () => {
  const f = fixture();
  f.controller.beginCancel(tab, running());
  const first = f.controller.submitCancel({ reason: " \n", note: " " });
  assert.deepEqual(f.calls[0].options.body, { group: "tab:parent-a", runId: "run-a" });
  f.calls[0].reject(new Error("denied"));
  await first;
  f.controller.beginCancel(tab, running(), { id: "agent-id" });
  const second = f.controller.submitCancel();
  assert.deepEqual(f.calls[1].options.body, { group: "tab:parent-a", runId: "run-a", agentId: "agent-id" });
  f.calls[1].reject("offline");
  await second;
  assert.deepEqual(f.statuses.at(-1), ["subagent cancel failed: offline", "error"]);
});

test("cancel failure keeps the selection, reports original status and releases only its lock", async () => {
  const f = fixture();
  const selection = f.controller.beginCancel(tab, running());
  const request = f.controller.submitCancel();
  f.calls[0].reject(new Error("not cancellable"));
  assert.equal(await request, false);
  assert.strictEqual(f.controller.getSnapshot().cancelSelection, selection);
  assert.equal(f.controller.getSnapshot().cancelSubmitting, false);
  assert.deepEqual(f.statuses.at(-1), ["subagent cancel failed: not cancellable", "error"]);
  assert.deepEqual(f.events, [["subagent cancel failed: not cancellable", "error"]]);
  assert.equal(f.closed.length, 0);
  assert.equal(f.calls.length, 1);
  const retry = f.controller.submitCancel();
  assert.equal(f.calls.length, 2);
  f.calls[1].reject(new Error("still denied"));
  await retry;
});

for (const outcome of ["success", "failure"]) {
  test(`reset/reopen rejects an old cancel ${outcome} and its finally cannot unlock a new request`, async () => {
    const f = fixture();
    const c = f.controller;
    const previous = c.beginCancel(tab, running());
    const old = c.submitCancel();
    c.resetCancel();
    assert.equal(c.getSnapshot().cancelSubmitting, false);
    const next = c.beginCancel(tab, running());
    assert.deepEqual(next, previous);
    assert.notStrictEqual(next, previous, "reopening the same run still creates a new selection owner");
    const current = c.submitCancel({ reason: "new reason" });
    const callbacks = [f.statuses.length, f.changes.length];
    if (outcome === "success") f.calls[0].resolve();
    else f.calls[0].reject(new Error("old failure"));
    assert.equal(await old, false);
    assert.strictEqual(c.getSnapshot().cancelSelection, next);
    assert.equal(c.getSnapshot().cancelSubmitting, true);
    assert.deepEqual([f.statuses.length, f.changes.length], callbacks);
    assert.deepEqual(f.closed, []);
    assert.deepEqual(f.events, []);
    assert.equal(f.calls.length, 2);
    f.calls[1].resolve();
    await tick();
    assert.deepEqual(f.closed, [next]);
    f.calls[2].resolve(overview());
    await current;
    assert.equal(c.getSnapshot().cancelSubmitting, false);
  });
}

test("success closes only the selected dialog and its pending refresh cannot unlock a reopened dialog", async () => {
  let f;
  f = fixture({ onCancelClosed(selection) {
    f.closed.push(selection);
    f.controller.resetCancel();
  } });
  const c = f.controller;
  const firstSelection = c.beginCancel(tab, running());
  const old = c.submitCancel();
  f.calls[0].resolve();
  await tick();
  assert.deepEqual(f.closed, [firstSelection]);
  const next = c.beginCancel(tab, running("run-b"));
  const current = c.submitCancel();
  assert.equal(f.calls[1].path, "/api/subagents");
  assert.equal(f.calls[2].path, "/api/subagents/cancel");
  f.calls[1].resolve(overview());
  await old;
  assert.strictEqual(c.getSnapshot().cancelSelection, next);
  assert.equal(c.getSnapshot().cancelSubmitting, true);
  f.calls[2].reject(new Error("new error"));
  await current;
  assert.deepEqual(f.statuses.at(-1), ["subagent cancel failed: new error", "error"]);
  assert.equal(c.getSnapshot().cancelSubmitting, false);
});

test("resetting or closing selection is local and does not clear overview resources", async () => {
  const f = fixture();
  const data = await f.seed(overview([running()]));
  const count = f.calls.length;
  f.controller.beginCancel(tab, running());
  f.controller.resetCancel();
  assert.equal(f.controller.getSnapshot().cancelSelection, null);
  assert.equal(f.controller.getSnapshot().cancelSubmitting, false);
  assert.strictEqual(f.controller.getSnapshot().data, data);
  assert.equal(f.calls.length, count);
  assert.deepEqual(f.closed, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.statuses.at(-1), [""]);
});

test("dismiss validates capability and preserves external group identity and detach wording", async () => {
  const f = fixture();
  const c = f.controller;
  assert.equal(await c.dismiss({}, done()), false);
  assert.equal(await c.dismiss(tab, running()), false);
  assert.equal(f.calls.length, 0);
  const external = { groupId: "external", tabId: "parent-a" };
  const projection = { id: "projection-a", status: "stale", attached: true };
  const request = c.dismiss(external, projection);
  assert.equal(f.calls[0].path, "/api/subagents/dismiss");
  assert.deepEqual(f.calls[0].options, { method: "POST", scoped: false, body: { group: "external", runId: "projection-a" } });
  external.groupId = "changed";
  projection.id = "changed";
  f.calls[0].resolve();
  await tick();
  assert.deepEqual(f.events, [["detached persisted session projection projection-a", "info"]]);
  assert.deepEqual(f.closed, []);
  f.calls[1].resolve(overview());
  assert.equal(await request, true);
  assert.equal(f.timers.delay(), 4000);
});

test("finished dismissal reports its own event, while failure does not refresh or close a dialog", async () => {
  const f = fixture();
  const c = f.controller;
  const selection = c.beginCancel(tab, running());
  const first = c.dismiss(tab, done());
  f.calls[0].resolve();
  await tick();
  f.calls[1].resolve(overview());
  await first;
  assert.deepEqual(f.events, [["dismissed finished subagent run done-a", "info"]]);
  const failed = c.dismiss(tab, done("failed-b"));
  f.calls[2].reject(new Error("cannot dismiss"));
  assert.equal(await failed, false);
  assert.deepEqual(f.events.at(-1), ["subagent dismiss failed: cannot dismiss", "error"]);
  assert.equal(f.calls.length, 3);
  assert.strictEqual(c.getSnapshot().cancelSelection, selection);
  assert.deepEqual(f.closed, []);
});

test("a mutation overlapping an overview fetch requests one authoritative follow-up", async () => {
  const f = fixture();
  const refresh = f.controller.refresh();
  const dismiss = f.controller.dismiss(tab, done());
  f.calls[1].resolve();
  await tick();
  assert.equal(f.calls.length, 2);
  const beforeDismissal = overview([done()]);
  f.calls[0].resolve(beforeDismissal);
  await tick();
  assert.equal(f.calls.length, 3);
  const afterDismissal = overview();
  f.calls[2].resolve(afterDismissal);
  await Promise.all([refresh, dismiss]);
  assert.strictEqual(f.controller.getSnapshot().data, afterDismissal);
  assert.equal(f.settled.length, 1);
});

test("Clear finished snapshots selections, dismisses sequentially, and reports partial failure", async () => {
  const selections = [{ groupId: "tab:parent-a", runId: "done-a" }, { groupId: "external", runId: "done-b" }, { groupId: "external", runId: "done-c" }];
  const f = fixture({ finishedSelections: () => selections });
  const c = f.controller;
  await f.seed(overview([done()]));
  c.schedule();
  const clear = c.clearFinished();
  assert.equal(c.getSnapshot().clearingFinished, true);
  assert.equal(f.timers.pending.size, 0);
  assert.equal(f.calls.length, 2);
  selections[1].groupId = "changed";
  selections.push({ groupId: "external", runId: "new-run" });
  await c.clearFinished();
  assert.equal(f.calls.length, 2);
  f.calls[1].resolve();
  await tick();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[2].options.body, { group: "external", runId: "done-b" });
  f.calls[2].reject(new Error("permission denied"));
  await tick();
  assert.equal(f.calls.length, 4);
  f.calls[3].resolve();
  await tick();
  assert.equal(f.calls[4].path, "/api/subagents");
  assert.equal(c.getSnapshot().clearingFinished, true);
  f.calls[4].resolve(overview());
  await clear;
  assert.equal(f.calls.length, 5);
  assert.equal(c.getSnapshot().clearingFinished, false);
  assert.equal(c.getSnapshot().loading, false);
  assert.deepEqual(f.events, [["cleared 2 finished subagent runs", "info"], ["could not clear 1 finished subagent run", "warn"]]);
  assert.deepEqual(f.calls.slice(1, 4).map((call) => call.options), [
    { method: "POST", scoped: false, body: { group: "tab:parent-a", runId: "done-a" } },
    { method: "POST", scoped: false, body: { group: "external", runId: "done-b" } },
    { method: "POST", scoped: false, body: { group: "external", runId: "done-c" } },
  ]);
  assert.equal(f.timers.delay(), 4000);
});

test("Clear finished is inert during loading or without policy-eligible selections", async () => {
  const f = fixture();
  const c = f.controller;
  await c.clearFinished();
  assert.equal(f.calls.length, 0);
  const pending = c.refresh();
  await c.clearFinished();
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve(overview([running(), { id: "stale", status: "stale", attached: true }, { id: "no-open", status: "done" }]));
  await pending;
  await c.clearFinished();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.events, []);
});

test("Auto-Clear uses only supplied eligible groups and cannot recurse on its refresh", async () => {
  const f = fixture();
  f.settings.autoClear = true;
  const c = f.controller;
  const data = overview([running(), done(), { id: "retained", status: "done", capabilities: { open: false } }]);
  data.groups.push({ id: "external", kind: "external", runs: [done("external-done")] });
  const initial = c.refresh();
  f.calls[0].resolve(data);
  await tick();
  assert.strictEqual(f.policyInputs[0], data);
  assert.equal(f.calls[1].path, "/api/subagents/dismiss");
  assert.deepEqual(f.calls[1].options.body, { group: "tab:parent-a", runId: "done-a" });
  f.calls[1].resolve();
  await tick();
  assert.deepEqual(f.calls[2].options.body, { group: "external", runId: "external-done" });
  f.calls[2].resolve();
  await tick();
  assert.equal(f.calls[3].path, "/api/subagents");
  f.calls[3].resolve(data);
  await initial;
  assert.equal(f.calls.length, 4, "an unchanged refresh cannot recursively clear again");
  assert.equal(c.getSnapshot().clearingFinished, false);
  assert.deepEqual(f.events, [["auto-cleared", "info", {
    aggregateKey: "subagent-auto-clear", aggregateIncrement: 2,
    aggregateSingular: "finished subagent run", aggregatePlural: "finished subagent runs",
  }]]);
  assert.equal(f.timers.delay(), 4000);
});

test("Auto-Clear partial failure retains aggregate metadata and the original warning", async () => {
  const f = fixture();
  await f.seed(overview([done(), { ...done("failed-b"), status: "failed" }]));
  f.settings.autoClear = true;
  const request = f.controller.refresh();
  f.calls[1].resolve(f.controller.getSnapshot().data);
  await tick();
  f.calls[2].resolve();
  await tick();
  f.calls[3].reject(new Error("busy"));
  await tick();
  f.calls[4].reject(new Error("refresh failed"));
  await request;
  assert.deepEqual(f.events, [["auto-cleared", "info", {
    aggregateKey: "subagent-auto-clear", aggregateIncrement: 1,
    aggregateSingular: "finished subagent run", aggregatePlural: "finished subagent runs",
  }], ["could not auto-clear 1 finished subagent run", "warn"]]);
  assert.equal(f.controller.getSnapshot().error.message, "refresh failed");
  assert.equal(f.controller.getSnapshot().clearingFinished, false);
  assert.equal(f.timers.delay(), 4000);
});

test("a failed refresh alone cannot Auto-Clear retained data and the preference is read at completion", async () => {
  const f = fixture();
  await f.seed(overview([done()]));
  f.settings.autoClear = true;
  const failed = f.controller.refresh();
  f.calls[1].reject(new Error("offline"));
  await failed;
  assert.equal(f.calls.length, 2);
  const next = f.controller.refresh();
  f.settings.autoClear = false;
  f.calls[2].resolve(overview([done()]));
  await next;
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.events, []);
});

test("Clear finished leaves a newer explicit schedule intact and releases after every failure", async () => {
  const f = fixture();
  const c = f.controller;
  await f.seed(overview([done()]));
  const clear = c.clearFinished();
  c.schedule(123);
  f.calls[1].reject(new Error("dismiss failed"));
  await tick();
  f.calls[2].reject(new Error("refresh failed"));
  await clear;
  assert.deepEqual(f.events, [["could not clear 1 finished subagent run", "warn"]]);
  assert.equal(c.getSnapshot().clearingFinished, false);
  assert.equal(c.getSnapshot().loading, false);
  assert.equal(f.timers.delay(), 123);
  const retry = c.clearFinished();
  assert.equal(f.calls.length, 4);
  f.calls[3].resolve();
  await tick();
  f.calls[4].resolve(overview());
  await retry;
  assert.deepEqual(f.events.at(-1), ["cleared 1 finished subagent run", "info"]);
});

for (const outcome of ["success", "failure"]) {
  test(`dispose rejects a late overview ${outcome}, clears timers and prevents all new work`, async () => {
    const f = fixture();
    const c = f.controller;
    const retained = await f.seed(overview([running()]));
    c.beginCancel(tab, running());
    c.schedule(7);
    const timer = [...f.timers.pending.keys()][0];
    const request = f.timers.fire(timer);
    const queued = c.refresh();
    c.dispose();
    c.dispose();
    const counts = [f.overviews.length, f.settled.length, f.changes.length];
    if (outcome === "success") f.calls[1].resolve(overview());
    else f.calls[1].reject(new Error("late error"));
    await Promise.all([request, queued]);
    assert.strictEqual(c.getSnapshot().data, retained);
    assert.equal(c.getSnapshot().error, null);
    assert.equal(c.getSnapshot().loading, false);
    assert.deepEqual([f.overviews.length, f.settled.length, f.changes.length], counts);
    c.start();
    await c.refresh();
    c.schedule(0);
    await f.timers.history.get(timer).callback();
    assert.equal(c.beginCancel(tab, running()), null);
    c.resetCancel();
    await c.submitCancel();
    await c.dismiss(tab, done());
    await c.clearFinished();
    assert.equal(f.calls.length, 2);
    assert.equal(f.timers.pending.size, 0);
    assert.deepEqual(f.closed, []);
    assert.deepEqual(f.events, []);
  });
}

for (const action of ["cancel", "dismiss", "clear"]) {
  for (const outcome of ["success", "failure"]) {
    test(`dispose during ${action} suppresses a late ${outcome} without further server work`, async () => {
      const f = fixture();
      const c = f.controller;
      const data = await f.seed(overview([done(), done("done-b")]));
      let request;
      if (action === "cancel") {
        c.beginCancel(tab, running());
        request = c.submitCancel();
      } else if (action === "dismiss") {
        request = c.dismiss(tab, done());
      } else {
        request = c.clearFinished();
      }
      c.dispose();
      const counts = [f.changes.length, f.statuses.length, f.settled.length];
      if (outcome === "success") f.calls[1].resolve();
      else f.calls[1].reject(new Error("late error"));
      await request;
      assert.equal(f.calls.length, 2);
      assert.strictEqual(c.getSnapshot().data, data);
      assert.deepEqual([f.changes.length, f.statuses.length, f.settled.length], counts);
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.closed, []);
      assert.equal(f.timers.pending.size, 0);
    });
  }
}
