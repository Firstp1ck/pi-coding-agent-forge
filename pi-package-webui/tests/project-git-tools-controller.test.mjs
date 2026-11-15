import test from "node:test";
import assert from "node:assert/strict";
import {
  GIT_TOOLS_ENDPOINTS,
  GIT_TOOLS_SECTIONS,
  createProjectGitToolsController,
} from "../public/project-git-tools-controller.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}) {
  const target = { tabId: "origin-tab", root: "/repo/origin", generation: 1 };
  let current = target;
  const calls = [];
  const effects = [];
  const confirmations = [];
  let captures = 0;
  const controller = createProjectGitToolsController({
    api: (url, options) => {
      calls.push({ url, ...options });
      return overrides.api?.(url, options) ?? Promise.resolve({ ok: true, data: { root: target.root } });
    },
    captureTarget: () => { captures += 1; return current; },
    isTargetCurrent: (captured) => captured === current,
    confirm: (text, options) => {
      confirmations.push({ text, ...options });
      return overrides.confirm?.(text, options) ?? Promise.resolve(true);
    },
    addEvent: (message, level) => {
      effects.push({ kind: "event", message, level });
      overrides.addEvent?.(message, level);
    },
    onChange: () => {
      effects.push({ kind: "change" });
      overrides.onChange?.();
    },
    onRefreshChanges: (captured) => {
      effects.push({ kind: "changes", target: captured });
      return overrides.onRefreshChanges?.(captured);
    },
    onRefreshFooter: (captured) => {
      effects.push({ kind: "footer", target: captured });
      return overrides.onRefreshFooter?.(captured);
    },
    onMessage: (message, captured) => {
      effects.push({ kind: "message", message, target: captured });
      overrides.onMessage?.(message, captured);
    },
  });
  controller.reset(target);
  return {
    controller, target, calls, effects, confirmations,
    get captures() { return captures; },
    replace(next = { ...target, generation: 2 }) {
      current = next;
      controller.reset(next);
      return next;
    },
    invalidate() { current = null; },
  };
}

const action = {
  url: "/api/git-stash/save", body: { includeUntracked: true },
  success: "Stashed tracked and untracked changes.", refreshChanges: true,
};

function nonRenderEffects(h) {
  return h.effects.filter((effect) => effect.kind !== "change");
}

test("metadata preserves the existing six sections and lazy endpoints", () => {
  assert.deepEqual(GIT_TOOLS_SECTIONS.map(({ key, title }) => [key, title]), [
    ["stash", "Stash"], ["undo", "Undo & recovery"], ["worktrees", "Worktrees"],
    ["submodules", "Submodules"], ["tags", "Tags"], ["signing", "Signing"],
  ]);
  assert.deepEqual(GIT_TOOLS_ENDPOINTS, {
    stash: "/api/git-stash", undo: "/api/git-undo", worktrees: "/api/git-worktrees",
    submodules: "/api/git-submodules", tags: "/api/git-tags", signing: "/api/git-signing",
  });
});

test("opening and setters stay lazy; projections cannot change owned state", async () => {
  const h = harness({ api: async () => ({ ok: true, data: { stashes: [{ ref: "stash@{0}" }] } }) });
  const c = h.controller;
  assert.equal(c.setSectionOpen("stash", true), true);
  c.setBusy("operation", true);
  c.setBusy("conflict-agent", true);
  c.setNotice("stash", "Preview unavailable.");
  assert.equal(h.calls.length, 0);
  assert.equal(await c.load("stash"), true);
  const projection = c.getState();
  projection.openSections.clear();
  projection.busy.clear();
  projection.notice.stash = "tampered";
  projection.cache.stash.stashes[0].ref = "tampered";
  assert.equal(c.getState().openSections.has("stash"), true);
  assert.equal(c.getState().busy.has("operation"), true);
  assert.equal(c.getState().busy.has("conflict-agent"), true);
  assert.equal(c.getState().notice.stash, "");
  assert.equal(c.getState().cache.stash.stashes[0].ref, "stash@{0}");
  c.setSectionOpen("stash", false);
  c.setBusy("operation", false);
  assert.equal(c.getState().openSections.size, 0);
  assert.equal(c.getState().busy.has("operation"), false);
});

