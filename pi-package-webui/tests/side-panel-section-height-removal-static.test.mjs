import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, layout, html, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "lib", "ui-layout-settings.mjs"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

for (const removedToken of [
  "data-side-panel-section-resize",
  "initializeSidePanelSectionResizing",
  "persistSidePanelSectionHeight",
  "beginSidePanelSectionResize",
  "side-panel-section-resize-handle",
  "side-panel-section-resizing",
]) {
  assert.doesNotMatch(app, new RegExp(removedToken), `${removedToken} should be absent from the browser controller`);
  assert.doesNotMatch(css, new RegExp(removedToken), `${removedToken} should be absent from side-panel styles`);
}
assert.doesNotMatch(layout, /sectionHeightMin|sectionHeightMax|validateSectionHeights|sectionHeights/, "the durable layout schema should not expose section heights");
assert.match(app, /const UI_LAYOUT_SIDE_PANEL_FIELDS = \["placement", "sectionLayout", "collapsedSectionIds", "hiddenSectionIds", "collapsedPanels", "panelWidths"\];/, "the browser durable layout field list should omit section heights");
assert.match(app, /function clearRemovedSidePanelSectionHeightState\(\)[\s\S]*localStorage\.removeItem\(REMOVED_SIDE_PANEL_SECTION_HEIGHT_STORAGE_KEY\)[\s\S]*record\.field === "sidePanel" && record\.subfield === "sectionHeights"/, "startup should remove the retired cache and pending mutations");
assert.match(app, /clearRemovedSidePanelSectionHeightState\(\);\s*restoreDurableUiLayoutPendingJournal\(\);/, "retired height state should be cleared before pending layout restoration");
assert.match(html, /styles\.css\?v=154/, "removing section resize styles should advance the stylesheet revision");
assert.match(html, /app\.js\?v=184/, "removing section resize behavior should advance the app revision");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "removing browser assets should advance the PWA cache identity");

console.log("side-panel-section-height-removal-static.test.mjs passed");
