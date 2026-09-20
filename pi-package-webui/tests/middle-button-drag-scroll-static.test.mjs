import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, html, serviceWorker, packageJson] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
]);

assert.match(app, /import \{ installMiddleButtonDragScroll \} from "\.\/middle-button-drag-scroll\.mjs";/, "the app should load the delegated drag-scroll controller");
assert.match(app, /installMiddleButtonDragScroll\(\{[\s\S]*onDirection: \(\{ target, offsetY \}\)[\s\S]*noteChatUserScrollIntent\(\{ type: "middle-drag", deltaY: offsetY \}\)/, "chat auto-scroll direction should feed the existing follow/pause intent state");
assert.match(app, /event\?\.type === "middle-drag"\) return event\.deltaY > 0;/, "moving below the press point should be recognized as intent to read later chat output");
assert.match(css, /body\.middle-button-auto-scrolling,[\s\S]*cursor: all-scroll !important;[\s\S]*user-select: none !important;/, "active automatic scrolling should expose a directional-scroll affordance and suppress accidental selection");
assert.match(html, /styles\.css\?v=154/, "changed drag-scroll styles should advance the stylesheet revision");
assert.match(html, /app\.js\?v=184/, "changed drag-scroll wiring should advance the app revision");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155";[\s\S]*"\/middle-button-drag-scroll\.mjs"/, "offline PWA installs should refresh and cache the new controller module");
assert.match(JSON.parse(packageJson).scripts.check, /node --check public\/middle-button-drag-scroll\.mjs/, "the package check should parse the startup-critical controller module");

console.log("middle-button-drag-scroll-static.test.mjs passed");
