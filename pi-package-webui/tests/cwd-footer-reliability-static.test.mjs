import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, server, supervisor] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "bin", "pi-webui-rpc-supervisor.mjs"), "utf8"),
]);

assert.match(
  app,
  /function pickCwd\(tab, initialCwd[\s\S]*?if \(pathPickerState\) \{[\s\S]*?working-directory picker is already open[\s\S]*?pathPickerSearchInput\.focus/,
  "a duplicate cwd action should focus the existing picker and explain why no second picker opened",
);
assert.match(
  app,
  /async function changeActiveTabCwd\(\)[\s\S]*?title: "Changing working folder…"[\s\S]*?The existing working folder was kept[\s\S]*?surfaceRuntimeDiagnostic\("Working folder change failed", message\)/,
  "cwd restarts should show immediate progress and transcript-visible failures with an atomicity explanation",
);
assert.match(
  app,
  /const changedTabId = response\.data\?\.tab\?\.id \|\| tab\.id;[\s\S]*?resetGitWorkflowForTab\(changedTabId\);[\s\S]*?clearGitFooterPayloadState\(changedTabId\);[\s\S]*?if \(!isCurrentTabContext\(tabContext\)\)/,
  "a cwd change that finishes after a tab switch should invalidate that tab's old footer state",
);
assert.match(
  app,
  /if \(response\.data\?\.changed !== false\) closeFileViewer\(\);\s*const nextContext = setActiveTabId\(response\.data\?\.tab\?\.id \|\| activeTabId\);\s*resetActiveTabUi\(\);/,
  "a successful cwd change should discard the old workspace viewer instead of restoring its path in the replacement workspace",
);

assert.match(
  app,
  /function gitFooterFallbackMessage\(\)[\s\S]*?payloadState\?\.phase === "waiting"[\s\S]*?payloadState\?\.phase === "failed"[\s\S]*?payloadState\?\.phase === "idle"[\s\S]*?if \(extensionDetected\) return "Loading git footer status…"/,
  "git footer fallback copy should distinguish active loading, terminal failure, cleared status, and discovery",
);
assert.match(
  app,
  /function waitForGitFooterPayloadSettlement\(tabContext, requestSerial\)[\s\S]*?gitFooterPayloadRequestSerialByTab\.get\(tabContext\.tabId\) !== requestSerial[\s\S]*?settleGitFooterPayload\(tabContext\.tabId, "failed"/,
  "no-payload settlement should be bounded and reject stale request callbacks",
);
assert.match(
  app,
  /signal: AbortSignal\.timeout\(GIT_FOOTER_PAYLOAD_REQUEST_TIMEOUT_MS\)/,
  "a hung footer refresh HTTP request should be bounded",
);
assert.match(
  app,
  /GIT_FOOTER_PAYLOAD_SETTLEMENT_TIMEOUT_MS[\s\S]*?Git footer refresh command is unavailable — reload to retry/,
  "RPC command discovery should have a bounded loading window before actionable failure",
);
assert.match(
  app,
  /const footerPayload = parseGitFooterWebuiPayloadRaw\(request\.statusText\);[\s\S]*?const validPayload = !!footerPayload;[\s\S]*?validPayload \? "ready" : "failed"/,
  "a later valid live payload should recover failed or waiting footer state",
);
assert.match(
  app,
  /new Set\(\[\.\.\.gitFooterPayloadStateByTab\.keys\(\), \.\.\.gitFooterPayloadSettlementTimersByTab\.keys\(\), \.\.\.gitFooterPayloadRefreshInFlightByTab\]\)\) clearGitFooterPayloadState\(tabId\)/,
  "feature toggles should clear footer state, timers, and in-flight markers",
);

assert.match(
  server,
  /async function updateTabCwd\(id, cwd\)[\s\S]*?cwdChangeInProgress[\s\S]*?makeHttpError\(409,[\s\S]*?performTabCwdUpdate/,
  "overlapping cwd changes should be rejected per tab",
);
assert.match(
  server,
  /function scheduleSupervisorMetadataUpdate\(tab\)[\s\S]*?if \(tab\.cwdChangeInProgress\) return;[\s\S]*?updateMetadata\(supervisedTabMetadata\(tab\)\)/,
  "stale full metadata writes should be deferred during cwd replacement",
);
assert.match(
  server,
  /async function performTabCwdUpdate\(tab, cwd\)[\s\S]*?!tab\.rpc\.supervisor\.isCurrentVersion\(\)[\s\S]*?Fully shut down Pi WebUI \(not Restart\)[\s\S]*?oldRpc\.replace\([\s\S]*?cwd: nextCwd[\s\S]*?tab\.cwd = nextCwd/,
  "the server should reject stale detached supervisors and publish tab cwd only after replacement succeeds",
);
assert.match(
  server,
  /webui_cwd_change_failed[\s\S]*?makeHttpError\(502, `Could not restart/,
  "replacement failures should produce an actionable SSE event and HTTP error",
);

assert.match(
  supervisor,
  /queueTabCommand\(tabId, operation, readOnly = false\)[\s\S]*?tab\.mutationTail = admission\.catch[\s\S]*?return admission\.then\(\(\) => response\)[\s\S]*?case "command": return this\.queueTabCommand[\s\S]*?case "write": return this\.queueTabMutation/,
  "commands should release their FIFO admission barrier before the full Pi response while writes remain serialized",
);
const dispatchBeforeQueue = supervisor.slice(supervisor.indexOf("  async perform(request) {"), supervisor.indexOf("    switch (request.type)", supervisor.indexOf("  async perform(request) {")));
assert.doesNotMatch(dispatchBeforeQueue, /\bawait\b/, "asynchronous admission must not reorder requests before they enter the tab FIFO");
assert.match(supervisor, /host\.requests\.values\(\)[\s\S]*request\.mutating && !request\.settled/, "an unpublished or queued mutation must prevent an idle update acknowledgement");
assert.doesNotMatch(
  supervisor,
  /async afterTabMutation\(/,
  "commands must not chase a continuously moving mutation tail",
);
assert.match(
  supervisor,
  /async spawnChildCandidate\(child\)[\s\S]*?return \{ processChild, cwd, startedAt[\s\S]*?commitChild\(tab/,
  "replacement children should be spawned privately before atomic publication",
);
assert.match(
  supervisor,
  /if \(tab\.child === processChild\) this\.handlePiLine[\s\S]*?text && tab\.child === processChild/,
  "retired child stdout and stderr should be generation-fenced",
);
assert.match(
  supervisor,
  /const stopFailures = stopResults\.filter[\s\S]*?shutdown blocked by live child[\s\S]*?return false/,
  "shutdown should retain ownership and state when a child cannot be stopped",
);

console.log("cwd-footer-reliability-static.test.mjs passed");
