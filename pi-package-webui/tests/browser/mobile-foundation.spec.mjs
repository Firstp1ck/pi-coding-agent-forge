import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
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

async function assertAxeClean(page, label, selector = "#mobileShellV2", disabledRules = []) {
  let builder = new AxeBuilder({ page }).include(selector);
  if (disabledRules.length) builder = builder.disableRules(disabledRules);
  const accessibility = await builder.analyze();
  const serious = accessibility.violations.filter((violation) => ["serious", "critical"].includes(violation.impact));
  assert.deepEqual(serious, [], `${label} should not introduce serious/critical axe violations: ${serious.map((item) => item.id).join(", ")}`);
}

test.beforeAll(async () => {
  const port = await freePort();
  tempRoot = await mkdtemp(join(tmpdir(), "pi-webui-mobile-browser-"));
  await writeFile(join(tempRoot, "tablet-example.txt"), "tablet file viewer fixture\n", "utf8");
  baseURL = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [serverScript, "--cwd", tempRoot, "--host", "127.0.0.1", "--port", String(port), "--pi", fakePi], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PI_WEBUI_RPC_SUPERVISOR: "0",
      FAKE_PI_CONTINUITY_MODE: "1",
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

test("v2 flag is isolated on desktop and rollback remains explicit", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/?mobileShell=v2`);
  await expect(page.locator("#promptInput")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-mobile-shell", "v2");
  await expect(page.locator(".layout")).toHaveCSS("grid-template-columns", /.+/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/?mobileShell=legacy`);
  await expect(page.locator("#promptInput")).toBeVisible();
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-shell");
  await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate", {
    state: {
      piMobileShellV2: true,
      mobileShellState: { featureMode: "v2", tabletFeatureMode: "v2", viewportMode: "phone", route: "sessions", surface: "none", routeHistory: ["chat"] },
    },
  })));
  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-shell");
  await expect(page.locator("#mobileShellV2")).toBeHidden();
});

test("the main prompt scrolls vertically after bounded auto-growth", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(baseURL);
  const prompt = page.locator("#promptInput");
  const longPrompt = Array.from({ length: 20 }, (_, index) => `line ${index + 1}: keep this prompt line reachable`).join("\n");

  await prompt.fill(longPrompt);
  const longMetrics = await prompt.evaluate((node) => {
    const style = getComputedStyle(node);
    node.scrollTop = node.scrollHeight;
    return {
      clientHeight: node.clientHeight,
      maxHeight: Number.parseFloat(style.maxHeight),
      overflowY: style.overflowY,
      scrollHeight: node.scrollHeight,
      scrollTop: node.scrollTop,
    };
  });
  assert.equal(longMetrics.overflowY, "auto");
  assert.ok(longMetrics.scrollHeight > longMetrics.clientHeight + 1, `long prompt should overflow vertically: ${JSON.stringify(longMetrics)}`);
  assert.ok(longMetrics.scrollTop > 0, `long prompt should accept vertical scrolling: ${JSON.stringify(longMetrics)}`);
  assert.ok(longMetrics.clientHeight <= longMetrics.maxHeight + 1, `prompt should retain its height cap: ${JSON.stringify(longMetrics)}`);

  await prompt.fill("short prompt");
  const shortMetrics = await prompt.evaluate((node) => ({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight }));
  assert.ok(shortMetrics.clientHeight < longMetrics.clientHeight, `short prompt should shrink after long input: ${JSON.stringify(shortMetrics)}`);
});

