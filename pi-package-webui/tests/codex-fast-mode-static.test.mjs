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
assert.match(server, /function codexFastModeStatusState\(statusText\)[\s\S]*?text !== "on" && text !== "off"[\s\S]*?known: true, enabled: text === "on"/, "server should accept only exact published on/off states");
assert.match(server, /function codexFastModeSnapshot\(tab, patch = \{\}\)[\s\S]*?extensionStatusMap\(tab\)\.get\(CODEX_FAST_MODE_STATUS_KEY\)/, "server snapshots should come from remembered extension status");
assert.match(server, /async function codexFastModeFeatureData[\s\S]*?codexFastModeSnapshot\(tab\)[\s\S]*?tabHasActiveOutput\(tab\)[\s\S]*?CODEX_FAST_MODE_CREDIT_NOTICE/, "GET state should be tab-scoped, extension-owned, busy-aware, and disclose credit use");
assert.match(server, /async function waitForCodexFastModeStatus\(tab, desired\)[\s\S]*?snapshot\.statusKnown && snapshot\.enabled === desired[\s\S]*?makeHttpError\(409,[\s\S]*?did not confirm/, "server should require bounded authoritative status confirmation");
assert.match(server, /async function setCodexFastMode[\s\S]*?typeof body\?\.enabled !== "boolean"[\s\S]*?feature\.busy[\s\S]*?type: "prompt", message: `\/\$\{feature\.commandName\} \$\{desired \? "on" : "off"\}`[\s\S]*?waitForCodexFastModeStatus\(tab, desired\)[\s\S]*?requested: desired/, "PUT should require explicit intent, reject busy tabs, invoke the extension, and return only confirmed state");
assert.doesNotMatch(server, /codexFastModeSnapshot\(tab, \{ enabled: desired/, "server must not infer effective Fast state from RPC success");
assert.match(server, /url\.pathname === "\/api\/codex-fast-mode" && req\.method === "GET"[\s\S]*?url\.pathname === "\/api\/codex-fast-mode" && req\.method === "PUT"/, "server should expose GET and PUT routes");

assert.match(html, /<label for="fastOutputModeSelect">Compact mode \(Experimental\)<\/label>[\s\S]*?<option value="compact-v1">Compact<\/option>/, "legacy output processing should be presented as Compact mode while retaining compact-v1");
assert.doesNotMatch(html, /<label for="fastOutputModeSelect">Fast mode/, "legacy output processing should no longer be presented as Fast mode");
assert.match(html, /data-side-panel-section="codex-usage"[\s\S]*?id="codexUsageBox"[\s\S]*?class="control-field codex-fast-mode-control"[\s\S]*?class="codex-fast-mode-row"[\s\S]*?id="codexFastModeLabel"[\s\S]*?id="codexFastModeSelect"[\s\S]*?<option value="normal">Normal<\/option>[\s\S]*?<option value="fast">Fast<\/option>[\s\S]*?id="setCodexFastModeButton"[\s\S]*?id="codexFastModeStatus"/, "Codex Usage should render before the compact session Fast-mode row");
assert.match(styles, /\.codex-fast-mode-control \{[\s\S]*?margin-top: 0\.58rem[\s\S]*?padding: 0\.48rem 0\.55rem[\s\S]*?\.codex-fast-mode-row \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) minmax\(6\.5rem, 8rem\) auto/, "Codex Fast mode should use a compact horizontal control surface");
assert.match(app, /function codexFastModeStatusText\(\)[\s\S]*?return `\$\{codexFastModeState\.enabled \? "Fast" : "Normal"\} · This tab`;/, "ordinary Fast-mode status should stay concise");

assert.match(app, /id: "codexFastMode"[\s\S]*?packageName: "@firstpick\/pi-extension-codex-fast-mode"[\s\S]*?capabilityLabel: "\/fast-mode"/, "browser Optional Features should catalog Fast mode");
assert.match(app, /OPTIONAL_FEATURE_DISABLE_PREREQUISITES = new Map\([\s\S]*?\["codexFastMode", \(\) => disableCodexFastModeIntegration\(\)\]/, "browser should register disable-off-first behavior");
assert.match(app, /if \(disabled\) \{[\s\S]*?OPTIONAL_FEATURE_DISABLE_PREREQUISITES\.get\(feature\.id\)[\s\S]*?await turnOff\(\)[\s\S]*?setOptionalFeatureDisabled\(feature\.id, disabled\)/, "Optional Features Disable should abort before hiding integration if turn-off fails");
assert.match(app, /function applyCodexFastModeStatus\(statusText\)[\s\S]*?status !== "on" && status !== "off"[\s\S]*?enabled: status === "on"[\s\S]*?statusKnown: true/, "browser should consume only exact extension status values");
assert.match(app, /async function refreshCodexFastMode\(tabContext = activeTabContext\(\)\)[\s\S]*?api\("\/api\/codex-fast-mode", \{ tabId: tabContext\.tabId \}\)[\s\S]*?!featureEnabled && data\.available[\s\S]*?enabled: false[\s\S]*?isCurrentTabContext\(tabContext\)/, "browser status refresh should stay tab-scoped and disarm restored branches while the feature is hidden");
assert.match(app, /async function applyCodexFastMode\(\)[\s\S]*?body: \{ enabled \}, tabId: tabContext\.tabId[\s\S]*?1\.5x faster[\s\S]*?may spend 2x credits[\s\S]*?2\.5x/, "browser should apply explicit state and disclose conditional speed/credit multipliers");
assert.match(app, /async function disableCodexFastModeIntegration\(\)[\s\S]*?tabs\.filter[\s\S]*?Promise\.all\(tabIds\.map[\s\S]*?data\.busy[\s\S]*?enabled: false[\s\S]*?codexFastModeConfirmedOff\(response\.data\)/, "browser-global Disable should preflight every live tab and require each mutation to confirm off");
assert.match(app, /refreshNaturalConversationMode\(tabContext\),[\s\S]*?refreshCodexFastMode\(tabContext\),/, "tab refreshes should reload branch-scoped Fast-mode state");
assert.match(app, /statusKey === CODEX_FAST_MODE_STATUS_KEY[\s\S]*?applyCodexFastModeStatus\(request\.statusText\)/, "extension status events should refresh the active-tab selector");

assert.match(technical, /## Normal and compact output[\s\S]*?select \*\*Compact\*\*[\s\S]*?`compact-v1`/, "technical reference should document Compact mode with the stable identifier");
assert.match(development, /### Codex subscription Fast mode[\s\S]*?service_tier: "priority"[\s\S]*?1\.5× faster[\s\S]*?2× Standard credits[\s\S]*?2\.5×/, "development guide should document Fast-mode integration and cost semantics");
// Intent preserved: browser-asset changes must advance the coherent cache tuple.
assert.match(serviceWorker, /pi-webui-pwa-v155/, "PWA cache identity should be bumped for changed browser assets");
assert.match(html, /data-app-src="\/app\.js\?v=184"/, "browser module URL should be cache-busted for Fast-mode wiring");

console.log("codex-fast-mode-static.test.mjs passed");
