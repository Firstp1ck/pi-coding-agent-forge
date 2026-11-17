import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");
const HIDDEN_IDS_KEY = "pi-webui-control-visibility-hidden-ids-v1";
const MENU_SELECTOR = "#visibilityContextMenu";

let child;
let baseURL;
let port;
let tempRoot;
let settingsFile;
let output = "";

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer() {
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
      PI_WEBUI_SETTINGS_FILE: settingsFile,
    },
  });
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) });
      if (response.ok) return;
    } catch {
      // Wait for the fixture server to start.
    }
    await delay(100);
  }
  throw new Error(`Pi Web UI did not start:\n${output}`);
}

async function stopServer() {
  const stoppingChild = child;
  if (!stoppingChild || stoppingChild.exitCode !== null) return;
  const exited = new Promise((resolve) => stoppingChild.once("exit", resolve));
  stoppingChild.kill("SIGTERM");
  await Promise.race([
    exited,
    delay(5_000).then(() => {
      if (stoppingChild.exitCode === null) stoppingChild.kill("SIGKILL");
      return exited;
    }),
  ]);
}

async function hiddenIdsOnDisk() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const settings = JSON.parse(await readFile(settingsFile, "utf8"));
      const hiddenIds = settings?.uiLayout?.controlVisibility?.hiddenIds;
      if (hiddenIds !== undefined) return Array.isArray(hiddenIds) ? hiddenIds : hiddenIds;
    } catch {
      // The settings file may be replaced atomically during the write.
    }
    await delay(100);
  }
  return undefined;
}

async function hiddenIdsInLocal(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), HIDDEN_IDS_KEY);
}

async function openAreaMenu(page) {
  // Dispatch on marked header padding so responsive Control Deck overlays do
  // not make the empty-area recovery path flaky in the browser harness.
  await page.locator('.side-panel-header[data-visibility-region="control-deck"]').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: rect.left + 4,
      clientY: rect.top + 4,
    }));
  });
  return page.locator(MENU_SELECTOR);
}

async function dispatchAreaMenuAt(page, clientX, clientY) {
  await page.locator(".composer-row").evaluate((element, point) => {
    element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: point.clientX,
      clientY: point.clientY,
    }));
  }, { clientX, clientY });
  return page.locator(MENU_SELECTOR);
}

async function suppressUnrelatedOverlays(page) {
  await page.addStyleTag({ content: "#optionalFeatureMigrationSurface, #updateNotification { display: none !important; }" });
}

async function openSetupFromDirect(page, selector) {
  const menu = page.locator(MENU_SELECTOR);
  await page.locator(selector).click({ button: "right" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Open setup" }).click();
  await expect(menu).toBeHidden();
  const dialog = page.locator("#controlVisibilitySetupDialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-control-visibility-"));
  settingsFile = join(tempRoot, "settings.json");
  await writeFile(settingsFile, "{}", "utf8");
  await mkdir(join(tempRoot, "agent"), { recursive: true });
  port = await freePort();
  baseURL = `http://127.0.0.1:${port}`;
  await startServer();
});

test.afterAll(async () => {
  await stopServer();
  await rm(tempRoot, { recursive: true, force: true });
});