test("legacy phone keeps terminal navigation and secondary composer actions collapsed", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?mobileShell=legacy`);
  await page.addStyleTag({ content: "#optionalFeatureMigrationSurface, #updateNotification { display: none !important; }" });

  await expect(page.locator("html")).not.toHaveAttribute("data-mobile-shell");
  await expect(page.locator("body")).toHaveClass(/mobile-composer-disclosure/);
  await expect(page.locator("#terminalTabsDrawerContent")).toBeHidden();
  await expect(page.locator("#terminalTabsBackdrop")).toBeHidden();
  await expect(page.locator("#terminalTabsToggleButton")).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#promptInput")).toBeVisible();
  await expect(page.locator("#attachButton")).toBeVisible();
  await expect(page.locator("#composerActionsButton")).toBeVisible();
  await expect(page.locator("#sendButton")).toBeVisible();
  await expect(page.locator("#composerActionsPanel")).toBeHidden();
  const legacyDensity = await page.evaluate(() => ({
    controlSize: getComputedStyle(document.documentElement).getPropertyValue("--mobile-control-size").trim(),
    bodyFontSize: Number.parseFloat(getComputedStyle(document.body).fontSize),
    attachSize: document.querySelector("#attachButton").getBoundingClientRect().width,
  }));
  assert.equal(legacyDensity.controlSize, "40px");
  assert.ok(legacyDensity.bodyFontSize <= 14, `legacy mobile body text should use the balanced compact scale, got ${legacyDensity.bodyFontSize}px`);
  assert.equal(legacyDensity.attachSize, 40, `legacy attachment control should use the selected 40px target, got ${legacyDensity.attachSize}px`);

  await page.evaluate(() => {
    const widget = document.createElement("details");
    widget.id = "mobileTodoProgressFixture";
    widget.className = "widget todo-widget";
    widget.innerHTML = `
      <summary class="todo-widget-summary">
        <div class="todo-widget-goal">Goal: Keep mobile progress compact</div>
        <div class="todo-widget-header">
          <span class="todo-widget-toggle">›</span>
          <span class="todo-widget-title">Todo progress</span>
          <span class="todo-widget-count">1/3</span>
          <span class="todo-widget-meta">active</span>
        </div>
        <div class="todo-widget-progress"><span class="todo-widget-progress-fill" style="width: 33%"></span></div>
      </summary>
      <div class="todo-widget-body"><ol class="todo-widget-list"><li class="todo-widget-item partial"><span class="todo-widget-marker">–</span><span class="todo-widget-text">Add regression coverage</span></li></ol></div>
    `;
    document.querySelector(".widget-area").append(widget);
  });
  const mobileTodo = page.locator("#mobileTodoProgressFixture");
  const collapsedTodoSummary = await mobileTodo.locator("summary").boundingBox();
  assert.ok(collapsedTodoSummary && collapsedTodoSummary.height <= 24, `collapsed mobile todo progress should be one line, got ${JSON.stringify(collapsedTodoSummary)}`);
  await expect(mobileTodo.locator(".todo-widget-goal")).toBeHidden();
  await expect(mobileTodo.locator(".todo-widget-progress")).toBeHidden();
  await expect(mobileTodo.locator(".todo-widget-body")).toBeHidden();
  await mobileTodo.locator("summary").tap();
  await expect(mobileTodo).toHaveAttribute("open", "");
  await expect(mobileTodo.locator(".todo-widget-goal")).toBeVisible();
  await expect(mobileTodo.locator(".todo-widget-progress")).toBeVisible();
  await expect(mobileTodo.locator(".todo-widget-body")).toBeVisible();
  await mobileTodo.evaluate((node) => node.remove());

  await page.locator("#terminalTabsToggleButton").tap();
  await expect(page.locator("#footerFloatingTooltip")).toHaveCount(0);
  await expect(page.locator("#terminalTabsToggleButton")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#terminalTabsDrawerContent")).toBeVisible();
  await expect(page.locator("#terminalTabsBackdrop")).toBeVisible();
  await expect(page.locator(".terminal-sidebar-actions")).toBeVisible();
  await expect(page.locator("#closeAllTabsButton")).toBeVisible();
  const drawer = await page.locator(".terminal-tabs-shell").boundingBox();
  assert.ok(drawer && drawer.x === 0 && drawer.y === 0 && drawer.width === 390 && drawer.height === 844, `terminal navigation should fill 390×844, got ${JSON.stringify(drawer)}`);
  await expect(page.locator("#sidePanelExpandButton")).toBeHidden();
  await page.locator("#terminalTabsToggleButton").tap();
  await expect(page.locator("#terminalTabsDrawerContent")).toBeHidden();
  await expect(page.locator("#terminalTabsToggleButton")).toBeFocused();
  await page.setViewportSize({ width: 320, height: 720 });
  await page.locator("#terminalTabsToggleButton").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminalTabsDrawerContent")).toBeVisible();
  const narrowDrawer = await page.locator(".terminal-tabs-shell").boundingBox();
  assert.ok(narrowDrawer && narrowDrawer.x === 0 && narrowDrawer.y === 0 && narrowDrawer.width === 320 && narrowDrawer.height === 720, `terminal navigation should fill 320×720, got ${JSON.stringify(narrowDrawer)}`);
  await expect(page.locator("#sidePanelExpandButton")).toBeHidden();
  await expect(page.locator(".terminal-tabs-shell")).toHaveAttribute("role", "dialog");
  await expect(page.locator(".terminal-tabs-shell")).toHaveAttribute("aria-modal", "true");

  await page.locator("#newTabButton").tap();
  await expect(page.locator("#newTabMenuPanel")).toBeVisible();
  let drawerLayers = await page.evaluate(() => ({
    drawer: Number.parseInt(getComputedStyle(document.querySelector(".terminal-tabs-shell")).zIndex, 10),
    backdrop: Number.parseInt(getComputedStyle(document.querySelector("#terminalTabsBackdrop")).zIndex, 10),
  }));
  assert.ok(drawerLayers.drawer > drawerLayers.backdrop, `open + Tab options must remain above the blurred backdrop, got ${JSON.stringify(drawerLayers)}`);

  await page.evaluate(() => {
    const fixture = document.createElement("div");
    fixture.id = "mobileGroupToggleFixture";
    fixture.className = "terminal-tab terminal-tab-group";
    const button = document.createElement("button");
    button.className = "terminal-tab-button terminal-tab-group-button";
    button.setAttribute("aria-expanded", "false");
    button.innerHTML = '<span class="terminal-tab-title-row"><span class="terminal-tab-title">Fixture group</span><span class="terminal-tab-group-dropdown-indicator">⌄</span></span><span class="terminal-tab-meta">project-cwd · idle</span>';
    const menu = document.createElement("div");
    menu.className = "terminal-tab-group-menu";
    menu.textContent = "Fixture terminal";
    button.addEventListener("click", () => {
      const open = !fixture.classList.contains("menu-open");
      fixture.classList.toggle("menu-open", open);
      button.setAttribute("aria-expanded", String(open));
    });
    fixture.append(button, menu);

    const visibilityFixture = document.createElement("div");
    visibilityFixture.id = "mobileGroupedTabsVisibilityFixture";
    visibilityFixture.className = "terminal-tabs";
    for (const label of ["group-a", "group-b"]) {
      const group = document.createElement("div");
      group.className = "terminal-tab terminal-tab-group";
      group.dataset.groupKey = label;
      visibilityFixture.append(group);
    }
    const overallNewTab = document.createElement("div");
    overallNewTab.id = "mobileOverallNewTabFixture";
    overallNewTab.className = "terminal-new-tab-menu composer-publish-menu";
    overallNewTab.textContent = "+ Tab";
    visibilityFixture.append(overallNewTab);

    document.querySelector("#terminalTabsDrawerContent").append(fixture, visibilityFixture);
  });
  await expect(page.locator("#mobileOverallNewTabFixture")).toBeVisible();
  await page.locator("#mobileGroupedTabsVisibilityFixture > .terminal-tab-group").first().evaluate((node) => node.classList.add("menu-open"));
  await expect(page.locator("#mobileOverallNewTabFixture")).toBeHidden();
  await page.locator("#mobileGroupedTabsVisibilityFixture > .terminal-tab-group").first().evaluate((node) => node.classList.remove("menu-open"));
  await expect(page.locator("#mobileOverallNewTabFixture")).toBeVisible();
  await page.locator("#mobileGroupedTabsVisibilityFixture").evaluate((node) => node.remove());
  const mobileGroupFixture = page.locator("#mobileGroupToggleFixture");
  const mobileGroupFixtureButton = mobileGroupFixture.locator(".terminal-tab-group-button");
  const mobileGroupFixtureMenu = mobileGroupFixture.locator(".terminal-tab-group-menu");
  await expect(mobileGroupFixtureButton.locator(".terminal-tab-meta")).toBeVisible();
  await expect(mobileGroupFixtureButton.locator(".terminal-tab-meta")).toContainText("project-cwd");
  await mobileGroupFixtureButton.tap();
  await expect(page.locator("#newTabMenuPanel")).toBeHidden();
  await expect(mobileGroupFixtureButton).toHaveAttribute("aria-expanded", "true");
  await expect(mobileGroupFixtureMenu).toBeVisible();
  drawerLayers = await page.evaluate(() => ({
    drawer: Number.parseInt(getComputedStyle(document.querySelector(".terminal-tabs-shell")).zIndex, 10),
    backdrop: Number.parseInt(getComputedStyle(document.querySelector("#terminalTabsBackdrop")).zIndex, 10),
  }));
  assert.ok(drawerLayers.drawer > drawerLayers.backdrop, `open group options must remain above the blurred backdrop, got ${JSON.stringify(drawerLayers)}`);
  await mobileGroupFixtureButton.tap();
  await expect(mobileGroupFixtureButton).toHaveAttribute("aria-expanded", "false");
  await expect(mobileGroupFixtureMenu).toBeHidden();
  await mobileGroupFixture.evaluate((node) => node.remove());

  await page.locator("#closeAllTabsButton").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#terminalTabsToggleButton")).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest?.(".terminal-tabs-shell") !== null)).toBe(true);
  await assertAxeClean(page, "legacy terminal drawer", ".terminal-tabs-shell", ["aria-required-children"]);
  await page.keyboard.press("Escape");
  await expect(page.locator("#terminalTabsDrawerContent")).toBeHidden();
  await expect(page.locator("#terminalTabsToggleButton")).toBeFocused();

  await page.locator("#composerActionsButton").focus();
  await page.locator("#composerActionsButton").click();
  await expect(page.locator("#composerActionsButton")).toHaveText("−");
  await expect(page.locator("#composerActionsButton")).toHaveAttribute("aria-label", "Minimize more composer actions");
  await expect(page.locator("#composerActionsPanel")).toBeVisible();
  await expect(page.locator("#sidePanelExpandButton")).toBeHidden();
  const moreOverlayBox = await page.locator("#composerActionsPanel").boundingBox();
  assert.ok(moreOverlayBox && moreOverlayBox.x === 0 && moreOverlayBox.y === 0 && moreOverlayBox.width === 320 && moreOverlayBox.height === 720, `mobile More actions should fill 320×720, got ${JSON.stringify(moreOverlayBox)}`);
  const minimizeButtonBox = await page.locator("#composerActionsButton").boundingBox();
  assert.ok(minimizeButtonBox && minimizeButtonBox.y < 60 && minimizeButtonBox.width === 40 && minimizeButtonBox.height === 40 && minimizeButtonBox.x + minimizeButtonBox.width <= 320, `mobile minimize should remain compact and reachable at the top-right of the full-screen overlay, got ${JSON.stringify(minimizeButtonBox)}`);
  await expect(page.getByRole("heading", { name: "Session & workspace" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Tools & commands" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Context & modes" })).toBeVisible();
  await expect(page.locator("#newSessionButton")).toBeVisible();
  await expect(page.locator("#optionsMenuButton")).toBeVisible();
  await expect.poll(() => page.locator("#workflowModeControls").evaluate((node) => node.parentElement?.id)).toBe("composerActionsPanel");
  await expect.poll(() => page.locator("#btwButton").evaluate((node) => node.parentElement?.id)).toBe("composerActionsPanel");
  await page.keyboard.press("Escape");
  await expect(page.locator("#composerActionsPanel")).toBeHidden();
  await expect(page.locator("#sidePanelExpandButton")).toBeVisible();
  await expect(page.locator("#composerActionsButton")).toHaveText("More");
  await expect(page.locator("#composerActionsButton")).toBeFocused();

  await page.locator("#sidePanelExpandButton").click();
  await expect(page.locator("#sidePanel")).toBeVisible();
  await expect(page.getByText("Control Deck", { exact: true })).toBeVisible();
  const editSectionsButton = page.locator("#sidePanelEditButton");
  await expect(editSectionsButton).toHaveText(/Edit/);
  await expect(editSectionsButton).toHaveAttribute("aria-pressed", "false");
  const dragVisibleSections = (pointerId) => page.evaluate((id) => {
    const sections = [...document.querySelectorAll("[data-side-panel-section]")].filter((section) => !section.hidden);
    const source = sections[0]?.querySelector("[data-side-panel-section-toggle]");
    const target = sections[1]?.querySelector("[data-side-panel-section-toggle]");
    const before = sections.map((section) => section.dataset.sidePanelSection);
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    source.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: id, button: 0, clientX: sourceRect.left + 10, clientY: sourceRect.top + 10 }));
    window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: id, button: 0, clientX: targetRect.left + 10, clientY: targetRect.bottom - 4 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: id, button: 0, clientX: targetRect.left + 10, clientY: targetRect.bottom - 4 }));
    return {
      before,
      after: [...document.querySelectorAll("[data-side-panel-section]")].filter((section) => !section.hidden).map((section) => section.dataset.sidePanelSection),
      title: source.title,
      touchAction: getComputedStyle(source).touchAction,
      storedOrder: JSON.parse(localStorage.getItem("pi-webui-side-panel-section-order-v1") || "[]"),
    };
  }, pointerId);

  const lockedDragResult = await dragVisibleSections(71);
  assert.deepEqual(lockedDragResult.after, lockedDragResult.before, "Control Deck sections must remain locked before Edit is activated");
  assert.doesNotMatch(lockedDragResult.title, /drag|Alt\+/i, "locked section titles should not advertise reorder controls");
  assert.equal(lockedDragResult.touchAction, "manipulation", "locked section headers should retain native tap/scroll behavior");

  await editSectionsButton.tap();
  await expect(editSectionsButton).toHaveText(/Done/);
  await expect(editSectionsButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#sidePanel")).toHaveClass(/section-edit-mode/);
  await expect(page.locator("#sidePanelEditHint")).toBeVisible();
  const editableDragResult = await dragVisibleSections(72);
  assert.notDeepEqual(editableDragResult.after, editableDragResult.before, "Edit mode should enable touch/pointer section reordering");
  assert.match(editableDragResult.title, /drag to reorder · Alt\+↑\/↓ moves/, "Edit mode should advertise pointer and keyboard movement");
  assert.equal(editableDragResult.touchAction, "none", "Edit mode should reserve section-header gestures for drag movement");
  assert.deepEqual(editableDragResult.storedOrder.slice(0, editableDragResult.after.length), editableDragResult.after, "Edit-mode drag order should persist through the existing layout preference");

  const keyboardOrderBefore = await page.locator("[data-side-panel-section]:not([hidden])").evaluateAll((sections) => sections.map((section) => section.dataset.sidePanelSection));
  await page.locator("[data-side-panel-section]:not([hidden]) [data-side-panel-section-toggle]").first().focus();
  await page.keyboard.press("Alt+ArrowDown");
  const keyboardOrderAfter = await page.locator("[data-side-panel-section]:not([hidden])").evaluateAll((sections) => sections.map((section) => section.dataset.sidePanelSection));
  assert.notDeepEqual(keyboardOrderAfter, keyboardOrderBefore, "Edit mode should enable accessible Alt+Arrow section movement");

  await editSectionsButton.tap();
  await expect(editSectionsButton).toHaveText(/Edit/);
  await expect(editSectionsButton).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#sidePanel")).not.toHaveClass(/section-edit-mode/);
  await expect(page.locator("#sidePanelEditHint")).toBeHidden();
  const doneDragResult = await dragVisibleSections(73);
  assert.deepEqual(doneDragResult.after, doneDragResult.before, "Done should lock Control Deck section order again");

  await editSectionsButton.tap();
  await page.locator("#toggleSidePanelButton").click();
  await expect(editSectionsButton).toHaveAttribute("aria-pressed", "false");

  await page.evaluate(() => {
    const statusBar = document.querySelector("#statusBar");
    statusBar.className = "statusbar statusbar-git-footer";
    statusBar.replaceChildren();
    const metric = (icon, label, value) => {
      const node = document.createElement("span");
      node.className = "footer-metric";
      node.innerHTML = `<span class="footer-metric-icon">${icon}</span><span class="footer-metric-label">${label}</span><span class="footer-metric-value">${value}</span>`;
      return node;
    };
    const meta = (className, label, value) => {
      const node = document.createElement("span");
      node.className = `footer-meta ${className}`;
      node.innerHTML = `<span class="footer-meta-label">${label}</span><span class="footer-meta-value">${value}</span>`;
      return node;
    };
    const main = document.createElement("div");
    main.className = "footer-line footer-line-main";
    main.append(
      metric("🪙", "tokens", "↑1.1M · ↓76k"),
      metric("π", "pi", "21k tok"),
      metric("⚡", "speed", "76k tok @ 35.1/s"),
      metric("🧠", "context", "59.8%/272k"),
      metric("📊", "usage", "weekly 2% · session 8%"),
    );
    const details = document.createElement("button");
    details.className = "footer-details-toggle";
    details.textContent = "−";
    details.setAttribute("aria-label", "Minimize Git footer details");
    const metadata = document.createElement("div");
    metadata.className = "footer-line footer-line-meta";
    metadata.append(
      meta("footer-worktree", "git+", "🕘 1h"),
      meta("footer-workspace", "cwd", "~/npm-packages"),
      meta("footer-context", "context", "59.8%/272k (auto)"),
      meta("footer-branch", "git", "main"),
      meta("footer-changes", "changes", "✏️ 13 · ✓ fetch"),
      meta("footer-model", "model", "(openai-codex) gpt-5.6-sol"),
      meta("footer-thinking", "effort", "high"),
      details,
    );
    const refresh = document.createElement("button");
    refresh.className = "git-footer-refresh-button";
    refresh.textContent = "↻";
    statusBar.append(main, metadata, refresh);
    document.body.classList.add("footer-details-expanded");
  });
  const footerOverlay = page.locator("#statusBar");
  const footerOverlayBox = await footerOverlay.boundingBox();
  assert.ok(footerOverlayBox && footerOverlayBox.x === 0 && footerOverlayBox.y === 0 && footerOverlayBox.width === 320 && footerOverlayBox.height === 720, `mobile Git footer details should fill 320×720, got ${JSON.stringify(footerOverlayBox)}`);
  await expect(footerOverlay.locator(".footer-details-toggle")).toHaveText("−");
  await expect(footerOverlay.locator(".footer-details-toggle")).toHaveAttribute("aria-label", "Minimize Git footer details");
  await expect(footerOverlay.locator(".git-footer-refresh-button")).toBeVisible();
  const footerDetailsLayout = await footerOverlay.evaluate((node) => {
    const main = node.querySelector(".footer-line-main");
    const metadata = node.querySelector(".footer-line-meta");
    const metrics = [...main.querySelectorAll(".footer-metric")].map((item) => item.getBoundingClientRect());
    const workspace = metadata.querySelector(".footer-workspace").getBoundingClientRect();
    const branch = metadata.querySelector(".footer-branch").getBoundingClientRect();
    const metaCards = [...metadata.querySelectorAll(".footer-meta")].map((item) => item.getBoundingClientRect());
    return {
      alignContent: getComputedStyle(node).alignContent,
      mainColumns: getComputedStyle(main).gridTemplateColumns,
      metaColumns: getComputedStyle(metadata).gridTemplateColumns,
      mainHeading: getComputedStyle(main, "::before").content,
      metaHeading: getComputedStyle(metadata, "::before").content,
      firstMetricWidth: metrics[0].width,
      lastMetricWidth: metrics.at(-1).width,
      maxMetricHeight: Math.max(...metrics.map((item) => item.height)),
      workspaceWidth: workspace.width,
      branchWidth: branch.width,
      maxMetaHeight: Math.max(...metaCards.map((item) => item.height)),
    };
  });
  assert.equal(footerDetailsLayout.alignContent, "start", "expanded footer rows should pack at the top instead of stretching across the viewport");
  assert.match(footerDetailsLayout.mainColumns, /px .*px/, "session metrics should use two balanced columns");
  assert.match(footerDetailsLayout.metaColumns, /px .*px/, "workspace and Git metadata should use two balanced columns");
  assert.equal(footerDetailsLayout.mainHeading, '"Session"');
  assert.equal(footerDetailsLayout.metaHeading, '"Workspace, Git & runtime"');
  assert.ok(footerDetailsLayout.lastMetricWidth >= footerDetailsLayout.firstMetricWidth * 1.9, `an odd final metric should span both columns, got ${JSON.stringify(footerDetailsLayout)}`);
  assert.ok(footerDetailsLayout.workspaceWidth >= footerDetailsLayout.branchWidth * 1.9, `long workspace metadata should span both columns, got ${JSON.stringify(footerDetailsLayout)}`);
  assert.ok(footerDetailsLayout.maxMetricHeight <= 52 && footerDetailsLayout.maxMetaHeight <= 46, `footer cards should stay compact, got ${JSON.stringify(footerDetailsLayout)}`);
  await expect(page.locator("#sidePanelExpandButton")).toBeHidden();
  await page.evaluate(() => document.body.classList.remove("footer-details-expanded"));
  await expect(footerOverlay.locator(".git-footer-refresh-button")).toBeHidden();

  await context.close();

  const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const desktopPage = await desktopContext.newPage();
  await desktopPage.goto(`${baseURL}/?mobileShell=legacy`);
  await desktopPage.addStyleTag({ content: "#optionalFeatureMigrationSurface, #updateNotification { display: none !important; }" });
  await expect(desktopPage.locator("#terminalTabsToggleButton")).toBeHidden();
  await expect.poll(() => desktopPage.locator("#workflowModeControls").evaluate((node) => node.parentElement?.className)).toContain("composer-input-row");
  await expect.poll(() => desktopPage.locator("#btwButton").evaluate((node) => node.parentElement?.className)).toContain("composer-row");
  await desktopContext.close();
});

test("phone v2 destinations, canonical actions, history, and presentation remain functional", async ({ browser }) => {
  const phoneContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await phoneContext.newPage();
  await page.goto(`${baseURL}/?mobileShell=v2`);
  await expect(page.locator("html")).toHaveAttribute("data-mobile-shell", "v2");
  await expect(page.locator("#mobileShellV2")).toBeVisible();
  const v2Density = await page.evaluate(() => {
    const appbar = document.querySelector(".mobile-shell-appbar");
    const nav = document.querySelector(".mobile-shell-nav");
    return {
      controlSize: getComputedStyle(document.documentElement).getPropertyValue("--mobile-control-size").trim(),
      appbarHeight: appbar.getBoundingClientRect().height,
      appbarMinHeight: Number.parseFloat(getComputedStyle(appbar).minHeight),
      appbarGridRows: getComputedStyle(appbar).gridTemplateRows,
      appbarPadding: `${getComputedStyle(appbar).paddingTop} ${getComputedStyle(appbar).paddingBottom}`,
      sessionHeight: document.querySelector("#mobileSessionButton").getBoundingClientRect().height,
      indicatorHeight: document.querySelector("#mobileShellIndicators").getBoundingClientRect().height,
      searchHeight: document.querySelector("#mobileSearchButton").getBoundingClientRect().height,
      navHeight: nav.getBoundingClientRect().height,
      navMinHeight: Number.parseFloat(getComputedStyle(nav).minHeight),
    };
  });
  assert.equal(v2Density.controlSize, "40px");
  assert.ok(v2Density.appbarHeight <= v2Density.appbarMinHeight + 2 && v2Density.navHeight <= v2Density.navMinHeight + 0.5, `v2 chrome should stay at its compact safe-area-aware minimum, got ${JSON.stringify(v2Density)}`);
  for (const selector of ["#mobileSessionButton", "#mobileSearchButton", "#mobileMoreButton", "#attachButton", "#composerActionsButton", "#sendButton"]) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box, `${selector} should have a box`);
    assert.ok(box.width >= 40 && box.height >= 40, `${selector} should meet the selected 40px target floor, got ${box.width}×${box.height}`);
  }
  const phoneNav = page.getByRole("navigation", { name: "Phone destinations" });
  await expect(phoneNav.getByRole("button")).toHaveCount(4);
  await expect(page.locator("#chat")).not.toHaveAttribute("aria-live");
  await assertAxeClean(page, "phone Chat route");

  await phoneNav.getByRole("button", { name: "Sessions", exact: true }).click();
  await expect(page.locator("#mobileSessionsRoute")).toBeVisible();
  await expect(page.locator("#mobileSessionsTitle")).toBeFocused();
  await expect(page.locator(".layout")).toHaveAttribute("inert", "");
  await expect(page.locator(".layout")).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator("#mobileShellDestination")).toHaveAttribute("role", "main");
  await expect(page.locator("#mobileSessionsSearchInput")).toBeVisible();
  await page.locator("#promptInput").evaluate((node) => { node.value = "draft survives switch"; node.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.locator("#mobileNewCurrentDirectoryButton").click();
  await expect(page.locator(".mobile-session-select")).toHaveCount(2);
  await page.locator(".mobile-session-select").first().click();
  await expect(page.locator("#promptInput")).toHaveValue("draft survives switch");
  await assertAxeClean(page, "phone Sessions route");

  await phoneNav.getByRole("button", { name: "Activity", exact: true }).click();
  await expect(page.locator("#mobileActivityRoute")).toBeVisible();
  await expect(page.locator("#mobileActivityTitle")).toBeFocused();
  await expect(page.locator("#mobileActivityStatus")).toBeVisible();
  await assertAxeClean(page, "phone Activity route");
  await phoneNav.getByRole("button", { name: "Project", exact: true }).click();
  await expect(page.locator("#mobileProjectRoute")).toBeVisible();
  await expect(page.locator("#mobileProjectTitle")).toBeFocused();
  await page.getByRole("tab", { name: "Files" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Git" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.locator("#fileTreeRoot")).toBeVisible();
  await page.getByRole("tab", { name: "Queue" }).click();
  await expect(page.locator("#queueBox")).toBeVisible();
  await assertAxeClean(page, "phone Project route");

  await phoneNav.getByRole("button", { name: "Chat", exact: true }).click();
  await page.locator("#composerActionsButton").focus();
  await page.locator("#composerActionsButton").click();
  await expect(page.locator("#mobileShellSurface")).toBeVisible();
  await expect(page.locator("#mobileShellSurface")).toHaveAttribute("role", "dialog");
  await expect(page.locator("#mobileShellSurface")).toHaveAttribute("aria-modal", "true");
  await page.getByRole("button", { name: "Session actions" }).click();
  await page.getByRole("button", { name: "Command palette", exact: true }).click();
  await expect(page.locator("#commandPaletteDialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#commandPaletteDialog")).toBeHidden();
  await expect(page.locator("#mobileShellSurface")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Session actions" })).toBeVisible();
  await page.locator("#mobileSurfaceBackButton").click();
  await page.getByRole("button", { name: "Voice" }).click();
  await expect(page.getByRole("heading", { name: "Voice" })).toBeVisible();
  await assertAxeClean(page, "phone action sheet");
  await page.locator("#mobileSurfaceBackButton").click();
  await page.locator("#mobileSurfaceCloseButton").click();
  await expect(page.locator("#mobileShellSurface")).toBeHidden();
  await expect(page.locator("#composerActionsButton")).toBeFocused();

  await page.locator("#mobileMoreButton").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.locator("#modelSelect")).toBeVisible();
  await page.locator("#thinkingSelect").focus();
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(500);
  await expect(page.locator("#thinkingSelect")).toBeFocused();
  await page.locator("#mobileSurfaceBackButton").click();
  await page.getByRole("button", { name: "Detailed" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-mobile-presentation", "detailed");
  await assertAxeClean(page, "phone More/Settings surface");
  await page.locator("#mobileSurfaceCloseButton").click();

  await phoneNav.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.goBack();
  await expect(phoneNav.getByRole("button", { name: "Chat", exact: true })).toHaveAttribute("aria-current", "page");
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(page.locator("#mobileShellV2")).toBeVisible();

  await assertAxeClean(page, "phone shell after history and rotation");
  await phoneContext.close();
});

test("mobile model search retains focus while agent output streams", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?mobileShell=v2`);
  await page.locator("#updateNotification").evaluate((notification) => { notification.hidden = true; notification.classList.remove("show"); });

  await page.locator("#mobileMoreButton").click();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.locator("#modelControlLabel").click();
  const modelSearch = page.locator("#modelSearchInput");
  await expect(modelSearch).toBeVisible();
  await modelSearch.fill("gpt");

  const tabsPayload = await (await page.request.get(`${baseURL}/api/tabs`)).json();
  const streamingTabId = tabsPayload.data.activeTabId || tabsPayload.data.tabs[0].id;
  const streamResponse = await page.request.post(`${baseURL}/api/prompt?tab=${encodeURIComponent(streamingTabId)}`, {
    data: { message: "fixture continuity delayed stream", requestId: `model-search-focus-${Date.now()}` },
  });
  assert.equal(streamResponse.ok(), true);
  await expect(page.locator(".message.assistant.streaming .streaming-markdown").last()).toContainText("continuity stream");
  await expect(modelSearch).toBeFocused();
  await expect(modelSearch).toHaveValue("gpt");
  await context.close();
});

