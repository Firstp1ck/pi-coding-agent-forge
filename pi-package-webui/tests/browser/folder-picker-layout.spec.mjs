import { expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { test } from "./folder-picker-layout-fixture.mjs";

test.use({
  video: "off", serviceWorkers: "block", viewport: { width: 1280, height: 900 },
  reducedMotion: "reduce", launchOptions: { executablePath: "/usr/bin/chromium" },
});
test.setTimeout(45_000);

async function ready(page, fixture, scheme = "dark") {
  await page.addInitScript(({ scheme }) => {
    localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "focused" }));
    localStorage.setItem("pi-webui-theme-mode", scheme);
  }, { scheme });
  await page.goto(`${fixture.baseURL}/?tab=${encodeURIComponent(fixture.tab.id)}`);
  await expect(page.locator("#statusBar")).toContainText("fake-model");
  await expect(page.locator("#promptInput")).toBeEditable();
  await page.locator("#promptInput").fill("Keep this source draft");
}

async function openPicker(page, { waitForLoad = true } = {}) {
  if (await page.locator("#newTabButton").isVisible()) {
    await page.locator("#newTabButton").click();
    await page.locator("#newTabChooseDirectoryButton").click();
  } else {
    await page.locator("#promptInput").focus();
    await page.keyboard.press("Control+k");
    await expect(page.locator("#commandPaletteInput")).toBeVisible();
    await page.locator("#commandPaletteInput").fill("Choose directory for new tab");
    await page.keyboard.press("Enter");
  }
  await expect(page.locator("#pathPickerDialog")).toBeVisible();
  if (waitForLoad) await expect(page.locator("#pathPickerChooseButton")).toBeEnabled();
}

