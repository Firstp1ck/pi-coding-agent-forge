import assert from "node:assert/strict";
import test from "node:test";
import { createAttentionScheduler } from "../public/session-attention-scheduler.mjs";

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

class FakeClock {
  now = 0;
  next = 0;
  timers = new Map();
  peakTimers = 0;

  setTimeout = (callback, delay) => {
    assert.ok(Number.isFinite(delay) && delay >= 0);
    const id = this.next++;
    this.timers.set(id, { callback, at: this.now + delay });
    this.peakTimers = Math.max(this.peakTimers, this.timers.size);
    assert.ok(this.timers.size <= 1, "only one scheduler timer may exist, including the request timeout");
    return id;
  };

  clearTimeout = (id) => this.timers.delete(id);

  async tick(ms) {
    const end = this.now + ms;
    await flush();
    for (let count = 0; ; count++) {
      assert.ok(count < 1000, "timer execution must remain bounded");
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      const [id, timer] = due;
      this.now = timer.at;
      this.timers.delete(id);
      timer.callback();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

function harness(t, { state = {}, abortable = true, onRefresh, onError } = {}) {
  const clock = new FakeClock();
  t.mock.method(Date, "now", () => clock.now);
  const current = { tabCount: 2, working: false, visible: true, menuOpen: false, ...state };
  const requests = [];
  const errors = [];
  const scheduler = createAttentionScheduler({
    getState: () => current,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onError(error) {
      errors.push(error);
      onError?.(error);
    },
    refresh({ signal }) {
      assert.ok(signal instanceof AbortSignal);
      assert.ok(requests.every((request) => request.settled), "refresh calls must never overlap");
      let resolve;
      let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      const request = { signal, at: clock.now, settled: false };
      const finish = (callback, value) => {
        if (request.settled) return;
        request.settled = true;
        signal.removeEventListener("abort", abort);
        callback(value);
      };
      const abort = () => finish(reject, signal.reason);
      request.resolve = (value) => finish(resolve, value);
      request.reject = (error) => finish(reject, error);
      if (abortable) signal.addEventListener("abort", abort, { once: true });
      requests.push(request);
      onRefresh?.(request);
      return promise;
    },
  });
  t.after(async () => {
    scheduler.dispose();
    for (const request of requests) request.resolve();
    await flush();
    assert.equal(clock.timers.size, 0, "disposal must leave no timers");
  });
  return { clock, state: current, requests, errors, scheduler };
}

test("multiple initially idle tabs discover a later background blocker without manual refresh", async (t) => {
  let serverBlocked = false;
  let discovered = false;
  const h = harness(t, {
    onRefresh(request) {
      discovered = serverBlocked;
      h.state.working = discovered;
      request.resolve();
    },
  });
  h.scheduler.sync();
  await h.clock.tick(9999);
  assert.equal(h.requests.length, 0);
  serverBlocked = true;
  await h.clock.tick(1);
  assert.equal(discovered, true);
  assert.equal(h.requests.length, 1);
  await h.clock.tick(1499);
  assert.equal(h.requests.length, 1);
  await h.clock.tick(1);
  assert.equal(h.requests.length, 2);
});

for (const [name, state, interval] of [
  ["no tabs", { tabCount: 0, working: true }, null],
  ["one idle visible tab", { tabCount: 1 }, null],
  ["one idle hidden tab", { tabCount: 1, visible: false }, null],
  ["one working visible tab", { tabCount: 1, working: true }, 1500],
  ["multiple idle visible tabs", {}, 10000],
  ["multiple idle hidden tabs", { visible: false }, 30000],
  ["one working hidden tab", { tabCount: 1, working: true, visible: false }, 30000],
]) {
  test(`recurring cadence for ${name}`, async (t) => {
    const h = harness(t, { state, onRefresh: (request) => request.resolve() });
    h.scheduler.sync();
    if (interval === null) {
      await h.clock.tick(120000);
      assert.equal(h.requests.length, 0);
      assert.equal(h.clock.timers.size, 0);
      return;
    }
    await h.clock.tick(interval - 1);
    assert.equal(h.requests.length, 0);
    await h.clock.tick(1);
    assert.equal(h.requests.length, 1);
    await h.clock.tick(interval);
    assert.deepEqual(h.requests.map((request) => request.at), [interval, interval * 2]);
  });
}

test("sync and manual requests preserve the earliest deadline across cadence changes", async (t) => {
  const h = harness(t);
  h.scheduler.sync();
  await h.clock.tick(1000);
  h.scheduler.sync();
  await h.clock.tick(1000);
  h.scheduler.request(5000);
  h.scheduler.request(10000);
  await h.clock.tick(1000);
  h.state.working = true;
  h.scheduler.sync();
  h.state.visible = false;
  h.scheduler.sync();
  await h.clock.tick(1499);
  assert.equal(h.requests.length, 0);
  await h.clock.tick(1);
  assert.equal(h.requests[0].at, 4500);
  assert.equal(h.clock.peakTimers, 1);
});

test("repeated sync never postpones an existing idle discovery deadline", async (t) => {
  const h = harness(t);
  h.scheduler.sync();
  for (let i = 0; i < 9; i++) {
    await h.clock.tick(1000);
    h.scheduler.sync();
  }
  await h.clock.tick(1000);
  assert.equal(h.requests[0].at, 10000);
});

test("zero tabs reject manual network work; a single idle tab permits it", async (t) => {
  const h = harness(t, { state: { tabCount: 0 } });
  h.scheduler.request();
  h.scheduler.request(100);
  await h.clock.tick(10000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.clock.timers.size, 0);
  h.state.tabCount = 1;
  h.scheduler.request(1000);
  h.scheduler.request(100);
  h.scheduler.request(500);
  h.scheduler.sync();
  await h.clock.tick(99);
  assert.equal(h.requests.length, 0);
  await h.clock.tick(1);
  h.requests[0].resolve();
  await h.clock.tick(120000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.timers.size, 0);
});

test("manual requests during a refresh coalesce without replacing its timeout", async (t) => {
  const h = harness(t, { state: { tabCount: 1 } });
  h.scheduler.request();
  await h.clock.tick(0);
  const timeout = [...h.clock.timers.values()][0];
  h.scheduler.request(5000);
  await h.clock.tick(200);
  for (let i = 0; i < 20; i++) {
    h.scheduler.request();
    h.scheduler.sync();
  }
  assert.equal(h.requests.length, 1);
  assert.equal([...h.clock.timers.values()][0], timeout);
  h.requests[0].resolve();
  await h.clock.tick(0);
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve();
  await h.clock.tick(10000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.clock.timers.size, 0);
});

test("a delayed manual request during a refresh retains its earliest requested deadline", async (t) => {
  const h = harness(t, { state: { tabCount: 1 } });
  h.scheduler.request();
  await h.clock.tick(0);
  h.scheduler.request(5000);
  h.scheduler.request(8000);
  await h.clock.tick(1000);
  h.requests[0].resolve();
  await h.clock.tick(3999);
  assert.equal(h.requests.length, 1);
  await h.clock.tick(1);
  assert.equal(h.requests[1].at, 5000);
});

test("sync during refresh schedules the next recurring interval from settlement", async (t) => {
  const h = harness(t, { state: { working: true } });
  h.scheduler.sync();
  await h.clock.tick(1500);
  await h.clock.tick(2000);
  h.scheduler.sync();
  h.scheduler.sync();
  h.requests[0].resolve();
  await h.clock.tick(1499);
  assert.equal(h.requests.length, 1);
  await h.clock.tick(1);
  assert.equal(h.requests[1].at, 5000);
});

test("open menus defer in 600ms steps, including repeated manual requests and sync", async (t) => {
  const h = harness(t, { state: { tabCount: 1, menuOpen: true } });
  h.scheduler.request();
  await h.clock.tick(0);
  await h.clock.tick(599);
  h.scheduler.sync();
  h.scheduler.request();
  assert.equal(h.requests.length, 0);
  await h.clock.tick(1);
  assert.equal(h.requests.length, 0);
  h.state.menuOpen = false;
  h.scheduler.sync();
  await h.clock.tick(599);
  assert.equal(h.requests.length, 0);
  await h.clock.tick(1);
  assert.equal(h.requests[0].at, 1200);
});

test("sync cancels recurring work when only one idle tab remains but preserves manual work", async (t) => {
  const h = harness(t);
  h.scheduler.sync();
  h.state.tabCount = 1;
  h.scheduler.sync();
  assert.equal(h.clock.timers.size, 0);
  h.scheduler.request(50);
  h.scheduler.sync();
  await h.clock.tick(50);
  assert.equal(h.requests.length, 1);
  h.state.tabCount = 0;
  h.scheduler.sync();
  assert.equal(h.requests[0].signal.aborted, true);
  await h.clock.tick(60000);
  assert.equal(h.errors.length, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("a no-longer-needed automatic poll cannot pull a later manual deadline forward", async (t) => {
  const h = harness(t);
  h.scheduler.sync();
  h.scheduler.request(20000);
  h.state.tabCount = 1;
  await h.clock.tick(19999);
  assert.equal(h.requests.length, 0);
  await h.clock.tick(1);
  assert.equal(h.requests[0].at, 20000);
});

test("timer callbacks recheck zero-tab and single-idle state even without sync", async (t) => {
  const h = harness(t);
  h.scheduler.sync();
  h.state.tabCount = 1;
  await h.clock.tick(10000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.clock.timers.size, 0);
  h.scheduler.request(100);
  h.state.tabCount = 0;
  await h.clock.tick(100);
  assert.equal(h.requests.length, 0);
  assert.equal(h.clock.timers.size, 0);
});

test("settlement after the last tab disappears neither reports nor retries", async (t) => {
  const h = harness(t);
  h.scheduler.request();
  await h.clock.tick(0);
  h.state.tabCount = 0;
  h.requests[0].reject(new Error("last tab closed"));
  await h.clock.tick(60000);
  assert.equal(h.errors.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.timers.size, 0);
});

test("10s timeout aborts through AbortSignal and retries after backoff", async (t) => {
  const h = harness(t, { state: { working: true } });
  h.scheduler.sync();
  await h.clock.tick(1500);
  await h.clock.tick(9999);
  assert.equal(h.requests[0].signal.aborted, false);
  await h.clock.tick(1);
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].name, "TimeoutError");
  assert.equal(h.requests[0].signal.reason, h.errors[0]);
  h.scheduler.request();
  h.scheduler.sync();
  await h.clock.tick(1499);
  assert.equal(h.requests.length, 1);
  await h.clock.tick(1);
  assert.equal(h.requests[1].at, 13000);
});

test("an unsettled timed-out refresh cannot overlap a retry even if it ignores abort", async (t) => {
  const h = harness(t, { state: { tabCount: 1 }, abortable: false });
  h.scheduler.request();
  await h.clock.tick(10000);
  assert.equal(h.requests[0].signal.aborted, true);
  h.scheduler.request();
  h.scheduler.sync();
  await h.clock.tick(60000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.timers.size, 0);
  h.requests[0].resolve();
  await h.clock.tick(0);
  assert.equal(h.errors.length, 1);
  assert.equal(h.errors[0].name, "TimeoutError", "late success cannot turn a timeout into success");
  await h.clock.tick(1500);
  assert.equal(h.requests.length, 2);
});

test("failure backoff doubles to 30s, survives sync/manual pressure, and resets on success", async (t) => {
  const h = harness(t, { state: { working: true } });
  h.scheduler.request();
  await h.clock.tick(0);
  for (const [index, delay] of [1500, 3000, 6000, 12000, 24000, 30000, 30000].entries()) {
    const error = new Error(`failure ${index}`);
    h.requests.at(-1).reject(error);
    await h.clock.tick(0);
    assert.equal(h.errors.at(-1), error);
    h.scheduler.sync();
    h.scheduler.request();
    await h.clock.tick(delay - 1);
    assert.equal(h.requests.length, index + 1);
    await h.clock.tick(1);
    assert.equal(h.requests.length, index + 2);
  }
  h.requests.at(-1).resolve();
  await h.clock.tick(1499);
  assert.equal(h.requests.length, 8);
  await h.clock.tick(1);
  assert.equal(h.requests.length, 9);
  h.requests.at(-1).reject(new Error("new failure"));
  await h.clock.tick(1500);
  assert.equal(h.requests.length, 10);
});

test("idle and hidden failures retain their slower reconciliation intervals", async (t) => {
  const h = harness(t);
  h.scheduler.request();
  await h.clock.tick(0);
  h.requests[0].reject(new Error("idle failure"));
  await h.clock.tick(9999);
  assert.equal(h.requests.length, 1);
  await h.clock.tick(1);
  h.state.visible = false;
  h.requests[1].reject(new Error("hidden failure"));
  await h.clock.tick(29999);
  assert.equal(h.requests.length, 2);
  await h.clock.tick(1);
  assert.equal(h.requests[2].at, 40000);
});

test("stop aborts and suppresses late results; restart waits for old settlement", async (t) => {
  const h = harness(t, { abortable: false });
  h.scheduler.request();
  await h.clock.tick(0);
  h.scheduler.request();
  h.scheduler.stop();
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(h.clock.timers.size, 0);
  h.scheduler.request();
  await h.clock.tick(60000);
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(new Error("stale stopped request"));
  await h.clock.tick(0);
  assert.equal(h.errors.length, 0);
  assert.equal(h.requests.length, 2);
  h.scheduler.stop();
  h.requests[1].resolve();
  await h.clock.tick(60000);
  assert.equal(h.requests.length, 2);
  assert.equal(h.clock.timers.size, 0);
  h.scheduler.sync();
  await h.clock.tick(10000);
  assert.equal(h.requests.length, 3);
});

test("dispose is terminal and suppresses late errors and saved timer callbacks", async (t) => {
  const h = harness(t, { abortable: false });
  h.scheduler.sync();
  const stalePoll = [...h.clock.timers.values()][0].callback;
  h.scheduler.request();
  await h.clock.tick(0);
  const staleTimeout = [...h.clock.timers.values()][0].callback;
  h.scheduler.dispose();
  h.requests[0].reject(new Error("late disposed request"));
  stalePoll();
  staleTimeout();
  h.scheduler.sync();
  h.scheduler.request();
  h.scheduler.stop();
  h.scheduler.dispose();
  await h.clock.tick(60000);
  assert.equal(h.errors.length, 0);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.timers.size, 0);
});

test("stopped timers cannot refresh after restart even if their callbacks were already queued", async (t) => {
  const h = harness(t, { state: { tabCount: 1 } });
  h.scheduler.request();
  const stale = [...h.clock.timers.values()][0].callback;
  h.scheduler.stop();
  h.scheduler.request(100);
  stale();
  assert.equal(h.requests.length, 0);
  await h.clock.tick(100);
  assert.equal(h.requests.length, 1);
});

test("an error callback may stop ownership or throw without leaking timers", async (t) => {
  const h = harness(t, { onError() { h.scheduler.stop(); throw new Error("presentation failed"); } });
  h.scheduler.request();
  await h.clock.tick(0);
  h.requests[0].reject(new Error("network failed"));
  await h.clock.tick(60000);
  assert.equal(h.errors.length, 1);
  assert.equal(h.requests.length, 1);
  assert.equal(h.clock.timers.size, 0);
});

test("a throwing error callback preserves bounded retry ownership", async (t) => {
  const h = harness(t, { onError() { throw new Error("presentation failed"); } });
  h.scheduler.request();
  await h.clock.tick(0);
  h.requests[0].reject(new Error("network failed"));
  await h.clock.tick(9999);
  assert.equal(h.requests.length, 1);
  await h.clock.tick(1);
  assert.equal(h.requests.length, 2);
});

test("synchronous refresh throws retry and successful synchronous results release ownership", async (t) => {
  const clock = new FakeClock();
  t.mock.method(Date, "now", () => clock.now);
  let calls = 0;
  const failure = new Error("synchronous failure");
  const errors = [];
  const scheduler = createAttentionScheduler({
    getState: () => ({ tabCount: 1, working: false, visible: true, menuOpen: false }),
    refresh() { if (++calls === 1) throw failure; },
    onError: (error) => errors.push(error),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  t.after(() => scheduler.dispose());
  scheduler.request();
  await clock.tick(1500);
  assert.equal(calls, 2);
  assert.deepEqual(errors, [failure]);
  assert.equal(clock.timers.size, 0);
});

test("global timer defaults work and invalid inputs fail at the boundary", async (t) => {
  const clock = new FakeClock();
  t.mock.method(Date, "now", () => clock.now);
  t.mock.method(globalThis, "setTimeout", clock.setTimeout);
  t.mock.method(globalThis, "clearTimeout", clock.clearTimeout);
  const options = { refresh() {}, getState: () => ({ tabCount: 1 }) };
  assert.throws(() => createAttentionScheduler(), /refresh must be a function/);
  for (const key of ["refresh", "getState", "onError", "setTimeout", "clearTimeout"]) {
    assert.throws(() => createAttentionScheduler({ ...options, [key]: null }), TypeError);
  }
  const scheduler = createAttentionScheduler(options);
  t.after(() => scheduler.dispose());
  assert.deepEqual(Object.keys(scheduler), ["sync", "request", "stop", "dispose"]);
  for (const delay of [-1, NaN, Infinity, "0"]) assert.throws(() => scheduler.request(delay), RangeError);
  scheduler.request();
  await clock.tick(0);
  assert.equal(clock.timers.size, 0);
});
