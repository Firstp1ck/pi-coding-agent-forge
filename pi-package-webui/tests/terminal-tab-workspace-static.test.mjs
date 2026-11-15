import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "app.js"), "utf8");
const styles = await readFile(join(root, "public", "styles.css"), "utf8");

function appFunctionSource(name, nextName) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(`\nfunction ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} should remain a standalone frontend helper`);
  return app.slice(start, end);
}

function appFunctionToMarker(name, marker) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf(marker, start);
  assert.ok(start >= 0 && end > start, `${name} should remain extractable for behavioral tests`);
  return app.slice(start, end);
}

const sources = [
  appFunctionSource("threadDisplayTitle", "tabIndicator"),
  appFunctionSource("tabGroupTitle", "terminalDisplayGroupTitle"),
  appFunctionSource("normalizeGitWorkspaceInfo", "gitWorkspaceBadgeLabel"),
  appFunctionSource("terminalTabWorkspaceName", "terminalTabMeta"),
  appFunctionSource("terminalTabMeta", "terminalTabGitTooltip"),
  appFunctionSource("terminalTabGitTooltip", "terminalTabActiveTooltip"),
  appFunctionSource("terminalTabActiveTooltip", "terminalTabTooltip"),
  appFunctionSource("terminalTabTooltip", "terminalTabGroupStatusTooltip"),
  appFunctionSource("terminalTabGroupStatusTooltip", "terminalTabGroupWorkspaceTooltip"),
  appFunctionSource("terminalTabGroupWorkspaceTooltip", "terminalTabGroupActiveTooltip"),
  appFunctionSource("terminalTabGroupActiveTooltip", "terminalTabGroupTooltip"),
  appFunctionSource("terminalTabGroupTooltip", "appendTerminalTabContent"),
  appFunctionToMarker("cleanTooltipText", "\n\nconst TOOLTIP_HOVER_DELAY_MS"),
].join("\n");
const terminalTabMetaSource = appFunctionSource("terminalTabMeta", "terminalTabGitTooltip");
const renderTerminalTabGroupSource = appFunctionSource("renderTerminalTabGroup", "updateTerminalTabGroupOpenState");
const renderSubagentTerminalTabGroupSource = appFunctionSource("renderSubagentTerminalTabGroup", "openSubagentOutput");

const context = {
  normalizeDisplayPath: (value) => String(value || "").replace(/\\/g, "/"),
  cleanStatusText: (value) => String(value || "").trim(),
  stripAnsi: (value) => String(value || ""),
  tabIndicator: (tab) => ({ state: tab.running ? (tab.state || "idle") : "idle", label: tab.running ? (tab.label || "Idle") : "Stopped" }),
  tabAppRunnerRunningRun: (tab) => tab.appRunner || null,
  terminalAppRunnerLabel: (run) => `app runner: ${run.label}`,
  tabConversationMode: (tab) => tab.conversationMode || { enabled: false },
  tabConversationModeActive: (tab) => tab.conversationMode?.enabled === true,
  tabWorkflowModeActive: (tab) => tab.workflowMode === true,
  workflowRunningCountForTab: (id) => id === "tab-1" ? 2 : 0,
  terminalDisplayGroupTitle: () => "Workspace group",
  isMobileView: () => false,
};

const results = vm.runInNewContext(`
  ${sources}
  const runningTab = {
    id: "tab-1",
    title: "Tooltip work",
    running: true,
    state: "working",
    label: "Working",
    cwd: "/home/user/projects/pi-package-webui",
    gitWorkspace: { worktreePath: "/home/user/projects/pi-package-webui", branch: "feat/readable-tooltip", isMainWorktree: true },
    appRunner: { label: "npm test" },
    conversationMode: { enabled: true, uiState: "listening" },
    workflowMode: true,
  };
  const stoppedTab = { id: "tab-2", title: "Closed tab", running: false, cwd: "/tmp/other/pi-package-webui", pid: 4242, command: "secret-command", sessionFile: "/private/session.jsonl" };
  ({
    metadata: terminalTabMeta(runningTab, { meta: "working" }),
    running: cleanTooltipText(terminalTabTooltip(runningTab)),
    stopped: cleanTooltipText(terminalTabTooltip(stoppedTab)),
    group: terminalTabGroupTooltip({ custom: true, tabs: [runningTab, stoppedTab] }, "Tooltip group"),
  });
`, context);

