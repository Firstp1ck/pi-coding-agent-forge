import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { join, relative } from "node:path";
import { expect } from "@playwright/test";
import { api, artifactRoot, openFixture, packageRoot, sourceBaseline, startFixture, stopFixture, test } from "./overhaul-fixture.mjs";

const integrationBase = "ad514adba3f4e57c10c72b26eec0dce570eab30e";
const runDirectory = join(artifactRoot, `layout-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const report = {
  schemaVersion: 1,
  workstream: "W0-C",
  capturedAt: new Date().toISOString(),
  sourceRevision: sourceBaseline,
  integrationBase,
  command: "node node_modules/@playwright/test/cli.js test --config playwright.overhaul-layout.config.mjs",
  acceptance: "Baseline evidence only. Passing characterization tests do not mean known product defects pass layout acceptance.",
  scenarios: [],
  omissions: [
    "No native device, OS software keyboard, IME, safe-area hardware, or physical keyboard verification.",
    "Headless keyboard browser-zoom attempt is measured; fallback viewport reflow is not true browser zoom, CSS zoom, pinch zoom, or device scale emulation.",
    "Short existing fake-Pi transcripts and no installed companions. No simulated catalog responses are used by this layout workstream.",
    "Stop/approval states and the original 42 screenshots/performance budgets belong to the frozen original baseline; this supplement does not replace or change them.",
    "Model/effort selector geometry is measured in expanded desktop Controls. Phone model/effort workflow parity remains outside this layout-only pass.",
  ],
};

async function saveJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

// Hit testing and ancestor clipping catch fixed-position clipping that document overflow misses.
async function geometry(scope, selectors) {
  return scope.locator("html").evaluate((html, entries) => {
    const doc = html.ownerDocument;
    const win = doc.defaultView;
    const rectangle = (rect) => Object.fromEntries(["x", "y", "width", "height", "right", "bottom"].map((key) => [key, rect[key]]));
    const controls = entries.map((selector) => {
      const node = doc.querySelector(selector);
      if (!node) return { selector, present: false, reachable: false };
      const box = node.getBoundingClientRect();
      const style = win.getComputedStyle(node);
      const rendered = box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      const withinViewport = rendered && box.x >= -0.5 && box.y >= -0.5 && box.right <= win.innerWidth + 0.5 && box.bottom <= win.innerHeight + 0.5;
      let clippedBy = null;
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const s = win.getComputedStyle(parent);
        const b = parent.getBoundingClientRect();
        if ((/(hidden|clip|auto|scroll)/.test(s.overflowX) && (box.x < b.x - 1 || box.right > b.right + 1)) ||
            (/(hidden|clip|auto|scroll)/.test(s.overflowY) && (box.y < b.y - 1 || box.bottom > b.bottom + 1))) {
          clippedBy = parent.id || parent.className || parent.tagName;
          break;
        }
      }
      const hit = doc.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      const centerHit = !!hit && (hit === node || node.contains(hit));
      const disabled = node.matches(":disabled") || !!node.closest("[inert]");
      return { selector, present: true, box: rectangle(box), rendered, withinViewport, clippedBy, centerHit, disabled, hit: hit?.id || hit?.tagName || null, reachable: withinViewport && !clippedBy && centerHit && !disabled };
    });
    return {
      viewport: { width: win.innerWidth, height: win.innerHeight, devicePixelRatio: win.devicePixelRatio, visual: win.visualViewport ? { width: win.visualViewport.width, height: win.visualViewport.height, scale: win.visualViewport.scale, offsetTop: win.visualViewport.offsetTop } : null },
      documentOverflowX: Math.max(0, html.scrollWidth - win.innerWidth),
      bodyClasses: doc.body.className,
      keyboardInset: win.getComputedStyle(html).getPropertyValue("--keyboard-inset-bottom"),
      sidebarWidthProperty: win.getComputedStyle(doc.body).getPropertyValue("--terminal-tabs-sidebar-width"),
      regions: [".terminal-tabs-shell", ".chat-panel", "#chat", ".composer"].flatMap((selector) => {
        const node = doc.querySelector(selector);
        return node ? [{ selector, box: rectangle(node.getBoundingClientRect()), gridColumns: win.getComputedStyle(node).gridTemplateColumns }] : [];
      }),
      controls,
    };
  }, selectors);
}

async function capture(page, scenario, suffix, selectors, scope = page) {
  await settle(page);
  const path = join(runDirectory, `${scenario.id}-${suffix}.png`);
  const measurement = { state: suffix, screenshot: relative(packageRoot, path), ...await geometry(scope, selectors) };
  if (scope !== page) {
    const host = await page.locator("#terminalSplitFrame").boundingBox();
    assert.ok(host, "embedded control measurement requires a rendered iframe host");
    measurement.iframeHost = host;
    for (const control of measurement.controls) {
      if (!control.box) continue;
      const box = { x: host.x + control.box.x, y: host.y + control.box.y, right: host.x + control.box.right, bottom: host.y + control.box.bottom };
      control.topLevelBox = box;
      control.topLevelReachable = await page.evaluate(({ box }) => {
        const hit = document.elementFromPoint((box.x + box.right) / 2, (box.y + box.bottom) / 2);
        return box.x >= 0 && box.y >= 0 && box.right <= innerWidth + 0.5 && box.bottom <= innerHeight + 0.5 && hit?.id === "terminalSplitFrame";
      }, { box });
      control.reachable = control.reachable && control.topLevelReachable;
    }
  }
  await page.screenshot({ path, animations: "disabled" });
  scenario.measurements.push(measurement);
  await saveJson(join(runDirectory, `${scenario.id}-${suffix}.json`), measurement);
  return measurement;
}

async function assertReachable(scope, measurement) {
  const problems = measurement.controls.filter((control) => !control.reachable).map((control) => control.selector);
  assert.deepEqual(problems, [], `mandatory geometry/reachability: ${JSON.stringify(measurement)}`);
  for (const control of measurement.controls) {
    await scope.locator(control.selector).click({ trial: true, timeout: 2_000 });
    control.clickTrial = "pass";
  }
}

async function withScenario(browser, request, setup, run) {
  const scenario = { ...setup, sourceRevision: sourceBaseline, status: "missing", steps: [], measurements: [], errors: [], pageErrors: [] };
  report.scenarios.push(scenario);
  const fixture = await startFixture(request);
  let context;
  try {
    context = await browser.newContext({ viewport: setup.viewport, isMobile: !!setup.isMobile, hasTouch: !!setup.isMobile, locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block" });
    if (setup.theme) await context.addInitScript(({ theme, mode }) => {
      localStorage.setItem("pi-webui-theme", theme);
      localStorage.setItem("pi-webui-theme-mode", mode);
      localStorage.setItem(`pi-webui-theme-${mode}`, theme);
    }, setup);
    const page = await context.newPage();
    page.on("pageerror", (error) => scenario.pageErrors.push(error.message));
    await openFixture(page, fixture, setup.query || "");
    await run({ page, context, fixture, scenario });
    assert.deepEqual(scenario.pageErrors, [], "no browser script errors");
    scenario.status = scenario.defects?.length ? "known-defect" : "pass";
  } catch (error) {
    scenario.errors.push(error.message);
    throw error;
  } finally {
    try { await context?.close(); } finally {
      await stopFixture(fixture);
      await saveJson(join(runDirectory, `${setup.id}-scenario.json`), scenario);
    }
  }
}

async function controls(page) {
  const toggle = page.locator('[data-side-panel-section-toggle="controls"]');
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
  await expect(page.locator("#controlDeckPlacementSelect")).toBeVisible();
}

async function layoutState(page, fixture) {
  return api(page.request, fixture.baseURL, "/api/interface-preferences");
}

const composer = ["#promptInput", "#attachButton", "#sendButton"];

test.beforeAll(async ({ browser }) => {
  assert.equal(process.env.PI_OVERHAUL_QUERY || "", "", "layout evidence requires unchanged source without inherited presentation queries");
  execFileSync("git", ["diff", "--exit-code", sourceBaseline, "--", "public", "bin", "lib", "index.ts", "webui-rpc-helper.mjs"], { cwd: packageRoot });
  report.executionHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim();
  report.environment = { node: process.version, chromium: browser.version(), executable: "/usr/bin/chromium", platform: platform(), arch: arch(), kernel: release() };
  await mkdir(runDirectory, { recursive: true });
});

for (const [tabs, deck, theme, mode] of [
  ["top", "right"], ["top", "left", "catppuccin-latte", "light"],
  ["top", "both", "overhaul-custom", "dark"], ["left", "right"], ["left", "left"],
]) {
  test(`Classic ${tabs} tabs, ${deck} deck with persisted customization`, async ({ browser, request }) => {
    await withScenario(browser, request, { id: `layout-classic-${tabs}-${deck}`, viewport: { width: 1920, height: 1080 }, tabs, deck, theme, mode }, async ({ page, fixture, scenario }) => {
      await controls(page);
      await page.locator("#controlDeckPlacementSelect").selectOption(deck);
      await page.locator("#terminalTabsLayoutSelect").selectOption(tabs);
      scenario.steps.push(`Expand Controls; choose ${deck} deck; choose ${tabs} tabs using normal selects.`);
      if (theme) await expect(page.locator("#themeSelect")).toHaveValue(theme);
      if (theme === "overhaul-custom") {
        await page.locator("#backgroundInput").setInputFiles({ name: "layout-background.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64") });
        await expect(page.locator("body")).toHaveClass(/custom-background-active/);
      }
      const files = page.locator('[data-side-panel-section-toggle="files"]');
      await files.focus();
      await files.press("Alt+ArrowUp");
      if (deck === "both") await files.press("Alt+ArrowLeft");
      await expect.poll(async () => (await layoutState(page, fixture)).layout.terminalTabs.layout).toBe(tabs);
      const before = await layoutState(page, fixture);
      scenario.persistedLayout = before.layout;
      scenario.steps.push("Move Files upward using Alt+ArrowUp; Both also moves Files left with Alt+ArrowLeft; wait for isolated server persistence.");
      await page.reload();
      await expect(page.locator("#promptInput")).toBeVisible();
      await controls(page);
      await expect(page.locator("#terminalTabsLayoutSelect")).toHaveValue(tabs);
      await expect(page.locator("#controlDeckPlacementSelect")).toHaveValue(deck);
      assert.deepEqual((await layoutState(page, fixture)).layout.sidePanel.sectionLayout, before.layout.sidePanel.sectionLayout);
      scenario.sectionStates = await page.locator("[data-side-panel-section-toggle]").evaluateAll((nodes) => nodes.map((node) => ({ section: node.dataset.sidePanelSectionToggle, expanded: node.getAttribute("aria-expanded") })));
      assert.ok(scenario.sectionStates.some((section) => section.expanded === "false"), "customized decks include explicitly collapsed sections");
      await page.locator("#promptInput").fill("Layout baseline draft");
      const customized = await capture(page, scenario, "customized", [...composer, "#modelSelect", "#thinkingSelect"]);
      await assertReachable(page, customized);
      if (tabs === "left" && deck === "right") {
        const rail = customized.regions.find((region) => region.selector === ".terminal-tabs-shell");
        const chat = customized.regions.find((region) => region.selector === "#chat");
        assert.ok(rail.box.width > 900 && chat.box.width < 500, "known sidebar sizing defect is characterized independently of mandatory-control reachability");
        scenario.defects = [{ id: "W0-C-003", severity: "Major", target: "W3 Classic sidebar layout; W7 deck-placement regression", expected: "Session sidebar retains a compact width and leaves most available space to conversation content.", actual: { rail, chat, sidebarWidthProperty: customized.sidebarWidthProperty, regions: customized.regions }, screenshot: customized.screenshot, reproduction: [...scenario.steps] }];
      }
      const side = deck === "left" ? "Left" : "";
      await page.locator(`#toggleSidePanel${side}Button`).click();
      scenario.steps.push(`Collapse ${deck === "left" ? "left" : "right"} deck with its actual toggle; verify composer and expand control.`);
      await assertReachable(page, await capture(page, scenario, "collapsed", [...composer, `#sidePanel${side}ExpandButton`]));
      await expect.poll(async () => (await layoutState(page, fixture)).layout.sidePanel.collapsedPanels[side === "Left" ? "left" : "right"]).toBe(true);
      scenario.collapsedLayout = await layoutState(page, fixture);
    });
  });
}

