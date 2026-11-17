import { expect } from "@playwright/test";
import { test } from "./session-fixture.mjs";

test.use({
  video: "off", serviceWorkers: "block", viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce", actionTimeout: 8_000,
  ...(process.env.PI_WEBUI_TEST_CHROMIUM ? { launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM } } : {}),
});
test.setTimeout(45_000);

const catalog = [{ provider: "alpha", id: "shared" }, { provider: "beta", id: "alternate" }, { provider: "beta", id: "shared" }];
const scope = (page) => page.locator(".native-resource-scope select");
const model = (page) => page.locator(".native-resource-model select");
const inherit = (page) => page.locator("#nativeCommandActions").getByRole("button", { name: "Use inherited defaults", exact: true });
const item = (page, name) => page.locator(".native-selector-item").filter({ has: page.getByText(name, { exact: true }) });
const names = (page) => page.locator("#nativeCommandBody .native-selector-title strong");

function resourceData(kind, resourceNames, enabled = resourceNames, extra = {}) {
  return {
    [kind]: resourceNames.map((name) => ({
      name, description: `Fixture ${name}`, enabled: enabled.includes(name),
      sourceInfo: { source: "builtin", scope: "temporary", origin: "top-level" },
    })),
    configured: true, ...extra,
  };
}

async function fulfill(route, data, status = 200) {
  await route.fulfill({ status, json: status >= 400 ? { ok: false, ...data } : { ok: true, data } });
}

async function browserTurn(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function release(page, call, data, status = 200) {
  const delivered = page.waitForResponse((response) => response.request() === call.route.request());
  await fulfill(call.route, data, status);
  await (await delivered).finished();
  // Let fetch/json continuations and the actual dialog renderer process the response.
  await browserTurn(page);
}

async function interceptResources(page, respond) {
  const calls = [];
  await page.route(/\/api\/(tools|skills)(?:\?|$)/, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const call = {
      route, kind: url.pathname.slice(5), method: request.method(),
      tabId: url.searchParams.get("tab"), scope: url.searchParams.get("scope"),
      provider: url.searchParams.get("provider"), modelId: url.searchParams.get("modelId"),
      body: request.method() === "POST" ? request.postDataJSON() : null,
    };
    calls.push(call);
    await respond(call);
  });
  return calls;
}

async function mockCatalog(page) {
  const calls = [];
  await page.route(/\/api\/models(?:\?|$)/, (route) => {
    calls.push(route.request().url());
    return fulfill(route, { models: catalog });
  });
  return calls;
}

async function openSetup(page, kind = "tools") {
  if (!await page.locator("#nativeCommandMenuButton").isVisible()) await page.locator("#composerActionsButton").click();
  await page.locator("#nativeCommandMenuButton").click();
  await page.locator(kind === "tools" ? "#nativeToolsButton" : "#nativeSkillsButton").click();
  await expect(page.locator("#nativeCommandDialog")).toBeVisible();
  await expect(page.locator("#nativeCommandTitle")).toHaveText(kind === "tools" ? "Tools Setup" : "Skills Setup");
}

async function closeSetup(page) {
  await page.locator("#nativeCommandActions").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator("#nativeCommandDialog")).toBeHidden();
}

async function chooseModel(page, label) {
  const value = await model(page).locator("option").filter({ hasText: new RegExp(`^${label}$`) }).getAttribute("value");
  await model(page).selectOption(value);
}

async function selectTab(page, id) {
  const button = page.locator(`#tabBar [data-tab-id="${id}"] .terminal-tab-button`);
  await button.click();
  await expect(button).toHaveAttribute("aria-selected", "true");
}

test.beforeEach(async ({ page, ownership }) => {
  // Only advertise the two fixture commands; the production command/menu/dialog path remains intact.
  await page.route(/\/api\/commands(?:\?|$)/, (route) => fulfill(route, {
    commands: [
      { name: "tools", source: "extension", description: "Configure tools" },
      { name: "skills", source: "extension", description: "Configure skills" },
    ],
  }));
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator("#promptInput")).toBeVisible();
  await expect(page.locator("#chat")).toContainText("fake answer");
  await expect(page.locator("#modelSelect option")).not.toHaveCount(0);
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(2);
});

