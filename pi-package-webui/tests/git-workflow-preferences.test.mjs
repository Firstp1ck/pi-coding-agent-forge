import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as compatibility from "../lib/git-workflow-preferences.mjs";
import * as preferenceValues from "../lib/git-workflow-preference-values.mjs";
import {
  GIT_WORKFLOW_SETUP_VERSION,
  gitWorkflowPreferencesSummary,
  isGitWorkflowSetupComplete,
  supportedGitWorkflowThinkingLevels,
} from "../lib/git-workflow-preference-values.mjs";
import {
  normalizeInterfacePreferences,
  readGitWorkflowPreferences,
  readWebuiSettings,
  writeGitWorkflowPreferences,
  writeWebuiSettings,
} from "../lib/git-workflow-preferences.mjs";

for (const [name, value] of Object.entries(preferenceValues)) {
  assert.equal(compatibility[name], value, `${name} must retain its identity through the compatibility path`);
}

assert.deepEqual(supportedGitWorkflowThinkingLevels({ reasoning: false }), ["off"]);
assert.deepEqual(
  supportedGitWorkflowThinkingLevels({ reasoning: true }),
  ["off", "minimal", "low", "medium", "high"],
  "models without an explicit map should expose standard levels but not opt-in extended levels",
);
assert.deepEqual(
  supportedGitWorkflowThinkingLevels({ reasoning: true, thinkingLevelMap: { minimal: null, xhigh: null, max: "max" } }),
  ["off", "low", "medium", "high", "max"],
  "null map entries should be hidden while explicit extended levels remain available",
);
assert.deepEqual(normalizeInterfacePreferences({}), { sidePanelWidth: null });
assert.deepEqual(normalizeInterfacePreferences({ sidePanelWidth: 617.6 }), { sidePanelWidth: 618 });
assert.deepEqual(normalizeInterfacePreferences({ sidePanelWidth: 10 }), { sidePanelWidth: 320 });
assert.deepEqual(normalizeInterfacePreferences({ sidePanelWidth: 9000 }), { sidePanelWidth: 4096 });

const root = await mkdtemp(path.join(tmpdir(), "pi-webui-git-preferences-"));
const settingsFile = path.join(root, "settings.json");

