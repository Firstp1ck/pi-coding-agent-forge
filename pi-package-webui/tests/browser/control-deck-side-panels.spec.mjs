import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");
let child;
let baseURL;
let tempRoot;

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer() {
  const port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, PI_WEBUI_RPC_SUPERVISOR: "0", PI_CODING_AGENT_DIR: join(tempRoot, "agent"), PI_WEBUI_SETTINGS_FILE: join(tempRoot, "settings.json") },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await delay(100);
  }
  throw new Error(`server did not start: ${output}`);
}

async function stopServer() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  await Promise.race([exited, delay(5_000).then(() => child.kill("SIGKILL"))]);
}

async function openControls(page) {
  const toggle = page.locator('[data-side-panel-section-toggle="controls"]');
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.locator("#controlDeckPlacementSelect")).toBeVisible();
}

async function selectPlacement(page, placement) {
  await openControls(page);
  await page.locator("#controlDeckPlacementSelect").selectOption(placement);
  await expect(page.locator("#controlDeckPlacementSelect")).toHaveValue(placement);
}

async function assertSidePanelResizePillInGap(page, side) {
  const handle = page.locator(side === "left" ? "#sidePanelLeftResizeHandle" : "#sidePanelResizeHandle");
  const shell = page.locator(side === "left" ? "#sidePanelLeft" : "#sidePanel");
  const [handleBox, shellBox, workspaceBox, paintedWidth] = await Promise.all([
    handle.boundingBox(),
    shell.boundingBox(),
    page.locator(".workspace-column").boundingBox(),
    handle.evaluate((node) => Number.parseFloat(getComputedStyle(node, "::after").width)),
  ]);
  assert.ok(handleBox && shellBox && workspaceBox && paintedWidth > 0, `${side} Control Deck resize pill should expose measurable geometry`);
  const paintedLeft = handleBox.x + (handleBox.width - paintedWidth) / 2;
  const paintedRight = paintedLeft + paintedWidth;
  if (side === "right") {
    assert.ok(paintedLeft >= workspaceBox.x + workspaceBox.width - 0.5 && paintedRight <= shellBox.x + 0.5, `right Control Deck resize pill should be fully inside the inter-column gap: ${JSON.stringify({ paintedLeft, paintedRight, workspaceBox, shellBox })}`);
  } else {
    assert.ok(paintedLeft >= shellBox.x + shellBox.width - 0.5 && paintedRight <= workspaceBox.x + 0.5, `left Control Deck resize pill should be fully inside the inter-column gap: ${JSON.stringify({ paintedLeft, paintedRight, workspaceBox, shellBox })}`);
  }
}

async function assertAxeClean(page, label, selector) {
  const accessibility = await new AxeBuilder({ page }).include(selector).disableRules(["aria-required-children"]).analyze();
  const serious = accessibility.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
  assert.deepEqual(serious, [], `${label} should have no serious/critical Axe violations: ${serious.map(({ id }) => id).join(", ")}`);
}

async function openAcceptanceFile(page) {
  const files = page.locator('[data-side-panel-section-toggle="files"]');
  if (await files.getAttribute("aria-expanded") !== "true") await files.click();
  const fixture = page.locator('[role="treeitem"][data-path="acceptance.txt"]');
  await expect(fixture).toBeVisible();
  await fixture.click();
  await expect(page.locator("#fileViewerPane")).toBeVisible();
}

async function dismissUpdateNotification(page, { waitMs = 2_500 } = {}) {
  const notification = page.locator("#updateNotification");
  const appeared = await notification.waitFor({ state: "visible", timeout: waitMs }).then(() => true).catch(() => false);
  if (!appeared) return;
  await page.locator("#updateNotificationDismissButton").click();
  await expect(notification).toBeHidden();
}