assert.equal(results.metadata, "working · pi-package-webui · app runner · voice · workflow mode · 2 workflows", "compact tab metadata should keep workspace and live-mode context");
assert.equal(results.running.split("\n").length, 5, "a fully populated workspace tooltip should remain bounded to five lines");
assert.match(results.running, /^Tooltip work · Working\nWorking folder: \/home\/user\/projects\/pi-package-webui/m, "rendered tooltip should lead with identity/status and the full readable workspace path");
assert.match(results.running, /Git: feat\/readable-tooltip · main worktree/, "rendered tooltip should show optional branch/worktree context");
assert.match(results.running, /Active: app runner: npm test · voice: listening · workflow: 2 runs/, "rendered tooltip should summarize active workspace modes");
assert.equal((results.stopped.match(/Stopped/g) || []).length, 1, "stopped status should appear exactly once");
assert.match(results.stopped, /Working folder: \/tmp\/other\/pi-package-webui/, "same-basename workspaces should remain distinguishable by full path");
assert.doesNotMatch(`${results.running}\n${results.stopped}`, /4242|secret-command|session\.jsonl|\bpid\b/i, "tooltips should exclude diagnostic and private session details");
assert.match(results.group, /^Tooltip group · 2 threads\nWorkspaces: projects\/pi-package-webui, other\/pi-package-webui\nStatus: 1 working · 1 stopped/m, "group hover summary should distinguish same-basename workspaces and aggregate status");
assert.match(results.group, /Click to switch · Drop threads here to add$/, "group hover summary should preserve the drop-target affordance");
assert.doesNotMatch(terminalTabMetaSource, /\bpid\b/i, "compact tab metadata should not expose the process PID");
assert.equal(app.match(/applyStyledTooltip\(button, terminalTabTooltip\(tab\)/g)?.length, 2, "single and grouped-item tabs should share one tooltip formatter");
assert.match(renderTerminalTabGroupSource, /applyStyledTooltip\(button, terminalTabGroupTooltip\(group, groupTitle\), \{ ariaLabel: false, description: true, placement: "right", preserveInternalSpaces: true, variant: "workspace", targetKey: `terminal-group:\$\{group\.key\}:switch` \}\)/, "group hover disclosure should use the shared floating tooltip layer with stable semantic identity to the right of its trigger while preserving valid prompt-path spaces");
assert.doesNotMatch(renderTerminalTabGroupSource, /terminal-tab-group-summary|menu\.append\(summary\)/, "group hover disclosure should not render an in-flow summary that shifts group menu items");
assert.match(renderTerminalTabGroupSource, /dropdown: true[\s\S]*button\.addEventListener\("click", \(\) => \{[\s\S]*if \(isMobileView\(\)\)[\s\S]*toggleOpenTerminalTabGroup\(group\.key\)[\s\S]*switchTab\(activeGroupTab\.id\)/, "mobile terminal group titles should toggle their dropdown while desktop titles keep switching terminals");
assert.match(renderSubagentTerminalTabGroupSource, /dropdown: true[\s\S]*button\.addEventListener\("click", \(\) => \{[\s\S]*if \(isMobileView\(\)\)[\s\S]*toggleOpenTerminalTabGroup\(group\.key\)[\s\S]*activateSubagentTerminalView\(activeView\.id\)/, "mobile subagent group titles should toggle their dropdown while desktop titles keep switching views");
assert.equal((`${renderTerminalTabGroupSource}\n${renderSubagentTerminalTabGroupSource}`.match(/event\.pointerType === "touch"/g) || []).length, 4, "touch pointer enter and leave should not compete with explicit dropdown taps");
assert.match(renderTerminalTabGroupSource, /menu\.id = `terminalTabGroupMenu\$\{\+\+terminalTabGroupMenuSerial\}`[\s\S]*button\.setAttribute\("aria-controls", menu\.id\)/, "regular terminal dropdown buttons should own their generated group list");
assert.match(renderSubagentTerminalTabGroupSource, /menu\.id = `terminalTabGroupMenu\$\{\+\+terminalTabGroupMenuSerial\}`[\s\S]*button\.setAttribute\("aria-controls", menu\.id\)/, "subagent dropdown buttons should own their generated group list");
assert.match(styles, /\.terminal-tab-group-dropdown-indicator \{[\s\S]*display:\s*none;[\s\S]*\.terminal-tab-group-button\[aria-expanded="true"\] \.terminal-tab-group-dropdown-indicator[\s\S]*rotate\(180deg\)/, "group buttons should expose a stateful dropdown indicator");
assert.match(styles, /\.terminal-tab-group-button \{\n\s+width:\s*100%;\n\s+min-width:\s*0;[\s\S]*\.terminal-tab-group-dropdown-indicator \{ display:\s*inline-grid; \}/, "mobile terminal groups should show the dropdown indicator and retain a full-width trigger");
assert.match(styles, /\.terminal-tab-group:hover:not\(\.menu-open\) \.terminal-tab-group-menu,[\s\S]*\.terminal-tab-group:focus-within:not\(\.menu-open\) \.terminal-tab-group-menu \{\n\s+display:\s*none;/, "mobile focus and latched hover should not keep a toggled-closed group visible");
assert.match(app, /if \(surface !== elements\.terminalTabsShell \|\| !openTerminalTabGroupKey\) return false;[\s\S]*event\.stopPropagation\(\)[\s\S]*clearOpenTerminalTabGroup\(openTerminalTabGroupKey, \{ force: true \}\)[\s\S]*terminal-tab-group-button/, "Escape should close a mobile group dropdown before closing the terminal drawer");
assert.match(app, /if \(tabId === activeTabId\) \{\n\s+clearOpenTerminalTabGroup\(null, \{ force: true \}\);\n\s+setMobileTabsExpanded\(false\);/, "selecting the already-active regular group member should close the mobile group and drawer");
assert.match(app, /async function activateSubagentTerminalView\(viewId\)[\s\S]*clearOpenTerminalTabGroup\(null, \{ force: true \}\);\n\s+setMobileTabsExpanded\(false\);/, "selecting a subagent group member should close the mobile group and drawer");
assert.match(app, /lines\.push\(isMobileView\(\) \? "Tap to open group threads" : "Click to switch · Drop threads here to add"\)/, "group accessible descriptions should match mobile dropdown and desktop switch behavior");
assert.match(app, /footerTooltipNode\.setAttribute\("role", "tooltip"\)/, "the shared visual tooltip should expose tooltip semantics");
assert.match(app, /document\.addEventListener\("keydown", \(event\) => \{[\s\S]*event\.key === "Escape" && footerTooltipTarget[\s\S]*hideFooterTooltip\(footerTooltipTarget\)[\s\S]*\}, true\)/, "Escape should dismiss both hover- and focus-triggered tooltips from the document capture phase");
assert.match(app, /node\.addEventListener\("focus", \(\) => \{[\s\S]*?!node\.matches\(":focus-visible"\)[\s\S]*?showFooterTooltip\(node\)/, "touch focus should not flash styled tooltips while keyboard focus remains supported");
assert.match(app, /styled-tooltip-description[\s\S]*aria-describedby/, "detailed tab tooltip text should be available as an accessible description");
assert.match(styles, /footer-floating-tooltip\[data-variant="workspace"\][\s\S]*line-height: 1\.52/, "workspace tooltips should use the readable visual variant");
assert.doesNotMatch(styles, /terminal-tab-group-summary/, "group tooltip styling should not reserve in-flow menu space");
assert.match(app, /placement === "right"[\s\S]*left = rect\.right \+ gap;[\s\S]*top = rect\.top;/, "right-placed tooltips should overlay beside and top-align with their trigger");

console.log("terminal tab workspace static tests passed");
