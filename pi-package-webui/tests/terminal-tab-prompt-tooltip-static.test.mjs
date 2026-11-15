import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = await readFile(join(root, "public", "app.js"), "utf8");

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

const promptSource = appFunctionSource("terminalTabPromptTooltip", "terminalTabGroupRepresentedTab");
const representedTabSource = appFunctionSource("terminalTabGroupRepresentedTab", "terminalTabTooltip");
const tabTooltipSource = appFunctionSource("terminalTabTooltip", "terminalTabGroupStatusTooltip");
const threadDisplayTitleSource = appFunctionSource("threadDisplayTitle", "tabIndicator");
const groupTooltipSource = appFunctionSource("terminalTabGroupTooltip", "appendTerminalTabContent");
const regularRendererSource = appFunctionSource("renderTerminalTab", "renderTerminalTabGroupItem");
const groupedItemRendererSource = appFunctionSource("renderTerminalTabGroupItem", "shouldRenderTerminalTabGroup");
const collapsedGroupRendererSource = appFunctionSource("renderTerminalTabGroup", "updateTerminalTabGroupOpenState");
const stripAnsiSource = appFunctionToMarker("stripAnsi", "\n\nconst ANSI_16_COLORS");
const cleanTooltipSource = appFunctionToMarker("cleanTooltipText", "\n\nconst TOOLTIP_HOVER_DELAY_MS");
const applyStyledTooltipSource = appFunctionSource("applyStyledTooltip", "applyFooterTooltip");

const promptResults = vm.runInNewContext(`
  ${promptSource}
  const exactBound = "/" + "a".repeat(4095);
  ({
    positive: terminalTabPromptTooltip({ prompt: { kind: "append-system", path: "/home/user/.pi/agent/minimal/APPEND_SYSTEM.md" } }),
    textOnly: terminalTabPromptTooltip({ prompt: { kind: "append-system", path: "/tmp/<prompt>&.md" } }),
    exactBound: terminalTabPromptTooltip({ prompt: { kind: "append-system", path: exactBound } }),
    nullPrompt: terminalTabPromptTooltip({ prompt: null }),
    missingPrompt: terminalTabPromptTooltip({}),
    wrongKind: terminalTabPromptTooltip({ prompt: { kind: "system", path: "/tmp/APPEND_SYSTEM.md" } }),
    relativePath: terminalTabPromptTooltip({ prompt: { kind: "append-system", path: "relative/APPEND_SYSTEM.md" } }),
    oversizedPath: terminalTabPromptTooltip({ prompt: { kind: "append-system", path: "/" + "a".repeat(4096) } }),
    multilinePath: terminalTabPromptTooltip({ prompt: { kind: "append-system", path: "/tmp/prompt\\ncontent" } }),
    extraField: terminalTabPromptTooltip({ prompt: { kind: "append-system", path: "/tmp/APPEND_SYSTEM.md", content: "secret" } }),
    commandOnly: terminalTabPromptTooltip({ command: "pi --append-system-prompt /tmp/APPEND_SYSTEM.md" }),
  });
`);

assert.equal(promptResults.positive, "Append-system prompt: /home/user/.pi/agent/minimal/APPEND_SYSTEM.md", "a valid tab-local descriptor should produce the exact approved label");
assert.equal(promptResults.textOnly, "Append-system prompt: /tmp/<prompt>&.md", "the helper should return text without interpreting markup-like path characters");
assert.equal(promptResults.exactBound.length, "Append-system prompt: ".length + 4096, "the server's 4,096-character path boundary should remain usable");
for (const [name, result] of Object.entries(promptResults).filter(([name]) => !["positive", "textOnly", "exactBound"].includes(name))) {
  assert.equal(result, "", `${name} must not add an append-system tooltip line`);
}

const tooltipResults = vm.runInNewContext(`
  ${promptSource}
  ${threadDisplayTitleSource}
  ${representedTabSource}
  ${tabTooltipSource}
  ${groupTooltipSource}
  const activeTabId = "tab-active";
  const defaultTab = { id: "tab-default", title: "Default", running: true, cwd: "/workspace/default", prompt: null };
  const activeTab = { id: "tab-active", title: "Active", running: true, cwd: "/workspace/active", prompt: { kind: "append-system", path: "/visible/active/APPEND_SYSTEM.md" } };
  const inactiveTab = { id: "tab-inactive", title: "Inactive", running: true, cwd: "/workspace/inactive", prompt: { kind: "append-system", path: "/visible/inactive/APPEND_SYSTEM.md" } };
  ({
    regular: terminalTabTooltip(activeTab),
    defaultTab: terminalTabTooltip(defaultTab),
    group: terminalTabGroupTooltip({ custom: true, tabs: [inactiveTab, activeTab] }, "Prompt group"),
  });
`, {
  normalizeDisplayPath: (value) => String(value || ""),
  tabIndicator: () => ({ label: "Idle", state: "idle" }),
  terminalTabGitTooltip: () => "",
  terminalTabActiveTooltip: () => "",
  terminalDisplayGroupTitle: () => "Group",
  terminalTabGroupWorkspaceTooltip: () => "Working folder: /workspace",
  terminalTabGroupStatusTooltip: () => "2 idle",
  terminalTabGroupActiveTooltip: () => "",
  isMobileView: () => false,
});