test.beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-control-deck-"));
  await writeFile(join(tempRoot, "acceptance.txt"), "Control Deck capacity fixture\n", "utf8");
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("Mobile v2 repeatedly returns canonical project content to its Control Deck owner", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?mobileShell=v2`);
  await expect(page.locator("html")).toHaveAttribute("data-mobile-shell", "v2");
  const project = page.getByRole("navigation", { name: "Phone destinations" }).getByRole("button", { name: "Project", exact: true });
  const chat = page.getByRole("navigation", { name: "Phone destinations" }).getByRole("button", { name: "Chat", exact: true });
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await project.click();
    await page.getByRole("tab", { name: "Files" }).click();
    await expect.poll(() => page.locator("#sidePanelSectionFiles").evaluate((node) => node.parentElement?.id)).toBe("mobileProjectContent");
    await expect(page.locator("#sidePanelBodyRight #sidePanelSectionFiles")).toHaveCount(0);
    await chat.click();
    await expect.poll(() => page.locator("#sidePanelSectionFiles").evaluate((node) => node.closest("[data-control-deck-body]")?.id || "")).toBe("sidePanelBodyRight");
    await expect(page.locator("#mobileProjectContent #sidePanelSectionFiles")).toHaveCount(0);
  }
  await context.close();
});

test("embedded split terminal fills every desktop pane width with inherited sidebar classes", async ({ page }) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto(baseURL);
  const tabId = await page.locator("[data-tab-id]").first().getAttribute("data-tab-id");
  assert.ok(tabId, "the fixture should expose a terminal tab for the embedded split");

  for (const width of [721, 900, 1200]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${baseURL}/?embed=split&tab=${encodeURIComponent(tabId)}`);
    await page.locator("body").evaluate((body) => {
      body.classList.add("terminal-tabs-left", "terminal-tabs-sidebar-start");
      body.style.setProperty("--terminal-tabs-sidebar-width", "560px");
    });
    await expect(page.locator("body")).toHaveClass(/embedded-split/);
    await expect(page.locator("body")).toHaveClass(/terminal-tabs-left/);
    await expect(page.locator("#terminalTabsShell")).toBeHidden();
    const geometry = await page.evaluate(() => {
      const panel = document.querySelector(".chat-panel");
      const chat = document.querySelector(".chat");
      const composer = document.querySelector(".composer");
      const panelRect = panel?.getBoundingClientRect();
      const chatRect = chat?.getBoundingClientRect();
      const composerRect = composer?.getBoundingClientRect();
      const style = panel ? getComputedStyle(panel) : null;
      return {
        viewportWidth: window.innerWidth,
        panelWidth: panelRect?.width || 0,
        chatWidth: chatRect?.width || 0,
        composerWidth: composerRect?.width || 0,
        display: style?.display || "",
        flexDirection: style?.flexDirection || "",
      };
    });
    assert.equal(geometry.display, "flex", `embedded chat panel should remain flex at ${width}px`);
    assert.equal(geometry.flexDirection, "column", `embedded chat panel should remain vertical at ${width}px`);
    assert.ok(Math.abs(geometry.panelWidth - geometry.viewportWidth) <= 1, `embedded panel should fill ${width}px: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.chatWidth - geometry.panelWidth) <= 2, `embedded transcript should fill ${width}px inside the panel border: ${JSON.stringify(geometry)}`);
    assert.ok(Math.abs(geometry.composerWidth - geometry.panelWidth) <= 2, `embedded composer should fill ${width}px inside the panel border: ${JSON.stringify(geometry)}`);
  }
});

test("Right, Left, Both, Sidebar rail, independent state, overlay, singleton ARIA, and reload", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 2200, height: 1000 });
  await page.goto(baseURL);
  await page.waitForTimeout(600);
  await dismissUpdateNotification(page);

  const rightResizeHandle = page.locator("#sidePanelResizeHandle");
  const leftResizeHandle = page.locator("#sidePanelLeftResizeHandle");
  await expect(page.locator("#sidePanel")).toBeVisible();
  await expect(page.locator("#sidePanelLeft")).toBeHidden();
  await expect(rightResizeHandle).toBeVisible();
  await expect(leftResizeHandle).toBeHidden();
  await assertSidePanelResizePillInGap(page, "right");
  const rightOnlyBefore = Number(await rightResizeHandle.getAttribute("aria-valuenow"));
  await rightResizeHandle.focus();
  await rightResizeHandle.press("Shift+ArrowLeft");
  const rightOnlyWidth = Number(await rightResizeHandle.getAttribute("aria-valuenow"));
  expect(rightOnlyWidth).toBeGreaterThan(rightOnlyBefore);

  await selectPlacement(page, "left");
  await expect(page.locator("#sidePanelLeft")).toBeVisible();
  await expect(leftResizeHandle).toBeVisible();
  await expect(rightResizeHandle).toBeHidden();
  await assertSidePanelResizePillInGap(page, "left");
  await expect(page.locator("#openIssueButton")).toBeVisible();
  await expect(page.locator("#piVersionButton")).toHaveCount(1);
  const leftOnlyBefore = Number(await leftResizeHandle.getAttribute("aria-valuenow"));
  const leftHandleBox = await leftResizeHandle.boundingBox();
  assert.ok(leftHandleBox, "left Control Deck resize handle should have pointer geometry");
  await page.mouse.move(leftHandleBox.x + leftHandleBox.width / 2, leftHandleBox.y + leftHandleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftHandleBox.x + leftHandleBox.width / 2 + 80, leftHandleBox.y + leftHandleBox.height / 2, { steps: 8 });
  await page.mouse.up();
  const leftOnlyWidth = Number(await leftResizeHandle.getAttribute("aria-valuenow"));
  expect(leftOnlyWidth).toBeGreaterThan(leftOnlyBefore);

  await selectPlacement(page, "both");
  await expect(page.locator("#sidePanelLeft")).toBeVisible();
  await expect(page.locator("#sidePanel")).toBeVisible();
  await expect(leftResizeHandle).toBeVisible();
  await expect(rightResizeHandle).toBeVisible();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-webui-control-deck-layout-v2") || "null")?.panelWidths)).toMatchObject({ left: leftOnlyWidth, right: rightOnlyWidth });
  await assertAxeClean(page, "visible left Control Deck", "#sidePanelLeft");
  await assertAxeClean(page, "visible right Control Deck", "#sidePanel");
  const controls = page.locator('[data-side-panel-section-toggle="controls"]');
  const files = page.locator('[data-side-panel-section-toggle="files"]');
  await expect(controls).toHaveAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown Alt+ArrowLeft Alt+ArrowRight");
  const initialOrder = await page.locator("#sidePanelBodyRight > [data-side-panel-section]").evaluateAll((nodes) => nodes.map((node) => node.dataset.sidePanelSection));
  await controls.focus();
  await controls.press("Alt+ArrowRight");
  await expect.poll(() => page.locator("#sidePanelBodyRight > [data-side-panel-section]").evaluateAll((nodes) => nodes.map((node) => node.dataset.sidePanelSection))).toEqual(initialOrder);
  await controls.press("Alt+ArrowLeft");
  await expect(page.locator('#sidePanelBodyLeft > [data-side-panel-section="controls"]')).toHaveCount(1);
  await expect(controls).toBeFocused();
  await expect(page.locator("#controlDeckMovementAnnouncer")).toContainText(/Controls moved to the left Control Deck, position 1 of 1/);
  await files.focus();
  await files.press("Alt+ArrowLeft");
  await expect(page.locator('#sidePanelBodyLeft > [data-side-panel-section="files"]')).toHaveCount(1);
  await expect(files).toBeFocused();
  await expect(page.locator("#controlDeckMovementAnnouncer")).toContainText(/Files moved to the left Control Deck, position 2 of 2/);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-webui-control-deck-layout-v2") || "null")?.sectionLayout?.leftSectionIds || [])).toEqual(expect.arrayContaining(["controls", "files"]));
  const git = page.locator('[data-side-panel-section-toggle="git"]');
  await dismissUpdateNotification(page);
  await git.scrollIntoViewIfNeeded();
  await expect(git).toBeVisible();
  await git.hover();
  const gitBox = await git.boundingBox();
  assert.ok(gitBox, "pointer cross-panel drag requires a visible source toggle");
  await page.mouse.down();
  await page.mouse.move(gitBox.x + gitBox.width / 2 + 32, gitBox.y + gitBox.height / 2 + 8, { steps: 8 });
  await expect(page.locator("body")).toHaveClass(/control-deck-section-dragging/);
  const leftDropBox = await page.locator('[data-control-deck-drop-target="left"]').boundingBox();
  assert.ok(leftDropBox, "pointer drag should reveal the populated destination drop target");
  await page.mouse.move(leftDropBox.x + leftDropBox.width / 2, leftDropBox.y + leftDropBox.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator('#sidePanelBodyLeft > [data-side-panel-section="git"]')).toHaveCount(1);
  await git.press("Alt+ArrowRight");
  await expect(page.locator('#sidePanelBodyRight > [data-side-panel-section="git"]')).toHaveCount(1);

  await page.waitForTimeout(300);
  if (await files.getAttribute("aria-expanded") !== "true") await files.click();
  if (await controls.getAttribute("aria-expanded") !== "true") await controls.click();
  await expect(files).toHaveAttribute("aria-expanded", "true");
  await expect(controls).toHaveAttribute("aria-expanded", "true");
  await files.click();
  await expect(files).toHaveAttribute("aria-expanded", "false");
  await controls.press("Alt+ArrowRight");
  await expect(controls).toBeFocused();
  await expect(controls).toHaveAttribute("aria-expanded", "true");
  await expect(files).toHaveAttribute("aria-expanded", "false");
  await files.click();
  await expect(files).toHaveAttribute("aria-expanded", "true");
  await files.press("Alt+ArrowRight");
  await expect(files).toBeFocused();
  await expect(files).toHaveAttribute("aria-expanded", "true");
  await expect(controls).toHaveAttribute("aria-expanded", "true");
  await controls.click();
  await expect(controls).toHaveAttribute("aria-expanded", "false");
  await expect(files).toHaveAttribute("aria-expanded", "true");

  await files.press("Alt+ArrowLeft");
  await expect(files).toBeFocused();
  await expect(files).toHaveAttribute("aria-expanded", "true");
  await expect(controls).toHaveAttribute("aria-expanded", "false");
  await files.click();
  await expect(files).toHaveAttribute("aria-expanded", "false");
  const latentLeftBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("pi-webui-control-deck-layout-v2") || "null")?.sectionLayout?.leftSectionIds || []);
  await selectPlacement(page, "right");
  await controls.focus();
  await controls.press("Alt+ArrowDown");
  const rightOrder = await page.locator("#sidePanelBodyRight > [data-side-panel-section]").evaluateAll((nodes) => nodes.map((node) => node.dataset.sidePanelSection));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-webui-control-deck-layout-v2") || "null")?.sectionLayout?.leftSectionIds || [])).toEqual(latentLeftBefore);
  await page.reload();
  await expect.poll(() => page.locator("#sidePanelBodyRight > [data-side-panel-section]").evaluateAll((nodes) => nodes.map((node) => node.dataset.sidePanelSection))).toEqual(rightOrder);
  await selectPlacement(page, "both");
  await expect(page.locator('#sidePanelBodyLeft > [data-side-panel-section="files"]')).toHaveCount(1);
  await expect(files).toHaveAttribute("aria-expanded", "false");
  await expect(controls).toHaveAttribute("aria-expanded", "true");

  await page.locator("#toggleSidePanelLeftButton").click();
  await expect(page.locator("body")).toHaveClass(/side-panel-left-collapsed/);
  await expect(page.locator("#sidePanel")).toBeVisible();
  await page.locator("#sidePanelLeftExpandButton").click();
  await expect(page.locator("body")).not.toHaveClass(/side-panel-left-collapsed/);
  await leftResizeHandle.focus();
  const leftBefore = Number(await leftResizeHandle.getAttribute("aria-valuenow"));
  await leftResizeHandle.press("Shift+ArrowRight");
  await expect.poll(async () => Number(await leftResizeHandle.getAttribute("aria-valuenow"))).toBeGreaterThan(leftBefore);
  const bothLeftWidth = Number(await leftResizeHandle.getAttribute("aria-valuenow"));
  await rightResizeHandle.focus();
  const rightBefore = Number(await rightResizeHandle.getAttribute("aria-valuenow"));
  await rightResizeHandle.press("Shift+ArrowLeft");
  await expect.poll(async () => Number(await rightResizeHandle.getAttribute("aria-valuenow"))).toBeGreaterThan(rightBefore);
  const bothRightWidth = Number(await rightResizeHandle.getAttribute("aria-valuenow"));
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-webui-control-deck-layout-v2") || "null")?.panelWidths)).toMatchObject({ left: bothLeftWidth, right: bothRightWidth });

  await openControls(page);
  await page.locator("#terminalTabsLayoutSelect").selectOption("left");
  await expect(page.locator("body")).toHaveClass(/terminal-tabs-left/);
  const placementSelect = page.locator("#controlDeckPlacementSelect");
  const bothPlacementOption = placementSelect.locator('option[value="both"]');
  await expect(placementSelect).toBeEnabled();
  await expect(bothPlacementOption).toBeDisabled();
  await expect(placementSelect).toHaveValue("right");
  await expect(page.locator("#sidePanel")).toBeVisible();
  await expect(page.locator("#sidePanelLeft")).toBeHidden();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("pi-webui-control-deck-layout-v2") || "null")?.placement)).toBe("right");

  await placementSelect.selectOption("right");
  await expect(page.locator("body")).toHaveClass(/terminal-tabs-sidebar-start/);
  await expect(page.locator("#sidePanel")).toBeVisible();
  await expect(page.locator("#sidePanelLeft")).toBeHidden();
  const rightPlacementChatBox = await page.locator(".chat").boundingBox();
  const leftRailBox = await page.locator(".terminal-tabs-shell").boundingBox();
  assert.ok(rightPlacementChatBox && leftRailBox && leftRailBox.x < rightPlacementChatBox.x, "Right Control Deck placement should switch the thread rail to the left of chat");

  await page.locator("#controlDeckPlacementSelect").selectOption("left");
  await expect(page.locator("body")).not.toHaveClass(/terminal-tabs-sidebar-start/);
  await expect(page.locator("#sidePanelLeft")).toBeVisible();
  await expect(page.locator("#sidePanel")).toBeHidden();
  const chatBox = await page.locator(".chat").boundingBox();
  const railBox = await page.locator(".terminal-tabs-shell").boundingBox();
  assert.ok(chatBox && railBox && railBox.x > chatBox.x, "Left Control Deck placement should switch the thread rail to the right of chat");
  await expect(page.locator("#controlDeckPlacementStatus")).toContainText("Control Deck left, threads right");
  const newTabButton = page.locator("#newTabButton");
  const newTabButtonBox = await newTabButton.boundingBox();
  assert.ok(newTabButtonBox && newTabButtonBox.x >= railBox.x - 1 && newTabButtonBox.x + newTabButtonBox.width <= railBox.x + railBox.width + 1, `the right-rail compose button should stay inside its rail: ${JSON.stringify({ newTabButtonBox, railBox })}`);
  await newTabButton.hover();
  await expect(page.locator("#newThreadDialog")).toBeHidden();
  await newTabButton.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#newThreadDialog")).toBeVisible();
  const paletteBox = await page.locator("#newThreadDialog").boundingBox();
  assert.ok(paletteBox && paletteBox.x >= 0 && paletteBox.x + paletteBox.width <= 2200 && paletteBox.y >= 0 && paletteBox.y + paletteBox.height <= 1000, `the new-thread palette should open without viewport clipping: ${JSON.stringify({ paletteBox })}`);
  await page.keyboard.press("Escape");
  const workspaceButton = page.locator("#workspaceDashboardToggleButton");
  await workspaceButton.hover();
  await expect.poll(() => workspaceButton.evaluate((button) => getComputedStyle(button, "::after").opacity)).toBe("1");
  await workspaceButton.focus();
  await expect.poll(() => workspaceButton.evaluate((button) => getComputedStyle(button, "::after").opacity)).toBe("1");
  await page.locator("#terminalTabsLayoutSelect").selectOption("top");
  await expect(placementSelect).toHaveValue("left");
  await expect(bothPlacementOption).toBeEnabled();
  await placementSelect.selectOption("both");

  await page.setViewportSize({ width: 1500, height: 900 });
  await expect(page.locator("body")).not.toHaveClass(/control-deck-overlay/);
  const firstTabId = await page.locator("[data-tab-id]").first().getAttribute("data-tab-id");
  assert.ok(firstTabId, "the fixture should expose a splittable terminal tab");
  await page.locator(`[data-tab-id="${firstTabId}"] .terminal-tab-split-button`).click();
  await expect(page.locator("body")).toHaveClass(/terminal-split-open/);
  await openAcceptanceFile(page);
  await expect(page.locator("body")).toHaveClass(/control-deck-overlay/);
  await expect(page.locator("body")).toHaveClass(/side-panel-collapsed/);
  await expect(page.locator("#fileViewerPane")).toBeVisible();
  await expect(page.locator("#terminalSplitShell")).toBeVisible();
  await dismissUpdateNotification(page);
  await page.locator("#fileViewerCloseButton").click();
  await expect(page.locator("body")).not.toHaveClass(/control-deck-overlay/);
  await expect(page.locator("body")).toHaveClass(/terminal-split-open/);
  await expect(page.locator("#terminalSplitShell")).toBeVisible();
  await expect(page.locator("body")).toHaveClass(/control-deck-both/);
  await expect(page.locator('#sidePanelBodyLeft > [data-side-panel-section="files"]')).toHaveCount(1);

  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator("body")).toHaveClass(/control-deck-overlay/);
  await expect(page.locator("#sidePanelLeft")).toBeHidden();
  await page.locator("#sidePanelExpandButton").click();
  await expect(page.locator("#sidePanel")).toHaveAttribute("role", "dialog");
  await expect(page.locator("#sidePanelBackdrop")).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await expect(page.locator(".workspace-column")).toHaveCSS("visibility", "hidden");
  await assertAxeClean(page, "open Control Deck overlay", "#sidePanel");
  await page.keyboard.press("Escape");
  await expect(page.locator("#sidePanelBackdrop")).toBeHidden();

  const duplicateIds = await page.locator("[id]").evaluateAll((nodes) => {
    const ids = nodes.map((node) => node.id);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds).toEqual([]);
  const brokenAria = await page.locator("[aria-controls]").evaluateAll((nodes) => nodes.flatMap((node) => (node.getAttribute("aria-controls") || "").split(/\s+/)).filter((id) => id && !document.getElementById(id)));
  expect(brokenAria).toEqual([]);

  await page.setViewportSize({ width: 2200, height: 1000 });
  await expect(page.locator("body")).toHaveClass(/control-deck-both/);
  await page.reload();
  await expect(page.locator("body")).toHaveClass(/control-deck-both/);
  await expect(page.locator('#sidePanelBodyLeft > [data-side-panel-section="files"]')).toHaveCount(1);
  await expect.poll(async () => Number(await leftResizeHandle.getAttribute("aria-valuenow"))).toBe(bothLeftWidth);
  await expect.poll(async () => Number(await rightResizeHandle.getAttribute("aria-valuenow"))).toBe(bothRightWidth);
});
