import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "app.js"), "utf8");
const queue = await readFile(join(root, "public", "activity-queue-controller.mjs"), "utf8");
const renderer = await readFile(join(root, "public", "transcript-renderer.mjs"), "utf8");

function functionBody(name, source = app) {
  const signature = new RegExp(`function\\s+${name}\\s*\\(`, "m");
  const match = signature.exec(source);
  assert.ok(match, `${name} should remain a standalone frontend helper`);
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

const captureControl = functionBody("captureScopedControlContinuity");
const restoreControl = functionBody("restoreScopedControlContinuity");
const setScroll = functionBody("setScopedScrollContinuity");
const rememberScroll = functionBody("rememberScopedScrollContinuity");
const bindScroll = functionBody("bindScopedScrollContinuity");
const restoreScroll = functionBody("restoreScopedScrollContinuity");
const deferPointer = functionBody("deferUiRenderDuringPointerActivation");
const deferSurface = functionBody("deferUiRenderDuringInteractiveSurface");
const flushDeferred = functionBody("flushDeferredUiRenders");
const captureTooltip = functionBody("captureTooltipContinuity");
const restoreTooltip = functionBody("restoreTooltipContinuity");
const renderTabs = functionBody("renderTabs");
const renderFooter = functionBody("renderFooter");
const renderFileTree = functionBody("renderFileTree");
const renderWidgets = functionBody("renderWidgets");
const renderSubagents = functionBody("renderSubagents");
const renderGitWorkflow = functionBody("renderGitWorkflow");
const renderGitPanel = functionBody("renderGitPanel");
const renderQueue = functionBody("render", queue);
const captureChatText = functionBody("captureChatTextSelection");
const matchChatText = functionBody("chatTextSelectionMatch");
const restoreChatText = functionBody("restoreChatTextSelection");
const renderAllMessages = functionBody("renderAllMessages");
const bindToolDetailsScrollMode = functionBody("bindToolDetailsScrollMode");
const markInteractedToolBubble = functionBody("markInteractedToolBubble");
const ensureToolInteractionDelegation = functionBody("ensureToolInteractionDelegation");
const captureInteractedToolInteraction = functionBody("captureInteractedToolInteractionState");
const captureToolDetailsInteraction = functionBody("captureToolDetailsInteractionState");
const restoreToolDetailsInteraction = functionBody("restoreToolDetailsInteractionState");
const updateLiveToolCard = functionBody("updateLiveToolCard");
const renderStreamingMarkdown = functionBody("renderStreamingMarkdown");
const refreshMessages = functionBody("refreshMessages");
const restoreStreamRender = functionBody("restoreStreamRenderAfterChatRebuild");
const captureMobileSurface = functionBody("captureMobileSurfaceRenderFocus");
const restoreMobileSurface = functionBody("restoreMobileSurfaceRenderFocus");
const captureAppRunnerInput = functionBody("captureAppRunnerInputFocus");
const restoreAppRunnerInput = functionBody("restoreAppRunnerInputFocus");
const captureGitInput = functionBody("captureGitWorkflowInputFocus");
const restoreGitInput = functionBody("restoreGitWorkflowInputFocus");

assert.match(captureControl, /root\?\.contains\(source\)/, "control capture must be scoped to the renderer root");
assert.match(captureControl, /const targetKey = targetKeyFor\?\.\(source\);[\s\S]*if \(!targetKey\) return null;/, "control capture requires a semantic target key");
assert.match(captureControl, /contextKey,[\s\S]*selectionStart:[\s\S]*selectionEnd:[\s\S]*selectionDirection:[\s\S]*scrollTop:[\s\S]*scrollLeft:/, "control snapshots must retain context, selection direction, and both control scroll axes");
assert.match(restoreControl, /snapshot\.contextKey !== contextKey \|\| document\.activeElement === snapshot\.source/, "restore must reject mismatched contexts and leave an already-focused surviving source alone");
assert.match(restoreControl, /isMeaningfulConnectedFocus\(document\.activeElement\)/, "restore must not steal focus from a meaningful connected target");
assert.match(restoreControl, /snapshot\.source\.isConnected && root\?\.contains\(snapshot\.source\)[\s\S]*targetForKey\?\.\(snapshot\.targetKey\)[\s\S]*root\?\.contains\(target\)[\s\S]*target\.disabled/, "restore must prefer a surviving reattached control or resolve a valid replacement inside its root");
assert.match(restoreControl, /target\.focus\(\{ preventScroll: true \}\)[\s\S]*setSelectionRange\(start, end, snapshot\.selectionDirection \|\| "none"\)/, "restore must restore focus and directional selection without scrolling the page");
assert.match(restoreControl, /target\.scrollTop = Math\.min[\s\S]*target\.scrollLeft = Math\.min/, "restore must bound control scroll rather than applying stale offsets blindly");

assert.match(captureTooltip, /footerTooltipTarget \|\| footerTooltipPendingTarget[\s\S]*root\?\.contains\(target\)[\s\S]*tooltipTargetKey\(target\)[\s\S]*target\.matches\?\.\(":hover"\)[\s\S]*remainingDelay:/, "tooltip capture must use a root-local semantic target and retain any in-progress hover delay");
assert.match(restoreTooltip, /querySelectorAll\?\.\("\[data-tooltip-target-key\]"\)[\s\S]*tooltipTargetKey\(node\) === snapshot\.key/, "tooltip restore must find the semantic replacement rather than reusing detached DOM");
assert.match(restoreTooltip, /!target \|\| !target\.hasAttribute\("data-tooltip"\)[\s\S]*hideFooterTooltip\(snapshot\.target\)/, "removed or inapplicable tooltip targets must close the old tooltip");
assert.match(restoreTooltip, /snapshot\.pending\) scheduleFooterTooltip\(target, snapshot\.remainingDelay\)[\s\S]*showFooterTooltip\(target\)/, "surviving visible tooltips must rebind synchronously while pending tooltips retain only their remaining delay");

