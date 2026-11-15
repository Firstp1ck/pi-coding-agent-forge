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
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-session-summary-"));
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
      PI_WEBUI_SETTINGS_FILE: join(tempRoot, "settings.json"),
      PI_SESSION_SUMMARY_CONFIG_FILE: join(tempRoot, "session-summary.json"),
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
      // Wait for the isolated real server and fake RPC fixture.
    }
    await delay(100);
  }
  throw new Error(`Pi Web UI did not start:\n${output}`);
});

test.afterAll(async () => {
  if (child?.exitCode === null) child.kill("SIGTERM");
  if (child && child.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

function preferencesData({ configured = false, summary = null } = {}) {
  return {
    version: 1,
    preferences: {
      version: 1,
      configured,
      enabled: false,
      model: { provider: "fake", modelId: "fake-model", thinkingLevel: "off" },
      prompts: { title: "Create a bounded title", summary: "Create a bounded Markdown summary" },
      input: { scope: "text-and-tool-names" },
      context: { injectLatest: false },
      title: { enabled: true, minSettledTurns: 3 },
    },
    models: [{ provider: "fake", id: "fake-model", name: "Fake Model", reasoning: false }],
    modelThinkingLevels: { "fake/fake-model": ["off"] },
    disclosure: {
      scope: "Active-branch user text, final assistant text, and tool names only.",
      cost: "One configured-model request with no fallback.",
      persistence: "Preferences and validated output are stored locally.",
    },
    summary: summary || (configured ? { version: 1, status: "idle", configured: true, enabled: false, durable: false, updatedAt: new Date().toISOString() } : null),
  };
}

function generatedSummaryResponse() {
  return {
    status: 200,
    payload: {
      ok: true,
      data: {
        requested: true,
        summary: {
          version: 1,
          status: "success",
          configured: true,
          enabled: false,
          durable: false,
          title: "Validated fixture title",
          summaryMarkdown: "## Goal\n\nKeep **validated Markdown** visible.\n\n<script>globalThis.summaryPwned = true</script>",
          updatedAt: new Date().toISOString(),
        },
      },
    },
  };
}

async function installSummaryRoutes(page, requests, { configured = false, summary = null, generate = generatedSummaryResponse } = {}) {
  const requestTabId = (route) => new URL(route.request().url()).searchParams.get("tab");
  requests.getTabs = [];
  requests.putTabs = [];
  requests.generateTabs = [];
  await page.route("**/api/commands?*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { commands: [
        { name: "summary", source: "extension", description: "Open the latest session summary" },
        { name: "summary-setup", source: "extension", description: "Configure session summaries" },
      ] } }),
    });
  });
  await page.route("**/api/session-summary/preferences?*", async (route) => {
    const method = route.request().method();
    const tabId = requestTabId(route);
    if (method === "GET") {
      requests.get += 1;
      requests.getTabs.push(tabId);
      const tabSummary = typeof summary === "function" ? summary(tabId) : summary;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: preferencesData({ configured, summary: tabSummary }) }) });
      return;
    }
    requests.putTabs.push(tabId);
    requests.put.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: preferencesData({ configured: true }) }) });
  });
  await page.route("**/api/session-summary/generate?*", async (route) => {
    const request = JSON.parse(route.request().postData() || "{}");
    requests.generateTabs.push(requestTabId(route));
    requests.generate.push(request);
    const response = await generate(request, requests.generate.length);
    await route.fulfill({
      status: response.status,
      contentType: "application/json",
      body: JSON.stringify(response.payload),
    });
  });
}