test("reset captures once when omitted, clears all owned state, and rejects foreign tokens", async () => {
  const h = harness();
  const foreign = harness().controller.capture();
  const old = h.controller.capture();
  h.controller.setSectionOpen("tags", true);
  h.controller.setNotice("tags", "old notice");
  h.controller.setBusy("operation", true);
  await h.controller.load("tags");
  h.controller.reset();
  assert.equal(h.captures, 1);
  assert.deepEqual(h.controller.getState(), {
    tabId: h.target.tabId, openSections: new Set(), cache: {}, busy: new Set(), notice: {},
  });
  assert.equal(h.controller.isCurrent(old), false);
  assert.equal(h.controller.isCurrent(foreign), false);
  assert.equal(await h.controller.run("stash", action, foreign), false);
  h.replace(null);
  assert.equal(h.controller.getState().tabId, null);
  assert.equal(h.controller.isCurrent(h.controller.capture()), false);
  assert.equal(await h.controller.load("tags"), false);
  assert.equal(h.calls.length, 1);
});

test("unknown and prototype section keys are rejected without dispatch", async () => {
  const h = harness();
  for (const key of ["unknown", "reflog", "toString", "__proto__", "operation"]) {
    await assert.rejects(h.controller.load(key), RangeError);
    await assert.rejects(h.controller.run(key, action), RangeError);
    assert.throws(() => h.controller.setSectionOpen(key, true), RangeError);
    assert.throws(() => h.controller.setNotice(key, "error"), RangeError);
  }
  assert.throws(() => h.controller.setBusy("load:unknown", true), RangeError);
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirmations.length, 0);
});

test("loads coalesce during a request, use cache afterwards, and force a fresh read", async () => {
  const request = deferred();
  const h = harness({ api: () => request.promise });
  const pending = h.controller.load("tags");
  assert.equal(h.controller.getState().busy.has("load:tags"), true);
  assert.equal(await h.controller.load("tags", { force: true }), false);
  assert.equal(h.calls.length, 1);
  request.resolve({ ok: true, data: { tags: [{ name: "v1" }] } });
  assert.equal(await pending, true);
  assert.equal(h.controller.getState().busy.size, 0);
  assert.equal(await h.controller.load("tags"), true);
  assert.equal(h.calls.length, 1);
  assert.equal(await h.controller.load("tags", { force: true }), true);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every(({ tabId }) => tabId === h.target.tabId));
});

test("load failures preserve cached data, display errors and allow retry", async () => {
  const responses = [
    { ok: false, error: "Signing unavailable" },
    new Error("network failed"),
    { ok: false },
    { ok: true, data: { signingKey: "key-id" } },
    { ok: false, error: "refresh failed" },
  ];
  const h = harness({ api: async () => {
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  } });
  for (const message of ["Signing unavailable", "network failed", "Failed to load signing"]) {
    assert.equal(await h.controller.load("signing"), false);
    assert.equal(h.controller.getState().notice.signing, message);
    assert.equal(h.controller.getState().busy.size, 0);
  }
  assert.equal(await h.controller.load("signing"), true);
  assert.equal(h.controller.getState().notice.signing, "");
  assert.equal(await h.controller.load("signing", { force: true }), false);
  assert.deepEqual(h.controller.getState().cache.signing, { signingKey: "key-id" });
  assert.equal(h.controller.getState().notice.signing, "refresh failed");
});

test("undo loads optional reflog for the captured tab and tolerates reflog failure", async (t) => {
  for (const mode of ["success", "false", "error"]) {
    await t.test(mode, async () => {
      const h = harness({ api: async (url) => {
        if (url === "/api/git-undo") return { ok: true, data: { canUndoLastCommit: true } };
        if (mode === "error") throw new Error("reflog unavailable");
        return mode === "false" ? { ok: false } : { ok: true, data: { entries: [{ hash: "abc" }] } };
      } });
      assert.equal(await h.controller.load("undo"), true);
      assert.deepEqual(h.calls, [
        { url: "/api/git-undo", tabId: "origin-tab" },
        { url: "/api/git-reflog", tabId: "origin-tab" },
      ]);
      assert.deepEqual(h.controller.getState().cache.reflog, mode === "success" ? { entries: [{ hash: "abc" }] } : null);
      assert.equal(h.controller.getState().notice.undo, "");
      assert.equal(h.controller.getState().busy.size, 0);
    });
  }
});

