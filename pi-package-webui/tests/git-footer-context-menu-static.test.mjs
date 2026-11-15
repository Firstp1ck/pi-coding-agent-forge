import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, css] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
]);

assert.match(
  html,
  /id="gitFooterContextMenu"[^>]*role="menu"[^>]*aria-label="Git footer box actions"[^>]*hidden[\s\S]*data-git-footer-menu-action="disable"[\s\S]*Disable this box[\s\S]*data-git-footer-menu-action="visibility"[\s\S]*Open Git-footer Visibility/,
  "the page should provide both requested Git footer context-menu actions",
);
assert.match(
  app,
  /function bindGitFooterContextMenu\(node, chip\)[\s\S]*aria-keyshortcuts", "ContextMenu Shift\+F10"[\s\S]*addEventListener\("contextmenu"[\s\S]*event\.key !== "ContextMenu"[\s\S]*event\.shiftKey && event\.key === "F10"/,
  "every bound footer box should support pointer and keyboard context-menu activation",
);
assert.match(
  app,
  /function renderGitFooterPayloadMetric\(chip, payload\)[\s\S]*return bindGitFooterContextMenu\(node, chip\);/,
  "metric boxes should receive the context menu",
);
assert.match(
  app,
  /function renderGitFooterPayloadMeta\(chip, tab, payload\)[\s\S]*return bindGitFooterContextMenu\(node, chip\);/,
  "metadata boxes should receive the context menu",
);
assert.match(
  app,
  /function showGitFooterContextMenu\(event, chip, trigger\)[\s\S]*disableButton\.textContent = `Disable \$\{label\} box`[\s\S]*window\.innerWidth[\s\S]*window\.innerHeight/,
  "the menu should name the clicked box and remain inside the viewport",
);
assert.match(
  app,
  /async function disableGitFooterContextChip\(key, label\)[\s\S]*runGitFooterVisibilityCommand\("hide", \[key\], target, \{ dialogOwned: false \}\)[\s\S]*requestGitFooterWebuiPayload/,
  "disabling a box should persist its matching WebUI visibility key and refresh the payload",
);
assert.match(
  app,
  /data-git-footer-menu-action[\s\S]*action === "disable"[\s\S]*disableGitFooterContextChip\(state\.key, state\.label\)[\s\S]*action === "visibility"[\s\S]*openGitFooterVisibilityDialog\(\)/,
  "the menu should dispatch both requested actions",
);
assert.match(
  app,
  /gitFooterContextMenu[\s\S]*addEventListener\("keydown"[\s\S]*event\.key === "Escape"[\s\S]*event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"[\s\S]*event\.key === "Home" \|\| event\.key === "End"/,
  "the context menu should support standard keyboard navigation",
);
assert.match(
  app,
  /!elements\.gitFooterContextMenu\.hidden[\s\S]*!event\.target\?\.closest\?\.\("\.git-footer-context-menu"\)[\s\S]*closeGitFooterContextMenu\(\)/,
  "clicking outside should close the Git footer context menu",
);

assert.match(
  html,
  /role="menuitemcheckbox"[^>]*aria-checked="false"[^>]*data-git-footer-menu-action="toggle-advanced"[^>]*hidden>Toggle advanced<\/button>/,
  "the advanced-layout action should be a hidden-by-default checkbox menu item",
);
assert.match(
  app,
  /function syncGitFooterAdvancedMenuItem\(key = gitFooterContextMenuState\?\.key\)[\s\S]*advancedButton\.hidden = key !== "model"[\s\S]*advancedButton\.textContent = footerScopedModelLayout === "advanced" \? "Toggle Simple" : "Toggle advanced"[\s\S]*advancedButton\.setAttribute\("aria-checked", footerScopedModelLayout === "advanced" \? "true" : "false"\)[\s\S]*function showGitFooterContextMenu\(event, chip, trigger\)[\s\S]*syncGitFooterAdvancedMenuItem\(key\)/,
  "the Model-only layout action should show the destination label and expose its current checked state",
);
assert.match(
  app,
  /const FOOTER_SCOPED_MODEL_LAYOUT_STORAGE_KEY = "pi-webui-footer-scoped-model-layout-v1"[\s\S]*function normalizeFooterScopedModelLayout\(value\)[\s\S]*value === "advanced" \? "advanced" : "flat"[\s\S]*localStorage\.setItem\(FOOTER_SCOPED_MODEL_LAYOUT_STORAGE_KEY, next\)/,
  "the browser-local layout preference should normalize unknown values and persist explicit flat or advanced state",
);
assert.match(
  app,
  /window\.addEventListener\("storage"[\s\S]*event\.key === FOOTER_SCOPED_MODEL_LAYOUT_STORAGE_KEY[\s\S]*setFooterScopedModelLayout\(event\.newValue, \{ persist: false \}\)/,
  "same-origin Web UI tabs should adopt advanced-layout storage changes without rewriting them",
);
assert.match(
  app,
  /function setFooterScopedModelLayout\([\s\S]*syncGitFooterAdvancedMenuItem\(\)[\s\S]*renderFooter\(\)/,
  "live layout adoption should refresh an open checkbox",
);
assert.match(
  app,
  /function footerModelPickerRenderKey\(\)[\s\S]*footerScopedModelLayout[\s\S]*orderedFooterScopedModels\(\)/,
  "layout and scoped order should invalidate open-picker fast rendering",
);
assert.match(
  app,
  /function footerScopedModelProviderGroups\(models = orderedFooterScopedModels\(\)\)[\s\S]*modelsByProvider\.get\(provider\)\.push\(model\)[\s\S]*sort\(\(\[a\], \[b\]\) => compareFooterScopedModelProviders\(a, b\)\)[\s\S]*models: providerModels/,
  "provider grouping should sort provider columns while preserving each provider's existing model order",
);
assert.match(
  app,
  /footer-model-provider-column[\s\S]*dataset\.footerProviderIndex = String\(providerIndex\)[\s\S]*setAttribute\("role", "group"\)[\s\S]*setAttribute\("aria-labelledby", heading\.id\)[\s\S]*renderFooterModelOption\(model, \{ advanced: true, providerIndex, modelIndex, initialKey \}\)/,
  "advanced rendering should expose labelled provider groups and stable provider/model indices",
);
assert.match(
  app,
  /function footerScopedModelOrderWithProviderOrder\(provider, providerOrder\)[\s\S]*allowedKeys[\s\S]*nextProviderKeys[\s\S]*String\(model\?\.provider \|\| ""\) === provider[\s\S]*function commitFooterScopedModelProviderOrder[\s\S]*commitFooterScopedModelOrder\(nextOrder/,
  "advanced provider reordering should replace only that provider's existing global order slots",
);
assert.match(
  app,
  /function handleAdvancedFooterModelKeydown\(event, model\)[\s\S]*event\.key === "Enter" \|\| event\.key === " "[\s\S]*!event\.repeat[\s\S]*applyFooterModel\(model\)[\s\S]*event\.key === "Escape"[\s\S]*setFooterModelPickerOpen\(false, \{ restoreFocus: true \}\)[\s\S]*event\.altKey[\s\S]*moveFooterScopedModelWithinProviderByOffset[\s\S]*event\.key === "ArrowUp" \|\| event\.key === "ArrowDown" \|\| event\.key === "Home" \|\| event\.key === "End"[\s\S]*event\.key === "ArrowLeft" \|\| event\.key === "ArrowRight"/,
  "advanced options should implement provider-local reorder, apply, close/focus restoration, row, and provider keyboard contracts",
);
assert.match(
  app,
  /function focusAdvancedFooterModelOption\([\s\S]*scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/,
  "advanced navigation should reveal focused options",
);
assert.match(
  app,
  /function syncAdvancedFooterModelRovingTabStop\([\s\S]*option\.tabIndex = option === target \? 0 : -1[\s\S]*restoreScopedControlContinuity[\s\S]*syncAdvancedFooterModelRovingTabStop\(\)/,
  "footer rerenders should preserve one advanced roving tab stop",
);
assert.match(
  app,
  /let footerModelApplyInFlight = false[\s\S]*async function applyFooterModel\(model\)[\s\S]*footerModelApplyInFlight[\s\S]*footerModelPickerOpen = false[\s\S]*renderFooter\(\)[\s\S]*await api\("\/api\/model"[\s\S]*footerModelApplyInFlight = false/,
  "model application should close synchronously and reject duplicate in-flight activation",
);
assert.match(
  app,
  /Drag within provider[\s\S]*Alt\+Up\/Down reorders[\s\S]*Home\/End[\s\S]*Enter\/Space[\s\S]*help\.id = "footerModelPickerHelp"[\s\S]*setAttribute\("aria-describedby", help\.id\)/,
  "the picker should programmatically associate complete advanced reorder and keyboard help",
);
assert.match(
  app,
  /if \(advanced\) \{[\s\S]*handleAdvancedFooterModelKeydown\(event, model\)[\s\S]*\} else \{[\s\S]*event\.altKey[\s\S]*moveFooterScopedModelByOffset[\s\S]*\}\s*button\.addEventListener\("pointerdown", \(event\) => beginFooterScopedModelPointerDrag/,
  "flat and advanced options should share pointer reordering while retaining their mode-specific keyboard handlers",
);
assert.match(
  css,
  /body\.footer-model-picker-open \.workspace-column \{[\s\S]*z-index:\s*112;[\s\S]*body\.footer-model-picker-open \.workspace-column > \.chat-panel,[\s\S]*overflow:\s*visible;/,
  "an open picker should escape the chat-panel clip and stack its workspace above side panels",
);
assert.match(
  css,
  /\.footer-model-picker-advanced \{[\s\S]*width:\s*max-content;[\s\S]*max-width:\s*calc\(100vw - 1rem\);[\s\S]*\.footer-model-picker-advanced \.footer-model-picker-source \{[\s\S]*contain:\s*inline-size;[\s\S]*width:\s*100%;[\s\S]*max-width:\s*none;[\s\S]*\.footer-model-provider-columns \{[\s\S]*grid-auto-flow:\s*column;[\s\S]*grid-auto-columns:\s*13rem;[\s\S]*width:\s*fit-content;[\s\S]*max-width:\s*calc\(100vw - 2\.5rem\);[\s\S]*overflow:\s*auto;/,
  "desktop advanced layout should give help text the full picker width, grow by provider count, stop at the viewport, and scroll internally",
);
assert.match(
  css,
  /\.footer-model-picker-advanced \.footer-model-option\[data-footer-model-key\] \{[\s\S]*cursor:\s*grab;[\s\S]*touch-action:\s*none;[\s\S]*user-select:\s*none;/,
  "advanced models should expose draggable styling",
);
assert.match(
  css,
  /\.footer-model-provider-column:focus-within[\s\S]*\.footer-model-provider-title[\s\S]*\.footer-model-picker-advanced \.footer-model-option:focus-visible/,
  "provider headings, focused columns, and focused models should remain visible",
);
assert.match(
  css,
  /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*\.footer-model-picker-advanced \{[\s\S]*overflow:\s*hidden;[\s\S]*\.footer-model-provider-columns \{[\s\S]*grid-auto-flow:\s*row;[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*overflow-x:\s*hidden;/,
  "narrow advanced layout should stack providers and keep horizontal overflow inside the viewport",
);

console.log("git-footer-context-menu-static.test.mjs passed");
