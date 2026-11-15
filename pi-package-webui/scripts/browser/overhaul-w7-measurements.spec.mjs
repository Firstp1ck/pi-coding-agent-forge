import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, freemem, platform, release, totalmem } from "node:os";
import { join, relative } from "node:path";
import { expect } from "@playwright/test";
import { fixtureContract, fixedPrompt, openFixture, packageRoot, promptFixture, seedBaseline, sourceBaseline, startFixture, stopFixture, streamFinal, streamPrompt, test, waitIdle } from "./overhaul-fixture.mjs";
import { compareReports, frozenBudgets, installRenderProbe, measureCrowding, measureInput, measureTabSwitch, startStreamProbe, stopStreamProbe, summarize, w7ViewMapping } from "./overhaul-metrics.mjs";

const runId = process.env.PI_OVERHAUL_W7_RUN_ID;
assert.match(runId || "", /^run-[\w-]+$/, "run with playwright.overhaul-w7.config.mjs");
assert.ok(!process.env.PI_OVERHAUL_QUERY, "W7 forbids inherited query overrides");
assert.ok(!process.env.PI_OVERHAUL_UPDATE_BASELINE, "W7 never updates frozen references");
const runDirectory = join(packageRoot, "test-results/overhaul-w7", runId);
const baselinePath = join(packageRoot, "docs/overhaul/browser-baseline.json");
const frozenReference = await readFile(baselinePath, "utf8");
const baseline = JSON.parse(frozenReference);
const report = { schemaVersion: 2, capturedAt: new Date().toISOString(), sourceBaseline, seedBaseline, fixture: fixtureContract, budgets: frozenBudgets, views: [], workflows: [], performance: null,
  omissions: ["Reachability and companion-populated cases belong to W7-CAP; no workflow completion claimed here.", "Chromium headless viewport emulation only; no native devices, OS keyboard, physical display latency or process-cold startup.", "Service workers blocked; no offline/PWA evidence. Stream gap includes the fixed 500ms producer cadence; no transport latency claim.", "Heap is main-page JS after explicit GC, excluding DOM/native/GPU/RSS. Density is default Conversation only; no customized/split/theme parity claim."] };

async function saveJson(name, value) {
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

async function seedFocused(context) {
  await context.addInitScript(() => localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "focused" })));
}

async function snapshot(page, name, state) {
  const screenshot = join(runDirectory, `${name}-${state}.png`);
  await page.screenshot({ path: screenshot, animations: "disabled" });
  const measurement = { state, screenshot: relative(packageRoot, screenshot), ...await measureCrowding(page) };
  await saveJson(`${name}-${state}.json`, measurement);
  return measurement;
}

const matrix = w7ViewMapping.map((identity) => {
  const original = baseline.views.find((view) => view.name === identity.baseline);
  assert.ok(original, `frozen view missing: ${identity.baseline}`);
  return { name: identity.current, baselineName: identity.baseline, width: original.width, height: original.height,
    query: original.query || "", isMobile: !!original.isMobile, desktop: identity.desktop };
});

test.beforeAll(async ({ browser }) => {
  report.machine = { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytesAtStart: freemem(), node: process.version, chromium: browser.version(), executable: "/usr/bin/chromium", samples: 7 };
  report.executionHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim();
  await saveJson("report.json", report);
});