test("confirmation preserves text/root/label and declined or failed prompts do not dispatch", async () => {
  const choice = deferred();
  const h = harness({ confirm: () => choice.promise });
  const options = { ...action, confirm: "Stash all changes?\n\nIncludes untracked files." };
  const pending = h.controller.run("stash", options);
  assert.deepEqual(h.confirmations, [{
    text: options.confirm, affected: "/repo/origin", confirmLabel: action.success,
  }]);
  assert.equal(await h.controller.run("stash", options), false);
  assert.equal(h.confirmations.length, 1);
  choice.resolve(false);
  assert.equal(await pending, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.controller.getState().busy.size, 0);
  assert.deepEqual(nonRenderEffects(h), []);

  const error = harness({ confirm: async () => { throw new Error("prompt failed"); } });
  assert.equal(await error.controller.run("stash", options), false);
  assert.equal(error.controller.getState().notice.stash, "prompt failed");
  assert.equal(error.calls.length, 0);

  const fallback = harness({ confirm: async () => false });
  fallback.replace({ tabId: "fallback-tab", root: "" });
  await fallback.controller.run("tags", { url: "/unused", confirm: "Continue?" });
  assert.deepEqual(fallback.confirmations, [{ text: "Continue?", affected: "the current repository", confirmLabel: "Continue" }]);
});

test("confirmation names the loaded repository without replacing its captured target", async () => {
  const h = harness({
    api: async () => ({ ok: true, data: { root: "/repo/resolved" } }),
    confirm: async () => false,
  });
  const token = h.controller.capture();
  await h.controller.load("tags");
  await h.controller.run("tags", { url: "/unused", confirm: "Create tag?" }, token);
  assert.equal(h.confirmations[0].affected, "/repo/resolved");
  assert.equal(h.controller.capture(), token);
  assert.equal(h.target.root, "/repo/origin");
  assert.equal(h.calls.length, 1);

  h.replace({ tabId: "replacement-tab", root: "/repo/replacement" });
  assert.equal(await h.controller.run("tags", { url: "/unused", confirm: "Create tag?" }, token), false);
  await h.controller.run("tags", { url: "/unused", confirm: "Create tag?" });
  assert.equal(h.confirmations[1].affected, "/repo/replacement");
});

test("successful actions preserve method/body and refresh with the originating target", async () => {
  const response = { ok: true, data: { removed: "/repo/other" } };
  const h = harness({ api: async () => response });
  h.controller.setNotice("worktrees", "old error");
  assert.equal(await h.controller.run("worktrees", {
    url: "/api/git-worktrees", method: "DELETE", body: { path: "/repo/other", confirmed: true },
    confirm: "Remove worktree?", success: "Removed worktree.",
    successMessage: (result) => { assert.equal(result, response); return `Removed ${result.data.removed}.`; },
    refreshChanges: true,
  }), true);
  assert.deepEqual(h.calls, [
    { url: "/api/git-worktrees", method: "DELETE", body: { path: "/repo/other", confirmed: true }, tabId: "origin-tab" },
    { url: "/api/git-worktrees", tabId: "origin-tab" },
  ]);
  assert.deepEqual(nonRenderEffects(h), [
    { kind: "event", message: "Removed /repo/other.", level: "success" },
    { kind: "changes", target: h.target },
    { kind: "message", message: "Removed /repo/other.", target: h.target },
    { kind: "footer", target: h.target },
  ]);
  assert.equal(nonRenderEffects(h).at(-1).target, h.target);
  assert.equal(h.captures, 0, "actions never recapture the active tab after an await");
  assert.equal(h.controller.getState().notice.worktrees, "");
  assert.equal(h.controller.getState().busy.size, 0);
});

test("default POST, fallback success message and optional Changes refresh retain existing semantics", async () => {
  const h = harness();
  assert.equal(await h.controller.run("stash", { ...action, successMessage: () => "", refreshChanges: false }), true);
  assert.deepEqual(h.calls[0], { url: action.url, method: "POST", body: action.body, tabId: "origin-tab" });
  assert.deepEqual(nonRenderEffects(h).map(({ kind }) => kind), ["event", "message", "footer"]);
  assert.equal(nonRenderEffects(h)[0].message, action.success);
});

