import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, html, css, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

assert.match(html, /id="mobileShellV2"/, "the flagged phone shell must have one root");
for (const route of ["chat", "sessions", "activity", "project"]) {
  assert.match(html, new RegExp(`data-mobile-route-button="${route}"`), `${route} must be a labelled bottom destination`);
}
assert.match(html, /id="mobileSessionsSearchInput"/, "Sessions must expose search");
assert.match(html, /id="mobileNewCurrentDirectoryButton"[\s\S]*id="mobileNewDirectoryButton"[\s\S]*id="mobileNewWorktreeButton"[\s\S]*id="mobileResumeSessionButton"/, "Sessions must retain the existing new/resume paths");
assert.match(html, /id="mobileProjectTopics"[\s\S]*data-mobile-project-topic="files"[\s\S]*data-mobile-project-topic="git"[\s\S]*data-mobile-project-topic="queue"[\s\S]*data-mobile-project-topic="workflows"/, "Project must provide all parity topics");
assert.match(html, /id="mobileLifecycleAnnouncer"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/, "one atomic lifecycle announcer is required");
assert.match(html, /id="mobileShellIndicators"[^>]*role="group"/, "indicator refreshes must not create a second live region");
assert.match(html, /id="chat" class="chat" aria-live="polite"/, "desktop and legacy mobile must retain the canonical transcript live region");
assert.match(app, /if \(active\) elements\.chat\.removeAttribute\("aria-live"\);[\s\S]*?else elements\.chat\.setAttribute\("aria-live", "polite"\)/, "v2 must swap the transcript live region for its lifecycle announcer only while active");
assert.match(html, /id="mobileSurfaceBackButton"[^>]*hidden/, "surfaces need a visible Back control when child pages replace content");
assert.match(html, /id="mobileSurfaceCloseButton"/, "surfaces need a visible Close control");

for (const helper of ["mobileRenderSessions", "mobileRenderActivity", "mobileRenderProject", "mobileRenderMore", "mobileRenderActionSheet", "mobileRenderLifecycle", "installMobilePhoneExperience"]) {
  assert.match(app, new RegExp(`function ${helper}\\(`), `${helper} must implement a functional phone path`);
}
assert.match(app, /switchTab\(tabId\)/, "session selection must call canonical switchTab");
assert.match(app, /mobileCanonicalMountContent\(host, \["sidePanelSectionFiles"\]/, "Files must reuse its canonical node");
assert.match(app, /mobileCanonicalMountContent\(host, \["sidePanelSectionGit"\]/, "Git must reuse its canonical node");
assert.match(app, /mobileCanonicalMountContent\(host, \["sidePanelSectionQueue"\]/, "Queue must reuse its canonical node");
assert.match(app, /mobileCanonicalMountContent\(host, topic\[1\]/, "More must reuse canonical settings/action nodes");
assert.match(app, /await appConfirm\(\{ title: "Abort active run\?"/, "Abort must have visible tap-confirm parity");
assert.match(app, /elements\.optionsConversationModeButton\?\.click\(\)/, "voice entry must retain the existing action");
assert.match(app, /window\.history\.pushState/, "route and sheet transitions must be history-owned");
assert.match(app, /document\.addEventListener\("keydown", \(event\) => \{[\s\S]*?event\.key !== "Escape"[\s\S]*?document\.querySelector\("dialog\[open\]"\)/, "Escape must share mobile Back handling without dismissing a surface under a native dialog");
assert.match(app, /projectTopics\?\.addEventListener\("keydown"[\s\S]*?"ArrowLeft"[\s\S]*?"Home"[\s\S]*?activateProjectTopic/, "Project tabs require arrow/Home/End keyboard activation");
assert.match(app, /function syncMobileShellInteractivity\([\s\S]*?layout\.inert = layoutObscured[\s\S]*?destination\.setAttribute\("role", "main"\)/, "full-screen destinations must inert the obscured layout and own the main landmark");
assert.match(app, /function restoreMobileSurfaceFocus\([\s\S]*?mobileSurfaceFocusReturn/, "closing a transient surface must restore its invoking control");
assert.match(app, /captureMobileSurfaceRenderFocus\([\s\S]*?restoreMobileSurfaceRenderFocus\(surface, surfaceFocusSnapshot\)/, "poll-driven surface rerenders must preserve focus");
assert.match(app, /event\.preventDefault\(\);\n      event\.stopPropagation\(\);\n      mobileBack\(\);/, "v2 Escape consumption must not reach legacy handlers");
assert.match(html, /id="mobileSessionsTitle" tabindex="-1"[\s\S]*id="mobileActivityTitle" tabindex="-1"[\s\S]*id="mobileProjectTitle" tabindex="-1"[\s\S]*id="mobileSurfaceTitle" tabindex="-1"/, "route and surface headings must be programmatically focusable");
assert.match(app, /mobilePresentation = value === "detailed" \? "detailed" : "essential"/, "Essential/Detailed is browser presentation state");
assert.match(app, /This does not enable compact-v1 or change transcript content/, "presentation must not mutate compact-v1 or transcript semantics");
assert.match(app, /mobileDismissedActivityKeys/, "completed activity can be dismissed without deleting session history");
assert.match(app, /const priorityTabs = visible\.filter[\s\S]*?renderGroup\("Priority", priorityTabs\)/, "Sessions must render needs-input and running work in a top Priority group");
assert.match(app, /const badgeLabels = \{[\s\S]*?button\.setAttribute\("aria-label", badgeLabel \? `\$\{base\}, \$\{badgeLabel\}` : base\)/, "destination names must describe the actual badge semantics");
assert.match(app, /tabPendingBlockerCount\(tab\)/, "Activity must consume canonical blocker state");
assert.match(app, /workflowRunningCountForTab\(tab\.id\)/, "Activity must consume canonical workflow state");
assert.match(app, /tabAppRunnerRunningRun\(tab\)/, "Activity must consume canonical app-runner state");
assert.match(app, /installMobilePhoneExperience\(\);/, "the phone shell must be installed at boot");

assert.match(css, /html\[data-mobile-shell="v2"\] \.mobile-shell-v2/, "mobile CSS must be root scoped");
assert.match(css, /--mobile-control-size:\s*40px;[\s\S]*?html\[data-mobile-shell="v2"\][\s\S]*?min-height:\s*var\(--mobile-control-size\)/, "phone v2 targets must use the selected 40px floor");
assert.match(css, /env\(safe-area-inset-bottom\)/, "bottom controls must honor safe areas");
assert.match(css, /data-mobile-presentation="essential"/, "Essential presentation must use progressive disclosures");
assert.match(css, /html\[data-mobile-shell="v2"\] body\.mobile-keyboard-open \.widget-area,[\s\S]*?\.composer-actions-button \{ display: block !important; \}/, "v2 keyboard mode must keep run widgets and the actions entry available");
assert.match(css, /@media \(prefers-reduced-motion: reduce\)/, "reduced-motion behavior is required");
assert.match(css, /@media \(forced-colors: active\)/, "forced-color affordances are required");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "browser asset changes need a coherent cache tuple");

console.log("mobile-phone-experience-static.test.mjs passed");
