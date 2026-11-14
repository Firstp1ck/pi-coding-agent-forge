import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform, release } from "node:os";
import { join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { api, artifactRoot, openFixture, packageRoot, sourceBaseline, startFixture, stopFixture, streamFinal, streamPrompt, waitIdle } from "./overhaul-fixture.mjs";

const integrationBase = "ad514adba3f4e57c10c72b26eec0dce570eab30e";
const runDirectory = join(artifactRoot, `capability-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const report = {
  schemaVersion: 1,
  workstream: "W0-D",
  capturedAt: new Date().toISOString(),
  sourceBaseline,
  integrationBase,
  originalReference: "docs/overhaul/browser-baseline.json, unchanged; no new performance budgets or replacement workflow metrics",
  scenarios: [],
};
const views = [
  { name: "desktop", width: 1440, height: 900, query: "" },
  { name: "phone-legacy", width: 390, height: 844, query: "mobileShell=legacy", isMobile: true },
  { name: "phone-v2", width: 390, height: 844, query: "mobileShell=v2", isMobile: true },
];
const models = [
  { provider: "fake", id: "fake-model", name: "Fake Model" },
  { provider: "fake", id: "z-capability-alternative", name: "Capability Alternative" },
];
const catalogMocks = "Simulated HTTP GET model/command catalogs only; real UI handlers, POST APIs, fake-Pi RPC and temporary settings persistence. No installed companion/provider verification.";

async function saveJson(path, value) {
  await mkdir(runDirectory, { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function snapshot(page, record, suffix) {
  const path = join(runDirectory, `capability-${record.id}-${suffix}.png`);
  await page.screenshot({ path, animations: "disabled" });
  record.screenshots.push(relative(packageRoot, path));
}

async function installCatalogs(page, stats = false) {
  await page.route("**/api/models?*", (route) => route.fulfill({ json: { ok: true, data: { models } } }));
  await page.route("**/api/commands?*", async (route) => {
    const response = await route.fetch();
    assert.ok(response.ok(), "real command catalog must load before supplementing it");
    const payload = await response.json();
    if (stats) payload.data.commands.push({ name: "stats", source: "extension", description: "Simulated stats dashboard discovery" });
    payload.data.commands.push(
      { name: "tools", source: "extension", description: "Simulated Tools Setup discovery" },
      { name: "skills", source: "extension", description: "Simulated Skills Setup discovery" },
    );
    await route.fulfill({ json: payload });
  });
}

async function scenario({ browser, request }, id, view, options, exercise) {
  const record = { id, view, status: "running", actions: [], screenshots: [], pageErrors: [], ...options.evidence };
  report.scenarios.push(record);
  const fixture = await startFixture(request, options.fixture);
  let context;
  let page;
  const act = async (selector, description, perform) => {
    const action = { selector, description, completed: false };
    record.actions.push(action);
    await perform();
    action.completed = true;
  };
  try {
    context = await browser.newContext({ viewport: { width: view.width, height: view.height }, isMobile: !!view.isMobile, hasTouch: !!view.isMobile, locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "reduce", serviceWorkers: "block" });
    page = await context.newPage();
    page.on("pageerror", (error) => record.pageErrors.push(error.message));
    if (options.catalogs) await installCatalogs(page, options.stats);
    await openFixture(page, fixture, view.query);
    await expect(page.locator("#eventLog")).toContainText("connected to");
    await exercise({ page, fixture, record, act });
    expect(record.pageErrors, `${id} browser script errors`).toEqual([]);
    record.status = record.status === "running" ? "verified" : record.status;
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    if (page && !page.isClosed()) await snapshot(page, record, "failure");
    throw error;
  } finally {
    record.completedActionCount = record.actions.filter((action) => action.completed).length;
    try { await context?.close(); } finally {
      await stopFixture(fixture);
      await saveJson(join(runDirectory, `capability-${id}.json`), record);
    }
  }
}

async function openControls(page, view, act) {
  if (view.name === "phone-v2") {
    await act('#mobileMoreButton', "open More", () => page.locator('#mobileMoreButton').click());
    await act('button "Settings"', "open Settings", () => page.getByRole("button", { name: "Settings", exact: true }).click());
  } else {
    if (view.isMobile) await act("#sidePanelExpandButton", "open Control Deck", () => page.locator("#sidePanelExpandButton").click());
    await act("#sidePanelSectionToggleControls", "expand Controls", () => page.locator("#sidePanelSectionToggleControls").click());
  }
  await expect(page.locator("#modelSelect")).toBeVisible();
}

async function prompt(page, fixture, message, tabId = fixture.tabs[0].id) {
  return api(page.request, fixture.baseURL, `/api/prompt?tab=${encodeURIComponent(tabId)}`, { message, requestId: `capability-${randomUUID()}` });
}

async function settings(fixture) {
  return JSON.parse(await readFile(join(fixture.root, "settings.json"), "utf8"));
}

function tabButton(page, tab) {
  return page.locator(`[data-tab-id="${tab.id}"] .terminal-tab-button`);
}

async function selectSession(page, view, tab, act) {
  if (view.name === "phone-v2") {
    await act("#mobileSessionButton", "open Sessions from app bar", () => page.locator("#mobileSessionButton").click());
    const session = page.locator(".mobile-session-select").filter({ hasText: tab.title });
    await act(`session ${tab.title}`, "select session", () => session.click());
  } else {
    if (view.isMobile && !await tabButton(page, tab).isVisible()) {
      await act("#terminalTabsToggleButton", "open Tabs drawer", () => page.locator("#terminalTabsToggleButton").click());
    }
    if (view.isMobile && !await tabButton(page, tab).isVisible()) {
      const group = page.locator(".terminal-tab-group").filter({ has: tabButton(page, tab) });
      await act(".terminal-tab-group-button", "open workspace session list", () => group.locator(":scope > .terminal-tab-group-button").click());
    }
    await act(`tab ${tab.title}`, "select session", () => tabButton(page, tab).click());
  }
}

test.beforeAll(async ({ browser }) => {
  execFileSync("git", ["diff", "--exit-code", sourceBaseline, "--", "public", "bin", "lib", "index.ts", "webui-rpc-helper.mjs"], { cwd: packageRoot });
  report.executionHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim();
  report.environment = { platform: platform(), release: release(), node: process.version, chromium: browser.version(), executable: "/usr/bin/chromium" };
  await mkdir(runDirectory, { recursive: true });
});

for (const view of views) {
  test(`alternative model selection: ${view.name}`, async ({ browser, request }) => {
    await scenario({ browser, request }, `model-${view.name}`, view, { catalogs: true, evidence: { simulation: catalogMocks } }, async ({ page, fixture, record, act }) => {
      await openControls(page, view, act);
      const value = JSON.stringify({ provider: "fake", modelId: "z-capability-alternative" });
      await act("#modelSelect", "choose alternative fake model", () => page.locator("#modelSelect").selectOption(value));
      await expect(page.locator("#modelSelect")).toHaveValue(value);
      await snapshot(page, record, "chosen-before-apply");
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/model" && response.request().method() === "POST");
      await act("#setModelButton", "apply model", () => page.locator("#setModelButton").click());
      const response = await responsePromise;
      expect(response.ok()).toBe(true);
      expect(response.request().postDataJSON()).toEqual({ provider: "fake", modelId: "z-capability-alternative" });
      expect(new URL(response.url()).searchParams.get("tab")).toBe(fixture.tabs[0].id);
      record.modelResponse = await response.json();
      expect(record.modelResponse.data).toMatchObject({ provider: "fake", id: "z-capability-alternative" });
      const log = await readFile(join(fixture.root, "fake-pi.jsonl"), "utf8");
      expect(log).toContain('"modelId":"z-capability-alternative"');
      record.authoritativeModel = (await api(page.request, fixture.baseURL, `/api/state?tab=${fixture.tabs[0].id}`)).model;
      record.status = "partial-fixture-limitation";
      record.limitation = "Alternative choice and real POST/RPC acceptance verified. Existing fake Pi set_model echoes the request but get_state always returns fake/fake-model; durable provider/model switching is unverified, not a production regression.";
      await snapshot(page, record, "accepted");
    });
  });

  test(`scoped tool and skill profiles: ${view.name}`, async ({ browser, request }) => {
    await scenario({ browser, request }, `resources-${view.name}`, view, { catalogs: true, evidence: { simulation: catalogMocks } }, async ({ page, fixture, record, act }) => {
      if (view.name === "phone-v2") {
        await act('#mobileMoreButton', "open More", () => page.locator('#mobileMoreButton').click());
        await act('button "Extensions"', "open Extensions", () => page.getByRole("button", { name: "Extensions", exact: true }).click());
        await act('button "Set up TUI Tools command"', "open Tools Setup", () => page.getByRole("button", { name: "Set up TUI Tools command", exact: true }).click());
      } else {
        if (view.isMobile) await act("#composerActionsButton", "open composer actions", () => page.locator("#composerActionsButton").click());
        await act("#nativeCommandMenuButton", "open resource menu", () => page.locator("#nativeCommandMenuButton").click());
        await act("#nativeToolsButton", "open Tools Setup", () => page.locator("#nativeToolsButton").click());
      }
      await expect(page.locator("#nativeCommandTitle")).toHaveText("Tools Setup");
      const scope = page.locator(".native-resource-scope select");
      await expect(scope).toHaveValue("session");
      await act(".native-selector-item containing bash", "disable bash for this session", () => page.locator(".native-selector-item").filter({ hasText: "bash" }).click());
      await expect(page.locator(".native-selector-item").filter({ hasText: "bash" })).toContainText("disabled");
      record.sessionOnlySettings = (await settings(fixture)).resourceDefaults || null;
      record.sessionToolScopes = [];
      for (const tab of fixture.tabs.slice(0, 2)) {
        const data = await api(page.request, fixture.baseURL, `/api/tools?scope=session&tab=${tab.id}`);
        record.sessionToolScopes.push({ tabId: tab.id, bashEnabled: data.tools.find((tool) => tool.name === "bash").enabled });
      }
      expect(record.sessionToolScopes.map((scope) => scope.bashEnabled)).toEqual([false, true]);
      expect(record.sessionOnlySettings?.tools?.enabledTools).toBeNull();
      await act('button "Use inherited defaults"', "restore inherited session tools", () => page.locator("#nativeCommandActions").getByRole("button", { name: "Use inherited defaults" }).click());
      await expect(page.locator(".native-selector-item").filter({ hasText: "bash" })).toContainText("enabled");
      await act(".native-resource-scope select", "choose model default", () => scope.selectOption("model"));
      await expect(page.locator(".native-resource-model select")).toBeVisible();
      await act(".native-selector-item containing bash", "disable bash for fake-model default", () => page.locator(".native-selector-item").filter({ hasText: "bash" }).click());
      await expect.poll(async () => (await settings(fixture)).resourceDefaults?.modelProfiles?.[0]?.tools?.enabledTools).toEqual(["read"]);
      record.modelProfile = (await settings(fixture)).resourceDefaults.modelProfiles;
      record.configurationActionCount = record.actions.length;
      await snapshot(page, record, "model-profile");
      await act('button "Use inherited defaults"', "clear model override", () => page.locator("#nativeCommandActions").getByRole("button", { name: "Use inherited defaults" }).click());
      await expect.poll(async () => (await settings(fixture)).resourceDefaults?.modelProfiles || []).toEqual([]);
      await act(".native-resource-scope select", "choose global default", () => scope.selectOption("global"));
      await act(".native-selector-item containing bash", "disable bash globally", () => page.locator(".native-selector-item").filter({ hasText: "bash" }).click());
      await expect.poll(async () => (await settings(fixture)).resourceDefaults?.tools?.enabledTools).toEqual(["read"]);
      record.globalProfile = (await settings(fixture)).resourceDefaults.tools;
      await act('button "Use inherited defaults"', "clear global override", () => page.locator("#nativeCommandActions").getByRole("button", { name: "Use inherited defaults" }).click());
      await expect.poll(async () => (await settings(fixture)).resourceDefaults?.tools?.enabledTools).toBeNull();
      await act('button "Cancel"', "close Tools Setup", () => page.locator("#nativeCommandActions").getByRole("button", { name: "Cancel" }).click());
      if (view.name === "phone-v2") {
        await act('button "Set up TUI Skills command"', "open Skills Setup", () => page.getByRole("button", { name: "Set up TUI Skills command", exact: true }).click());
      } else {
        if (view.isMobile) await act("#composerActionsButton", "reopen composer actions", () => page.locator("#composerActionsButton").click());
        await act("#nativeCommandMenuButton", "open resource menu again", () => page.locator("#nativeCommandMenuButton").click());
        await act("#nativeSkillsButton", "open Skills Setup", () => page.locator("#nativeSkillsButton").click());
      }
      await expect(page.locator("#nativeCommandTitle")).toHaveText("Skills Setup");
      await act(".native-resource-scope select", "choose exact-model skill default", () => page.locator(".native-resource-scope select").selectOption("model"));
      const security = page.locator(".native-selector-item").filter({ hasText: "code-security" });
      await expect(security).toHaveAttribute("aria-pressed", "true");
      await act("skill code-security", "disable code-security for fake-model default", () => security.click());
      await expect.poll(async () => (await settings(fixture)).resourceDefaults?.modelProfiles?.[0]?.skills?.enabledSkills).toEqual(["repo-explorer"]);
      record.skillProfile = (await settings(fixture)).resourceDefaults.modelProfiles;
      await snapshot(page, record, "skill-profile");
      await act('button "Use inherited defaults"', "clear skill model override", () => page.locator("#nativeCommandActions").getByRole("button", { name: "Use inherited defaults" }).click());
      await expect.poll(async () => (await settings(fixture)).resourceDefaults?.modelProfiles || []).toEqual([]);
      await act('button "Cancel"', "close Skills Setup", () => page.locator("#nativeCommandActions").getByRole("button", { name: "Cancel" }).click());
      record.scopeVerification = "Session tools changed only the originating fake process; exact-model/global tool defaults and exact-model skill defaults saved then cleared in temporary real-server settings. No provider/native companion execution implied.";
    });
  });

  test(`background approval targeting: ${view.name}`, async ({ browser, request }) => {
    await scenario({ browser, request }, `approval-${view.name}`, view, {}, async ({ page, fixture, record, act }) => {
      const [foreground, target] = fixture.tabs;
      await page.locator("#promptInput").fill("foreground draft must survive");
      await prompt(page, fixture, "fixture mobile blocker", target.id);
      await expect.poll(async () => (await api(page.request, fixture.baseURL, "/api/tabs")).tabs.find((tab) => tab.id === target.id).pendingExtensionUiRequestCount).toBe(1);
      await expect(page.locator("#dialog")).toBeHidden();
      record.origin = { foregroundTab: foreground.id, approvalTab: target.id, id: "fixture_blocker_12345678" };
      await page.waitForTimeout(1_000);
      record.beforeReconcile = { backendPending: 1, label: await tabButton(page, target).getAttribute("aria-label") };
      expect(record.beforeReconcile.label).toContain("Idle");
      record.status = "known-defect-characterization";
      record.defect = { id: "CAP-001", severity: "Major", source: "existing per-tab SSE delivery and polling only when browser already knows about working tabs", summary: "An idle foreground client does not discover a new background approval until metadata reconciliation", expected: "Background session signals needs input without a reload or manual refresh", actual: "Server pending=1 while foreground browser still labels target Idle", reproduction: "Open three idle tabs, prompt fixture mobile blocker against a nonforeground tab through the real API, wait one second; observe Idle. Refresh metadata to reveal it." };
      await snapshot(page, record, "stale-discovery");
      if (view.name === "phone-v2") {
        await act('[data-mobile-route-button="activity"]', "open Activity", () => page.locator('[data-mobile-route-button="activity"]').click());
        await expect(page.locator(".mobile-activity-item.is-blocked")).toHaveCount(0);
        await act("#mobileActivityRefreshButton", "refresh Activity to discover background approval", () => page.locator("#mobileActivityRefreshButton").click());
        const review = page.locator(".mobile-activity-item.is-blocked").getByRole("button", { name: "Review", exact: true });
        await expect(review).toBeVisible();
        await snapshot(page, record, "discovery");
        await act('blocked activity button "Review"', "open background approval", () => review.click());
      } else {
        await act("browser reload", "reload to discover background approval", () => page.reload());
        await expect(page.locator("#eventLog")).toContainText("connected to");
        await expect(tabButton(page, target)).toHaveAttribute("aria-label", /Blocked/);
        await snapshot(page, record, "discovery");
        await selectSession(page, view, target, act);
      }
      await expect(page.locator("#dialogTitle")).toHaveText("Fixture blocker");
      record.accessActionCount = record.actions.length;
      await snapshot(page, record, "dialog");
      const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/extension-ui-response" && response.request().method() === "POST");
      await act('#dialogActions button "Yes"', "approve exact background request", () => page.locator("#dialogActions").getByRole("button", { name: "Yes", exact: true }).click());
      const response = await responsePromise;
      expect(response.ok()).toBe(true);
      record.responseTarget = new URL(response.url()).searchParams.get("tab");
      expect(record.responseTarget).toBe(target.id);
      expect(response.request().postDataJSON()).toMatchObject({ id: "fixture_blocker_12345678", confirmed: true });
      await expect(page.locator("#dialog")).toBeHidden();
      await expect.poll(async () => (await api(page.request, fixture.baseURL, "/api/tabs")).tabs.find((tab) => tab.id === target.id).pendingExtensionUiRequestCount).toBe(0);
      if (view.name === "phone-v2") {
        record.bottomNavigationObstruction = await page.locator('[data-mobile-route-button="sessions"]').evaluate((node) => {
          const rect = node.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
          return { obstructed: !node.contains(hit), hitClass: hit?.className || "", toastText: document.querySelector("#noticeToastStack")?.textContent || "" };
        });
        if (record.bottomNavigationObstruction.obstructed && record.bottomNavigationObstruction.hitClass.includes("notice-toast")) {
          record.additionalDefects = [{ id: "CAP-002", severity: "Minor", summary: "Approval recovery notifications cover the bottom Sessions navigation target", actual: record.bottomNavigationObstruction, workaround: "Use the top Open Sessions control or dismiss the notification" }];
        }
        await snapshot(page, record, "after-response");
      }
      await selectSession(page, view, foreground, act);
      await expect(page.locator("#promptInput")).toHaveValue("foreground draft must survive");
      record.returnVerified = true;
    });
  });
}

for (const view of views.filter((view) => view.isMobile)) {
  test(`common mobile session switch: ${view.name}`, async ({ browser, request }) => {
    await scenario({ browser, request }, `common-session-${view.name}`, view, {}, async ({ page, fixture, record, act }) => {
      await page.locator("#promptInput").fill("preserve mobile session draft");
      await selectSession(page, view, fixture.tabs[1], act);
      await expect(page.locator("#promptInput")).toHaveValue("");
      await expect(tabButton(page, fixture.tabs[1])).toHaveAttribute("aria-selected", "true");
      record.accessActionCount = record.actions.length;
      await snapshot(page, record, "switched");
      await selectSession(page, view, fixture.tabs[0], act);
      await expect(page.locator("#promptInput")).toHaveValue("preserve mobile session draft");
      record.draftRestored = true;
    });
  });

  test(`common mobile effort change: ${view.name}`, async ({ browser, request }) => {
    await scenario({ browser, request }, `common-effort-${view.name}`, view, {}, async ({ page, fixture, record, act }) => {
      await openControls(page, view, act);
      await act("#thinkingSelect", "choose High effort", () => page.locator("#thinkingSelect").selectOption("high"));
      await act("#setThinkingButton", "apply High effort", () => page.locator("#setThinkingButton").click());
      await expect.poll(async () => (await api(page.request, fixture.baseURL, `/api/state?tab=${fixture.tabs[0].id}`)).thinkingLevel).toBe("high");
      expect((await api(page.request, fixture.baseURL, `/api/state?tab=${fixture.tabs[1].id}`)).thinkingLevel).toBe("off");
      record.sessionIsolationVerified = true;
      await snapshot(page, record, "applied");
    });
  });

  test(`common mobile file attachment: ${view.name}`, async ({ browser, request }) => {
    await scenario({ browser, request }, `common-attachment-${view.name}`, view, {}, async ({ page, record, act }) => {
      let chooser;
      if (view.name === "phone-v2") {
        await act("#attachButton", "open Add Context", () => page.locator("#attachButton").click());
        [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 5_000 }),
          act('.mobile-context-actions button "Files"', "open Files chooser", () => page.locator(".mobile-context-actions").getByRole("button", { name: "Files", exact: true }).click()),
        ]);
      } else {
        [chooser] = await Promise.all([
          page.waitForEvent("filechooser", { timeout: 5_000 }),
          act("#attachButton", "open file chooser", () => page.locator("#attachButton").click()),
        ]);
      }
      await act("native file chooser", "choose mobile-context.txt", () => chooser.setFiles({ name: "mobile-context.txt", mimeType: "text/plain", buffer: Buffer.from("Fixed mobile attachment context\n") }));
      await expect(page.locator(".attachment-pill-name")).toHaveText("mobile-context.txt");
      if (view.name === "phone-v2") await act("#mobileSurfaceCloseButton", "return to chat with attachment", () => page.locator("#mobileSurfaceCloseButton").click());
      await expect(page.locator("#attachmentTray")).toBeVisible();
      record.nativeDeviceLimitation = "Real app chooser handler with a Playwright-supplied file; no native OS picker, camera, photo permission or physical device verification.";
      await snapshot(page, record, "attached");
    });
  });
}

test("disabled companion Setup discovery", async ({ browser, request }) => {
  await scenario({ browser, request }, "disabled-setup", views[0], {}, async ({ page, record, act }) => {
    await act("#sidePanelSectionToggleOptionalFeatures", "expand Optional features", () => page.locator("#sidePanelSectionToggleOptionalFeatures").click());
    const rows = page.locator(".optional-feature-row");
    await expect(rows.first()).toBeVisible();
    record.rows = await rows.allTextContents();
    expect(record.rows.join("\n")).toContain("Guided Git");
    record.setupButtons = await rows.getByRole("button", { name: /^Set up / }).allTextContents();
    expect(record.setupButtons.length).toBeGreaterThan(0);
    record.simulation = "None; original no-installed-companion discovery. No install or Setup activation performed.";
    await snapshot(page, record, "discovery");
  });
});

test("enabled Guided Git and stats prompt resources", async ({ browser, request }) => {
  await scenario({ browser, request }, "enabled-companions", views[0], { catalogs: true, stats: true, fixture: { fakePi: { FAKE_PI_GUIDED_GIT_ACTIVATION: "1", FAKE_PI_STATS_PROMPT_CONTEXT: "1" }, settings: { version: 8, gitWorkflow: { reviewProcessEnabled: false, stagingPolicy: "all", generation: { provider: "fake", modelId: "fake-model", thinkingLevel: "off", unavailablePolicy: "ask", fallback: { provider: "", modelId: "", thinkingLevel: "off" } } } } }, evidence: { simulation: "Existing fake-Pi activation and structured stats status payload plus simulated HTTP command discovery for /stats, /tools and /skills and alternative-model catalog; real browser handlers. No installed companion, Git generation, commit or publication." } }, async ({ page, fixture, record, act }) => {
    await page.locator("#promptInput").fill("keep companion draft");
    await page.locator("#attachmentInput").setInputFiles({ name: "keep.txt", mimeType: "text/plain", buffer: Buffer.from("isolated companion attachment\n") });
    await expect(page.locator("#gitWorkflowButton")).toBeEnabled();
    await act("#gitWorkflowButton", "open Guided Git", () => page.locator("#gitWorkflowButton").click());
    await expect(page.locator("#gitWorkflowPanel")).toBeVisible();
    await expect(page.locator("#promptInput")).toHaveValue("keep companion draft");
    await expect(page.locator(".attachment-pill-name")).toHaveText("keep.txt");
    await page.mouse.move(20, 90);
    await snapshot(page, record, "guided-git");
    await act("#gitWorkflowCancelButton", "cancel Guided Git before execution", () => page.locator("#gitWorkflowCancelButton").click());
    await act("#optionsMenuButton", "open Common Options", () => page.locator("#optionsMenuButton").click());
    await act("#optionsViewDiagnosticsSubmenuButton", "hover View & Diagnostics", () => page.locator("#optionsViewDiagnosticsSubmenuButton").hover());
    await act("#optionsStatsButton", "open stats dashboard", () => page.locator("#optionsStatsButton").click());
    await expect(page.locator("#statsOverlayDialog")).toBeVisible();
    await prompt(page, fixture, "/stats-webui 14");
    await act("#statsOverlayTab-prompt", "view prompt and resource inventory", () => page.locator("#statsOverlayTab-prompt").click());
    await expect(page.locator(".stats-prompt-initial")).toBeVisible();
    await expect(page.locator("#statsOverlayBody")).toContainText("Active tool schemas");
    record.familyMapping = ["Guided Git activation and draft/attachment continuity", "structured companion status dashboard", "prompt/context, tool-schema and skill resource inventory"];
    await snapshot(page, record, "stats-resources");
    const schemas = page.locator("#statsOverlayBody summary").filter({ hasText: "Active tool schemas" });
    await act('summary "Active tool schemas"', "expand tool-schema inventory", () => schemas.click());
    const skills = page.locator("#statsOverlayBody summary").filter({ hasText: /^Skills/ });
    await act('summary "Skills"', "expand skill inventory", () => skills.click());
    await schemas.scrollIntoViewIfNeeded();
    await snapshot(page, record, "stats-resource-details");
    await page.locator("#statsOverlayCloseButton").click();
  });
});

test("busy multi-agent workflow and gate status", async ({ browser, request }) => {
  await scenario({ browser, request }, "busy-agents", views[0], { evidence: { simulation: "Existing fake prompts emit canonical agent/gate/workflow events; no actual inference providers or child agents run." } }, async ({ page, fixture, record, act }) => {
    await prompt(page, fixture, "fixture subagents running");
    await act('[data-side-panel-section-toggle="subagents"]', "expand Subagents", () => page.locator('[data-side-panel-section-toggle="subagents"]').click());
    record.subagentSnapshot = await api(page.request, fixture.baseURL, "/api/subagents");
    const activeGroup = page.locator(".subagent-tab-group.active");
    await expect(activeGroup.locator(".subagent-agent-row")).toHaveCount(2);
    await expect(activeGroup.locator(".subagent-tab-count")).toContainText("2 running");
    record.aggregateStatus = await page.locator("#subagentsStatus").innerText();
    record.identityLimitation = "All three fake processes report sessionId=fake-session. Canonical identity grouping projects the same two instances into three terminal groups; aggregate six is not six executed agents or proof of session isolation.";
    await expect(activeGroup.locator(".subagent-gate-card")).toHaveCount(1);
    record.gateText = await activeGroup.locator(".subagent-gate-card").innerText();
    await activeGroup.locator(".subagent-gate-card").scrollIntoViewIfNeeded();
    await snapshot(page, record, "running-gate");
    await act(".subagent-agent-row:first", "open representative agent output", () => activeGroup.locator(".subagent-agent-row").first().click());
    await expect(page.locator(".subagent-overlay-widget")).toBeVisible();
    await snapshot(page, record, "agent-output");
    await act(".subagent-overlay-close-action", "close agent output", () => page.locator(".subagent-overlay-close-action").click());
    await prompt(page, fixture, "fixture subagents workflow");
    await expect(activeGroup.locator(".subagent-workflow")).toHaveCount(1);
    await expect(activeGroup.locator(".subagent-workflow .subagent-agent-name")).toHaveText("worker");
    await expect(activeGroup.locator(".subagent-workflow-header")).toContainText("running");
    await activeGroup.locator(".subagent-workflow").scrollIntoViewIfNeeded();
    await snapshot(page, record, "workflow");
    record.familyMapping = ["agent roster, running state and output", "gate progress and failed-provider attempt display", "workflow controller with nested worker"];
  });
});

const longTranscript = Array.from({ length: 200 }, (_, index) => {
  const text = `${index === 1 ? "fake answer " : ""}Deterministic message ${String(index).padStart(3, "0")}. ${"Fixed reading context with preserved selection and scroll. ".repeat(4)}`;
  return { role: index % 2 ? "assistant" : "user", content: index % 2 ? [{ type: "text", text }] : text, timestamp: (index + 1) * 1000 };
});

test("200-message transcript selection find and manual scroll during output", async ({ browser, request }) => {
  await scenario({ browser, request }, "long-transcript", views[0], { fixture: { fakePi: { FAKE_PI_TRANSCRIPT_JSON: JSON.stringify(longTranscript) } }, evidence: { simulation: "200 fixed messages supplied through existing fake-Pi get_messages override; real stream, DOM Range, application find and scroll handlers." } }, async ({ page, fixture, record }) => {
    await expect(page.locator("#chat .message")).toHaveCount(200);
    const bubble = page.locator("#chat .message").filter({ hasText: "Deterministic message 101." });
    await bubble.scrollIntoViewIfNeeded();
    await page.locator("#chat").click({ position: { x: 20, y: 20 } });
    await page.keyboard.press("Control+f");
    await page.locator("#chatSearchInput").fill("Deterministic message 101.");
    await expect(page.locator("#chatSearchCount")).toHaveText("1/1");
    expect(await page.evaluate(() => CSS.highlights.get("chat-search-match")?.size)).toBe(1);
    await bubble.evaluate((node) => {
      const target = "Deterministic message 101.";
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const start = walker.currentNode.textContent.indexOf(target);
        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(walker.currentNode, start);
        range.setEnd(walker.currentNode, start + target.length);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        return;
      }
      throw new Error("deterministic selection text missing");
    });
    const selected = "Deterministic message 101.";
    expect(await page.evaluate(() => window.getSelection().toString())).toBe(selected);
    await page.locator("#chat").evaluate((node) => { node.scrollTop -= 80; node.dispatchEvent(new Event("scroll")); });
    const before = await page.locator("#chat").evaluate((node) => node.scrollTop);
    expect(before).toBeGreaterThan(0);
    await prompt(page, fixture, streamPrompt);
    await expect(page.locator("#chat .message.assistant.streaming")).toContainText("This is a long");
    const samples = [];
    for (let index = 0; index < 5; index += 1) {
      samples.push(await page.evaluate(() => ({ selection: window.getSelection().toString(), scrollTop: document.querySelector("#chat").scrollTop, find: document.querySelector("#chatSearchCount").textContent, query: document.querySelector("#chatSearchInput").value })));
      await page.waitForTimeout(300);
    }
    await waitIdle(page, fixture);
    await expect(page.locator("#chat")).toContainText(streamFinal);
    samples.push(await page.evaluate(() => ({ selection: window.getSelection().toString(), scrollTop: document.querySelector("#chat").scrollTop, find: document.querySelector("#chatSearchCount").textContent, query: document.querySelector("#chatSearchInput").value })));
    record.continuity = { messageCount: 200, beforeScrollTop: before, samples, finalOutput: streamFinal };
    for (const sample of samples) {
      expect(sample.selection).toBe(selected);
      expect(Math.abs(sample.scrollTop - before)).toBeLessThanOrEqual(1);
      expect(sample.find).toBe("1/1");
      expect(sample.query).toBe(selected);
    }
    await snapshot(page, record, "preserved");
  });
});

test("expanded 120-file tree and search", async ({ browser, request }) => {
  await scenario({ browser, request }, "large-file-tree", views[0], {}, async ({ page, record, act }) => {
    await act("#sidePanelSectionToggleFiles", "expand Files", () => page.locator("#sidePanelSectionToggleFiles").click());
    const files = page.locator('#fileTreeRoot .file-tree-item[data-path^="context-"]');
    await expect(files).toHaveCount(120);
    record.fileCount = await files.count();
    record.firstFile = await files.first().getAttribute("data-path");
    record.lastFile = await files.last().getAttribute("data-path");
    await snapshot(page, record, "expanded");
    await act("#fileTreeSearchInput", "find context-119", () => page.locator("#fileTreeSearchInput").fill("context-119"));
    const last = page.locator('.file-tree-item[data-path="context-119.txt"]');
    await expect(last).toBeVisible();
    await act('file "context-119.txt"', "open final file", () => last.click());
    await expect(page.locator("#fileViewerPane")).toBeVisible();
    await expect(page.locator("#fileViewerEditor")).toHaveValue("Fixed context 119\n");
    await snapshot(page, record, "searched-open");
  });
});

test.afterAll(async () => {
  report.omissions = [
    "Model catalog and tools/skills discovery are simulated. Existing fake Pi does not retain set_model state; durable provider switching cannot be asserted.",
    "No installed-companion matrix or real provider execution; representative feature families only.",
    "Chromium phone emulation does not establish native device/engine, OS keyboard or touch usability.",
    "Tablet-v2 attachment clipping remains parent BUG-002; no fix or original baseline replacement.",
    "No new performance measurements or crowding denominators; original 42-image reference and frozen budgets remain authoritative.",
  ];
  await saveJson(join(runDirectory, "capability-report.json"), report);
  if (process.env.PI_OVERHAUL_UPDATE_CAPABILITY_BASELINE === "1") {
    assert.equal(report.scenarios.length, 20, "refuse incomplete capability evidence");
    const recordedStatuses = new Set(["verified", "partial-fixture-limitation", "known-defect-characterization"]);
    assert.ok(report.scenarios.every((entry) => recordedStatuses.has(entry.status) && entry.pageErrors.length === 0), "refuse failed or unclassified scenarios");
    await saveJson(join(packageRoot, "docs/overhaul/capability-browser-baseline.json"), report);
  }
});