test("populated custom session groups retain source sessions", async ({ browser, request }) => {
  await withScenario(browser, request, { id: "layout-populated-groups", viewport: { width: 1440, height: 900 } }, async ({ page, fixture, scenario }) => {
    const tabs = [...fixture.tabs];
    for (let index = 0; index < 3; index += 1) {
      tabs.push((await api(page.request, fixture.baseURL, "/api/tabs", { title: `Layout extra ${index + 1}` })).tab);
    }
    const groups = { version: 1, groups: [
      { id: "baseline-review", title: "Review sessions", tabIds: tabs.slice(0, 3).map((tab) => tab.id) },
      { id: "baseline-build", title: "Build sessions", tabIds: tabs.slice(3).map((tab) => tab.id) },
    ] };
    const current = await layoutState(page, fixture);
    await api(page.request, fixture.baseURL, "/api/interface-preferences", { expectedLayoutRevision: current.layoutRevision, layout: { version: 3, terminalTabs: { customGroups: groups } } }, "PUT");
    scenario.steps.push("Create three additional isolated sessions with existing tabs API; persist two named three-session groups through the real interface-preferences API; reload and expand each actual group menu.");
    scenario.groups = groups;
    await page.reload();
    await expect(page.locator(".terminal-tab-custom-group")).toHaveCount(2);
    for (const group of groups.groups) {
      const selector = `[data-custom-group-id="${group.id}"]`;
      await page.locator(`${selector} > .terminal-tab-group-button`).focus();
      await expect(page.locator(`${selector} > .terminal-tab-group-button`)).toHaveAttribute("aria-expanded", "true");
      await expect(page.locator(`${selector} .terminal-tab-group-item-button`)).toHaveCount(3);
      await assertReachable(page, await capture(page, scenario, group.id, [...group.tabIds.map((id) => `${selector} [data-tab-id="${id}"] .terminal-tab-group-item-button`), ...composer]));
    }
    scenario.sessionIds = (await api(page.request, fixture.baseURL, "/api/tabs")).tabs.map((tab) => tab.id);
    assert.deepEqual(new Set(scenario.sessionIds), new Set(tabs.map((tab) => tab.id)));
    assert.deepEqual((await layoutState(page, fixture)).layout.terminalTabs.customGroups, groups);
  });
});

