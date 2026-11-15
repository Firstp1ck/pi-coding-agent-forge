import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

// Browser coverage for plans/planned/webui-user-noticeable-improvements.md.

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
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-user-noticeable-"));
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

async function layoutMetrics(page) {
  return page.evaluate(() => {
    const workspace = document.querySelector(".workspace-column").getBoundingClientRect();
    const prompt = document.querySelector("#promptInput").getBoundingClientRect();
    return {
      bodyClasses: document.body.className,
      gridColumns: getComputedStyle(document.querySelector("main.layout")).gridTemplateColumns,
      workspaceWidth: workspace.width,
      promptWidth: prompt.width,
      viewportWidth: window.innerWidth,
    };
  });
}

// P0-1: with the Control Deck collapsed in overlay presentation (phones, tablets, laptops <= 1050px)
// the workspace must take the full viewport width instead of collapsing to a few pixels.
for (const viewport of [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1024, height: 700 }]) {
  test(`overlay presentation keeps the workspace full-width at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(baseURL);
    await expect(page.locator("#promptInput")).toBeVisible();
    await expect.poll(async () => (await layoutMetrics(page)).bodyClasses).toContain("control-deck-overlay");
    const metrics = await layoutMetrics(page);
    assert.ok(metrics.bodyClasses.includes("side-panel-collapsed"), `overlay deck should start collapsed: ${metrics.bodyClasses}`);
    assert.ok(metrics.workspaceWidth >= metrics.viewportWidth * 0.9, `workspace should fill the viewport: ${JSON.stringify(metrics)}`);
    assert.ok(metrics.promptWidth >= metrics.viewportWidth * 0.6, `prompt should be usable: ${JSON.stringify(metrics)}`);
  });
}

// P0-2: native selector dialogs (/model, /theme, /resume, …) — Enter in the filter selects the
// highlighted choice instead of closing the dialog; arrows move the highlight; the current
// choice is highlighted when unfiltered.
test("model selector supports Enter-to-select and arrow-key navigation from the filter box", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const models = [
    { provider: "fake", id: "fake-model", name: "Fake Model" },
    { provider: "fake", id: "alpha-one", name: "Alpha One" },
    { provider: "fake", id: "beta-two", name: "Beta Two" },
    { provider: "other", id: "gamma-three", name: "Gamma Three" },
  ];
  await page.route("**/api/models*", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: { models } }) });
  });
  const setModelCalls = [];
  await page.route(/\/api\/model(\?.*)?$/, async (route) => {
    setModelCalls.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: route.request().postDataJSON() }) });
  });
  await page.goto(baseURL);
  await expect(page.locator("#promptInput")).toBeFocused();

  await page.keyboard.press("Control+l");
  const dialog = page.locator("#nativeCommandDialog");
  await expect(dialog).toBeVisible();
  const search = page.locator("#nativeCommandSearch");
  await expect(search).toBeFocused();
  await expect(page.locator("#nativeCommandBody .native-selector-item")).toHaveCount(4);
  // The current model is highlighted before any filtering.
  await expect(page.locator("#nativeCommandBody .native-selector-item.keyboard-active")).toContainText("fake/fake-model");

  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#nativeCommandBody .native-selector-item.keyboard-active")).toContainText("fake/alpha-one");
  await expect(search).toHaveAttribute("aria-activedescendant", /nativeSelectorItem-1/);
  await page.keyboard.press("End");
  await expect(page.locator("#nativeCommandBody .native-selector-item.keyboard-active")).toContainText("other/gamma-three");

  await search.fill("beta");
  await expect(page.locator("#nativeCommandBody .native-selector-item")).toHaveCount(1);
  await expect(page.locator("#nativeCommandBody .native-selector-item.keyboard-active")).toContainText("fake/beta-two");
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  assert.deepEqual(setModelCalls, [{ provider: "fake", modelId: "beta-two" }], "Enter should select the highlighted model");
});

// P0-3: Enter accepts the highlighted slash suggestion instead of sending the partial token;
// once the token equals the suggestion, Enter sends as usual.
test("Enter accepts the highlighted slash suggestion before sending", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const prompt = page.locator("#promptInput");
  await expect(prompt).toBeVisible();
  await prompt.click();
  await page.keyboard.type("/work");
  const suggest = page.locator("#commandSuggest");
  await expect(suggest).toBeVisible();
  await expect(suggest.locator(".command-suggest-item").first()).toContainText("/workflow");
  await expect(suggest.locator(".command-suggest-hint")).toContainText("Enter or Tab accept");
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveValue("/workflow ");
  await expect(suggest).toBeHidden();
  // Nothing was sent: the transcript has no user message for the partial token.
  await expect(page.locator("#chat")).not.toContainText("/work\n");
});

// P0-5: warnings/errors that used to land only in the collapsed Events log now surface as a
// non-blocking toast and increment an unread badge on the Events section header.
test("errors surface as a toast and an Events unread badge", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(/\/api\/tabs(\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "tab spawn exploded" }) });
  });
  await page.goto(baseURL);
  await expect(page.locator("#promptInput")).toBeVisible();
  await expect(page.locator("#eventsUnreadBadge")).toBeHidden();

  // Palette → "New tab" fails server-side; previously this only wrote to the collapsed Events log.
  await page.keyboard.press("Control+k");
  await page.locator("#commandPaletteInput").fill("New tab");
  await page.keyboard.press("Enter");
  const toast = page.locator("#noticeToastStack .notice-toast.error");
  await expect(toast.first()).toContainText("tab spawn exploded");
  await expect(page.locator("#eventsUnreadBadge")).toBeVisible();
  await expect(page.locator("#eventsUnreadBadge")).toHaveText("1");

  // "Events" on the toast opens the Control Deck Events section and clears the unread badge.
  await toast.first().locator(".notice-toast-events").click();
  await expect(page.locator("#sidePanelSectionEvents")).toBeVisible();
  await expect(page.locator("#eventsUnreadBadge")).toBeHidden();
  await expect(page.locator("#eventLog .event.error").first()).toContainText("tab spawn exploded");
});

// P1-1: hover/focus-opened composer menus close on Escape even while the trigger keeps focus
// (previously the panel stayed visible because :focus-within re-opened it immediately).
test("Escape closes the composer options menu while its trigger keeps focus", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  await expect(page.locator("#promptInput")).toBeVisible();
  const trigger = page.locator("#optionsMenuButton");
  const panel = page.locator("#optionsMenu");
  await trigger.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
  // Explicit click reopens it.
  await trigger.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("a group with more than eight tabs keeps every titled row reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await page.goto(baseURL);
  await expect(page.locator("#promptInput")).toBeVisible();

  const groupedTabs = [];
  for (let index = 1; index <= 9; index += 1) {
    const title = `Overflow title ${index}`;
    const response = await page.request.post(`${baseURL}/api/tabs`, { data: { title } });
    assert.equal(response.ok(), true, `creating ${title} should succeed`);
    const payload = await response.json();
    groupedTabs.push({ id: payload.data.tab.id, title });
  }

  await page.evaluate((tabs) => {
    localStorage.setItem("pi-webui-terminal-custom-groups-v1", JSON.stringify({
      version: 1,
      groups: [{ id: "overflow-group", title: "Overflow group", tabIds: tabs.map((tab) => tab.id) }],
    }));
  }, groupedTabs);
  await page.reload();

  const group = page.locator(".terminal-tab-custom-group");
  await expect(group).toHaveCount(1);
  await group.hover();
  const menu = group.locator(".terminal-tab-group-menu");
  await expect(menu).toBeVisible();
  await expect(menu.locator(".terminal-tab-group-item")).toHaveCount(groupedTabs.length);
  assert.deepEqual(
    await menu.locator(".terminal-tab-group-item .terminal-tab-title").allTextContents(),
    groupedTabs.map((tab) => tab.title),
    "the group menu should preserve every server-provided tab title",
  );

  const bounds = await menu.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { bottom: rect.bottom, viewportHeight: window.innerHeight, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight };
  });
  assert.ok(bounds.bottom <= bounds.viewportHeight - 16, `the group menu should stay inside the viewport: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.scrollHeight > bounds.clientHeight, `nine group rows should use the bounded menu scroller: ${JSON.stringify(bounds)}`);

  await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
  const lastRow = menu.locator(".terminal-tab-group-item").last();
  const lastBounds = await lastRow.evaluate((node) => {
    const row = node.getBoundingClientRect();
    const scroller = node.parentElement.getBoundingClientRect();
    return { rowTop: row.top, rowBottom: row.bottom, scrollerTop: scroller.top, scrollerBottom: scroller.bottom };
  });
  assert.ok(lastBounds.rowTop >= lastBounds.scrollerTop && lastBounds.rowBottom <= lastBounds.scrollerBottom, `the final titled row should be reachable by scrolling: ${JSON.stringify(lastBounds)}`);
});
