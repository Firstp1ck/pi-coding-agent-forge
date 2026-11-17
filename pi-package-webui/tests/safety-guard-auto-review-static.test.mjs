import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, server] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
]);

const dialog = app.match(/async function openNativeSafetyGuardSetupDialog\(\) \{[\s\S]*?\n\}\n\nfunction gitWorkflowSetupModelKey/)?.[0] || "";
assert.ok(dialog, "Safety Guard Setup dialog should remain extractable");
assert.match(dialog, /nativeSettingToggle\("Automatic model review"[\s\S]*config\.autoReview\?\.enabled === true/, "dialog should apply the canonical disabled-by-default auto-review toggle");
assert.match(dialog, /nativeSettingSelect\("Review model"[\s\S]*nativeSettingSelect\("Review thinking"/, "dialog should expose model and thinking selectors");
assert.match(dialog, /data\.modelThinkingLevels\?\.\[selectedModelKey\]/, "thinking options should come from the server's per-model support map");
assert.match(dialog, /controls\.autoReviewModel\.select\.disabled = !models\.length[\s\S]*controls\.autoReviewThinking\.select\.disabled = !selectedAvailable/, "model and thinking selectors should remain configurable before auto-review is enabled");
assert.match(dialog, /model and thinking can still be preselected before enabling auto-review/, "disabled auto-review state should explain that model setup remains available");
assert.match(dialog, /Unavailable: no authenticated Pi models are available[\s\S]*Unavailable: select one of the authenticated models from this active thread/, "dialog should explain model-unavailable states");
assert.match(dialog, /const collectConfig = \(\) =>[\s\S]*autoReview: \{[\s\S]*enabled: controls\.autoReview\.input\.checked[\s\S]*provider:[\s\S]*modelId:[\s\S]*thinkingLevel:/, "collection should persist the canonical nested autoReview shape");
assert.match(dialog, /const applyConfig = \(value\) =>[\s\S]*controls\.autoReview\.input\.checked = value\?\.autoReview\?\.enabled === true[\s\S]*syncAutoReviewControls/, "application and reset should restore auto-review controls and availability state");
assert.match(dialog, /addNativeCommandAction\("Reset defaults"[\s\S]*applyConfig\(defaults\)/, "reset should apply canonical defaults");
assert.match(dialog, /submitted\.autoReview\.enabled && !models\.some[\s\S]*submitted\.autoReview\.enabled && !supportedLevels\.includes[\s\S]*body: \{ config: submitted \}/, "save should reject unavailable browser selections before posting the nested config");

const api = server.match(/function safetyGuardModelKey\(model\)[\s\S]*?\n\}\n\nfunction requireSubagentLaunchSlotScope/)?.[0] || "";
assert.ok(api, "Safety Guard config API helpers should remain extractable");
assert.match(api, /availableGitWorkflowModels\(tab\)/, "GET payload should discover authenticated models through the active tab convention");
assert.match(api, /modelThinkingLevels: Object\.fromEntries[\s\S]*supportedGitWorkflowThinkingLevels\(model\)/, "GET payload should reuse the existing supported-thinking convention");
assert.match(api, /mergeSafetyGuardConfig\(settingsModule\.readSafetyGuardConfig\(\), submitted\)/, "POST validation should inspect the merged canonical config");
assert.match(api, /if \(next\.autoReview\.enabled\)[\s\S]*Selected auto-review model is not currently available[\s\S]*does not support thinking level/, "POST should validate availability and thinking support only when auto-review is enabled");
assert.match(server, /url\.pathname === "\/api\/safety-guard\/config" && req\.method === "GET"[\s\S]*const tab = getRequestedTab\(req, url\)[\s\S]*safetyGuardConfigData\(tab\)/, "GET route should pass the requested active tab into model discovery");
assert.match(server, /url\.pathname === "\/api\/safety-guard\/config" && req\.method === "POST"[\s\S]*saveSafetyGuardConfigData\(tab, body\)/, "POST route should validate against the requested active tab");

console.log("safety-guard-auto-review-static.test.mjs passed");
