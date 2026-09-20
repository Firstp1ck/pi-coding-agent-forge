import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "app.js"), "utf8");
const styles = await readFile(join(root, "public", "styles.css"), "utf8");
const transcriptRenderer = await readFile(join(root, "public", "transcript-renderer.mjs"), "utf8");

const SELF_CONTAINED_THEORY_TITLES = new Map([
  [0, "Live todo-progress widget rebuild"],
  [1, "scrollChatToBottom"],
  [2, "O(n²) re-parse"],
  [3, "markdown re-render fallback"],
  [4, "setRunIndicatorActivity"],
  [5, "ingestEventTabActivity"],
  [6, "markTabOutputSeen"],
  [7, "Skill / auto-retry tracking"],
  [8, "steer prompt"],
]);

function findFunctionBody(source, name) {
  const signature = new RegExp(`function\\s+${name}\\s*\\(`, "m");
  const match = signature.exec(source);
  assert.ok(match, `${name} should be defined`);
  let parenDepth = 0;
  let openBrace = -1;
  for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth -= 1;
    else if (char === "{" && parenDepth === 0) {
      openBrace = index;
      break;
    }
  }
  assert.notEqual(openBrace, -1, `${name} body should open`);
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  assert.fail(`${name} body should close`);
}

function findCaseBody(source, caseLabel) {
  const caseStart = source.indexOf(`case "${caseLabel}":`);
  assert.notEqual(caseStart, -1, `case ${caseLabel} should exist`);
  const nextCase = source.indexOf("\n    case ", caseStart + 1);
  const defaultCase = source.indexOf("\n    default:", caseStart + 1);
  const candidates = [nextCase, defaultCase].filter((index) => index !== -1);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(caseStart, end);
}

function assertDocTheory(id, titleFragment) {
  const title = SELF_CONTAINED_THEORY_TITLES.get(id);
  assert.ok(title, `self-contained theory ${id} should be listed`);
  assert.match(title, new RegExp(titleFragment), `self-contained theory ${id} should include: ${titleFragment}`);
}

const futureFailures = [];
function futureInvariant(name, assertion) {
  try {
    assertion();
  } catch (error) {
    futureFailures.push(`${name}\n  ${error.message}`);
  }
}

// Keep the test suite explicitly tied to the audit theories it enforces.
assertDocTheory(0, "Live todo-progress widget rebuild");
assertDocTheory(1, "scrollChatToBottom");
assertDocTheory(2, "O\\(n²\\) re-parse");
assertDocTheory(3, "markdown re-render fallback");
assertDocTheory(4, "setRunIndicatorActivity");
assertDocTheory(5, "ingestEventTabActivity");
assertDocTheory(6, "markTabOutputSeen");
assertDocTheory(7, "Skill / auto-retry tracking");
assertDocTheory(8, "steer prompt");

const syncLiveTodoProgressWidgetFromText = findFunctionBody(app, "syncLiveTodoProgressWidgetFromText");
const scheduleLiveWidgetRender = findFunctionBody(app, "scheduleLiveWidgetRender");
const appendOptimisticUserPrompt = findFunctionBody(app, "appendOptimisticUserPrompt");
const handleMessageUpdate = findFunctionBody(app, "handleMessageUpdate");
const scrollChatToBottom = findFunctionBody(app, "scrollChatToBottom");
const stripTodoProgressLines = findFunctionBody(app, "stripTodoProgressLines");
const liveTodoProgressWidgetLinesFromText = findFunctionBody(app, "liveTodoProgressWidgetLinesFromText");
const syncStreamingThinkingFormat = findFunctionBody(app, "syncStreamingThinkingFormat");
const setStreamThinkingRawText = findFunctionBody(app, "setStreamThinkingRawText");
const syncStreamingThinkingFromUpdate = findFunctionBody(app, "syncStreamingThinkingFromUpdate");
const renderStreamingAssistantText = findFunctionBody(app, "renderStreamingAssistantText");
const renderStreamingMarkdown = findFunctionBody(app, "renderStreamingMarkdown");
const setRunIndicatorActivity = findFunctionBody(app, "setRunIndicatorActivity");
const ingestEventTabActivity = findFunctionBody(app, "ingestEventTabActivity");
const handleEvent = findFunctionBody(app, "handleEvent");
const markTabOutputSeen = findFunctionBody(app, "markTabOutputSeen");
const trackSkillsFromEvent = findFunctionBody(app, "trackSkillsFromEvent");
const trackAutoRetryStateFromEvent = findFunctionBody(app, "trackAutoRetryStateFromEvent");
const requestGitFooterWebuiPayload = findFunctionBody(app, "requestGitFooterWebuiPayload");

