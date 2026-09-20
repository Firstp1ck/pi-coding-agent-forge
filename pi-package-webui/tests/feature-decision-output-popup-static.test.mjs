import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, css] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
]);

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const next = app.slice(start + 1).match(/\nfunction [A-Za-z0-9_$]+\(/);
  const end = next ? start + 1 + next.index : app.length;
  return app.slice(start, end);
}

assert.match(
  html,
  /<button id="featureCategoryTag"[^>]*type="button"[^>]*aria-haspopup="dialog"[^>]*aria-controls="featureDecisionDialog"[^>]*disabled hidden><\/button>/,
  "the category tag should be a native dialog-triggering button and remain unavailable until exact output arrives",
);
assert.match(
  html,
  /<dialog id="featureDecisionDialog" class="extension-dialog feature-decision-dialog" aria-labelledby="featureDecisionDialogTitle">[\s\S]*<h2 id="featureDecisionDialogTitle">Classifier output<\/h2>[\s\S]*<pre id="featureDecisionDialogOutput"[\s\S]*<button id="featureDecisionDialogCloseButton" type="submit" value="close">Close<\/button>/,
  "the popup should use a labelled native dialog, plain-text output container, and explicit close control",
);
assert.match(html, /<form method="dialog">[\s\S]*id="featureDecisionDialogCloseButton"/, "the popup close button should use native dialog close semantics");
assert.doesNotMatch(app, /featureDecisionDialog\?\.addEventListener\("cancel"/, "Escape should retain native dialog cancellation behavior");
assert.match(css, /\.composer-feature-category-tag:hover:not\(:disabled\),\s*\.composer-feature-category-tag:focus-visible/, "the category button should expose hover and keyboard focus styling");
assert.match(css, /\.feature-decision-dialog-output \{[\s\S]*white-space:\s*pre-wrap;/, "exact output should render as wrapping preformatted plain text");

assert.match(app, /const FEATURE_DECISION_OUTPUT_STATUS_KEY = "feature-decision-output";/, "the consumer should use the approved dedicated status key");
assert.match(app, /const featureCategoryByTab = new Map\(\);\s*const featureDecisionOutputByTab = new Map\(\);/, "category and decision output should remain isolated in separate per-tab maps");
assert.match(app, /const FEATURE_DECISION_PAYLOAD_MAX_CHARS = \d+;/, "the consumer should bound the accepted status payload size");
assert.match(app, /const FEATURE_DECISION_REASON_MAX_CHARS = \d+;/, "the consumer should bound the rendered classifier reason");

const context = vm.createContext({ Map, JSON });
vm.runInContext(`
  const FEATURE_DECISION_PAYLOAD_MAX_CHARS = ${/const FEATURE_DECISION_PAYLOAD_MAX_CHARS = (\d+);/.exec(app)[1]};
  const FEATURE_DECISION_REASON_MAX_CHARS = ${/const FEATURE_DECISION_REASON_MAX_CHARS = (\d+);/.exec(app)[1]};
  ${functionSource("normalizeFeatureCategory")}
  ${functionSource("normalizeFeatureDecisionKind")}
  ${functionSource("normalizeFeatureDecisionReason")}
  ${functionSource("parseFeatureDecisionPayload")}
  ${functionSource("featureDecisionKindLabel")}
  ${functionSource("formatFeatureDecisionText")}
  const featureCategoryByTab = new Map();
  const featureDecisionOutputByTab = new Map();
  ${functionSource("featureDecisionForTab")}
  ${functionSource("featureDecisionOutputForTab")}
`, context);
assert.equal(context.normalizeFeatureCategory("lightweight-feature"), "lightweight-feature");
assert.equal(context.normalizeFeatureCategory("complex-feature"), "complex-feature");
assert.equal(context.normalizeFeatureCategory(" lightweight-feature"), "", "category validation must not trim payloads");
assert.equal(context.normalizeFeatureDecisionKind("feature_lightweight"), "feature_lightweight");
assert.equal(context.normalizeFeatureDecisionKind("feature_complex"), "feature_complex");
for (const invalid of ["feature_lightweight\n", "feature-lightweight", "lightweight-feature", "", null, undefined]) {
  assert.equal(context.normalizeFeatureDecisionKind(invalid), "", `decision kind should reject ${String(invalid)}`);
}

// The parser runs inside the sandbox realm, so compare plain field copies rather than prototypes.
function parsePayload(payload) {
  const decision = context.parseFeatureDecisionPayload(payload);
  return decision ? { kind: decision.kind, reason: decision.reason } : decision;
}

assert.deepEqual(
  parsePayload(JSON.stringify({ kind: "feature_complex", reason: "Crosses two packages." })),
  { kind: "feature_complex", reason: "Crosses two packages." },
  "the structured classifier payload should be accepted",
);
assert.deepEqual(
  parsePayload(JSON.stringify({ reason: "  Collapses\n\tuntrusted\u0007 whitespace and \u202espoofed direction.  ", kind: "feature_lightweight" })),
  { kind: "feature_lightweight", reason: "Collapses untrusted whitespace and spoofed direction." },
  "reason text should strip control and bidi formatting characters and collapse whitespace regardless of key order",
);
assert.deepEqual(
  parsePayload("feature_complex"),
  { kind: "feature_complex", reason: "" },
  "the legacy exact label should stay accepted for rolling compatibility",
);
assert.equal(
  parsePayload(JSON.stringify({ kind: "feature_complex", reason: "x".repeat(900) }))?.reason.length,
  500,
  "an oversized reason should be bounded rather than rendered in full",
);
for (const invalid of [
  undefined,
  null,
  42,
  "",
  "feature-lightweight",
  "lightweight-feature",
  '["feature_complex","reason"]',
  "{not json",
  JSON.stringify({ kind: "feature_complex" }),
  JSON.stringify({ kind: "feature_complex", reason: "" }),
  JSON.stringify({ kind: "feature_complex", reason: "   " }),
  JSON.stringify({ kind: "feature_complex", reason: 7 }),
  JSON.stringify({ kind: "bug", reason: "Restores documented behavior." }),
  JSON.stringify({ kind: "feature_complex", reason: "Extra fields are rejected.", extra: true }),
  JSON.stringify({ kind: "feature_complex", reason: "y".repeat(6000) }),
]) {
  assert.equal(parsePayload(invalid), null, `payload should fail closed: ${String(invalid).slice(0, 60)}`);
}

assert.equal(
  context.formatFeatureDecisionText({ kind: "feature_complex", reason: "Crosses two packages." }),
  "Decision: Complex feature (feature_complex)\nReason: Crosses two packages.",
  "the dialog text should read as a decision plus reason, not only the machine label",
);
assert.equal(
  context.formatFeatureDecisionText({ kind: "feature_lightweight", reason: "" }),
  "Decision: Lightweight feature (feature_lightweight)\nReason: The classifier reported feature_lightweight without a reason.",
  "a legacy label should render a deterministic readable fallback reason",
);
assert.equal(context.formatFeatureDecisionText(null), "", "absent decisions should render no dialog text");

vm.runInContext(`
  featureCategoryByTab.set("light", "lightweight-feature");
  featureDecisionOutputByTab.set("light", { kind: "feature_lightweight", reason: "One localized slice." });
  featureCategoryByTab.set("complex", "complex-feature");
  featureDecisionOutputByTab.set("complex", { kind: "feature_complex", reason: "Crosses two packages." });
  featureCategoryByTab.set("legacy", "complex-feature");
  featureDecisionOutputByTab.set("legacy", { kind: "feature_complex", reason: "" });
  featureCategoryByTab.set("mismatch", "complex-feature");
  featureDecisionOutputByTab.set("mismatch", { kind: "feature_lightweight", reason: "One localized slice." });
`, context);
assert.equal(
  context.featureDecisionOutputForTab("light"),
  "Decision: Lightweight feature (feature_lightweight)\nReason: One localized slice.",
  "lightweight output should stay readable and tab-scoped",
);
assert.equal(
  context.featureDecisionOutputForTab("complex"),
  "Decision: Complex feature (feature_complex)\nReason: Crosses two packages.",
  "complex output should stay readable and tab-scoped",
);
assert.equal(
  context.featureDecisionOutputForTab("legacy"),
  "Decision: Complex feature (feature_complex)\nReason: The classifier reported feature_complex without a reason.",
  "legacy exact-label state should render the deterministic fallback reason",
);
assert.equal(context.featureDecisionOutputForTab("mismatch"), "", "a category/decision mismatch must not open a popup");
assert.equal(context.featureDecisionOutputForTab("missing"), "", "a tab must not inherit another tab's decision");

const openSource = functionSource("openFeatureDecisionDialog");
assert.match(openSource, /const tabId = activeTabId;[\s\S]*featureDecisionOutputForTab\(tabId\)[\s\S]*textContent = output;[\s\S]*dialog\.showModal\(\)/, "popup opening should resolve and render only the active tab's exact output");
assert.doesNotMatch(app, /featureDecisionDialogOutput\.innerHTML/, "classifier reason text must never reach innerHTML");
assert.match(functionSource("handleFeatureDecisionOutputStatus"), /parseFeatureDecisionPayload\(statusText\)[\s\S]*featureDecisionOutputByTab\.set\(tabId, decision\);\s*else featureDecisionOutputByTab\.delete\(tabId\)/, "status handling should store only parsed decisions and drop rejected payloads");
assert.match(openSource, /featureDecisionDialogCloseButton\?\.focus/, "popup opening should place focus on its explicit close control");
assert.match(app, /elements\.featureCategoryTag\?\.addEventListener\("click", openFeatureDecisionDialog\)/, "native click and keyboard button activation should open the popup");
assert.match(app, /function installDialogModalPrimitive\(dialog\)[\s\S]*trigger\.focus\(\{ preventScroll: true \}\)/, "native dialog close should return focus to the triggering category button");

const clearSource = functionSource("clearFeatureDecisionStateForTab");
assert.match(clearSource, /featureCategoryByTab\.delete\(tabId\);\s*featureDecisionOutputByTab\.delete\(tabId\);[\s\S]*closeFeatureDecisionDialog\(\{ restoreFocus: false \}\)/, "lifecycle cleanup should clear both maps and close the affected popup");
assert.match(functionSource("handleFeatureCategoryStatus"), /else clearFeatureDecisionStateForTab\(tabId\)/, "clearing or rejecting a category should defensively clear exact output");
assert.match(functionSource("setActiveTabId"), /nextTabId !== activeTabId[\s\S]*closeFeatureDecisionDialog\(\{ restoreFocus: false \}\)/, "switching tabs should close the prior tab popup");
assert.match(functionSource("syncTabMetadata"), /clearFeatureDecisionStateForTab\(tabId\)/, "closed-tab metadata cleanup should remove decision state");
assert.match(functionSource("closeTerminalTabs"), /clearFeatureDecisionStateForTab\(id\)/, "explicit tab closure should remove decision state");
assert.match(app, /case "webui_connected":[\s\S]*clearFeatureDecisionStateForTab\(connectedTabId, \{ render: true \}\)[\s\S]*scheduleForegroundReconcile\("event stream reconnect", 0\)/, "reconnect should clear local state before authoritative replay");
assert.match(app, /statusKey === FEATURE_DECISION_OUTPUT_STATUS_KEY[\s\S]*handleFeatureDecisionOutputStatus[\s\S]*return;[\s\S]*statusKey === FEATURE_CATEGORY_STATUS_KEY[\s\S]*return;[\s\S]*statusEntries\.set/, "both feature statuses should be intercepted before generic footer storage while preserving category handling");

assert.match(html, /\/styles\.css\?v=154/, "integrated stylesheet changes should advance the cache query");
assert.match(html, /\/app\.js\?v=184/, "integrated app changes should advance the cache query");

console.log("feature decision-output popup static checks passed");