test("mobile continuity preserves drafts, restores metadata honestly, and retries only on command", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?mobileShell=v2`);
  await page.locator("#promptInput").fill("offline continuity draft");
  await page.locator("#attachmentInput").setInputFiles({ name: "context.txt", mimeType: "text/plain", buffer: Buffer.from("context") });
  await expect(page.locator("#attachmentTray")).toContainText("context.txt");
  await page.reload();
  await expect(page.locator("#promptInput")).toHaveValue("offline continuity draft");
  await expect(page.locator("#attachmentTray")).toContainText("Reselect required");

  await page.locator("#attachButton").click();
  await expect(page.getByRole("heading", { name: "Add Context" })).toBeVisible();
  for (const name of ["Camera", "Photos", "Files"]) await expect(page.locator("#mobileSurfaceRoot").getByRole("button", { name, exact: true })).toBeVisible();
  await expect(page.locator("#mobileSurfaceRoot").getByText("Paste text", { exact: true })).toBeVisible();
  const pasteInput = page.locator(".mobile-paste-context-text");
  const pasteDraft = Array.from({ length: 18 }, (_, index) => `pasted context line ${index}`).join("\n");
  await pasteInput.fill(pasteDraft);
  const pasteBefore = await pasteInput.evaluate((node) => {
    node.focus();
    node.setSelectionRange(14, 41, "backward");
    node.scrollTop = 48;
    return { value: node.value, selectionStart: node.selectionStart, selectionEnd: node.selectionEnd, selectionDirection: node.selectionDirection, scrollTop: node.scrollTop };
  });
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(pasteInput).toBeFocused();
  await expect.poll(() => pasteInput.evaluate((node) => ({
    value: node.value,
    selectionStart: node.selectionStart,
    selectionEnd: node.selectionEnd,
    selectionDirection: node.selectionDirection,
    scrollTop: node.scrollTop,
  }))).toEqual(pasteBefore);
  await page.locator("#mobileSurfaceCloseButton").click();
  await page.locator(".attachment-remove-button").click();

  await context.setOffline(true);
  await page.locator("#sendButton").click();
  await expect(page.locator("#mobileFailedSendRecovery")).toBeVisible();
  await expect(page.locator("#mobileFailedSendRecovery")).toContainText("never retry automatically");
  await assertAxeClean(page, "failed-send recovery", "#mobileFailedSendRecovery");
  await context.setOffline(false);
  await page.locator("#mobileFailedSendRetryButton").click();
  await expect(page.locator("#mobileFailedSendRecovery")).toBeHidden();

  const tabsResponse = await page.request.get(`${baseURL}/api/tabs`);
  const tabsPayload = await tabsResponse.json();
  const tabId = tabsPayload.data.tabs[0].id;
  await page.goto(`${baseURL}/?mobileShell=v2&mobileRoute=activity&tab=${encodeURIComponent(tabId)}`);
  await expect(page.locator("#mobileActivityRoute")).toBeVisible();
  await expect(page.locator("#mobileContinuityNotice")).toContainText("checking current server state");

  await page.goto(`${baseURL}/?mobileShell=v2&mobileRoute=activity&tab=stale_tab_12345678`);
  await expect(page.locator("#mobileContinuityNotice")).toContainText("no longer available");
  await expect(page.locator("#mobileSessionsRoute")).toBeVisible();
  await context.close();
});

test("an extension response clears stale local running state after canonical idle", async ({ page }) => {
  await page.goto(baseURL);
  await page.locator("#promptInput").fill("fixture mobile blocker");
  await page.locator("#sendButton").click();
  await expect(page.locator("#dialogTitle")).toHaveText("Fixture blocker");
  await expect(page.locator("#runIndicatorHost .runIndicator")).toContainText("Waiting for your confirm response…");
  await page.locator("#dialogActions").getByRole("button", { name: "Yes", exact: true }).click();
  await expect(page.locator("#dialog")).not.toBeVisible();
  await expect(page.locator("#runIndicatorHost .runIndicator")).toBeHidden({ timeout: 5_000 });
});

test("a blocker notification switches to its background tab before exact-target validation", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?mobileShell=v2`);
  const initialTabs = await (await page.request.get(`${baseURL}/api/tabs`)).json();
  const targetTabId = initialTabs.data.tabs[0].id;
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.locator("#mobileNewCurrentDirectoryButton").click();
  await expect(page.locator(".mobile-session-select")).toHaveCount(2);
  const currentTabs = await (await page.request.get(`${baseURL}/api/tabs`)).json();
  const activeTabId = currentTabs.data.activeTabId || currentTabs.data.tabs.find((tab) => tab.id !== targetTabId)?.id;
  assert.notEqual(activeTabId, targetTabId, "fixture requires a different active tab");
  const requestId = `fixture_request_${Date.now()}`;
  const response = await page.request.post(`${baseURL}/api/prompt?tab=${encodeURIComponent(targetTabId)}`, { data: { message: "fixture mobile blocker", requestId } });
  assert.equal(response.ok(), true);
  await expect.poll(async () => {
    const payload = await (await page.request.get(`${baseURL}/api/tabs`)).json();
    return payload.data.tabs.find((tab) => tab.id === targetTabId)?.pendingExtensionUiRequestCount || 0;
  }).toBe(1);
  await page.evaluate(({ tabId }) => {
    navigator.serviceWorker.dispatchEvent(new MessageEvent("message", {
      data: { type: "pi-webui:navigate:v1", target: { v: 1, route: "activity", tabId, blockerId: "fixture_blocker_12345678" } },
    }));
  }, { tabId: targetTabId });
  await expect(page.locator("#dialogTitle")).toHaveText("Fixture blocker");
  await expect(page.locator("#mobileActivityRoute")).toBeVisible();
  await expect(page.locator("#mobileContinuityNotice")).toContainText("Opened after reconnecting");
  const cancel = await page.request.post(`${baseURL}/api/extension-ui-response?tab=${encodeURIComponent(targetTabId)}`, {
    data: { id: "fixture_blocker_12345678", cancelled: true },
  });
  assert.equal(cancel.ok(), true);
  await context.close();
});