test("explicit split at wide and narrow widths retains source sessions", async ({ browser, request }) => {
  await withScenario(browser, request, { id: "layout-split", viewport: { width: 1920, height: 1080 }, query: "tabletShell=legacy" }, async ({ page, fixture, scenario }) => {
    const sourceIds = fixture.tabs.map((tab) => tab.id);
    await page.locator("#promptInput").fill("Source session draft retained");
    await page.locator(`[data-tab-id="${sourceIds[0]}"] .terminal-tab-split-button`).click();
    await expect(page.locator("#terminalSplitShell")).toBeVisible();
    const splitId = await page.locator("#terminalSplitFrame").getAttribute("data-tab-id");
    assert.ok(splitId && !sourceIds.includes(splitId), "existing split control creates an independent session, not a clone of source history");
    const frame = page.frameLocator("#terminalSplitFrame");
    await expect(frame.locator("#chat")).toContainText("fake answer");
    await frame.locator("#promptInput").fill("Independent split draft");
    scenario.steps.push("Fill source draft; click actual source Split button; verify newly created independent split session and distinct draft.");
    scenario.sourceIds = sourceIds;
    scenario.splitId = splitId;
    for (const viewport of [{ width: 1920, height: 1080 }, { width: 1200, height: 768 }, { width: 1024, height: 768 }, { width: 720, height: 450 }]) {
      await page.setViewportSize(viewport);
      await settle(page);
      await expect(page.locator("#promptInput")).toHaveValue("Source session draft retained");
      await expect(frame.locator("#promptInput")).toHaveValue("Independent split draft");
      scenario.steps.push(`Resize existing split to ${viewport.width}×${viewport.height}; verify both session drafts and API membership.`);
      if (viewport.width > 1050) {
        await expect(page.locator("#terminalSplitShell")).toBeVisible();
        await assertReachable(page, await capture(page, scenario, `${viewport.width}-primary`, [...composer, "#terminalSplitCloseButton"]));
        await assertReachable(frame, await capture(page, scenario, `${viewport.width}-embedded`, composer, frame));
      } else {
        await expect(page.locator("#terminalSplitShell")).toBeHidden();
        const measurement = await capture(page, scenario, `${viewport.width}-hidden-split`, [...composer, "#terminalSplitShell", "#terminalSplitCloseButton"]);
        await assertReachable(page, { ...measurement, controls: measurement.controls.slice(0, composer.length) });
        assert.ok(measurement.controls.slice(composer.length).every((control) => !control.rendered && !control.reachable), "known split presentation failure must remain explicit");
        const primaryBox = await page.locator(".chat-panel").boundingBox();
        assert.ok(primaryBox && primaryBox.width < viewport.width * 0.6, "hidden split still reserves half the workspace");
        scenario.defects ??= [];
        scenario.defects.push({ id: "W0-C-001", severity: "Major", target: "W3 split/narrow layout; W7 resize regression", expected: "An explicit split remains reachable or the primary conversation reclaims the hidden pane space.", actual: { primaryBox, splitDisplay: await page.locator("#terminalSplitShell").evaluate((node) => getComputedStyle(node).display), controls: measurement.controls.slice(composer.length), bodyClasses: measurement.bodyClasses }, screenshot: measurement.screenshot, reproduction: [...scenario.steps] });
      }
      assert.deepEqual(new Set((await api(page.request, fixture.baseURL, "/api/tabs")).tabs.map((tab) => tab.id)), new Set([...sourceIds, splitId]));
    }
    await page.setViewportSize({ width: 1920, height: 1080 });
    await expect(page.locator("#terminalSplitShell")).toBeVisible();
    await expect(frame.locator("#promptInput")).toHaveValue("Independent split draft");
    await page.locator("#terminalSplitCloseButton").click();
    const finalIds = (await api(page.request, fixture.baseURL, "/api/tabs")).tabs.map((tab) => tab.id);
    assert.deepEqual(new Set(finalIds), new Set([...sourceIds, splitId]), "closing split presentation retains every session");
    scenario.finalSessionIds = finalIds;
  });
});

