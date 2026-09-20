import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [app, css, html, serviceWorker] = await Promise.all([
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
]);

const resizeStart = app.indexOf("function resizePromptInput()");
const resizeEnd = app.indexOf("\nfunction updateComposerModeButtons", resizeStart);
assert.ok(resizeStart >= 0 && resizeEnd > resizeStart, "resizePromptInput should remain inspectable");
const resizePromptInput = app.slice(resizeStart, resizeEnd);

assert.match(css, /#promptInput \{[\s\S]*--prompt-input-block-chrome: calc\(1\.8rem \+ 2px\);[\s\S]*max-height: calc\(6lh \+ var\(--prompt-input-block-chrome\)\);[\s\S]*overflow-y: auto;[\s\S]*overscroll-behavior-y: contain;/, "the prompt should show six complete lines before native vertical scrolling begins");
assert.match(resizePromptInput, /input\.style\.height = "auto";[\s\S]*borderTopWidth[\s\S]*borderBottomWidth[\s\S]*naturalHeight = input\.scrollHeight \+ borderBlock[\s\S]*isCapped \? "auto" : "hidden"/, "auto-resizing should include the textarea borders and enable vertical scrolling only after the six-line cap");
assert.doesNotMatch(resizePromptInput, /input\.style\.overflowY = "auto";/, "auto-resizing must not force a scrollbar below the six-line cap");
assert.match(html, /styles\.css\?v=154/, "the page should request the six-line prompt stylesheet revision");
assert.match(html, /app\.js\?v=184/, "the page should request the current app revision");
assert.match(serviceWorker, /const CACHE_NAME = "pi-webui-pwa-v155"/, "the PWA cache identity should advance with the prompt scroll assets");

console.log("prompt-input-vertical-scroll-static.test.mjs passed");