test("tablet mode is independent, uses a rail and right inspector, and survives rotation and keyboard navigation", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 820, height: 1180 }, hasTouch: true });
  const page = await context.newPage();
  await page.goto(`${baseURL}/?mobileShell=v2`);
  await expect(page.locator("#mobileShellV2")).toBeHidden();

  await page.goto(`${baseURL}/?tabletShell=v2`);
  await expect(page.locator("html")).toHaveAttribute("data-tablet-shell", "v2");
  await expect(page.locator("#mobileShellV2")).toBeVisible();
  const rail = page.getByRole("navigation", { name: "Tablet destinations" });
  await expect(rail).toBeVisible();
  const railBox = await rail.boundingBox();
  assert.ok(railBox && railBox.x === 0 && railBox.width >= 100 && railBox.width <= 120, `tablet rail geometry should remain stable, got ${JSON.stringify(railBox)}`);

  await page.locator("#promptInput").fill("tablet rotation draft");
  await rail.getByRole("button", { name: "Sessions", exact: true }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(rail.getByRole("button", { name: "Activity", exact: true })).toBeFocused();
  await rail.getByRole("button", { name: "Project", exact: true }).click();
  await page.getByRole("tab", { name: "Files" }).click();
  await expect(page.locator("#fileTreeRoot")).toBeVisible();
  await page.locator('[role="treeitem"][data-path="tablet-example.txt"]').click();
  await expect(page.locator("#fileViewerPane")).toBeVisible();
  const fileBox = await page.locator("#fileViewerPane").boundingBox();
  assert.ok(fileBox && fileBox.x === 0 && fileBox.y === 0 && fileBox.width === 820, `tablet file viewer must default to full-screen replacement, got ${JSON.stringify(fileBox)}`);
  await page.locator("#fileViewerCloseButton").click();

  await page.locator("#mobileMoreButton").click();
  const inspectorBox = await page.locator("#mobileShellSurface").boundingBox();
  assert.ok(inspectorBox && inspectorBox.width <= 480 && Math.abs(inspectorBox.x + inspectorBox.width - 820) <= 1, `tablet inspector must be a bounded right sheet, got ${JSON.stringify(inspectorBox)}`);
  await page.setViewportSize({ width: 1024, height: 768 });
  await expect(page.locator("#mobileShellSurface")).toBeVisible();
  await page.locator("#mobileSurfaceCloseButton").click();
  await rail.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.locator("#promptInput")).toHaveValue("tablet rotation draft");

  for (const size of [{ width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await expect(page.locator("#mobileShellV2")).toBeVisible();
  }
  await assertAxeClean(page, "tablet shell");

  await page.goto(`${baseURL}/?tabletShell=legacy`);
  await expect(page.locator("#mobileShellV2")).toBeHidden();
  await context.close();
});

