import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [pkgRaw, html, css, app, server, extension, readme, technical, development, startScript, manifestRaw, serviceWorker, appleIcon, icon192, icon512, matrixBackground, mochaBackground] = await Promise.all([
  readFile(join(root, "package.json"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8").then((value) => value.replace(/\r\n/g, "\n")),
  readFile(join(root, "index.ts"), "utf8"),
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
  readFile(join(root, "dev", "scripts", "start-webui.sh"), "utf8"),
  readFile(join(root, "public", "manifest.webmanifest"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "public", "apple-touch-icon.png")),
  readFile(join(root, "public", "icon-192.png")),
  readFile(join(root, "public", "icon-512.png")),
  readFile(join(root, "public", "matrix-background.webp")),
  readFile(join(root, "public", "catppuccin-mocha-background.png")),
]);
const pkg = JSON.parse(pkgRaw);
const manifest = JSON.parse(manifestRaw);
const helper = await readFile(join(root, "webui-rpc-helper.mjs"), "utf8");
const codexAuth = await readFile(join(root, "lib", "codex-usage-auth.mjs"), "utf8");
const optionalFeatureCatalog = await readFile(join(root, "lib", "optional-feature-catalog.mjs"), "utf8");

function appFunctionSource(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const nextStarts = [
    app.indexOf(`\nfunction ${nextName}(`, start),
    app.indexOf(`\nasync function ${nextName}(`, start),
  ].filter((index) => index > start);
  const end = nextStarts.length ? Math.min(...nextStarts) : -1;
  assert.ok(start >= 0 && end > start, `${name} should remain a standalone frontend helper`);
  return app.slice(start, end);
}
const nativeExportPayload = await readFile(join(root, "lib", "native-export-payload.mjs"), "utf8");
const companionDependencies = {
  "@firstpick/pi-extension-bang-command-autocomplete": "^0.2.2",
  "@firstpick/pi-extension-btw": "^0.1.4",
  "@firstpick/pi-extension-fish-user-bash": "^0.2.2",
  "@firstpick/pi-extension-git-footer-status": "^0.5.0",
  "@firstpick/pi-extension-release-aur": "^0.1.8",
  "@firstpick/pi-extension-release-npm": "^0.4.4",
  "@firstpick/pi-extension-safety-guard": "^0.2.6",
  "@firstpick/pi-extension-setup-skills": "^0.1.9",
  "@firstpick/pi-extension-stats": "^0.2.9",
  "@firstpick/pi-extension-todo-progress": "^0.2.9",
  "@firstpick/pi-extension-tools": "^0.1.7",
  "@firstpick/pi-extension-workflows": "^0.1.7",
  "@firstpick/pi-package-remote-webui": "^0.1.8",
  "@firstpick/pi-prompts-git-pr": "^0.1.5",
  "@firstpick/pi-themes-bundle": "^0.1.5",
};

assert.match(html, /viewport-fit=cover/, "viewport should opt into safe-area-aware full-screen layout");
assert.match(html, /interactive-widget=resizes-content/, "viewport should request keyboard-driven content resizing where supported");
assert.match(html, /<meta name="theme-color" content="#11111b" \/>/, "PWA should declare a mobile browser theme color");
assert.match(html, /<link rel="manifest" href="\/manifest\.webmanifest" \/>/, "PWA should expose a web app manifest");
assert.match(html, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png" \/>/, "PWA should expose the conventional iOS home-screen icon path");
assert.match(html, /id="terminalTabsToggleButton"/, "mobile should expose a compact terminal-tabs toggle");
assert.match(html, /id="newTabMenu" class="terminal-new-tab-menu composer-publish-menu"/, "new-tab control should reuse the shared composer dropdown container");
assert.match(html, /id="newTabButton"[\s\S]*aria-haspopup="menu"[\s\S]*aria-controls="newTabMenuPanel"/, "new-tab control should open a dropdown menu");
assert.match(html, /id="newTabMenuPanel" class="terminal-new-tab-menu-panel composer-publish-menu-panel"/, "new-tab menu should reuse the shared composer dropdown panel");
assert.match(html, /id="newTabCurrentDirectoryButton" class="terminal-new-tab-menu-item composer-publish-menu-item"[\s\S]*<span>Current Directory<\/span>/, "new-tab menu should offer the active cwd");
assert.match(html, /id="newTabChooseDirectoryButton" class="terminal-new-tab-menu-item composer-publish-menu-item"[\s\S]*<span>Choose Directory<\/span>/, "new-tab menu should offer the cwd picker");
assert.match(html, /id="newTabWorktreeButton" class="terminal-new-tab-menu-item composer-publish-menu-item"[\s\S]*<span>Branch Worktree…<\/span>/, "new-tab menu should offer branch worktree tabs");
assert.match(html, /id="closeAllTabsButton"[\s\S]*?>Close all Tabs<\/button>/, "tab header should expose a top-right close-all tabs action");
assert.match(html, /id="sidePanelBackdrop"/, "mobile side panel needs an overlay/backdrop close target");
assert.match(html, /<div class="side-panel-heading">[\s\S]*<strong class="side-panel-title">Control Deck<\/strong>[\s\S]*<div class="side-panel-version-row"[\s\S]*<button id="piVersionButton"[\s\S]*aria-controls="piReleaseNotesDialog"[\s\S]*<button id="webuiVersionButton"[\s\S]*aria-controls="webuiPackageDialog"[\s\S]*id="webuiDevBadge"/, "Control Deck header should keep its title separate from an aligned version and build row");
assert.match(html, /<div class="side-panel-brand-row">[\s\S]*<span class="side-panel-kicker">Pi Web UI<\/span>[\s\S]*<a class="sponsor-link" data-visibility-key="control-deck\.sponsor" href="https:\/\/github\.com\/sponsors\/Firstp1ck" target="_blank" rel="noopener noreferrer" aria-label="Sponsor Firstp1ck on GitHub"[^>]*>♡<\/a>/, "Control Deck brand should expose a subtle, accessible sponsor link beside the Pi Web UI name");
assert.match(html, /<dialog id="piReleaseNotesDialog"[\s\S]*id="piReleaseNotesTitle"[\s\S]*id="piReleaseNotesStatus"[\s\S]*id="piReleaseNotesBody"[\s\S]*id="piReleaseNotesGithubLink"/, "Pi release notes should use a dedicated accessible dialog");
assert.doesNotMatch(html, /Safer option|confirmationAlternative/, "shared confirmation dialogs should not render a safer-option row");
assert.doesNotMatch(app, /confirmationAlternative|\balternative:\s*options\.alternative/, "confirmation logic should not populate a removed safer-option row");
assert.doesNotMatch(html, /id="sessionLine"/, "Control Deck title should not show verbose session status metadata");
assert.match(html, /id="themeSelect"/, "side panel should expose a theme selector");
assert.match(html, /class="controls-intro"[\s\S]*aria-labelledby="sessionControlsTitle"[\s\S]*aria-labelledby="interfaceControlsTitle"[\s\S]*id="networkControlField"[\s\S]*aria-labelledby="serverControlsTitle"/, "Controls should explain scope and group session, interface, remote-access, and server settings in task order");
assert.match(html, /id="sessionControlsTitle">Active session<[\s\S]*class="control-scope-badge">This tab<[\s\S]*id="interfaceControlsTitle">Interface<[\s\S]*class="control-scope-badge">This browser</, "Controls groups should state whether settings affect the active tab or this browser");
assert.match(html, /class="control-action-row">[\s\S]*id="modelSelect"[\s\S]*id="setModelButton"[^>]*>Apply<\/button>[\s\S]*id="thinkingSelect"[\s\S]*id="setThinkingButton"[^>]*>Apply<\/button>/, "model and thinking controls should keep their apply actions beside the selection");
assert.match(css, /\.control-group-header[\s\S]*\.control-scope-badge[\s\S]*\.control-action-row/, "Controls should visually separate group headers, scope badges, and compact action rows");
assert.match(html, /<label for="themeSelect"[^>]*id="themeControlLabel"[^>]*>Theme<\/label>/, "theme selector should be labeled in side-panel controls");
assert.match(html, /id="themeControlLabel"[\s\S]*id="themeSelect"[\s\S]*id="themeSearchInput"[\s\S]*id="themeSearchResults"/, "side-panel theme selector should keep the compact control row before its expandable search results");
assert.match(html, /id="backgroundInput"[^>]*type="file"[^>]*accept="image\/png,image\/jpeg,image\/webp,image\/gif"/, "side panel should expose an image picker for custom backgrounds");
assert.match(html, /id="backgroundClearButton"[\s\S]*?>×<\/button>/, "side-panel background control should expose an X remove button");
assert.match(html, /id="serverActionSelect"[\s\S]*<option value="restart">Restart Server<\/option>[\s\S]*<option value="stop">Stop Server<\/option>/, "side panel should expose restart and stop server actions in a dropdown");
assert.match(html, /id="runServerActionButton"[^>]*disabled[^>]*>Run<\/button>/, "side panel should expose a guarded button for selected server actions");
assert.match(html, /id="serverActionStatus"[^>]*aria-live="polite"/, "server actions should expose visible restart feedback");
assert.match(html, /id="agentDoneNotificationsToggle"/, "side panel should expose an agent-done notifications toggle");
assert.match(html, /id="agentDoneNotificationsStatus"/, "agent-done notifications toggle should expose status text");
assert.match(html, /id="thinkingVisibilityToggle"/, "side panel should expose a thinking-output visibility toggle");
assert.match(html, /id="thinkingVisibilityStatus"/, "thinking-output visibility toggle should expose status text");
assert.match(html, /<option value="xhigh">xhigh<\/option>\s*<option value="max">max<\/option>/, "side panel should expose Pi's max thinking effort after xhigh");
assert.match(app, /const SETTINGS_THINKING_OPTIONS = \["off", "minimal", "low", "medium", "high", "xhigh", "max"\]/, "native settings should expose every Pi thinking effort");
assert.match(app, /return levels\.length \? levels : \["off", "minimal", "low", "medium", "high", "xhigh", "max"\]/, "footer thinking picker fallback should include max effort");
assert.match(server, /const THINKING_LEVELS = \["off", "minimal", "low", "medium", "high", "xhigh", "max"\]/, "server should accept Pi's max thinking effort");
assert.match(html, /id="terminalTabsLayoutSelect"[\s\S]*<option value="left">Sidebar<\/option>/, "side panel controls should expose a terminal-tabs layout selector");
assert.match(html, /id="terminalTabsLayoutStatus"/, "terminal-tabs layout selector should expose status text");
assert.match(html, /id="nativeCommandDialog"/, "native slash selector UI should have a dedicated dialog");
assert.match(html, /id="optionsWorkflowSetupButton"[^>]*data-command="\/workflow-setup"[^>]*hidden[\s\S]*Workflow Permission Setup/, "Common Pi options should expose catalog-gated Workflow Permission Setup");
assert.match(html, /id="optionsSummarySetupButton"[^>]*data-command="\/summary-setup"[^>]*hidden[\s\S]*Session Summary Setup/, "Common Pi options should expose catalog-gated Session Summary Setup");
assert.doesNotMatch(html, /id="summary(?:Header|Action)Button"/, "workspace-level session summary launchers should be removed");
assert.match(html, /id="sessionSummaryOverlay"[^>]*role="dialog"[^>]*aria-modal="false"[^>]*aria-labelledby="sessionSummaryOverlayTitle"[^>]*hidden[\s\S]*id="sessionSummaryOverlayBody"[\s\S]*id="sessionSummaryOverlayCopyButton"[\s\S]*id="sessionSummaryOverlayRefreshButton"/, "session summary should use a labelled non-modal Markdown overlay with copy and refresh actions");
assert.doesNotMatch(html, /<dialog[^>]*id="sessionSummaryOverlay"/, "session summary overlay must remain non-blocking rather than modal");
assert.match(html, /id="optionsSafetyGuardSetupButton"[\s\S]*data-command="\/safety-guard-setup"[\s\S]*Safety Guard Setup/, "Common Pi options should expose native Safety Guard Setup");
assert.match(html, /id="optionsGitWorkflowSetupButton"[\s\S]*data-command="\/git-workflow-setup"[\s\S]*Guided Git Setup/, "Common Pi options should expose native Guided Git Setup");
assert.match(app, /const NATIVE_SELECTOR_COMMANDS = new Set\(\[[^\]]*"summary"[^\]]*"summary-setup"[^\]]*"workflow-setup"[^\]]*\]\)/, "exact /summary, /summary-setup, and /workflow-setup should be browser-native selector commands");
assert.match(app, /function createTerminalTabSessionSummaryButton\(tab\)[\s\S]*hasAvailableCommand\("summary", \{ tabId: tab\.id \}\)[\s\S]*setAttribute\("aria-busy"[\s\S]*openSessionSummaryForTab\(tab\.id, \{ focusReturnKey:/, "each terminal tab summary action should use that tab's command catalog, busy state, focus restoration, and direct target");
assert.match(app, /function renderTerminalTab\(tab, \{ showCwdAdd = false \} = \{\}\)[\s\S]*createTerminalTabActions\(tab\)[\s\S]*function renderTerminalTabGroupItem\(tab, group\)[\s\S]*createTerminalTabActions\(tab\)/, "regular and grouped Pi terminal tabs should render shared per-tab split and summary actions");
assert.match(app, /function createTerminalTabActions\(tab\)[\s\S]*createTerminalTabSplitButton\(tab\)[\s\S]*createTerminalTabSessionSummaryButton\(tab\)/, "each terminal action slot should place Split beside Summary");
assert.match(app, /function terminalTabControlKey\(node\)[\s\S]*terminal-tab-split-button[\s\S]*terminal-tab:\$\{tabId\}:split[\s\S]*terminal-tab-summary-button[\s\S]*terminal-tab:\$\{tabId\}:summary/, "per-tab split and summary actions should retain stable focus continuity keys");
assert.match(app, /\.terminal-tab-close, \.terminal-tab-actions, \.terminal-tab-cwd-add, \.terminal-tab-group-add/, "per-tab actions should not initiate terminal-tab dragging");
assert.match(app, /function prefetchInactiveTabCommandCatalogs\(\)[\s\S]*refreshCommands\(activeTabContext\(tab\.id\)\)[\s\S]*function refreshTabs[\s\S]*prefetchInactiveTabCommandCatalogs\(\)/, "restored inactive tabs should fetch their own command catalogs without activation");
assert.match(app, /const focusReturnKey = sessionSummaryOverlayFocusReturnKey[\s\S]*querySelectorAll\("button"\)[\s\S]*terminalTabControlKey\(node\) === focusReturnKey/, "summary overlay focus restoration should resolve rerendered per-tab controls by continuity key");
assert.match(app, /sessionSummaryOverlayFocusReturnKey = focusReturnKey \|\| terminalTabControlKey\(sessionSummaryOverlayFocusReturn\)/, "summary overlay opening should preserve an explicit per-tab focus key or capture the active control key");
assert.match(app, /openNativeSessionSummarySetupDialog\(\{ initialData: response\.data, tabId, focusReturnKey \}\)[\s\S]*tabId: targetTabId/, "unconfigured summary setup and preference save should retain the clicked tab target and focus return identity");
assert.match(css, /\.terminal-tab-actions \{[\s\S]*flex: 0 0 2rem[\s\S]*flex-direction: column[\s\S]*\.terminal-tab-split-button,[\s\S]*\.terminal-tab-summary-button \{[\s\S]*flex: 1 1 50%[\s\S]*min-height: 0[\s\S]*\.terminal-tab-split-button:not\(:only-child\) \{[\s\S]*border-bottom:[\s\S]*\.terminal-tab-group-item > \.terminal-tab-actions[\s\S]*\.terminal-tab-close \{/, "Split and Summary should stack at half height without increasing the existing compact tab height");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.terminal-tab-actions,[\s\S]*\.terminal-tab-close \{[\s\S]*min-width: 44px/, "touch layouts should preserve the shared 44px action slot and separate close target");
assert.match(app, /function normalizeSessionSummaryClientState\(value, previous = null, \{ resetProjection = false \} = \{\}\)[\s\S]*sessionChanged[\s\S]*resetProjection \|\| sessionChanged \? null : previous[\s\S]*inherited\?\.summaryMarkdown/, "frontend should preserve failure Markdown but clear it for session changes and explicit branch-state projections");
assert.match(app, /function handleSessionSummaryEvent\(event\)[\s\S]*resetProjection: event\?\.kind === "state"/, "active-branch state events should reset the cached overlay projection");
assert.match(app, /function renderSessionSummaryOverlay\(\)[\s\S]*renderMarkdown\(elements\.sessionSummaryOverlayBody, state\.summaryMarkdown\)/, "summary overlay should use the sanitized Markdown renderer");
assert.match(app, /previous successful summary is preserved/, "summary overlay should explain failure preservation");
assert.match(app, /async function openNativeSessionSummarySetupDialog[\s\S]*Inject latest summary into main-agent context[\s\S]*nativeSettingsNote\("Privacy scope"[\s\S]*nativeSettingsNote\("Cost and provider behavior"/, "browser-native summary setup should expose the approved context, privacy, and cost controls");
assert.match(app, /addNativeCommandAction\("Save and generate"[\s\S]*confirmed: true[\s\S]*requestSessionSummaryGeneration/, "browser-native summary setup should confirm, persist, and immediately request the first generation");
assert.match(app, /sessionSummaryOverlayCopyButton[\s\S]*copyText\(state\.summaryMarkdown\)/, "summary copy should use the raw validated Markdown source");
assert.match(css, /\.session-summary-overlay \{[\s\S]*position: fixed[\s\S]*\.session-summary-overlay\[hidden\][\s\S]*@media \(max-width: 720px\)[\s\S]*\.session-summary-overlay/, "summary overlay should be visibly non-modal and responsive on mobile");
assert.match(app, /function normalizedWorkflowPolicyList\(value\)[\s\S]*new Set[\s\S]*\.filter\(Boolean\)\)\]\.sort\(\)/, "workflow policy list fields should trim, deduplicate, and sort for the canonical preview");
assert.match(app, /function parseWorkflowPolicyVerificationCommands\(value\)[\s\S]*JSON\.parse\(line\)[\s\S]*non-empty JSON string argv array[\s\S]*commands\.push\(command\)/, "workflow verification should accept one ordered JSON argv array per nonblank line");
assert.match(app, /async function openNativeWorkflowSetupDialog\(\)[\s\S]*api\("\/api\/workflow-policy", \{ scoped: false \}\)[\s\S]*nativeSettingToggle\("Allow write"[\s\S]*nativeSettingToggle\("Allow shell"[\s\S]*nativeSettingToggle\("Allow network"[\s\S]*Exact normalized JSON preview/, "workflow setup should load the localhost policy API and render accessible permission controls plus an exact normalized preview");
assert.match(app, /Authorization ceiling[\s\S]*not blanket authority[\s\S]*Shell safety[\s\S]*not an OS sandbox[\s\S]*explicit empty-verification waiver/, "workflow setup should explain ceiling, shell sandbox, and empty-verification limitations");
assert.match(app, /nativeSettingsDirty = workflowPolicyDraftSignature\(controls\) !== initialDraftSignature/, "workflow setup edits should participate in native dialog discard protection");
assert.match(app, /addNativeCommandAction\("Reset to all deny"[\s\S]*applyDeniedWorkflowPolicyControls\(controls\)[\s\S]*controls\.write\.input\.focus\(\)/, "workflow setup should expose an explicit reset-to-all-deny action");
assert.match(app, /title: "Save reviewed workflow permission ceiling\?"[\s\S]*Exact normalized JSON:[\s\S]*if \(!reviewed\) return;[\s\S]*api\("\/api\/workflow-policy", \{[\s\S]*body: \{ policy: policyToSave, expectedRevision: data\.revision \?\? null \}[\s\S]*No agent turn was started/, "workflow setup should require explicit normalized review before revision-protected save and report transient no-turn success");
assert.match(app, /\(name === "workflow-setup" \|\| name === "summary" \|\| name === "summary-setup"\) && !hasLoadedRpcCommand\(name\)[\s\S]*case "summary":[\s\S]*await openSessionSummaryForTab[\s\S]*case "workflow-setup":[\s\S]*await openNativeWorkflowSetupDialog\(\)/, "native summary and setup routing should require the active Pi tab's loaded extension command catalog");
assert.match(app, /function normalizeWorkflowPolicySuggestions\(value\)[\s\S]*if \(!value \|\| typeof value !== "object" \|\| Array\.isArray\(value\)\) return empty;[\s\S]*if \(!Array\.isArray\(group\) \|\| group\.some[\s\S]*return \[\];[\s\S]*shellAllowlist: normalizeStringGroup\(value\.shellAllowlist\)[\s\S]*networkAllowlist: normalizeStringGroup\(value\.networkAllowlist\)[\s\S]*verificationCommands: normalizeVerificationGroup\(value\.verificationCommands\)/, "workflow suggestions should defensively normalize each server-provided catalog group and render no fallback for malformed groups");
assert.match(app, /const suggestions = normalizeWorkflowPolicySuggestions\(data\.suggestions\)[\s\S]*suggestionLabel: "Shell executable suggestions"[\s\S]*suggestionLabel: "Network host suggestions"[\s\S]*suggestionLabel: "Verification command suggestions"/, "all three workflow policy textareas should consume only GET-provided suggestions in labelled groups");
const appendWorkflowPolicySuggestionSource = appFunctionSource("appendWorkflowPolicySuggestion", "workflowPolicySuggestionGroup");
assert.match(appendWorkflowPolicySuggestionSource, /const separator = textarea\.value && !textarea\.value\.endsWith\("\\n"\)[\s\S]*textarea\.value = `\$\{textarea\.value\}\$\{separator\}\$\{line\}`[\s\S]*dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)[\s\S]*textarea\.focus\(\)/, "workflow suggestions should append an exact line without replacing manual text and dispatch current input tracking");
assert.doesNotMatch(appendWorkflowPolicySuggestionSource, /\.checked|permissions|api\(/, "adding a workflow suggestion must not toggle permissions or persist anything");
const workflowPolicySuggestionGroupSource = appFunctionSource("workflowPolicySuggestionGroup", "workflowPolicyTextarea");
assert.match(workflowPolicySuggestionGroupSource, /setAttribute\("role", "group"\)[\s\S]*setAttribute\("aria-labelledby", labelNode\.id\)[\s\S]*button\.type = "button"[\s\S]*button\.disabled = present\.has\(line\)[\s\S]*textarea\.addEventListener\("input", sync\)/, "workflow suggestion controls should be labelled, keyboard-native buttons that disable and resync with manual edits");
assert.match(app, /function workflowPolicyPresentSuggestionLines\(textarea, kind\)[\s\S]*normalizedWorkflowPolicyList\(textarea\.value\)[\s\S]*JSON\.parse\(line\)[\s\S]*present\.add\(JSON\.stringify\(command\)\)/, "workflow suggestion deduplication should compare normalized exact list and verification values");
assert.match(app, /const renderPreview = \(\) => \{\s*controls\.shellAllowlist\.syncSuggestions\(\);\s*controls\.networkAllowlist\.syncSuggestions\(\);\s*controls\.verificationCommands\.syncSuggestions\(\);[\s\S]*addNativeCommandAction\("Reset to all deny"[\s\S]*applyDeniedWorkflowPolicyControls\(controls\);\s*renderPreview\(\);/, "workflow preview and reset should resync suggestion availability after additions or removals");
assert.match(app, /body: \{ policy: policyToSave, expectedRevision: data\.revision \?\? null \}/, "workflow save should persist only canonical policy and revision, never suggestion metadata");
assert.match(html, /id="nativeCommandSearch"[^>]*type="search"/, "native slash selector dialog should expose a filter box");
assert.match(html, /id="remoteQrDialog"[\s\S]*id="remoteQrBody"[\s\S]*id="remoteQrCopyButton"/, "remote WebUI should expose a dedicated QR popup dialog");
assert.match(html, /id="commandPaletteCloseButton"[^>]*aria-label="Close command palette"[^>]*>Close<\/button>/, "command palette should expose a visible accessible close button");
assert.match(html, /id="pathPickerCreateNameInput"[^>]*placeholder="New directory name"/, "cwd picker should expose a new-directory name input");
assert.match(html, /id="pathPickerCreateButton"[^>]*>Create directory<\/button>/, "cwd picker should expose a create-directory action");
assert.match(html, /id="pathPickerSearchInput"[^>]*type="search"[^>]*placeholder="Search current directory…"/, "cwd picker should expose a current-directory search box");
assert.match(html, /id="pathPickerClearSearchButton"[^>]*hidden[^>]*>Clear<\/button>/, "cwd picker should expose a clear-search action");
assert.match(app, /function fileTreeGitStatusForEntry\(entry = \{\}\) \{\s+return fileTreeState\.gitStatusByPath\.get\(normalizeFileTreePath\(entry\.path \|\| ""\)\) \|\| null;\s+\}/, "file tree rendering should use the refreshed Git-status snapshot instead of stale status embedded in cached entries");
assert.match(app, /function fileTreeExpander\(expanded = false\)[\s\S]*make\("span", "file-tree-expander", expanded \? "▾" : "▸"\)[\s\S]*aria-hidden/, "file tree arrows should be visual children rather than separate buttons");
assert.match(app, /function appendFileTreeEntry\(parent, entry, depth = 0\)[\s\S]*button\.append\([\s\S]*isDirectory \? fileTreeExpander\(expanded\)[\s\S]*file-tree-name[\s\S]*button\.addEventListener\("click"[\s\S]*toggleFileTreeDirectory\(path\)[\s\S]*item\.append\(button, fileTreeOverflowButton\(entry\)\)/, "each directory arrow and label should share one expansion button");
assert.match(app, /function appendFileSearchEntry\(parent, entry\)[\s\S]*button\.append\([\s\S]*isDirectory \? fileTreeExpander\(expanded\)[\s\S]*button\.addEventListener\("click"[\s\S]*toggleFileTreeDirectory\(path\)[\s\S]*item\.append\(button, fileTreeOverflowButton\(entry\)\)/, "directory search results should combine their arrow and label action while toggling in place");
assert.match(css, /\.file-tree-node \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto[\s\S]*\.file-tree-item \{[\s\S]*grid-template-columns: auto auto minmax\(0, 1fr\) auto auto/, "file tree layout should reserve one row button plus the overflow action while keeping the arrow inside the row button");
assert.match(app, /confirmLabel: activeAgentTabs\.length \? "Close and stop work" : count === 1 \? "Close tab" : "Close tabs"/, "single-tab confirmation should use singular close wording");
assert.match(html, /data-side-panel-section="git"[\s\S]*class="side-panel-section-label">Git<[\s\S]*id="gitPanelCountBadge"[\s\S]*id="gitPanelGroups"[\s\S]*aria-label="Git repositories"[\s\S]*id="gitPanelContextMenu"[\s\S]*role="menu"/, "side panel should expose a collapsed, globally deduplicated Git repository list with a count and dedicated action menu");
assert.match(app, /const GIT_PANEL_CACHE_MAX_AGE_MS = 5 \* 60 \* 1000/, "Git panel should use the approved five-minute page-local freshness window");
assert.match(app, /function gitPanelTerminalGroups\(\)[\s\S]*tabCwdGroups\(\)[\s\S]*shouldRenderTerminalTabGroup[\s\S]*key: `tab:\$\{tab\.id\}`[\s\S]*title: tabGroupTitle\(tab\.cwd, "Working directory"\)/, "Git panel discovery should mirror visible terminal groups while cwd—not session title—defines ungrouped labels");
assert.match(app, /function gitPanelCandidates\(groups = gitPanelTerminalGroups\(\)\)[\s\S]*const byCwd = new Map\(\)[\s\S]*key: `cwd:\$\{cwd\}`/, "Git panel discovery should deduplicate repeated cwd candidates globally across terminal groups");
assert.match(app, /function gitPanelRepositoryCards\(groups = gitPanelTerminalGroups\(\)\)[\s\S]*const identity = root \? `root:\$\{root\}` : candidate\.key[\s\S]*byIdentity/, "Git panel cards should deduplicate discovered repositories globally by canonical Git root");
assert.match(app, /const cards = gitPanelRepositoryCards\(groups\)/, "Git panel rendering should consume the globally deduplicated repository card list");
const gitPanelCandidatesSource = appFunctionSource("gitPanelCandidates", "gitPanelRepositoryCards");
const gitPanelRepositoryCardsSource = appFunctionSource("gitPanelRepositoryCards", "gitPanelRootLabel");
const gitPanelDeduplication = JSON.parse(vm.runInNewContext(`${gitPanelCandidatesSource}\n${gitPanelRepositoryCardsSource}\nJSON.stringify((() => {\n  const groups = [\n    { key: "group-a", tabs: [{ id: "tab-1", cwd: "/repo" }, { id: "tab-2", cwd: "/repo" }] },\n    { key: "group-b", tabs: [{ id: "tab-3", cwd: "/repo" }, { id: "tab-4", cwd: "/repo/subdir" }] },\n  ];\n  gitPanelState.discovery.set("cwd:/repo", { root: "/repo", resolved: true });\n  gitPanelState.discovery.set("cwd:/repo/subdir", { root: "/repo", resolved: true });\n  return { candidates: gitPanelCandidates(groups), cards: gitPanelRepositoryCards(groups) };\n})())`, {
  gitPanelState: { discovery: new Map() },
  gitPanelTerminalGroups: () => [],
  tabGroupTitle: (cwd) => cwd.split("/").filter(Boolean).pop() || "Working directory",
}));
assert.equal(gitPanelDeduplication.candidates.length, 2, "repeated cwd tabs across terminal groups should create one discovery candidate per cwd");
assert.equal(gitPanelDeduplication.cards.length, 1, "different cwd candidates in the same canonical repository should render one card globally");
assert.equal(gitPanelDeduplication.cards[0].key, "root:/repo", "the global repository card key should be based only on the canonical Git root");
assert.match(app, /function toggleGitPanelRepository\(card\)[\s\S]*gitPanelState\.expandedCardKey === card\.key[\s\S]*gitPanelState\.expandedCardKey = card\.key/, "only one Git repository card should be expanded at a time");
assert.match(app, /function loadGitPanelRepository\(card, \{ force = false \} = \{\}\)[\s\S]*!force && gitPanelSnapshotFresh\(existing\)[\s\S]*api\("\/api\/git-panel"/, "repository expansion should reuse fresh cache and otherwise load local status on demand");
assert.match(app, /ensureGitPanelRepositoriesDiscovered\(\{ retryUnavailable: true \}\)[\s\S]*function ensureGitPanelRepositoriesDiscovered\(\{ retryUnavailable = false \} = \{\}\)[\s\S]*discoverGitPanelCandidate\(candidate, \{ force: true \}\)/, "reopening the Git section should rediscover cwd entries that were previously not repositories");
assert.match(app, /function renderGitPanel\(\) \{\s+if \(!elements\.gitPanelGroups \|\| !gitPanelSectionExpanded\(\)\) return;/, "tab polling should not rebuild the Git panel while its top-level section is collapsed");
assert.doesNotMatch(app, /make\("div", "git-side-panel-tree"[\s\S]{0,180}setAttribute\("role", "tree"\)/, "Git file disclosures should use native details semantics instead of an incomplete ARIA tree");
assert.match(app, /function gitPanelStatsText\(entry = \{\}, category = ""\)[\s\S]*category === "staged"[\s\S]*category === "changes"/, "mixed index/worktree files should display category-specific numstat values");
assert.match(app, /function renderGitPanelChanges\(card, data\)[\s\S]*"Conflicts"[\s\S]*"Staged"[\s\S]*"Changes"[\s\S]*"Untracked"/, "Git panel should render every requested change category");
assert.match(app, /function runGitPanelAction\(card, action, path = ""\)[\s\S]*"stage-all"[\s\S]*"unstage-all"[\s\S]*confirm:[\s\S]*git restore --[\s\S]*Delete untracked file/, "Git panel actions should cover staging plus confirmed destructive discard/delete flows");
assert.match(app, /function renderGitPanelHistory\(card, data\)[\s\S]*openGitCommitDialog\(card\.tabId, commit\)/, "Git History should open bounded commit diffs from the selected repository");
assert.match(app, /elements\.gitPanelGroups\.replaceChildren\(\.\.\.cards\.map\(renderGitPanelRepositoryCard\)\)/, "Git repositories should render directly without a redundant terminal/session disclosure");
assert.doesNotMatch(app, /function renderGitPanelGroup\(/, "Git panel should not render terminal/session parent dropdowns");
assert.match(app, /function gitPanelContextMenuItems\(context\)[\s\S]*kind === "repository"[\s\S]*"View Diff"[\s\S]*"Stage All"[\s\S]*"Unstage All"[\s\S]*"Discard changes…"[\s\S]*"Delete file…"/, "repository and path actions should be provided by the Git context menu");
assert.match(app, /function bindGitPanelContextMenu\(trigger, context\)[\s\S]*"contextmenu"[\s\S]*"ContextMenu"[\s\S]*event\.shiftKey && event\.key === "F10"/, "Git context actions should support right click and keyboard-equivalent invocation");
assert.doesNotMatch(app, /git-side-panel-file-actions|git-side-panel-toolbar-actions|git-side-panel-stage-select|gitPanelSmallButton/, "Git rows should not render the removed inline action controls");
assert.match(app, /function renderGitPanelFolder\(node, card, category, depth = 0\)[\s\S]*const defaultOpen = true[\s\S]*details\.open = gitPanelState\.openFolders\.has\(folderKey\) \? gitPanelState\.openFolders\.get\(folderKey\) : defaultOpen[\s\S]*details\.open === defaultOpen[\s\S]*gitPanelState\.openFolders\.set\(folderKey, details\.open\)[\s\S]*git-side-panel-folder-chevron[\s\S]*aria-hidden/, "Git folders should start expanded at every depth while retaining explicit user collapse overrides");
assert.match(css, /\.git-side-panel-folder-chevron[\s\S]*transform: rotate\(0deg\)[\s\S]*\.git-side-panel-folder\[open\][\s\S]*transform: rotate\(90deg\)/, "Git folder arrows should indicate collapsed and expanded states");
assert.match(css, /\.git-side-panel-repository[\s\S]*\.git-side-panel-file[\s\S]*grid-template-columns: 1\.3rem minmax\(5rem, 1fr\) auto[\s\S]*\.git-side-panel-context-menu[\s\S]*\.git-side-panel-commit/, "Git side panel should prioritize filename width and style repository, context-menu, and history surfaces");
assert.match(server, /async function readGitPanel\(cwd\)[\s\S]*GIT_PANEL_HISTORY_LIMIT[\s\S]*"status", "--porcelain=v1", "-z"[\s\S]*"--numstat", "-z"/, "server should build compact bounded local Git snapshots without full file contents");
assert.match(server, /async function readGitCommit\(cwd, requestedHash\)[\s\S]*\^\[a-f0-9\][\s\S]*"show", "--format="/, "commit inspection should require a full hash and use a bounded read-only Git show");
assert.match(server, /"\/api\/git-changes\/stage-all"[\s\S]*stageAllGitChanges[\s\S]*"\/api\/git-changes\/unstage-all"[\s\S]*unstageAllGitChanges/, "server should expose repository-wide stage and unstage mutations");
assert.match(technical, /side-panel \*\*Git\*\* section[\s\S]*five-minute cache window[\s\S]*confirmed discard\/delete actions[\s\S]*latest 30 commits/, "technical reference should document Git panel grouping, refresh, actions, and history behavior");
assert.match(html, /id="optionalFeaturesBox"/, "side panel should expose optional feature status and controls");
assert.match(html, /class="optional-features-description[\s\S]*href="https:\/\/github\.com\/Firstp1ck\/pi-coding-agent-forge\/issues\/new"[\s\S]*open a GitHub issue/, "optional features should link users to GitHub issues for additional feature requests");
assert.doesNotMatch(html, /id="btwOverlayDialog"/, "/btw should not use a blocking modal overlay");
assert.match(html, /id="codexUsageBox"/, "side panel should expose Codex subscription usage status");
assert.match(html, /data-side-panel-section="codex-usage"/, "Codex usage should live in a collapsible side-panel section");
assert.match(html, /data-side-panel-section="subagents"[\s\S]*class="side-panel-section-label">Subagents<\/span>[\s\S]*id="subagentCountBadge"[\s\S]*class="subagents-help"[\s\S]*Managed and registered Pi agent runs appear here[\s\S]*External agents[\s\S]*id="subagentsBox"/, "side panel should explain managed and registered agent visibility with a live count");
assert.match(html, /id="subagentOpenModeSelect"[\s\S]*<option value="overlay">Overlay<\/option>[\s\S]*<option value="tab">Tab \/ terminal<\/option>[\s\S]*id="subagentOpenModeStatus"/, "Subagents should offer a browser-persisted overlay or terminal-tab opening choice");
assert.match(html, /class="subagents-status-row"[\s\S]*id="subagentsAutoClearButton"[^>]*aria-pressed="false"[^>]*>Auto-Clear<\/button>[\s\S]*id="subagentsStatus"[\s\S]*id="subagentsClearFinishedButton"[^>]*disabled[^>]*>Clear finished<\/button>/, "Subagents should expose selectable auto-clear and manual clear controls beside its live status");
const subagentCancelDialogHtml = html.match(/<dialog id="subagentCancelDialog"[\s\S]*?<\/dialog>/)?.[0] || "";
assert.match(subagentCancelDialogHtml, /id="subagentCancelDialogTitle">Cancel subagent<[\s\S]*id="subagentCancelDialogSubtitle"/, "subagent cancellation should use a titled dialog with dynamic target context");
assert.match(subagentCancelDialogHtml, /<select id="subagentCancelReason">[\s\S]*<option value="" selected>No reason<\/option>[\s\S]*Wrong model\/provider\/thinking effort[\s\S]*Wrong agent or task[\s\S]*Taking too long[\s\S]*Wrong approach or direction[\s\S]*Output no longer needed[\s\S]*Started by mistake[\s\S]*<option value="Other">Other<\/option>/, "subagent cancellation should offer every approved optional reason");
assert.match(subagentCancelDialogHtml, /<textarea id="subagentCancelNote"[^>]*placeholder="Optional note for the parent agent"/, "subagent cancellation should offer the optional parent note field");
assert.doesNotMatch(subagentCancelDialogHtml, /<(?:select|textarea) id="subagentCancel(?:Reason|Note)"[^>]*\brequired\b/, "subagent cancellation reason and note must remain optional");
assert.match(subagentCancelDialogHtml, /id="subagentCancelSubmitButton" class="danger" type="submit">Cancel subagent<\/button>[\s\S]*id="subagentCancelKeepRunningButton"|id="subagentCancelKeepRunningButton"[\s\S]*id="subagentCancelSubmitButton" class="danger" type="submit">Cancel subagent/, "subagent cancellation should expose danger submit and keep-running controls");
assert.match(html, /id="subagentTerminalView"[\s\S]*id="subagentTerminalCancelButton" class="danger"[^>]*hidden>Cancel…<\/button>/, "subagent terminal headers should include a hidden-until-running cancel control");
assert.match(html, /id="subagentLaunchSlots"[\s\S]*id="subagentLaunchSlotsTitle">Agent models<[\s\S]*id="subagentLaunchSlotScope"[\s\S]*<option value="user">User default<\/option>[\s\S]*<option value="project">This project<\/option>[\s\S]*id="subagentLaunchSlotRoles"[\s\S]*id="subagentLaunchSlotsSave"[\s\S]*Save agent models[\s\S]*id="subagentLaunchSlotsReload"[\s\S]*Reload active tab/, "Subagents should expose a separate scoped Agent models editor before the live monitor");
assert.match(html, /id="subagentLaunchSlotsInherit"[^>]*hidden[^>]*>Use user defaults<\/button>/, "project launch-slot overrides should expose an explicit inheritance reset");
assert.match(html, /id="subagentLaunchSlotScope"[^>]*aria-describedby="subagentLaunchSlotScopeStatus"/, "scope selection should use stable scope help rather than dynamic live status as its accessible description");
assert.match(html, /id="subagentLaunchSlotsAnnouncer"[^>]*aria-live="polite"[^>]*aria-atomic="true"/, "launch-slot additions and removals should have a dedicated live announcement");
assert.match(css, /\.subagent-launch-slots-reload-actions span \{\s*flex: 1 1 auto;\s*min-width: min\(12rem, 100%\);/, "narrow launch-slot reload prompts should size from their content instead of reserving a tall fixed flex basis");
assert.match(html, /id="subagentTerminalView"[\s\S]*Subagent · view only[\s\S]*id="subagentTerminalTranscript"[\s\S]*id="subagentTerminalStatus"[^>]*aria-live="off"[\s\S]*id="subagentTerminalInput"[^>]*placeholder="View only — send messages from the parent terminal"[^>]*disabled[\s\S]*Use its parent terminal to interact with the run/, "dedicated subagent tabs should expose a view-only transcript, non-announcing routine status, and disabled input");
const subagentTerminalCardsHtml = html.match(/<footer id="subagentTerminalCards"[\s\S]*?<\/footer>/)?.[0] || "";
assert.match(subagentTerminalCardsHtml, /^<footer id="subagentTerminalCards"[^>]*class="subagent-terminal-cards"[^>]*aria-label="Subagent session telemetry"[^>]*>[\s\S]*<dl class="subagent-terminal-card-list">/, "dedicated subagent telemetry should use a labelled footer and definition list");
const subagentTerminalCards = [
  ["pi", "subagentTerminalCardPi", "PI", "—"],
  ["speed", "subagentTerminalCardSpeed", "Speed", "—"],
  ["context", "subagentTerminalCardContext", "Context", "—"],
  ["model", "subagentTerminalCardModel", "Model", "unknown"],
  ["effort", "subagentTerminalCardEffort", "Effort", "unknown"],
  ["tokens", "subagentTerminalCardTokens", "Tokens", "—"],
];
assert.equal((subagentTerminalCardsHtml.match(/\bdata-subagent-card=/g) || []).length, 6, "dedicated subagent telemetry should retain exactly six card slots");
for (const [slot, id, label, fallback] of subagentTerminalCards) {
  assert.equal((subagentTerminalCardsHtml.match(new RegExp(`data-subagent-card="${slot}"`, "g")) || []).length, 1, `${slot} telemetry card should have one stable slot`);
  assert.match(subagentTerminalCardsHtml, new RegExp(`<div[^>]*data-subagent-card="${slot}"[^>]*>[\\s\\S]*?<dt[^>]*>${label}<\\/dt>[\\s\\S]*?<dd id="${id}"[^>]*>${fallback}<\\/dd>`), `${slot} telemetry card should expose a labelled definition with an honest initial fallback`);
}
assert.match(subagentTerminalCardsHtml, /data-subagent-card="tokens"[^>]*title="[^"]*bounded recent child-session scan/, "token totals should disclose their bounded recent-session scope");
const subagentTerminalTelemetryNumberSource = appFunctionSource("subagentTerminalTelemetryNumber", "formatSubagentTerminalTelemetryTokens");
const formatSubagentTerminalTelemetryTokensSource = appFunctionSource("formatSubagentTerminalTelemetryTokens", "formatSubagentTerminalTelemetryText");
const formatSubagentTerminalTelemetryTextSource = appFunctionSource("formatSubagentTerminalTelemetryText", "renderSubagentTerminalCards");
const renderSubagentTerminalCardsSource = appFunctionSource("renderSubagentTerminalCards", "renderSubagentTerminalView");
assert.match(renderSubagentTerminalCardsSource, /agent\?\.telemetry/, "terminal telemetry cards should consume the normalized telemetry object");
assert.doesNotMatch(renderSubagentTerminalCardsSource, /\b(?:transcript|recentOutput|messages|content)\b/i, "terminal telemetry cards must not derive metrics from transcript output");
const telemetryCardElements = Object.fromEntries(subagentTerminalCards.map(([, id]) => [id, { textContent: "" }]));
vm.runInNewContext(`${subagentTerminalTelemetryNumberSource}\n${formatSubagentTerminalTelemetryTokensSource}\n${formatSubagentTerminalTelemetryTextSource}\n${renderSubagentTerminalCardsSource}\nrenderSubagentTerminalCards({ telemetry: [] });`, {
  elements: telemetryCardElements,
  formatFooterTokenCount: (value) => String(value),
});
assert.deepEqual(Object.fromEntries(Object.entries(telemetryCardElements).map(([id, element]) => [id, element.textContent])), {
  subagentTerminalCardPi: "—",
  subagentTerminalCardSpeed: "—",
  subagentTerminalCardContext: "— / unknown",
  subagentTerminalCardModel: "unknown",
  subagentTerminalCardEffort: "unknown",
  subagentTerminalCardTokens: "↑— · ↓—",
}, "missing or invalid telemetry should keep every card visible with explicit unknown fallbacks");
vm.runInNewContext(`${subagentTerminalTelemetryNumberSource}\n${formatSubagentTerminalTelemetryTokensSource}\n${formatSubagentTerminalTelemetryTextSource}\n${renderSubagentTerminalCardsSource}\nrenderSubagentTerminalCards({ telemetry: { promptInjectionTokens: 1200, tokenSpeed: 42.5, contextTokens: 1234, contextWindow: 9999, model: "provider/model", effort: "high", inputTokens: 12, outputTokens: 34 } });`, {
  elements: telemetryCardElements,
  formatFooterTokenCount: (value) => String(value),
});
assert.deepEqual(Object.fromEntries(Object.entries(telemetryCardElements).map(([id, element]) => [id, element.textContent])), {
  subagentTerminalCardPi: "1200",
  subagentTerminalCardSpeed: "42.5 tok/s",
  subagentTerminalCardContext: "1234 / 9999",
  subagentTerminalCardModel: "provider/model",
  subagentTerminalCardEffort: "high",
  subagentTerminalCardTokens: "↑12 · ↓34",
}, "terminal telemetry cards should render only normalized telemetry values");
assert.match(css, /\.subagent-terminal-card-list\s*\{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(/, "telemetry cards should wrap responsively through a grid rather than require a fixed row");
assert.match(css, /@media\s*\([^)]*max-width[^)]*\)\s*\{[\s\S]*?\.subagent-terminal-card-list\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/, "narrow viewports should collapse telemetry cards without horizontal overflow");
assert.match(technical, /exactly six telemetry cards: PI, measured token speed, context, model, effort, and input\/output tokens from a bounded recent session scan[\s\S]*Unavailable or legacy evidence remains `—` or `unknown` rather than being estimated/, "technical reference should document each subagent telemetry card, bounded scan scope, and honest unknown behavior");
assert.doesNotMatch(html, /id="subagentOverlayDialog"/, "subagent output should not use a blocking modal dialog");
assert.match(html, /data-side-panel-section="session"[\s\S]*data-side-panel-section="subagents"[\s\S]*data-side-panel-section="queue"/, "Subagents should appear between Session and Queue in the side panel");
assert.match(html, /data-side-panel-section="sampling"[\s\S]*class="side-panel-section-label">Sampling parameters<\/span>[\s\S]*id="samplingParametersSupport"[\s\S]*id="samplingParametersControls"[\s\S]*id="samplingParametersPreserved"[\s\S]*id="applySamplingParametersButton"[\s\S]*id="resetSamplingParametersButton"[\s\S]*id="samplingParametersStatus"/, "Sampling parameters should be a labelled side-panel section with native controls, hidden-key preservation status, apply/reset actions, and live status");
assert.match(app, /sampling: \["Sampling parameters", \["sidePanelSectionSampling"\]\]/, "mobile More settings should reuse the canonical native sampling controls");
assert.doesNotMatch(html, /id="samplingParametersInput"|Session override \(JSON object\)/, "mobile reuse should not expose the removed raw JSON editor");
assert.match(css, /\.sampling-parameters \{[\s\S]*container: sampling-parameters \/ inline-size;[\s\S]*@container sampling-parameters \(max-width: 22rem\)[\s\S]*\.sampling-parameter-editor,[\s\S]*grid-template-columns: minmax\(0, 1fr\)/, "native sampling controls should collapse to one column in narrow side-panel/mobile hosts");
assert.match(html, /data-side-panel-section="queue"[\s\S]*id="createPromptListButton"[\s\S]*>Create prompt list<\/button>/, "Queue section should expose prompt-list creation");
assert.match(html, /id="loadPromptListButton"[\s\S]*>Load List<\/button>[\s\S]*id="runLoadedPromptListButton"[^>]*disabled[^>]*>Run<\/button>/, "Queue section should expose load and run controls for saved prompt lists");
assert.match(html, /id="promptListDialog"[\s\S]*id="promptListAddPromptButton"[\s\S]*\+ Add follow-up prompt/, "prompt-list dialog should add follow-up prompt rows");
assert.match(html, /id="promptListLoadSelectedButton"[\s\S]*>Load selected<\/button>[\s\S]*id="promptListDeleteSelectedButton"[^>]*class="danger"[\s\S]*>Delete<\/button>/, "prompt-list dialog should delete saved lists from the load panel");
assert.match(html, /id="promptListSaveButton"[\s\S]*>Save<\/button>[\s\S]*id="promptListRunListButton"[\s\S]*>Run List<\/button>/, "prompt-list dialog should save and run the displayed list");
assert.match(html, /id="serverOfflinePanel"/, "PWA/offline shell should expose a backend-offline recovery panel");
assert.match(html, /id="serverRestartPanel"[\s\S]*id="serverRestartMessage"/, "server restart should expose a loading overlay instead of the generic offline shell");
assert.match(html, /id="copyServerCommandButton"/, "backend-offline recovery panel should expose a start-command copy button");
assert.match(html, /id="retryServerConnectionButton"/, "backend-offline recovery panel should expose a retry button");
assert.match(html, /data-side-panel-section="controls"/, "side panel controls should live in a collapsible section");
assert.match(html, /data-side-panel-section="commands"/, "side panel commands should live in a collapsible section");
assert.match(html, /class="side-panel-section-toggle"[^>]*aria-controls="sidePanelSectionControls"/, "side panel section toggles should target their content panels");
assert.match(html, /class="side-panel-section-label">Events<\/span>/, "side panel events should expose a section toggle label");
assert.match(app, /function addEvent\(message, level = "info", \{ toolCallId = "", toolEventPhase = "", details = \[\], notify = true,[\s\S]*?make\("button", `event \$\{level\}`[\s\S]*?chatEventTimestamp[\s\S]*?jumpToChatEvent\(line\)/, "event log entries should be keyboard-accessible controls that navigate into the chat");
assert.match(app, /function chatEventTargetForLine\(line\)[\s\S]*?chatToolCallId[\s\S]*?data-tool-call-id[\s\S]*?\.message\[data-chat-timestamp\]/, "event navigation should prefer exact tool cards and otherwise match the closest chat timestamp");
assert.match(app, /function jumpToChatEvent\(line\)[\s\S]*?setChatScrollTopInstant[\s\S]*?highlightChatEventTarget[\s\S]*?setSidePanelCollapsed\(true, \{ persist: false \}\)/, "event navigation should dismiss overlay sidebars, scroll the chat, and highlight its target");
assert.match(app, /function applyChatEventMetadata\(bubble, message\)[\s\S]*?bubble\.dataset\.chatTimestamp/, "rendered chat events should expose timestamps for sidebar navigation");
assert.match(app, /case "tool_execution_start":[\s\S]*?addEvent\(\.\.\.toolLifecycleEventArguments\(event, "start"\)\)/, "tool start events should retain exact tool-card navigation while adding bounded lifecycle details");
assert.match(css, /\.event:hover,[\s\S]*?\.message\.chat-event-target[\s\S]*?@keyframes chat-event-target-pulse/, "clickable events and highlighted chat targets should have visible interaction states");
const sidePanelToggleStates = Array.from(
  html.matchAll(/class="side-panel-section-toggle"[^>]*aria-expanded="([^"]+)"/g),
  (match) => match[1],
);
assert.ok(sidePanelToggleStates.length >= 7, "side panel should expose section toggle states");
assert.deepEqual([...new Set(sidePanelToggleStates)], ["false"], "side-panel sections should start collapsed by default");
assert.equal(
  (html.match(/<section class="side-panel-section collapsed" data-side-panel-section=/g) || []).length,
  sidePanelToggleStates.length,
  "side-panel sections should render with the collapsed class by default",
);
assert.equal(
  (html.match(/class="side-panel-section-content" hidden/g) || []).length,
  sidePanelToggleStates.length,
  "side-panel section panels should be hidden by default",
);
assert.match(html, /id="jumpToLatestButton"/, "chat should expose a jump-to-latest control for non-forced streaming");
assert.match(
  html,
  /<div class="main-output-surface">[\s\S]*?<div id="chat"[\s\S]*?<\/div>\s*<button id="jumpToLatestButton"[\s\S]*?<\/button>\s*<\/div>\s*<div id="runIndicatorHost"/,
  "jump-to-latest should overlay the output surface above the separate run indicator",
);
assert.match(
  css,
  /\.jump-to-latest-button \{[\s\S]*?position: absolute;[\s\S]*?z-index: 14;[\s\S]*?bottom: 0\.75rem;[\s\S]*?left: 50%;[\s\S]*?transform: translateX\(-50%\);/,
  "jump-to-latest should stay centered in the top overlay layer without taking a layout row",
);
assert.match(
  css,
  /\.jump-to-latest-button:hover \{[\s\S]*?transform: translateX\(-50%\) translateY\(-1px\);[\s\S]*?\.jump-to-latest-button:active \{[\s\S]*?transform: translateX\(-50%\) translateY\(0\);/,
  "jump-to-latest hover and press feedback should preserve horizontal centering",
);
assert.doesNotMatch(css, /terminal-tabs-left \.jump-to-latest-button \{ grid-row:/, "sidebar terminal layout should not assign the overlay its own row");
assert.match(html, /id="stickyUserPromptButton"/, "chat should expose a fixed last-user-prompt jump control");
assert.match(html, /id="feedbackTray"/, "chat should expose a queued action-feedback tray");
assert.match(html, /id="sendFeedbackButton"/, "action feedback should be submittable after the agent finishes");
assert.match(html, /<textarea id="promptInput"[^>]*rows="1"[^>]*enterkeyhint="enter"/, "prompt textarea should start at one row and hint that Return inserts a newline");
assert.ok(html.includes('id="commandSuggest"') && html.indexOf('id="commandSuggest"') < html.indexOf('id="promptInput"'), "slash-command and @ path suggestions should render above the prompt input");
assert.match(html, /id="busyPromptBehaviorTag"[\s\S]*class="composer-busy-mode-tag"[\s\S]*aria-controls="busyPromptBehaviorMenu"/, "composer should expose a clickable busy prompt behavior tag on the input frame");
assert.doesNotMatch(html, /Busy send:/i, "busy prompt behavior tag should show only the current mode label");
assert.match(html, /id="sessionSkillTags" class="composer-skill-tags"[\s\S]*hidden/, "composer should expose a hidden-until-used skill tag strip beside the busy mode tag");
assert.match(html, /<button id="featureCategoryTag" class="composer-feature-category-tag"[^>]*type="button"[^>]*aria-haspopup="dialog"[^>]*aria-controls="featureDecisionDialog"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*disabled hidden><\/button>/, "composer should expose a hidden-until-used accessible feature category button");
assert.match(html, /id="skillEditorDialog"[\s\S]*id="skillEditorText"[\s\S]*id="skillEditorSaveButton"/, "skill tags should have an in-Web UI SKILL.md editing dialog");
assert.match(html, /id="busyPromptBehaviorMenu"[\s\S]*data-busy-prompt-behavior="followUp"[\s\S]*data-busy-prompt-behavior="steer"/, "busy prompt behavior dropdown should expose follow-up and steer choices");
assert.match(app, /const LONG_INPUT_ATTACHMENT_LINE_THRESHOLD = 20/, "long composer text should use a 20-line threshold before becoming an attachment");
assert.match(app, /function attachLongTextAsFile\(text, source = "input text"\)/, "long composer text should be attachable as a generated text file");
assert.match(app, /function handleAttachmentPaste\(event\)[\s\S]*attachLongTextAsFile\(text, "clipboard text"\)/, "long pasted text should be attached instead of inserted into the prompt textarea");
assert.doesNotMatch(app, /moveLongPromptInputToAttachment/, "typed composer text must stay editable inline; only pasted text becomes an attachment");
assert.match(html, /id="attachmentTextDialog"[\s\S]*id="attachmentTextEditor"/, "text attachments should have an in-Web UI editing dialog");
assert.match(app, /attachment-edit-button[\s\S]*openTextAttachmentEditor\(attachment\.id\)/, "editable text attachments should expose an Edit action in the tray");
assert.match(app, /function saveTextAttachmentEdit\(\)[\s\S]*attachment\.file = nextFile/, "text attachment dialog should save edits back to the attachment file");
assert.match(app, /attachmentTextDialog\?\.addEventListener\("keydown"[\s\S]*event\.key\.toLowerCase\(\) !== "s"[\s\S]*saveTextAttachmentEdit\(\)/, "text attachment dialog should save with Ctrl+S or Cmd+S");
assert.match(css, /\.attachment-text-dialog[\s\S]*\.attachment-text-editor/, "text attachment editor should have dedicated dialog styling");
assert.match(html, /id="composerActionsButton"/, "mobile composer should expose a compact actions trigger");
assert.match(html, /id="composerActionsPanel"/, "secondary composer controls should live in a mobile actions panel");
assert.match(html, /<div class="composer-row" data-visibility-region="composer">[\s\S]*id="abortButton"[\s\S]*id="btwButton"[\s\S]*id="sendButton"/, "Abort and /btw should live in the bottom composer row beside Send");
assert.match(html, /id="btwButton"[\s\S]*class="composer-icon-button composer-btw-button"[\s\S]*?<svg class="composer-icon"/, "composer should expose an icon-only /btw side-question button");
assert.doesNotMatch(html, /id="btwButton"[\s\S]*?<span>\/btw<\/span>[\s\S]*?id="sendButton"/, "/btw composer button should not show a text label");
assert.match(html, /id="abortButton"[^>]*Hold Esc or the Abort button for 3 seconds/, "Abort should advertise guarded Esc and long-press affordances");
assert.doesNotMatch(html, /class="side-panel-controls"[\s\S]*id="abortButton"/, "Abort should not be buried in the side-panel controls");
assert.match(html, /id="publishButton"[\s\S]*?aria-controls="publishMenu"/, "composer should expose a Publish workflow menu button");
assert.match(html, /id="releaseNpmButton"[^>]*data-command="\/release-npm"[\s\S]*?<span>NPM Release<\/span>/, "Publish menu should include the npm release workflow by label");
assert.match(html, /id="releaseAurButton"[^>]*data-command="\/release-aur"[\s\S]*?<span>AUR Release<\/span>/, "Publish menu should include the AUR release workflow by label");
assert.match(html, /id="nativeCommandMenuButton"[\s\S]*?aria-controls="nativeCommandMenu"/, "composer should expose a /skills and /tools command menu button");
assert.ok(html.indexOf('id="publishButton"') < html.indexOf('id="nativeCommandMenuButton"'), "skills/tools command menu should render immediately after the Publish workflow button");
assert.match(html, /id="nativeSkillsButton"[^>]*data-command="\/skills"[\s\S]*?<span>Skills Setup<\/span>/, "skills/tools command menu should include Skills Setup");
assert.match(html, /id="nativeToolsButton"[^>]*data-command="\/tools"[\s\S]*?<span>Tools Setup<\/span>/, "skills/tools command menu should include Tools Setup");
assert.match(html, /id="appRunnerInfoButton"[\s\S]*?aria-controls="appRunnerInfoDialog"/, "detected app-runner controls should expose an explanation popup button");
assert.match(html, /id="appRunnerMenuButton"[\s\S]*?aria-controls="appRunnerMenuPanel"/, "composer should expose a detected app-runner dropdown button");
for (const menuId of ["publishMenu", "nativeCommandMenu", "optionsMenu", "appRunnerMenuPanel"]) {
  assert.match(html, new RegExp(`id="${menuId}"[^>]*class="[^"]*composer-auto-height-menu-panel`), `${menuId} should opt into content-height sizing without internal scrolling`);
}
assert.ok(html.indexOf('id="optionsMenuButton"') < html.indexOf('id="appRunnerMenuButton"'), "app-runner dropdown should render to the right of the settings/options button");
assert.match(html, /id="optionsRemoteButton"[^>]*data-command="\/remote"[^>]*hidden[\s\S]*?<span>Open Remote<\/span>/, "Options menu should include the Remote WebUI launcher by label");
const optionsRemoteIndex = html.indexOf('id="optionsRemoteButton"');
const optionsReloadIndex = html.indexOf('id="optionsReloadButton"');
const optionsNameIndex = html.indexOf('id="optionsNameButton"');
assert.ok(
  Math.min(optionsReloadIndex, optionsNameIndex) < optionsRemoteIndex && optionsRemoteIndex < Math.max(optionsReloadIndex, optionsNameIndex),
  "Open Remote should render between Reload Pi and Name Session",
);
assert.match(html, /id="optionsConversationModeButton"[^>]*data-command="\/talk"[^>]*hidden[\s\S]*?<span>Start Natural Conversation<\/span>/, "Options menu should include the feature-gated Natural Conversation toggle");
assert.match(html, /id="conversationModeChip" class="composer-conversation-mode-chip"[\s\S]*hidden>Voice: off<\/button>/, "composer should expose a hidden-until-active conversation status chip");
const workflowModeButtonHtml = html.match(/<button\s+id="workflowModeButton"[\s\S]*?<\/button>/)?.[0] || "";
const workflowOverlayOpenButtonHtml = html.match(/<button\s+id="workflowOverlayOpenButton"[\s\S]*?<\/button>/)?.[0] || "";
const optionsMenuHtml = html.match(/<div id="optionsMenu"[\s\S]*?<\/div>/)?.[0] || "";
assert.match(html, /id="commandSuggest"[\s\S]*?<div class="composer-input-row" data-visibility-region="inputframe">\s*<div id="workflowModeControls" class="composer-workflow-mode-dock" role="group" aria-label="Workflow Mode controls" data-visibility-key="input\.workflow"[\s\S]*id="workflowOverlayOpenButton"[\s\S]*aria-controls="widgetArea"[\s\S]*id="workflowModeButton"[\s\S]*?<\/div>\s*<div class="composer-context-tags">/, "Workflow Mode should remain directly accessible as an isolated icon-only overlay inside the prompt frame");
assert.doesNotMatch(html, /composer-workflow-mode-dock-label|>Workflow mode<\/span>/, "Workflow Mode dock should not render visible text beside the icon");
assert.doesNotMatch(optionsMenuHtml, /id="workflowModeButton"|Workflow Mode/, "Options menu should not duplicate or hide the directly accessible Workflow Mode control");
assert.doesNotMatch(workflowOverlayOpenButtonHtml, /\stitle=/, "Workflow overlay restore should not combine a browser-native tooltip with its styled tooltip");
assert.match(workflowModeButtonHtml, /class="composer-icon-button composer-workflow-mode-button"[\s\S]*aria-label="Enable Workflow Mode"[\s\S]*aria-pressed="false"[\s\S]*hidden[\s\S]*<svg class="composer-icon"[\s\S]*aria-hidden="true"/, "composer actions should expose a capability-gated, accessible Workflow Mode icon toggle");
assert.doesNotMatch(workflowModeButtonHtml, /<span>Workflow<\/span>/, "Workflow Mode should use the shared icon treatment instead of a text label");
assert.match(workflowModeButtonHtml, /data-tooltip="Workflow Mode:/, "Workflow Mode should retain its styled tooltip");
assert.doesNotMatch(workflowModeButtonHtml, /\stitle=/, "Workflow Mode should not also expose a browser-native tooltip");
assert.match(html, /id="workflowModeChip" class="composer-workflow-mode-chip"[\s\S]*hidden>Workflow: on<\/button>/, "composer should expose a hidden-until-active Workflow Mode chip");
assert.match(html, /id="conversationModeEndButton" class="composer-conversation-end-button"[\s\S]*hidden>End conversation<\/button>/, "composer should expose a persistent End conversation button while active");
assert.match(html, /id="conversationVoiceMenu" class="composer-publish-menu composer-conversation-voice-menu"[^>]*hidden>[\s\S]*id="conversationVoiceButton"[\s\S]*id="conversationVoiceMenuPanel" class="composer-publish-menu-panel[\s\S]*id="conversationModeEndButton"/, "composer should expose the conversation voice menu (publish-menu pattern) next to the End conversation button");
assert.match(app, /conversationVoiceMenuPanel: \$\("#conversationVoiceMenuPanel"\)/, "frontend should register the conversation voice menu panel");
assert.match(app, /\/api\/conversation-voices/, "frontend should load the Piper voice list from the server");
assert.match(app, /\/api\/conversation-voice"/, "frontend should switch voices through the conversation-voice endpoint");
assert.match(app, /void switchConversationVoice\(voice\.id\);/, "voice menu item clicks should trigger the voice switch");
assert.match(app, /elements\.conversationVoiceButton\?\.addEventListener\("click", \(\) => \{\n\s*setConversationVoiceMenuOpen\(!conversationVoiceMenuOpen\);/, "voice menu must open on click like the Common-Pi-options menu (touch devices have no hover)");
assert.match(app, /\{ menu: elements\.conversationVoiceMenu, button: elements\.conversationVoiceButton, panel: elements\.conversationVoiceMenuPanel \}/, "voice menu should participate in mobile dropdown height bounding");
assert.match(app, /function conversationVoiceLanguageLabel\(voiceId\)/, "voice labels should include a compact DE/EN language indicator");
assert.match(app, /function conversationVoiceGenderLabel\(voiceId\)/, "voice labels should include a compact M/F gender indicator");
assert.match(app, /\$\{label\} ↓\$\{conversationVoiceDownloadSizeText\(voice\)\}/, "voices that are not downloaded yet should use compact labels with a download marker and size");
assert.match(app, /showConversationVoiceFeedback/, "voice selection and download should surface explicit user feedback");
assert.match(app, /event\.stopPropagation\(\);\n\s*void switchConversationVoice\(voice\.id\);/, "voice menu item clicks should not be swallowed by surrounding dropdown handlers");
assert.match(app, /downloading\|testing/, "voice-switch progress from the package status text should surface on the conversation chip");
assert.match(app, /function nativeConversationAudioEngaged\(\)[\s\S]*widgets\.has\("natural-conversation-audio"\)/, "frontend should detect the package's native audio loop via its widget");
assert.match(app, /mode\.enabled === true && !!activeTabId && !nativeConversationAudioEngaged\(\)/, "browser Web Speech loop must stand down while native audio is armed (no double voices)");
assert.match(html, /id="appRunnerMenuPanel"[^>]*aria-label="Detected app runners"/, "app-runner dropdown should render detected runner choices only from JS data");
assert.match(html, /id="appRunnerInfoDialog"[\s\S]*id="appRunnerInfoBody"/, "app-runner explanation popup should have a dynamic details body");
assert.match(app, /\.pi-webui-runners\.json/, "app-runner popup should explain the project-local custom runner config file");
assert.match(app, /appRunnerCustomPathInput[\s\S]*Browse/, "custom app-runner path should be browseable from the popup");
assert.match(server, /APP_RUNNER_CONFIG_FILE = "\.pi-webui-runners\.json"/, "server should use a project-local custom app-runner config file");
assert.match(server, /\/api\/app-runner-config/, "server should expose custom app-runner config endpoints");
assert.match(server, /\/api\/app-runner-files/, "server should expose project-scoped file browsing for custom runner paths");
assert.match(app, /function renderAppRunnerSearchPathSection\(\)[\s\S]*Project discovery paths/, "app-runner popup should offer a project discovery paths section");
assert.match(app, /body\.append\(current, renderAppRunnerSearchPathSection\(\), renderAppRunnerCustomSection\(\)/, "project discovery paths should render above custom project runners");
assert.match(app, /function renderAppRunnerSearchPathSection\(\)[\s\S]*relative to the project root[\s\S]*one level deep only \(no subdirectories\)[\s\S]*\.sh, \.bash, \.zsh, \.fish, and \.py[\s\S]*Python shebang[\s\S]*uv and\/or python3\/python/, "discovery-path copy should state project scope, non-recursive scanning, and supported shell/Python runtimes");
assert.match(app, /async function saveAppRunnerSearchPaths\(searchPaths[\s\S]*api\("\/api\/app-runner-config", \{ method: "POST", body: \{ searchPaths \}[\s\S]*setAppRunnerData\(tabContext\.tabId, response\.data \|\| \{\}\)[\s\S]*renderAppRunnerControls\(\)/, "discovery paths should be saved through the app-runner config endpoint and refresh runner data immediately");
assert.match(app, /async function addAppRunnerSearchPath\(container\)[\s\S]*already configured[\s\S]*APP_RUNNER_SEARCH_PATH_LIMIT/, "adding a discovery path should reject duplicates and respect the configured path limit");
assert.match(app, /async function removeAppRunnerSearchPath\(searchPath\)[\s\S]*offerUndo\(\{/, "removing a discovery path should stay undoable like other app-runner config edits");
assert.match(app, /async function loadAppRunnerDirectoryBrowser\(relativePath = ""\)[\s\S]*\/api\/app-runner-files\?path=/, "discovery paths should be browseable through the project-scoped file browser endpoint");
assert.match(app, /function renderAppRunnerDirectoryBrowser\(\)[\s\S]*Use this directory[\s\S]*chooseAppRunnerSearchPath/, "the discovery-path browser should let users pick the browsed directory");
assert.match(app, /appRunnerSearchPathInput[\s\S]*setAttribute\("aria-label", "Project-relative directory to scan for shell and Python scripts"\)/, "the discovery-path input should expose an accessible label for every supported script category");
assert.match(app, /elements\.appRunnerInfoButton\.hidden = false;\n\s+elements\.appRunnerInfoButton\.disabled = false;/, "app-runner configuration should stay reachable when no runner is detected");
assert.match(app, /function appRunnerSourceLabel\(runner = \{\}, displayCommand = ""\)[\s\S]*from \$\{projectFile\}/, "detected runners should disambiguate their project-relative source path");
assert.doesNotMatch(html, /<code>\/release-(?:npm|aur)<\/code>/, "Publish menu should not show slash command names as option labels");
assert.doesNotMatch(html, /data-tooltip="[^"]*\/release-(?:npm|aur)/, "Publish tooltip should not show slash command names");
assert.match(html, /id="steerButton"[\s\S]*?data-tooltip="Steer usage:/, "Steer should explain type-first usage in a tooltip");
assert.match(html, /id="followUpButton"[\s\S]*?data-tooltip="Follow-up usage:/, "Follow-up should explain type-first usage in a tooltip");
assert.match(html, /id="gitWorkflowButton"[\s\S]*?data-tooltip="Guided Git workflow:[\s\S]*Optional: create or type a PR branch worktree[\s\S]*Push normally, or push the PR worktree branch, generate\/review \/pr, and create the PR/, "Git workflow tooltip should describe the current commit-or-PR worktree flow");
assert.ok(
  html.indexOf('<main class="layout">') < html.indexOf('id="sidePanelBackdrop"') &&
    html.indexOf('id="sidePanelBackdrop"') < html.indexOf('id="sidePanel"'),
  "side-panel backdrop should live inside the layout before the panel so the panel can stack above it",
);

assert.match(css, /--visual-viewport-height:\s*100dvh/, "CSS should define a visual viewport height fallback");
assert.match(css, /color-scheme:\s*var\(--theme-color-scheme\)/, "CSS should allow JS-selected themes to update browser color-scheme");
assert.match(css, /font-size:\s*100%/, "Web UI should preserve the browser base scale for accessible typography");
assert.match(css, /--text-xs:\s*0\.75rem/, "typography tokens should define a 12 px absolute floor");
assert.doesNotMatch(css, /font-size:\s*0\.(?:[0-6]\d*|7[0-4])rem/, "interface font declarations should not fall below the 0.75rem floor");
assert.match(html, /id="undoToast"[^>]*aria-live="polite"[^>]*aria-atomic="true"[^>]*hidden/, "reversible actions should expose a non-blocking live Undo notification");
assert.match(html, /id="undoToastButton"[^>]*>Undo<\/button>/, "Undo notification should expose an explicit Undo button");
assert.match(app, /function offerUndo\([\s\S]*?timeoutMs = 10000[\s\S]*?setTimeout\(dismissUndoToast, timeoutMs\)/, "Undo offers should expire after a clear bounded interval");
assert.match(app, /async function runOfferedUndo\(\)[\s\S]*?await pending\.undo\(\)[\s\S]*?settleUndoToast/, "Undo notification should execute asynchronous reversal callbacks and report the result");
assert.match(css, /\.undo-toast\.expiring \.undo-toast-progress \{ animation: undo-toast-expire var\(--undo-timeout\) linear forwards; \}/, "Undo notification should show its remaining lifetime visually");
assert.match(app, /message: `\$\{feature\.label\} was \$\{disabled \? "disabled" : "enabled"\}\.`,[\s\S]*?undo: \(\) => setOptionalFeatureDisabled/, "optional feature toggles should offer Undo");
assert.match(app, /message: `Deleted prompt list[\s\S]*?upsertStoredPromptList\(deleted\)/, "prompt-list deletion should offer restoration instead of only confirmation");
assert.match(app, /message: `Deleted custom app runner[\s\S]*?method: "POST", body: \{ runner: restoreRunner \}/, "custom runner deletion should offer restoration");
assert.match(app, /message: `Moved \$\{sourcePath\} to \$\{nextPath\}\.`,[\s\S]*?offerMoveUndo: false/, "file moves should offer a non-recursive move-back action");
assert.match(app, /message: "Remote access is open\."[\s\S]*?remoteWebuiCommand\("close", "\/remote close"\)/, "opening remote access should offer a quick return to local-only mode");
assert.doesNotMatch(app, /dashboardAction\("Start a conversation"/, "empty starter should not duplicate the already-focused conversation composer");
assert.match(app, /function emptyStartRecentWorkspaces\(\)[\s\S]*?typeof item\?\.cwd === "string"[\s\S]*?\^\\\[object Object\\\]\$[\s\S]*?filter\(Boolean\)\.slice\(0, 4\)/, "empty starter should normalize and reject invalid recent-workspace entries");
assert.match(app, /const recent = recentWorkspaces\.length \? make\("section", "empty-start-recent"\) : null/, "empty starter should omit the recent-workspaces section when no valid entries exist");
assert.match(app, /title: "Open workspace"[\s\S]*?title: "Resume session"[\s\S]*?title: "Branch worktree"/, "empty starter should prioritize the three useful workspace and session actions");
assert.match(css, /\.empty-start-actions \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/, "empty starter should present primary actions as a balanced desktop grid");
assert.match(css, /\.empty-start-action-copy span \{[\s\S]*?font-size: var\(--text-xs\)/, "empty starter actions should explain their outcome in readable supporting text");
assert.match(css, /--background-glow-pink/, "CSS should expose theme-controlled page glow colors");
assert.match(css, /--theme-background-image:\s*none/, "CSS should expose a theme-controlled page background image variable");
assert.match(css, /var\(--theme-background-image\)/, "body background should include the selected theme background image layer");
assert.match(css, /\.background-control-row \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/, "side-panel background controls should keep the remove button beside the picker");
assert.match(css, /\.background-clear-button \{[\s\S]*?color:\s*var\(--ctp-red\)/, "background remove button should be visually destructive");
assert.match(css, /\.path-picker-create-row \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/, "cwd picker directory creation controls should sit in a responsive row");
assert.match(css, /\.path-picker-create-button:hover,[\s\S]*?var\(--ctp-blue\)/, "cwd picker create action should have a distinct hover style");
assert.match(css, /\.path-picker-search-row \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/, "cwd picker search controls should sit in a responsive row");
assert.match(css, /\.path-picker-clear-search-button:hover,[\s\S]*?var\(--ctp-mauve\)/, "cwd picker clear-search action should have a distinct hover style");
assert.match(css, /height:\s*var\(--visual-viewport-height, 100dvh\)/, "layout should consume visual viewport height");
assert.match(css, /@media \(max-width: 1050px\)[\s\S]*?\.chat-panel \{[\s\S]*?height:\s*calc\(var\(--visual-viewport-height, 100dvh\) - 2rem\);[\s\S]*?max-height:\s*calc\(var\(--visual-viewport-height, 100dvh\) - 2rem\);[\s\S]*?\.chat \{ flex-basis:\s*0; \}/, "narrow stacked layout should bound the transcript so terminal tabs and bottom controls stay visible");
assert.match(css, /@media \(max-width: 1050px\)[\s\S]*?\.side-panel-backdrop \{[\s\S]*?position:\s*fixed[\s\S]*?\.side-panel \{[\s\S]*?position:\s*fixed/, "narrow stacked layout should use the mobile-style side-panel overlay drawer");
assert.match(css, /body\.control-deck-overlay:not\(\.side-panel-collapsed\) \{ overflow:\s*hidden; \}/, "narrow side-panel overlay should prevent background page scrolling while open");
assert.match(css, /body:where\(:not\(\.control-deck-left\):not\(\.control-deck-both\)\) \.layout \{ grid-template-columns:/, "the default two-column layout rule must keep low specificity so overlay/collapsed rules win on narrow and touch viewports");
assert.match(css, /body\.control-deck-overlay:not\(\.side-panel-collapsed\) \.workspace-column \{[\s\S]*?visibility:\s*hidden;[\s\S]*?pointer-events:\s*none;/, "narrow side-panel overlay should suppress the underlying workspace so it cannot cover side-panel controls");
assert.match(css, /body\.control-deck-overlay \.side-panel-backdrop \{[\s\S]*?z-index:\s*110;/, "overlay backdrop should sit above the workspace");
assert.match(css, /@media \(max-width: 1050px\)[\s\S]*?\.side-panel \{[\s\S]*?z-index:\s*111;[\s\S]*?body\.side-panel-collapsed \.terminal-tabs-shell \{[\s\S]*?padding-right:\s*4\.85rem;[\s\S]*?\.side-panel-expand-button \{[\s\S]*?z-index:\s*120/, "narrow side-panel overlay and expand button should stay above and reserve space from terminal header controls");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*?body\.side-panel-collapsed \.terminal-tabs-shell \{ padding-right:\s*calc\(44px \+ 0\.8rem\); \}[\s\S]*?\.side-panel-expand-button \{[\s\S]*?z-index:\s*120[\s\S]*?\.side-panel-backdrop \{[\s\S]*?z-index:\s*110;[\s\S]*?\.side-panel \{[\s\S]*?z-index:\s*111;/, "mobile side-panel controls should not hide behind terminal header buttons");
assert.match(css, /button, select, input \{ min-height: 44px; \}/, "base controls should meet 44px touch-target height");
// Intent superseded: Phase 0 raises all phone/coarse composer hit areas to 44px.
assert.match(css, /\.composer-row button \{\n\s+width:\s*100%;\n\s+min-height:\s*44px/, "mobile composer buttons should retain compact layout with 44px footer hit areas");
assert.match(css, /\.composer-abort-button,\n\.composer-row button\.primary \{[\s\S]*?min-width:/, "Abort and Send should share stable bottom-row sizing");
assert.match(css, /\.composer-abort-button\.long-pressing::after[\s\S]*?animation:\s*abort-long-press-fill var\(--abort-long-press-duration, 1200ms\) linear forwards/, "Abort should expose a visible long-press progress affordance");
assert.match(css, /body\.mobile-composer-disclosure \.composer-row \{[\s\S]*?grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\)/, "mobile composer should reserve one compact row for primary run controls");
assert.match(css, /body\.mobile-composer-disclosure\.pi-run-active:not\(\.mobile-keyboard-open\) \.composer-row > #abortButton \{ order:\s*1; \}[\s\S]*?#steerButton \{ order:\s*2; \}[\s\S]*?#followUpButton \{ order:\s*3; \}[\s\S]*?\.composer-actions-button \{ order:\s*4; \}[\s\S]*?#sendButton \{ order:\s*5; \}/, "active mobile runs should keep Abort, Steer, Follow-up, More, and Send on one ordered row");
assert.match(css, /#promptInput \{[\s\S]*?min-height:\s*calc\(1\.5em \+ 1\.8rem\)/, "prompt input should default to a compact single-line height");
assert.match(css, /#promptInput \{[\s\S]*?overflow-y:\s*auto/, "prompt input should auto-grow to a bounded height and then scroll vertically");
assert.match(css, /\.composer-context-tags \{[\s\S]*?top:\s*-0\.48rem;[\s\S]*?left:\s*0\.75rem;/, "busy prompt behavior and skill tags should sit at the top-left of the input frame");
assert.match(css, /\.composer-context-tags \{[^}]*width:\s*calc\(100% - 4\.5rem\);[^}]*min-width:\s*0;[^}]*pointer-events:\s*none;/, "context tags should claim the available prompt-frame width while leaving empty overlay space clickable through to the prompt");
assert.match(css, /\.composer-busy-mode-tag,[\s\S]*?\.composer-workflow-mode-chip \{\s*pointer-events:\s*auto;/, "interactive context chips should remain clickable through the pointer-transparent full-width overlay");
assert.match(css, /\.composer-skill-tags \{[^}]*flex:\s*1 1 0;[^}]*overflow:\s*hidden;/, "skill tag strips should use the true leftover context-tag width without squeezing sibling chips");
assert.match(css, /\.composer-busy-mode-tag \{[\s\S]*?var\(--ctp-crust\)/, "busy prompt behavior tag should use an opaque base background");
assert.match(css, /\.composer-skill-tag \{[^}]*flex:\s*0 0 auto;[\s\S]*?var\(--ctp-crust\)/, "skill tags should preserve their natural chip widths inside the responsive strip");
assert.doesNotMatch(app, /SKILL_TAG_MAX_VISIBLE/, "skill tag visibility should not remain capped at a fixed count");
assert.match(app, /function fitSessionSkillTags\(\)[\s\S]*?availableWidth = container\.clientWidth[\s\S]*?maxOverflowDigits = String\(tags\.length\)\.length[\s\S]*?requiredWidth <= availableWidth \+ 0\.5/, "skill tags should fit their visible count to the measured input width with bounded overflow-chip measurements");
assert.match(app, /function installSessionSkillTagResizeHandling\(\)[\s\S]*?new ResizeObserver\(scheduleSessionSkillTagLayout\)[\s\S]*?observe\(container\.parentElement\)/, "skill tag fitting should rerun when the composer tag strip changes width");
assert.match(css, /\.composer-feature-category-tag \{[\s\S]*?var\(--ctp-crust\)[\s\S]*?\.composer-feature-category-tag\.complex-feature \{[\s\S]*?var\(--ctp-mauve\)[\s\S]*?\.composer-feature-category-tag\[hidden\]/, "feature category tags should use the existing composer-tag frame with a distinct complex state and hidden default");
assert.match(css, /button\.composer-skill-tag:hover,[\s\S]*?button\.composer-skill-tag:focus-visible/, "skill tags should be styled as clickable controls");
assert.match(css, /\.extension-dialog\.skill-editor-dialog \{[\s\S]*?--skill-editor-size:\s*min\(152rem[\s\S]*?width:\s*var\(--skill-editor-size\);[\s\S]*?height:\s*var\(--skill-editor-size\);[\s\S]*?aspect-ratio:\s*1 \/ 1/, "skill editor should use a square viewport-bounded modal layout");
assert.match(css, /\.skill-editor-dialog form \{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0/, "skill editor form should fill the square modal without forcing overflow");
assert.match(css, /\.skill-editor-text \{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*pre-wrap/, "skill editor text should wrap long lines instead of horizontal scrolling");
assert.match(html, /<textarea id="fileViewerEditor"[^>]*\bwrap="soft"/, "file viewer source mode should enable soft wrapping");
assert.match(css, /\.file-viewer-editor \{[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*pre-wrap/, "file viewer source mode should wrap long lines to the available preview width");
assert.match(css, /\.composer-busy-mode-menu \{[\s\S]*?bottom:\s*calc\(100% \+ 0\.22rem\);[\s\S]*?background:\s*var\(--ctp-crust\)/, "busy prompt behavior dropdown should expand above the tag with an opaque background");
assert.match(css, /\.sticky-user-prompt-button \{[\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\) auto/, "last-user-prompt jump control should render as a fixed transcript header");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*?\.sticky-user-prompt-button \{\n\s+grid-template-columns:\s*minmax\(0, 1fr\) auto;\n\s+min-height:\s*36px;[\s\S]*?\.sticky-user-prompt-text \{[\s\S]*?font-size:\s*var\(--text-xs\)/, "mobile last-user-prompt card should preserve compact height while respecting the text floor");
assert.match(html, /id="followUpQueueTrigger"[^>]*aria-controls="followUpQueueOverlay"[\s\S]*id="followUpQueueOverlay"[\s\S]*id="followUpQueueStatus"[^>]*aria-live="polite"/, "mobile composer should expose the accessible queued follow-up trigger and overlay");
assert.match(css, /\.follow-up-queue-overlay \{[\s\S]*bottom:\s*calc\(100% \+ 0\.42rem\)[\s\S]*var\(--visual-viewport-height, 100dvh\)[\s\S]*body\.mobile-keyboard-open \.follow-up-queue-trigger:not\(\[hidden\]\) \{ display: inline-flex; \}/, "mobile queue overlay should float above the composer, fit the visual viewport, and keep its trigger usable with the keyboard open");
assert.doesNotMatch(app, /nextQueuedFollowUpPrompt|sticky-user-follow-up-prompt|Next follow-up prompt:/, "the mobile sticky prompt control should not duplicate a queued follow-up preview");
assert.match(css, /\.message\.extension,[\s\S]*?\.message\.native/, "extension and native command output should have visible transcript styling");
assert.match(app, /const FEATURE_DECISION_OUTPUT_STATUS_KEY = "feature-decision-output";\s+const FEATURE_CATEGORY_STATUS_KEY = "feature-category";[\s\S]*const featureCategoryByTab = new Map\(\);\s+const featureDecisionOutputByTab = new Map\(\)/, "feature category and exact decision output should use separate transport keys and per-tab maps");
assert.match(app, /function normalizeFeatureCategory\(value\) \{\s+return value === "lightweight-feature" \|\| value === "complex-feature" \? value : "";/, "feature category normalization should accept only the two approved exact labels");
assert.match(app, /function normalizeFeatureDecisionKind\(value\) \{\s+return value === "feature_lightweight" \|\| value === "feature_complex" \? value : "";/, "feature decision kind normalization should accept only the two approved exact labels");
assert.match(app, /function parseFeatureDecisionPayload\(value\) \{[\s\S]*value\.length > FEATURE_DECISION_PAYLOAD_MAX_CHARS\) return null;[\s\S]*const legacyKind = normalizeFeatureDecisionKind\(value\);[\s\S]*JSON\.parse\(value\)[\s\S]*return kind && reason \? \{ kind, reason \} : null;/, "the decision payload parser should bound size, accept the legacy exact label, and otherwise fail closed on the structured payload");
assert.match(app, /function formatFeatureDecisionText\(decision\) \{[\s\S]*`Decision: \$\{featureDecisionKindLabel\(decision\.kind\)\} \(\$\{decision\.kind\}\)\\nReason: \$\{reason\}`/, "the popup should render a readable decision and reason instead of only the machine label");
assert.match(app, /function renderFeatureCategoryTag\(tabId = activeTabId\) \{[\s\S]*featureCategoryByTab\.get\(tabId\)[\s\S]*featureDecisionOutputForTab\(tabId\)[\s\S]*tag\.hidden = !category;\s+tag\.disabled = !output;\s+tag\.textContent = category/, "feature category rendering should preserve category text while enabling the active-tab popup only for matching exact output");
assert.match(app, /function handleFeatureCategoryStatus\(statusText, tabId = activeTabId\) \{[\s\S]*featureCategoryByTab\.set\(tabId, category\)[\s\S]*clearFeatureDecisionStateForTab\(tabId\)[\s\S]*tabId === activeTabId/, "feature category status should update only the addressed tab and defensively clear exact output when category clears");
assert.match(app, /case "setStatus": \{[\s\S]*statusKey === FEATURE_DECISION_OUTPUT_STATUS_KEY[\s\S]*handleFeatureDecisionOutputStatus\(request\.statusText, request\.tabId \|\| activeTabId\);[\s\S]*statusKey === FEATURE_CATEGORY_STATUS_KEY[\s\S]*handleFeatureCategoryStatus\(request\.statusText, request\.tabId \|\| activeTabId\);[\s\S]*statusEntries\.set\(statusKey, request\.statusText\)/, "feature output and category statuses should be consumed before generic footer status storage");
assert.match(app, /function setActiveTabId\(tabId, \{ remember = false \} = \{\}\) \{[\s\S]*closeFeatureDecisionDialog\(\{ restoreFocus: false \}\)[\s\S]*renderFeatureCategoryTag\(nextTabId\)[\s\S]*function syncTabMetadata\(nextTabs = \[\]\) \{[\s\S]*clearFeatureDecisionStateForTab\(tabId\)/, "tab activation and cleanup should close stale popup content, render only active-tab state, and remove closed-tab state");
assert.match(app, /function remoteWebuiQrSvg\(qrLines = \[\]\)[\s\S]*?viewBox[\s\S]*?shape-rendering[\s\S]*?crispEdges/, "remote WebUI QR popup should render terminal QR output as square SVG modules");
assert.match(app, /function showRemoteWebuiQrLoadingPopup\(message = "Opening Remote WebUI QR…"\)[\s\S]*?remote-qr-loading[\s\S]*?showModal\(\)/, "remote WebUI QR popup should show a loading state while QR generation is pending");
assert.match(app, /function handleRemoteWebuiStatus\(statusText\)[\s\S]*?opening remote webui[\s\S]*?refreshing remote qr[\s\S]*?enabling remote pin auth[\s\S]*?showRemoteWebuiQrLoadingPopup/, "remote WebUI status updates should open the QR loading popup before widget lines arrive");
assert.match(app, /case "confirm":[\s\S]*?if \(isRemoteWebuiQrPopupLoading\(\)\) closeRemoteWebuiQrPopup\(\)/, "blocking extension dialogs should close the QR loading popup before opening");
assert.match(app, /function showRemoteWebuiQrPopup\(widgetKey, lines = \[\], request = \{\}\)[\s\S]*?widgetKey !== "pi-remote-webui"[\s\S]*?openRemoteWebuiQrPopup\(lines\)/, "remote WebUI QR widget events should open the QR popup");
assert.match(app, /function mirrorRemoteWebuiWidgetToTranscript\(widgetKey, lines = \[\], request = \{\}\)[\s\S]*?widgetKey !== "pi-remote-webui"[\s\S]*?addTransientMessage\(\{ role: "extension", title: "\/remote"/, "remote WebUI QR widget events should still mirror into the active tab transcript");
assert.match(app, /if \(widgetKey === "pi-remote-webui"\) \{[\s\S]*?setWidgetForTab\(requestTabId, widgetKey, \{ \.\.\.request, widgetLines: undefined \}\);[\s\S]*?showRemoteWebuiQrPopup\(widgetKey, request\.widgetLines, request\)/, "remote WebUI QR widget events should not render in the generic widget area");
assert.doesNotMatch(app, /function renderRemoteWebuiWidget/, "remote WebUI QR should not render through the generic widget renderer");
assert.match(css, /\.message\.run-indicator-message \{[\s\S]*?border-color/, "active agent runs should render a visible transcript indicator card");
assert.match(css, /\.message-copy-button \{[\s\S]*?position:\s*absolute/, "transcript messages should expose a top-right copy button");
assert.match(css, /\.message\.has-copy-action[\s\S]*?padding-right:\s*3\.1rem/, "copy buttons should reserve space in message cards");
assert.match(css, /\.message\.action-enter \{[\s\S]*?action-card-slide-in 340ms/, "new action cards should visibly slide in from the bottom");
assert.match(css, /@keyframes action-card-slide-in \{[\s\S]*?translate3d\(0, 1\.45rem, 0\)/, "action-card entry animation should start well below the final position");
assert.match(css, /\.message\.thinking,\n\.message\.toolCall,\n\.message\.assistantEvent/, "thinking and assistant events should have non-assistant transcript card styling");
assert.doesNotMatch(css, /\.message\.thinking\.streaming\.complete[\s\S]*?content:\s*" done"/, "completed live thinking cards should not append a green DONE label");
assert.doesNotMatch(css, /\.thinking-block\.streaming-thinking\.complete[\s\S]*?content:\s*" done"/, "completed thinking details should not append a green DONE label");
assert.match(css, /\.message\.toolResult, \.message\.bashExecution, \.message\.compactionSummary/, "compaction summaries should render as compact collapsible transcript cards");
assert.match(css, /\.message\.toolExecution \{[\s\S]*?border-color/, "paired tool executions should render as distinct TUI-like action cards");
assert.match(css, /\.tool-diff \{[\s\S]*?font-family:/, "edit tool diffs should have a dedicated monospace renderer");
assert.match(css, /\.markdown-body \{[\s\S]*?line-height:/, "assistant Markdown output should have dedicated readable styling");
assert.match(css, /\.markdown-table-wrapper \{[\s\S]*?overflow-x:\s*auto/, "assistant Markdown tables should be horizontally scrollable on narrow screens");
assert.match(css, /\.tool-result-preview \{[\s\S]*?padding:/, "collapsed tool results should show a preview area by default");
assert.match(css, /\.message-collapse\[open\] \+ \.tool-result-preview \{[\s\S]*?display:\s*none/, "tool result preview should hide when full output is expanded");
assert.match(css, /\.message\.toolResult \.message-collapse\[open\] > \.message-body,[\s\S]*?\.message\.bashExecution \.message-collapse\[open\] > \.message-body,[\s\S]*?max-height:\s*min\(42rem, 62dvh\);[\s\S]*?overflow:\s*auto/, "expanded transcript tool and bash output should scroll inside their cards");
assert.match(css, /\.tool-output-details\[open\] > \.tool-output-code \{[\s\S]*?max-height:\s*min\(34rem, 52dvh\);[\s\S]*?overflow:\s*auto/, "expanded live tool output should get an internal scrollbar");
assert.match(css, /\.run-indicator-pulse \{[\s\S]*?animation:\s*run-indicator-pulse/, "active agent run indicator should have an animated pulse");
assert.match(css, /\.optional-features-box \{[\s\S]*?display:\s*grid/, "optional features should render as a side-panel feature list");
assert.match(css, /\.optional-feature-section \{[\s\S]*?display:\s*grid[\s\S]*?\.optional-feature-section-list \{[\s\S]*?display:\s*grid/, "optional features should render grouped type subsections");
assert.match(css, /\.btw-widget \{[\s\S]*?\.btw-widget-composer \{[\s\S]*?\.btw-transfer-action \{[\s\S]*?\.btw-live-widget \.release-npm-output-details\[open\] \.release-npm-terminal \{[\s\S]*?height:\s*clamp/, "/btw should render as a non-blocking release-style output widget with its own input and transfer action");
assert.match(css, /\.prompt-list-controls \{[\s\S]*?display:\s*grid/, "Queue prompt-list controls should render as a side-panel control group");
assert.match(css, /\.prompt-list-dialog \{[\s\S]*?width:\s*min\(58rem/, "prompt-list editor dialog should have a wider prompt-friendly layout");
assert.match(css, /\.prompt-list-editor-rows \{[\s\S]*?max-height:/, "prompt-list dialog should scroll long follow-up lists inside the editor");
assert.match(css, /\.prompt-list-load-row \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto auto/, "prompt-list load row should fit load and delete actions beside saved-list selection");
assert.match(css, /\.side-panel-section-toggle \{[\s\S]*?justify-content:\s*space-between/, "side panel section toggles should align labels and chevrons");
assert.match(html, /id="stateDetails" class="session-details"[^>]*aria-label="Current session details"/, "session panel should expose a dedicated accessible details container");
assert.match(app, /function sessionCopyButton\([\s\S]*?await copyText\(value\)/, "session identifiers and files should be copyable");
assert.match(app, /function splitSessionFilePath\([\s\S]*?replace\(\/\^\\\/home/, "session file display should abbreviate home directories");
assert.match(css, /\.session-overview \{[\s\S]*?grid-template-columns:/, "session status and counts should have a scannable overview");
assert.match(css, /\.session-detail-value\.truncate[\s\S]*?text-overflow:\s*ellipsis/, "long session values should not overwhelm the side panel");
assert.match(css, /\.server-restart-panel \{[\s\S]*?z-index:\s*62/, "server restart overlay should render above the offline shell");
assert.match(css, /@keyframes server-restart-spin/, "server restart overlay should show a loading spinner");
assert.match(css, /\.side-panel-version-row \{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*center[\s\S]*?flex-wrap:\s*wrap/, "Control Deck versions and build status should use a dedicated responsive row");
assert.match(css, /\.side-panel-brand-row \{[\s\S]*?display:\s*flex[\s\S]*?align-items:\s*center[\s\S]*?\.sponsor-link \{[\s\S]*?text-decoration:\s*none/, "Sponsor heart should sit inline with the Pi Web UI brand and remain visually subtle");
assert.match(css, /\.sponsor-link:hover,[\s\S]*?\.sponsor-link:focus-visible/, "Sponsor heart should expose visible hover and keyboard focus states");
assert.match(css, /\.pi-version-button,\n\.webui-version-button,\n\.webui-dev-badge \{[\s\S]*?border-radius:\s*999px/, "Pi and Web UI version buttons plus the dev indicator should render as compact title controls");
assert.match(css, /\.webui-version-button:hover,[\s\S]*?\.webui-version-button:focus-visible/, "Web UI version button should expose visible hover and keyboard focus states");
assert.match(css, /\.pi-version-button:hover,[\s\S]*?\.pi-version-button:focus-visible/, "Pi version button should expose visible hover and keyboard focus states");
assert.match(css, /\.extension-dialog\.pi-release-notes-dialog \{[\s\S]*?\.pi-release-notes-body \{[\s\S]*?overflow:\s*auto/, "Pi release notes popup should keep long notes scrollable");
assert.match(css, /\.webui-dev-badge \{[\s\S]*?color:\s*var\(--ctp-yellow\)/, "Web UI dev indicator should have distinct warning styling");
assert.match(css, /\.side-panel-section\.collapsed \.side-panel-section-content,\n\.side-panel-section-content\[hidden\] \{\n\s+display:\s*none;/, "collapsed side panel section content should be hidden");
assert.match(css, /\.side-panel-section:not\(\.collapsed\) \.side-panel-section-chevron/, "expanded side panel sections should rotate the chevron");
assert.match(css, /\.subagents-help \{[\s\S]*border-left:[\s\S]*font-size:\s*0\.7rem;[\s\S]*\.subagents-help code/, "subagent invocation guidance should render as a compact informational callout");
assert.match(css, /\.subagent-launch-slots \{[\s\S]*\.subagent-launch-slot-role \{[\s\S]*\.subagent-launch-slot-controls \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "launch-slot cards should group role slots with paired model and thinking controls");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\) \{[\s\S]*min-height: 44px[\s\S]*\.subagent-launch-slot-scope,[\s\S]*\.subagent-launch-slot-row,[\s\S]*\.subagent-launch-slot-controls \{ grid-template-columns: minmax\(0, 1fr\); \}/, "launch-slot controls should stack with coarse-pointer touch targets");
assert.match(css, /\.subagents-box\.has-items[\s\S]*\.subagent-tab-group[\s\S]*\.subagent-agent-row/, "running subagents should render as grouped terminal/session cards");
assert.match(css, /\.subagent-gate-card \{[\s\S]*gap: 0\.12rem;[\s\S]*background: transparent;[\s\S]*\.subagent-gate-title \{[\s\S]*display: flex;[\s\S]*\.subagent-gate-attempt \{[\s\S]*min-height: 1\.68rem;[\s\S]*background: transparent;[\s\S]*\.subagent-gate-attempt-identity \{[\s\S]*white-space: nowrap;/, "retry gates should use compact, flat, single-line attempt rows");
assert.match(css, /\.subagent-agent-row:hover,[\s\S]*\.subagent-agent-row:focus-visible/, "subagent rows should expose clickable hover and keyboard focus states");
assert.match(css, /\.subagent-overlay-widget[\s\S]*\.subagent-overlay-transcript[\s\S]*\.subagent-overlay-message[\s\S]*\.subagent-overlay-close-action/, "subagent output should combine the non-blocking widget shell with the main transcript message styling");
assert.match(css, /\.terminal-tab-subagent-indicator[\s\S]*\.terminal-tab-subagent[\s\S]*\.subagent-terminal-view[\s\S]*\.subagent-terminal-composer textarea:disabled/, "subagent terminal tabs should be visibly marked and retain an explicit disabled composer");
assert.match(css, /body\.subagent-terminal-active \.workspace-dashboard,[\s\S]*body\.subagent-terminal-active \.composer[\s\S]*display: none !important/, "the dedicated child view should replace parent terminal content without mutating it");
assert.match(css, /\.subagent-run-indicator[\s\S]*\.subagent-run-indicator \.run-indicator-meta/, "subagent output should reuse the main live run-indicator treatment with wrapping activity metadata");
assert.match(css, /\.subagent-terminal-transcript > \.message \{[\s\S]*width: 100%;[\s\S]*max-width: none;/, "dedicated subagent transcript cards should fill the available tab width");
assert.doesNotMatch(css, /\.extension-dialog\.subagent-overlay-dialog/, "subagent output should not retain blocking dialog styles");
assert.match(css, /\.subagent-state-dot\.running \{[\s\S]*?background: var\(--ctp-yellow\);[\s\S]*?animation: subagent-running-pulse/, "running subagents should expose a blinking yellow activity indicator");
assert.match(css, /@keyframes subagent-running-pulse/, "running subagents should expose a live activity animation");
assert.match(css, /\.optional-feature-pill\.enabled/, "optional features should visually distinguish enabled state");
assert.match(css, /\.todo-widget \{[\s\S]*?display:\s*grid/, "todo-progress widget should render as a styled checklist card");
assert.match(css, /\.todo-widget-summary \{[\s\S]*?cursor:\s*pointer/, "todo-progress widget should expose a compact expandable summary");
assert.match(css, /\.todo-widget-goal \{[\s\S]*?overflow-wrap:\s*anywhere/, "todo-progress widget should show long goals above progress without layout overflow");
assert.match(css, /\.todo-widget-body \{[\s\S]*?max-height:/, "expanded todo-progress details should be height-limited");
assert.match(css, /\.todo-widget-item\.partial \.todo-widget-marker/, "todo-progress partial items should have distinct styling");
assert.match(css, /\.todo-widget-item\.done \.todo-widget-text[\s\S]*?text-decoration:\s*line-through/, "todo-progress completed items should be visually crossed out");
assert.match(css, /\.release-npm-widget \{[\s\S]*?border-left:\s*0\.28rem solid/, "release-npm output should stand apart from the page background");
assert.match(css, /\.release-npm-stream-header \{[\s\S]*?text-transform:\s*uppercase/, "release-npm output should label the output stream clearly");
assert.match(css, /\.release-npm-output-summary \{[\s\S]*?cursor:\s*pointer/, "release-npm output should expose a local expand/collapse summary");
assert.match(css, /\.release-npm-output-details\[open\] \.release-npm-output-toggle/, "release-npm expanded output should rotate the summary chevron");
assert.match(css, /\.release-npm-output-details \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\);[\s\S]*?min-width:\s*0;/, "release output should constrain its grid track so long subprocess lines scroll inside the terminal instead of widening the widget");
assert.match(css, /\.widget-area:has\(\.release-npm-live-widget \.release-npm-output-details\[open\]\)[\s\S]*?flex:\s*0 0 min\(44rem, 68dvh\)/, "live release output should reserve a stable widget slot instead of resizing the transcript while streaming");
assert.match(css, /\.widget-area:has\(\.workflow-live-widget \.release-npm-output-details\[open\]\) \{[^}]*min-height:\s*0;[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/, "live workflow output should retain its local scroll boundary without forcing a fixed outer height");
assert.match(css, /\.widget-area:has\(\.workflow-widget:not\(\.minimized\)\) \{[^}]*--workflow-overlay-max-height:\s*min\(44rem, 68dvh\);[^}]*flex:\s*0 0 auto;[^}]*max-height:\s*var\(--workflow-overlay-max-height\);[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto/, "restored workflow widgets should follow rendered content up to a viewport-safe scroll cap while minimized-only workflow content releases that sizing rule");
assert.match(css, /\.widget-area:has\(\.workflow-widget:not\(\.minimized\)\) \{ --workflow-overlay-max-height:\s*34dvh; \}/, "mobile workflow widgets should keep the existing compact viewport cap while sizing intrinsically");
assert.match(css, /\.release-npm-live-widget \.release-npm-output-details\[open\] \.release-npm-terminal,[\s\S]*?\.release-aur-live-widget[\s\S]*?height:\s*clamp\(15rem, 42dvh, 31rem\)/, "live release terminals should keep a fixed viewport height while output streams");
assert.match(css, /\.workflow-subprocess-widget \.release-npm-output-details\[open\] \.release-npm-terminal \{[^}]*max-height:\s*clamp\(12rem, 34dvh, 26rem\);[^}]*min-height:\s*0;[^}]*overscroll-behavior-y:\s*auto;[^}]*scrollbar-gutter:\s*stable/, "workflow output should grow with real line content up to a compact local scroll cap");
assert.match(css, /\.workflow-subprocess-widget \.workflow-meta \{[\s\S]*?grid-template-columns:[\s\S]*?\.workflow-meta-label \{[\s\S]*?text-transform:\s*uppercase/, "workflow run limits and status should render as clearly labeled metadata groups");
assert.match(css, /\.release-npm-terminal \{[\s\S]*?rgba\(3, 4, 10, 0\.98\)/, "release-npm terminal should use a high-contrast stream panel");
assert.match(css, /\.release-aur-widget \{[\s\S]*?border-color/, "release-aur output should render as a specialized Web UI widget variant");
assert.match(css, /\.app-runner-widget \{[\s\S]*?border-color/, "app runner output should render as a specialized Web UI widget variant");
assert.match(css, /\.composer-app-runner-info-button \{[\s\S]*?position:\s*absolute;[\s\S]*?right:\s*-0\.48rem;[\s\S]*?flex:\s*none;[\s\S]*?pointer-events:\s*none/, "app runner info help should float over Run without consuming toolbar width");
assert.match(css, /\.composer-app-runner-menu\.has-runners:hover \.composer-app-runner-info-button,[\s\S]*?\.composer-app-runner-info-button:focus-visible \{[\s\S]*?opacity:\s*1;[\s\S]*?pointer-events:\s*auto;[\s\S]*?transform:\s*translateY\(0\) scale\(1\)/, "app runner info help should reveal without reflowing neighboring composer buttons");
assert.match(css, /\.composer-app-runner-menu\.no-runners \.composer-app-runner-info-button,/, "app runner configuration help should stay visible when no runner is detected");
assert.match(css, /\.workflow-policy-suggestions \{[\s\S]*display:\s*flex;[\s\S]*flex-wrap:\s*wrap;[\s\S]*\.workflow-policy-suggestion:focus-visible \{[\s\S]*outline:/, "workflow policy suggestion buttons should wrap and expose a visible keyboard focus state");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.workflow-policy-suggestions \{[\s\S]*flex-direction:\s*column;[\s\S]*\.workflow-policy-suggestion \{[\s\S]*width:\s*100%;[\s\S]*min-height:\s*44px;/, "workflow policy suggestions should stack into full-width touch targets on narrow screens");
assert.match(css, /\.app-runner-directory-row \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/, "discovery-path browser rows should pair navigation with a selection action");
assert.match(css, /@media \(max-width: 720px\)[\s\S]*?\.app-runner-directory-row,[\s\S]*?grid-template-columns:\s*1fr;/, "discovery-path browser rows should stack on narrow mobile widths");
assert.match(css, /\.widget-area:has\(\.app-runner-live-widget \.release-npm-output-details\[open\]\)/, "live app runner output should reserve the same fixed top widget slot as release output");
assert.match(css, /\.widget-area \.widget:not\(\.todo-widget\):not\(\.release-npm-widget\)/, "mobile widget filtering should keep release workflow output visible");
assert.match(css, /\.message\.warn \.message-role \{ color: var\(--ctp-yellow\); \}/, "warning-level command output should be visually distinct");
assert.match(css, /\.commands-box \{[\s\S]*?max-height:\s*min\(32rem, 52vh\)/, "side-panel commands should use expanded viewport-aware height");
assert.match(css, /\.command-item \{[\s\S]*?width:\s*100%/, "side-panel commands should render as full-width click targets");
assert.match(css, /\.toggle-control \{[\s\S]*?grid-template-columns:\s*auto minmax\(0, 1fr\)/, "side-panel notification toggle should align checkbox and label text");
assert.match(css, /\.toggle-control:has\(input:checked\)/, "side-panel notification toggle should style the enabled state");
assert.match(css, /\.command-item:hover,[\s\S]*?\.command-item:focus-visible/, "side-panel commands should have hover and keyboard focus affordances");
assert.match(css, /\.command-suggest \{\n\s+margin:\s*0 0 0\.5rem;[\s\S]*?max-height:\s*15rem/, "slash-command and @ path suggestions should reserve spacing below themselves above the prompt input");
assert.match(css, /\.command-suggest-item:hover \{\n\s+box-shadow: none;\n\s+transform: none;\n\}\n\.command-suggest-item\.active \{/, "autocomplete hover should not render as the selected suggestion unless JS marks it active");
assert.doesNotMatch(css, /\.command-suggest-item:hover,\n\.command-suggest-item\.active/, "autocomplete hover and active selection styles should stay separate");
assert.match(css, /\.feedback-tray\[hidden\] \{ display: none; \}/, "queued action-feedback tray should hide when empty");
assert.match(css, /\.action-feedback-controls \{[\s\S]*?position:\s*absolute/, "action reactions should be absolutely positioned so they do not expand cards");
assert.match(css, /\.action-feedback-controls \{[\s\S]*?bottom:\s*0\.48rem/, "action reactions should sit inside the message box by default");
assert.match(css, /\.action-feedback-controls \{[\s\S]*?opacity:\s*0/, "action reactions should stay hidden until hovered or focused");
assert.match(css, /\.action-feedback-controls:hover,[\s\S]*?\.action-feedback-controls:focus-within/, "action reactions should reveal on hover or keyboard focus");
assert.match(css, /\.action-feedback-controls:not\(:hover\):not\(:focus-within\) \.action-feedback-button/, "hidden action reactions should not expose button hit targets until the hover area is reached");
assert.match(css, /\.action-feedback-button\.feedback-question\.active/, "question-mark reaction should have selected styling");
assert.match(css, /\.composer-row button\[data-tooltip\]::after/, "composer-row button tooltips should be shared across Git, Steer, and Follow-up buttons");
assert.doesNotMatch(css, /\.composer-row \.composer-workflow-mode-button\[data-tooltip\]/, "isolated Workflow Mode dock should not retain composer-row pseudo-tooltip overrides");
assert.match(css, /\.composer-input-row \.composer-workflow-mode-dock button\[data-tooltip\]::before,\s*\.composer-input-row \.composer-workflow-mode-dock button\[data-tooltip\]::after \{\s*display:\s*none;/, "Workflow Mode dock controls should suppress inherited pseudo-tooltips and keep only their floating styled tooltip");
assert.match(css, /\.composer-row \.composer-git-button\[data-tooltip\]::after \{[\s\S]*?left:\s*0;[\s\S]*?right:\s*auto;/, "Git workflow tooltip should open rightward so it is not clipped off the left edge");
assert.match(css, /\.composer-row button\[data-tooltip\]\.tooltip-open::after/, "composer button tooltips should be triggerable from JS for empty mobile taps");
assert.match(css, /\.composer-row button\[data-tooltip\]:hover,[\s\S]*?\.composer-input-row button\[data-tooltip\]\.tooltip-open \{\n\s+z-index:\s*40;/, "active composer tooltip triggers should stack above context tags and adjacent controls");
assert.match(css, /\.footer-floating-tooltip \{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*1000/, "git footer extension boxes should use one viewport-positioned styled tooltip");
assert.match(css, /\.footer-floating-tooltip \{[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*pre-wrap;/, "git footer tooltips should wrap long paths instead of clipping them");
assert.doesNotMatch(css, /\.statusbar-git-footer \.footer-(?:metric|meta)\[data-tooltip\]::after/, "git footer chips should not also render a second pseudo-element tooltip");
assert.match(css, /\.composer-publish-menu:hover > \.composer-publish-button\[data-tooltip\]::before,[\s\S]*?\.composer-publish-menu\.open > \.composer-publish-button\[data-tooltip\]::after \{[\s\S]*?display:\s*none !important;[\s\S]*?opacity:\s*0 !important;/, "dropdown button tooltips should hide while publish or setup menus are open");
assert.match(css, /\.composer-publish-menu-panel \{[\s\S]*?display:\s*none;[\s\S]*?flex-direction:\s*column/, "Publish workflow menu should hide when closed and expand like grouped tabs");
assert.match(css, /\.composer-publish-menu:hover \.composer-publish-menu-panel,[\s\S]*?\.composer-publish-menu:focus-within \.composer-publish-menu-panel,[\s\S]*?\.composer-publish-menu\.open \.composer-publish-menu-panel \{\n\s+display:\s*flex;/, "Publish workflow menu should open on hover, focus, or explicit open state");
assert.match(css, /\.composer-native-command-button \{[\s\S]*?color:\s*var\(--ctp-mauve\)/, "skills/tools command menu should have a distinct slash-command button style");
assert.match(css, /\.composer-auto-height-menu-panel \{[\s\S]*?height:\s*auto;[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;[\s\S]*?overflow-y:\s*visible;/, "content-height composer menus should grow with their active commands without an internal scrollbar");
assert.match(css, /\.composer-publish-menu-panel \{[\s\S]*?overscroll-behavior:\s*contain;[\s\S]*?-webkit-overflow-scrolling:\s*touch/, "dropdown panels should default to contained momentum scrolling when their options overflow");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu \.composer-publish-menu-panel \{[\s\S]*?max-height:\s*min\(var\(--mobile-dropdown-max-height, 34dvh\), calc\(var\(--visual-viewport-height, 100dvh\) - 2rem\)\)/, "mobile composer dropdowns should default to an in-viewport scroll height");
assert.match(css, /\.composer-actions-panel > \.composer-options-menu \.composer-publish-menu-panel,\n\s+\.composer-actions-panel > \.composer-app-runner-menu \.composer-publish-menu-panel \{\n\s+inset-inline:\s*auto 0;/, "mobile Options and app-runner dropdowns should share right-aligned popover placement");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu \.composer-auto-height-menu-panel \{[\s\S]*?height:\s*auto;[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;[\s\S]*?overflow-y:\s*visible;/, "mobile content-height menus should grow with their active commands without an internal scrollbar");
assert.match(css, /\.composer-native-command-menu-item \{[\s\S]*?color:\s*var\(--ctp-mauve\)/, "skills/tools command menu items should be styled separately from publish actions");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu[\s\S]*?grid-column: span 1/, "Publish and command menu buttons should fit beside Git workflow in mobile actions");
assert.match(css, /body\.mobile-composer-disclosure \.composer-actions-panel \{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;[\s\S]*?width:\s*100vw;[\s\S]*?height:\s*var\(--visual-viewport-height, 100dvh\);[\s\S]*?max-height:\s*none;/, "mobile composer actions should open as a full-screen visual-viewport overlay");
assert.match(css, /body\.composer-actions-open \.composer-actions-panel \{ display: grid; \}/, "composer actions panel should only open when toggled");
assert.match(css, /\.terminal-tabs-toggle-button \{ display: none; \}/, "terminal tab toggle should be hidden outside mobile CSS");
assert.match(html, /id="terminalTabsDrawerContent"[^>]*aria-label="Terminal navigation"[\s\S]*class="terminal-sidebar-actions"[^>]*aria-label="Tab and workspace actions"[\s\S]*id="closeAllTabsButton"/, "mobile terminal disclosure should group canonical tabs and workspace actions in one labelled drawer");
assert.match(html, /id="terminalTabsBackdrop"[^>]*aria-label="Close terminal navigation"[^>]*hidden/, "mobile terminal drawer should expose an accessible backdrop close target");
assert.match(css, /\.command-palette-close-button \{[\s\S]*?min-width:\s*44px;[\s\S]*?min-height:\s*44px/, "command palette close button should meet touch-target sizing by default");
assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.command-palette-dialog \{[\s\S]*?width:\s*min\(100vw - 0\.5rem, 42rem\)[\s\S]*?\.command-palette-list \{[\s\S]*?align-content:\s*start;[\s\S]*?grid-auto-rows:\s*max-content;[\s\S]*?scrollbar-gutter:\s*auto;[\s\S]*?\.command-palette-item \{[\s\S]*?grid-template-columns:\s*minmax\(3\.4rem, 0\.26fr\) minmax\(0, 1fr\);[\s\S]*?min-height:\s*3rem;/, "mobile command palette results should keep text-height rows and use compact two-column cards");
assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.command-palette-item-kind \{[\s\S]*?font-size:\s*var\(--text-xs\);[\s\S]*?\.command-palette-item-label \{ font-size:\s*0\.82rem; \}[\s\S]*?\.command-palette-item-description \{ font-size:\s*var\(--text-xs\); \}/, "mobile command palette result text should respect the typography floor");
assert.match(css, /body\.terminal-tabs-left \.chat-panel \{[\s\S]*?grid-template-columns:\s*minmax\(13rem, var\(--terminal-tabs-sidebar-width\)\) minmax\(0, 1fr\)/, "terminal tabs left layout should split the chat panel into a resizable sidebar and transcript area");
assert.match(css, /body\.terminal-tabs-left \.terminal-tabs-shell \{[\s\S]*?grid-column:\s*1;[\s\S]*?grid-row:\s*1 \/ -1;[\s\S]*?flex-direction:\s*column/, "terminal tabs left layout should turn the top tab strip into a vertical sidebar");
assert.match(html, /class="terminal-sidebar-actions"[^>]*aria-label="Tab and workspace actions"[\s\S]*id="workspaceSaveButton"[^>]*aria-label="Save workspace"[\s\S]*id="commandPaletteButton"[^>]*aria-label="Open command palette"[\s\S]*id="workspaceDashboardToggleButton"[^>]*aria-label="Show workspace overview"/, "save, command, and workspace actions should share one accessibly labelled sidebar toolbar");
assert.doesNotMatch(html, /id="splitTabButton"|class="terminal-split-button"/, "the global terminal-header Split control should be removed");
assert.doesNotMatch(html, /terminal-sidebar-action-label/, "left-sidebar action buttons should be icon-only without redundant visible labels");
assert.match(css, /body\.terminal-tabs-left \.terminal-sidebar-actions \{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);[\s\S]*?body\.terminal-tabs-left \.terminal-sidebar-actions > button \{[\s\S]*?place-items:\s*center;[\s\S]*?min-height:\s*2\.75rem;[\s\S]*?padding:\s*0\.42rem;/, "left-sidebar actions should render as three compact equal-width icon buttons with 44px targets");
assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?body\.terminal-tabs-left \.terminal-sidebar-actions \{[\s\S]*?z-index:\s*130;[\s\S]*?overflow:\s*visible;[\s\S]*?terminal-workspace-save-button\[data-tooltip\]::after,[\s\S]*?terminal-command-palette-button\[data-tooltip\]::after,[\s\S]*?terminal-dashboard-button\[data-tooltip\]::after \{[\s\S]*?bottom:\s*calc\(100% \+ 0\.62rem\);[\s\S]*?z-index:\s*220;[\s\S]*?width:\s*calc\(300% \+ 0\.84rem\);/, "left-sidebar save, command, and overview tooltips should render above the full toolbar without clipping");
assert.match(css, /terminal-workspace-save-button\[data-tooltip\]::after \{\s+left:\s*0;[\s\S]*?terminal-command-palette-button\[data-tooltip\]::after \{\s+left:\s*calc\(-100% - 0\.42rem\);[\s\S]*?terminal-dashboard-button\[data-tooltip\]::after \{\s+left:\s*calc\(-200% - 0\.84rem\);/, "left-sidebar tooltips should align to the toolbar edges from their individual buttons");
assert.match(app, /function updateTerminalSplitControls\(canShowSplit[\s\S]*terminal-tab-split-button[\s\S]*setAttribute\("aria-pressed", isOpenSplit \? "true" : "false"\)[\s\S]*terminal-tab:\$\{tabId\}:split/, "per-tab Split controls should expose open or close state through accessibility text and stable tooltips");
assert.match(app, /async function splitTerminalTab\(tabId[\s\S]*tabs\.find\(\(tab\) => tab\.id === tabId\)[\s\S]*sourceTab\.cwd[\s\S]*body: \{ cwd: resolvedCwd \}/, "per-tab Split should create the independent terminal from the clicked tab's working directory");
assert.match(css, /body\.terminal-tabs-left \.terminal-close-all-button \{[\s\S]*?margin-top:\s*0;[\s\S]*?justify-content:\s*center;[\s\S]*?text-align:\s*center;/, "left-sidebar close-all action should remain a separate centered destructive row");
assert.match(css, /body\.terminal-tabs-left \.terminal-tabs \{[\s\S]*?flex-direction:\s*column/, "terminal tabs left layout should stack tabs vertically");
assert.match(css, /body\.terminal-tabs-left \.terminal-tab-group-menu \{[\s\S]*?inset:\s*0 auto auto 100%;[\s\S]*?padding-left:\s*var\(--terminal-left-dropdown-bridge\)/, "left-sidebar grouped tab menus should include a hover bridge so they do not vanish between button and dropdown");
assert.match(css, /body\.terminal-tabs-left \.terminal-new-tab-menu \.composer-publish-menu-panel \{[\s\S]*?inset:\s*0 auto auto 100%;[\s\S]*?padding-left:\s*var\(--terminal-left-dropdown-bridge\)/, "left-sidebar new-tab dropdown should include a hover bridge so it does not vanish between button and dropdown");
assert.match(css, /\.terminal-new-tab-menu \.composer-publish-menu-panel \{[\s\S]*?inset:\s*100% 0 auto auto;[\s\S]*?padding-top:\s*0\.38rem/, "new-tab dropdown should reuse the shared composer panel and open below the tab bar");
assert.match(css, /\.terminal-tabs > \.terminal-new-tab-menu:only-child \.composer-publish-menu-panel \{\s*inset:\s*100% auto auto 0;/, "zero-tab new-tab dropdown should align to the left edge instead of extending off-screen");
assert.match(css, /\.terminal-new-tab-menu \.composer-publish-menu-item \{[\s\S]*?color:\s*var\(--ctp-pink\)/, "new-tab dropdown items should reuse shared composer menu items with a tab-specific color");
assert.match(css, /\.terminal-close-all-button \{[\s\S]*?color:\s*var\(--ctp-red\)/, "close-all tabs action should render as a top-right destructive tab action");
assert.match(css, /\.terminal-tabs\.terminal-tabs-dense \{[\s\S]*?flex-wrap:\s*wrap/, "large terminal tab sets should wrap into a readable dense tab strip");
assert.match(css, /\.terminal-tab-group-close \{[\s\S]*?border-left-color/, "terminal tab groups should style their close button distinctly");
assert.match(css, /body\.mobile-tabs-expanded \.terminal-tabs-shell \{[\s\S]*?position:\s*fixed;[\s\S]*?top:\s*0;[\s\S]*?right:\s*0;[\s\S]*?left:\s*0;[\s\S]*?width:\s*100vw;[\s\S]*?height:\s*var\(--visual-viewport-height, 100dvh\);[\s\S]*?border-radius:\s*0;/, "expanded mobile terminal navigation should fill the visual viewport");
assert.match(css, /body\.mobile-tabs-expanded \.terminal-tabs-backdrop:not\(\[hidden\]\) \{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*121;[\s\S]*?backdrop-filter:\s*blur\(4px\)/, "expanded mobile terminal navigation should dim the inactive surface behind it");
assert.match(css, /body\.mobile-tabs-expanded \.terminal-tabs \{[\s\S]*?position:\s*static;[\s\S]*?flex-direction:\s*column;[\s\S]*?overflow-y:\s*auto;/, "expanded full-screen mobile terminal tabs should use the canonical vertical interaction model");
assert.match(css, /\.terminal-tab-activity-indicator/, "terminal tabs should expose per-tab agent activity indicators");
assert.match(css, /\.terminal-tab-app-runner-indicator \{[\s\S]*?terminal-tab-app-runner-pulse/, "terminal tabs should expose animated app-runner indicators");
assert.match(css, /\.terminal-tab\.app-runner-running,\n\.terminal-tab-group-item\.app-runner-running/, "terminal tabs and grouped items should mark running app runners");
assert.match(css, /\.terminal-tab-group-menu \{[^}]*max-height:\s*min\(32rem, calc\(var\(--visual-viewport-height, 100dvh\) - 6rem\)\);[^}]*overflow-x:\s*hidden;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;[^}]*scrollbar-gutter:\s*stable;/, "large grouped terminal tab menus should stay inside the viewport and scroll without dropping entries");
assert.match(css, /\.terminal-tab-group-item \{[\s\S]*?flex:\s*0 0 auto[\s\S]*?background:\s*var\(--ctp-crust\)/, "grouped terminal tab items should keep readable height and use opaque backgrounds");
assert.match(css, /\.terminal-tab-group-add \{[\s\S]*?flex:\s*0 0 auto/, "grouped terminal tab menus should keep the add-tab action at its natural height");
assert.match(css, /\.terminal-tab-group\.active \{[\s\S]*?background:[\s\S]*?var\(--ctp-crust\)/, "active terminal tab groups should keep opaque backgrounds");
assert.match(css, /\.terminal-tab-group\.stopped \{[\s\S]*?opacity:\s*1/, "stopped terminal tab groups should not become transparent");
assert.match(css, /\.terminal-tabs:has\(\.terminal-tab-group\.menu-open\),[^{}]*\{[^}]*overflow:\s*visible;/, "open terminal tab groups should escape the tab strip without clipping");
assert.match(css, /\.terminal-tab-group\.menu-open \.terminal-tab-group-menu \{[\s\S]*?display:\s*flex/, "open terminal tab group menus should remain visible without hover");
assert.match(css, /\.terminal-tab\.activity-working > \.terminal-tab-button \.terminal-tab-activity-indicator[\s\S]*?terminal-tab-working-pulse/, "working tab indicators should be visibly animated");
assert.match(css, /\.terminal-tab-group-item\.activity-working > \.terminal-tab-button \.terminal-tab-activity-indicator[\s\S]*?terminal-tab-working-pulse/, "working indicators should still animate on grouped tab menu items themselves");
assert.match(css, /\.terminal-tab\.activity-blocked[\s\S]*?rgba\(250, 179, 135/, "blocked tab indicators should use orange styling");
assert.match(css, /\.terminal-tab\.activity-blocked > \.terminal-tab-button \.terminal-tab-activity-indicator[\s\S]*?background:\s*var\(--ctp-peach\)/, "blocked tab indicator dots should be orange");
assert.doesNotMatch(css, /\.terminal-tab\.activity-(?:working|blocked|done)\s+\.terminal-tab-activity-indicator/, "group status styling should not cascade into child tabs in the group menu");
assert.match(css, /\.terminal-tab\.activity-done/, "completed unseen work should have a distinct tab style");
assert.match(app, /function setMobileTabsExpanded\(expanded, \{ restoreFocus = false \} = \{\}\)[\s\S]*?setComposerActionsOpen\(false\)[\s\S]*?terminalTabsBackdrop\.hidden = !mobileTabsExpanded[\s\S]*?focusReturn\.focus/, "mobile terminal drawer should coordinate competing surfaces, backdrop state, and focus return");
assert.match(css, /body\.mobile-keyboard-open \.terminal-tabs-shell,[\s\S]*?body\.mobile-keyboard-open \.widget-area,[\s\S]*?body\.mobile-keyboard-open \.statusbar/, "mobile keyboard mode should hide header, widgets, and footer");
assert.match(css, /body\.mobile-keyboard-open \.composer-actions-button,[\s\S]*?body\.mobile-keyboard-open \.composer-actions-panel/, "mobile keyboard mode should hide the secondary actions sheet while keeping active-run controls available");
assert.match(css, /\.server-offline-panel/, "PWA/offline shell should style a backend-offline recovery panel");
assert.match(html, /id="composerActionsPanel"[^>]*aria-label="More composer actions"[\s\S]*Session &amp; workspace[\s\S]*Tools &amp; commands[\s\S]*Context &amp; modes/, "secondary mobile composer controls should be grouped in task order");
assert.match(app, /function syncMobileComposerDisclosureLayout\(\)[\s\S]*?isMobileView\(\) && !isMobileShellV2Active\(\)[\s\S]*?composerActionsPanel\.append\(node\)/, "legacy mobile should reuse canonical secondary composer controls inside the expandable panel");
assert.match(css, /body\.mobile-composer-disclosure:not\(\.pi-run-active\):not\(\.mobile-keyboard-open\) \.composer-row > \.composer-actions-button \{[\s\S]*?grid-column:\s*span 2;[\s\S]*?#sendButton \{[\s\S]*?grid-column:\s*span 3;/, "idle mobile composer should show only More and Send beneath the prompt and attachment row");
assert.match(css, /body\.mobile-composer-disclosure\.mobile-keyboard-open \.composer-row \{[\s\S]*?repeat\(4,[\s\S]*?body\.mobile-composer-disclosure\.mobile-keyboard-open \.composer-actions-button,[\s\S]*?display:\s*none !important/, "keyboard-open mobile composer should retain primary run controls while hiding secondary disclosure chrome");
assert.match(css, /\[hidden\] \{ display: none !important; \}/, "hidden controls should not occupy layout space or be overridden by component display styles");
assert.match(css, /\.statusbar-tui-footer \{[\s\S]*?gap:\s*0/, "default TUI-like footer should reduce statusbar chrome around the compact line");
assert.match(css, /\.statusbar-git-footer \{[\s\S]*?--footer-chip-min-width:\s*7\.6rem;[\s\S]*?gap:\s*0\.58rem/, "enabled git-footer extension should keep styled spacing and one shared minimal chip width token");
assert.match(css, /\.footer-line-main \.footer-metric \{[\s\S]*?flex:\s*1 1 var\(--footer-chip-min-width\);[\s\S]*?width:\s*auto;[\s\S]*?min-width:\s*0/, "git-footer metrics should use a shared preferred minimum and distribute spare row space equally");
assert.match(css, /\.footer-line-meta \{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*nowrap/, "git-footer metadata should keep cwd, git chips, model, and effort on one row when space allows");
assert.match(css, /\.footer-line-meta \.footer-meta \{[\s\S]*?flex:\s*1 1 var\(--footer-chip-min-width\);[\s\S]*?width:\s*auto;[\s\S]*?min-width:\s*0/, "git-footer metadata chips should use a shared preferred minimum and distribute spare row space equally");
assert.match(css, /\.footer-thinking \.footer-meta-value \{[\s\S]*?color:\s*var\(--ctp-mauve\)/, "git-footer effort chip should have its own styling");
assert.match(css, /\.footer-changes \{[\s\S]*?border-color:\s*rgba\(249, 226, 175, 0\.36\)/, "git-footer changes chip should use a higher-contrast warning tint");
assert.match(css, /\.footer-changes \.footer-meta-value \{[\s\S]*?color:\s*var\(--ctp-yellow\)[\s\S]*?font-weight:\s*950/, "git-footer changes value should be bright and bold");
assert.match(css, /\.footer-changed-files-popover \{[\s\S]*?position:\s*absolute;[\s\S]*?bottom:\s*calc\(100% \+ 0\.48rem\)[\s\S]*?max-height:/, "git-footer changes chip should expose a hover popover for changed files");
assert.match(css, /\.footer-changes-with-files:hover \.footer-changed-files-popover,[\s\S]*?\.footer-changes-with-files:focus \.footer-changed-files-popover,[\s\S]*?\.footer-changes-with-files:focus-within \.footer-changed-files-popover \{[\s\S]*?display:\s*grid/, "git-footer changed-files popover should open on hover or keyboard focus");
assert.match(css, /\.footer-changed-file\.modified \.footer-changed-file-status \{ color:\s*var\(--ctp-yellow\); \}/, "modified changed-file rows should keep the changes warning color");
assert.match(css, /\.footer-git-extra \.footer-meta-value \{[\s\S]*?color:\s*var\(--ctp-sky\)[\s\S]*?font-weight:\s*900/, "git-footer extras value should be bright enough to read at footer size");
assert.match(css, /\.footer-metric-action,\n\.footer-meta-action \{[\s\S]*?position:\s*relative;[\s\S]*?border-color:\s*rgba\(148, 226, 213, 0\.26\)/, "clickable footer boxes should have a subtle always-visible highlight");
assert.doesNotMatch(css, /\.footer-(?:metric|meta)-action::after/, "clickable footer boxes should not show a corner indicator dot");
assert.match(css, /\.extension-dialog\.git-changes-dialog \{[\s\S]*?--git-changes-dialog-width:[\s\S]*?--git-changes-dialog-height:[\s\S]*?width:\s*var\(--git-changes-dialog-width\)[\s\S]*?height:\s*var\(--git-changes-dialog-height\)/, "git changes modal should override the base dialog with a wide bounded diff layout");
assert.match(css, /\.git-changes-body \{[\s\S]*?align-content:\s*start/, "git changes modal should keep summary and file content packed at the top of the scroller");
assert.match(css, /\.git-current-file-header \{[\s\S]*?position:\s*sticky[\s\S]*?top:\s*-0\.72rem/, "git changes modal should keep a sticky current-file header inside the diff scroller");
assert.match(css, /\.git-changes-file-list \{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, "git changes modal should show changed-file jump buttons in two columns without horizontal scrolling");
assert.match(css, /\.git-diff-grid \{[\s\S]*?grid-template-columns:\s*3\.8rem minmax\(22rem, 1fr\) 3\.8rem minmax\(22rem, 1fr\)/, "git changes modal should render a side-by-side diff grid");
assert.match(html, /id="gitChangesDialog"[\s\S]*id="gitChangesRefreshButton"[\s\S]*id="gitChangesPullButton"[\s\S]*id="gitChangesBody"/, "git changes modal should expose refresh, pull controls, and a diff body");
assert.match(app, /chip\.key === "changes"[\s\S]*?options\.onClick = \(\) => openGitChangesDialog\(tab\?\.id \|\| activeTabId\)/, "footer CHANGES chip should pass its tab ID without forwarding the browser click event");
assert.match(app, /chip\.key === "git-state"[\s\S]*?options\.onClick = \(\) => openGitChangesDialog\(tab\?\.id \|\| activeTabId\)/, "footer git-state chip should pass its tab ID without forwarding the browser click event");
assert.match(app, /function openGitChangesDialog\(requestedTabId = activeTabId\)[\s\S]*?typeof requestedTabId === "string" && requestedTabId \? requestedTabId : activeTabId/, "git changes dialog should reject event objects and other non-string tab IDs defensively");
assert.doesNotMatch(app, /options\.onClick = openGitChangesDialog/, "git changes handlers must not forward click events as tab IDs");
assert.match(app, /async function loadGitChangesDialog[\s\S]*api\("\/api\/git-changes"/, "git changes modal should load diff data from the server endpoint");
assert.match(app, /"Resolve with agent"[\s\S]*api\("\/api\/git-operation\/resolve-with-agent", \{ method: "POST"[\s\S]*switchToResponseTab\(response\)/, "conflict panel should open the resolution agent in the new tab returned by the server");
assert.match(server, /function gitConflictResolutionAgentPrompt\(operation\)[\s\S]*Conflicted files:[\s\S]*Do not continue, skip, abort, commit, reset, or push[\s\S]*diff-filter=U is empty/, "server should build a bounded conflict handoff with operation safety and verification instructions");
assert.match(server, /"\/api\/git-operation\/resolve-with-agent"[\s\S]*openGitConflictResolutionAgentTab\(tab\)/, "server should expose conflict-resolution agent tab creation through the git operation routes");
assert.match(app, /async function pullGitChangesDialog\(\)[\s\S]*api\("\/api\/git-changes\/pull", \{ method: "POST"/, "git changes modal should post to the pull endpoint from the Pull button");
assert.match(app, /async function pullGitFooterSync\(tabId = activeTabId, \{ syncValue = "" \} = \{\}\)[\s\S]*api\("\/api\/git-changes\/pull", \{ method: "POST", body: \{ remote: "origin" \}, tabId \}\)[\s\S]*requestGitFooterWebuiPayload\(tabContext, \{ force: true \}\)/, "incoming-only footer Sync should pull directly from origin and refresh the footer payload");
assert.doesNotMatch(app.match(/async function pullGitFooterSync[\s\S]*?\n\}/)?.[0] || "", /git-workflow\/push|appConfirmText/, "the direct footer pull path should neither push nor open a confirmation");
assert.match(html, /id="gitPullErrorDialog"[\s\S]*aria-labelledby="gitPullErrorDialogTitle"[\s\S]*id="gitPullErrorOutput"[\s\S]*id="gitPullErrorRecovery"[^>]*hidden[\s\S]*id="gitPullErrorReviewButton"[\s\S]*id="gitPullErrorRebaseButton"[\s\S]*id="gitPullErrorMergeButton"[\s\S]*id="gitPullErrorCopyButton"[\s\S]*id="gitPullErrorCloseButton"/, "footer pull failures should use a labelled native dialog with review, rebase, merge, copy, and close actions");
assert.match(css, /\.extension-dialog\.git-pull-error-dialog[\s\S]*\.git-pull-error-output \{[\s\S]*user-select: text;[\s\S]*white-space: pre-wrap;[\s\S]*\.git-pull-error-recovery-actions \{[\s\S]*flex-wrap: wrap;/, "Git pull error output and recovery actions should remain readable, selectable, and responsive");
assert.match(app, /function gitFailureDisplayText\(response[\s\S]*result\.stderr = ""[\s\S]*formatGitCommandResult\(result\)[\s\S]*seen\.has\(key\)/, "Git pull error formatting should remove exact duplicate stderr while retaining unique command details");
assert.match(app, /function openGitPullErrorDialog\(message, \{ code = "", tabId = null, syncValue = "" \} = \{\}\)[\s\S]*code === "DIVERGED"[\s\S]*This does not mean conflicts exist[\s\S]*gitPullErrorRecovery\.hidden = !diverged[\s\S]*gitPullErrorCloseButton\?\.classList\.toggle\("primary", !diverged\)[\s\S]*gitPullErrorDialog\.showModal\(\)/, "DIVERGED pull errors should explain conflict uncertainty and expose native recovery actions while standard errors retain a primary Close action");
assert.match(app, /async function integrateGitPullDivergence\(mode\)[\s\S]*appConfirmText[\s\S]*danger: !merge[\s\S]*gitFooterSyncInFlightByTab\.add\(tabId\)[\s\S]*\/api\/git-changes\/integrate[\s\S]*body: \{ mode, confirmed: true \}[\s\S]*gitPullErrorContext\.requestId !== requestId[\s\S]*response\.code === "CONFLICTS"[\s\S]*openGitChangesDialog\(tabId\)[\s\S]*freshAheadValue[\s\S]*gitFooterSyncInFlightByTab\.delete\(tabId\)/, "merge and rebase recovery should require confirmation, reject stale responses, serialize per-tab mutations, use fresh ahead counts, and route actual conflicts to Git Changes");
assert.match(app, /function reviewGitPullDivergence\(\)[\s\S]*closeGitPullErrorDialog\(\)[\s\S]*openGitChangesDialog\(tabId\)/, "review recovery should open Git Changes without integrating");
assert.match(app, /async function copyGitPullErrorOutput\(\)[\s\S]*copyText\(gitPullErrorText\)[\s\S]*Error output copied to the clipboard/, "Git pull error dialog should copy the complete displayed output");
assert.match(app, /async function pullGitFooterSync[\s\S]*if \(!response\.ok\)[\s\S]*gitFailureDisplayText\(response[\s\S]*openGitPullErrorDialog\(message, \{ code: response\.code \|\| "", tabId, syncValue \}\)/, "footer pull failures should route structured, deduplicated details into the native dialog");

const gitFailureDisplayStart = app.indexOf("function gitFailureDisplayText(");
const gitFailureDisplayEnd = app.indexOf("\nfunction setGitPullErrorBusy(", gitFailureDisplayStart);
assert.ok(gitFailureDisplayStart >= 0 && gitFailureDisplayEnd > gitFailureDisplayStart, "Git failure display formatter should remain a standalone helper");
const gitFailureDisplayContext = {
  formatGitCommandResult(result) {
    const lines = [`$ ${result?.command || "git"}`];
    if (result?.stdout?.trim()) lines.push("", result.stdout.trim());
    if (result?.stderr?.trim()) lines.push("", result.stderr.trim());
    if (result?.exitCode !== 0) lines.push("", `[exit: ${result?.exitCode}]`);
    return lines.join("\n");
  },
};
vm.runInNewContext(`${app.slice(gitFailureDisplayStart, gitFailureDisplayEnd)}\nthis.formatFailure = gitFailureDisplayText;`, gitFailureDisplayContext);
const repeatedStderr = "fatal: Not possible to fast-forward, aborting.";
const deduplicatedPullError = gitFailureDisplayContext.formatFailure({
  error: repeatedStderr,
  hint: "Local and remote branches have diverged.",
  data: { command: "git pull --ff-only origin", stderr: repeatedStderr, stdout: "", exitCode: 128 },
});
assert.equal(deduplicatedPullError.split(repeatedStderr).length - 1, 1, "identical pull stderr should appear exactly once");
assert.match(deduplicatedPullError, /git pull --ff-only origin[\s\S]*\[exit: 128\]/, "deduplication should preserve command and exit details");

const gitPullErrorDialogStart = app.indexOf("function setGitPullErrorBusy(");
const gitPullErrorDialogEnd = app.indexOf("\nasync function pullGitFooterSync(", gitPullErrorDialogStart);
assert.ok(gitPullErrorDialogStart >= 0 && gitPullErrorDialogEnd > gitPullErrorDialogStart, "Git pull error dialog helpers should remain isolated from the pull request helper");
const copiedPullErrors = [];
const integrationRequests = [];
const integrationConfirmations = [];
const reviewedPullTabs = [];
const refreshedPullTabs = [];
const resumedPushes = [];
let integrationResponse = { ok: true, data: { changes: { summary: { ahead: 2 } } } };
const nativePullErrorDialog = { open: false, showModal() { this.open = true; }, close() { this.open = false; }, setAttribute() {} };
const nativePullErrorTitle = { textContent: "" };
const nativePullErrorDescription = { textContent: "" };
const nativePullErrorOutput = { textContent: "" };
const nativePullErrorStatus = { textContent: "", classList: { add() {}, remove() {} } };
const nativePullErrorRecovery = { hidden: true };
const nativePullErrorButton = () => ({ disabled: false, focus() {}, classList: { toggle() {} } });
const nativePullErrorMergeButton = nativePullErrorButton();
const nativePullErrorRebaseButton = nativePullErrorButton();
const nativePullErrorReviewButton = nativePullErrorButton();
const nativePullErrorCopyButton = nativePullErrorButton();
const nativePullErrorCloseButton = nativePullErrorButton();
const gitPullErrorDialogContext = {
  gitPullErrorText: "",
  gitPullErrorContext: { code: "", tabId: null, syncValue: "", busy: false, requestId: 0 },
  activeTabId: "tab-pull",
  tabs: [{ id: "tab-pull", title: "feature/sync" }, { id: "tab-rebase", title: "feature/rebase" }],
  gitFooterSyncInFlightByTab: new Set(),
  elements: {
    gitPullErrorDialog: nativePullErrorDialog,
    gitPullErrorDialogTitle: nativePullErrorTitle,
    gitPullErrorDialogDescription: nativePullErrorDescription,
    gitPullErrorOutput: nativePullErrorOutput,
    gitPullErrorStatus: nativePullErrorStatus,
    gitPullErrorRecovery: nativePullErrorRecovery,
    gitPullErrorMergeButton: nativePullErrorMergeButton,
    gitPullErrorRebaseButton: nativePullErrorRebaseButton,
    gitPullErrorReviewButton: nativePullErrorReviewButton,
    gitPullErrorCopyButton: nativePullErrorCopyButton,
    gitPullErrorCloseButton: nativePullErrorCloseButton,
  },
  window: { alert() { throw new Error("native dialog should avoid alert fallback"); } },
  queueMicrotask: (callback) => callback(),
  copyText: async (text) => copiedPullErrors.push(text),
  addEvent() {},
  gitFooterCurrentBranch: () => "feature/sync",
  appConfirmText: async (message, options) => { integrationConfirmations.push({ message, options }); return true; },
  api: async (path, options) => { integrationRequests.push({ path, options }); return integrationResponse; },
  gitFailureDisplayText: () => "integration conflict output",
  openGitChangesDialog: (tabId) => reviewedPullTabs.push(tabId),
  activeTabContext: (tabId) => ({ tabId }),
  isCurrentTabContext: () => false,
  renderFooter() {},
  requestGitFooterWebuiPayload: (context) => refreshedPullTabs.push(context.tabId),
  gitFooterSyncCounts: () => ({ ahead: 1, behind: 0 }),
  pushGitFooterSync: async (tabId, value) => resumedPushes.push({ tabId, value }),
};
vm.runInNewContext(`${app.slice(gitPullErrorDialogStart, gitPullErrorDialogEnd)}\nthis.openPullError = openGitPullErrorDialog; this.copyPullError = copyGitPullErrorOutput; this.reviewPullError = reviewGitPullDivergence; this.integratePullError = integrateGitPullDivergence;`, gitPullErrorDialogContext);
gitPullErrorDialogContext.openPullError("network unavailable\n\ncheck the connection", { code: "DIVERGED", tabId: "tab-pull", syncValue: "⇡1 · ⇣2" });
assert.equal(nativePullErrorDialog.open, true, "Git pull error dialog should open natively");
assert.equal(nativePullErrorTitle.textContent, "Branches diverged", "DIVERGED popup should use a specific title");
assert.match(nativePullErrorDescription.textContent, /does not mean conflicts exist/, "DIVERGED popup should distinguish divergence from conflicts");
assert.equal(nativePullErrorRecovery.hidden, false, "DIVERGED popup should reveal recovery actions");
assert.equal(integrationRequests.length, 0, "opening divergence recovery must not mutate Git state");
assert.equal(nativePullErrorOutput.textContent, "network unavailable\n\ncheck the connection", "Git pull error dialog should display complete output");
await gitPullErrorDialogContext.copyPullError();
assert.deepEqual(copiedPullErrors, ["network unavailable\n\ncheck the connection"], "Git pull error copy action should preserve the complete output");
assert.equal(nativePullErrorStatus.textContent, "Error output copied to the clipboard.", "Git pull error dialog should announce copy success");
gitPullErrorDialogContext.reviewPullError();
assert.deepEqual(reviewedPullTabs, ["tab-pull"], "Review changes should open Git Changes for the originating tab");
assert.equal(integrationRequests.length, 0, "Review changes must remain non-mutating");

gitPullErrorDialogContext.openPullError("diverged", { code: "DIVERGED", tabId: "tab-pull", syncValue: "⇡1 · ⇣2" });
assert.equal(await gitPullErrorDialogContext.integratePullError("merge"), true, "confirmed merge recovery should succeed");
assert.deepEqual(JSON.parse(JSON.stringify(integrationRequests[0])), { path: "/api/git-changes/integrate", options: { method: "POST", body: { mode: "merge", confirmed: true }, tabId: "tab-pull" } }, "merge recovery should use the confirmed integration contract");
assert.equal(integrationConfirmations[0].options.confirmLabel, "Merge changes", "merge recovery should be the primary confirmed action");
assert.equal(integrationConfirmations[0].options.danger, false, "merge confirmation should use the normal primary style");
assert.deepEqual(refreshedPullTabs, ["tab-pull"], "successful integration should refresh the originating footer");
assert.deepEqual(resumedPushes, [{ tabId: "tab-pull", value: "⇡2" }], "successful integration should resume the existing confirmed push flow with the fresh outgoing count");

integrationResponse = { ok: false, code: "CONFLICTS", error: "conflicts created", data: { command: "git rebase @{upstream}", exitCode: 1 } };
gitPullErrorDialogContext.openPullError("diverged", { code: "DIVERGED", tabId: "tab-rebase", syncValue: "⇡2 · ⇣1" });
assert.equal(await gitPullErrorDialogContext.integratePullError("rebase"), false, "conflicted rebase recovery should stop");
assert.deepEqual(JSON.parse(JSON.stringify(integrationRequests[1].options.body)), { mode: "rebase", confirmed: true }, "rebase recovery should use the confirmed integration contract");
assert.equal(integrationConfirmations[1].options.confirmLabel, "Rebase commits", "rebase should remain an explicit alternative");
assert.equal(integrationConfirmations[1].options.danger, true, "rebase confirmation should warn that local commit IDs will be rewritten");
assert.deepEqual(reviewedPullTabs, ["tab-pull", "tab-rebase"], "actual conflicts should open the existing Git Changes panel");
assert.equal(resumedPushes.length, 1, "conflicted integration must not continue to push");

const pullGitFooterSyncStart = app.indexOf("async function pullGitFooterSync(");
const pullGitFooterSyncEnd = app.indexOf("\nasync function pullThenPushGitFooterSync(", pullGitFooterSyncStart);
assert.ok(pullGitFooterSyncStart >= 0 && pullGitFooterSyncEnd > pullGitFooterSyncStart, "footer pull should remain a standalone async frontend helper");
const pullGitFooterSyncSource = app.slice(pullGitFooterSyncStart, pullGitFooterSyncEnd);
const pullFailureEvents = [];
const pullFailureDialogs = [];
const pullFailureContext = {
  gitFooterSyncInFlightByTab: new Set(),
  activeTabContext: (tabId) => ({ tabId }),
  hideFooterTooltip() {},
  isCurrentTabContext: () => false,
  renderFooter() {},
  api: async () => ({ ok: false, code: "DIVERGED", error: "duplicated raw error", hint: "diverged", data: {} }),
  gitFailureDisplayText: () => "deduplicated pull error",
  addEvent: (message, level) => pullFailureEvents.push({ message, level }),
  requestGitFooterWebuiPayload() {},
  openGitPullErrorDialog: (message, options) => pullFailureDialogs.push({ message, options }),
};
vm.runInNewContext(`${pullGitFooterSyncSource}\nthis.runPullGitFooterSync = pullGitFooterSync;`, pullFailureContext);
assert.equal(await pullFailureContext.runPullGitFooterSync("tab-pull", { syncValue: "⇡1 · ⇣2" }), false, "failed footer pull should report failure to ordered Sync");
assert.deepEqual(pullFailureEvents, [{ message: "deduplicated pull error", level: "error" }], "failed footer pull should keep only deduplicated output in the event log");
assert.deepEqual(JSON.parse(JSON.stringify(pullFailureDialogs)), [{ message: "deduplicated pull error", options: { code: "DIVERGED", tabId: "tab-pull", syncValue: "⇡1 · ⇣2" } }], "failed footer pull should preserve structured recovery context");
assert.match(app, /async function pushGitFooterSync\(tabId = activeTabId, syncValue = ""\)[\s\S]*api\("\/api\/git-workflow\/push", \{ method: "POST", body: \{\}, tabId \}\)[\s\S]*response\.code === "NON_FAST_FORWARD"[\s\S]*recoverWithPullFirst = true[\s\S]*gitFooterSyncInFlightByTab\.delete\(tabId\)[\s\S]*pullThenPushGitFooterSync\(tabId, syncValue\)/, "non-fast-forward footer pushes should release their mutation lock before entering pull-first recovery");
const pushGitFooterSyncStart = app.indexOf("async function pushGitFooterSync(");
const pushGitFooterSyncEnd = app.indexOf("\nfunction renderGitFooterPayloadMeta(", pushGitFooterSyncStart);
assert.ok(pushGitFooterSyncStart >= 0 && pushGitFooterSyncEnd > pushGitFooterSyncStart, "footer push should remain a standalone async frontend helper");
const pushRecoveryRequests = [];
const pushRecoveryEvents = [];
const pushRecoveryCalls = [];
const pushRecoveryInFlight = new Set();
const pushRecoveryContext = {
  activeTabId: "tab-push",
  gitFooterSyncInFlightByTab: pushRecoveryInFlight,
  gitFooterSyncCounts: () => ({ ahead: 2, behind: 0 }),
  activeTabContext: (tabId) => ({ tabId }),
  tabs: [{ id: "tab-push", title: "feature/push-recovery" }],
  hideFooterTooltip() {},
  gitFooterCurrentBranch: () => "feature/push-recovery",
  appConfirmText: async () => true,
  isCurrentTabContext: () => false,
  renderFooter() {},
  api: async (path, options) => {
    pushRecoveryRequests.push({ path, options });
    return { ok: false, code: "NON_FAST_FORWARD", error: "remote contains new commits" };
  },
  addEvent: (message, level) => pushRecoveryEvents.push({ message, level }),
  requestGitFooterWebuiPayload() {},
  formatGitCommandResult: () => "",
  pullThenPushGitFooterSync: async (tabId, value) => pushRecoveryCalls.push({ tabId, value, locked: pushRecoveryInFlight.has(tabId) }),
};
vm.runInNewContext(`${app.slice(pushGitFooterSyncStart, pushGitFooterSyncEnd)}\nthis.runPushGitFooterSync = pushGitFooterSync;`, pushRecoveryContext);
await pushRecoveryContext.runPushGitFooterSync("tab-push", "⇡2");
assert.deepEqual(JSON.parse(JSON.stringify(pushRecoveryRequests)), [{ path: "/api/git-workflow/push", options: { method: "POST", body: {}, tabId: "tab-push" } }], "footer Push should not offer or attempt force-with-lease after a non-fast-forward rejection");
assert.deepEqual(JSON.parse(JSON.stringify(pushRecoveryCalls)), [{ tabId: "tab-push", value: "⇡2", locked: false }], "footer Push should hand non-fast-forward recovery to the existing pull-then-push workflow after unlocking the tab");
assert.deepEqual(pushRecoveryEvents, [{ message: "Push found incoming commits. Starting pull-first recovery.", level: "info" }], "footer Push should explain the switch to pull-first recovery");
assert.match(app, /chip\.key === "sync" && visible\("webui-sync-push"\)[\s\S]*syncAction === "pull"[\s\S]*pullGitFooterSync\(tabId\)[\s\S]*syncAction === "pull-push"[\s\S]*pullThenPushGitFooterSync\(tabId, chip\.value\)[\s\S]*syncAction === "push"[\s\S]*pushGitFooterSync\(tabId, chip\.value\)/, "footer Sync should route incoming, diverged, and outgoing states to their respective actions");
const gitFooterSyncRoutingSource = appFunctionSource("gitFooterSyncCounts", "gitFooterCurrentBranch");
const gitFooterSyncRouting = JSON.parse(vm.runInNewContext(`${gitFooterSyncRoutingSource}\nJSON.stringify({
  incoming: gitFooterSyncAction({ key: "sync", value: "⇣2" }),
  outgoing: gitFooterSyncAction({ key: "sync", value: "⇡2" }),
  diverged: gitFooterSyncAction({ key: "sync", value: "⇡1 · ⇣2" }),
  unavailable: gitFooterSyncAction({ key: "sync", value: "no upstream" }),
  other: gitFooterSyncAction({ key: "changes", value: "⇣2" }),
})`));
assert.deepEqual(gitFooterSyncRouting, { incoming: "pull", outgoing: "push", diverged: "pull-push", unavailable: "", other: "" }, "Sync routing should pull before pushing whenever incoming and outgoing commits both exist");
const pullThenPushGitFooterSyncStart = app.indexOf("async function pullThenPushGitFooterSync(");
const pullThenPushGitFooterSyncEnd = app.indexOf("\nasync function pushGitFooterSync(", pullThenPushGitFooterSyncStart);
assert.ok(pullThenPushGitFooterSyncStart >= 0 && pullThenPushGitFooterSyncEnd > pullThenPushGitFooterSyncStart, "pull-then-push Sync should remain a standalone async frontend helper");
const pullThenPushGitFooterSyncSource = app.slice(pullThenPushGitFooterSyncStart, pullThenPushGitFooterSyncEnd);
const orderedSyncCalls = [];
const orderedSyncContext = {
  pullGitFooterSync: async (tabId) => { orderedSyncCalls.push(`pull:${tabId}`); return true; },
  pushGitFooterSync: async (tabId, value) => { orderedSyncCalls.push(`push:${tabId}:${value}`); },
};
vm.runInNewContext(`${pullThenPushGitFooterSyncSource}\nthis.runPullThenPushGitFooterSync = pullThenPushGitFooterSync;`, orderedSyncContext);
await orderedSyncContext.runPullThenPushGitFooterSync("tab-sync", "⇡1 · ⇣2");
assert.deepEqual(orderedSyncCalls, ["pull:tab-sync", "push:tab-sync:⇡1 · ⇣2"], "combined Sync should await pull before push");
orderedSyncCalls.length = 0;
orderedSyncContext.pullGitFooterSync = async (tabId) => { orderedSyncCalls.push(`pull:${tabId}`); return false; };
await orderedSyncContext.runPullThenPushGitFooterSync("tab-sync", "⇡1 · ⇣2");
assert.deepEqual(orderedSyncCalls, ["pull:tab-sync"], "combined Sync should skip push when pull fails or cannot start");
assert.match(app, /function gitDiffDisplayLine\(row, side\)[\s\S]*`-\$\{text\}`[\s\S]*`\+\$\{text\}`/, "git changes modal should render changed lines with +/- prefixes");
assert.match(app, /function gitUntrackedEntryToDiffFile\(entry\)[\s\S]*?renderRowLimit:\s*Number\.POSITIVE_INFINITY[\s\S]*?type: "added"/, "untracked files should render as complete added-file diffs without the row preview cap");
assert.match(app, /async function loadMissingGitUntrackedContent\(entry[\s\S]*?\/api\/git-changes\/untracked-file\?path=/, "untracked path-only payloads should fetch complete file contents instead of rendering as empty files");
assert.match(app, /function updateGitChangesCurrentFileHeader\(\)[\s\S]*?querySelectorAll\("\.git-diff-file\[data-git-diff-file\]"\)/, "git changes modal should derive the sticky current-file header from visible file cards");
assert.match(app, /function renderGitChangesFileList\(parsedSections, untracked\)[\s\S]*dataset\.gitChangesJumpFile = item\.path[\s\S]*git-changes-file-jump-meta/, "git changes modal should render jump buttons for each changed file");
assert.match(app, /gitChangesBody\?\.addEventListener\("click"[\s\S]*data-git-changes-jump-file[\s\S]*scrollIntoView\(\{ block: "start", behavior: "smooth" \}\)/, "git changes file jump buttons should scroll to their diff cards");
assert.match(server, /async function readGitUntrackedEntry\(root, file, \{ maxBytes = Number\.POSITIVE_INFINITY \} = \{\}\)[\s\S]*?content: binary \? "" : buffer\.toString\("utf8"\)/, "server should include complete text contents for untracked files");
assert.match(server, /url\.pathname === "\/api\/git-changes\/untracked-file" && req\.method === "GET"/, "server should expose a focused untracked-file content endpoint for stale path-only payload fallbacks");
assert.match(server, /async function readGitChanges\(cwd\)[\s\S]*?const diffArgs = \["diff", "--no-ext-diff"[\s\S]*?"--unified=0"[\s\S]*?\["diff", "--cached"/, "server should collect compact staged and unstaged git diffs for the changes modal");
assert.match(server, /\["status", "--porcelain=2", "--branch", "--untracked-files=all"\][\s\S]*?summarizeGitPorcelainStatus\(porcelainStatusText\)/, "server should derive behind/ahead from locale-independent porcelain status so the Pull button activates after fetch");
assert.match(server, /async function readGitIncomingChanges\(root, summary\)[\s\S]*?"HEAD\.\.@\{upstream\}"/, "server should collect incoming upstream diffs when remote commits are behind");
assert.match(server, /url\.pathname === "\/api\/git-changes" && req\.method === "GET"/, "server should expose GET /api/git-changes for the changes modal");
assert.match(server, /async function pullGitChanges\(cwd, \{ remote \} = \{\}\)[\s\S]*?const pullArgs = \["pull", "--ff-only"\];[\s\S]*?remote === "origin"[\s\S]*?pullArgs\.push\("origin"\)[\s\S]*?runGuardedGitMutation\(pullArgs/, "server should allow the guarded pull endpoint to target origin explicitly");
assert.match(server, /url\.pathname === "\/api\/git-changes\/pull" && req\.method === "POST"[\s\S]*?pullGitChanges\(tab\.cwd, \{ remote: body\?\.remote \}\)/, "server should expose POST /api/git-changes/pull for modal and footer Pull actions");
assert.match(css, /@media \(max-width: 1050px\)[\s\S]*?\.footer-line-meta \{[\s\S]*?display:\s*flex;[\s\S]*?flex-wrap:\s*wrap;[\s\S]*?\.footer-line-meta \.footer-meta \{[\s\S]*?flex:\s*1 1 var\(--footer-chip-min-width\);[\s\S]*?width:\s*auto;[\s\S]*?\.footer-workspace,\n\s+\.footer-model,\n\s+\.footer-thinking \{ grid-column:\s*auto; \}/, "narrow git-footer metadata should wrap like the top metric row instead of forcing a two-column grid");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*?\.context-meter-bar \{ display:\s*none !important; \}/, "mobile should hide the WebUI context meter that appears after high context usage");
assert.match(css, /\.footer-line-tui \{[\s\S]*?white-space:\s*nowrap/, "default Web UI footer should use a minimal TUI-like line");
assert.match(css, /\.footer-tui-cwd[\s\S]*?max-width:\s*38%/, "TUI-like footer should keep cwd compact on desktop");
assert.match(css, /\.footer-tui-model[\s\S]*?text-align:\s*right/, "TUI-like footer should right-align model information on desktop");
assert.match(css, /\.footer-model-picker[\s\S]*?position:\s*absolute[\s\S]*?left:\s*var\(--footer-model-picker-left, auto\)[\s\S]*?right:\s*var\(--footer-model-picker-right, 0\.95rem\)/, "footer model and effort pickers should render as anchored dropdown popovers");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*?\.footer-model-picker \{[\s\S]*?position:\s*fixed/, "mobile footer model picker should escape footer-details stacking as a fixed overlay on narrow, device-width-narrow, or touch-only devices");
assert.match(css, /bottom:\s*var\(--footer-model-picker-bottom/, "mobile footer model picker should be anchored by a JS-computed viewport offset");
assert.match(css, /\.footer-model-option\.active/, "footer model picker should style the selected scoped model");
assert.match(css, /\.side-panel-controls \.model-search-result \{[\s\S]*?align-content:\s*center;[\s\S]*?min-height:\s*3\.2rem;[\s\S]*?padding:\s*0\.48rem 0\.62rem;/, "side-panel model rows should override generic control-button sizing and center both text lines");
assert.match(css, /\.model-search-result-main,\n\.model-search-result-name \{[\s\S]*?line-height:\s*1\.4;/, "side-panel model titles should reserve enough line height to avoid clipping heavy font glyphs");
assert.match(app, /async function createPathPickerDirectory\(\)/, "cwd picker should implement create-directory behavior in the browser");
assert.match(app, /function renderPathPickerDirectoryList\(\)[\s\S]*pathPickerDirectoryMatchesSearch/, "cwd picker should filter current-directory entries in the browser");
assert.match(app, /elements\.pathPickerSearchInput\.addEventListener\("input", renderPathPickerDirectoryList\)/, "cwd picker should update directory matches as the user types");
assert.match(app, /function shouldOpenCwdChangeInNewTab\(tab\) \{[\s\S]*!!tab\?\.conversationStarted[\s\S]*activeTabHasConversationMessages\(tab\)[\s\S]*stateHasVisibleWork\(currentState\)[\s\S]*tabHasActiveAgent\(tab\)/, "cwd changes for started conversations should be routed to a new tab");
assert.match(app, /if \(shouldOpenCwdChangeInNewTab\(tab\)\) \{[\s\S]*await createTerminalTab\(cwd, \{ triggerButton: null \}\);[\s\S]*return;[\s\S]*await appConfirmText\(`Restart/, "footer cwd changes should open a new tab before app-confirmed cwd restarts once a session is active");
assert.match(server, /async function createDirectoryPickerDirectory\(parentPath, nameValue, activeCwd\)/, "server should implement cwd picker directory creation");
assert.match(server, /function directoryPickerActiveCwd\(req, url, body = \{\}\)/, "server should let the cwd picker run before any Pi tabs exist");
assert.match(server, /url\.pathname === "\/api\/directories" && req\.method === "POST"/, "server should expose POST /api/directories for cwd picker directory creation");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*?\.footer-line-tui \{[\s\S]*?flex-wrap:\s*wrap/, "mobile footer should wrap the minimal TUI-like line instead of using expanded metadata chips");
assert.match(css, /(?:^|\n)\s*\.side-panel-backdrop\s*\{[\s\S]*?position:\s*fixed/, "mobile side panel backdrop should be fixed overlay UI");
assert.match(css, /(?:^|\n)\s*\.side-panel\s*\{[\s\S]*?position:\s*fixed/, "mobile side panel should be an overlay drawer instead of stacked content");
assert.match(css, /\.extension-dialog[\s\S]*?max-height:\s*calc\(var\(--visual-viewport-height/, "dialogs should fit the visual viewport on mobile");
assert.match(css, /\.extension-dialog[\s\S]*?inset:\s*auto 0 0 0/, "mobile dialogs should behave like bottom sheets");
assert.match(css, /#dialogMessage \{[\s\S]*?white-space:\s*pre-wrap/, "extension dialog messages should preserve multiline prompts");
assert.match(css, /\.edit-retry-dialog \{[\s\S]*?width:\s*min\(44rem, calc\(100vw - 2rem\)\);[\s\S]*?max-height:\s*calc\(var\(--visual-viewport-height, 100dvh\) - 2rem\);[\s\S]*?overflow:\s*hidden/, "edit/retry dialog should stay bounded by the viewport instead of bleeding off-screen");
assert.match(css, /\.edit-retry-dialog form \{[\s\S]*?display:\s*grid;[\s\S]*?grid-template-rows:\s*auto auto minmax\(0, 1fr\) auto auto;[\s\S]*?max-height:\s*calc\(var\(--visual-viewport-height, 100dvh\) - 4rem\);[\s\S]*?min-height:\s*0/, "edit/retry dialog form should let the editor row shrink inside the modal");
assert.match(css, /\.edit-retry-text \{[\s\S]*?min-width:\s*0;[\s\S]*?max-height:\s*min\(32rem, 48vh\);[\s\S]*?overflow-x:\s*hidden;[\s\S]*?overflow-y:\s*auto;[\s\S]*?overflow-wrap:\s*anywhere;[\s\S]*?white-space:\s*pre-wrap/, "edit/retry editor should wrap long prompts and scroll vertically without expanding the modal");
assert.match(css, /\.native-command-dialog \{[\s\S]*?width:\s*min\(56rem/, "native slash selector dialog should have roomy desktop layout");
assert.match(css, /\.extension-dialog\.remote-qr-dialog \{[\s\S]*?width:\s*min\(34rem/, "remote QR popup should have a bounded modal layout");
assert.match(css, /\.remote-qr-loading \{[\s\S]*?display:\s*flex/, "remote QR popup should style its loading placeholder");
assert.match(css, /\.remote-qr-spinner \{[\s\S]*?animation:\s*remote-qr-spinner-spin 900ms linear infinite/, "remote QR popup loading state should include a spinner animation");
assert.match(css, /\.remote-qr-svg \{[\s\S]*?aspect-ratio:\s*1 \/ 1/, "remote QR popup should render QR modules as a square image");
assert.match(css, /\.remote-qr-code \{[\s\S]*?white-space:\s*pre/, "remote QR popup should preserve terminal QR whitespace as fallback");
assert.doesNotMatch(css, /--tree-depth/, "native slash selector choices should not indent tree entries by depth");
assert.match(css, /\.native-selector-index \{[\s\S]*?font-variant-numeric:\s*tabular-nums/, "native tree selector choices should use numeric prefixes");
assert.match(css, /\.native-selector-badge\.native-selector-badge-pi-native[\s\S]*?color:\s*var\(--ctp-blue\)/, "Tools Setup should distinguish Pi native tools with a Pi Native tag");
assert.match(css, /\.native-selector-badge\.native-selector-badge-external[\s\S]*?color:\s*var\(--ctp-mauve\)/, "Tools Setup should distinguish external tools with an External tag");
assert.match(css, /\.native-settings-grid,[\s\S]*?\.native-tree-options \{[\s\S]*?grid-template-columns:/, "native settings and tree selector options should use responsive grids");
assert.match(css, /\.extension-dialog\.guardrail-dialog[\s\S]*?border-color:\s*rgba\(249, 226, 175/, "guardrail dialogs should have warning-specific styling");
assert.match(css, /\.extension-dialog\.release-dialog[\s\S]*?width:\s*min\(64rem/, "release confirmation dialogs should have more horizontal room");
assert.match(css, /\.extension-dialog\.release-dialog[\s\S]*?overflow:\s*hidden/, "release confirmation dialogs should clip overflowing internal panes instead of bleeding over the transcript");
assert.match(css, /\.extension-dialog\.release-dialog form[\s\S]*?min-height:\s*0/, "release confirmation layout should allow inner scroll panes to shrink inside the modal");
assert.match(css, /\.extension-dialog\.release-dialog #dialogMessage[\s\S]*?max-height:\s*min\(56vh, 34rem\)/, "release confirmation summaries should scroll in a roomy panel");
assert.match(css, /\.extension-dialog\.release-dialog #dialogBody[\s\S]*?max-height:\s*min\(23rem, 34vh\)[\s\S]*?overflow:\s*auto/, "release target option lists should scroll when many packages are eligible");
assert.match(css, /\.release-dialog-success \{ color: var\(--ctp-green\); \}/, "release confirmation should color publish/update lines as success");
assert.match(css, /\.release-dialog-danger \{ color: var\(--ctp-red\); \}/, "release confirmation should color blocked/error lines as danger");

assert.match(app, /const MOBILE_VIEW_QUERY = "\(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)"/, "mobile detection should include phones that report desktop-like layout widths");
assert.match(app, /const SIDE_PANEL_OVERLAY_QUERY = "\(max-width: 1050px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\)"/, "side-panel overlay mode should also activate at the stacked narrow layout breakpoint");
assert.match(app, /function isSidePanelOverlayView\(\)[\s\S]*sidePanelOverlayMedia\?\.matches/, "side-panel overlay detection should be separate from full mobile mode");
assert.match(app, /const overlay = isControlDeckOverlayPresentation\(\);[\s\S]*?const showBackdrop = !collapsed && overlay;/, "side-panel backdrop should show for the overlay presentation, not only phone layouts");
// Intent preserved for legacy; v2 suppresses this legacy surface writer.
assert.match(app, /function restoreSidePanelState\(\) \{\n\s+if \(isMobileShellV2Active\(\)\) return;\n\s+if \(isControlDeckOverlayPresentation\(\)\) \{\n\s+setSidePanelCollapsed\(true, \{ persist: false \}\);/, "legacy side-panel should start collapsed in narrow overlay mode");
assert.match(app, /function bindSidePanelOverlayViewChanges\(\)/, "side-panel overlay breakpoint changes should be monitored separately from full mobile changes");
assert.match(app, /if \(isSidePanelOverlayView\(\) && !document\.body\.classList\.contains\("side-panel-collapsed"\)\)/, "Escape should close the side-panel overlay at narrow widths");
assert.match(app, /const THEME_STORAGE_KEY = "pi-webui-theme"/, "theme selection should be persisted in browser storage");
assert.match(app, /const CUSTOM_BACKGROUND_STORAGE_KEY = "pi-webui-custom-background"/, "custom backgrounds should keep a legacy persistent browser storage key for migration");
assert.match(app, /const CUSTOM_BACKGROUNDS_STORAGE_KEY = "pi-webui-custom-backgrounds"/, "custom backgrounds should be persisted per theme in browser storage");
assert.match(app, /const CUSTOM_BACKGROUND_IDB_NAME = "pi-webui-custom-background"/, "custom backgrounds should prefer IndexedDB persistence for large images");
assert.match(app, /const SIDE_PANEL_SECTION_STORAGE_KEY = "pi-webui-side-panel-sections-collapsed"/, "side-panel section collapse state should be persisted in browser storage");
assert.match(app, /const AGENT_DONE_NOTIFICATIONS_STORAGE_KEY = "pi-webui-agent-done-notifications"/, "agent-done notification preference should be persisted in browser storage");
assert.match(app, /const TERMINAL_TABS_LAYOUT_STORAGE_KEY = "pi-webui-terminal-tabs-layout"/, "terminal-tabs layout preference should be persisted in browser storage");
assert.match(app, /document\.body\.classList\.toggle\("terminal-tabs-left", next === "left"\)/, "terminal-tabs layout should toggle a body class for CSS layout");
assert.match(app, /terminalTabsLayoutSelect\.addEventListener\("change"/, "terminal-tabs layout selector should update the browser layout immediately");
assert.match(app, /async function initializeThemes\(\)/, "frontend should initialize bundled themes");
assert.match(app, /api\("\/api\/themes", \{ scoped: false \}\)/, "baseline theme loading should remain backward-compatible with the unscoped themes endpoint");
assert.match(app, /async function refreshThemeCatalog\(tabContext = activeTabContext\(\)\)[\s\S]*api\("\/api\/themes", \{ tabId: tabContext\.tabId \}\)/, "custom project theme discovery should refresh against the active tab context");
assert.match(app, /function applyTheme\(theme/, "frontend should apply a selected theme to CSS variables");
assert.match(html, /id="themeCustomizeButton"[^>]*aria-controls="themeCustomizerDialog"/, "mobile theme controls should expose the accessible customizer launcher");
assert.match(css, /@media \(max-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*\.theme-customizer-dialog \{[\s\S]*width: 100vw[\s\S]*height: var\(--visual-viewport-height, 100dvh\)[\s\S]*\.theme-token-grid,[\s\S]*grid-template-columns: minmax\(0, 1fr\)/, "theme customizer should become a one-column visual-viewport-height editor on phones and coarse pointers");
assert.match(css, /\.theme-customizer-scroll \{[\s\S]*overflow-y: auto/, "the 51-token mobile customizer should scroll internally");
assert.match(css, /\.theme-token-swatch \{[^}]*width: 44px[^}]*height: 44px/, "theme color pickers should preserve 44px touch targets");
assert.match(app, /const LOCAL_BACKGROUND_IMAGE_PATTERN = /, "frontend should restrict theme background images to local static URLs");
assert.match(app, /"--theme-background-image": themeExportCssValue\(theme, "backgroundImage", "none", LOCAL_BACKGROUND_IMAGE_PATTERN\)/, "frontend should apply theme export background images to CSS variables");
assert.match(app, /applyCustomBackgroundOverride\(\{ render: false \}\);/, "theme changes should preserve the user's custom background override");
assert.match(app, /function customBackgroundThemeKey\(themeName = currentThemeName\)/, "custom background persistence should be keyed by the active theme");
assert.match(app, /async function setCustomBackgroundFromFile\(file\)/, "frontend should load side-panel background image files");
assert.match(app, /persistCustomBackground\(background, themeName\)/, "side-panel background changes should save under the selected theme");
assert.match(app, /clearStoredCustomBackground\(themeName, \{ includeLegacy: true \}\)/, "side-panel X button should remove only the selected theme background while clearing legacy state");
assert.match(app, /await loadCustomBackgroundForTheme\(theme\.name/, "theme switching should load that theme's saved custom background");
assert.match(app, /URL\.createObjectURL\(file\)/, "custom backgrounds should apply through short blob URLs instead of huge CSS data URLs");
assert.match(app, /function dataUrlToBlob\(dataUrl\)/, "saved custom backgrounds should be restored from persisted data URLs into blob URLs");
assert.match(app, /async function clearCustomBackground\(\)/, "frontend should support removing the custom background");
assert.match(app, /backgroundClearButton\.addEventListener\("click"/, "side-panel X button should clear the custom background");
assert.match(app, /initializeCustomBackground\(\)\.catch/, "startup should restore the saved custom background when theme loading fails");
assert.match(app, /Restart Web UI to load themes/, "frontend should explain when a stale server cannot serve the themes endpoint");
assert.match(app, /themeSelect\.addEventListener\("change"/, "side-panel theme selector should switch themes immediately");
assert.match(app, /open \? "Close remote access" : "Open for remote access"/, "network button should use explicit remote-access labels for open and close actions");
assert.match(app, /let networkStatusLoaded = false;/, "Remote WebUI QR auto-popup state should track the first loaded network status");
assert.match(app, /const hadNetworkStatus = networkStatusLoaded;[\s\S]*if \(!hadNetworkStatus\) \{\n\s+remoteQrAutoPopupShown = true;\n\s+return;\n\s+\}[\s\S]*if \(!wasOpen && !remoteQrAutoPopupShown && isLocalWebuiBrowserOrigin\(\)\)/, "Remote WebUI QR should auto-open only after network access transitions open, not on initial refresh");
assert.match(app, /remoteAuthToggle: \$\("#remoteAuthToggle"\)/, "Remote WebUI controls should bind the remote PIN auth toggle");
assert.match(html, /id="networkControlField"[^>]*hidden/, "Remote WebUI browser controls should be hidden until the optional package is loaded and enabled");
assert.match(html, /id="showRemoteQrButton"[^>]*hidden>Open QR-Code<\/button>/, "Remote WebUI side-panel controls should include the Open QR-Code button");
assert.doesNotMatch(css, /#networkControlField\s+#showRemoteQrButton\s*\{[^}]*display:\s*none/, "Remote WebUI styles should not override the Open QR-Code button's runtime visibility");
assert.match(app, /showRemoteQrButton\.hidden = !open;[\s\S]*?showRemoteQrButton\.disabled = rebinding \|\| !open;[\s\S]*?showRemoteQrButton\.textContent = "Open QR-Code";/, "Open QR-Code should keep the existing remote-open and rebinding availability rules");
assert.match(app, /showRemoteQrButton\?\.addEventListener\("click", \(\) => showRemoteWebuiQrPopupFromNetwork\(\)/, "Open QR-Code should open the existing Remote WebUI QR popup");
assert.match(app, /remoteWebuiCommand\(enable \? "authOn" : "authOff"/, "remote PIN auth toggle should dispatch through the Remote WebUI package command");
assert.match(server, /webuiSettingsFile,[\s\S]*from "\.\.\/lib\/git-workflow-preferences\.mjs"/, "server should use the shared Pi Web UI settings persistence module");
assert.match(server, /const persistedStartupSettings = await readWebuiSettings\(undefined, \{ reportInvalidOutputMode: true \}\);[\s\S]*?let persistedRemoteAuthEnabled = persistedStartupSettings\.remoteAuthEnabled === true;/, "server should load the saved Remote PIN auth preference before startup");
assert.match(server, /if \(remoteAuthStartupEnabled\(\)\) enableRemoteAuth\(remoteAuthStartupReason\(\)\)/, "saved Remote PIN auth preference should enable auth on startup");
assert.match(server, /await saveRemoteAuthPreference\(true\)/, "enabling Remote PIN auth should persist the on preference");
assert.match(server, /await saveRemoteAuthPreference\(false\)/, "disabling Remote PIN auth should persist the off preference");
assert.match(server, /function pinFromHash\(\)[\s\S]*new URLSearchParams\(String\(window\.location\.hash \|\| ""\)\.replace\(\/\^#\/, ""\)\)/, "remote auth page should read QR-provided PINs from the URL fragment");
assert.match(server, /window\.history\.replaceState\(null, "", window\.location\.pathname \+ \(window\.location\.search \|\| ""\)\)/, "remote auth page should scrub fragment PINs from the address bar before authenticating");
assert.match(app, /remoteWebuiCommand\(open \? "close" : "open"/, "network open\/close button should dispatch through the Remote WebUI package command");
assert.match(app, /piVersionButton: \$\("#piVersionButton"\)/, "frontend should bind the Control Deck Pi version button");
assert.match(app, /webuiVersionButton: \$\("#webuiVersionButton"\)/, "frontend should bind the Control Deck Web UI version button");
assert.match(app, /webuiDevBadge: \$\("#webuiDevBadge"\)/, "frontend should bind the Control Deck dev badge");
assert.match(app, /function openPiReleaseNotes\(\)[\s\S]*api\("\/api\/pi-release-notes", \{ scoped: false \}\)[\s\S]*renderMarkdown\(elements\.piReleaseNotesBody/, "Pi version button should load and render release notes in the popup");
assert.match(app, /const PI_WEBUI_NPM_URL = "https:\/\/www\.npmjs\.com\/package\/@firstpick\/pi-package-webui"/, "Web UI version button should target the package's public npm page");
assert.match(app, /async function confirmOpenWebuiNpmPage\(\)[\s\S]*appConfirm\([\s\S]*confirmLabel: "Open npm"[\s\S]*openWebuiNpmPageInNewTab\(\)/, "Web UI version button should ask before opening npm in a new tab");
assert.match(app, /function refreshWebuiVersion\(\)[\s\S]*api\("\/api\/health", \{ scoped: false \}\)[\s\S]*setWebuiVersion\(health\.webuiVersion\)[\s\S]*setPiVersion\(health\.piVersion\)[\s\S]*setWebuiDevServer\(isWebuiDevMetadata\(health\)\)/, "frontend should load Pi version, Web UI version, and dev mode from health metadata");
assert.match(app, /case "webui_connected":[\s\S]*setWebuiVersion\(event\.version\)[\s\S]*setPiVersion\(event\.piVersion\)[\s\S]*setWebuiDevServer\(isWebuiDevMetadata\(event\)\)/, "frontend should refresh Pi version, Web UI version, and dev mode from reconnect events");
assert.match(server, /url\.pathname === "\/api\/pi-release-notes"[\s\S]*piReleaseNotes\(\)/, "server should expose release notes for the available Pi update or the installed fallback");
assert.match(server, /PI_RELEASES_PAGE_BASE_URL = "https:\/\/github\.com\/earendil-works\/pi\/releases\/tag"/, "release-note links should target the official Pi GitHub release page");
assert.match(server, /const webuiDevServer = isTruthyEnv\(process\.env\.PI_WEBUI_DEV\) \|\| isSourceCheckout\(packageRoot\)/, "server should derive dev mode from PI_WEBUI_DEV or a source checkout");
assert.match(server, /webuiDev: webuiDevServer,[\s\S]*webuiMode: webuiDevServer \? "dev" : "production"/, "server status should expose Web UI dev mode");
assert.match(server, /type: "webui_connected",[\s\S]*webuiDev: webuiDevServer,[\s\S]*webuiMode: webuiDevServer \? "dev" : "production"/, "SSE connect event should expose Web UI dev mode");
assert.match(server, /async function validateStartupCwd\(cwd\)/, "server should validate startup cwd before spawning Pi");
assert.match(server, /--cwd does not exist:/, "server should report nonexistent startup cwd paths clearly");
assert.match(server, /options\.cwd = await validateStartupCwd\(options\.cwd\)/, "server should fail fast for invalid startup cwd paths");
assert.match(server, /cwdExplicit: false/, "server should track whether startup cwd was explicitly requested");
assert.match(server, /return options\.cwdExplicit \? \[await createTab\(\)\] : \[\]/, "server should wait for UI cwd selection when no --cwd is supplied");
assert.match(server, /async function resolvedPiCliScript\(\)[\s\S]*require\.resolve\.paths\(PI_CODING_AGENT_PACKAGE\)[\s\S]*nodeModulesRoot[\s\S]*dist[\s\S]*cli\.js/, "server should resolve the bundled Pi CLI through Node resolution roots so hoisted global installs can spawn RPC tabs");
assert.match(server, /canonicalPiRuntimeIdentity[\s\S]*bundledCli: await resolvedPiCliScript\(\)/, "standalone server should use the canonical resolver with the bundled Pi CLI before PATH pi");
assert.match(server, /resolveCanonicalPiRuntime\([\s\S]*explicitCommand: options\.piBinExplicit \? options\.piBin : ""[\s\S]*bundledCli/, "updates should resolve the same canonical explicit or bundled Pi identity used by tabs");
assert.match(app, /serverActionSelect\.addEventListener\("change", updateServerActionButton\)/, "Server action dropdown should control the guarded run button");
assert.match(app, /runServerActionButton\.addEventListener\("click"[\s\S]*runSelectedServerAction/, "Server action run button should execute the selected action");
assert.match(app, /api\("\/api\/restart", \{ method: "POST", scoped: false \}\)/, "Restart Server action should call the unscoped restart endpoint");
assert.match(app, /setServerActionStatus\(message, "warn"\);\n\s+setServerRestartOverlay\(true, message\)/, "Restart Server action should show reconnect progress in the side panel and loading overlay");
assert.match(app, /const showOfflinePanel = backendOffline && !serverRestartInProgress/, "intentional restart should suppress the generic offline shell while reconnecting");
assert.match(app, /api\("\/api\/shutdown", \{ method: "POST", scoped: false \}\)/, "Stop Server action should call the unscoped shutdown endpoint");
assert.match(server, /url\.pathname === "\/api\/restart" && req\.method === "POST"/, "server should expose restart endpoint");
assert.match(server, /PI_WEBUI_RESTORE_FILE: restore\.file/, "server restart should pass tab metadata through a private read-once restore file");
assert.match(server, /if \(webuiDevServer\) env\.PI_WEBUI_DEV = "1";/, "server restart should explicitly preserve dev mode");
assert.match(server, /url\.pathname === "\/api\/update\/plan"[\s\S]*createServerOwnedUpdatePlan/, "server should expose exact server-owned update planning");
assert.match(server, /url\.pathname === "\/api\/update\/apply"[\s\S]*validateUpdateApplyRequest[\s\S]*applyServerOwnedUpdate/, "server should apply only a transaction id and plan digest");
assert.match(server, /Legacy update mutation is disabled/, "divergent legacy update mutation routes should fail closed");
assert.doesNotMatch(server, /function resolveUpdateTasks|function projectPackageRootUpdateTasks|function npmGlobalPackageRootUpdateTask|function bunGlobalPackageRootUpdateTask/, "broad heuristic package-root mutation should be removed");
assert.match(app, /Exact immutable plan digest:[\s\S]*persisted exact-target plan[\s\S]*will not re-resolve latest or scan package roots/, "frontend confirmation should bind users to the exact plan digest and fail-closed scope");
assert.match(app, /api\("\/api\/update\/apply", \{ method: "POST", body: \{ transactionId: plan\.transactionId, planDigest: plan\.digest \}/, "frontend should apply only the confirmed transaction and digest");
assert.match(html, /<option value="update-all">/, "side panel should retain a combined update action while routing through exact plans");
assert.match(readme, /exact-target plan|plan digest/i, "README should document exact update plans");
assert.match(server, /async function closeNetworkAccess\(\)/, "server should expose a local-only rebind helper for closing network access");
assert.match(server, /url\.pathname === "\/api\/network\/close" && req\.method === "POST"/, "server should route network close requests");
assert.match(server, /server\.closeAllConnections\?\.\(\)/, "network rebind should force-close long-lived clients so close-to-localhost can complete");
assert.match(server, /connection: "close"/, "network rebind API responses should not hold keep-alive sockets open");
assert.match(technical, /toggles to "Close for network"/, "technical reference should document the close-network toggle");
assert.match(app, /window\.visualViewport/, "app should listen to VisualViewport for keyboard/viewport updates");
assert.match(html, /<textarea id="promptInput"[^>]*autofocus/, "prompt composer should autofocus for new Web UI/app launches");
assert.match(app, /function syncMobileChatToBottomForInput\(\)/, "mobile input focus should force the output view to the latest message");
assert.match(app, /function updateMobileDropdownScrollBounds\(\)[\s\S]*--mobile-dropdown-max-height/, "mobile dropdowns should compute a viewport-bounded scroll height when opened");
assert.match(app, /function setAppRunnerMenuOpen\(open\)[\s\S]*scheduleMobileDropdownScrollBoundsUpdate\(\)/, "app-runner dropdown opening should refresh mobile scroll bounds");
assert.match(app, /function setOptionsMenuOpen\(open\)[\s\S]*scheduleMobileDropdownScrollBoundsUpdate\(\)/, "Options dropdown opening should refresh mobile scroll bounds");
assert.match(app, /function focusPromptInput\(\{ defer = false \} = \{\}\)/, "frontend should focus the prompt composer programmatically after tab/app startup");
assert.match(app, /async function switchTab\(tabId\)[\s\S]*?restoreActiveDraft\(\);\n\s+focusPromptInput\(\{ defer: true \}\);/, "switching to a newly opened tab should focus the prompt input immediately");
assert.match(app, /async function initializeTabs\(\)[\s\S]*?restoreActiveDraft\(\);[\s\S]*if \(!loadedTabs\.length\)[\s\S]*focusPromptInput\(\{ defer: true \}\);/, "starting the Web UI should prompt for cwd when needed and focus active tabs");
assert.match(app, /resizePromptInput\(\);\nclearRemovedSidePanelSectionHeightState\(\);\nrestoreDurableUiLayoutPendingJournal\(\);\nrestoreSidePanelWidthPreference\(\);\nrestoreFileViewerWidthPreference\(\);\nrestoreTerminalTabsSidebarWidthPreference\(\);\nfocusPromptInput\(\{ defer: true \}\);\nrestoreStoredSkillUsage\(\);\nrestoreBusyPromptBehaviorSetting\(\);\nsyncMobileComposerDisclosureLayout\(\);\nupdateComposerModeButtons\(\);/, "startup should clear retired section-height state, restore resizable panel preferences, request prompt focus, and restore skill tags before waiting for tab state refreshes");
assert.match(app, /elements\.promptInput\.addEventListener\("focus", \(\) => \{\n\s+syncMobileChatToBottomForInput\(\);/, "focusing mobile input should scroll output to bottom");
assert.match(app, /navigator\.serviceWorker\.register\("\/service-worker\.js"\)/, "PWA service worker should be registered by the app");
assert.match(app, /function serverStartCommandText\(\)[\s\S]*return `pi-webui\$\{currentPortArg\(\)\}`/, "PWA/offline shell should build a pathless pi-webui recovery command");
assert.match(app, /async function createFirstTerminalTabFromChosenDirectory\(\)/, "frontend should define the first-terminal cwd prompt");
assert.match(app, /async function initializeTabs\(\)[\s\S]*?if \(!saved\.length\) await createFirstTerminalTabFromChosenDirectory\(\)/, "frontend should still prompt for the first terminal cwd when no saved workspace can be loaded");
assert.match(app, /Choose CWD for first terminal/, "frontend should title the first-terminal cwd picker clearly");
assert.match(app, /Pi Web UI server is offline/, "PWA/offline shell should clearly report backend-down state");
assert.match(app, /navigator\.clipboard\.writeText\(text\)/, "backend-offline recovery panel should copy the start command when possible");
assert.match(app, /function messageCopyText\(message, body = null\)/, "frontend should derive copy text from transcript messages");
assert.match(app, /function attachMessageCopyButton\(bubble, message, body\)/, "frontend should add copy controls to rendered transcript cards");
assert.match(app, /button\.append\(make\("span", "message-copy-icon", "⧉"\)\)/, "message copy buttons should render as icon-only controls");
assert.match(app, /copyMessageBubble\(button\)/, "message copy buttons should copy through the shared clipboard helper");
assert.match(app, /function attachMarkdownCodeCopyButton\(wrapper, label = "Copy"\)/, "frontend should add copy controls to markdown code blocks");
assert.match(app, /function copyMarkdownCodeBlock\(button\)[\s\S]*?await copyText\(text\)/, "markdown code block copy controls should use the shared clipboard helper");
assert.match(app, /attachMarkdownCodeCopyButton\(wrapper\);/, "normal fenced code blocks should get copy buttons");
assert.match(app, /attachMarkdownCodeCopyButton\(wrapper, "Copy source"\);/, "rendered Mermaid blocks should expose source copy buttons");
assert.match(css, /\.markdown-code-copy-button \{[\s\S]*?position:\s*absolute/, "markdown code blocks should expose positioned copy buttons");
assert.match(css, /\.markdown-code-block\.has-code-copy-action > \.code-block \{[\s\S]*?padding-top:/, "code block copy buttons should reserve vertical space above source text");
assert.match(app, /retryServerConnectionButton.*retryServerConnection/s, "backend-offline recovery panel should wire a retry action");
assert.match(app, /function isChatNearBottom\(/, "chat should detect whether the user is reading above the bottom");
assert.match(app, /function scheduleChatFollowScroll\(/, "chat auto-follow should retry after layout settles during fast streaming");
assert.match(app, /function setChatScrollTopInstant\(top\)[\s\S]*?scrollBehavior = "auto"/, "chat auto-follow should bypass smooth scrolling while chasing fast output");
assert.match(app, /function syncAutoFollowFromChatScroll\(/, "programmatic scroll events should not accidentally disable auto-follow");
assert.match(app, /elements\.chat\.addEventListener\("wheel", noteChatUserScrollIntent/, "manual wheel scrolling should still be able to pause auto-follow");
assert.match(app, /function stripAnsi\(text\)/, "widget rendering should strip ANSI color escapes before display");
assert.match(app, /\(\?:\\x1B\|\\u241B\)/, "ANSI stripping should handle literal escape characters and visible escape glyphs");
assert.match(app, /function renderAnsiText\(parent, text\)/, "extension dialogs should render ANSI-colored TUI text as browser spans");
assert.match(app, /function applyAnsiSgr\(codes, state\)/, "ANSI SGR color state should be parsed for dialog rendering");
assert.match(app, /function normalizeDialogPrompt\(request\)/, "extension dialogs should split multiline prompts into title and body");
assert.match(app, /plainMessage: stripAnsi\(message\)/, "dialog prompt parsing should keep a plain-text copy for detection and visibility");
assert.match(app, /function releaseDialogPromptParts\(prompt\)/, "release confirmation dialogs should promote the publish question into the dialog title");
assert.match(app, /Publish to AUR/, "release confirmation dialogs should also recognize AUR publish prompts");
assert.match(app, /function renderReleaseDialogMessage\(parent, text\)/, "release confirmation dialogs should semantically color summary lines");
assert.match(app, /else renderAnsiText\(elements\.dialogMessage, displayPrompt\.message\)/, "non-release dialog prompts should preserve TUI highlight colors in the browser");
assert.match(app, /elements\.dialog\.classList\.toggle\("guardrail-dialog", isGuardrailDialog\)/, "guardrail extension dialogs should get dedicated styling");
assert.match(app, /elements\.dialog\.classList\.toggle\("release-dialog", isReleaseDialog\)/, "release extension dialogs should get dedicated roomy styling");
assert.match(app, /release-publish-action/, "release dialogs should distinguish the publish confirmation button");
assert.match(app, /guardrail-safe-action/, "guardrail dialogs should distinguish safe and allow actions");
assert.match(app, /function hasQueuedDialogRequest\(id\)/, "frontend should deduplicate replayed extension UI dialogs by request id");
assert.match(app, /if \(request\.replayed\) addEvent\(`recovered pending \$\{request\.method\} request`, "warn"\)/, "frontend should surface replayed extension UI blockers");
assert.match(app, /case "webui_extension_ui_cancelled":/, "frontend should close dialogs cancelled by backend abort handling");
assert.match(app, /case "webui_extension_ui_resolved":[\s\S]*?removeQueuedDialogRequests\(\[event\.id\]\)/, "frontend should close dialogs resolved by another connected browser");
assert.match(app, /if \(responseId && activeDialog && String\(activeDialog\.id \|\| ""\) !== responseId\) return;/, "dialog response cleanup should not close the next queued dialog after a resolve-event race");
assert.match(app, /if \(runIndicatorIsActive\(\)\) \{\s*setRunIndicatorActivity\("Continuing after your response…"\);[\s\S]*?scheduleRefreshState\(120, tabContext\);\s*\}/, "extension UI responses should promptly reconcile canonical state so background release commands cannot leave a stale running indicator");
assert.match(app, /function parseTodoProgressWidget\(lines\)/, "todo-progress widgets should be parsed from extension widget lines");
assert.ok(app.includes("const goalLine = cleanLines.find((line) => /^Goal\\s*[:：]/i.test(line));"), "todo-progress parser should preserve an optional Goal line from extension widget lines");
assert.ok(app.includes("if (todo.goal) summary.append(make(\"div\", \"todo-widget-goal\", `Goal: ${todo.goal}`));"), "todo-progress widget should display the goal above the progress header");
assert.match(app, /const todoProgressWidgetExpandedByTab = new Map\(\)/, "todo-progress expansion state should survive widget re-renders per tab");
assert.match(app, /const todoProgressSignatureByTab = new Map\(\)/, "todo-progress should track per-tab signatures to avoid unchanged re-renders");
assert.match(app, /function widgetRequestEquivalent\(a, b\)[\s\S]*?return a\.widgetLines\.every/, "todo-progress and generic widgets should no-op identical widget payloads");
assert.match(app, /todoProgressSignatureByTab\.get\(tabId\) === signature\) return false/, "live todo-progress sync should skip unchanged checklist signatures");
assert.match(app, /const node = make\("details", "widget todo-widget"\)/, "todo-progress widget should render collapsed by default as expandable details");
assert.match(app, /Optional feature detection intentionally checks loaded Pi capabilities/, "optional Web UI features should be detected through loaded capabilities, not package folders");
assert.match(app, /function resetOptionalFeatureAvailability\(\)/, "optional feature state should reset across active-tab and reload boundaries");
assert.match(app, /function renderOptionalFeaturePanel\(\)/, "side panel should render optional feature installed/enabled state");
assert.match(app, /const OPTIONAL_FEATURE_SECTIONS = \[[\s\S]*label: "Composer & commands"[\s\S]*label: "Workflows & releases"[\s\S]*label: "Safety & access"[\s\S]*label: "UI widgets & native parity"[\s\S]*featureIds: \[[^\]]*"questionnaire"[\s\S]*label: "Conversation"/, "optional features should be grouped into five type subsections with questionnaires under native parity");
assert.match(app, /function renderOptionalFeatureSection\(section, features\)[\s\S]*optional-feature-section[\s\S]*optional-feature-section-title[\s\S]*optional-feature-section-list/, "optional feature panel should render subsection headers and lists");
assert.match(app, /async function refreshQuestionnaireFeatureAvailability[\s\S]*\/api\/tools\?scope=session[\s\S]*tool\?\.name === "questionnaire"/, "questionnaire availability should be detected from the active Pi tab's loaded tool capability");
assert.match(app, /async function setToolManagedOptionalFeatureEnabled\(feature, enabled\)[\s\S]*\/api\/tools\?scope=session[\s\S]*enabledTools[\s\S]*scope: "session"[\s\S]*\/api\/tools/, "the questionnaire row toggle should update the active session tool allowlist while preserving other tool states");
assert.match(app, /detected && feature\.manageWith === "tools"[\s\S]*action\.textContent = enabled \? "Disable" : "Enable"[\s\S]*setToolManagedOptionalFeatureEnabled/, "loaded questionnaire access should expose a dedicated enable or disable action");
assert.match(app, /if \(detected && feature\.setup\)[\s\S]*"optional-feature-action setup", "Setup"[\s\S]*openOptionalFeatureSetup/, "detected configurable optional features should expose a separate Setup action");
assert.match(app, /case "skills": return openNativeSkillsSelector\(\)/, "TUI Skills command Setup should open the browser-native Skills Setup dialog");
assert.match(app, /case "tools": return openNativeToolsSelector\(\)/, "TUI Tools command Setup should open the browser-native Tools Setup dialog");
assert.match(app, /function setSidePanelSectionCollapsed\(record, collapsed/, "side panel sections should have explicit collapse/expand behavior");
assert.match(
  app,
  /function setOnlySidePanelSectionExpanded\(targetRecord,[\s\S]*?setSidePanelSectionCollapsed\(record, record\.id !== targetId, \{ persist: false \}\);[\s\S]*?persistSidePanelSectionState\(\);/,
  "opening a side-panel section should collapse every other section before persisting",
);
assert.match(
  app,
  /function restoreSidePanelSectionState\(\) \{[\s\S]*?setSidePanelSectionCollapsed\(record, collapsedIds \? collapsedIds\.has\(record\.id\) : true, \{ persist: false \}\);/,
  "side-panel sections should restore independently from the persisted collapsed set and default to collapsed",
);
assert.match(
  app,
  /setSidePanelSectionCollapsed\(record, !record\.section\.classList\.contains\("collapsed"\)\);/,
  "side-panel section toggles should open and close each section independently",
);
assert.match(app, /function renderCodexUsage\(\)/, "frontend should render Codex usage buckets in the side panel");
assert.match(app, /function renderSubagents\(\)[\s\S]*subagentTabsWithRunningAgents\(\)[\s\S]*totalGates[\s\S]*renderSubagentTabGroup\(tab\)/, "frontend should group running subagents and retained retry gates by terminal and session");
assert.match(app, /function renderSubagents\(\)[\s\S]*activeTabs\.reduce\(\(count, tab\) => count \+ Number\(tab\.runningAgents \|\| 0\), 0\)[\s\S]*subagentCountBadge\.textContent = String\(totalAgents\)/, "the subagent count badge should derive visible agent totals without counting workflow containers or retry-gated attempts twice");
const workflowControllerSource = appFunctionSource("subagentIsWorkflowController", "subagentCapabilities");
const workflowRenderSource = appFunctionSource("renderSubagentWorkflow", "renderSubagentAgent");
const compactSubagentAgentSource = appFunctionSource("renderSubagentAgent", "renderSubagentRun");
const compactSubagentRunSource = appFunctionSource("renderSubagentRun", "subagentGateStatusLabel");
assert.match(workflowControllerSource, /name \|\| ""[\s\S]*launcher === "pi-subagents"[\s\S]*function subagentRunAgents[\s\S]*function subagentRunAgentCounts/, "pi-subagents workflow controllers should be recognized separately from model-powered agents and excluded from agent counts");
const workflowCountContext = {
  subagentAgentStatus(run, agent) { return String(agent?.status || run?.status || "running").toLowerCase(); },
};
vm.runInNewContext(`${workflowControllerSource}\nthis.isWorkflowController = subagentIsWorkflowController; this.workflowAgents = subagentRunAgents; this.workflowCounts = subagentRunAgentCounts;`, workflowCountContext);
const syntheticWorkflowRun = {
  launcher: "pi-subagents",
  status: "running",
  agents: [
    { id: "run:workflow", name: "workflow", status: "running" },
    { id: "run:worker", name: "worker", status: "running", model: "openai-codex/gpt-5.6-sol", thinking: "high" },
  ],
};
assert.equal(workflowCountContext.isWorkflowController(syntheticWorkflowRun, syntheticWorkflowRun.agents[0]), true, "the model-less pi-subagents workflow row should be treated as the workflow controller");
assert.deepEqual(JSON.parse(JSON.stringify(workflowCountContext.workflowAgents(syntheticWorkflowRun).map((agent) => agent.name))), ["worker"], "only actual child agents should remain in the workflow agent list");
assert.deepEqual(JSON.parse(JSON.stringify(workflowCountContext.workflowCounts([syntheticWorkflowRun]))), { total: 1, running: 1, stale: 0 }, "workflow controllers should be count-neutral while their children retain lifecycle counts");
assert.equal(workflowCountContext.isWorkflowController(syntheticWorkflowRun, { name: "workflow", launcher: "pi-subagents", model: "provider/real-model", thinking: "high" }), false, "a real model-powered agent named workflow must remain an agent row");
assert.match(workflowRenderSource, /const status = subagentWorkflowPresentationStatus\(run, agents\);[\s\S]*make\("details", `subagent-workflow[\s\S]*details\.open = !collapsedSubagentWorkflowRunKeys\.has\(key\)[\s\S]*make\("summary", "subagent-workflow-header"\)[\s\S]*renderSubagentAgent\(tab, entry\.run, entry\.agent\)/, "workflow controllers should render as stateful native disclosure headers using the aggregate lifecycle while preserving each child run");
assert.match(compactSubagentAgentSource, /const \[model, thinking\] = subagentExecutionValues\(agent\)[\s\S]*identity\.append\([\s\S]*"subagent-agent-name", name[\s\S]*"subagent-agent-inline-meta", `· \$\{status\} · \$\{model\} · \$\{thinking\}`[\s\S]*row\.append\(dot, identity\)/, "side-panel agent rows should show type, provider\/model, and thinking effort on one compact line");
assert.doesNotMatch(compactSubagentAgentSource, /subagent-agent-meta|subagentExecutionFacts|subagentSourceLabel|subagentRunElapsed|currentTool/, "side-panel agent rows should leave all other execution metadata to the selected subagent view");
assert.doesNotMatch(compactSubagentRunSource, /subagent-run-(?:header|title|meta|state)|`Run \$\{/, "side-panel run groups should not repeat IDs, metadata headers, or state badges");
assert.match(compactSubagentRunSource, /Dismiss finished run[\s\S]*dismissSubagentRun\(tab, run\)/, "compact terminal subagent runs should retain their dismiss action");
assert.match(compactSubagentRunSource, /subagentRunCanCancel\(run\)[\s\S]*Cancel entire subagent run[\s\S]*openSubagentCancelDialog\(tab, run\)/, "compact running subagent runs should retain whole-run cancellation through the shared dialog");
assert.match(app, /function renderSubagentTerminalView\(\)[\s\S]*subagentRunElapsed\(view\.run\)[\s\S]*subagentExecutionFacts\(agent\)[\s\S]*parent \$\{parent\?\.title[\s\S]*run \$\{view\.runId\}/, "the dedicated subagent view should own elapsed, execution, parent, and run details removed from the side panel");
const subagentTerminalViewGroupsSource = appFunctionSource("subagentTerminalViewGroups", "renderSubagentTerminalTab");
const subagentTerminalGroupingContext = vm.createContext({
  subagentTerminalViews: new Map([
    ["a-1", { id: "a-1", parentTabId: "workspace-a", parentTitle: "Workspace A", openedAt: 1 }],
    ["b-1", { id: "b-1", parentTabId: "workspace-b", parentTitle: "Workspace B", openedAt: 2 }],
    ["a-2", { id: "a-2", parentTabId: "workspace-a", parentTitle: "Workspace A", openedAt: 3 }],
  ]),
});
vm.runInContext(`${subagentTerminalViewGroupsSource}\nthis.groupedSubagentViews = subagentTerminalViewGroups();`, subagentTerminalGroupingContext);
assert.deepEqual(JSON.parse(JSON.stringify(subagentTerminalGroupingContext.groupedSubagentViews.map((group) => ({ key: group.key, parentTabId: group.parentTabId, viewIds: group.views.map((view) => view.id) })))), [
  { key: "subagents:workspace-a", parentTabId: "workspace-a", viewIds: ["a-1", "a-2"] },
  { key: "subagents:workspace-b", parentTabId: "workspace-b", viewIds: ["b-1"] },
], "dedicated subagent views should group only with siblings spawned by the same parent workspace");
assert.match(app, /function renderTabs\(\)[\s\S]*const subagentGroups = subagentTerminalViewGroups\(\)[\s\S]*group\.views\.length > 1[\s\S]*renderSubagentTerminalTabGroup\(group\)[\s\S]*renderSubagentTerminalTab\(group\.views\[0\]\)/, "the tab strip should collapse same-workspace subagent siblings while leaving a single view standalone");
const renderSubagentTerminalTabSource = appFunctionSource("renderSubagentTerminalTab", "renderSubagentTerminalTabGroup");
assert.match(renderSubagentTerminalTabSource, /groupItem = false[\s\S]*terminal-tab-group-item[\s\S]*terminal-tab-group-item-button[\s\S]*activateSubagentTerminalView\(view\.id\)/, "subagent tabs should remain individually activatable inside a workspace group menu");
const renderSubagentTerminalTabGroupSource = appFunctionSource("renderSubagentTerminalTabGroup", "openSubagentOutput");
assert.match(renderSubagentTerminalTabGroupSource, /groupViews\.filter\(subagentTerminalViewIsRunning\)[\s\S]*group\.parentTitle[\s\S]*terminal-tab-subagent-group[\s\S]*count: groupViews\.length[\s\S]*renderSubagentTerminalTab\(view, \{ groupItem: true \}\)/, "workspace subagent groups should expose their parent title, aggregate state, count, and child-view menu");
const closeSubagentTerminalGroupStart = app.indexOf("function closeSubagentTerminalGroup(");
const closeSubagentTerminalGroupEnd = app.indexOf("\nasync function copySubagentTerminalOutput(", closeSubagentTerminalGroupStart);
assert.ok(closeSubagentTerminalGroupStart >= 0 && closeSubagentTerminalGroupEnd > closeSubagentTerminalGroupStart, "closeSubagentTerminalGroup should remain a standalone frontend helper");
const closeSubagentTerminalGroupSource = app.slice(closeSubagentTerminalGroupStart, closeSubagentTerminalGroupEnd);
assert.match(closeSubagentTerminalGroupSource, /subagentTerminalViews\.delete\(view\.id\)[\s\S]*renderTabs\(\)/, "closing a workspace subagent group should remove its view tabs as one UI operation");
assert.doesNotMatch(closeSubagentTerminalGroupSource, /cancel|\/api\/subagents/, "closing a workspace subagent group must not stop its child runs");
assert.match(css, /\.subagent-tab-title \{[\s\S]*container-type: inline-size;[\s\S]*flex: 1 1 0;[\s\S]*min-width: 0;[\s\S]*\.subagent-tab-title strong \{[\s\S]*font-size: clamp\(0\.64rem, calc\(0\.5rem \+ 0\.65cqi\), 0\.78rem\);[\s\S]*\.subagent-tab-count \{[\s\S]*flex: 0 0 auto;[\s\S]*white-space: nowrap;/, "subagent titles should scale with their available inline width while summary badges stay fixed and text can still truncate");
assert.match(css, /\.subagent-agent-list \{[\s\S]*gap: 0\.16rem;[\s\S]*\.subagent-agent-row \{[\s\S]*min-height: 1\.75rem;[\s\S]*background: transparent;[\s\S]*\.subagent-agent-identity \{[\s\S]*display: flex;[\s\S]*white-space: nowrap;[\s\S]*\.subagent-agent-inline-meta \{[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;[\s\S]*\.subagent-run \{[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;[\s\S]*border: 0;/, "the inline subagent monitor should keep type, model, and effort in compact rows without overflow");
assert.match(css, /\.subagent-workflow \{[\s\S]*\.subagent-workflow-header \{[\s\S]*list-style: none;[\s\S]*\.subagent-workflow:not\(\[open\]\)[\s\S]*\.subagent-workflow-agents \{[\s\S]*border-left:/, "workflow disclosures should have a distinct collapsible header and visually nested child-agent section");
assert.match(app, /function renderSubagentOverlayWidget\(\)[\s\S]*openSubagentCancelDialog\(selection\.tab, selection\.run, agent\)[\s\S]*subagent-overlay-cancel-action/, "running overlays should route cancel through the shared dialog");
assert.match(app, /subagentTerminalCancelButton[\s\S]*openSubagentCancelDialog\(view\.tab \|\| \{ tabId: view\.parentTabId, tabTitle: view\.parentTitle \}, view\.run, view\.data\?\.agent \|\| view\.agent\)/, "running terminal headers should route cancel through the shared dialog");
assert.match(app, /function openSubagentCancelDialog\(tab, run, agent = null\)[\s\S]*agentCount[\s\S]*The entire run will be stopped[\s\S]*subagentCancelDialog\.showModal\(\)[\s\S]*async function submitSubagentCancel\(\)[\s\S]*api\("\/api\/subagents\/cancel", \{[\s\S]*method: "POST",[\s\S]*scoped: false,[\s\S]*group: selection\.groupId,[\s\S]*runId: selection\.runId/, "the shared cancel dialog should honestly describe and submit whole-run cancellation with optional reason/note data");
assert.doesNotMatch(app, /body: \{\n\s+tab: selection\.tabId,\n\s+runId: selection\.runId,\n\s+\.\.\.\(selection\.agentId/, "the frontend must not imply unsupported per-agent cancellation in its request contract");
assert.match(app, /async function dismissSubagentRun\(tab, run\)[\s\S]*api\("\/api\/subagents\/dismiss", \{[\s\S]*method: "POST",[\s\S]*scoped: false,[\s\S]*body: \{ group: tab\.groupId, runId: run\.id \}/, "finished-run dismiss controls should call the owning group endpoint");
assert.match(app, /function finishedSubagentRunSelections\(data = latestSubagents\)[\s\S]*subagentRunIsTerminal\(run\) && subagentRunCanDismiss\(run\)[\s\S]*async function clearFinishedSubagentRuns\(\{ automatic = false \} = \{\}\)[\s\S]*for \(const selection of selections\)[\s\S]*api\("\/api\/subagents\/dismiss", \{[\s\S]*body: \{ group: selection\.groupId, runId: selection\.runId \}[\s\S]*subagentsClearFinishedButton\.disabled = subagentsLoading \|\| subagentsClearingFinished \|\| finishedRuns\.length === 0/, "clear-finished should dismiss visible terminal ordinary runs while preserving retry-gated, active, and workflow runs");
assert.match(app, /subagentsAutoClearButton\?\.addEventListener\("click", \(\) => \{[\s\S]*setSubagentAutoClearEnabled\(!subagentAutoClearEnabled, \{ announce: true \}\)/, "the Auto-Clear button should toggle the selected browser preference");
assert.match(app, /SUBAGENT_AUTO_CLEAR_STORAGE_KEY = "pi-webui-subagent-auto-clear"[\s\S]*function readStoredSubagentAutoClearEnabled\(\)[\s\S]*localStorage\.getItem\(SUBAGENT_AUTO_CLEAR_STORAGE_KEY\) === "1"[\s\S]*function setSubagentAutoClearEnabled[\s\S]*clearFinishedSubagentRuns\(\{ automatic: true \}\)[\s\S]*restoreSubagentAutoClearSetting\(\)/, "Auto-Clear should persist per browser and immediately clear already-finished ordinary runs when selected");
assert.match(app, /async function refreshSubagents\(\)[\s\S]*refreshed = true[\s\S]*refreshed && subagentAutoClearEnabled && finishedSubagentRunSelections\(\)\.length[\s\S]*await clearFinishedSubagentRuns\(\{ automatic: true \}\)/, "successful overview refreshes should await guarded auto-clear when terminal runs appear");
assert.match(app, /subagentsClearFinishedButton\?\.addEventListener\("click", \(\) => \{[\s\S]*clearFinishedSubagentRuns\(\)/, "the clear-finished button should invoke the guarded bulk dismissal action");
assert.match(css, /\.subagents-status-row \{[\s\S]*display: flex;[\s\S]*\.subagents-auto-clear-button,[\s\S]*\.subagents-clear-finished-button \{[\s\S]*min-height: 2rem;[\s\S]*\.subagents-auto-clear-button\[aria-pressed="true"\]/, "the clear controls should share a compact row with a visible Auto-Clear selected state");
const clearFinishedSourceStart = app.indexOf("function finishedSubagentRunSelections(");
const clearFinishedSourceEnd = app.indexOf("\nfunction subagentOverlayTranscriptMessages(", clearFinishedSourceStart);
assert.ok(clearFinishedSourceStart >= 0 && clearFinishedSourceEnd > clearFinishedSourceStart, "clear-finished helpers should remain independently testable");
const clearFinishedCalls = [];
const clearFinishedEvents = [];
let clearFinishedRefreshes = 0;
const clearFinishedContext = {
  latestSubagents: {
    tabs: [
      { tabId: "tab-a", runs: [{ id: "done-a", status: "done", source: "async" }, { id: "running-a", status: "running", source: "async" }, { id: "workflow-a", status: "done", source: "workflow" }, { id: "gated-a", status: "done", source: "async" }], gates: [{ attempts: [{ runId: "gated-a" }] }] },
      { tabId: "tab-b", runs: [{ id: "failed-b", status: "failed", source: "foreground" }, { id: "cancelled-b", status: "cancelled", source: "async" }] },
    ],
  },
  ungatedSubagentRuns(tab) {
    const gatedRunIds = new Set((tab.gates || []).flatMap((gate) => (gate.attempts || []).map((attempt) => attempt.runId)));
    return (tab.runs || []).filter((run) => !gatedRunIds.has(run.id));
  },
  // Mirror the production overview shape: one group per tab with `groupId: tab:<id>` and ungated display runs.
  subagentOverviewGroups(data) {
    return (data?.tabs || []).map((tab) => ({ ...tab, groupId: `tab:${tab.tabId}`, displayRuns: clearFinishedContext.ungatedSubagentRuns(tab) }));
  },
  subagentRunIsTerminal(run) { return ["done", "failed", "cancelled"].includes(run?.status); },
  subagentRunCanDismiss(run) { return clearFinishedContext.subagentRunIsTerminal(run) && run?.source !== "workflow"; },
  subagentsClearingFinished: false,
  subagentsLoading: false,
  refreshSubagentsTimer: null,
  clearTimeout() {},
  renderSubagents() {},
  async api(path, options) { clearFinishedCalls.push({ path, options }); },
  async refreshSubagents() { clearFinishedRefreshes += 1; },
  scheduleRefreshSubagents() {},
  addEvent(message, level, options = {}) { clearFinishedEvents.push({ message, level, options }); },
};
vm.runInNewContext(`${app.slice(clearFinishedSourceStart, clearFinishedSourceEnd)}\nthis.runClearFinishedSubagentRuns = clearFinishedSubagentRuns;`, clearFinishedContext);
await clearFinishedContext.runClearFinishedSubagentRuns();
assert.deepEqual(JSON.parse(JSON.stringify(clearFinishedCalls)), [
  { path: "/api/subagents/dismiss", options: { method: "POST", scoped: false, body: { group: "tab:tab-a", runId: "done-a" } } },
  { path: "/api/subagents/dismiss", options: { method: "POST", scoped: false, body: { group: "tab:tab-b", runId: "failed-b" } } },
  { path: "/api/subagents/dismiss", options: { method: "POST", scoped: false, body: { group: "tab:tab-b", runId: "cancelled-b" } } },
], "clear-finished should call the existing dismiss endpoint only for visible terminal ordinary runs");
assert.equal(clearFinishedRefreshes, 1, "clear-finished should refresh the overview once after all dismissals");
assert.equal(clearFinishedContext.subagentsClearingFinished, false, "clear-finished should always release its in-flight guard");
assert.deepEqual(clearFinishedEvents, [{ message: "cleared 3 finished subagent runs", level: "info", options: {} }]);
clearFinishedContext.latestSubagents = { tabs: [{ tabId: "tab-c", runs: [{ id: "done-c", status: "done", source: "async" }] }] };
await clearFinishedContext.runClearFinishedSubagentRuns({ automatic: true });
assert.deepEqual(JSON.parse(JSON.stringify(clearFinishedEvents.at(-1))), {
  message: "auto-cleared",
  level: "info",
  options: {
    aggregateKey: "subagent-auto-clear",
    aggregateIncrement: 1,
    aggregateSingular: "finished subagent run",
    aggregatePlural: "finished subagent runs",
  },
}, "automatic clearing should use one keyed event whose cleared-run counter can accumulate");
const addEventSource = appFunctionSource("addEvent", "closeEventTreeContextMenu");
assert.match(addEventSource, /eventAggregateKey === stableAggregateKey[\s\S]*eventAggregateCount[\s\S]*priorAggregate\?\.remove\(\)[\s\S]*eventLog\.prepend\(line\)/, "keyed events should replace their prior row, retain a cumulative count, and return to the top of the log");
assert.match(addEventSource, /aggregateCount === 1 \? aggregateSingular : aggregatePlural/, "aggregate rows should keep singular and plural summaries accurate");
const aggregateEventLog = {
  children: [],
  prepend(node) {
    node.parent = this;
    this.children.unshift(node);
  },
  get lastElementChild() { return this.children.at(-1) || null; },
};
function aggregateEventNode(_tag, className = "", text = "") {
  return {
    className,
    dataset: {},
    children: [],
    attributes: {},
    textContent: text,
    classList: { contains: (value) => className.split(/\s+/).includes(value) },
    append(...children) {
      this.children.push(...children);
      this.textContent += children.map((child) => child?.textContent || "").join("");
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    addEventListener() {},
    remove() {
      if (!this.parent) return;
      this.parent.children = this.parent.children.filter((child) => child !== this);
      this.parent = null;
    },
  };
}
const aggregateEventContext = {
  elements: { eventLog: aggregateEventLog },
  make: aggregateEventNode,
  applyEventFilter() {},
  jumpToChatEvent() {},
  showNoticeToast() {},
  noteUnreadEvent() {},
};
vm.runInNewContext(`${addEventSource}\nthis.runAddEvent = addEvent;`, aggregateEventContext);
const aggregateOptions = {
  aggregateKey: "subagent-auto-clear",
  aggregateIncrement: 1,
  aggregateSingular: "finished subagent run",
  aggregatePlural: "finished subagent runs",
};
aggregateEventContext.runAddEvent("auto-cleared", "info", aggregateOptions);
aggregateEventContext.runAddEvent("unrelated event", "info");
aggregateEventContext.runAddEvent("auto-cleared", "info", { ...aggregateOptions, aggregateIncrement: 2 });
assert.equal(aggregateEventLog.children.length, 2, "repeated keyed events should occupy one row alongside unrelated events");
assert.equal(aggregateEventLog.children[0].dataset.eventAggregateCount, "3", "the keyed row should accumulate the supplied run counts");
assert.equal(aggregateEventLog.children[0].children[0].children[1].textContent, "auto-cleared 3 finished subagent runs", "the keyed row should show its current cumulative count");
assert.equal(aggregateEventLog.children[1].children[0].children[1].textContent, "unrelated event", "updating a keyed row should not remove unrelated history");
assert.match(app, /function materializeRetainedSubagentTerminalViews\(\)[\s\S]*subagentOverviewGroups\(\)[\s\S]*restoreKey = `\$\{tab\.tabId\}\\u0000\$\{tab\.sessionFile[\s\S]*tab\.displayRuns[\s\S]*\["queued", "running", "stale"\]\.includes\(subagentAgentStatus\(run\)\)[\s\S]*ensureSubagentTerminalView/, "terminal mode should materialize only ungated restored retained agent views once per parent session identity without touching overlay mode");
assert.match(app, /from "\.\/subagent-launch-slot-state\.mjs"[\s\S]*function renderSubagentLaunchSlots\(\)[\s\S]*function loadSubagentLaunchSlotConfig\([\s\S]*\/api\/subagents\/config/, "launch-slot configuration should have its own browser state and API loader");
assert.match(app, /function subagentLaunchSlotThinkingForModel\(model\)[\s\S]*modelThinkingLevels/, "launch-slot thinking choices should come from the selected model metadata");
assert.match(app, /function renderSubagentLaunchSlotCard\(role, slots\)[\s\S]*Default \/ inherit[\s\S]*"Add slot"[\s\S]*Remove/, "role cards should render independent same-role slots and inheritance controls");
assert.match(app, /async function saveSubagentLaunchSlotConfig[\s\S]*scope: subagentLaunchSlotScope,[\s\S]*revision: subagentLaunchSlotConfig\.revision,[\s\S]*body\.roles = cloneLaunchSlotRoles[\s\S]*async function reloadActiveTabForSubagentLaunchSlots[\s\S]*sendPrompt\("prompt", "\/reload"/, "launch-slot saves should be revision checked and offer active-tab reload through the existing path");
assert.match(app, /const subagentLaunchSlotReloadTabs = new Set\(\)[\s\S]*subagentLaunchSlotReloadTabs\.add\(activeTabId\)[\s\S]*subagentLaunchSlotReloadTabs\.delete\(activeTabId\)/, "reload-required reminders should survive tab switches until that tab is actually reloaded");
const subagentOverviewRefreshSource = appFunctionSource("refreshSubagents", "scheduleRefreshSubagents");
assert.doesNotMatch(subagentOverviewRefreshSource, /subagentLaunchSlot/, "live subagent polling must not recreate or reset the launch-slot editor");
assert.match(app, /function renderSubagentGateAttempt\(tab, attempt\)[\s\S]*subagent-gate-attempt-name[\s\S]*subagent-gate-attempt-meta[\s\S]*function renderSubagentGate\(tab, gate\)[\s\S]*"Retry gate"[\s\S]*qualifyingSuccesses/, "frontend should render compact gate identity rows and a minimal quorum summary");
const subagentGateTargetSource = appFunctionSource("subagentGateAttemptTarget", "subagentGateAttemptExecutionValues");
const subagentGateExecutionSource = appFunctionSource("subagentGateAttemptExecutionValues", "openSubagentGateAttemptOutput");
const subagentGateOpenSource = appFunctionSource("openSubagentGateAttemptOutput", "renderSubagentGateAttempt");
const subagentGateAttemptSource = appFunctionSource("renderSubagentGateAttempt", "renderSubagentGate");
assert.match(subagentGateTargetSource, /candidate\?\.id === attempt\.runId[\s\S]*candidate\?\.name === attempt\.agent[\s\S]*agents\.length === 1[\s\S]*return agent\?\.id && subagentRunCanOpen\(run, agent\) \? \{ run, agent \} : null/, "retry-gate attempts should resolve their ordinary tracked child run and agent");
assert.match(subagentGateExecutionSource, /SETTINGS_THINKING_OPTIONS\.includes\(suffix\)[\s\S]*model = model\.slice\(0, suffixIndex\)[\s\S]*model = `\$\{provider\}\/\$\{model\}`/, "compact gate rows should normalize provider, model, and thinking effort");
assert.match(subagentGateAttemptSource, /const target = subagentGateAttemptTarget\(tab, attempt\)[\s\S]*subagentGateAttemptExecutionValues\(attempt\)[\s\S]*attempt\?\.status[\s\S]*retrySafety[\s\S]*subagent-gate-attempt-open/, "compact gate rows should retain title, state, provider\/model, thinking effort, type, and open affordance");
assert.doesNotMatch(subagentGateAttemptSource, /attempt\?\.phase|failureKind|attempt\?\.error|`run \$\{attempt/, "compact gate rows should move verbose diagnostics out of the side panel");
assert.match(subagentGateOpenSource, /openSubagentOutput\(tab, \{ \.\.\.target\.run, gateAttempt: attempt \}, target\.agent\)/, "opening a gate child should hand its detailed attempt metadata to the standard child output path");
assert.match(app, /function subagentGateAttemptViewFacts\(attempt\)[\s\S]*gate attempt[\s\S]*phase[\s\S]*failure[\s\S]*gate error[\s\S]*function subagentOverlayStateFacts[\s\S]*subagentGateAttemptViewFacts\(subagentOverlaySelection\?\.gateAttempt\)[\s\S]*function renderSubagentTerminalView[\s\S]*subagentGateAttemptViewFacts\(view\.gateAttempt\)/, "attempt number, phase, failure class, and error should appear only inside the opened child view");
assert.match(app, /function openSubagentOverlay\(tab, run, agent\)[\s\S]*gateAttempt: run\.gateAttempt \|\| null[\s\S]*function ensureSubagentTerminalView\(tab, run, agent\)[\s\S]*gateAttempt: run\.gateAttempt \|\| null/, "overlay and terminal child views should retain gate diagnostics");
assert.match(app, /function renderSubagentGate\(tab, gate\)[\s\S]*renderSubagentGateAttempt\(tab, attempt\)/, "retry-gate rendering should retain the owning parent tab needed to open child output");
assert.match(css, /button\.subagent-gate-attempt \{ cursor: pointer; \}[\s\S]*button\.subagent-gate-attempt:hover,[\s\S]*button\.subagent-gate-attempt:focus-visible[\s\S]*\.subagent-gate-attempt-open/, "openable retry-gate attempts should expose button hover, keyboard-focus, and arrow affordances");
const subagentGateTargetContext = { subagentRunCanOpen: () => true };
vm.runInNewContext(`${subagentGateTargetSource}\nthis.resolveSubagentGateAttempt = subagentGateAttemptTarget;`, subagentGateTargetContext);
const gateTargetTab = {
  tabId: "parent-tab",
  groupId: "tab:parent-tab",
  displayRuns: [
    { id: "review-run", agents: [{ id: "review-agent", name: "reviewer" }, { id: "scout-agent", name: "scout" }] },
    { id: "single-run", agents: [{ id: "single-agent", name: "delegate" }] },
  ],
};
assert.equal(subagentGateTargetContext.resolveSubagentGateAttempt(gateTargetTab, { runId: "review-run", agent: "reviewer" })?.agent?.id, "review-agent", "gate attempts should select the matching agent in their tracked run");
assert.equal(subagentGateTargetContext.resolveSubagentGateAttempt(gateTargetTab, { runId: "single-run", agent: "reviewer" })?.agent?.id, "single-agent", "single-child gate runs should remain openable if display names differ");
assert.equal(subagentGateTargetContext.resolveSubagentGateAttempt(gateTargetTab, { runId: "missing-run", agent: "reviewer" }), null, "a gate attempt should remain non-interactive until its tracked run is available");
const subagentGateExecutionContext = { SETTINGS_THINKING_OPTIONS: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] };
vm.runInNewContext(`${subagentGateExecutionSource}\nthis.resolveSubagentGateExecution = subagentGateAttemptExecutionValues;`, subagentGateExecutionContext);
assert.deepEqual(JSON.parse(JSON.stringify(subagentGateExecutionContext.resolveSubagentGateExecution({ provider: "openrouter", model: "openrouter/moonshotai/kimi-k3:high" }))), ["openrouter/moonshotai/kimi-k3", "high"], "gate rows should split a thinking suffix from a fully qualified model");
assert.deepEqual(JSON.parse(JSON.stringify(subagentGateExecutionContext.resolveSubagentGateExecution({ provider: "openrouter", model: "moonshotai/kimi-k3:medium" }))), ["openrouter/moonshotai/kimi-k3", "medium"], "gate rows should add a separately reported provider without duplicating it");
assert.match(helper, /async function enrichAsyncSubagentAgent\(run, agent, statusByDir\)[\s\S]*status\.json[\s\S]*agent\.model = subagentModel\(step\.model\)[\s\S]*agent\.thinking = subagentThinking\(step\.thinking\)/, "WebUI helper should enrich async children from effective lifecycle model and reasoning metadata");
assert.match(helper, /SUBAGENT_GATE_UPDATE_EVENT[\s\S]*function publicSubagentGates\(\)[\s\S]*failureKind[\s\S]*gates = publicSubagentGates\(\)/, "WebUI helper should publish bounded retry-gate lifecycle data");
assert.match(extension, /registerSubagentGate\(pi\)[\s\S]*session_shutdown[\s\S]*subagentGate\.dispose\(\)/, "the WebUI package extension should own the retry-gate tool lifecycle without another extension package");
assert.match(server, /function normalizeWebuiSubagentPayload\(value\)[\s\S]*model: normalizeWebuiSubagentText\(rawAgent\.model, 240\)[\s\S]*thinking: normalizeWebuiSubagentText\(rawAgent\.thinking, 40\)/, "server should bound model and reasoning metadata in the cross-tab overview");
assert.match(server, /WEBUI_SUBAGENT_GATE_LIMIT[\s\S]*rawGate\.attempts[\s\S]*failureKind: normalizeWebuiSubagentText\(rawAttempt\.failureKind, 80\)[\s\S]*totalGates/, "server should bound retry gates and expose their cross-tab total");
assert.match(server, /function normalizeWebuiSubagentOutput\(value, selection\)[\s\S]*model: normalizeWebuiSubagentText\(rawAgent\.model, 240\)[\s\S]*thinking: normalizeWebuiSubagentText\(rawAgent\.thinking, 40\)/, "server should preserve model and reasoning metadata in selected child output");
assert.match(server, /function normalizeWebuiSubagentSource\(value\) \{[\s\S]*\["foreground", "workflow", "recovered"\]\.includes\(value\)[\s\S]*function normalizeWebuiSubagentPayload\(value\)[\s\S]*const source = normalizeWebuiSubagentSource\(rawRun\.source\)[\s\S]*function normalizeWebuiSubagentOutput\(value, selection\)[\s\S]*source: normalizeWebuiSubagentSource\(selection\.run\?\.source \|\| value\.source\)/, "server should preserve workflow source in overview and selected-output normalization");
assert.match(app, /function subagentExecutionValues\(agent = \{\}\)[\s\S]*model\.slice\(suffixIndex \+ 1\)\.toLowerCase\(\) === thinking\.toLowerCase\(\)[\s\S]*return \[model \|\| "unknown", thinking \|\| "unknown"\][\s\S]*function subagentExecutionFacts\(agent = \{\}\)[\s\S]*model \$\{model\}[\s\S]*reasoning \$\{thinking\}/, "subagent metadata should share honest model\/reasoning values, strip duplicate effort suffixes, and retain unknown fallbacks");
assert.match(app, /function subagentSourceLabel\(source = ""\) \{[\s\S]*source === "foreground" \|\| source === "workflow"[\s\S]*function subagentOverlayStateFacts\(data = subagentOverlayData\)[\s\S]*subagentSourceLabel\(data\?\.source \|\| run\.source\)[\s\S]*function renderSubagentTerminalView\(\)[\s\S]*subagentSourceLabel\(view\.data\?\.source \|\| view\.run\?\.source\)[\s\S]*function renderSubagentTerminalTab\(view, \{ groupItem = false \} = \{\}\)[\s\S]*subagentSourceLabel\(view\.data\?\.source \|\| view\.run\?\.source\)/, "one source-label helper should keep overlays and virtual tabs honest after inline metadata is removed");
assert.match(compactSubagentAgentSource, /subagentExecutionValues\(agent\)/, "Subagents side-panel rows should reuse the normalized model and reasoning values shown in selected output views");
assert.match(app, /function subagentOverlayStateFacts\(data = subagentOverlayData\)[\s\S]*\.\.\.subagentExecutionFacts\(agent\)/, "subagent overlays should show model and reasoning effort");
assert.match(app, /function renderSubagentTerminalView\(\)[\s\S]*\.\.\.subagentExecutionFacts\(agent\)/, "dedicated subagent terminal views should show model and reasoning effort");
assert.match(app, /SUBAGENT_OPEN_MODE_STORAGE_KEY = "pi-webui-subagent-open-mode"[\s\S]*function normalizeSubagentOpenMode\(value\)[\s\S]*function restoreSubagentOpenModeSetting\(\)/, "subagent opening mode should default safely and persist in this browser");
assert.match(app, /function openSubagentOutput\(tab, run, agent\) \{[\s\S]*subagentOpenMode === "tab" \? openSubagentTerminal\(tab, run, agent\) : openSubagentOverlay\(tab, run, agent\)/, "clicking an agent should dispatch to the selected overlay or terminal-tab view");
assert.match(app, /function openSubagentOverlay\(tab, run, agent\)[\s\S]*activeSubagentTerminalId[\s\S]*deactivateSubagentTerminalView\(\{ render: false \}\)[\s\S]*activeTabId !== tab\.tabId[\s\S]*await switchTab\(tab\.tabId\)[\s\S]*renderWidgets\(\)/, "opening an overlay should first leave any virtual child tab, then switch to its owning terminal before rendering the widget");
assert.match(app, /function renderWidgets\(\)[\s\S]*renderAppRunnerWidget\(\)[\s\S]*renderSubagentOverlayWidgetSafely\(\)/, "subagent output should render in the shared non-blocking top widget area after App Runner");
assert.doesNotMatch(app, /subagentOverlayDialog\.showModal|elements\.subagentOverlayDialog/, "subagent output should not open or depend on a modal dialog");
assert.match(app, /api\(`\/api\/subagents\/output\?\$\{query\}`, \{ scoped: false \}\)/, "subagent overlay should fetch selected live output from the owning tab");
assert.match(app, /function subagentRunIndicatorActivity\(agent = \{\}\)[\s\S]*currentToolArgs[\s\S]*activityState[\s\S]*function appendSubagentRunIndicator\(parent,[\s\S]*run-indicator-pulse[\s\S]*Agent is running:[\s\S]*subagent-run-indicator-elapsed[\s\S]*updateSubagentRunIndicatorElapsed\(parent, run\)/, "running child output should show the main-style pulse, current tool or activity, and separately refreshed elapsed runtime");
assert.match(app, /const facts = \[[\s\S]*view\.finished \? "finished" : running \? `running\$\{elapsed/, "retained completed child views should not keep contradictory running header metadata and live views should include elapsed time");
assert.match(app, /function renderSubagentTerminalView\(\)[\s\S]*if \(running\) appendSubagentRunIndicator\(elements\.subagentTerminalTranscript, \{ agent, run: view\.run \}\)/, "the dedicated child tab should append a live run indicator whenever the selected child is running");
const subagentTerminalSignatureSource = appFunctionSource("subagentTerminalViewMeaningfulSignature", "updateSubagentTerminalRefreshState");
const subagentTerminalRefreshSource = appFunctionSource("refreshSubagentTerminalView", "deactivateSubagentTerminalView");
assert.ok(subagentTerminalRefreshSource.includes("group: view.groupId, run: view.runId, agent: view.agentId"), "subagent terminal refresh should stay scoped to the child and its owning parent terminal");
assert.ok(subagentTerminalRefreshSource.includes("view.finished = true"), "an open child tab should retain its last snapshot after the run is no longer tracked");
assert.ok(subagentTerminalRefreshSource.includes("previousSignature !== subagentTerminalViewMeaningfulSignature(view)"), "automatic child polling should compare meaningful snapshots before rebuilding the transcript");
let unchangedSubagentRenderCount = 0;
let unchangedSubagentTabRenderCount = 0;
let unchangedSubagentElapsedUpdateCount = 0;
const unchangedSubagentView = {
  id: "child-view",
  parentTabId: "parent-tab",
  runId: "run-1",
  agentId: "agent-1",
  data: { updatedAt: 1, agent: { id: "agent-1", status: "running", currentTool: "read" } },
  error: "",
  finished: false,
  loading: false,
  requestSerial: 0,
};
await vm.runInNewContext(`${subagentTerminalSignatureSource}\nasync ${subagentTerminalRefreshSource}\nrefreshSubagentTerminalView("child-view");`, {
  activeSubagentTerminalId: "child-view",
  elements: { subagentTerminalTranscript: {} },
  subagentTerminalViews: new Map([["child-view", unchangedSubagentView]]),
  URLSearchParams,
  api: async () => ({ data: { updatedAt: 2, agent: { id: "agent-1", status: "running", currentTool: "read" } } }),
  renderSubagentTerminalView() { unchangedSubagentRenderCount += 1; },
  renderTabs() { unchangedSubagentTabRenderCount += 1; },
  updateSubagentRunIndicatorElapsed() { unchangedSubagentElapsedUpdateCount += 1; },
  updateSubagentTerminalRefreshState() { throw new Error("background polls must not announce routine loading state"); },
});
assert.equal(unchangedSubagentRenderCount, 0, "an unchanged background poll should preserve the existing transcript DOM");
assert.equal(unchangedSubagentTabRenderCount, 0, "an unchanged background poll should not rebuild terminal tabs");
assert.equal(unchangedSubagentElapsedUpdateCount, 1, "an unchanged background poll should refresh only the existing visual elapsed-time node");
assert.equal(unchangedSubagentView.loading, false, "an unchanged background poll should still clear its internal loading flag");
const subagentTerminalCloseStart = app.indexOf("function closeSubagentTerminalTab(");
const subagentTerminalCloseEnd = app.indexOf("\nfunction closeSubagentTerminalGroup(", subagentTerminalCloseStart);
assert.ok(subagentTerminalCloseStart >= 0 && subagentTerminalCloseEnd > subagentTerminalCloseStart, "closeSubagentTerminalTab should remain a standalone frontend helper");
const subagentTerminalCloseSource = app.slice(subagentTerminalCloseStart, subagentTerminalCloseEnd);
assert.ok(subagentTerminalCloseSource.includes("subagentTerminalViews.delete(viewId)"), "closing a subagent tab should remove only its client-side view record");
assert.doesNotMatch(subagentTerminalCloseSource, /\bapi\(|closeTerminalTabs\(|closeSubagentOverlay\(/, "closing a subagent tab must not call backend terminal or subagent lifecycle APIs");
assert.match(app, /function renderSubagentTerminalTab\(view, \{ groupItem = false \} = \{\}\)[\s\S]*terminal-tab-subagent[\s\S]*subagent: true[\s\S]*closeSubagentTerminalTab\(view\.id\)/, "standalone and grouped virtual tabs should be marked as subagents and retain a view-only close action");
assert.match(app, /function subagentTerminalViewId\(tab, run, agent\)[\s\S]*JSON\.stringify\(\[tab\?\.tabId[\s\S]*run\?\.id[\s\S]*agent\?\.id/, "virtual child tabs should be uniquely keyed by parent terminal, run, and child agent");
assert.match(app, /SUBAGENT_OVERLAY_REFRESH_MS = 1000/, "subagent overlay should poll selected live output at a fast cadence");
const createMessageBubbleSource = appFunctionSource("createMessageBubble", "appendMessage");
const appendMessageSource = appFunctionSource("appendMessage", "appendOptimisticUserPrompt");
assert.match(createMessageBubbleSource, /renderContent\(body, message\.content, \{ markdown: message\.role === "assistant" \|\| message\.role === "custom" \}\)/, "the reusable message bubble renderer must retain Markdown-capable main output");
assert.match(appendMessageSource, /reuseToolExecutionBubble[\s\S]*createMessageBubble\(message, \{ \.\.\.options, segmentId \}\)[\s\S]*appendChatMessageBubble/, "main transcript output should reuse stable tool cards before creating and appending a fresh message bubble");
const subagentTranscriptMessagesSource = appFunctionSource("subagentOverlayTranscriptMessages", "subagentOverlayToolArguments");
assert.ok(subagentTranscriptMessagesSource.includes("message.role === \"assistant\" || message.role === \"toolResult\""), "subagent overlays should retain structured assistant and tool-result entries");
const subagentToolArgumentsSource = appFunctionSource("subagentOverlayToolArguments", "subagentOverlayTranscriptDisplayMessages");
assert.ok(subagentToolArgumentsSource.includes("JSON.parse(value)"), "structured tool arguments should be restored for specialized tool renderers");
const subagentDisplaySource = appFunctionSource("subagentOverlayTranscriptDisplayMessages", "subagentOverlayTranscriptOutputLines");
assert.ok(subagentDisplaySource.includes("const toolResults = buildToolResultMap(messages);"), "subagent rendering should pair calls with the shared result lookup");
assert.ok(subagentDisplaySource.includes("role: \"toolExecution\""), "paired subagent calls should use main-transcript toolExecution cards");
assert.ok(subagentDisplaySource.includes("const result = toolResults.get(displayMessage.toolCallId) || null;") && subagentDisplaySource.includes("          result,"), "incomplete subagent tool calls should remain pending tool cards");
assert.ok(subagentDisplaySource.includes("if (pairedToolCallIds.has(toolResultCallId(message))) continue;"), "paired tool results should not render as duplicate generic cards");
const subagentAppendSource = appFunctionSource("appendSubagentOverlayTranscript", "subagentOverlayStateFacts");
assert.ok(subagentAppendSource.includes("subagentOverlayTranscriptDisplayMessages(messages)"), "subagent bubbles should use the paired structured display sequence");
assert.ok(subagentAppendSource.includes("createMessageBubble(displayMessage, { transient: true })"), "subagent bubbles should reuse the main message renderer");
const thinkingVisibilitySource = appFunctionSource("setThinkingOutputVisible", "applyToolOutputExpansionToDom");
assert.ok(thinkingVisibilitySource.includes("if (subagentOverlaySelection?.tabId === activeTabId) renderWidgets();"), "changing thinking visibility should rerender an open subagent overlay transcript, including finished agents");
assert.ok(thinkingVisibilitySource.includes("if (activeSubagentTerminalId) renderSubagentTerminalView();"), "changing thinking visibility should rerender an open subagent terminal transcript, including finished agents");
const subagentCopySource = appFunctionSource("subagentOverlayTranscriptOutputLines", "subagentOverlayOutputLines");
assert.ok(subagentCopySource.includes("messageCopyText(message)"), "global subagent copy should derive from the same structured bubble messages");
const subagentOutputSource = appFunctionSource("subagentOverlayOutputLines", "subagentOverlayOutputText");
assert.ok(subagentOutputSource.includes("if (transcriptMessages.length) return subagentOverlayTranscriptOutputLines(data);"), "global subagent copy should prefer structured transcript content over flattened recent output");
const subagentEmptySource = appFunctionSource("subagentOverlayEmptyTranscriptText", "appendSubagentRunIndicator");
assert.ok(subagentEmptySource.includes("No visible output was captured."), "hidden or non-renderable structured output should have explicit fallback text");
const subagentRenderErrorSource = appFunctionSource("renderSubagentOverlayErrorWidget", "renderSubagentOverlayWidgetSafely");
assert.ok(subagentRenderErrorSource.includes("Subagent output unavailable"), "a failed subagent renderer should show a minimal recoverable widget");
assert.ok(subagentRenderErrorSource.includes("appRunnerActionButton(\"Close\", closeSubagentOverlay"), "the recoverable subagent renderer error widget should provide a Close action");
assert.doesNotMatch(subagentRenderErrorSource, /addEvent\(/, "renderer failures should not create repeated event-log entries while a refresh retries");
const subagentSafeRenderSource = appFunctionSource("renderSubagentOverlayWidgetSafely", "renderSubagentOverlayWidget");
assert.match(subagentSafeRenderSource, /try \{[\s\S]*renderSubagentOverlayWidget\(\)[\s\S]*\} catch \{[\s\S]*renderSubagentOverlayErrorWidget\(\)/, "subagent renderer exceptions should be isolated from the shared widget render pass");
const rendererFallbackSentinel = {};
const rendererContainmentResult = vm.runInNewContext(`${subagentSafeRenderSource}\nrenderSubagentOverlayWidgetSafely();`, {
  renderSubagentOverlayWidget() { throw new Error("fixture renderer failure"); },
  renderSubagentOverlayErrorWidget() { return rendererFallbackSentinel; },
});
assert.equal(rendererContainmentResult, rendererFallbackSentinel, "subagent renderer failures should return the recoverable fallback widget");
const subagentWidgetSource = appFunctionSource("renderSubagentOverlayWidget", "scheduleSubagentOverlayRefresh");
assert.ok(subagentWidgetSource.includes("const visibleFallbackText = !hasStructuredTranscript ? fallbackText : emptyTranscriptFallback;"), "the widget should render a fallback instead of leaving structured-but-hidden output blank");
assert.ok(subagentWidgetSource.includes("if (visibleFallbackText) {"), "the widget should append the nonblank fallback bubble");
assert.ok(subagentWidgetSource.includes("if (running) appendSubagentRunIndicator(output, { agent, run: selection.run });"), "running subagent widgets should append the shared live activity indicator");
assert.match(app, /api\("\/api\/subagents", \{ scoped: false \}\)/, "frontend should refresh the cross-tab subagent overview");
assert.match(app, /SUBAGENTS_ACTIVE_REFRESH_MS = 1500/, "running subagents should receive a fast live refresh cadence");
assert.match(server, /url\.pathname === "\/api\/subagents" && req\.method === "GET"[\s\S]*await webuiSubagentsData\(\)/, "server should await enriched cross-tab running-subagent titles");
assert.match(server, /async function resolveSubagentDisplayTitle\(tab\)[\s\S]*tab\.titleSource !== "auto"[\s\S]*get_messages[\s\S]*message\?\.role === "user"[\s\S]*generatedTabTitleFromPrompt\(extractSessionTextContent\(firstUserMessage\?\.content\)\)/, "existing auto-named subagent groups should recover their longer title from the first user message without relaunching children");
assert.match(server, /const tabSummaries = await Promise\.all\([\s\S]*runs\.length \|\| gates\.length \|\| tab\.webuiAgentRuns\?\.instances\?\.length \? await resolveSubagentDisplayTitle\(tab\) : tab\.title/, "subagent title recovery should run once for visible run and retry-gate groups");
const resolveSubagentDisplayTitleStart = server.indexOf("async function resolveSubagentDisplayTitle(");
const resolveSubagentDisplayTitleEnd = server.indexOf("\nasync function webuiSubagentsData(", resolveSubagentDisplayTitleStart);
assert.ok(resolveSubagentDisplayTitleStart >= 0 && resolveSubagentDisplayTitleEnd > resolveSubagentDisplayTitleStart, "subagent display-title recovery should remain independently testable");
const recoveredSubagentTitle = "Workspace files webui files section sidepanel dynamically adjusted";
let subagentTitleMessageReads = 0;
const resolveSubagentDisplayTitleContext = vm.createContext({
  TAB_ACTIVITY_STATE_RECONCILE_TIMEOUT_MS: 1200,
  safeRpcResponse: async () => {
    subagentTitleMessageReads += 1;
    return { data: { messages: [{ role: "user", content: recoveredSubagentTitle }] } };
  },
  extractSessionTextContent: (content) => String(content || ""),
  generatedTabTitleFromPrompt: (message) => message,
});
vm.runInContext(`${server.slice(resolveSubagentDisplayTitleStart, resolveSubagentDisplayTitleEnd)}\nthis.runResolveSubagentDisplayTitle = resolveSubagentDisplayTitle;`, resolveSubagentDisplayTitleContext);
const legacyAutoNamedTab = { title: "Workspace files webui files section sidepan…", titleSource: "auto" };
assert.equal(await resolveSubagentDisplayTitleContext.runResolveSubagentDisplayTitle(legacyAutoNamedTab), recoveredSubagentTitle, "existing auto-named rows should recover the wider title from their parent conversation");
assert.equal(await resolveSubagentDisplayTitleContext.runResolveSubagentDisplayTitle(legacyAutoNamedTab), recoveredSubagentTitle, "recovered titles should remain available to later panel refreshes");
assert.equal(subagentTitleMessageReads, 1, "title recovery should read the existing parent conversation once and must not require spawning another subagent");
assert.match(server, /url\.pathname === "\/api\/subagents\/output" && req\.method === "GET"[\s\S]*canonicalWebuiSubagentOutputData\(groupId, runId, agentId\)[\s\S]*webuiSubagentOutputData\(getRequestedTab\(req, url\), runId, agentId\)/, "server should expose selected running subagent output only through its owning group or tab");
assert.match(server, /rememberWebuiSubagentsStatusEvent\(tab, event\)/, "server should ingest the helper's structured subagent status without forwarding internal JSON to the browser footer");
assert.match(server, /PI_RPC_JSONL_LINE_MAX_BYTES = 32 \* 1024 \* 1024/, "Pi RPC JSONL parsing should use an explicit line-size limit with inline-image headroom");
assert.match(server, /function ensureStderrMirrorErrorHandler\(stream\)[\s\S]*stream\.on\("error"/, "Pi stderr mirroring should contain asynchronous closed-sink failures");
assert.match(server, /type: "pi_stdout_line_too_large"[\s\S]*discardingOversizedLine/, "oversized unterminated Pi RPC lines should be discarded until their newline");
assert.match(helper, /SUBAGENT_RPC_REQUEST_EVENT = "subagents:rpc:v1:request"/, "Web UI helper should use pi-subagents' stable status RPC");
assert.match(helper, /case "subagent-output":[\s\S]*subagentOutputSnapshot\(payload\)/, "Web UI helper should return bounded live state and recent output for the selected child agent");
assert.match(helper, /function subagentTranscriptOutput\(sessionFile\)[\s\S]*const empty = \{ recentOutput: \[\], transcript: \[\] \}[\s\S]*transcript: subagentTranscriptMessages\(boundedCandidates\)/, "subagent transcript extraction should return bounded structured entries alongside recentOutput");
assert.match(helper, /line\.trim\(\)\.toLowerCase\(\) === "\(no output\)"/, "subagent transcript extraction should suppress empty tool-result markers");
assert.match(server, /function normalizeWebuiSubagentTranscript\(value\)[\s\S]*remainingParts = WEBUI_SUBAGENT_OUTPUT_LINE_LIMIT[\s\S]*const transcript = normalizeWebuiSubagentTranscript\(rawAgent\.transcript\)/, "server output normalization should preserve the structured transcript under the existing line limit");
assert.match(helper, /SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started"[\s\S]*SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete"/, "Web UI helper should track async subagent lifecycle events");
assert.match(helper, /pi\.on\("tool_execution_start"[\s\S]*event\.toolName !== "subagent"[\s\S]*pi\.on\("tool_execution_end"/, "Web UI helper should track foreground subagent executions");
assert.match(app, /if \(normalized === "prolite"\) return "Usage";/, "Codex Prolite plan labels should display as Usage in the side panel");
assert.match(app, /api\(`\/api\/codex-usage\$\{suffix\}`, \{ scoped: false \}\)/, "Codex usage should load through a server endpoint without browser credentials");
assert.match(app, /restoreSidePanelSectionState\(\);\n[\s\S]{0,200}?bindSidePanelSectionToggles\(\);/, "side panel section state should restore before toggles are bound");
assert.match(app, /OPTIONAL_FEATURES_STORAGE_KEY/, "optional feature disable toggles should persist in browser storage");
assert.match(app, /GIT_FOOTER_WEBUI_STATUS_KEY = "git-footer-webui"/, "git footer Web UI data should be received as an extension-owned status payload");
assert.match(html, /gitFooterVisibilityApplyButton[^>]*>Save globally</, "git footer visibility should state that applied choices persist globally");
assert.match(app, /Changes are saved globally and reused by every Pi session\./, "git footer visibility dialog should explain its global persistence scope");
assert.match(app, /Saved.*global WebUI footer visibility change/, "git footer visibility apply feedback should confirm global persistence");
assert.match(app, /function parseGitFooterWebuiPayloadRaw\(raw\)[\s\S]*GIT_FOOTER_WEBUI_PAYLOAD_TYPE[\s\S]*GIT_FOOTER_WEBUI_PAYLOAD_VERSION/, "Web UI footer should parse the structured payload emitted by git-footer-status");
assert.match(app, /function normalizeFooterPayloadChangedFile\(value\)[\s\S]*FOOTER_CHANGED_FILE_KINDS\.has\(value\.kind\)[\s\S]*oldPath/, "git footer payload parsing should preserve changed-file details for changes popovers");
assert.match(app, /const files = value\.files\.map\(normalizeFooterPayloadChangedFile\)\.filter\(Boolean\)\.slice\(0, 80\);[\s\S]*chip\.files = files;/, "git footer payload chips should retain bounded changed-file lists");
assert.match(app, /FOOTER_PAYLOAD_ACTIONS = new Set\(\["calibrate-current", "calibrate-probe"\]\)[\s\S]*chip\.action = value\.action;/, "git footer payload chips should preserve allowlisted actions such as PI calibration");
assert.match(app, /async function runGitFooterPiCalibration\(tabContext = activeTabContext\(\)\)[\s\S]*resolveAvailableCommandName\("calibrate", \{ rpcOnly: true \}\)[\s\S]*sendPrompt\("prompt", `\/\$\{commandName\}`[\s\S]*scheduleGitFooterPiCalibrationRefresh\(tabContext\)/, "clicking the PI footer chip should dispatch exactly /calibrate and schedule a refreshed footer value");
assert.match(app, /function applyGitFooterPiCalibrationOptions\(chip, options\) \{\s+if \(chip\?\.key !== "pi"\) return "";[\s\S]*void runGitFooterPiCalibration\(\)/, "every PI footer chip should remain clickable regardless of payload calibration action metadata");
assert.doesNotMatch(app.match(/async function runGitFooterPiCalibration[\s\S]*?\n\}/)?.[0] || "", /commandName\} current|appConfirmText/, "PI footer calibration should neither append the current-mode argument nor open a probe confirmation dialog");

assert.match(app, /title: cleanFooterPayloadText\(value\.title, "", 4000\)/, "git footer tooltip titles should preserve long cwd paths instead of truncating at chip display length");
assert.match(app, /const sourceTitle = cleanFooterPayloadText\(chip\?\.title, "", 4000\)/, "git footer tooltip rendering should keep full source titles for long cwd paths");
assert.match(app, /function renderFooter\(\)[\s\S]*parseGitFooterWebuiPayload\(\)[\s\S]*renderGitFooterPayload\(footerPayloadWithLiveModel\(gitFooterPayload\)\)/, "detailed footer rendering should prefer the git-footer-status extension payload");
assert.match(app, /function footerPayloadWithLiveModel\(payload\)[\s\S]*?shortModelLabel\(currentState\.model\)[\s\S]*?footerThinkingDisplay\(\)[\s\S]*?key: "thinking", label: "effort"/, "git footer payload rendering should split model and effort chips from live Web UI state");
assert.match(app, /function footerContextDisplayWithAuto\(value, state = currentState\)[\s\S]*footerAutoCompactionEnabled\(state\)[\s\S]*`\$\{withoutAuto\} \(auto\)`/, "context displays should append the auto-compaction indicator when enabled");
assert.match(app, /function footerPayloadWithLiveModel\(payload\)[\s\S]*const contextChip = \(chip\)[\s\S]*footerContextDisplayWithAuto\(chip\?\.value\)[\s\S]*if \(chip\?\.key === "context"\) return \[contextChip\(chip\)\]/, "git footer context chips should use live Web UI auto-compaction state");
assert.match(app, /async function toggleFooterAutoCompaction\(tabContext = activeTabContext\(\)\)[\s\S]*currentState = \{ \.\.\.currentState, autoCompactionEnabled: enabled \}[\s\S]*api\("\/api\/auto-compaction", \{ method: "POST", body: \{ enabled \}, tabId: tabContext\.tabId \}\)/, "git footer context box should optimistically toggle auto-compaction through the Web UI API");
assert.match(app, /function renderGitFooterPayload\(payload\)[\s\S]*classList\.remove\("statusbar-tui-footer"\)[\s\S]*classList\.add\("statusbar-git-footer"\)[\s\S]*payload\.main\.map\(\(chip\) => renderGitFooterPayloadMetric\(chip, payload\)\)[\s\S]*payload\.meta\.map\(\(chip\) => renderGitFooterPayloadMeta\(chip, tab, payload\)\)/, "enabled git footer payload should use the styled extension chip renderer, not the default TUI line");
assert.match(app, /function ensureFooterTooltipNode\(\)[\s\S]*footer-floating-tooltip[\s\S]*document\.body\.append\(footerTooltipNode\)/, "git footer tooltips should render into a single floating viewport-level node");
const footerTooltipSource = app.match(/function applyFooterTooltip\(node, tooltip, options = \{\}\)[\s\S]*?\n}\n\nfunction footerMetric/)?.[0] || "";
assert.ok(footerTooltipSource, "git footer tooltip application source should be inspectable");
assert.doesNotMatch(footerTooltipSource, /node\.title/, "git footer tooltips should not set native title tooltips in addition to the styled tooltip");
assert.match(app, /const GIT_FOOTER_TOOLTIP_COPY = \{[\s\S]*tokens:[\s\S]*cache:[\s\S]*pi:[\s\S]*speed:[\s\S]*cost:[\s\S]*context:[\s\S]*cwd:[\s\S]*git:[\s\S]*"git-state":[\s\S]*sync:[\s\S]*changes:[\s\S]*"git-extra":[\s\S]*worktree:[\s\S]*model:[\s\S]*thinking:/, "git footer tooltips should explain each known extension footer box including worktrees");
assert.match(app, /function gitFooterPayloadTooltip\(chip, options = \{\}\)[\s\S]*GIT_FOOTER_TOOLTIP_COPY\[key\][\s\S]*`Current: \$\{value\}`/, "git footer tooltips should combine explanations with the current chip value");
assert.match(app, /function isRedundantFooterTooltipTitle\(sourceTitle, chip, value\)[\s\S]*labels\.map\(\(label\) => `\$\{label\}: \$\{value\}`\)/, "git footer tooltips should suppress duplicate label/current title lines");
assert.match(app, /function gitFooterTooltipAlign\(chip\)[\s\S]*\["tokens", "cwd"\][\s\S]*return "start";[\s\S]*\["model", "thinking"\][\s\S]*return "end";/, "git footer tooltip alignment should keep edge boxes readable");
assert.match(app, /function renderGitFooterPayloadMetric\(chip, payload\)[\s\S]*applyGitFooterContextToggleOptions\(chip, options\)[\s\S]*gitFooterPayloadTooltip\(chip, \{ action \}\)[\s\S]*footerMetric\(chip\.icon/, "git footer main payload chips should render as styled metrics with explanatory tooltips and context action support");
assert.match(app, /function applyFooterChangedFilesDropdown\(node, chip, payload\)[\s\S]*gitFooterPayloadVisible\(payload, "webui-changed-files-popover"\)[\s\S]*chip\?\.key !== "changes"[\s\S]*footer-changes-with-files[\s\S]*footer-changed-files-popover/, "git footer changes chip should render a changed-files hover popover when files are present");
assert.match(app, /function insertChangedFilePathReference\(path\)[\s\S]*formatPathReference\(path\)[\s\S]*input\.focus\(\)/, "clicking changed files should insert an @path reference and focus the composer");
assert.match(app, /function renderGitFooterPayloadMeta\(chip, tab, payload\)[\s\S]*options\.title = gitFooterPayloadTooltip\(chip, \{ action \}\)[\s\S]*footerMeta\(chip\.label, chip\.value, footerMetaClassForPayload\(chip\), options\)[\s\S]*applyFooterChangedFilesDropdown\(node, chip, payload\)/, "git footer meta payload chips should render as styled metadata with explanatory tooltips and changes popovers");
assert.match(app, /chip\.key === "git"[\s\S]*setFooterBranchPickerOpen\(!footerBranchPickerOpen\)[\s\S]*Worktree actions are the safe default for parallel work/, "git branch footer chip should open the worktree-aware branch picker");
assert.match(app, /chip\.key === "worktree"[\s\S]*setFooterBranchPickerOpen\(!footerBranchPickerOpen\)[\s\S]*Click to manage branch worktrees/, "worktree footer chip should open the branch worktree picker");
assert.match(app, /function footerPayloadWithLiveModel\(payload\)[\s\S]*const worktreeLabel = gitWorkspaceBadgeLabel\(workspace\)[\s\S]*key: "worktree"/, "git footer payload should inject a live worktree chip from tab metadata");
assert.match(app, /function renderFooterBranchPicker\(\)[\s\S]*Git branches & worktrees[\s\S]*renderFooterWorktreeList\(state\)[\s\S]*renderFooterBranchOption\(branch, state\)/, "git branch picker should render branch worktree controls and local branch choices");
assert.match(app, /function renderFooterBranchOption\(branch, state = footerBranchPickerState\)[\s\S]*openFooterBranchOption\(branch, state\)[\s\S]*footer-branch-advanced-action[\s\S]*applyFooterGitBranch\(branch\.name, \{ switchingKey: branch\.key \}\)/, "branch rows should prefer worktree open/create while keeping an advanced in-place switch action");
const branchPickerRenderKeySource = appFunctionSource("footerBranchPickerRenderKey", "gitFooterPickerStateKey");
const branchPickerKeySandbox = { footerBranchPickerOpen: true, footerBranchPickerState: { loading: true, branches: [] } };
const loadingBranchPickerKey = vm.runInNewContext(`${branchPickerRenderKeySource}\nfooterBranchPickerRenderKey()`, branchPickerKeySandbox);
branchPickerKeySandbox.footerBranchPickerState = { loading: false, branches: [{ name: "main" }] };
const loadedBranchPickerKey = vm.runInNewContext("footerBranchPickerRenderKey()", branchPickerKeySandbox);
assert.notEqual(loadingBranchPickerKey, loadedBranchPickerKey, "branch picker render key should change when asynchronous branch data replaces loading state");
assert.match(appFunctionSource("gitFooterPickerStateKey", "updateGitFooterChipNodeValue"), /footerBranchPickerRenderKey\(\)/, "git footer cache identity should include live branch picker state so the first opening rerenders when loading finishes");
const branchSwitchAvailabilitySource = appFunctionSource("footerBranchSwitchAvailability", "renderFooterBranchOption");
const branchSwitchAvailability = JSON.parse(vm.runInNewContext(`${branchSwitchAvailabilitySource}\nJSON.stringify({
  switching: footerBranchSwitchAvailability({ name: "feat/demo" }, { loading: true, switching: "origin/main" }, ""),
  loading: footerBranchSwitchAvailability({ name: "feat/demo" }, { loading: true, switching: "" }, ""),
  mainWorktree: footerBranchSwitchAvailability({ name: "feat/demo", mainWorktree: true }, {}, "/repo"),
  otherWorktree: footerBranchSwitchAvailability({ name: "feat/demo", mainWorktree: false }, {}, "/repo-worktrees/demo"),
  available: footerBranchSwitchAvailability({ name: "feat/demo" }, {}, ""),
})`));
assert.equal(branchSwitchAvailability.switching.label, "Action running…", "running branch mutations should expose their exact disabled category");
assert.match(branchSwitchAvailability.switching.reason, /origin\/main is still running/, "running branch mutations should name the active branch action");
assert.equal(branchSwitchAvailability.loading.label, "Refreshing…", "branch metadata loading should expose a distinct disabled category");
assert.match(branchSwitchAvailability.loading.reason, /information finishes loading/, "branch metadata loading should explain when switching becomes available");
assert.equal(branchSwitchAvailability.mainWorktree.label, "In main worktree", "main-worktree occupancy should expose a distinct disabled category");
assert.match(branchSwitchAvailability.mainWorktree.reason, /main worktree at \/repo/, "main-worktree occupancy should identify the exact checkout path");
assert.equal(branchSwitchAvailability.otherWorktree.label, "In another worktree", "secondary-worktree occupancy should expose a distinct disabled category");
assert.match(branchSwitchAvailability.otherWorktree.reason, /another worktree at \/repo-worktrees\/demo/, "secondary-worktree occupancy should identify the exact checkout path");
assert.deepEqual(branchSwitchAvailability.available, { disabled: false, label: "Switch here", reason: "" }, "unoccupied idle branches should keep Switch here enabled");
assert.match(app, /function footerGitBranchKey\(item = \{\}\)[\s\S]*return item\.remote \? `remote:\$\{item\.remoteRef\}` : `local:\$\{item\.name\}`/, "remote branch rows should use their exact remote ref, not local name, as their deduplication identity");
assert.match(app, /function normalizeFooterGitBranches\(data = \{\}\)[\s\S]*const remoteRef = cleanFooterPayloadText\(item\?\.remoteRef, "", 4000\);[\s\S]*if \(remote && !remoteRef\) continue;[\s\S]*remoteRef: remote \? remoteRef : "",[\s\S]*remoteName: remote \? cleanStatusText\(item\?\.remoteName\) : "",[\s\S]*displayName: remote \? cleanFooterPayloadText\(item\?\.displayName, remoteRef, 4000\) : name,[\s\S]*const key = footerGitBranchKey\(branch\);[\s\S]*if \(seen\.has\(key\)\) continue;/, "branch normalization should sanitize and retain explicit remote metadata while deduplicating by remote identity");
assert.match(app, /function footerBranchOptionLabel\(branch = \{\}\)[\s\S]*cleanStatusText\(branch\.displayName\) \|\| cleanStatusText\(branch\.name\)/, "remote branch rows should visibly prefer the advertised exact remote ref label");
assert.match(app, /function footerBranchOptionDetail\(branch, state, \{ selected, worktreePath \} = \{\}\)[\s\S]*if \(branch\.remote\) return `remote-only · creates local branch \$\{branch\.name\} tracking \$\{branch\.remoteRef\}`;/, "remote branch rows should visibly describe the local tracking branch they create");
assert.match(app, /function renderFooterBranchOption\(branch, state = footerBranchPickerState\)[\s\S]*remote-only[\s\S]*Remote-only branch \$\{branch\.remoteRef\}: create local branch \$\{branch\.name\} tracking it[\s\S]*Advanced: git switch --track -c \$\{branch\.name\} \$\{branch\.remoteRef\} in this checkout/, "remote branch rows should expose remote-only state and exact-ref tracking actions in visible and accessible text");
assert.match(app, /function openFooterBranchOption\(branch, state = footerBranchPickerState\)[\s\S]*if \(branch\.remote\) return createFooterGitBranchWorktree\(branch\.name, \{ skipConfirm: true, chooseBase: false, remoteRef: branch\.remoteRef/, "remote primary actions should forward the advertised exact remote ref to tracking-worktree creation");
assert.match(app, /async function createFooterGitBranchWorktree\(branch = footerBranchCreateName\(\), \{[\s\S]*const response = trackedRemoteRef[\s\S]*\? await api\("\/api\/git-worktrees", \{ method: "POST", body: \{ branchName, remoteRef: trackedRemoteRef, sessionMode: "fork-current", openTab: false \}, tabId \}\)[\s\S]*: await api\("\/api\/git-worktrees", \{ method: "POST", body: \{ branchName, baseRef, sessionMode: "fork-current", openTab: false \}, tabId \}\)/, "remote and local worktree creation should preserve their exact refs while deferring tab opening until after creation");
assert.match(app, /async function applyFooterGitBranch\(branch, \{[\s\S]*const response = trackedRemoteRef[\s\S]*\? await api\("\/api\/git-branch", \{ method: "POST", body: \{ branch: branchName, create, remoteRef: trackedRemoteRef \}, tabId \}\)[\s\S]*: await api\("\/api\/git-branch", \{ method: "POST", body: \{ branch: branchName, create \}, tabId \}\)/, "remote in-place switching should submit the exact remote ref while local switching retains its request shape");
assert.match(app, /function footerBranchOptionDetail\(branch, state,[\s\S]*state\.switchingKey \? state\.switchingKey === branch\.key[\s\S]*switchingKey: branch\.key/, "branch busy state should use the exact local-or-remote row identity instead of a collision-prone display label");
assert.match(app, /GIT_BRANCH_TYPE_SUGGESTIONS = \["feat", "fix", "change", "perf", "test", "chore", "refactor", "docs", "style", "build", "ci", "revert"\]/, "new branch creation should reuse the conventional type suggestions from /git-staged-msg");
assert.match(app, /function renderFooterBranchCreateForm\(state = footerBranchPickerState\)[\s\S]*footer-branch-create-dropdown-inputfield[\s\S]*footer-branch-type-suggestions[\s\S]*footer-branch-create-input-field[\s\S]*Create branch worktree/, "branch worktree creation should use a styled editable suggestions dropdown plus input field instead of a browser prompt");
assert.match(app, /let footerBranchCreateDraft = \{ type: "", name: "" \}/, "new branch creation should not default the editable type prefix to feat");
assert.match(app, /function footerBranchCreateType\(value = footerBranchCreateDraft\.type\) \{\n\s+return slugifyGitBranchPart\(value\);\n\}/, "branch type suggestions should not restrict or default custom user-entered prefixes");
assert.match(app, /const slash = make\("span", "footer-branch-create-slash", "\/"\)/, "branch creation should visibly separate the prefix and user input with a slash");
assert.match(app, /function gitWorktreeCreateCommandDisplay\(branch, state = footerBranchPickerState, baseRef = "origin\/main"\)[\s\S]*git worktree add -b[\s\S]*preview\.textContent = gitWorktreeCreateCommandDisplay\(branchName \|\| footerBranchCreatePreviewName\(\), state\)/, "branch worktree creation should preview the default origin/main start point");
assert.match(app, /function footerBranchCreateTooltip\(branchName = footerBranchCreateName\(\), state = footerBranchPickerState\)[\s\S]*A branch worktree is a separate checkout for parallel changes\.[\s\S]*origin\/main \(default\)[\s\S]*creates the worktree, then asks whether to open and switch to it in a separate Pi tab[\s\S]*does not switch this tab's branch, commit, push, or delete anything[\s\S]*ignored dependencies such as node_modules or \.venv are not copied/, "create worktree button should explain the base choice and post-creation switch choice");
assert.match(html, /id="gitWorktreeBaseDialog"[\s\S]*id="gitWorktreeBaseOriginMain"[^>]*value="origin\/main" checked[\s\S]*id="gitWorktreeBaseCurrentHead"[^>]*value="HEAD"[\s\S]*id="gitWorktreeBaseCreateButton"/, "worktree creation should present an origin/main-default base picker with a current-HEAD alternative");
assert.match(app, /function chooseGitWorktreeBase\(branch\)[\s\S]*gitWorktreeBaseOriginMain\.checked = true[\s\S]*gitWorktreeBaseCurrentHead\.checked = false/, "the worktree base picker should reset to origin/main for every creation");
assert.match(css, /\.git-worktree-base-option:has\(input:checked\)[\s\S]*border-color:/, "the selected worktree base should be visibly highlighted");
assert.match(app, /submitButton\.dataset\.tooltip = footerBranchCreateTooltip\(branchName\);[\s\S]*submitButton\.removeAttribute\("title"\)/, "create branch button should use the styled tooltip instead of a native title tooltip");
assert.match(css, /\.footer-branch-create-submit\[data-tooltip\]::after \{[\s\S]*?content:\s*attr\(data-tooltip\);[\s\S]*?white-space:\s*pre-wrap;[\s\S]*?overflow-wrap:\s*anywhere;/, "create branch button tooltip should be styled and support detailed multiline copy");
assert.match(app, /submitButton\.disabled = false;[\s\S]*submitButton\.classList\.toggle\("footer-branch-create-submit-disabled", submitDisabled\);[\s\S]*submitButton\.setAttribute\("aria-disabled", submitDisabled \? "true" : "false"\)/, "branch creation should use aria-disabled styling so the tooltip is not dimmed by disabled button opacity");
assert.match(css, /\.footer-branch-create-submit-disabled \{[\s\S]*?cursor:\s*not-allowed;[\s\S]*?color:\s*rgba\(166, 227, 161, 0\.58\);/, "greyed branch create button should use a class instead of disabled opacity");
assert.match(app, /Loading local and fetched remote branches and worktrees… Worktree creation is available once branch data loads\./, "branch picker loading copy should accurately describe local and fetched remote branch metadata");
assert.match(app, /No other local or fetched remote branches available\.[\s\S]*Fetch to list remote branches, or create a branch worktree from origin\/main or the current workspace HEAD to continue\./, "branch picker empty copy should explain how fetched remote branches become available");
assert.match(css, /\.footer-model-picker\.footer-branch-picker \{[\s\S]*?overflow:\s*visible;[\s\S]*?max-height:\s*none;/, "branch picker should not force scrolling just to see the open type suggestions dropdown");
assert.match(css, /\.footer-branch-type-suggestions \{[\s\S]*?grid-template-columns:\s*repeat\(3,[\s\S]*?max-height:\s*none;[\s\S]*?overflow:\s*visible;/, "branch type suggestions should render as a styled multi-column dropdown without internal scrolling");
assert.match(css, /\.footer-branch-option-row \{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) auto/, "branch rows should lay out primary worktree action and advanced switch separately");
assert.match(css, /\.footer-branch-advanced-action:disabled \{[\s\S]*?cursor:\s*not-allowed/, "advanced branch switch action should visibly disable occupied branches");
assert.match(css, /\.footer-worktree \.footer-meta-value,[\s\S]*?\.footer-tui-worktree \{[\s\S]*?color:\s*var\(--ctp-green\)/, "worktree footer chips should have distinct green styling");
assert.match(css, /\.workspace-dashboard-action\.worktree \{[\s\S]*?color:\s*var\(--ctp-green\)/, "workspace dashboard should style the branch worktree action distinctly");
assert.match(app, /const summary = make\("div", "workspace-dashboard-summary-row"\);[\s\S]*summary\.append\(make\("span", "workspace-dashboard-kicker", "Workspace"\), meta\);[\s\S]*const identity = make\("div", "workspace-dashboard-identity"\);[\s\S]*identity\.append\(heading, cwd\);/, "workspace dashboard should group status and identity into two compact rows");
assert.match(css, /\.workspace-dashboard \{[\s\S]*?gap:\s*0\.52rem;[\s\S]*?padding:\s*0\.62rem 0\.78rem 0\.56rem;/, "workspace dashboard shell should use compact desktop spacing");
assert.match(css, /\.workspace-dashboard-metric \{[\s\S]*?min-height:\s*3\.75rem;[\s\S]*?padding:\s*0\.48rem 0\.52rem;/, "workspace dashboard metrics should remain readable without tall cards");
assert.match(css, /@media \(max-width: 720px\) \{[\s\S]*?\.workspace-dashboard-metrics \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}[\s\S]*?@media \(max-width: 480px\) \{\s*\.workspace-dashboard-metrics \{ grid-template-columns: 1fr; \}/, "workspace dashboard metrics should stay compact on tablets and stack on narrow phones");
assert.match(app, /async function createFooterGitBranchWorktree\(branch = footerBranchCreateName\(\)[\s\S]*chooseGitWorktreeBase\(branchName\)[\s\S]*api\("\/api\/git-worktrees", \{ method: "POST", body: \{ branchName, baseRef, sessionMode: "fork-current", openTab: false \}/, "new footer branch worktrees should ask for and submit the selected base ref without opening a tab early");
assert.match(app, /async function confirmSwitchToCreatedFooterGitWorktree\(payload = \{\}, branchName = ""\)[\s\S]*payload\.created !== true[\s\S]*title: "Switch to new worktree\?"[\s\S]*switch to it now\?[\s\S]*confirmLabel: "Switch to worktree"[\s\S]*danger: false/, "newly created worktrees should prompt with a non-danger action before switching tabs");
assert.match(app, /if \(payload\.created\) \{[\s\S]*openWorktreeResponseTab\(response, \{ branchName, action: "create" \}\)[\s\S]*confirmSwitchToCreatedFooterGitWorktree\(payload, branchName\)[\s\S]*openFooterGitWorktree\(worktreePath, \{ branchName, tabContext, skipConfirm: true, announce: false \}\)[\s\S]*\} else \{[\s\S]*openFooterGitWorktree\(worktreePath, \{ branchName, tabContext, skipConfirm: true \}\)/, "creation should switch only after acceptance while existing-worktree results retain automatic opening");
assert.match(app, /async function openFooterGitWorktree\(path,[\s\S]*api\("\/api\/git-worktrees\/open", \{ method: "POST", body: \{ path: worktreePath, sessionMode: "fork-current", openTab: true \}/, "accepted and existing worktree actions should call the worktree open endpoint");
assert.match(app, /elements\.newTabWorktreeButton\?\.addEventListener\("click", \(\) => openBranchWorktreePicker\(\)\)/, "new-tab menu branch worktree item should open the picker");
assert.match(app, /\{ kind: "Git", label: "Branch worktree"[\s\S]*openBranchWorktreePicker\(\)/, "command palette should include branch worktree actions");
assert.match(app, /dashboardAction\("Branch worktree", \(\) => openBranchWorktreePicker\(\), "worktree"\)/, "workspace dashboard should expose a branch worktree action");
assert.match(app, /async function createFooterGitBranch\(branch = footerBranchCreateName\(\)\)[\s\S]*confirmFooterGitBranchAction\(branchName, \{ create: true, requireConfirm: true/, "advanced in-place branch creation should still require confirmation before running git switch -c");
assert.match(app, /function footerBranchAgentWarningLines[\s\S]*WARNING:[\s\S]*still running or waiting for input in this Git working tree/, "branch create/switch confirmation should warn when an agent is active in the current git working tree");
assert.match(app, /if \(footerBranchPickerOpen\) elements\.statusBar\.append\(renderFooterBranchPicker\(\)\)/, "footer should append the branch picker above the status bar when open");
assert.match(server, /url\.pathname === "\/api\/git-branches"[\s\S]*readGitBranches\(tab\.cwd\)/, "server should expose local git branch listing for the footer picker");
assert.match(server, /url\.pathname === "\/api\/git-worktrees" && req\.method === "POST"[\s\S]*createGitWorktreeTab\(tab, body\)/, "server should expose git worktree creation for branch tabs");
assert.match(server, /url\.pathname === "\/api\/git-worktrees\/open" && req\.method === "POST"[\s\S]*openExistingGitWorktreeTab\(tab, body\)/, "server should expose existing git worktree opening for branch tabs");
assert.match(server, /url\.pathname === "\/api\/git-worktrees" && req\.method === "DELETE"[\s\S]*requireLocalhost\(req, "Removing Git worktrees is only allowed from localhost"\)[\s\S]*removeGitWorktreeForTab\(tab, body\)/, "server should guard destructive git worktree removal behind localhost and confirmation");
assert.match(server, /url\.pathname === "\/api\/git-branch"[\s\S]*const remoteRef = requestedRemoteRef\(body\);[\s\S]*switchGitBranch\(tab\.cwd, body\.branch, \{ create: body\.create === true, remoteRef \}\)/, "server should preserve optional exact remote-ref intent for advanced footer branch switching");
assert.match(server, /runGitReadCommandDetailed\(root, \["for-each-ref", "--format=%\(refname\)%09%\(symref\)"[\s\S]*remoteBranchesTruncated: remoteData\.truncated === true[\s\S]*item\.remote !== true && item\.name === targetBranch/, "server branch listing should parse full remote refs, expose truncation, and keep local branch guards local-only");
assert.match(server, /async function switchGitBranch[\s\S]*BRANCH_CHECKED_OUT_ELSEWHERE[\s\S]*const args = create \? \["switch", "-c", targetBranch\] : \["switch", targetBranch\]/, "server branch switching should refuse branches checked out in another worktree before git switch");
assert.match(app, /let latestStats = null/, "default footer should retain session stats for token and context display");
assert.match(app, /async function refreshStats\(tabContext = activeTabContext\(\)\)[\s\S]*api\("\/api\/stats"/, "default footer should fetch session stats");
assert.match(app, /function renderMinimalFooter\(\)[\s\S]*stats: fallbackFooterStats\(\)/, "minimal default footer should include token, cost, and context stats");
assert.match(app, /function footerStatsTokensDisplay\(stats = latestStats\)[\s\S]*`↑\$\{formatFooterTokenCount\(tokens\.input\)\} ↓\$\{formatFooterTokenCount\(tokens\.output\)\}`/, "fallback footer stats should include input/output tokens");
assert.match(app, /function footerStatsCostDisplay\(stats = latestStats\)[\s\S]*footerCostAuthLabel\(\)/, "fallback footer stats should include api\/sub cost mode");
assert.doesNotMatch(app, /Git footer status disabled/, "disabled git footer should show only the minimal footer metadata");
assert.doesNotMatch(app, /footerMeta\("runtime"/, "minimal Web UI footer should not render runtime metadata");
assert.match(app, /statusEntries\.has\(GIT_FOOTER_WEBUI_STATUS_KEY\)/, "optional feature detection should recognize the git-footer-status Web UI payload");
assert.match(app, /function renderGitFooterRefreshButton\(\)[\s\S]*git-footer-refresh-button[\s\S]*triggerGitFooterRefreshFromButton\(\)/, "git footer should render a compact refresh button wired to the explicit refresh handler");
assert.match(app, /function triggerGitFooterRefreshFromButton\(\)[\s\S]*requestGitFooterWebuiPayload\(tabContext, \{ force: true, silent: false, allowDuringRun: true \}\)/, "git footer refresh button should force a visible /git-footer-refresh request even during active agent runs");
assert.doesNotMatch(app, /Git footer refresh is unavailable while Pi is busy\./, "explicit git footer refresh should not be blocked while the agent is running");
assert.match(app, /message: `\/\$\{refreshCommand\}\$\{silent \? " --webui-silent" : ""\}`/, "Web UI should quietly request the extension-owned footer payload when idle and omit --webui-silent for explicit refreshes");
assert.match(app, /function requestGitFooterWebuiPayload\(tabContext = activeTabContext\(\), \{ force = false, silent = true, allowDuringRun = false \} = \{\}\)[\s\S]*?!allowDuringRun && \(currentState\?\.isStreaming \|\| currentState\?\.isCompacting\)[\s\S]*?!force && statusEntries\.has\(GIT_FOOTER_WEBUI_STATUS_KEY\)/, "git footer payload refresh should support forced refresh even when a live payload already exists and only block busy runs by default");
assert.doesNotMatch(app, /function requestGitFooterWebuiPayload\([\s\S]*?statusEntries\.delete\(GIT_FOOTER_WEBUI_STATUS_KEY\)/, "forced git footer refreshes should keep the existing payload visible while the refresh runs");
assert.match(app, /function applyOptimisticModelSelection\(model, tabContext = activeTabContext\(\)\)[\s\S]*?currentState = \{ \.\.\.currentState, model: nextModel \}[\s\S]*?renderStatus\(\)[\s\S]*?requestGitFooterWebuiPayload\(tabContext, \{ force: true \}\)/, "model changes should update current state and footer immediately before async refreshes complete");
assert.match(app, /function gitFooterRelevantStateChanged\(previousState, nextState\)[\s\S]*?previousState\.thinkingLevel !== nextState\.thinkingLevel[\s\S]*?modelStateKey\(previousState\.model\) !== modelStateKey\(nextState\.model\)/, "state refresh should detect model and thinking changes that make the git footer payload stale");
assert.match(app, /requestGitFooterWebuiPayload\(tabContext, \{ force: shouldRefreshGitFooter \}\)/, "state refresh should force-refresh the git footer when model or thinking state changes");
assert.match(app, /if \(response\.data\?\.level\) requestGitFooterWebuiPayload\(tabContext, \{ force: true \}\)/, "thinking shortcut should immediately force-refresh the git footer payload");
assert.match(app, /Loading git footer status…/, "missing git footer payload should show a loading state before declaring the extension unavailable");
assert.match(app, /GIT_FOOTER_WEBUI_PAYLOAD_CACHE_KEY/, "git footer payloads should be cached across Web UI reloads");
assert.match(app, /function setOptionalFeatureDisabled\(featureId, disabled\)[\s\S]*clearGitFooterWebuiPayloadCache\(\)/, "changing the git footer feature toggle should invalidate the cached footer payload");
const workspaceInfoSource = server.match(/async function getWorkspaceInfo[\s\S]*?\r?\n}\r?\n\r?\nlet activeGitWorkflowProcess/)?.[0] || "";
assert.ok(workspaceInfoSource, "server workspace info source should be inspectable");
assert.doesNotMatch(workspaceInfoSource, /runCommand\("git"|branchStatus|isRepo/, "Web UI workspace endpoint should not duplicate git footer status collection");
assert.match(app, /function renderOptionalFeatureDependentDisplays\(\)[\s\S]*renderOptionalFeatureControls\(\);[\s\S]*renderThemeSelect\(\);[\s\S]*renderWidgets\(\);[\s\S]*renderStatus\(\);[\s\S]*renderCommands\(\);[\s\S]*renderAllMessages\(\{ preserveScroll: true, forceRebuild: true \}\);[\s\S]*if \(streamRawText\) renderStreamingAssistantText\(\);/, "optional feature toggles should immediately refresh visible controls, commands, transcript, and live stream displays");
assert.match(app, /function setOptionalFeatureDisabled\(featureId, disabled\)[\s\S]*renderOptionalFeatureDependentDisplays\(\);[\s\S]*const tabContext = activeTabContext\(\);[\s\S]*refreshCommands\(tabContext\)/, "optional feature enable/disable should re-render the GUI and then refresh command capabilities");
assert.match(app, /function setOptionalControlState\(button, available, unavailableTitle\)[\s\S]*setAttribute\("aria-label", nextAriaLabel\)[\s\S]*setAttribute\("data-tooltip", nextTooltip\)/, "optional feature button disabled state should update accessible labels and visible tooltips");
assert.match(app, /const hasGitWorkflow = isOptionalFeatureEnabled\("gitWorkflow"\);[\s\S]{0,400}?elements\.gitWorkflowButton\.hidden = !hasGitWorkflow && isOptionalFeatureDisabled\("gitWorkflow"\)/, "guided git workflow composer button should stay discoverable (disabled) when the package is missing and hide only when explicitly disabled");
assert.match(app, /elements\.publishButton\.hidden = !hasPublishWorkflow[\s\S]*elements\.nativeCommandMenuButton\.hidden = !hasNativeCommandMenu/, "optional publish and skills/tools menu buttons should be hidden when no enabled menu items are available");
assert.match(app, /\["skills", "tuiSkillsCommand"\][\s\S]*\["tools", "tuiToolsCommand"\]/, "optional feature toggles should gate /skills and /tools command surfaces");
assert.match(app, /function setNativeCommandMenuOpen\(open\)/, "frontend should track the skills/tools command menu open state separately from Publish");
assert.match(app, /nativeSkillsButton\.hidden = !isOptionalFeatureEnabled\("tuiSkillsCommand"\)[\s\S]*nativeToolsButton\.hidden = !isOptionalFeatureEnabled\("tuiToolsCommand"\)/, "skills/tools menu items should be hidden by their optional feature toggles");
assert.match(app, /function renderCommands\(\)/, "side-panel commands should be re-renderable from current optional feature state");
const installOptionalFeatureSource = appFunctionSource("installOptionalFeature", "installOptionalFeatureBatch");
const installOptionalFeatureBatchSource = appFunctionSource("installOptionalFeatureBatch", "runPublishWorkflow");
assert.match(installOptionalFeatureSource, /featureId, \{ update = false \} = \{\}/, "optional features should expose per-row install and update actions");
assert.match(app, /api\("\/api\/optional-features"/, "optional feature panel should fetch package install/update status from the backend");
assert.match(app, /function optionalFeatureNeedsInstall\(feature\)[\s\S]*status\.ready !== true[\s\S]*status\.resourceConflict !== true/, "bulk selection should exclude ready top-level resources and duplicate registration conflicts");
assert.match(app, /packageStatus\?\.updateAvailable[\s\S]*action\.textContent = "Update…"/, "optional feature package drift should retain the per-row update action");
assert.match(app, /function optionalFeatureManualInstallCommand\(feature\)[\s\S]*`pi install npm:\$\{feature\.packageName\}`/, "optional feature fallback commands should use the exact unpinned Pi npm source");
assert.match(app, /function copyOptionalFeatureInstallCommand\(featureId\)[\s\S]*state\?\.command \|\| optionalFeatureManualInstallCommand\(feature\)/, "missing and unregistered rows should expose a copyable Pi fallback command before an install attempt");
assert.match(installOptionalFeatureSource, /optionalFeatureManualInstallCommand\(feature\)[\s\S]*selected Pi CLI[\s\S]*api\("\/api\/optional-feature-install"/, "per-row install/update should describe and call the Pi-backed endpoint");
assert.doesNotMatch(installOptionalFeatureSource, /npm install|Web UI package install root|npm command/i, "per-row optional feature copy should not claim that Web UI invokes npm directly");
assert.match(app, /renderOptionalFeatureBatchToolbar\(\)[\s\S]*"Install all"[\s\S]*installOptionalFeatureBatch\(OPTIONAL_FEATURES/, "optional feature panel should expose Install all");
assert.match(app, /function renderOptionalFeatureSection\(section, features\)[\s\S]*"Install missing"[\s\S]*installOptionalFeatureBatch\(features/, "each optional feature section should expose Install missing");
assert.match(installOptionalFeatureBatchSource, /optionalFeatureBatchCandidates\(features\)[\s\S]*await appConfirmText\([\s\S]*api\("\/api\/optional-feature-install-batch"[\s\S]*for \(const feature of candidates\)[\s\S]*result\?\.ok === true[\s\S]*optionalFeatureInstallFailureFromBatchResult/, "bulk install should confirm once, call one backend batch, and settle every requested row independently");
assert.match(installOptionalFeatureBatchSource, /Batch finished:[\s\S]*succeeded[\s\S]*failed|optional feature batch finished:[\s\S]*succeeded[\s\S]*failed/, "bulk install should expose bounded aggregate success/failure counts");
assert.equal((installOptionalFeatureBatchSource.match(/confirmLabel: "Reload tab"/g) || []).length, 1, "bulk install should issue exactly one post-batch reload prompt");
assert.match(app, /id: "btwCommand"[\s\S]*?@firstpick\/pi-extension-btw/, "optional features should include the /btw companion");
assert.match(app, /BTW_OUTPUT_WIDGET_KEY = "btw:output"[\s\S]*function renderBtwOutputWidget/, "Web UI should render structured /btw output widgets");
assert.match(app, /if \(key\.startsWith\("btw:"\)\) return "btwCommand"/, "extension widget routing should associate /btw widgets with the optional feature");
assert.match(app, /id: "safetyGuard"[\s\S]*?@firstpick\/pi-extension-safety-guard/, "optional features should include the safety guard companion");
assert.match(app, /id: "tuiSkillsCommand"[\s\S]*?@firstpick\/pi-extension-setup-skills[\s\S]*?setup: "skills"/, "optional features should expose Skills Setup from the TUI skills command companion");
assert.match(app, /id: "tuiToolsCommand"[\s\S]*?@firstpick\/pi-extension-tools[\s\S]*?setup: "tools"/, "optional features should expose Tools Setup from the TUI tools command companion");
assert.match(app, /id: "remoteWebui"[\s\S]*?@firstpick\/pi-package-remote-webui/, "optional features should include the Remote WebUI companion");
assert.match(app, /id: "questionnaire"[\s\S]*?@firstpick\/pi-package-questionnaire[\s\S]*?capabilityLabel: "questionnaire tool in \/tools"[\s\S]*?manageWith: "tools"/, "optional features should include the native questionnaire package with direct session access control");
assert.match(app, /id: "naturalConversation"[\s\S]*?@firstpick\/pi-package-natural-conversation[\s\S]*?capabilityLabel: "\/talk, \/voice, or \/conversation"/, "optional features should include the capability-detected Natural Conversation shell");
assert.match(app, /NATURAL_CONVERSATION_COMMAND_NAMES = \["talk", "voice", "conversation"\]/, "frontend should detect Natural Conversation only from RPC-visible command aliases");
assert.match(app, /const conversationModeByTab = new Map\(\)/, "frontend should track Natural Conversation state per terminal tab");
assert.match(app, /function defaultConversationModeState[\s\S]*allowedTools: \["read", "grep", "find", "ls"\]/, "frontend Natural Conversation defaults should mirror the read-only tool allowlist");
assert.match(app, /function renderConversationModeControls\(\)[\s\S]*document\.body\.classList\.toggle\("conversation-mode-active", active\)[\s\S]*optionsConversationModeButton[\s\S]*conversationModeChip[\s\S]*conversationModeEndButton/, "frontend should render active Natural Conversation controls and page\/composer state");
assert.match(app, /async function setNaturalConversationModeEnabled\(enabled\)[\s\S]*api\("\/api\/conversation-mode", \{ method: "POST"/, "frontend Natural Conversation toggle should use the WebUI shell endpoint");
assert.match(app, /const WORKFLOW_MODE_STATUS_KEY = "workflow-mode"/, "frontend should consume extension-owned Workflow Mode status");
assert.match(app, /const WORKFLOW_MODE_RPC_WIDGET_KEY = "workflow-mode:rpc"[\s\S]*WORKFLOW_MODE_RPC_PAYLOAD_PREFIX = "WORKFLOW_MODE_RPC_PAYLOAD "[\s\S]*WORKFLOW_MODE_RPC_PAYLOAD_VERSION = 1/, "frontend should recognize the versioned replayable Workflow Mode RPC payload");
assert.match(app, /function workflowModeStateFromRpcPayload\(lines\)[\s\S]*payload\?\.type !== WORKFLOW_MODE_RPC_PAYLOAD_TYPE[\s\S]*normalizeWorkflowModeState/, "frontend should strictly validate structured Workflow Mode payloads");
assert.match(app, /const workflowModeByTab = new Map\(\)/, "frontend should track Workflow Mode independently for each Pi tab");
assert.match(app, /function renderWorkflowModeControls\(\)[\s\S]*workflow-mode-active[\s\S]*workflowModeButton[\s\S]*workflowModeChip/, "frontend should render toggle, active chip, and composer state from extension status");
assert.match(app, /if \(pending\) elements\.workflowModeButton\.setAttribute\("aria-busy", "true"\);[\s\S]*else elements\.workflowModeButton\.removeAttribute\("aria-busy"\);[\s\S]*pending\s*\? "Updating JavaScript Workflow Mode for this Pi tab\."/, "Workflow Mode icon should expose valid pending busy semantics and accessible tooltip feedback");
assert.match(app, /workflowOverlayOpenButton\.setAttribute\("aria-expanded", openAvailable \? "false" : "true"\)/, "Workflow overlay restore should keep disclosure state synchronized while visible or hidden");
assert.match(app, /applyStyledTooltip\(elements\.workflowOverlayOpenButton, "Open the minimized workflow overlay\.", \{ ariaLabel: true, align: "end" \}\)/, "isolated Workflow restore should use the viewport-clamped floating tooltip");
assert.match(app, /applyStyledTooltip\(elements\.workflowModeButton, tooltip, \{ ariaLabel: true, align: "end" \}\)/, "isolated Workflow Mode should use the viewport-clamped floating tooltip");
assert.match(app, /function applyStyledTooltip\([\s\S]*if \(options\.floating !== false\) bindStyledTooltipEvents\(node\)/, "styled tooltip setup should allow controls with native scoped tooltip CSS to opt out of the floating tooltip layer");
assert.match(app, /async function setWorkflowModeEnabled\(enabled\)[\s\S]*`\/\$\{commandName\} mode \$\{enabled \? "on" : "off"\}`/, "Workflow Mode toggle should send canonical extension commands rather than rewrite prompts locally");
assert.match(app, /if \(statusKey === WORKFLOW_MODE_STATUS_KEY\) handleWorkflowModeStatus/, "Workflow Mode should synchronize from replayable extension setStatus events");
assert.match(app, /if \(widgetKey === WORKFLOW_MODE_RPC_WIDGET_KEY\)[\s\S]*workflowModeStateFromRpcPayload\(request\.widgetLines\)[\s\S]*updateWorkflowModeForTab/, "Workflow Mode should consume structured replay state without rendering an opaque widget");
assert.match(app, /const WORKFLOW_INSPECTOR_WIDGET_KEY = "workflow:rpc"[\s\S]*WORKFLOW_INSPECTOR_PAYLOAD_PREFIX = "WORKFLOW_RPC_PAYLOAD "[\s\S]*WORKFLOW_INSPECTOR_PAYLOAD_VERSION = 1/, "frontend should recognize the versioned multi-run Workflow inspector payload");
assert.match(app, /function parseWorkflowInspectorPayload\(lines\)[\s\S]*payload\?\.type !== WORKFLOW_INSPECTOR_PAYLOAD_TYPE[\s\S]*Array\.isArray\(payload\.runs\)/, "frontend should validate Workflow inspector type, version, and run shape");
assert.match(app, /function renderWorkflowInspectorWidget\(\)[\s\S]*workflow-inspector-run-list[\s\S]*workflow-inspector-phase-tabs[\s\S]*renderWorkflowInspectorAgent/, "WebUI should render non-blocking active and historical run, phase, and agent drilldown");
assert.match(app, /function renderWorkflowInspectorAgent\(agent, run\)[\s\S]*Prompt[\s\S]*Recent activity[\s\S]*Result and usage[\s\S]*Retry agent/, "agent drilldown should expose prompt, activity, result, usage, and retry");
assert.match(app, /canPause[\s\S]*`\/workflow pause \$\{run\.runId\}`[\s\S]*canAbort[\s\S]*`\/workflow abort \$\{run\.runId\}`[\s\S]*Save user[\s\S]*Save project[\s\S]*Raw workflow script/, "WebUI Workflow controls should send canonical extension commands and expose raw scripts");
assert.match(app, /confirmMessage && !window\.confirm\(confirmMessage\)/, "destructive WebUI Workflow actions should require browser confirmation");
assert.match(app, /const workflowInspectorByTab = new Map\(\)[\s\S]*workflowInspectorSelectionByTab = new Map\(\)[\s\S]*workflowInspectorMinimizedByTab = new Set\(\)/, "Workflow inspector run, selection, and minimized state should be per tab");
assert.match(app, /const workflowTerminalScrollByTab = new Map\(\);\s*const workflowSubprocessMinimizedByTab = new Set\(\);\s*const workflowOverlayMinimizedByTab = new Set\(\);/, "Workflow subprocess and complete-overlay minimize state should be isolated per browser tab");
assert.match(app, /function setWorkflowOverlayMinimized\(minimized\)[\s\S]*workflowOverlayMinimizedByTab\.(?:add|delete)[\s\S]*renderWidgets\(\)[\s\S]*workflowOverlayOpenButton[\s\S]*workflow-overlay-close-button[\s\S]*focus\(\{ preventScroll: true \}\)/, "complete Workflow overlay minimize and restore should survive rerenders and move focus to the replacement control");
assert.match(app, /function workflowOverlayHasContent\(\)[\s\S]*getWidgetLines\("workflow"\)\.length[\s\S]*getWidgetLines\("workflow:subprocess"\)/, "the Workflow restore affordance should remain available when only the legacy status/details widget remains");
assert.match(app, /function renderWidgets\(\)[\s\S]*if \(!workflowOverlayIsMinimized\(\)\)[\s\S]*attachWorkflowOverlayCloseButton\(workflowInspectorWidget \|\| workflowSubprocessWidget\)[\s\S]*for \(const \[key, value\] of widgets\)[\s\S]*widgetFeatureId === "workflows" && workflowOverlayIsMinimized\(\)/, "closing the complete Workflow overlay should omit specialized surfaces and the legacy workflow status/details widget");
assert.match(app, /workflowOverlayOpenButton\?\.addEventListener\("click", \(\) => setWorkflowOverlayMinimized\(false\)\)/, "the Workflow-button restore affordance should reopen the complete overlay");
assert.match(app, /function workflowInspectorSetMinimized\(minimized\)[\s\S]*workflowInspectorMinimizedByTab\.(?:add|delete)[\s\S]*renderWidgets\(\)[\s\S]*requestAnimationFrame[\s\S]*workflow-inspector-minimize-button[\s\S]*focus\(\{ preventScroll: true \}\)/, "Workflow inspector minimize state should survive rerenders and restore focus to the replacement control");
assert.match(app, /function renderWorkflowInspectorWidget\(\)[\s\S]*workflow-inspector-body[\s\S]*workflow-inspector-minimize-button[\s\S]*minimized \? "Restore" : "Minimize"[\s\S]*minimizeButton\.type = "button"[\s\S]*aria-controls[\s\S]*aria-expanded[\s\S]*aria-label[\s\S]*if \(minimized\) return node/, "Workflow inspector should expose an accessible minimize and restore disclosure control");
assert.match(app, /function workflowSubprocessSetMinimized\(minimized\)[\s\S]*workflowSubprocessMinimizedByTab\.(?:add|delete)[\s\S]*renderWidgets\(\)[\s\S]*requestAnimationFrame[\s\S]*workflow-subprocess-minimize-button[\s\S]*focus\(\{ preventScroll: true \}\)/, "Workflow subprocess minimize state should survive live rerenders and restore focus to the replacement control");
assert.match(app, /function renderWorkflowSubprocessWidget\(\)[\s\S]*workflow-subprocess-body[\s\S]*workflow-subprocess-minimize-button[\s\S]*minimized \? "Restore" : "Minimize"[\s\S]*minimizeButton\.type = "button"[\s\S]*aria-controls[\s\S]*aria-expanded[\s\S]*aria-label[\s\S]*node\.append\(header, body\);\s*if \(minimized\) return node;[\s\S]*body\.append\(outputDetails\)/, "Workflow subprocess output should expose an accessible minimize and restore disclosure control without rebuilding its terminal while minimized");
assert.match(app, /workflowInspectorMinimizedByTab\.delete\(tabId\)[\s\S]*workflowSubprocessMinimizedByTab\.delete\(tabId\)[\s\S]*workflowOverlayMinimizedByTab\.delete\(tabId\)/, "closing a terminal tab should discard its Workflow inspector, subprocess, and complete-overlay minimize state");
assert.match(app, /handleInactiveTabEvent\(event\)[\s\S]*WORKFLOW_INSPECTOR_WIDGET_KEY[\s\S]*updateWorkflowInspectorForTab\(event\.tabId, inspector\)[\s\S]*renderTabs\(\)/, "inactive tabs should consume replayed Workflow inspector payloads for badges");
assert.match(app, /terminal-tab-workflow-indicator[\s\S]*workflowRunningCountForTab/, "terminal tabs should display Workflow Mode or active-run badges");
assert.match(css, /\.workflow-inspector-layout \{[\s\S]*grid-template-columns:[\s\S]*\.workflow-inspector-run-list[\s\S]*\.workflow-inspector-agent/, "Workflow inspector should have responsive run and agent layout styling");
assert.match(css, /\.workflow-inspector-widget\.minimized,[\s\S]*\.workflow-subprocess-widget\.minimized \{[\s\S]*\.workflow-inspector-minimize-button,[\s\S]*\.workflow-subprocess-minimize-button/, "Workflow inspector and subprocess widgets should share visible minimized-state toggle styling");
assert.match(css, /\.workflow-subprocess-widget\.minimized > \.release-npm-header \{[\s\S]*?padding-bottom:\s*0;[\s\S]*?border-bottom:\s*0;/, "minimized Workflow subprocess output should collapse its header divider and extra spacing");
assert.match(css, /\.terminal-tab-workflow-indicator \{[\s\S]*color: var\(--ctp-mauve\)/, "inactive-tab Workflow badges should have a distinct accessible style");
const workflowModeDockCss = css.match(/\.composer-workflow-mode-dock \{[^}]*\}/)?.[0] || "";
assert.match(workflowModeDockCss, /position:\s*absolute;[\s\S]*?top:\s*-0\.48rem;[\s\S]*?right:\s*3\.55rem;[\s\S]*?margin:\s*0;[\s\S]*?padding:\s*0;/, "Workflow Mode dock should overlay the prompt frame without adding composer height");
assert.doesNotMatch(workflowModeDockCss, /border(?:-radius)?:|background:|box-shadow:/, "icon-only Workflow Mode control should not retain a decorative outer box");
assert.match(css, /body:not\(\.mobile-keyboard-open\) \.composer-input-row:has\(\.composer-workflow-mode-dock:not\(\[hidden\]\)\) #promptInput \{[\s\S]*?padding-right:\s*3\.35rem;/, "visible icon-only Workflow dock should reserve prompt text space without adding a layout row or a hidden-keyboard gutter");
assert.match(css, /body:not\(\.mobile-keyboard-open\) \.composer-input-row:has\(\.composer-workflow-mode-dock:not\(\[hidden\]\)\) \.composer-context-tags \{[\s\S]*?max-width:\s*calc\(100% - 7\.5rem\);/, "visible icon-only Workflow dock should reserve top-border space from context tags");
assert.doesNotMatch(css, /\.composer-workflow-mode-dock-label/, "icon-only Workflow dock should not retain obsolete label styling");
assert.match(css, /body:not\(\.mobile-keyboard-open\)[\s\S]*?\.composer-context-tags \{ max-width:\s*calc\(100% - 6\.5rem\); \}/, "compact dock should reserve mobile context-tag space only while the keyboard is closed");
assert.match(css, /\.composer-workflow-mode-dock \.composer-workflow-overlay-open-button \{\s*top:\s*-0\.2rem;\s*right:\s*-0\.2rem;/, "mobile Workflow restore badge should not protrude above the compact composer");
assert.match(css, /body\.mobile-keyboard-open \.composer-workflow-mode-dock \{ display:\s*none !important; \}/, "Workflow Mode dock should leave the compact mobile typing surface uncluttered");
assert.match(css, /\.composer-workflow-mode-dock \.composer-workflow-mode-button \{[\s\S]*?width:\s*2\.25rem;[\s\S]*?min-height:\s*2\.25rem;/, "overlay Workflow icon should use a compact deliberate target inside its isolated dock");
assert.match(css, /\.composer-workflow-mode-button\.active,[\s\S]*aria-pressed="true"/, "active Workflow Mode toggle should have persistent pressed styling");
assert.match(css, /\.composer-workflow-mode-dock\.has-open-control \{[^}]*min-width:\s*1\.95rem;[^}]*min-height:\s*2\.35rem;/, "Workflow restore should retain an anchored dock even if the Workflow Mode button is unavailable");
assert.match(css, /\.composer-workflow-overlay-open-button \{[\s\S]*position:\s*absolute;[\s\S]*border-radius:\s*999px;[\s\S]*\.workflow-overlay-close-button \{/, "Workflow restore should use a visible helper badge and the complete overlay should expose a distinct close action");
assert.match(css, /\.composer\.workflow-mode-active[\s\S]*body\.workflow-mode-active \.composer::before/, "active Workflow Mode should visibly accent the composer");

// Workflow raw-script inspector: narrowly specialized, structurally read-only, and viewport-safe.
const workflowPreviewRequestSource = appFunctionSource("isWorkflowScriptPreviewRequest", "workflowScriptTokenClass");
const workflowTokenRenderSource = appFunctionSource("appendWorkflowScriptTokens", "renderWorkflowScriptPreview");
const workflowPreviewSource = appFunctionSource("renderWorkflowScriptPreview", "showNextDialog");
const workflowDialogSource = appFunctionSource("showNextDialog", "handleInactiveTabEvent");
assert.match(workflowPreviewRequestSource, /request\?\.method === "editor"[\s\S]*title\.startsWith\("Raw workflow script"\)[\s\S]*inspection only;\\s\*edits are ignored/, "workflow inspector specialization should require the editor method, raw-script title, and inspection-only wording");
assert.match(workflowDialogSource, /else if \(isWorkflowScriptPreview\) \{\s*renderWorkflowScriptPreview\(request, respondToDialog\);\s*\} else if \(request\.method === "editor"\) \{\s*const textarea = make\("textarea", "dialog-editor"\);[\s\S]*textarea\.value = request\.prefill \|\| ""/, "workflow previews should specialize before the unchanged generic editor textarea fallback and share its one-shot responder");
assert.doesNotMatch(workflowPreviewSource, /\btextarea\b/, "workflow previews should not create an editable textarea");
assert.match(workflowTokenRenderSource, /document\.createTextNode\(line\.slice\(start, match\.index\)\)[\s\S]*make\("span", `workflow-script-token/, "workflow syntax tokens should be built from DOM text nodes and spans");
assert.doesNotMatch(workflowTokenRenderSource, /innerHTML|insertAdjacentHTML/, "workflow syntax token rendering should not inject source through HTML APIs");
assert.match(workflowPreviewSource, /search\.type = "search"[\s\S]*Previous match[\s\S]*Next match[\s\S]*Wrap lines[\s\S]*Copy source/, "workflow inspector should expose search navigation, wrap, and copy controls");
assert.match(workflowPreviewSource, /search\.addEventListener\("keydown", \(event\) => \{\s*if \(event\.key !== "Enter"\) return;\s*event\.preventDefault\(\);\s*if \(matchingLineIndexes\.length === 0\) return;\s*setActiveMatch\(activeMatchIndex \+ \(event\.shiftKey \? -1 : 1\)\);\s*\}\);/, "workflow search should prevent Enter form submission before returning for no matches and navigate only when matches exist");
assert.match(workflowPreviewSource, /workflow-script-search-status[\s\S]*aria-live", "polite"[\s\S]*workflow-script-copy-status[\s\S]*aria-live", "polite"/, "workflow search and copy feedback should be announced");
assert.match(workflowPreviewSource, /addDialogButton\("Cancel workflow"[\s\S]*cancelled: true[\s\S]*addDialogButton\("Back to approval"[\s\S]*value: request\.prefill/, "workflow inspector actions should cancel explicitly or return the original prefill unchanged");
assert.match(css, /\.extension-dialog\.workflow-script-dialog \{[\s\S]*width: min\(96rem, calc\(100vw - 2rem\)\)[\s\S]*height: min\(58rem, calc\(var\(--visual-viewport-height, 100dvh\) - 2rem\)\)[\s\S]*overflow: hidden/, "workflow inspector should use a large visual-viewport-bounded desktop dialog");
assert.match(css, /\.workflow-script-toolbar \{[\s\S]*grid-template-columns: minmax\(12rem, 1fr\) repeat\(4, auto\)[\s\S]*\.workflow-script-code \{[\s\S]*overflow: auto[\s\S]*font-family: ui-monospace[\s\S]*\.workflow-script-line-number \{[\s\S]*position: sticky/, "workflow inspector should style its toolbar, scrollable code surface, and persistent line-number gutter");
assert.match(css, /\.workflow-script-code\.is-wrapped[\s\S]*white-space: pre-wrap[\s\S]*\.workflow-script-line\.is-search-match[\s\S]*\.workflow-script-line\.is-active-match[\s\S]*box-shadow:/, "workflow inspector should distinguish matches and support soft wrapping");
assert.match(css, /\.workflow-script-code:focus-visible[\s\S]*outline:[\s\S]*\.workflow-script-token-keyword[\s\S]*var\(--ctp-mauve\)[\s\S]*\.workflow-script-token-string[\s\S]*var\(--ctp-green\)[\s\S]*\.workflow-script-token-number[\s\S]*var\(--ctp-peach\)[\s\S]*\.workflow-script-token-comment[\s\S]*var\(--ctp-subtext\)/, "workflow inspector should provide a visible focus ring and high-contrast token colors");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\) \{[\s\S]*\.extension-dialog\.workflow-script-dialog \{[\s\S]*height: calc\(var\(--visual-viewport-height, 100dvh\) - 0\.25rem - env\(safe-area-inset-top\)\)[\s\S]*\.workflow-script-toolbar \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)[\s\S]*\.workflow-script-dialog #dialogActions \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "workflow inspector mobile bottom sheet should respect the visual viewport and keep controls reachable");
// Phase 3: browser voice loop (Web Speech STT/TTS) wiring.
const voiceModule = await readFile(join(root, "public", "voice-conversation.mjs"), "utf8");
assert.match(voiceModule, /export function createVoiceConversationController\(options = \{\}\)/, "voice loop should live in a dependency-injected module for Node tests");
assert.match(voiceModule, /if \(state\.assistantStreaming && state\.toolRunning\) \{[\s\S]*queuedInterrupt/, "voice transcripts during tool phases must be queued, not injected");
assert.match(voiceModule, /if \(!bargeInEnabled\) stopRecognition\(\{ forSpeech: true \}\)/, "microphone must pause during TTS unless barge-in is enabled");
assert.match(voiceModule, /function pause\(\{ reason = "manual" \} = \{\}\)[\s\S]*stopRecognition\(\{ forSpeech: true \}\)[\s\S]*setUiState\("paused"/, "voice loop should support manual pause without disabling safe mode");
assert.match(voiceModule, /function resume\(\)[\s\S]*state\.userPaused = false[\s\S]*resumeListeningAfterTurn\(\)/, "voice loop should support manual resume back to listening");
assert.match(voiceModule, /togglePaused/, "voice controller should expose a pause/resume toggle");
assert.match(voiceModule, /if \(!transcript \|\| !state\.active \|\| state\.userPaused\) return/, "paused voice loop should drop speech transcripts");
assert.match(voiceModule, /if \(state\.userPaused\) return snapshot\(\)/, "paused voice loop should not speak a completed assistant turn");
assert.match(voiceModule, /export function voiceSilenceEventMessage/, "silence events should use a shared structured message");
assert.match(app, /import\("\.\/voice-conversation\.mjs\?v=\d+"\)/, "app.js should lazy-load the voice module with a cache-busted dynamic import");
assert.match(app, /function syncVoiceConversationLoop\(\)[\s\S]*stopVoiceConversationLoop\(\)[\s\S]*startVoiceConversationLoop\(activeTabId\)/, "voice loop should follow per-tab conversation mode state");
assert.match(app, /function toggleVoiceConversationPaused\(\)[\s\S]*togglePaused\?\.\(\)[\s\S]*Browser voice loop paused/, "composer voice chip should be wired to pause or resume browser listening");
assert.match(app, /function conversationModeDisplayText\(mode = activeConversationMode\(\)\)[\s\S]*voiceConversationVisibleProviderLabel\(\)[\s\S]*browser STT\/TTS/, "conversation status chip should show the active browser voice provider state");
assert.match(app, /conversationModeChip\?\.addEventListener\("click", \(\) => toggleVoiceConversationPaused\(\)\)/, "conversation chip should pause/resume the browser voice loop instead of ending safe mode");
assert.match(app, /async function startVoiceConversationLoop\(tabId = activeTabId\)[\s\S]*remoteMicConsentGranted\(tabId\)/, "voice loop must gate remote sessions behind explicit microphone consent");
assert.match(app, /function isLocalhostWebui\(\)[\s\S]*127\.0\.0\.1/, "remote-consent detection should treat localhost as implicitly consented");
assert.match(app, /function latestAssistantSpokenText\(\)[\s\S]*assistantDisplayMessages\(message\)\.find\(\(item\) => item\?\.title === "final output"\)/, "spoken text must come from final output only, never thinking or tool payloads");
assert.match(app, /function speakableTextFromMarkdown\(text\)[\s\S]*Code block omitted/, "spoken text should strip code blocks and markdown syntax");
assert.match(app, /case "agent_settled":[\s\S]*handleVoiceConversationTurnEnd\(tabContext\)/, "agent_settled should hand the fully finished turn to the voice loop");
assert.match(app, /case "tool_execution_start":[\s\S]*setAssistantActivity\(\{ toolRunning: true \}\)/, "tool execution start should mark the voice loop tool phase");
assert.match(app, /case "tool_execution_end":[\s\S]*setAssistantActivity\(\{ toolRunning: false \}\)/, "tool execution end should clear the voice loop tool phase");
assert.match(html, /id="remoteMicStreamingConsentButton"[^>]*disabled>Allow remote microphone streaming</, "remote mic consent button should exist, start disabled, and use action-specific copy");
assert.match(html, /id="remoteMicStreamingConsent" class="composer-remote-mic-consent" role="alert" hidden/, "remote mic consent disclosure container should exist and start hidden");
assert.match(css, /\.composer-remote-mic-consent[\s\S]*\.composer-remote-mic-consent-button/, "remote mic consent banner should have dedicated styles");
assert.match(css, /\.composer-conversation-mode-chip\[data-voice-state="speaking"\]/, "conversation chip should style voice states");
assert.match(serviceWorker.toString(), /\/voice-conversation\.mjs/, "service worker app shell should include the voice module");
assert.ok(pkg.scripts.check.includes("node --check public/voice-conversation.mjs"), "npm run check should parse the voice module");
assert.match(app, /id: "bangCommandAutocomplete"[\s\S]*packageName: "@firstpick\/pi-extension-bang-command-autocomplete"[\s\S]*capabilityLabel: "\/bang-status or \/bang-refresh"/, "optional features should list bang-command autocomplete by loaded command capability");
assert.match(app, /id: "fishUserBash"[\s\S]*packageName: "@firstpick\/pi-extension-fish-user-bash"[\s\S]*capabilityLabel: "\/user-bash-shell"/, "optional features should list fish user-bash by loaded command capability");
assert.match(app, /OPTIONAL_COMMAND_FEATURES = new Map\(\[[\s\S]*\["bang-refresh", "bangCommandAutocomplete"\][\s\S]*\["bang-status", "bangCommandAutocomplete"\][\s\S]*\["user-bash-shell", "fishUserBash"\]/, "optional command mapping should gate bang and fish companion commands");
assert.match(app, /function updateOptionalFeatureAvailability\(\)[\s\S]*hasAvailableCommand\("bang-status"\) \|\| hasAvailableCommand\("bang-refresh"\)[\s\S]*hasAvailableCommand\("user-bash-shell"\)[\s\S]*hasLoadedGuidedGitNativeCommand\("git-staged-msg", activeTabId\)[\s\S]*hasAvailableCommand\("release-npm"\)[\s\S]*hasAvailableCommand\("release-aur"\)[\s\S]*hasAvailableCommand\("safety-guard"\)[\s\S]*hasLoadedRpcCommand\("skills"\)[\s\S]*hasAvailableCommand\("todo-progress-status"\)[\s\S]*hasLoadedRpcCommand\("tools"\)[\s\S]*hasAvailableCommand\("remote"\)[\s\S]*NATURAL_CONVERSATION_COMMAND_NAMES\.some\(\(name\) => hasAvailableCommand\(name\)\)/, "optional feature detection should require Guided Git extension provenance while distinguishing native resource selectors from TUI companions");
assert.match(app, /hasRemoteWebuiCommand = isOptionalFeatureEnabled\("remoteWebui"\) && hasAvailableCommand\("remote"\)[\s\S]*optionsRemoteButton\.hidden = !hasRemoteWebuiCommand[\s\S]*syncRemoteWebuiControlVisibility\(hasRemoteWebuiCommand\)/, "Options menu should track /remote availability and delegate network card visibility");
assert.match(app, /function syncRemoteWebuiControlVisibility[\s\S]*networkControlField\.hidden = !hasRemoteWebuiCommand/, "Remote WebUI network card should render whenever the optional feature and /remote command are enabled");
assert.match(app, /querySelector\("#remoteAccessControlsTitle"\)[\s\S]*heading\.textContent = payload\?\.title \|\| "Remote access"/, "Remote WebUI payload titles should update the group heading without replacing the nested PIN-auth label");
assert.match(app, /if \(featureId === "remoteWebui"\) syncRemoteWebuiControlVisibility\(false\)/, "Disabling Remote WebUI should immediately hide browser network controls before broader rerendering");
assert.match(app, /window\.addEventListener\("storage"[\s\S]*OPTIONAL_FEATURES_STORAGE_KEY[\s\S]*reconcileDisabledOptionalFeaturesFromStorage/, "Optional feature disables should live-sync across open Web UI pages");
assert.match(app, /if \(key === "pi-remote-webui"\) return "remoteWebui"/, "optional feature handling should recognize Remote WebUI widget events without rendering them as overlays");
assert.match(app, /REMOTE_WEBUI_CONTROLS_PAYLOAD_TYPE = "firstpick\.pi-package-remote-webui\.controls"/, "Remote WebUI package should announce browser controls through a package-owned status payload");
assert.match(app, /function combineIdenticalDuplicateCommands\(commands\)[\s\S]*duplicateGroups[\s\S]*duplicateCount: group\.length/, "identical duplicate RPC commands should be combined into one visible command entry");
assert.match(app, /if \(kind === "prompt" && attachments\.length === 0\) message = resolveRpcSlashCommandMessage\(message, \{ tabId: targetTabId \}\)/, "manual targeted slash prompts should resolve combined duplicate command aliases from their captured target tab before reaching Pi RPC");
assert.match(app, /if \(!isOptionalFeatureDetected\("todoProgressWidget"\)\) return String\(text \|\| ""\)/, "todo progress line stripping should keep transport filtering active whenever the todo feature is detected");
assert.match(app, /const releasePrompt = detectedReleasePrompt && isOptionalFeatureEnabled\(detectedReleasePrompt\.featureId\) \? detectedReleasePrompt : null/, "release confirmation dialogs should use specialized rendering only when their release optional feature is enabled");
assert.match(app, /case "webui_tab_reloaded":[\s\S]*resetOptionalFeatureAvailability\(\)/, "optional feature state should reset when the RPC tab reloads resources");
assert.match(app, /function runPublishWorkflow\(command\)[\s\S]*resolveAvailableCommandName\(commandName, \{ rpcOnly: true \}\)/, "publish workflow launch should guard on loaded slash commands, including duplicate-suffixed RPC command names");
assert.match(app, /function guidedGitNativeCommandsAvailable\(tabId\)[\s\S]*\["git-staged-msg", "git-branch-name", "pr"\]\.every[\s\S]*hasLoadedGuidedGitNativeCommand/, "guided Git must require all native extension commands in the originating tab");
assert.match(app, /function launchGuidedGitWorkflow\(tabId = activeTabId\)[\s\S]*resolveAvailableCommandName\("git-guided-workflow", \{ tabId, rpcOnly: true \}\)/, "guided Git visible entry points should prefer the tab-local extension command");
assert.doesNotMatch(html, /gitWorkflowProcessSelect/, "guided git workflow should not expose process selection as a dropdown");
assert.match(app, /const GIT_WORKFLOW_PROCESSES = \[[\s\S]*value: "stage", label: "Stage"[\s\S]*value: "message", label: "Message"[\s\S]*value: "commit", label: "Commit"[\s\S]*value: "push", label: "Push"/, "guided git workflow should define Stage/Message/Commit/Push process buttons");
assert.match(app, /function selectGitWorkflowProcess\(processValue, tabId = gitWorkflowActionTabId\(\)\)[\s\S]*process === "commit"[\s\S]*loadGitWorkflowMessage\(\{ requireFresh: false, runId, tabId \}\)/, "guided git workflow process buttons should jump to Commit by loading current generated message files");
assert.match(app, /actionsDone: createGitWorkflowActionsDone\(\)/, "guided git workflow should track process completion separately from selected process");
assert.match(app, /if \(gitWorkflowActionDone\(gitWorkflow, process\.value\)\) item\.classList\.add\("done"\)/, "guided git workflow step pills should turn green only after their action is done");
assert.doesNotMatch(app, /index < activeIndex\) item\.classList\.add\("done"\)/, "guided git workflow step pills should not turn green merely because a later process was selected");
assert.match(app, /make\("button", "git-workflow-step", process\.label\)[\s\S]*item\.dataset\.gitWorkflowProcess = process\.value/, "guided git workflow step pills should render as clickable buttons");
assert.match(app, /gitWorkflowSteps\.addEventListener\("click"[\s\S]*data-git-workflow-process[\s\S]*selectGitWorkflowProcess\(button\.dataset\.gitWorkflowProcess\)/, "guided git workflow process buttons should select processes directly");
assert.match(css, /\.git-workflow-step::before \{[\s\S]*background:\s*var\(--ctp-yellow\)/, "guided git workflow step dots should stay yellow until that process action is done");
assert.match(css, /\.git-workflow-step\.done::before \{[\s\S]*background:\s*var\(--ctp-green\)/, "guided git workflow completed process dots should be green");
assert.match(css, /button\.git-workflow-step \{[\s\S]*min-height:\s*2\.15rem[\s\S]*box-shadow:/, "guided git workflow step buttons should keep pill button styling");
assert.match(app, /const gitWorkflowsByTab = new Map\(\)/, "guided git workflow state should be stored per terminal tab");
assert.match(app, /function bindGitWorkflowToActiveTab\(\) \{\n\s+gitWorkflow = gitWorkflowForTab\(activeTabId\) \|\| createGitWorkflowState\(\);/, "guided git workflow should render only the active terminal tab's workflow state");
assert.match(app, /function setGitWorkflow\(patch, \{ tabId = activeTabId \} = \{\}\)[\s\S]*if \(tabId === activeTabId\) \{[\s\S]*renderGitWorkflow\(\);/, "guided git workflow should not render inactive terminal workflows globally");
assert.match(html, /id="gitPrDialog"[\s\S]*id="gitPrTitleInput"[\s\S]*id="gitPrBodyEditor"[\s\S]*id="gitPrCreateButton"/, "guided git workflow should expose a PR review dialog with title and body editing");
assert.match(app, /addGitWorkflowAction\("Create PR worktree", \(\) => createGitPrBranch\(\), deliveryMode === "pr-worktree" \? "primary" : "", false, GIT_WORKFLOW_CREATE_PR_TOOLTIP\)/, "guided git workflow should offer and preference-highlight a Create PR worktree action after message generation");
assert.match(app, /const GIT_WORKFLOW_CREATE_PR_TOOLTIP = \[[\s\S]*"Create PR worktree:"[\s\S]*"1\. Ask Pi to generate a type\/feature-name branch from staged changes\."[\s\S]*"4\. Create or open a Git worktree for that branch instead of switching this checkout\."[\s\S]*"7\. Push and Create PR will push upstream, run \/pr, let you review, then run gh pr create\."/, "Create PR worktree should have an up-to-date step-by-step tooltip");
assert.match(app, /const GIT_WORKFLOW_MANUAL_BRANCH_TOOLTIP = \[[\s\S]*"Manual PR worktree:"[\s\S]*"1\. Skip agent branch-name generation\."[\s\S]*"4\. Create or open a Git worktree for that branch instead of switching this checkout\."[\s\S]*"7\. Push and Create PR will push upstream, run \/pr, let you review, then run gh pr create\."/, "Manual worktree should have an up-to-date step-by-step tooltip");
assert.match(app, /addGitWorkflowAction\("Manual worktree", \(\) => createGitPrBranchManually\(\), "", false, GIT_WORKFLOW_MANUAL_BRANCH_TOOLTIP\)/, "Manual worktree should render with its tooltip");
assert.match(app, /function renderGitWorkflowManualCommitInput\(\{ appendCommitButton = true \} = \{\}\)[\s\S]*git-workflow-message-input[\s\S]*Commit input[\s\S]*commitGitWorkflow\("input", tabId\)/, "Message stage should render a manual commit message input with a Commit input action");
assert.match(app, /function captureGitWorkflowInputFocus\(\)[\s\S]*document\.activeElement[\s\S]*gitWorkflowManualCommitMessage[\s\S]*selectionStart[\s\S]*function restoreGitWorkflowInputFocus\(state\)[\s\S]*state\.tabId !== activeTabId[\s\S]*state\.runId !== gitWorkflow\?\.runId[\s\S]*focus\(\{ preventScroll: true \}\)[\s\S]*setSelectionRange/, "guided git rerenders should restore focus and the cursor only for the same commit-message workflow");
assert.match(app, /function renderGitWorkflow\(\) \{\n\s+const inputFocus = captureGitWorkflowInputFocus\(\);[\s\S]*gitWorkflowActions\.replaceChildren\(\);[\s\S]*restoreGitWorkflowInputFocus\(inputFocus\);\n\}/, "background guided git updates should not leave the manual commit-message input unfocused after replacing workflow actions");
assert.match(app, /gitWorkflow\.step === "generate"\) \{\n\s+const commitInputButton = renderGitWorkflowManualCommitInput\(\{ appendCommitButton: false \}\);[\s\S]*addGitWorkflowAction\("Preview current message files"[\s\S]*gitWorkflowActions\.append\(commitInputButton\)/, "Message process stage should place Commit input immediately after Preview current message files");
assert.match(app, /gitWorkflow\.step === "message"\) \{[\s\S]*const commitInputButton = renderGitWorkflowManualCommitInput\(\{ appendCommitButton: false \}\);[\s\S]*addGitWorkflowAction\("Regenerate"[\s\S]*gitWorkflowActions\.append\(commitInputButton\)/, "Commit choice stage should place Commit input immediately after Regenerate");
assert.match(app, /async function commitGitWorkflow\(variant[\s\S]*variant === "input"[\s\S]*message: inputMessage/, "Commit input should send the typed message to the git workflow commit API");
assert.match(app, /const donePatch = variant === "input"[\s\S]*message: true, commit: true/, "Commit input should mark both message and commit workflow processes done");
assert.match(server, /\["short", "long", "input"\][\s\S]*cleanGitCommitMessageInput\(body\.message\)[\s\S]*git commit -m <input message>/, "server should accept typed git workflow commit messages");
assert.match(css, /\.git-workflow-message-input-row \{[\s\S]*flex:\s*1 1 100%/, "manual git workflow commit input should span the Message stage actions row");
assert.match(css, /\.git-workflow-actions button\[data-tooltip\]::after \{[\s\S]*content:\s*attr\(data-tooltip\)[\s\S]*white-space:\s*pre-line/, "guided git workflow action tooltips should render multiline step lists");
assert.match(app, /function gitBranchNamePromptMessage\(tabId = gitWorkflowActionTabId\(\)\)[\s\S]*hasLoadedGuidedGitNativeCommand\("git-branch-name", tabId\)[\s\S]*"\/git-branch-name"/, "guided git workflow should invoke native PR branch-name generation only when the extension command is available");
assert.match(app, /async function loadGitWorkflowBranchName\([\s\S]*generationId[\s\S]*gitWorkflowRequest\(`\/api\/git-workflow\/branch-name\$\{query\}`/, "guided git workflow should load exactly correlated generated branch names before branch creation");
assert.match(app, /async function createGitPrBranchWithSuggestion\([\s\S]*appPromptText\(\{ title: "New PR branch worktree"[\s\S]*chooseGitWorktreeBase\(branch\)[\s\S]*assertGuidedGitStagedContentBinding\(tabId, "PR worktree creation"\)[\s\S]*gitWorkflowRequest\("\/api\/git-workflow\/branch", \{ body: \{ branch, baseRef, sessionMode: "fork-current", openTab: true, [\s\S]*expectedStagedContentHash/, "guided git worktrees should ask for a base ref before verifying and carrying staged content");
assert.match(app, /function syncGitWorkflowWorktreeTabs\(result\)[\s\S]*Array\.isArray\(result\?\.tabs\)[\s\S]*applyTabMetadata\(result\.tab\)/, "guided git workflow should merge worktree tab metadata returned by the branch endpoint");
assert.match(app, /const targetTabId = result\.tab\?\.id[\s\S]*setGitWorkflow\(nextState, \{ tabId: targetTabId \}\)[\s\S]*switchTab\(targetTabId\)/, "guided git workflow should transfer PR state to the opened worktree tab");
assert.match(app, /addGitWorkflowAction\("Push and Create PR", \(\) => pushAndCreatePrGitWorkflow\(\), "primary", false\)/, "guided git workflow should replace push with Push and Create PR in PR mode");
assert.match(app, /async function runGitPrPrompt\(tabId = gitWorkflowActionTabId\(\), \{ prefixOutput = "" \} = \{\}\)[\s\S]*\/api\/git-workflow\/generate"[\s\S]*kind: "pr"/, "guided git workflow should generate PR descriptions with the configured generation profile");
assert.match(app, /async function runGitMessagePrompt\([\s\S]*\/api\/git-workflow\/generate"[\s\S]*kind: "commit"/, "guided git workflow should generate commit messages with the configured model and effort");
assert.match(app, /async function runGitBranchNamePrompt\([\s\S]*\/api\/git-workflow\/generate"[\s\S]*kind: "branch"/, "guided git workflow should generate branch names with the configured model and effort");
assert.match(app, /async function acceptCurrentGitStaging\([\s\S]*summary\?\.staged[\s\S]*No staged files are available/, "review staging should require a non-empty current staged set");
assert.match(app, /function gitWorkflowRequest\([\s\S]*response\.hint \? `\\n\\nHint:/, "guided git failures should show actionable backend hints");
assert.match(app, /function gitWorkflowRequest\([\s\S]*if \(response\.code\) failure\.code = response\.code;[\s\S]*if \(response\.hint\) failure\.hint = response\.hint;[\s\S]*if \(response\.data\) failure\.data = response\.data;[\s\S]*throw failure;/, "guided git request failures should preserve the structured backend code, hint, and process result");
assert.match(app, /async function pushGitWorkflow\([\s\S]*if \(error\?\.code === "NO_REMOTE"\) \{[\s\S]*await publishGitWorkflowRepository\(tabId, error\)/, "guided git push should offer GitHub publication only for structured NO_REMOTE failures");
assert.match(app, /async function publishGitWorkflowRepository\(tabId, failure\)[\s\S]*const repoName = cleanGitHubRepoNameInput\(failure\?\.data\?\.repoName \|\| defaultGitInitRepoName\(targetTab\)\);[\s\S]*Publish this repository to GitHub as \$\{repoName\} with the authenticated GitHub CLI \(gh\) account\?[\s\S]*if \(!publishRequested\) return false;[\s\S]*visibility = await promptGitPublishVisibility\(repoName\);[\s\S]*if \(!visibility\) return false;/, "guided git publication should derive the repository name and ask only for explicit visibility");
assert.match(app, /async function publishGitWorkflowRepository\([\s\S]*const confirmed = await appConfirmText\(\[[\s\S]*Repository name: \$\{repoName\}[\s\S]*Visibility: \$\{visibility\}[\s\S]*Branch to push: \$\{branch\}[\s\S]*Resulting remote: origin[\s\S]*if \(!confirmed\) return false;[\s\S]*gitWorkflowRequest\("\/api\/git-workflow\/publish", \{ body: \{ visibility, confirmed: true \}/, "guided git publication should confirm the derived name and omit a client-controlled name from the publish request");
assert.match(app, /async function publishGitWorkflowRepository\([\s\S]*Published \$\{result\.repoName \|\| repoName\} as \$\{result\.visibility \|\| visibility\}\.[\s\S]*Remote: \$\{result\.remote \|\| "origin"\}[\s\S]*Branch: \$\{result\.branch \|\| branch\}[\s\S]*scheduleRefreshFooter\(\)/, "successful publication should report branch/remote metadata and refresh the footer");
assert.doesNotMatch(app, /function promptGitPublishRepoName\(/, "publication should not ask the user to name a repository");
assert.match(server, /case "\/api\/git-workflow\/publish": \{[\s\S]*const root = await getGitRoot\(cwd\);[\s\S]*const repoName = cleanGitHubRepoName\(path\.basename\(root\)\);[\s\S]*\["repo", "create", repoName, `--\$\{visibility\}`, "--source", "\.", "--remote", "origin", "--push"\][\s\S]*\{ cwd: root, timeoutMs:/, "server publication should derive the Git root directory name and let gh use system configuration while adding origin and pushing");
assert.match(html, /<select id="textPromptSelect" class="dialog-input" aria-labelledby="textPromptTitle" hidden><\/select>/, "the application prompt should provide a native dropdown control");
assert.match(app, /function appPromptSelect\([\s\S]*placeholderOption\.disabled = true;[\s\S]*placeholderOption\.selected = true;[\s\S]*select\.value = "";/, "selection prompts should require an explicit choice with no preselected value");
assert.match(app, /async function promptGitPublishVisibility\(repoName\) \{[\s\S]*await appPromptSelect\(\{[\s\S]*\{ value: "public", label: "Public" \}[\s\S]*\{ value: "private", label: "Private" \}[\s\S]*placeholder: "Choose visibility…"/, "repository visibility should use a public/private dropdown with no default");
assert.doesNotMatch(app, /async function promptGitPublishVisibility\(repoName\) \{[\s\S]{0,500}window\.prompt/, "repository visibility should not use the browser text prompt");
assert.match(app, /function cleanGitPublishVisibilityInput\(value\)[\s\S]*if \(visibility !== "public" && visibility !== "private"\)[\s\S]*nothing was published/, "publication visibility must be exactly public or private");
assert.doesNotMatch(app, /visibility = "(?:public|private)"/, "publication visibility should never be defaulted in the frontend");
assert.match(server, /async function gitAddAllPayload\([\s\S]*platform\(\) === "win32"[\s\S]*findWindowsReservedGitPath\([\s\S]*windowsReservedGitPathFailure\(/, "guided git add should preflight Windows-reserved untracked paths before staging");
assert.match(app, /Pre-commit verification reminder[\s\S]*Continue with this commit/, "configured verification reminders should run before committing");
assert.match(server, /function gitWorkflowGenerationProfileArgument\(profile\)[\s\S]*--firstpick-webui-generation-profile=/, "server should encode the configured generation profile for the native extension command");
assert.match(server, /async function dispatchGitWorkflowGenerationAttempt\([\s\S]*record\.message = gitWorkflowGenerationPrompt\(record\.kind, record\.preferences, record\.nativeCommandName, profile\)[\s\S]*type: "prompt"/, "server should dispatch the configured generation profile without changing the tab profile");
assert.match(server, /function consumeGitWorkflowGenerationEvent\(tab, event[\s\S]*event\?\.type !== "agent_settled"[\s\S]*settleGitWorkflowGeneration\(tab, record, settlement\)/, "server should settle the owned Guided Git attempt only after agent settlement");
assert.match(server, /async function finishGitWorkflowGeneration\(tab, record[\s\S]*if \(tab\.gitWorkflowGeneration === record\) tab\.gitWorkflowGeneration = null;/, "server should finish Guided Git generation without restoring or changing the active tab model and effort");
assert.match(server, /case "\/api\/git-workflow\/branch-name": \{[\s\S]*generationId[\s\S]*readGitWorkflowBranchName\(cwd, \{ generationId/, "server should expose exactly correlated generated branch-name loading for the guided PR workflow");
assert.match(server, /case "\/api\/git-workflow\/branch":[\s\S]*createGitWorkflowBranchWorktree\(tab, body\)/, "server should route guided PR branch creation through worktree tabs");
assert.match(server, /async function createGitWorkflowBranchWorktree\(tab, body = \{\}\)[\s\S]*expectedStagedContentHashFromBody\(body\)[\s\S]*snapshotGitWorkflowBranchState\(root, tab\.cwd, expectedStagedContentHash\)[\s\S]*applyGitWorkflowBranchStateToWorktree\(snapshot, worktreePath\)[\s\S]*openWorktreeResultForTab\(tab, createdResult/, "guided PR worktree creation should verify and copy exact staged state before opening the worktree tab");
assert.match(server, /case "\/api\/git-workflow\/create-pr":[\s\S]*runGitHubWorkflowCommand\(\["pr", "create"/, "server should create PRs with the GitHub CLI after confirmation");
assert.doesNotMatch(app, /gitWorkflowVisibleTabId|Workflow belongs to/, "guided git workflow should not pin or show workflows outside their owning terminal tab");
assert.match(app, /function renderReleaseNpmOutputWidget\(\)/, "release-npm live output should use a specialized Web UI renderer");
assert.match(app, /async function refreshAppRunners\(tabContext = activeTabContext\(\)\)/, "frontend should load detected app runners for the active tab cwd");
assert.match(app, /function renderAppRunnerWidget\(\)/, "frontend should render app runner output in the shared top widget area");
assert.match(app, /function tabAppRunnerRunningRun\(tab\)[\s\S]*appRunnerIsRunning\(run\)/, "frontend should derive running app-runner state for terminal tab indicators");
assert.match(app, /function appendTerminalTabContent\(button, \{ title, indicator, meta, count = null, appRunnerRun = null, conversationModeActive = false,[^}]*\}\)[\s\S]*terminal-tab-app-runner-indicator/, "terminal tab content should render a visible app-runner badge");
assert.match(app, /function appendTerminalTabContent\(button,[\s\S]*terminal-tab-conversation-indicator/, "terminal tab content should render a visible Natural Conversation badge");
assert.match(app, /function renderTerminalTab\(tab, \{ showCwdAdd = false \} = \{\}\)[\s\S]*conversation-mode-running/, "terminal tabs should indicate active Natural Conversation mode per tab");
assert.match(css, /\.composer-conversation-mode-chip[\s\S]*\.composer-conversation-end-button/, "Natural Conversation composer controls should have dedicated styles");
assert.match(css, /\.composer\.conversation-mode-active[\s\S]*body\.conversation-mode-active \.composer::before/, "active Natural Conversation mode should visibly glow around the composer");
assert.match(css, /\.terminal-tab\.conversation-mode-running[\s\S]*\.terminal-tab-conversation-indicator/, "Natural Conversation tabs should have active-tab and badge styles");
assert.match(app, /function renderTerminalTabGroup\(group[\s\S]*tabGroupAppRunnerRunningRun\(groupTabs\)[\s\S]*app-runner-running/, "terminal tab groups should indicate when any child tab has a running app runner");
assert.match(server, /function tabMeta\(tab\)[\s\S]*appRunner: publicAppRunnerState\(tab\.appRunner\)/, "server should expose app-runner state in tab metadata for inactive tab indicators");
assert.match(app, /function renderAppRunnerInputForm\(run\)[\s\S]*app-runner-stdin-input[\s\S]*Send stdin/, "frontend should let running app runners receive line-oriented stdin");
assert.match(app, /function renderAppRunnerContextForm\(run\)[\s\S]*app-runner-context-lines-input[\s\S]*Add to context/, "frontend should let users choose how many app-runner output lines to add to agent context");
assert.match(app, /async function transferAppRunnerOutputToContext\(run, form\)[\s\S]*\/api\/app-runner\/context[\s\S]*scheduleRefreshMessages/, "frontend should submit selected app-runner output lines and refresh the transcript after context transfer");
assert.match(app, /function appRunnerFailureState\(runnerId, error[\s\S]*failed to start app runner/, "frontend should render visible app-runner start failures instead of only logging them");
assert.match(app, /appRunnerCustomFeedback[\s\S]*Custom app runner was not saved/, "custom app-runner save failures should be shown inline in the dialog");
assert.match(server, /function customAppRunnerUnavailableReason\(projectRoot, runner\)[\s\S]*Command is not available/, "server should explain why saved custom app runners are unavailable");
assert.match(server, /url\.pathname === "\/api\/app-runners" && req\.method === "GET"/, "server should expose detected app runners for the active tab cwd");
assert.match(server, /url\.pathname === "\/api\/app-runner" && req\.method === "POST"/, "server should start selected app runners directly");
assert.match(server, /url\.pathname === "\/api\/app-runner\/input" && req\.method === "POST"[\s\S]*sendAppRunnerInput/, "server should accept stdin for running app runners");
assert.match(server, /url\.pathname === "\/api\/app-runner\/context" && req\.method === "POST"[\s\S]*transferAppRunnerContext/, "server should expose app-runner output transfer into agent context");
assert.match(server, /function transferAppRunnerContext\(tab, body = \{\}\)[\s\S]*sendWebuiHelperCommand\(tab, "app-runner-context"[\s\S]*publicAppRunnerState\(run\)/, "server should send selected app-runner output lines through the Web UI helper as a custom context message");
assert.match(server, /function addGoRunner\(runners, cwd\)[\s\S]*Go\/Golang app entry/, "server should detect Go\/Golang app runners");
assert.match(server, /function addZigRunner\(runners, cwd\)[\s\S]*zig build run[\s\S]*zig run/, "server should detect Zig build and entry-file runners");
assert.match(server, /function addCppRunners\(runners, cwd\)[\s\S]*C\/C\+\+ CMake executable target[\s\S]*language: "C\+\+"/, "server should detect C\/C++ CMake and entry-file runners");
assert.match(server, /function addDockerComposeRunner\(runners, cwd\)[\s\S]*docker compose up[\s\S]*docker-compose up/, "server should detect Docker Compose runners");
assert.match(server, /APP_RUNNER_SHELL_SCRIPT_DIRS = \["", "dev", "scripts", "dev\/scripts"\][\s\S]*function addShellScriptRunners\(runners, cwd\)/, "server should detect bash\/zsh\/fish scripts in root, dev, scripts, and dev\/scripts");
assert.match(app, /const releaseNpmOutputExpandedByTab = new Map\(\)/, "release-npm output collapse state should be tracked per browser tab");
assert.match(app, /const workflowTerminalScrollByTab = new Map\(\)/, "workflow terminal follow state should be isolated per browser tab");
assert.match(app, /function renderReleaseNpmOutputDetails\(key, streamHeader, terminal, controls = null\)[\s\S]*node\.open = releaseNpmOutputExpandedByTab\.get\(stateKey\) !== false[\s\S]*release-npm-output-toggle/, "release-npm output should render as a browser-side details expander");
assert.match(app, /function workflowMetaItem\(label, value[\s\S]*workflow-meta-label[\s\S]*workflow-meta-value[\s\S]*workflow-meta-description/, "workflow metadata should pair human-readable labels and values with an optional visible description");
assert.match(app, /function bindWorkflowTerminalScroll\([\s\S]*Auto-follow paused[\s\S]*distanceFromBottom <= 24[\s\S]*requestAnimationFrame\(restorePosition\)/, "workflow output should preserve reading position and follow only near the live tail");
assert.match(app, /meta\.setAttribute\("role", "group"\)[\s\S]*meta\.setAttribute\("aria-label", "Workflow run summary"\)[\s\S]*"Limited history"[\s\S]*"Older output omitted from this view\."/, "workflow subprocess metadata should expose an accessible group and visible output-limit explanation");
assert.match(app, /terminal\.dataset\.preserveScrollOnToggle = "true"[\s\S]*bindWorkflowTerminalScroll\(terminal, outputDetails, followStatus, \{ live, runId: payload\.runId \}\)/, "workflow output should opt into its own position restoration without changing shared terminal toggles");
assert.match(app, /workflowMetaItem\("Run"[\s\S]*workflowMetaItem\("Phase"[\s\S]*workflowMetaItem\("Tasks"[\s\S]*"Limited history"/, "workflow subprocess summary should distinguish status, phase, task progress, and limited output history");
assert.match(app, /releaseNpmStreamHeader\("Live output stream", outputLines\.length, \{ live: true \}\)/, "release-npm live output should expose a clear stream heading");
assert.match(app, /renderReleaseNpmOutputDetails\("release-npm:output", streamHeader, terminal, controls\)/, "release-npm live stream should be wrapped in the local expander");
assert.match(app, /function renderReleaseAurOutputWidget\(\)/, "release-aur live output should use a specialized Web UI renderer");
assert.match(app, /releaseNpmActionButton\("Abort", "\/release-abort", "danger"\)/, "release-npm Web UI output should expose an abort action");
assert.match(app, /releaseNpmActionButton\("Abort", "\/release-aur abort", "danger"\)/, "release-aur Web UI output should expose an abort action");
assert.match(app, /key === "todo-progress" && isOptionalFeatureEnabled\("todoProgressWidget"\) \? renderTodoProgressWidget\(key, lines\) : null/, "todo-progress should use the specialized widget renderer only when enabled");
assert.match(app, /let transientMessages = \[\]/, "frontend should keep transient Web UI/extension output messages");
assert.match(app, /function orderedTranscriptItems\(\)/, "frontend should merge persisted and transient messages chronologically");
assert.match(app, /items\.sort\(\(a, b\) => a\.timestampMs - b\.timestampMs \|\| a\.order - b\.order\)/, "transient extension output should not pin itself below newer persisted messages");
assert.match(app, /const ACTION_FEEDBACK_REACTIONS = \{/, "frontend should define direct feedback reactions");
assert.match(app, /message\?\.role === "assistant" \|\| message\?\.role === "toolExecution" \|\| message\?\.role === "toolResult" \|\| message\?\.role === "bashExecution"/, "frontend should allow reactions on final assistant output as well as actions");
assert.match(app, /function renderActionFeedbackControls\(/, "frontend should render per-message reaction controls");
assert.match(app, /function toolResultPreviewText\(message, lineLimit = 10\)/, "tool results should derive a ten-line collapsed preview");
assert.match(app, /const WEBUI_TOOL_RENDERERS = \{[\s\S]*?function renderSingleToolExecution\(parent, message\)[\s\S]*?WEBUI_TOOL_RENDERERS[\s\S]*?function renderToolExecution\(parent, message\)[\s\S]*?renderSingleToolExecution\(parent, message\)/, "paired tool cards should use the browser-side built-in tool renderer registry");
assert.match(app, /appendToolRawDetails\(parent, tool\)/, "paired tool cards should keep a safe raw-data expander for debugging renderer mismatches");
assert.match(app, /function toolStateMeta\(tool\)/, "tool cards should expose consistent status and elapsed metadata across built-in renderers");
assert.doesNotMatch(app, /TOOL_LIVE_UPDATE_THROTTLE_MS|liveToolRenderQueue/, "superseded per-tool timers should not compete with the bounded stream controller");
const updateLiveToolCardSource = appFunctionSource("updateLiveToolCard", "renderLiveToolRun");
assert.match(updateLiveToolCardSource, /transcriptRenderer\.ownSurface\(body[\s\S]*?transcriptRenderer\.commitTranscriptMutation\(\{[\s\S]*?kind: "reconcile"[\s\S]*?transcriptRenderer\.replaceChildren\(body\)[\s\S]*?renderToolExecution\(body, message\)/, "live tool card updates should re-render the existing semantic body through the transcript coordinator");
assert.match(app, /function applyToolExecutionBubbleState\(bubble, message\)[\s\S]*?bubble\.dataset\.toolStatus !== status[\s\S]*?bubble\.classList\.add\(nextClass\)[\s\S]*?bubble\.classList\.toggle\("error"/, "tool status classes should not be removed and re-added on every live update");
assert.match(app, /function toolExecutionRenderSignature\(message\)[\s\S]*?normalizeToolExecution\(message\)[\s\S]*?toolRenderSignatureReplacer\(\)/, "tool cards should derive stable render signatures from normalized tool payloads");
assert.match(app, /const nextRenderSignature = toolExecutionRenderSignature\(message\)[\s\S]*?bubble\._toolRenderSignature === nextRenderSignature[\s\S]*?return true;[\s\S]*?bubble\._toolRenderSignature = nextRenderSignature/, "live tool card updates should skip identical body re-renders");
assert.match(app, /message\.role === "toolExecution"[\s\S]*?renderToolExecution\(body, message\);[\s\S]*?bubble\._toolRenderSignature = toolExecutionRenderSignature\(message\);/, "new tool cards should cache their initial render signature");
assert.match(app, /applyToolExecutionUpdate: \(event\) => \{\s+if \(!compactOutputActive\(\) && !isIntercomTransportToolName\(event\?\.toolName\)\) applyTranscriptToolExecutionUpdate\(event\);/, "live tool updates should enter the bounded transcript controller sink");
assert.match(app, /function applyTranscriptToolExecutionUpdate\(event\)[\s\S]*?event\.partialResult[\s\S]*?renderLiveToolRun\(run, \{ scroll: false \}\)/, "coalesced tool_execution_update events should update transcript-visible tool cards in the controller frame");
assert.match(app, /function captureReusableToolCards\(\)[\s\S]*?\.message\.toolExecution\[data-tool-call-id\]/, "full transcript re-renders should capture existing tool cards before clearing the chat");
assert.match(app, /function appendMessage\(message,[\s\S]*?reusableToolCards = null[\s\S]*?reuseToolExecutionBubble\(reusableToolCards, message/, "message rendering should reuse matching tool cards instead of replacing them during refreshes");
assert.match(app, /function renderAllMessages\(\{ preserveScroll = false, forceRebuild = false \} = \{\}\)[\s\S]*?const reusableToolCards = captureReusableToolCards\(\);[\s\S]*?appendTranscriptMessage\(entry\.item\.message,[\s\S]*?reusableToolCards,/, "transcript refreshes should pass reusable tool cards through to item rendering");
assert.match(app, /const keyedToolExecution = message\.role === "toolExecution" && message\.toolCallId[\s\S]*?keyedToolExecution \? "toolExecution"[\s\S]*?keyedToolExecution \? "" : message\.title[\s\S]*?keyedToolExecution \? "" : message\.timestamp/, "tool action entry identity should stay stable when live transient cards become persisted transcript cards");
assert.match(app, /appendText\(preview, toolResultPreviewText\(message, 10\), "code-block tool-result-preview-text"\)/, "collapsed tool results should render the first ten preview lines by default");
assert.match(app, /function assistantDisplayMessages\(message\)/, "assistant history should split thinking and tool-call parts out of the final Assistant output card");
assert.match(app, /function assistantHasToolCallAfter\(content, index\)/, "assistant text that precedes a tool call should be detectable and suppressible");
assert.match(app, /if \(!assistantHasToolCallAfter\(content, index\)\) finalParts\.push\(finalPart\);/, "assistant history should not render pre-tool-call assistant text as final output");
assert.match(app, /typeof content === "string"[\s\S]*?splitThinkingFormatText\(content\)[\s\S]*?content: parsed\.finalText/, "assistant string messages with tagged <think> output should render final text separately");
assert.match(app, /const textForThinkingFormat[\s\S]*?splitThinkingFormatText\(textForThinkingFormat\)[\s\S]*?appendThinkingFormatDisplayMessages\(displayMessages, base, parsed\)[\s\S]*?finalParts\.push/, "assistant text parts with tagged <think> output should split into thinking and final-output cards");
assert.match(app, /return content\.trim\(\) \? \[\{ \.\.\.message, title: "final output" \}\] : \[\]/, "assistant messages with stripped empty text should not render empty final-output cards");
assert.match(app, /function isEmptyAssistantTextPart\(part\)[\s\S]*?part\.type === "text"[\s\S]*?!assistantTextPartText\(part\)\.trim\(\)/, "empty assistant text parts should be recognized as skippable provider metadata");
assert.match(app, /if \(isEmptyAssistantTextPart\(part\)\) continue;/, "empty assistant text parts should not render as assistant-event cards");
assert.match(app, /function assistantFinalOutputPart\(part\)[\s\S]*?if \(part\.type === "text"\) \{[\s\S]*?const text = assistantTextPartText\(part\);[\s\S]*?return text\.trim\(\) \? \{ \.\.\.part, type: "text", text \} : null;/, "assistant text parts should normalize supported text payload shapes");
assert.match(app, /\["assistant", "toolExecution"\]\.includes\(transcriptMessage\.role\) \? messageIndex : -1/, "final Assistant output and paired tool action cards should keep the source message index for feedback");
assert.match(app, /function ensureStreamingThinkingBubble\(\)[\s\S]*if \(!thinkingOutputVisible\) return false/, "live thinking should respect the show/hide thinking-output toggle");
assert.match(app, /const UNEXPOSED_THINKING_TEXT = "No thinking content was exposed by the provider\."/, "frontend should name the provider no-thinking placeholder for suppression");
assert.match(app, /THINKING_FORMAT_OPEN_TAG_REGEX/, "frontend should recognize tagged <think> provider output");
assert.match(app, /CHANNEL_THINKING_FORMAT_OPEN_TAG_REGEX = \/\^<\\\|\(\[a-z\]\[\\w-\]\*\)>\/i/, "frontend should recognize tagged <|channel> provider output");
assert.match(app, /function thinkingFormatOpenMatch\(text\)[\s\S]*?CHANNEL_THINKING_FORMAT_OPEN_TAG_REGEX[\s\S]*?closeRegex: new RegExp\(`<\$\{escapeRegExp\(name\)\}\\\\\|>`/, "channel-style tagged output should create a matching <channel|> close delimiter");
assert.match(app, /function splitThinkingFormatText\(text, \{ streaming = false \} = \{\}\)[\s\S]*?thinkingFormatOpenMatch\(rest\)[\s\S]*?finalText: stripThinkingFormatOutputSeparator\(rest\)/, "tagged thinking output should split thinking text from final response text");
assert.match(app, /function visibleThinkingText\(text\)[\s\S]*?trimmed === UNEXPOSED_THINKING_TEXT[\s\S]*?return "";/, "provider no-thinking placeholders should normalize to empty thinking output");
assert.match(app, /if \(isThinkingPart\) \{[\s\S]*?visibleThinkingText\(assistantThinkingText\(part\)\)[\s\S]*?if \(thinking\) displayMessages\.push/, "assistant transcript splitting should skip empty or unexposed thinking parts");
assert.match(app, /message\.role === "thinking"[\s\S]*?visibleThinkingText\(message\.thinking \|\| textFromContent\(message\.content\)\)[\s\S]*?if \(thinkingOutputVisible && thinkingText\) appendThinkingMarkdown\(body, thinkingText\);/, "thinking cards should suppress empty and provider no-thinking placeholder output while rendering visible reasoning as markdown");
assert.match(app, /function showStreamingThinking\(initialText = ""\)[\s\S]*?if \(initialText && !streamThinking\.textContent\) renderThinkingMarkdown\(streamThinking, initialText\);/, "live thinking should not create a visible placeholder card before content arrives");
assert.match(app, /function setStreamingThinkingText\(text, \{ complete = false \} = \{\}\)[\s\S]*?if \(!thinking\) \{[\s\S]*?removeLiveTranscriptBubble\(streamThinkingBubble, "thinking-correction"\)/, "explicit empty thinking corrections should remove the draft card");
assert.match(app, /function syncStreamingThinkingFromUpdate\(event, update, \{ placeholder = "", render = true \} = \{\}\)[\s\S]*?return render \? setStreamingThinkingText\(streamThinkingRawText \|\| placeholder\) : true;/, "incremental thinking sync should only report success after setting visible thinking text");
assert.doesNotMatch(app, /text \|\| placeholder \|\| streamThinkingBubble/, "partial-message thinking sync should not clear an existing thinking card when a partial carries no visible thinking text");
assert.match(app, /update\.type === "thinking_start" \|\| update\.type === "thinking_delta"\) \{\s+syncStreamingThinkingFromUpdate\(event, update, \{ render: false \}\);\s+if \(thinkingOutputVisible && streamThinkingRawText\) thinkingStreamRenderScheduler\.request\(\{ complete: false \}\);/, "live thinking deltas should require visible raw thinking text before scheduling a card render");
assert.match(app, /function thinkingDeltaText\(update\) \{[\s\S]*?return visibleThinkingText\(update\.delta \|\| update\.thinking \|\| update\.content \|\| ""\);/, "live thinking deltas should suppress provider no-thinking placeholders too");
assert.match(app, /const THINKING_VISIBILITY_STORAGE_KEY = "pi-webui-thinking-visible"/, "thinking visibility should persist in browser storage");
assert.match(app, /function setThinkingOutputVisible\(visible[\s\S]*renderAllMessages\(\{ preserveScroll: true \}\)/, "thinking visibility changes should immediately re-render the transcript");
assert.match(app, /function assistantStreamingMessage\(event\)/, "live streaming should read the authoritative partial assistant message from RPC events like the TUI");
assert.match(app, /function syncStreamingThinkingFromUpdate\(event, update[\s\S]*?update\.type === "thinking_end"\) \{[\s\S]*?typeof update\.content === "string"[\s\S]*?setStreamThinkingRawText\(snapshot, \{ reconcile: true \}\);[\s\S]*?setStreamingThinkingText\(streamThinkingRawText, \{ complete: true \}\)/, "live thinking end should respect explicit content, including an empty correction");
assert.match(app, /function setStreamRawText\(text, \{ reason = "snapshot" \} = \{\}\)[\s\S]*?streamRawText = nextText;[\s\S]*?ensureStreamDerivedOutputState\(\)\.replace\(nextText, \{ reason \}\);/, "live assistant text should synchronize from partial messages through a cache-aware setter");
assert.match(app, /const TODO_PROGRESS_LINE_REGEX = /, "frontend should recognize live todo progress lines that will be moved into the todo widget");
assert.match(app, /function stripTodoProgressLines\(text, \{ streaming = false \} = \{\}\)/, "live Assistant output should strip todo-progress lines before rendering final-output text");
assert.match(app, /function syncLiveTodoProgressWidgetFromText\(text, tabId = activeTabId\)/, "authoritative Assistant checklist text should remain convertible into the todo-progress widget");
assert.doesNotMatch(app, /scheduleLiveTodoProgressWidgetSync\(streamRawText, event\.tabId \|\| activeTabId\)/, "raw streaming assistant text must not drive the todo-progress widget");
assert.match(app, /function renderStreamingAssistantText\(\{ complete = false \} = \{\}\)[\s\S]*?const thinkingFormat = syncStreamingThinkingFormat\(\{ complete \}\);[\s\S]*?const finalText = thinkingFormat\?\.hasThinkingFormat \? streamDerivedText\(\)\.finalText : streamRenderableAssistantText\(\);/, "streamed Assistant text should render cached derived output without directly rescanning raw stream text");
assert.match(app, /function syncStreamingThinkingFormat\(\{ complete = false \} = \{\}\)[\s\S]*?const parsed = streamDerivedText\(\)\.thinkingFormat;[\s\S]*?setStreamingThinkingText\(thinking, \{ complete: complete \|\| parsed\.complete \}\)/, "tagged <think> streaming output should update the live thinking card from cached parse state instead of flashing raw tags");
assert.match(app, /const finalText = thinkingFormat\?\.hasThinkingFormat \? streamDerivedText\(\)\.finalText : streamRenderableAssistantText\(\);/, "tagged <think> streaming output should render only final response text in the Assistant card");
assert.match(app, /const STREAM_OUTPUT_HIDE_DELAY_MS = 300/, "stream output hiding should be debounced to prevent rapid flicker");
assert.doesNotMatch(app, /STREAM_OUTPUT_TOOLCALL_GUARD_MS|scheduleStreamingAssistantTextRender/, "controller batching should be the only live assistant render scheduler");
assert.match(app, /function scheduleStreamBubbleHide\([\s\S]*?STREAM_OUTPUT_MIN_VISIBLE_MS/, "stream output cards should observe a minimum visible duration before hiding");
assert.match(app, /if \(finalText\) \{[\s\S]*?renderStreamingMarkdown\(streamText, finalText, \{ complete \}\);[\s\S]*?\} else \{\n\s+scheduleStreamBubbleHide\(\);/, "empty filtered stream output should schedule hide while visible stream output renders as Markdown");
assert.match(app, /function handleMessageUpdate\(event\)[\s\S]*?assistantStreamRenderScheduler\.request\(\{ complete: update\.type === "text_end" \}\);/, "controller-batched assistant text should render through the latest-wins transcript scheduler");
assert.match(app, /const assistantStreamRenderScheduler = createLatestWinsRenderScheduler\(\{\s+render: \(options\) => \{\s+renderStreamingAssistantText\(options\);/, "the assistant stream scheduler should render through the transcript-only sink");
assert.match(app, /streamToolCallSeen = true;\n\s+suppressStreamingAssistantTextBeforeToolCall\(\);/, "tool-call starts should remove pending assistant text from the live transcript");
assert.match(app, /function renderStreamingToolCallCard\(\{ scroll = false \} = \{\}\)[\s\S]*?appendMessage\(message, \{ streaming: true, itemKey:[\s\S]*?transcriptRenderer\.ownSurface\(streamToolCallText[\s\S]*?transcriptRenderer\.updateTextSurface\(\{[\s\S]*?text: displayText/, "live tool-call cards should render and update their stable semantic arguments surface in place");
assert.match(app, /applyToolCallUpdate: \(event\) => \{[\s\S]*?streamToolCalls\.ingest\(event\)[\s\S]*?updateStreamingToolCallFromState\(call\)/, "tool-call deltas should reconstruct indexed state before updating the transcript-only sink");
assert.match(app, /case "tool_execution_start":[\s\S]*?removeStreamingToolCallCard\(\)[\s\S]*?handleToolExecutionStart\(event\)/, "the streamed tool-call argument card should be removed when the real tool execution card starts");
assert.doesNotMatch(app, /Preparing tool call:/, "tool-call streaming should no longer show only the static preparing placeholder");
assert.match(app, /const created = appendMessage\(\{ role: "assistant", title: "final output"/, "live Assistant cards should be created only for final output text without a noisy Assistant label");
assert.match(app, /function renderMarkdownInto\(parent, text\)/, "assistant output should have a browser-native Markdown renderer");
assert.match(app, /safeMarkdownLinkHref\(url\)/, "Markdown links should be sanitized before rendering");
assert.match(app, /renderContent\(body, message\.content, \{ markdown: message\.role === "assistant" \|\| message\.role === "custom" \}\)/, "final assistant output should render through the Markdown path");
assert.match(app, /const hideMessageHeader = message\.role === "assistant" && !isCollapsibleOutput/, "assistant final-output cards should hide the redundant role header");
assert.match(app, /api\("\/api\/action-feedback", \{ method: "POST"/, "queued action feedback should post to the server after the run is idle");
assert.match(app, /function postQueuedFeedback\(tabId, items, tabContext = activeTabContext\(tabId\)\)/, "queued feedback should have a backward-compatible submit path");
assert.match(app, /\/api\/action-feedback not found; falling back to a normal prompt/, "new frontend should gracefully handle older running Web UI servers");
assert.match(app, /actionFeedbackSteerMessage\(item\)/, "live action feedback should be sent as steering while the agent is running");
assert.match(app, /function addTransientMessage\(\{ role = "notice"/, "frontend should render transient command output into the transcript");
assert.match(app, /addTransientMessage\(\{ role: "extension", title: "extension output"/, "extension notify output should appear in the transcript, not only the event log");
assert.match(app, /function renderRunIndicator\(/, "frontend should render an active agent indicator");
assert.match(app, /return "Agent is running: ";/, "active agent indicator should use the requested headline wording");
assert.doesNotMatch(app, /"agent running"/, "active agent indicator should not render a separate title/header label");
assert.doesNotMatch(app, /runIndicatorTimestamp/, "active agent indicator should not render a separate live timestamp header");
assert.match(app, /runIndicatorBubble = make\("article", "message runIndicator run-indicator-message streaming"\)/, "active agent indicator should retain its dedicated streaming-card appearance");
assert.match(html, /id="chat" class="chat" aria-live="polite"[\s\S]*?<\/div>\s*<div id="runIndicatorHost" class="run-indicator-host"><\/div>/, "active agent indicator should have a dedicated host immediately after the transcript");
assert.match(css, /\.run-indicator-host\s*\{[\s\S]*?padding: 0 1rem 1rem;/, "the dedicated run-indicator host should preserve the transcript card inset");
assert.match(css, /\.run-indicator-row\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow:\s*hidden;[\s\S]*?\.run-indicator-meta\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/, "changing run activity text should stay on one clipped line without resizing the status card");
assert.match(app, /function standaloneLiveTranscriptBubbles\(\)[\s\S]*?streamThinkingBubble[\s\S]*?streamToolCallBubble[\s\S]*?streamBubble[\s\S]*?compactThinkingBubble[\s\S]*?compactTextBubble/, "transcript reconciliation should identify standalone live-tail bubbles that must stay mounted");
assert.match(app, /function resetChatOutput\(\)[\s\S]*?liveBubbles = standaloneLiveTranscriptBubbles\(\)[\s\S]*?preservedNodes[\s\S]*?child === elements\.stickyUserPromptButton \|\| liveBubbles\.has\(child\)[\s\S]*?transcriptRenderer\.replaceChildren\(elements\.chat, \.\.\.preservedNodes\)/, "transcript resets should reconcile through the coordinator while preserving only transcript-owned live output");
assert.match(app, /function appendChatMessageBubble\(bubble, \{ liveTail = false \} = \{\}\)[\s\S]*?!liveTail && liveBubbles\.has\(child\)[\s\S]*?insertBefore\(bubble, tailAnchor\)/, "reconciled history should preserve the stable live transcript tail while new live output stays chronological");
assert.match(app, /appendChatMessageBubble\(created\.bubble, \{ liveTail: streaming \|\| message\?\.live === true \}\)/, "streaming thinking, assistant text, and live tools should append after earlier live output");
assert.match(app, /setChatScrollTopInstant\(Math\.min\(previousScrollTop, elements\.chat\.scrollHeight\)\)/, "paused-reader scroll restoration should bypass smooth scrolling to avoid a down-then-back animation");
assert.match(app, /function ensureRunIndicatorBubble\(\)[\s\S]*?!runIndicatorBubble \|\| !runIndicatorText \|\| !runIndicatorMeta[\s\S]*?runIndicatorBubble\.parentElement !== elements\.runIndicatorHost[\s\S]*?elements\.runIndicatorHost\.replaceChildren\(runIndicatorBubble\)/, "active agent indicator should reuse its existing bubble in the dedicated status host");
assert.match(app, /function tabsRenderSnapshotSignature\(tabList = \[\]\)[\s\S]*?const tabsRenderChanged = previousTabsRenderSignature !== tabsRenderSnapshotSignature\(nextTabs\);[\s\S]*?if \(tabsChanged\) \{[\s\S]*?syncTabMetadata\(tabs\);[\s\S]*?if \(tabsRenderChanged \|\| activeTabId !== previousActiveTabId \|\| selectStored\) renderTabs\(\);[\s\S]*?else syncTabPolling\(\);/, "unchanged background-tab polling should not rebuild terminal chrome or disturb the followed transcript");
assert.match(app, /function updateSessionSummaryForTab\([\s\S]*?if \(previous && tabsSnapshotSignature\(previous\) === tabsSnapshotSignature\(normalized\)\) return previous;/, "unchanged session-summary metadata should not schedule another terminal-strip render");
assert.match(app, /function updateStickyUserPromptButton\(\)[\s\S]*?const renderSignature = JSON\.stringify\([\s\S]*?button\.dataset\.renderSignature === renderSignature\) return;[\s\S]*?button\.replaceChildren\(\.\.\.children\);/, "focus reconciliation should preserve unchanged sticky-prompt children instead of disturbing chat scroll anchoring");
assert.match(app, /let tabStateCache = new Map\(\);[\s\S]*?let tabStatsCache = new Map\(\);[\s\S]*?let tabWorkspaceCache = new Map\(\);[\s\S]*?function cachedStateForTabSwitch[\s\S]*?latestStats = activeTabId \? tabStatsCache\.get\(activeTabId\)[\s\S]*?latestWorkspace = activeTabId \? tabWorkspaceCache\.get\(activeTabId\)[\s\S]*?restoreComposerActionSlotLayout\(\);/, "terminal switching should restore cached run, context, workspace, and composer geometry before repainting");
assert.match(app, /const activityState = tab\?\.running && pendingExtensionUiRequestCount > 0[\s\S]*?pendingExtensionUiRequestCount,[\s\S]*?activityState,/, "tab polling should compare rendered activity state instead of volatile lifecycle metadata");
assert.match(app, /const statusText = sidebarPresentation[\s\S]*?controlDeckPlacementStatus\.textContent !== statusText/, "foreground layout reconciliation should not rewrite unchanged Control Deck status text");
assert.match(app, /const optionsSignature = JSON\.stringify\(matchingModels\.map[\s\S]*?modelSelect\.dataset\.optionsSignature !== optionsSignature/, "foreground model refreshes should preserve an unchanged model selector DOM");
assert.match(app, /function renderSessionSummaryControls\(\)[\s\S]*?renderSignature === sessionSummaryControlsRenderSignature\) return;[\s\S]*?sessionSummaryControlsRenderSignature = renderSignature;/, "foreground command refreshes should not schedule unchanged session-summary tab chrome");
assert.match(app, /const previousCatalog = commandCatalogsByTab\.get\(tabContext\.tabId\);[\s\S]*?tabsSnapshotSignature\(previousCatalog\) !== tabsSnapshotSignature\(catalog\)\) scheduleTabsRender\(\);/, "foreground command refreshes should retain unchanged terminal controls");
assert.doesNotMatch(app, /elements\.chat\.(?:append|insertBefore)\(runIndicatorBubble/, "the active agent indicator must never be mounted in the transcript");
assert.match(app, /const headline = runIndicatorHeadline\(\);\n\s+if \(runIndicatorText\.textContent !== headline\) runIndicatorText\.textContent = headline;/, "active agent indicator should avoid redundant headline DOM writes that can flicker");
assert.match(app, /if \(runIndicatorMeta\.textContent !== meta\) runIndicatorMeta\.textContent = meta;[\s\S]*?const elapsed = runIndicatorShowsElapsed\(\) \? ` · run time[\s\S]*?runIndicatorElapsed\.textContent = elapsed;/, "active agent indicator should avoid redundant metadata DOM writes and keep the elapsed ticker in its own aria-hidden span");
assert.match(app, /runIndicatorShowsElapsed\(\) \? ` · run time/, "active agent indicator should label elapsed run time instead of showing a bare counter");
assert.match(app, /case "agent_settled":(?:(?!case ")[\s\S])*?clearRunIndicatorActivity\(\{ deferRemoval: !autoFollowChat \|\| !isChatNearBottom\(\) \}\);(?:(?!case ")[\s\S])*?scheduleSemanticReconcile\(\{[^}]*messages: true/, "settlement should keep the tail height stable for readers above the live edge until the coalesced semantic reconciler refreshes canonical messages");
assert.match(app, /Abort requested/, "abort feedback should clarify that Web UI is checking stop status");
assert.match(app, /const ABORT_LONG_PRESS_MS = 1200/, "Abort long-press timing should be explicit and short enough to feel responsive");
assert.match(app, /function showAbortTapHint\(\)[\s\S]*?"Hold to abort"/, "a quick tap on Abort should explain the hold instead of doing nothing");
assert.match(app, /const ABORT_LONG_PRESS_TICK_MS = 100/, "Abort hold countdown should update visibly while held");
assert.match(app, /const ABORT_LONG_PRESS_RELEASE_GRACE_MS = 350/, "Escape release cancellation should be debounced to ignore spurious keyup during key repeat");
assert.match(app, /let escapeAbortHoldSuppressesDoubleEscape = false/, "Escape abort hold should track suppression separately from abort button UI state");
assert.match(app, /function shouldSuppressEmptyPromptEscapeAction\(\)[\s\S]*escapeAbortHoldSuppressesDoubleEscape[\s\S]*suppressEmptyPromptEscapeUntil/, "Escape abort hold should suppress the empty-prompt double-Escape action until keyup or grace expiry");
assert.match(app, /function isAbortLongPressActive\(\) \{\n\s+return abortLongPressStartedAt > 0;\n\}/, "Abort hold state should stay active from its monotonic start time, not timer id truthiness");
assert.match(app, /async function abortActiveRun\(\{ source = "button" \} = \{\}\)/, "Abort should be centralized for button, Esc, and long-press triggers");
assert.match(app, /elements\.abortButton\.addEventListener\("pointerdown", startAbortLongPress\)/, "Abort should support pointer long-press");
assert.match(app, /else if \(!event\.repeat\) startAbortLongPress\(event, \{ source: "escape" \}\)/, "Escape should arm the guarded abort hold only on the initial keydown");
assert.match(app, /if \(isAbortLongPressActive\(\)\) \{\n\s+resumeAbortLongPressAffordance\(\);\n\s+return true;\n\s+\}\n\s+resetAbortLongPressAffordance\(\);/, "repeat or duplicate start events should resume instead of restart an in-progress abort countdown");
assert.match(app, /abortLongPressDeadlineAt = abortLongPressStartedAt \+ ABORT_LONG_PRESS_MS/, "Abort hold countdown should use an immutable deadline for display and completion");
assert.match(app, /function completeAbortLongPress\(\)[\s\S]*?if \(abortLongPressReleasePending\) return;[\s\S]*?if \(isAbortAvailable\(\)\) abortActiveRun\(\{ source \}\);[\s\S]*?else \{\n\s+resetAbortLongPressAffordance\(\);\n\s+updateComposerModeButtons\(\);\n\s+\}/, "completed abort holds should abort only when no release is pending and reset cleanly if the run already stopped");
assert.match(app, /if \(shouldSuppressEmptyPromptEscapeAction\(\)\) \{\n\s+event\.preventDefault\(\);\n\s+return;\n\s+\}\n\s+if \(event\.repeat\)/, "completed Escape abort holds should suppress trailing Escape events before double-Escape handling");
assert.match(app, /if \(event\.repeat\) \{\n\s+event\.preventDefault\(\);\n\s+return;\n\s+\}\n\s+if \(document\.activeElement === elements\.promptInput[\s\S]*doubleEscapeAction/, "held Escape key-repeat should not trigger the double-Escape action");
assert.match(app, /window\.addEventListener\("keyup"[\s\S]*abortLongPressSource === "escape"[\s\S]*scheduleAbortLongPressReleaseReset[\s\S]*finishEscapeAbortHoldSuppression\(\)/, "releasing Escape should debounce-cancel a pending guarded abort hold and re-enable double-Escape after a grace window");
assert.match(app, /function resumeAbortLongPressAffordance\(\)[\s\S]*clearAbortLongPressResetTimer\(\);\n\s+abortLongPressReleasePending = false;\n\s+tickAbortLongPressAffordance\(\);/, "new Escape keydown events should cancel pending release resets without restarting countdown");
assert.match(app, /function addAbortTranscriptNotice\(/, "abort button should render a transcript-visible aborted notice");
assert.match(app, /this transcript marks the run as aborted/, "abort notice should clearly mark the agent output as aborted");
assert.match(app, /await api\("\/api\/abort"[\s\S]*?addAbortTranscriptNotice\(\{ activeRun: hadActiveRun \}\)/, "abort button should add the aborted transcript notice after the abort request succeeds");
assert.match(app, /let runIndicatorGraceCheckTimer = null/, "local-only run indicators should have a grace-check timer");
assert.match(app, /const RUN_INDICATOR_STATE_RECHECK_MS = 5000/, "active run indicators should periodically re-check state");
assert.match(app, /function scheduleRunIndicatorGraceCheck\(/, "local-only run indicators should schedule a follow-up state check");
assert.match(app, /function maybeRefreshRunIndicatorState\([\s\S]*?refreshState\(tabContext\)/, "active run indicators should poll state so missed completion events do not leave stale cards");
assert.match(app, /function clearRunIndicatorActivity[\s\S]*?clearRunIndicatorGraceCheck\(\)[\s\S]*?runIndicatorLastStateCheckAt = 0/, "clearing the active agent indicator should cancel pending grace checks and reset state polling");
assert.match(app, /scheduleRunIndicatorGraceCheck\(tabContext = activeTabContext\(\)\)[\s\S]*?refreshState\(tabContext\)/, "stale local-only run indicators should re-check state after the start grace period");
assert.match(app, /function scheduleAbortStateChecks\(/, "abort handling should poll state so the active indicator can clear after stop confirmation");
assert.match(app, /case "tool_execution_start":[\s\S]*?suppressStreamingAssistantTextBeforeToolCall\(\)[\s\S]*?handleToolExecutionStart\(event\)[\s\S]*?setRunIndicatorActivity\(`Running tool:/, "tool execution should suppress pre-tool assistant text, then update the active agent indicator and live tool card");
assert.match(app, /applyToolExecutionUpdate: \(event\) => \{\s+if \(!compactOutputActive\(\) && !isIntercomTransportToolName\(event\?\.toolName\)\) applyTranscriptToolExecutionUpdate\(event\);/, "tool execution updates should enter the transcript-only controller sink before lifecycle dispatch");
assert.match(app, /case "auto_retry_start":[\s\S]*?addTransientMessage\(\{ role: "warn", title: "auto retry"/, "auto-retry starts should be transcript-visible warnings");
assert.match(app, /function trackAutoRetryStateFromEvent\(event\)[\s\S]*?event\.type === "auto_retry_start"[\s\S]*?autoRetryingTabs\.add\(tabId\)[\s\S]*?suppressPendingAgentDoneNotificationsForTab\(tabId\)[\s\S]*?markTabWorkingLocally\(tabId\)/, "auto-retry starts should suppress misleading done notifications and keep the tab working");
assert.match(app, /function notifyAgentDone[\s\S]*?agentDoneNotificationKeys\.add\(key\);\n\s+if \(isAutoRetryingTab\(tabId\)\) return;/, "agent-done notifications should be ignored while a tab is auto-retrying");
assert.match(app, /function queueAgentDoneBrowserNotification[\s\S]*?setTimeout\([\s\S]*?isAutoRetryingTab\(tabId\)[\s\S]*?promptRoutingTabs\.has\(tabId\)[\s\S]*?activityForTab\(tab\)\.isWorking[\s\S]*?AGENT_DONE_NOTIFICATION_RETRY_GRACE_MS/, "agent-done notifications should wait briefly and suppress stale alerts when retry or new work starts");
assert.match(app, /case "extension_error":[\s\S]*?addTransientMessage\(\{ role: "error", title: "extension error"/, "extension errors should be transcript-visible error cards");
assert.match(app, /setRunIndicatorActivity\("Requesting context compaction…"\);\n\s+scrollChatToBottom\(\{ force: true \}\);/, "manual compaction should force-follow the transcript to the bottom status card");
assert.match(app, /function markContextUsageUnknownAfterCompaction\(/, "compaction should have a dedicated context-usage invalidation helper");
assert.match(app, /case "compaction_end":[\s\S]*?markContextUsageUnknownAfterCompaction\(event\.tabId \|\| activeTabId\)/, "finished compaction should make footer context usage unknown instead of showing stale pressure");
assert.match(app, /function footerStatsContextDisplay[\s\S]*?contextUsageUnknownAfterCompaction\(\)[\s\S]*?unknownFooterContextText/, "fallback footer context should show an unknown value after compaction invalidates usage");
assert.match(app, /case "agent_settled":[\s\S]*?clearRunIndicatorActivity\(\{ deferRemoval:[^}]+\}\)/, "agent settlement should clear indicator activity while deferring tail removal for readers above the live edge");
assert.match(app, /case "agent_settled":[\s\S]*?notifyAgentDone\(event\.tabId \|\| activeTabId/, "agent settlement should trigger optional done notifications");
assert.doesNotMatch(app.match(/case "agent_end":[\s\S]*?case "message_start":/)?.[0] || "", /notifyAgentDone\(/, "an intermediate low-level agent end must not trigger a done notification");
assert.match(app, /function getPathTrigger\(\)/, "prompt composer should detect @ file\/path reference triggers");
assert.match(app, /api\(`\/api\/path-suggestions\?query=\$\{encodeURIComponent\(trigger\.query\)\}`/, "@ reference suggestions should load from the server as the user types");
assert.match(app, /async function api\([\s\S]*?if \(signal\?\.aborted \|\| error\?\.name === "AbortError"\) throw error;[\s\S]*?setBackendOffline\(true, offlineError\)/, "cancelled @ autocomplete requests should not mark the server offline");
assert.match(app, /formatPathReference\(suggestion\.path, trigger\.quoted\)/, "accepting a path suggestion should insert an @ reference into the prompt");
assert.match(app, /let pathSuggestActiveQuery = null/, "@ autocomplete should track the active path query to avoid duplicate refresh flicker");
assert.match(app, /pathSuggestActiveQuery === trigger\.query[\s\S]*?return;/, "@ autocomplete should skip duplicate same-query fetches from input and keyup events");
assert.match(app, /const keepExistingPathMenu = suggestionMode === "path"[\s\S]*?if \(!keepExistingPathMenu\) \{[\s\S]*?Finding paths…/, "@ autocomplete should keep the existing menu visible while refreshing a new path query");
assert.match(app, /elements\.commandSuggest\.setAttribute\("aria-busy", "true"\)/, "@ autocomplete should mark async path refreshes busy without clearing rendered suggestions");
assert.match(app, /function getBangTrigger\(\)/, "prompt composer should detect leading ! and !! shell command triggers");
assert.match(app, /function renderBangSuggestions\(trigger[\s\S]*api\(`\/api\/bang-suggestions\?query=\$\{encodeURIComponent\(trigger\.query\)\}`/, "bang autocomplete should load suggestions from the Web UI server as the user types");
assert.match(app, /function renderBangSuggestionItems\(trigger[\s\S]*insertBangSuggestion\(index\)/, "bang autocomplete should render clickable shell command suggestions");
assert.match(app, /function insertBangSuggestion\(index = commandSuggestIndex\)/, "accepting a bang suggestion should insert a shell command after the ! or !! prefix");
assert.match(app, /if \(suggestionMode === "bang"\) return insertBangSuggestion\(index\)/, "generic autocomplete insertion should route bang suggestions to the bang inserter");
assert.match(app, /isOptionalFeatureEnabled\("bangCommandAutocomplete"\)[\s\S]*renderBangSuggestions\(bangTrigger/, "bang autocomplete should only render when the optional companion is detected and enabled");
assert.match(app, /function setActiveCommandSuggestionFromPointerMove\(index, event\)/, "command and path autocomplete should route pointer selection through movement detection");
assert.match(app, /item\.addEventListener\("pointermove", \(event\) => setActiveCommandSuggestionFromPointerMove\(index, event\)\);[\s\S]*?item\.addEventListener\("click", \(\) => insertCommandSuggestion\(index\)\);/, "slash command autocomplete should only follow pointer movement before click insertion");
assert.match(app, /item\.addEventListener\("pointermove", \(event\) => setActiveCommandSuggestionFromPointerMove\(index, event\)\);[\s\S]*?item\.addEventListener\("click", \(\) => insertPathSuggestion\(index\)\);/, "path autocomplete should only follow pointer movement before click insertion");
assert.match(app, /item\.addEventListener\("pointermove", \(event\) => setActiveCommandSuggestionFromPointerMove\(index, event\)\);[\s\S]*?item\.addEventListener\("click", \(\) => insertBangSuggestion\(index\)\);/, "bang autocomplete should only follow pointer movement before click insertion");
assert.doesNotMatch(app, /addEventListener\("mouseenter", \(\) => setActiveCommandSuggestion\(index\)\)/, "autocomplete should not change active selection on stationary mouseenter");
assert.match(app, /function resizePromptInput\(\)/, "prompt textarea should auto-resize from a one-line default");
assert.match(app, /elements\.promptInput\.addEventListener\("input", \(\) => \{[\s\S]*?resizePromptInput\(\);/, "prompt textarea should resize whenever the user edits it");
assert.match(app, /function updateComposerModeButtons\(\)/, "composer should relocate Steer and Follow-up based on run state");
assert.match(app, /const target = runActive \? elements\.composerRow : elements\.composerActionsPanel/, "Steer and Follow-up should move into the bottom row only while an agent run is active");
assert.match(app, /const before = runActive \? elements\.abortButton : null/, "active Steer and Follow-up controls should sit before Abort and Send");
assert.match(app, /button\.hidden = !runActive;\n\s+button\.disabled = !runActive;/, "Steer and Follow-up should be hidden and disabled when the agent is not running");
assert.match(app, /renderBusyPromptBehaviorTag\(\);\n\s+renderSendButtonMode\(runActive\);\n\s+document\.body\.classList\.toggle\("pi-run-active", runActive \|\| abortAvailable\)/, "composer mode refresh should keep the busy prompt behavior tag and Send label current");
assert.match(app, /const abortHoldActive = isAbortLongPressActive\(\);\n\s+if \(!abortAvailable && !abortHoldActive\) resetAbortLongPressAffordance\(\);\n\s+elements\.abortButton\.hidden = !abortAvailable && !abortHoldActive;\n\s+elements\.abortButton\.disabled = \(!abortAvailable && !abortHoldActive\) \|\| abortRequestInFlight;/, "Abort should stay visible during an active hold even if run state briefly refreshes unavailable");
assert.match(app, /document\.body\.classList\.toggle\("pi-run-active", runActive \|\| abortAvailable\)/, "run-active or abort-available state should be reflected in CSS for mobile composer layout");
assert.match(app, /function showComposerButtonTooltip\(button\)/, "empty mode-button taps should show the usage tooltip");
assert.match(app, /function renderBusyPromptBehaviorTag\(\)[\s\S]*?tag\.textContent = label/, "busy prompt behavior tag should render only the current follow-up\/steer setting");
assert.doesNotMatch(app, /Busy send: \$\{label\}/, "busy prompt behavior tag should not prefix the current mode label");
assert.match(app, /function renderSessionSkillTags\(tabId = activeTabId\)[\s\S]*?filter\(\(entry\) => entry\.kinds\.has\("read"\)\)[\s\S]*?make\("button", classes\.join\(" "\), entry\.name\)[\s\S]*?openSkillEditor\(entry\)/, "skill tags should render as clickable buttons only after the full skill context was read");
assert.ok(app.includes('normalized.match(/\\/skills\\/([^/]+)\\/SKILL\\.md$/i)'), "skill context tracking should require SKILL.md paths");
assert.match(app, /function trackSkillsFromToolInvocation\(tabId, toolName[\s\S]*?name\.toLowerCase\(\) !== "read"\) return false;[\s\S]*?kind: "read"/, "skill context tracking should only follow read-tool invocations");
assert.match(app, /function trackSkillUsage\(tabId, skillName[\s\S]*?persistSkillUsage\(\);[\s\S]*?renderSessionSkillTags\(tabId\)/, "skill tags should persist and live-update when a read skill is tracked");
assert.match(app, /const SKILL_USAGE_STORAGE_KEY = "pi-webui-skill-usage-v1"/, "read skill tags should have browser storage for hard-refresh and restart restore");
assert.match(app, /function persistSkillUsage\(\)[\s\S]*?localStorage\.setItem\(SKILL_USAGE_STORAGE_KEY/, "read skill tags should be persisted to browser storage");
assert.match(app, /function restoreStoredSkillUsage\(\)[\s\S]*?localStorage\.getItem\(SKILL_USAGE_STORAGE_KEY/, "read skill tags should restore from browser storage");
assert.match(app, /restoreStoredSkillUsage\(\);[\s\S]*?initializeTabs\(\)/, "stored read skill tags should be restored before tabs initialize");
assert.match(app, /trackSkillsFromEvent\(event\);[\s\S]*?if \(!eventTargetsActiveTab\(event\)\)/, "skill usage should be tracked as soon as tab events arrive");
assert.doesNotMatch(app, /trackSkillsFromCommands\(rawAvailableCommands, tabContext\.tabId\)/, "loaded skill commands alone should not populate skill tags");
assert.match(app, /function openSkillEditor\(entry\)[\s\S]*?api\(skillEditorApiPath\(\{ name, path \}\), \{ tabId \}\)/, "clicking a skill tag should load the corresponding SKILL.md into the editor dialog");
assert.match(app, /function saveSkillEditor\(\)[\s\S]*?api\("\/api\/skill-file", \{[\s\S]*?method: "POST"[\s\S]*?content: elements\.skillEditorText\.value/, "skill editor should save changed SKILL.md contents through the API");
assert.match(app, /skillEditorDialog\?\.addEventListener\("keydown"[\s\S]*?saveSkillEditor\(\)/, "skill editor should support Ctrl\/Cmd+S saving");
assert.match(app, /function setBusyPromptBehaviorMenuOpen\(open,[\s\S]*aria-expanded[\s\S]*busyPromptBehaviorMenu\.hidden/, "busy prompt behavior tag should control a dropdown menu");
assert.match(app, /busyPromptBehaviorTag\?\.addEventListener\("click"[\s\S]*setBusyPromptBehaviorMenuOpen\(nextOpen\)/, "clicking the busy prompt behavior tag should toggle its dropdown");
assert.match(app, /busyPromptBehaviorMenu\?\.addEventListener\("click"[\s\S]*chooseBusyPromptBehaviorFromMenu/, "busy prompt behavior dropdown choices should update the setting");
assert.match(app, /setBusyPromptBehavior\(controls\.busyBehavior\.select\.value\)/, "native settings should update the busy prompt behavior tag immediately");
assert.match(app, /const initialRuntime = JSON\.stringify\(\{[\s\S]*?busyBehavior: busyPromptBehavior,[\s\S]*?\}\);/, "native settings should snapshot the defined busy prompt behavior before rendering Apply");
assert.match(app, /applyButton = addNativeCommandAction\("Apply"/, "native settings should render the Apply action after initializing the runtime snapshot");
assert.match(app, /sendPromptFromModeButton\("steer", elements\.steerButton\)/, "Steer should show tooltip instead of silently doing nothing when input is empty");
assert.match(app, /sendPromptFromModeButton\("follow-up", elements\.followUpButton\)/, "Follow-up should show tooltip instead of silently doing nothing when input is empty");
assert.match(app, /async function sendBtwQuestion\(question,[\s\S]*?`\/btw \$\{cleanQuestion\}`[\s\S]*?await sendPrompt\("prompt", message, \{ targetTabId, throwOnError: true \}\)/, "/btw helper should send text as an ephemeral slash command");
assert.match(app, /const btwWidgetDismissedIdsByTab = new Map\(\)/, "/btw dismissals should be scoped to terminal tabs");
assert.match(app, /function currentBtwWidgetPayload\(\)[\s\S]*?payload\.id === btwWidgetDismissedIdsByTab\.get\(activeTabId\)/, "/btw rendering should honor the active tab's dismissed payload ID");
assert.match(app, /function closeBtwOutputWidget\(\)[\s\S]*?btwWidgetDismissedIdsByTab\.set\(activeTabId, payload\.id\)/, "closing /btw should remember the dismissed payload ID for its tab");
const resetActiveTabUiSource = app.slice(app.indexOf("function resetActiveTabUi()"), app.indexOf("function tabGroupStatusRank"));
assert.doesNotMatch(resetActiveTabUiSource, /btwWidgetDismissedIdsByTab/, "switching tabs should not clear remembered /btw dismissals");
assert.match(app, /async function sendBtwPromptFromButton\(\)[\s\S]*?if \(!question\) \{\n\s+openBtwComposerWidget\(\);/, "empty /btw button should open the side-question widget input");
assert.match(app, /function renderBtwComposerForm\(\)[\s\S]*?form\.requestSubmit\(\)[\s\S]*?sendBtwQuestion\(question\)/, "/btw widget input should submit each message as a /btw trigger");
assert.match(app, /function makeBtwTransferIcon\(\)[\s\S]*?class", "btw-transfer-icon"[\s\S]*?function transferBtwContextToMain\(button, \{ transferMode = "full" \} = \{\}\)[\s\S]*?`\/btw-transfer \$\{encoded\}`[\s\S]*?streamingBehavior: "steer"[\s\S]*?Summarize & Steer/, "/btw widget should expose full-context and summary transfer actions that send steering context during active runs");
assert.match(app, /async function sendPrompt\(kind = "prompt", explicitMessage, \{ targetTabId = activeTabId, throwOnError = false, streamingBehavior \} = \{\}\)[\s\S]*?if \(targetWasBusy\) body\.streamingBehavior = streamingBehavior \|\| busyBehavior/, "prompt sending should support a per-call streaming behavior override");
assert.match(app, /function appendOptimisticUserPrompt\([\s\S]*?transientMessages\.push\(\{[\s\S]*?role: "user"[\s\S]*?optimisticPromptId[\s\S]*?renderAllMessages\(\)/, "new prompts should enter transcript state optimistically before routing finishes");
assert.match(app, /function reconcileOptimisticUserPrompts\([\s\S]*?persistedUserMessageCount\(messages\)[\s\S]*?message\?\.optimisticPromptId[\s\S]*?persistedUserCount <= Number\(message\.optimisticBaselineUserCount \|\| 0\)/, "optimistic prompts should remain renderable until a newer persisted user message supersedes them");
assert.match(app, /function renderMessages\(messages\) \{\n\s+latestMessages = messages \|\| \[\];\n\s+reconcileOptimisticUserPrompts\(latestMessages\);/, "message refreshes should reconcile rather than blindly discard optimistic prompts");
assert.match(app, /if \(startsRun\) \{\n\s+promptRoutingTabs\.add\(targetTabId\);\n\s+markTabWorkingLocally\(targetTabId\);\n\s+if \(isCurrentTabContext\(tabContext\)\) \{\n\s+optimisticPromptId = appendOptimisticUserPrompt\(originalMessage, attachments\.length\);\n\s+setRunIndicatorActivity\(attachments\.length \? "Preparing attachments for routing…" : "Routing prompt to the selected agent…"\);/, "new runs should show the prompt and routing progress immediately in the target tab");
assert.match(app, /if \(startsRun && isCurrentTabContext\(tabContext\)\) setRunIndicatorActivity\("Routing complete; starting agent…"\);/, "prepared prompts should transition from routing to agent-start progress before dispatch");
assert.doesNotMatch(app, /applyResponseTab\(response\);\n\s+if \(startsRun\) promptRoutingTabs\.delete\(targetTabId\);/, "prompt acceptance alone should not clear pending launch continuity before Pi confirms the run");
assert.match(app, /if \(event\?\.type === "agent_start"\) beginToolBoundaryRun\(event\);[\s\S]*?if \(!eventTargetsActiveTab\(event\)\)[\s\S]*?case "agent_start":\n\s+promptRoutingTabs\.delete\(event\.tabId \|\| activeTabId\);/, "agent start should establish run-scoped dedupe for active and inactive tabs before replacing optimistic routing continuity with canonical streaming state");
assert.match(app, /else if \(promptRoutingTabs\.has\(activeTabId\)\) \{\n\s+renderRunIndicator/, "idle state snapshots should not hide the run indicator while an accepted prompt still awaits agent start");
assert.match(app, /if \(state\.isStreaming && runIndicatorActivityIsRouting\(\)\) \{\n\s+runIndicatorActivity = "Agent run confirmed; waiting for first output or action…";/, "confirmed streaming state should replace stale routing copy without overwriting newer thinking or tool activity");
assert.match(app, /function runPublishWorkflow\(command\)[\s\S]*?sendPrompt\("prompt", `\/\$\{resolvedCommandName\}\$\{commandRest\}`\)/, "Publish workflows should send resolved slash commands directly without replacing the draft");
assert.match(app, /async function runNativeCommandMenu\(command\)[\s\S]*?await handleNativeSlashSelectorCommand\(command\)/, "skills/tools command menu should open native selector dialogs directly");
assert.match(app, /async function runNativeCommandMenu\(command\)[\s\S]*?sendPrompt\("prompt", command\)/, "generic native command menu should fall back to slash-command prompt execution");
assert.match(app, /function setOptionsMenuOpen\(open\)/, "Options menu should have explicit open state");
assert.match(app, /function nativeToolOriginTag\(resource\)[\s\S]*?sourceInfo\?\.source === "builtin"[\s\S]*?label: "Pi Native"[\s\S]*?label: "External"/, "Tools Setup should classify built-in Pi tools separately from external tools");
assert.match(app, /renderNativeResourceToggles\(tools, \{[\s\S]*?getResourceTag: nativeToolOriginTag/, "Tools Setup should render Pi Native\/External tags");
assert.match(app, /function nativeResourceScopeControl\(scope,[\s\S]*Session only[\s\S]*Global default/, "Tools and Skills Setup should expose a visible session/global scope control");
assert.match(app, /\/api\/tools\?scope=\$\{encodeURIComponent\(scope\)\}[\s\S]*enabledTools: \[\.\.\.enabledTools\], scope/, "Tools Setup should load and save the selected scope");
assert.match(app, /\/api\/skills\?scope=\$\{encodeURIComponent\(scope\)\}[\s\S]*enabledSkills: \[\.\.\.enabledSkills\], scope/, "Skills Setup should load and save the selected scope");
assert.match(server, /updateWebuiSettings\(\(current\) => \(\{\s+resourceDefaults: \{\s+tools: \{[\s\S]*updateWebuiSettings\(\(current\) => \(\{\s+resourceDefaults: \{\s+skills: \{/, "server should persist global tool and skill defaults in the shared Web UI settings file");
assert.match(helper, /const directive = branchResourceDirective\(lastBranchConfig\(ctx, TOOLS_CONFIG_TYPE\), "tools"\);[\s\S]*?directive\.pinned\s+\? \{ names: directive\.names \|\| \[\], source: "session" \}\s+: resolveResourceSelection\(resourceDefaults, "tools"/, "session tool entries should take precedence over global defaults");
assert.match(helper, /const directive = branchResourceDirective\(lastBranchConfig\(ctx, SKILLS_CONFIG_TYPE\), "skills"\);[\s\S]*?if \(directive\.pinned && directive\.legacyDisabledNames !== null\)/, "session skill entries should take precedence over global defaults");
assert.match(technical, /Session only[\s\S]*Global default/, "technical reference should document resource selector scopes");
assert.match(app, /const tags = Array\.isArray\(item\.tags\)[\s\S]*?item\.badge, \.\.\.tags/, "native selector filtering should include extra resource tags");
assert.match(app, /publishMenuContainer\?\.addEventListener\("pointerenter", \(\) => \{[\s\S]*?setPublishMenuOpen\(true\);[\s\S]*?\}\)/, "Publish menu should expand on hover");
assert.match(app, /publishMenuContainer\?\.addEventListener\("pointerleave", \(\) => setPublishMenuOpen\(false\)\)/, "Publish menu should collapse after hover leaves");
assert.match(app, /nativeCommandMenuContainer\?\.addEventListener\("pointerenter", \(\) => \{[\s\S]*?setNativeCommandMenuOpen\(true\);[\s\S]*?\}\)/, "skills/tools command menu should expand on hover");
assert.match(app, /nativeCommandMenuContainer\?\.addEventListener\("pointerleave", \(\) => setNativeCommandMenuOpen\(false\)\)/, "skills/tools command menu should collapse after hover leaves");
assert.match(app, /optionsMenuContainer\?\.addEventListener\("pointerenter", \(\) => \{[\s\S]*?setOptionsMenuOpen\(true\);[\s\S]*?\}\)/, "Options menu should expand on hover");
assert.match(app, /optionsMenuContainer\?\.addEventListener\("pointerleave", \(\) => setOptionsMenuOpen\(false\)\)/, "Options menu should collapse after hover leaves");
assert.match(app, /releaseNpmButton\.addEventListener\("click", \(\) => runPublishWorkflow\("\/release-npm"\)\)/, "Publish menu should launch /release-npm");
assert.match(app, /releaseAurButton\.addEventListener\("click", \(\) => runPublishWorkflow\("\/release-aur"\)\)/, "Publish menu should launch /release-aur");
assert.match(app, /nativeSkillsButton\.addEventListener\("click", \(\) => runNativeCommandMenu\("\/skills"\)\)/, "skills/tools command menu should launch /skills");
assert.match(app, /nativeToolsButton\.addEventListener\("click", \(\) => runNativeCommandMenu\("\/tools"\)\)/, "skills/tools command menu should launch /tools");
for (const command of ["resume", "reload", "remote", "name", "clone", "settings", "export", "fork", "tree"]) {
  const id = command.replace(/^./, (letter) => letter.toUpperCase());
  assert.match(app, new RegExp(`options${id}Button\\.addEventListener\\("click", \\(\\) => runNativeCommandMenu\\("\\/${command}"\\)\\)`), `Options menu should launch /${command}`);
}
assert.match(app, /optionsSafetyGuardSetupButton\?\.addEventListener\("click", \(\) => runNativeCommandMenu\("\/safety-guard-setup"\)\)/, "Options menu should launch native Safety Guard Setup");
assert.match(app, /optionsGitWorkflowSetupButton\?\.addEventListener\("click", \(\) => runNativeCommandMenu\("\/git-workflow-setup"\)\)/, "Options menu should launch native Guided Git Setup");
assert.match(extension, /registerCommand\("git-workflow-setup"[\s\S]*runGitWorkflowSetup/, "Pi extension should register the reusable /git-workflow-setup command");
assert.match(app, /async function openNativeSafetyGuardSetupDialog\([\s\S]*\/api\/safety-guard\/config/, "Web UI should implement Safety Guard Setup with the canonical persisted config API");
assert.match(server, /url\.pathname === "\/api\/safety-guard\/config" && req\.method === "GET"[\s\S]*url\.pathname === "\/api\/safety-guard\/config" && req\.method === "POST"/, "server should expose native safety guard config read and save endpoints");
assert.match(app, /async function openNativeGitWorkflowSetupDialog\([\s\S]*\/api\/git-workflow\/preferences[\s\S]*Manual review process[\s\S]*reviewProcessEnabled: controls\.reviewProcess\.select\.value === "enabled"/, "Web UI should persist the Guided Git review-process toggle through the preferences API");
assert.match(extension, /Manual review process[\s\S]*reviewProcessEnabled: reviewProcess === "enabled"/, "Pi's reusable setup command should persist the same review-process choice");
assert.match(app, /async function sendPrompt\(kind = "prompt", explicitMessage, \{ targetTabId = activeTabId, throwOnError = false, streamingBehavior \} = \{\}\)/, "prompt sending should accept direct messages that bypass the input field and optional target tab");
assert.match(app, /const rawMessage = usesPromptInput \? elements\.promptInput\.value : explicitMessage/, "direct prompt sends should not read the input textarea");
assert.match(app, /function clearPromptInputForRouting\(\{ usesPromptInput,[\s\S]*?if \(!usesPromptInput\) return;/, "direct prompt sends should preserve the input textarea draft");
assert.match(app, /make\("button", "command-item"\)[\s\S]*?sendPrompt\("prompt", `\/\$\{command\.name\}`\)/, "side-panel command clicks should send the slash command directly");
assert.match(app, /const NATIVE_SELECTOR_COMMANDS = new Set\(\["model", "settings", "summary", "summary-setup", "workflow-setup", "safety-guard-setup", "git-workflow-setup", "theme", "fork", "clone", "name", "resume", "tree", "login", "logout", "scoped-models", "tools", "skills"\]\)/, "frontend should route native slash commands, including session summary, workflow permission, safety, and Guided Git setup, into selector UIs");
assert.match(app, /async function handleNativeSlashSelectorCommand\(message/, "frontend should intercept exact native slash commands before prompt forwarding");
assert.match(app, /kind === "prompt" && attachments\.length === 0 && await handleNativeSlashSelectorCommand/, "prompt sending should open native selector dialogs before marking a run active");
assert.match(app, /function openNativeModelSelector\(\)[\s\S]*?nativeCommandApi\("\/api\/models"\)/, "native /model selector should load models through the active tab API");
assert.match(app, /function openNativeSettingsDialog\(\)[\s\S]*?\/api\/steering-mode[\s\S]*?\/api\/follow-up-mode[\s\S]*?\/api\/auto-compaction/, "native /settings selector should expose queue and compaction controls");
assert.match(app, /function openNativeNameDialog\(\)[\s\S]*?sendPrompt\("prompt", `\/name \$\{name\}`\)/, "native /name selector should prompt before running the slash command");
assert.match(app, /function openNativeForkSelector\(\)[\s\S]*?\/api\/fork-messages[\s\S]*?\/api\/fork/, "native /fork selector should pair fork-point loading with the fork action");
assert.match(app, /function openNativeResumeSelector\(scope = "current", \{ query = "" \} = \{\}\)[\s\S]*?\/api\/sessions\?scope=\$\{encodeURIComponent\(selectedScope\)\}/, "native /resume selector should list current-cwd or all sessions");
assert.match(app, /nativeCommandApi\("\/api\/switch-session"[\s\S]*?const resumedTab = syncResponseTabs\(result\)[\s\S]*?await switchTab\(resumedTab\.id\)/, "native /resume should select the new terminal returned by the server");
assert.match(app, /\/api\/session-rename/, "native /resume selector should rename session metadata");
assert.match(app, /\/api\/session-delete/, "native /resume selector should delete sessions with confirmation");
assert.match(app, /function openNativeTreeSelector\(\)[\s\S]*?\/api\/session-tree[\s\S]*?\/api\/tree-navigate/, "native /tree selector should list tree entries and navigate through the backend helper");
assert.match(app, /renderNativeSelectorItems\(toItems\(\), \{ emptyText: "No session tree entries match this filter\.", onSelect: navigate, numbered: true \}\)/, "native /tree selector should number entries instead of indenting by depth");
assert.match(app, /async function openNativeAuthSelector\(mode\)[\s\S]*?\/api\/auth-providers[\s\S]*?Browser login is not implemented yet/, "native /login should list provider status without browser credential entry");
assert.match(app, /\/api\/auth-logout[\s\S]*?confirmed: true/, "native /logout should remove stored credentials through a confirmed localhost-only endpoint");
assert.match(app, /const HIDDEN_COMMAND_NAMES = new Set\(\["webui-tree-navigate", "webui-helper"\]\)/, "internal Web UI helper commands should stay out of command pickers");
assert.match(app, /HIDDEN_COMMAND_NAMES\.add\("btw-transfer"\)/, "/btw transfer helper command should stay out of command pickers");
assert.match(app, /function shouldSendPromptFromEnter\(event\)/, "prompt keyboard handling should be centralized");
assert.match(app, /const PROMPT_HISTORY_STORAGE_KEY = "pi-webui-prompt-history"/, "prompt history should be persisted per browser for keyboard recall");
assert.match(app, /function recallPreviousPromptFromHistory\(\)/, "prompt history should support recalling older prompts from the textarea");
assert.match(app, /event\.key === "ArrowUp" && recallPreviousPromptFromHistory\(\)/, "plain Up should recall prompt history after command suggestions decline it");
assert.match(app, /function recallNextPromptFromHistory\(\)/, "prompt history should support returning toward the current draft");
assert.match(app, /syncPromptHistoryFromMessages\(latestMessages\)/, "message refresh should seed prompt history from existing user prompts");
assert.match(app, /function handleNativeAppShortcut\(event\)/, "native app shortcut handling should be centralized");
assert.match(app, /window\.addEventListener\("keydown", handleNativeAppShortcut, \{ capture: true \}\)/, "native shortcuts should run before textarea-specific key handling");
assert.match(app, /cycleModelFromShortcut\(event\.shiftKey \? "backward" : "forward"\)/, "Ctrl+P and Shift+Ctrl+P should cycle models");
assert.match(app, /cycleThinkingFromShortcut\(\)/, "Shift+Tab should cycle thinking level");
assert.match(app, /setToolOutputGloballyExpanded\(!toolOutputGloballyExpanded, \{ announce: true \}\)/, "Ctrl+O should toggle global tool expansion");
assert.match(app, /function restoreQueuedMessagesToComposerFromShortcut\(\)/, "Alt+Up should restore queued steering\/follow-up text into the composer");
assert.match(app, /const PROMPT_LIST_STORAGE_KEY = "pi-webui-prompt-lists"/, "frontend should persist prompt lists in browser storage");
assert.match(app, /async function runPromptList\(prompts,[\s\S]*sendPrompt\("prompt", listPrompts\[0\]/, "prompt-list runner should send the first item as the start prompt");
assert.match(app, /for \(const prompt of listPrompts\.slice\(1\)\)[\s\S]*sendPrompt\("follow-up", prompt/, "prompt-list runner should send remaining items as follow-ups");
assert.match(app, /async function runDisplayedPromptList\(\)[\s\S]*const saved = saveDisplayedPromptList\(\)[\s\S]*runPromptList\(saved\.prompts/, "Run List should persist the displayed prompt list before running it");
assert.match(app, /async function deleteSelectedPromptList\(\)[\s\S]*deleteStoredPromptList[\s\S]*offerUndo\(\{[\s\S]*upsertStoredPromptList\(deleted\)/, "prompt-list deletion should be immediately reversible through Undo");
assert.match(app, /function loadSelectedPromptListIntoEditor\(\)[\s\S]*loadPromptListIntoEditor\(list, \{ updateLoaded: true \}\)[\s\S]*elements\.promptListDialog\?\.close\(\)/, "loading a saved prompt list from the popup should close the dialog");
assert.match(app, /event\.altKey && key === "ArrowUp"[\s\S]*?restoreQueuedMessagesToComposerFromShortcut\(\)/, "Alt+Up should be handled by native shortcut routing");
assert.match(app, /clearPromptFromShortcut\(\)/, "Ctrl+C should clear only through a guarded prompt helper");
assert.match(app, /if \(event\.defaultPrevented\) return;/, "textarea keydown handling should respect app-level shortcut interception");
assert.match(app, /return !isMobileView\(\);/, "plain Enter should send only outside mobile view so mobile Return can insert newlines");
assert.match(app, /mobile-keyboard-open/, "JS should toggle mobile keyboard mode from viewport/focus state");
assert.match(app, /maxVisualViewportHeight - viewportHeight > 120/, "keyboard mode should detect viewport shrink even when keyboard inset is unavailable");
assert.match(app, /jumpToLatestButton/, "jump-to-latest button should be wired in JS");
assert.match(app, /function updateStickyUserPromptButton\(/, "last user prompt header should update from scroll position");
assert.match(app, /function jumpToStickyUserPrompt\(/, "last user prompt header should jump to its source message");
assert.match(app, /data-user-prompt/, "user prompt messages should be marked for sticky prompt navigation");
assert.match(app, /function resetChatOutput\(\)[\s\S]*?stickyUserPromptButton/, "chat rerenders should preserve the sticky user prompt control inside the transcript scroller");
assert.match(app, /LAST_USER_PROMPT_STORAGE_KEY/, "last user prompt should be cached so compaction cannot remove the sticky prompt preview");
assert.match(app, /function syncLastUserPromptFromMessages\(messages = latestMessages\)/, "message refresh should preserve the latest user prompt across compacted transcripts");
assert.match(app, /dataset\.compacted/, "sticky prompt should expose a compacted fallback state when its source message was summarized away");
assert.match(app, /stickyUserPromptButton\?\.addEventListener\("click", jumpToStickyUserPrompt\)/, "last user prompt header should be clickable without breaking stale cached HTML");
assert.match(app, /function setComposerActionsOpen\(/, "mobile composer actions panel should be JS-toggleable");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\) \{[\s\S]*?\.composer \{[\s\S]*?z-index:\s*50;/, "mobile composer should stack above transcript reaction controls while Actions are open");
assert.match(css, /\.composer-actions-panel \{[\s\S]*?z-index:\s*55;[\s\S]*?overflow:\s*visible;/, "mobile Actions panel should stay above message reactions and allow submenu overlays instead of clipping them into the panel layout");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu\.open \{\n\s+z-index:\s*120;\n\s+\}/, "opened mobile Actions dropdowns should overlay neighboring controls without taking grid space");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu::after \{[\s\S]*?bottom:\s*100%;[\s\S]*?height:\s*0\.8rem;[\s\S]*?pointer-events:\s*auto;/, "mobile Actions dropdowns should keep a hover bridge above the trigger and below the floating submenu");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu:hover::after,[\s\S]*?\.composer-actions-panel > \.composer-publish-menu:focus-within::after,[\s\S]*?\.composer-actions-panel > \.composer-publish-menu\.open::after \{\n\s+display:\s*block;/, "mobile Actions dropdown hover bridge should activate while hovered, focused, or opened");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu \.composer-publish-menu-panel \{[\s\S]*?position:\s*absolute;[\s\S]*?inset:\s*auto auto calc\(100% \+ 0\.38rem\) 0;[\s\S]*?max-height:\s*min\(var\(--mobile-dropdown-max-height, 34dvh\), calc\(var\(--visual-viewport-height, 100dvh\) - 2rem\)\);[\s\S]*?overflow:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/, "opened mobile Actions dropdown panels should float upward over the Actions controls with a viewport-bounded scrollbar");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu \.composer-publish-menu-panel \{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*100%;/, "mobile Actions dropdown panels should align to the width of their trigger buttons");
assert.match(css, /\.composer-actions-panel > \.composer-publish-menu \.composer-publish-menu-item \{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?white-space:\s*normal;/, "mobile Actions dropdown option buttons should not keep desktop min-widths that misalign with triggers");
assert.match(css, /\.composer-actions-panel > \.composer-options-menu \.composer-publish-menu-panel,\n\s+\.composer-actions-panel > \.composer-app-runner-menu \.composer-publish-menu-panel \{\n\s+inset-inline:\s*auto 0;/, "mobile Options and app-runner dropdowns should use the shared viewport-bounded scrollbar instead of forcing full viewport height");
assert.match(app, /function setMobileTabsExpanded\(/, "mobile tab strip should be JS-toggleable");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\) \{[\s\S]*?\.terminal-tab-group \{\n\s+display:\s*grid;\n\s+grid-template-columns:\s*minmax\(0, 1fr\) auto;/, "mobile terminal tab groups should use a stable grid row for the tab and close button when expanded");
assert.match(css, /@media \(max-width: 720px\), \(max-device-width: 720px\), \(pointer: coarse\) and \(hover: none\) \{[\s\S]*?\.terminal-tab-group-menu \{[\s\S]*?grid-column:\s*1 \/ -1;[\s\S]*?margin:\s*0\.34rem 0 0;/, "mobile terminal tab group menus should not add horizontal margins that overflow and distort the tab card");
assert.match(app, /let openTerminalTabGroupKey = null/, "frontend should track the open terminal tab group across tab bar rerenders");
assert.match(app, /function updateTerminalTabGroupOpenState\(\)/, "frontend should be able to reapply open terminal tab group state after rerenders");
assert.match(app, /const totalTabCount = tabs\.length \+ subagentTerminalViews\.size;[\s\S]*classList\.toggle\("terminal-tabs-dense", totalTabCount >= 10\)/, "frontend should include virtual subagent tabs when enabling dense tab layout");
assert.match(app, /appendTerminalTabContent\(button, \{ title: activeTitle,[\s\S]*?count: groupTabs\.length,[^}]*\}\)/, "group buttons should show the active terminal name instead of only the cwd label");
assert.match(app, /wrapper\.addEventListener\("pointerenter", \(event\) => \{\s+if \(event\.pointerType === "touch"\) return;\s+setOpenTerminalTabGroup\(group\.key\);/, "terminal tab groups should mark themselves open while hovered with a non-touch pointer");
assert.match(app, /if \(openTerminalTabGroupKey\) \{\n\s+scheduleRefreshTabs\(600\);/, "tab polling should defer full tab refreshes while a group menu is open");
assert.match(app, /function shouldRenderTerminalTabGroup\(group, groupCount\) \{\n\s+if \(group\.custom\) return group\.tabs\.length > 1;\n\s+return groupCount > 1 && group\.tabs\.length > 1 && Boolean\(group\.cwd\);\n\}/, "terminal tabs should always render custom groups while only collapsing multi-tab cwd groups when multiple groups are available");
assert.match(app, /TERMINAL_CUSTOM_GROUPS_STORAGE_KEY/, "frontend should persist custom terminal tab groups in browser storage");
assert.match(app, /function bindTerminalTabDragAndDrop\(/, "terminal tabs should bind drag-and-drop grouping behavior");
assert.match(app, /function handleTerminalTabDrop\(sourceTabId, target\)[\s\S]*?createTerminalCustomGroup/, "dropping a terminal tab onto another tab or group should create or update a custom group");
assert.match(css, /\.terminal-tab\.terminal-tab-drag-over,[\s\S]*?\.terminal-tab-group-item\.terminal-tab-drag-over/, "terminal tab drop targets should show drag-over affordance");
assert.match(app, /function closeTerminalTabGroup\(group\)[\s\S]*?closeTerminalTabs\(group\.tabs\.map\(\(tab\) => tab\.id\)/, "terminal tab groups should be closable as a batch");
assert.match(app, /const closedActiveCwd = closedActiveTab \? tabs\.find\(\(tab\) => tab\.id === activeTabId\)\?\.cwd \|\| "" : ""[\s\S]*?const sameCwdFallbackTabId = closedActiveCwd[\s\S]*?item\.cwd === closedActiveCwd/, "closing the active terminal should prefer another open tab in the same cwd");
assert.match(app, /function closeAllTerminalTabs\(\)[\s\S]*?closeTerminalTabs\(tabs\.map\(\(tab\) => tab\.id\)/, "tab header should close all terminal tabs as a batch");
assert.match(app, /WARNING: \$\{activeAgentTabs\.length\}[\s\S]*?still running or waiting for input/, "tab close confirmations should warn when agents are still running");
assert.match(app, /elements\.closeAllTabsButton\.addEventListener\("click", \(\) => closeAllTerminalTabs\(\)\)/, "close-all tabs button should be wired in JS");
assert.match(app, /const groups = tabCwdGroups\(\);[\s\S]*?for \(const group of groups\) \{\n\s+if \(shouldRenderTerminalTabGroup\(group, groups\.length\)\)[\s\S]*?renderTerminalTabGroup\(group, groups\.length\)[\s\S]*?for \(const tab of group\.tabs\) elements\.tabBar\.append\(renderTerminalTab\(tab, \{ showCwdAdd \}\)\);/, "terminal tabs should render groups with group count and ungrouped tabs when grouping is skipped");
assert.match(app, /const subagentGroups = subagentTerminalViewGroups\(\)[\s\S]*renderSubagentTerminalTabGroup\(group\)[\s\S]*renderSubagentTerminalTab\(group\.views\[0\]\)/, "open subagent views should render as first-class virtual tabs, grouped by parent workspace when siblings exist");
assert.match(technical, /Tracked subagent output[\s\S]*dedicated \*\*Subagent\*\* terminal tab[\s\S]*read-only[\s\S]*does not stop or interrupt/, "technical reference should document the selectable read-only child terminal behavior");
assert.match(app, /let tabSeenCompletionSerials = new Map\(\)/, "frontend should track which tab completions have been seen");
assert.match(app, /let activeTabGeneration = 0/, "frontend should version active-tab UI state to reject stale async work");
assert.match(app, /function isCurrentTabContext\(context\)/, "frontend should identify stale active-tab refresh contexts");
assert.match(app, /function connectEvents\(tabContext = activeTabContext\(\), \{ requestedMode = "auto", fallbackAttempted = false \} = \{\}\)[\s\S]*?eventSource !== source/, "frontend should ignore stale SSE messages from old active tabs");
assert.match(app, /let foregroundReconcileTimer = null/, "frontend should debounce foreground resume reconciliation");
assert.match(app, /case "webui_connected":[\s\S]*?clearFeatureDecisionStateForTab\(connectedTabId, \{ render: true \}\)[\s\S]*?scheduleForegroundReconcile\("event stream reconnect", 0\)/, "SSE reconnect should close stale popup content and clear cached category/output before authoritative status replay");
assert.match(app, /async function reconcileForegroundState\(reason = "resume"\)[\s\S]*?refreshTabs\(\)[\s\S]*?ensureActiveEventStream\(tabContext\)[\s\S]*?refreshAll\(tabContext\)/, "foreground reconciliation should refresh tabs plus active transcript after mobile backgrounding");
assert.match(app, /document\.addEventListener\("visibilitychange"[\s\S]*?scheduleForegroundReconcile\("visibility resume", 0\)/, "returning to a hidden mobile tab should force a server snapshot refresh");
assert.match(app, /window\.addEventListener\("pageshow", \(\) => scheduleForegroundReconcile\("page show", 0\)\)/, "BFCache or PWA page resume should force a server snapshot refresh");
assert.match(app, /async function refreshMessages\(tabContext = activeTabContext\(\), \{ authoritative = false \} = \{\}\)[\s\S]*?if \(!isCurrentTabContext\(tabContext\)\) return;/, "message refreshes should not render after the user switches tabs");
assert.match(app, /function tabIndicator\(tab\)/, "frontend should derive idle, working, blocked, and work-done tab indicator states");
assert.match(app, /pendingBlockerCount > 0[\s\S]*?state: "blocked"/, "frontend should show blocked tabs when extension UI blockers are pending");
assert.match(app, /const EXTENSION_UI_BLOCKING_METHODS = new Set\(\["select", "confirm", "input", "editor"\]\)/, "frontend should share blocking extension UI method detection for dialogs and notifications");
assert.match(app, /function notifyBlockedTab\(/, "frontend should send blocked-tab notifications when extension UI blocks a run");
assert.match(app, /function showBlockedTabBrowserNotification\(/, "frontend should use browser notifications for blocked tabs when permission allows");
assert.match(app, /function setAgentDoneNotificationsEnabled\(/, "frontend should manage the side-panel agent-done notification toggle");
assert.match(app, /agentDoneNotificationsToggle\.addEventListener\("change"/, "agent-done notification toggle should be wired to user changes");
assert.match(app, /function notifyAgentDone\(/, "frontend should send optional browser notifications when agent work completes");
assert.match(app, /ensureAgentDoneNotificationPermission\(\)/, "agent-done notifications should request browser notification permission from the toggle flow");
assert.match(app, /Notification\.requestPermission\(\)/, "frontend should request notification permission before browser alerts");
assert.match(app, /syncBlockedTabNotificationsFromTabs\(tabs, previousTabs\)/, "tab refreshes should notify when a background tab becomes blocked");
assert.match(app, /syncAgentDoneNotificationsFromTabs\(tabs, previousTabs\)/, "tab refreshes should notify when background tab work completes");
assert.match(app, /notifyBlockedTab\(request\.tabId, \{ request, count: request\.pendingExtensionUiRequestCount \}\)/, "extension UI requests should trigger blocked-tab notifications");
assert.match(app, /pendingExtensionUiRequestCount[\s\S]*?setTabPendingBlockerCount/, "frontend should ingest pending blocker counts from tab events");
assert.match(app, /function markTabOutputSeen\(/, "frontend should clear work-done indicators once output is seen");
assert.match(app, /function markTabDoneLocally\(/, "frontend should locally recover tabs that were left working after idle state refreshes");
assert.match(app, /function syncActiveTabActivityFromState\(state = currentState\)/, "frontend should reconcile active-tab indicators from authoritative state snapshots");
assert.match(app, /event\.command === "get_state" && event\.tabId === activeTabId[\s\S]*?syncActiveTabActivityFromState\(currentState\)/, "get_state response events should update stale active-tab activity");
assert.match(app, /function applyResponseTab\(response\)/, "frontend should merge tab metadata returned by prompt responses");
assert.match(app, /newSessionButton\.addEventListener\("click", async \(\) => \{[\s\S]*?api\("\/api\/new-session"[\s\S]*?applyResponseTab\(response\)[\s\S]*?refreshAll\(tabContext\)/, "the New button should apply returned terminal-tab metadata before the full session refresh");
assert.match(app, /case "webui_tab_renamed":/, "frontend should update tab labels from backend rename events");
assert.match(app, /case "webui_recovery_opened":[\s\S]*?refreshTabs\(\)[\s\S]*?switchTab\(event\.recoveryTabId\)/, "recovery events should refresh tabs and activate the new recovery session");
assert.match(app, /terminalTabsToggleButton\.addEventListener\("click"/, "terminal tabs trigger should be wired in JS");
assert.match(app, /composerActionsButton\.addEventListener\("click"/, "composer actions trigger should be wired in JS");
assert.match(app, /function setMobileFooterExpanded\(/, "mobile footer should preserve expansion state for compatibility");
assert.match(app, /function updateFooterModelPickerPosition\(\)[\s\S]*?footerActivePickerTarget\(\)[\s\S]*?--footer-model-picker-left/, "footer picker should align desktop dropdowns above the active model or effort chip");
assert.match(app, /mobileFooterExpanded = false;[\s\S]*?document\.body\.classList\.remove\("footer-details-expanded"\)/, "opening mobile model picker should collapse legacy footer details so they cannot cover the dropdown");
assert.match(app, /function renderTuiFooterLine\([\s\S]*footer-line footer-line-tui/, "footer should render a minimal TUI-like line instead of metadata chips");
assert.match(app, /footerTuiItem\(model, "footer-tui-model", \{[\s\S]*setFooterModelPickerOpen\(!footerModelPickerOpen\)/, "footer model item should be clickable");
assert.match(app, /function renderFooterModelPicker\(\)/, "footer should render a scoped-model picker dropdown");
assert.match(app, /api\("\/api\/scoped-models", \{ tabId: tabContext\.tabId \}\)/, "footer model picker should load scoped models instead of all available models");
assert.match(app, /for \(const model of footerScopedModels\)/, "footer model picker should render only scoped models");
assert.match(app, /api\("\/api\/model", \{ method: "POST"/, "footer model picker should apply selected model through the model API");
assert.match(app, /chip\.key === "thinking"[\s\S]*?setFooterThinkingPickerOpen\(!footerThinkingPickerOpen\)/, "git footer effort chip should open its own picker");
assert.match(app, /function renderFooterThinkingPicker\(\)[\s\S]*?Thinking effort[\s\S]*?for \(const level of footerThinkingLevels\(\)\)/, "footer should render a thinking effort picker dropdown");
assert.match(app, /api\("\/api\/thinking", \{ method: "POST", body: \{ level: nextLevel \}/, "footer thinking picker should apply selected effort through the thinking API");
assert.match(app, /function isFooterPickerOpen\(\)[\s\S]*?footerModelPickerOpen \|\| footerThinkingPickerOpen/, "footer picker overlay state should cover model and thinking pickers");
assert.doesNotMatch(app.match(/function renderMinimalFooter\(\)[\s\S]*?\n\}/)?.[0] || "", /footer-details-toggle/, "minimal default footer should not render a details toggle chip");
assert.match(app, /bindMobileViewChanges\(/, "side panel state should react to mobile breakpoint changes");
// Intent preserved for legacy; v2 leaves mobile surface ownership to its reducer.
assert.match(app, /function restoreSidePanelState\(\) \{\n\s+if \(isMobileShellV2Active\(\)\) return;\n\s+if \(isControlDeckOverlayPresentation\(\)\)/, "legacy mobile and narrow overlay layouts should start with the side panel collapsed");
assert.match(app, /case "webui_tab_reloaded":/, "frontend should handle native /reload tab restart events");
assert.match(app, /addTransientMessage\(\{ role: "native", title: "\/reload"/, "native /reload should produce visible transcript output");
assert.match(app, /copyText\(data\.copyText\)\.catch/, "native /copy should use the shared browser clipboard helper when available");
assert.match(app, /Clipboard access failed:[\s\S]*?data\.copyText/, "native /copy should show text in transcript when clipboard access fails");
assert.match(app, /setTimeout\(\(\) => \{[\s\S]*?refreshAll\(tabContext\)\.catch/, "frontend should refresh state after native /reload restarts the RPC process");
assert.match(app, /api\("\/api\/path-fast-picks"/, "frontend should load/save fast picks through the server API");
assert.match(app, /loadLegacyFastPicks\(/, "frontend should migrate existing browser-local fast picks");

assert.equal(manifest.display, "standalone", "PWA manifest should request standalone display");
assert.equal(manifest.start_url, "/", "PWA manifest should start at the web UI root");
assert.ok(manifest.icons?.some((icon) => icon.src === "/apple-touch-icon.png" && icon.sizes === "180x180"), "PWA manifest should include a conventional 180px apple touch icon");
assert.ok(manifest.icons?.some((icon) => icon.src === "/icon-192.png" && icon.sizes === "192x192"), "PWA manifest should include a 192px icon");
assert.ok(manifest.icons?.some((icon) => icon.src === "/icon-512.png" && icon.sizes === "512x512"), "PWA manifest should include a 512px icon");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v\d+"/, "PWA service worker should define a versioned app-shell cache");
assert.match(serviceWorker, /fetchThenCache\(event\)\.catch\(/, "PWA service worker should serve the app shell network-first with offline cache fallback");
assert.match(serviceWorker, /const APP_SHELL_NETWORK_TIMEOUT_MS = 8_000;/, "PWA app-shell requests should have a bounded network timeout");
assert.match(serviceWorker, /event\.waitUntil\([\s\S]*?cache\.put\(request, response\.clone\(\)\)/, "PWA cache writes should be tracked without blocking response delivery");
assert.match(serviceWorker, /ignoreSearch: true/, "PWA service worker offline fallback should ignore ?v= cache busters");
assert.match(serviceWorker, /self\.addEventListener\("notificationclick"/, "PWA service worker should focus Web UI when blocked-tab notifications are clicked");
// Intent superseded: notification URLs are now generated only from validated opaque targets; invalid payloads fall back to the app root.
assert.match(serviceWorker, /function notificationTargetUrl\(data\)[\s\S]*?if \(!target\) return `\$\{self\.location\.origin\}\/`/, "notification clicks should use a bounded root fallback instead of accepting an arbitrary URL");
assert.doesNotMatch(serviceWorker, /data\?\.url/, "notification payloads must not inject arbitrary fallback URLs");
assert.match(serviceWorker, /"\/subagent-launch-slot-state\.mjs"/, "PWA service worker should cache the launch-slot state module imported by the app shell");
assert.match(serviceWorker, /"\/apple-touch-icon\.png"/, "PWA service worker should cache the apple touch icon");
assert.match(serviceWorker, /"\/matrix-background\.webp"/, "PWA service worker should cache the Matrix background image");
assert.match(serviceWorker, /"\/catppuccin-mocha-background\.png"/, "PWA service worker should cache the Catppuccin Mocha background image");
assert.match(serviceWorker, /url\.pathname\.startsWith\("\/api\/"\)/, "PWA service worker should not cache live API or SSE calls");
assert.ok(appleIcon.length > 1000, "PWA apple touch icon should be present");
assert.ok(icon192.length > 1000, "PWA 192px icon should be present");
assert.ok(icon512.length > icon192.length, "PWA 512px icon should be present and larger than 192px icon");
assert.ok(matrixBackground.length > 100000, "Matrix background image should be present as an optimized WebP asset");
assert.ok(mochaBackground.length > 8000, "Catppuccin Mocha background image should be present as a compact PNG asset");

assert.match(server, /resolveCodexUsageAuth/, "server should use the lock-safe Codex OAuth compatibility adapter");
assert.match(server, /DefaultPackageManager/, "server should use Pi's package resolver when controlling Web UI tab extension loading");
assert.match(server, /WEBUI_RESOURCE_EXCLUDED_PACKAGES = new Set\(\[WEBUI_PACKAGE\]\)/, "server should exclude only the Web UI package itself from normal Pi resource loading");
assert.match(server, /async function packageNameForResourcePath\(resourcePath\)[\s\S]*canonicalResourcePath = await realpath\(resourcePath\)[\s\S]*path\.dirname\(canonicalResourcePath\)/, "package ownership checks should canonicalize file symlinks before walking package ancestors");
assert.match(server, /const args = \["--mode", "rpc", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes"\]/, "Web UI tabs should disable implicit resource loading before adding resolved resource paths");
assert.match(server, /normalPiResourcePathsForTab[\s\S]*WEBUI_RESOURCE_EXCLUDED_PACKAGES\.has\(packageName\)[\s\S]*continue/, "Web UI tab resource resolution should retain separately configured optional packages and prevent only self-loading duplication");
assert.match(server, /startedWebuiResourcePaths\(resourceType\)/, "Web UI tabs should load Web UI-owned resources from the started package");
assert.match(server, /resolveInstalledPackageSubpath\(nodeModulesRef\.packageName, nodeModulesRef\.subpath\)/, "Web UI should prefer workspace/global/package-root installed packages for node_modules manifest entries");
assert.match(codexAuth, /CODEX_TOKEN_REFRESH_SKEW_MS = 5 \* 60 \* 1000/, "Codex OAuth credentials should refresh five minutes before expiry");
assert.match(server, /catch \{[\s\S]*OpenAI Codex OAuth token refresh failed/, "Codex auth failures should be redacted before reaching clients");
assert.match(server, /url\.pathname === "\/api\/codex-usage" && req\.method === "GET"/, "server should expose a sanitized Codex usage endpoint");
assert.match(server, /OPENAI_CODEX_USAGE_ENDPOINT/, "server should query Codex usage from the backend, not the browser");
assert.match(server, /const NATIVE_SLASH_COMMANDS = nativeSlashCommandEntries\(nativeParityMatrix\)/, "server should define Pi native slash commands for autocomplete from the parity matrix");
assert.match(server, /WEBUI_TUI_NATIVE_PARITY\.json/, "native command descriptions should come from the parity matrix source of truth");
assert.match(server, /function parseSlashCommand\(message\)/, "server should parse native slash commands before prompt forwarding");
assert.match(server, /AUTO_TAB_TITLE_MAX_LENGTH = 44;[\s\S]*AUTO_TAB_TITLE_DISPLAY_MAX_LENGTH = 160;/, "compact terminal labels and wider subagent display titles should use separate length limits");
assert.match(server, /function generatedTabTitleFromPrompt\(message\)[\s\S]*truncateTabTitle\(titleCaseTabTitle\(selectedWords\.join\(" "\)\), AUTO_TAB_TITLE_DISPLAY_MAX_LENGTH\)/, "server should preserve a longer automatic title before compact terminal truncation");
assert.match(server, /function renameTab\(tab, title,[\s\S]*tab\.subagentDisplayTitle = source === "auto" \? truncateTabTitle\(title, AUTO_TAB_TITLE_DISPLAY_MAX_LENGTH\) : undefined;/, "new auto-named tabs should cache their wider subagent display title immediately");
assert.match(server, /function maybeNameTabForConversation\(tab, command\)/, "server should auto-name default tabs when a conversation starts");
assert.match(server, /function maybeNameTabForConversation\(tab, command\) \{[\s\S]*const shouldRename = !tab\.conversationStarted && tab\.titleSource !== "explicit";[\s\S]*tab\.conversationStarted = true;[\s\S]*if \(!shouldRename\) return false;/, "server should mark conversations as started even when an explicit title prevents auto-renaming");
assert.match(server, /function createTabActivity\(/, "server should track per-tab activity for idle, working, and completed work");
assert.match(server, /function reconcileTabActivityFromState\(tab, state/, "server should recover stale working tab activity from get_state snapshots");
assert.match(server, /pendingExtensionUiRequests\(tab\)\.length > 0[\s\S]*?markTabWorking\(tab, timestamp\)/, "server should keep tabs with pending blockers in working activity until the blocker resolves");
assert.match(server, /case "response":[\s\S]*?event\.command === "get_state"[\s\S]*?reconcileTabActivityFromState\(tab, event\.data/, "server should reconcile tab activity when get_state responses flow through RPC events");
assert.match(server, /async function listTabsWithReconciledActivity\(\)/, "server tab listing should reconcile stale working tabs before returning metadata");
assert.match(server, /tabs: await listTabsWithReconciledActivity\(\)/, "GET /api/tabs should use reconciled tab activity metadata");
assert.match(server, /tabActivity: tabActivitySnapshot\(tab\)/, "server should expose tab activity over tab metadata and events");
assert.match(server, /const EXTENSION_UI_BLOCKING_METHODS = new Set\(\["select", "confirm", "input", "editor"\]\)/, "server should know which extension UI requests can block Pi runs");
assert.match(server, /function trackPendingExtensionUiRequest\(tab, event\)/, "server should track blocking extension UI requests per tab");
assert.match(server, /pendingExtensionUiRequests: new Map\(\)/, "new tabs should initialize pending extension UI request storage");
assert.match(server, /extensionStatuses: new Map\(\)/, "new tabs should initialize replayable extension status storage");
assert.match(server, /extensionWidgets: new Map\(\)/, "new tabs should initialize replayable extension widget storage");
assert.match(server, /const REPLAYABLE_CLEARED_EXTENSION_STATUS_KEYS = new Set\(\["feature-decision-output", "feature-category"\]\)/, "server should retain cleared feature-routing status keys as late-client capability evidence");
assert.match(server, /function rememberExtensionStatusEvent\(tab, event\)[\s\S]*event\.statusText\) statuses\.set\(statusKey, String\(event\.statusText\)\)[\s\S]*REPLAYABLE_CLEARED_EXTENSION_STATUS_KEYS\.has\(statusKey\)\) statuses\.set\(statusKey, undefined\)[\s\S]*else statuses\.delete\(statusKey\)[\s\S]*scheduleSupervisorMetadataUpdate\(tab\)/, "server should replay feature-routing clears, persist first detection, and delete unrelated cleared statuses");
assert.match(server, /function supervisedTabMetadata\(tab,[\s\S]*featureSystemPromptDetected: featureSystemPromptDetected\(tab\)/, "supervisor metadata should persist feature-routing capability evidence across server restarts");
assert.match(server, /function hydrateManagedTabs\(snapshot\)[\s\S]*restoreFeatureSystemPromptDetection\(tab, metadata\?\.featureSystemPromptDetected === true\)/, "supervised tab hydration should restore feature-routing capability evidence before SSE replay");
assert.match(server, /function rememberExtensionWidgetEvent\(tab, event\)[\s\S]*event\.method !== "setWidget"[\s\S]*widgets\.set\(String\(widgetKey\)/, "server should retain extension widget events for reconnects");
assert.match(server, /rememberExtensionStatusEvent\(tab, scopedEvent\)[\s\S]*rememberExtensionWidgetEvent\(tab, scopedEvent\)[\s\S]*trackPendingExtensionUiRequest\(tab, scopedEvent\)/, "RPC events should retain extension statuses and widgets before broadcasting");
assert.match(server, /trackPendingExtensionUiRequest\(tab, scopedEvent\)/, "RPC events should populate pending extension UI storage before broadcasting");
assert.match(server, /scopedEvent = \{ \.\.\.scopedEvent,[\s\S]*?pendingExtensionUiRequestCount: pendingExtensionUiRequests\(tab\)\.length \}/, "RPC events should broadcast pending blocker counts for tab indicators");
assert.match(server, /function replayExtensionStatuses\(tab, client\)[\s\S]*method: "setStatus"/, "server should replay latest extension statuses on SSE reconnect");
assert.match(server, /function replayExtensionWidgets\(tab, client\)[\s\S]*method: "setWidget"/, "server should replay latest extension widgets on SSE reconnect");
assert.match(server, /function replayPendingExtensionUiRequests\(tab, client\)/, "server should be able to replay missed extension UI requests on SSE reconnect");
assert.match(server, /replayExtensionStatuses\(tab, client\);\n\s+replayExtensionWidgets\(tab, client\);[\s\S]*?webui_session_summary[\s\S]*?replayPendingExtensionUiRequests\(tab, client\)/, "SSE connections should replay extension statuses, widgets, and the tab-scoped summary before pending blockers");
assert.match(server, /pendingExtensionUiRequests: pendingExtensionUiRequestSummaries\(tab\)/, "detailed Web UI status should expose pending extension UI blockers");
assert.match(server, /resolvePendingExtensionUiRequest\(tab, payload\.id\)/, "extension UI responses should clear the pending blocker cache");
assert.match(server, /type: "webui_extension_ui_resolved"[\s\S]*?pendingExtensionUiRequestCount/, "extension UI responses should notify clients that a blocker resolved");
assert.match(server, /command\.type === "abort"[\s\S]*?cancelPendingExtensionUiRequests\(tab\)/, "abort should cancel hidden pending extension UI requests");
assert.match(server, /type: "webui_extension_ui_cancelled"/, "server should notify browsers when pending extension UI requests are cancelled");
assert.match(server, /async function handleNativeSlashCommand\(tab, body, req\)/, "server should intercept supported native slash commands with request context for security guards");
assert.match(server, /const restoreTabs = await readRestoreTabsFromEnv\(\)/, "server should accept private restart tab restore descriptors from the launcher environment");
assert.match(server, /delete process\.env\.PI_WEBUI_RESTORE_FILE[\s\S]*delete process\.env\.PI_WEBUI_RESTORE_TABS/, "server should avoid leaking private or obsolete restore descriptors into spawned Pi RPC processes");
assert.match(server, /if \(sessionFile && !options\.noSession\) piArgs\.push\("--session", sessionFile\)/, "restored tabs should resume previous session files");
assert.doesNotMatch(server, /args\.push\("--name"/, "Web UI tab titles should not be forwarded as Pi CLI --name flags because older bundled Pi CLIs reject them");
assert.match(server, /const closedRestorableTabs = \[\]/, "server should track recently closed tabs separately from restart restore descriptors");
assert.match(server, /async function closeTab\(id, \{ allowLast = false \} = \{\}\)[\s\S]*?rememberClosedRestorableTab\(tab, restorableState\)/, "closing a tab should capture its session before stopping RPC for detailed closed-tab status");
assert.match(server, /async function restorableTabsForRestart\(\)[\s\S]*?return mergeRestorableTabDescriptors\(liveDescriptors\)/, "server restart should restore only currently open tabs");
assert.doesNotMatch(server, /return mergeRestorableTabDescriptors\(liveDescriptors,\s*closedRestorableTabs\)/, "server restart should not restore closed tabs");
assert.match(server, /async function closeTabs\(ids, \{ allowEmpty = false \} = \{\}\)[\s\S]*?if \(!allowEmpty && targetTabs\.length >= tabs\.size\) \{\n\s+await createTab/, "bulk tab close should preserve replacement-tab behavior unless an explicit close-all requests the workspace-load empty state");
assert.match(server, /url\.pathname === "\/api\/tabs\/close" && req\.method === "POST"[\s\S]*?closedIds: closed\.map\(\(tab\) => tab\.id\)/, "server should expose a bulk close-tabs endpoint");
assert.match(server, /function rememberTabState\(tab, state\)/, "server should cache last-known tab state for restart-safe session restoration");
assert.match(server, /sessionFile: tabRestorableSessionFile\(tab\)/, "tab metadata should expose cached session files for health/status restore descriptors");
assert.match(server, /restorableTabs: mergeRestorableTabDescriptors\(statusTabs\)/, "status should expose only currently open tabs as restart restore descriptors");
assert.match(server, /data\.restorableTabs = mergeRestorableTabDescriptors\(detailedTabs\)/, "detailed status should keep restart restore descriptors limited to open tabs");
assert.match(server, /data\.closedTabs = closedRestorableTabs\.slice\(\)/, "detailed status should expose recently closed tabs separately");
assert.match(server, /const stateData = stateResult\.ok \? stateResult\.data : tab\.lastState \|\| null/, "detailed status should fall back to cached state when live RPC state is temporarily unavailable");
assert.match(server, /const initialTabs = await createInitialTabs\(\)/, "server should recreate restored tabs before listening");
assert.match(extension, /api\/webui-status\?detailed=1&events=0/, "launcher should capture detailed tab status before restarting an existing Web UI");
assert.match(extension, /function mergeRestorableTabsFromStatusSources\(sources: unknown\[\], options: StartWebuiOptions\)/, "launcher should merge available restore sources instead of trusting only the first one");
assert.match(extension, /const openTabSources: unknown\[\] = \[\]/, "launcher should collect explicit open-tab sources for restart restore");
assert.match(extension, /const detailedTabs = statusData\?\.tabs;\n\s+if \(Array\.isArray\(detailedTabs\)\) openTabSources\.push\(detailedTabs\)/, "launcher should prefer detailed open tabs over restorableTabs that may include closed tabs");
assert.match(extension, /if \(openTabSources\.length > 0\) return mergeRestorableTabsFromStatusSources\(openTabSources, options\)/, "launcher should restore only open tabs when open tab lists are available");
assert.match(extension, /return mergeRestorableTabsFromStatusSources\(\[statusData\?\.restorableTabs, existing\.restorableTabs\], options\)/, "launcher should use restorableTabs only as a legacy fallback");
assert.match(extension, /env\.PI_WEBUI_RESTORE_FILE = \(await createRestoreFile\(agentDir, restoreTabs\)\)\.file/, "launcher should pass restorable tabs through a private read-once file");
assert.match(extension, /pi\.registerCommand\("webui-start"/, "extension should expose the canonical /webui-start command");
assert.match(extension, /const child = spawn\(nodeExecutable, args, \{/, "/webui-start should use Node instead of treating a standalone Pi executable as a JavaScript runtime");
assert.match(extension, /pi\.registerCommand\("webui-tree-navigate"/, "extension should expose the internal Web UI tree navigation command");
assert.match(extension, /ctx\.navigateTree\(payload\.entryId/, "internal Web UI tree command should call the native session tree navigation API");
assert.doesNotMatch(extension, /pi\.registerCommand\("start-webui"/, "extension should not expose the older /start-webui alias");
assert.match(server, /if \(state\.data\?\.sessionFile && !options\.noSession\) piArgs\.push\("--session", state\.data\.sessionFile\)/, "native /reload should resume the same session file when restarting the RPC tab");
assert.match(server, /case "reload": \{[\s\S]*?restartTabRpc\(tab, "slash-command"\)/, "native /reload should restart the active RPC tab");
assert.match(server, /message: "Reloaded keybindings, extensions, skills, prompts, and themes\."/, "native /reload should return visible command output");
assert.match(server, /case "name": \{[\s\S]*?renameTab\(tab, parsed\.args, \{ source: "explicit" \}\)/, "native /name should also rename the browser tab");
assert.match(server, /maybeNameTabForConversation\(tab, command\);[\s\S]*?markTabWorking\(tab\)/, "server should auto-name tabs before starting visible prompt work");
assert.match(server, /function formatSessionOutput\(tab, state, stats\)/, "native /session should have visible Web UI output");
assert.match(server, /case "session": \{[\s\S]*?formatSessionOutput\(tab, state\.data \|\| \{\}, stats\.success === false \? null : stats\.data\)/, "native /session should render state and stats through Web UI");
assert.match(server, /case "copy": \{[\s\S]*?get_last_assistant_text[\s\S]*?copyText: text/, "native /copy should return text for browser clipboard handling");
assert.match(server, /case "export": \{[\s\S]*?handleNativeExportCommand\(tab, parsed\.args, req\)/, "native /export should run through the Web UI export helper");
assert.match(server, /nativeExportDownloadPayload\(\{[\s\S]*localRequest: isLocalRequest\(req\)/, "native /export should condition filesystem disclosure on localhost");
assert.match(nativeExportPayload, /\.\.\.\(localRequest \? \{ serverPath: exportedPath, result: responseData \} : \{\}\)/, "remote no-path exports should omit server paths and raw RPC path data");
assert.match(server, /url\.pathname\.startsWith\("\/api\/native-download\/"\) && req\.method === "GET"/, "native /export should expose short-lived opaque download URLs");
assert.match(app, /function triggerNativeDownload\(download\)/, "frontend should be able to start native command downloads");
assert.match(app, /function openNativeExportDownloadPrompt\(download, serverPath = ""\)[\s\S]*Copy path[\s\S]*copyText\(savedPath\)/, "frontend should show and copy the saved /export HTML path");
assert.match(app, /function alternateLoopbackBrowserUrl\(value\)/, "frontend should avoid reopening exports inside the installed PWA when possible");
assert.match(app, /function safeHttpUrl\(value/, "frontend should validate server-provided URLs through a shared helper");
assert.match(app, /const url = safeHttpUrl\(download\?\.url\)/, "native downloads must reject non-http(s) URL schemes");
assert.match(app, /const href = safeHttpUrl\(url\);/, "network status links must reject non-http(s) URL schemes");
assert.match(server, /case "\/api\/bash": \{[\s\S]*?type: "bash", command, excludeFromContext: body\.excludeFromContext === true/, "server should expose user bash execution with exclude-from-context support");
assert.match(server, /case "\/api\/abort-bash":[\s\S]*?type: "abort_bash"/, "server should expose user bash abort");
assert.match(server, /function sendQueuedBashCommand\(tab, command\)/, "server should serialize user bash through a per-tab FIFO queue");
assert.match(server, /command\.type === "bash"[\s\S]*?await sendQueuedBashCommand\(tab, command\)[\s\S]*?: await tab\.rpc\.send\(command\)/, "POST routing should use the bash FIFO queue before RPC send");
assert.match(app, /function parseUserBashInput\(message\)/, "frontend should parse leading ! and !! bash commands");
assert.match(app, /let userBashQueuesByTab = new Map\(\)/, "frontend should keep a per-tab user bash queue");
assert.match(app, /enqueueUserBashCommand\(parsed, \{ usesPromptInput, targetTabId \}\)/, "frontend should queue additional bash commands while one is active");
assert.match(app, /await sendUserBashCommand\(userBash, \{ usesPromptInput, targetTabId \}\)/, "prompt sending should run user bash before normal prompt forwarding");
assert.match(server, /case "hotkeys": \{[\s\S]*?webuiHotkeysOutput\(\)/, "native /hotkeys should return Web UI hotkey output");
assert.match(server, /url\.pathname === "\/api\/commands" && req\.method === "GET"[\s\S]*?getCommandData\(tab\)/, "GET /api/commands should merge native and RPC-visible commands");
assert.match(server, /WEBUI_TUI_NATIVE_PARITY\.json/, "server should load the native parity matrix");
assert.match(server, /url\.pathname === "\/api\/native-parity" && req\.method === "GET"/, "server should expose the native parity matrix endpoint");
assert.match(server, /function safeRpcResponse\(tab, command/, "server should provide stopped-RPC fallbacks for refresh endpoints");
assert.match(server, /function primeTabRpc\(tab\)/, "server should prime new terminal RPC state before returning created tabs");
assert.match(server, /specific Web UI action or final-output cards/, "server feedback-learning prompt should cover final outputs as well as actions");
assert.match(server, /function formatActionFeedbackLearningPrompt\(items\)/, "server should convert feedback into a LEARNING prompt");
assert.match(server, /url\.pathname === "\/api\/action-feedback" && req\.method === "POST"[\s\S]*?handleActionFeedback\(tab, body\)/, "POST /api/action-feedback should trigger the feedback-learning prompt");
assert.match(server, /Wait for the current agent run or compaction to finish before sending feedback\./, "server should only accept post-run feedback submissions");
// Intent preserved: request deduplication wraps, but does not bypass, native slash handling.
assert.match(server, /async function handlePromptRequest\(tab, body, req\)[\s\S]*?handleNativeSlashCommand\(tab, body, req\)[\s\S]*?url\.pathname === "\/api\/prompt" && req\.method === "POST"[\s\S]*?deduplicateBrowserPromptRequest\(tab, body, \(\) => handlePromptRequest\(tab, body, req\)\)/, "POST /api/prompt should retain native slash handling under browser request deduplication");
assert.match(server, /function fastPicksStorageFile\(/, "server should define a persistent fast-picks storage file");
assert.match(server, /PI_WEBUI_FAST_PICKS_FILE/, "server should allow overriding the fast-picks storage path");
assert.match(server, /async function getPathSuggestionData\(tab, rawQuery\)/, "server should compute @ file\/path reference suggestions for the active tab cwd");
assert.match(server, /url\.pathname === "\/api\/path-suggestions" && req\.method === "GET"/, "server should expose GET /api/path-suggestions for @ reference autocomplete");
assert.match(server, /async function getBangSuggestionData\(tab, rawQuery\)/, "server should compute ! and !! shell command suggestions for the active tab cwd");
assert.match(server, /PI_BANG_AUTOCOMPLETE_INCLUDE_HISTORY/, "server bang suggestions should support the companion's history knob");
assert.match(server, /PI_BANG_AUTOCOMPLETE_RUNTIME_STORE_PATH/, "server bang suggestions should support the companion's runtime-store knob");
assert.match(server, /url\.pathname === "\/api\/bang-suggestions" && req\.method === "GET"/, "server should expose GET /api/bang-suggestions for bang-command autocomplete");
assert.match(server, /url\.pathname === "\/api\/path-fast-picks" && req\.method === "GET"/, "server should expose GET /api/path-fast-picks");
assert.match(server, /url\.pathname === "\/api\/path-fast-picks" && req\.method === "POST"/, "server should expose POST /api/path-fast-picks");
assert.match(server, /url\.pathname === "\/api\/scoped-models" && req\.method === "GET"/, "server should expose GET /api/scoped-models");
assert.match(server, /url\.pathname === "\/api\/fork-messages" && req\.method === "GET"/, "server should expose fork-point data for the native /fork selector");
assert.match(server, /url\.pathname === "\/api\/sessions" && req\.method === "GET"/, "server should expose session lists for the native /resume selector");
assert.match(server, /url\.pathname === "\/api\/session-tree" && req\.method === "GET"/, "server should expose session-tree data for the native /tree selector");
assert.match(server, /url\.pathname === "\/api\/switch-session" && req\.method === "POST"/, "server should expose session resume for the native /resume selector");
assert.match(server, /async function resumeSessionInNewTab\([\s\S]*?createTab\(\{[\s\S]*?sessionFile: manager\.getSessionFile\(\)[\s\S]*?sourceTab: tabMeta\(sourceTab\)/, "session resume should create a separate terminal and preserve source-tab metadata");
assert.match(server, /url\.pathname === "\/api\/tree-navigate" && req\.method === "POST"/, "server should expose tree navigation through the Web UI helper command");
assert.match(server, /function configuredSessionDir\(\)/, "server should honor forwarded --session-dir for session selectors");
assert.match(server, /SessionManager\.listAll\(sessionDir\) : await SessionManager\.list\(tab\.cwd, sessionDir\)/, "server should support current-cwd and all-session resume scopes");
assert.match(server, /type: "set_steering_mode"/, "server should expose steering queue-mode changes for native /settings");
assert.match(server, /type: "set_follow_up_mode"/, "server should expose follow-up queue-mode changes for native /settings");
assert.match(server, /type: "set_auto_compaction"/, "server should expose auto-compaction changes for native /settings");
assert.match(server, /@firstpick\/pi-themes-bundle/, "server should discover themes from the optional theme package");
assert.match(server, /configuredAgentNpmRoot\(\), "node_modules", "@firstpick", "pi-themes-bundle", "themes"/, "server should discover themes installed in Pi's managed agent npm root");
assert.match(server, /const OPTIONAL_FEATURE_PACKAGES = new Map\(OPTIONAL_FEATURE_CATALOG/, "server should derive install allowlisting from the optional feature catalog");
assert.match(optionalFeatureCatalog, /\["bangCommandAutocomplete", "@firstpick\/pi-extension-bang-command-autocomplete"/, "catalog should allow installing the bang autocomplete optional feature");
assert.match(optionalFeatureCatalog, /\["fishUserBash", "@firstpick\/pi-extension-fish-user-bash"/, "catalog should allow installing the fish user-bash optional feature");
assert.match(optionalFeatureCatalog, /\["btwCommand", "@firstpick\/pi-extension-btw"/, "catalog should allow installing the /btw optional feature");
assert.match(optionalFeatureCatalog, /\["safetyGuard", "@firstpick\/pi-extension-safety-guard"/, "catalog should allow installing the safety guard optional feature");
assert.match(optionalFeatureCatalog, /\["tuiSkillsCommand", "@firstpick\/pi-extension-setup-skills"/, "catalog should allow installing the TUI skills optional feature");
assert.match(optionalFeatureCatalog, /\["tuiToolsCommand", "@firstpick\/pi-extension-tools"/, "catalog should allow installing the TUI tools optional feature");
assert.match(optionalFeatureCatalog, /\["questionnaire", "@firstpick\/pi-package-questionnaire"/, "catalog should allow explicitly installing the native questionnaire optional feature");
assert.match(optionalFeatureCatalog, /\["naturalConversation", "@firstpick\/pi-package-natural-conversation"/, "catalog should know the standalone Natural Conversation package for status and install guidance");
assert.match(server, /const NATURAL_CONVERSATION_COMMAND_NAMES = \["talk", "voice", "conversation"\]/, "server should detect Natural Conversation from RPC-visible command aliases");
assert.match(server, /function naturalConversationFeatureData\(tab[\s\S]*getCommandData\(tab, \{ annotateSkills: false \}\)[\s\S]*available[\s\S]*mode/, "server should expose a capability-based Natural Conversation feature snapshot");
assert.match(server, /url\.pathname === "\/api\/features\/natural-conversation" && req\.method === "GET"[\s\S]*naturalConversationFeatureData\(tab\)/, "server should expose Natural Conversation feature metadata");
assert.match(server, /url\.pathname === "\/api\/conversation-mode" && req\.method === "POST"[\s\S]*setNaturalConversationMode\(tab, body\)/, "server should toggle Natural Conversation through the package-owned slash command");
assert.match(server, /url\.pathname === "\/api\/stt\/transcribe"[\s\S]*handleNaturalConversationSttTranscribe[\s\S]*url\.pathname === "\/api\/tts\/speech"[\s\S]*handleNaturalConversationTtsSpeech/, "server should expose opt-in Natural Conversation STT/TTS fallback routes");
assert.match(server, /PI_VOICE_STT_URL[\s\S]*PI_VOICE_TTS_URL[\s\S]*GROQ_API_KEY[\s\S]*OPENAI_API_KEY[\s\S]*CLOUDFLARE_API_TOKEN/, "server voice fallbacks should be gated by server-side provider environment variables");
assert.match(server, /function requireRemoteMicConsentForStt\(req, body = \{\}\)[\s\S]*remoteMicStreamingConsentAccepted/, "server STT fallback should require explicit remote microphone streaming consent for remote clients");
assert.match(server, /function ensureNaturalConversationPromptSafety\(tab, command\)[\s\S]*setThinkingLevelForTab\(tab, "off"/, "server should force thinking off before WebUI prompts while conversation mode is active");
assert.match(server, /function enforceNaturalConversationCommandAllowed\(tab, command\)[\s\S]*thinking is forced off[\s\S]*slash commands are blocked from the Web UI shell/, "server should block unsafe direct RPC\/WebUI commands while conversation mode is active");
assert.match(server, /async function topLevelOptionalFeatureResourceIndex\(cwd = options\.cwd\)[\s\S]*metadata\?\.origin === "package"[\s\S]*packageNameForResourcePath/, "server should detect enabled top-level resources by owning package");
assert.match(server, /function optionalFeaturePackageStatus\(featureId, cwd = options\.cwd, topLevelResourceIndex\)[\s\S]*installed[\s\S]*configured[\s\S]*locallyConfigured[\s\S]*resourceConflict[\s\S]*ready/, "server should report package registration, top-level availability, conflicts, and readiness separately");
assert.match(server, /if \(beforeStatus\.locallyConfigured\)[\s\S]*load it twice[\s\S]*local-resource-conflict/, "server should block npm registration when a top-level resource already owns the optional feature");
assert.match(server, /function installOptionalFeaturePackage\(featureId, cwd = options\.cwd\)[\s\S]*const source = `npm:\$\{packageName\}`[\s\S]*resolvePiCommand\(\["install", source\]\)/, "server should install and update optional features through the selected Pi CLI");
assert.match(server, /function configuredAgentNpmRoot\(\)/, "status discovery should consider Pi's agent npm root for legacy or hoisted packages");
assert.match(server, /function packageNodeModulesPath\(nodeModulesRoot, packageName\)[\s\S]*path\.join\(nodeModulesRoot,[\s\S]*split\("\/"\)/, "status discovery should map scoped npm package names into node_modules paths");
assert.match(server, /resolveInstalledPackageSubpath\(nodeModulesRef\.packageName, nodeModulesRef\.subpath\)/, "started Web UI resource resolution should support configured package resources");
assert.match(server, /url\.pathname === "\/api\/optional-features" && req\.method === "GET"/, "server should expose optional feature package status endpoint");
assert.match(server, /url\.pathname === "\/api\/optional-feature-install" && req\.method === "POST"/, "server should preserve the optional feature single-install endpoint");
assert.match(server, /url\.pathname === "\/api\/optional-feature-install-batch" && req\.method === "POST"[\s\S]*installOptionalFeaturePackages\(body\.featureIds, tab\.cwd\)/, "server should expose the sequential optional feature batch endpoint");
assert.match(server, /function validateOptionalFeatureBatch\(featureIds\)[\s\S]*OPTIONAL_FEATURE_CATALOG\.length[\s\S]*seen\.has\(value\)/, "server batch validation should remain allowlisted, bounded, and deduplicated");
assert.match(server, /async function installOptionalFeaturePackages\(featureIds, cwd = options\.cwd\)[\s\S]*for \(const featureId of requestedFeatureIds\)[\s\S]*catch \(error\)[\s\S]*succeeded[\s\S]*failed/, "server batch execution should be sequential and continue after per-feature failures");
assert.match(server, /requireLocalhostRoute\(req, url\.pathname\)|requireLocalhost\(req, "Installing optional Web UI features is only allowed from localhost"\)/, "optional feature install endpoints should enforce localhost trust policy");
assert.match(server, /url\.pathname === "\/api\/skill-file" && req\.method === "GET"[\s\S]*?getSkillFileData/, "server should expose GET /api/skill-file for editable skill content");
assert.match(server, /url\.pathname === "\/api\/skill-file" && req\.method === "POST"[\s\S]*?requireLocalhostRoute\(req, url\.pathname\)[\s\S]*?saveSkillFileData/, "server should expose localhost-only POST /api/skill-file for saving skill content");
assert.match(server, /function resolveEditableSkillFile\(tab, request = \{\}\)[\s\S]*?path\.basename\(skill\.filePath\) !== "SKILL\.md"/, "skill file API should validate that edits target resolved SKILL.md resources");
assert.match(server, /function resolveExplicitSkillFilePath\(tab, filePath, requestedName = ""\)[\s\S]*?Skill path must point to \/skills\/<name>\/SKILL\.md[\s\S]*?allowedRoots/, "skill file API should allow exact read SKILL.md paths from trusted Pi skill roots");
assert.match(server, /Skill path is outside allowed Pi skill locations/, "explicit skill path fallback should reject paths outside Pi skill roots");
assert.match(server, /writeFile\(tmpFile, body\.content[\s\S]*?rename\(tmpFile, skill\.filePath\)/, "skill file saves should use an atomic temp-file rename");
assert.match(server, /url\.pathname === "\/api\/themes" && req\.method === "GET"/, "server should expose GET /api/themes");
assert.match(server, /readBundledThemes\(\)/, "server should read bundled theme JSON files for the browser");
// public/ is the explicit browser boundary; flat, typed asset serving prevents a
// newly imported module from drifting out of sync with a second name allowlist.
assert.match(server, /const STATIC_PUBLIC_FILE_EXTENSIONS = new Set\(\["\.html", "\.css", "\.js", "\.mjs", "\.svg", "\.png", "\.webp", "\.webmanifest"\]\)/, "server should allow only supported public asset types");
assert.match(server, /\^\[A-Za-z0-9\]\[A-Za-z0-9\._-\]\*\$[\s\S]*STATIC_PUBLIC_FILE_EXTENSIONS\.has\(path\.extname\(name\)\)/, "server should serve only safe flat file names from public");
assert.match(server, /\["\.webmanifest", "application\/manifest\+json; charset=utf-8"\]/, "server should serve manifest with the correct MIME type");
assert.match(server, /\["\.png", "image\/png"\]/, "server should serve PWA PNG icons with the correct MIME type");
assert.match(server, /\["\.webp", "image\/webp"\]/, "server should serve Matrix WebP backgrounds with the correct MIME type");
assert.match(server, /function configuredScopedModelPatterns\(cwd = options\.cwd\)/, "server should read Pi configured scoped-model patterns for the active tab cwd");
assert.match(server, /readJsonFileIfExists\(path\.join\(cwd, "\.pi", "settings\.json"\)\)/, "server should read project-local scoped-model settings from active tab cwd");
assert.match(server, /resolveScopedModelsFromPatterns\(patterns, response\.data\?\.models/, "server should resolve scoped patterns against available models");
assert.match(server, /writeFile\(tmpFile[\s\S]*?rename\(tmpFile, storageFile\)/, "server should persist fast picks with an atomic temp-file rename");
assert.match(technical, /automatic naming from the first prompt/i, "technical reference should describe automatic terminal-tab naming");
assert.match(development, /Feedback reactions \(`👍`, `👎`, `\?`\) on final assistant output plus tool\/bash action cards/, "development guide should describe final-output and action feedback reactions");
assert.match(development, /POST \/api\/action-feedback\?tab=<tabId>/, "development guide should document the action-feedback endpoint");
assert.match(development, /`@` file\/path references with live suggestions/, "development guide should describe @ file/path reference autocomplete");
assert.match(development, /optional `@firstpick\/pi-extension-bang-command-autocomplete` companion[\s\S]*GET \/api\/bang-suggestions\?tab=<tabId>&query=<command>/, "development guide should document optional bang-command autocomplete and its endpoint");
assert.match(development, /optional `@firstpick\/pi-extension-fish-user-bash` companion/, "development guide should document optional fish user-bash integration");
assert.match(development, /GET \/api\/path-suggestions\?tab=<tabId>&query=<path>/, "development guide should document the path-suggestions endpoint");
assert.match(development, /GET \/api\/optional-features/, "development guide should document optional feature status endpoint");
assert.match(development, /POST \/api\/optional-feature-install/, "development guide should document optional feature install endpoint");
assert.match(development, /POST \/api\/optional-feature-install-batch[\s\S]*bounded allowlisted[\s\S]*sequentially/, "development guide should document the bounded sequential batch endpoint");
assert.match(technical, /\*\*Install all\*\*[\s\S]*\*\*Install missing\*\*[\s\S]*missing or unregistered[\s\S]*one confirmation[\s\S]*continue after individual failures/, "technical reference should document bulk control scope and partial-failure behavior");
assert.match(technical, /pi install npm:@firstpick\/pi-extension-stats[\s\S]*Re-running the same `pi install npm:<package>` command is the supported update path/, "technical reference should document separate manual Pi package installation and updates");
assert.match(development, /server-persisted fast picks/, "development guide should describe server-persisted fast picks");
assert.match(development, /`\/btw` side-question output widgets with optional context transfer\/live steering, browser notifications when a tab needs an extension UI response, and an optional side-panel toggle for agent-done notifications/, "development guide should describe /btw, blocked-tab, and agent-done notifications");
assert.match(development, /blocked-tab browser notifications, and optional agent-done notifications require browser service-worker\/notification support/, "development guide should document notification requirements");
assert.match(development, /Side-panel theme picker backed by optional `@firstpick\/pi-themes-bundle` themes plus Pi-native project\/global custom themes/, "development guide should describe bundled and custom theme selection");
assert.match(development, /## Optional companion packages/, "development guide should document optional Web UI companion packages");
assert.match(development, /Web UI tabs load enabled resources resolved from normal Pi settings/, "development guide should document Pi-settings-based optional feature loading");
assert.match(development, /legacy\/hoisted package files without either a Pi settings entry or an enabled top-level resource remain installable/i, "development guide should document migration handling for physically present but unregistered packages");
assert.match(development, /excluding the Web UI package itself from re-loading/, "development guide should document Web UI self-loading duplicate prevention");
assert.match(development, /checks loaded Pi capabilities directly through RPC-visible commands, tools, themes, and live widget events/, "development guide should document capability-based startup checks");
assert.match(development, /side panel separately reports physical installation and Pi registration/, "development guide should document distinct installed and registered optional feature status");
assert.match(development, /per-row \*\*Install\*\* or \*\*Update\*\* action[\s\S]*batch has one confirmation[\s\S]*bounded diagnostics/, "development guide should document per-row and bulk warning/result behavior");
assert.match(development, /Natural Conversation Mode shell[\s\S]*\/talk[\s\S]*read-only/, "development guide should document the optional Natural Conversation WebUI shell");
assert.match(development, /\.\/dev\/scripts\/start-webui\.sh --dev --cwd \/path\/to\/project/, "development guide should document the dev helper launcher");
assert.match(development, /register that package with Pi from its absolute local path[\s\S]*resolved from Pi settings rather than the Web UI manifest/, "development guide should document local companion registration through Pi settings");
assert.match(startScript, /--dev\)/, "start-webui.sh should accept a --dev flag");
assert.match(startScript, /local_pi_webui_bin\(\)/, "start-webui.sh should resolve this checkout's local server entrypoint");
assert.match(startScript, /candidate="\$\(package_root\)\/bin\/pi-webui\.mjs"/, "start-webui.sh should resolve the package-root bin from dev/scripts");
assert.match(startScript, /webui_cmd=\(node "\$local_webui_bin"\)/, "start-webui.sh --dev should run the local bin with node");
assert.match(startScript, /export PI_WEBUI_DEV=1/, "start-webui.sh --dev should mark the Web UI server as dev mode");
assert.match(startScript, /"\$\{webui_cmd\[@\]\}" --cwd "\$cwd" --host "\$host" --port "\$port" "\$\{pass_args\[@\]\}"/, "start-webui.sh should launch through the selected server command without forwarding --dev");

assert.match(pkg.scripts?.test || "", /node tests\/run-all\.mjs/, "package test script should run every tests/*.test.mjs through the shared runner");
assert.ok(!pkg.files?.includes("start-webui.sh"), "npm package should not list the moved Bash dev helper at the package root");
assert.ok(!pkg.files?.includes("start-webui.ps1"), "npm package should not list the moved PowerShell dev helper at the package root");
assert.ok(!pkg.files?.some((entry) => entry === "dev/scripts" || entry.startsWith("dev/scripts/")), "npm package should not publish development helper scripts");
for (const name of Object.keys(companionDependencies)) {
  assert.equal(pkg.optionalDependencies?.[name], undefined, `webui package should not optionally install companion ${name}`);
  assert.equal(pkg.dependencies?.[name], undefined, `webui package should not require companion ${name}`);
}
for (const name of [
  "@firstpick/pi-package-natural-conversation",
  "@firstpick/pi-package-questionnaire",
  "@firstpick/pi-extension-aur-review",
]) {
  assert.equal(pkg.optionalDependencies?.[name], undefined, `webui package should keep ${name} as a separate Pi package`);
  assert.equal(pkg.dependencies?.[name], undefined, `webui package should not require separate Pi package ${name}`);
}
assert.deepEqual(pkg.optionalDependencies, { "node-pty": "^1.1.0" }, "node-pty should be the sole optional Web UI runtime dependency");
assert.equal(pkg.bundledDependencies, undefined, "webui optional companion packages should not be bundled into the tarball");
assert.deepEqual(pkg.pi?.extensions, ["./index.ts", "./session-summary.ts"], "webui Pi manifest should load its core and focused session-summary extensions");
assert.equal(pkg.pi?.skills, undefined, "webui Pi manifest should not own companion skills");
assert.equal(pkg.pi?.prompts, undefined, "webui Pi manifest should not own companion prompts");
assert.equal(pkg.pi?.themes, undefined, "webui Pi manifest should not own companion themes");
assert.match(helper, /function installRpcUserBashSupport\(\)/, "Web UI RPC helper should patch RPC bash execution for user_bash events");
assert.match(helper, /runner\?\.hasHandlers\?\.\("user_bash"\)[\s\S]*runner\.emitUserBash/, "Web UI RPC helper should emit user_bash before default bash execution");
assert.match(helper, /eventResult\?\.operations[\s\S]*original\.call\(this, command, onChunk, nextOptions\)/, "Web UI RPC helper should pass extension-provided bash operations to Pi execution");
assert.match(helper, /eventResult\?\.result[\s\S]*recordBashResult/, "Web UI RPC helper should preserve extension-provided bash results in session history");
assert.ok(pkg.scripts?.check?.includes("node --check public/app.js"), "check script should syntax-check app.js");
assert.ok(pkg.scripts?.check?.includes("node tests/run-all.mjs"), "check script should run the shared test runner");

// --- Performance: keyed transcript reconciliation (P0-1) ---
assert.match(app, /let renderedTranscriptState = \{ epoch: "", entries: \[\] \};/, "transcript reconciliation should track rendered entries");
const renderAllMessagesSource = appFunctionSource("renderAllMessages", "applyNativeSlashCommandEffects");
assert.match(renderAllMessagesSource, /prefixLength[\s\S]*?prefixKeys[\s\S]*?transcriptRenderer\.commitTranscriptMutation\(\{[\s\S]*?kind: forceRebuild \? "authoritative" : "reconcile"[\s\S]*?if \(prefixLength === 0\)[\s\S]*?resetChatOutput\(\)[\s\S]*?removeChatBubblesAfterPrefix\(/, "renderAllMessages should reuse the unchanged keyed prefix inside one coordinator transaction instead of always rebuilding");
assert.match(app, /function removeChatBubblesAfterPrefix\(keptKeys\)[\s\S]*?child === elements\.stickyUserPromptButton \|\| liveBubbles\.has\(child\)/, "prefix removal must preserve the sticky prompt button and live bubbles such as the run indicator");
assert.match(app, /function resetChatOutput\(\) \{\n  liveToolCards\.clear\(\);\n  renderedTranscriptState = \{ epoch: "", entries: \[\] \};/, "full chat resets must clear reconciliation state");
assert.match(app, /function transcriptRenderEpoch\(\)[\s\S]*?thinkingOutputVisible/, "reconciliation epoch must include thinking visibility so toggles rebuild the transcript");
assert.match(app, /pruneDisconnectedLiveToolCards\(\);/, "reconciliation must prune live tool card references to removed DOM nodes");

// --- Performance: incremental streaming markdown (P0-3) ---
assert.match(app, /function streamingMarkdownStableBoundary\(text, previousState, options\) \{\s+return advanceStreamingMarkdownTail\(previousState, text, options\);/, "streaming markdown boundary must be delegated to the mutable-tail helper (which never treats the final partial line as stable)");
const renderStreamingMarkdownSource = appFunctionSource("renderStreamingMarkdown", "appendImage");
assert.match(renderStreamingMarkdownSource, /captureChatTextSelection\(block\)[\s\S]*?transcriptRenderer\.reconcileMarkdownSurface\(\{[\s\S]*?stableBoundary: streamingMarkdownStableBoundary[\s\S]*?renderInto: renderMarkdownInto[\s\S]*?restoreChatTextSelection/, "streaming Markdown must reconcile stable committed blocks and its mutable tail through the coordinator");
assert.match(app, /streamRawText = "";\n  streamThinkingRawText = "";\n  resetStreamDerivedOutputState\("reset"\);/, "resetting the stream bubble must clear raw text and derived output state");

// --- Performance: delta transcript fetch (P1-1) ---
assert.match(app, /function mergeMessagesDelta\(previous, data\)[\s\S]*?messagesLookEqual\(previous\[since\], data\.messages\[0\]\)/, "delta merges must verify the one-message overlap before applying");
assert.match(app, /async function refreshMessages\(tabContext = activeTabContext\(\), \{ authoritative = false \} = \{\}\)[\s\S]*?\/api\/messages\?since=/, "message refreshes should request transcript deltas");
assert.match(app, /if \(!nextMessages\) \{[\s\S]*?api\("\/api\/messages", \{ tabId: tabContext\.tabId \}\)/, "delta failures must fall back to a full transcript fetch");
assert.match(server, /function applyMessagesSinceParam\(response, url\)/, "server should slice get_messages results for \\?since= requests");
assert.match(app, /const messageStaticSignatureCache = new WeakMap\(\);/, "static message signatures should be cached by object identity");
assert.match(app, /case "tool_execution_end":(?:(?!scheduleRefreshMessages)[\s\S])*?break;/, "tool completions must not trigger full transcript refreshes");
assert.match(app, /case "message_end": \{(?:(?!case ")[\s\S])*?scheduleSemanticReconcile\(\{ messages: true, state: true, footerData: true \}, tabContext\);/, "assistant message completion must still reconcile the transcript, through the coalesced semantic scheduler");

// --- UX: transcript search (P2-1) ---
assert.match(html, /id="chatSearchBar"[\s\S]*?id="chatSearchInput"[\s\S]*?id="chatSearchPrevButton"[\s\S]*?id="chatSearchNextButton"[\s\S]*?id="chatSearchCloseButton"/, "transcript search bar markup should exist with navigation controls");
assert.match(app, /function openChatSearch\(\)[\s\S]*?elements\.chatSearchInput\?\.focus\(\)/, "opening transcript search should focus the input");
assert.match(app, /\(event\.ctrlKey \|\| event\.metaKey\) && !event\.altKey && !event\.shiftKey && event\.key\.toLowerCase\(\) === "f"/, "Ctrl\/Cmd+F should open the transcript search");
assert.match(app, /function chatSearchRoot\(\)[\s\S]*subagentTerminalTranscript[\s\S]*elements\.chat/, "transcript search should target the active main or subagent output stream");
assert.match(app, /function collectChatSearchMatches\(query\)[\s\S]*while \(matches\.length < CHAT_SEARCH_MATCH_LIMIT\)[\s\S]*matches\.push\(\{ bubble, start, end:/, "transcript search should collect every matching occurrence instead of only matching bubbles");
assert.match(app, /function renderChatSearchHighlights\(\)[\s\S]*chat-search-match[\s\S]*new HighlightConstructor\(\.\.\.ranges\)[\s\S]*chat-search-current/, "transcript search should highlight all exact ranges and distinguish the current one");
assert.match(app, /function focusChatSearchMatch\(\)[\s\S]*?details\.open = true;[\s\S]*?scrollIntoView/, "navigating to a search match should expand collapsed tool output and scroll to the bubble");
assert.match(app, /autoFollowChat = false;\n    lastChatProgrammaticScrollAt = performance\.now\(\);/, "main-transcript search navigation must not fight chat auto-follow");
assert.match(app, /new MutationObserver\([\s\S]*runChatSearch\(\{ navigate: false \}\)[\s\S]*characterData: true/, "open searches should re-highlight refreshed live output without stealing navigation focus");
assert.match(css, /::highlight\(chat-search-match\)[\s\S]*::highlight\(chat-search-current\)/, "all transcript matches and the current match should have distinct highlight styles");
assert.doesNotMatch(css, /body\.subagent-terminal-active \.chat-search-bar/, "the search bar must remain visible while viewing a subagent output stream");
assert.match(css, /\.chat \{[^}]*overflow:\s*auto;[^}]*overflow-anchor:\s*none;/, "the transcript should disable browser scroll anchoring because paused-reader position is controlled explicitly during live growth");
assert.match(css, /\.chat-search-bar,\n\.file-viewer-search-bar \{/, "transcript search bar should be styled");

console.log("mobile static checks passed");
