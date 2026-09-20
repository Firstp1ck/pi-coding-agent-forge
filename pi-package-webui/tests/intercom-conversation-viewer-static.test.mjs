import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, css, serviceWorker, readme, technical, development] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
]);

function count(value, pattern) {
  return [...value.matchAll(pattern)].length;
}

function functionSource(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const next = app.slice(start + 1).match(/\n(?:async )?function [A-Za-z0-9_$]+\(/);
  const end = next ? start + 1 + next.index : app.length;
  return app.slice(start, end);
}

for (const id of [
  "intercomConversationTags",
  "intercomConversationDialog",
  "intercomConversationTitle",
  "intercomConversationParticipants",
  "intercomConversationTranscript",
  "intercomConversationStatus",
  "intercomConversationCloseButton",
]) {
  assert.equal(count(html, new RegExp(`id="${id}"`, "g")), 1, `${id} should be a singleton`);
  assert.ok(app.includes(`${id}: $("#${id}")`), `${id} should be cached in the browser element map`);
}

assert.match(
  html,
  /<div class="composer-context-tags">[\s\S]*<div id="intercomConversationTags" class="composer-intercom-tags" role="group" aria-label="Agent conversations" aria-live="polite" data-visibility-key="tag\.agent-conversations" hidden><\/div>/,
  "the dedicated conversation-tag list should live beneath the composer input in the existing context-tag surface",
);
assert.match(
  html,
  /<dialog id="intercomConversationDialog"[^>]*aria-labelledby="intercomConversationTitle"[^>]*aria-describedby="intercomConversationParticipants intercomConversationStatus">[\s\S]*role="log"[^>]*aria-live="polite"[\s\S]*id="intercomConversationCloseButton" type="submit" value="close"/,
  "the viewer should be a labelled native dialog with a live transcript and explicit close control",
);
assert.match(app, /installModalPrimitives\(\)/, "the native dialog should use the shared focus-management primitive");
assert.match(functionSource("openIntercomConversation"), /showModal\(\)[\s\S]*intercomConversationCloseButton\?\.focus/, "opening should use the modal primitive and establish an explicit keyboard target");
assert.match(functionSource("setActiveTabId"), /closeIntercomConversationDialog\(\{ restoreFocus: false \}\)/, "tab switching should close the old conversation without restoring focus into the old tab");

const tagsSource = functionSource("renderIntercomConversationTags");
assert.match(tagsSource, /const seenConversationIds = new Set\(\)/, "tag rendering should deduplicate conversation IDs defensively");
assert.match(tagsSource, /seenConversationIds\.has\(conversation\.id\)[\s\S]*seenConversationIds\.add\(conversation\.id\)/, "each projected conversation should create at most one tag");
assert.match(tagsSource, /dataset\.intercomConversationId = conversation\.id/, "tags should retain only the opaque conversation ID");
assert.match(tagsSource, /aria-haspopup", "dialog"[\s\S]*aria-controls", "intercomConversationDialog"/, "each tag should advertise its dialog relationship");
assert.match(tagsSource, /if \(!conversations\.length\)[\s\S]*container\.replaceChildren\(\)[\s\S]*container\.hidden = true/, "the tag list should disappear and clear stale disclosure state when there are no conversations");

const summarySource = functionSource("refreshIntercomConversationSummaries");
assert.match(summarySource, /api\("\/api\/intercom\/conversations", \{ tabId: tabContext\.tabId \}\)/, "summary requests should stay scoped to the selected tab");
assert.match(summarySource, /requestSerial !== intercomSummaryRequestSerial \|\| !isCurrentTabContext\(tabContext\)/, "summary responses should be rejected after a newer request or tab switch");
const detailSource = functionSource("refreshIntercomConversationDetail");
assert.match(detailSource, /conversation=\$\{encodeURIComponent\(state\.conversationId\)\}/, "detail selection should send only an encoded opaque ID");
assert.match(detailSource, /requestSerial !== intercomDetailRequestSerial[\s\S]*state !== intercomConversationDialogState[\s\S]*!isCurrentTabContext\(state\)/, "detail responses should be rejected after rapid selection or tab changes");
assert.match(app, /\["webui_connected", "agent_end", "message_end", "tool_execution_end"\][\s\S]*scheduleIntercomConversationRefresh\(tabContext\)/, "settlement and reconnect events should refresh conversation summaries");
assert.match(app, /source\.onopen = \(\) => \{[\s\S]*scheduleIntercomConversationRefresh\(tabContext, 0\)/, "event-stream reconnection should authoritatively refetch tags");

const messageRenderSource = functionSource("renderIntercomConversationMessage");
const renderSource = functionSource("renderIntercomConversationDetail");
assert.match(messageRenderSource, /message\.direction === "local"[\s\S]*conversation\.participants\.local/, "message alignment should derive the sender from the normalized direction");
assert.match(messageRenderSource, /text\.textContent = message\.text/, "message content should be assigned as inert text");
assert.doesNotMatch(`${messageRenderSource}\n${renderSource}`, /innerHTML|insertAdjacentHTML|outerHTML/, "conversation content must not reach an HTML parser sink");
assert.doesNotMatch(`${messageRenderSource}\n${renderSource}`, /attachment|tool|reasoning|stdout|stderr|session/i, "the renderer must not consume excluded record fields");
const normalizeDetailSource = functionSource("normalizeIntercomConversationDetail");
assert.match(normalizeDetailSource, /INTERCOM_MESSAGE_ID_PATTERN\.test\(id\)[\s\S]*seenMessageIds\.has\(id\)/, "detail normalization should require and deduplicate opaque message IDs");
assert.match(normalizeDetailSource, /\["local", "peer"\]\.includes\(candidate\.direction\)[\s\S]*typeof candidate\.text !== "string"/, "detail normalization should whitelist only direction and text messages");
assert.match(renderSource, /new Map\(\[\.\.\.transcript\.querySelectorAll\("\:scope > \.intercom-conversation-message\[data-intercom-message-id\]"\)\]/, "live refresh should reconcile existing keyed message nodes");
assert.match(renderSource, /existingArticles\.get\(message\.id\)[\s\S]*renderIntercomConversationMessage\(article, message, conversation\)/, "existing opaque message nodes should be reused and safely patched");
assert.match(renderSource, /staleArticle\.remove\(\)[\s\S]*transcript\.insertBefore\(article, cursor\)/, "only stale messages should be removed and genuinely new messages inserted");
assert.doesNotMatch(renderSource, /replaceChildren/, "detail polling must not rebuild the whole live log");
assert.match(renderSource, /const anchorOffset = anchor \? anchor\.getBoundingClientRect\(\)\.top - transcript\.getBoundingClientRect\(\)\.top[\s\S]*transcript\.scrollTop \+= currentAnchorOffset - anchorOffset/, "scrolled-up readers should retain their visual message anchor");

assert.match(functionSource("scheduleIntercomConversationDetailRefresh"), /INTERCOM_DETAIL_REFRESH_MS/, "an open dialog should use the bounded detail refresh interval");
assert.match(functionSource("resetIntercomConversationDialog"), /intercomDetailRequestSerial \+= 1[\s\S]*clearTimeout\(intercomDetailRefreshTimer\)[\s\S]*intercomConversationDialogState = null/, "dialog close should invalidate requests, cancel polling, and clear selection state");
assert.match(app, /elements\.intercomConversationDialog\?\.addEventListener\("close", resetIntercomConversationDialog\)/, "native Escape and close-button paths should share polling cleanup");

assert.match(css, /\.composer-intercom-tags \{[\s\S]*display: inline-flex;[\s\S]*flex: 0 1 50%;[\s\S]*max-width: 50%;[\s\S]*overflow: hidden;/, "conversation tags should use up to half the desktop input width without a horizontal scroller");
assert.match(css, /\.composer-intercom-overflow-menu \{[\s\S]*position: absolute;[\s\S]*max-height:[\s\S]*overflow-y: auto;/, "hidden conversations should remain reachable in a bounded popup");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.composer-intercom-tags \{ flex: 0 0 100%; width: 100%; min-width: 0; max-width: 100%; \}/, "conversation tags should regain the available row width on narrow and coarse-pointer layouts");
assert.doesNotMatch(css, /\.composer-intercom-tags \{[^}]*overflow-x:\s*(?:auto|scroll)/, "the conversation tag group should not restore horizontal scrolling");
assert.match(css, /\.composer-intercom-tag:hover,[\s\S]*\.composer-intercom-tag:focus-visible/, "tags should expose pointer and keyboard focus states");
assert.match(css, /\.extension-dialog\.intercom-conversation-dialog \{[\s\S]*width: min\(76rem,[\s\S]*height: min\(54rem,/, "the viewer should use a large in-app modal");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.composer-intercom-tag \{ min-height: 44px;[\s\S]*\.extension-dialog\.intercom-conversation-dialog[\s\S]*width: calc\(100vw - 0\.7rem\)/, "tags and the dialog should remain reachable on narrow and coarse-pointer layouts");

assert.match(html, /\/styles\.css\?v=154/, "the stylesheet URL should advance for the bounded conversation tags");
assert.match(html, /data-app-src="\/app\.js\?v=184"/, "the guarded app URL should advance for current browser wiring");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "the PWA cache identity should advance with browser assets");

assert.match(readme, /one compact tag per conversation appears beneath the composer/i, "the README should explain the user-visible entry point");
assert.match(technical, /## Agent conversation viewer[\s\S]*Attachments, tool calls and results, thinking, stdout\/stderr, filesystem paths, raw session records/i, "the advanced guide should document privacy exclusions");
assert.match(development, /## Intercom conversation projection and viewer[\s\S]*GET \/api\/intercom\/conversations[\s\S]*five-second open-dialog refresh/i, "the contributor guide should document the endpoint and browser lifecycle");

console.log("intercom conversation viewer static checks passed");
