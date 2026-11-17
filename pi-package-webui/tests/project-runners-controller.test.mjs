import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_RUNNER_CONTEXT_DEFAULT_LINES,
  APP_RUNNER_CONTEXT_MAX_LINES,
  createProjectRunnersController,
  normalizeAppRunnerContextLineCount,
} from "../public/project-runners-controller.mjs";

const running = (id = "run-a") => ({ id, runnerId: "dev", status: "running", displayCommand: "npm run dev" });

function fixture() {
  let target = { tabId: "a", lifetime: 1 };
  const calls = [];
  const notifications = [];
  const renders = [];
  const events = [];
  const contextRefreshes = [];
  const controller = createProjectRunnersController({
    captureTarget: () => target,
    isTargetCurrent: (captured) => captured.tabId === target.tabId && captured.lifetime === target.lifetime,
    cleanStatusText: (text) => text.replaceAll("\u001b[31m", "").replaceAll("\n", " "),
    api(path, options) {
      let resolve;
      let reject;
      const pending = new Promise((accept, fail) => { resolve = accept; reject = fail; });
      calls.push({ path, options, resolve: (data = {}) => resolve({ ok: true, data }), reject });
      return pending;
    },
    onData: (...args) => notifications.push(args),
    onRender: (options) => renders.push(options),
    addEvent: (...args) => events.push(args),
    onRefreshContext: (captured) => contextRefreshes.push(captured),
  });
  return {
    controller, calls, notifications, renders, events, contextRefreshes,
    target: () => target,
    select(tabId, lifetime = 1) { target = { tabId, lifetime }; },
    seed(run = running()) { controller.applyData("a", { activeRun: run }); },
  };
}

test("merging preserves omitted run and metadata, while explicit null clears the run without rendering", () => {
  const f = fixture();
  const c = f.controller;
  assert.deepEqual(c.getData("missing"), { runners: [], activeRun: null });
  assert.equal(c.applyData(null, { activeRun: running() }), undefined);
  const config = { path: ".pi-webui-runners.json" };
  const runners = [{ id: "dev", label: "Dev" }];
  const run = running();
  c.applyData("a", { cwd: "/project", runners, customRunnerConfig: config, activeRun: run });
  c.applyData("a", { runners: "invalid", cwd: "", customRunnerConfig: null });
  assert.deepEqual(c.getData("a"), { cwd: "/project", runners, customRunnerConfig: config, activeRun: run });
  assert.deepEqual(f.notifications[1], ["a", c.getData("a"), { hasActiveRun: false }]);
  c.applyData("a", { activeRun: null, runners: [] });
  assert.deepEqual(f.notifications[2][2], { hasActiveRun: true });
  assert.equal(c.getData("a").activeRun, null);
  assert.deepEqual(c.getData("a").runners, []);
  c.applyData("b", { cwd: "/background", activeRun: running("run-b") });
  assert.equal(c.getData("b").activeRun.id, "run-b");
  assert.equal(c.getData("a").activeRun, null);
  assert.deepEqual(f.renders, []);
  assert.deepEqual(f.calls, []);
});

test("discovery and start construct actual requests and distinguish tab repainting", async () => {
  const f = fixture();
  const c = f.controller;
  const discovery = c.refresh();
  assert.deepEqual(f.calls[0].options, { tabId: "a" });
  assert.equal(f.calls[0].path, "/api/app-runners");
  f.calls[0].resolve({ cwd: "/project", runners: [{ id: "dev" }] });
  assert.deepEqual(await discovery, { success: true, data: { cwd: "/project", runners: [{ id: "dev" }] } });
  assert.deepEqual(f.renders, [{ tabs: false }]);
  const start = c.start("dev");
  assert.deepEqual(f.calls[1].options, { method: "POST", body: { runnerId: "dev" }, tabId: "a" });
  assert.equal(f.calls[1].path, "/api/app-runner");
  f.calls[1].resolve({ activeRun: running() });
  assert.equal((await start).success, true);
  assert.equal(c.getData("a").cwd, "/project");
  assert.deepEqual(f.renders, [{ tabs: false }, { tabs: true }]);
  assert.deepEqual(f.events, [["started npm run dev", "info"]]);
});

