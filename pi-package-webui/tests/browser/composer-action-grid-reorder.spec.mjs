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
const storageKey = "pi-webui-composer-action-order-v1";
const layoutStorageKey = "pi-webui-composer-action-layout-v2";

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
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-composer-action-order-"));
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
      // Wait for the real server and fake Pi fixture to start.
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

test.beforeEach(async () => {
  const currentResponse = await fetch(`${baseURL}/api/interface-preferences`);
  const current = await currentResponse.json();
  expect(currentResponse.ok).toBe(true);
  const resetResponse = await fetch(`${baseURL}/api/interface-preferences`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sidePanelWidth: 384,
      layout: { version: 3, composerActions: null },
      expectedLayoutRevision: current.data.layoutRevision,
    }),
  });
  expect(resetResponse.ok).toBe(true);
});

async function storedOrder(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "[]"), storageKey);
}

async function storedLayout(page) {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null"), layoutStorageKey);
}

async function waitForControlDeckGeometry(handle) {
  await handle.evaluate(() => document.fonts.ready);
  await expect.poll(() => handle.evaluate((node) => {
    const panel = document.getElementById("sidePanel");
    const layout = document.querySelector(".layout");
    const targetWidth = Number(node.getAttribute("aria-valuenow"));
    return Math.abs(panel.getBoundingClientRect().width - targetWidth) < 1
      && !layout.getAnimations().some((animation) => animation.playState === "running");
  })).toBe(true);
}

async function resizeControlDeckBy(handle, key, count) {
  // Keyboard steps read rendered width, which trails aria-valuenow during the CSS transition.
  await waitForControlDeckGeometry(handle);
  for (let index = 0; index < count; index += 1) {
    const previous = await handle.getAttribute("aria-valuenow");
    await handle.press(key);
    await expect.poll(async () => handle.getAttribute("aria-valuenow")).not.toBe(previous);
    await waitForControlDeckGeometry(handle);
  }
}