assert.match(setScroll, /scopedScrollContinuityByKey\.delete\(key\)[\s\S]*size > SCOPED_SCROLL_CONTINUITY_LIMIT[\s\S]*keys\(\)\.next\(\)\.value/, "scroll continuity must use bounded recency storage");
assert.match(rememberScroll, /!node\?\.isConnected \|\| !key[\s\S]*const previous = scopedScrollContinuityByKey\.get\(key\);[\s\S]*preserveMode && previous \? previous\.mode : maxScrollTop - node\.scrollTop <= 24 \? "follow-end" : "position"/, "scroll capture must ignore detached stale emitters and latch reader mode across programmatic renders");
assert.match(bindScroll, /dataset\.continuityScrollKey = key[\s\S]*_scopedScrollContinuityUserIntentUntil[\s\S]*rememberScopedScrollContinuity\(node, undefined, \{ allowPendingRestore: userInitiated, preserveMode: !userInitiated \}\)/, "scroll listeners must resolve the current semantic key and only change mode after user intent");
assert.match(restoreScroll, /requestAnimationFrame[\s\S]*state\.mode === "follow-end" \? maxScrollTop : Math\.min/, "scroll restore must apply its mode after layout and bound a retained position");
assert.match(app, /bindScopedScrollContinuity\(terminal, scrollKey\)[\s\S]*restoreScopedScrollContinuity\(terminal, scrollKey\)/, "app-runner output must participate in explicit scroll continuity");
assert.match(app, /bindScopedScrollContinuity\(transcript, scrollKey\)[\s\S]*restoreScopedScrollContinuity\(transcript, scrollKey\)/, "subagent transcript output must participate in explicit scroll continuity");

assert.match(deferPointer, /shouldDeferUiRenderForPointerActivation\(\)[\s\S]*deferredUiRenderCallbacks\.set\(key, callback\)/, "pointer-active updates must defer through a latest-wins keyed callback map");
assert.match(deferSurface, /isInteractiveDropdownOpen\(\)[\s\S]*deferredUiRenderCallbacks\.set\(key, callback\)[\s\S]*scheduleDeferredUiFlushAfterDropdownClose\(\)/, "open interactive surfaces must defer their invalidation until they close");
assert.match(flushDeferred, /\[\.\.\.deferredUiRenderCallbacks\.values\(\)\][\s\S]*deferredUiRenderCallbacks\.clear\(\)[\s\S]*for \(const callback of callbacks\)/, "deferred renders must coalesce and flush each retained callback once");

