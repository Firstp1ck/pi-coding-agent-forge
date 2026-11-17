import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const [html, app, css, server, serviceWorker, pkg] = await Promise.all([
  readFile(join(root, "public", "index.html"), "utf8"),
  readFile(join(root, "public", "app.js"), "utf8"),
  readFile(join(root, "public", "styles.css"), "utf8"),
  readFile(join(root, "bin", "pi-webui.mjs"), "utf8"),
  readFile(join(root, "public", "service-worker.js"), "utf8"),
  readFile(join(root, "package.json"), "utf8"),
]);

assert.match(html, /<details id="subagentLaunchSlots" class="subagent-launch-slots">[\s\S]*<summary class="subagent-launch-slots-summary">[\s\S]*id="subagentLaunchSlotsTitle">Agent models<[\s\S]*id="subagentLaunchSlotRoles"[\s\S]*id="subagentsStatus"[\s\S]*id="subagentsBox"/, "launch-slot configuration should be a native collapsible surface separate from the live monitor");
assert.doesNotMatch(html, /<details id="subagentLaunchSlots"[^>]*\sopen(?:\s|>)/, "Agent models should start collapsed to keep the Subagents panel compact");
assert.match(html, /id="subagentLaunchSlotScope"[^>]*aria-describedby="subagentLaunchSlotScopeStatus"/, "scope selection should use stable accessible help");
assert.match(html, /id="subagentLaunchSlotsSave"[^>]*aria-describedby="subagentLaunchSlotsDirty"[^>]*disabled[\s\S]*id="subagentLaunchSlotsDirty"[^>]*role="status"[^>]*aria-live="polite"/, "save availability explanations should be visible and associated with the disabled control");
assert.match(html, /id="subagentLaunchSlotsAnnouncer"[^>]*aria-live="polite"[^>]*aria-atomic="true"/, "slot changes should be announced accessibly");
assert.match(app, /from "\.\/subagent-launch-slot-state\.mjs"/, "the browser should use the pure launch-slot state helper");
assert.match(app, /const subagentLaunchSlotReloadTabs = new Set\(\)[\s\S]*subagentLaunchSlotReloadTabs\.add\(activeTabId\)[\s\S]*subagentLaunchSlotReloadTabs\.delete\(activeTabId\)/, "reload reminders should be tracked per tab until reload");
assert.match(app, /subagentLaunchSlotsSummaryStatus\.textContent[\s\S]*"Unsaved changes"[\s\S]*"Saved · reload this thread"[\s\S]*subagentLaunchSlots\.open = true/, "the collapsed summary should surface state and reopen for errors or required reloads");
assert.match(app, /const saveState = subagentLaunchSlotSaveState\([\s\S]*subagentLaunchSlotsSave\.disabled = saveState\.disabled[\s\S]*`Unsaved changes · \$\{saveState\.reason\}`/, "save eligibility and its adjacent explanation should come from one canonical state");
assert.doesNotMatch(app, /`(?:Model|Thinking) · \$\{slotLabel\}`/, "visible field labels should stay compact while aria-labels retain slot context");
assert.doesNotMatch(app, /make\("(?:p|span)", "subagent-launch-slot-(?:meta|id)"/, "redundant assignment summaries and internal slot IDs should stay out of the compact editor");
assert.match(app, /if \(slots\.length > 1\)[\s\S]*`Slot \$\{ordinal\}`/, "slot headings should appear only when a role has multiple slots");
assert.match(app, /api\(`\/api\/subagents\/config\?\$\{query\}`/, "the editor should load configuration through the tab-scoped API");
assert.match(app, /api\("\/api\/subagents\/config", \{ method: "POST", body, scoped: false \}\)/, "the editor should save through the localhost-scoped configuration API");
assert.match(css, /\.subagent-launch-slots \{[\s\S]*container: subagent-launch-slots \/ inline-size[\s\S]*@container subagent-launch-slots \(max-width: 22rem\)[\s\S]*\.subagent-launch-slot-controls \{ grid-template-columns: minmax\(0, 1fr\); \}/, "launch-slot controls should stack only in genuinely narrow side-panel containers");
assert.match(css, /\.subagent-launch-slots-summary \{[^}]*min-height: 2\.35rem/, "the summary should retain the compact density contract");
assert.match(css, /\.subagent-launch-slot-role \{[^}]*padding: 0\.34rem/, "role surfaces should retain the compact density contract");
assert.match(css, /\.subagent-launch-slot-controls \{[\s\S]*grid-column: 1 \/ -1[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/, "model and thinking controls should remain paired where side-panel space permits");
assert.match(css, /\.sr-only \{[\s\S]*clip-path: inset\(50%\)[\s\S]*white-space: nowrap/, "screen-reader announcements should stay visually hidden without leaving the accessibility tree");
assert.match(css, /\.subagent-launch-slot-remove \{[^}]*color: var\(--ctp-red\)/, "destructive slot removal should have a textual control and warning color");
assert.match(server, /STATIC_PUBLIC_FILE_EXTENSIONS[\s\S]*"\.mjs"/, "the server should serve typed browser modules from the public asset boundary");
assert.match(serviceWorker, /pi-webui-pwa-v\d+[\s\S]*"\/subagent-launch-slot-state\.mjs"/, "the refreshed PWA cache should include the browser module");
assert.match(pkg, /node --check public\/subagent-launch-slot-state\.mjs/, "package checks should syntax-check the browser state module");

console.log("subagent-launch-slots-static.test.mjs passed");