test("composer actions persist pointer and keyboard grid reordering", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  await expect(page.locator("body")).toHaveClass(/composer-action-grid-enabled/);

  const send = page.locator('[data-composer-action-id="send"]');
  const newSession = page.locator('[data-composer-action-id="new"]');
  await expect(send).toBeVisible();
  await expect(newSession).toBeVisible();

  const sendBox = await send.boundingBox();
  const newBox = await newSession.boundingBox();
  expect(sendBox).toBeTruthy();
  expect(newBox).toBeTruthy();
  const newLabelCenterOffset = await newSession.evaluate((button) => {
    const range = document.createRange();
    range.selectNodeContents(button);
    const labelRect = range.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return (labelRect.left + labelRect.width / 2) - (buttonRect.left + buttonRect.width / 2);
  });
  expect(Math.abs(newLabelCenterOffset)).toBeLessThan(1);
  const minimumCellWidth = await page.evaluate(() => 3.2 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  const gridGuide = page.locator("#composerActionGridGuide");
  await expect(gridGuide).toBeHidden();
  await page.mouse.move(sendBox.x + sendBox.width / 2, sendBox.y + sendBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sendBox.x + sendBox.width / 2 - 12, sendBox.y + sendBox.height / 2, { steps: 2 });
  await expect(gridGuide).toBeVisible();

  const [rowBox, guideBox, firstCellBox, lastCellBox] = await Promise.all([
    page.locator(".composer-row").boundingBox(),
    gridGuide.boundingBox(),
    gridGuide.locator(".composer-action-grid-cell").first().boundingBox(),
    gridGuide.locator(".composer-action-grid-cell").last().boundingBox(),
  ]);
  expect(rowBox).toBeTruthy();
  expect(guideBox).toBeTruthy();
  expect(firstCellBox).toBeTruthy();
  expect(lastCellBox).toBeTruthy();
  expect(Math.abs(guideBox.x - rowBox.x)).toBeLessThan(1);
  expect(Math.abs(guideBox.width - rowBox.width)).toBeLessThan(1);
  expect(Math.abs(firstCellBox.width - lastCellBox.width)).toBeLessThan(1);
  expect(firstCellBox.width).toBeGreaterThanOrEqual(minimumCellWidth - 1);
  expect(Math.abs(firstCellBox.width - newBox.width)).toBeLessThan(1);
  expect(Math.abs(firstCellBox.height - newBox.height)).toBeLessThan(1);
  expect(await gridGuide.locator(".composer-action-grid-cell").count()).toBeGreaterThan(await page.locator("[data-composer-action-id]:visible").count());

  await page.mouse.move(newBox.x + 3, newBox.y + newBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect(gridGuide).toBeHidden();

  await expect.poll(async () => (await storedOrder(page)).slice(0, 2)).toEqual(["send", "new"]);
  await expect.poll(async () => {
    const [sendRect, newRect] = await Promise.all([send.boundingBox(), newSession.boundingBox()]);
    return sendRect.x < newRect.x;
  }).toBe(true);

  await page.reload();
  await expect.poll(async () => (await storedOrder(page)).slice(0, 2)).toEqual(["send", "new"]);
  await expect.poll(async () => {
    const [sendRect, newRect] = await Promise.all([send.boundingBox(), newSession.boundingBox()]);
    return sendRect.x < newRect.x;
  }).toBe(true);

  await newSession.focus();
  await newSession.press("Alt+ArrowLeft");
  await expect.poll(async () => (await storedOrder(page)).slice(0, 2)).toEqual(["new", "send"]);
  await expect(newSession).toBeFocused();
  await expect(page.locator("#composerActionOrderStatus")).toContainText("New moved to position 1");

  const movedNewBox = await newSession.boundingBox();
  expect(movedNewBox).toBeTruthy();
  await page.mouse.move(movedNewBox.x + movedNewBox.width / 2, movedNewBox.y + movedNewBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(movedNewBox.x + movedNewBox.width / 2 + 12, movedNewBox.y + movedNewBox.height / 2, { steps: 2 });
  await expect(gridGuide).toBeVisible();
  const emptyEndCellBox = await gridGuide.locator(".composer-action-grid-cell").last().boundingBox();
  expect(emptyEndCellBox).toBeTruthy();
  await page.mouse.move(emptyEndCellBox.x + emptyEndCellBox.width / 2, emptyEndCellBox.y + emptyEndCellBox.height / 2, { steps: 8 });
  await expect(gridGuide.locator(".composer-action-grid-cell-target")).toHaveCount(1);
  await page.mouse.up();
  await expect(gridGuide).toBeHidden();
  await expect.poll(async () => {
    const [nextNewRect, nextSendRect] = await Promise.all([newSession.boundingBox(), send.boundingBox()]);
    return nextNewRect.x > nextSendRect.x;
  }).toBe(true);
});

test("empty composer grid cells retain their space and accept later drops", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);

  const options = page.locator('[data-composer-action-id="options"]');
  const appRunner = page.locator('[data-composer-action-id="app-runner"]');
  const newSession = page.locator('[data-composer-action-id="new"]');
  const gridGuide = page.locator("#composerActionGridGuide");
  await expect(options).toBeVisible();
  await expect(appRunner).toBeVisible();
  await expect(newSession).toBeVisible();

  const optionsBox = await options.boundingBox();
  expect(optionsBox).toBeTruthy();
  const optionsCenter = { x: optionsBox.x + optionsBox.width / 2, y: optionsBox.y + optionsBox.height / 2 };
  await page.mouse.move(optionsCenter.x, optionsCenter.y);
  await page.mouse.down();
  await page.mouse.move(optionsCenter.x + 12, optionsCenter.y, { steps: 2 });
  await expect(gridGuide).toBeVisible();

  const endCellIndex = await gridGuide.locator(".composer-action-grid-cell").count() - 1;
  const endCellBox = await gridGuide.locator(".composer-action-grid-cell").last().boundingBox();
  expect(endCellBox).toBeTruthy();
  const endCellCenter = { x: endCellBox.x + endCellBox.width / 2, y: endCellBox.y + endCellBox.height / 2 };
  await page.mouse.move(endCellCenter.x, endCellCenter.y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null")?.positions?.options, layoutStorageKey)).toBe(endCellIndex);

  await expect.poll(async () => {
    const box = await options.boundingBox();
    return Math.abs((box.x + box.width / 2) - endCellCenter.x);
  }).toBeLessThan(1);
  await page.reload();
  await expect(appRunner).toBeVisible();
  const expectedOptionColumn = String((endCellIndex % (endCellIndex + 1)) + 1);
  await expect.poll(async () => options.evaluate((node) => node.style.getPropertyValue("--composer-action-grid-column"))).toBe(expectedOptionColumn);
  await expect.poll(async () => {
    const box = await options.boundingBox();
    return Math.abs((box.x + box.width / 2) - endCellCenter.x);
  }).toBeLessThan(1);

  const movedNewBox = await newSession.boundingBox();
  expect(movedNewBox).toBeTruthy();
  await page.mouse.move(movedNewBox.x + movedNewBox.width / 2, movedNewBox.y + movedNewBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(movedNewBox.x + movedNewBox.width / 2 + 12, movedNewBox.y + movedNewBox.height / 2, { steps: 2 });
  await expect(gridGuide).toBeVisible();
  const middleEmptyCellIndex = await gridGuide.locator(".composer-action-grid-cell").evaluateAll((cells) => {
    const actions = Array.from(document.querySelectorAll("[data-composer-action-id]"))
      .filter((action) => !action.hidden && action.getClientRects().length > 0);
    return cells.findIndex((cell, index) => {
      if (index === 0 || index === cells.length - 1) return false;
      const rect = cell.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return !actions.some((action) => {
        const actionRect = action.getBoundingClientRect();
        return centerX >= actionRect.left && centerX <= actionRect.right && centerY >= actionRect.top && centerY <= actionRect.bottom;
      });
    });
  });
  expect(middleEmptyCellIndex).toBeGreaterThan(0);
  const middleEmptyCellBox = await gridGuide.locator(".composer-action-grid-cell").nth(middleEmptyCellIndex).boundingBox();
  expect(middleEmptyCellBox).toBeTruthy();
  const middleEmptyCellCenter = { x: middleEmptyCellBox.x + middleEmptyCellBox.width / 2, y: middleEmptyCellBox.y + middleEmptyCellBox.height / 2 };
  await page.mouse.move(middleEmptyCellCenter.x, middleEmptyCellCenter.y, { steps: 8 });
  await expect(gridGuide.locator(".composer-action-grid-cell-target")).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(async () => {
    const box = await newSession.boundingBox();
    return Math.abs((box.x + box.width / 2) - middleEmptyCellCenter.x);
  }).toBeLessThan(1);
  await expect.poll(async () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "null")?.positions?.new, layoutStorageKey)).toBe(middleEmptyCellIndex);
});

