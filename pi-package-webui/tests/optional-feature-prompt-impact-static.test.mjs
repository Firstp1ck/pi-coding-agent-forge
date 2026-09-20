import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [app, css, html, serviceWorker, readme, technical, development] = await Promise.all([
  readFile(new URL("../public/app.js", import.meta.url), "utf8"),
  readFile(new URL("../public/styles.css", import.meta.url), "utf8"),
  readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  readFile(new URL("../public/service-worker.js", import.meta.url), "utf8"),
  readFile(new URL("../README.md", import.meta.url), "utf8"),
  readFile(new URL("../TECHNICAL.md", import.meta.url), "utf8"),
  readFile(new URL("../DEVELOPMENT.md", import.meta.url), "utf8"),
]);

const expectedImpact = new Map([
  ["bangCommandAutocomplete", "none"],
  ["fishUserBash", "none"],
  ["btwCommand", "none"],
  ["gitWorkflow", "none"],
  ["releaseNpm", "none"],
  ["releaseAur", "initial"],
  ["aurReview", "none"],
  ["workflows", "initial"],
  ["featureSystemPrompt", "conditional"],
  ["safetyGuard", "none"],
  ["tuiSkillsCommand", "none"],
  ["todoProgressWidget", "initial"],
  ["tuiToolsCommand", "none"],
  ["remoteWebui", "none"],
  ["questionnaire", "initial"],
  ["naturalConversation", "conditional"],
  ["gitFooterStatus", "none"],
  ["statsCommand", "none"],
  ["codexFastMode", "none"],
  ["themeBundle", "none"],
]);

function optionalFeatureBlock(featureId) {
  const match = app.match(new RegExp(`\\{\\n\\s+id: "${featureId}",[\\s\\S]*?\\n\\s+\\},`));
  assert.ok(match, `optional feature ${featureId} should remain declared`);
  return match[0];
}

for (const [featureId, impact] of expectedImpact) {
  assert.match(optionalFeatureBlock(featureId), new RegExp(`promptImpact: "${impact}"`), `${featureId} should declare ${impact} prompt impact`);
}

const catalog = app.slice(app.indexOf("const OPTIONAL_FEATURES = ["), app.indexOf("const OPTIONAL_FEATURE_PROMPT_IMPACTS"));
const declaredImpacts = [...catalog.matchAll(/promptImpact: "(initial|conditional|none)"/g)];
assert.equal(declaredImpacts.length, expectedImpact.size, "every optional feature should declare exactly one recognized prompt-impact class");

assert.match(app, /initial: Object\.freeze\(\{ symbol: "\+", label: "Adds to the initial system prompt" \}\)/, "+ should describe initial system-prompt text");
assert.match(app, /conditional: Object\.freeze\(\{ symbol: "\+\.\.\.", label: "Can add system-prompt text while the session is running" \}\)/, "+... should describe conditional session-time prompt text");
assert.match(app, /none: Object\.freeze\(\{ symbol: "-", label: "No additional system-prompt text measured" \}\)/, "- should describe no measured system-prompt text");
assert.doesNotMatch(app, /renderOptionalFeaturePromptImpactLegend|optional-feature-prompt-impact-legend/, "the panel should not repeat a prompt-impact legend above the feature list");
assert.match(app, /function renderOptionalFeatureRow\(feature\)[\s\S]*?System prompt impact: \$\{impact\.label\}[\s\S]*?renderOptionalFeaturePromptImpactBadge\(feature\)/, "each feature row should expose the impact in its tooltip and visible heading");
assert.match(css, /\.optional-feature-prompt-impact \{[\s\S]*?width: 2\.8rem;[\s\S]*?min-width: 2\.8rem;[\s\S]*?\.optional-feature-prompt-impact\.initial[\s\S]*?\.optional-feature-prompt-impact\.conditional[\s\S]*?\.optional-feature-prompt-impact\.none/, "all three row indicator classes should use the same fixed width");
assert.doesNotMatch(css, /optional-feature-prompt-impact-legend/, "removed legend styles should not remain in the browser bundle");
assert.match(app, /const statusTags = make\("div", "optional-feature-status-tags"\);[\s\S]*?statusTags\.append\(renderOptionalFeaturePromptImpactBadge\(feature\), make\("span", `optional-feature-pill/, "the impact and feature-status badges should share one dedicated row");
assert.match(css, /\.optional-feature-title \{[\s\S]*?flex-direction: column;[\s\S]*?\.optional-feature-status-tags \{[\s\S]*?display: inline-flex;[\s\S]*?gap: 0\.34rem;[\s\S]*?\.optional-feature-pill \{[\s\S]*?flex: 0 0 auto;/, "title width should not stretch the feature-status badge or the gap between badges");
assert.match(readme, /\+.*initial system prompt[\s\S]*?\+\.\.\..*session is running[\s\S]*?-.*no measured system-prompt text/i, "README should explain the symbols in user language");
assert.match(technical, /prompt-impact indicators[\s\S]*?tool schemas and ordinary user or tool messages are not counted/i, "technical reference should state the measurement boundary");
assert.match(development, /reports\/pi-default-system-prompt-evaluation\.md[\s\S]*?promptImpact/, "contributor guide should identify the evidence source and catalog field");
assert.match(html, /styles\.css\?v=154/, "indicator styles should advance the stylesheet revision");
assert.match(html, /app\.js\?v=184/, "indicator rendering should advance the app revision");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "browser asset changes should advance the PWA cache identity");

console.log("optional-feature-prompt-impact-static.test.mjs passed");