// Fixed theory #0 should stay fixed while the remaining tests fail until their
// corresponding stream/UI coupling issues are removed.
assert.doesNotMatch(
  syncLiveTodoProgressWidgetFromText,
  /(^|\n)\s*updateOptionalFeatureAvailability\s*\(/,
  "fixed theory #0: live todo-progress sync must not reconcile optional-feature chrome per token",
);
assert.match(syncLiveTodoProgressWidgetFromText, /scheduleLiveWidgetRender\s*\(/, "fixed theory #0: live todo-progress widget rendering should remain scheduler-based");
assert.match(scheduleLiveWidgetRender, /requestAnimationFrame\s*\(/, "fixed theory #0: live widget rebuilds should remain coalesced to animation frames");
assert.match(scheduleLiveWidgetRender, /liveWidgetRenderFrame !== null/, "fixed theory #0: repeated tokens in one frame should not queue duplicate widget rebuilds");
assert.match(
  stripTodoProgressLines,
  /isOptionalFeatureDetected\("todoProgressWidget"\)/,
  "todo-progress transport lines should remain hidden when only the optional widget renderer is disabled",
);
assert.doesNotMatch(
  stripTodoProgressLines,
  /isOptionalFeatureEnabled\("todoProgressWidget"\)/,
  "todo-progress output filtering must not depend on the widget renderer toggle",
);
assert.match(
  liveTodoProgressWidgetLinesFromText,
  /isOptionalFeatureEnabled\("todoProgressWidget"\)/,
  "disabling todo-progress should still suppress the optional widget renderer itself",
);

assert.match(styles, /\.chat \{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;/, "the transcript should retain a stable vertical flow as composer geometry changes");
assert.match(styles, /\.chat > \.message:first-of-type \{ margin-top:\s*0; \}/, "settled transcript cards should stay top-anchored while the prompt textarea auto-resizes");
assert.doesNotMatch(styles, /\.chat > \.message:first-of-type \{ margin-top:\s*auto; \}/, "short transcripts must not follow the moving composer edge while the user types");
assert.match(appendOptimisticUserPrompt, /renderAllMessages\(\);[\s\S]*?scrollChatToBottom\(\{ force:\s*true \}\);/, "submitting a prompt should explicitly resume bottom-follow for the new turn");
assert.doesNotMatch(appendOptimisticUserPrompt, /if \(autoFollowChat \|\| isChatNearBottom\(\)\)/, "a paused reader position should not leave a newly submitted turn off-screen");
assert.match(app, /import \{[^}]*reconcileTranscriptThinkingSnapshot[^}]*\} from "\.\/stream-output-controller\.mjs";/, "the browser should import the tested thinking-snapshot reconciler");
assert.match(setStreamThinkingRawText, /reconcile\s*\?\s*reconcileTranscriptThinkingSnapshot\(streamThinkingRawText, snapshot\)/, "thinking state should use authoritative snapshot reconciliation");
assert.match(syncStreamingThinkingFromUpdate, /update\.type === "thinking_end"[\s\S]*?typeof update\.content === "string"[\s\S]*?setStreamThinkingRawText\(snapshot, \{ reconcile: true \}\)/, "thinking_end must apply explicit shortened or empty content rather than preserving discarded tails");

futureInvariant("theory #1: message_update streaming hot path must not call immediate scroll/layout work", () => {
  assert.doesNotMatch(handleMessageUpdate, /scrollChatToBottom\s*\(/, "handleMessageUpdate should schedule/coalesce follow-scroll instead of calling scrollChatToBottom() directly");
});
futureInvariant("theory #1: scrollChatToBottom must not synchronously read scrollHeight and write scrollTop", () => {
  assert.doesNotMatch(scrollChatToBottom, /setChatScrollTopInstant\(elements\.chat\.scrollHeight\)/, "scrollChatToBottom should route layout-sensitive scroll work through a frame-coalesced flusher");
});
futureInvariant("theory #1: disabled auto-follow must not refresh jump/sticky layout from the token path", () => {
  assert.doesNotMatch(scrollChatToBottom, /!autoFollowChat[\s\S]*?updateJumpToLatestButton\(\)[\s\S]*?updateStickyUserPromptButton\(\)/, "jump/sticky button layout reads should be debounced or frame-coalesced, not run per token");
});

futureInvariant("theory #2: text deltas must not re-read the full accumulated assistant message", () => {
  assert.doesNotMatch(handleMessageUpdate, /assistantTextFromMessage\(assistantStreamingMessage\(event\), \{ streaming: true \}\)/, "text_delta should process only the new delta tail or a cached parse state");
});
futureInvariant("theory #2: thinking deltas must not re-read the full accumulated assistant message", () => {
  assert.doesNotMatch(handleMessageUpdate, /assistantThinkingTextFromMessage\(assistantStreamingMessage\(event\), \{ streaming: true \}\)/, "thinking_delta should process only the new delta tail or a cached parse state");
});
futureInvariant("theory #2: streaming todo stripping must not split the full accumulated stream each render", () => {
  assert.doesNotMatch(stripTodoProgressLines, /raw\.split\(\/\\r\?\\n\//, "stripTodoProgressLines should be incremental/cached for streaming input");
});
futureInvariant("theory #2: live todo widget extraction must not split the full accumulated stream each token", () => {
  assert.doesNotMatch(liveTodoProgressWidgetLinesFromText, /raw\.split\(\/\\r\?\\n\//, "liveTodoProgressWidgetLinesFromText should process the new tail or cached block state");
});
futureInvariant("theory #2: thinking-format parsing must not reparse the full accumulated assistant text", () => {
  assert.doesNotMatch(syncStreamingThinkingFormat, /splitThinkingFormatText\(assistantText, \{ streaming: true \}\)/, "syncStreamingThinkingFormat should use incremental/cached parsing while streaming");
});
futureInvariant("theory #2: streaming assistant render must not derive all views from streamRawText on every render", () => {
  assert.doesNotMatch(renderStreamingAssistantText, /stripTodoProgressLines\(streamRawText, \{ streaming: true \}\)/, "renderStreamingAssistantText should consume cached/incremental visible-text state instead of rescanning streamRawText");
});

futureInvariant("theory #3: streaming markdown must not full-rebuild when earlier derived text changes", () => {
  const reconcileMarkdownSurface = findFunctionBody(transcriptRenderer, "reconcileMarkdownSurface");
  assert.match(renderStreamingMarkdown, /transcriptRenderer\.reconcileMarkdownSurface\(\{[\s\S]*?stableBoundary: streamingMarkdownStableBoundary[\s\S]*?renderInto: renderMarkdownInto/, "streaming markdown must route through the coordinator's committed-block/mutable-tail reconciler");
  assert.doesNotMatch(renderStreamingMarkdown, /block\.replaceChildren\(\)/, "streaming markdown must not replace the whole block directly");
  assert.match(reconcileMarkdownSurface, /!value\.startsWith\(state\.value\)[\s\S]*?invalidateSelection: diverged/, "retroactive todo/thinking rewrites must compare the whole previous surface value and explicitly invalidate selection");
  assert.match(reconcileMarkdownSurface, /if \(boundary > state\.stableText\.length\)/, "committed blocks must stay mounted for append-only updates");
  assert.match(reconcileMarkdownSurface, /for \(const node of state\.tailNodes\) node\.remove\(\)/, "only the mutable tail may be re-parsed per delta batch");
});

futureInvariant("theory #4: run-indicator activity changes must not render/scroll synchronously from token paths", () => {
  assert.doesNotMatch(setRunIndicatorActivity, /if \(needsRender\) renderRunIndicator\(\{ scroll \}\)/, "setRunIndicatorActivity should schedule/coalesce indicator rendering instead of rendering immediately");
});
futureInvariant("theory #4: run-indicator token updates must not touch composer chrome unconditionally", () => {
  assert.doesNotMatch(setRunIndicatorActivity, /updateComposerModeButtons\(\)/, "composer mode button reconciliation should be gated/coalesced outside steady-state token updates");
});

futureInvariant("theory #5: tab activity ingestion must not rebuild tabs synchronously per event", () => {
  assert.doesNotMatch(ingestEventTabActivity, /if \(changed\) renderTabs\(\)/, "tab chrome should be updated via a frame-coalesced affected-tab render, not renderTabs() directly");
});
futureInvariant("theory #5: handleEvent must not run tab chrome ingestion for every raw server event", () => {
  assert.doesNotMatch(handleEvent, /^\s*ingestEventTabActivity\(event\);/m, "tab activity ingestion should be filtered/coalesced before global event dispatch touches chrome");
});

futureInvariant("theory #6: output-seen tab refresh should remain out of the message_update token path", () => {
  assert.doesNotMatch(handleMessageUpdate, /markTabOutputSeen\s*\(/, "markTabOutputSeen should stay event-end driven, not token driven");
});
futureInvariant("theory #6: event-end output-seen refresh should not synchronously rebuild all tabs", () => {
  assert.doesNotMatch(markTabOutputSeen, /renderTabs\(\)/, "output-seen serial changes should schedule/coalesce tab chrome updates");
});
assert.match(findCaseBody(handleEvent, "agent_settled"), /markTabOutputSeen\(\)/, "theory #6: output-seen marking should happen only when a logical run settles");
assert.match(findCaseBody(handleEvent, "compaction_end"), /markTabOutputSeen\(\)/, "theory #6: output-seen marking should still happen when compaction ends");

futureInvariant("theory #7: skill tracking must not inspect every message_update event", () => {
  assert.doesNotMatch(trackSkillsFromEvent, /event\.type === "message_update"/, "skill tracking should be event-filtered so plain text/thinking deltas do not enter tracking code");
});
futureInvariant("theory #7: auto-retry and skill tracking must not run before every event dispatch", () => {
  assert.doesNotMatch(handleEvent, /^\s*trackAutoRetryStateFromEvent\(event\);\n\s*trackSkillsFromEvent\(event\);/m, "tracking hooks should be case-specific or pre-filtered, not invoked for every server event");
});
assert.match(trackAutoRetryStateFromEvent, /event\.type === "auto_retry_start"/, "theory #7: auto-retry bookkeeping should remain scoped to retry events");

// Theory #8 is a correctness guard: the current design still uses a steer prompt,
// but it must never run while the agent is active.
assert.match(requestGitFooterWebuiPayload, /currentState\?\.isStreaming \|\| currentState\?\.isCompacting/, "theory #8: git-footer steer refresh must remain guarded during active streaming/compaction");
assert.match(findCaseBody(handleEvent, "agent_settled"), /currentState\) currentState = \{ \.\.\.currentState, isStreaming: false \};[\s\S]*?requestGitFooterWebuiPayload\(tabContext, \{ force: true \}\)/, "theory #8: forced git-footer refresh should only happen after agent settlement clears streaming state");
assert.doesNotMatch(findCaseBody(handleEvent, "agent_end"), /isStreaming: false|requestGitFooterWebuiPayload/, "theory #8: low-level agent_end must not expose an idle window before retry or continuation");

// --- WS2a: lifecycle / chrome / todo ownership separation ---
// These are hard invariants, not future theories: raw stream output may not own
// lifecycle chrome, and lifecycle chrome may not be driven by token cadence.

const renderMessages = findFunctionBody(app, "renderMessages");
const refreshMessages = findFunctionBody(app, "refreshMessages");
const setRunIndicatorActivityBody = findFunctionBody(app, "setRunIndicatorActivity");
const startRunIndicatorTicker = findFunctionBody(app, "startRunIndicatorTicker");
const startLifecycleStateWatchdog = findFunctionBody(app, "startLifecycleStateWatchdog");
const reconcileTodoProgressFromMessages = findFunctionBody(app, "reconcileTodoProgressFromMessages");
const eventMayAffectSkillUsage = findFunctionBody(app, "eventMayAffectSkillUsage");
const flushSemanticReconcile = findFunctionBody(app, "flushSemanticReconcile");

// (1) Transcript rendering is transcript-only; chrome belongs to the reconciler.
assert.doesNotMatch(renderMessages, /renderFooter\(\)|renderFeedbackTray\(\)|renderWidgets\(\)|renderStatus\(\)/, "WS2a: renderMessages must be transcript-only and must not render footer/feedback/widget/status chrome");
assert.match(renderMessages, /renderAllMessages\(\)/, "WS2a: renderMessages must still own transcript rendering");

// (2) Todo progress derives from authoritative content, never token cadence.
assert.doesNotMatch(app, /function scheduleLiveTodoProgressWidgetSync/, "WS2a: the token-driven todo-progress scheduler must be removed");
assert.doesNotMatch(app, /scheduleLiveTodoProgressWidgetSync\(/, "WS2a: nothing may schedule token-driven todo-progress syncs");
assert.match(reconcileTodoProgressFromMessages, /authoritativeTodoProgressSourceText\([\s\S]*?syncLiveTodoProgressWidgetFromText\(/, "WS2a: todo progress must be derived from authoritative assistant content");
assert.match(refreshMessages, /reconcileTodoProgressFromMessages\(latestMessages, tabContext\.tabId\)/, "WS2a: todo progress must be derived once at authoritative message reconciliation");
assert.match(findFunctionBody(app, "syncLiveTodoProgressWidgetFromText"), /todoProgressSignatureByTab\.get\(tabId\) === signature\) return false/, "WS2a: the todo widget record may change only when its semantic value changes");

// (3) Activity wording is transcript-owned; composer/Stop changes on transitions.
assert.doesNotMatch(setRunIndicatorActivityBody, /^\s*scheduleComposerModeButtonsUpdate\(\);/m, "WS2a: activity wording must not unconditionally reconcile composer chrome");
assert.match(setRunIndicatorActivityBody, /syncLifecycleComposerState\(\)/, "WS2a: composer/Stop reconciliation must be gated on a lifecycle signature change");
assert.match(findFunctionBody(app, "syncLifecycleComposerState"), /signature === lifecycleComposerSignature\) return false/, "WS2a: an unchanged lifecycle signature must not schedule composer work");
assert.match(app, /runIndicatorBubble\.dataset\.streamOwned = "run-indicator"/, "WS2a: the live activity root must be a stable transcript-owned node");

// (4) The transcript ticker must not perform lifecycle/network reconciliation.
assert.doesNotMatch(startRunIndicatorTicker, /maybeRefreshRunIndicatorState\(\)/, "WS2a: the transcript-owned ticker must only repaint its own node");
assert.match(startLifecycleStateWatchdog, /maybeRefreshRunIndicatorState\(\)/, "WS2a: canonical state rechecks belong to the lifecycle watchdog");

// (5) Skills and event-log records happen once at semantic tool boundaries.
assert.doesNotMatch(eventMayAffectSkillUsage, /tool_execution_update|toolcall_start/, "WS2a: skill tracking must not be reachable from tool update/argument cadence");
assert.match(eventMayAffectSkillUsage, /"tool_execution_start", "tool_execution_end"/, "WS2a: skill tracking must run at semantic tool boundaries");
assert.match(trackSkillsFromEvent, /recordedToolBoundaryKeys\.has\(key\)[\s\S]*?trackSkillsFromToolInvocation[\s\S]*?if \(tracked && key\) rememberToolBoundaryRecordKey\(key\)/, "WS2a: usable tool skill records must be deduplicated without consuming a missing-args fallback");
assert.match(findCaseBody(handleEvent, "tool_execution_start"), /claimToolBoundaryRecord\(event, "log:start"\)\) addEvent\(/, "WS2a: tool start event-log records must be deduplicated by tool boundary");
assert.match(findCaseBody(handleEvent, "tool_execution_end"), /claimToolBoundaryRecord\(event, "log:end"\)\) addEvent\(/, "WS2a: tool end event-log records must be deduplicated by tool boundary");

// (6) Lifecycle boundaries reconcile chrome through one coalesced scheduler.
assert.match(findFunctionBody(app, "scheduleSemanticReconcile"), /mergeSemanticReconcileRequest\(semanticReconcilePending, dirty, tabContext\)[\s\S]*?semanticReconcileFrame !== null\) return;/, "WS2a: semantic reconciliation must coalesce partitioned requests to one pending flush");
assert.match(findFunctionBody(app, "mergeSemanticReconcileRequest"), /semanticReconcileContextKey\(tabContext\)[\s\S]*?pendingByContext\.set\(key, request\)/, "WS2a: semantic dirty flags must remain partitioned by tab generation");
assert.match(flushSemanticReconcile, /if \(dirty\.workflow\) reconcileGitWorkflowContinuation\(tabContext\.tabId\);[\s\S]*?if \(!isCurrentTabContext\(tabContext\)\) continue;/, "WS2a: originating workflow settlement must run before stale active-DOM work no-ops");
const reconcileGitWorkflowContinuation = findFunctionBody(app, "reconcileGitWorkflowContinuation");
assert.match(reconcileGitWorkflowContinuation, /workflow\.step === "readmeGenerating"[\s\S]*?prepareGitInitFiles\(\{ afterReadmePrompt: true,[\s\S]*?workflow\.step === "gitignoreGenerating"[\s\S]*?prepareGitInitFiles\(\{ afterGitignorePrompt: true,/, "WS2a: settlement must continue README and .gitignore initialization after Pi finishes");
for (const [caseLabel, flag] of [["agent_start", "state: true"], ["agent_end", "messages: true"], ["message_end", "messages: true"], ["agent_settled", "messages: true"]]) {
  assert.match(findCaseBody(handleEvent, caseLabel), new RegExp(`scheduleSemanticReconcile\\(\\{[\\s\\S]*?${flag}`), `WS2a: ${caseLabel} must reconcile chrome through the coalesced semantic scheduler`);
}
assert.match(findCaseBody(handleEvent, "agent_settled"), /usage: true,[\s\S]*?workflow: true,/, "WS2a: settlement must own the coalesced post-turn usage/workflow reconciliation");

if (futureFailures.length) {
  assert.fail(`streaming/UI coupling invariants still failing (${futureFailures.length}):\n\n${futureFailures.map((failure, index) => `${index + 1}. ${failure}`).join("\n\n")}`);
}

console.log("streaming-ui-coupling.test.mjs passed");