test("200 percent zoom attempt and constrained desktop reflow", async ({ browser, request }) => {
  await withScenario(browser, request, { id: "layout-zoom-200", viewport: { width: 1440, height: 900 }, query: "tabletShell=legacy" }, async ({ page, scenario }) => {
    const before = (await geometry(page, composer)).viewport;
    await page.locator("#chat").click();
    await page.keyboard.press("Control+0");
    for (let step = 0; step < 5; step += 1) await page.keyboard.press("Control++");
    await settle(page);
    const after = (await geometry(page, composer)).viewport;
    const actualZoom = after.devicePixelRatio / before.devicePixelRatio;
    scenario.zoomAttempt = { mechanism: "Control+0 then five Control++ browser shortcuts in headless Chromium", before, after, actualZoom, status: actualZoom >= 1.95 && actualZoom <= 2.05 ? "pass" : "missing", limitation: "Shortcut dispatch may not invoke headless browser chrome. devicePixelRatio and innerWidth verify whether browser zoom changed; visualViewport.scale alone would indicate pinch." };
    await page.keyboard.press("Control+0");
    if (scenario.zoomAttempt.status === "missing") {
      await page.setViewportSize({ width: 720, height: 450 });
      scenario.steps.push("Browser shortcuts did not establish 200% browser zoom; constrain CSS viewport to 720×450, representing the reflow area of a 1440×900 window at 200%. DPR stays 1; visual scale stays 1; no CSS zoom or pinch emulation.");
    }
    await page.locator("#promptInput").fill("200 percent constrained reflow draft");
    await assertReachable(page, await capture(page, scenario, "reflow", composer));
  });
});