test("narrow composer projection preserves the saved order of adjacent actions", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);

  const row = page.locator(".composer-row");
  const options = page.locator('[data-composer-action-id="options"]');
  const send = page.locator('[data-composer-action-id="send"]');
  const gridGuide = page.locator("#composerActionGridGuide");
  const resizeHandle = page.locator("#sidePanelResizeHandle");
  await waitForControlDeckGeometry(resizeHandle);

  const moveToCellFromEnd = async (action, offsetFromEnd) => {
    const actionBox = await action.boundingBox();
    expect(actionBox).toBeTruthy();
    await page.mouse.move(actionBox.x + actionBox.width / 2, actionBox.y + actionBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(actionBox.x + actionBox.width / 2 + 12, actionBox.y + actionBox.height / 2, { steps: 2 });
    await expect(gridGuide).toBeVisible();
    const cellCount = await gridGuide.locator(".composer-action-grid-cell").count();
    const target = gridGuide.locator(".composer-action-grid-cell").nth(cellCount - offsetFromEnd);
    const targetBox = await target.boundingBox();
    expect(targetBox).toBeTruthy();
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 });
    await page.mouse.up();
    await expect(gridGuide).toBeHidden();
  };

  await moveToCellFromEnd(options, 3);
  await moveToCellFromEnd(send, 2);
  const savedWideLayout = await storedLayout(page);
  expect(savedWideLayout?.positions?.options).toBeLessThan(savedWideLayout?.positions?.send);
  const wideRowBox = await row.boundingBox();
  expect(wideRowBox).toBeTruthy();

  await resizeHandle.focus();
  await resizeControlDeckBy(resizeHandle, "Shift+ArrowLeft", 3);
  await expect.poll(async () => (await row.boundingBox()).width).toBeLessThan(wideRowBox.width - 150);
  await expect.poll(async () => {
    const [optionsBox, sendBox] = await Promise.all([options.boundingBox(), send.boundingBox()]);
    if (!optionsBox || !sendBox) return false;
    return optionsBox.y < sendBox.y || (Math.abs(optionsBox.y - sendBox.y) < 1 && optionsBox.x < sendBox.x);
  }).toBe(true);
  expect(await storedLayout(page)).toEqual(savedWideLayout);

  await page.reload();
  await expect.poll(async () => {
    const [optionsBox, sendBox] = await Promise.all([options.boundingBox(), send.boundingBox()]);
    if (!optionsBox || !sendBox) return false;
    return optionsBox.y < sendBox.y || (Math.abs(optionsBox.y - sendBox.y) < 1 && optionsBox.x < sendBox.x);
  }).toBe(true);
  expect(await storedLayout(page)).toEqual(savedWideLayout);
});

