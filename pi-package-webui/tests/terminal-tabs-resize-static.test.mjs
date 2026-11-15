import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const html = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "public/styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "public/app.js"), "utf8");

test("active desktop terminal rail exposes an accessible resize separator", () => {
  assert.match(html, /id="terminalTabsResizeHandle"[^>]*role="separator"[^>]*aria-orientation="vertical"[^>]*aria-label="Resize thread sidebar width"[^>]*tabindex="0"/);
  assert.match(css, /--terminal-tabs-sidebar-width:\s*clamp\(13rem, 18vw, 19rem\)/);
  assert.match(css, /body\.terminal-tabs-left \.chat-panel \{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(13rem, var\(--terminal-tabs-sidebar-width\)\)/);
  assert.match(css, /\.terminal-tabs-resize-handle \{[\s\S]*left:\s*-0\.78rem/);
});

test("terminal rail supports bounded pointer and keyboard resizing", () => {
  assert.match(app, /function terminalTabsSidebarResizeAvailable\(\)[\s\S]*terminalTabsLayout !== "left"[\s\S]*isSidePanelOverlayView\(\)/);
  assert.match(app, /function terminalTabsSidebarMaxWidth\(\)[\s\S]*transcriptMinWidth = 320[\s\S]*panelWidth \* 0\.72/);
  assert.match(app, /function beginTerminalTabsSidebarResize\(event\)[\s\S]*setPointerCapture[\s\S]*pointermove[\s\S]*pointercancel/);
  assert.match(app, /function updateTerminalTabsSidebarResize\(event\)[\s\S]*terminal-tabs-sidebar-start[\s\S]*delta/);
  assert.match(app, /function handleTerminalTabsSidebarResizeKeydown\(event\)[\s\S]*ArrowLeft[\s\S]*ArrowRight[\s\S]*Home[\s\S]*End/);
  assert.match(app, /elements\.terminalTabsResizeHandle\?\.addEventListener\("pointerdown", beginTerminalTabsSidebarResize\);\nelements\.terminalTabsResizeHandle\?\.addEventListener\("keydown", handleTerminalTabsSidebarResizeKeydown\);/);
});

test("terminal rail width is locally cached and durably restored", () => {
  assert.match(app, /const TERMINAL_TABS_SIDEBAR_WIDTH_STORAGE_KEY = "pi-webui-terminal-tabs-sidebar-width"/);
  assert.match(app, /function persistTerminalTabsSidebarWidth\(width\)[\s\S]*localStorage\.setItem\(TERMINAL_TABS_SIDEBAR_WIDTH_STORAGE_KEY[\s\S]*markDurableUiLayoutDirty\("terminalTabs", "sidebarWidth"\)/);
  assert.match(app, /function collectDurableTerminalTabsLayout\(\)[\s\S]*sidebarWidth: readStoredTerminalTabsSidebarWidth\(\)/);
  assert.match(app, /function applyDurableTerminalTabsLayout\(value\)[\s\S]*value\.sidebarWidth[\s\S]*restoreTerminalTabsSidebarWidthPreference\(\)/);
  assert.match(app, /window\.addEventListener\("storage"[\s\S]*TERMINAL_TABS_SIDEBAR_WIDTH_STORAGE_KEY\) restoreTerminalTabsSidebarWidthPreference\(\)/);
  assert.match(app, /restoreFileViewerWidthPreference\(\);\nrestoreTerminalTabsSidebarWidthPreference\(\);/);
});
