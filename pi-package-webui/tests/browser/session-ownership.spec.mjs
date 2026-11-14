import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { expect, test as base } from "@playwright/test";

const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const defaultModel = "fake-model";
const alternateModel = "fake-model-alt";
const streamPrompt = "fixture continuity delayed stream";
const streamText = "continuity stream complete";

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function stopServer(child) {
  if (!child?.pid) return;
  const signalGroup = (signal) => {
    try { process.kill(-child.pid, signal); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  let timer;
  const exited = child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once("exit", resolve));
  try {
    signalGroup("SIGTERM");
    await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(resolve, 3_000); })]);
  } finally {
    clearTimeout(timer);
    // A server exit can precede its fake-Pi descendants' shutdown.
    signalGroup("SIGKILL");
    await Promise.race([exited, delay(1_000)]);
  }
}

const test = base.extend({
  ownership: async ({ request }, use, testInfo) => {
    const root = await mkdtemp(join(tmpdir(), "pi-webui-session-ownership-"));
    let child;
    let output = "";
    let spawnError;
    try {
      const project = join(root, "project");
      const agent = join(root, "agent");
      const sessions = join(root, "sessions");
      for (const directory of [project, agent, sessions, join(root, "home")]) await mkdir(directory);
      await writeFile(join(root, "settings.json"), "{}\n");
      const sessionPath = join(sessions, "ownership-resume.jsonl");
      const timestamp = "2026-01-01T00:00:00.000Z";
      await writeFile(sessionPath, [
        { type: "session", version: 3, id: "ownership-resume", timestamp, cwd: project },
        { type: "message", id: "seed-user", parentId: null, timestamp, message: { role: "user", content: "Ownership resume target", timestamp: Date.parse(timestamp) } },
      ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

      const baseURL = `http://127.0.0.1:${await freePort()}`;
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_") && !key.startsWith("FAKE_PI_")));
      child = spawn(process.execPath, [
        join(packageRoot, "bin/pi-webui.mjs"), "--cwd", project,
        "--host", "127.0.0.1", "--port", new URL(baseURL).port,
        "--pi", join(packageRoot, "tests/fixtures/fake-pi.mjs"),
        "--", "--session-dir", sessions,
      ], {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...env, NODE_ENV: "test", HOME: join(root, "home"),
          XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"),
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
          PI_CODING_AGENT_DIR: agent, PI_WEBUI_SETTINGS_FILE: join(root, "settings.json"),
          PI_WEBUI_UPDATE_TEST_HOME: join(root, "update-coordination"), PI_WEBUI_RPC_SUPERVISOR: "0",
          FAKE_PI_SESSION_OWNERSHIP: "1", FAKE_PI_CONTINUITY_MODE: "1",
        },
      });
      child.on("error", (error) => { spawnError = error; });
      for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { output = (output + chunk).slice(-32_000); });

      let ready = false;
      for (let attempt = 0; attempt < 80 && child.exitCode === null && !spawnError; attempt += 1) {
        try {
          if ((await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; }
        } catch (error) {
          if (!["TypeError", "TimeoutError"].includes(error.name)) throw error;
        }
        await delay(100);
      }
      expect(ready, `Disposable server startup: ${spawnError?.message || output}`).toBe(true);
      const api = async (pathname, data) => {
        const response = await request.fetch(`${baseURL}${pathname}`, {
          method: data === undefined ? "GET" : "POST", data, timeout: 8_000,
        });
        const payload = await response.json();
        expect(response.ok() && payload.ok !== false && payload.success !== false, `${pathname}: ${JSON.stringify(payload)}`).toBe(true);
        return payload.data;
      };
      const initial = (await api("/api/tabs")).tabs;
      expect(initial).toHaveLength(1);
      const second = (await api("/api/tabs", {})).tab;
      expect(second.id).not.toBe(initial[0].id);
      await use({ baseURL, api, tabs: [initial[0], second], sessionPath });
    } finally {
      try {
        await stopServer(child);
        await testInfo.attach("disposable server log", { body: output, contentType: "text/plain" });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
});

test.use({
  video: "off", serviceWorkers: "block", viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce", actionTimeout: 8_000,
  ...(process.env.PI_WEBUI_TEST_CHROMIUM ? { launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM } } : {}),
});
test.setTimeout(45_000);

function tabButton(page, id) {
  return page.locator(`#tabBar [data-tab-id="${id}"] .terminal-tab-button`);
}

async function selectTab(page, id) {
  await tabButton(page, id).click();
  await expect(tabButton(page, id)).toHaveAttribute("aria-selected", "true");
}

function waitForPost(page, pathname) {
  return page.waitForResponse((response) => new URL(response.url()).pathname === pathname && response.request().method() === "POST", { timeout: 8_000 });
}

async function expectPost(responsePromise, tabId, body) {
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  expect(new URL(response.url()).searchParams.get("tab")).toBe(tabId);
  expect(response.request().postDataJSON()).toMatchObject(body);
  return response.json();
}

async function state(ownership, tabId) {
  return ownership.api(`/api/state?tab=${encodeURIComponent(tabId)}`);
}

async function chooseModel(page, tabId, id) {
  const value = JSON.stringify({ provider: "fake", modelId: id });
  await page.locator("#modelSelect").selectOption(value);
  const response = waitForPost(page, "/api/model");
  await page.locator("#setModelButton").click();
  await expectPost(response, tabId, { provider: "fake", modelId: id });
  await expect(page.locator("#modelSelect")).toHaveValue(value);
}

test.beforeEach(async ({ page, ownership }) => {
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator("#promptInput")).toBeVisible();
  await expect(page.locator("#chat")).toContainText("fake answer");
  await expect(page.locator("#eventLog")).toContainText("connected to");
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(2);
});

test.afterEach(async ({ page }, testInfo) => {
  if (!page.isClosed()) {
    const path = testInfo.outputPath("session-ownership.png");
    await page.screenshot({ path, animations: "disabled" });
    await testInfo.attach("session ownership browser", { path, contentType: "image/png" });
  }
});

test("model choices remain independent across real session tabs", async ({ page, ownership }) => {
  const [source, peer] = ownership.tabs;
  const initialSource = await state(ownership, source.id);
  const initialPeer = await state(ownership, peer.id);
  expect(initialSource.sessionId).not.toBe(initialPeer.sessionId);
  await page.locator("#sidePanelSectionToggleControls").click();
  await chooseModel(page, source.id, alternateModel);
  expect((await state(ownership, source.id)).model).toEqual({ provider: "fake", id: alternateModel });
  expect((await state(ownership, peer.id)).model).toEqual({ provider: "fake", id: defaultModel });

  await selectTab(page, peer.id);
  await expect(page.locator("#modelSelect")).toHaveValue(JSON.stringify({ provider: "fake", modelId: defaultModel }));
  await chooseModel(page, peer.id, alternateModel);
  await chooseModel(page, peer.id, defaultModel);
  await selectTab(page, source.id);
  await expect(page.locator("#modelSelect")).toHaveValue(JSON.stringify({ provider: "fake", modelId: alternateModel }));
  expect((await state(ownership, source.id)).sessionId).toBe(initialSource.sessionId);
  expect((await state(ownership, peer.id)).sessionId).toBe(initialPeer.sessionId);
  expect((await state(ownership, source.id)).model.id).toBe(alternateModel);
  expect((await state(ownership, peer.id)).model.id).toBe(defaultModel);
});

test("new_session replaces the current session and keeps SSE usable in the same tab", async ({ page, ownership }, testInfo) => {
  const [source, peer] = ownership.tabs;
  const initialSource = await state(ownership, source.id);
  const initialPeer = await state(ownership, peer.id);
  if (!await page.locator("#newSessionButton").isVisible()) await page.locator("#composerActionsButton").click();
  await page.locator("#newSessionButton").click();
  await expect(page.locator("#confirmationDialog")).toBeVisible();
  const replacement = waitForPost(page, "/api/new-session");
  await page.locator("#confirmationConfirmButton").click();
  await expectPost(replacement, source.id, {});
  await expect.poll(async () => (await state(ownership, source.id)).sessionId).not.toBe(initialSource.sessionId);
  await expect(tabButton(page, source.id)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(2);

  await page.locator("#promptInput").fill(streamPrompt);
  const sent = waitForPost(page, "/api/prompt");
  await page.locator("#sendButton").click();
  await expectPost(sent, source.id, { message: streamPrompt });
  // The live delta proves delivery before a settlement snapshot can refresh it.
  await expect(page.locator("#chat .message.assistant.streaming")).toContainText("continuity", { timeout: 8_000 });
  await expect(page.locator("#chat .message.assistant:not(.streaming)").last()).toContainText(streamText);
  await expect(page.locator("#abortButton")).toBeHidden();
  const screenshot = testInfo.outputPath("same-tab-sse.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("settled SSE after session replacement", { path: screenshot, contentType: "image/png" });
  expect((await state(ownership, peer.id)).sessionId).toBe(initialPeer.sessionId);
  await selectTab(page, peer.id);
  await expect(page.locator("#chat")).not.toContainText(streamText);
});

test("resume opens a new tab and preserves the source session and unsent draft", async ({ page, ownership }) => {
  const [source] = ownership.tabs;
  const original = await state(ownership, source.id);
  const draft = "Source draft stays here\nwith its second line.";
  await page.locator("#promptInput").fill(draft);
  if (!await page.locator("#optionsMenuButton").isVisible()) await page.locator("#composerActionsButton").click();
  await page.locator("#optionsMenuButton").click();
  await page.locator("#optionsSessionSubmenuButton").focus();
  await page.locator("#optionsSessionSubmenuButton").press("ArrowRight");
  await page.locator("#optionsResumeButton").click();
  await expect(page.locator("#nativeCommandTitle")).toHaveText("Resume a session");
  await page.locator(".native-selector-item").filter({ hasText: "Ownership resume target" }).click();
  const resumed = waitForPost(page, "/api/switch-session");
  await page.locator("#nativeCommandActions").getByRole("button", { name: "Resume", exact: true }).click();
  const payload = await expectPost(resumed, source.id, { sessionPath: ownership.sessionPath });
  const newTab = payload.data.tab;
  expect(ownership.tabs.map((tab) => tab.id)).not.toContain(newTab.id);
  await expect(tabButton(page, newTab.id)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(3);
  await expect(page.locator("#promptInput")).toHaveValue("");
  const resumedState = await state(ownership, newTab.id);
  expect(resumedState.sessionFile).toBe(ownership.sessionPath);
  expect(resumedState.sessionId).not.toBe(original.sessionId);
  await page.locator("#promptInput").fill("Resumed tab has its own draft.");
  await selectTab(page, source.id);
  await expect(page.locator("#promptInput")).toHaveValue(draft);
  expect((await state(ownership, source.id)).sessionId).toBe(original.sessionId);
  await selectTab(page, newTab.id);
  await expect(page.locator("#promptInput")).toHaveValue("Resumed tab has its own draft.");
});

test("two initially idle tabs discover a background approval without a test metadata refresh", async ({ page, ownership }) => {
  const [source, target] = ownership.tabs;
  await expect(tabButton(page, source.id)).toHaveAttribute("aria-label", /Idle/);
  await expect(tabButton(page, target.id)).toHaveAttribute("aria-label", /Idle/);
  expect((await state(ownership, source.id)).isStreaming).toBe(false);
  expect((await state(ownership, target.id)).isStreaming).toBe(false);
  const draft = "Foreground draft survives background approval.";
  await page.locator("#promptInput").fill(draft);

  // No test-side GET /api/tabs, navigation, reload or explicit refresh may
  // reveal this blocker. The application's idle reconciliation must find it.
  const accepted = await ownership.api(`/api/prompt?tab=${encodeURIComponent(target.id)}`, {
    message: "fixture mobile blocker", requestId: `ownership-${randomUUID()}`,
  });
  expect(accepted.output).toBe("mobile blocker fixture accepted");
  await expect(tabButton(page, target.id)).toHaveAttribute("aria-label", /Blocked/, { timeout: 16_000 });
  await expect(tabButton(page, source.id)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#promptInput")).toHaveValue(draft);
  await selectTab(page, target.id);
  await expect(page.locator("#dialogTitle")).toHaveText("Fixture blocker");
  const approval = waitForPost(page, "/api/extension-ui-response");
  await page.locator("#dialogActions").getByRole("button", { name: "Yes", exact: true }).click();
  await expectPost(approval, target.id, { id: "fixture_blocker_12345678", confirmed: true });
  await expect(page.locator("#dialog")).toBeHidden();
  await selectTab(page, source.id);
  await expect(page.locator("#promptInput")).toHaveValue(draft);
});