test("sparse composer buttons keep fixed widths and stable columns when the Control Deck width changes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);

  const row = page.locator(".composer-row");
  const options = page.locator('[data-composer-action-id="options"]');
  const send = page.locator('[data-composer-action-id="send"]');
  const gridGuide = page.locator("#composerActionGridGuide");
  const resizeHandle = page.locator("#sidePanelResizeHandle");
  await waitForControlDeckGeometry(resizeHandle);
  const initialRowBox = await row.boundingBox();
  expect(initialRowBox).toBeTruthy();

  await resizeHandle.focus();
  await resizeControlDeckBy(resizeHandle, "Shift+ArrowLeft", 3);
  await expect.poll(async () => (await row.boundingBox()).width).toBeLessThan(initialRowBox.width - 50);

  const narrowRowBox = await row.boundingBox();
  const optionsBox = await options.boundingBox();
  expect(narrowRowBox).toBeTruthy();
  expect(optionsBox).toBeTruthy();
  const rootFontSize = await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
  const fixedCellWidth = 3.2 * rootFontSize;
  expect(Math.abs(optionsBox.width - fixedCellWidth)).toBeLessThan(1);

  await page.mouse.move(optionsBox.x + optionsBox.width / 2, optionsBox.y + optionsBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(optionsBox.x + optionsBox.width / 2 + 12, optionsBox.y + optionsBox.height / 2, { steps: 2 });
  await expect(gridGuide).toBeVisible();
  const lastCellBox = await gridGuide.locator(".composer-action-grid-cell").last().boundingBox();
  expect(lastCellBox).toBeTruthy();
  await page.mouse.move(lastCellBox.x + lastCellBox.width / 2, lastCellBox.y + lastCellBox.height / 2, { steps: 8 });
  await page.mouse.up();

  const placedOptionsBox = await options.boundingBox();
  const placedSendBox = await send.boundingBox();
  const narrowColumn = await options.evaluate((node) => node.style.getPropertyValue("--composer-action-grid-column"));
  const savedNarrowLayout = await storedLayout(page);
  expect(placedOptionsBox).toBeTruthy();
  expect(placedSendBox).toBeTruthy();
  expect(Number(narrowColumn)).toBeGreaterThan(1);
  expect(savedNarrowLayout?.columns).toBeGreaterThan(1);

  await resizeControlDeckBy(resizeHandle, "Shift+ArrowRight", 3);

  await expect.poll(async () => (await row.boundingBox()).width).toBeGreaterThan(narrowRowBox.width + 50);
  await expect.poll(async () => {
    const wideOptionsBox = await options.boundingBox();
    return Math.abs(wideOptionsBox.width - placedOptionsBox.width);
  }).toBeLessThan(1);
  await expect.poll(async () => {
    const wideSendBox = await send.boundingBox();
    return Math.abs(wideSendBox.width - placedSendBox.width);
  }).toBeLessThan(1);
  await expect.poll(async () => {
    const wideOptionsBox = await options.boundingBox();
    return Math.abs(wideOptionsBox.x - placedOptionsBox.x);
  }).toBeLessThan(1);
  await expect.poll(async () => {
    const wideSendBox = await send.boundingBox();
    return Math.abs(wideSendBox.x - placedSendBox.x);
  }).toBeLessThan(1);
  await expect.poll(async () => options.evaluate((node) => node.style.getPropertyValue("--composer-action-grid-column"))).toBe(narrowColumn);
  expect(await storedLayout(page)).toEqual(savedNarrowLayout);

  await page.reload();
  await expect.poll(async () => options.evaluate((node) => node.style.getPropertyValue("--composer-action-grid-column"))).toBe(narrowColumn);
  await expect.poll(async () => {
    const restoredOptionsBox = await options.boundingBox();
    return Math.abs(restoredOptionsBox.x - placedOptionsBox.x);
  }).toBeLessThan(1);
  await expect.poll(async () => {
    const restoredSendBox = await send.boundingBox();
    return Math.abs(restoredSendBox.x - placedSendBox.x);
  }).toBeLessThan(1);
  expect(await storedLayout(page)).toEqual(savedNarrowLayout);
});
