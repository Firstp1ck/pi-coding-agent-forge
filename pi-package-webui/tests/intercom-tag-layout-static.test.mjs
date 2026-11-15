import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [css, app, controller] = await Promise.all([
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "activity-intercom-controller.mjs"), "utf8"),
]);

function rule(selector, label) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${label} should be present`);
  const end = css.indexOf("}", start);
  assert.ok(end > start, `${label} should be complete`);
  return css.slice(start, end + 1);
}

function functionSource(name, nextName) {
  const start = controller.indexOf(`function ${name}(`);
  const candidates = [
    controller.indexOf(`\n  function ${nextName}(`, start),
    controller.indexOf(`\n  async function ${nextName}(`, start),
  ].filter((index) => index > start);
  const end = Math.min(...candidates);
  assert.ok(start >= 0 && Number.isFinite(end), `${name} should remain a standalone frontend helper`);
  return controller.slice(start, end);
}

const container = rule(".composer-intercom-tags", "conversation tag container styles");
const tag = rule(".composer-intercom-tag", "conversation tag styles");
const label = rule(".composer-intercom-tag-label", "conversation tag label styles");
const icon = rule(".composer-intercom-tag-icon", "conversation tag icon styles");
const count = rule(".composer-intercom-tag-count", "conversation tag count styles");
const disclosure = functionSource("setOverflowOpen", "fitTags");
const install = functionSource("install", "updateIntercomConversationTag");
const render = functionSource("renderTags", "refreshSummaries");

assert.match(container, /position:\s*relative;/, "the overflow popup should anchor to the conversation tag strip");
assert.match(container, /display:\s*inline-flex;/, "conversation tags should remain on one measured row");
assert.match(container, /flex-direction:\s*row-reverse;/, "the newest conversation should start at the right edge and older tags should extend toward the middle");
assert.match(container, /flex:\s*0 1 50%;/, "the desktop strip should be allowed to reach the middle of the input row");
assert.match(container, /max-width:\s*50%;/, "the desktop strip should stop at half of the input row");
assert.match(container, /overflow:\s*hidden;/, "unfitted direct tags should not leak outside the strip");
assert.doesNotMatch(css, /\.composer-intercom-tags\.dense\s*\{/, "dense grids should not make conversation labels unrecognizable");
assert.doesNotMatch(container, /overflow(?:-x|-inline)?\s*:[^;]*(?:auto|scroll)/, "conversation tags should not restore horizontal scrolling");

assert.match(tag, /flex:\s*0 0 auto;[\s\S]*width:\s*auto;[\s\S]*max-width:\s*min\(13rem, 100%\);/, "direct tags should keep readable intrinsic widths up to the bounded maximum before overflow fitting");
assert.match(tag, /overflow:\s*hidden;/, "a single very long tag should still truncate safely");
assert.match(label, /flex:\s*1 1 auto;[\s\S]*min-width:\s*0;[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/, "long visual labels should produce a real single-line ellipsis");
assert.match(icon, /flex:\s*0 0 auto;/, "the conversation icon should stay stable while the label shrinks");
assert.match(count, /flex:\s*0 0 auto;/, "the conversation count should stay stable while the label shrinks");

assert.match(disclosure, /classList\.toggle\("overflow-open", expanded\)[\s\S]*aria-expanded[\s\S]*menu\.hidden = !expanded/, "the +X disclosure should synchronize visual, accessible, and hidden state");
assert.match(install, /ResizeObserver[\s\S]*event\.key !== "Escape"[\s\S]*restoreFocus: true[\s\S]*listen\(document, "pointerdown"/, "resize, Escape, and outside-click handling should keep the disclosure usable");
assert.match(render, /make\("button", "composer-intercom-tag overflow"[\s\S]*aria-haspopup[\s\S]*intercomConversationOverflowMenu[\s\S]*role", "dialog"/, "the hidden conversation count should render as an accessible popup button");
assert.match(install, /listen\(container, "click"[\s\S]*setOverflowOpen\(false, \{ restoreFocus: true \}\);[\s\S]*open\(button\.dataset\.intercomConversationId\)/, "hidden conversations should open through the existing conversation dialog");
assert.match(css, /\.composer-intercom-overflow-menu \{[\s\S]*position: absolute;[\s\S]*bottom: calc\(100% \+ 0\.42rem\);[\s\S]*max-height:[\s\S]*overflow-y: auto;/, "the bounded popup should expand upward above the compact strip");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.composer-intercom-tags \{ flex: 0 0 100%; width: 100%; min-width: 0; max-width: 100%; \}[\s\S]*?\.composer-intercom-overflow-menu \.composer-intercom-tag \{ min-height: 44px; \}/, "narrow disclosures should use the full row and keep hidden conversations touch-friendly");
assert.match(css, /body\.mobile-composer-disclosure \.composer-actions-panel > \.composer-context-tags \{[\s\S]*display: flex;[\s\S]*flex-wrap: wrap;/, "the narrow composer disclosure should give the full-width conversation strip its own row");
assert.match(app, /installSessionSkillTagResizeHandling\(\);\s*activityIntercom\.install\(\);/, "startup should install responsive fitting for both compact tag groups");
assert.match(controller, /const visualSignature = JSON\.stringify\(\[label, conversation\.messageCount\]\);[\s\S]*tag\.replaceChildren\(\.\.\.children\);[\s\S]*tag\.dataset\.intercomVisualSignature = visualSignature;/, "unchanged tag visuals should retain their existing children inside the polite live region");

console.log("intercom-tag-layout-static.test.mjs passed");
