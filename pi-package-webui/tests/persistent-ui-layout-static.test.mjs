import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

// --- Contract constants ----------------------------------------------------

assert.match(
  app,
  /const UI_LAYOUT_SCHEMA_VERSION = 3;[\s\S]*const UI_LAYOUT_ENDPOINT = "\/api\/interface-preferences";/,
  "the browser controller should target the accepted version-3 layout schema on the existing interface-preferences endpoint",
);
assert.match(
  app,
  /const UI_LAYOUT_FIELDS = \["sidePanel", "composerActions", "controlVisibility", "footerScopedModelOrder", "terminalTabs", "fileViewerWidth"\];/,
  "every approved arrangement surface should be a durable layout field",
);
assert.match(
  app,
  /const UI_LAYOUT_SIDE_PANEL_FIELDS = \["placement", "sectionLayout", "collapsedSectionIds", "hiddenSectionIds", "collapsedPanels", "panelWidths"\];/,
  "Control Deck durable layout should contain only order, visibility, and collapse state",
);
for (const [constant, value] of [
  ["UI_LAYOUT_ID_MAX_LENGTH", "256"],
  ["UI_LAYOUT_TITLE_MAX_LENGTH", "160"],
  ["UI_LAYOUT_LIST_MAX_ITEMS", "128"],
  ["UI_LAYOUT_GROUP_MAX_COUNT", "32"],
  ["UI_LAYOUT_GRID_MAX_COLUMNS", "24"],
  ["UI_LAYOUT_GRID_MAX_SLOTS", "4096"],
]) {
  assert.match(app, new RegExp(`const ${constant} = ${value};`), `${constant} should mirror the accepted server-side bound`);
}
assert.doesNotMatch(
  app,
  /UI_LAYOUT_FIELDS = \[[^\]]*(selectedModel|activeTab|queue|attachment|prompt)/i,
  "semantic file, queue, attachment, model, and prompt state must stay out of the durable layout schema",
);

// --- Local-first hydration and migration -----------------------------------

assert.match(
  app,
  /async function restoreSidePanelWidthPreference\(\)[\s\S]*readStoredSidePanelWidth\(\)[\s\S]*const layoutGenerations = new Map\(UI_LAYOUT_FIELDS\.map\(\(field\) => \[field, durableUiLayoutGeneration\(field\)\]\)\);[\s\S]*const readEpoch = \+\+durableLayoutReadEpoch;[\s\S]*await api\("\/api\/interface-preferences", \{ scoped: false \}\)[\s\S]*applyDurableUiLayoutSnapshot\(response\.data, \{ generations: layoutGenerations, readEpoch \}\)/,
  "the local cache should apply first and a single non-blocking unscoped GET should hydrate both the width preference and the durable layout",
);
assert.equal(
  (app.match(/api\("\/api\/interface-preferences", \{ scoped: false \}\)/g) || []).length
    + (app.match(/api\(UI_LAYOUT_ENDPOINT, \{ scoped: false \}\)/g) || []).length,
  2,
  "startup and reconciliation should share exactly one GET call site each instead of polling the settings endpoint",
);
assert.match(
  app,
  /function applyDurableUiLayoutSnapshot\(data, \{ generations = null, readEpoch = 0 \} = \{\}\)[\s\S]*readEpoch < durableLayoutAppliedReadEpoch[\s\S]*durableLayoutRevision = data\.layoutRevision/,
  "the snapshot handler should reject out-of-order reads before retaining the opaque server layout revision",
);
assert.match(
  app,
  /function applyDurableUiLayoutSnapshot[\s\S]*const generationChanged = durableUiLayoutGeneration\(field\) !== requestedGeneration;[\s\S]*const dirtySubfields = dirtyEntry\?\.subfields/,
  "a stale GET response should identify newer local generations and named dirty subfields",
);
assert.match(
  app,
  /function applyDurableUiLayoutSnapshot[\s\S]*const activelyManipulated[\s\S]*!isDirty && !activelyManipulated && !generationChanged[\s\S]*applicable\[subfield\] = remote[\s\S]*applyDurableUiLayoutField\(field, applicable\)/,
  "non-dirty sibling subfields should still adopt authoritative server values",
);
assert.match(
  app,
  /function applyDurableUiLayoutSnapshot[\s\S]*const remotePresent = durableUiLayoutSubfieldValuePresent\(field, subfield, remote\)[\s\S]*!isDirty && !remotePresent && durableUiLayoutValuePresent\(local\)[\s\S]*markDurableUiLayoutDirty\(field, subfield\)/,
  "missing server subfields should migrate only their valid local values",
);
assert.match(
  app,
  /function refreshDurableUiLayoutFromServer\(\)[\s\S]*const readEpoch = \+\+durableLayoutReadEpoch[\s\S]*applyDurableUiLayoutSnapshot\(response\.data, \{ generations, readEpoch \}\)/,
  "overlapping reconciliation reads should carry monotonic epochs",
);

