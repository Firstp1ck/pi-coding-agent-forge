import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SUBAGENT_GATE_RETENTION_MS,
  pruneDismissedSubagentGateKeys,
  subagentGateIsTerminal,
  subagentGateKey,
  subagentGateRunIds,
  ungatedSubagentRuns,
  visibleSubagentGates,
} from "../public/subagent-gate-visibility.mjs";

const now = 100_000;
const tab = {
  tabId: "tab-a",
  gates: [
    { id: "running", status: "running", endedAt: 1 },
    { id: "fresh", status: "failed", endedAt: now - SUBAGENT_GATE_RETENTION_MS + 1 },
    { id: "expired", status: "satisfied", endedAt: now - SUBAGENT_GATE_RETENTION_MS },
    { id: "updated", status: "cancelled", updatedAt: now - 1_000 },
    { id: "untimed", status: "failed" },
  ],
};

assert.equal(SUBAGENT_GATE_RETENTION_MS, 30_000, "terminal retry gates should remain readable for 30 seconds");
assert.equal(subagentGateKey("tab-a", "gate-a"), "tab-a:gate-a");
assert.equal(subagentGateKey("", "gate-a"), "");
assert.equal(subagentGateIsTerminal({ status: "running" }), false);
assert.equal(subagentGateIsTerminal({ status: "failed" }), true);

const mixedRunsTab = {
  runs: [
    { id: "direct-run", agents: [{ name: "scout" }] },
    { id: "gate-run-1", agents: [{ name: "reviewer" }] },
    { id: "gate-run-2", agents: [{ name: "planner" }] },
  ],
  gates: [
    { attempts: [{ runId: "gate-run-1" }, { runId: " gate-run-2 " }, { runId: "" }] },
  ],
};
assert.deepEqual([...subagentGateRunIds(mixedRunsTab)], ["gate-run-1", "gate-run-2"], "retry gates should identify every spawned run they own");
assert.deepEqual(ungatedSubagentRuns(mixedRunsTab).map((run) => run.id), ["direct-run"], "retry-gated runs should be omitted while direct subagent spawns remain visible");
assert.deepEqual(ungatedSubagentRuns({ runs: mixedRunsTab.runs, gates: [] }).map((run) => run.id), ["direct-run", "gate-run-1", "gate-run-2"], "ordinary spawns should remain visible when no retry gate owns them");

assert.deepEqual(
  visibleSubagentGates(tab, new Set(), now).map((gate) => gate.id),
  ["running", "fresh", "updated", "untimed"],
  "running gates should remain visible while terminal gates should expire after the retention window",
);

assert.deepEqual(
  visibleSubagentGates(tab, new Set(["tab-a:fresh"]), now).map((gate) => gate.id),
  ["running", "updated", "untimed"],
  "manual dismissal should hide a terminal gate immediately",
);

const dismissed = new Set(["tab-a:fresh", "tab-z:gone"]);
pruneDismissedSubagentGateKeys([tab], dismissed);
assert.deepEqual([...dismissed], ["tab-a:fresh"], "dismissal state should be pruned after its gate leaves the server snapshot");

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, serviceWorker, server, pkgRaw] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
]);
const pkg = JSON.parse(pkgRaw);

assert.match(app, /from "\.\/subagent-gate-visibility\.mjs"/, "the browser should load the retry-gate visibility policy");
assert.match(app, /function subagentOverviewGroups[\s\S]*Number\(data\?\.version\) === 2[\s\S]*displayRuns: runs/, "the side panel should render canonical v2 runs without recounting gate references");
assert.match(app, /const gates = visibleSubagentGates\(tab, dismissedSubagentGateKeys, now\);[\s\S]*const displayRuns = ungatedSubagentRuns\(tab\);[\s\S]*displayRuns,/, "the v1 fallback should retain gate-owned run filtering before deriving count-neutral workflow totals");
assert.match(app, /function renderSubagentGate\(tab, gate\)[\s\S]*subagentGateIsTerminal\(gate\)[\s\S]*Hide finished retry gate[\s\S]*dismissedSubagentGateKeys\.add\(key\)[\s\S]*renderSubagents\(\)[\s\S]*event\.detail === 0[\s\S]*focusTarget\?\.focus/, "terminal gate cards should expose an accessible hide button and preserve keyboard focus after rerendering");
assert.match(app, /pruneDismissedSubagentGateKeys\(data\?\.tabs, dismissedSubagentGateKeys\)/, "polling should prune stale dismissal keys");
assert.match(css, /\.subagent-gate-actions[\s\S]*\.subagent-gate-close[\s\S]*min-width:\s*1\.45rem[\s\S]*background:\s*transparent[\s\S]*\.subagent-gate-close:hover,[\s\S]*\.subagent-gate-close:focus-visible/, "the close control should remain minimal, compact, and keyboard-visible");
assert.match(serviceWorker, /"\/subagent-gate-visibility\.mjs"/, "the PWA app shell should cache the visibility module");
assert.match(server, /STATIC_PUBLIC_FILE_EXTENSIONS[\s\S]*"\.mjs"/, "the server should serve typed visibility modules from the public asset boundary");
assert.match(pkg.scripts.check, /node --check public\/subagent-gate-visibility\.mjs/, "the package check should syntax-check the visibility module");

console.log("subagent gate visibility tests passed");