test("first click opens confirmed setup, cancel has no side effect, and save opens a non-blocking sanitized overlay", async ({ page }) => {
  const requests = { get: 0, put: [], generate: [] };
  await installSummaryRoutes(page, requests);
  await page.goto(baseURL);

  const summaryButton = page.locator(".terminal-tab.active[data-tab-id] > .terminal-tab-actions > .terminal-tab-summary-button");
  await expect(summaryButton).toBeVisible();
  await summaryButton.evaluate((button) => button.click());
  await expect(page.locator("#nativeCommandDialog")).toBeVisible();
  await expect(page.locator("#nativeCommandTitle")).toHaveText("/summary-setup");
  await expect(page.locator("#nativeCommandBody")).toContainText("Privacy scope");
  expect(requests.put).toHaveLength(0);
  expect(requests.generate).toHaveLength(0);

  await page.locator("#nativeCommandActions").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#nativeCommandDialog")).not.toBeVisible();
  expect(requests.put).toHaveLength(0);
  expect(requests.generate).toHaveLength(0);

  await summaryButton.evaluate((button) => button.click());
  await expect(page.locator("#nativeCommandDialog")).toBeVisible();
  await page.locator("#nativeCommandActions").getByRole("button", { name: "Save and generate" }).click();
  await expect(page.locator("#confirmationDialog")).toBeVisible();
  await expect(page.locator("#confirmationSummary")).toContainText("Active-branch user text");
  expect(requests.put).toHaveLength(0);
  expect(requests.generate).toHaveLength(0);
  await page.locator("#confirmationConfirmButton").click();

  await expect(page.locator("#sessionSummaryOverlay")).toBeVisible();
  await expect(page.locator("#sessionSummaryOverlay")).toHaveAttribute("aria-modal", "false");
  await expect(page.locator("#sessionSummaryOverlayTitle")).toHaveText("Validated fixture title");
  await expect(page.locator("#sessionSummaryOverlayBody h2")).toHaveText("Goal");
  await expect(page.locator("#sessionSummaryOverlayBody strong")).toHaveText("validated Markdown");
  await expect(page.locator("#sessionSummaryOverlayBody script")).toHaveCount(0);
  await expect(page.locator("#sessionSummaryOverlayBody")).toContainText("<script>globalThis.summaryPwned = true</script>");
  expect(await page.evaluate(() => globalThis.summaryPwned)).toBeUndefined();
  expect(requests.put).toHaveLength(1);
  expect(requests.put[0]).toMatchObject({ confirmed: true, preferences: { input: { scope: "text-and-tool-names" } } });
  expect(requests.generate).toEqual([{ refresh: true }]);

  await page.setViewportSize({ width: 390, height: 844 });
  const dimensions = await page.locator("#sessionSummaryOverlay").evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    right: element.getBoundingClientRect().right,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  expect(dimensions.right).toBeLessThanOrEqual(391);
});

test("typed summary commands stay native, preserve failures, reset sessions, restore focus, and close on tab switch", async ({ page }) => {
  const requests = { get: 0, put: [], generate: [], prompt: [] };
  const initialSummary = {
    version: 1,
    status: "success",
    configured: true,
    enabled: false,
    durable: true,
    sessionId: "session-a",
    title: "Session A",
    summaryMarkdown: "## Previous success\n\nKeep this Markdown on refresh failure.",
    updatedAt: new Date().toISOString(),
  };
  let generationMode = "failure";
  await installSummaryRoutes(page, requests, {
    configured: true,
    summary: initialSummary,
    generate: async () => generationMode === "failure"
      ? { status: 503, payload: { ok: false, error: "Fixture provider unavailable" } }
      : {
          status: 200,
          payload: {
            ok: true,
            data: {
              requested: true,
              summary: {
                version: 1,
                status: "idle",
                configured: true,
                enabled: false,
                durable: true,
                sessionId: "session-b",
                updatedAt: new Date().toISOString(),
              },
            },
          },
        },
  });
  await page.route("**/api/prompt?*", async (route) => {
    requests.prompt.push(JSON.parse(route.request().postData() || "{}"));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: {} }) });
  });
  await page.goto(baseURL);
  await expect(page.locator(".terminal-tab.active[data-tab-id] > .terminal-tab-actions > .terminal-tab-summary-button")).toBeVisible();

  const prompt = page.locator("#promptInput");
  await prompt.fill("/summary");
  await prompt.press("Enter");
  await expect(page.locator("#sessionSummaryOverlay")).toBeVisible();
  await expect(page.locator("#sessionSummaryOverlayTitle")).toHaveText("Session A");
  await expect(page.locator("#sessionSummaryOverlayBody")).toContainText("Previous success");
  await expect(prompt).toHaveValue("");
  await expect(prompt).toBeFocused();
  expect(requests.generate).toHaveLength(0);
  expect(requests.prompt).toHaveLength(0);
  expect(await page.locator(".message.user").allTextContents()).not.toContainEqual(expect.stringContaining("/summary"));

  await page.keyboard.press("Escape");
  await expect(page.locator("#sessionSummaryOverlay")).toBeHidden();
  await expect(prompt).toBeFocused();

  await prompt.fill("/summary refresh");
  await prompt.press("Enter");
  await expect.poll(() => requests.generate.length).toBe(1);
  expect(requests.generate[0]).toEqual({ refresh: true });
  await expect(page.locator("#sessionSummaryOverlayStatus")).toContainText("Fixture provider unavailable");
  await expect(page.locator("#sessionSummaryOverlayBody")).toContainText("Keep this Markdown on refresh failure");
  expect(requests.prompt).toHaveLength(0);

  generationMode = "session-reset";
  await prompt.fill("/summary refresh");
  await prompt.press("Enter");
  await expect.poll(() => requests.generate.length).toBe(2);
  await expect(page.locator("#sessionSummaryOverlayBody")).not.toContainText("Previous success");
  await expect(page.locator("#sessionSummaryOverlayBody")).toContainText("Generate a summary to populate this view.");

  await page.locator("#newTabButton").evaluate((button) => button.click());
  await page.locator("#newThreadList [role=\"option\"]").first().evaluate((button) => button.click());
  await expect(page.locator("#emptyStartTitle")).toHaveText("Start a conversation");
  await expect(page.locator("#sessionSummaryOverlay")).toBeHidden();
});