async function directPath(page, path) {
  await page.locator("#pathPickerPathInput").fill(path);
  await page.locator("#pathPickerPathInput").press("Enter");
  await expect(page.locator("#pathPickerCurrent")).toHaveAttribute("title", path);
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

async function expectFits(page) {
  const geometry = await page.locator("#pathPickerDialog").evaluate(dialog => {
    const rect = dialog.getBoundingClientRect();
    const footer = dialog.querySelector("menu").getBoundingClientRect();
    const body = dialog.querySelector(".path-picker-body");
    return {
      left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
      footerBottom: footer.bottom, footerTop: footer.top,
      width: innerWidth, height: innerHeight, overflow: body.scrollWidth - body.clientWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.footerTop).toBeGreaterThan(0);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  await expect(page.locator("#pathPickerCancelButton")).toBeInViewport();
  await expect(page.locator("#pathPickerChooseButton")).toBeInViewport();
}

for (const view of [
  { name: "desktop-dark", width: 1280, height: 900, scheme: "dark" },
  { name: "narrow-light", width: 390, height: 844, scheme: "light" },
]) {
  test(`${view.name}: long location, browsing and optional sections fit`, async ({ page, folderPicker }, info) => {
    await page.setViewportSize({ width: view.width, height: view.height });
    await ready(page, folderPicker, view.scheme);
    await openPicker(page);
    await expect(page.locator("#pathPickerTitle")).toHaveText("Choose a folder for new session");
    await expect(page.locator("#pathPickerChooseButton")).toHaveText("Choose this folder");
    await expect(page.locator("#pathPickerCreateButton")).toHaveText("Create folder");
    await expect(page.locator("#pathPickerRoots")).toContainText("Current session");
    await expect(page.locator("#pathPickerRoots")).toContainText("Default folder");
    await expect(page.locator("#pathPickerCurrent")).toHaveAttribute("title", folderPicker.project);
    await expect(page.locator("#pathPickerList .path-picker-directory")).toHaveCount(folderPicker.folders.length);
    await expect(page.locator(".path-picker-pinned")).not.toHaveAttribute("open", "");
    await expect(page.locator(".path-picker-create")).not.toHaveAttribute("open", "");
    await expect(page.locator("#pathPickerSearchInput")).toBeInViewport();
    await expect(page.locator("#pathPickerList")).toBeInViewport();
    await expectFits(page);
    await capture(page, info, `${view.name}-source-populated`);
    const accessibility = await new AxeBuilder({ page }).include("#pathPickerDialog").analyze();
    expect(accessibility.violations.filter(({ impact }) => ["serious", "critical"].includes(impact))).toEqual([]);
    await page.locator(".path-picker-pinned summary").click();
    await expect(page.locator("#pathPickerAddFastPickButton")).toBeVisible();
    await page.locator(".path-picker-create summary").click();
    await expect(page.locator("#pathPickerCreateNameInput")).toBeEditable();
    await expectFits(page);
    await capture(page, info, `${view.name}-source-expanded`);
    await page.locator("#pathPickerCancelButton").click();
    await expect(page.locator("#pathPickerDialog")).toBeHidden();
    await expect(page.locator("#promptInput")).toHaveValue("Keep this source draft");
    expect((await folderPicker.api("/api/tabs")).tabs).toHaveLength(1);
  });
}

test("direct paths, search, empty folders and creation preserve canonical actions", async ({ page, folderPicker }, info) => {
  await ready(page, folderPicker);
  await openPicker(page);
  const search = page.locator("#pathPickerSearchInput");
  await search.fill("alpha");
  await expect(page.locator("#pathPickerList .path-picker-directory")).toHaveText(["alpha/"]);
  await expect(page.locator("#pathPickerSearchStatus")).toHaveText(`Showing 1 of ${folderPicker.folders.length} directories.`);
  await search.press("Enter");
  await expect(page.locator("#pathPickerCurrent")).toHaveAttribute("title", join(folderPicker.project, "alpha"));
  await expect(page.locator("#pathPickerList")).toContainText("No subdirectories.");
  await directPath(page, folderPicker.project);
  await search.fill("nothing matches");
  await expect(page.locator("#pathPickerList")).toContainText("No directories match");
  await page.locator("#pathPickerClearSearchButton").click();
  await expect(search).toBeFocused();
  await expect(page.locator("#pathPickerList .path-picker-directory")).toHaveCount(folderPicker.folders.length);
  await directPath(page, join(folderPicker.project, "empty"));
  await capture(page, info, "desktop-source-empty");
  await page.locator(".path-picker-create summary").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await expect(page.locator("#pathPickerCreateNameInput")).toBeFocused();
  await page.locator("#pathPickerCreateNameInput").fill("../invalid");
  await page.locator("#pathPickerCreateButton").click();
  await expect(page.locator("#pathPickerError")).toContainText("do not include path separators");
  await expect(page.locator("#pathPickerCreateNameInput")).toBeFocused();
  await page.locator("#pathPickerCreateNameInput").fill("new-work");
  await page.locator("#pathPickerCreateNameInput").press("Enter");
  const created = join(folderPicker.project, "empty", "new-work");
  await expect(page.locator("#pathPickerCurrent")).toHaveAttribute("title", created);
  expect((await stat(created)).isDirectory()).toBe(true);
  await expect(page.locator("#pathPickerChooseButton")).toBeFocused();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tabs" && response.request().method() === "POST");
  await page.locator("#pathPickerChooseButton").click();
  expect((await response).request().postDataJSON()).toEqual({ cwd: created });
  await expect(page.locator("#pathPickerDialog")).toBeHidden();
  await expect.poll(async () => (await folderPicker.api("/api/tabs")).tabs.map(tab => tab.cwd)).toContain(created);
});

test("pin, reopen, jump and unpin use the persisted folder", async ({ page, folderPicker }) => {
  await ready(page, folderPicker);
  await openPicker(page);
  await page.locator(".path-picker-pinned summary").focus();
  await page.keyboard.press("Enter");
  await page.locator("#pathPickerAddFastPickButton").click();
  await expect(page.locator("#pathPickerAddFastPickButton")).toHaveText("Pinned");
  await expect.poll(async () => (await folderPicker.api("/api/path-fast-picks")).picks.map(pick => pick.cwd)).toContain(folderPicker.project);
  await directPath(page, join(folderPicker.project, "empty"));
  await page.locator("#pathPickerFastPicks .path-picker-fast-pick-button").click();
  await expect(page.locator("#pathPickerCurrent")).toHaveAttribute("title", folderPicker.project);
  await expect(page.locator("#pathPickerSearchInput")).toBeFocused();
  await page.locator("#pathPickerCancelButton").click();
  await openPicker(page);
  await expect(page.locator("#pathPickerFastPicks .path-picker-fast-pick-button")).toHaveCount(1);
  await page.locator("#pathPickerFastPicks .path-picker-fast-pick-remove").click();
  await expect.poll(async () => (await folderPicker.api("/api/path-fast-picks")).picks).toEqual([]);
  await expect(page.locator("#pathPickerFastPicks")).toContainText("No pinned folders yet");
});

test("short narrow viewport keeps footer reachable with both disclosures open", async ({ page, folderPicker }, info) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await ready(page, folderPicker, "light");
  await openPicker(page);
  await page.locator(".path-picker-pinned summary").click();
  await page.locator(".path-picker-create summary").click();
  await page.locator("#pathPickerCreateNameInput").fill("new-folder");
  await expectFits(page);
  await capture(page, info, "short-narrow-source-expanded");
  await page.locator("#pathPickerCreateNameInput").fill("../invalid");
  await page.locator("#pathPickerCreateButton").click();
  await expect(page.locator("#pathPickerError")).toBeInViewport({ ratio: 1 });
  await expectFits(page);
  await capture(page, info, "short-narrow-source-validation");
  await page.locator("#pathPickerCancelButton").click();
  await expect(page.locator("#pathPickerDialog")).toBeHidden();
});

test("Cancel and Escape return focus to their caller and keep the source draft", async ({ page, folderPicker }) => {
  await ready(page, folderPicker);
  const caller = page.locator(".footer-tui-cwd");
  for (const action of ["cancel", "Escape"]) {
    await caller.click();
    await expect(page.locator("#pathPickerChooseButton")).toBeEnabled();
    if (action === "cancel") await page.locator("#pathPickerCancelButton").click();
    else await page.keyboard.press("Escape");
    await expect(page.locator("#pathPickerDialog")).toBeHidden();
    await expect(caller).toBeFocused();
    await expect(page.locator("#promptInput")).toHaveValue("Keep this source draft");
  }
  expect((await folderPicker.api("/api/tabs")).tabs).toHaveLength(1);
});

test("failed direct path preserves location and offers an accessible cancellation", async ({ page, folderPicker }, info) => {
  await ready(page, folderPicker);
  await openPicker(page);
  await page.locator("#pathPickerPathInput").fill(join(folderPicker.project, "missing-folder"));
  await page.locator("#pathPickerPathButton").click();
  await expect(page.locator("#pathPickerError")).toBeVisible();
  await expect(page.locator("#pathPickerError")).toBeInViewport({ ratio: 1 });
  await expect(page.locator("#pathPickerCurrent")).toHaveAttribute("title", folderPicker.project);
  await expect(page.locator("#pathPickerPathInput")).toBeEditable();
  await expectFits(page);
  await capture(page, info, "desktop-source-error");
  await page.locator("#pathPickerCancelButton").click();
  await expect(page.locator("#pathPickerDialog")).toBeHidden();
});

test("Windows drive roots remain navigation-only and direct paths retain their spelling", async ({ page, folderPicker }) => {
  const drives = "::pi-webui-windows-drives::";
  const requests = [];
  await page.route("**/api/directories*", async route => {
    const cwd = new URL(route.request().url()).searchParams.get("path") || "";
    requests.push(cwd);
    const data = cwd === drives
      ? { cwd: "", displayCwd: "This PC", parent: null, selectable: false, directories: ["C:\\", "D:\\"].map(cwd => ({ name: cwd, cwd })) }
      : { cwd: cwd === "D:/project" ? "D:\\project" : "C:\\", displayCwd: cwd === "D:/project" ? "D:\\project" : "C:\\", parent: drives, directories: [] };
    await route.fulfill({ json: { ok: true, data: { ...data, roots: [], truncated: false } } });
  });
  await ready(page, folderPicker);
  await openPicker(page);
  await page.locator("#pathPickerRoots button").first().click();
  await expect(page.locator("#pathPickerCurrent")).toHaveText("This PC");
  await expect(page.locator("#pathPickerChooseButton")).toBeDisabled();
  await expect(page.locator("#pathPickerCreateNameInput")).toBeDisabled();
  await expect(page.locator("#pathPickerAddFastPickButton")).toBeDisabled();
  await expect(page.locator("#pathPickerPathInput")).toBeEditable();
  await expect(page.locator("#pathPickerSearchInput")).toBeFocused();
  await page.locator("#pathPickerSearchInput").fill("D:");
  await expect(page.locator("#pathPickerList .path-picker-directory")).toHaveText(["D:\\"]);
  await page.locator("#pathPickerPathInput").fill("D:/project");
  await page.locator("#pathPickerPathButton").click();
  await expect(page.locator("#pathPickerCurrent")).toHaveText("D:\\project");
  await expect(page.locator("#pathPickerChooseButton")).toBeEnabled();
  expect(requests).toContain("D:/project");
  await page.keyboard.press("Escape");
  expect((await folderPicker.api("/api/tabs")).tabs).toHaveLength(1);
});

test("cancelling a pending load keeps a reopened picker owned by its new request", async ({ page, folderPicker }) => {
  await ready(page, folderPicker);
  let release;
  let intercepted;
  let finished;
  const pending = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { intercepted = resolve; });
  const staleFinished = new Promise(resolve => { finished = resolve; });
  let count = 0;
  await page.route("**/api/directories*", async route => {
    count += 1;
    const first = count === 1;
    if (first) {
      intercepted();
      await Promise.race([pending, delay(5_000)]);
    }
    try {
      await route.fulfill({ json: { ok: true, data: { cwd: first ? "/stale" : folderPicker.project, displayCwd: first ? "Stale response" : folderPicker.project, roots: [], directories: [] } } });
    } finally {
      if (first) finished();
    }
  });
  try {
    await openPicker(page, { waitForLoad: false });
    await entered;
    await expect(page.locator("#pathPickerChooseButton")).toBeDisabled();
    await expect(page.locator("#pathPickerCancelButton")).toBeFocused();
    const aborted = page.waitForEvent("requestfailed", request => new URL(request.url()).pathname === "/api/directories");
    await page.keyboard.press("Escape");
    expect((await aborted).failure().errorText).toMatch(/abort|cancel/i);
    await expect(page.locator("#newTabButton")).toBeFocused();
    await openPicker(page);
    await expect(page.locator("#pathPickerCurrent")).toHaveText(folderPicker.project);
    release();
    await staleFinished;
    await page.evaluate(() => new Promise(requestAnimationFrame));
    await expect(page.locator("#pathPickerCurrent")).toHaveText(folderPicker.project);
    await expect(page.locator("#pathPickerDialog")).toBeVisible();
    await page.locator("#pathPickerCancelButton").click();
    await expect(page.locator("#newTabButton")).toBeFocused();
  } finally {
    release();
  }
});
