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
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-optimistic-prompt-"));
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      PI_CODING_AGENT_DIR: join(tempRoot, "agent"),
      PI_WEBUI_SETTINGS_FILE: join(tempRoot, "settings.json"),
      FAKE_PI_CONTINUITY_MODE: "1",
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
      // Wait for the isolated Web UI fixture.
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

test("submitted prompt remains visible during transcript reconciliation", async ({ page }) => {
  const prompt = "optimistic prompt survives reconciliation";
  await page.goto(baseURL);
  await expect(page.locator("#chat")).toContainText("fake answer");
  await page.locator("#promptInput").fill(prompt);
  await page.locator("#sendButton").click();

  const visiblePrompt = page.locator("#chat .message.user", { hasText: prompt });
  await expect(visiblePrompt).toHaveCount(1);
  await expect(page.locator("#promptInput")).toHaveValue("");

  // Changing transcript visibility forces the same keyed reconciliation used
  // by message refreshes while the fake backend intentionally withholds a
  // canonical user-message entry.
  await page.keyboard.press("Control+t");

  await expect(visiblePrompt).toHaveCount(1);
});

test("run indicator remains visible and stable on mobile until delayed agent start is confirmed", async ({ page }) => {
  const prompt = "fixture continuity delayed start";
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(baseURL);
  await expect(page.locator("#chat")).toContainText("fake answer");
  await page.locator("#promptInput").fill(prompt);
  await page.locator("#sendButton").click();

  const runIndicator = page.locator("#runIndicatorHost .runIndicator");
  await expect(runIndicator).toBeVisible();
  await expect(page.locator("#chat .runIndicator")).toHaveCount(0);
  expect(await runIndicator.evaluate((node) => node.parentElement?.id)).toBe("runIndicatorHost");
  await delay(250);
  await page.evaluate(() => {
    window.__runIndicatorFrameGaps = 0;
    window.__runIndicatorPositions = [];
    window.__monitorRunIndicator = true;
    const sample = () => {
      if (!window.__monitorRunIndicator) return;
      const indicator = document.querySelector("#runIndicatorHost .runIndicator");
      if (!indicator) window.__runIndicatorFrameGaps += 1;
      else window.__runIndicatorPositions.push(indicator.getBoundingClientRect().top);
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await delay(2000);
  const indicatorSamples = await page.evaluate(() => {
    window.__monitorRunIndicator = false;
    const positions = window.__runIndicatorPositions || [];
    return {
      frameGaps: window.__runIndicatorFrameGaps,
      drift: positions.length ? Math.max(...positions) - Math.min(...positions) : 0,
      positions,
    };
  });
  expect(indicatorSamples.frameGaps).toBe(0);
  expect(indicatorSamples.drift, JSON.stringify(indicatorSamples.positions)).toBeLessThanOrEqual(1.5);
  await delay(1300);
  await expect(runIndicator).toBeVisible();
  await expect(runIndicator).toContainText("Agent is running:");
  await expect(page.locator("#chat .message.assistant").last()).toContainText("continuity stream complete");
});

test("run indicator keeps one-line geometry across changing activity text", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 844 });
  await page.goto(baseURL);
  await page.locator("#promptInput").fill("fixture continuity delayed start");
  await page.locator("#sendButton").click();

  const runIndicator = page.locator("#runIndicatorHost .runIndicator");
  await expect(runIndicator).toBeVisible();
  const geometry = await runIndicator.evaluate((node) => {
    const meta = node.querySelector(".run-indicator-meta");
    const before = node.getBoundingClientRect();
    meta.textContent = "Running tool: subagent_wait with a deliberately long activity description that must not wrap or resize the running status card · run time 1m 00s";
    const after = node.getBoundingClientRect();
    return {
      heightDrift: Math.abs(after.height - before.height),
      topDrift: Math.abs(after.top - before.top),
    };
  });
  expect(geometry.heightDrift).toBeLessThanOrEqual(1.5);
  expect(geometry.topDrift).toBeLessThanOrEqual(1.5);
});

test("confirmed streaming replaces routing status before delayed activity events", async ({ page }) => {
  await page.goto(baseURL);
  await page.locator("#promptInput").fill("fixture continuity confirmed before tool");
  await page.locator("#sendButton").click();

  const runIndicator = page.locator("#runIndicatorHost .runIndicator");
  await expect(runIndicator).toContainText("Agent run confirmed; waiting for first output or action…");
  await expect(runIndicator).not.toContainText(/Routing/i);
  await expect(runIndicator).toContainText("Running tool: read…");
});

test("persisted user message replaces its optimistic bubble without duplication", async ({ page }) => {
  const prompt = "fixture continuity delayed stream";
  await page.goto(baseURL);
  await expect(page.locator("#chat")).toContainText("fake answer");
  await page.locator("#promptInput").fill(prompt);
  await page.locator("#sendButton").click();

  const matchingPrompts = page.locator("#chat .message.user", { hasText: prompt });
  await expect(matchingPrompts).toHaveCount(1);
  await expect(page.locator("#chat .message.assistant").last()).toContainText("continuity stream complete");
  await expect(matchingPrompts).toHaveCount(1);
});
