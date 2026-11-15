import { expect } from "@playwright/test";
import { test } from "./session-fixture.mjs";

const choices = ["newTabNoProjectButton", "newTabCurrentDirectoryButton", "newTabChooseDirectoryButton", "newTabWorktreeButton"];
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

async function expectMenuFits(page) {
  const panel = page.locator("#newTabMenuPanel");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(4);
  expect(box.y).toBeGreaterThanOrEqual(4);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 3);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 3);
  for (const id of choices) {
    await page.locator(`#${id}`).scrollIntoViewIfNeeded();
    await expect(page.locator(`#${id}`)).toBeInViewport({ ratio: 1 });
    await page.locator(`#${id}`).click({ trial: true });
  }
  expect(await panel.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  return box;
}

for (const view of [
  { name: "desktop-sidebar", navigation: "left", width: 1440, height: 900 },
  { name: "desktop-top", navigation: "top", width: 1280, height: 800 },
  { name: "constrained-sidebar", navigation: "left", width: 1100, height: 450 },
  { name: "short-top", navigation: "top", width: 1100, height: 220 },
]) {
  test(`${view.name}: only the visible button opens a content-sized menu`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: view.width, height: view.height });
    await ready(page, ownership, view.navigation);
    const trigger = page.locator("#newTabButton");
    const wrapper = await page.locator("#newTabMenu").boundingBox();
    const button = await trigger.boundingBox();
    const row = await page.locator("#tabBar").boundingBox();
    await capture(page, info, `${view.name}-closed`);
    expect(Math.abs(wrapper.width - button.width), JSON.stringify({ wrapper, button, row })).toBeLessThanOrEqual(1);
    expect(Math.abs(wrapper.height - button.height)).toBeLessThanOrEqual(1);
    const empty = { x: view.navigation === "left" ? row.x + row.width - 8 : view.width - 20, y: button.y + button.height / 2 };
    expect(empty.x).toBeGreaterThan(button.x + button.width + 2);
    expect(await page.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest("#newTabMenu"), empty)).toBe(false);
    await page.mouse.move(empty.x, empty.y);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#newTabMenuPanel")).toBeHidden();
    await page.mouse.click(empty.x, empty.y);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#newTabMenuPanel")).toBeHidden();

    await trigger.hover();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const panel = await expectMenuFits(page);
    expect(panel.width).toBeGreaterThanOrEqual(button.width);
    expect(panel.y >= button.y + button.height - 1 || panel.y + panel.height <= button.y + 1).toBe(true);
    if (view.navigation === "left") expect(panel.width).toBeLessThan(row.width - 20);
    expect(Math.abs(panel.x - Math.max(4, Math.min(button.x, view.width - panel.width - 4)))).toBeLessThanOrEqual(1);
    await capture(page, info, view.name);

    // Cross the shared trigger/menu edge with real pointer movement, including the wider menu area.
    const below = panel.y >= button.y + button.height - 1;
    const bridgeX = button.x + button.width / 2;
    await page.mouse.move(bridgeX, below ? button.y + button.height - 1 : button.y + 1);
    await page.mouse.move(bridgeX, below ? panel.y + 1 : panel.y + panel.height - 1, { steps: 8 });
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    for (const id of choices) {
      await page.locator(`#${id}`).hover();
      await expect(trigger).toHaveAttribute("aria-expanded", "true");
    }
    await page.mouse.move(view.width - 5, view.height - 5);
    await expect(page.locator("#newTabMenuPanel")).toBeHidden();

    await trigger.focus();
    await trigger.press("ArrowDown");
    await expect(page.locator(`#${choices[0]}`)).toBeFocused();
    for (const id of choices.slice(1)) {
      await page.keyboard.press("ArrowDown");
      await expect(page.locator(`#${id}`)).toBeFocused();
    }
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(`#${choices[0]}`)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(`#${choices.at(-1)}`)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator(`#${choices[0]}`)).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.locator(`#${choices.at(-1)}`)).toBeFocused();
    await expect(page.locator(`#${choices.at(-1)}`)).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(page.locator("#newTabMenuPanel")).toBeHidden();
    await trigger.press("ArrowUp");
    await expect(page.locator(`#${choices.at(-1)}`)).toBeFocused();
    await expect(page.locator(`#${choices.at(-1)}`)).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    await trigger.click();
    await expectMenuFits(page);
    await page.locator("#promptInput").click({ position: { x: 12, y: 12 } });
    await expect(page.locator("#newTabMenuPanel")).toBeHidden();
  });
}

