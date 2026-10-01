import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [server, app, html, styles, serviceWorker, technical, development, packageRaw, lockRaw, optionalFeatureCatalog] = await Promise.all([
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
  readFile(join(root, "DEVELOPMENT.md"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
  readFile(join(root, "package-lock.json"), "utf8"),
  readFile(join(root, "lib", "optional-feature-catalog.mjs"), "utf8"),
]);
const pkg = JSON.parse(packageRaw);
const lock = JSON.parse(lockRaw);
const packageName = "@firstpick/pi-extension-codex-fast-mode";

assert.equal(pkg.optionalDependencies?.[packageName], undefined, "WebUI should keep the Fast-mode companion as a separate Pi package");
assert.equal(pkg.pi?.extensions?.includes(`node_modules/${packageName}/index.ts`), false, "WebUI should not claim the separately configured Fast-mode extension");
assert.equal(lock.packages?.[""]?.optionalDependencies?.[packageName], undefined, "lock root should not install the Fast-mode companion with WebUI core");
assert.equal(lock.packages?.[`node_modules/${packageName}`], undefined, "lockfile should not resolve the separately installed Fast-mode companion");
assert.match(optionalFeatureCatalog, /\["codexFastMode", "@firstpick\/pi-extension-codex-fast-mode", "\^0\.1\.0"\]/, "Optional Features should retain the Pi-installable Fast-mode package mapping");

assert.match(server, /const OPTIONAL_FEATURE_PACKAGES = new Map\(OPTIONAL_FEATURE_CATALOG/, "server should derive Fast-mode installation from the shared Optional Features catalog");
assert.match(server, /CODEX_FAST_MODE_STATUS_KEY = "codex-fast-mode"[\s\S]*?CODEX_FAST_MODE_COMMAND_NAME = "fast-mode"/, "server should use the extension-owned status and command contracts");
assert.match(server, /function codexFastModeStatusState\(statusText\)[\s\S]*?codexSpeedModeFromStatus\(stripAnsi\(statusText\)\)/, "server should use the tested exact status parser");
assert.match(server, /function codexFastModeSnapshot\(tab, patch = \{\}\)[\s\S]*?extensionStatusMap\(tab\)\.get\(CODEX_FAST_MODE_STATUS_KEY\)/, "server snapshots should come from remembered extension status");
assert.match(server, /async function codexFastModeFeatureData[\s\S]*?codexFastModeSnapshot\(tab\)[\s\S]*?tabHasActiveOutput\(tab\)[\s\S]*?ultrafastModelEligible:[\s\S]*?CODEX_FAST_MODE_CREDIT_NOTICE/, "GET state should be tab-scoped, extension-owned, busy-aware, model-gated, and disclose credit use");
assert.match(server, /async function waitForCodexFastModeStatus\(tab, desired\)[\s\S]*?snapshot\.statusKnown && snapshot\.mode === desired[\s\S]*?makeHttpError\(409,[\s\S]*?did not confirm/, "server should require bounded exact-mode confirmation");
assert.match(server, /async function setCodexFastMode[\s\S]*?codexSpeedModeFromIntent\(body\)[\s\S]*?feature\.busy[\s\S]*?desired === "ultrafast" && !feature\.ultrafastModelEligible[\s\S]*?type: "prompt", message: `\/\$\{feature\.commandName\} \$\{argument\}`[\s\S]*?waitForCodexFastModeStatus\(tab, desired\)/, "PUT should validate intent, reject busy or ineligible tabs, invoke the extension, and require exact confirmed state");
assert.doesNotMatch(server, /codexFastModeSnapshot\(tab, \{ enabled: desired/, "server must not infer effective Fast state from RPC success");
assert.match(server, /url\.pathname === "\/api\/codex-fast-mode" && req\.method === "GET"[\s\S]*?url\.pathname === "\/api\/codex-fast-mode" && req\.method === "PUT"/, "server should expose GET and PUT routes");

assert.match(html, /<label for="fastOutputModeSelect">Compact mode \(Experimental\)<\/label>[\s\S]*?<option value="compact-v1">Compact<\/option>/, "legacy output processing should be presented as Compact mode while retaining compact-v1");
assert.doesNotMatch(html, /<label for="fastOutputModeSelect">Fast mode/, "legacy output processing should no longer be presented as Fast mode");
assert.match(html, /data-side-panel-section="codex-usage"[\s\S]*?id="codexUsageBox"[\s\S]*?class="control-field codex-fast-mode-control"[\s\S]*?class="codex-fast-mode-row"[\s\S]*?id="codexFastModeLabel"[\s\S]*?id="codexFastModeSelect"[\s\S]*?<option value="normal">Normal<\/option>[\s\S]*?<option value="fast">Fast<\/option>[\s\S]*?<option value="ultrafast" disabled>Ultrafast<\/option>[\s\S]*?id="setCodexFastModeButton"[\s\S]*?id="codexFastModeStatus"/, "Codex Usage should render before the compact session Fast-mode row");
assert.match(styles, /\.codex-fast-mode-control \{[\s\S]*?margin-top: 0\.58rem[\s\S]*?padding: 0\.48rem 0\.55rem[\s\S]*?\.codex-fast-mode-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(6\.5rem, 8rem\) auto/, "Codex Fast mode should use a compact horizontal control surface");
assert.match(app, /function codexFastModeStatusText\(\)[\s\S]*?codexSpeedModeLabel\(codexFastModeState\.mode\)[\s\S]*?return `\$\{label\} · This tab`;/, "mode status should distinguish all three preferences concisely");

assert.match(app, /id: "codexFastMode"[\s\S]*?packageName: "@firstpick\/pi-extension-codex-fast-mode"[\s\S]*?capabilityLabel: "\/fast-mode"/, "browser Optional Features should catalog Fast mode");
assert.match(app, /OPTIONAL_FEATURE_DISABLE_PREREQUISITES = new Map\([\s\S]*?\["codexFastMode", \(\) => disableCodexFastModeIntegration\(\)\]/, "browser should register disable-off-first behavior");
assert.match(app, /if \(disabled\) \{[\s\S]*?OPTIONAL_FEATURE_DISABLE_PREREQUISITES\.get\(feature\.id\)[\s\S]*?await turnOff\(\)[\s\S]*?setOptionalFeatureDisabled\(feature\.id, disabled\)/, "Optional Features Disable should abort before hiding integration if turn-off fails");
assert.match(app, /function applyCodexFastModeStatus\(statusText\)[\s\S]*?codexSpeedModeFromStatus\(statusText\)[\s\S]*?if \(mode === null\) return false[\s\S]*?enabled: mode !== "normal"[\s\S]*?statusKnown: true/, "browser should consume only exact extension status values");
assert.match(app, /async function refreshCodexFastMode\(tabContext = activeTabContext\(\)\)[\s\S]*?api\("\/api\/codex-fast-mode", \{ tabId: tabContext\.tabId \}\)[\s\S]*?!featureEnabled && data\.available[\s\S]*?enabled: false[\s\S]*?isCurrentTabContext\(tabContext\)/, "browser status refresh should stay tab-scoped and disarm restored branches while the feature is hidden");
assert.match(app, /async function applyCodexFastMode\(\)[\s\S]*?await appConfirm\([\s\S]*?8x Standard included usage[\s\S]*?6x purchased-credit[\s\S]*?if \(!confirmed[\s\S]*?body: \{ mode \}, tabId: tabContext\.tabId/, "browser should confirm Ultrafast costs before applying explicit mode intent");
assert.match(app, /async function disableCodexFastModeIntegration\(\)[\s\S]*?tabs\.filter[\s\S]*?Promise\.all\(tabIds\.map[\s\S]*?data\.busy[\s\S]*?enabled: false[\s\S]*?codexFastModeConfirmedOff\(response\.data\)/, "browser-global Disable should preflight every live tab and require each mutation to confirm off");
assert.match(app, /refreshNaturalConversationMode\(tabContext\),[\s\S]*?refreshCodexFastMode\(tabContext\),/, "tab refreshes should reload branch-scoped Fast-mode state");
assert.match(app, /statusKey === CODEX_FAST_MODE_STATUS_KEY[\s\S]*?applyCodexFastModeStatus\(request\.statusText\)/, "extension status events should refresh the active-tab selector");

assert.match(technical, /## Normal and compact output[\s\S]*?select \*\*Compact\*\*[\s\S]*?`compact-v1`/, "technical reference should document Compact mode with the stable identifier");
assert.match(development, /### Codex subscription Fast mode[\s\S]*?service_tier: "priority"[\s\S]*?service_tier: "ultrafast"[\s\S]*?8× Standard included usage[\s\S]*?6×/, "development guide should document both tiers and cost semantics");
assert.match(technical, /Normal \/ Fast \/ Ultrafast[\s\S]*?Pro \$500/, "technical reference should document the third mode and subscription eligibility");
// Intent preserved: browser-asset changes must advance the coherent cache tuple.
assert.match(serviceWorker, /pi-webui-pwa-v156[\s\S]*?"\/codex-speed-mode\.mjs"/, "PWA should refresh and cache the shared mode helper");
assert.match(html, /data-app-src="\/app\.js\?v=185"/, "browser module URL should be cache-busted for speed-mode wiring");

console.log("codex-fast-mode-static.test.mjs passed");
