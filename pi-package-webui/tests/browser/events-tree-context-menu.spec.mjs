import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");
const mappedEntryId = "fixture-finish-entry";

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

async function api(page, pathname) {
  const response = await page.request.get(`${baseURL}${pathname}`);
  const payload = await response.json().catch(() => ({}));
  assert.equal(response.ok(), true, `${pathname} should succeed: ${payload.error || output}`);
  return payload;
}

async function emitToolLifecycle(page) {
  await page.locator("#promptInput").fill("fixture transcript continuity tool");
  await page.locator("#sendButton").click();
  const finishRow = page.locator('#eventLog .event[data-event-tool-phase="finish"]').first();
  await expect(finishRow).toContainText("tool read finished");
  await expect(finishRow).toContainText("target: continuity.txt");
  return finishRow;
}

async function dispatchPointerMenu(row) {
  await row.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 8,
      clientY: rect.bottom,
    }));
  });
}

async function openEvents(page) {
  await expect(page.locator("#chat")).toContainText("fake answer");
  const section = page.locator("#sidePanelSectionEvents");
  if (await section.isHidden()) await page.locator("#sidePanelSectionToggleEvents").click();
  await expect(section).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const port = await freePort();
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-events-tree-menu-"));
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
      PI_WEBUI_SETTINGS_FILE: join(tempRoot, "settings.json"),
      FAKE_PI_CONTINUITY_MODE: "1",
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
      // Wait for the isolated WebUI fixture.
    }
    await delay(100);
  }
  throw new Error(`Pi WebUI did not start:\n${output}`);
});

