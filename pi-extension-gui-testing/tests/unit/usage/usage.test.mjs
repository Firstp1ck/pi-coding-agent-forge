import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageTracker } from "../../../src/usage/detector.ts";
import { SessionLimitError, SessionRegistry } from "../../../src/usage/registry.ts";
import { LOOP_THRESHOLDS } from "../../../src/usage/types.ts";

const act = (at, extra = {}) => ({ session: "s1", tool: "gui_act", at, action: "click", ref: "1:5", ...extra });

test("repeated-action fires only above 5 identical actions in a row; other tools do not break the run", () => {
  const tracker = new UsageTracker();
  tracker.startSession("s1", "docker-linux", 0);
  for (let i = 1; i <= LOOP_THRESHOLDS.repeatedAction; i++) {
    assert.deepEqual(tracker.record(act(i)), [], `action ${i} is at or below the limit`);
    assert.deepEqual(tracker.record({ session: "s1", tool: "gui_snapshot", at: i }), []);
  }
  const sixth = tracker.record(act(6));
  assert.equal(sixth.length, 1);
  assert.deepEqual({ ...sixth[0], message: undefined }, { signal: "repeated-action", observed: 6, threshold: 5, message: undefined });
  assert.match(sixth[0].message, /Stop and reassess/);
  assert.equal(tracker.record(act(7))[0].observed, 7, "keeps warning while the run continues");
  assert.equal(tracker.session("s1").warnings.length, 1, "stored once per run");

  assert.deepEqual(tracker.record(act(8, { ref: "1:6" })), [], "different target resets");
});

test("repeated-action keys on coordinates when there is no ref, and on the action", () => {
  const tracker = new UsageTracker();
  for (let i = 0; i < 5; i++) tracker.record(act(i, { ref: undefined, x: 10, y: 20 }));
  assert.equal(tracker.record(act(5, { ref: undefined, x: 10, y: 20 })).length, 1);
  assert.deepEqual(tracker.record(act(6, { ref: undefined, x: 10, y: 20, action: "double_click" })), []);
});

test("unchanged-screen fires only above 8 consecutive actions with identical hashes (auto-screenshot or next screenshot)", () => {
  const tracker = new UsageTracker();
  let t = 0;
  // Distinct targets so repeated-action stays quiet.
  const step = (i, viaScreenshot) => {
    const warnings = viaScreenshot
      ? [...tracker.record(act(++t, { ref: `r${i}` })), ...tracker.record({ session: "s1", tool: "gui_screenshot", at: ++t, screenshotSha256: "same" })]
      : tracker.record(act(++t, { ref: `r${i}`, screenshotSha256: "same" }));
    return warnings.filter((w) => w.signal === "unchanged-screen");
  };
  for (let i = 1; i <= LOOP_THRESHOLDS.unchangedScreen; i++) assert.deepEqual(step(i, i % 2 === 0), [], `action ${i}`);
  const ninth = step(9, false);
  assert.equal(ninth.length, 1);
  assert.equal(ninth[0].observed, 9);
  assert.equal(ninth[0].threshold, 8);

  // A changed screen resets the run.
  tracker.record(act(++t, { ref: "x", screenshotSha256: "different" }));
  assert.deepEqual(step(10, false), []);
});

test("screenshots without actions in between do not count as actions", () => {
  const tracker = new UsageTracker();
  for (let i = 0; i < 20; i++) tracker.record({ session: "s1", tool: "gui_screenshot", at: i, screenshotSha256: "same" });
  assert.equal(tracker.session("s1").warnings.length, 0);
  assert.equal(tracker.session("s1").screenshots, 20);
});

test("launch-storm fires above 20 launches within 10 minutes, across sessions, and ages out", () => {
  const tracker = new UsageTracker();
  const minute = 60_000;
  for (let i = 0; i < LOOP_THRESHOLDS.launchStorm; i++) {
    assert.deepEqual(tracker.record({ session: `s${i}`, tool: "gui_launch", at: i * 1000 }), []);
  }
  const storm = tracker.record({ session: "s20", tool: "gui_launch", at: 20_000 });
  assert.deepEqual(storm.map((w) => [w.signal, w.observed, w.threshold]), [["launch-storm", 21, 20]]);
  assert.deepEqual(tracker.record({ session: "late", tool: "gui_launch", at: 30 * minute }), [], "old launches left the window");
});

