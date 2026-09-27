import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LIMITS, PROTOCOL_VERSION, REQUEST_TYPES } from "../lib/backend/protocol.mjs";
import { SEMANTIC_PALETTE_ROLES } from "../lib/backend/themes.mjs";
import { qmlFunctions } from "./helpers/qml-functions.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const qmlRoot = path.join(root, "qml");

async function readQml(relative) {
  return readFile(path.join(qmlRoot, relative), "utf8");
}

const [shell, bridge, theme, smoke, composer, row, blocks, toolCard, searchBar, emptyState, appButton, statusBadge, noticeBar, appDialog, extensionDialog, linkDialog, selectableText, fixture] = await Promise.all([
  readQml("shell.qml"),
  readQml("BackendBridge.qml"),
  readQml("Theme.qml"),
  readQml("SmokeDriver.qml"),
  readQml(path.join("components", "Composer.qml")),
  readQml(path.join("components", "TranscriptRow.qml")),
  readQml(path.join("components", "MarkdownBlocks.qml")),
  readQml(path.join("components", "ToolCard.qml")),
  readQml(path.join("components", "SearchBar.qml")),
  readQml(path.join("components", "EmptyState.qml")),
  readQml(path.join("components", "AppButton.qml")),
  readQml(path.join("components", "StatusBadge.qml")),
  readQml(path.join("components", "NoticeBar.qml")),
  readQml(path.join("dialogs", "AppDialog.qml")),
  readQml(path.join("dialogs", "ExtensionDialog.qml")),
  readQml(path.join("dialogs", "LinkDialog.qml")),
  readQml(path.join("components", "SelectableText.qml")),
  readFile(path.join(root, "tests", "fixtures", "fake-pi-rpc.mjs"), "utf8"),
]);

const [workingIndicator, statusSegment, statusOverlay, dropUpPicker, pickerDialog, completionPopup, sequencesDialog, textEditDialog, tabStrip, sessionList, confirmDialog, inputDialog, worktreeDialog, directoryDialog] = await Promise.all([
  readQml(path.join("components", "WorkingIndicator.qml")), readQml(path.join("components", "StatusSegment.qml")), readQml(path.join("components", "StatusOverlay.qml")), readQml(path.join("components", "DropUpPicker.qml")), readQml(path.join("dialogs", "PickerDialog.qml")),
  readQml(path.join("components", "CompletionPopup.qml")), readQml(path.join("dialogs", "SequencesDialog.qml")), readQml(path.join("dialogs", "TextEditDialog.qml")),
  readQml(path.join("components", "TabStrip.qml")), readQml(path.join("components", "SessionList.qml")), readQml(path.join("dialogs", "ConfirmDialog.qml")), readQml(path.join("dialogs", "InputDialog.qml")), readQml(path.join("dialogs", "WorktreeDialog.qml")), readQml(path.join("dialogs", "DirectoryDialog.qml")),
]);
const [eventsDialog, diagnosticsDialog, resourceProfilesDialog] = await Promise.all([
  readQml(path.join("dialogs", "EventsDialog.qml")),
  readQml(path.join("dialogs", "DiagnosticsDialog.qml")),
  readQml(path.join("dialogs", "ResourceProfilesDialog.qml")),
]);
const components = { shell, composer, row, blocks, toolCard, searchBar, emptyState, appButton, statusBadge, noticeBar, appDialog, extensionDialog, linkDialog, selectableText, workingIndicator, statusSegment, statusOverlay, dropUpPicker, pickerDialog, completionPopup, sequencesDialog, textEditDialog, tabStrip, sessionList, confirmDialog, inputDialog, worktreeDialog, directoryDialog, eventsDialog, diagnosticsDialog, resourceProfilesDialog };

function balancedBody(source, open, description) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`${description} should have a balanced body`);
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  return balancedBody(source, source.indexOf("{", start), name);
}

function objectBodyContaining(source, objectType, needle) {
  for (const match of source.matchAll(new RegExp(`\\b${objectType}\\s*\\{`, "g"))) {
    const body = balancedBody(source, source.indexOf("{", match.index), `${objectType} containing ${needle}`);
    if (body.includes(needle)) return body;
  }
  assert.fail(`${objectType} containing ${needle} should exist`);
}

function objectBodyWithId(source, objectType, id) {
  const idIndex = source.indexOf(`id: ${id}`);
  assert.notEqual(idIndex, -1, `${objectType} id ${id} should exist`);
  let start = -1;
  for (const match of source.matchAll(new RegExp(`\\b${objectType}\\s*\\{`, "g"))) {
    if (match.index > idIndex) break;
    start = match.index;
  }
  assert.notEqual(start, -1, `${objectType} id ${id} should have an opening body`);
  return balancedBody(source, source.indexOf("{", start), `${objectType} id ${id}`);
}