test("late Session, Global and Model reads cannot replace the newest exact-model selection", async ({ page, ownership }) => {
  await mockCatalog(page);
  const calls = await interceptResources(page, () => {});
  await openSetup(page);
  await expect.poll(() => calls.length).toBe(1);
  await scope(page).selectOption("global");
  await expect.poll(() => calls.length).toBe(2);
  await scope(page).selectOption("model");
  await expect.poll(() => calls.length).toBe(3);
  await chooseModel(page, "beta/shared");
  await expect.poll(() => calls.length).toBe(4);
  expect(calls.map(({ scope, provider, modelId, tabId }) => ({ scope, provider, modelId, tabId }))).toEqual([
    { scope: "session", provider: null, modelId: null, tabId: ownership.tabs[0].id },
    { scope: "global", provider: null, modelId: null, tabId: ownership.tabs[0].id },
    { scope: "model", provider: "alpha", modelId: "shared", tabId: ownership.tabs[0].id },
    { scope: "model", provider: "beta", modelId: "shared", tabId: ownership.tabs[0].id },
  ]);
  await release(page, calls[3], resourceData("tools", ["current-model"]));
  await expect(names(page)).toHaveText(["current-model"]);
  for (const index of [2, 1, 0]) {
    await release(page, calls[index], resourceData("tools", [`retired-${calls[index].scope}`]));
    await expect(scope(page)).toHaveValue("model");
    await expect(model(page).locator("option:checked")).toHaveText("beta/shared");
    await expect(names(page)).toHaveText(["current-model"]);
    await expect(page.locator("#nativeCommandError")).toBeHidden();
    await expect(inherit(page)).toBeEnabled();
  }
  expect(calls).toHaveLength(4);
});

test("Tools completion and error after reopen cannot clear a pending Skills write or show stale notices", async ({ page }) => {
  const calls = await interceptResources(page, (call) => call.method === "GET"
    ? fulfill(call.route, resourceData(call.kind, call.kind === "tools" ? ["read", "bash"] : ["repo-explorer", "code-security"]))
    : undefined);
  for (const outcome of ["completion", "error"]) {
    await openSetup(page);
    await item(page, "read").click();
    await expect.poll(() => calls.filter((call) => call.kind === "tools" && call.method === "POST").length).toBe(outcome === "completion" ? 1 : 2);
    const oldWrite = calls.findLast((call) => call.kind === "tools" && call.method === "POST");
    await closeSetup(page);
    await openSetup(page, "skills");
    await item(page, "repo-explorer").click();
    await expect.poll(() => calls.filter((call) => call.kind === "skills" && call.method === "POST").length).toBe(outcome === "completion" ? 1 : 2);
    const currentWrite = calls.findLast((call) => call.kind === "skills" && call.method === "POST");
    expect(currentWrite.body).toEqual({ scope: "session", enabledSkills: ["code-security"] });
    await expect(scope(page)).toBeDisabled();
    if (outcome === "error") await release(page, oldWrite, { error: "retired Tools write failed" }, 500);
    else await release(page, oldWrite, resourceData("tools", ["retired-tools-completion"]));
    await expect(page.locator("#nativeCommandTitle")).toHaveText("Skills Setup");
    await expect(names(page)).toHaveText(["repo-explorer", "code-security"]);
    await expect(scope(page)).toBeDisabled();
    await expect(inherit(page)).toBeDisabled();
    await expect(item(page, "repo-explorer")).toBeDisabled();
    await expect(page.locator("#nativeCommandError")).toBeHidden();
    await expect(page.locator("#chat")).not.toContainText("Tool read disabled for this session.");
    await release(page, currentWrite, resourceData("skills", ["repo-explorer", "code-security"], ["code-security"]));
    await expect(item(page, "repo-explorer")).toHaveAttribute("aria-pressed", "false");
    await expect(scope(page)).toBeEnabled();
    await expect(inherit(page)).toBeEnabled();
    await expect(page.locator("#chat")).toContainText("Skill repo-explorer disabled for this session.");
    await closeSetup(page);
  }
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(4);
});