test("desktop remains equivalent at required viewport fixtures", async ({ page }) => {
  for (const size of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    await page.goto(`${baseURL}/?mobileShell=v2&tabletShell=v2`);
    await expect(page.locator("#mobileShellV2")).toBeHidden();
    await expect(page.locator("#promptInput")).toBeVisible();
    await expect(page.locator(".terminal-tabs-shell")).toBeVisible();
    await expect(page.locator("#sidePanel")).toBeVisible();
  }
});

test("desktop left-sidebar actions are compact accessible icon buttons", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  await page.locator("body").evaluate((body) => body.classList.add("terminal-tabs-left"));

  const actions = page.locator(".terminal-sidebar-actions > button");
  await expect(actions).toHaveCount(3);
  const snapshots = await actions.evaluateAll((buttons) => buttons.map((button) => ({
    text: button.textContent.trim(),
    ariaLabel: button.getAttribute("aria-label"),
    width: button.getBoundingClientRect().width,
    height: button.getBoundingClientRect().height,
  })));
  for (const action of snapshots) {
    assert.equal(action.text, "", "left-sidebar action buttons should not render visible text");
    assert.ok(action.ariaLabel, "each icon-only action must retain an accessible name");
    assert.ok(action.width >= 44 && action.height >= 44, `icon action must retain a 44px target, got ${action.width}×${action.height}`);
  }
  assert.ok(Math.max(...snapshots.map((action) => action.width)) - Math.min(...snapshots.map((action) => action.width)) <= 1, "icon actions should remain equal width");
});