test("actions reject duplicate dispatch through both mutation and section-refresh waits", async () => {
  const mutation = deferred();
  const refresh = deferred();
  const enteredRefresh = deferred();
  const h = harness({ api: (url) => {
    if (url === action.url) return mutation.promise;
    enteredRefresh.resolve();
    return refresh.promise;
  } });
  const pending = h.controller.run("stash", action);
  assert.equal(h.controller.getState().busy.has("stash"), true);
  assert.equal(await h.controller.run("stash", action), false);
  mutation.resolve({ ok: true });
  await enteredRefresh.promise;
  assert.equal(h.controller.getState().busy.has("stash"), false);
  assert.equal(h.controller.getState().busy.has("load:stash"), true);
  assert.equal(await h.controller.run("stash", action), false);
  refresh.resolve({ ok: true, data: { stashes: [] } });
  assert.equal(await pending, true);
  assert.equal(h.calls.length, 2);
  assert.equal(await h.controller.run("stash", action), true, "admission is released after completion");
});

test("action false responses, hints and thrown errors stay visible and release busy admission", async (t) => {
  for (const [response, message] of [
    [{ ok: false, error: "Cannot undo", hint: "Push is already published" }, "Cannot undo\nPush is already published"],
    [{ ok: false }, "git action failed"],
    [new Error("offline"), "offline"],
  ]) {
    await t.test(message, async () => {
      const h = harness({ api: async () => {
        if (response instanceof Error) throw response;
        return response;
      } });
      assert.equal(await h.controller.run("stash", action), false);
      assert.equal(h.controller.getState().notice.stash, message);
      assert.equal(h.controller.getState().busy.size, 0);
      assert.deepEqual(nonRenderEffects(h), []);
      assert.equal(h.calls.length, 1);
      await h.controller.run("stash", action);
      assert.equal(h.calls.length, 2, "failed action can be retried");
    });
  }
});

test("failed section refresh remains visible while successful action still refreshes Changes and footer", async () => {
  const h = harness({ api: async (url) => url === action.url ? { ok: true } : { ok: false, error: "List refresh failed" } });
  assert.equal(await h.controller.run("stash", action), true);
  assert.equal(h.controller.getState().notice.stash, "List refresh failed");
  assert.equal(h.controller.getState().busy.size, 0);
  assert.deepEqual(nonRenderEffects(h).map(({ kind }) => kind), ["event", "changes", "message", "footer"]);
});

test("refresh callback errors become notices without skipping busy cleanup", async (t) => {
  for (const callback of ["onRefreshChanges", "onRefreshFooter"]) {
    await t.test(callback, async () => {
      const h = harness({ [callback]: async () => { throw new Error("Refresh failed"); } });
      assert.equal(await h.controller.run("stash", action), false);
      assert.equal(h.controller.getState().notice.stash, "Refresh failed");
      assert.equal(h.controller.getState().busy.size, 0);
      if (callback === "onRefreshChanges") assert.equal(h.effects.some(({ kind }) => kind === "message" || kind === "footer"), false);
    });
  }
});

test("reset during confirmation and a token from an earlier preview cannot authorize a replacement", async () => {
  const choice = deferred();
  const h = harness({ confirm: () => choice.promise });
  const oldToken = h.controller.capture();
  const pending = h.controller.run("stash", { ...action, confirm: "Continue?" });
  h.replace(h.target);
  h.controller.setBusy("stash", true);
  const replacement = h.controller.getState();
  const effectCount = h.effects.length;
  choice.resolve(true);
  assert.equal(await pending, false);
  assert.equal(h.controller.isCurrent(oldToken), false);
  assert.equal(await h.controller.run("stash", action, oldToken), false);
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.controller.getState(), replacement);
  assert.equal(h.effects.length, effectCount);
});