test("an open menu remeasures its contents on viewport resize", async ({ page, ownership }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await ready(page, ownership);
  await page.locator("#newTabButton").focus();
  const original = await expectMenuFits(page);
  await page.setViewportSize({ width: 1100, height: 450 });
  const resized = await expectMenuFits(page);
  expect(Math.abs(original.width - resized.width)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(page.locator("#newTabButton")).toBeFocused();
});

test("all choices retain their targets and No Project creates only a browser draft", async ({ page, ownership }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await ready(page, ownership);
  const selected = await page.locator('#tabBar [role="tab"][aria-selected="true"]').evaluate(node => node.closest('[data-tab-id]').dataset.tabId);
  const source = (await ownership.api("/api/tabs")).tabs.find(tab => tab.id === selected);
  await page.locator("#promptInput").fill("Keep the source composer");
  await page.locator("#newTabButton").click();
  await page.locator("#newTabChooseDirectoryButton").click();
  await expect(page.locator("#pathPickerDialog")).toBeVisible();
  await page.locator("#pathPickerCancelButton").click();
  await expect(page.locator("#newTabButton")).toBeFocused();
  await expect(page.locator("#newTabMenuPanel")).toBeHidden();
  await page.locator("#newTabButton").click();
  await page.locator("#newTabWorktreeButton").click();
  await expect(page.getByRole("listbox", { name: "Git branches and worktrees" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox", { name: "Git branches and worktrees" })).toBeHidden();
  await expect(page.locator("#promptInput")).toHaveValue("Keep the source composer");

  await page.locator("#newTabButton").press("ArrowDown");
  await expect(page.locator("#newTabNoProjectButton")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".focused-context")).toHaveText("No Project");
  await expect(page.locator("#promptInput")).toHaveValue("");
  expect((await ownership.api("/api/tabs")).tabs).toHaveLength(2);
  await page.locator("#promptInput").fill("T7 browser-only draft");
  await page.locator("#newTabButton").click();
  await page.locator("#newTabNoProjectButton").click();
  await expect(page.locator("[data-draft-id]")).toHaveCount(1);
  expect((await ownership.api("/api/tabs")).tabs).toHaveLength(2);
  await page.locator(`#tabBar [data-tab-id="${selected}"] .terminal-tab-button`).click();
  await expect(page.locator("#promptInput")).toHaveValue("Keep the source composer");
  await page.locator("#newTabButton").click();
  await page.locator("#newTabCurrentDirectoryButton").click();
  await expect(page.locator('#tabBar [data-tab-id] [role="tab"]')).toHaveCount(3);
  const tabs = (await ownership.api("/api/tabs")).tabs;
  expect(tabs).toHaveLength(3);
  expect(tabs.at(-1).cwd).toBe(source.cwd);
  await expect(page.locator("[data-draft-id]")).toHaveCount(1);
});

for (const view of [{ width: 390, height: 844 }, { width: 320, height: 360 }]) {
  test(`narrow ${view.width}x${view.height}: button and choices stay reachable in the tab drawer`, async ({ page, ownership }, info) => {
    await page.setViewportSize(view);
    await page.goto(ownership.baseURL);
    await expect(page.locator("#statusBar")).toContainText("fake-model");
    await page.locator("#terminalTabsToggleButton").click();
    await expect(page.locator("#terminalTabsDrawerContent")).toBeVisible();
    const trigger = page.locator("#newTabButton");
    await trigger.scrollIntoViewIfNeeded();
    const button = await trigger.boundingBox();
    const wrapper = await page.locator("#newTabMenu").boundingBox();
    expect(Math.abs(wrapper.width - button.width)).toBeLessThanOrEqual(1);
    await capture(page, info, `narrow-${view.width}x${view.height}-closed`);
    const row = await page.locator("#tabBar").boundingBox();
    const empty = { x: Math.min(view.width - 20, row.x + row.width - 8), y: button.y + button.height / 2 };
    expect(empty.x).toBeGreaterThan(button.x + button.width);
    expect(await page.evaluate(point => !!document.elementFromPoint(point.x, point.y)?.closest("#newTabMenu"), empty)).toBe(false);
    await page.mouse.move(empty.x, empty.y);
    await page.mouse.click(empty.x, empty.y);
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#newTabMenuPanel")).toBeHidden();
    await expect(page.locator("#terminalTabsDrawerContent")).toBeVisible();
    await trigger.click();
    await expectMenuFits(page);
    await capture(page, info, `narrow-${view.width}x${view.height}`);
    await trigger.press("ArrowUp");
    await expect(page.locator(`#${choices.at(-1)}`)).toBeFocused();
    await page.keyboard.press("Home");
    await expect(page.locator(`#${choices[0]}`)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
    await expect(page.locator("#newTabMenuPanel")).toBeHidden();
    await trigger.press("Enter");
    await page.keyboard.press("End");
    await expect(page.locator(`#${choices.at(-1)}`)).toBeFocused();
    await expect(page.locator(`#${choices.at(-1)}`)).toBeInViewport({ ratio: 1 });
    await page.keyboard.press("Escape");
    await expect(trigger).toBeFocused();
  });
}


for (const placement of ["left", "right"]) {
  test(`Classic ${placement} sidebar preserves complete hovered menu choices`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.addInitScript(() => localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "classic" })));
    await page.goto(ownership.baseURL);
    await expect(page.locator("#statusBar")).toContainText("fake-model");
    await page.locator("#terminalTabsLayoutSelect").selectOption("left", { force: true });
    await page.locator("#controlDeckPlacementSelect").selectOption(placement, { force: true });
    await expect(page.locator("body")).toHaveClass(/terminal-tabs-left/);
    const trigger = page.locator("#newTabButton");
    const panel = page.locator("#newTabMenuPanel");
    await trigger.scrollIntoViewIfNeeded();
    await trigger.hover();
    await expect(panel).toBeVisible();
    for (const id of choices) {
      const choice = page.locator(`#${id}`);
      await choice.hover();
      await expect(choice).toHaveCSS("transform", "none");
      await expect(choice).toBeInViewport({ ratio: 1 });
      await expect(panel).toBeVisible();
    }
    await page.locator("#newTabNoProjectButton").hover();
    await capture(page, info, `classic-${placement}-hover`);
    await trigger.focus();
    await trigger.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
  });
}