assert.match(tooltipResults.regular, /Working folder: \/workspace\/active\nAppend-system prompt: \/visible\/active\/APPEND_SYSTEM\.md\nClick to switch/, "regular tooltips should preserve working-folder and action lines around the new prompt line");
assert.doesNotMatch(tooltipResults.defaultTab, /Append-system prompt:/, "default tabs should keep their existing tooltip lines unchanged");
assert.match(tooltipResults.group, /Append-system prompt: \/visible\/active\/APPEND_SYSTEM\.md/, "a collapsed group should show its active represented tab's descriptor");
assert.doesNotMatch(tooltipResults.group, /\/visible\/inactive\/APPEND_SYSTEM\.md/, "a collapsed group must not borrow another group member's descriptor");

const styledTooltipResults = vm.runInNewContext(`
  ${promptSource}
  ${stripAnsiSource}
  ${cleanTooltipSource}
  let styledTooltipDescriptionSerial = 0;
  ${applyStyledTooltipSource}
  function tooltipNode() {
    const attributes = new Map();
    return {
      attributes,
      children: [],
      dataset: {},
      id: "",
      append(child) { this.children.push(child); },
      getAttribute(name) { return attributes.get(name) || null; },
      removeAttribute(name) { attributes.delete(name); },
      setAttribute(name, value) { attributes.set(name, String(value)); },
    };
  }
  const promptTooltip = terminalTabPromptTooltip({ prompt: { kind: "append-system", path: "/tmp/prompt  two/APPEND_SYSTEM.md" } });
  const promptNode = tooltipNode();
  applyStyledTooltip(promptNode, promptTooltip, { ariaLabel: false, description: true, preserveInternalSpaces: true });
  const ordinaryNode = tooltipNode();
  applyStyledTooltip(ordinaryNode, "Ordinary   repeated\\twhitespace", { ariaLabel: true });
  ({
    promptTooltip,
    promptData: promptNode.getAttribute("data-tooltip"),
    promptDescribedBy: promptNode.getAttribute("aria-describedby"),
    promptDescriptionId: promptNode.children[0]?.id,
    promptDescriptionText: promptNode.children[0]?.textContent,
    preservedCleanup: cleanTooltipText("\\u001b[31m  Keep  spaces\\r\\n\\n\\nTail\\tlabel  \\u001b[0m", { preserveInternalSpaces: true }),
    ordinaryData: ordinaryNode.getAttribute("data-tooltip"),
    ordinaryAriaLabel: ordinaryNode.getAttribute("aria-label"),
  });
`, {
  bindStyledTooltipEvents: () => {},
  make: (_tag, className, text) => ({ className, id: "", textContent: text || "" }),
});

const consecutiveSpaceTooltip = "Append-system prompt: /tmp/prompt  two/APPEND_SYSTEM.md";
assert.equal(styledTooltipResults.promptTooltip, consecutiveSpaceTooltip, "the descriptor formatter must retain consecutive spaces in a valid path");
assert.equal(styledTooltipResults.promptData, consecutiveSpaceTooltip, "the styled tooltip data attribute must retain consecutive path spaces");
assert.equal(styledTooltipResults.promptDescriptionText, consecutiveSpaceTooltip, "the aria-describedby text must retain consecutive path spaces");
assert.equal(styledTooltipResults.promptDescribedBy, styledTooltipResults.promptDescriptionId, "the preserved description text must remain connected to its trigger");
assert.equal(styledTooltipResults.preservedCleanup, "Keep  spaces\n\nTail label", "space preservation must retain ANSI stripping, CR/LF normalization, newline bounds, trimming, and non-space whitespace cleanup");
assert.equal(styledTooltipResults.ordinaryData, "Ordinary repeated whitespace", "ordinary styled tooltips must keep the default repeated-whitespace collapse");
assert.equal(styledTooltipResults.ordinaryAriaLabel, "Ordinary repeated whitespace", "ordinary tooltip accessibility labels must keep the default sanitizer behavior");

assert.match(regularRendererSource, /applyStyledTooltip\(button, terminalTabTooltip\(tab\), \{[^}]*preserveInternalSpaces: true/, "regular tabs should explicitly preserve valid prompt-path spaces");
assert.match(groupedItemRendererSource, /applyStyledTooltip\(button, terminalTabTooltip\(tab\), \{[^}]*preserveInternalSpaces: true/, "grouped tab items should explicitly preserve valid prompt-path spaces");
assert.match(collapsedGroupRendererSource, /const activeGroupTab = terminalTabGroupRepresentedTab\(groupTabs\)[\s\S]*applyStyledTooltip\(button, terminalTabGroupTooltip\(group, groupTitle\), \{[^}]*preserveInternalSpaces: true/, "collapsed groups should use the same represented-tab selection and explicit space preservation for their styled tooltip");
assert.equal(app.match(/applyStyledTooltip\(button, terminalTabTooltip\(tab\)/g)?.length, 2, "regular and grouped-item call sites should continue sharing terminalTabTooltip");
assert.doesNotMatch(promptSource, /\bsettings\b|appendSystemPromptPath|\.command\b|piArgs/, "prompt display must not infer state from global settings or tab commands");
assert.doesNotMatch(`${promptSource}\n${tabTooltipSource}\n${groupTooltipSource}`, /\bfetch\s*\(|nativeCommandApi|XMLHttpRequest|FileReader|\/api\/.*file/i, "tooltip rendering must not load prompt files or contents");
assert.doesNotMatch(`${regularRendererSource}\n${groupedItemRendererSource}\n${collapsedGroupRendererSource}`, /\.innerHTML\s*=/, "tab tooltip call sites should retain attribute/text-only rendering");

console.log("terminal tab prompt tooltip static tests passed");
