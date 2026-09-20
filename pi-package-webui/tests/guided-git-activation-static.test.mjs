import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, state, server, html, serviceWorker, readme, technical, development, fakePi] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "guided-git-command-state.mjs"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "README.md"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
  readFile(join(root, "tests", "fixtures", "fake-pi.mjs"), "utf8"),
]);

test("Guided Git activation is intercepted before generic status rendering and bound to the envelope tab", () => {
  assert.match(app, /function handleExtensionUiRequest\(request\) \{\n  if \(handleGuidedGitActivationRequest\(request\)\) return;\n  request\.tabId \|\|= activeTabId;/u);
  assert.match(app, /function handleInactiveTabEvent\(event\) \{\n  if \(handleGuidedGitActivationRequest\(event\)\) return;/u);
  assert.match(app, /guidedGitActivationController\.consume\(request, async \(tabId, activationIsCurrent\)/u);
  assert.match(app, /startGitWorkflow\(tabId, \{ activationIsCurrent \}\)/u, "tab reset or close must invalidate an asynchronous activation start");
  assert.match(app, /api\("\/api\/git-workflow\/preferences\?includeModels=false", \{ tabId \}\)/u, "configured startup must not wait for the setup-only model catalog RPC");
  assert.match(server, /includeModels = url\.searchParams\.get\("includeModels"\) !== "false"[\s\S]*gitWorkflowPreferencesData\(tab, \{ includeModels \}\)/u, "the preferences route must expose the explicit lightweight startup read");
  assert.match(app, /openNativeGitWorkflowSetupDialog\(\{\s+tabId,\s+activationIsCurrent,\s+onSaved: \(\) => startGitWorkflow\(tabId, \{ skipSetup: true, activationIsCurrent \}\),\s+\}\)/u, "setup and its local continuation must preserve the envelope tab and the same activation owner");
  assert.match(app, /async function openNativeGitWorkflowSetupDialog\(\{ onSaved, tabId = activeTabId, activationIsCurrent = \(\) => true \} = \{\}\)[\s\S]*nativeCommandTabId = tabId[\s\S]*nativeCommandApi\("\/api\/git-workflow\/preferences", \{ tabId \}\)[\s\S]*const targetState = tabId === activeTabId \? currentState : tabStateCache\.get\(tabId\)/u, "setup still loads the full model catalog for the originating tab");
  assert.match(app, /const setupOwner = Symbol\(tabId\);[\s\S]*const setupOwnsDialog = \(\) => guidedGitSetupDialogOwner === setupOwner;[\s\S]*const handleSetupClose = \(\) => \{\s+if \(!saveInFlight\) settleSetup\("cancelled"\);[\s\S]*if \(!activationIsCurrent\(\)\) \{\s+closeOwnedSetupDialog\(\);\s+settleSetup\("stale"\);/u, "Cancel must settle ownership, stale reset\/cwd\/session owners must fail closed, and an old response must not close a replacement setup dialog");
  assert.match(app, /nativeCommandApi\("\/api\/git-workflow\/preferences", \{\s+method: "POST",\s+tabId,[\s\S]*if \(typeof onSaved === "function" && activationIsCurrent\(\)\)/u, "Save and its continuation must stay tab-bound and owner-guarded");
  assert.match(app, /function resetGitWorkflowForTab[\s\S]*guidedGitLaunchPermits\.clearTab\(tabId\);[\s\S]*guidedGitActivationController\.clearTab\(tabId\);/u, "reset, cwd change, and new-session seams must invalidate permits and activation ownership together");
  assert.doesNotMatch(state, /tabId.*JSON|cwd|repositoryPath/u, "the exact activation payload parser must not accept routing or repository data");
  assert.match(state, /Object\.keys\(value\)\.sort\(\)/u);
  assert.match(state, /request\?\.replayed === true/u);
  assert.match(state, /maxSeenPerTab = 64, maxTrackedTabs = 64/u);
});

test("all visible Guided Git entry points prefer the extension launcher without composer mutation", () => {
  assert.match(app, /async function launchGuidedGitWorkflow\(tabId = activeTabId\)[\s\S]*!guidedGitLaunchAdmitted\(tabId\)[\s\S]*guidedGitLaunchModeForTabCatalog\(commandCatalogForTab\(tabId\)[\s\S]*resolveAvailableCommandName\("git-guided-workflow", \{ tabId, rpcOnly: true \}\)[\s\S]*sendPrompt\("prompt", `\/\$\{commandName\}`, \{ targetTabId: tabId, throwOnError: true \}\)/u);
  assert.match(app, /Guided Git workflow"[\s\S]{0,180}run: \(\) => launchGuidedGitWorkflow\(\)/u, "command palette must use the launcher");
  assert.match(app, /elements\.gitWorkflowButton\.addEventListener\("click"[\s\S]{0,160}launchGuidedGitWorkflow\(\)/u, "composer and mobile-proxied button must use the launcher");
  assert.match(app, /addGitWorkflowAction\("Start another", \(\) => launchGuidedGitWorkflow\(gitWorkflowActionTabId\(\)\)/u);
  assert.match(app, /addGitWorkflowAction\("Restart", \(\) => launchGuidedGitWorkflow\(gitWorkflowActionTabId\(\)\)/u);
  assert.match(app, /const usesPromptInput = explicitMessage === undefined;/u);
  assert.match(app, /function clearPromptInputForRouting\(\{ usesPromptInput[\s\S]{0,160}if \(!usesPromptInput\) return;/u, "explicit command dispatch must preserve composer draft and attachments");
  assert.match(app, /const guidedGitExtensionLaunch = kind === "prompt"[\s\S]*guidedGitWorkflowCommandForTabCatalog\(commandCatalogForTab\(targetTabId\), originalMessage\)[\s\S]*if \(!guidedGitLaunchAdmitted\(targetTabId\)\) return;[\s\S]*guidedGitLaunchPermits\.grant\(targetTabId, guidedGitLaunchId\)/u, "typed commands must refuse before generic busy queue routing and grant one correlated origin-client permit");
  assert.match(app, /if \(promptRoutingTabs\.has\(tabId\)\) return "pending";/u, "an unresolved local prompt handoff must refuse another Guided Git launch");
  assert.match(app, /if \(guidedGitLaunchId\) bodyBase\.guidedGitLaunchId = guidedGitLaunchId;/u, "only exact guided commands add the dedicated launch field");
  assert.match(app, /const targetState = targetTabId === activeTabId \? currentState : tabStateCache\.get\(targetTabId\);\s+const targetWasStreaming = !!targetState\?\.isStreaming;/u, "prompt routing must inspect the captured target tab rather than whichever tab becomes active later");
  assert.match(app, /guidedGitLaunchBlockedReason\(guidedGitLaunchStateForTab\(tabId\), queueMessageCount\(queuedSnapshotForTab\(tabId\)\)\)/u, "busy admission must include streaming, compaction, canonical pending count, and the real tab-local queue snapshot");
});

test("native generation capabilities are extension-only and tab-local", () => {
  assert.doesNotMatch(app, /startLegacyGuidedGitWorkflowFallback|temporary prompt-only Guided Git compatibility launcher/u);
  assert.match(app, /function hasLoadedGuidedGitNativeCommand\(commandName, tabId\)[\s\S]*rpcOnly: true[\s\S]*source === "extension"/u);
  assert.match(app, /guidedGitNativeCommandsAvailable[\s\S]*\["git-staged-msg", "git-branch-name", "pr"\]\.every/u);
  assert.match(state, /function guidedGitLaunchModeForTabCatalog[\s\S]*return "extension"[\s\S]*return "fallback"[\s\S]*return "unavailable"/u);
  assert.match(state, /createGuidedGitLaunchPermitController\(\{ maxTrackedTabs = 64, permitTtlMs = 15_000 \}/u);
  assert.match(app, /claimStart: \(tabId, _payload, request, now\) => guidedGitLaunchPermits\.consume\(tabId, request\?\.guidedGitLaunchId, now\)/u, "only the browser client holding the exact envelope-correlated permit may claim activation");
  assert.match(server, /GUIDED_GIT_COMMAND_MESSAGE = .*git-guided-workflow.*\\d/u);
  assert.match(server, /authoritativeGuidedGitLaunchAdmission\(tab, \{ launchId: guidedGitLaunchId, reserve: true \}\)[\s\S]*queuedForCompaction = guidedGitLaunch \? null : maybeQueueCommandDuringCompaction/u, "the exact command must reserve authoritatively before and bypass generic compaction queueing");
  assert.match(server, /scopedGuidedGitLaunchEvent\(tab, eventForTabClients\(tab, event\)\)/u);
  assert.match(server, /return \{ \.\.\.event, guidedGitLaunchId: pending\.launchId \};/u, "browser launch correlation belongs only to the trusted transport envelope");
  assert.match(server, /GUIDED_GIT_LAUNCH_TTL_MS = 15_000/u);
  assert.match(server, /guidedGitPendingLaunch: null/u, "pending launch state is bounded to one record per tab and dies with the tab");
  assert.match(app, /hasLoadedGuidedGitNativeCommand\("git-staged-msg", tabId\)/u);
  assert.match(app, /hasLoadedGuidedGitNativeCommand\("git-branch-name", tabId\)/u);
  assert.match(app, /hasLoadedGuidedGitNativeCommand\("pr", tabId\)/u);
  assert.match(app, /Same-named prompt templates are not used/u);
  assert.doesNotMatch(`${app}\n${readme}\n${technical}\n${development}`, /pi-prompts-git-pr/u);
});

test("server dispatch requires extension provenance and completes on a fresh native artifact", () => {
  assert.match(server, /async function resolveGuidedGitNativeCommand[\s\S]*candidate\?\.source === "extension"[\s\S]*Same-named prompt templates are not used/u);
  const dispatchStart = server.indexOf("async function dispatchGitWorkflowGenerationAttempt");
  const dispatchEnd = server.indexOf("\nasync function settleGitWorkflowGeneration", dispatchStart);
  assert.notEqual(dispatchStart, -1);
  assert.notEqual(dispatchEnd, -1);
  const dispatch = server.slice(dispatchStart, dispatchEnd);
  assert.match(dispatch, /record\.message = gitWorkflowGenerationPrompt\(record\.kind, record\.preferences, record\.nativeCommandName, profile\)/u);
  assert.match(server, /record\.primary = gitWorkflowGenerationProfile\(\s+preferences\.generation\.provider,\s+preferences\.generation\.modelId,\s+preferences\.generation\.thinkingLevel,/u, "generation records should retain the configured profile used by dispatch");
  assert.doesNotMatch(dispatch, /set_model|set_thinking_level|setThinkingLevelForTab/u, "guided generation must not switch or restore the parent tab model or reasoning effort");
  assert.match(server, /function guidedGitNativeCommandErrorFromEvent[\s\S]*event\?\.type !== "extension_error"[\s\S]*event\.extensionPath !== `command:\$\{commandName\}`/u);
  assert.match(server, /if \(record\.nativeCommandError\) throw record\.nativeCommandError;[\s\S]*await assertGuidedGitNativeArtifactUpdated\(tab, record\);[\s\S]*finishGitWorkflowGeneration\(tab, record, \{ successful: true \}\)/u);
  assert.match(server, /const target = path\.resolve\(base, `\$\{encodeURIComponent\(branch\)\}\.md`\)/u);
  assert.match(development, /correlated `extension_error` event as the native command's terminal failure/u);
});

test("fixture, cache revisions, and layered docs expose the migration contract", () => {
  assert.match(fakePi, /FAKE_PI_GUIDED_GIT_ACTIVATION/u);
  assert.match(fakePi, /git-guided-workflow:webui-start/u);
  assert.match(html, /styles\.css\?v=154/u);
  assert.match(html, /app\.js\?v=184/u);
  assert.match(serviceWorker, /pi-webui-pwa-v155/u);
  assert.match(serviceWorker, /"\/guided-git-command-state\.mjs"/u);
  assert.match(readme, /pi-extension-git-guided-workflow/u);
  assert.match(technical, /\/git-guided-workflow/u);
  assert.match(development, /git-guided-workflow:webui-start/u);
});
