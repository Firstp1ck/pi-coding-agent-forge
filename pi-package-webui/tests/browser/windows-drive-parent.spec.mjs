import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const serverScript = join(root, "bin", "pi-webui.mjs");
const fakePi = join(root, "tests", "fixtures", "fake-pi.mjs");
const WINDOWS_DRIVES_PICKER_PATH = "::pi-webui-windows-drives::";

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
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-windows-drive-parent-"));
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
  if (child?.exitCode === null) await new Promise((resolve) => child.once("exit", resolve));
  await rm(tempRoot, { recursive: true, force: true });
});

function directoryPayload(cwd, { parent = WINDOWS_DRIVES_PICKER_PATH, directories = [] } = {}) {
  return {
    cwd,
    displayCwd: cwd,
    parent,
    roots: [],
    directories,
    truncated: false,
  };
}

function virtualDrivesPayload() {
  return {
    cwd: "",
    displayCwd: "This PC",
    parent: null,
    roots: [],
    directories: ["C:\\", "D:\\", "E:\\"].map((cwd) => ({ name: cwd, cwd, displayCwd: cwd, hidden: false })),
    truncated: false,
    selectable: false,
  };
}

test("Windows drive Parent flow remains navigation-only, accessible, and cwd-safe", async ({ page }) => {
  const directoryRequests = [];
  const tabCreateBodies = [];

  await page.route("**/api/path-fast-picks*", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, data: { picks: [{ cwd: "D:\\", displayCwd: "D:\\" }] } }),
    });
  });
  await page.route(/\/api\/tabs(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    tabCreateBodies.push(route.request().postDataJSON());
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "test stopped after cwd submission" }) });
  });
  await page.route("**/api/directories*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const requestedPath = new URL(route.request().url()).searchParams.get("path") || "";
    directoryRequests.push(requestedPath);
    if (requestedPath === WINDOWS_DRIVES_PICKER_PATH) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data: virtualDrivesPayload() }) });
      return;
    }
    if (requestedPath === "E:\\") {
      await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Drive E is unavailable" }) });
      return;
    }
    const data = requestedPath === "D:/project"
      ? directoryPayload("D:\\project", { parent: "D:\\" })
      : directoryPayload(requestedPath === "D:\\" ? "D:\\" : "C:\\");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
  });

  await page.setViewportSize({ width: 1280, height: 850 });
  await page.goto(baseURL);
  await expect(page.locator("#promptInput")).toBeFocused();

  await page.keyboard.press("Control+k");
  await page.locator("#commandPaletteInput").fill("Choose directory for new tab");
  await page.keyboard.press("Enter");

  const dialog = page.locator("#pathPickerDialog");
  const current = page.locator("#pathPickerCurrent");
  const search = page.locator("#pathPickerSearchInput");
  const directPath = page.locator("#pathPickerPathInput");
  const choose = page.locator("#pathPickerChooseButton");
  await expect(dialog).toBeVisible();
  await expect(current).toHaveText("C:\\");

  await page.locator("#pathPickerFastPicks .path-picker-fast-pick-button", { hasText: "D:" }).click();
  await expect(current).toHaveText("D:\\");
  await expect(search).toBeFocused();

  await page.getByRole("button", { name: "↑ Parent" }).click();
  await expect(current).toHaveText("This PC");
  await expect(search).toBeFocused();
  await expect(choose).toBeDisabled();
  await expect(page.locator("#pathPickerCreateNameInput")).toBeDisabled();
  await expect(page.locator("#pathPickerCreateButton")).toBeDisabled();
  await expect(page.locator("#pathPickerAddFastPickButton")).toBeDisabled();
  await expect(search).toBeEnabled();
  await expect(directPath).toBeEnabled();

  const accessibility = await new AxeBuilder({ page }).include("#pathPickerDialog").disableRules(["aria-required-children"]).analyze();
  const serious = accessibility.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
  assert.deepEqual(serious, [], `This PC picker should have no serious/critical Axe violations: ${serious.map(({ id }) => id).join(", ")}`);

  await search.fill("D");
  await expect(page.locator("#pathPickerList .path-picker-directory")).toHaveCount(1);
  await expect(page.locator("#pathPickerList .path-picker-directory")).toHaveText("D:\\");
  await page.locator("#pathPickerClearSearchButton").click();

  await page.locator("#pathPickerList .path-picker-directory", { hasText: "D:\\" }).click();
  await expect(current).toHaveText("D:\\");
  await expect(search).toBeFocused();
  await page.getByRole("button", { name: "↑ Parent" }).click();
  await expect(current).toHaveText("This PC");
  await expect(search).toBeFocused();

  await directPath.fill("D:/project");
  await page.locator("#pathPickerList .path-picker-directory", { hasText: "E:\\" }).click();
  const alert = page.locator("#pathPickerError");
  await expect(alert).toHaveAttribute("role", "alert");
  await expect(alert).toContainText("Drive E is unavailable");
  await expect(current).toHaveText("This PC");
  await expect(directPath).toHaveValue("D:/project");

  await page.locator("#pathPickerPathButton").click();
  await expect(current).toHaveText("D:\\project");
  await expect(search).not.toBeFocused();
  assert.ok(directoryRequests.includes("D:/project"), "direct path entry should preserve slash-form drive-qualified input");

  await page.getByRole("button", { name: "↑ Parent" }).click();
  await expect(current).toHaveText("D:\\");
  await expect(search).toBeFocused();
  await page.getByRole("button", { name: "↑ Parent" }).click();
  await expect(current).toHaveText("This PC");
  await expect(search).toBeFocused();

  await page.evaluate(() => document.querySelector("#pathPickerChooseButton").click());
  await expect(dialog).toBeVisible();
  assert.deepEqual(tabCreateBodies, [], "the virtual empty cwd must not create a tab");

  await page.locator("#pathPickerList .path-picker-directory", { hasText: "C:\\" }).click();
  await expect(current).toHaveText("C:\\");
  await expect(search).toBeFocused();
  await choose.click();
  await expect.poll(() => tabCreateBodies.length).toBe(1);
  assert.deepEqual(tabCreateBodies, [{ cwd: "C:\\" }]);
  assert.ok(tabCreateBodies.every(({ cwd }) => cwd && cwd !== WINDOWS_DRIVES_PICKER_PATH), "only a real drive root may reach tab creation");
});
