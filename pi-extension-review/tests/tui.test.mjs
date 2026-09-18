import test from "node:test";
import assert from "node:assert/strict";
import { registerTestSdk } from "./package-test-loader.mjs";

registerTestSdk();

const { visibleWidth } = await import("@earendil-works/pi-tui");
const { ReviewStatusComponent, createReviewStatusPublisher, createStatusOverlayController, sanitizeUiText, showReviewSetup } = await import("../src/tui.ts");

function context(mode = "tui") {
  const calls = { custom: 0, unfocus: 0, abort: 0, notify: [] };
  let done;
  const ctx = {
    mode,
    ui: {
      notify(message, type) { calls.notify.push({ message, type }); },
      custom(factory, options) {
        calls.custom += 1;
        const promise = new Promise((resolve) => {
          done = resolve;
          calls.component = factory({ requestRender() { calls.renders = (calls.renders ?? 0) + 1; } }, {}, {}, resolve);
          options.onHandle({ unfocus() { calls.unfocus += 1; } });
        });
        return promise;
      },
    },
  };
  return { ctx, calls, close: () => done?.() };
}

test("setup returns settings only after final confirmation and cancellation changes nothing", async () => {
  const initial = { mode: "git", paths: [], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 100, timeoutMs: 900000, maxNoProgress: 3, maxContextBytes: 4096 };
  const models = [{ label: "fake/reviewer", profile: initial.model, supportedThinking: ["off"] }];
  const make = (confirmed) => {
    const selects = ["git", "fake/reviewer", "off"]; const inputs = ["", "3", "100", "900", "3"];
    return { ui: { select: async () => selects.shift(), input: async () => inputs.shift(), confirm: async () => confirmed, notify() {} } };
  };
  assert.equal(await showReviewSetup(make(false), initial, models), null);
  assert.deepEqual(await showReviewSetup(make(true), initial, models), initial);
});

test("setup rejects invalid numeric input and early cancellation before confirmation", async () => {
  const initial = { mode: "git", paths: [], exclusions: [], model: { provider: "fake", modelId: "reviewer", thinkingLevel: "off" }, contextLines: 3, maxTurns: 100, timeoutMs: 900000, maxNoProgress: 3, maxContextBytes: 4096 };
  const models = [{ label: "fake/reviewer", profile: initial.model, supportedThinking: ["off"] }];
  let confirmations = 0;
  const notices = [];
  const selects = ["git", "fake/reviewer", "off"];
  const inputs = ["", "0"];
  const ui = { select: async () => selects.shift(), input: async () => inputs.shift(), confirm: async () => { confirmations++; return true; }, notify: (text) => notices.push(text) };
  assert.equal(await showReviewSetup({ ui }, initial, models), null);
  assert.match(notices[0], /integer from 1 to 100/);
  assert.equal(await showReviewSetup({ ui: { ...ui, select: async () => undefined } }, initial, models), null);
  assert.equal(confirmations, 0);
});

test("status component sanitizes controls, scrolls, closes, and stays within narrow widths", () => {
  let closed = 0;
  const component = new ReviewStatusComponent({ title: "bad\x1btitle", lines: Array.from({ length: 20 }, (_, i) => `line ${i} ${"x".repeat(40)}`) }, () => {}, () => { closed += 1; });
  component.handleInput("\x1b[B");
  for (const width of [1, 4, 5, 12, 40]) for (const line of component.render(width)) assert.ok(visibleWidth(line) <= width);
  component.handleInput("\x1b");
  assert.equal(closed, 1);
  assert.equal(sanitizeUiText("a\x1b[31m b"), "a [31m b");
});

test("status overlay is fire-and-forget, unfocused, live, and toggles without aborting agents", async () => {
  const publisher = createReviewStatusPublisher({ title: "Review", lines: ["one"] });
  const overlay = createStatusOverlayController(publisher);
  const harness = context();
  overlay.toggle(harness.ctx);
  assert.equal(harness.calls.custom, 1);
  assert.equal(harness.calls.unfocus, 1);
  assert.equal(overlay.isOpen(), true);
  publisher.publish({ title: "Review", lines: ["two"] });
  assert.ok(harness.calls.renders > 0);
  overlay.toggle(harness.ctx);
  overlay.toggle(harness.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlay.isOpen(), true, "the old overlay promise cannot close a newly opened overlay");
  overlay.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(overlay.isOpen(), false);
  assert.equal(harness.calls.abort, 0);
  assert.equal(publisher.listenerCount(), 0);
});

test("non-TUI status is textual and never invokes custom UI", () => {
  const publisher = createReviewStatusPublisher({ title: "Review abc", lines: ["paused", "pending 2"] });
  const overlay = createStatusOverlayController(publisher);
  const harness = context("rpc");
  overlay.toggle(harness.ctx);
  assert.equal(harness.calls.custom, 0);
  assert.match(harness.calls.notify[0].message, /Review abc\npaused\npending 2/u);
});