test("shell composes one window from the shared bridge, theme, transcript, composer, search, and dialogs", () => {
  assert.equal((shell.match(/\bFloatingWindow\s*\{/g) ?? []).length, 1);
  assert.match(shell, /title:\s*bridge\.windowTitle/);
  assert.match(shell, /surfaceFormat\.opaque:\s*true/);
  assert.match(shell, /parent:\s*window\.contentItem/);
  assert.match(shell, /text:\s*bridge\.displayCwd\n/);
  assert.match(bridge, /readonly property string displayCwd/);
  assert.match(shell, /text:\s*bridge\.currentProvider \+ "\/" \+ bridge\.currentModelId/);
  assert.match(shell, /text:\s*"thinking " \+ bridge\.currentThinkingLevel/);
  assert.match(shell, /text:\s*bridge\.compacting \? "Compacting…" : "Compact context"/);
  assert.match(shell, /StatusBadge\s*\{[\s\S]*kind:\s*root\.hasActiveSession \? bridge\.statusKind : "stopped"[\s\S]*text:\s*root\.hasActiveSession \? bridge\.statusText : "No session"/);
  for (const component of ["BackendBridge", "Theme", "Composer", "SearchBar", "EmptyState", "NoticeBar", "TranscriptRow", "ExtensionDialog", "LinkDialog", "PickerDialog", "ResourceProfilesDialog"]) {
    assert.match(shell, new RegExp(`\\b${component}\\s*\\{`), `shell should use ${component}`);
  }
  for (const sequence of ["Ctrl+F", "Ctrl+T", "Ctrl+Shift+X", "Ctrl+L", "Ctrl+M", "Ctrl+Shift+P", "Ctrl+E", "Ctrl+Shift+E", "Ctrl+Shift+R", "Ctrl+Shift+S", "Ctrl+Shift+A", "Ctrl+N", "Ctrl+O", "Ctrl+W", "Ctrl+Tab", "Ctrl+Shift+Tab", "Ctrl+Shift+O", "Ctrl+Shift+N", "Ctrl+Shift+B", "F2", "Ctrl+K", "Ctrl+Shift+L", "Ctrl+Shift+D"]) {
    assert.match(shell, new RegExp(`sequence:\\s*"${sequence.replace(/\+/g, "\\+")}"`), `shortcut ${sequence}`);
  }
  assert.match(shell, /onLinkActivated:\s*link\s*=>\s*root\.confirmLink\(link\)/);
  assert.match(shell, /onCopyRequested:\s*text\s*=>\s*bridge\.copyToClipboard\(text\)/);
  assert.match(shell, /followOutput/);
  assert.match(shell, /positionViewAtIndex\(searchCurrentRow, ListView\.Center\)/);
  assert.match(shell, /Loader\s*\{[\s\S]*active:\s*root\.smokeMode[\s\S]*SmokeDriver/);
  assert.match(shell, /footer:\s*WorkingIndicator\s*\{[\s\S]*running:\s*bridge\.active/);
  assert.match(shell, /StatusOverlay\s*\{[\s\S]*groups:\s*root\.statusGroups/);
  assert.match(functionBody(shell, "groupStatusChips"), /chip\.group === "meta"/);
  assert.match(shell, /text:\s*bridge\.restarting \? "Restarting…"/);
});

test("transcript exposes an accessible Latest control while follow mode is paused", () => {
  const transcript = objectBodyWithId(shell, "ListView", "transcriptList");
  const latest = objectBodyWithId(shell, "AppButton", "latestButton");
  assert.match(transcript, /property bool followOutput:\s*true/);
  assert.match(functionBody(transcript, "jumpToLatest"), /followOutput = true[\s\S]*followToEnd\(\)/, "Latest resumes follow mode before moving to the end");
  assert.match(latest, /visible:\s*root\.hasActiveSession && transcriptList\.count > 0 && !transcriptList\.followOutput/, "Latest appears only for a paused non-empty active transcript");
  assert.match(latest, /text:\s*"Latest ↓"/);
  assert.match(latest, /accessibleName:\s*"Go to latest output"/);
  assert.match(latest, /onClicked:\s*transcriptList\.jumpToLatest\(\)/);
});

test("workspace shell keeps the approved rail, centered conversation, and small-window structure", () => {
  const rail = objectBodyContaining(shell, "Rectangle", "id: workspaceRail");
  const resizeHandle = objectBodyContaining(rail, "Item", "id: workspaceRailResizeHandle");
  const reloadPiButton = objectBodyContaining(shell, "AppButton", "id: reloadPiButton");
  assert.match(shell, /minimumSize:\s*Qt\.size\(560, 520\)/);
  assert.match(shell, /readonly property int workspaceMinimumWidth:\s*composer\.implicitMinimumWidth \+ \(contentRoot\.width <= 640 \? 20 : 36\) \+ 2 \* appTheme\.borderWidth/);
  assert.match(shell, /readonly property int workspaceRailMaximumWidth:\s*Math\.max\(workspaceRailMinimumWidth, contentRoot\.width - workspaceMinimumWidth\)/);
  assert.match(shell, /readonly property bool workspaceRailVisible:\s*!workspaceRailCollapsed && contentRoot\.width >= workspaceRailMinimumWidth \+ workspaceMinimumWidth/);
  assert.match(shell, /sequence:\s*"Ctrl\+Alt\+B"[\s\S]*onActivated:\s*root\.toggleWorkspaceRail\(\)/);
  assert.match(functionBody(shell, "toggleWorkspaceRail"), /workspaceRailCollapsed = !workspaceRailCollapsed/);
  assert.match(shell, /implicitWidth:\s*root\.smokeMode && Quickshell\.env\("QT_WEBUI_THEME_MODE"\) === "layout-geometry" \? 560 : 860/);
  assert.match(shell, /implicitHeight:\s*root\.smokeMode && Quickshell\.env\("QT_WEBUI_THEME_MODE"\) === "layout-geometry" \? 520 : 760/);
  assert.match(smoke, /function checkLayoutGeometry\(label, railShown\)[\s\S]*mapToItem\(frame, 0, 0\)/);
  assert.match(functionBody(shell, "clampWorkspaceRailWidth"), /Math\.min\(workspaceRailMaximumWidth, Math\.max\(workspaceRailMinimumWidth, width\)\)/);
  assert.match(rail, /Layout\.preferredWidth:\s*root\.workspaceRailRequestedWidth > 0[\s\S]*root\.clampWorkspaceRailWidth\(contentRoot\.width \* 0\.24\)/);
  assert.match(rail, /Layout\.minimumWidth:\s*root\.workspaceRailMinimumWidth/);
  assert.match(rail, /Layout\.maximumWidth:\s*root\.workspaceRailMaximumWidth/);
  assert.match(rail, /Accessible\.name:\s*"Workspace navigation"/);
  assert.match(shell, /text:\s*"◆"[\s\S]*Accessible\.name:\s*"Qt WebUI identity mark"/);
  assert.match(shell, /readonly property bool hasActiveSession:\s*bridge\.activeTabId\.length > 0/);
  assert.match(shell, /text:\s*"WORKSPACES"[\s\S]*font\.letterSpacing:\s*appTheme\.labelTracking/);
  assert.match(shell, /id:\s*contentRoot[\s\S]*border\.color:\s*appTheme\.frameBorder/);
  assert.match(resizeHandle, /activeFocusOnTab:\s*true/);
  assert.match(resizeHandle, /Accessible\.role:\s*Accessible\.Slider/);
  assert.match(resizeHandle, /Accessible\.description:\s*"Drag left or right, or press Shift\+Left or Shift\+Right"/);
  assert.match(resizeHandle, /cursorShape:\s*Qt\.SplitHCursor/);
  assert.match(resizeHandle, /DragHandler\s*\{[\s\S]*target:\s*null[\s\S]*yAxis\.enabled:\s*false[\s\S]*translation\.x/);
  assert.match(resizeHandle, /Keys\.onPressed:[\s\S]*Qt\.ShiftModifier[\s\S]*Qt\.Key_Left[\s\S]*shiftWorkspaceRailWidth\(-16\)[\s\S]*Qt\.Key_Right[\s\S]*shiftWorkspaceRailWidth\(16\)/);
  assert.match(rail, /SessionList\s*\{[\s\S]*sessions:\s*bridge\.sessionCatalog/);
  assert.match(reloadPiButton, /visible:\s*bridge\.ready/);
  assert.match(reloadPiButton, /text:\s*"Reload Pi"/);
  assert.match(reloadPiButton, /enabled:\s*!bridge\.active/);
  assert.match(reloadPiButton, /onClicked:\s*bridge\.sendPrompt\("\/reload", "send"\)/);
  assert.match(shell, /width:\s*Math\.min\(parent\.width, 820\)/);
  assert.match(shell, /Accessible\.name:\s*"Conversation transcript"/);
  assert.match(emptyState, /Flickable\s*\{[\s\S]*boundsBehavior:\s*Flickable\.StopAtBounds/);
  assert.match(emptyState, /RowLayout\s*\{[\s\S]*Accessible\.name:\s*"Prompt landmark"[\s\S]*text:\s*">"[\s\S]*Layout\.preferredWidth:\s*empty\.theme\.spaceXl[\s\S]*Layout\.preferredHeight:\s*empty\.theme\.borderWidth \* 2/);
  assert.match(emptyState, /property bool sessionOpen:\s*true[\s\S]*signal newSessionRequested\(\)/);
  assert.match(emptyState, /text:\s*!empty\.sessionOpen \? "NO SESSION OPEN" : empty\.ready \? "SESSION READY"[\s\S]*font\.family:\s*empty\.theme\.monospaceFamily[\s\S]*font\.letterSpacing:\s*empty\.theme\.labelTracking/);
  assert.match(shell, /Layout\.fillHeight:\s*!root\.hasActiveSession \|\| transcriptList\.count > 0[\s\S]*Layout\.preferredHeight:\s*root\.hasActiveSession && transcriptList\.count === 0[\s\S]*Math\.min\(480, Math\.max\(260, contentRoot\.height \* 0\.42\)\)/);
  assert.match(emptyState, /AppButton\s*\{[\s\S]*visible:\s*!empty\.sessionOpen \|\| empty\.canRecover[\s\S]*variant:\s*"primary"[\s\S]*text:\s*"New session"[\s\S]*accessibleName:\s*"Start a new session"[\s\S]*onClicked:\s*empty\.newSessionRequested\(\)/);
  assert.doesNotMatch(emptyState, /Focus prompt|Focus the prompt|focusComposerRequested/);
  assert.match(shell, /EmptyState\s*\{[\s\S]*sessionOpen:\s*root\.hasActiveSession[\s\S]*onNewSessionRequested:\s*root\.newSessionInTab\(\)/);
  assert.doesNotMatch(shell, /onFocusComposerRequested/);
  assert.match(shell, /id:\s*workspaceHeader[\s\S]*visible:\s*root\.hasActiveSession/);
  assert.match(functionBody(shell, "newSessionInTab"), /root\.hasActiveSession \? bridge\.newSession\(\) : bridge\.openTab\("", ""\)/);
  assert.equal((shell.match(/\bComposer\s*\{/g) ?? []).length, 1);
  assert.match(shell, /id:\s*composer[\s\S]*visible:\s*root\.hasActiveSession/);
  const composerIndex = shell.indexOf("id: composer");
  const responseControlsIndex = shell.indexOf("id: responseControls");
  assert(responseControlsIndex > composerIndex, "response controls should sit beneath the composer instead of beneath the workspace title");
  assert.match(shell, /id:\s*responseControls[\s\S]*Accessible\.name:\s*"Response and transcript controls for workspace "/);
});

test("global sessions page safely into accessible Working and default-expanded Settled navigation", () => {
  const refresh = functionBody(bridge, "refreshSessionCatalog");
  const page = functionBody(bridge, "loadSessionCatalogPage");
  const settle = functionBody(bridge, "setSessionSettled");
  const settleAll = functionBody(bridge, "settleAllSessions");
  const settleBatch = functionBody(bridge, "settleSessionBatch");
  const finishSettleAll = functionBody(bridge, "finishSettleAll");
  const open = functionBody(bridge, "openCatalogSession");
  assert.match(refresh, /const generation = \+\+sessionCatalogGeneration[\s\S]*loadSessionCatalogPage\(generation, 0, \[\], \(\{\}\)\)/);
  assert.match(page, /const fields = \{ scope: "all", offset: offset \}/);
  assert.match(page, /if \(cursor\) fields\.cursor = cursor/);
  assert.match(page, /request\("sessions_list", fields/);
  assert.match(page, /generation !== sessionCatalogGeneration\) return/);
  assert.match(page, /seen\[path\] === true[\s\S]*seen\[path\] = true[\s\S]*merged\.push\(session\)/, "concurrent-page duplicates are removed by path");
  assert.match(page, /nextOffset <= offset[\s\S]*loadSessionCatalogPage\(generation, nextOffset, merged, seen, response\.data\.cursor, retries\)/, "paging must make progress and remain sequential");
  assert.match(page, /sessionCatalog = merged[\s\S]*sessionCatalogLoading = false[\s\S]*sessionCatalogLoaded\(merged\)/);
  assert.match(page, /\}, false\)/, "global pages are not dropped after a tab switch");
  assert.match(bridge, /Timer\s*\{[\s\S]*id:\s*sessionCatalogRefreshTimer[\s\S]*interval:\s*500[\s\S]*bridge\.refreshSessionCatalog\(\)/, "catalog refresh events are coalesced");
  assert.match(functionBody(bridge, "listSessions"), /request\("sessions_list", \{\}/, "the legacy picker remains workspace-scoped");

  assert.match(settle, /sessionSettlementIsPending\(path\)/);
  assert.match(settle, /sessionTab\(catalogSession\(path\)\)[\s\S]*nextSettled && matchingTab && matchingTab\.active/, "the local idle guard uses backend-provided canonical tab association");
  assert.match(settle, /request\("session_settled", \{ "sessionPath": path, "settled": nextSettled \}/);
  assert.match(settle, /if \(!response\.ok\)[\s\S]*else updateCatalogSettlement/, "the visible group changes only after backend confirmation");
  assert.match(bridge, /property bool sessionSettleAllPending:\s*false/);
  assert.match(settleAll, /sessionSettleAllPending \|\| !backendReady \|\| quitting/);
  assert.match(settleAll, /session\.settled === true[\s\S]*matchingTab && matchingTab\.active[\s\S]*!sessionSettlementIsPending\(path\)[\s\S]*settleSessionBatch\(paths, 0, 0, 0, skippedActive, callback\)/, "bulk settlement snapshots only unsettled idle saved-session paths");
  assert.match(settleBatch, /setSessionSettled\(paths\[index\], true, response =>[\s\S]*settleSessionBatch\(paths, index \+ 1/, "bulk settlement is sequential instead of exceeding the backend pending-request limit");
  assert.match(finishSettleAll, /sessionSettleAllPending = false[\s\S]*postNotice\([\s\S]*settled: settledCount, failed: failedCount, skippedActive: skippedActive/, "bulk settlement clears pending state and summarizes partial results");
  assert.match(bridge, /bridge\.sessionSettlementPending = \(\{\}\)[\s\S]*bridge\.sessionSettleAllPending = false/, "backend exit cancels the client-side batch");
  assert.match(open, /const matchingTab = sessionTab\(session\)[\s\S]*return selectTab\(String\(matchingTab\.id\), callback\)/, "an already-open canonical alias reuses its associated tab");
  assert.match(functionBody(bridge, "sessionTab"), /openTabId[\s\S]*tabById\(openTabId\)/, "canonical identities stay hidden behind backend-provided tab ids");
  const settledNotificationGuard = functionBody(bridge, "tabSessionIsSettled");
  assert.match(settledNotificationGuard, /session\.settled !== true[\s\S]*sessionTab\(session\)[\s\S]*String\(tab\.id \|\| ""\) === id/, "notification suppression follows the canonical catalog-to-tab association");
  const notificationLabel = functionBody(bridge, "notificationSessionLabel");
  assert.match(notificationLabel, /tab\.name[\s\S]*tab\.sessionName[\s\S]*id === activeTabId[\s\S]*sessionName[\s\S]*tabLabel\(tab\)/, "notifications prefer the session's displayed name and retain an unnamed-tab fallback");
  const notificationBody = functionBody(bridge, "notificationBody");
  const formatNotificationBody = new Function("body", "tabId", "notificationSessionLabel", notificationBody);
  assert.equal(formatNotificationBody("Build failed", "tab-2", () => "Release prep"), "Release prep\nBuild failed");
  assert.equal(formatNotificationBody("Release prep", "tab-2", () => "Release prep"), "Release prep", "an existing session-name body is not repeated");
  assert.match(functionBody(bridge, "notifyDesktop"), /sourceTabId === undefined \? activeTabId[\s\S]*tabSessionIsSettled\(tabId\)[\s\S]*notificationBody\(body, tabId\)/, "every desktop notification checks the originating session and includes its name");
  assert.equal((functionBody(bridge, "handleInactiveTabEvent").match(/notifyDesktop\([^\n]*event\.tab\)/g) ?? []).length, 2, "background input and run-completion notifications identify their originating tab");
  assert.match(open, /tabs\.length >= maxTabs[\s\S]*return openTab\(String\(session\.cwd \|\| ""\), path, callback\)/, "another saved session opens in a new cwd-aware tab without bypassing the tab limit");
  assert.match(functionBody(shell, "openCatalogSession"), /openTabId\.length > 0[\s\S]*bridge\.selectTab\(openTabId\)[\s\S]*bridge\.openCatalogSession\(session\)/, "temporary unsaved tab rows remain selectable");

  assert.match(sessionList, /property bool settledExpanded:\s*true/);
  assert.match(sessionList, /property alias searchQuery:\s*workspaceSearchField\.text/);
  assert.match(sessionList, /property var orderedSessions:\s*\[\][\s\S]*property var committedSortModifiedByKey:\s*\(\{\}\)/);
  assert.match(sessionList, /readonly property int activitySortGraceMs:\s*5 \* 60 \* 1000/);
  assert.match(sessionList, /readonly property string normalizedSearchQuery:\s*searchQuery\.trim\(\)\.toLowerCase\(\)/);
  assert.match(sessionList, /readonly property var workingSessions:\s*filterSessions\(buildWorkingSessions\(\)\)/);
  assert.match(sessionList, /readonly property var settledSessions:\s*filterSessions\(buildSettledSessions\(\)\)/);
  assert.match(functionBody(sessionList, "titleFor"), /session\.name[\s\S]*session\.firstMessage[\s\S]*session\.id/, "saved title precedence is name, first user message, then id");
  const sessionAgeLabel = functionBody(sessionList, "sessionAgeLabel");
  assert.match(sessionAgeLabel, /ageMs > 30 \* dayMs[\s\S]*new Date\(modified\)[\s\S]*getDate\(\)[\s\S]*getMonth\(\) \+ 1[\s\S]*getFullYear\(\)/, "sessions older than 30 elapsed days use a zero-padded local calendar date");
  assert.match(sessionAgeLabel, /ageMs >= dayMs[\s\S]*Math\.floor\(ageMs \/ dayMs\) \+ "d"[\s\S]*ageMs >= hourMs[\s\S]*Math\.floor\(ageMs \/ hourMs\) \+ "h"/, "recent sessions use compact whole-day and whole-hour labels");
  assert.match(sessionAgeLabel, /!Number\.isFinite\(ageMs\)[\s\S]*return ""/, "temporary sessions without activity timestamps do not gain a misleading age");
  const deferredSessionOrder = functionBody(sessionList, "deferredSessionOrder");
  assert.match(deferredSessionOrder, /hasPrevious && ageMs < activitySortGraceMs[\s\S]*Number\(previous\[key\]\)[\s\S]*sortable\.sort\([\s\S]*right\.committed - left\.committed/, "existing rows keep their committed ordering timestamp until five minutes after their latest activity");
  assert.match(deferredSessionOrder, /nextCommitted = \(\{\}\)[\s\S]*nextCommitted\[key\][\s\S]*"committedByKey": nextCommitted/, "each reconciliation prunes ordering state for sessions no longer in the catalog");
  assert.match(functionBody(sessionList, "reconcileSessionOrder"), /deferredSessionOrder\(sessions, committedSortModifiedByKey, nowMs\)[\s\S]*orderedSessions = result\.sessions/);
  assert.match(sessionList, /onSessionsChanged:\s*reconcileSessionOrder\(Date\.now\(\)\)[\s\S]*Timer\s*\{[\s\S]*interval:\s*60 \* 1000[\s\S]*sessionList\.ageClockMs = now[\s\S]*sessionList\.reconcileSessionOrder\(now\)/, "catalog changes and the minute clock both reconcile deferred activity ordering");
  assert.match(functionBody(sessionList, "searchText"), /session\.title[\s\S]*session\.id[\s\S]*session\.cwd[\s\S]*toLowerCase\(\)/, "workspace search covers titles, identifiers, and folders case-insensitively");
  assert.match(functionBody(sessionList, "filterSessions"), /!searchActive[\s\S]*searchText\(session\)\.indexOf\(normalizedSearchQuery\) !== -1/, "empty queries preserve the source arrays and non-empty queries filter locally");
  const workspaceSearchField = objectBodyWithId(sessionList, "TextField", "workspaceSearchField");
  assert.match(workspaceSearchField, /maximumLength:\s*256/);
  assert.match(workspaceSearchField, /placeholderText:\s*"Search workspaces"/);
  assert.match(workspaceSearchField, /Accessible\.role:\s*Accessible\.EditableText[\s\S]*Accessible\.name:\s*"Search workspaces"/);
  assert.match(workspaceSearchField, /Qt\.Key_Escape[\s\S]*clear\(\)[\s\S]*Qt\.Key_Down[\s\S]*forceActiveFocus\(\)/, "Escape clears and Down enters the filtered results");
  const clearWorkspaceSearch = objectBodyContaining(sessionList, "AppButton", 'accessibleName: "Clear workspace search"');
  assert.match(clearWorkspaceSearch, /visible:\s*workspaceSearchField\.text\.length > 0[\s\S]*workspaceSearchField\.clear\(\)[\s\S]*workspaceSearchField\.forceActiveFocus\(\)/);
  assert.match(sessionList, /visible:\s*sessionList\.searchActive && sessionList\.workingSessions\.length === 0 && sessionList\.settledSessions\.length === 0[\s\S]*text:\s*"No matching workspaces"/);
  assert.match(functionBody(sessionList, "enriched"), /tabForId\(session\.openTabId\)/, "catalog enrichment uses canonical backend association instead of path spelling");
  assert.match(functionBody(sessionList, "buildWorkingSessions"), /for \(const session of orderedSessions\)[\s\S]*catalogTabIds\[openTabId\] = true[\s\S]*catalogTabIds\[String\(tab\.id \|\| ""\)\] === true[\s\S]*openOnly: true/, "working rows use deferred activity order without duplicating canonically associated open tabs");
  assert.match(functionBody(sessionList, "buildSettledSessions"), /for \(const session of orderedSessions\)[\s\S]*session\.settled === true/);
  assert.match(functionBody(sessionList, "countUnsettledSavedSessions"), /for \(const session of sessions\)[\s\S]*session\.settled !== true[\s\S]*count \+= 1/, "the threshold counts saved catalog rows, not temporary open-only rows");
  assert.match(sessionList, /readonly property int unsettledSavedSessionCount:\s*countUnsettledSavedSessions\(\)/);
  const settleAllButton = objectBodyWithId(sessionList, "AppButton", "settleAllButton");
  assert.match(settleAllButton, /anchors\.right:\s*parent\.right[\s\S]*anchors\.bottom:\s*parent\.bottom[\s\S]*z:\s*2/, "Settle All floats over the lower-right session list without replacing list content");
  assert.match(settleAllButton, /visible:\s*sessionList\.unsettledSavedSessionCount > 100/, "Settle All is hidden at exactly 100 unsettled sessions");
  assert.match(settleAllButton, /variant:\s*"primary"[\s\S]*text:\s*sessionList\.settleAllPending \? "Settling…" : "Settle All"[\s\S]*enabled:\s*!sessionList\.settleAllPending[\s\S]*sessionList\.settleAllRequested\(\)/);
  assert.match(shell, /settleAllPending:\s*bridge\.sessionSettleAllPending[\s\S]*onSettleAllRequested:\s*bridge\.settleAllSessions\(\)/, "the floating action is wired to the bridge batch");
  const catalogStatus = objectBodyContaining(sessionList, "SelectableText", 'text: sessionList.loading ? "Loading saved sessions…" : sessionList.errorText');
  assert.match(catalogStatus, /visible:\s*\(sessionList\.loading && sessionList\.sessions\.length === 0\) \|\| sessionList\.errorText\.length > 0/, "background refreshes do not show a loading placeholder over an existing settled session");
  assert.match(catalogStatus, /wrapMode:\s*TextEdit\.Wrap[\s\S]*maximumLineCount:\s*2/, "catalog errors remain bounded while their source stays selectable");
  assert.match(sessionList, /id:\s*workingList[\s\S]*model:\s*sessionList\.workingSessions[\s\S]*activeFocusOnTab:\s*count > 0[\s\S]*Accessible\.name:\s*"Working sessions"/);
  assert.match(sessionList, /id:\s*settledToggle[\s\S]*accessibleName:\s*\(sessionList\.settledExpanded \? "Collapse" : "Expand"\) \+ " settled sessions"/);
  assert.match(sessionList, /id:\s*settledList[\s\S]*model:\s*sessionList\.settledSessions[\s\S]*Accessible\.name:\s*"Settled sessions"/);
  assert.match(sessionList, /color:\s*sessionList\.errorText\.length > 0 \? sessionList\.theme\.errorForeground : sessionList\.theme\.muted/, "catalog errors use a defined semantic foreground token");
  const workingRow = objectBodyWithId(sessionList, "Rectangle", "workingRow");
  assert.match(workingRow, /readonly property string ageText:\s*sessionList\.sessionAgeLabel\(modelData\)/);
  assert.match(workingRow, /visible:\s*workingRow\.ageText\.length > 0[\s\S]*text:\s*workingRow\.ageText/);
  assert.match(workingRow, /text:\s*sessionList\.statusFor\(workingRow\.modelData\)/);
  assert.match(workingRow, /width:\s*4[\s\S]*height:\s*12[\s\S]*radius:\s*0/, "working status uses rectangular punctuation rather than a round dot");
  const workingRowTap = objectBodyWithId(workingRow, "TapHandler", "workingRowTap");
  assert.match(workingRowTap, /acceptedButtons:\s*Qt\.LeftButton[\s\S]*gesturePolicy:\s*TapHandler\.DragThreshold[\s\S]*workingRow\.activateRow\(\)/);
  assert.match(functionBody(workingRow, "activateRow"), /workingList\.currentIndex = workingRow\.index[\s\S]*sessionList\.openRow\(workingRow\.modelData\)/, "the complete working-session card activates from a normal tap");
  assert.match(workingRow, /SelectableText\s*\{[\s\S]*text:\s*workingRow\.modelData\.title[\s\S]*onTapped:\s*workingRow\.activateRow\(\)/, "text taps share the row action without replacing native selection drags");
  assert.match(workingRow, /HoverHandler\s*\{[\s\S]*Qt\.PointingHandCursor/, "blank row space retains the navigation cursor");
  assert.match(workingRow, /Layout\.preferredWidth:\s*78[\s\S]*implicitWidth:\s*78[\s\S]*"Settle"/, "Settle reserves enough width for its full label");
  assert.match(workingRow, /enabled:\s*!workingRow\.modelData\.active/);
  assert.match(workingRow, /accessibleName:\s*"Close tab " \+ workingRow\.modelData\.title/);
  const settledRow = objectBodyWithId(sessionList, "Rectangle", "settledRow");
  assert.match(settledRow, /readonly property string ageText:\s*sessionList\.sessionAgeLabel\(modelData\)/);
  assert.match(settledRow, /text:\s*settledRow\.modelData\.title[\s\S]*visible:\s*settledRow\.ageText\.length > 0[\s\S]*text:\s*settledRow\.ageText/);
  const settledRowTap = objectBodyWithId(settledRow, "TapHandler", "settledRowTap");
  assert.match(settledRowTap, /acceptedButtons:\s*Qt\.LeftButton[\s\S]*gesturePolicy:\s*TapHandler\.DragThreshold[\s\S]*settledRow\.activateRow\(\)/);
  assert.match(functionBody(settledRow, "activateRow"), /settledList\.currentIndex = settledRow\.index[\s\S]*sessionList\.openRow\(settledRow\.modelData\)/, "the complete settled-session card activates from a normal tap");
  assert.match(settledRow, /SelectableText\s*\{[\s\S]*text:\s*settledRow\.modelData\.title[\s\S]*onTapped:\s*settledRow\.activateRow\(\)/, "settled text taps share the row action without replacing native selection drags");
  assert.match(settledRow, /Layout\.preferredWidth:\s*86[\s\S]*implicitWidth:\s*86[\s\S]*"Restore"/, "Restore reserves enough width for its full label");
  assert.doesNotMatch(settledRow, /statusFor|shortPath|messageCount|statusKind|\.cwd\b/, "settled rows do not repeat status details or folder paths");
  for (const signal of ["settleAllRequested()", "closeRequested(string tabId)", "newTabRequested()", "openDirectoryRequested()"] ) {
    assert(sessionList.includes(`signal ${signal}`), `session list should expose ${signal}`);
  }
});

test("open session rows and tab controls present backend-owned activity states with orthogonal conditions", () => {
  for (const [name, source] of [["session list", sessionList], ["tab strip", tabStrip]]) {
    const activityStateFor = functionBody(source, "activityStateFor");
    assert.match(activityStateFor, /\.activityState/, `${name} consumes backend activityState`);
    for (const state of ["blocked", "working", "done", "idle"]) {
      assert.match(activityStateFor, new RegExp(`"${state}"`), `${name} exposes the ${state} label`);
    }
    assert.doesNotMatch(activityStateFor, /\.active|\.unread|\.needsInput/, `${name} does not independently infer activity`);

    const conditionDescription = functionBody(source, "conditionDescription");
    assert.match(conditionDescription, /statusKind === "error"[\s\S]*statusText/, `${name} preserves process errors as a separate condition`);
    assert.match(conditionDescription, /needsInput[\s\S]*"needs input"/, `${name} reports pending input as a separate condition`);
  }

  const sessionStatus = functionBody(sessionList, "statusFor");
  assert.match(sessionStatus, /!session\.open\) return "saved · "/, "closed saved rows retain their existing status");
  assert.match(sessionStatus, /activityStateFor\(session\) \+ " · "/, "open rows display the backend activity label");
  assert.match(functionBody(sessionList, "enriched"), /"activityState": tab \? String\(tab\.activityState/, "catalog-backed open rows copy activityState from their tab summary");
  assert.match(functionBody(sessionList, "buildWorkingSessions"), /activityState: String\(tab\.activityState/, "temporary open rows copy activityState from their tab summary");
  const workingRow = objectBodyWithId(sessionList, "Rectangle", "workingRow");
  assert.match(workingRow, /Accessible\.name:[\s\S]*statusFor\(modelData\)[\s\S]*conditionText/, "open-row accessibility includes activity and orthogonal conditions");
  assert.match(workingRow, /ToolTip\.text:\s*sessionList\.statusTooltip\(modelData\)/, "open-row tooltips include the same status description");
  const sessionPunctuation = objectBodyContaining(workingRow, "Rectangle", "width: 4");
  assert.match(sessionPunctuation, /statusKind === "error" \? sessionList\.theme\.destructive/, "session errors retain destructive precedence");
  for (const [state, token] of [["blocked", "warning"], ["working", "runningForeground"], ["done", "readyForeground"]]) {
    assert.match(sessionPunctuation, new RegExp(`=== "${state}" \\? sessionList\\.theme\\.${token}`), `session ${state} uses ${token}`);
  }
  assert.match(sessionPunctuation, /: sessionList\.theme\.muted/, "session idle uses muted");
  assert.match(sessionPunctuation, /width:\s*4[\s\S]*height:\s*12[\s\S]*radius:\s*0/, "session activity keeps rectangular status punctuation");

  const tabItem = objectBodyWithId(tabStrip, "Rectangle", "tabItem");
  assert.match(tabItem, /readonly property string activityState:\s*strip\.activityStateFor\(modelData\)/);
  assert.match(tabItem, /Accessible\.name:[\s\S]*activityState[\s\S]*conditionText/, "tab accessibility includes activity and orthogonal conditions");
  assert.match(tabItem, /ToolTip\.text:\s*strip\.tooltipDescription\(modelData\)/, "tab tooltips include activity and orthogonal conditions");
  assert.match(tabItem, /SelectableText\s*\{[\s\S]*text:\s*tabItem\.activityState/, "tab controls visibly show the lowercase activity label");
  const tabPunctuation = objectBodyContaining(tabItem, "Rectangle", "width: 8");
  assert.match(tabPunctuation, /statusKind === "error" \? strip\.theme\.destructive/, "tab errors retain destructive precedence");
  for (const [state, token] of [["blocked", "warning"], ["working", "runningForeground"], ["done", "readyForeground"]]) {
    assert.match(tabPunctuation, new RegExp(`=== "${state}" \\? strip\\.theme\\.${token}`), `tab ${state} uses ${token}`);
  }
  assert.match(tabPunctuation, /: strip\.theme\.muted/, "tab idle uses muted");
});

test("automatic session settlement setting is confirmed, bounded, cancellable, and refreshes after save", () => {
  assert.match(bridge, /property int sessionSettleDays:\s*30/);
  assert.match(bridge, /property bool sessionSettleDaysPending:\s*false/);
  const apply = functionBody(bridge, "applySettings");
  assert.match(apply, /Number\.isInteger\(settings\.sessionSettleDays\)[\s\S]*settings\.sessionSettleDays >= 1[\s\S]*settings\.sessionSettleDays <= 3650[\s\S]*sessionSettleDays = settings\.sessionSettleDays/);

  const save = functionBody(bridge, "setSessionSettleDays");
  assert.match(save, /const days = Number\(value\)/);
  assert.match(save, /sessionSettleDaysPending \|\| !Number\.isInteger\(days\) \|\| days < 1 \|\| days > 3650/);
  assert.match(save, /request\("settings_set", \{ "values": \{ "sessionSettleDays": days \} \}/);
  assert.match(save, /if \(!response\.ok\)[\s\S]*Could not save automatic settlement/);
  assert.match(save, /response\.data\.settings\.sessionSettleDays < 1[\s\S]*response\.data\.settings\.sessionSettleDays > 3650/);
  assert.match(save, /applySettings\(response\.data\.settings\)[\s\S]*refreshSessionCatalog\(\)/, "the catalog refresh follows the confirmed settings application");
  assert(save.indexOf("applySettings(response.data.settings)") > save.indexOf("if (!response.ok)"), "a failed response must not change the confirmed setting");
  assert(save.indexOf("refreshSessionCatalog()") > save.indexOf("applySettings(response.data.settings)"), "refresh must happen only after backend confirmation is applied");

  const validate = functionBody(shell, "sessionSettleDaysProblem");
  assert.match(validate, /value\.length === 0/);
  assert.match(validate, /\^\[0-9\]\+\$/);
  assert.match(validate, /!Number\.isInteger\(days\) \|\| days < 1 \|\| days > 3650/);
  const openSetting = functionBody(shell, "openSessionSettleDays");
  assert.match(openSetting, /bridge\.sessionSettleDaysPending \|\| inputDialogItem\.opened/);
  assert.match(openSetting, /title: "Automatic session settlement"/);
  assert.match(openSetting, /Lowering the value may settle closed inactive sessions/);
  assert.match(openSetting, /prefill: String\(bridge\.sessionSettleDays\)/);
  assert.match(openSetting, /maxCharacters: 4[\s\S]*validate: text => root\.sessionSettleDaysProblem\(text\)/);
  assert.match(openSetting, /previousDays: bridge\.sessionSettleDays/);
  assert.match(functionBody(shell, "inputSubmitted"), /context\.action === "session-settle-days"\) bridge\.setSessionSettleDays\(text\)/);
  assert.match(functionBody(shell, "runPaletteAction"), /case "session-settle-days": return root\.openSessionSettleDays\(\)/);
  assert.match(functionBody(shell, "composerMenuItems"), /value: "session-settle-days"[\s\S]*detail: bridge\.sessionSettleDays \+ " days"/);
  assert.match(functionBody(shell, "paletteActions"), /"Automatic settlement: " \+ bridge\.sessionSettleDays \+ " days"/);
  assert.match(inputDialog, /onClosed:\s*if \(!answered\) cancelled\(context\)/, "closing or cancelling the input must not submit a setting change");
  assert.match(functionBody(inputDialog, "submit"), /if \(answered \|\| !valid\) return false[\s\S]*submitted\(field\.text\.trim\(\), context\)/, "invalid input remains in the dialog without submission");
});

test("composer burger menu exposes secondary actions without duplicating visible controls", () => {
  const responseControls = objectBodyContaining(shell, "RowLayout", "id: responseControls");
  const composerMenuButton = objectBodyContaining(responseControls, "AppButton", "id: composerMenuButton");
  const menuItems = functionBody(shell, "composerMenuItems");
  assert.match(responseControls, /Flow\s*\{[\s\S]*id:\s*primaryResponseControls[\s\S]*Layout\.fillWidth:\s*true/);
  assert.match(composerMenuButton, /text:\s*"☰"[\s\S]*accessibleName:\s*"More options"/);
  assert.match(composerMenuButton, /accessibleDescription:\s*"Resources, saved prompt sequences, automatic settlement, display settings, events, and diagnostics"/);
  assert.match(composerMenuButton, /Layout\.alignment:\s*Qt\.AlignRight \| Qt\.AlignTop/);
  assert.doesNotMatch(responseControls, /Layout\.rightMargin/, "the burger button should align with the prompt's full right edge");
  assert(responseControls.indexOf("id: composerMenuButton") > responseControls.indexOf("id: statusButton"), "the burger menu should be the rightmost response control");
  assert.doesNotMatch(responseControls, /id:\s*resourceProfilesButton|text:\s*bridge\.resourceLoading \? "Resources…" : "Resources"/, "Resources should live in the menu instead of a standalone control");
  assert.doesNotMatch(composer, /id:\s*sequencesButton|signal\s+sequencesRequested/, "Sequences should live in the menu instead of a standalone composer control");
  for (const action of ["resource-profiles", "sequences", "toggle-thinking", "toggle-highlighting", "toggle-notifications", "cycle-appearance", "toggle-reduced-motion", "events", "diagnostics"]) {
    assert.match(menuItems, new RegExp(`value: "${action}"`), `secondary action ${action}`);
  }
  for (const duplicate of ["compact-context", "choose-model", "choose-thinking", "search", "resume-session", "worktree", "restart"]) {
    assert.doesNotMatch(menuItems, new RegExp(`value: "${duplicate}"`), `visible action ${duplicate} should not be duplicated`);
  }
  assert.match(shell, /DropUpPicker\s*\{[\s\S]*id:\s*composerMenuDropUpItem[\s\S]*anchorItem:\s*composerMenuButton[\s\S]*returnFocusItem:\s*composerMenuButton/);
  assert.match(functionBody(shell, "composerPickerOpen"), /composerMenuDropUpItem\.opened/);
  assert.match(functionBody(shell, "invalidateComposerPickers"), /composerMenuDropUpItem\.opened[\s\S]*composerMenuDropUpItem\.close\(\)/);
  assert.match(functionBody(shell, "openComposerMenu"), /!bridge\.ready \|\| bridge\.active[\s\S]*composerMenuDropUpItem\.present/);
  assert.match(functionBody(shell, "composerMenuPicked"), /Qt\.callLater[\s\S]*runPaletteAction\(value\)[\s\S]*recordAction\("action:" \+ value\)/);
});

test("theme owns every palette color and follows the portal-first desktop color scheme", () => {
  assert.match(theme, /Qt\.styleHints\.colorScheme\s*===\s*Qt\.Dark/);
  assert.match(theme, /requestedMode === "dark"/);
  assert.match(theme, /portalMode === "dark"/);
  assert.match(shell, /requestedMode:\s*bridge\.appearanceMode/);
  assert.match(shell, /portalMode:\s*bridge\.portalColorScheme/);
  assert.match(shell, /reducedMotion:\s*bridge\.reducedMotion/);
  assert.match(shell, /desktopCornerRadius:\s*bridge\.desktopCornerRadius/);
  assert.match(shell, /desktopEdgeGap:\s*bridge\.desktopEdgeGap/);
  for (const token of ["mainSurface", "sidebarSurface", "sidebarBorder", "panelSurface", "windowBackground", "foreground", "frameBorder", "accent", "link", "focusRing", "success", "controlSurface", "controlHover", "controlPressed", "controlActive", "controlSelected", "composerSurface", "composerBorder", "codeBackground", "codeForeground", "quoteBorder", "tableBorder", "thinkingForeground", "dialogOverlay", "searchHighlight", "selection", "selectionForeground", "urgentBackground", "urgentBorder", "urgentForeground", "primaryButtonForeground", "destructiveButtonForeground", "warningButtonForeground"]) {
    assert.match(theme, new RegExp(`readonly property color ${token}\\b`), `theme token ${token}`);
  }
  for (const token of ["spaceXxs", "spaceXs", "spaceSm", "spaceMd", "spaceLg", "spaceXl", "space2Xl", "space3Xl", "space4Xl", "typeCaption", "typeSmall", "typeBody", "typeSubtitle", "typeTitle", "typeHeading", "typeDisplay", "typeDisplayLarge", "radiusSmall", "radiusMedium", "radiusLarge", "radiusPill", "borderWidth", "focusBorderWidth", "controlHeight", "motionFast", "motionNormal", "motionSlow", "animationDuration"]) {
    assert.match(theme, new RegExp(`readonly property int ${token}\\b`), `theme scale token ${token}`);
  }
  assert.match(theme, /motionNormal:\s*reducedMotion \? 0 : 120/);
  assert.match(theme, /property int desktopCornerRadius:\s*0/);
  assert.match(theme, /radiusSmall:\s*Math\.min\(2, desktopCornerRadius\)/);
  assert.match(theme, /focusBorderWidth:\s*borderWidth/);
  assert.match(theme, /controlHeight:\s*36/);
  assert.match(theme, /readonly property real labelTracking:\s*1\.1/);
  assert.match(theme, /mainSurface:\s*themedColor\("mainSurface", dark \? "#100e18" : "#f4f1fa"\)/);
  assert.match(theme, /accent:\s*themedColor\("accent", dark \? "#afa2ee" : "#5f529b"\)/);
  assert.match(theme, /readyForeground:\s*themedColor\("readyForeground", success\)/);
  assert.doesNotMatch(theme, /syntaxString:[^\n]*#(?:86efac|bbf7d0)/, "green remains success punctuation rather than a general syntax accent");
  assert.match(bridge, /validatedDesktopMetric\(Quickshell\.env\("QT_WEBUI_DESKTOP_CORNER_RADIUS"\), 0\)/);
  assert.match(theme, /function filledButtonBackground\(variant, state\)/);
  assert.match(theme, /function filledButtonForeground\(variant, state\)/);
  for (const stateToken of ["primaryButtonBackground", "primaryButtonHover", "primaryButtonPressed", "primaryButtonHoverForeground", "primaryButtonPressedForeground", "destructiveButtonBackground", "destructiveButtonHover", "destructiveButtonPressed", "destructiveButtonHoverForeground", "destructiveButtonPressedForeground", "warningButtonBackground", "warningButtonHover", "warningButtonPressed"]) {
    assert.match(theme, new RegExp(`readonly property color ${stateToken}\\b`), `filled button state token ${stateToken}`);
  }
  for (const statusKind of ["ready", "running", "tool", "error"]) assert.match(theme, new RegExp(`kind === "${statusKind}"`));
  for (const [name, source] of Object.entries(components)) {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b/, `${name} should use semantic theme roles`);
  }
});

test("external theme state is bounded, atomic, generation-ordered, and wired through the picker", () => {
  assert.match(bridge, /readonly property int maxThemeInventory:\s*131/);
  assert.match(bridge, /readonly property int maxThemeDiagnostics:\s*64/);
  assert.match(bridge, /property var themeState:/);
  const apply = functionBody(bridge, "applyThemeState");
  assert.match(apply, /data\.generation < themeState\.generation\) return false/, "older list responses cannot replace newer theme events");
  assert.match(apply, /data\.inventory\.length > maxThemeInventory/);
  assert.match(apply, /data\.diagnostics\.length > maxThemeDiagnostics/);
  assert.match(apply, /themeState = \{[\s\S]*requested:[\s\S]*effective:[\s\S]*fallbackReason:[\s\S]*inventory:[\s\S]*diagnostics:[\s\S]*palette:/, "theme state changes in one assignment");
  assert.match(functionBody(bridge, "listThemes"), /request\("themes_list", \{\},[\s\S]*applyThemeState\(response\.data\)[\s\S]*\}, false\)/);
  assert.match(functionBody(bridge, "selectTheme"), /validThemeIdentity\(identity\)[\s\S]*request\("theme_select", \{ "selection": \{ "kind": identity\.kind, "name": identity\.name \} \}/);
  assert.match(bridge, /applyThemeState\(response\.data\.themeState\)/);
  assert.match(functionBody(bridge, "handleEvent"), /case "themes\.changed":[\s\S]*applyThemeState\(event\.state\)/);
  assert.match(functionBody(bridge, "resetThemeGeneration"), /generation: 0/, "a restarted backend begins a new generation sequence");

  assert.match(shell, /themeState:\s*bridge\.themeState/);
  assert.match(functionBody(shell, "themeItems"), /JSON\.stringify\(\{ kind: identity\.kind, name: identity\.name \}\)/, "built-in and external names cannot collide");
  assert.match(functionBody(shell, "themeItems"), /current: themeIdentityMatches\(identity, bridge\.themeState\.requested\)/);
  assert.match(functionBody(shell, "openThemePicker"), /bridge\.listThemes\([\s\S]*title: "Choose a theme"[\s\S]*message: root\.themeStatusMessage\(\)/);
  assert.match(functionBody(shell, "themeStatusMessage"), /Requested theme[\s\S]*unavailable[\s\S]*Using[\s\S]*retry the saved choice/);
  assert.match(functionBody(shell, "pickerPicked"), /kind === "theme"[\s\S]*JSON\.parse\(value\)[\s\S]*bridge\.selectTheme\(identity\)/);
  assert.match(functionBody(shell, "runPaletteAction"), /case "choose-theme": return root\.openThemePicker\(\)/);
  assert.match(functionBody(shell, "composerMenuItems"), /value: "choose-theme"[\s\S]*detail: root\.themeSelectionLabel\(\)/);

  for (const role of SEMANTIC_PALETTE_ROLES) {
    assert(theme.includes(`"${role}"`), `complete-palette guard should include ${role}`);
    assert.match(theme, new RegExp(`readonly property color ${role}: themedColor\\("${role}",`), `${role} should switch atomically through Theme.qml`);
  }
  assert.match(functionBody(theme, "completeExternalPalette"), /state\.effective\.kind !== "external"[\s\S]*for \(const role of paletteRoleNames\)[\s\S]*return state\.palette/);
});

test("QML limits match the backend protocol budget", () => {
  assert.match(bridge, new RegExp(`readonly property int protocolVersion:\\s*${PROTOCOL_VERSION}\\b`));
  assert.match(bridge, new RegExp(`readonly property int maxTranscriptRows:\\s*${LIMITS.maxTranscriptRows}\\b`));
  assert.match(bridge, new RegExp(`readonly property int maxMessageCharacters:\\s*${LIMITS.maxMessageCharacters}\\b`));
  assert.match(bridge, new RegExp(`readonly property int maxErrorCharacters:\\s*${LIMITS.maxErrorCharacters}\\b`));
  assert.match(bridge, new RegExp(`readonly property int maxRuntimeInfoCharacters:\\s*${LIMITS.maxRuntimeInfoCharacters}\\b`));
  assert.match(bridge, new RegExp(`readonly property int maxPendingRequests:\\s*${LIMITS.maxPendingRequests}\\b`));
  assert.match(bridge, new RegExp(`readonly property int maxModels:\\s*${LIMITS.maxModels}\\b`));
  assert.match(functionBody(bridge, "appendRow"), /transcript\.count >= maxTranscriptRows/);
  assert.match(functionBody(bridge, "boundedText"), /slice\(0, max - 1\)/);
  assert.match(bridge, /"toolOutput": boundedText\(event\.output \|\| "", 4096\)/);
  assert.equal(LIMITS.maxToolOutputCharacters, 4096);
});

test("bridge talks only to the backend over strict LF JSONL with correlated, bounded requests", () => {
  assert.match(bridge, /command:\s*\[\s*String\(Quickshell\.env\("QT_WEBUI_NODE_EXECUTABLE"\)[\s\S]*String\(Quickshell\.env\("QT_WEBUI_BACKEND_ENTRY"\)/);
  assert.doesNotMatch(bridge, /--mode|QT_WEBUI_PI_CLI_ENTRY/, "QML must not start Pi directly");
  assert.match(bridge, /workingDirectory:\s*bridge\.callerCwd/);
  assert.match(bridge, /stdinEnabled:\s*true/);
  assert.equal((bridge.match(/splitMarker:\s*"\\n"/g) ?? []).length, 2);
  const request = functionBody(bridge, "request");
  assert.match(request, /"v": protocolVersion/);
  assert.match(request, /const encoded = JSON\.stringify\(frame\) \+ "\\n"/);
  assert.match(request, /utf8Bytes\(encoded\) > maxInboundFrameBytes/);
  assert.match(request, /backendProcess\.write\(encoded\)/);
  assert.match(request, /pendingRequestCount >= maxPendingRequests/);
  assert.match(request, /deadline: Date\.now\(\) \+ timeoutFor\(type\)/);
  assert.match(request, /originTab: type === "tab_select" \? String\(frame\.tab\) : activeTabId/);
  assert.match(request, /sessionScoped:\s*sessionScopedOverride === undefined \? sessionScopedRequestTypes\[type\] === true : sessionScopedOverride === true/);
  const settle = functionBody(bridge, "settlePending");
  assert.match(settle, /entry\.sessionScoped && entry\.originTab\.length > 0 && entry\.originTab !== activeTabId/);
  assert.match(settle, /staleResponses\+\+[\s\S]*return true/);
  assert.match(functionBody(bridge, "sweepPending"), /code: "timeout"/);
  assert.match(functionBody(bridge, "handleFrame"), /frame\.v !== protocolVersion/);
  assert.match(functionBody(bridge, "handleFrame"), /staleResponses\+\+/);
  const line = functionBody(bridge, "handleLine");
  assert.match(line, /endsWith\("\\r"\)/);
  assert.match(line, /JSON\.parse\(line\)/);
  assert.match(line, /catch \(error\)/);
  assert.doesNotMatch(bridge, /\beval\s*\(|new Function|Qt\.openUrlExternally|execDetached/);
  for (const type of REQUEST_TYPES) {
    if (type === "hello" || type === "debug_crash" || type === "settings_get") continue; // hello returns settings; settings_get exists for tooling
    assert.match(bridge, new RegExp(`request\\("${type}"`), `bridge should issue ${type} requests`);
  }
});

test("bridge handles every backend event type and keeps failure paths explicit", () => {
  const handler = functionBody(bridge, "handleEvent");
  for (const eventType of [
    "backend.ready", "backend.fatal", "pi.status", "pi.error", "pi.runtime", "pi.exit", "message.user", "part.begin",
    "part.render", "part.remove", "message.end", "tool.start", "tool.update", "tool.end", "run.start", "run.end",
    "extension.request", "extension.notify", "extension.status", "composer.setText",
    "window.title", "queue.update", "notice", "events.dropped", "settings.changed", "appearance.changed", "themes.changed", "tabs.update", "sessions.changed", "transcript.reset", "transcript.row",
  ]) assert.match(handler, new RegExp(`case "${eventType.replace(".", "\\.")}"`), `event ${eventType}`);
  assert.match(handler, /default:\s*\n\s*break/);
  assert.match(bridge, /event\.partKind/);
  assert.match(bridge, /onExited:\s*\(exitCode, exitStatus\)/);
  assert.match(bridge, /failAllPending\("not_running", "Backend exited"\)/);
  assert.match(bridge, /The Qt WebUI backend exited with code/);
  assert.match(functionBody(bridge, "restartProcess"), /startBackend\(\)/);
  assert.match(functionBody(bridge, "restartProcess"), /restarting = true/);
  assert.match(functionBody(bridge, "handleExtensionStatus"), /event\.chips/);
  assert.match(functionBody(bridge, "restartProcess"), /request\("restart"/);
  assert.match(functionBody(bridge, "shutdown"), /request\("shutdown"/);
  assert.match(functionBody(bridge, "copyToClipboard"), /Quickshell\.clipboardText = text/);
  assert.match(functionBody(bridge, "notifyDesktop"), /!desktopNotifications \|\| windowActive/);
  assert.match(functionBody(bridge, "applyAppearance"), /mode === "unknown"\) return false/);
  assert.match(bridge, /property string appearanceMode: "automatic"/);
  assert.match(bridge, /property bool reducedMotion: false/);
  assert.match(bridge, /QT_WEBUI_DESKTOP_CORNER_RADIUS/);
  assert.match(bridge, /QT_WEBUI_DESKTOP_EDGE_GAP/);
});

test("extension dialogs settle before closing and retain rejected answers", () => {
  const answer = functionBody(bridge, "answerDialog");
  assert.match(answer, /activeDialog\.state !== "open"/);
  assert.match(answer, /dialog\.state = "submitting"/);
  assert.match(answer, /response\.ok \|\| response\.error\.code === "stale_request"/);
  assert.match(answer, /request\("extension_response"/);
  assert.match(functionBody(bridge, "clearDialogs"), /dialogQueue = \[\]/);
  assert.match(bridge, /case "pi\.exit":[\s\S]*clearDialogs\(/);
  assert.match(bridge, /onExited:[\s\S]*clearDialogs\(/);
  for (const method of ["select", "confirm", "input", "editor"]) assert.match(extensionDialog, new RegExp(`method === "${method}"`));
  assert.match(functionBody(extensionDialog, "submit"), /submissionState !== "open"/);
  assert.doesNotMatch(functionBody(extensionDialog, "submit"), /close\(\)/);
  assert.match(extensionDialog, /closePolicy: Popup\.NoAutoClose/);
  assert.match(extensionDialog, /onActivated: dialog\.cancel\(\)/);
  assert.match(functionBody(extensionDialog, "selectOption"), /options\.indexOf\(value\) === -1\) return false/);
  assert.match(extensionDialog, /initialFocusItem:/);
  assert.match(extensionDialog, /keyNavigationEnabled:\s*true/);
  assert.match(extensionDialog, /Keys\.onReturnPressed:\s*dialog\.selectCurrent\(\)/);
  assert.match(appDialog, /modal:\s*true/);
  assert.match(appDialog, /focus:\s*true/);
  assert.match(appDialog, /closePolicy:\s*Popup\.CloseOnEscape/);
  assert.match(appDialog, /parent:\s*Overlay\.overlay/);
  assert.match(appDialog, /onClosed:\s*if \(returnFocusItem\) returnFocusItem\.forceActiveFocus\(\)/);
  assert.match(appDialog, /Accessible\.role:\s*Accessible\.Dialog/);
});

test("model and thinking drop-ups are bounded, keyboard accessible, explicit, and busy guarded", () => {
  for (const name of ["loadModels", "selectModel", "cycleModel", "loadThinkingLevels", "setThinkingLevel", "cycleThinkingLevel", "compactContext"]) {
    assert.match(bridge, new RegExp(`function ${name}\\(`), `bridge should implement ${name}`);
  }
  for (const name of ["selectModel", "cycleModel", "setThinkingLevel", "cycleThinkingLevel"]) {
    assert.match(functionBody(bridge, name), /if \(!ready \|\| active \|\| modelActionPending \|\| resourceActionPending\) return false/, `${name} must refuse while a run or another change is active`);
  }
  assert.match(functionBody(bridge, "selectModel"), /provider === currentProvider && modelId === currentModelId\) return false/);
  assert.match(functionBody(bridge, "compactContext"), /if \(!ready \|\| active \|\| compacting\) return false/);
  assert.match(functionBody(bridge, "compactContext"), /boundedText\(instructions\.trim\(\), 1024\)/);
  assert.equal(LIMITS.maxCompactionInstructionCharacters, 1024);
  assert.match(bridge, /case "pi\.exit":[\s\S]*modelActionPending = false[\s\S]*compacting = false/);

  assert.match(functionBody(shell, "composerPickerOpen"), /pickerDialogItem\.opened \|\| composerMenuDropUpItem\.opened \|\| modelDropUpItem\.opened \|\| thinkingDropUpItem\.opened/);
  assert.match(functionBody(shell, "openModelPicker"), /if \(!bridge\.ready \|\| bridge\.active \|\| bridge\.modelActionPending \|\| bridge\.resourceActionPending \|\| composerPickerOpen\(\)\) return false/);
  assert.match(functionBody(shell, "invalidateComposerPickers"), /composerPickerGeneration\+\+[\s\S]*modelPickerLoading = false[\s\S]*thinkingPickerLoading = false[\s\S]*modelDropUpItem\.close\(\)[\s\S]*thinkingDropUpItem\.close\(\)/);
  assert.match(functionBody(shell, "openModelPicker"), /const originTab = bridge\.activeTabId[\s\S]*const generation = \+\+composerPickerGeneration[\s\S]*bridge\.loadModels\(response => root\.modelPickerResult\(originTab, generation, response\)\)/);
  assert.match(functionBody(shell, "openThinkingPicker"), /const originTab = bridge\.activeTabId[\s\S]*const generation = \+\+composerPickerGeneration[\s\S]*bridge\.loadThinkingLevels\(response => root\.thinkingPickerResult\(originTab, generation, response\)\)/);
  for (const name of ["modelPickerResult", "thinkingPickerResult"]) {
    const result = functionBody(shell, name);
    assert.match(result, /generation !== composerPickerGeneration/);
    assert.match(result, /!bridge\.ready \|\| bridge\.active \|\| bridge\.activeTabId !== originTab/);
    assert.match(result, /\.present\(/);
  }
  assert.match(shell, /function onReadyChanged\(\)[\s\S]*if \(!bridge\.ready\)[\s\S]*root\.invalidateComposerPickers\(\)/);
  assert.match(shell, /function onActiveChanged\(\)[\s\S]*if \(bridge\.active\) root\.invalidateComposerPickers\(\)/);
  assert.match(shell, /function onTabSwitched\(tabId\)[\s\S]*root\.invalidateComposerPickers\(\)/);
  assert.match(functionBody(shell, "modelPicked"), /bridge\.activeTabId !== modelPickerTabId[\s\S]*modelPickerGeneration !== composerPickerGeneration[\s\S]*bridge\.selectModel\(value\.slice\(0, slash\), value\.slice\(slash \+ 1\)\)/);
  assert.match(functionBody(shell, "thinkingPicked"), /bridge\.activeTabId !== thinkingPickerTabId[\s\S]*thinkingPickerGeneration !== composerPickerGeneration[\s\S]*bridge\.setThinkingLevel\(value\)/);

  assert.match(dropUpPicker, /^Popup \{/m);
  assert.match(dropUpPicker, /modal:\s*false/);
  assert.match(dropUpPicker, /closePolicy:\s*Popup\.CloseOnEscape \| Popup\.CloseOnPressOutside/);
  assert.match(dropUpPicker, /readonly property real dropUpAvailableHeight:\s*Math\.max\(0, anchorPosition\.y - edgeMargin - anchorGap\)/);
  assert.match(dropUpPicker, /height:\s*Math\.min\(implicitHeight, maximumHeight, dropUpAvailableHeight\)/);
  assert.match(dropUpPicker, /x:\s*Math\.max\(edgeMargin, Math\.min\(anchorPosition\.x, boundsItem\.width - width - edgeMargin\)\)/);
  assert.match(dropUpPicker, /y:\s*Math\.max\(edgeMargin, anchorPosition\.y - height - anchorGap\)/);
  assert.match(dropUpPicker, /onClosed:[\s\S]*returnFocusItem\.forceActiveFocus\(\)/);
  assert.match(dropUpPicker, /keyNavigationEnabled:\s*true/);
  const listKeys = functionBody(dropUpPicker, "handleOptionListKey");
  assert.match(listKeys, /Qt\.Key_Down[\s\S]*moveSelection\(1\)/);
  assert.match(listKeys, /Qt\.Key_Up[\s\S]*moveSelection\(-1\)/);
  assert.match(listKeys, /Qt\.Key_Return \|\| key === Qt\.Key_Enter \|\| key === Qt\.Key_Space[\s\S]*pickCurrent\(\)/);
  assert.match(dropUpPicker, /Keys\.onPressed:\s*event => \{[\s\S]*popup\.handleOptionListKey\(event\.key, event\.modifiers\)[\s\S]*event\.accepted = true/);
  assert.match(dropUpPicker, /currentIndex:\s*popup\.currentIndex/);
  assert.doesNotMatch(functionBody(dropUpPicker, "filterItems"), /picked\(/, "filtering must never pick");
  assert.doesNotMatch(functionBody(dropUpPicker, "moveSelection"), /picked\(/, "navigation must never pick");
  assert.match(functionBody(dropUpPicker, "pickIndex"), /picked\(value\)[\s\S]*close\(\)/);
  assert.match(dropUpPicker, /Accessible\.role:\s*Accessible\.ListItem/);
  assert.match(dropUpPicker, /Accessible\.selected:\s*index === popup\.currentIndex/);
  assert.match(dropUpPicker, /\(current \? ", current" : ""\)/);
  assert.match(statusBadge, /property real horizontalPadding:\s*theme\.spaceLg/);
  assert.match(statusBadge, /property real verticalPadding:\s*theme\.spaceLg \/ 2/);
  assert.match(statusBadge, /implicitWidth:\s*label\.implicitWidth \+ 2 \* horizontalPadding/);
  assert.match(statusBadge, /implicitHeight:\s*label\.implicitHeight \+ 2 \* verticalPadding/);
  const currentBadge = objectBodyContaining(dropUpPicker, "StatusBadge", 'text: "current"');
  assert.match(currentBadge, /horizontalPadding:\s*popup\.theme\.spaceMd/);
  assert.match(currentBadge, /verticalPadding:\s*popup\.theme\.spaceXxs/);
  assert.match(currentBadge, /Layout\.alignment:\s*Qt\.AlignVCenter/);
  assert.doesNotMatch(pickerDialog, /horizontalPadding:\s*dialog\.theme\.|verticalPadding:\s*dialog\.theme\./, "generic picker badges keep the shared defaults");
  assert.match(dropUpPicker, /HoverHandler\s*\{[\s\S]*Qt\.PointingHandCursor/);
  assert.match(shell, /DropUpPicker\s*\{[\s\S]*id:\s*modelDropUpItem[\s\S]*anchorItem:\s*modelButton[\s\S]*returnFocusItem:\s*modelButton/);
  assert.match(shell, /DropUpPicker\s*\{[\s\S]*id:\s*thinkingDropUpItem[\s\S]*anchorItem:\s*thinkingButton[\s\S]*returnFocusItem:\s*thinkingButton/);
  assert.match(shell, /enabled:\s*bridge\.ready && !bridge\.active && !bridge\.modelActionPending/);
  assert.match(fixture, /"get_available_models"/);
  assert.match(fixture, /"cycle_thinking_level"/);
  assert.match(fixture, /__QT_WEBUI_COMPACT_FAIL__/);
});

test("explicit scoped-model ordering is exact, bounded, filter-safe, persistent, and wired without selecting", () => {
  assert.match(bridge, /property var modelOrder:\s*\[\]/);
  assert.match(functionBody(bridge, "applySettings"), /Array\.isArray\(settings\.modelOrder\)[\s\S]*settings\.modelOrder\.slice\(0, maxModels\)/);
  const applyOrder = functionBody(bridge, "orderedModelData");
  assert.match(applyOrder, /data\.scope\.explicit !== true/);
  assert.match(applyOrder, /String\(model\.provider\) \+ "\/" \+ String\(model\.id\)/);
  assert.match(applyOrder, /for \(const identity of modelOrder\)[\s\S]*ordered\.push\(byIdentity\[identity\]\)[\s\S]*for \(const model of data\.models\)/);
  const merge = functionBody(bridge, "mergedModelOrder");
  assert.match(merge, /for \(const value of Array\.isArray\(currentIdentities\)/);
  assert.match(merge, /merged\.length >= maxModels/);
  assert.match(merge, /for \(const value of modelOrder\)/);
  assert(merge.indexOf("for (const value of modelOrder)") > merge.indexOf("for (const value of Array.isArray(currentIdentities)"), "current scope identities must be merged before absent saved identities");
  assert.match(functionBody(bridge, "saveModelOrder"), /request\("settings_set", \{ "values": \{ "modelOrder": merged \} \}/);
  assert.match(functionBody(bridge, "loadModels"), /response\.data = orderedModelData\(response\.data\)[\s\S]*modelsLoaded\(response\.data\)/);

  assert.match(dropUpPicker, /property bool reorderable:\s*false/);
  assert.match(dropUpPicker, /readonly property bool reorderEnabled:\s*reorderable && items\.length >= 2 && String\(filter \|\| ""\)\.trim\(\)\.length === 0/);
  assert.match(dropUpPicker, /signal reordered\(var values\)/);
  const moveItem = functionBody(dropUpPicker, "moveItem");
  assert.match(moveItem, /const selectedValue =/);
  assert.match(moveItem, /reorderedItems\.splice\(fromIndex, 1\)/);
  assert.match(moveItem, /items = reorderedItems[\s\S]*currentIndex = index[\s\S]*reordered\(reorderedItems\.map/);
  assert.doesNotMatch(moveItem, /picked\(|close\(\)/, "reordering must not select or close");
  const reorderKey = functionBody(dropUpPicker, "handleReorderKey");
  assert.match(reorderKey, /Qt\.ControlModifier[\s\S]*Qt\.ShiftModifier/);
  assert.match(reorderKey, /Qt\.Key_Up[\s\S]*Qt\.Key_Down/);
  assert.match(dropUpPicker, /DragHandler\s*\{[\s\S]*id:\s*reorderDrag[\s\S]*target:\s*null[\s\S]*popup\.finishDrag\(\)/);
  assert.match(dropUpPicker, /onTranslationChanged:[^\n]*optionRow\.y \+ optionRow\.height \/ 2 \+ translation\.y \+ optionList\.contentY - popup\.dragStartContentY/);
  const dragTarget = functionBody(dropUpPicker, "updateDragTarget");
  assert.match(dragTarget, /centerY <= optionList\.contentY/);
  assert.match(dragTarget, /centerY >= optionList\.contentY \+ optionList\.height/);
  const dragScrollStep = functionBody(dropUpPicker, "dragScrollStep");
  assert.match(dragScrollStep, /centerY - optionList\.contentY/);
  assert.match(dragScrollStep, /optionList\.contentHeight - optionList\.height/);
  assert.match(dropUpPicker, /Timer\s*\{[\s\S]*id:\s*dragAutoScrollTimer[\s\S]*interval:\s*16[\s\S]*running:\s*popup\.dragScrollStep\(popup\.dragCenterY\) !== 0[\s\S]*popup\.scrollDraggedItem\(\)/);
  assert.match(dropUpPicker, /onContentYChanged:\s*popup\.handleDragContentYChanged\(\)/, "wheel and edge scrolling must keep the dragged row under the pointer");
  assert.match(dropUpPicker, /y:\s*reorderDrag\.active \? reorderDrag\.translation\.y \+ optionList\.contentY - popup\.dragStartContentY : 0/);
  assert.match(dropUpPicker, /text:\s*"≡"/);
  assert.match(dropUpPicker, /Accessible\.description:[^\n]*Ctrl\+Shift\+Up or Ctrl\+Shift\+Down/);

  const modelResult = functionBody(shell, "modelPickerResult");
  assert.match(modelResult, /response\.data\.scope && response\.data\.scope\.explicit === true && items\.length >= 2/);
  assert.match(modelResult, /reorderable: reorderable/);
  const reorderWiring = functionBody(shell, "modelsReordered");
  assert.match(reorderWiring, /bridge\.activeTabId !== modelPickerTabId[\s\S]*modelPickerGeneration !== composerPickerGeneration/);
  assert.match(reorderWiring, /identities\.length !== modelDropUpItem\.items\.length/);
  assert.match(reorderWiring, /bridge\.saveModelOrder\(identities\)/);
  assert.match(shell, /onReordered:\s*values => root\.modelsReordered\(values\)/);
  for (const marker of ["QT_WEBUI_SMOKE_MODEL_REORDER_COMPLETED", "QT_WEBUI_SMOKE_MODEL_REORDER_SAVED", "QT_WEBUI_SMOKE_MODEL_REORDER_REAPPLIED"]) assert.match(smoke, new RegExp(marker));
});

test("resource profiles expose explicit scopes, inheritance, enabled names, supported sampling, and fail-closed controls", () => {
  for (const name of ["refreshResources", "setEnabledTools", "setEnabledSkills", "setSampling", "setResourceProfile", "applyResourceState"]) {
    assert.match(bridge, new RegExp(`function ${name}\\(`), `bridge should implement ${name}`);
  }
  assert.match(functionBody(bridge, "refreshResources"), /if \(!ready \|\| active \|\| resourceLoading \|\| resourceActionPending \|\| modelActionPending\)/);
  assert.match(functionBody(bridge, "refreshResources"), /request\("resources_state"/);
  for (const type of ["resources_state", "tools_set", "skills_set", "sampling_set", "model_set", "thinking_set"]) {
    assert.match(bridge, new RegExp(`"${type}": true`), `${type} callbacks must remain bound to their originating tab`);
  }
  const mutation = functionBody(bridge, "setResourceProfile");
  assert.match(mutation, /!resourcesAvailable/);
  assert.match(mutation, /if \(type === "tools_set"\) request\("tools_set"/);
  assert.match(mutation, /type === "skills_set"\) request\("skills_set"/);
  assert.match(mutation, /request\("sampling_set"/);
  assert.match(mutation, /sessionDurability\.durable === false/);
  assert.match(mutation, /postNotice\("warning"/);
  assert.match(functionBody(bridge, "setEnabledTools"), /"enabledTools"/);
  assert.match(functionBody(bridge, "setEnabledSkills"), /"enabledSkills"/);
  assert.doesNotMatch(bridge, /disabledSkills/, "the public bridge sends enabled skills only");
  for (const name of ["selectModel", "cycleModel", "setThinkingLevel", "cycleThinkingLevel"]) {
    assert.match(functionBody(bridge, name), /applyResourceState\(response\.data\.resources\)/, `${name} applies the backend's freshly resolved resources`);
  }
  assert.match(functionBody(bridge, "applySnapshot"), /resourceLoading = Object\.values\(pendingRequests\)\.some\(entry => entry\.type === "resources_state" && entry\.originTab === activeTabId\)/, "a selection snapshot retains its in-flight resource read");
  assert.match(functionBody(bridge, "applySnapshot"), /applyTabSummary\(data\.tab, false\)[\s\S]*if \(ready\)[\s\S]*bridge\.refreshResources\(\)/, "tab snapshots refresh resources only with projected readiness");
  assert.match(functionBody(bridge, "applyTabSummary"), /ready = tab\.ready === true[\s\S]*if \(refreshOnReady && !wasReady && ready\)/, "tab updates apply effective readiness before refreshing resources");
  assert.match(functionBody(bridge, "applyTabSummary"), /if \(tab\.ready === true && tab\.mutating !== true\)[\s\S]*sessionFile =/, "transition targets cannot change the editor's conversation identity");
  assert.match(bridge, /case "tabs\.update":[\s\S]*applyTabSummary\(tabById\(activeTabId\), !selectionChanged\)/, "resume completion updates active controls without duplicate selection refreshes");
  assert.match(functionBody(bridge, "resetTabState"), /resourceState = null/);
  assert.match(functionBody(bridge, "handleEvent"), /case "resources\.changed":[\s\S]*applyResourceState\(event\.state\)/);
  assert.match(bridge, new RegExp(`readonly property int maxResourceNames:\\s*${LIMITS.maxResourceNames}\\b`));

  assert.match(resourceProfilesDialog, /^AppDialog \{/m);
  assert.match(resourceProfilesDialog, /property string scope: "session"/);
  assert.match(resourceProfilesDialog, /property string section: "tools"/);
  assert.match(resourceProfilesDialog, /\["session", "model", "global"\]/);
  assert.match(resourceProfilesDialog, /\["tools", "skills", "sampling"\]/);
  const visibleListDraft = functionBody(resourceProfilesDialog, "visibleListDraft");
  assert.match(visibleListDraft, /if \(listMode === "inherit"\) return null/);
  assert.match(visibleListDraft, /for \(const item of visibleInventory\)/);
  assert.match(visibleListDraft, /visibleNames\.indexOf\(String\(name\)\) !== -1/);
  assert.match(visibleListDraft, /slice\(0, bridge\.maxResourceNames\)/);
  const runVisibleListDraft = new Function("listMode", "visibleInventory", "listDraft", "bridge", visibleListDraft);
  assert.equal(runVisibleListDraft("inherit", [{ name: "read" }], ["read", "temporarily-unavailable"], { maxResourceNames: LIMITS.maxResourceNames }), null);
  assert.deepEqual(runVisibleListDraft("custom", [{ name: "read" }, { name: "write" }], ["read", "temporarily-unavailable"], { maxResourceNames: LIMITS.maxResourceNames }), ["read"]);
  assert.deepEqual(runVisibleListDraft("custom", [{ name: "read" }], [], { maxResourceNames: LIMITS.maxResourceNames }), [], "intentional none remains distinct after filtering");
  const saveCurrent = functionBody(resourceProfilesDialog, "saveCurrent");
  assert.match(saveCurrent, /setEnabledTools\(scope, visibleListDraft\(\), callback\)/);
  assert.match(saveCurrent, /setEnabledSkills\(scope, visibleListDraft\(\), callback\)/);
  assert.doesNotMatch(saveCurrent, /listDraft\.slice\(\)/, "the dialog must not submit unavailable configured names");
  assert.match(functionBody(resourceProfilesDialog, "chooseNone"), /listMode = "custom"[\s\S]*listDraft = \[\]/, "none is distinct from inherit");
  assert.match(functionBody(resourceProfilesDialog, "chooseInherit"), /listMode = "inherit"/);
  assert.match(functionBody(resourceProfilesDialog, "effectiveSource"), /field \+ "Source"/);
  assert.match(functionBody(resourceProfilesDialog, "listSummary"), /"Pi defaults"[\s\S]*"Intentionally none"/);
  assert.match(resourceProfilesDialog, /Effective " \+ dialog\.section[\s\S]*source:/);
  assert.match(resourceProfilesDialog, /Stored here: intentionally none/);
  assert.match(resourceProfilesDialog, /visibleInventory: inventoryForSection\(\)\.slice\(0, bridge\.maxResourceNames\)/);
  assert.match(resourceProfilesDialog, /Accessible\.role: Accessible\.CheckBox/);
  assert.match(resourceProfilesDialog, /Accessible\.checked: checked/);
  assert.match(resourceProfilesDialog, /Accessible\.role: Accessible\.PageTab/);
  assert.match(resourceProfilesDialog, /Accessible\.selected: active/);
  assert.match(resourceProfilesDialog, /enabled: dialog\.controlsEnabled/);
  assert.match(resourceProfilesDialog, /available && bridge\.ready && !bridge\.active/);
  assert.match(resourceProfilesDialog, /Pi is working\. Resource controls stay disabled/);
  assert.match(resourceProfilesDialog, /sessionDurability\.durable === false/);
  assert.match(resourceProfilesDialog, /not saved durably/);
  assert.match(resourceProfilesDialog, /Unsupported stored values remain saved but are not sent to the provider|Unsupported stored values remain saved/i);
  assert.match(resourceProfilesDialog, /enabled: dialog\.controlsEnabled && samplingRow\.supported/);
  assert.match(resourceProfilesDialog, /dialog\.samplingReason\(samplingRow\.modelData\)/);
  assert.match(resourceProfilesDialog, /stored here: " \+ stored \+ " \(preserved\)"/);
  for (const key of ["temperature", "top_p", "frequency_penalty", "presence_penalty", "seed", "top_k", "min_p"]) assert(resourceProfilesDialog.includes(key), `sampling control ${key}`);
  assert.match(shell, /ResourceProfilesDialog\s*\{[\s\S]*returnFocusItem:\s*composer/);
  assert.match(functionBody(shell, "openResourceProfiles"), /!bridge\.ready \|\| bridge\.active \|\| bridge\.modelActionPending \|\| bridge\.resourceActionPending/);
  assert.match(functionBody(shell, "runPaletteAction"), /case "resource-profiles": return root\.openResourceProfiles\(\)/);
});

test("untrusted content renders as plain or whitelisted styled text and links open only after confirmation", () => {
  for (const [name, source] of Object.entries(components)) {
    assert.doesNotMatch(source, /Text\.MarkdownText|TextEdit\.MarkdownText|Text\.AutoText|TextEdit\.AutoText/, `${name} must not auto-parse untrusted text`);
    if (name !== "blocks") assert.doesNotMatch(source, /Text\.RichText|TextEdit\.RichText/, `${name} must not use rich text formats`);
  }
  assert.equal((blocks.match(/textFormat:\s*TextEdit\.RichText/g) ?? []).length, 6, "only the six backend-sanitized styled editors use RichText");
  assert.doesNotMatch(blocks, /textFormat:\s*TextEdit\.StyledText/, "TextEdit has no StyledText enum value");
  assert.match(blocks, /TextEdit\s*\{[\s\S]*textFormat:\s*TextEdit\.PlainText[\s\S]*readOnly:\s*true/);
  assert.match(blocks, /onLinkActivated:\s*link\s*=>\s*root\.linkActivated\(link\)/);
  assert.doesNotMatch(blocks, /Qt\.openUrlExternally/);
  assert.match(functionBody(blocks, "parseBlocks"), /JSON\.parse\(json\)/);
  assert.match(functionBody(blocks, "parseBlocks"), /catch \(error\)/);
  assert.match(linkDialog, /function accept\(\)[\s\S]*bridge\.openLink\(target/);
  assert.match(linkDialog, /initialFocusItem:\s*cancelButton/);
  const userOutput = objectBodyWithId(row, "TextEdit", "userMessageLabel");
  assert.match(userOutput, /visible:\s*row\.kind === "user"/);
  assert.match(userOutput, /textFormat:\s*TextEdit\.PlainText/);
  const selectableEditors = [
    [row, "userMessageLabel"],
    [blocks, "paragraphLabel"], [blocks, "headingLabel"], [blocks, "highlightedCodeLabel"],
    [blocks, "plainCodeEdit"], [blocks, "itemLabel"], [blocks, "cellLabel"],
    [blocks, "droppedLabel"], [blocks, "noticeLabel"],
    [toolCard, "toolErrorLabel"], [toolCard, "outputEdit"],
  ];
  for (const [source, id] of selectableEditors) {
    const editor = objectBodyWithId(source, "TextEdit", id);
    assert.match(editor, /readOnly:\s*true/, `${id} should stay read-only`);
    assert.match(editor, /selectByMouse:\s*true/, `${id} should support pointer selection`);
    assert.match(editor, /selectByKeyboard:\s*true/, `${id} should support keyboard selection`);
    assert.match(editor, /selectionColor:\s*\w+\.theme\.selection/, `${id} should use the theme selection color`);
    assert.match(editor, /selectedTextColor:\s*\w+\.theme\.selectionForeground/, `${id} should keep selected text readable`);
  }
  const transcriptMarkdown = objectBodyContaining(row, "MarkdownBlocks", "visible: row.kind === \"text\" || row.kind === \"thinking\"");
  assert.match(transcriptMarkdown, /blocksJson:\s*row\.kind === "text" \|\| row\.kind === "thinking" \? row\.blocksJson : "\[\]"/);
  assert.match(transcriptMarkdown, /foregroundColor:\s*row\.kind === "thinking" \? row\.theme\.thinkingForeground : row\.theme\.foreground/);
  assert.match(transcriptMarkdown, /italic:\s*row\.kind === "thinking"/);
  for (const roleName of ["rowId", "messageId", "role", "kind", "text", "blocksJson", "truncated", "streaming", "modeLabel", "attachments", "toolName", "toolSummary", "toolStatus", "toolDurationMs", "toolOutput", "toolError"]) {
    assert.match(row, new RegExp(`required property \\w+ ${roleName}\\b`), `TranscriptRow should require ${roleName}`);
  }
  const contextLabel = objectBodyContaining(shell, "SelectableText", "text: bridge.displayCwd");
  assert.match(contextLabel, /theme:\s*appTheme/);
  assert.match(selectableText, /textFormat:\s*TextEdit\.PlainText/);
  assert.match(functionBody(bridge, "handleExtensionStatus"), /indexOf\("cwd "\) === 0\) continue/, "the cd status repeats the header");
  assert.match(functionBody(bridge, "handleExtensionStatus"), /name\.indexOf\("git-footer"\) === 0 && name !== "git-footer-webui"\) continue/);
  assert.match(functionBody(bridge, "handleExtensionStatus"), /shownLabel/);
  assert.match(functionBody(shell, "groupStatusChips"), /add\("Extensions", entry\)/);
  assert.match(toolCard, /TextEdit\s*\{[\s\S]*textFormat:\s*TextEdit\.PlainText/);
  assert.match(fixture, /toolName: "<b>read<\/b>"/);
  assert.match(fixture, /<script>alert\(1\)<\/script>/);
});

test("shared selectable text keeps one native PlainText selection layout", () => {
  assert.match(selectableText, /^Item \{/m);
  assert.match(selectableText, /property string text:\s*""/);
  assert.match(selectableText, /TextEdit\s*\{[\s\S]*text:\s*root\.text[\s\S]*textFormat:\s*TextEdit\.PlainText[\s\S]*readOnly:\s*true/);
  assert.match(selectableText, /selectByMouse:\s*true[\s\S]*selectByKeyboard:\s*true/);
  assert.match(selectableText, /selectionColor:\s*root\.theme\.selection[\s\S]*selectedTextColor:\s*root\.theme\.selectionForeground/);
  assert.match(selectableText, /clip:\s*true/);
  assert.doesNotMatch(selectableText, /Label\s*\{/, "one editor owns both glyph and selection layout so selection cannot ghost a separately elided label");
  assert.match(selectableText, /maximumLineCount > 0[\s\S]*Math\.min\(editor\.contentHeight, maximumLineCount \* oneLineHeight\)/, "wrapped fields bound their visible editor without changing its source");
  assert.match(selectableText, /TapHandler\s*\{[\s\S]*gesturePolicy:\s*TapHandler\.DragThreshold[\s\S]*root\.tapped\(\)/, "text taps can share row actions without treating a drag as a click");
  assert.doesNotMatch(selectableText, /RichText|MarkdownText|AutoText|Quickshell\.clipboardText|copyToClipboard/, "the shared surface never parses or writes text outside a user copy gesture");
  for (const source of [shell, sessionList, statusOverlay, noticeBar, statusBadge, toolCard, emptyState, workingIndicator]) {
    assert.match(source, /SelectableText\s*\{/, "readable main-window status, error, notice, heading, or detail text should use the shared surface");
  }
});

test("dialogs and interactive rows use PlainText selection without accidental activation", () => {
  for (const [name, source] of [["app dialog", appDialog], ["confirmation", confirmDialog], ["extension", extensionDialog], ["picker", pickerDialog], ["directory", directoryDialog], ["events", eventsDialog], ["resources", resourceProfilesDialog], ["sequences", sequencesDialog], ["text editor", textEditDialog], ["worktree", worktreeDialog], ["composer", composer], ["completion", completionPopup], ["drop-up", dropUpPicker], ["tabs", tabStrip]]) {
    assert.match(source, /SelectableText\s*\{/, `${name} exposes its readable text through the shared PlainText selector`);
    assert.doesNotMatch(source, /textFormat:\s*Text\.(RichText|StyledText|AutoText)/, `${name} does not widen its text format policy`);
  }
  assert.match(appDialog, /height:\s*Math\.min\(implicitHeight, parent \? Math\.max\(0, parent\.height - theme\.space4Xl - theme\.space2Xl\)/, "dialogs fit the actual overlay height");
  assert.match(appDialog, /Flickable\s*\{[\s\S]*id:\s*bodyViewport[\s\S]*SelectableText\s*\{[\s\S]*text:\s*dialog\.title[\s\S]*SelectableText\s*\{[\s\S]*text:\s*dialog\.message/, "full plain-text titles and messages scroll in the body");
  assert.match(appDialog, /property alias actions:\s*actionArea\.data/, "action controls do not scroll with the question");
  assert.match(linkDialog, /TextEdit\s*\{[\s\S]*textFormat:\s*TextEdit\.PlainText[\s\S]*readOnly:\s*true[\s\S]*selectByMouse:\s*true[\s\S]*selectByKeyboard:\s*true/, "link confirmation keeps its full address in a keyboard-copyable native PlainText editor");
  assert.match(composer, /SelectableText\s*\{[\s\S]*chip\.modelData\.name[\s\S]*SelectableText\s*\{[\s\S]*composer\.sizeLabel/, "attachment names and metadata remain readable without changing Edit or Remove actions");

  for (const [name, source, rowId, action] of [["completion", completionPopup, "entry", "popup.accepted"], ["drop-up", dropUpPicker, "optionRow", "popup.pickCurrent"], ["picker", pickerDialog, "optionRow", "dialog.pickCurrent"], ["extension", extensionDialog, "optionRow", "dialog.selectCurrent"], ["tabs", tabStrip, "tabItem", "strip.selectRequested"]]) {
    const row = objectBodyWithId(source, "Rectangle", rowId);
    assert.match(row, /function activateRow\(\)/, `${name} keeps normal row activation explicit`);
    assert.match(row, new RegExp(action.replace(".", "\\.") + "\\("), `${name} retains its existing click action`);
    assert.match(row, /TapHandler\s*\{[\s\S]*acceptedButtons:\s*Qt\.LeftButton[\s\S]*gesturePolicy:\s*TapHandler\.DragThreshold[\s\S]*onTapped:\s*\w+\.activateRow\(\)/, `${name} separates a tap from a selection drag`);
    assert.match(row, /SelectableText\s*\{[\s\S]*onTapped:\s*\w+\.activateRow\(\)/, `${name} only activates on a text tap, never on a selection drag`);
  }
  for (const [name, source] of [["directory", directoryDialog], ["events", eventsDialog], ["sequences", sequencesDialog]]) {
    assert.match(source, /TapHandler\s*\{[\s\S]*gesturePolicy:\s*TapHandler\.DragThreshold/, `${name} metadata rows preserve native drag selection`);
  }
  const directoryRow = objectBodyWithId(directoryDialog, "Rectangle", "entryRow");
  assert.match(functionBody(directoryRow, "tapHitsText"), /entryLabel\.mapFromItem\(entryRow,[\s\S]*entryLabel\.contains/, "directory rows distinguish selectable text geometry from blank-card activation");
  assert.match(directoryRow, /onDoubleTapped:\s*eventPoint\s*=>\s*\{[\s\S]*tapHitsText\(eventPoint\)\) return[\s\S]*dialog\.enterCurrent\(\)/, "directory double-click navigation remains available only outside selectable text");
  assert.doesNotMatch(functionBody(composer, "acceptCompletion"), /trySend|sendRequested/, "completion acceptance still only edits the prompt");
  assert.doesNotMatch(functionBody(pickerDialog, "moveSelection"), /pick/, "picker navigation stays non-selecting");
  assert.doesNotMatch(functionBody(dropUpPicker, "moveSelection"), /pick/, "drop-up navigation stays non-selecting");
});

test("composer exposes send, a steer/follow-up toggle, abort, and restart with keyboard paths", () => {
  assert.match(composer, /color:\s*theme\.composerSurface/);
  assert.match(composer, /border\.width:\s*theme\.borderWidth/);
  assert.match(composer, /id:\s*prompt[\s\S]*font\.family:\s*composer\.theme\.monospaceFamily/);
  assert.match(composer, /border\.color:\s*prompt\.activeFocus \? theme\.focusRing : theme\.composerBorder/);
  assert.doesNotMatch(composer, /MultiEffect|shadowEnabled|shadowColor/, "the composer stays flat and shadow-free");
  assert.match(composer, /id:\s*chip[\s\S]*width:\s*Math\.min\(implicitWidth, parent \? parent\.width : implicitWidth\)/);
  assert.match(composer, /id:\s*chipRow[\s\S]*anchors\.left:\s*parent\.left[\s\S]*anchors\.right:\s*parent\.right/);
  assert.match(composer, /Layout\.fillWidth:\s*true[\s\S]*Layout\.minimumWidth:\s*48[\s\S]*Layout\.maximumWidth:\s*240/);
  assert.match(composer, /signal sendRequested\(string text, string mode\)/);
  assert.match(composer, /property string busyPromptMode:\s*"steer"/);
  assert.match(functionBody(composer, "toggleBusyPromptMode"), /busyPromptMode = busyPromptMode === "steer" \? "followUp" : "steer"/);
  assert.match(composer, /composer\.trySend\(composer\.active \? composer\.busyPromptMode : "send"\)/);
  assert.match(composer, /composer\.trySend\(composer\.active \? "followUp" : "send"\)/);
  const modeButton = objectBodyContaining(composer, "AppButton", "id: busyPromptModeButton");
  assert.match(modeButton, /visible:\s*composer\.ready/);
  assert.match(modeButton, /text:\s*composer\.busyPromptMode === "steer" \? "Steer mode" : "Follow-up mode"/);
  assert.match(modeButton, /Accessible\.checked:\s*composer\.busyPromptMode === "followUp"/);
  assert.match(modeButton, /onClicked:\s*composer\.toggleBusyPromptMode\(\)/);
  const modeAction = objectBodyContaining(composer, "AppButton", "id: busyPromptActionButton");
  assert.match(modeAction, /visible:\s*composer\.active && composer\.ready/);
  assert.match(modeAction, /text:\s*composer\.busyPromptMode === "steer" \? "Steer" : "Queue"/);
  assert.match(modeAction, /onClicked:\s*composer\.trySend\(composer\.busyPromptMode\)/);
  const attachButton = objectBodyContaining(composer, "AppButton", "id: attachButton");
  assert.match(attachButton, /text:\s*"📎"/);
  assert.match(attachButton, /accessibleName:\s*"Attach files"/);
  assert.match(attachButton, /Layout\.preferredWidth:\s*composer\.theme\.controlHeight/);
  assert.match(composer, /id:\s*attachButton[\s\S]*?onClicked:\s*composer\.attachRequested\(\)[\s\S]*?}\n\n\s*AppButton\s*{\s*id:\s*primaryButton/, "Attach should sit immediately before the primary Send control");
  assert.match(composer, /event\.modifiers & Qt\.ShiftModifier\) return/, "Shift+Enter must insert a new line");
  assert.match(composer, /Enter to send · Shift\+Enter for a new line/);
  assert.match(composer, /text:\s*composer\.active \? "Abort" : \(composer\.ready \? "Send" : "Restart"\)/);
  assert.match(composer, /enabled:\s*composer\.ready\b/);
  assert.match(composer, /overLimit/);
  assert.match(functionBody(composer, "trySend"), /if \(mode === "send" && active\) return/);
  assert.match(functionBody(bridge, "sendPrompt"), /promptMode === "send" && active/);
  assert.match(functionBody(bridge, "sendPrompt"), /message\.length > maxMessageCharacters/);
});

test("composer completion, attachments, drafts, and sequences never send by accident and stay bounded", () => {
  // Highlighted code keeps theme-owned syntax colors while remaining directly selectable.
  assert.match(blocks, /property bool highlight:\s*true/);
  assert.match(functionBody(blocks, "styledCode"), /"<pre>"/);
  assert.match(functionBody(blocks, "styledCode"), /theme\.syntaxColor\(kind\)/);
  assert.doesNotMatch(functionBody(blocks, "styledCode"), /#[0-9a-fA-F]{3,8}\b/);
  assert.match(blocks, /readonly property bool highlighted:\s*root\.highlight && hasTokens/);
  assert.doesNotMatch(blocks, /"Select text"|property bool selectable/);
  assert.match(blocks, /onClicked:\s*root\.copyRequested\(block\.text \|\| ""\)/);
  assert.match(theme, /function syntaxColor\(kind\)/);
  for (const token of ["syntaxKeyword", "syntaxString", "syntaxComment", "syntaxNumber", "syntaxType", "syntaxFunction", "diffAdded", "diffRemoved"]) {
    assert.match(theme, new RegExp(`readonly property color ${token}\\b`), `theme token ${token}`);
  }
  assert.match(bridge, /property bool syntaxHighlighting:\s*true/);
  assert.match(shell, /highlightCode:\s*bridge\.syntaxHighlighting/);

  // Completion: accepting edits the text and never calls trySend or sendRequested.
  const accept = functionBody(composer, "acceptCompletion");
  assert.doesNotMatch(accept, /trySend|sendRequested/);
  assert.match(accept, /"\/" \+ String\(item\.value\) \+ " "/);
  assert.match(accept, /"@" \+ String\(item\.value\) \+ \(item\.directory === true \? "\/" : " "\)/);
  assert.match(composer, /if \(composer\.completionOpen\) \{[\s\S]*Qt\.Key_Down[\s\S]*Qt\.Key_Up[\s\S]*Qt\.Key_Escape[\s\S]*Qt\.Key_Tab \|\| event\.key === Qt\.Key_Return[\s\S]*acceptCurrentCompletion\(\)[\s\S]*event\.accepted = true[\s\S]*return/);
  assert.match(functionBody(composer, "completionContext"), /kind: "command"/);
  assert.match(functionBody(composer, "completionContext"), /token\.startsWith\("@"\)/);
  assert.match(completionPopup, /Accessible\.role:\s*Accessible\.List/);
  assert.match(completionPopup, /Accessible\.selected:\s*index === popup\.currentIndex/);
  assert.doesNotMatch(completionPopup, /sendRequested|trySend/);
  assert.match(functionBody(shell, "commandSuggestions"), /if \(items\.length >= 50\) break/);
  assert.match(shell, /Timer\s*\{[\s\S]*id:\s*pathCompletionTimer[\s\S]*interval:\s*120/);

  // Attachments: ids travel with the prompt, chips expose names and removal, the picker grants outside paths.
  assert.match(functionBody(bridge, "sendPrompt"), /"attachments": attachmentIds/);
  assert.match(functionBody(bridge, "reconcilePromptAttachments"), /Array\.isArray\(consumed\)/);
  assert.match(shell, /FileDialog\s*\{[\s\S]*fileMode:\s*FileDialog\.OpenFiles[\s\S]*bridge\.addAttachment\(root\.urlToPath\(url\), true\)/);
  assert.match(composer, /accessibleName:\s*"Remove attachment " \+ String\(chip\.modelData\.name\)/);
  assert.match(composer, /enabled:\s*composer\.attachments\.length < composer\.maxAttachments/);
  assert.match(objectBodyWithId(shell, "Composer", "composer"), /maxAttachments:\s*bridge\.maxAttachments/);
  assert.equal(LIMITS.maxAttachments, 8);
  assert.match(row, /text:\s*"Attached: " \+ row\.attachments/);
  assert.match(textEditDialog, /function save\(\)[\s\S]*if \(answered \|\| overLimit \|\| submitting \|\| unknown\) return false/);
  assert.doesNotMatch(functionBody(textEditDialog, "save"), /close\(\)/);

  // Drafts: saves and delayed loads keep the owner, key, and edit revision captured at scheduling.
  assert.match(bridge, /readonly property string draftKey:.*draftFile\.length > 0 \? draftFile : "draft:" \+ draftId/);
  assert.match(shell, /id:\s*draftTimer[\s\S]*interval:\s*600[\s\S]*save\.owner === root\.draftOwnerInUse[\s\S]*save\.revision === root\.draftEditRevision[\s\S]*saveDraftFor\(save\.key, save\.text\)/);
  assert.match(functionBody(shell, "restoreDraft"), /owner !== draftOwnerInUse \|\| key !== draftKeyInUse \|\| text\.length === 0 \|\| composer\.text\.length > 0/);
  assert.match(functionBody(shell, "restoreCurrentDraft"), /generation !== draftRestoreGeneration \|\| revision !== draftEditRevision[\s\S]*owner !== draftOwnerInUse \|\| key !== draftKeyInUse/);
  assert.match(functionBody(shell, "handleDraftKeyChanged"), /composer\.text\.length > 0\) bridge\.saveDraftFor\(draftKeyInUse, composer\.text\)/);
  assert.match(functionBody(bridge, "saveDraftFor"), /if \(!response\.ok\) postNotice\("error", "Could not save draft:/);
  assert.match(functionBody(bridge, "saveDraftFor"), /boundedText\(String\(text \|\| ""\), 8192\)/);
  assert.equal(LIMITS.maxDraftCharacters, 8192);

  // Sequences: run only from the explicit action, delete needs confirmation, list actions never run.
  assert.match(functionBody(sequencesDialog, "deleteCurrent"), /if \(!confirmingDelete\) \{[\s\S]*confirmingDelete = true[\s\S]*return true/);
  assert.doesNotMatch(functionBody(sequencesDialog, "deleteCurrent"), /runSequence|runCurrent/);
  assert.doesNotMatch(functionBody(sequencesDialog, "moveCurrent"), /runSequence|runCurrent/);
  assert.doesNotMatch(functionBody(sequencesDialog, "saveEdit"), /runSequence|runCurrent/);
  assert.match(functionBody(sequencesDialog, "runCurrent"), /if \(!sequence \|\| busy \|\| !bridge\.ready \|\| bridge\.active\) return false/);
  assert.match(sequencesDialog, /text:\s*dialog\.confirmingDelete \? "Confirm delete" : "Delete"/);
  assert.match(sequencesDialog, /readonly property int maxEntries:\s*16/);
  assert.equal(LIMITS.maxSequenceEntries, 16);
  assert.match(functionBody(bridge, "runSequence"), /if \(!ready \|\| active\)/);
  assert.match(shell, /SequencesDialog\s*\{[\s\S]*returnFocusItem:\s*composer/);
});

test("composer replacement, promotion, pending loads, edits, and failed transitions preserve their owner", async () => {
  const saved = new Map();
  const loads = [];
  const bridgeState = { ready: true, activeTabId: "A", draftOwner: "A:one", draftKey: "draft:one", tabs: [{ id: "A" }, { id: "B" }],
    saveDraftFor(key, text) { saved.set(key, text); }, loadDraft(callback, key) { loads.push({ callback, key }); } };
  const editor = { text: "", setText(text) { this.text = text; } };
  const timer = { pending: null, stop() { this.pending = null; } };
  const s = await qmlFunctions("shell.qml", { bridge: bridgeState, composer: editor, draftTimer: timer,
    draftOwnerInUse: "", draftKeyInUse: "", draftEditRevision: 0, draftRestoreGeneration: 0,
    draftRecords: {}, changingDraft: false });
  const type = text => { editor.text = text; s.rememberDraft(text); timer.pending = { owner: s.draftOwnerInUse,
    key: s.draftKeyInUse, revision: s.draftEditRevision, text }; };
  s.commitDraftReplacement();
  type("A pending");
  s.beginDraftReplacement();
  bridgeState.draftOwner = "B:two"; bridgeState.draftKey = "draft:two"; bridgeState.activeTabId = "B";
  s.commitDraftReplacement();
  assert.equal(saved.get("draft:one"), "A pending", "replacement flushes the pending debounce to A");
  loads[0].callback({ ok: true, data: { text: "late A" } });
  assert.equal(editor.text, "", "late A cannot populate B");
  type("B newer");
  loads.at(-1).callback({ ok: true, data: { text: "B stale" } });
  assert.equal(editor.text, "B newer", "typing during load wins");
  s.beginDraftReplacement();
  bridgeState.draftOwner = "A:one"; bridgeState.draftKey = "draft:one"; bridgeState.activeTabId = "A";
  s.commitDraftReplacement();
  assert.equal(editor.text, "A pending", "A-to-B-to-A restores the old text exactly");
  bridgeState.draftKey = "/saved.jsonl";
  s.handleDraftKeyChanged();
  assert.equal(editor.text, "A pending", "first filename does not clear the editor");
  assert.equal(saved.get("/saved.jsonl"), "A pending");
  s.restoreCurrentDraft();
  assert.equal(editor.text, "A pending", "same-session refresh leaves the editor alone");
  // A failed or cancelled replacement emits no sessionReplacing/sessionReplaced signals.
  assert.equal(s.draftOwnerInUse, "A:one");
  type("");
  assert.equal(s.draftRecords["/saved.jsonl"].text, "", "an explicit clear records an empty draft");
});

test("tabs isolate session state, replay from the backend, confirm busy closes, and worktrees confirm their path", () => {
  const handler = functionBody(bridge, "handleEvent");
  assert.match(handler, /if \(typeof event\.tab === "string" && event\.tab !== activeTabId\) \{[\s\S]*handleInactiveTabEvent\(event\)[\s\S]*return/, "events from other tabs never touch the view");
  assert.match(functionBody(bridge, "request"), /if \(activeTabId\.length > 0 && frame\.tab === undefined\) frame\.tab = activeTabId/);
  const reset = functionBody(bridge, "resetTabState");
  for (const cleared of ["transcript.clear()", "visibleError = \"\"", "attachments = []", "steeringQueue = []", "dialogQueue = []", "activeDialog = null", "statusChips = []", "commandsLoaded = false"]) {
    assert(reset.includes(cleared), `resetTabState must include ${cleared}`);
  }
  assert.doesNotMatch(reset, /answerDialog|extension_response/, "switching tabs never answers another tab's dialogs");
  const applySnapshot = functionBody(bridge, "applySnapshot");
  assert.match(applySnapshot, /enqueueDialog\(dialog, false\)/);
  assert.match(applySnapshot, /typeof snapshot\.error === "string" && snapshot\.error\.trim\(\)\.length > 0 \? boundedError\(snapshot\.error\) : ""/, "empty snapshot errors stay empty");
  assert.match(functionBody(bridge, "enqueueDialog"), /dialogQueue\.some\(entry => entry\.requestId === requestId\)\) return false/, "snapshots never duplicate queued dialogs");
  assert.match(functionBody(bridge, "closeTab"), /"force": force === true/);
  assert.match(functionBody(bridge, "createWorktree"), /"confirmed": true/);
  assert.match(bridge, /readonly property string draftOwner:\s*activeTabId \+ ":" \+ draftId/);
  assert.match(bridge, /case "tabs\.update":[\s\S]*beginTabSwitch\(event\.activeTab\)/);
  assert.match(bridge, /onExited:[\s\S]*bridge\.tabs = \[\][\s\S]*bridge\.activeTabId = ""/);
  assert.equal(LIMITS.maxTabs, 8);
  assert.match(bridge, /readonly property int maxTabs:\s*8/);

  // Shell: busy tabs confirm before closing, worktrees are planned then confirmed, sessions resume through the picker.
  assert.match(functionBody(shell, "closeTab"), /if \(tab\.active\) \{[\s\S]*destructive: true[\s\S]*action: "close-tab"/);
  assert.match(functionBody(shell, "closeTab"), /return bridge\.closeTab\(tabId, false\)/);
  assert.match(functionBody(shell, "confirmAccepted"), /bridge\.closeTab\(String\(context\.tabId\), true\)/);
  assert.match(functionBody(shell, "planWorktree"), /bridge\.planWorktree\(branch, response => \{[\s\S]*plan\.problems\.length > 0[\s\S]*confirmDialogItem\.present\(\{[\s\S]*detail: plan\.path/);
  assert.doesNotMatch(functionBody(shell, "planWorktree"), /createWorktree/, "planning never creates");
  assert.match(functionBody(shell, "confirmAccepted"), /bridge\.createWorktree\(context\.plan\.branch, context\.plan\.base, context\.plan\.path\)/);
  assert.match(functionBody(shell, "planWorktree"), /typeof branch !== "string"[\s\S]*worktreeDialogItem\.validate = root\.branchProblem[\s\S]*worktreeDialogItem\.present\(\)/, "the worktree action opens the split branch dialog");
  assert.match(worktreeDialog, /property var typeSuggestions:\s*\["feat", "fix", "change", "perf", "test", "chore", "refactor", "docs", "style", "build", "ci", "revert"\]/, "the editable type field shares pi-package-webui's conventional suggestions");
  assert.match(worktreeDialog, /ComboBox\s*\{[\s\S]*editable:\s*true[\s\S]*Accessible\.description:\s*"Choose a suggested type or enter a custom type"/, "branch type suggestions never restrict custom input");
  assert.match(worktreeDialog, /visible:\s*typeField\.editText\.length === 0[\s\S]*text:\s*"type"/, "the empty editable dropdown shows the type placeholder");
  assert.match(worktreeDialog, /readonly property string branch:\s*branchType\.length > 0 && branchName\.length > 0 \? branchType \+ "\/" \+ branchName : ""/, "type and name are visibly collected as one slash-separated branch");
  assert.match(functionBody(worktreeDialog, "present"), /currentIndex = -1[\s\S]*editText = ""[\s\S]*nameField\.text = ""/, "the type starts empty instead of defaulting to feat");
  assert.match(functionBody(worktreeDialog, "submit"), /if \(answered \|\| !valid\) return false[\s\S]*submitted\(branch\)/, "the split dialog only submits a valid combined branch");
  assert.match(shell, /WorktreeDialog\s*\{[\s\S]*onSubmitted:\s*branch => root\.planWorktree\(branch\)/);
  assert.match(functionBody(shell, "pickerPicked"), /kind === "session"[\s\S]*bridge\.switchSession\(value\)/);
  assert.match(functionBody(shell, "openSessionsPicker"), /if \(\(!bridge\.ready && !bridge\.canRecover\) \|\| bridge\.active \|\| pickerDialogItem\.opened\) return false/);
  assert.match(functionBody(bridge, "listSessions"), /if \(!ready && !canRecover\) return false/, "the recovery picker can list saved sessions while prompts remain blocked");
  for (const action of ["switchSession", "newSession"]) assert.match(functionBody(bridge, action), /if \(\(!ready && !canRecover\) \|\| active\) return false/, `${action} remains available only during explicit recovery`);
  assert.match(functionBody(bridge, "applyTabSummary"), /canRecover = tab\.canRecover === true/);
  assert.match(functionBody(bridge, "handleStatus"), /canRecover = event\.canRecover === true/, "status events cannot retain recovery actions after the child stops");
  assert.match(shell, /text: "Sessions"[\s\S]*onClicked: root\.openSessionsPicker\(\)/);
  assert.match(shell, /visible: bridge\.canRecover[\s\S]*text: "New session"[\s\S]*onClicked: root\.newSessionInTab\(\)/, "new session stays visible when a missing file blocks the composer");
  assert.match(emptyState, /visible: !empty\.sessionOpen \|\| empty\.ready \|\| empty\.canRecover[\s\S]*text: "Resume session"/);
  assert.match(functionBody(shell, "handleDraftKeyChanged"), /bridge\.saveDraftFor\(draftKeyInUse, composer\.text\)/, "the previous tab's draft is saved before switching");
  assert.match(shell, /SessionList\s*\{[\s\S]*onSessionRequested:\s*session => root\.openCatalogSession\(session\)[\s\S]*onCloseRequested:\s*tabId => root\.closeTab\(tabId\)/);
  assert.match(shell, /DirectoryDialog\s*\{[\s\S]*onChosen:\s*path => bridge\.openTab\(path, ""\)/);
  assert.match(shell, /Instantiator\s*\{[\s\S]*model:\s*8[\s\S]*sequence:\s*"Ctrl\+" \+ \(index \+ 1\)/);
  assert.match(emptyState, /signal resumeRequested\(\)/);

  // Dialogs: destructive confirmations focus Cancel first; input never submits invalid text;
  // the directory picker only leaves through Choose.
  assert.match(confirmDialog, /initialFocusItem:\s*destructive \? cancelButton : confirmButton/);
  assert.match(functionBody(confirmDialog, "confirm"), /if \(answered\) return false[\s\S]*answered = true[\s\S]*confirmed\(context\)/);
  assert.match(functionBody(inputDialog, "submit"), /if \(answered \|\| !valid\) return false/);
  assert.equal((directoryDialog.match(/chosen\(/g) ?? []).length, 3, "signal declaration plus the two explicit choose paths");
  assert.doesNotMatch(functionBody(directoryDialog, "navigateTo"), /chosen\(/);
  assert.doesNotMatch(functionBody(directoryDialog, "enterCurrent"), /chosen\(/);
  assert.match(directoryDialog, /Keys\.onPressed[\s\S]*Qt\.Key_Backspace && text\.length === 0[\s\S]*dialog\.up\(\)/);
  assert.match(tabStrip, /Accessible\.role:\s*Accessible\.PageTabList/);
  assert.match(tabStrip, /Accessible\.role:\s*Accessible\.PageTab\b/);
  assert.match(tabStrip, /Accessible\.selected:\s*current/);
  assert.match(tabStrip, /accessibleName:\s*"Close tab " \+ tabItem\.label/);
  assert.match(fixture, /"switch_session"/);
  assert.match(fixture, /"get_messages"/);
});

test("the palette, usage, events, and diagnostics stay keyboard-first, bounded, and never send", () => {
  assert.match(functionBody(shell, "paletteItems"), /push\("Recent"|recents\.indexOf\("action:" \+ action\[0\]\) !== -1 \? "Recent" : "Action"/);
  for (const group of ["Tab", "Model", "Session", "Pi command", "Skill"]) assert(functionBody(shell, "paletteItems").includes(`"${group}"`), `palette group ${group}`);
  assert.match(functionBody(shell, "openPalette"), /bridge\.loadModels[\s\S]*bridge\.listSessions[\s\S]*loadCommands/, "capability groups reload when the palette opens");
  const picked = functionBody(shell, "palettePicked");
  assert.match(picked, /kind === "command"[\s\S]*composer\.setText\("\/" \+ payload \+ " "\)/);
  assert.doesNotMatch(picked, /sendPrompt|trySend/, "the palette never sends a prompt");
  assert.match(picked, /kind === "skill"[\s\S]*confirmDialogItem\.present\(\{[\s\S]*action: "open-path"/, "skill files open only after confirmation");
  assert.match(functionBody(shell, "confirmAccepted"), /context\.action === "open-path"\) bridge\.openPath\(String\(context\.path\)\)/);
  assert.doesNotMatch(shell, /toggle-compact|Ctrl\+Shift\+M/, "density switching is absent from the palette, menu, and shortcuts");
  assert.match(functionBody(shell, "runPaletteAction"), /case "cycle-appearance": return root\.cycleAppearanceMode\(\)/);
  assert.match(functionBody(shell, "runPaletteAction"), /case "toggle-reduced-motion": bridge\.updateSetting\("reducedMotion"/);
  assert.match(functionBody(shell, "cycleAppearanceMode"), /\["automatic", "light", "dark"\]/);
  assert.match(functionBody(shell, "palettePicked"), /bridge\.recordAction\(value\)/);
  assert.match(pickerDialog, /String\(item\.group \|\| ""\)/, "filtering also matches the group label");
  assert.match(functionBody(shell, "groupStatusChips"), /add\("Usage", \{ key: "context"/);
  assert.match(functionBody(shell, "groupStatusChips"), /tone: usage\.context\.percent >= 90 \? "error" : usage\.context\.percent >= 75 \? "warning" : ""/);
  assert.match(bridge, /readonly property int maxNotices:\s*200/);
  assert.equal(LIMITS.maxEventHistory, 200);
  assert.match(functionBody(bridge, "postNotice"), /noticeRevision\+\+/);
  assert.match(functionBody(bridge, "clearNotices"), /notices\.clear\(\)/);
  assert.match(bridge, /case "run\.end":[\s\S]*usageTimer\.restart\(\)/);
  assert.match(functionBody(eventsDialog, "collectEntries"), /previous\.count \+= 1/, "repeated events collapse");
  assert.match(eventsDialog, /model:\s*\["all", "info", "warning", "error"\]/);
  assert.match(functionBody(eventsDialog, "copyAll"), /bridge\.copyToClipboard/);
  assert.match(diagnosticsDialog, /TextEdit\s*\{[\s\S]*textFormat:\s*TextEdit\.PlainText[\s\S]*readOnly:\s*true/);
  assert.match(functionBody(diagnosticsDialog, "buildReport"), /Recent errors/);
  assert.match(shell, /EventsDialog\s*\{[\s\S]*returnFocusItem:\s*composer/);
  assert.match(shell, /DiagnosticsDialog\s*\{[\s\S]*returnFocusItem:\s*composer/);
  assert.match(fixture, /"get_session_stats"/);
});

test("session details stay collapsed behind a bounded complete status overlay", () => {
  const responseControls = objectBodyContaining(shell, "RowLayout", "id: responseControls");
  const trigger = objectBodyWithId(responseControls, "AppButton", "statusButton");
  const overlayWiring = objectBodyWithId(shell, "StatusOverlay", "statusOverlayItem");
  assert.match(shell, /readonly property int statusEntryCount:\s*\{[\s\S]*group\.entries\.length/);
  assert.match(trigger, /visible:\s*root\.statusEntryCount > 0/);
  assert.match(trigger, /active:\s*statusOverlayItem\.opened/);
  assert.match(trigger, /text:\s*"Status " \+ root\.statusEntryCount/);
  assert.match(trigger, /if \(statusOverlayItem\.opened\) statusOverlayItem\.close\(\)[\s\S]*else statusOverlayItem\.present\(\)/, "the same control opens and closes the overlay");
  assert.doesNotMatch(shell, /\bStatusSegment\s*\{/, "status rows no longer occupy persistent space below the prompt");
  assert.match(overlayWiring, /anchorItem:\s*statusButton[\s\S]*returnFocusItem:\s*statusButton[\s\S]*groups:\s*root\.statusGroups/);
  assert.match(statusOverlay, /parent:\s*anchorItem \? anchorItem : boundsItem/);
  assert.match(statusOverlay, /closePolicy:\s*Popup\.CloseOnEscape \| Popup\.CloseOnPressOutsideParent/, "the trigger is inside the popup parent, so its press reaches the toggle instead of being consumed as an outside press");
  assert.match(statusOverlay, /x:\s*Math\.max[\s\S]*- \(anchorItem \? anchorPosition\.x : 0\)[\s\S]*y:\s*Math\.max[\s\S]*- \(anchorItem \? anchorPosition\.y : 0\)/, "bounded window coordinates are translated back into the trigger parent coordinate space");
  assert.match(statusOverlay, /width:\s*Math\.min\(maximumWidth,[\s\S]*height:\s*Math\.min\(implicitHeight, maximumHeight, dropUpAvailableHeight\)/);
  assert.match(statusOverlay, /ScrollView\s*\{[\s\S]*ScrollBar\.vertical\.policy:\s*ScrollBar\.AsNeeded/);
  assert.match(statusOverlay, /model:\s*popup\.groups[\s\S]*model:\s*groupSection\.modelData\.entries/);
  assert.match(statusOverlay, /entryLabel:\s*String\(modelData\.label \|\| ""\)/);
  assert.match(statusOverlay, /entryValue:\s*String\(modelData\.value \|\| ""\)/);
  assert.match(statusOverlay, /detailText:\s*String\(modelData\.title \|\| ""\)/);
  assert.match(statusOverlay, /String\(statusEntry\.modelData\.icon \|\| ""\)/);
  assert.match(statusOverlay, /color:\s*popup\.valueColor\(statusEntry\.tone\)/);
  assert.match(statusOverlay, /wrapMode:\s*TextEdit\.WrapAnywhere/);
  assert.doesNotMatch(statusOverlay, /\belide:/, "expanded status values and details remain fully readable");
  assert.match(functionBody(statusOverlay, "present"), /entryCount === 0[\s\S]*open\(\)[\s\S]*closeButton\.forceActiveFocus\(\)/);
  assert.match(statusOverlay, /onClosed:\s*if \(returnFocusItem\) returnFocusItem\.forceActiveFocus\(\)/);
});

test("status overlay attaches dialog accessibility to its visual content", () => {
  const rootProperties = statusOverlay.slice(statusOverlay.indexOf("{") + 1, statusOverlay.indexOf("background:"));
  const statusColumn = objectBodyWithId(statusOverlay, "ColumnLayout", "statusColumn");
  assert.doesNotMatch(rootProperties, /Accessible\./, "Popup does not derive from Item or Action");
  assert.match(statusColumn, /Accessible\.role:\s*Accessible\.Dialog/);
  assert.match(statusColumn, /Accessible\.name:\s*"Session details"/);
  assert.match(statusColumn, /Accessible\.description:\s*popup\.entryCount/);
});

test("controls carry accessible names, roles, and focus behavior", () => {
  assert.match(appButton, /Accessible\.role:\s*Accessible\.Button/);
  assert.match(appButton, /Accessible\.name:\s*accessibleName/);
  assert.match(appButton, /focusPolicy:\s*Qt\.StrongFocus/);
  assert.match(appButton, /border\.width:\s*control\.activeFocus \? control\.theme\.focusBorderWidth : control\.theme\.borderWidth/, "buttons reserve a stable semantic frame");
  assert.match(appButton, /font\.family:\s*control\.theme\.monospaceFamily/);
  assert.match(statusBadge, /font\.family:\s*badge\.theme\.monospaceFamily/);
  assert.match(statusSegment, /font\.family:\s*segment\.theme\.monospaceFamily/);
  assert.match(tabStrip, /font\.family:\s*strip\.theme\.monospaceFamily/);
  assert.match(row, /font\.family:\s*row\.theme\.monospaceFamily/);
  assert.match(appButton, /HoverHandler\s*\{[\s\S]*Qt\.PointingHandCursor/);
  assert.match(appButton, /hoverEnabled:\s*true/);
  assert.match(appButton, /Accessible\.checked:\s*active/);
  assert.match(appButton, /interactionState:\s*down \? "pressed" : hovered \? "hovered" : "idle"/);
  assert.match(appButton, /filled \? theme\.filledButtonBackground\(variant, interactionState\)/);
  assert.match(appButton, /filled \? theme\.filledButtonForeground\(variant, interactionState\)/);
  assert.doesNotMatch(appButton, /Qt\.(lighter|darker)/, "component state colors stay theme-owned");
  assert.match(appButton, /active \? theme\.controlActive/);
  assert.match(appButton, /implicitHeight:\s*control\.theme\.controlHeight/);
  assert.match(statusBadge, /radius:\s*theme\.radiusSmall/);
  assert.match(statusBadge, /font\.capitalization:\s*Font\.AllUppercase/);
  assert.match(statusBadge, /font\.letterSpacing:\s*badge\.theme\.labelTracking/);
  assert.match(statusSegment, /width:\s*Math\.min\(implicitWidth, availableWidth\)/);
  assert.match(statusSegment, /border\.color:\s*theme\.frameBorder/);
  assert.match(tabStrip, /border\.color:\s*theme\.frameBorder/);
  assert.match(statusSegment, /Flow\s*\{[\s\S]*id:\s*statusFlow/);
  assert.match(statusSegment, /readonly property real contentImplicitWidth:\s*\{[\s\S]*statusRepeater\.count[\s\S]*statusRepeater\.itemAt\(index\)[\s\S]*item\.implicitWidth/, "status segments derive their natural width from instantiated entries instead of collapsing to padding");
  assert.match(statusSegment, /readonly property real contentImplicitHeight:\s*childrenRect\.height/, "status flow derives its natural height from positioned entries");
  assert.match(statusSegment, /implicitWidth:\s*statusFlow\.contentImplicitWidth \+ theme\.spaceXl[\s\S]*implicitHeight:\s*statusFlow\.contentImplicitHeight \+ theme\.spaceMd/, "the frame consumes the flow's content dimensions instead of the read-only zero defaults");
  assert.match(statusSegment, /width:\s*Math\.min\(implicitWidth, statusFlow\.width\)/);
  assert.match(statusSegment, /SelectableText\s*\{[\s\S]*Layout\.fillWidth:\s*true[\s\S]*Layout\.minimumWidth:\s*48/, "status values clip through the shared selectable text surface instead of eliding differently from selection");
  const responseControls = objectBodyContaining(shell, "RowLayout", "id: responseControls");
  assert.doesNotMatch(responseControls, /active:\s*bridge\.showThinking|updateSetting\("showThinking"/, "the visible thinking-section toggle leaves the response controls");
  assert.match(shell, /sequence:\s*"Ctrl\+T"[\s\S]*updateSetting\("showThinking"/, "the thinking visibility shortcut remains");
  assert.match(functionBody(shell, "runPaletteAction"), /case "toggle-thinking": bridge\.updateSetting\("showThinking"/, "the palette thinking visibility action remains");
  assert.match(shell, /showThinking:\s*bridge\.showThinking/, "transcript filtering remains wired");
  assert.doesNotMatch(objectBodyWithId(shell, "RowLayout", "responseControls"), /compactTranscript|"Detailed"/, "the composer has no transcript density control");
  assert.match(bridge, /readonly property bool compactTranscript:\s*true/, "compact layout is fixed");
  assert.doesNotMatch(functionBody(bridge, "applySettings"), /compactTranscript/, "legacy saved density settings cannot restore detailed layout");
  assert.match(shell, /spacing:\s*bridge\.compactTranscript \? 6 : 12/);
  assert.match(shell, /compact:\s*bridge\.compactTranscript/, "transcript rows use the fixed compact layout");
  for (const [name, source] of [["composer", composer], ["searchBar", searchBar], ["toolCard", toolCard], ["row", row], ["statusBadge", statusBadge], ["noticeBar", noticeBar], ["emptyState", emptyState], ["blocks", blocks]]) {
    assert.match(source, /Accessible\.(role|name)/, `${name} should describe itself to assistive technology`);
  }
  assert.match(searchBar, /Keys\.onPressed[\s\S]*Qt\.Key_Escape[\s\S]*bar\.closeRequested\(\)/);
  assert.match(searchBar, /event\.modifiers & Qt\.ShiftModifier\) bar\.previousRequested\(\)/);
  assert.match(row, /Accessible\.name:\s*roleLabel/);
  assert.match(row, /!row\.fromUser && row\.kind !== "thinking" && !row\.searchCurrent\) \? row\.theme\.transparent/);
  assert.match(row, /row\.fromUser \|\| row\.kind === "thinking" \? 1 : 0/);
  assert.match(row, /font\.capitalization:\s*Font\.AllUppercase[\s\S]*font\.letterSpacing:\s*row\.theme\.labelTracking/);
  assert.match(composer, /text:\s*"PROMPT"[\s\S]*font\.letterSpacing:\s*composer\.theme\.labelTracking/);
  assert.match(composer, /composer\.active \? \(composer\.busyPromptMode === "steer" \? "STEER" : "FOLLOW-UP"\) : "READY"/);
  for (const [name, source] of [["drop-up", dropUpPicker], ["completion", completionPopup], ["tabs", tabStrip], ["picker", pickerDialog], ["extension", extensionDialog], ["directory", directoryDialog], ["sequences", sequencesDialog], ["events", eventsDialog]]) {
    assert.match(source, /interactiveFill\(/, `${name} rows should expose semantic hover, pressed, and selected fills`);
    assert.match(source, /interactiveBorder\(/, `${name} rows should expose a semantic keyboard focus border`);
  }
  assert.match(tabStrip, /activeFocusOnTab:\s*true/);
  assert.match(tabStrip, /Keys\.onSpacePressed:/);
  assert.match(workingIndicator, /running:\s*indicator\.running && !indicator\.theme\.reducedMotion/);
  assert.match(workingIndicator, /opacity:\s*indicator\.theme\.reducedMotion \? 1\.0 : 0\.3/);
});

test("smoke driver and fixture cover every recorded protocol edge", () => {
  for (const marker of [
    "QT_WEBUI_SMOKE_BACKEND_READY", "QT_WEBUI_SMOKE_READY", "QT_WEBUI_SMOKE_THEME_LIGHT_OVERRIDE", "QT_WEBUI_SMOKE_THEME_DARK_OVERRIDE", "QT_WEBUI_SMOKE_THEME_AUTOMATIC", "QT_WEBUI_SMOKE_REDUCED_MOTION", "QT_WEBUI_SMOKE_STREAM_RECONCILED", "QT_WEBUI_SMOKE_THINKING_RENDERED",
    "QT_WEBUI_SMOKE_TOOL_CARD", "QT_WEBUI_SMOKE_MARKDOWN_RENDERED", "QT_WEBUI_SMOKE_LINK_CONFIRMED", "QT_WEBUI_SMOKE_SEARCH_MATCHED",
    "QT_WEBUI_SMOKE_PROVIDER_ERROR_PRESERVED", "QT_WEBUI_SMOKE_FAILED_RESPONSE_RECOVERED", "QT_WEBUI_SMOKE_DELAYED_ABORT_RECEIPT",
    "QT_WEBUI_SMOKE_TRANSCRIPT_BOUNDED", "QT_WEBUI_SMOKE_SETTINGS_PERSISTED", "QT_WEBUI_SMOKE_CODE_HIGHLIGHTED", "QT_WEBUI_SMOKE_COMMANDS_LOADED",
    "QT_WEBUI_SMOKE_COMMAND_COMPLETED", "QT_WEBUI_SMOKE_PATH_COMPLETED", "QT_WEBUI_SMOKE_ATTACHMENT_ADDED", "QT_WEBUI_SMOKE_ATTACHMENT_SENT",
    "QT_WEBUI_SMOKE_DRAFT_PERSISTED", "QT_WEBUI_SMOKE_SEQUENCE_RUN", "QT_WEBUI_SMOKE_SEQUENCE_DELETED", "QT_WEBUI_SMOKE_ACTIVE_PICKER_INVALIDATED", "QT_WEBUI_SMOKE_STALE_PICKER_RESULT_REFUSED", "QT_WEBUI_SMOKE_PICKER_LOADING_RECOVERED", "QT_WEBUI_SMOKE_REAL_LIST_ARROW_SELECTION", "QT_WEBUI_SMOKE_MODEL_DROPUP_BOUNDED", "QT_WEBUI_SMOKE_MODEL_DROPUP_FOCUS_RETURNED", "QT_WEBUI_SMOKE_MODEL_PICKER", "QT_WEBUI_SMOKE_MODEL_SELECTED",
    "QT_WEBUI_SMOKE_WORKSPACE_SEARCH_FILTERED", "QT_WEBUI_SMOKE_EMPTY_SESSION_STATE", "QT_WEBUI_SMOKE_TAB_OPENED", "QT_WEBUI_SMOKE_TAB_PICKER_INVALIDATED", "QT_WEBUI_SMOKE_TAB_PICKER_LOADING_RECOVERED", "QT_WEBUI_SMOKE_STALE_RESOURCE_READ_IGNORED", "QT_WEBUI_SMOKE_STALE_RESOURCE_MUTATION_IGNORED", "QT_WEBUI_SMOKE_TAB_SWITCHED", "QT_WEBUI_SMOKE_SESSION_RESUMED", "QT_WEBUI_SMOKE_SESSION_NEW", "QT_WEBUI_SMOKE_DIRECTORY_PICKED",
    "QT_WEBUI_SMOKE_WORKTREE_CREATED", "QT_WEBUI_SMOKE_TAB_CLOSED", "QT_WEBUI_SMOKE_USAGE_LOADED", "QT_WEBUI_SMOKE_PALETTE_ACTION",
    "QT_WEBUI_SMOKE_EVENTS_LISTED", "QT_WEBUI_SMOKE_DIAGNOSTICS_SHOWN",
    "QT_WEBUI_SMOKE_THINKING_DROPUP_BOUNDED", "QT_WEBUI_SMOKE_THINKING_DROPUP_FOCUS_RETURNED", "QT_WEBUI_SMOKE_THINKING_PICKER", "QT_WEBUI_SMOKE_MODEL_CYCLED", "QT_WEBUI_SMOKE_THINKING_CYCLED", "QT_WEBUI_SMOKE_CONTEXT_COMPACTED",
    "QT_WEBUI_SMOKE_RESOURCES_LOADED", "QT_WEBUI_SMOKE_RESOURCE_TOOLS_NONE", "QT_WEBUI_SMOKE_RESOURCE_SKILLS_ENABLED", "QT_WEBUI_SMOKE_RESOURCE_SAMPLING_SAVED", "QT_WEBUI_SMOKE_RESOURCE_UNSUPPORTED_PRESERVED",
    "QT_WEBUI_SMOKE_FAILED_STATE_RECOVERABLE",
    "QT_WEBUI_SMOKE_MISSING_STATE_RECOVERABLE", "QT_WEBUI_SMOKE_RESTART_RECEIPT", "QT_WEBUI_SMOKE_BACKEND_CRASH_OBSERVED",
    "QT_WEBUI_SMOKE_BACKEND_CRASH_RECOVERED", "QT_WEBUI_SMOKE_COMPLETE",
  ]) assert.match(smoke, new RegExp(marker), `driver should log ${marker}`);
  assert.match(functionBody(smoke, "startAppearanceChecks"), /updateSetting\("appearanceMode", "light"\)/);
  assert.match(smoke, /appearance-dark[\s\S]*updateSetting\("appearanceMode", "dark"\)/);
  assert.match(smoke, /appearance-reduced[\s\S]*updateSetting\("reducedMotion", true\)/);
  assert.match(smoke, /appearance-automatic[\s\S]*updateSetting\("appearanceMode", "automatic"\)/);
  assert.match(smoke, /dialog\.submit\(\{ "cancelled": true \}\)\) fail\(/, "driver proves a second answer is rejected");
  assert.match(fixture, /\{malformed rpc record\}/);
  assert.match(fixture, /future_unknown_event/);
  assert.match(fixture, /qt-webui-stale-0/);
  assert.match(fixture, /"\\r\\n"/);
  assert.match(fixture, /deterministic prompt rejection/);
  assert.match(fixture, /options: \["Allow", "Block"\]/);
  assert.match(fixture, /prefill: "Line 1\\nLine 2"/);
  assert.match(fixture, /setTimeout\(\(\) => \{[\s\S]*activeAbort = true;[\s\S]*type: "agent_start"/);
  assert.match(fixture, /stopReason: "error"/);
  assert.match(fixture, /failed-state/);
  assert.match(fixture, /missing-state/);
  assert.match(fixture, /text: "authoritative final"/);
  assert.match(fixture, /"x"\.repeat\(10_000\)/);
  assert.match(fixture, /process\.exit\(23\)/);
  assert.match(fixture, /grandchild\.kill\("SIGTERM"\)/);
});

test("no QML file is left over from the direct-Pi design", async () => {
  const names = await readdir(qmlRoot);
  assert(!names.includes("PiBridge.qml"));
  const componentNames = await readdir(path.join(qmlRoot, "components"));
  assert(!componentNames.includes("ChatMessage.qml"));
});

test("prompt attachment reconciliation uses consumed ids scoped to the originating owner", () => {
  const send = functionBody(bridge, "sendPrompt");
  assert.match(functionBody(bridge, "reconcilePromptAttachments"), /submission\.owner === attachmentOwner\(submission\.tab\)/);
  assert.match(functionBody(bridge, "reconcilePromptAttachments"), /submission\.generation === sessionGenerationFor\(submission\.tab\)/);
  const reconcile = functionBody(bridge, "reconcilePromptAttachments");
  assert.match(reconcile, /Array\.isArray\(consumed\)/);
  assert.match(reconcile, /current\.filter\(item => consumed\.indexOf\(String\(item\.id\)\) === -1\)/);
  assert.match(reconcile, /syncAttachments\(submission\.tab, submission\.owner\)/);
  assert.match(reconcile, /bumpAttachmentEpoch\(submission\.owner\)/);
  assert.match(reconcile, /consumed\.length <= maxAttachments/);
  assert.match(functionBody(bridge, "settleTimedOutPrompt"), /entry\.state === "unknown"/);
  assert.match(functionBody(bridge, "applySnapshot"), /attachmentEpoch === \(attachmentEpochs\[owner\] \|\| 0\)/);
  assert.doesNotMatch(send, /attachments = \[\]|\["busy", "not_ready", "not_running"\]/);
  assert.match(functionBody(bridge, "removeAttachment"), /attachmentLocked\(attachmentId\)/);
  assert.match(functionBody(bridge, "updateAttachment"), /attachmentLocked\(attachmentId\)/);
  assert.match(composer, /enabled: composer\.lockedAttachmentIds\.indexOf\(String\(chip\.modelData\.id\)\) === -1/);
});