test("original-tab write and pre-replacement session read stay retired across real UI target changes", async ({ page, ownership }) => {
  const [source, peer] = ownership.tabs;
  const beforeSource = await ownership.api(`/api/state?tab=${source.id}`);
  const beforePeer = await ownership.api(`/api/state?tab=${peer.id}`);
  let holdNextRead = false;
  let oldRead;
  let replacement = false;
  const calls = await interceptResources(page, (call) => {
    if (call.method === "POST") return;
    if (holdNextRead) {
      holdNextRead = false;
      oldRead = call;
      return;
    }
    return fulfill(call.route, resourceData(call.kind, [call.tabId === peer.id ? "peer-read" : replacement ? "replacement-read" : "read"]));
  });
  await openSetup(page);
  await item(page, "read").click();
  await expect.poll(() => calls.filter((call) => call.method === "POST").length).toBe(1);
  const oldWrite = calls.findLast((call) => call.method === "POST");
  expect(oldWrite.tabId).toBe(source.id);
  expect(oldWrite.body).toEqual({ scope: "session", enabledTools: [] });
  await closeSetup(page);
  await selectTab(page, peer.id);
  await openSetup(page);
  await expect(names(page)).toHaveText(["peer-read"]);
  await release(page, oldWrite, resourceData("tools", ["retired-source-write"]));
  await expect(names(page)).toHaveText(["peer-read"]);
  await expect(page.locator("#chat")).not.toContainText("Tool read disabled for this session.");
  expect((await ownership.api(`/api/state?tab=${peer.id}`)).sessionId).toBe(beforePeer.sessionId);
  await closeSetup(page);
  await selectTab(page, source.id);
  holdNextRead = true;
  await openSetup(page);
  await expect.poll(() => Boolean(oldRead)).toBe(true);
  expect(oldRead.tabId).toBe(source.id);
  await closeSetup(page);
  if (!await page.locator("#newSessionButton").isVisible()) await page.locator("#composerActionsButton").click();
  await page.locator("#newSessionButton").click();
  await expect(page.locator("#confirmationDialog")).toBeVisible();
  const replaced = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/new-session" && response.request().method() === "POST");
  replacement = true;
  await page.locator("#confirmationConfirmButton").click();
  expect((await replaced).ok()).toBe(true);
  await expect.poll(async () => (await ownership.api(`/api/state?tab=${source.id}`)).sessionId).not.toBe(beforeSource.sessionId);
  await expect(page.locator("#confirmationDialog")).toBeHidden();
  await openSetup(page);
  await expect(names(page)).toHaveText(["replacement-read"]);
  await release(page, oldRead, resourceData("tools", ["retired-session-read"]));
  await expect(names(page)).toHaveText(["replacement-read"]);
  await expect(scope(page)).toHaveValue("session");
  await expect(page.locator("#nativeCommandError")).toBeHidden();
  expect(calls.filter((call) => call.method === "POST").map(({ tabId, body }) => ({ tabId, body }))).toEqual([
    { tabId: source.id, body: { scope: "session", enabledTools: [] } },
  ]);
});