for (const [name, source, root] of [
  ["terminal tabs", renderTabs, "elements.tabBar"],
  ["footer", renderFooter, "elements.statusBar"],
  ["file tree", renderFileTree, "root"],
  ["widgets", renderWidgets, "elements.widgetArea"],
  ["subagent panel", renderSubagents, "box"],
]) {
  assert.match(source, /deferUiRenderDuringPointerActivation/, `${name} must participate in primary-pointer deferral`);
  assert.match(source, /captureScopedControlContinuity|captureScopedScrollContinuity/, `${name} must capture only its own continuity state`);
  if (name === "terminal tabs" || name === "footer" || name === "file tree" || name === "subagent panel") {
    assert.match(source, new RegExp(`restoreScopedControlContinuity\\(${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), `${name} must restore through its own root`);
  }
}
assert.match(renderTabs, /captureTooltipContinuity\(elements\.tabBar\)[\s\S]*restoreTooltipContinuity\(elements\.tabBar, tooltipSnapshot\)/, "terminal-tab rerenders must retain semantic tooltip continuity");
assert.match(renderFooter, /captureTooltipContinuity\(elements\.statusBar\)[\s\S]*restoreTooltipContinuity\(elements\.statusBar, tooltipSnapshot\)/, "footer rerenders must retain semantic tooltip continuity");
assert.match(renderGitWorkflow, /captureGitWorkflowInputFocus\(\)[\s\S]*deferUiRenderDuringPointerActivation\("git-workflow", renderGitWorkflow\)[\s\S]*restoreGitWorkflowInputFocus\(inputFocus\)/, "guided Git renders must defer pointer teardown and restore only their captured input");

assert.match(captureAppRunnerInput, /activeTabContext\(\)[\s\S]*selectionDirection:[\s\S]*scrollTop:[\s\S]*scrollLeft:/, "app-runner input capture must include its tab context and complete text-control state");
assert.match(restoreAppRunnerInput, /isCurrentTabContext\(state\.context\) \|\| state\.source\?\.isConnected/, "app-runner input restore must reject stale tab contexts and connected sources");
assert.match(restoreAppRunnerInput, /isMeaningfulConnectedFocus\(document\.activeElement\)[\s\S]*featureWidgetElements\("\.app-runner-stdin-input"\)[\s\S]*candidate\.dataset\.runId === state\.runId/, "app-runner input restore must stay inside canonical feature widget roots and match runner identity");
assert.match(captureGitInput, /activeTabContext\(\)[\s\S]*selectionDirection:[\s\S]*scrollTop:[\s\S]*scrollLeft:/, "Guided Git input capture must include its context and complete text-control state");
assert.match(restoreGitInput, /state\.tabId !== activeTabId \|\| state\.runId !== gitWorkflow\?\.runId \|\| !isCurrentTabContext\(state\.context\) \|\| state\.source\?\.isConnected/, "Guided Git input restore must require the exact tab, run, and current context");

assert.match(renderGitPanel, /captureScopedControlContinuity\(elements\.gitPanelGroups[\s\S]*data-git-panel-continuity-key[\s\S]*scrollTop = scrollTop/, "Git-panel rebuilds must preserve semantic focus and panel scroll");
assert.match(renderQueue, /captureContinuity\(nodes\.queueBox[\s\S]*data-queue-continuity-key[\s\S]*restore\(\)/, "queue rebuilds must preserve semantic action focus and panel scroll");
assert.match(app, /dataset\.mobileContinuityKey = "context:paste-text"[\s\S]*dataset\.mobileDraftAuthority = "dom"/, "mobile paste text must have a stable DOM-authoritative continuity identity");
assert.match(captureMobileSurface, /mobileDraftAuthority === "dom"[\s\S]*selectionDirection:[\s\S]*scrollTop:[\s\S]*scrollLeft:/, "mobile DOM drafts must capture selection and scroll state");
assert.match(restoreMobileSurface, /target\.dataset\.mobileDraftAuthority === "dom"[\s\S]*target\.value = snapshot\.value[\s\S]*setSelectionRange[\s\S]*target\.focus\(\{ preventScroll: true \}\)/, "mobile DOM drafts must restore value, selection, scroll, and focus");

assert.match(captureChatText, /selection\.isCollapsed[\s\S]*!anchorSurface \|\| !focusSurface[\s\S]*chatTextSelectionEndpoint\(anchorSurface[\s\S]*chatTextSelectionEndpoint\(focusSurface[\s\S]*chatTextSelectionContextKey\(\)[\s\S]*anchor,[\s\S]*focus,[\s\S]*text,/, "main-output selection capture must retain distinct semantic anchor/focus endpoints, context, direction, and exact text");
assert.match(matchChatText, /chatTextSelectionEndpointPoint\(anchorSurface, snapshot\.anchor\)[\s\S]*chatTextSelectionEndpointPoint\(focusSurface, snapshot\.focus\)[\s\S]*chatTextSelectionSpansSurfaces\(snapshot\) \|\| text === snapshot\.text/, "main-output selection restoration must validate exact semantic endpoints while allowing harmless intermediate UI text changes across surfaces");
assert.match(restoreChatText, /snapshot\.contextKey !== chatTextSelectionContextKey\(\)[\s\S]*chatTextSelectionCandidates\(snapshot, "anchor"\)[\s\S]*chatTextSelectionCandidates\(snapshot, "focus"\)[\s\S]*anchorCandidates\.includes\(currentAnchorSurface\)[\s\S]*focusCandidates\.includes\(currentFocusSurface\)[\s\S]*currentText && currentAnchorSurface && currentFocusSurface[\s\S]*setBaseAndExtent/, "main-output selection restoration must reject stale contexts and meaningful newer selections while preserving cross-surface anchor direction");
assert.match(renderStreamingMarkdown, /captureChatTextSelection\(block\)[\s\S]*restoreChatTextSelection\(selectionSnapshot\)/, "streaming Markdown tail replacement must preserve a still-valid browser Range");
assert.match(renderAllMessages, /captureChatTextSelection\(\)[\s\S]*restoreChatTextSelection\(selectionSnapshot\)/, "authoritative transcript rerenders must preserve a still-valid main-output Range");
assert.doesNotMatch(renderAllMessages, /applyToolOutputExpansionToDom\(|captureTranscriptToolInteractionState\(|restoreTranscriptToolInteractionState\(/, "routine transcript rerenders must not scan or overwrite every historical tool disclosure");
assert.match(app, /const INTERACTED_TOOL_BUBBLE_LIMIT = 16;/, "interacted tool continuity must stay tightly bounded");
assert.match(markInteractedToolBubble, /interactedToolBubbles\.delete\(bubble\)[\s\S]*interactedToolBubbles\.add\(bubble\)[\s\S]*size > INTERACTED_TOOL_BUBBLE_LIMIT/, "interacted tool continuity must use a bounded recency set");
assert.match(ensureToolInteractionDelegation, /toolInteractionDelegationBound[\s\S]*elements\.chat\.addEventListener\("toggle"[\s\S]*elements\.chat\.addEventListener\("focusin"[\s\S]*elements\.chat\.addEventListener\("scroll"[\s\S]*scrollHeight - node\.clientHeight/, "tool interaction tracking must use one delegated listener set and measure layout only on actual scroll events");
assert.match(captureInteractedToolInteraction, /for \(const bubble of \[\.\.\.interactedToolBubbles\]\)[\s\S]*!bubble\.isConnected[\s\S]*captureToolDetailsInteractionState\(bubble\)/, "transcript reconciliation must inspect only bounded, previously interacted tool cards");
assert.match(renderAllMessages, /captureInteractedToolInteractionState\(\)[\s\S]*restoreInteractedToolInteractionState\(toolInteractionSnapshots\)/, "routine transcript renders must restore only explicitly interacted tool cards");
assert.match(bindToolDetailsScrollMode, /dataset\.toolScrollMode \|\|= "position"[\s\S]*ensureToolInteractionDelegation\(\)/, "tool scroll surfaces must use delegated reader-mode tracking rather than per-node listeners");
assert.match(captureToolDetailsInteraction, /if \(details\.open\)[\s\S]*mode: node\.dataset\.toolScrollMode \|\| "position"[\s\S]*scrollTop:[\s\S]*scrollLeft:[\s\S]*open: details\.open[\s\S]*summaryFocused:/, "one live tool snapshot must retain open state, summary focus, reader mode, and both scroll axes without reading layout");
assert.doesNotMatch(captureToolDetailsInteraction, /scrollHeight|clientHeight|getBoundingClientRect/, "live tool state capture must avoid synchronous layout reads");
assert.match(restoreToolDetailsInteraction, /details\.open = snapshot\.open[\s\S]*focus\(\{ preventScroll: true \}\)[\s\S]*requestAnimationFrame[\s\S]*scrollSnapshot\.mode === "follow-end"[\s\S]*node\.scrollLeft = Math\.min/, "tool disclosure restoration must preserve keyboard focus and bounded reader scroll after layout");
assert.match(updateLiveToolCard, /captureToolDetailsInteractionState\(body\)[\s\S]*transcriptRenderer\.replaceChildren\(body\)[\s\S]*restoreToolDetailsInteractionState\(body, detailsInteractionState\)/, "live tool updates must restore only their local disclosure interaction state around body replacement");
assert.match(refreshMessages, /const selectionSnapshot = captureChatTextSelection\(\);[\s\S]*adoptedOutput = adoptLiveAssistantBubble\(latestMessages\)[\s\S]*resetStreamBubble\(\{ preserveCompact: adoptedOutput === "compact" \}\)[\s\S]*restoreStreamRenderAfterChatRebuild\(\)[\s\S]*restoreChatTextSelection\(selectionSnapshot\)/, "stream settlement must adopt matching normal or compact output before reset and retain exact fallback selection");
assert.match(restoreStreamRender, /streamOutputMounted[\s\S]*thinkingOutputMounted[\s\S]*toolCallOutputMounted/, "stream restoration must distinguish preserved live-tail nodes from surfaces that were actually detached");
assert.match(restoreStreamRender, /if \(!streamOutputMounted\)[\s\S]*streamBubble = null[\s\S]*if \(!thinkingOutputMounted\)[\s\S]*streamThinkingBubble = null[\s\S]*if \(!toolCallOutputMounted\)[\s\S]*streamToolCallBubble = null/, "authoritative refreshes must retain mounted live assistant, thinking, and tool-call bubbles instead of orphaning and duplicating them");

// --- Transcript mutation coordinator contracts (keyed DOM ownership) ---

const renderThinkingMarkdown = functionBody("renderThinkingMarkdown");
const flushCompactLiveOutput = functionBody("flushCompactLiveOutput");
const renderLiveToolRun = functionBody("renderLiveToolRun");
const renderMermaidDiagram = functionBody("renderMermaidDiagram");
const renderStreamingToolCallCard = functionBody("renderStreamingToolCallCard");
const adoptLiveAssistantBubble = functionBody("adoptLiveAssistantBubble");
const authoritativeAssistantTextForAdoption = functionBody("authoritativeAssistantTextForAdoption");
const resetChatOutput = functionBody("resetChatOutput");
const ownTranscriptBubble = functionBody("ownTranscriptBubble");
const transcriptSurfaceKind = functionBody("transcriptSurfaceKind");
const ensureStreamBubble = functionBody("ensureStreamBubble");
const ensureStreamingThinkingBubble = functionBody("ensureStreamingThinkingBubble");
const ensureCompactTextBubble = functionBody("ensureCompactTextBubble");
const ensureCompactThinkingBubble = functionBody("ensureCompactThinkingBubble");
const renderCompactToolShell = functionBody("renderCompactToolShell");
const removeLiveTranscriptBubble = functionBody("removeLiveTranscriptBubble");
const removeStreamingThinkingBubble = functionBody("removeStreamingThinkingBubble");
const removeStreamBubble = functionBody("removeStreamBubble");
const removeCompactLiveBubble = functionBody("removeCompactLiveBubble");
const finalizeAdoptedAssistantBubble = functionBody("finalizeAdoptedAssistantBubble");
const prunePendingTranscriptAdoptions = functionBody("prunePendingTranscriptAdoptions");

const commitTranscriptMutation = functionBody("commitTranscriptMutation", renderer);
const applyMutation = functionBody("applyMutation", renderer);
const reconcileMarkdownSurface = functionBody("reconcileMarkdownSurface", renderer);
const updateTextSurface = functionBody("updateTextSurface", renderer);
const ownMessage = functionBody("ownMessage", renderer);
const ownSurface = functionBody("ownSurface", renderer);
const ownBlocks = functionBody("ownBlocks", renderer);
const restoreCoordinatedSelection = functionBody("restoreSelection", renderer);
const rangeForSnapshot = functionBody("rangeForSnapshot", renderer);
const coordinatedTextPoint = functionBody("textPoint", renderer);
const logMutation = functionBody("logMutation", renderer);

// Coordinator import and initialization.
assert.match(app, /import \{ createTranscriptRenderer, groupConsecutiveThinkingItems, groupConsecutiveThinkingMessages \} from "\.\/transcript-renderer\.mjs";/, "app must import the transcript mutation coordinator and thinking-group helpers");
assert.match(app, /const transcriptRenderer = createTranscriptRenderer\(\{[\s\S]*?chat: elements\.chat[\s\S]*?contextKey: \(\) => chatTextSelectionContextKey\(\)[\s\S]*?\}\);/, "the coordinator must be initialized once against #chat with the transcript context key");
assert.doesNotMatch(renderer, /^\s*import\s/m, "the transcript renderer must stay dependency-free");
assert.match(renderer, /export function createTranscriptRenderer\(/, "the coordinator must be the module's exported factory");
assert.match(renderer, /if \(!chat\) throw new Error/, "the coordinator must require the transcript root");

// Semantic message/surface/block ownership.
assert.match(ownMessage, /dataset\.transcriptMessageKey[\s\S]*dataset\.transcriptRole/, "messages must receive durable semantic keys and roles");
assert.match(ownSurface, /dataset\.transcriptSurface = kind[\s\S]*dataset\.transcriptSurfaceKey/, "surfaces must receive durable semantic kind and identity keys");
assert.match(ownBlocks, /dataset\.transcriptBlockKey[\s\S]*dataset\.transcriptBlock = tail \? "mutable-tail" : "committed"/, "streamed Markdown blocks must carry stable committed-block versus mutable-tail identity");
assert.match(transcriptSurfaceKind, /role === "thinking"[\s\S]*"assistant-thinking"[\s\S]*role === "toolExecution"[\s\S]*"tool-execution"[\s\S]*role === "toolResult"[\s\S]*"tool-result"[\s\S]*role === "compactionSummary"[\s\S]*"compaction-summary"[\s\S]*return "assistant-final"/, "surface kinds must cover assistant, thinking, tool execution/result, and compaction surfaces");
assert.match(ownTranscriptBubble, /transcriptRenderer\.ownMessage\(bubble, \{ key: itemKey \|\| bubble\.dataset\.itemKey \|\| fallbackKey, role \}\)[\s\S]*surfaces\.forEach\(\(surface, index\) => transcriptRenderer\.ownSurface/, "every transcript bubble and its selectable surfaces must receive semantic ownership");
assert.match(ensureStreamBubble, /transcriptRenderer\.ownSurface\(streamText, \{ messageKey: "live:assistant", kind: "assistant-final", segment: "0" \}\)/, "the live assistant surface must be semantically owned");
assert.match(ensureStreamingThinkingBubble, /transcriptRenderer\.ownSurface\(streamThinking, \{ messageKey: "live:thinking", kind: "assistant-thinking", segment: "0" \}\)/, "the live thinking surface must be semantically owned");
assert.match(ensureCompactTextBubble, /transcriptRenderer\.ownSurface\(compactTextNode, \{ messageKey: "live:compact-output", kind: "compact-output", segment: "0" \}\)/, "the compact live-output surface must be semantically owned");
assert.match(ensureCompactThinkingBubble, /transcriptRenderer\.ownSurface\(compactThinkingNode, \{ messageKey: "live:compact-thinking", kind: "assistant-thinking", segment: "0" \}\)/, "the compact thinking surface must be semantically owned");
assert.match(renderCompactToolShell, /transcriptRenderer\.ownMessage\(bubble, \{ key: `live:compact-tool:\$\{id\}`, role: "toolExecution" \}\)[\s\S]*transcriptRenderer\.ownSurface\(body, \{ messageKey: `live:compact-tool:\$\{id\}`, kind: "tool-execution"/, "compact tool shells must receive semantic message and surface ownership");

// Normal/compact/thinking/tool/Mermaid routing through the coordinator.
assert.match(renderStreamingMarkdown, /transcriptRenderer\.reconcileMarkdownSurface\(\{[\s\S]*?kind: "assistant-final"[\s\S]*?stableBoundary: streamingMarkdownStableBoundary[\s\S]*?renderInto: renderMarkdownInto/, "normal streaming output must route through the coordinator committed-block reconciler");
assert.match(renderThinkingMarkdown, /transcriptRenderer\.reconcileMarkdownSurface\(\{[\s\S]*?kind: "assistant-thinking"[\s\S]*?stableBoundary: streamingMarkdownStableBoundary[\s\S]*?renderInto: renderMarkdownInto/, "streaming thinking must share the same committed-block reconciler");
assert.match(flushCompactLiveOutput, /transcriptRenderer\.updateTextSurface\(\{[\s\S]*?surface: compactTextNode[\s\S]*?kind: "compact-output"/, "compact live output must update a stable text surface through the coordinator");
assert.match(flushCompactLiveOutput, /renderThinkingMarkdown\(compactThinkingNode, compactLiveState\.thinking\)/, "compact thinking must share the thinking reconciler path");
assert.match(updateLiveToolCard, /transcriptRenderer\.ownMessage\(bubble, \{ key: messageKey, role: "toolExecution" \}\)[\s\S]*transcriptRenderer\.ownSurface\(body, \{ messageKey, kind: "tool-execution"[\s\S]*transcriptRenderer\.commitTranscriptMutation\(\{[\s\S]*?kind: "reconcile"[\s\S]*?transcriptRenderer\.replaceChildren\(body\)[\s\S]*?transcriptRenderer\.ownSurface\(body, \{ messageKey, kind: "tool-execution"/, "live tool body must have semantic ownership before selection capture and remain inside one coordinator-owned transaction");
assert.match(renderLiveToolRun, /key: `tool-replace:\$\{id\}`[\s\S]*kind: "reconcile"[\s\S]*mutate: \(\) => existing\.replaceWith\(created\.bubble\)/, "live tool card replacement must be a coordinator transaction");
assert.match(renderMermaidDiagram, /transcriptRenderer\.commitTranscriptMutation\(\{[\s\S]*?kind: "destructive"[\s\S]*?transcriptRenderer\.replaceHtml\(diagram, svg\)/, "async Mermaid completion must register its destructive mutation with the coordinator");
assert.match(renderStreamingToolCallCard, /transcriptRenderer\.updateTextSurface\(\{[\s\S]*?surface: streamToolCallText[\s\S]*?kind: "tool-execution"/, "streaming tool-call text must update through the coordinator text surface");
assert.match(removeLiveTranscriptBubble, /transcriptRenderer\.commitTranscriptMutation\(\{[\s\S]*kind: "authoritative"[\s\S]*invalidateSelection: true[\s\S]*mutate: \(\) => bubble\.remove\(\)/, "presentation removals must be explicit coordinator-owned invalidations rather than raw transcript mutation");
assert.match(removeCompactLiveBubble, /removeLiveTranscriptBubble\(bubble, messageKey\)/, "compact removals must share the authoritative live-output removal gateway");
assert.match(removeStreamingThinkingBubble, /removeLiveTranscriptBubble\(streamThinkingBubble, "thinking"\)/, "thinking visibility changes must use the authoritative removal gateway");
assert.match(removeStreamBubble, /removeLiveTranscriptBubble\(streamBubble, "assistant"\)/, "normal-to-compact transitions must use the authoritative removal gateway");
for (const [name, source] of [["compact", removeCompactLiveBubble], ["thinking", removeStreamingThinkingBubble], ["assistant", removeStreamBubble]]) {
  assert.doesNotMatch(source, /\.remove\(\)/, `${name} presentation removal must not bypass the coordinator helper`);
}

// Stable compact text-node updates.
assert.match(updateTextSurface, /_transcriptTextNode[\s\S]*node\.appendData\(value\.slice\(node\.data\.length\)\)[\s\S]*else node\.data = value/, "text surfaces must reuse one stable Text node and append in place instead of replacing it");

// Stable committed blocks and a bounded mutable tail.
assert.match(reconcileMarkdownSurface, /if \(boundary > state\.stableText\.length\)/, "committed blocks must never be re-rendered for append-only input");
assert.match(reconcileMarkdownSurface, /for \(const node of state\.tailNodes\) node\.remove\(\)/, "only the mutable tail may be detached during streaming");
assert.match(reconcileMarkdownSurface, /const diverged = !!state && !value\.startsWith\(state\.value\);[\s\S]*invalidateSelection: diverged/, "authoritative divergence must compare the whole previous value and explicitly invalidate selection");
assert.match(reconcileMarkdownSurface, /canReuseLiveTail[\s\S]*appendLiveTail\(state\.tailNodes, state\.tailText, tail, boundaryInfo\)/, "open fences and bounded plain tails must append into their mounted live nodes");
assert.match(reconcileMarkdownSurface, /promotesMountedTail[\s\S]*ownBlocks\(state\.tailNodes[\s\S]*state\.tailNodes = \[\]/, "a newly stable mounted tail must be promoted without detaching its DOM");

// Live settlement adoption.
assert.match(authoritativeAssistantTextForAdoption, /if \(finalParts\.length !== 1\) return null;/, "multi-part settlement must not be fuzzy-adopted onto a single live surface");
assert.match(adoptLiveAssistantBubble, /compactCandidate[\s\S]*normalCandidate[\s\S]*authoritativeText !== candidate\.text[\s\S]*transcriptRenderer\.ownMessage\(candidate\.bubble, \{ key, role: "assistant" \}\)[\s\S]*transcriptRenderer\.ownSurface\(candidate\.surface[\s\S]*pendingTranscriptAdoptions\.set\(key, candidate\.bubble\)/, "live settlement adoption requires exact authoritative agreement and re-keys the same normal or compact bubble");
assert.match(renderAllMessages, /const commit = transcriptRenderer\.commitTranscriptMutation\(\{[\s\S]*?kind: forceRebuild \? "authoritative" : "reconcile"[\s\S]*?invalidateSelection: forceRebuild[\s\S]*?pendingTranscriptAdoptions\.get\(entry\.key\)/, "authoritative reconciliation must be one coordinator transaction that adopts matching live bubbles");
assert.match(renderAllMessages, /if \(commit\.deferred\) return;/, "a deferred transcript commit must not run post-mutation restore work");
assert.match(refreshMessages, /adoptedOutput = adoptLiveAssistantBubble\(latestMessages\);[\s\S]*resetStreamBubble\(\{ preserveCompact: adoptedOutput === "compact" \}\)/, "settlement must try exact live-bubble adoption and preserve a matching compact owner through reset");
assert.match(finalizeAdoptedAssistantBubble, /compact-live-text[\s\S]*classList\.add\("markdown-body", "compact-transcript-text"\)[\s\S]*transcriptRenderer\.reconcileMarkdownSurface\(\{[\s\S]*stableBoundary: \(value\) => value\.length/, "an adopted compact surface must retain its DOM owner while final Markdown reconciles in place");
assert.match(prunePendingTranscriptAdoptions, /for \(const \[key, bubble\] of pendingTranscriptAdoptions\)[\s\S]*!bubble\?\.isConnected[\s\S]*pendingTranscriptAdoptions\.delete\(key\)/, "disconnected unconsumed adoptions must not retain detached transcript trees");

// Bounded mutation logging.
assert.match(renderer, /MUTATION_LOG_LIMIT = \d+/, "the coordinator must bound its mutation log");
assert.match(logMutation, /mutationLog\.push\([\s\S]*mutationLog\.length > MUTATION_LOG_LIMIT[\s\S]*mutationLog\.splice/, "the mutation log must drop oldest entries once the bound is exceeded");

// Pointer-selection sessions and destructive-mutation coalescing.
assert.match(renderer, /document\.addEventListener\("pointerdown"[\s\S]*chat\.addEventListener\("pointerdown"[\s\S]*window\.addEventListener\("pointerup"[\s\S]*window\.addEventListener\("pointercancel"[\s\S]*window\.addEventListener\("blur"[\s\S]*document\.addEventListener\("selectionchange"[\s\S]*chat\.addEventListener\("copy"/, "the coordinator must track transcript pointer selection while ending gestures released outside #chat or the window");
assert.match(commitTranscriptMutation, /DESTRUCTIVE_KINDS\.has\(kind\)[\s\S]*!invalidateSelection[\s\S]*pointerSession[\s\S]*selectedSurfaceIntersects\(surfaces\)[\s\S]*deferredMutations\.set\(key, entry\)/, "destructive commits intersecting an active pointer drag must coalesce latest-wins until the gesture ends");

// Exact single-surface fallback and explicit invalidation.
assert.match(applyMutation, /if \(context !== contextKey\(\)\) return \{ applied: false, stale: true \}/, "stale-context mutations must be rejected");
assert.match(applyMutation, /selectionSnapshot\(\) \|\| selectionSession\?\.snapshot \|\| null/, "coordinator mutations must retain the last exact semantic bookmark when an adjacent render step already detached the native range");
assert.match(rangeForSnapshot, /range\.toString\(\) === snapshot\.text/, "fallback restoration must require exact text evidence");
assert.match(rangeForSnapshot, /surfaceText\.indexOf\(snapshot\.text\)[\s\S]*surfaceText\.indexOf\(snapshot\.text, exactStart \+ 1\) !== -1[\s\S]*anchorOffset = backward \? exactEnd : exactStart/, "structurally shifted selections may remap only to one exact occurrence in the same semantic surface while preserving direction");
assert.match(coordinatedTextPoint, /target < next \|\| \(target === next && !forwardAffinity\)/, "selection starts at text-node boundaries must bind to the next node while ends retain backward affinity, avoiding implicit block newlines");
assert.match(restoreCoordinatedSelection, /snapshot\.context !== contextKey\(\)[\s\S]*!forceRemap && currentText === snapshot\.text[\s\S]*currentText && currentAnchor && currentFocus[\s\S]*snapshot\.anchorOffset > snapshot\.focusOffset[\s\S]*setBaseAndExtent[\s\S]*selection\.addRange\(match\.range\)/, "fallback restoration must reject stale contexts, preserve backward direction, and use the exact validated Range for forward selection");
assert.match(applyMutation, /intersectsSelection = selectedSurfaceIntersects\(surfaces\)[\s\S]*forceRemap = DESTRUCTIVE_KINDS\.has\(kind\) && intersectsSelection[\s\S]*restoreSelection\(snapshot, \{ forceRemap \}\)/, "destructive mutations intersecting a captured selection must remap a fresh semantic Range instead of trusting transient browser boundaries");
assert.match(applyMutation, /restoredSelection && forceRemap && typeof requestAnimationFrame[\s\S]*requestAnimationFrame\(\(\) => \{[\s\S]*selectionIntentRevision !== restoreIntentRevision[\s\S]*restoreSelection\(snapshot, \{ forceRemap: true \}\)/, "destructive selection restoration must survive the browser's deferred Range adjustment without clobbering a newer pointer or keyboard selection");
assert.match(renderer, /function invalidateSelection\(\{ surfaces = \[\] \} = \{\}\) \{[\s\S]*clearSelectionFor\(surfaces\)/, "explicit invalidation must be a first-class coordinator operation");

// Prevention of unapproved direct destructive transcript mutations.
assert.doesNotMatch(app, /elements\.chat\.(?:replaceChildren|replaceWith)\(|elements\.chat\.innerHTML\s*=/, "no direct destructive #chat mutation may bypass the coordinator");
assert.match(resetChatOutput, /transcriptRenderer\.replaceChildren\(elements\.chat/, "full chat resets must go through the coordinator");
for (const [name, source] of [
  ["streaming markdown", renderStreamingMarkdown],
  ["streaming thinking", renderThinkingMarkdown],
  ["compact live output", flushCompactLiveOutput],
  ["authoritative reconciliation", renderAllMessages],
  ["live tool card", updateLiveToolCard],
  ["mermaid renderer", renderMermaidDiagram],
]) {
  assert.doesNotMatch(source, /(?<!transcriptRenderer)\.(?:replaceChildren|replaceWith|replaceHtml)\(|\.innerHTML\s*=/, `${name} must not perform unapproved direct destructive transcript mutations`);
}

console.log("interaction-state-stability-static.test.mjs passed");