// --- One coalescing writer, conflicts, and offline retention ---------------

assert.match(
  app,
  /function scheduleDurableUiLayoutSave\(delay = UI_LAYOUT_SAVE_DEBOUNCE_MS\)[\s\S]*clearTimeout\(durableLayoutSaveTimer\)[\s\S]*flushDurableUiLayoutSave\(\)/,
  "saves should be coalesced through one debounced timer so drag-over movement cannot create a request storm",
);
assert.match(
  app,
  /function markDurableUiLayoutDirty\(field, subfield = null\)[\s\S]*durableUiLayoutGeneration\(field\) \+ 1[\s\S]*writeDurableUiLayoutPendingMutation\(field, key, value\?\.\[key\] \?\? null\)[\s\S]*subfieldMutationIds\.set\(key, nextMutationId\)[\s\S]*subfieldGenerations\.set\(key, generation\)/,
  "each mutation should merge its named subfield into a reload-safe pending journal",
);
assert.match(
  app,
  /const UI_LAYOUT_PENDING_STORAGE_PREFIX = "pi-webui-ui-layout-pending-v4:";[\s\S]*const UI_LAYOUT_LEGACY_PENDING_STORAGE_PREFIX = "pi-webui-ui-layout-pending-v3:";[\s\S]*function durableUiLayoutPendingMutationRecords\(\)[\s\S]*UI_LAYOUT_LEGACY_PENDING_STORAGE_PREFIX[\s\S]*!\[3, 4\]\.includes\(value\.version\)[\s\S]*function restoreDurableUiLayoutPendingJournal\(\)[\s\S]*candidate\.value[\s\S]*subfieldMutationIds[\s\S]*scheduleDurableUiLayoutSave\(\)/,
  "per-writer pending layout values should survive reload without one tab replacing another tab's journal",
);
assert.match(
  app,
  /restoreDurableUiLayoutPendingJournal\(\);\s*\nrestoreSidePanelWidthPreference\(\);/,
  "the pending journal should restore before the startup server read",
);
assert.match(
  app,
  /async function flushDurableUiLayoutSave\(\)[\s\S]*if \(durableLayoutSaveInFlight \|\| !durableLayoutDirtyFields\.size\) return;/,
  "only one PUT may be in flight at a time",
);
assert.match(
  app,
  /async function flushDurableUiLayoutSave[\s\S]*durableLayoutDirtyFields\.keys\(\)[\s\S]*durableUiLayoutInteractionActive\(field\)[\s\S]*scheduleDurableUiLayoutSave\(\);\s*\n\s*return;/,
  "an active interaction should defer only writes for its affected layout surface",
);
assert.match(
  app,
  /function durableUiLayoutInteractionActive\(field = null\)[\s\S]*sidePanelSectionPointerDrag\?\.active[\s\S]*composerActionPointerDrag\?\.active[\s\S]*footerScopedModelPointerDrag\?\.active[\s\S]*terminalTabDragId[\s\S]*fileViewerResizeState/,
  "every durable reorder and resize interaction should be tracked per surface",
);
assert.match(
  app,
  /async function flushDurableUiLayoutSave[\s\S]*body: \{[\s\S]*layout: patch,[\s\S]*expectedLayoutRevision: durableLayoutRevision[\s\S]*\}/,
  "layout writes should submit the latest known opaque revision",
);
assert.match(
  app,
  /async function flushDurableUiLayoutSave[\s\S]*current\.subfieldGenerations\?\.get\(subfield\) !== entry\.subfieldGenerations\?\.get\(subfield\)[\s\S]*current\.subfieldMutationIds\?\.get\(subfield\) !== entry\.subfieldMutationIds\?\.get\(subfield\)[\s\S]*clearAcknowledgedDurableUiLayoutPendingMutations\(snapshot\)/,
  "acknowledgement should clear matching nested generations independently across every writer journal",
);
assert.match(
  app,
  /const UI_LAYOUT_MAX_CONFLICT_RETRIES = 1;[\s\S]*if \(status === 409\)[\s\S]*durableLayoutConflictAttempts \+= 1;[\s\S]*await refreshDurableUiLayoutFromServer\(\);[\s\S]*durableLayoutConflictAttempts <= UI_LAYOUT_MAX_CONFLICT_RETRIES[\s\S]*else warnDurableUiLayoutOnce/,
  "a 409 should refresh once, retry within a bounded budget, and then report exactly one warning",
);
assert.match(
  app,
  /function warnDurableUiLayoutOnce\(message\)[\s\S]*if \(durableLayoutWarned\) return;[\s\S]*durableLayoutWarned = true;[\s\S]*addEvent\(message, "warn"\)/,
  "conflict and rejection reporting should stay bounded to one warning",
);
assert.match(
  app,
  /async function flushDurableUiLayoutSave[\s\S]*navigator\.onLine === false\) return;/,
  "offline browsers should keep the dirty layout instead of issuing doomed writes",
);
assert.match(
  app,
  /function reconcileDurableUiLayout\(\)[\s\S]*refreshDurableUiLayoutFromServer\(\)\.then\(\(ready\) => \{[\s\S]*durableLayoutDirtyFields\.size\) scheduleDurableUiLayoutSave\(0\)/,
  "foreground reconciliation should retry retained dirty state",
);
assert.match(
  app,
  /window\.addEventListener\("online", \(\) => reconcileDurableUiLayout\(\)\);\s*\nwindow\.addEventListener\("pageshow", \(\) => reconcileDurableUiLayout\(\)\);\s*\ndocument\.addEventListener\("visibilitychange", \(\) => \{\s*\n\s*if \(document\.visibilityState === "visible"\) reconcileDurableUiLayout\(\);/,
  "durable layout reconciliation should use dedicated online, pageshow, and foreground listeners",
);
// The pre-existing session/transcript reconciliation contracts must stay intact.
assert.match(
  app,
  /window\.addEventListener\("pageshow", \(\) => scheduleForegroundReconcile\("page show", 0\)\);/,
  "existing foreground snapshot reconciliation must remain unchanged",
);
assert.match(
  app,
  /window\.addEventListener\("online", \(\) => scheduleForegroundReconcile\("network online", 0\)\);/,
  "existing online snapshot reconciliation must remain unchanged",
);

// --- Every approved arrangement surface is durable -------------------------

for (const [persistFunction, field, subfield] of [
  ["persistSidePanelSectionOrder", "sidePanel", "sectionLayout"],
  ["persistSidePanelSectionState", "sidePanel", "collapsedSectionIds"],
  ["persistSidePanelSectionVisibility", "sidePanel", "hiddenSectionIds"],
  ["persistComposerActionOrder", "composerActions", null],
  ["persistComposerActionSlotLayout", "composerActions", null],
  ["persistTerminalTabsLayout", "terminalTabs", "layout"],
  ["persistTerminalCustomGroups", "terminalTabs", "customGroups"],
  ["persistFileViewerWidth", "fileViewerWidth", null],
  ["writeFooterScopedModelOrder", "footerScopedModelOrder", null],
]) {
  const marker = subfield
    ? `markDurableUiLayoutDirty\\("${field}", "${subfield}"\\)`
    : `markDurableUiLayoutDirty\\("${field}"\\)`;
  assert.match(
    app,
    new RegExp(`(?:function ${persistFunction}\\([^)]*\\)|function persistControlDeckSectionLayout\\([^)]*\\)) \\{[\\s\\S]*?${marker};\\s*\\n\\}`),
    `${persistFunction} should mark only its owned durable layout value after writing the local cache`,
  );
}
assert.match(
  app,
  /localStorage\.setItem\(SIDE_PANEL_STORAGE_KEY, collapsed \? "1" : "0"\);[\s\S]{0,300}markDurableUiLayoutDirty\("sidePanel", "collapsedPanels"\)/,
  "Control Deck collapse state should be durable without dirtying sibling settings",
);
assert.match(
  app,
  /function restoreSidePanelState\(\)[\s\S]*persist: false[\s\S]*side:/,
  "passive Control Deck restoration must not echo stale cache back to the server",
);
assert.doesNotMatch(
  app,
  /initializeSidePanelSectionResizing|persistSidePanelSectionHeight|beginSidePanelSectionResize|sidePanelSectionResizeState|data-side-panel-section-resize/,
  "Control Deck section-height adjustment and persistence should be absent",
);

// --- Composer order and grid stay one atomic logical update ----------------

assert.match(
  app,
  /function collectDurableComposerActionsLayout\(\)[\s\S]*return \{ order: durableLayoutStoredIdList\(COMPOSER_ACTION_ORDER_STORAGE_KEY\), grid \};/,
  "composer order and sparse grid must be submitted together as one field",
);
assert.match(
  app,
  /function collectDurableComposerActionsLayout\(\)[\s\S]*grid = \{ version: 2, columns: stored\.columns, positions \};/,
  "the persisted grid should use the accepted version-2 sparse envelope",
);
assert.match(
  app,
  /function applyDurableComposerActionsLayout\(value\)[\s\S]*writeDurableLayoutCache\(COMPOSER_ACTION_LAYOUT_STORAGE_KEY, JSON\.stringify\(value\.grid\)\);\s*\n\s*restoreComposerActionSlotLayout\(\)/,
  "server grid slots should be cached locally and restored through the existing responsive restore pass",
);
assert.match(
  app,
  /function restoreComposerActionSlotLayout\(\)[\s\S]*stored\.columns === columns[\s\S]*projectComposerActionSlots[\s\S]*nearestAvailableComposerActionSlot/,
  "stored slots should project into mismatched column counts without rewriting the saved source geometry",
);

// --- Cross-tab cache adoption without duplicate server writes --------------

assert.match(
  app,
  /window\.addEventListener\("storage"[\s\S]*event\.key === TERMINAL_CUSTOM_GROUPS_STORAGE_KEY[\s\S]*restoreTerminalCustomGroups\(\);[\s\S]*syncTerminalCustomGroupsWithTabs\(tabs, \{ persist: false \}\)/,
  "another tab's terminal groups should be adopted through the existing tab-filtering restore without re-persisting",
);
assert.match(
  app,
  /window\.addEventListener\("storage"[\s\S]*event\.key === FOOTER_SCOPED_MODEL_ORDER_STORAGE_KEY[\s\S]*footerScopedModels = orderedFooterScopedModels\(\)/,
  "another tab's footer order should be adopted locally",
);
assert.match(
  app,
  /window\.addEventListener\("storage"[\s\S]*event\.key === FILE_VIEWER_WIDTH_STORAGE_KEY\) restoreFileViewerWidthPreference\(\)/,
  "another tab's file-viewer width should be adopted locally",
);
for (const applyFunction of [
  "applyDurableSidePanelLayout",
  "applyDurableComposerActionsLayout",
  "applyDurableFooterScopedModelOrder",
  "applyDurableTerminalTabsLayout",
  "applyDurableFileViewerWidth",
]) {
  const body = new RegExp(`function ${applyFunction}\\(value\\) \\{[\\s\\S]*?\\n\\}`).exec(app)?.[0] || "";
  assert.ok(body, `${applyFunction} should exist`);
  assert.doesNotMatch(body, /markDurableUiLayoutDirty/, `${applyFunction} must not echo server state back as a new write`);
}

// --- Terminal groups keep the existing valid-tab filtering ------------------

assert.match(
  app,
  /function applyDurableTerminalTabsLayout\(value\)[\s\S]*setTerminalTabsLayout\(value\.layout, \{ persist: false \}\)/,
  "an applied terminal layout should not re-persist",
);
assert.match(
  app,
  /function collectDurableTerminalTabsLayout\(\)[\s\S]*if \(!title \|\| tabIds\.length < 2\) continue;/,
  "durable groups should honor the existing minimum-membership rule and bounded titles",
);

// --- Coherent browser asset revisions --------------------------------------

assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "changed browser assets should advance the PWA cache identity");
assert.match(html, /styles\.css\?v=154/, "the page should request the updated layout stylesheet revision");
assert.match(html, /data-app-src="\/app\.js\?v=184"/, "the boot loader should request the updated app module revision");

console.log("persistent-ui-layout-static.test.mjs passed");
