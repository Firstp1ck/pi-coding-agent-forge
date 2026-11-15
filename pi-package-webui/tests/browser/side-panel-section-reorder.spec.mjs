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
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-side-panel-order-"));
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

async function sectionOrder(page) {
  return page.locator("#sidePanel .side-panel-body > [data-side-panel-section]").evaluateAll((sections) => (
    sections.map((section) => section.dataset.sidePanelSection)
  ));
}

test("desktop Control Deck always enables and persists pointer and keyboard reordering", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  await expect(page.locator("#sidePanel")).toBeVisible();

  const initialOrder = await sectionOrder(page);
  expect(initialOrder.slice(0, 3)).toEqual(["controls", "files", "git"]);
  await expect(page.locator("#sidePanelEditButton")).toBeHidden();
  await expect(page.locator("#sidePanel")).toHaveClass(/section-edit-mode/);

  const controls = page.locator('[data-side-panel-section-toggle="controls"]');
  await expect(controls).toHaveAttribute("title", /drag to reorder/);
  await expect(controls).toHaveCSS("cursor", "grab");
  const desktopReorderVisuals = await controls.evaluate((button) => ({
    borderColor: getComputedStyle(button).borderColor,
    boxShadow: getComputedStyle(button).boxShadow,
    labelMarker: getComputedStyle(button.querySelector(".side-panel-section-label"), "::before").content,
  }));
  expect(desktopReorderVisuals.borderColor).not.toContain("148, 226, 213");
  expect(desktopReorderVisuals.boxShadow).not.toContain("148, 226, 213");
  expect(desktopReorderVisuals.labelMarker).toBe("none");
  const git = page.locator('[data-side-panel-section-toggle="git"]');
  const controlsBox = await controls.boundingBox();
  let gitBox = await git.boundingBox();
  expect(controlsBox).toBeTruthy();
  expect(gitBox).toBeTruthy();
  await page.mouse.move(controlsBox.x + controlsBox.width / 2, controlsBox.y + controlsBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(controlsBox.x + controlsBox.width / 2, controlsBox.y + controlsBox.height / 2 + 12, { steps: 2 });
  await expect(controls.locator("xpath=../..")).toHaveClass(/dragging/);
  gitBox = await git.boundingBox();
  expect(gitBox).toBeTruthy();
  await page.mouse.move(gitBox.x + gitBox.width / 2, gitBox.y + gitBox.height - 4, { steps: 6 });
  await page.mouse.up();

  await expect.poll(async () => (await sectionOrder(page)).slice(0, 3)).toEqual(["files", "git", "controls"]);
  await expect.poll(async () => page.evaluate(() => JSON.parse(localStorage.getItem("pi-webui-side-panel-section-order-v1") || "[]").slice(0, 3))).toEqual(["files", "git", "controls"]);

  await page.reload();
  await expect.poll(async () => (await sectionOrder(page)).slice(0, 3)).toEqual(["files", "git", "controls"]);
  await expect(page.locator("#sidePanelEditButton")).toBeHidden();

  const movedControls = page.locator('[data-side-panel-section-toggle="controls"]');
  await movedControls.focus();
  await movedControls.press("Alt+ArrowUp");
  await expect.poll(async () => (await sectionOrder(page)).slice(0, 3)).toEqual(["files", "controls", "git"]);
  await expect(movedControls).toBeFocused();

  await page.reload();
  await expect.poll(async () => (await sectionOrder(page)).slice(0, 3)).toEqual(["files", "controls", "git"]);
  await expect(page.locator("#sidePanelEditButton")).toBeHidden();
});