test.afterAll(async () => {
  if (child?.exitCode === null) child.kill("SIGTERM");
  if (child && child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
});

test("display modes persist while pointer and keyboard Tree actions remain safe", async ({ page }) => {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await openEvents(page);
  let finishRow = await emitToolLifecycle(page);
  const menu = page.locator("#eventTreeContextMenu");
  const eventDetails = finishRow.locator(".event-details");
  const filter = page.locator("#eventFilterSelect");
  const visibleRows = page.locator("#eventLog .event:not([hidden])");
  await expect(page.locator("#eventLog")).toHaveAttribute("data-display-mode", "detailed");
  await expect(filter).toHaveValue("all");
  await expect(eventDetails).toBeVisible();

  await page.locator("#eventLog").evaluate((log) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "event error";
    row.dataset.eventLevel = "error";
    row.dataset.eventTreeAvailable = "false";
    row.textContent = "fixture filter failure";
    log.prepend(row);
  });
  await filter.selectOption("errors");
  await expect(visibleRows).toHaveCount(1);
  await expect(visibleRows).toContainText("fixture filter failure");
  await expect(page.locator("#eventFilterStatus")).toContainText("1 of");
  await filter.selectOption("warnings");
  await expect(visibleRows).toHaveCount(0);
  await expect(page.locator("#eventFilterEmpty")).toBeVisible();
  await filter.selectOption("tools");
  await expect(visibleRows).toHaveCount(2);
  await filter.selectOption("tree");
  await expect(visibleRows).toHaveCount(2);
  expect(await page.evaluate(() => localStorage.getItem("pi-webui-event-filter-v1"))).toBe("tree");
  await filter.selectOption("all");

  await dispatchPointerMenu(finishRow);
  await expect(menu).toBeVisible();
  await expect(page.locator("#eventDisplayDetailedAction")).toBeFocused();
  await expect(page.locator("#eventDisplayDetailedAction")).toHaveAttribute("aria-checked", "true");
  await page.locator("#eventDisplayCompactAction").click();
  await expect(menu).toBeHidden();
  await expect(eventDetails).toBeHidden();
  await expect(finishRow.locator(".event-time")).toBeVisible();
  await expect(finishRow.locator(".event-summary")).toContainText("tool read finished");
  await expect(finishRow).toHaveCSS("border-left-style", "solid");
  expect(await page.evaluate(() => localStorage.getItem("pi-webui-event-display-mode-v1"))).toBe("compact");
  await filter.selectOption("tree");

  await page.reload({ waitUntil: "domcontentloaded" });
  await openEvents(page);
  await expect(page.locator("#eventLog")).toHaveAttribute("data-display-mode", "compact");
  await expect(page.locator("#eventFilterSelect")).toHaveValue("tree");
  finishRow = await emitToolLifecycle(page);
  await expect(finishRow.locator(".event-details")).toBeHidden();
  await expect(page.locator("#eventLog .event:not([hidden])")).toHaveCount(2);
  await page.locator("#eventFilterSelect").selectOption("all");
  await dispatchPointerMenu(finishRow);
  await expect(page.locator("#eventDisplayCompactAction")).toBeFocused();
  await expect(page.locator("#eventDisplayCompactAction")).toHaveAttribute("aria-checked", "true");
  await page.locator("#eventDisplayDetailedAction").click();
  await expect(finishRow.locator(".event-details")).toBeVisible();

  const toolCallId = await finishRow.getAttribute("data-chat-tool-call-id");
  assert.ok(toolCallId, "the rendered finish row should carry its stable tool-call ID");

  const tabsPayload = await api(page, "/api/tabs");
  const tabId = tabsPayload.data?.activeTabId || tabsPayload.data?.tabs?.[0]?.id;
  assert.ok(tabId, "the fixture should expose an active tab");

  const sessionTreeUrls = [];
  const navigationRequests = [];
  const refreshUrls = [];
  let releaseNavigation;
  let navigationCanFinish = new Promise((resolve) => { releaseNavigation = resolve; });
  let navigationReleased = false;

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (navigationReleased && url.pathname === "/api/state") refreshUrls.push(url);
  });
  await page.route("**/api/session-tree?*", async (route) => {
    const url = new URL(route.request().url());
    sessionTreeUrls.push(url);
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        data: {
          nodes: [{ id: mappedEntryId }],
          eventTargets: [{ toolCallId, toolName: "read", startEntryId: "fixture-start-entry", finishEntryId: mappedEntryId }],
        },
      }),
    });
  });
  await page.route("**/api/tree-navigate?*", async (route) => {
    const request = route.request();
    navigationRequests.push({ url: new URL(request.url()), body: request.postDataJSON() });
    await navigationCanFinish;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { message: "Fixture tree navigation complete." } }),
    });
  });

  await dispatchPointerMenu(finishRow);
  await expect(menu).toBeVisible();
  await expect(page.locator("#eventDisplayDetailedAction")).toBeFocused();
  await page.locator("#eventTreeContextMenuAction").click();
  await expect(page.locator("#confirmationDialog")).toBeVisible();
  await page.locator("#confirmationCancelButton").click();
  await expect(page.locator("#confirmationDialog")).toBeHidden();
  expect(navigationRequests).toHaveLength(0);

  await finishRow.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await expect(page.locator("#eventDisplayDetailedAction")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator("#eventTreeContextMenuAction")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#confirmationDialog")).toBeVisible();
  await page.locator("#confirmationConfirmButton").dispatchEvent("click");
  await expect.poll(() => navigationRequests.length).toBe(1);

  expect(navigationRequests[0].body).toEqual({ entryId: mappedEntryId, summarize: false });
  expect(navigationRequests[0].url.searchParams.get("tab")).toBe(tabId);
  expect(sessionTreeUrls.length).toBeGreaterThanOrEqual(2);
  expect(sessionTreeUrls.every((url) => url.searchParams.get("tab") === tabId)).toBe(true);

  await menu.evaluate((element) => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
  await expect(menu).toBeHidden();
  navigationReleased = true;
  releaseNavigation();

  await expect(page.locator("#chat")).toContainText("Fixture tree navigation complete.");
  await expect.poll(() => refreshUrls.length).toBeGreaterThan(0);
  expect(refreshUrls.every((url) => url.searchParams.get("tab") === tabId)).toBe(true);
});