test("inactive and grouped tab actions keep setup, generation, and busy state scoped without activating the tab", async ({ page }) => {
  const requests = { get: 0, put: [], generate: [] };
  let releaseGeneration;
  const generationReleased = new Promise((resolve) => { releaseGeneration = resolve; });
  await installSummaryRoutes(page, requests, {
    generate: async () => {
      await generationReleased;
      return generatedSummaryResponse();
    },
  });
  await page.goto(baseURL);
  await expect(page.locator(".terminal-tab[data-tab-id]").first()).toBeVisible();
  const initialTabCount = await page.locator(".terminal-tab[data-tab-id]").count();
  expect(initialTabCount).toBeGreaterThan(0);
  await expect(page.locator(".terminal-tab-summary-button")).toHaveCount(initialTabCount);

  const firstTabId = await page.locator(".terminal-tab[data-tab-id]").first().getAttribute("data-tab-id");
  // The new-thread palette only opens drafts, so create the idle second thread directly.
  const created = await page.request.post(`${baseURL}/api/tabs`, { data: {} });
  expect(created.ok()).toBe(true);
  const createdTabId = (await created.json()).data.tab.id;
  const expectedTabCount = initialTabCount + 1;
  await page.reload();
  await expect(page.locator(".terminal-tab[data-tab-id]")).toHaveCount(expectedTabCount);
  await expect(page.locator(".terminal-tab-summary-button")).toHaveCount(expectedTabCount);
  await page.locator(`[data-tab-id="${createdTabId}"] .terminal-tab-button`).click();
  await expect(page.locator(`[data-tab-id="${createdTabId}"]`)).toHaveClass(/active/);

  const activeTab = page.locator(".terminal-tab.active[data-tab-id]");
  const activeTabId = await activeTab.getAttribute("data-tab-id");
  expect(activeTabId).not.toBe(firstTabId);
  const inactiveSummary = page.locator(`[data-tab-id="${firstTabId}"] > .terminal-tab-actions > .terminal-tab-summary-button`);
  const activeSummary = page.locator(`[data-tab-id="${activeTabId}"] > .terminal-tab-actions > .terminal-tab-summary-button`);
  await inactiveSummary.click();
  await expect(page.locator("#nativeCommandDialog")).toBeVisible();
  await expect(page.locator("#nativeCommandTitle")).toHaveText("/summary-setup");
  await expect(page.locator(`[data-tab-id="${activeTabId}"]`)).toHaveClass(/active/);

  await page.locator("#nativeCommandActions").getByRole("button", { name: "Save and generate" }).click();
  await page.locator("#confirmationConfirmButton").click();
  await expect.poll(() => requests.generate.length).toBe(1);
  expect(requests.putTabs).toEqual([firstTabId]);
  expect(requests.generateTabs).toEqual([firstTabId]);
  await expect(inactiveSummary).toBeDisabled();
  await expect(inactiveSummary).toHaveAttribute("aria-busy", "true");
  await expect(activeSummary).toBeEnabled();
  await expect(activeSummary).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(`[data-tab-id="${activeTabId}"]`)).toHaveClass(/active/);

  releaseGeneration();
  await expect(page.locator("#sessionSummaryOverlay")).toBeVisible();
  await expect(page.locator("#sessionSummaryOverlayTitle")).toHaveText("Validated fixture title");
  await expect(inactiveSummary).toBeEnabled();
  await page.keyboard.press("Escape");

  await page.locator(`.terminal-tab[data-tab-id="${activeTabId}"]`).dragTo(page.locator(`.terminal-tab[data-tab-id="${firstTabId}"]`));
  const group = page.locator(".terminal-tab-custom-group");
  await expect(group).toHaveCount(1);
  await group.hover();
  await expect(group.locator(".terminal-tab-group-item")).toHaveCount(2);
  await expect(group.locator(".terminal-tab-group-item > .terminal-tab-actions > .terminal-tab-summary-button")).toHaveCount(2);
  await group.locator(`[data-tab-id="${firstTabId}"] > .terminal-tab-actions > .terminal-tab-summary-button`).click();
  await expect(page.locator("#sessionSummaryOverlayTitle")).toHaveText("Validated fixture title");
  await expect(group.locator(`[data-tab-id="${activeTabId}"]`)).toHaveClass(/active/);
});