for (const shell of ["legacy", "v2"]) {
  for (const [orientation, width, height, constrainedHeight] of [["portrait", 390, 844, 500], ["landscape", 844, 390, 220]]) {
    test(`keyboard-constrained phone ${shell} ${orientation}`, async ({ browser, request }) => {
      await withScenario(browser, request, { id: `layout-keyboard-${shell}-${orientation}`, viewport: { width, height }, isMobile: true, query: `mobileShell=${shell}` }, async ({ page, scenario }) => {
        const draft = `Retained ${shell} ${orientation} draft with attachment`;
        await page.locator("#promptInput").fill(draft);
        await page.locator("#attachmentInput").setInputFiles({ name: "layout-context.txt", mimeType: "text/plain", buffer: Buffer.from("Layout fixture attachment\n") });
        await expect(page.locator("#attachmentTray")).toContainText("layout-context.txt");
        await page.locator("#promptInput").focus();
        scenario.beforeConstraint = (await geometry(page, composer)).viewport;
        await page.setViewportSize({ width, height: constrainedHeight });
        await expect(page.locator("body")).toHaveClass(/mobile-keyboard-open/);
        scenario.steps.push(`Type draft and attach text file through existing file input; focus composer; shrink layout viewport height ${height}→${constrainedHeight} without changing width; keep visualViewport.scale=1. This exercises resize/max-height keyboard detection, not native keyboard occlusion or visual-viewport-only resize.`);
        const measurement = await capture(page, scenario, "draft-attachment", [...composer, "#attachmentTray"]);
        await expect(page.locator("#promptInput")).toHaveValue(draft);
        await expect(page.locator("#attachmentTray")).toContainText("layout-context.txt");
        if (shell === "v2" && orientation === "landscape") {
          const blocked = measurement.controls.filter((control) => !control.reachable);
          assert.deepEqual(blocked.map((control) => control.selector), ["#promptInput", "#attachButton"], "record exact known-defect controls; unexpected failures still fail the test");
          assert.ok(blocked.every((control) => control.hit === "mobileShellIndicators" && control.withinViewport && !control.centerHit));
          const clickErrors = [];
          for (const control of blocked) {
            let failure;
            try { await page.locator(control.selector).click({ trial: true, timeout: 800 }); } catch (error) { failure = error.message; }
            assert.ok(failure?.includes("intercepts pointer events"), "known-defect trial click must confirm pointer interception");
            clickErrors.push({ selector: control.selector, error: failure });
          }
          await assertReachable(page, { ...measurement, controls: measurement.controls.filter((control) => control.reachable) });
          scenario.defects = [{ id: "W0-C-002", severity: "Major", target: "W3 phone layout; W7 keyboard/landscape regression", expected: "Focused prompt and attachment control stay reachable in the constrained viewport.", actual: blocked, clickErrors, screenshot: measurement.screenshot, reproduction: [...scenario.steps] }];
        } else {
          await assertReachable(page, measurement);
        }
        await page.setViewportSize({ width, height });
        await expect(page.locator("#promptInput")).toHaveValue(draft);
        await expect(page.locator("#attachmentTray")).toContainText("layout-context.txt");
        scenario.restored = await geometry(page, composer);
      });
    });
  }
}