test("stop and clear target the captured run without adding its ID to the wire", async () => {
  const f = fixture();
  f.seed();
  const stop = f.controller.stop("run-a");
  assert.equal(f.calls[0].path, "/api/app-runner/stop");
  assert.deepEqual(f.calls[0].options, { method: "POST", body: {}, tabId: "a" });
  f.calls[0].resolve({ activeRun: { ...running(), status: "done" } });
  assert.equal((await stop).success, true);
  const clear = f.controller.clear("run-a");
  assert.equal(f.calls[1].path, "/api/app-runner/clear");
  assert.deepEqual(f.calls[1].options, { method: "POST", body: {}, tabId: "a" });
  f.calls[1].resolve({ activeRun: null });
  assert.equal((await clear).success, true);
  assert.equal(f.controller.getData("a").activeRun, null);
  assert.deepEqual(f.events, [["app runner stop requested", "warn"]]);
  assert.deepEqual(f.renders, [{ tabs: true }, { tabs: true }]);
});

const actions = {
  refresh: (c, target) => c.refresh(target),
  start: (c, target) => c.start("dev", target),
  stop: (c, target) => c.stop("run-a", target),
  clear: (c, target) => c.clear("run-a", target),
  input: (c, target) => c.sendInput({ runId: "run-a", text: "submitted" }, target),
  context: (c, target) => c.transferContext({ runId: "run-a", lineCount: 7 }, target),
};

test("requests reject retired snapshots while same-run input acknowledgments survive SSE", async (t) => {
  for (const [name, invoke] of Object.entries(actions)) {
    for (const invalidation of ["retire", "sse", "replacement", "lifetime", "switch"]) {
      await t.test(`${name}: ${invalidation}`, async () => {
        const f = fixture();
        f.seed();
        f.controller.setInputDraft("a", "run-a", "submitted");
        const pending = invoke(f.controller);
        if (invalidation === "retire") {
          f.controller.forgetTab("a");
          f.seed(running("replacement"));
          f.controller.setInputDraft("a", "run-a", "new lifetime draft");
        } else if (invalidation === "replacement") {
          f.seed(running("replacement"));
        } else if (invalidation === "sse") {
          f.controller.applyData("a", { activeRun: { ...running(), pendingLine: "new output" } });
        } else {
          f.select(invalidation === "switch" ? "b" : "a", 2);
        }
        const before = f.controller.getData("a");
        const notificationCount = f.notifications.length;
        f.calls[0].resolve({ activeRun: running("old-response"), delivery: "steer" });
        if (name === "input" && invalidation === "sse") {
          const result = await pending;
          assert.equal(result.success, true);
          assert.equal(result.inputDraftCleared, true);
          assert.equal(f.controller.getData("a"), before);
          assert.equal(f.notifications.length, notificationCount);
          assert.equal(f.controller.getInputDraft("a", "run-a"), "");
          assert.deepEqual(f.renders, [{ tabs: false }]);
          assert.deepEqual(f.events, [["sent app runner input", "info"]]);
          return;
        }
        assert.deepEqual(await pending, { success: false, reason: "stale" });
        assert.equal(f.controller.getData("a"), before);
        assert.equal(f.notifications.length, notificationCount);
        assert.deepEqual(f.renders, []);
        assert.deepEqual(f.events, []);
        assert.deepEqual(f.contextRefreshes, []);
        assert.equal(f.controller.getInputDraft("a", "run-a"), invalidation === "retire" ? "new lifetime draft" : "submitted");
      });
    }
  }
});

test("later requests supersede discovery and start failures as well as successful results", async () => {
  const f = fixture();
  f.seed();
  const oldDiscovery = f.controller.refresh();
  const oldStart = f.controller.start("dev");
  const latest = f.controller.refresh();
  f.calls[2].resolve({ activeRun: running("latest") });
  assert.equal((await latest).success, true);
  f.calls[0].resolve({ activeRun: null });
  f.calls[1].reject(new Error("superseded start failed"));
  assert.deepEqual(await oldDiscovery, { success: false, reason: "stale" });
  assert.deepEqual(await oldStart, { success: false, reason: "stale" });
  assert.equal(f.controller.getData("a").activeRun.id, "latest");
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.renders, [{ tabs: false }]);
});

test("a mutation supersedes a pending refresh before either finishes", async () => {
  const f = fixture();
  f.seed();
  const refresh = f.controller.refresh();
  const start = f.controller.start("dev");
  f.calls[0].resolve({ activeRun: null });
  assert.deepEqual(await refresh, { success: false, reason: "stale" });
  assert.equal(f.controller.getData("a").activeRun.id, "run-a");
  f.calls[1].resolve({ activeRun: running("next") });
  assert.equal((await start).success, true);
  assert.equal(f.controller.getData("a").activeRun.id, "next");
});