test("shell recovery overrides previews across resize without losing the draft", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/?shell=classic&mobileShell=v2&tabletShell=v2`);
  await page.locator('#promptInput').fill('recovery retains this draft');
  for (const width of [390, 820, 1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(page.locator('#mobileShellV2')).toBeHidden();
    await expect(page.locator('html')).not.toHaveAttribute('data-mobile-shell');
    await expect(page.locator('html')).not.toHaveAttribute('data-tablet-shell');
    await expect(page.locator('#promptInput')).toHaveValue('recovery retains this draft');
  }
});

test("shell history failure leaves the current view and draft usable", async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/?mobileShell=v2`);
  await page.locator('#promptInput').fill('history failure draft');
  await page.evaluate(() => {
    const original = history.pushState;
    history.pushState = function (...args) {
      history.pushState = original;
      throw new DOMException('fixture history write denied', 'SecurityError');
    };
  });
  await page.locator('#mobileMoreButton').click();
  await expect(page.locator('#mobileShellSurface')).toBeHidden();
  await expect(page.locator('#promptInput')).toHaveValue('history failure draft');
  await page.locator('#mobileMoreButton').click();
  await expect(page.locator('#mobileShellSurface')).toBeVisible();
  await page.locator('#mobileSurfaceCloseButton').click();
  await expect(page.locator('#promptInput')).toHaveValue('history failure draft');
  assert.deepEqual(errors, []);
});

