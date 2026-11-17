import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const helperRequests = await readFile(new URL("../lib/server/helper-requests.mjs", import.meta.url), "utf8");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [parityRaw, server, app, pkgRaw] = await Promise.all([
  readFile(join(root, "lib", "WEBUI_TUI_NATIVE_PARITY.json"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
]);

const parity = JSON.parse(parityRaw);
const pkg = JSON.parse(pkgRaw);
const statusValues = new Set(parity.statusTaxonomy);
const guardValues = new Set(parity.guardTaxonomy);
const kindValues = new Set([
  "slash-command",
  "keyboard-shortcut",
  "editor-feature",
  "session-action",
  "extension-ui-method",
  "native-command-adapter",
  "security-guard",
  "test-harness",
]);
const priorityValues = new Set(["P0", "P1", "P2"]);

assert.equal(parity.schemaVersion, 1, "native parity matrix should have a schema version");
assert.deepEqual(parity.statusTaxonomy, ["implemented", "degraded", "unsupported"], "native parity status taxonomy should stay strict");
assert.ok(Array.isArray(parity.surfaces) && parity.surfaces.length > 0, "native parity matrix should contain surfaces");

const ids = new Set();
for (const surface of parity.surfaces) {
  assert.equal(typeof surface.id, "string", "every parity surface should have an id");
  assert.ok(surface.id.trim(), "parity surface ids should be non-empty");
  assert.ok(!ids.has(surface.id), `duplicate parity surface id: ${surface.id}`);
  ids.add(surface.id);
  assert.ok(kindValues.has(surface.kind), `${surface.id} should use a known kind`);
  assert.ok(statusValues.has(surface.webStatus), `${surface.id} should use the strict webStatus taxonomy`);
  assert.ok(priorityValues.has(surface.priority), `${surface.id} should declare a P0/P1/P2 priority`);
  assert.equal(typeof surface.sensitive, "boolean", `${surface.id} should declare whether it is sensitive`);
  assert.ok(Array.isArray(surface.guards) && surface.guards.length > 0, `${surface.id} should declare at least one guard`);
  for (const guard of surface.guards) {
    assert.ok(guardValues.has(guard), `${surface.id} guard ${guard} should be in guardTaxonomy`);
  }
  assert.equal(typeof surface.currentBehavior, "string", `${surface.id} should document current behavior`);
  assert.equal(typeof surface.targetBehavior, "string", `${surface.id} should document target behavior`);
}

const slashSurfaces = parity.surfaces.filter((surface) => surface.kind === "slash-command");
const slashCommandNames = slashSurfaces.map((surface) => surface.command?.name).filter(Boolean);
const requiredNativeCommands = [
  "settings",
  "safety-guard-setup",
  "git-workflow-setup",
  "workflow-setup",
  "summary",
  "summary-setup",
  "model",
  "theme",
  "scoped-models",
  "tools",
  "skills",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "tree",
  "login",
  "logout",
  "new",
  "compact",
  "resume",
  "reload",
  "quit",
];
assert.deepEqual(slashCommandNames, requiredNativeCommands, "matrix slash-command order should define the native command picker order");

for (const surface of slashSurfaces) {
  assert.equal(surface.id, `/${surface.command.name}`, `${surface.command.name} slash-command id should match command.name`);
  assert.equal(typeof surface.command.description, "string", `${surface.id} should provide a command description`);
  assert.ok(surface.command.description.trim(), `${surface.id} command description should not be empty`);
}

const workflowSetupSurface = slashSurfaces.find((surface) => surface.id === "/workflow-setup");
assert.ok(workflowSetupSurface, "/workflow-setup should be represented in the native parity matrix");
assert.equal(workflowSetupSurface.webStatus, "implemented", "/workflow-setup browser-native support should be implemented");
assert.equal(workflowSetupSurface.sensitive, true, "/workflow-setup should be tracked as a sensitive policy mutation");
assert.deepEqual(workflowSetupSurface.guards, ["localhost", "confirmation"], "/workflow-setup should require both localhost and explicit confirmation guards");

for (const id of ["/summary", "/summary-setup"]) {
  const surface = slashSurfaces.find((item) => item.id === id);
  assert.ok(surface, `${id} should be represented in the native parity matrix`);
  assert.equal(surface.webStatus, "implemented", `${id} browser-native support should be implemented`);
  assert.equal(surface.sensitive, true, `${id} sends or configures provider-bound session data`);
  assert.deepEqual(surface.guards, ["confirmation"], `${id} should use explicit setup/disclosure confirmation without a localhost-only restriction`);
}

const selectorMatch = app.match(/const NATIVE_SELECTOR_COMMANDS = new Set\(\[(.*?)\]\)/s);
assert.ok(selectorMatch, "frontend native selector command set should be discoverable");
const frontendSelectorCommands = [...selectorMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
for (const name of frontendSelectorCommands) {
  assert.ok(slashCommandNames.includes(name), `frontend native selector /${name} should be represented in the parity matrix`);
}

const sensitiveCommands = new Set(["export", "import", "share", "login", "logout", "resume", "quit"]);
for (const name of sensitiveCommands) {
  const surface = slashSurfaces.find((item) => item.command.name === name);
  assert.ok(surface, `sensitive command /${name} should be in the matrix`);
  assert.equal(surface.sensitive, true, `/${name} should be marked sensitive`);
  assert.ok(!surface.guards.includes("none"), `/${name} should not have a no-op guard`);
}

for (const id of [
  "adapter.native-command-response",
  "security.trust-boundaries",
  "tests.native-parity-harness",
]) {
  const surface = parity.surfaces.find((item) => item.id === id);
  assert.ok(surface, `P0 foundation surface ${id} should be tracked`);
  assert.equal(surface.priority, "P0", `${id} should remain P0`);
  assert.equal(surface.webStatus, "implemented", `${id} should be implemented`);
}

assert.match(server, /WEBUI_TUI_NATIVE_PARITY\.json/, "server should load the native parity matrix file");
assert.match(server, /from "\.\.\/lib\/native-command-adapter\.mjs"/, "server should import the native command adapter module");
assert.match(server, /from "\.\.\/lib\/trust-boundaries\.mjs"/, "server should import the shared trust-boundaries module");
assert.match(server, /const NATIVE_SLASH_COMMANDS = nativeSlashCommandEntries\(nativeParityMatrix\)/, "native slash commands should use the matrix-derived source of truth");
assert.match(server, /const respondNative = \(command, data = \{\}\) => nativeCommandResponse\(command, data, nativeParityMatrix\)/, "server should bind native command responses to the parity matrix");
assert.match(server, /default:\n\s+return unavailableNative\(parsed\.name\)/, "unsupported native commands should return structured unavailable cards instead of raw HTTP errors");
assert.match(server, /return nativeCommandBlocked\(parsed\.name, req, nativeParityMatrix/, "guarded native commands should return blocked adapter cards for failed trust checks");
assert.match(
  server,
  /const evaluation = evaluateDispatchTrustGuards\(guardsForNativeCommand\(parsed\.name, nativeParityMatrix\)/,
  "native command dispatch should evaluate matrix guards for every command, not only sensitive ones",
);
assert.doesNotMatch(server, /if \(surface\?\.sensitive\)/, "native command dispatch must not key trust checks on the sensitive flag");
assert.match(server, /requireLocalhostRoute\(req, url\.pathname\)/, "localhost-only API routes should use the shared trust-boundaries helper");
assert.match(server, /remoteShellTrustWarning\(req, networkStatus\(\)\.open\)/, "remote bash clients should receive LAN shell trust warnings");
assert.match(server, /url\.pathname === "\/api\/session-rename" && req\.method === "POST"/, "server should expose POST /api/session-rename for resume metadata rename");
assert.match(server, /url\.pathname === "\/api\/session-delete" && req\.method === "POST"/, "server should expose localhost-only POST /api/session-delete");
assert.match(server, /url\.pathname === "\/api\/auth-providers" && req\.method === "GET"/, "server should expose GET /api/auth-providers");
assert.match(server, /url\.pathname === "\/api\/auth-logout" && req\.method === "POST"/, "server should expose localhost-only POST /api/auth-logout");
assert.match(server, /url\.pathname === "\/api\/workflow-policy" && req\.method === "GET"[\s\S]*requireLocalhost\(req, "Workflow policy setup is only allowed from localhost\."\)/, "workflow policy reads should be localhost-only");
assert.match(server, /url\.pathname === "\/api\/workflow-policy" && req\.method === "POST"[\s\S]*requireLocalhostRoute\(req, url\.pathname\)[\s\S]*requireWorkflowPolicyJsonRequest\(req\)[\s\S]*expectedRevision: body\.expectedRevision/, "workflow policy saves should be registry-guarded, same-origin JSON, and revision protected");
assert.match(app, /\(name === "workflow-setup" \|\| name === "summary" \|\| name === "summary-setup"\) && !hasLoadedRpcCommand\(name\)[\s\S]*case "workflow-setup":[\s\S]*openNativeWorkflowSetupDialog\(\)/, "frontend should gate exact summary and setup commands on the active Pi tab's loaded extension catalog");
assert.ok(app.includes('const summaryMatch = String(message || "").trim().match(/^\\/summary(?:\\s+(refresh))?$/i);'), "frontend should intercept only exact /summary and /summary refresh command forms");
assert.match(app, /case "summary":[\s\S]*openSessionSummaryForTab\(activeTabId, \{ refresh: summaryMatch\?\.\[1\][\s\S]*case "summary-setup":[\s\S]*openNativeSessionSummarySetupDialog\(\)/, "frontend should route exact summary commands to the non-blocking overlay without normal prompt dispatch");
assert.match(app, /async function openSessionSummaryForTab\(tabId = activeTabId, \{ refresh = false, focusReturnKey = "" \} = \{\}\)[\s\S]*hasAvailableCommand\("summary", \{ tabId \}\)[\s\S]*preferences\?\.configured[\s\S]*openNativeSessionSummarySetupDialog[\s\S]*openSessionSummaryOverlay[\s\S]*requestSessionSummaryGeneration\(tabId, \{ refresh \}\)/, "frontend /summary action should remain catalog-gated, preserve focus restoration, open setup when needed, and force exact refresh requests");
assert.match(app, /function normalizeSessionSummaryClientState\(value, previous = null, \{ resetProjection = false \} = \{\}\)[\s\S]*sessionChanged[\s\S]*resetProjection \|\| sessionChanged \? null : previous[\s\S]*function handleSessionSummaryEvent\(event\)[\s\S]*resetProjection: event\?\.kind === "state"/, "client projection should clear across session IDs and active-branch state events while preserving ordinary failure state");
assert.match(app, /title: "Save session summary setup\?"[\s\S]*if \(!reviewed\) return;[\s\S]*confirmed: true[\s\S]*requestSessionSummaryGeneration/, "summary setup should require explicit privacy/cost confirmation before persistence and immediate first generation");
assert.match(server, /args\.includes\(sessionSummaryExtensionPath\)[\s\S]*args\.push\("--extension", sessionSummaryExtensionPath\)/, "each WebUI child should explicitly receive the package-owned summary extension");
assert.match(server, /url\.pathname === "\/api\/session-summary\/preferences" && req\.method === "GET"[\s\S]*url\.pathname === "\/api\/session-summary\/preferences" && req\.method === "PUT"[\s\S]*url\.pathname === "\/api\/session-summary\/generate" && req\.method === "POST"/, "server should expose authenticated tab-scoped preferences and generation routes");
assert.match(server, /function requireSessionSummaryJsonRequest\(req\)[\s\S]*application\/json[\s\S]*same-origin/, "summary mutations should fail closed on cross-origin-simple request shapes");
assert.match(server, /function publicSessionSummaryPreferences\(value\)[\s\S]*scope: "text-and-tool-names"[\s\S]*preferences: publicSessionSummaryPreferences\(storedPreferences\)/, "summary preference responses should project only approved bounded fields instead of exposing preserved unknown keys");
assert.match(server, /tab\.titleSource === "default" \|\| tab\.titleSource === "auto"[\s\S]*renameTab\(tab, details\.title, \{ source: "auto"/, "summary title bridge should preserve explicit tab names");
assert.match(server, /filterSessionSummaryTranscriptMessages[\s\S]*SESSION_SUMMARY_RPC_TYPE[\s\S]*SESSION_SUMMARY_DISPLAY_TYPE/, "summary control and display messages should remain outside the normal WebUI transcript");
assert.match(server, /const SESSION_SUMMARY_GENERATE_TIMEOUT_MS = 105 \* 1000[\s\S]*async function triggerSessionSummary[\s\S]*SESSION_SUMMARY_GENERATE_TIMEOUT_MS[\s\S]*status: "failure"[\s\S]*broadcastSessionSummaryState\(tab, "failure"\)[\s\S]*throw error/, "summary RPC dispatch should use the extension-scale timeout and broadcast bounded terminal failure before rethrowing");
assert.match(app, /title: "Save reviewed workflow permission ceiling\?"[\s\S]*if \(!reviewed\) return;[\s\S]*body: \{ policy: policyToSave, expectedRevision: data\.revision \?\? null \}/, "frontend should explicitly confirm the normalized workflow policy before revision-protected save");
assert.match(server, /url\.pathname === "\/api\/native-parity" && req\.method === "GET"/, "server should expose the native parity matrix for clients/tests");
assert.match(server, /const NATIVE_DOWNLOAD_TOKEN_TTL_MS = 10 \* 60 \* 1000/, "native downloads should use short-lived tokens");
assert.match(helperRequests, /export const WEBUI_HELPER_COMMAND = "webui-helper"/, "server should declare the hidden Web UI RPC helper command");
assert.match(server, /import \{ createHelperRequestService, WEBUI_HELPER_COMMAND \} from "\.\.\/lib\/server\/helper-requests\.mjs"/, "server command discovery must use the same helper command identity");
assert.match(server, /args\.push\("--extension", webuiHelperExtensionPath\)/, "Web UI tabs should force-load the browser-native RPC helper extension");
assert.match(server, /url\.pathname === "\/api\/tools" && req\.method === "GET"/, "server should expose GET /api/tools for native /tools");
assert.match(server, /url\.pathname === "\/api\/tools" && req\.method === "POST"/, "server should expose POST /api/tools for native /tools updates");
assert.match(server, /url\.pathname === "\/api\/skills" && req\.method === "GET"/, "server should expose GET /api/skills for native /skills");
assert.match(server, /url\.pathname === "\/api\/skills" && req\.method === "POST"/, "server should expose POST /api/skills for native /skills updates");
assert.match(server, /function requireResourceScope\(value\)[\s\S]*scope !== "session" && scope !== "global" && scope !== "model"/, "resource APIs should accept session, global, and model scopes");
assert.match(server, /updateWebuiSettings\([\s\S]*resourceDefaults[\s\S]*tools[\s\S]*enabledTools/, "global tool choices should persist through the locked Web UI settings updater");
assert.match(server, /updateWebuiSettings\([\s\S]*resourceDefaults[\s\S]*skills[\s\S]*enabledSkills/, "global skill choices should persist through the locked Web UI settings updater");
assert.match(app, /function nativeResourceScopeControl\(scope,[\s\S]*Session only[\s\S]*Global default[\s\S]*Model default/, "Tools and Skills Setup should expose session/global/model scope choices");
assert.match(app, /const body = \{ scope: selection\.scope \};[\s\S]*if \(selection\.scope === "model"\) Object\.assign\(body, \{ provider: selection\.provider, modelId: selection\.modelId \}\)/, "resource writes should retain the selected scope and exact model identity");
assert.match(app, /if \(change\.inherit\) body\.inherit = true;[\s\S]*body\[kind === "tools" \? "enabledTools" : "enabledSkills"\] = change\.enabled;[\s\S]*method: "POST", body, tabId: target\.tabId/, "resource writes should preserve inheritance versus the full enabled list and captured tab");
assert.match(app, /Unpinned active \$\{kind\} update immediately; pinned \$\{kind\} are unchanged\./, "global selector feedback should explain live precedence");
assert.match(app, /aria-pressed/, "resource toggles should expose their enabled state programmatically");
assert.match(app, /const HIDDEN_COMMAND_NAMES = new Set\(\["webui-tree-navigate", "webui-helper"\]\)/, "frontend should hide Web UI internal helper commands");
assert.match(app, /"scoped-models", "tools", "skills"/, "frontend native selector commands should include /tools and /skills");
assert.match(app, /return match \? match\[1\]\.toLowerCase\(\) : ""/, "frontend native slash command matching should be case-insensitive");
assert.match(app, /async function openNativeToolsSelector\(\)/, "frontend should implement a browser-native /tools selector");
assert.match(app, /async function openNativeSkillsSelector\(\)/, "frontend should implement a browser-native /skills selector");
assert.match(server, /function registerNativeDownload\(filePath, \{ fileName, contentType, command = "native" \} = \{\}\)/, "server should register opaque native download tokens");
assert.match(server, /url\.pathname\.startsWith\("\/api\/native-download\/"\) && req\.method === "GET"/, "server should expose opaque native download endpoint");
assert.match(server, /case "export": \{\n\s+return handleNativeExportCommand\(tab, parsed\.args, req\);\n\s+\}/, "native /export should route through the native command adapter");
assert.match(server, /tab\.rpc\.send\(\{ type: "export_html", outputPath \}\)/, "no-path /export should use RPC export_html into a controlled temp path");
assert.match(server, /registerNativeDownload\(exportedPath/, "no-path /export should return a short-lived browser download token");
assert.match(server, /nativeExportDownloadPayload\(\{[\s\S]*localRequest: isLocalRequest\(req\)/, "no-path /export should disclose the saved HTML path only to localhost requests");
assert.match(server, /openUrl: record\.contentType === MIME_TYPES\.get\("\.html"\)/, "HTML native downloads should expose a browser-open URL");
assert.match(server, /url\.searchParams\.get\("disposition"\) === "inline"/, "native download endpoint should support inline HTML rendering");
assert.match(server, /copyFile\(sessionFile, targetPath\)/, "explicit .jsonl /export should copy the active session file");
assert.match(app, /function triggerNativeDownload\(download\)[\s\S]*try \{[\s\S]*anchor\.click\(\)[\s\S]*finally \{[\s\S]*anchor\.remove\(\)/, "frontend should clean up download anchors even when browser opening throws");
assert.match(app, /function applyNativeSlashCommandEffects\(response, message, tabContext/, "frontend should apply centralized native slash-command adapter effects");
assert.match(app, /if \(data\.download\) \{[\s\S]*handleNativeDownloadResponse\(data\.download, data\.command, data\.serverPath\)[\s\S]*could not open \$\{data\.command === "export" \? "HTML export" : "download"\}/, "frontend should catch and surface native HTML/download open failures");
assert.match(app, /function openNativeExportDownloadPrompt\(download, serverPath = ""\)[\s\S]*Saved to:\\n[\s\S]*Copy path[\s\S]*copyText\(savedPath\)[\s\S]*Open in browser/, "frontend should show and copy the saved /export HTML path before offering browser open");
assert.match(app, /function alternateLoopbackBrowserUrl\(value\)[\s\S]*hostname === "localhost"[\s\S]*127\.0\.0\.1/, "PWA export opens should escape same-origin app scope via alternate loopback host");
assert.match(app, /for \(const warning of response\.warnings/, "frontend should surface remote bash trust warnings");
assert.match(server, /case "\/api\/bash": \{[\s\S]*?return \{ type: "bash", command, excludeFromContext: body\.excludeFromContext === true \}/, "server should expose RPC bash with include/exclude context semantics");
assert.match(server, /case "\/api\/abort-bash":[\s\S]*?return \{ type: "abort_bash" \}/, "server should expose abort_bash for user bash cancellation");
assert.match(app, /function parseUserBashInput\(message\)[\s\S]*?text\.startsWith\("!!"\)/, "frontend should detect !! bash commands before prompt forwarding");
assert.match(app, /const userBash = kind === "prompt" && attachments\.length === 0 \? parseUserBashInput\(originalMessage\) : null/, "prompt sending should intercept user bash only for plain prompt input");
assert.match(app, /api\("\/api\/bash", \{ method: "POST", body: \{ command, excludeFromContext \}/, "frontend should send user bash commands to the bash endpoint");
assert.match(app, /function isCompleteUserBashMessage\(message\)[\s\S]*?title\.includes\("complete"\)[\s\S]*?function shouldOpenMessageCollapseByDefault\(message\)[\s\S]*?isCompleteUserBashMessage\(message\)/, "frontend should expand completed user bash cards by default without toggling all tool output");
assert.match(app, /api\("\/api\/abort-bash", \{ method: "POST", body: \{\}, tabId: tabContext\.tabId \}\)/, "abort should target active user bash before agent abort");
assert.match(server, /async function cycleTabModel\(tab, direction = "forward"\)/, "server should provide scoped\/all model cycling helper");
assert.match(server, /url\.pathname === "\/api\/model-cycle" && req\.method === "POST"/, "server should expose model-cycle endpoint for shortcuts");
assert.match(server, /case "\/api\/thinking-cycle":[\s\S]*?type: "cycle_thinking_level"/, "server should expose thinking-cycle endpoint for shortcuts");
assert.match(server, /async function setThinkingLevelForTab\(tab, level, \{ allowPending = true \} = \{\}\)[\s\S]*?stateIsBusyForSettings\(stateResult\.data\)[\s\S]*?tab\.pendingThinkingLevel = level/, "server should queue side-panel thinking changes while a tab is running");
assert.match(server, /function eventForTabClients\(tab, event\)[\s\S]*?const decorated = event\?\.type === "queue_update"[\s\S]*?responseWithPendingThinking\(tab, decorated\)[\s\S]*?tabId: tab\.id/, "server should apply pending-thinking decoration to the source-decorated SSE event and retain its tab id");
assert.match(server, /tab\.pendingThinkingLevel = level;\n\s+broadcastPendingThinkingState\(tab, stateResult\.data\)/, "server should broadcast queued thinking state after assigning the pending level");
assert.match(server, /const pendingThinkingResponse = await applyPendingThinkingBeforePrompt\(tab\)/, "server should apply queued thinking level before the next prompt");
assert.match(app, /pendingThinkingLevel[\s\S]*?next prompt/, "frontend should show queued thinking changes as applying on the next prompt");
assert.match(app, /response\.data\?\.pending[\s\S]*?will apply to the next prompt/, "frontend should announce queued side-panel thinking changes");
assert.match(app, /response\.data\?\.level[\s\S]*?Thinking level set to/, "frontend should announce effective side-panel thinking changes");
assert.match(app, /function handleNativeAppShortcut\(event\)/, "frontend should centralize native app shortcut handling");
assert.match(app, /openNativeModelSelector\(\)/, "Ctrl+L shortcut should open the native model selector");
assert.match(app, /cycleModelFromShortcut\(event\.shiftKey \? "backward" : "forward"\)/, "Ctrl+P shortcuts should cycle models forward and backward");
assert.match(app, /cycleThinkingFromShortcut\(\)/, "Shift+Tab shortcut should cycle thinking level");
assert.match(app, /setToolOutputGloballyExpanded\(!toolOutputGloballyExpanded, \{ announce: true \}\)/, "Ctrl+O shortcut should toggle global tool output expansion");
assert.match(app, /clearPromptFromShortcut\(\)/, "Ctrl+C shortcut should clear the prompt only through the guarded helper");
assert.match(app, /function restoreQueuedMessagesToComposerFromShortcut\(\)/, "Alt+Up should restore the observed queue snapshot into the composer");
assert.match(app, /event\.altKey && key === "ArrowUp"[\s\S]*?restoreQueuedMessagesToComposerFromShortcut\(\)/, "Alt+Up should be routed through native shortcut handling");
assert.match(app, /let userBashQueuesByTab = new Map\(\)/, "frontend should track per-tab user bash FIFO queues");
assert.match(app, /enqueueUserBashCommand\(parsed, \{ usesPromptInput, targetTabId \}\)/, "user bash should enqueue while an active or queued bash command exists");
assert.match(server, /function sendQueuedBashCommand\(tab, command\)/, "server should serialize user bash commands per tab");
assert.match(server, /command\.type === "bash"[\s\S]*?await sendQueuedBashCommand\(tab, command\)[\s\S]*?: await tab\.rpc\.send\(command\)/, "generic POST handling should route bash through the FIFO queue");
assert.ok(pkg.files.includes("lib/WEBUI_TUI_NATIVE_PARITY.json"), "published package should include the native parity matrix");
assert.ok(pkg.files.includes("lib"), "published package should include shared Web UI foundation modules");
assert.ok(pkg.files.includes("webui-rpc-helper.mjs"), "published package should include the Web UI RPC helper extension");

console.log("native-parity.test.mjs passed");
