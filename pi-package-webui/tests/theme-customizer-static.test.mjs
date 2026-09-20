import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REQUIRED_THEME_TOKENS, THEME_TOKEN_GROUPS } from "../public/theme-contract.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, html, css, serviceWorker, pkg, technical] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
  readFile(join(root, "TECHNICAL.md"), "utf8"),
]);

assert.equal(THEME_TOKEN_GROUPS.length, 7, "customizer contract should expose seven labelled groups");
assert.equal(REQUIRED_THEME_TOKENS.length, 51, "customizer contract should expose exactly 51 required tokens");
assert.equal(new Set(REQUIRED_THEME_TOKENS).size, 51, "required customizer tokens should be unique");

assert.match(html, /id="themeCustomizeButton"[^>]*aria-haspopup="dialog"[^>]*aria-controls="themeCustomizerDialog"/, "theme controls should expose an accessible Customize dialog launcher");
assert.match(html, /<dialog id="themeCustomizerDialog"[^>]*aria-labelledby="themeCustomizerTitle"[^>]*aria-describedby="themeCustomizerDescription"/, "customizer should use a labelled native dialog");
for (const id of [
  "themeCustomizerName", "themeCustomizerScope", "themeCustomizerVisualFields", "themeCustomizerThinkingMax",
  "themeCustomizerVars", "themeCustomizerExportFields", "themeCustomizerJson", "themeCustomizerPreview",
  "themeCustomizerStatus", "themeCustomizerCancelButton", "themeCustomizerResetButton", "themeCustomizerSaveButton",
  "themeCustomizerOverwrite", "themeCustomizerOverwriteButton",
]) {
  assert.match(html, new RegExp(`id="${id}"`), `customizer should expose #${id}`);
}
assert.match(html, /<option id="themeCustomizerProjectOption" value="project">This project<\/option>[\s\S]*<option value="global">Global themes<\/option>/, "save destination should offer project and global scopes");
assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/, "customizer should expose an atomic polite validation surface");
assert.match(html, /role="alert" hidden>[\s\S]*Replace this exact target\?/, "overwrite should use a hidden-until-needed alert naming the target");