test("focus returns to a regenerated per-tab summary action after tab controls rerender", async ({ page }) => {
  const requests = { get: 0, put: [], generate: [] };
  await installSummaryRoutes(page, requests, { configured: true });
  await page.goto(baseURL);

  await expect(page.locator("#promptInput")).toBeFocused();
  const summaryButton = page.locator(".terminal-tab.active[data-tab-id] > .terminal-tab-actions > .terminal-tab-summary-button, .terminal-tab-group.active .terminal-tab-group-item.active > .terminal-tab-actions > .terminal-tab-summary-button");
  await expect(summaryButton).toHaveCount(1);
  await summaryButton.evaluate((button) => button.click());
  await expect(page.locator("#sessionSummaryOverlayTitle")).toHaveText("Validated fixture title");
  await page.keyboard.press("Escape");
  await expect(summaryButton).toBeFocused();
});

test("each desktop terminal tab keeps adjacent accessible Split and Summary actions at tab height", async ({ page }) => {
  const requests = { get: 0, put: [], generate: [] };
  await installSummaryRoutes(page, requests, { configured: true });
  await page.goto(baseURL);
  await expect(page.locator("#tabBar .terminal-tab-button").first()).toBeVisible();

  await expect(page.locator("#splitTabButton")).toHaveCount(0);
  const activeGroup = page.locator(".terminal-tab-group.active");
  if (await activeGroup.count()) await activeGroup.hover();
  const activeActions = page.locator(".terminal-tab.active[data-tab-id] > .terminal-tab-actions, .terminal-tab-group.active .terminal-tab-group-item.active > .terminal-tab-actions");
  await expect(activeActions).toHaveCount(1);
  const initialTabCount = await page.locator("[data-tab-id] > .terminal-tab-actions").count();
  expect(initialTabCount).toBeGreaterThan(0);
  await expect(activeActions.locator(":scope > .terminal-tab-split-button")).toHaveCount(1);
  await expect(activeActions.locator(":scope > .terminal-tab-summary-button")).toHaveCount(1);
  const actionGeometry = await activeActions.evaluate((slot) => ({
    slotWidth: slot.getBoundingClientRect().width,
    splitWidth: slot.querySelector(".terminal-tab-split-button")?.getBoundingClientRect().width || 0,
    summaryWidth: slot.querySelector(".terminal-tab-summary-button")?.getBoundingClientRect().width || 0,
    slotHeight: slot.getBoundingClientRect().height,
    tabHeight: slot.parentElement?.querySelector(":scope > .terminal-tab-button")?.getBoundingClientRect().height || 0,
    splitHeight: slot.querySelector(".terminal-tab-split-button")?.getBoundingClientRect().height || 0,
    summaryHeight: slot.querySelector(".terminal-tab-summary-button")?.getBoundingClientRect().height || 0,
  }));
  expect(actionGeometry.splitWidth).toBeGreaterThanOrEqual(24);
  expect(actionGeometry.summaryWidth).toBeGreaterThanOrEqual(24);
  expect(Math.abs(actionGeometry.splitWidth + actionGeometry.summaryWidth - actionGeometry.slotWidth)).toBeLessThanOrEqual(2);
  expect(Math.abs(actionGeometry.slotHeight - actionGeometry.tabHeight)).toBeLessThan(1);
  expect(Math.abs(actionGeometry.splitHeight - actionGeometry.summaryHeight)).toBeLessThan(1);
  expect(Math.abs(actionGeometry.splitHeight - actionGeometry.slotHeight)).toBeLessThan(1);
  expect(Math.abs(actionGeometry.summaryHeight - actionGeometry.slotHeight)).toBeLessThan(1);

  await activeActions.locator(":scope > .terminal-tab-split-button").click();
  await expect(page.locator("[data-tab-id] > .terminal-tab-actions")).toHaveCount(initialTabCount + 1);
  await expect(page.locator("#terminalSplitShell")).toBeVisible();
  const splitTabId = await page.locator("#terminalSplitFrame").getAttribute("data-tab-id");
  expect(splitTabId).toBeTruthy();
  const splitControl = page.locator(`[data-tab-id="${splitTabId}"] > .terminal-tab-actions > .terminal-tab-split-button`);
  await expect(splitControl).toHaveAttribute("aria-pressed", "true");
  await splitControl.evaluate((button) => button.click());
  await expect(page.locator("#terminalSplitShell")).toBeHidden();
  await expect(splitControl).toHaveAttribute("aria-pressed", "false");
});