test("background data and drafts cannot supersede another tab's pending request", async () => {
  const f = fixture();
  f.seed();
  f.controller.setInputDraft("a", "run-a", "submitted");
  const pending = f.controller.sendInput({ runId: "run-a", text: "submitted" });
  f.controller.applyData("b", { cwd: "/other", activeRun: running() });
  f.controller.setInputDraft("b", "run-a", "background edit");
  f.controller.forgetTab("unused");
  f.calls[0].resolve({ activeRun: running() });
  assert.equal((await pending).inputDraftCleared, true);
  assert.equal(f.controller.getInputDraft("b", "run-a"), "background edit");
  assert.equal(f.controller.getData("b").cwd, "/other");
});

test("invalid targets and stale run forms never dispatch or supersede a valid request", async () => {
  const f = fixture();
  f.seed();
  const pending = f.controller.refresh();
  for (const invoke of Object.values(actions)) {
    assert.deepEqual(await invoke(f.controller, { tabId: "a", lifetime: 0 }), { success: false, reason: "target" });
    assert.deepEqual(await invoke(f.controller, {}), { success: false, reason: "target" });
  }
  assert.deepEqual(await f.controller.start(""), { success: false, reason: "runner" });
  assert.deepEqual(await f.controller.stop("old"), { success: false, reason: "run" });
  assert.deepEqual(await f.controller.clear("old"), { success: false, reason: "run" });
  assert.deepEqual(await f.controller.sendInput({ runId: "old", text: "wrong process" }), { success: false, reason: "run" });
  assert.deepEqual(await f.controller.transferContext({ runId: "old", lineCount: 3 }), { success: false, reason: "run" });
  assert.equal(f.calls.length, 1);
  f.calls[0].resolve({ activeRun: running() });
  assert.equal((await pending).success, true);
});

test("run identity is mandatory and input admission keeps the existing running/stopping rule", async () => {
  const f = fixture();
  for (const run of [null, { ...running(), status: "done" }, { ...running(), status: "error" }]) {
    f.seed(run);
    assert.deepEqual(await f.controller.sendInput({ runId: "run-a", text: "x" }), { success: false, reason: "run" });
  }
  f.seed();
  assert.deepEqual(await f.controller.stop(), { success: false, reason: "run" });
  assert.deepEqual(await f.controller.clear(), { success: false, reason: "run" });
  f.seed({ ...running(), status: "done", stopping: true });
  const pending = f.controller.sendInput({ runId: "run-a", text: "" });
  f.calls[0].resolve();
  assert.equal((await pending).success, true);
});

test("start errors construct terminal output from owned runner metadata and clean the message", async () => {
  const f = fixture();
  const runner = { id: "dev", kind: "npm", label: "Development", command: "npm", args: ["run", "dev"], displayCommand: "npm run dev" };
  f.controller.applyData("a", { cwd: "/project", runners: [runner] });
  const pending = f.controller.start("dev");
  const error = new Error("\u001b[31mspawn failed\ntry again");
  f.calls[0].reject(error);
  assert.deepEqual(await pending, { success: false, reason: "error", error });
  const run = f.controller.getData("a").activeRun;
  assert.match(run.id, /^start-error:\d+$/);
  assert.equal(run.startedAt, run.endedAt);
  assert.ok(Number.isFinite(Date.parse(run.startedAt)));
  assert.deepEqual({ ...run, id: "<id>", startedAt: "<time>", endedAt: "<time>" }, {
    id: "<id>", runnerId: "dev", kind: "npm", label: "Development", command: "npm", args: ["run", "dev"],
    displayCommand: "npm run dev", cwd: "/project", status: "error", startedAt: "<time>", endedAt: "<time>",
    lineCount: 3, lines: ["$ npm run dev", "# failed to start app runner", "# spawn failed try again"],
  });
  assert.deepEqual(f.events, [["app runner failed: spawn failed try again", "error"]]);
  assert.deepEqual(f.renders, [{ tabs: true }]);
  assert.equal(f.notifications.at(-1)[2].hasActiveRun, true);
});

test("unknown runner failures retain fallback command, label, kind and empty args", async () => {
  const f = fixture();
  const pending = f.controller.start("missing");
  f.calls[0].reject("unavailable");
  assert.equal((await pending).success, false);
  const run = f.controller.getData("a").activeRun;
  assert.equal(run.displayCommand, "missing");
  assert.equal(run.label, "App runner failed");
  assert.equal(run.kind, "custom");
  assert.equal(run.command, "");
  assert.deepEqual(run.args, []);
});