test("old load completion and cleanup cannot overwrite a newer same-section request", async (t) => {
  for (const failure of [false, true]) {
    await t.test(failure ? "rejected old load" : "successful old load", async () => {
      const old = deferred();
      const next = deferred();
      let requests = 0;
      const h = harness({ api: () => ++requests === 1 ? old.promise : next.promise });
      const pending = h.controller.load("stash");
      h.replace();
      h.controller.setNotice("stash", "replacement notice");
      const replacementLoad = h.controller.load("stash");
      const replacement = h.controller.getState();
      const effectCount = h.effects.length;
      if (failure) old.reject(new Error("old failure"));
      else old.resolve({ ok: true, data: { stashes: ["old"] } });
      assert.equal(await pending, false);
      assert.deepEqual(h.controller.getState(), replacement);
      assert.equal(h.effects.length, effectCount);
      next.resolve({ ok: true, data: { stashes: ["new"] } });
      assert.equal(await replacementLoad, true);
      assert.deepEqual(h.controller.getState().cache.stash, { stashes: ["new"] });
    });
  }
});

test("undo cannot start or publish reflog across reset", async (t) => {
  for (const stage of ["primary", "reflog"]) {
    await t.test(stage, async () => {
      const wait = deferred();
      const entered = deferred();
      const h = harness({ api: (url) => {
        if (stage === "primary" || url === "/api/git-reflog") {
          entered.resolve();
          return wait.promise;
        }
        return Promise.resolve({ ok: true, data: { canUndoLastCommit: true } });
      } });
      const pending = h.controller.load("undo");
      await entered.promise;
      h.replace();
      const effectCount = h.effects.length;
      wait.resolve({ ok: true, data: { entries: ["old"] } });
      assert.equal(await pending, false);
      assert.deepEqual(h.controller.getState().cache, {});
      assert.equal(h.effects.length, effectCount);
      assert.equal(h.calls.length, stage === "primary" ? 1 : 2);
    });
  }
});

test("old action completion cannot clear a replacement action or start follow-ups", async (t) => {
  for (const failure of [false, true]) {
    await t.test(failure ? "old action error" : "old action success", async () => {
      const old = deferred();
      const next = deferred();
      let requests = 0;
      const h = harness({ api: (url) => {
        if (url !== action.url) return Promise.resolve({ ok: true, data: {} });
        return ++requests === 1 ? old.promise : next.promise;
      } });
      const pending = h.controller.run("stash", action);
      h.replace();
      const replacementAction = h.controller.run("stash", action);
      const replacement = h.controller.getState();
      const effectCount = h.effects.length;
      if (failure) old.reject(new Error("old action failure"));
      else old.resolve({ ok: true });
      assert.equal(await pending, false);
      assert.deepEqual(h.controller.getState(), replacement);
      assert.equal(h.effects.length, effectCount);
      assert.equal(h.calls.length, 2);
      next.resolve({ ok: true });
      assert.equal(await replacementAction, true);
      assert.equal(h.controller.getState().busy.size, 0);
    });
  }
});

test("reset during an action's section reload prevents Changes, message and footer follow-ups", async () => {
  const reload = deferred();
  const entered = deferred();
  const h = harness({ api: (url) => {
    if (url === action.url) return Promise.resolve({ ok: true });
    entered.resolve();
    return reload.promise;
  } });
  const pending = h.controller.run("stash", action);
  await entered.promise;
  h.replace();
  h.controller.setNotice("stash", "new owner");
  const replacement = h.controller.getState();
  const effectCount = h.effects.length;
  reload.resolve({ ok: true, data: { stashes: ["old"] } });
  assert.equal(await pending, false);
  assert.deepEqual(h.controller.getState(), replacement);
  assert.equal(h.effects.length, effectCount);
  assert.deepEqual(nonRenderEffects(h).map(({ kind }) => kind), ["event"]);
});

test("reset during Changes or footer refresh suppresses all remaining continuation writes", async (t) => {
  for (const callback of ["onRefreshChanges", "onRefreshFooter"]) {
    for (const failure of [false, true]) {
      await t.test(`${callback}, ${failure ? "failure" : "success"}`, async () => {
        const wait = deferred();
        const entered = deferred();
        const h = harness({ [callback]: () => { entered.resolve(); return wait.promise; } });
        const pending = h.controller.run("stash", action);
        await entered.promise;
        assert.equal(await h.controller.run("stash", action), false, "refresh keeps action admission reserved");
        h.replace();
        h.controller.setBusy("stash", true);
        const replacement = h.controller.getState();
        const effectCount = h.effects.length;
        if (failure) wait.reject(new Error("old refresh failed"));
        else wait.resolve();
        assert.equal(await pending, false);
        assert.deepEqual(h.controller.getState(), replacement);
        assert.equal(h.effects.length, effectCount);
        if (callback === "onRefreshChanges") {
          assert.equal(h.effects.some(({ kind }) => kind === "message" || kind === "footer"), false);
        }
      });
    }
  }
});

