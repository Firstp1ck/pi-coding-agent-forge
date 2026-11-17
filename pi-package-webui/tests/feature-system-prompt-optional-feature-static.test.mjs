import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [catalog, app, development, manifest] = await Promise.all([
  readFile(new URL("../lib/optional-feature-catalog.mjs", import.meta.url), "utf8"),
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../DEVELOPMENT.md", import.meta.url), "utf8"),
  readFile(new URL("../../pi-extension-feature-system-prompt/package.json", import.meta.url), "utf8").then(JSON.parse),
]);

assert.equal(manifest.name, "@firstpick/pi-extension-feature-system-prompt");
assert.equal(manifest.version, "0.1.7");
assert.match(
  catalog,
  /\["featureSystemPrompt", "@firstpick\/pi-extension-feature-system-prompt", "\^0\.1\.3"\]/,
  "the shared server catalog should allow Pi to install and audit the feature-routing package",
);
assert.match(
  app,
  /featureSystemPrompt: false,[\s\S]*?id: "featureSystemPrompt",[\s\S]*?packageName: "@firstpick\/pi-extension-feature-system-prompt"/,
  "browser availability state and optional-feature metadata should use the same feature id and package",
);
assert.match(
  app,
  /featureIds: \["gitWorkflow", "workflows", "featureSystemPrompt", "releaseNpm", "releaseAur", "aurReview"\]/,
  "the package should appear in the Workflows & releases section",
);
assert.match(
  app,
  /function renderFeatureCategoryTag\([\s\S]*?isOptionalFeatureEnabled\("featureSystemPrompt"\)/,
  "the package-specific composer integration should honor the browser Optional Features toggle",
);
assert.match(
  app,
  /function handleFeatureDecisionOutputStatus\([\s\S]*?optionalFeatureAvailability\.featureSystemPrompt = true;[\s\S]*?function handleFeatureCategoryStatus\([\s\S]*?optionalFeatureAvailability\.featureSystemPrompt = true;/,
  "either extension-owned status should mark the package integration as detected",
);
assert.match(
  app,
  /featureId === "featureSystemPrompt"[\s\S]*?clearFeatureDecisionStateForTab/,
  "disabling the optional integration should clear replayed classifier state",
);
assert.match(
  development,
  /`@firstpick\/pi-extension-feature-system-prompt` — feature-request classification and routing/,
  "the contributor companion list should document the new package",
);

console.log("feature-system-prompt optional-feature static tests passed");
