import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

let child;
let baseURL;
let tempRoot;
let output = "";

test.beforeAll(async () => {
  const port = await freePort();
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-controls-layout-"));
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
      PI_WEBUI_SETTINGS_FILE: join(tempRoot, "settings.json"),
    },
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Wait for the local server and fake Pi fixture.
    }
    await delay(100);
  }
  throw new Error(`Pi Web UI did not start:\n${output}`);
});

test.afterAll(async () => {
  child?.kill("SIGTERM");
  if (child) await new Promise((resolve) => child.once("exit", resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

async function openControls(page) {
  await page.goto(baseURL);
  await page.locator("#updateNotification").evaluate((notification) => { notification.hidden = true; notification.classList.remove("show"); });
  const sidePanel = page.locator("#sidePanel");
  if (!(await sidePanel.isVisible())) await page.locator("#sidePanelExpandButton").click();
  const toggle = page.locator('[data-side-panel-section-toggle="controls"]');
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.locator("#sidePanelSectionControls")).toBeVisible();
}

test("Controls use aligned name and parameter columns with viewport-safe tooltips", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openControls(page);

  const rows = page.locator("#sidePanelSectionControls .control-row");
  const rowLabels = [
    "Model",
    "Thinking effort",
    "Thinking output",
    "Desktop layout",
    "Compact session navigation",
    "Tab placement",
    "Control Deck placement",
    "Theme mode",
    "Theme",
    "Background",
    "Notifications",
    "Compact mode (Experimental)",
    "Connection",
    "PIN protection",
    "Network access",
    "Action",
  ];
  await expect(rows.locator(".control-row-label")).toHaveText(rowLabels);
  const visibleRows = rows.filter({ visible: true });
  const hiddenNetworkRows = new Set(["Connection", "PIN protection", "Network access"]);
  await expect(visibleRows.locator(".control-row-label")).toHaveText(rowLabels.filter((label) => !hiddenNetworkRows.has(label)));
  for (let index = 0; index < await visibleRows.count(); index += 1) {
    const columns = await visibleRows.nth(index).evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(" ").filter(Boolean));
    assert.equal(columns.length, 2, `visible setting row ${index + 1} should have two grid columns`);
  }

  const thinkingLabel = page.locator('.control-row-label:has-text("Thinking effort")');
  await thinkingLabel.hover();
  const tooltip = page.locator("#footerFloatingTooltip");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("hidden reasoning");
  const box = await tooltip.boundingBox();
  assert.ok(box, "tooltip should have a visible bounding box");
  assert.ok(box.x >= 0 && box.y >= 0, "tooltip should stay inside the top and left viewport edges");
  assert.ok(box.x + box.width <= 1440 && box.y + box.height <= 900, "tooltip should stay inside the bottom and right viewport edges");

  await page.keyboard.press("Tab");
  await thinkingLabel.focus();
  await page.keyboard.press("Enter");
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toContainText("hidden reasoning");
});

test("Controls stay two-column and touch-sized on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openControls(page);

  const thinkingRow = page.locator('.control-row:has(#thinkingSelect)');
  const columns = await thinkingRow.evaluate((row) => getComputedStyle(row).gridTemplateColumns.split(" ").filter(Boolean));
  assert.equal(columns.length, 2);
  await expect(page.locator("#thinkingSelect")).toBeVisible();
  await expect(page.locator("#setThinkingButton")).toBeVisible();
  assert.ok(await page.locator("#setThinkingButton").evaluate((button) => button.getBoundingClientRect().height >= 36));

  const modelLabel = page.locator('.control-row-label:has(#modelControlLabel)');
  await modelLabel.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#modelSearchInput")).toBeVisible();
  const searchBox = await page.locator("#modelSearchInput").boundingBox();
  const rowBox = await page.locator('.control-row:has(#modelSelect)').boundingBox();
  assert.ok(searchBox && rowBox);
  assert.ok(Math.abs(searchBox.x - rowBox.x) <= 1, "expanded search should span the full setting row");
  assert.ok(Math.abs(searchBox.width - rowBox.width) <= 1, "expanded search should retain the full row width");
});