test("setup dialog covers the catalog, immediate durability, quick actions, focus, gating, and narrow viewports", async ({ page }) => {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await suppressUnrelatedOverlays(page);
  const menu = page.locator(MENU_SELECTOR);
  const optionsButton = page.locator("#optionsMenuButton");
  const optionsAction = page.locator('[data-composer-action-id="options"]');

  // The grouped area menu opens setup and its non-focusable host uses the
  // prompt fallback when setup closes.
  await openAreaMenu(page);
  await menu.getByRole("menuitem", { name: "Open setup" }).click();
  let dialog = page.locator("#controlVisibilitySetupDialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#promptInput")).toBeFocused();

  // Wrapped controls preserve the actual inner button for pointer and keyboard
  // invocation instead of retaining their non-focusable catalog wrapper.
  dialog = await openSetupFromDirect(page, "#optionsMenuButton");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(optionsButton).toBeFocused();

  await optionsButton.focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Open setup" }).focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(optionsButton).toBeFocused();

  // If setup hides the wrapped catalog root, its inner button is no longer a
  // surviving return target and focus falls back safely to the prompt.
  dialog = await openSetupFromDirect(page, "#optionsMenuButton");
  await dialog.getByLabel("Show Common options").uncheck();
  await expect(optionsAction).toHaveClass(/webui-user-hidden/);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#promptInput")).toBeFocused();
  await openAreaMenu(page);
  await menu.getByRole("menuitem", { name: "Reset defaults" }).click();
  await expect(optionsAction).not.toHaveClass(/webui-user-hidden/);
  await expect.poll(hiddenIdsOnDisk).toBe(null);

  // A direct visibility menu opens the generated setup and transfers focus.
  dialog = await openSetupFromDirect(page, "#newSessionButton");
  await expect(dialog.getByRole("checkbox")).toHaveCount(24);
  await expect(dialog.getByRole("group")).toHaveCount(5);
  assert.deepEqual(
    await dialog.getByRole("group").evaluateAll((groups) => groups.map((group) => group.querySelector("legend")?.textContent?.trim())),
    ["Workspace toolbar", "Control Deck", "Composer actions", "Input-frame controls", "Input-frame tags"],
    "setup groups should follow the approved catalog order",
  );
  await expect(dialog.locator('[data-visibility-setup-id="composer.send"]')).toHaveCount(0);
  await expect(dialog.getByText("Send", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Show Save workspace")).toBeFocused();

  // Simulate runtime capability gating deterministically: preference application
  // may toggle only its class and must leave the capability-owned hidden state intact.
  const gitButton = page.locator('[data-composer-action-id="git"]');
  await expect(dialog.getByLabel("Show Guided Git workflow")).toBeChecked();
  await gitButton.evaluate((element) => { element.hidden = true; });
  await expect(gitButton).toBeHidden();

  // Escape follows the native dialog close path and restores a surviving opener.
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#newSessionButton")).toBeFocused();

  // Hiding the invoking control persists immediately and makes Close use the prompt fallback.
  dialog = await openSetupFromDirect(page, "#attachButton");
  const attachToggle = dialog.getByLabel("Show Attach files");
  await attachToggle.uncheck();
  await expect(page.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
  assert.deepEqual(await hiddenIdsInLocal(page), ["input.attach-files"], "setup changes should update the local cache immediately");
  await expect.poll(hiddenIdsOnDisk).toEqual(["input.attach-files"]);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#promptInput")).toBeFocused();

  // Reload from durable settings, not the browser cache, and synchronize the setup checkbox.
  await page.evaluate((key) => localStorage.removeItem(key), HIDDEN_IDS_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await suppressUnrelatedOverlays(page);
  await expect(page.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
  dialog = await openSetupFromDirect(page, "#newSessionButton");
  await expect(dialog.getByLabel("Show Attach files")).not.toBeChecked();

  // Reapply the simulated capability state after reload, which replaced the DOM.
  await gitButton.evaluate((element) => { element.hidden = true; });
  await expect(gitButton).toBeHidden();

  // Setup quick actions preserve the [] versus null contract and refresh all toggles.
  await dialog.getByRole("button", { name: "Show all" }).click();
  await expect.poll(() => dialog.getByRole("checkbox").evaluateAll((checkboxes) => checkboxes.every((checkbox) => checkbox.checked))).toBe(true);
  assert.deepEqual(await hiddenIdsInLocal(page), [], "Show all should persist an explicit empty list");
  await expect.poll(hiddenIdsOnDisk).toEqual([]);
  assert.ok(await gitButton.evaluate((element) => element.hidden), "Show all must not clear capability-owned hidden state");

  await dialog.getByRole("button", { name: "Reset defaults" }).click();
  await expect.poll(() => dialog.getByRole("checkbox").evaluateAll((checkboxes) => checkboxes.every((checkbox) => checkbox.checked))).toBe(true);
  assert.equal(await hiddenIdsInLocal(page), null, "Reset defaults should clear the preference to null");
  await expect.poll(hiddenIdsOnDisk).toBe(null);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.locator("#newSessionButton")).toBeFocused();

  // A short viewport keeps the dialog bounded, its persistent actions usable,
  // and the full generated catalog reachable through an independently scrolling body.
  dialog = await openSetupFromDirect(page, "#newSessionButton");
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(dialog.getByRole("button", { name: "Show all" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Reset defaults" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Close" })).toBeVisible();
  const dialogBounds = await dialog.boundingBox();
  assert.ok(dialogBounds.x >= 0 && dialogBounds.y >= 0, "the setup should not overflow the top or left viewport edges");
  assert.ok(dialogBounds.x + dialogBounds.width <= 360 && dialogBounds.y + dialogBounds.height <= 640, "the setup should remain bounded by the narrow viewport");
  assert.ok(await dialog.locator("#controlVisibilitySetupBody").evaluate((body) => body.scrollHeight > body.clientHeight), "the setup catalog should scroll within its bounded body");
  await dialog.locator("#controlVisibilitySetupBody").evaluate((body) => { body.scrollTop = body.scrollHeight; });
  await expect(dialog.getByLabel("Show Workflow-mode tag")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await expect(menu).toBeHidden();
});

test("grouped area menu, direct hide, recovery, persistence, gating, Send exclusion, keyboard", async ({ page }) => {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await suppressUnrelatedOverlays(page);
  await expect(page.locator("#sendButton")).toBeVisible();

  // Seed a saved grid so visibility changes must project a dense visible layout.
  await page.evaluate(() => {
    localStorage.setItem("pi-webui-composer-action-layout-v2", JSON.stringify({
      version: 2,
      columns: 4,
      positions: { new: 0, compact: 1, options: 3, send: 6 },
    }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await suppressUnrelatedOverlays(page);
  const optionsAction = page.locator('[data-composer-action-id="options"]');
  const compactAction = page.locator('[data-composer-action-id="compact"]');
  const newAction = page.locator('[data-composer-action-id="new"]');
  await expect.poll(() => optionsAction.evaluate((element) => Number(element.style.getPropertyValue("--composer-action-grid-column")))).toBeGreaterThan(1);
  await expect.poll(() => newAction.evaluate((element) => Number(element.style.getPropertyValue("--composer-action-grid-column")))).toBeGreaterThan(0);
  const initialOptionsColumn = Number(await optionsAction.evaluate((element) => element.style.getPropertyValue("--composer-action-grid-column")));
  const initialCompactColumn = Number(await compactAction.evaluate((element) => element.style.getPropertyValue("--composer-action-grid-column")));
  const initialNewColumn = Number(await newAction.evaluate((element) => element.style.getPropertyValue("--composer-action-grid-column")));

  // Send and editable controls are not region-menu proxies.
  const menu = page.locator(MENU_SELECTOR);
  await page.locator("#sendButton").click({ button: "right" });
  await expect(menu).toBeHidden();
  await page.locator("#promptInput").click({ button: "right" });
  await expect(menu).toBeHidden();

  // Open submenu contents keep their specialized context behavior even though
  // their registered composer wrapper is an ancestor.
  await page.locator("#optionsMenuButton").click();
  await expect(page.locator("#optionsMenu")).toBeVisible();
  await page.locator("#optionsSettingsButton").click({ button: "right" });
  await expect(menu).toBeHidden();
  await page.keyboard.press("Escape");

  // Empty marked area opens the complete grouped catalog.
  await openAreaMenu(page);
  await expect(menu).toBeVisible();
  const checkboxes = menu.locator('[role="menuitemcheckbox"]');
  await expect(checkboxes).toHaveCount(24);
  await expect.poll(async () => checkboxes.evaluateAll((items) => items.map((item) => item.getAttribute("aria-checked")))).toEqual(Array(24).fill("true"));
  await expect(menu.getByRole("menuitem", { name: "Show all" })).toHaveCount(1);
  await expect(menu.getByRole("menuitem", { name: "Reset defaults" })).toHaveCount(1);
  await expect(menu.locator('[data-visibility-menu-toggle="composer.send"]')).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  // Non-focusable region hosts restore focus to the prompt fallback on Escape.
  await expect(page.locator("#promptInput")).toBeFocused();

  // Direct hide applies immediately and reflows the sparse composer grid.
  await page.locator("#newSessionButton").click({ button: "right" });
  await expect(menu).toContainText("Hide New");
  await menu.locator('[data-visibility-menu-action="hide"]').click();
  await expect(page.locator("#newSessionButton")).toHaveClass(/webui-user-hidden/);
  await expect(page.locator("#promptInput")).toBeFocused();
  await expect.poll(() => compactAction.evaluate((element) => Number(element.style.getPropertyValue("--composer-action-grid-column")))).toBeLessThan(initialCompactColumn);
  assert.ok(Number(await optionsAction.evaluate((element) => element.style.getPropertyValue("--composer-action-grid-column"))) > 0, "repacked actions should keep a positive dense slot");
  assert.deepEqual(await hiddenIdsInLocal(page), ["composer.new"], "direct hide should persist locally first");
  await expect.poll(async () => (await hiddenIdsOnDisk())?.slice?.().sort?.()).toEqual(["composer.new"]);

  // Simulate runtime capability gating deterministically before preferences show all.
  const gitButton = page.locator('[data-composer-action-id="git"]');
  await gitButton.evaluate((element) => { element.hidden = true; });
  await openAreaMenu(page);
  assert.ok(await gitButton.evaluate((element) => element.hidden), "capability-hidden controls keep the hidden attribute");
  await menu.getByRole("menuitem", { name: "Show all" }).click();
  await expect(page.locator("#newSessionButton")).not.toHaveClass(/webui-user-hidden/);
  // Un-hiding must schedule a restore that returns actions to their saved slots.
  await expect.poll(() => newAction.evaluate((element) => Number(element.style.getPropertyValue("--composer-action-grid-column")))).toBe(initialNewColumn);
  await expect.poll(() => optionsAction.evaluate((element) => Number(element.style.getPropertyValue("--composer-action-grid-column")))).toBe(initialOptionsColumn);
  assert.deepEqual(await hiddenIdsInLocal(page), [], "Show all should persist an explicit empty list");
  assert.ok(await gitButton.evaluate((element) => element.hidden), "Show all must not clear runtime hidden gating");

  // Reset defaults is distinct from Show all: null vs [].
  await openAreaMenu(page);
  await menu.getByRole("menuitem", { name: "Reset defaults" }).click();
  assert.equal(await hiddenIdsInLocal(page), null, "Reset defaults should clear hiddenIds to null");
  await expect.poll(hiddenIdsOnDisk).toBe(null);

  // Shift+F10 supports complete menu navigation and restores surviving focus.
  await page.locator("#attachButton").focus();
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Reset defaults" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem", { name: "Hide Attach files" })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator("#attachButton")).toBeFocused();

  // The Context Menu key plus Enter performs direct hide. A hidden trigger
  // returns focus to the safe prompt fallback.
  await page.keyboard.press("ContextMenu");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
  await expect(page.locator("#promptInput")).toBeFocused();
  await expect.poll(hiddenIdsOnDisk).toEqual(["input.attach-files"]);

  // Prove reload recovery comes from durable settings rather than only cache.
  await page.evaluate((key) => localStorage.removeItem(key), HIDDEN_IDS_KEY);
  await page.reload({ waitUntil: "domcontentloaded" });
  await suppressUnrelatedOverlays(page);
  await expect(page.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
  await expect(page.locator("#sendButton")).toBeVisible();

  // Area recovery remains available and tag categories toggle independently.
  await openAreaMenu(page);
  const attachToggle = menu.locator('[data-visibility-menu-toggle="input.attach-files"]');
  await expect(attachToggle).toHaveAttribute("aria-checked", "false");
  await attachToggle.click();
  await expect(attachToggle).toHaveAttribute("aria-checked", "true");
  await expect(page.locator("#attachButton")).not.toHaveClass(/webui-user-hidden/);
  const tagsToggle = menu.locator('[data-visibility-menu-toggle="tag.skills"]');
  await tagsToggle.click();
  await expect(page.locator("#sessionSkillTags")).toHaveClass(/webui-user-hidden/);
  assert.deepEqual(await hiddenIdsInLocal(page), ["tag.skills"], "each tag category toggles independently");
  await page.locator("#promptInput").click();
  await expect(menu).toBeHidden();

  // Coordinates beyond the viewport are clamped into the visible page.
  const viewport = page.viewportSize();
  await dispatchAreaMenuAt(page, viewport.width + 500, viewport.height + 500);
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0, "menu should not overflow the top or left viewport edges");
  assert.ok(bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height, "menu should remain inside the viewport");
  await page.keyboard.press("Escape");
});

test("keyboard-only recovery from Send after every catalog item is hidden", async ({ page }) => {
  await page.goto(baseURL, { waitUntil: "domcontentloaded" });
  await suppressUnrelatedOverlays(page);
  const menu = page.locator(MENU_SELECTOR);
  await expect(page.locator("#sendButton")).toHaveAttribute("aria-keyshortcuts", /Shift\+F10/);

  // Hide every catalog item through the grouped area menu (setup may use the
  // pointer; only the recovery below must be keyboard-only).
  await openAreaMenu(page);
  await expect(menu).toBeVisible();
  const checkboxes = menu.locator('[role="menuitemcheckbox"]');
  await expect(checkboxes).toHaveCount(24);
  for (let index = 0; index < 24; index += 1) {
    const item = checkboxes.nth(index);
    // Hiding controls can shift the layout and legitimately auto-dismiss the
    // menu on the resulting scroll, so drive the same click handler directly.
    if ((await item.getAttribute("aria-checked")) === "true") await item.dispatchEvent("click");
  }
  await expect.poll(async () => checkboxes.evaluateAll((items) => items.map((item) => item.getAttribute("aria-checked")))).toEqual(Array(24).fill("false"));
  await expect.poll(async () => (await hiddenIdsInLocal(page))?.length).toBe(24);
  if (!(await menu.isHidden())) await page.keyboard.press("Escape");
  await expect(page.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
  await expect(page.locator("#newSessionButton")).toHaveClass(/webui-user-hidden/);
  await expect(page.locator("#sendButton")).toBeVisible();

  // Keyboard-only recovery: the Context Menu key on Send opens the grouped
  // menu even though no optional control remains visible.
  await page.locator("#sendButton").focus();
  await page.keyboard.press("ContextMenu");
  await expect(menu).toBeVisible();
  await expect(menu.locator('[role="menuitemcheckbox"]')).toHaveCount(24);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator("#sendButton")).toBeFocused();

  // Shift+F10 opens the same menu; activate Show all without touching the pointer.
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Reset defaults" })).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(menu.getByRole("menuitem", { name: "Show all" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(page.locator("#sendButton")).toBeFocused();

  // Every catalog item is restored and the explicit show-all state persists.
  assert.deepEqual(await hiddenIdsInLocal(page), [], "Show all should persist an explicit empty list");
  await expect(page.locator("#attachButton")).not.toHaveClass(/webui-user-hidden/);
  await expect(page.locator("#newSessionButton")).not.toHaveClass(/webui-user-hidden/);
  await expect(page.locator("#sessionSkillTags")).not.toHaveClass(/webui-user-hidden/);
  await openAreaMenu(page);
  await expect.poll(async () => checkboxes.evaluateAll((items) => items.map((item) => item.getAttribute("aria-checked")))).toEqual(Array(24).fill("true"));
  await page.keyboard.press("Escape");
  // The next serial case reads the same server settings. Do not close this
  // page while its final Show all write is still queued behind earlier toggles.
  await expect.poll(hiddenIdsOnDisk).toEqual([]);
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage)
    .filter((key) => key.startsWith("pi-webui-ui-layout-pending")).length)).toBe(0);
});

test("pending visibility mutation survives same-origin cache adoption and rewrites the cache after acknowledgment", async ({ browser }) => {
  const context = await browser.newContext();
  const page1 = await context.newPage();
  const page2 = await context.newPage();
  try {
    await page1.goto(baseURL, { waitUntil: "domcontentloaded" });
    await suppressUnrelatedOverlays(page1);
    await page2.goto(baseURL, { waitUntil: "domcontentloaded" });
    await suppressUnrelatedOverlays(page2);

    // Hold page1's first layout PUT so its visibility mutation stays dirty.
    let heldRoute = null;
    await page1.route("**/api/interface-preferences", async (route) => {
      if (route.request().method() === "PUT" && !heldRoute) {
        heldRoute = route;
        return;
      }
      await route.continue();
    });

    // Page 1 hides Attach files; the save is intercepted before acknowledgment.
    await page1.locator("#attachButton").click({ button: "right" });
    await page1.locator(MENU_SELECTOR).locator('[data-visibility-menu-action="hide"]').click();
    await expect(page1.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
    await expect.poll(() => heldRoute !== null, { message: "page 1's visibility PUT should be held" }).toBe(true);

    // Page 2 adopts page 1's cache, then hides a tag category and saves
    // successfully; its cache write fires a same-origin storage event in page 1.
    await openAreaMenu(page2);
    await page2.locator(MENU_SELECTOR).locator('[data-visibility-menu-toggle="tag.skills"]').click();
    await page2.keyboard.press("Escape");
    await expect.poll(async () => hiddenIdsInLocal(page2)).toEqual(["input.attach-files", "tag.skills"]);
    await expect.poll(hiddenIdsOnDisk).toEqual(["input.attach-files", "tag.skills"]);

    // Page 1 keeps showing its own pending mutation instead of adopting the
    // incoming cache: Attach stays hidden and skill tags stay visible. The
    // grouped menu must use that same dirty set, not the overwritten cache.
    await delay(500);
    await expect(page1.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
    await expect(page1.locator("#sessionSkillTags")).not.toHaveClass(/webui-user-hidden/);
    const page1Menu = await openAreaMenu(page1);
    await expect(page1Menu.locator('[data-visibility-menu-toggle="input.attach-files"]')).toHaveAttribute("aria-checked", "false");
    await expect(page1Menu.locator('[data-visibility-menu-toggle="tag.skills"]')).toHaveAttribute("aria-checked", "true");
    await page1Menu.locator('[data-visibility-menu-toggle="tag.skills"]').click();
    await expect(page1.locator("#sessionSkillTags")).toHaveClass(/webui-user-hidden/);
    await page1.keyboard.press("Escape");
    await expect.poll(async () => hiddenIdsInLocal(page1)).toEqual(["input.attach-files", "tag.skills"]);

    // Release the held write. The stale revision retries once; after the
    // acknowledged PUT page 1 rewrites its value into the same-origin cache.
    await heldRoute.continue();
    await expect.poll(hiddenIdsOnDisk).toEqual(["input.attach-files", "tag.skills"]);
    await expect.poll(async () => hiddenIdsInLocal(page1)).toEqual(["input.attach-files", "tag.skills"]);
    await expect(page1.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
    await expect(page1.locator("#sessionSkillTags")).toHaveClass(/webui-user-hidden/);

    // Page 2 adopts the acknowledged value through the storage event and the
    // pending journal no longer holds a visibility mutation in either tab.
    await expect.poll(async () => page2.locator("#sessionSkillTags").evaluate((element) => element.classList.contains("webui-user-hidden"))).toBe(true);
    await expect(page2.locator("#attachButton")).toHaveClass(/webui-user-hidden/);
    await expect.poll(async () => page1.evaluate(() => Object.entries(localStorage)
      .filter(([key]) => key.startsWith("pi-webui-ui-layout-pending"))
      .filter(([, raw]) => { try { return JSON.parse(raw)?.field === "controlVisibility"; } catch { return false; } })
      .map(([key]) => key))).toEqual([]);
  } finally {
    await context.close();
  }
});