for (const view of matrix) {
  test(`W7 default density: ${view.name}`, async ({ browser, fixture }) => {
    const capture = { ...view, states: [], pageErrors: [] };
    report.views.push(capture);
    const context = await browser.newContext({ viewport: { width: view.width, height: view.height }, isMobile: view.isMobile, hasTouch: view.width <= 1024, colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block", locale: "en-US", timezoneId: "UTC" });
    try {
      await seedFocused(context);
      const page = await context.newPage();
      page.on("pageerror", (error) => capture.pageErrors.push(error.message));
      await openFixture(page, fixture, view.query);
      if (view.desktop) await expect(page.locator("#focusedWorkspace")).toBeVisible();
      else await expect(page.locator("#focusedWorkspace")).toBeHidden();
      capture.states.push(await snapshot(page, view.name, "idle"));
      await promptFixture(page, fixture, streamPrompt, `${view.name}-stream`);
      await expect(page.locator("#chat .message.assistant.streaming")).toContainText("This is a long");
      capture.states.push(await snapshot(page, view.name, "streaming"));
      await waitIdle(page, fixture);
      await expect(page.locator("#chat .message.assistant:not(.streaming) .markdown-body").filter({ hasText: streamFinal }).last()).toHaveText(streamFinal);
      await promptFixture(page, fixture, "fixture mobile blocker", `${view.name}-blocked`);
      await expect(page.locator("#dialogTitle")).toHaveText("Fixture blocker");
      capture.states.push(await snapshot(page, view.name, "blocked"));
      await page.locator("#dialogActions").getByRole("button", { name: "Yes", exact: true }).click();
      await expect(page.locator("#dialog")).toBeHidden();
      assert.deepEqual(capture.pageErrors, [], "no browser script errors");
    } catch (error) {
      capture.error = error.message;
      throw error;
    } finally {
      try { await saveJson(`${view.name}.json`, capture); } finally { await context.close(); }
    }
  });
}

test("input probe includes earlier synchronous application handlers", async ({ page }) => {
  await page.setContent('<textarea id="promptInput"></textarea>');
  await page.evaluate(() => {
    window.__overhaul = {};
    document.querySelector("#promptInput").addEventListener("input", (event) => {
      if (!event.data) return;
      const start = performance.now();
      while (performance.now() - start < 80) {}
      window.__overhaul.handlerMs = performance.now() - start;
    });
  });
  const measured = await measureInput(page, "listener order probe");
  const handlerMs = await page.evaluate(() => window.__overhaul.handlerMs);
  assert.ok(handlerMs >= 80, "probe must execute the earlier application handler");
  assert.ok(measured >= handlerMs, `input interval ${measured}ms must include ${handlerMs}ms of synchronous work`);
});

test("tab timing survives roster button replacement before dispatch", async ({ page }) => {
  await page.setContent('<div id="tabBar"><div data-tab-id="target"><button class="terminal-tab-button" aria-selected="false">Target</button></div></div><textarea id="promptInput"></textarea><div id="chat"></div>');
  await page.evaluate(() => {
    window.__overhaul = {};
    document.addEventListener("click", (event) => {
      const button = event.target.closest(".terminal-tab-button");
      if (!button) return;
      const start = performance.now();
      while (performance.now() - start < 40) {}
      window.__overhaul.handlerMs = performance.now() - start;
      button.setAttribute("aria-selected", "true");
      document.querySelector("#promptInput").value = "target draft";
      document.querySelector("#chat").textContent = "fake answer";
    });
  });
  const replacingPage = {
    evaluate: (...args) => page.evaluate(...args),
    waitForFunction: (fn) => page.waitForFunction(fn, null, { timeout: 2_000 }),
    locator(selector) {
      const locator = page.locator(selector);
      return {
        evaluate: (...args) => locator.evaluate(...args),
        async click() {
          await locator.evaluate((button) => button.replaceWith(button.cloneNode(true)));
          await locator.click();
        },
      };
    },
  };
  const measured = await measureTabSwitch(replacingPage, "target", "target draft");
  const handlerMs = await page.evaluate(() => window.__overhaul.handlerMs);
  assert.ok(handlerMs >= 40);
  assert.ok(measured >= handlerMs, "tab timing includes synchronous application work after replacement");
});

test("W7 repeated rendering and retained heap", async ({ browser, request }) => {
  test.setTimeout(180_000);
  const cold = [], warm = [], input = [], switches = [], streams = [], heap = [];
  const pageErrors = [];
  const refreshPerformance = async () => {
    report.performance = {
      pageErrors,
      viewport: { width: 1440, height: 900 },
      coldDefinition: "fresh nonpersistent context and empty HTTP cache; server and OS cache remain warm",
      warmDefinition: "reload in same context with HTTP cache enabled; service workers blocked",
      firstUsefulRender: { definition: "navigation time origin to two animation frames after visible enabled composer and fake answer in transcript", coldMs: summarize(cold), warmMs: summarize(warm) },
      inputToPaint: { measurementVersion: 2, definition: "capture-phase insertText input event before application bubble handlers to second animation frame; includes synchronous handler work, excludes driver dispatch latency", ms: summarize(input) },
      tabSwitchToContent: { definition: "actual tab click event to selected target tab, restored unique draft and transcript, then two animation frames; identical transcript fixture across tabs", ms: summarize(switches) },
      streamRenderGap: { definition: "successive changed streaming transcript text sampled at animation frames, followed by next rendering opportunity; includes intentional 500ms producer cadence", ms: summarize(streams.flatMap((stream) => stream.gapsMs)), runs: streams, eventToPaintLatency: null, eventToPaintLimitation: "fake Pi log has no browser-correlated event timestamp; render gap is cadence, not transport latency" },
      retainedHeap: { definition: "CDP main-page JS used heap after explicit GC and ten fixed first/second navigation cycles; no renderer/GPU/process RSS claim", afterBytes: summarize(heap.map((sample) => sample.afterBytes)), runs: heap },
    };
    await saveJson("performance.json", report.performance);
  };
  try {
    for (let index = 0; index < 7; index += 1) {
      const fixture = await startFixture(request);
      let context;
      let page;
      const progress = { sample: index + 1, stage: "startup" };
      try {
        context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block" });
        await seedFocused(context);
        await installRenderProbe(context);
        page = await context.newPage();
        page.on("pageerror", (error) => pageErrors.push(error.message));
        await openFixture(page, fixture);
        await expect(page.locator("#focusedWorkspace")).toBeVisible();
        await page.waitForFunction(() => window.__overhaul.usefulRenderMs !== null);
        cold.push(await page.evaluate(() => window.__overhaul.usefulRenderMs));
        progress.stage = "warm render";
        await page.reload();
        await page.waitForFunction(() => window.__overhaul.usefulRenderMs !== null);
        warm.push(await page.evaluate(() => window.__overhaul.usefulRenderMs));
        progress.stage = "input";
        input.push(await measureInput(page, fixedPrompt));
        progress.stage = "tab switch";
        const [first, second] = fixture.tabs;
        await page.locator(`[data-tab-id="${second.id}"] .terminal-tab-button`).click();
        await page.locator("#promptInput").fill("Second session fixed draft");
        await measureTabSwitch(page, first.id, fixedPrompt);
        switches.push(await measureTabSwitch(page, second.id, "Second session fixed draft"));
        await measureTabSwitch(page, first.id, fixedPrompt);
        await page.locator("#promptInput").fill("");
        const exactFinalCount = async () => page.locator("#chat .message.assistant:not(.streaming) .markdown-body").evaluateAll((nodes, expected) => nodes.filter((node) => node.textContent === expected).length, streamFinal);
        const previousFinalCount = await exactFinalCount();
        progress.stage = "stream";
        await startStreamProbe(page);
        await promptFixture(page, fixture, streamPrompt, `performance-${index}`);
        await expect(page.locator("#chat .message.assistant.streaming")).toContainText("This is a long");
        await waitIdle(page, fixture);
        const stream = await stopStreamProbe(page);
        const finalCount = await exactFinalCount();
        const finalTexts = await page.locator("#chat .message.assistant:not(.streaming) .markdown-body").allTextContents();
        streams.push({ ...stream, previousFinalCount, finalCount, expectedFinalText: streamFinal, finalTexts, finalOutputPresent: finalCount === previousFinalCount + 1 });
        assert.ok(streams.at(-1).finalOutputPresent, "fixed final assistant output must survive streaming");
        progress.stage = "heap cycles";
        const cdp = await context.newCDPSession(page);
        try {
          await cdp.send("HeapProfiler.collectGarbage");
          const before = await cdp.send("Runtime.getHeapUsage");
          for (let cycle = 0; cycle < 10; cycle += 1) {
            Object.assign(progress, { cycle: cycle + 1, target: second.id, expectedDraft: "Second session fixed draft" });
            await measureTabSwitch(page, second.id, "Second session fixed draft");
            Object.assign(progress, { target: first.id, expectedDraft: "" });
            await measureTabSwitch(page, first.id, "");
          }
          await cdp.send("HeapProfiler.collectGarbage");
          const after = await cdp.send("Runtime.getHeapUsage");
          heap.push({ cycles: 10, switches: 20, beforeBytes: before.usedSize, afterBytes: after.usedSize, retainedDeltaBytes: after.usedSize - before.usedSize });
        } finally { await cdp.detach(); }
      } catch (error) {
        progress.error = error.message;
        if (page && !page.isClosed()) {
          try {
            progress.browser = await page.evaluate(() => ({ draft: document.querySelector("#promptInput")?.value, tabs: [...document.querySelectorAll("#tabBar [data-tab-id] .terminal-tab-button")].map((node) => ({ id: node.closest("[data-tab-id]").dataset.tabId, selected: node.getAttribute("aria-selected"), text: node.textContent })), hasTranscript: document.querySelector("#chat")?.textContent.includes("fake answer"), measuredTabMs: window.__overhaul?.tabMs }));
            progress.screenshot = `sample-${index + 1}-failure.png`;
            await page.screenshot({ path: join(runDirectory, progress.screenshot), animations: "disabled" });
          } catch (diagnosticError) { progress.diagnosticError = diagnosticError.message; }
        }
        await saveJson(`sample-${index + 1}-failure.json`, progress);
        throw error;
      } finally {
        try { await refreshPerformance(); } finally {
          try { await context?.close(); } finally { await stopFixture(fixture); }
        }
      }
    }
  } catch (error) {
    report.performanceError = error.message;
    throw error;
  } finally {
    await refreshPerformance();
    if (report.performanceError) report.performance.error = report.performanceError;
    await saveJson("performance.json", report.performance);
  }
  assert.deepEqual(pageErrors, [], "performance samples must have no browser script errors");
});

test("semantic counting follows moved canonical nodes and one focused inspector", async ({ page }) => {
  await page.route("http://w7-measurement.invalid/", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto("http://w7-measurement.invalid/");
  await page.setContent(`<div id="focusedWorkspace">
    <div class="focused-composer-controls"><div class="control-row"><label>Model<select id="modelSelect"><option>fake-model</option></select></label></div></div>
    <aside class="focused-inspector"><div id="focusedWorkspaceInspectorPanel"><section class="side-panel-section"><div class="side-panel-section-content"><div id="queueBox">One queued prompt</div><div id="gitPanelGroups">README.md modified</div></div></section></div></aside>
    <button id="sendButton">Send</button><button id="attachButton">Attach</button><button id="abortButton">Stop</button>
    <button id="secondary">All tools</button><button disabled id="disabled">Unavailable</button>
    <div id="statusBar"><span class="footer-model">fake-model</span></div>
  </div>`);
  const measurement = await measureCrowding(page);
  assert.equal(measurement.secondaryCount, 1);
  assert.equal(measurement.disabled.length, 1);
  assert.equal(measurement.excluded.length, 4);
  assert.equal(measurement.summaries.model.length, 2);
  assert.equal(measurement.summaries.queue.length, 1);
  assert.equal(measurement.summaries.git.length, 1);
  assert.equal(measurement.duplicateExpandedSummaries, 1);
  assert.equal(measurement.openAuxiliaryRegions, 1);
  assert.equal(measurement.auxiliaryCandidates.length, 2);
});

async function saveReport() {
  // Playwright replaces a worker after a failed case. Read durable captures so a
  // later failure or verdict cannot erase earlier successful measurements.
  report.views = [];
  for (const view of matrix) {
    try { report.views.push(JSON.parse(await readFile(join(runDirectory, `${view.name}.json`), "utf8"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  try { report.performance = JSON.parse(await readFile(join(runDirectory, "performance.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const comparison = compareReports(baseline, report, { viewMapping: w7ViewMapping });
  await saveJson("report.json", report);
  await saveJson("comparison.json", comparison);
  assert.equal(await readFile(baselinePath, "utf8"), frozenReference, "frozen W0 reference unchanged");
  return comparison;
}

test("frozen W7 density and performance gates", async () => {
  const comparison = await saveReport();
  assert.deepEqual([...comparison.density, ...comparison.checks, { name: "exact final outputs", ...comparison.finalOutputCheck }].filter((check) => check.status !== "within-budget"), [], "failed or missing measurements cannot pass frozen gates");
});

test.afterAll(saveReport);
