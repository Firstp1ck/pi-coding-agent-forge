import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "app.js"), "utf8");

function functionSource(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} should remain a standalone frontend helper`);
  return app.slice(start, end);
}

const clearSource = functionSource("clearPromptInputForRouting", "restorePromptInputAfterRoutingError");
assert.match(clearSource, /if \(!usesPromptInput\) return;/, "programmatic prompt sends should preserve the visible draft");
assert.match(clearSource, /composerStore\.setDraft\(targetTabId, ""\);[\s\S]*elements\.promptInput\.value = "";[\s\S]*resizePromptInput\(\);[\s\S]*hideCommandSuggestions\(\);/, "input-backed sends should immediately clear their tab draft, textarea, and stale suggestions");

const sendSource = functionSource("sendPrompt", "hasQueuedDialogRequest");
const clearIndex = sendSource.indexOf("clearPromptInputForRouting({ usesPromptInput, targetTabId, tabContext });");
const routingIndex = sendSource.indexOf("if (startsRun) {");
const requestIndex = sendSource.indexOf('await api("/api/prompt"');
assert.ok(clearIndex >= 0, "sendPrompt should clear the captured input-backed draft");
assert.ok(routingIndex >= 0 && clearIndex < routingIndex, "the submitted prompt should be cleared before routing progress starts");
assert.ok(requestIndex >= 0 && clearIndex < requestIndex, "the submitted prompt should be cleared before the prompt request starts");
assert.match(sendSource, /catch \(error\) \{\s+if \(!sessionContext\.isLifetimeCurrent\(lifetime\)\) \{\s+if \(throwOnError\) throw error;\s+return;\s+\}\s+if \(guidedGitPermitGranted\) guidedGitLaunchPermits\.clearTab\(targetTabId\);\s+restorePromptInputAfterRoutingError\(inputMessage,/, "only a current-session routing failure may revoke its permit and restore the sent input");

const successStart = sendSource.indexOf("applyResponseTab(response);");
const catchStart = sendSource.indexOf("} catch (error)", successStart);
assert.ok(successStart >= 0 && catchStart > successStart, "sendPrompt should keep a bounded success continuation");
assert.doesNotMatch(sendSource.slice(successStart, catchStart), /elements\.promptInput\.value = "";/, "a delayed routing response must not clear a newer draft");

console.log("prompt routing input-clear static checks passed");
