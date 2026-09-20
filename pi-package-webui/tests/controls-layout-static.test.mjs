import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "public/index.html"), "utf8");
const css = readFileSync(join(root, "public/styles.css"), "utf8");
const app = readFileSync(join(root, "public/app.js"), "utf8");
const serviceWorker = readFileSync(join(root, "public/service-worker.js"), "utf8");

assert.equal((html.match(/class="control-row(?:\s[^"]*)?"/g) || []).length, 14, "Controls should render one two-column row per setting, including optional remote-access settings");
assert.match(css, /\.control-row \{[\s\S]*grid-template-columns:\s*minmax\(6\.2rem, 0\.44fr\) minmax\(0, 1fr\)/, "Controls settings should use stable name and parameter columns");
assert.equal((html.match(/class="control-row-label"[^>]*data-tooltip=/g) || []).length, 14, "Every Controls setting name should provide user-friendly help");
assert.match(app, /function initializeControlSettingTooltips\(\)[\s\S]*#sidePanelSectionControls \.control-row-label\[data-tooltip\][\s\S]*bindStyledTooltipEvents\(label\)[\s\S]*showFooterTooltip\(label\)/, "Controls help should use the viewport-safe floating tooltip for hover and keyboard access");
assert.match(html, /class="control-row remote-auth-control-row" hidden[\s\S]*id="remoteAuthToggle"/, "optional PIN protection should retain its guarded visibility");
assert.match(app, /remoteAuthToggle\?\.closest\("\.remote-auth-control-row"\)[\s\S]*remoteAuthRow\.hidden = false/, "loading remote status should reveal the optional PIN protection setting");
assert.match(html, /styles\.css\?v=154/, "Controls stylesheet changes should advance the cache query");
assert.match(html, /app\.js\?v=184/, "Controls tooltip wiring should advance the app cache query");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "Controls browser assets should advance the PWA cache identity");

console.log("controls-layout-static.test.mjs passed");
