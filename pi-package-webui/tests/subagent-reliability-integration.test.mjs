import { createActivityAgentsController } from "../public/activity-agents-controller.mjs";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [server, app, helper] = await Promise.all([
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8").then((value) => value.replace(/\r\n/g, "\n")),
  readFile(join(root, "public", "app.js"), "utf8").then((value) => value.replace(/\r\n/g, "\n")),
  readFile(join(root, "webui-rpc-helper.mjs"), "utf8").then((value) => value.replace(/\r\n/g, "\n")),
]);

function sourceBetween(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.ok(startIndex >= 0 && endIndex > startIndex, `expected source boundaries: ${start} -> ${end}`);
  return text.slice(startIndex, endIndex);
}

const normalizationSource = sourceBetween(
  server,
  "function normalizeWebuiSubagentText(",
  "\nfunction rememberWebuiSubagentsStatusEvent(",
);
const normalizationContext = {
  WEBUI_SUBAGENT_RUN_LIMIT: 128,
  WEBUI_SUBAGENT_AGENT_LIMIT: 256,
  WEBUI_SUBAGENT_GATE_LIMIT: 32,
  WEBUI_SUBAGENT_GATE_ATTEMPT_LIMIT: 100,
};
vm.runInNewContext(`${normalizationSource}\nthis.normalizePayload = normalizeWebuiSubagentPayload; this.filterStartup = filterStartupInactiveRows;`, normalizationContext);
const normalized = normalizationContext.normalizePayload({
  version: 1,
  available: true,
  updatedAt: 100,
  fleet: {
    version: 1,
    totalActive: 4,
    omitted: 3,
    entries: [{ key: "private-key", prompt: "private prompt", cwd: "C:/private" }],
    privatePath: "C:/private",
  },
  privatePrompt: "do not expose",
  runs: [{
    id: "fleet:opaque",
    source: "recovered",
    provisional: true,
    controllable: false,
    status: "running",
    startedAt: 10,
    prompt: "private child prompt",
    agents: [{ id: "fleet:opaque:agent", name: "Recovery scout", status: "running", model: "provider/model", thinking: "high", currentPath: "C:/private" }],
  }],
});
assert.deepEqual(JSON.parse(JSON.stringify(normalized.fleet)), { version: 1, totalActive: 4, omitted: 3 }, "server should expose only bounded fleet aggregates");
const ordinary = normalizationContext.normalizePayload({
  version: 1,
  runs: [{ id: "run-ordinary", source: "async", status: "running", agents: [{ name: "worker", status: "running" }] }],
});
assert.equal(Object.hasOwn(ordinary.runs[0], "provisional"), false, "ordinary payload v1 rows should not gain recovery-only provisional metadata");
assert.equal(Object.hasOwn(ordinary.runs[0], "controllable"), false, "ordinary payload v1 rows should not gain recovery-only control metadata");
const startupTab = {};
const firstStartupSnapshot = normalizationContext.filterStartup(startupTab, {
  runs: [
    { id: "active-before-start", status: "running" },
    { id: "done-before-start", status: "done" },
  ],
}, { rowsKey: "runs", stateKey: "fixtureStartup" });
assert.deepEqual(Array.from(firstStartupSnapshot.runs, (run) => run.id), ["active-before-start"], "the first helper snapshot should suppress pre-existing inactive runs");
const currentGenerationSnapshot = normalizationContext.filterStartup(startupTab, {
  runs: [
    { id: "done-before-start", status: "done" },
    { id: "done-after-start", status: "done" },
  ],
}, { rowsKey: "runs", stateKey: "fixtureStartup" });
assert.deepEqual(Array.from(currentGenerationSnapshot.runs, (run) => run.id), ["done-after-start"], "later terminal runs should remain visible while startup-suppressed identities stay hidden");
const reactivatedSnapshot = normalizationContext.filterStartup(startupTab, {
  runs: [{ id: "done-before-start", status: "running" }],
}, { rowsKey: "runs", stateKey: "fixtureStartup" });
assert.deepEqual(Array.from(reactivatedSnapshot.runs, (run) => run.id), ["done-before-start"], "an active transition should release startup suppression");
assert.match(server, /filterStartupInactiveRows\(tab, payload,[\s\S]*rowsKey: "instances"[\s\S]*filterStartupInactiveRows\(tab, payload,[\s\S]*rowsKey: "runs"[\s\S]*startupSuppressedAgentRunProjectionKeys\.has\(key\)[\s\S]*!agentRunIsActive\(record\.instance\)/, "helper snapshots and startup registry records should both exclude pre-existing inactive rows");
assert.deepEqual(JSON.parse(JSON.stringify(normalized.runs[0])), {
  id: "fleet:opaque",
  source: "recovered",
  provisional: true,
  controllable: false,
  mode: "single",
  status: "running",
  startedAt: 10,
  agents: [{
    id: "fleet:opaque:agent",
    name: "Recovery scout",
    status: "running",
    index: 0,
    model: "provider/model",
    thinking: "high",
    nested: false,
  }],
}, "server should preserve public recovery flags without leaking prompt, path, or raw fleet-entry fields");
assert.equal(normalizationContext.normalizePayload({ version: 1, fleet: { version: 1, totalActive: 1, omitted: 2 }, runs: [] }).fleet, null, "invalid aggregate counts should be discarded");

const canonicalProjectionSource = sourceBetween(
  helper,
  "function canonicalInstancesFromPublicRun(",
  "\n  /**\n   * Canonical, deduplicated projection",
);
assert.match(canonicalProjectionSource, /Number\.isFinite\(run\.endedAt\) \? run\.endedAt : startedAt/, "a terminal run without endedAt should use one stable fallback timestamp");
assert.doesNotMatch(canonicalProjectionSource, /endedAt[^\n]*Date\.now\(\)/, "terminal projection timestamps must not change on every status poll");
assert.match(canonicalProjectionSource, /open: true,[\s\S]*refresh: true,[\s\S]*cancel: status === "running" && !workflow && !recovered[\s\S]*outputRef: \{ kind: "helper"/, "recovered fleet rows should expose a read-only helper output view while lifecycle control remains blocked");
assert.match(server, /unavailable: rawAgent\.unavailable === true[\s\S]*unavailableReason: rawAgent\.unavailable === true/, "server normalization should preserve truthful recovered-output unavailability metadata");

const interactionSource = sourceBetween(
  server,
  "function webuiSubagentRunSupportsInteraction(",
  "\nfunction restorableTabDescriptor(",
);
assert.match(interactionSource, /source !== "recovered"[\s\S]*provisional !== true[\s\S]*controllable !== false/, "server should treat every unsupported recovery signal as non-interactive");
assert.match(interactionSource, /requireInteractiveWebuiSubagentRun[\s\S]*!webuiSubagentRunSupportsInteraction\(run\)[\s\S]*webuiSubagentOutputData[\s\S]*requireInteractiveWebuiSubagentRun/, "output lookup should reject unsupported rows before helper dispatch");
assert.match(server, /\/api\/subagents\/cancel[\s\S]*rejectUnsupportedWebuiSubagentRun\(tab, body\.runId\)[\s\S]*\/api\/subagents\/dismiss[\s\S]*rejectUnsupportedWebuiSubagentRun\(tab, body\.runId\)/, "cancel and dismiss routes should reject unsupported recovered rows before helper dispatch");

const renderAgentSource = sourceBetween(app, "function renderSubagentAgent(", "\nfunction renderSubagentRun(");
assert.match(renderAgentSource, /make\(interactive \? "button" : "div"[\s\S]*metadata-only[\s\S]*if \(interactive\)[\s\S]*openSubagentOutput[\s\S]*output is unavailable from this provider/, "unsupported rows should use truthful non-button rendering with no output affordance");
const materializationSource = sourceBetween(app, "function materializeRetainedSubagentTerminalViews(", "\nfunction subagentTerminalViewGroups(");
assert.match(materializationSource, /subagentAgentStatus\(run\)[\s\S]*ensureSubagentTerminalView/, "only terminal open-capable rows should materialize retained terminal views");
assert.match(app, /function subagentRunCanCancel[\s\S]*capabilities\.cancel === true/, "canonical capability ownership should gate cancellation");
assert.match(app, /function subagentRunIsTerminal[\s\S]*\["done", "failed", "cancelled"\]/, "clear-finished should select only explicit terminal lifecycle states");
assert.match(app, /function subagentRunIsAttachedProjection[\s\S]*source === "explicit-attach"[\s\S]*\["stale", "lost"\]/, "stale explicit attached sessions should be manually detachable");
assert.match(app, /function subagentRunCanDismiss[\s\S]*subagentRunIsAttachedProjection\(run\)[\s\S]*provider === "webui-registry"/, "terminal registry projections and explicit attaches should expose the appropriate manual dismissal control");
assert.match(app, /function finishedSubagentRunSelections[\s\S]*subagentRunIsTerminal\(run\) && subagentRunCanDismiss\(run\)/, "auto-clear should remain limited to genuinely terminal rows");
assert.match(server, /function agentRunProjectionCanBeDismissed[\s\S]*origin === "explicit-attach"[\s\S]*dismissedAgentRunProjectionKeys\.has\(key\)[\s\S]*agentRunProjectionCanBeDismissed\(record\.instance\)[\s\S]*selection\.kind === "registry"[\s\S]*registrySelections[\s\S]*dismissAgentRunProjection\(candidate\.instance\)/, "registry dismissal should retain bounded tombstones only for terminal or explicit-attach WebUI projections");
const viewSyncSource = sourceBetween(app, "function syncSubagentTerminalViewsFromOverview(", "\nfunction materializeRetainedSubagentTerminalViews(");
assert.match(viewSyncSource, /run && !subagentRunCanOpen\(run,[\s\S]*subagentTerminalViews\.delete/, "a row that loses open capability should close an existing terminal output view");
assert.match(viewSyncSource, /run && !subagentRunCanOpen\(run,[\s\S]*subagentOverlaySelection = null/, "a row that loses open capability should close an existing output overlay");
assert.match(app, /async function openSubagentOverlay\(tab, run, agent\)[\s\S]*!subagentRunCanOpen\(run, agent\)/, "direct overlay entry should reject unsupported rows");
assert.match(app, /function subagentGateAttemptTarget\(tab, attempt\)[\s\S]*subagentRunCanOpen\(run, agent\)/, "retry-gate output entry should reject unsupported rows");

const refreshSource = sourceBetween(app, "function refreshSubagents(", "\nfunction scheduleRefreshSubagents(");
let resolveFirst;
let resolveSecond;
let apiCalls = 0;
const firstResponse = new Promise((resolve) => { resolveFirst = resolve; });
const secondResponse = new Promise((resolve) => { resolveSecond = resolve; });
const overviewOwner = createActivityAgentsController({
  getVisibility: () => "visible", getAutoClear: () => false, finishedSelections: () => [],
  canCancel: () => false, canDismiss: () => false, isAttachedProjection: () => false, agentCount: () => 0,
  api() { apiCalls += 1; return apiCalls === 1 ? firstResponse : secondResponse; },
});
const refreshContext = { activityAgents: overviewOwner };
vm.runInNewContext(`${refreshSource}\nthis.runRefreshSubagents = refreshSubagents;`, refreshContext);
const initialRefresh = refreshContext.runRefreshSubagents();
const overlappingRefresh = refreshContext.runRefreshSubagents();
assert.equal(apiCalls, 1, "an overlapping refresh should coalesce while the first request is in flight");
resolveFirst({ data: { revision: "stale" } });
await new Promise((resolve) => setImmediate(resolve));
assert.equal(apiCalls, 2, "an overlapping request should guarantee one trailing authoritative refresh");
resolveSecond({ data: { revision: "authoritative" } });
await Promise.all([initialRefresh, overlappingRefresh]);
assert.equal(overviewOwner.getSnapshot().data?.revision, "authoritative", "the trailing refresh should own final browser state");
assert.equal(overviewOwner.getSnapshot().loading, false, "coalesced refresh should release its loading guard");
await refreshContext.runRefreshSubagents();
assert.equal(apiCalls, 3, "settled refresh should release its shared promise for new work");
overviewOwner.dispose();

console.log("subagent-reliability-integration.test.mjs passed");
