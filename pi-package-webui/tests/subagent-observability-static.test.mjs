import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, html, css, worker] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

assert.match(app, /function subagentOverviewGroups[\s\S]*Number\(data\?\.version\) === 2[\s\S]*Array\.isArray\(data\?\.groups\)[\s\S]*Array\.isArray\(data\?\.tabs\)/, "browser should prefer v2 groups while retaining a v1 tabs fallback");
for (const label of ["SDK", "Pi RPC", "Pi JSON", "Pi print", "Pi session", "tmux", "pi-subagents", "scheduled", "gate", "workflow", "custom"]) assert.ok(app.includes(`"${label}"`), `launcher label ${label} should be present`);
for (const state of ["queued", "running", "stale", "lost", "done", "failed", "cancelled"]) {
  assert.ok(app.includes(`"${state}"`), `lifecycle ${state} should be normalized`);
  assert.match(css, new RegExp(`\\.subagent-state-dot\\.${state}`), `lifecycle ${state} should have a distinct CSS state`);
}
assert.match(app, /function subagentRunAgentCounts[\s\S]*function renderSubagents\(\)[\s\S]*activeTabs\.reduce\(\(count, tab\) => count \+ Number\(tab\.agentCount \|\| 0\), 0\)[\s\S]*activeTabs\.reduce\(\(count, tab\) => count \+ Number\(tab\.runningAgents \|\| 0\), 0\)[\s\S]*activeTabs\.reduce\(\(count, tab\) => count \+ Number\(tab\.staleAgents \|\| 0\), 0\)/, "visible retained-inclusive agent totals should exclude count-neutral workflow controllers while preserving running and stale breakdowns");
assert.match(app, /URLSearchParams\(\{ group: selection\.groupId, run: selection\.runId, agent: selection\.agentId \}\)/, "overlay should use the unified group/run/agent output query");
assert.match(app, /URLSearchParams\(\{ group: view\.groupId, run: view\.runId, agent: view\.agentId \}\)/, "view-only tab should use the unified group/run/agent output query");
assert.match(app, /subagentRunCanRefresh[\s\S]*subagentRunCanCancel[\s\S]*subagentRunCanDismiss/, "controls should be capability-aware");
assert.match(app, /function subagentRunIsAttachedProjection[\s\S]*source === "explicit-attach"[\s\S]*function subagentRunCanDismiss[\s\S]*provider === "webui-registry"/, "terminal registry rows should clear while stale explicit attaches remain manually detachable");
assert.match(app, /function finishedSubagentRunSelections[\s\S]*subagentRunIsTerminal\(run\) && subagentRunCanDismiss\(run\)/, "Auto-Clear should not immediately remove stale attached sessions");
assert.match(app, /agent\.unavailableReason[\s\S]*Output is unavailable for this registered agent/, "output views should show truthful unavailable evidence");
assert.match(app, /const SUBAGENT_ASYNC_WIDGET_KEY = "subagent-async"[\s\S]*case "setWidget":[\s\S]*widgetKey === SUBAGENT_ASYNC_WIDGET_KEY[\s\S]*widgetLines: undefined[\s\S]*return;/, "native async-status widget updates should be discarded before reaching the generic main-output renderer");
assert.match(app, /for \(const \[key, value\] of widgets\)[\s\S]*if \(key === SUBAGENT_ASYNC_WIDGET_KEY\) continue;/, "stale cached async-status widgets should remain hidden defensively");
assert.match(css, /\.subagent-source-badge[\s\S]*text-overflow: ellipsis[\s\S]*@media \(max-width: 720px\)/, "source badges should remain compact and responsive");
assert.match(html, /Managed and registered Pi agent runs[\s\S]*External agents/, "help should explain managed, registered, and external groups");
assert.match(html, /styles\.css\?v=154[\s\S]*app\.js\?v=184/, "browser assets should use the current subagent-observability revisions");
assert.match(worker, /pi-webui-pwa-v155/, "PWA cache identity should advance with subagent widget suppression");

console.log("subagent-observability-static.test.mjs passed");