test("external operation/conflict-agent cleanup is guarded by its original owner token", () => {
  const h = harness();
  const old = h.controller.capture();
  h.controller.setBusy("operation", true, old);
  h.controller.setBusy("conflict-agent", true, old);
  h.replace(h.target);
  const current = h.controller.capture();
  h.controller.setBusy("operation", true, current);
  h.controller.setBusy("conflict-agent", true, current);
  const effectCount = h.effects.length;
  for (const key of ["operation", "conflict-agent"]) assert.equal(h.controller.setBusy(key, false, old), false);
  assert.equal(h.controller.setNotice("worktrees", "old preview failure", old), false);
  assert.equal(h.controller.setSectionOpen("worktrees", true, old), false);
  assert.equal(h.effects.length, effectCount);
  assert.deepEqual(h.controller.getState().busy, new Set(["operation", "conflict-agent"]));
  assert.equal(h.controller.setBusy("operation", false, current), true);
  assert.equal(h.controller.getState().busy.has("conflict-agent"), true);
});

test("target invalidation alone prevents completion and dispatch, without recapturing an active tab", async () => {
  const request = deferred();
  const h = harness({ api: () => request.promise });
  const token = h.controller.capture();
  const pending = h.controller.run("stash", action);
  h.invalidate();
  const snapshot = h.controller.getState();
  const effectCount = h.effects.length;
  request.resolve({ ok: true });
  assert.equal(await pending, false);
  assert.equal(h.controller.isCurrent(token), false);
  assert.equal(await h.controller.load("tags"), false);
  assert.equal(await h.controller.run("tags", action), false);
  assert.equal(h.controller.setBusy("operation", true, token), false);
  assert.deepEqual(h.controller.getState(), snapshot);
  assert.equal(h.effects.length, effectCount);
  assert.equal(h.calls.length, 1);
  assert.equal(h.captures, 0);
});

test("a replacement tab/root cannot inherit an old confirmation or its follow-up requests", async () => {
  const choice = deferred();
  const h = harness({ confirm: () => choice.promise });
  const pending = h.controller.run("worktrees", {
    url: "/api/git-worktrees", method: "DELETE", body: { path: "/repo/other", confirmed: true },
    confirm: "Remove the selected worktree?", success: "Removed worktree.",
  });
  const replacement = h.replace({ tabId: "replacement-tab", root: "/repo/replacement", generation: 1 });
  choice.resolve(true);
  assert.equal(await pending, false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.confirmations[0].affected, h.target.root);
  assert.equal(await h.controller.run("stash", action), true);
  assert.ok(h.calls.every(({ tabId }) => tabId === replacement.tabId));
  assert.equal(nonRenderEffects(h).find(({ kind }) => kind === "changes").target, replacement);
  assert.equal(nonRenderEffects(h).find(({ kind }) => kind === "footer").target, replacement);
});

test("synchronous callbacks that reset the owner cannot launch the next request or repaint", async () => {
  let h;
  let resetOnRender = false;
  h = harness({ onChange: () => {
    if (resetOnRender) { resetOnRender = false; h.replace(); }
  } });
  resetOnRender = true;
  assert.equal(await h.controller.run("stash", action), false);
  assert.equal(h.calls.length, 0);
  resetOnRender = true;
  assert.equal(await h.controller.load("undo"), false);
  assert.equal(h.calls.length, 0);

  let eventHarness;
  eventHarness = harness({ addEvent: () => eventHarness.replace() });
  assert.equal(await eventHarness.controller.run("stash", action), false);
  assert.equal(eventHarness.calls.length, 1);
  assert.deepEqual(eventHarness.controller.getState().cache, {});
  assert.deepEqual(nonRenderEffects(eventHarness).map(({ kind }) => kind), ["event"]);
});
