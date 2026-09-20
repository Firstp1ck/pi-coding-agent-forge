import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, css, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

assert.match(html, /id="newSessionButton"[^>]*data-composer-action-id="new"[^>]*data-composer-action-span="1"/, "New should occupy one composer grid cell");
for (const [id, label] of [
  ["compact", "Compact"],
  ["app-runner", "App runner"],
  ["steer", "Steer"],
  ["follow-up", "Follow-up"],
  ["abort", "Abort"],
  ["send", "Send"],
]) {
  assert.match(html, new RegExp(`data-composer-action-id="${id}"[^>]*data-composer-action-span="2"`), `${label} should occupy two composer grid cells`);
}
for (const id of ["git", "publish", "native-command", "options", "btw"]) {
  assert.match(html, new RegExp(`data-composer-action-id="${id}"[^>]*data-composer-action-span="1"`), `${id} should occupy one composer grid cell`);
}
assert.match(html, /id="composerActionGridGuide"[^>]*class="composer-action-grid-guide"[^>]*aria-hidden="true"[^>]*hidden/, "the composer should provide a decorative drag-only grid guide");
assert.match(html, /id="composerActionOrderStatus"[^>]*role="status"[^>]*aria-live="polite"/, "reordering should have a polite live-region announcement");

assert.match(
  css,
  /body\.composer-action-grid-enabled \.composer-row\s*\{[\s\S]*--composer-action-cell-min-width:\s*3\.2rem[\s\S]*display:\s*grid[\s\S]*grid-template-columns:\s*repeat\(auto-fill, var\(--composer-action-cell-min-width\)\)[\s\S]*grid-auto-flow:\s*dense/,
  "the desktop composer should use fixed-width dense grid cells",
);
assert.match(css, /grid-column:\s*var\(--composer-action-grid-column, auto\) \/ span var\(--composer-action-grid-span\)/, "actions should support explicit sparse grid columns");
assert.match(css, /\[data-composer-action-span="2"\]\s*\{\s*--composer-action-grid-span:\s*2;/, "wide actions should span exactly two cells");
assert.match(css, /body\.composer-action-grid-enabled \.composer-row \[data-composer-action-id\]\.composer-publish-menu:hover,[\s\S]*\.composer-publish-menu:focus-within,[\s\S]*\.composer-publish-menu\.open \{\s*z-index:\s*100;/, "open composer dropdowns should stack above prompt tags and neighboring grid controls");
assert.match(css, /#newSessionButton\s*\{[\s\S]*display:\s*grid[\s\S]*place-items:\s*center[\s\S]*padding-inline:\s*0\.4rem[\s\S]*text-align:\s*center/, "New should center its label inside the one-cell button");
assert.match(css, /composer-action-drag-active[\s\S]*composer-action-grid-guide:not\(\[hidden\]\)[\s\S]*position:\s*absolute[\s\S]*inset:\s*0[\s\S]*grid-template-columns:\s*repeat\(auto-fill, var\(--composer-action-cell-min-width\)\)[\s\S]*gap:\s*0\.5rem/, "the drag-only guide should cover the complete composer row with the same responsive tracks");
assert.match(css, /\.composer-action-grid-cell\s*\{[\s\S]*min-width:\s*0[\s\S]*border:[\s\S]*background:/, "empty guide cells should render as full grid cells");
assert.match(css, /composer-action-dragging[\s\S]*cursor:\s*grabbing[\s\S]*composer-action-drag-before[\s\S]*composer-action-drag-after/, "dragging and occupied drop targets should have visible affordances");
assert.match(css, /composer-action-grid-cell-target[\s\S]*border-color:\s*var\(--ctp-teal\)/, "empty-cell drop targets should have a visible affordance");

assert.match(app, /const COMPOSER_ACTION_ORDER_STORAGE_KEY = "pi-webui-composer-action-order-v1";[\s\S]*const COMPOSER_ACTION_LAYOUT_STORAGE_KEY = "pi-webui-composer-action-layout-v2";[\s\S]*const COMPOSER_ACTION_POINTER_DRAG_THRESHOLD_PX = 6;/, "composer order and sparse layout should use versioned storage with a bounded drag threshold");
assert.match(app, /function readStoredComposerActionOrder\(\)[\s\S]*localStorage\.getItem\(COMPOSER_ACTION_ORDER_STORAGE_KEY\)[\s\S]*new Set[\s\S]*function persistComposerActionOrder\(\)[\s\S]*localStorage\.setItem\(COMPOSER_ACTION_ORDER_STORAGE_KEY/, "stored order should be validated, deduplicated, and persisted");
assert.match(app, /function applyComposerActionOrder\(orderIds\)[\s\S]*knownIds[\s\S]*completeOrder[\s\S]*--composer-action-order/, "new actions should append safely when restoring an older order");
assert.match(app, /function showComposerActionGridGuide\(\)[\s\S]*composerActionGridColumnCount\(\)[\s\S]*top - groups\.at\(-1\) > 4[\s\S]*columnCount \* rowCount[\s\S]*composer-action-drag-active[\s\S]*function hideComposerActionGridGuide/, "dragging should materialize every full-row guide cell without splitting near-equal action tops into false rows");
assert.match(app, /function composerActionGridColumnCount\(\)[\s\S]*--composer-action-cell-min-width[\s\S]*row\.clientWidth[\s\S]*Math\.floor\(\(availableWidth \+ gap\) \/ \(minWidth \+ gap\)\)/, "column counts should derive from the visible row width instead of overflow-created implicit tracks");
assert.match(app, /function readStoredComposerActionLayout\(\)[\s\S]*COMPOSER_ACTION_LAYOUT_STORAGE_KEY[\s\S]*function composerActionSlotCanFit[\s\S]*function persistComposerActionSlotLayout[\s\S]*positions:\s*Object\.fromEntries/, "sparse cell positions should be validated and persisted independently from order");
assert.match(app, /function projectComposerActionSlots\(entries, sourceColumns, targetColumns\)[\s\S]*continuesChunk[\s\S]*targetColumns - chunkWidth[\s\S]*lastTargetRow[\s\S]*projected\.set[\s\S]*function nearestAvailableComposerActionSlot[\s\S]*function restoreComposerActionSlotLayout\(\)[\s\S]*projectComposerActionSlots/, "saved sparse positions should project contiguous action groups without changing their visual order");
assert.doesNotMatch(app, /relativeColumn|remapComposerActionSlot/, "composer width changes must not proportionally or independently remap saved action columns");
assert.doesNotMatch(app, /if \(!stored \|\| stored\.columns !== columns\)/, "column-count changes should not discard saved sparse positions");
assert.match(app, /function captureComposerActionSlotLayout\(\)[\s\S]*composerActionGridGuide[\s\S]*function moveComposerActionToGridCell\(actionId, cell\)[\s\S]*composerActionSlotCanFit[\s\S]*composer-action-grid-cell-target/, "empty grid cells should capture and retain exact action slots");
assert.match(app, /function composerActionRootFromPoint\(clientX, clientY\)[\s\S]*elementFromPoint[\s\S]*function updateComposerActionPointerDrag\(event\)[\s\S]*Math\.hypot[\s\S]*COMPOSER_ACTION_POINTER_DRAG_THRESHOLD_PX[\s\S]*showComposerActionGridGuide\(\)[\s\S]*captureComposerActionSlotLayout\(\)[\s\S]*composerActionGridCellFromPoint[\s\S]*moveComposerActionToGridCell/, "pointer dragging should activate after the threshold and distinguish occupied from empty grid cells");
assert.match(app, /function initializeComposerActionOrdering\(\)[\s\S]*MutationObserver[\s\S]*ResizeObserver[\s\S]*observedRowWidth[\s\S]*scheduleComposerActionSlotLayoutRestore[\s\S]*aria-keyshortcuts[\s\S]*ArrowLeft[\s\S]*ArrowRight[\s\S]*moveComposerActionByOffset[\s\S]*pointerdown/, "keyboard and pointer reordering should stay synchronized with dynamic action visibility and composer width");
assert.match(app, /event\.key === COMPOSER_ACTION_ORDER_STORAGE_KEY\) restoreComposerActionOrder\(\)[\s\S]*event\.key === COMPOSER_ACTION_LAYOUT_STORAGE_KEY\) restoreComposerActionSlotLayout\(\)/, "other tabs should apply persisted composer order and sparse-layout changes");
assert.match(app, /initializeComposerActionOrdering\(\);[\s\S]*restoreSidePanelSectionOrder\(\);/, "composer ordering should initialize during guarded app startup");

assert.match(html, /styles\.css\?v=154/, "changed composer styles should advance the stylesheet revision");
assert.match(html, /app\.js\?v=184/, "changed composer behavior should advance the app revision");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "changed browser assets should advance the PWA cache identity");

console.log("composer-action-grid-reorder-static.test.mjs passed");