test("shell canonical project navigation retains nodes, filters, history fields and stream", async ({ page }, testInfo) => {
  let streams = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/events') streams += 1; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseURL}/?mobileShell=v2`);
  await page.locator('#promptInput').fill('project navigation draft');
  await expect.poll(() => streams).toBeGreaterThan(0);
  const before = streams;
  await page.evaluate(() => {
    window.originalFilesView = document.querySelector('#sidePanelSectionFiles');
    history.replaceState({ ...history.state, independentMarker: 'retained' }, '');
  });
  const nav = page.getByRole('navigation', { name: 'Phone destinations' });
  await nav.getByRole('button', { name: 'Project', exact: true }).click();
  await page.locator('#fileTreeSearchInput').fill('tablet');
  await nav.getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue('project navigation draft');
  await page.goBack();
  await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
  await expect(page.locator('#fileTreeSearchInput')).toHaveValue('tablet');
  assert.deepEqual(await page.evaluate(() => ({ same: window.originalFilesView === document.querySelector('#sidePanelSectionFiles'), marker: history.state.independentMarker })), { same: true, marker: 'retained' });
  assert.equal(streams, before);
  await page.screenshot({ path: testInfo.outputPath('shell-project-continuity.png') });
});

test("shell palette stable actions dispatch the real transcript search", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseURL);
  await page.locator('#promptInput').fill('palette retains draft');
  await page.locator('#commandPaletteButton').click();
  const ids = await page.locator('#commandPaletteList [data-action-id]').evaluateAll(nodes => nodes.map(node => node.dataset.actionId));
  assert.ok(ids.length > 10);
  assert.equal(new Set(ids).size, ids.length);
  await page.locator('#commandPaletteInput').fill('Search transcript');
  await page.locator('[data-action-id="conversation:search"]').click();
  await expect(page.locator('#chatSearchInput')).toBeVisible();
  await expect(page.locator('#commandPaletteDialog')).toBeHidden();
  await expect(page.locator('#promptInput')).toHaveValue('palette retains draft');
});