test("counters per session, including all-black screenshots and bytes synced", () => {
  const tracker = new UsageTracker();
  tracker.startSession("s1", "docker-linux", 1000);
  tracker.record({ session: "s1", tool: "gui_launch", at: 1, bytesSynced: 2048 });
  tracker.record({ session: "s1", tool: "gui_screenshot", at: 2, screenshotSha256: "a", allBlack: true });
  tracker.record(act(3, { screenshotSha256: "b" }));
  tracker.record({ session: "s2", tool: "gui_logs", at: 4 });
  const s1 = tracker.session("s1");
  assert.deepEqual(s1.toolCalls, { gui_launch: 1, gui_screenshot: 1, gui_act: 1 });
  assert.equal(s1.actions, 1);
  assert.equal(s1.screenshots, 2);
  assert.equal(s1.allBlackScreenshots, 1);
  assert.equal(s1.bytesSynced, 2048);
  assert.equal(s1.backend, "docker-linux");
  assert.equal(tracker.session("s2").backend, "unknown");
  assert.equal(tracker.sessions().length, 2);
  s1.actions = 99;
  assert.equal(tracker.session("s1").actions, 1, "returns copies");
  tracker.forget("s2");
  assert.equal(tracker.session("s2"), undefined);
});

test("cost hook warns once above each threshold; without an estimator it stays silent", () => {
  let cost = { sessionUsd: 1, dailyUsd: 5 };
  const tracker = new UsageTracker({ warnSessionCostUsd: 1, warnDailyCostUsd: 5, estimateCost: () => cost });
  assert.deepEqual(tracker.record({ session: "s1", tool: "gui_logs", at: 1 }), [], "exactly at the threshold is fine");
  cost = { sessionUsd: 1.5, dailyUsd: 6 };
  const warnings = tracker.record({ session: "s1", tool: "gui_logs", at: 2 });
  assert.deepEqual(warnings.map((w) => w.signal), ["session-cost", "daily-cost"]);
  assert.deepEqual(tracker.record({ session: "s1", tool: "gui_logs", at: 3 }), []);
  assert.deepEqual(new UsageTracker({ warnSessionCostUsd: 0 }).record({ session: "x", tool: "gui_logs", at: 1 }), []);
});

test("session registry: limit with a clear message, reservation, idle detection, idempotent unregister", () => {
  let now = 0;
  const registry = new SessionRegistry({ maxConcurrentSessions: 2, idleTimeoutMinutes: 15, now: () => now });
  registry.register("a", "docker-linux");
  registry.register("b", "docker-linux");
  assert.throws(
    () => registry.register("c", "docker-linux"),
    (e) => e instanceof SessionLimitError && /at most 2 GUI sessions can run at once \(limits\.maxConcurrentSessions\).*gui_stop.*Active: a, b/.test(e.message),
  );
  assert.throws(() => registry.register("a", "docker-linux"), /already registered/);
  assert.equal(registry.size, 2);

  now = 10 * 60_000;
  registry.touch("b");
  assert.deepEqual(registry.idleSessions(), []);
  assert.equal(registry.nextIdleInMs(), 5 * 60_000);
  now = 15 * 60_000;
  assert.deepEqual(registry.idleSessions(), ["a"], "exactly at the timeout is idle");
  now = 25 * 60_000;
  assert.deepEqual(registry.idleSessions(), ["a", "b"]);

  registry.unregister("a");
  registry.unregister("a");
  assert.equal(registry.has("a"), false);
  registry.register("c", "docker-linux");
  assert.deepEqual(registry.list().map((s) => s.id), ["b", "c"]);
  assert.equal(new SessionRegistry({ maxConcurrentSessions: 1, idleTimeoutMinutes: 1 }).nextIdleInMs(), undefined);
  const one = new SessionRegistry({ maxConcurrentSessions: 1, idleTimeoutMinutes: 1 });
  one.register("x", "docker-linux");
  assert.throws(() => one.register("y", "docker-linux"), /at most 1 GUI session can/);
});

test("Z12: failed launches share the launch-storm window with successful ones; each attempt counts once", () => {
  const tracker = new UsageTracker();
  let at = 0;
  for (let i = 0; i < 10; i++) assert.deepEqual(tracker.recordFailedLaunch((at += 1_000)), []);
  for (let i = 0; i < 10; i++) assert.deepEqual(tracker.record({ session: `s${i}`, tool: "gui_launch", at: (at += 1_000) }), []);
  const warnings = tracker.recordFailedLaunch((at += 1_000));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].signal, "launch-storm");
  assert.equal(warnings[0].observed, 21);
  assert.deepEqual(tracker.sessions().map((s) => s.session), Array.from({ length: 10 }, (_, i) => `s${i}`), "failed launches create no session usage");
  assert.deepEqual(tracker.recordFailedLaunch(at + 10 * 60_000 + 1), [], "ages out with the window");
});