test("parent BUG-002 tablet-v2 attachment clipping characterization", async ({ browser, request }) => {
  await withScenario(browser, request, { id: "layout-tablet-v2-bug-002", viewport: { width: 768, height: 1024 }, query: "tabletShell=v2" }, async ({ page, scenario }) => {
    scenario.steps.push("Open existing tablet v2 at 768×1024; measure full mandatory control rectangles and hit targets.");
    const measurement = await capture(page, scenario, "clipping", composer);
    const attachment = measurement.controls.find((entry) => entry.selector === "#attachButton");
    assert.ok(attachment.box.x > 768 && !attachment.reachable, "explicit known-defect characterization, never a layout acceptance assertion");
    let clickError;
    try { await page.locator("#attachButton").click({ trial: true, timeout: 800 }); } catch (error) { clickError = error.message; }
    const afterTrial = await capture(page, scenario, "after-trial-scroll", composer);
    scenario.attachmentTrial = { status: clickError ? "blocked" : "pass-after-automatic-scroll", error: clickError || null, afterTrial };
    assert.ok(!attachment.withinViewport, "automatic trial-click scrolling must not erase the initial clipped geometry");
    scenario.defects = [{ id: "BUG-002", severity: "Major", target: "W3 layout fix; W7 narrow-screen regression", expected: "Composer and attachment fit the tablet viewport and receive pointer input without scrolling the layout sideways.", actual: attachment, trial: scenario.attachmentTrial, screenshot: measurement.screenshot, reproduction: scenario.steps }];
  });
});

test.afterAll(async () => {
  report.summary = Object.fromEntries(["pass", "known-defect", "missing"].map((status) => [status, report.scenarios.filter((scenario) => scenario.status === status).length]));
  report.missingEvidence = [
    { scenario: "native-mobile-keyboard", status: "missing", reason: "No real device or OS software keyboard is available in this headless Chromium fixture." },
    ...(report.scenarios.filter((scenario) => scenario.zoomAttempt?.status === "missing").map((scenario) => ({ scenario: scenario.id, status: "missing", reason: "True browser 200% zoom was not established; only equivalent CSS viewport reflow was measured." }))),
  ];
  await saveJson(join(runDirectory, "layout-report.json"), report);
  if (process.env.PI_OVERHAUL_LAYOUT_UPDATE === "1") {
    assert.equal(report.scenarios.length, 13, "refuse incomplete layout matrix");
    assert.equal(report.summary.missing, 0, "refuse missing scenario evidence; explicit zoom/native omissions remain recorded");
    await saveJson(join(packageRoot, "docs/overhaul/layout-baseline.json"), report);
  }
});