test("shell modules survive the service-worker offline cache and online refresh", async ({ page, context }) => {
  await page.goto(baseURL);
  await expect(page.locator('#promptInput')).toBeVisible();
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const modules = ['project-file-viewer-controller', 'project-git-tools-controller', 'project-runners-controller', 'project-artifact-controller', 'activity-queue-controller', 'activity-agents-controller', 'activity-intercom-controller', 'activity-events-controller', 'activity-usage-controller', 'activity-todo-view', 'shell-workspace', 'shell-tools-launcher', 'focused-shell-adapter', 'shell-actions', 'shell-navigation', 'shell-preferences', 'shell-view-host', 'shell-surfaces', 'session-context', 'session-composer-store', 'session-attention-scheduler', 'platform-event-stream', 'session-extension-requests'];
  const cacheState = await page.evaluate(async names => {
    const cacheNames = await caches.keys();
    const active = cacheNames.find(name => name.startsWith('pi-webui-pwa-'));
    const cache = await caches.open(active);
    return { active, modules: await Promise.all(names.map(async name => !!await cache.match(`/${name}.mjs`))), api: (await cache.keys()).some(request => new URL(request.url).pathname.startsWith('/api/')) };
  }, modules);
  assert.equal(cacheState.active, 'pi-webui-pwa-v164');
  assert.deepEqual(cacheState.modules, modules.map(() => true));
  assert.equal(cacheState.api, false);
  try {
    await context.setOffline(true);
    await page.reload();
    assert.deepEqual(await page.evaluate(async names => Promise.all(names.map(async name => Object.keys(await import(`/${name}.mjs`)).length > 0)), modules), modules.map(() => true));
  } finally {
    await context.setOffline(false);
  }
  await page.reload();
  await expect(page.locator('#promptInput')).toBeVisible();
  await page.locator('#commandPaletteButton').click();
  await expect(page.locator('[data-action-id="conversation:search"]')).toBeVisible();
});

test("shell breakpoint return restores focus and selection into the expanded Classic Files view", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${baseURL}/?mobileShell=v2&tabletShell=legacy&mobileRoute=project`);
  await page.locator('#sidePanelSectionToggleFiles').click();
  const input = page.locator('#fileTreeSearchInput');
  await expect(input).toBeVisible();
  await input.fill('tablet-example');
  await input.evaluate(node => {
    window.focusedFilesInput = node;
    node.focus();
    node.setSelectionRange(2, 6, 'backward');
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('navigation', { name: 'Phone destinations' }).getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.locator('#mobileProjectRoute')).toBeVisible();
  await input.focus();
  await input.evaluate(node => node.setSelectionRange(2, 6, 'backward'));
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  assert.deepEqual(await input.evaluate(node => ({ same: node === window.focusedFilesInput, value: node.value, start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection })), { same: true, value: 'tablet-example', start: 2, end: 6, direction: 'backward' });
  await page.screenshot({ path: testInfo.outputPath('classic-files-focus-restored.png') });
  await page.keyboard.insertText('retained');
  await expect(input).toHaveValue('taretained-example');
  await input.evaluate(node => node.setSelectionRange(2, 6, 'backward'));
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(input).toBeFocused();
  assert.deepEqual(await input.evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection]), [2, 6, 'backward']);
  await expect(input).toHaveValue('taretained-example');
});
