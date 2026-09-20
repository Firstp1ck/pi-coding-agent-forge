import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, html, css, serviceWorker, technical] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
]);

assert.match(app, /MOBILE_CONTINUITY_STORAGE_KEY = "pi-webui-mobile-continuity-v1"/, "continuity state must be browser-scoped and versioned");
assert.match(app, /requiresReselect: true/, "restored attachment records must be metadata-only");
assert.match(app, /Reselect required/, "metadata-only attachment restoration must be labelled truthfully");
assert.match(app, /function retryMobileFailedSend\([\s\S]*?body: pending\.body[\s\S]*?original request identity/, "failed sends must require a manual retry with the original request body and identity");
assert.match(app, /error\?\.backendOffline === true[\s\S]*?mobileFailedSend =/, "manual failed-send recovery must be created only for ambiguous transport failures, not confirmed HTTP rejection");
assert.match(app, /MOBILE_FAILED_SEND_RECOVERY_TTL_MS = 10 \* 60 \* 1000[\s\S]*?recoveryAgeMs <= MOBILE_FAILED_SEND_RECOVERY_TTL_MS/, "persisted request identity must not outlive the server deduplication window");
assert.match(app, /!Array\.isArray\(mobileFailedSend\.body\?\.images\) \|\| mobileFailedSend\.body\.images\.length === 0[\s\S]*?!Array\.isArray\(failed\.body\.images\) \|\| failed\.body\.images\.length === 0/, "failed-send persistence and restore must agree on empty image arrays");
assert.match(app, /function scheduleMobileContinuityPersist\([\s\S]*?MOBILE_CONTINUITY_PERSIST_DEBOUNCE_MS/, "composer draft persistence must be debounced off the keystroke hot path");
assert.match(app, /This implementation intentionally never retries an\n    \/\/ ambiguous mutation automatically/, "ambiguous prompt mutations must never replay automatically");
assert.match(html, /id="mobileFailedSendRecovery"[\s\S]*Not sent\.[\s\S]*id="mobileFailedSendRetryButton"[\s\S]*id="mobileFailedSendDiscardButton"/, "failed sends need visible Retry and Discard actions");
assert.match(app, /mobileButton\("Add Context"[\s\S]*mobileSetSurfacePage\("context"\)/, "the action sheet must expose unified context capture");
for (const source of ["Camera", "Photos", "Files", "Paste text"]) assert.match(app, new RegExp(source), `${source} must be represented in Add Context`);
assert.match(app, /Camera and photo access are requested by your browser only after you select them/, "capture permissions need contextual copy before the browser prompt");
assert.match(app, /active Web UI clients only/, "notification settings must state the active-client delivery limit");
assert.match(app, /mobileNotificationTarget\(\{ route: "activity", tabId, blockerId \}\)/, "blocker notifications must carry a versioned opaque target");
assert.match(app, /applyPendingMobileNavigationTarget\([\s\S]*?foreground reconcile/, "notification navigation must be deferred until reconciliation");
assert.match(app, /if \(targetTab\.id !== activeTabId\) await switchTab\(targetTab\.id\);[\s\S]*?if \(target\.blockerId && !mobileTargetBlockerExists/, "background-tab notification targets must switch before exact blocker validation");
assert.match(app, /That notification target is no longer available/, "stale targets need a visible fallback explanation");
assert.match(serviceWorker, /client\.postMessage\(\{ type: MOBILE_NAVIGATION_MESSAGE_TYPE, target \}\)/, "existing clients must focus and receive the exact target");
assert.match(serviceWorker, /openWindow\?\.\(targetUrl\)/, "no-client notification clicks must open only the bounded target URL");
assert.doesNotMatch(serviceWorker, /data\?\.url/, "service-worker fallback must not accept an arbitrary notification URL");
assert.match(app, /visibilitychange[\s\S]*?pageshow[\s\S]*?network online/, "visibility, page-show, and online returns must reconcile");
assert.match(app, /Continued while away · reconciled/, "return status must distinguish reconciled background continuation");
assert.match(app, /function renderMobileDiagnosticsPage\(/, "local diagnostics need a dedicated Copy/Clear surface");
assert.match(app, /function scrubMobileDiagnosticDetail\([\s\S]*?redacted potentially sensitive detail/, "diagnostic details must redact path-like and credential-like values");
assert.match(app, /excludes prompts, transcript text, paths, filenames, and credentials/, "diagnostics must document their privacy boundary");
assert.match(app, /function renderMobileInstallPage\(/, "install education must be contextual and dismissible");

assert.match(app, /TABLET_SHELL_STORAGE_KEY/, "tablet mode must use an independent browser flag");
assert.match(app, /initialUrlParams\.get\("tabletShell"\)/, "tablet mode must support an independent URL override");
assert.match(css, /@media \(min-width: 721px\) and \(max-width: 1050px\)/, "tablet layout must own only medium widths");
assert.match(css, /html\[data-tablet-shell="v2"\] \.mobile-shell-nav[\s\S]*?width: 7rem/, "tablet destinations must use a rail rather than the phone bottom bar");
assert.match(css, /html\[data-tablet-shell="v2"\] \.mobile-shell-surface[\s\S]*?width: min\(30rem, 72vw\)/, "tablet inspector must be a bounded right-side sheet");
assert.match(css, /html\[data-tablet-shell="v2"\] \.file-viewer-pane[\s\S]*?position: fixed[\s\S]*?inset: 0/, "tablet files must default to full-screen replacement");
assert.match(css, /and \(pointer: coarse\)[\s\S]*?min-height: 44px/, "coarse tablet pointers must retain the 44px target floor");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "continuity/tablet assets need a coherent cache identity");
assert.match(html, /styles\.css\?v=154/, "tablet CSS must have a coherent HTML revision");
assert.match(html, /app\.js\?v=184/, "continuity app logic must have a coherent HTML revision");
assert.match(technical, /tabletShell=v2[\s\S]*tabletShell=legacy/, "technical reference should document tablet preview and rollback");

console.log("mobile-continuity-tablet-static.test.mjs passed");