test("input, Enter and EOF preserve the exact payload and clear only the submitted draft", async (t) => {
  for (const [text, closeStdin, newline, event] of [
    ["hello\nworld", false, true, "sent app runner input"],
    ["", false, true, "sent app runner Enter"],
    ["", true, false, "sent app runner EOF"],
    ["last line", true, true, "sent app runner EOF"],
  ]) {
    await t.test(event + JSON.stringify(text), async () => {
      const f = fixture();
      f.seed();
      f.controller.setInputDraft("a", "run-a", text);
      f.controller.setInputDraft("a", "other", "keep other run");
      const pending = f.controller.sendInput({ runId: "run-a", text, closeStdin });
      assert.equal(f.calls[0].path, "/api/app-runner/input");
      assert.deepEqual(f.calls[0].options, { method: "POST", body: { text, newline, closeStdin }, tabId: "a" });
      const data = { activeRun: running() };
      f.calls[0].resolve(data);
      assert.deepEqual(await pending, { success: true, data, inputDraftCleared: true });
      assert.equal(f.controller.getInputDraft("a", "run-a"), "");
      assert.equal(f.controller.getInputDraft("a", "other"), "keep other run");
      assert.deepEqual(f.renders, [{ tabs: false }]);
      assert.deepEqual(f.events, [[event, "info"]]);
    });
  }
});

test("edits during a send survive, including edits that return to the submitted text", async (t) => {
  for (const editedText of ["new draft", "submitted"]) {
    await t.test(editedText, async () => {
      const f = fixture();
      f.seed();
      f.controller.setInputDraft("a", "run-a", "submitted");
      const pending = f.controller.sendInput({ runId: "run-a", text: "submitted" });
      f.controller.setInputDraft("a", "run-a", "temporary edit");
      f.controller.setInputDraft("a", "run-a", editedText);
      f.calls[0].resolve({ activeRun: running() });
      assert.equal((await pending).inputDraftCleared, false);
      assert.equal(f.controller.getInputDraft("a", "run-a"), editedText);
    });
  }
});

test("drafts are scoped by both tab and run, survive data changes, and retirement removes only one tab", () => {
  const f = fixture();
  const c = f.controller;
  for (const tab of ["a", "b", "a:run"]) {
    c.setInputDraft(tab, "same", `${tab} input`);
    c.setContextDraft(tab, "same", tab === "a" ? 14 : 27);
  }
  c.setInputDraft("a", "run:same", "separate key");
  c.applyData("a", { activeRun: running("other") });
  c.applyData("a", { activeRun: null });
  assert.equal(c.getInputDraft("a", "same"), "a input");
  assert.equal(c.getContextDraft("a", "same"), "14");
  assert.equal(c.getInputDraft("a", "run:same"), "separate key");
  c.forgetTab("a");
  c.forgetTab("a");
  assert.equal(c.getInputDraft("a", "same"), "");
  assert.equal(c.getContextDraft("a", "same"), "80");
  assert.deepEqual(c.getData("a"), { runners: [], activeRun: null });
  assert.equal(c.getInputDraft("b", "same"), "b input");
  assert.equal(c.getContextDraft("b", "same"), "27");
  assert.equal(c.getInputDraft("a:run", "same"), "a:run input");
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.renders, []);
});

test("context normalization retains existing parsing and bounds", () => {
  assert.equal(APP_RUNNER_CONTEXT_DEFAULT_LINES, 80);
  assert.equal(APP_RUNNER_CONTEXT_MAX_LINES, 1000);
  for (const [value, expected] of [[undefined, 80], [null, 80], ["", 80], ["bad", 80], ["17lines", 17], ["4.9", 4], [0, 1], [-20, 1], [9000, 1000]]) {
    assert.equal(normalizeAppRunnerContextLineCount(value), expected);
  }
});