assert.match(app, /from "\.\/theme-contract\.mjs"/, "frontend should consume the shared browser-safe theme contract");
assert.match(serviceWorker, /"\/theme-contract\.mjs"/, "the PWA app shell should cache the startup-critical theme contract");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "adding the theme contract to the startup graph should advance the PWA cache identity");
assert.match(pkg, /node --check public\/theme-contract\.mjs/, "the package check should syntax-check the startup-critical theme contract");
assert.match(app, /function themeDraftFromCatalog\(theme, name = theme\?\.name\)[\s\S]*colors: cloneThemeDraft\(theme\?\.colors \|\| \{\}\)/, "catalog metadata should be projected into a schema-only editable draft");
assert.match(app, /for \(const \{ name, label \} of group\.tokens\)/, "visual controls should render from the exact shared token inventory");
assert.match(app, /row\.dataset\.themeToken = name/, "every required token should receive a stable visual row");
assert.match(app, /swatch\.type = "color"[\s\S]*value\.type = "text"/, "each visual row should pair a color picker with a raw Pi value control");
assert.match(app, /const direct = \/\^#\[0-9a-f\]\{6\}\$\/i\.test\(raw\)[\s\S]*swatch\.disabled = !direct[\s\S]*Terminal default; edit the value to replace it/, "variable and terminal-default values should not be silently flattened by the color picker");
assert.match(app, /validateTheme\(candidate, \{ allowWebuiExport: true \}\)/, "client feedback should validate through the shared contract");
assert.match(app, /Advanced JSON is invalid:[\s\S]*last valid preview remains active/, "invalid JSON should stay editable without replacing the valid preview");
assert.match(app, /acceptThemeCustomizerDraft\(candidate, \{ syncJson: false, syncControls: true \}\)/, "valid JSON should synchronize back to visual and optional controls");
assert.match(app, /elements\.themeCustomizerJson\.value = serializeTheme\(canonical/, "valid visual changes should synchronize canonical advanced JSON");
assert.match(app, /applyTheme\(canonical, \{ persist: false \}\)/, "live preview must use the non-persisting apply path");
assert.match(app, /themeColorToRgb\(value, theme\?\.vars \|\| \{\}, fallback\)/, "WebUI preview should convert integer xterm colors through the shared contract");

assert.match(app, /function restoreThemeCustomizerOpeningState\(generation\)[\s\S]*state\.generation !== generation[\s\S]*applyTheme\(state\.opening\.theme, \{ persist: false \}\)[\s\S]*setCustomBackgroundRecord\(state\.opening\.background\)[\s\S]*applyCustomBackgroundOverride\(\)/, "cancel should generation-guard restoration of theme, meta/scheme presentation, and custom background");
assert.match(app, /themeCustomizerDialog\?\.addEventListener\("cancel"[\s\S]*closeThemeCustomizer\(\{ restore: true \}\)/, "Escape should restore and close through the same cancel path");
assert.match(app, /async function switchTab\(tabId\)[\s\S]*if \(themeCustomizerState\) closeThemeCustomizer\(\{ restore: true \}\)[\s\S]*refreshThemeCatalog\(tabContext\)/, "tab switches should restore an open preview and refresh project-bound catalog metadata");
assert.doesNotMatch(app.slice(app.indexOf("function themeScopeLabel("), app.indexOf("function renderThemeSelect(")), /localStorage\.(?:setItem|removeItem)/, "customizer preview/save workflow must not mutate browser theme storage directly");

assert.match(app, /api\("\/api\/themes\/custom", \{[\s\S]*tabId: state\.tabContext\.tabId[\s\S]*scope,[\s\S]*fileName: `\$\{name\}\.json`[\s\S]*overwrite,[\s\S]*expectedMtimeMs:/, "save should bind the server-derived target to the opening active tab and explicit scope");
assert.match(app, /state\.overwrite = \{ signature: themeCustomizerDraftSignature\(state\), scope, fileName, mtimeMs: details\.mtimeMs \}/, "overwrite confirmation should bind target, draft signature, and server mtime");
assert.match(app, /invalidateThemeCustomizerOverwrite\(\);[\s\S]*Any draft, name, or destination change cancels this confirmation/, "editing should invalidate overwrite confirmation");
assert.match(app, /code === "THEME_CHANGED"[\s\S]*was not overwritten[\s\S]*fresh target-bound confirmation/, "stale overwrite should stop and require fresh confirmation");
assert.match(app, /themeCustomizerCancelButton\.disabled = !!state\?\.saving[\s\S]*themeCustomizerResetButton\.disabled = !!state\?\.saving/, "cancel and reset should be disabled while a theme save is in flight");
assert.match(app, /function closeThemeCustomizer[\s\S]*if \(state\.saving\)[\s\S]*Wait for the theme save to finish/, "closing should not imply an in-flight filesystem save was cancelled");
assert.match(app, /function setThemeCustomizerStatus[\s\S]*urgent \? "alert" : "status"[\s\S]*urgent \? "assertive" : "polite"/, "blocking customizer errors should use assertive alert semantics");
assert.match(app, /code === "THEME_EXISTS"\) showThemeCustomizerOverwrite/, "same-target conflicts should enter explicit overwrite UI");
assert.match(app, /theme\.custom[\s\S]*theme-scope-badge/, "custom search results should receive scope badges");
assert.match(app, /Saved \$\{response\.data\?\.fileName[\s\S]*run \/reload or restart[\s\S]*No Pi or browser theme setting was changed/, "save guidance should truthfully describe manual TUI reload and non-mutation");

assert.match(css, /\.theme-customizer-dialog \{[\s\S]*height: min\(92dvh, 58rem\)[\s\S]*overflow: hidden/, "desktop customizer should be viewport-bounded and internally scrollable");
assert.match(css, /\.theme-customizer-scroll \{[\s\S]*overflow-y: auto[\s\S]*overscroll-behavior: contain/, "long token controls should scroll inside the dialog");
assert.match(css, /\.theme-token-grid \{[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 25rem\), 1fr\)\)/, "token columns should collapse based on their container before labels and inputs overlap");
assert.match(css, /\.theme-token-swatch-note \{[^}]*min-width: 0[^}]*overflow-wrap: anywhere/, "token helper text should wrap inside narrow rows");
assert.match(css, /\.theme-customizer-optional-fields fieldset \{[^}]*min-width: 0/, "optional field cards should be allowed to shrink inside the dialog");
assert.match(css, /\.theme-customizer-export-fields \{[\s\S]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 12rem\), 1fr\)\)/, "export color fields should wrap before their cards overflow");
assert.match(css, /\.theme-customizer-export-fields input \{[^}]*width: 100%[^}]*min-width: 0/, "export color inputs should stay within their grid tracks");
assert.match(css, /@media \(max-width: 720px\), \(pointer: coarse\) and \(hover: none\)[\s\S]*\.theme-customizer-dialog[\s\S]*width: 100vw[\s\S]*\.theme-token-grid,[\s\S]*grid-template-columns: minmax\(0, 1fr\)/, "phone/coarse layouts should become a safe one-column full-height editor");
assert.match(css, /\.extension-dialog\.theme-customizer-dialog \{[\s\S]*inset: 0;[\s\S]*height: var\(--visual-viewport-height, 100dvh\);[\s\S]*max-height: var\(--visual-viewport-height, 100dvh\);[\s\S]*overflow: hidden;[\s\S]*border-radius: 0;/, "the later generic mobile dialog rule must not override full-height customizer geometry");
assert.match(css, /\.theme-token-swatch \{[^}]*width: 44px[^}]*height: 44px/, "visual color targets should remain at least 44px");
assert.match(css, /env\(safe-area-inset-bottom\)/, "dialog actions should honor mobile safe-area insets");

assert.match(technical, /### Custom themes[\s\S]*exact 51 required theme tokens[\s\S]*last valid preview[\s\S]*This project[\s\S]*Global themes/, "technical reference should document controls, validation, and both scopes");
assert.match(technical, /does not select the theme or mutate Pi\/browser settings[\s\S]*run `\/reload` or restart Pi/, "technical reference should document non-persistence and truthful TUI activation");

console.log("theme-customizer-static: all assertions passed");
