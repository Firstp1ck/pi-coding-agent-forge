import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "activity-intercom-controller.mjs"), "utf8");

function functionSource(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`\n  function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} should remain a standalone frontend helper`);
  return app.slice(start, end);
}

function chip(width) {
  return {
    hidden: false,
    textContent: "",
    title: "",
    attributes: new Map(),
    measurements: 0,
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    getBoundingClientRect() {
      this.measurements += 1;
      return { width };
    },
  };
}

const tags = [chip(90), chip(100), chip(110)];
const menuItems = [chip(90), chip(100), chip(110)];
const overflow = chip(22);
const overflowStateCalls = [];
const container = {
  hidden: false,
  clientWidth: 250,
  querySelectorAll: (selector) => {
    if (selector === ":scope > button.composer-intercom-tag:not(.overflow)") return tags;
    if (selector === ".composer-intercom-overflow-menu-item") return menuItems;
    return [];
  },
  querySelector: (selector) => selector === "button.composer-intercom-tag.overflow" ? overflow : null,
};
const context = {
  disposed: false,
  nodes: { intercomConversationTags: container },
  intercomConversationOverflowOpen: false,
  setOverflowOpen: (open) => overflowStateCalls.push(open),
  window: { getComputedStyle: () => ({ columnGap: "5px", gap: "5px" }) },
};
vm.runInNewContext(
  `${functionSource("fitTags", "scheduleTagLayout")}\nthis.fitTags = fitTags;`,
  context,
);

context.fitTags();
assert.deepEqual(tags.map((tag) => tag.hidden), [false, false, true], "the strip should keep the maximum complete conversation tags that fit");
assert.deepEqual(menuItems.map((tag) => tag.hidden), [true, true, false], "the popup should contain only conversations hidden from the strip");
assert.equal(overflow.hidden, false, "the overflow chip should remain visible while conversations are hidden");
assert.equal(overflow.textContent, "+1", "the overflow chip should report the current hidden count");
assert.equal(overflow.attributes.get("aria-label"), "Show 1 more agent conversation", "the disclosure should announce its current hidden count");
assert.equal(overflow.measurements, 1, "fitting should measure one overflow width per digit count");

container.clientWidth = 320;
context.fitTags();
assert.deepEqual(tags.map((tag) => tag.hidden), [false, false, false], "widening the input should reveal every conversation without a data refresh");
assert.deepEqual(menuItems.map((tag) => tag.hidden), [true, true, true], "the popup should not duplicate visible conversations");
assert.equal(overflow.hidden, true, "the +X chip should disappear when every conversation fits");
assert.deepEqual(overflowStateCalls, [false], "revealing every conversation should close an open overflow popup");

container.clientWidth = 130;
context.fitTags();
assert.deepEqual(tags.map((tag) => tag.hidden), [false, true, true], "narrowing the input should hide whole tags instead of crushing every label");
assert.deepEqual(menuItems.map((tag) => tag.hidden), [true, false, false], "responsive fitting should update the selectable popup contents");
assert.equal(overflow.textContent, "+2", "responsive fitting should keep the overflow count current");

container.clientWidth = 0;
const zeroWidthState = tags.map((tag) => tag.hidden);
const zeroWidthOverflowText = overflow.textContent;
context.fitTags();
assert.deepEqual(tags.map((tag) => tag.hidden), zeroWidthState, "a temporarily unmeasurable strip should preserve its last stable visibility state");
assert.equal(overflow.textContent, zeroWidthOverflowText, "a zero-width pass should not expose a stale overflow count");

console.log("intercom tag overflow layout tests passed");