test("context transfer uses bounded draft values and retains the captured target for refresh", async (t) => {
  for (const [value, normalized, delivery] of [[0, 1, "steer"], [9000, 1000, "context"], [undefined, 23, "context"]]) {
    await t.test(String(value), async () => {
      const f = fixture();
      f.seed({ ...running(), status: "done" });
      const target = { ...f.target(), marker: "captured" };
      f.controller.setContextDraft("a", "run-a", 23);
      const pending = f.controller.transferContext({ runId: "run-a", lineCount: value }, target);
      assert.equal(f.calls[0].path, "/api/app-runner/context");
      assert.deepEqual(f.calls[0].options, { method: "POST", body: { lineCount: normalized }, tabId: "a" });
      assert.equal(f.controller.getContextDraft("a", "run-a"), String(normalized));
      f.controller.setContextDraft("a", "run-a", 51);
      const data = { activeRun: { ...running(), status: "done", contextTransferred: true }, delivery, lineCount: 1 };
      f.calls[0].resolve(data);
      assert.deepEqual(await pending, { success: true, data });
      assert.equal(f.controller.getData("a").activeRun.contextTransferred, true);
      assert.equal(f.controller.getContextDraft("a", "run-a"), "51");
      assert.deepEqual(f.renders, []);
      assert.equal(f.contextRefreshes[0], target);
      assert.deepEqual(f.events, [[delivery === "steer"
        ? "sent last 1 app runner output lines as live steering context"
        : "added last 1 app runner output lines to agent context", "info"]]);
    });
  }
});

test("context completion without an activeRun leaves owned run and metadata intact", async () => {
  const f = fixture();
  f.seed();
  const count = f.notifications.length;
  const pending = f.controller.transferContext({ runId: "run-a", lineCount: 10 });
  f.calls[0].resolve({ activeRun: null });
  assert.equal((await pending).success, true);
  assert.equal(f.notifications.length, count);
  assert.equal(f.controller.getData("a").activeRun.id, "run-a");
  assert.deepEqual(f.events, [["added last 10 app runner output lines to agent context", "info"]]);
  assert.equal(f.contextRefreshes.length, 1);
});

test("request errors retain existing event wording and preserve drafts and data", async (t) => {
  for (const [name, message] of [
    ["refresh", null], ["stop", "cannot perform action"], ["clear", "cannot perform action"],
    ["input", "app runner input failed: cannot perform action"],
    ["context", "app runner context transfer failed: cannot perform action"],
  ]) {
    await t.test(name, async () => {
      const f = fixture();
      f.seed();
      f.controller.setInputDraft("a", "run-a", "submitted");
      const before = f.controller.getData("a");
      const pending = actions[name](f.controller);
      const error = new Error("cannot perform action");
      f.calls[0].reject(error);
      assert.deepEqual(await pending, { success: false, reason: "error", error });
      assert.equal(f.controller.getData("a"), before);
      assert.equal(f.controller.getInputDraft("a", "run-a"), "submitted");
      assert.deepEqual(f.renders, []);
      assert.deepEqual(f.contextRefreshes, []);
      assert.deepEqual(f.events, message ? [[message, "error"]] : []);
    });
  }
});

test("errors from retired requests produce no failure output or events", async (t) => {
  for (const [name, invoke] of Object.entries(actions)) {
    await t.test(name, async () => {
      const f = fixture();
      f.seed();
      const pending = invoke(f.controller);
      f.controller.forgetTab("a");
      f.calls[0].reject(new Error("retired failure"));
      assert.deepEqual(await pending, { success: false, reason: "stale" });
      assert.deepEqual(f.controller.getData("a"), { runners: [], activeRun: null });
      assert.deepEqual(f.events, []);
      assert.deepEqual(f.renders, []);
    });
  }
});

test("explicit target is used instead of the currently selected tab", async () => {
  const f = fixture();
  f.seed();
  const target = f.target();
  f.select("b");
  assert.deepEqual(await f.controller.start("dev", target), { success: false, reason: "target" });
  assert.deepEqual(f.calls, []);
  const pending = f.controller.start("dev");
  assert.equal(f.calls[0].options.tabId, "b");
  f.calls[0].resolve({ activeRun: running("run-b") });
  assert.equal((await pending).success, true);
  assert.equal(f.controller.getData("b").activeRun.id, "run-b");
  assert.equal(f.controller.getData("a").activeRun.id, "run-a");
});


test("same-run output before stdin acknowledgment preserves a newer draft and newer output", async () => {
  const f = fixture();
  f.seed();
  f.controller.setInputDraft("a", "run-a", "submitted");
  const pending = f.controller.sendInput({ runId: "run-a", text: "submitted" });
  f.controller.applyData("a", { activeRun: { ...running(), lines: ["echo:submitted"] } });
  const currentData = f.controller.getData("a");
  f.controller.setInputDraft("a", "run-a", "next command");
  f.calls[0].resolve({ activeRun: { ...running(), lines: [] } });
  const result = await pending;
  assert.equal(result.success, true);
  assert.equal(result.inputDraftCleared, false);
  assert.equal(f.controller.getInputDraft("a", "run-a"), "next command");
  assert.equal(f.controller.getData("a"), currentData);
});
