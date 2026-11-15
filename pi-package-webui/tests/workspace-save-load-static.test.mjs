import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const [html, app, css] = await Promise.all([
  read("public/index.html"),
  read("public/app.js"),
  read("public/styles.css"),
]);

const actionStart = html.indexOf('<div class="terminal-sidebar-actions"');
const actionEnd = html.indexOf("</div>", actionStart);
const saveButton = html.indexOf('id="workspaceSaveButton"', actionStart);
assert.ok(actionStart >= 0 && saveButton > actionStart && saveButton < actionEnd, "Save workspace must be a header action");
assert.match(html, /workspaceSaveButton[\s\S]*?aria-label="Save workspace"/, "Save workspace must be labelled");
const saveTooltip = app.match(/applyStyledTooltip\(elements\.workspaceSaveButton,[\s\S]*?\);/)?.[0];
assert.ok(saveTooltip, "Save workspace must use the shared styled tooltip owner");
assert.doesNotMatch(saveTooltip, /floating: false/, "Save workspace must escape clipped sidebar ancestors");
assert.match(css, /\[data-tooltip-floating="true"\]::after[^}]*display: none !important/, "Shared tooltips must suppress duplicate pseudo tooltips");

assert.match(app, /function saveWebuiWorkspace[\s\S]*?api\("\/api\/workspaces", \{ method: "POST", body, scoped: false \}\)/, "Save must use an unscoped workspace API call");
assert.match(app, /function refreshSavedWorkspaces[\s\S]*?api\("\/api\/workspaces", \{ scoped: false \}\)/, "Workspace list must use an unscoped API call");
assert.match(app, /function deleteWebuiWorkspace[\s\S]*?method: "DELETE", scoped: false/, "Delete must use an unscoped API call");
assert.match(app, /function saveWebuiWorkspace[\s\S]*?appConfirm\(\{[\s\S]*?confirmLabel: "Overwrite"/, "Duplicate saves must use the existing confirmation modal");

const loadStart = app.indexOf("async function loadWebuiWorkspace");
const loadEnd = app.indexOf("async function deleteWebuiWorkspace", loadStart);
const loadFlow = app.slice(loadStart, loadEnd);
assert.ok(loadStart >= 0 && loadEnd > loadStart, "Load flow must be defined before delete flow");
assert.match(loadFlow, /\/api\/workspaces\/\$\{encodeURIComponent\(workspaceId\)\}\/load/, "Load must call the workspace load endpoint");
assert.match(loadFlow, /scoped: false/, "Load must be unscoped");
assert.ok(loadFlow.indexOf("await refreshTabs();") < loadFlow.indexOf("installLoadedWorkspaceGroups"), "Tabs must refresh before restored groups are installed");
assert.match(loadFlow, /await hydrateLoadedWorkspaceActiveTab\(data\.activeTabId\)/, "Load must hydrate the restored active tab even when refreshTabs selected it already");
assert.match(loadFlow, /settleUndoToast\(/, "Load must show a bounded restore summary");
assert.match(loadFlow, /addEvent\(/, "Load must record restore warnings/events");

assert.match(app, /function hydrateLoadedWorkspaceActiveTab[\s\S]*?connectEvents\(tabContext\);[\s\S]*?await refreshAll\(tabContext\)/, "A restored tab already selected by refreshTabs must still connect events and hydrate session state");
assert.match(app, /function installLoadedWorkspaceGroups[\s\S]*?terminalCustomGroups = new Map\(\);[\s\S]*?nextTerminalCustomGroupId\(\)[\s\S]*?persistTerminalCustomGroups\(\)/, "Restored groups must replace stale groups, use local ids, and persist");
assert.match(app, /const TERMINAL_CUSTOM_GROUPS_STORAGE_KEY = "pi-webui-terminal-custom-groups-v1"/, "The existing custom-group storage key must remain unchanged");
assert.match(app, /const savedWorkspacePanel = !tabs\.length \? renderSavedWorkspacePicker\(\) : null/, "The saved-workspace picker must be dashboard-only at zero tabs");
assert.match(app, /label: "Workspace: Save"/, "The command palette must offer workspace save when tabs exist");
assert.match(app, /label: "Workspace: Load…"/, "The command palette must offer workspace load when no tabs exist");
assert.match(app, /function closeAllTerminalTabs[\s\S]*?allowEmpty: true/, "Close all must permit the planned zero-tab workspace-load state");
assert.match(app, /function closeTerminalTabs[\s\S]*?if \(!tabs\.length\) setWorkspaceDashboardCollapsed\(false, \{ persist: false \}\)/, "Closing all tabs must reveal the workspace picker dashboard");
assert.match(app, /async function initializeTabs\(\)[\s\S]*?if \(!loadedTabs\.length\)[\s\S]*?refreshSavedWorkspaces\(\)/, "Empty startup must retain saved workspace discovery without requiring a folder choice");

const emptyStart = app.slice(app.indexOf("function renderEmptyStartState"), app.indexOf("function userPromptTargets"));
assert.match(emptyStart, /title: "Load workspace"[\s\S]*?description: "Restore a saved thread constellation"[\s\S]*?openWorkspaceLoadPicker/, "The empty-start card must offer a labelled saved-workspace picker action");
assert.match(html, /id="workspaceLoadDialog"[\s\S]*?aria-labelledby="workspaceLoadDialogTitle"/, "The saved-workspace picker must use a labelled dialog");
assert.match(html, /id="workspaceReplaceDialog"[\s\S]*?workspaceReplaceCurrentTabsList[\s\S]*?workspaceReplaceSaveName[\s\S]*?Load without saving[\s\S]*?Save &amp; load/, "The replacement dialog must expose current tabs, a save name, and explicit discard/save choices");
assert.match(app, /function renderWorkspaceLoadDialog[\s\S]*?Loading saved workspaces…[\s\S]*?workspace-load-dialog-retry[\s\S]*?No saved workspaces yet[\s\S]*?loadWebuiWorkspace[\s\S]*?workspace-load-dialog-item-delete danger[\s\S]*?deleteWebuiWorkspace[\s\S]*?workspaceLoadDialogCloseButton\?\.focus/, "The dialog picker must render loading, retry/error, empty, load, and destructive delete states while preserving focus after deletion");
assert.match(app, /const result = await loadWebuiWorkspace[\s\S]*?result === "cancelled"[\s\S]*?openWorkspaceLoadPicker[\s\S]*?result === "error"[\s\S]*?focusReturn\.focus/, "Cancelled and failed picker loads must restore a usable keyboard destination");
assert.match(app, /function workspaceReplacementTabRow[\s\S]*?tabIndicator\(tab\)[\s\S]*?tab\.id === activeTabId[\s\S]*?normalizeDisplayPath\(tab\.cwd/, "The replacement dialog must identify each current tab's activity, active state, and cwd");
assert.match(app, /function workspaceSaveCurrentDecision[\s\S]*?replaceOpenTabs: true[\s\S]*?groups: workspaceGroupsForSave\(\)[\s\S]*?activeTabId/, "Save-and-load must send only UI-owned group and active-tab metadata");
assert.match(app, /workspaceReplaceDiscardButton[\s\S]*?replaceOpenTabs: true, discardCurrent: true/, "Discard-and-load must require its own explicit dialog action");
assert.match(loadFlow, /const decision = await chooseWorkspaceReplacement[\s\S]*?Object\.keys\(decision\)\.length[\s\S]*?body: decision/, "Open-tab loading must send the WS1 decision body while zero-tab loading keeps an empty body");
assert.match(loadFlow, /workspace with that name already exists[\s\S]*?confirmLabel: "Overwrite & load"[\s\S]*?overwrite: true/, "Duplicate save-and-load names must confirm overwrite before retrying");
assert.match(loadFlow, /data\.closedIds[\s\S]*?retireClosedWorkspaceTabContexts\(closedIds\)[\s\S]*?data\.savedCurrent\?\.workspaces/, "The client must reconcile closed tabs and optional saved-current workspace metadata");
assert.match(app, /function retireClosedWorkspaceTabContexts[\s\S]*?clearAttachments[\s\S]*?composerStore\.clearTab[\s\S]*?projectFiles\.forgetTab[\s\S]*?removeSubagentTerminalViewsForParent/, "Workspace replacement must retire per-tab client state along with closed tabs");

assert.match(css, /body\.terminal-tabs-left \.terminal-sidebar-actions \{[\s\S]*?grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/, "The left tab layout must provide four action slots");
assert.match(css, /\.workspace-saved-workspaces/, "Saved-workspace picker styles must be scoped");
assert.match(css, /\.workspace-load-dialog,[\s\S]*?\.workspace-replace-dialog/, "Workspace loading and replacement dialogs must have scoped styles");
assert.match(css, /\.workspace-replace-current-tabs-list[\s\S]*?max-height:[\s\S]*?overflow: auto/, "The replacement tab disclosure must remain bounded and scrollable");
assert.match(css, /\.workspace-load-dialog-item-actions button \{ flex: 1 1 7rem; min-height: 44px; \}/, "Picker load and delete actions must remain touch-friendly on narrow layouts");
assert.match(css, /\.workspace-replace-dialog menu button \{ flex: 1 1 9rem; min-height: 44px; \}/, "Replacement decisions must remain touch-friendly on narrow layouts");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.workspace-saved-workspace-actions button \{ flex: 1 1 7rem; min-height: 44px; \}/, "Saved-workspace actions must stay touch-friendly on narrow layouts");

console.log("workspace-save-load-static.test.mjs passed");