try {
  const completeV1Layout = {
    version: 1,
    sidePanel: {
      sectionOrder: ["files", "controls", "git"],
      collapsedSectionIds: ["git"],
      hiddenSectionIds: ["files"],
      collapsed: true,
    },
    composerActions: {
      order: ["new", "git", "send"],
      grid: { version: 2, columns: 12, positions: { new: 0, git: 1, send: 10 } },
    },
    footerScopedModelOrder: ["fake/model"],
    terminalTabs: {
      layout: "left",
      customGroups: { version: 1, groups: [{ id: "group-1", title: "Group 1", tabIds: ["tab-a"] }] },
    },
    fileViewerWidth: 560,
  };
  await writeFile(settingsFile, `${JSON.stringify({
    version: 6,
    remoteAuthEnabled: true,
    interfacePreferences: { sidePanelWidth: 612 },
    uiLayout: completeV1Layout,
  }, null, 2)}\n`, "utf8");
  const migrated = await readWebuiSettings(settingsFile);
  assert.equal(migrated.version, 8);
  assert.equal(migrated.remoteAuthEnabled, true, "legacy Remote PIN state should survive schema migration");
  assert.equal(migrated.outputModeDefault, "normal", "legacy settings should default browser output to normal");
  assert.equal(isGitWorkflowSetupComplete(migrated.gitWorkflow), false);
  assert.equal(migrated.resourceDefaults.tools.enabledTools, null, "legacy settings should inherit Pi's normal tool defaults");
  assert.equal(migrated.resourceDefaults.skills.enabledSkills, null, "legacy settings should inherit Pi's normal skill defaults");
  assert.equal(migrated.gitWorkflow.stagingPolicy, "review");
  assert.equal(migrated.gitWorkflow.reviewProcessEnabled, true, "legacy settings should preserve the existing review-process behavior");
  assert.equal(migrated.gitWorkflow.generation.thinkingLevel, "low");
  assert.deepEqual(migrated.gitWorkflow.generation.fallback, {
    provider: "",
    modelId: "",
    thinkingLevel: "low",
  }, "legacy settings should keep fallback explicitly disabled");
  assert.equal(isGitWorkflowSetupComplete({ ...migrated.gitWorkflow, generation: { provider: "fake", modelId: "fake-model", thinkingLevel: "off" } }), true, "fallback must remain optional for setup completeness");
  assert.equal(migrated.uiLayout.version, 3);
  assert.equal(migrated.uiLayout.sidePanel.placement, "right");
  assert.deepEqual(migrated.uiLayout.sidePanel.sectionLayout, { order: ["files", "controls", "git"], leftSectionIds: [] });
  assert.deepEqual(migrated.uiLayout.sidePanel.collapsedSectionIds, ["git"]);
  assert.deepEqual(migrated.uiLayout.sidePanel.hiddenSectionIds, ["files"]);
  assert.deepEqual(migrated.uiLayout.sidePanel.collapsedPanels, { left: false, right: true });
  assert.deepEqual(migrated.uiLayout.sidePanel.panelWidths, { left: 384, right: 612 }, "legacy width must seed the migrated right width");
  await writeFile(path.join(root, "width-only.json"), `${JSON.stringify({ version: 6, interfacePreferences: { sidePanelWidth: 700 } })}\n`, "utf8");
  assert.deepEqual(
    (await readWebuiSettings(path.join(root, "width-only.json"))).uiLayout.sidePanel.panelWidths,
    { left: 384, right: 700 },
    "legacy width-only settings must seed v2 even without a v1 uiLayout envelope",
  );
  assert.deepEqual(migrated.uiLayout.composerActions, completeV1Layout.composerActions);
  assert.deepEqual(migrated.uiLayout.footerScopedModelOrder, completeV1Layout.footerScopedModelOrder);
  assert.deepEqual(migrated.uiLayout.terminalTabs, { ...completeV1Layout.terminalTabs, sidebarWidth: null });
  assert.equal(migrated.uiLayout.fileViewerWidth, 560);

  await writeFile(settingsFile, `${JSON.stringify({
    version: 6,
    remoteAuthEnabled: true,
    outputModeDefault: "unsupported",
    interfacePreferences: { sidePanelWidth: 612 },
    uiLayout: completeV1Layout,
  }, null, 2)}\n`, "utf8");
  assert.equal((await readWebuiSettings(settingsFile)).outputModeDefault, "normal", "invalid persisted output modes must fail closed to normal");

  const saved = await writeGitWorkflowPreferences({
    generation: {
      provider: "fake",
      modelId: "fake-model",
      thinkingLevel: "off",
      unavailablePolicy: "ask",
      fallback: { provider: "other", modelId: "other-model", thinkingLevel: "medium" },
    },
    commit: { language: "de", defaultVariant: "long", scope: "required" },
    stagingPolicy: "preserve",
    reviewProcessEnabled: false,
    deliveryMode: "pr-worktree",
    verificationPolicy: "none",
  }, settingsFile);
  assert.equal(saved.setupVersion, GIT_WORKFLOW_SETUP_VERSION);
  assert.equal(isGitWorkflowSetupComplete(saved), true);
  assert.equal(saved.commit.language, "de");
  assert.equal(saved.commit.defaultVariant, "long");
  assert.equal(saved.stagingPolicy, "preserve");
  assert.equal(saved.reviewProcessEnabled, false);

  await writeWebuiSettings({
    outputModeDefault: "compact-v1",
    resourceDefaults: {
      tools: { enabledTools: ["read", " write ", "read", ""] },
      skills: { enabledSkills: ["repo-explorer", "code-security"] },
    },
    interfacePreferences: { sidePanelWidth: 612 },
  }, settingsFile);

  const partiallyUpdated = await writeGitWorkflowPreferences({ deliveryMode: "current" }, settingsFile);
  assert.equal(partiallyUpdated.generation.modelId, "fake-model", "partial updates should preserve the selected model");
  assert.deepEqual(partiallyUpdated.generation.fallback, {
    provider: "other",
    modelId: "other-model",
    thinkingLevel: "medium",
  }, "unrelated partial updates should preserve the configured fallback");
  const fallbackEffortOnly = await writeGitWorkflowPreferences({ generation: { fallback: { thinkingLevel: "high" } } }, settingsFile);
  assert.deepEqual(fallbackEffortOnly.generation.fallback, {
    provider: "other",
    modelId: "other-model",
    thinkingLevel: "high",
  }, "nested fallback patches should preserve the selected fallback model");
  assert.equal(partiallyUpdated.commit.language, "de", "partial updates should preserve nested commit preferences");
  assert.equal(partiallyUpdated.deliveryMode, "current");
  assert.equal(partiallyUpdated.reviewProcessEnabled, false, "partial updates should preserve the review-process choice");

  const persisted = JSON.parse(await readFile(settingsFile, "utf8"));
  assert.equal(persisted.version, 8);
  assert.equal(persisted.uiLayout.version, 3, "the first unrelated locked write must persist the migrated v3 envelope");
  assert.deepEqual(persisted.uiLayout.sidePanel.sectionLayout, { order: ["files", "controls", "git"], leftSectionIds: [] });
  assert.deepEqual(persisted.uiLayout.composerActions, completeV1Layout.composerActions, "unchanged v1 composer fields must survive persistence");
  assert.deepEqual(persisted.uiLayout.terminalTabs, { ...completeV1Layout.terminalTabs, sidebarWidth: null }, "unchanged v1 terminal fields must survive persistence while new width state defaults safely");
  assert.equal(persisted.remoteAuthEnabled, true);
  assert.equal(persisted.outputModeDefault, "compact-v1", "output-mode default should persist beside existing Web UI settings");
  assert.equal(persisted.gitWorkflow.generation.provider, "fake");
  assert.deepEqual(persisted.gitWorkflow.generation.fallback, {
    provider: "other",
    modelId: "other-model",
    thinkingLevel: "high",
  });
  assert.deepEqual(persisted.resourceDefaults.tools.enabledTools, ["read", "write"], "global tool defaults should be normalized and deduplicated");
  assert.deepEqual(persisted.resourceDefaults.skills.enabledSkills, ["repo-explorer", "code-security"], "global skill defaults should persist beside other Web UI settings");
  assert.equal(persisted.interfacePreferences.sidePanelWidth, 612, "the user-scoped Control Deck width should persist beside other Web UI settings");
  assert.equal((await readWebuiSettings(settingsFile)).interfacePreferences.sidePanelWidth, 612);
  const summary = gitWorkflowPreferencesSummary(await readGitWorkflowPreferences(settingsFile));
  assert.match(summary, /fake\/fake-model/);
  assert.match(summary, /Fallback: other\/other-model · high/);
  assert.match(summary, /Review process: disabled/);
  if (process.platform !== "win32") assert.equal((await stat(settingsFile)).mode & 0o777, 0o600);

  console.log("git-workflow-preferences.test.mjs passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
