import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, css, serviceWorker, readme, development] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
]);

function sourceBetween(startMarker, endMarker, label) {
  const start = app.indexOf(startMarker);
  const end = app.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${label} should remain an inspectable standalone block`);
  return app.slice(start, end);
}

assert.match(
  html,
  /id="feedbackTray"[\s\S]*?<div class="footer-status-host">[\s\S]*?<div id="mainOutputLoading" class="main-output-loading" role="status" aria-live="polite" aria-atomic="true" aria-controls="chat" hidden>[\s\S]*?main-output-loading-spinner[\s\S]*?id="mainOutputLoadingLabel">Loading conversation history…<\/span>[\s\S]*?<div id="statusBar" class="statusbar"/,
  "the accessible loading status and Git footer should share an overlay host",
);
assert.doesNotMatch(html, /<dialog[^>]+id="mainOutputLoading"/, "loading feedback must not use a popup dialog");
assert.match(app, /mainOutputLoading: \$\("#mainOutputLoading"\)[\s\S]*mainOutputLoadingLabel: \$\("#mainOutputLoadingLabel"\)/, "the browser should bind the inline status and its detail label");
assert.match(app, /const mainOutputLoadingRequests = new Set\(\);[\s\S]*MAIN_OUTPUT_LOADING_REVEAL_DELAY_MS = 120/, "loading requests should have bounded concurrent ownership and a short anti-flicker delay");

const loadingHelpers = sourceBetween("function mainOutputLoadingRequestIsCurrent(", "\nasync function refreshMessages(", "main output loading helpers");
assert.match(loadingHelpers, /isCurrentTabContext\(request\.tabContext\)/, "only the active tab generation should control visible loading feedback");
assert.match(loadingHelpers, /filter\(mainOutputLoadingRequestIsCurrent\)\.at\(-1\)/, "the newest active request should supply the displayed operation");
assert.match(loadingHelpers, /setAttribute\("aria-busy", active \? "true" : "false"\)/, "the transcript should expose request state immediately to assistive technology");
assert.match(loadingHelpers, /mainOutputLoadingLabel\.textContent = request\?\.label/, "the live status should name the current operation");
assert.match(loadingHelpers, /setTimeout\([\s\S]*MAIN_OUTPUT_LOADING_REVEAL_DELAY_MS/, "visible animation should be delayed to avoid flashing on fast requests");
assert.match(loadingHelpers, /mainOutputLoadingRequests\.add\(request\)/, "overlapping requests should receive independent tokens");
assert.match(loadingHelpers, /function updateMainOutputLoading\([\s\S]*request\.label = label/, "an active request should be able to report its next stage");
assert.match(loadingHelpers, /mainOutputLoadingRequests\.delete\(request\)/, "settled requests should release only their own token");
assert.doesNotMatch(loadingHelpers, /showModal|alert\(|confirm\(/, "main output loading must remain non-modal");

const refreshMessages = sourceBetween("async function refreshMessages(", "\nasync function refreshModels(", "refreshMessages");
assert.match(refreshMessages, /beginMainOutputLoading\(tabContext, loadDelta \? "Checking for new messages…" : "Loading conversation history…"\)/, "message fetches should distinguish delta checks from complete transcript loads");
assert.match(refreshMessages, /updateMainOutputLoading\(loadingRequest, "Loading conversation history…"\)[\s\S]*api\("\/api\/messages"/, "delta fallback should report that it is loading the complete transcript");
assert.match(refreshMessages, /updateMainOutputLoading\(loadingRequest, "Preparing your conversation…"\)[\s\S]*renderMessages\(latestMessages\)/, "the status should report transcript rendering after data arrives");
assert.match(refreshMessages, /finally \{\s*finishMainOutputLoading\(loadingRequest\);\s*\}/, "success, failure, and stale responses should all clear their request token");
assert.match(app, /activeTabId = nextTabId;\s*renderMainOutputLoading\(\);/, "tab changes should immediately reconcile stale and current request visibility");

assert.match(css, /\.main-output-loading\[hidden\] \{ display: none !important; \}/, "hidden loading feedback should not render");
assert.match(css, /\.main-output-surface \{[\s\S]*?position: relative;[\s\S]*?flex: 1 1 auto;[\s\S]*?min-height: 0;/, "the transcript should retain its flexible layout surface");
assert.match(css, /\.footer-status-host \{[\s\S]*?position: relative;[\s\S]*?flex: 0 0 auto;[\s\S]*?min-width: 0;/, "the Git footer should provide a stable positioning host");
assert.match(css, /\.main-output-loading \{[\s\S]*?position: absolute;[\s\S]*?left: 50%;[\s\S]*?bottom: calc\(100% \+ 0\.3rem\);[\s\S]*?transform: translateX\(-50%\);[\s\S]*?pointer-events: none;/, "the loading status should overlay above the footer without entering layout flow");
assert.match(css, /\.main-output-loading \{[\s\S]*?font-size: var\(--text-xs\)/, "the loading status should remain compact");
assert.match(css, /\.main-output-loading-spinner \{[\s\S]*?animation: main-output-loading-spin 780ms linear infinite/, "the status should include a visible spinner animation");
assert.match(css, /@keyframes main-output-loading-spin/, "the spinner should have a local animation contract");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation-duration: 1ms !important;[\s\S]*?animation-iteration-count: 1 !important;/, "the existing reduced-motion policy should stop repeated spinner motion");
assert.match(css, /body\.terminal-tabs-left \.main-output-surface \{ grid-row: 4; \}[\s\S]*body\.terminal-tabs-left \.footer-status-host \{ grid-row: 7; \}[\s\S]*body\.terminal-tabs-left \.context-meter-bar \{ grid-row: 8; \}/, "sidebar tab placement should keep the loading overlay anchored to the footer host");
assert.match(css, /body\.subagent-terminal-active \.main-output-surface,[\s\S]*body\.subagent-terminal-active \.main-output-loading,/, "dedicated subagent output should hide the main transcript and its loading status");

assert.match(html, /styles\.css\?v=154/, "the stylesheet cache query should advance");
assert.match(html, /app\.js\?v=184/, "the app cache query should advance");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "the PWA cache identity should advance with browser assets");
assert.match(readme, /Loading conversation history/, "user documentation should describe the plain-language loading feedback");
assert.match(development, /main output loading/i, "developer documentation should preserve the request-ownership contract");

console.log("main output loading static tests passed");
