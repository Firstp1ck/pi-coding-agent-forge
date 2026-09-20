import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, html, server, serviceWorker, packageRaw] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
]);
const pkg = JSON.parse(packageRaw);

const assertionIntent = [
  {
    assertion: "phone controls use the user-selected 40px minimum",
    status: "preserved",
    reason: "Balanced phone density restores a 40px floor while retaining safe areas and unchanged tablet and desktop sizing.",
  },
  {
    assertion: "legacy mobile tab popover remains available when the v2 flag is off",
    status: "preserved",
    reason: "Phase 1 only suppresses its mutation handlers while v2 is active and leaves the legacy selectors intact.",
  },
];
assert.equal(assertionIntent.every((entry) => ["preserved", "superseded", "obsolete"].includes(entry.status)), true);

assert.equal(pkg.scripts["test:browser"], "playwright test", "the package must expose an explicit browser suite");
assert.equal(pkg.devDependencies?.["@playwright/test"], "1.62.1", "Playwright must be exact/pinned");
assert.equal(pkg.devDependencies?.["@axe-core/playwright"], "4.12.1", "axe must be exact/pinned");
assert.match(app, /from "\.\/mobile-shell-state\.mjs"/, "app boot must import the pure mobile shell module");
assert.match(pkg.scripts.check, /node --check public\/mobile-shell-state\.mjs/, "package checks must syntax-check every public module in the startup graph");
assert.match(pkg.scripts.check, /node --check public\/transcript-renderer\.mjs/, "package checks must syntax-check the transcript startup module");
assert.match(server, /STATIC_PUBLIC_FILE_EXTENSIONS[\s\S]*"\.mjs"/, "the server must serve typed startup modules from the public asset boundary");
assert.match(serviceWorker, /"\/mobile-shell-state\.mjs"/, "the PWA shell must cache the new startup module");
assert.match(serviceWorker, /"\/transcript-renderer\.mjs"/, "the PWA shell must cache the transcript startup module");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "the cache identity must change with the startup graph");
assert.match(html, /styles\.css\?v=154/, "the stylesheet revision must change with mobile/tablet CSS fixes");
assert.match(html, /app\.js\?v=184/, "the app revision must change with continuity/tablet wiring");
assert.match(serviceWorker, /const APP_SHELL_NETWORK_TIMEOUT_MS = 8_000;[\s\S]*?event\.waitUntil\([\s\S]*?cache\.put\(request, response\.clone\(\)\)[\s\S]*?return networkResponse;/, "runtime cache writes must extend the event lifetime without blocking bounded network responses");
assert.match(serviceWorker, /MOBILE_NAVIGATION_MESSAGE_TYPE = "pi-webui:navigate:v1"/, "the service worker must use a versioned active-client navigation message");
assert.match(serviceWorker, /client\.postMessage\(\{ type: MOBILE_NAVIGATION_MESSAGE_TYPE, target \}\)/, "existing clients must receive only a validated target message");
assert.match(app, /function installMobileShellNavigationBridge\([\s\S]*?pi-webui:navigate:v1/, "the app must accept the service-worker navigation contract");
assert.match(app, /function updateVisualViewportVars\([\s\S]*?keyboardOpen && !isMobileShellV2Active\(\)/, "v2 must retain viewport measurement but suppress legacy keyboard mutation");
assert.match(app, /function syncMobileChatToBottomForInput\(\) \{\n  if \(!isMobileView\(\) \|\| isMobileShellV2Active\(\)\) return;/, "v2 must suppress legacy forced chat scrolling");
assert.match(app, /function bindMobileViewChanges\([\s\S]*?applyMobileShellViewport\(\);[\s\S]*?if \(isMobileShellV2Active\(\)\) return;/, "v2 must bypass legacy breakpoint mutations");
assert.match(app, /function setMobileTabsExpanded\(expanded, \{ restoreFocus = false \} = \{\}\) \{\n  if \(isMobileShellV2Active\(\)\) return;/, "v2 must own surface visibility rather than the legacy tabs expander");
assert.match(app, /function setMobileFooterExpanded\(expanded, \{ restoreFocus = false \} = \{\}\) \{\n  if \(isMobileShellV2Active\(\)\) return;/, "v2 must suppress legacy footer expansion");
assert.match(app, /function createBrowserPromptRequestId\(/, "browser prompt submission must mint an opaque request identity");
assert.match(app, /if \(kind === "prompt"\) bodyBase\.requestId = createBrowserPromptRequestId\(\)/, "the browser identity must travel with primary prompt submission and remain stable in the captured manual-retry body");
assert.match(server, /BROWSER_PROMPT_REQUEST_LIMIT = 256/, "server request deduplication must remain bounded");
assert.match(server, /deduplicateBrowserPromptRequest\(tab, body/, "server prompt dispatch must deduplicate tab-bound request IDs");
assert.match(server, /requestId was already used for a different prompt/, "request-ID reuse with a different mutation must be rejected");
assert.match(server, /runId: null/, "tab activity must expose an opaque parent-run field");
assert.match(server, /activity\.runId = randomUUID\(\)/, "parent-run IDs must be server-issued opaque values");
assert.match(server, /function markTabFailed\([\s\S]*?activity\.status = "failed"[\s\S]*?activity\.completionSerial/, "failed parent turns must be represented distinctly from successful completion");
assert.match(server, /SSE_BACKPRESSURE_MAX_PENDING_BYTES = 4 \* 1024 \* 1024/, "SSE backpressure buffering must remain explicitly bounded above the healthy fixture burst");
assert.match(server, /res\.once\("drain", \(\) => flushSseClient\(client\)\)/, "healthy SSE clients must resume after transient write backpressure");
assert.match(server, /client\.tab\?\.sseClients\?\.delete\(client\)/, "eviction must remove only the slow client");
assert.match(server, /client\.res\?\.end\(\)/, "slow-client eviction must finish chunked SSE responses gracefully");
assert.match(css, /--mobile-control-size:\s*40px;/, "phone density should expose the selected 40px control floor");
assert.match(css, /\.terminal-tabs-toggle-button,[\s\S]*?\.terminal-close-all-button \{ min-height:\s*var\(--mobile-control-size\)/, "phone tab targets should use the shared compact control size");
assert.match(css, /\.side-panel-toggle-button,[\s\S]*?\.composer-attach-button,[\s\S]*?width:\s*var\(--mobile-control-size\);[\s\S]*?height:\s*var\(--mobile-control-size\);/, "phone icon controls should use the shared compact square size");
assert.match(css, /body\.mobile-composer-disclosure \.composer-input-row \{ grid-template-columns:\s*minmax\(0, 1fr\) var\(--mobile-control-size\);/, "legacy phone composer layout should reserve only the compact attachment width");
assert.match(css, /html\[data-mobile-shell="v2"\] \{ --mobile-shell-v2-active: 1; \}/, "new v2 CSS must be root-scoped");

console.log("mobile-foundation-static.test.mjs passed");
