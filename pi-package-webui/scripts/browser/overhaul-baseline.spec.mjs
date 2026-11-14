import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { join, relative } from "node:path";
import { expect } from "@playwright/test";
import { api, artifactRoot, fixedPrompt, fixtureContract, openFixture, packageRoot, promptFixture, seedBaseline, sourceBaseline, startFixture, stopFixture, streamFinal, streamPrompt, test, waitIdle } from "./overhaul-fixture.mjs";
import { compareReports, frozenBudgets, installRenderProbe, measureCrowding, measureInput, measureTabSwitch, startStreamProbe, stopStreamProbe, summarize } from "./overhaul-metrics.mjs";

const runDirectory = join(artifactRoot, `run-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const report = { schemaVersion: 1, capturedAt: new Date().toISOString(), sourceBaseline, seedBaseline, query: process.env.PI_OVERHAUL_QUERY || "", fixture: fixtureContract, budgets: frozenBudgets, views: [], workflows: [], performance: null };
const matrix = [
  ...[[360, 800], [390, 844], [844, 390]].flatMap(([width, height]) => [
    { name: `phone-legacy-${width}x${height}`, width, height, query: "mobileShell=legacy", isMobile: true },
    { name: `phone-v2-${width}x${height}`, width, height, query: "mobileShell=v2", isMobile: true },
  ]),
  ...[[768, 1024], [1024, 768]].flatMap(([width, height]) => [
    { name: `tablet-legacy-${width}x${height}`, width, height, query: "tabletShell=legacy" },
    { name: `tablet-v2-${width}x${height}`, width, height, query: "tabletShell=v2" },
  ]),
  { name: "classic-1440x900", width: 1440, height: 900 },
  { name: "classic-1920x1080", width: 1920, height: 1080 },
  { name: "classic-light-1440x900", width: 1440, height: 900, theme: "catppuccin-latte", mode: "light" },
  { name: "classic-custom-1440x900", width: 1440, height: 900, theme: "overhaul-custom", mode: "dark", background: true },
];

async function saveJson(name, value) {
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot(page, name, state) {
  const screenshot = join(runDirectory, `${name}-${state}.png`);
  await page.screenshot({ path: screenshot, animations: "disabled" });
  const measurement = { state, screenshot: relative(packageRoot, screenshot), ...await measureCrowding(page) };
  await saveJson(`${name}-${state}.json`, measurement);
  return measurement;
}

test.beforeAll(async ({ browser }) => {
  report.machine = { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), node: process.version, chromium: browser.version(), executable: process.env.PI_OVERHAUL_CHROMIUM || "/usr/bin/chromium", samples: 7 };
  report.executionHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim();
  if (process.env.PI_OVERHAUL_UPDATE_BASELINE === "1") {
    execFileSync("git", ["diff", "--exit-code", sourceBaseline, "--", "public", "bin", "lib", "index.ts", "webui-rpc-helper.mjs"], { cwd: packageRoot });
  }
  await mkdir(runDirectory, { recursive: true });
});

for (const view of matrix) {
  test(`rendered baseline: ${view.name}`, async ({ browser, fixture }) => {
    const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, isMobile: !!view.isMobile, hasTouch: view.width <= 1024, colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC" });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    try {
      if (view.theme) await context.addInitScript(({ theme, mode }) => {
        localStorage.setItem("pi-webui-theme", theme);
        localStorage.setItem("pi-webui-theme-mode", mode);
        localStorage.setItem(`pi-webui-theme-${mode}`, theme);
      }, view);
      await openFixture(page, fixture, view.query);
      if (view.theme) await expect(page.locator("#themeSelect")).toHaveValue(view.theme);
      if (view.background) {
        await page.locator("#backgroundInput").setInputFiles({ name: "baseline-background.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
        await expect(page.locator("body")).toHaveClass(/custom-background-active/);
      }
      const states = [await snapshot(page, view.name, "idle")];
      await promptFixture(page, fixture, streamPrompt, `${view.name}-stream`);
      await expect(page.locator("#chat .message.assistant.streaming")).toContainText("This is a long");
      states.push(await snapshot(page, view.name, "streaming"));
      await waitIdle(page, fixture);
      await expect(page.locator("#chat")).toContainText(streamFinal);
      await promptFixture(page, fixture, "fixture mobile blocker", `${view.name}-blocked`);
      await expect(page.locator("#dialogTitle")).toHaveText("Fixture blocker");
      states.push(await snapshot(page, view.name, "blocked"));
      await page.locator("#dialogActions").getByRole("button", { name: "Yes", exact: true }).click();
      await expect(page.locator("#dialog")).toBeHidden();
      report.views.push({ ...view, states, pageErrors: errors });
    } finally { await context.close(); }
  });
}

test("repeated rendering and retained heap baseline", async ({ browser, request }) => {
  test.setTimeout(120_000);
  const cold = [], warm = [], input = [], switches = [], streams = [], heap = [];
  for (let index = 0; index < 7; index += 1) {
    const fixture = await startFixture(request);
    let context;
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block" });
      await installRenderProbe(context);
      const page = await context.newPage();
      await openFixture(page, fixture);
      await page.waitForFunction(() => window.__overhaul.usefulRenderMs !== null);
      cold.push(await page.evaluate(() => window.__overhaul.usefulRenderMs));
      await page.reload();
      await page.waitForFunction(() => window.__overhaul.usefulRenderMs !== null);
      warm.push(await page.evaluate(() => window.__overhaul.usefulRenderMs));
      input.push(await measureInput(page, fixedPrompt));
      const [first, second] = fixture.tabs;
      await page.locator(`[data-tab-id="${second.id}"] .terminal-tab-button`).click();
      await page.locator("#promptInput").fill("Second session fixed draft");
      await measureTabSwitch(page, first.id, fixedPrompt);
      switches.push(await measureTabSwitch(page, second.id, "Second session fixed draft"));
      await measureTabSwitch(page, first.id, fixedPrompt);
      await page.locator("#promptInput").fill("");
      const previousFinalCount = await page.locator("#chat .message.assistant").filter({ hasText: streamFinal }).count();
      await startStreamProbe(page);
      await promptFixture(page, fixture, streamPrompt, `performance-${index}`);
      await expect(page.locator("#chat .message.assistant.streaming")).toContainText("This is a long");
      await waitIdle(page, fixture);
      const stream = await stopStreamProbe(page);
      const finalCount = await page.locator("#chat .message.assistant").filter({ hasText: streamFinal }).count();
      streams.push({ ...stream, previousFinalCount, finalCount, finalOutputPresent: finalCount === previousFinalCount + 1 });
      assert.ok(streams.at(-1).finalOutputPresent, "fixed final assistant output must survive streaming");
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send("HeapProfiler.collectGarbage");
        const before = await cdp.send("Runtime.getHeapUsage");
        for (let cycle = 0; cycle < 10; cycle += 1) {
          await measureTabSwitch(page, second.id, "Second session fixed draft");
          await measureTabSwitch(page, first.id, "");
        }
        await cdp.send("HeapProfiler.collectGarbage");
        const after = await cdp.send("Runtime.getHeapUsage");
        heap.push({ cycles: 10, switches: 20, beforeBytes: before.usedSize, afterBytes: after.usedSize, retainedDeltaBytes: after.usedSize - before.usedSize });
      } finally { await cdp.detach(); }
    } finally {
      try { await context?.close(); } finally { await stopFixture(fixture); }
    }
  }
  report.performance = {
    viewport: { width: 1440, height: 900 },
    coldDefinition: "fresh nonpersistent context and empty HTTP cache; server and OS cache remain warm",
    warmDefinition: "reload in same context with HTTP cache enabled; service workers blocked",
    firstUsefulRender: { definition: "navigation time origin to two animation frames after visible enabled composer and fake answer in transcript", coldMs: summarize(cold), warmMs: summarize(warm) },
    inputToPaint: { definition: "actual insertText input event to second animation frame; excludes driver dispatch latency", ms: summarize(input) },
    tabSwitchToContent: { definition: "actual tab click event to selected target tab, restored unique draft and transcript, then two animation frames; identical transcript fixture across tabs", ms: summarize(switches) },
    streamRenderGap: { definition: "successive changed streaming transcript text sampled at animation frames, followed by next rendering opportunity; includes intentional 500ms producer cadence", ms: summarize(streams.flatMap((stream) => stream.gapsMs)), runs: streams, eventToPaintLatency: null, eventToPaintLimitation: "fake Pi log has no browser-correlated event timestamp; render gap is cadence, not transport latency" },
    retainedHeap: { definition: "CDP main-page JS used heap after explicit GC and ten fixed first/second navigation cycles; no renderer/GPU/process RSS claim", afterBytes: summarize(heap.map((sample) => sample.afterBytes)), runs: heap },
  };
  await saveJson("performance.json", report.performance);
});

test("observed workflow action counts", async ({ browser, request }) => {
  test.setTimeout(120_000);
  let fixture;
  const workflows = [
    ["switch session", async (page, act) => {
      const selector = `[data-tab-id="${fixture.tabs[1].id}"] .terminal-tab-button`;
      await act(selector, "click", () => page.locator(selector).click());
      await expect(page.locator(selector)).toHaveAttribute("aria-selected", "true");
    }],
    ["change model", async (page, act) => {
      await act("#sidePanelSectionToggleControls", "expand Controls", () => page.locator("#sidePanelSectionToggleControls").click());
      await expect(page.locator("#modelSelect")).toBeVisible();
      return { status: "partial", reason: "model selector reached in one action; fake Pi advertises only one model, so a real model change cannot be measured", alternatives: await page.locator("#modelSelect option").allTextContents() };
    }],
    ["change effort", async (page, act) => {
      await act("#sidePanelSectionToggleControls", "expand Controls", () => page.locator("#sidePanelSectionToggleControls").click());
      await act("#thinkingSelect", "choose high", () => page.locator("#thinkingSelect").selectOption("high"));
      await act("#setThinkingButton", "apply effort", () => page.locator("#setThinkingButton").click());
      await expect.poll(async () => (await api(page.request, fixture.baseURL, `/api/state?tab=${fixture.tabs[0].id}`)).thinkingLevel).toBe("high");
    }],
    ["attach file", async (page, act) => {
      const chooserPromise = page.waitForEvent("filechooser");
      await act("#attachButton", "open file chooser", () => page.locator("#attachButton").click());
      const chooser = await chooserPromise;
      await act("native file chooser", "choose context.txt", () => chooser.setFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("Fixed attachment context\n") }));
      await expect(page.locator("#attachmentTray")).toContainText("context.txt");
    }],
    ["find changed file", async (page, act) => {
      await act("#sidePanelSectionToggleGit", "expand Git", () => page.locator("#sidePanelSectionToggleGit").click());
      await act(".git-side-panel-repository-toggle", "expand project repository", () => page.locator(".git-side-panel-repository-toggle").click());
      const file = page.locator(".git-side-panel-file").filter({ hasText: "README.md" });
      await expect(file).toBeVisible();
      await act(".git-side-panel-file containing README.md", "open changed README", () => file.click());
      await expect(page.locator("#fileViewerPane")).toBeVisible();
    }],
    ["open runner output", async (page, act) => {
      await act("#appRunnerMenuButton", "open runner menu", () => page.locator("#appRunnerMenuButton").click());
      const runner = page.getByRole("menuitem", { name: /Baseline runner/ });
      await expect(runner).toBeVisible();
      await act('menuitem "Baseline runner"', "start runner", () => runner.click());
      await expect(page.locator(".app-runner-widget")).toContainText("BASELINE RUNNER OUTPUT");
    }],
    ["find approval", async (page) => {
      await promptFixture(page, fixture, "fixture mobile blocker", "workflow-approval");
      await expect(page.locator("#dialogTitle")).toHaveText("Fixture blocker");
      return { status: "measured", reason: "active-session confirmation appears automatically; zero user actions to find it; fixture API trigger excluded" };
    }],
    ["configure tool profile", async (page, act) => {
      const menu = page.locator("#nativeCommandMenuButton");
      if (!await menu.isVisible() || !await menu.isEnabled()) return { status: "unsupported", reason: "resource menu is hidden and disabled because the existing fake Pi catalog does not advertise /tools or /skills", actionCount: null };
      await act("#nativeCommandMenuButton", "open resource menu", () => page.locator("#nativeCommandMenuButton").click());
      const tools = page.locator("#nativeToolsButton");
      if (!await tools.isVisible() || !await tools.isEnabled()) return { status: "unsupported", reason: "existing fake Pi command catalog does not advertise /tools; no command-response routing invented for baseline" };
      await act("#nativeToolsButton", "open Tools Setup", () => tools.click());
      await expect(page.locator("#nativeCommandTitle")).toHaveText("Tools Setup");
      return { status: "partial", reason: "Tools Setup reached; profile value editing not included" };
    }],
    ["change theme", async (page, act) => {
      await act("#sidePanelSectionToggleControls", "expand Controls", () => page.locator("#sidePanelSectionToggleControls").click());
      await act("#themeSelect", "choose Dracula", () => page.locator("#themeSelect").selectOption("dracula"));
      await expect(page.locator("#themeSelect")).toHaveValue("dracula");
      await expect.poll(() => page.evaluate(() => localStorage.getItem("pi-webui-theme"))).toBe("dracula");
    }],
  ];
  for (const [name, exercise] of workflows) {
    fixture = await startFixture(request);
    let context;
    let page;
    const actions = [];
    const act = async (selector, description, perform) => {
      const action = { selector, description, completed: false };
      actions.push(action);
      await perform();
      action.completed = true;
    };
    try {
      context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block" });
      page = await context.newPage();
      await openFixture(page, fixture);
      const detail = await exercise(page, act);
      report.workflows.push({ name, status: "measured", actions, actionCount: actions.length, ...detail });
    } catch (error) {
      report.workflows.push({ name, status: "missing-evidence", actions, actionCount: null, error: error.message });
      if (page && !page.isClosed()) await page.screenshot({ path: join(runDirectory, `workflow-${name.replaceAll(" ", "-")}-failure.png`) });
    } finally {
      try {
        if (name === "find approval" && page && !page.isClosed()) await api(page.request, fixture.baseURL, `/api/extension-ui-response?tab=${fixture.tabs[0].id}`, { id: "fixture_blocker_12345678", cancelled: true });
      } finally {
        try { await context?.close(); } finally { await stopFixture(fixture); }
      }
    }
  }
  await saveJson("workflows.json", report.workflows);
});

test.afterAll(async () => {
  report.omissions = [
    "No installed optional companion matrix, busy multi-agent session, split conversations, top/left session alternatives or Classic Left/Both decks. Default-only density evidence does not establish their parity.",
    "No real software keyboard or browser 200% zoom. Desktop headless viewport emulation cannot prove platform keyboard or browser chrome zoom behavior.",
    "No long-transcript selection/find/manual-scroll check; fixed baseline transcript is short. Large file fixture exists but screenshot capture does not expand it.",
    "No native mobile engine/device or accessibility audit. Phone and tablet screenshots use Chromium emulation.",
    "No process-cold startup, filesystem cache flush, physical input/display latency or server-event-to-browser-paint clock correlation.",
    "Action counts are desktop Classic paths; incomplete and unavailable workflows retain explicit status and cannot satisfy reachability gates.",
  ];
  await saveJson("report.json", report);
  if (process.env.PI_OVERHAUL_UPDATE_BASELINE !== "1") {
    try {
      const baseline = JSON.parse(await readFile(join(packageRoot, "docs/overhaul/browser-baseline.json"), "utf8"));
      await saveJson("comparison.json", compareReports(baseline, report));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  if (process.env.PI_OVERHAUL_UPDATE_BASELINE === "1") {
    assert.equal(report.views.length, matrix.length, "refuse to freeze an incomplete screenshot matrix");
    assert.ok(report.performance, "refuse to freeze without repeated performance samples");
    assert.equal(report.workflows.length, 9, "refuse to freeze without workflow observations");
    await mkdir(join(packageRoot, "docs/overhaul"), { recursive: true });
    await writeFile(join(packageRoot, "docs/overhaul/browser-baseline.json"), `${JSON.stringify(report, null, 2)}\n`);
  }
});
