import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(testsDir, "..");
const [app, server, html, serviceWorker, readme, technical, development] = await Promise.all([
  readFile(path.join(packageDir, "public", "app.js"), "utf8"),
  readFile(path.join(packageDir, "bin", "pi-webui.mjs"), "utf8"),
  readFile(path.join(packageDir, "public", "index.html"), "utf8"),
  readFile(path.join(packageDir, "public", "service-worker.js"), "utf8"),
  readFile(path.join(packageDir, "README.md"), "utf8"),
  readFile(path.join(packageDir, "TECHNICAL.md"), "utf8"),
  readFile(path.join(packageDir, "DEVELOPMENT.md"), "utf8"),
]);

function sourceBetween(source, start, end, label) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `${label} source should be extractable`);
  return source.slice(startIndex, endIndex);
}

const setup = sourceBetween(app, "async function openNativeGitWorkflowSetupDialog", "function normalizedWorkflowPolicyList", "Guided Git setup");
assert.match(setup, /configuredFallbackKey[\s\S]*initialFallbackKey/, "setup should restore an available configured fallback");
assert.match(setup, /\{ value: "", label: "No fallback" \}/, "fallback choices should include an explicit disabled option");
assert.match(setup, /modelOptions\.filter\(\(option\) => option\.value !== primaryKey\)/, "the selected primary must be excluded from fallback choices");
assert.match(setup, /Fallback reasoning effort[\s\S]*syncFallbackThinkingLevels[\s\S]*thinkingLevelsForModel\(fallbackKey\)/, "fallback effort should follow the fallback model capabilities");
assert.match(setup, /controls\.fallbackThinking\.select\.disabled = !fallbackKey/, "fallback effort should be disabled when no fallback is selected");
assert.match(setup, /fallback:\s*\{[\s\S]*provider: selectedFallback\?\.provider \|\| ""[\s\S]*modelId: selectedFallback\?\.id \|\| ""[\s\S]*thinkingLevel:/, "saving should send the complete nested fallback contract with empty provider/model fields when disabled");
assert.match(setup, /Guided Git setup saved\. Primary:[\s\S]*Fallback:/, "save confirmation should identify primary and fallback state");

const acceptedText = sourceBetween(app, "function gitWorkflowGenerationAcceptedText", "function gitWorkflowFallbackEventMatches", "immediate fallback copy");
assert.match(acceptedText, /fallbackUsed === true[\s\S]*primaryGeneration[\s\S]*continued with the fallback/, "immediate fallback responses should explain that primary failed and fallback continued");
assert.match(app, /gitWorkflowConfiguredGenerationText\(preferences\)[\s\S]*active tab model and effort are restored/, "workflow startup should identify configured generation profiles and restoration");

const lifecycle = sourceBetween(app, "function gitWorkflowFallbackEventMatchesPendingRequest", "function formatGitCommandResult", "fallback lifecycle handler");
assert.match(lifecycle, /webui_git_workflow_generation_fallback_started/, "the browser should observe fallback start events");
assert.match(lifecycle, /webui_git_workflow_generation_fallback_failed/, "the browser should observe fallback failure events");
assert.match(lifecycle, /fallbackLifecycleKeys instanceof Set[\s\S]*keys\.has\(key\)[\s\S]*keys\.add\(key\)/, "lifecycle output should be deduplicated");
assert.match(lifecycle, /pendingFallbackLifecycleEvents[\s\S]*slice\(-4\)/, "pre-response lifecycle events should be buffered with a fixed bound");
assert.match(lifecycle, /flushPendingGitWorkflowFallbackLifecycleEvents[\s\S]*generationAccepted: true[\s\S]*flushPendingGitWorkflowFallbackLifecycleEvents\(tabId\)/, "buffered lifecycle events should flush only after response correlation");
assert.match(lifecycle, /generationId[\s\S]*workflow\.generationId/, "all lifecycle kinds should require the exact server generation ID");
assert.doesNotMatch(lifecycle, /\bapi\(|gitWorkflowRequest\(|fetch\(/, "browser lifecycle handling must never dispatch fallback or another request");
assert.match(server, /lifecycle\.events = [\s\S]*\.slice\(-2\)/, "the server should retain a bounded per-tab lifecycle replay snapshot");
assert.match(server, /replayGitWorkflowFallbackLifecycle\(tab, client\)/, "EventSource reconnect should replay Guided Git lifecycle state");
assert.match(server, /reason: boundedGitWorkflowGenerationError\("The primary Git-writing model ended with an error\."\)/, "lifecycle reason copy should be curated rather than exposing provider diagnostics");
assert.match(app, /handleGitWorkflowFallbackLifecycleEvent\(event\)\) return;[\s\S]*if \(!eventTargetsActiveTab\(event\)\)/, "tab-scoped fallback events should be handled before inactive-tab routing");
assert.match(app, /generationKind: "commit"[\s\S]*generationKind: "branch"[\s\S]*generationKind: "pr"/, "all three Guided Git generation kinds should register browser correlation state");
assert.match(app, /branch-name\$\{query\}[\s\S]*pr-description\$\{query\}/, "branch and PR artifact reads should send their exact generation IDs");

assert.match(readme, /fallback model and its own reasoning effort[\s\S]*tries the fallback once[\s\S]*stopped Pi process do not trigger fallback/i, "README should explain the optional fallback and essential limits");
assert.match(technical, /## Guided Git generation profiles[\s\S]*strict one-retry policy[\s\S]*active model and reasoning effort remain unchanged[\s\S]*dead Pi process cannot run the fallback/i, "technical reference should document configuration and operational limits");
assert.match(development, /### Fallback browser\/runtime contract[\s\S]*fallbackUsed: true[\s\S]*webui_git_workflow_generation_fallback_started[\s\S]*never sends a retry/, "development guide should preserve the response/event and browser ownership contract");

assert.match(html, /data-app-src="\/app\.js\?v=184"/, "the changed browser app should use the next query revision");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155";/, "the PWA cache identity should advance with browser behavior");

console.log("guided-git-fallback-ui-static.test.mjs passed");