test("reordered model catalogs preserve provider/id through stale reads and the next write", async ({ page, ownership }, testInfo) => {
  const originalModel = (await ownership.api(`/api/state?tab=${ownership.tabs[0].id}`)).model;
  await mockCatalog(page);
  let held;
  const calls = await interceptResources(page, (call) => {
    if (call.method === "GET" && call.modelId === "alternate") { held = call; return; }
    return fulfill(call.route, resourceData("tools", ["read", "bash"], call.method === "POST" ? call.body.enabledTools : ["read", "bash"], {
      models: [catalog[2], catalog[0], catalog[1]],
    }));
  });
  await openSetup(page);
  await scope(page).selectOption("model");
  await expect(names(page)).toHaveText(["read", "bash"]);
  await expect(model(page).locator("option:checked")).toHaveText("alpha/shared");
  await expect(model(page)).toHaveValue("1");
  await chooseModel(page, "beta/alternate");
  await expect.poll(() => Boolean(held)).toBe(true);
  await chooseModel(page, "beta/shared");
  await expect(names(page)).toHaveText(["read", "bash"]);
  await release(page, held, resourceData("tools", ["retired-alternate"], ["retired-alternate"], { models: [...catalog].reverse() }));
  await expect(model(page).locator("option:checked")).toHaveText("beta/shared");
  await expect(model(page)).toHaveValue("0");
  await expect(names(page)).toHaveText(["read", "bash"]);
  await item(page, "read").click();
  await expect(item(page, "read")).toHaveAttribute("aria-pressed", "false");
  expect(calls.filter((call) => call.method === "POST").map(({ tabId, body }) => ({ tabId, body }))).toEqual([
    { tabId: ownership.tabs[0].id, body: { scope: "model", provider: "beta", modelId: "shared", enabledTools: ["bash"] } },
  ]);
  expect((await ownership.api(`/api/state?tab=${ownership.tabs[0].id}`)).model).toEqual(originalModel);
  await expect(model(page).locator("option:checked")).toHaveText("beta/shared");
  await expect(page.locator("#nativeCommandError")).toBeHidden();
  const screenshot = testInfo.outputPath("exact-model-after-reordered-catalog.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("actual exact-model Tools dialog", { path: screenshot, contentType: "image/png" });
});

test("filtered writes keep the full enabled set and distinguish explicit empty from inheritance", async ({ page, ownership }) => {
  const resourceNames = ["read", "bash", "write", "grep"];
  const initialEnabled = ["read", "bash", "grep"];
  const calls = await interceptResources(page, (call) => fulfill(call.route,
    resourceData("tools", resourceNames, call.method === "POST" && !call.body.inherit ? call.body.enabledTools : initialEnabled,
      { configured: call.body?.inherit !== true })));
  await openSetup(page);
  await scope(page).selectOption("global");
  await expect(names(page)).toHaveText(resourceNames);
  await page.locator("#nativeCommandActions").getByRole("button", { name: "Enabled", exact: true }).click();
  await page.locator("#nativeCommandSearch").fill("read");
  await expect(names(page)).toHaveText(["read"]);
  await item(page, "read").click();
  await expect(names(page)).toHaveCount(0);
  await page.locator("#nativeCommandSearch").fill("");
  await expect(names(page)).toHaveText(["bash", "grep"]);
  await item(page, "bash").click();
  await expect(names(page)).toHaveText(["grep"]);
  await item(page, "grep").click();
  await expect(names(page)).toHaveCount(0);
  await inherit(page).click();
  await expect(names(page)).toHaveText(initialEnabled);
  await expect(page.locator(".native-resource-scope")).toContainText("No global default is saved yet");
  expect(calls.filter((call) => call.method === "POST").map(({ tabId, body }) => ({ tabId, body }))).toEqual([
    { tabId: ownership.tabs[0].id, body: { scope: "global", enabledTools: ["bash", "grep"] } },
    { tabId: ownership.tabs[0].id, body: { scope: "global", enabledTools: ["grep"] } },
    { tabId: ownership.tabs[0].id, body: { scope: "global", enabledTools: [] } },
    { tabId: ownership.tabs[0].id, body: { scope: "global", inherit: true } },
  ]);
});

test("detached resource, inherit, scope and model controls cannot dispatch into replacement selections", async ({ page }) => {
  const modelCalls = await mockCatalog(page);
  const calls = await interceptResources(page, (call) => fulfill(call.route, resourceData(call.kind, ["read", "bash"])));
  await openSetup(page);
  await expect(names(page)).toHaveText(["read", "bash"]);
  const oldRow = await item(page, "read").elementHandle();
  const oldInherit = await inherit(page).elementHandle();
  const oldScope = await scope(page).elementHandle();
  await scope(page).selectOption("global");
  await expect(names(page)).toHaveText(["read", "bash"]);
  const afterGlobal = calls.length;
  for (const node of [oldRow, oldInherit, oldScope]) expect(await node.evaluate((element) => element.isConnected)).toBe(false);
  // Dispatch DOM events on retained detached controls, never call application handlers directly.
  await oldRow.evaluate((element) => element.click());
  await oldInherit.evaluate((element) => element.click());
  await oldScope.evaluate((element) => { element.value = "model"; element.dispatchEvent(new Event("change", { bubbles: true })); });
  await browserTurn(page);
  expect(calls).toHaveLength(afterGlobal);
  expect(modelCalls).toEqual([]);
  await expect(scope(page)).toHaveValue("global");

  await scope(page).selectOption("model");
  await expect(names(page)).toHaveText(["read", "bash"]);
  const oldModel = await model(page).elementHandle();
  const oldModelRow = await item(page, "read").elementHandle();
  await chooseModel(page, "beta/shared");
  await expect(names(page)).toHaveText(["read", "bash"]);
  const afterModel = calls.length;
  expect(await oldModel.evaluate((element) => element.isConnected)).toBe(false);
  await oldModel.evaluate((element) => { element.value = "0"; element.dispatchEvent(new Event("change", { bubbles: true })); });
  await oldModelRow.evaluate((element) => element.click());
  await browserTurn(page);
  expect(calls).toHaveLength(afterModel);
  expect(modelCalls).toHaveLength(1);
  await expect(model(page).locator("option:checked")).toHaveText("beta/shared");

  const retiredRow = await item(page, "read").elementHandle();
  const retiredInherit = await inherit(page).elementHandle();
  await closeSetup(page);
  await openSetup(page, "skills");
  await expect(names(page)).toHaveText(["read", "bash"]);
  const afterReopen = calls.length;
  await retiredRow.evaluate((element) => element.click());
  await retiredInherit.evaluate((element) => element.click());
  await browserTurn(page);
  expect(calls).toHaveLength(afterReopen);
  expect(modelCalls).toHaveLength(1);
  expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  await expect(page.locator("#nativeCommandTitle")).toHaveText("Skills Setup");
  await expect(scope(page)).toHaveValue("session");
  await expect(page.locator("#nativeCommandError")).toBeHidden();
});
