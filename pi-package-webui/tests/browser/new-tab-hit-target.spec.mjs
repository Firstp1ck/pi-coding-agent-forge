import { expect } from "@playwright/test";
import { test } from "./session-fixture.mjs";

const choiceLabels = ["No project", "Browse…", "Branch worktree…"];
test.use({ video: "off", serviceWorkers: "block", reducedMotion: "reduce" });

async function ready(page, ownership, navigation = "left") {
  await page.addInitScript(navigation => {
    localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "focused", navigation, navigationWidth: 320 }));
  }, navigation);
  await page.goto(ownership.baseURL);
  await expect(page.locator("#focusedWorkspace")).toBeVisible();
  await expect(page.locator("#focusedWorkspace")).toHaveAttribute("data-navigation", navigation);
  await expect(page.locator("#statusBar")).toContainText("fake-model");
  await expect(page.locator("#promptInput")).toBeEditable();
  await page.locator("#newTabButton").scrollIntoViewIfNeeded();
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: "image/png" });
}

function paletteOption(page, label) {
  return page.locator("#newThreadList").getByRole("option", { name: new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
}

async function expectPaletteFits(page) {
  const dialog = page.locator("#newThreadDialog");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#newThreadInput")).toBeFocused();
  const box = await dialog.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  for (const label of choiceLabels) {
    const option = paletteOption(page, label);
    await option.scrollIntoViewIfNeeded();
    // Fractional rem heights can leave a sub-pixel sliver under the scrolled list edge.
    await expect(option).toBeInViewport({ ratio: 0.98 });
    await option.click({ trial: true });
  }
  expect(await page.locator("#newThreadList").evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  return box;
}

async function expectPaletteKeyboard(page, trigger) {
  const options = page.locator("#newThreadList [role='option']");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  const count = await options.count();
  for (let index = 1; index < count; index++) {
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(index)).toHaveAttribute("aria-selected", "true");
  }
  await page.keyboard.press("ArrowDown");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(options.last()).toHaveAttribute("aria-selected", "true");
  await expect(options.last()).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#newThreadInput")).toHaveAttribute("aria-activedescendant", await options.last().getAttribute("id"));
  await page.keyboard.press("Escape");
  await expect(page.locator("#newThreadDialog")).toBeHidden();
  await expect(trigger).toBeFocused();
}

for (const view of [
  { name: "desktop-sidebar", navigation: "left", width: 1440, height: 900 },
  { name: "desktop-top", navigation: "top", width: 1280, height: 800 },
  { name: "constrained-sidebar", navigation: "left", width: 1100, height: 450 },
  { name: "short-top", navigation: "top", width: 1100, height: 220 },
]) {
  test(`${view.name}: only the visible compose button opens a palette that fits`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: view.width, height: view.height });
    await ready(page, ownership, view.navigation);
    const trigger = page.locator("#newTabButton");
    await expect(trigger).toHaveAccessibleName("New thread");
    await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    const wrapper = await page.locator("#newTabMenu").boundingBox();
    const button = await trigger.boundingBox();
    const row = await page.locator("#tabBar").boundingBox();
    await capture(page, info, `${view.name}-closed`);
    expect(Math.abs(wrapper.width - button.width), JSON.stringify({ wrapper, button, row })).toBeLessThanOrEqual(1);
    expect(Math.abs(wrapper.height - button.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(button.width - button.height), "the icon button stays square").toBeLessThanOrEqual(1);
    const empty = { x: view.navigation === "left" ? row.x + row.width - 8 : view.width - 20, y: button.y + button.height / 2 };
    expect(empty.x).toBeGreaterThan(button.x + button.width + 2);
    expect(await page.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest("#newTabMenu"), empty)).toBe(false);
    await page.mouse.click(empty.x, empty.y);
    await expect(page.locator("#newThreadDialog")).toBeHidden();
    await trigger.hover();
    await expect(page.locator("#newThreadDialog"), "hovering never opens the palette").toBeHidden();

    await trigger.click();
    await expectPaletteFits(page);
    await capture(page, info, view.name);
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();

    await trigger.press("Enter");
    await expectPaletteFits(page);
    await expectPaletteKeyboard(page, trigger);
    await trigger.press(" ");
    await expect(page.locator("#newThreadDialog")).toBeVisible();
    await page.locator("#newThreadCloseButton").click();
    await expect(page.locator("#newThreadDialog")).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}

test("an open palette stays inside the viewport on resize", async ({ page, ownership }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page, ownership);
  await page.locator("#newTabButton").click();
  await expectPaletteFits(page);
  await page.setViewportSize({ width: 1100, height: 450 });
  await expectPaletteFits(page);
  await page.keyboard.press("Escape");
  await expect(page.locator("#newTabButton")).toBeFocused();
});

