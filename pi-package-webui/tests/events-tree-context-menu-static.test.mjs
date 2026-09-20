import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, styles, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const next = source.slice(start + 1).match(/\n(?:async )?function [A-Za-z0-9_$]+\(/);
  const end = next ? start + 1 + next.index : source.length;
  return source.slice(start, end);
}

// Dedicated, labelled menu markup.
assert.match(html, /<div id="eventTreeContextMenu"[^>]*role="menu"[^>]*aria-labelledby="eventTreeContextMenuLabel"[^>]*hidden>/, "Events should own a labelled context menu");
assert.match(html, /id="eventDisplayDetailedAction"[^>]*role="menuitemradio"[^>]*aria-checked="true"[^>]*>Detailed<\/button>/, "the menu should expose Detailed as the default mode");
assert.match(html, /id="eventDisplayCompactAction"[^>]*role="menuitemradio"[^>]*aria-checked="false"[^>]*>Compact<\/button>/, "the menu should expose Compact mode");
assert.match(html, /role="separator"[\s\S]*id="eventTreeContextMenuAction"[^>]*role="menuitem"[^>]*>Tree…<\/button>[\s\S]*id="eventTreeContextMenuStatus"[^>]*role="status"/, "display choices should stay separate from Tree navigation and live feedback");
assert.match(html, /<label for="eventFilterSelect">Show<\/label>[\s\S]*id="eventFilterSelect"[\s\S]*value="all">All events<[\s\S]*value="errors">Errors \/ failures<[\s\S]*value="warnings">Warnings<[\s\S]*value="tools">Tool activity<[\s\S]*value="tree">Tree available</, "Events should expose the recommended native filter choices");
assert.match(html, /id="eventFilterStatus"[^>]*role="status"[^>]*aria-live="polite"[\s\S]*id="eventFilterEmpty"[^>]*hidden/, "the filter should expose live counts and an empty state");

const normalizeDisplaySource = functionSource(app, "normalizeEventDisplayMode");
assert.match(normalizeDisplaySource, /value === "compact" \? "compact" : "detailed"/, "unknown values should fall back to detailed mode");
assert.match(functionSource(app, "readStoredEventDisplayMode"), /localStorage\.getItem\(EVENT_DISPLAY_MODE_STORAGE_KEY\)/, "the display preference should restore from browser-local storage");
const setDisplaySource = functionSource(app, "setEventDisplayMode");
assert.match(setDisplaySource, /localStorage\.setItem\(EVENT_DISPLAY_MODE_STORAGE_KEY, eventDisplayMode\)/, "display choices should persist");
assert.match(functionSource(app, "syncEventDisplayModeUi"), /eventLog\.dataset\.displayMode = eventDisplayMode[\s\S]*eventDisplayDetailedAction[\s\S]*eventDisplayCompactAction/, "the current choice should update the log and radio menu state");

const normalizeFilterSource = functionSource(app, "normalizeEventFilter");
assert.match(normalizeFilterSource, /EVENT_FILTER_VALUES\.has\(value\) \? value : "all"/, "unknown filters should fall back to all events");
assert.match(functionSource(app, "readStoredEventFilter"), /localStorage\.getItem\(EVENT_FILTER_STORAGE_KEY\)/, "the event filter should restore from browser-local storage");
const filterMatchSource = functionSource(app, "eventRowMatchesFilter");
for (const contract of [
  /filter === "errors"[\s\S]*eventLevel === "error"/,
  /filter === "warnings"[\s\S]*eventLevel === "warn"/,
  /filter === "tools"[\s\S]*eventToolPhase/,
  /filter === "tree"[\s\S]*eventTreeAvailable === "true"/,
]) assert.match(filterMatchSource, contract, "each visible filter should have an explicit row predicate");
const applyFilterSource = functionSource(app, "applyEventFilter");
assert.match(applyFilterSource, /line\.hidden = !matches[\s\S]*eventFilterStatus[\s\S]*eventFilterEmpty\.hidden/, "filtering should hide rows in place and update count and empty-state feedback");
const setFilterSource = functionSource(app, "setEventFilter");
assert.match(setFilterSource, /localStorage\.setItem\(EVENT_FILTER_STORAGE_KEY, eventFilter\)/, "filter choices should persist");
assert.match(app, /eventFilterSelect\?\.addEventListener\("change"[\s\S]*setEventFilter\(elements\.eventFilterSelect\.value\)/, "the native select should apply its selected filter");
assert.match(app, /event\.key === EVENT_FILTER_STORAGE_KEY[\s\S]*setEventFilter\(event\.newValue, \{ persist: false \}\)/, "filter changes should synchronize across same-origin tabs");

// Bounded event details: explicit target allowlist, status, duration, and shortened ID.
const targetSource = functionSource(app, "boundedToolEventTarget");
for (const toolName of ["read", "write", "edit", "grep", "find", "ls"]) {
  assert.ok(app.includes(`["${toolName}", "path"]`), `${toolName} should be in the explicit path-target allowlist`);
}
assert.match(targetSource, /typeof value !== "string"/, "allowlisted details should accept only string fields");
assert.match(targetSource, /singleLine\.length > 96/, "allowlisted target text should be bounded");
assert.doesNotMatch(targetSource, /JSON\.stringify|\.result|\.output|Object\.values|Object\.entries/, "event details must not serialize arbitrary args or inspect output");
const detailsSource = functionSource(app, "toolLifecycleEventDetails");
for (const label of ["target", "status", "duration", "call"]) {
  assert.ok(detailsSource.includes(`label: "${label}"`), `tool details should expose bounded ${label} metadata`);
}
assert.match(functionSource(app, "shortenedToolCallId"), /slice\(0, 7\)[\s\S]*slice\(-5\)/, "long call IDs should be visibly shortened");
const lifecycleArgumentsSource = functionSource(app, "toolLifecycleEventArguments");
assert.match(lifecycleArgumentsSource, /toolEventStartedAt\.set\(timerKey, \{ startedAt: occurredAt, target: boundedToolEventTarget\(event\) \}\)/, "start records should retain only timing and already bounded target text");
assert.doesNotMatch(lifecycleArgumentsSource, /args:|arguments:|invocation:|\.\.\.event|JSON\.stringify/, "start records must not retain raw tool arguments");
assert.match(lifecycleArgumentsSource, /toolLifecycleEventDetails[\s\S]*toolEventStartedAt\.delete/, "completion rows should consume and remove the matching bounded start record");
assert.match(detailsSource, /phase === "finish"[\s\S]*toolEventStartedAt\.get\(toolEventTimerKey\(event\)\)[\s\S]*boundedToolEventTarget\(event\) \|\| startRecord\?\.target/, "finish rows should reuse the matching bounded start target when completion args omit it");

// Every row exposes display choices; stable lifecycle rows alone expose Tree navigation.
const addEventSource = functionSource(app, "addEvent");
assert.match(addEventSource, /const toolLifecycle = \["start", "finish"\]\.includes\(toolEventPhase\)[\s\S]*stableToolCallId && toolLifecycle/, "only stable lifecycle rows should be Tree eligible");
assert.match(addEventSource, /line\.dataset\.eventLevel = String\(level[\s\S]*line\.dataset\.eventTreeAvailable = String\(!!treeEligible\)/, "rows should retain bounded filter metadata without copying payloads");
assert.match(addEventSource, /if \(toolLifecycle\) line\.dataset\.eventToolPhase = toolEventPhase/, "all tool lifecycle rows should remain visually identifiable in compact mode");
assert.match(addEventSource, /while \(elements\.eventLog\.children\.length > 120\)[\s\S]*applyEventFilter\(\)/, "new rows should apply the active filter after preserving the existing history bound");
assert.match(addEventSource, /setAttribute\("aria-keyshortcuts", "ContextMenu Shift\+F10"\)/, "every event row should expose keyboard display choices");
assert.match(addEventSource, /addEventListener\("click", \(\) => jumpToChatEvent\(line\)\)/, "event rows should preserve click-to-jump");
assert.match(
  functionSource(app, "handleEvent"),
  /case "tool_execution_start":[\s\S]*isIntercomTransportToolName\(event\.toolName\)[\s\S]*break;[\s\S]*toolLifecycleEventArguments\(event, "start"\)[\s\S]*case "tool_execution_end":[\s\S]*isIntercomTransportToolName\(event\.toolName\)[\s\S]*break;[\s\S]*toolLifecycleEventArguments\(event, "finish"\)/,
  "hidden Intercom transport calls should still bypass event rows",
);

// Pointer and keyboard invocation, viewport clamping, focus, dismissal, and menu navigation.
assert.match(app, /eventLog\?\.addEventListener\("contextmenu"[\s\S]*closest\?\.\("\.event"\)[\s\S]*showEventTreeContextMenu\(event, line\)/, "every event row should support pointer display choices");
assert.match(app, /eventLog\?\.addEventListener\("keydown"[\s\S]*event\.key !== "ContextMenu"[\s\S]*event\.shiftKey && event\.key === "F10"[\s\S]*closest\?\.\("\.event"\)/, "every focused event row should support both keyboard invocations");
const showMenuSource = functionSource(app, "showEventTreeContextMenu");
assert.match(showMenuSource, /treeEligible = !!toolCallId[\s\S]*eventTreeContextMenuAction\.hidden = !treeEligible/, "Tree should appear only for eligible tool boundaries");
assert.match(showMenuSource, /window\.innerWidth - rect\.width[\s\S]*window\.innerHeight - rect\.height/, "the menu should clamp inside the viewport");
assert.match(showMenuSource, /eventDisplayCompactAction : elements\.eventDisplayDetailedAction[\s\S]*displayAction\?\.focus/, "the selected display choice should receive focus");
assert.match(functionSource(app, "closeOtherContextMenusForEventTree"), /closeFileContextMenu[\s\S]*closeGitPanelContextMenu[\s\S]*closeSidePanelContextMenu[\s\S]*closeVisibilityContextMenu[\s\S]*closeGitFooterContextMenu/, "opening Tree actions should close specialized context menus");
assert.match(app, /eventTreeContextMenu[^\n]*addEventListener\("keydown"[\s\S]*menuitemradio[\s\S]*"Escape"[\s\S]*"ArrowDown"[\s\S]*"ArrowUp"[\s\S]*"Home"[\s\S]*"End"/, "radio choices and Tree should share standard keyboard navigation");
assert.match(app, /eventTreeContextMenu && !elements\.eventTreeContextMenu\.hidden[\s\S]*event\.target\?\.closest\?\.\("\.event-tree-context-menu"\)[\s\S]*closeEventTreeContextMenu\(\)/, "outside pointer interaction should dismiss the menu");
assert.match(app, /window\.addEventListener\("resize", \(\) => closeEventTreeContextMenu\(\)/, "resize should dismiss the menu");
assert.match(app, /document\.addEventListener\("scroll"[\s\S]*closeEventTreeContextMenu\(\)/, "scroll should dismiss the menu");
assert.match(functionSource(app, "closeEventTreeContextMenu"), /trigger\?\.isConnected[\s\S]*trigger\.focus/, "closing should restore focus to a surviving event row");

// Action-time target resolution and exact no-summary navigation.
const targetEntrySource = functionSource(app, "eventTreeTargetEntryId");
assert.match(targetEntrySource, /data\?\.eventTargets/, "the action should use the minimal eventTargets contract");
assert.match(targetEntrySource, /state\.phase === "start" \? target\?\.startEntryId : target\?\.finishEntryId \|\| target\?\.startEntryId/, "start and finish boundaries should select the approved IDs");
assert.match(targetEntrySource, /nodes\.some\(\(node\) => node\?\.id === entryId\)/, "stale IDs should be rejected against current tree nodes");
const navigateSource = functionSource(app, "navigateEventTreeBoundary");
assert.match(navigateSource, /api\("\/api\/session-tree", \{ tabId: state\.tabContext\.tabId \}\)/, "targets should resolve from current session-tree data at action time");
assert.match(navigateSource, /appConfirm\(\{[\s\S]*Later entries stay in the tree[\s\S]*no automatic branch summary[\s\S]*Use \/tree to navigate back[\s\S]*danger: false/, "confirmation should explain branch effects and remain non-danger styled");
assert.match(navigateSource, /api\("\/api\/tree-navigate", \{[\s\S]*body: \{ entryId, summarize: false \}/, "acceptance should post the exact entry ID without summarization");
assert.ok(navigateSource.indexOf("if (!confirmed)") < navigateSource.indexOf('api("/api/tree-navigate"'), "cancel handling should return before any navigation POST");
const navigationPostIndex = navigateSource.indexOf('api("/api/tree-navigate"');
const postResponseSource = navigateSource.slice(navigationPostIndex);
assert.doesNotMatch(postResponseSource, /eventTreeContextMenuState !== state/, "post-confirmation response handling should not depend on menu visibility");
assert.match(postResponseSource, /if \(!isCurrentTabContext\(state\.tabContext\)\) return;[\s\S]*applyResponseTab\(result\)/, "successful responses should remain guarded by the originating tab generation");
assert.match(postResponseSource, /applyResponseTab\(result\)[\s\S]*title: "\/tree"[\s\S]*if \(eventTreeContextMenuState === state\) closeEventTreeContextMenu\(\)[\s\S]*await refreshAll\(state\.tabContext\)/, "success should apply response metadata, show /tree feedback, conditionally close the original menu, and refresh");
assert.match(navigateSource, /not available in the current persisted session tree[\s\S]*session was not changed/, "missing or stale targets should fail visibly without navigation");
assert.match(navigateSource, /state\.busy = true[\s\S]*action\.disabled = true[\s\S]*finally[\s\S]*action\.disabled = false/, "the action should preserve busy/error controls");

assert.match(styles, /\.event-filter-bar \{[\s\S]*grid-template-columns: auto minmax\(0, 1fr\) auto/, "the filter bar should keep its label, native select, and count aligned");
assert.match(styles, /\.event\[hidden\] \{ display: none; \}/, "filtered event rows should remain hidden despite the row display rule");
assert.match(styles, /\.event-details \{[\s\S]*flex-wrap: wrap/, "bounded details should wrap in detailed mode");
assert.match(styles, /\.event-log\[data-display-mode="compact"\] \.event-details \{ display: none; \}/, "compact mode should hide secondary metadata");
assert.match(styles, /\.event-log\[data-display-mode="compact"\] \.event\[data-event-tool-phase\][\s\S]*border-left:[\s\S]*\.event\[data-event-tool-phase="finish"\][\s\S]*border-left-color/, "compact tool events should retain visible lifecycle accents");
assert.match(styles, /\.event-tree-context-menu \{[\s\S]*max-width: calc\(100vw - 1rem\)/, "the dedicated menu should remain viewport bounded");

// Cache tuple for this browser-asset change.
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155";/, "the PWA cache identity should advance");
assert.match(html, /styles\.css\?v=154/, "compact-mode styles should advance the stylesheet revision");
assert.match(html, /data-app-src="\/app\.js\?v=184"/, "the app query revision should advance");

console.log("events-tree-context-menu-static.test.mjs passed");