test("all choices retain their targets and folder choices create only browser drafts", async ({ page, ownership }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page, ownership);
  const selected = await page.locator('#tabBar [role="tab"][aria-selected="true"]').evaluate(node => node.closest('[data-tab-id]').dataset.tabId);
  const source = (await ownership.api("/api/tabs")).tabs.find(tab => tab.id === selected);
  await page.locator("#promptInput").fill("Keep the source composer");
  await page.locator("#newTabButton").click();
  await paletteOption(page, "Browse…").click();
  await expect(page.locator("#pathPickerDialog")).toBeVisible();
  await page.locator("#pathPickerCancelButton").click();
  await expect(page.locator("#newTabButton")).toBeFocused();
  await expect(page.locator("#newThreadDialog")).toBeHidden();
  await page.locator("#newTabButton").click();
  await paletteOption(page, "Branch worktree…").click();
  await expect(page.getByRole("listbox", { name: "Git branches and worktrees" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Git branches and worktrees" })).toBeHidden();
  await expect(page.locator("#promptInput")).toHaveValue("Keep the source composer");

  await page.locator("#newTabButton").press("Enter");
  await page.keyboard.press("ArrowDown");
  await expect(paletteOption(page, "No project")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page.locator(".focused-context")).toHaveText("No Project");
  await expect(page.locator("#promptInput")).toHaveValue("");
  await expect(page.locator("#promptInput")).toBeFocused();
  expect((await ownership.api("/api/tabs")).tabs).toHaveLength(2);
  await page.locator("#promptInput").fill("T7 browser-only draft");
  await page.locator("#newTabButton").click();
  await paletteOption(page, "No project").click();
  await expect(page.locator("[data-draft-id]")).toHaveCount(1);
  expect((await ownership.api("/api/tabs")).tabs).toHaveLength(2);
  await page.locator(`#tabBar [data-tab-id="${selected}"] .terminal-tab-button`).click();
  await expect(page.locator("#promptInput")).toHaveValue("Keep the source composer");
  await page.locator("#newTabButton").click();
  await expect(page.locator("#newThreadList [role='option']").first()).toContainText("Current");
  await page.locator("#newThreadList [role='option']").first().click();
  await expect(page.locator(".empty-start-workspace-button")).toHaveText(source.cwd);
  await expect(page.locator(".focused-context")).toHaveText(source.cwd);
  await expect(page.locator('#tabBar [data-tab-id] [role="tab"]')).toHaveCount(2);
  expect((await ownership.api("/api/tabs")).tabs).toHaveLength(2);
  await expect(page.locator("[data-draft-id]")).toHaveCount(1);
});

for (const view of [{ width: 390, height: 844 }, { width: 320, height: 360 }]) {
  test(`narrow ${view.width}x${view.height}: the drawer button opens a palette that fits`, async ({ page, ownership }, info) => {
    await page.setViewportSize(view);
    await page.goto(ownership.baseURL);
    await expect(page.locator("#statusBar")).toContainText("fake-model");
    await page.locator("#terminalTabsToggleButton").click();
    await expect(page.locator("#terminalTabsDrawerContent")).toBeVisible();
    const trigger = page.locator("#newTabButton");
    await trigger.scrollIntoViewIfNeeded();
    const button = await trigger.boundingBox();
    const wrapper = await page.locator("#newTabMenu").boundingBox();
    expect(button.width, "the mobile control size is the touch target").toBeGreaterThanOrEqual(40);
    expect(Math.abs(button.width - button.height)).toBeLessThanOrEqual(1);
    expect(wrapper.x).toBeLessThanOrEqual(button.x);
    await capture(page, info, `narrow-${view.width}x${view.height}-closed`);
    const row = await page.locator("#tabBar").boundingBox();
    const empty = { x: Math.min(view.width - 20, row.x + row.width - 8), y: button.y + button.height / 2 };
    expect(empty.x).toBeGreaterThan(button.x + button.width);
    expect(await page.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest("#newTabButton"), empty)).toBe(false);
    await page.mouse.click(empty.x, empty.y);
    await expect(page.locator("#newThreadDialog")).toBeHidden();
    await expect(page.locator("#terminalTabsDrawerContent")).toBeVisible();
    await trigger.click();
    await expectPaletteFits(page);
    await expect(page.locator("#terminalTabsDrawerContent"), "the palette replaces the drawer").toBeHidden();
    await capture(page, info, `narrow-${view.width}x${view.height}`);
    await page.keyboard.press("End");
    await expect(page.locator("#newThreadList [role='option']").last()).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    await expect(page.locator("#newThreadDialog")).toBeHidden();
    await expect(page.locator("#terminalTabsToggleButton"), "focus returns to the drawer toggle the palette replaced").toBeFocused();
  });
}

for (const placement of ["left", "right"]) {
  test(`Classic ${placement} sidebar keeps the compose button and a complete palette`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "classic" })));
    await page.goto(ownership.baseURL);
    await expect(page.locator("#statusBar")).toContainText("fake-model");
    await page.locator("#terminalTabsLayoutSelect").selectOption("left", { force: true });
    await page.locator("#controlDeckPlacementSelect").selectOption(placement, { force: true });
    await expect(page.locator("body")).toHaveClass(/terminal-tabs-left/);
    const trigger = page.locator("#newTabButton");
    await trigger.scrollIntoViewIfNeeded();
    await expect(trigger).toBeInViewport({ ratio: 1 });
    await trigger.hover();
    await expect(trigger).toHaveCSS("transform", "none");
    await capture(page, info, `classic-${placement}-hover`);
    await trigger.focus();
    await trigger.press("Enter");
    await expectPaletteFits(page);
    await page.keyboard.press("Escape");
    await expect(page.locator("#newThreadDialog")).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
