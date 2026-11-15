import { rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect } from "@playwright/test";
import { test } from "./empty-startup-fixture.mjs";

test.use({
  video: "off", serviceWorkers: "block", viewport: { width: 1440, height: 900 },
  launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM || "/usr/bin/chromium" },
});

async function ready(page, fixture) {
  await page.addInitScript(() => localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "focused" })));
  await page.goto(fixture.baseURL);
  await expect(page.locator("#emptyStartTitle")).toHaveText("Start a conversation");
  await expect(page.locator(".focused-context")).toHaveText("No Project");
  await expect(page.locator("#pathPickerDialog")).not.toBeVisible();
  await expect(page.locator("#promptInput")).toBeEditable();
  await expect(page.locator("#promptInput")).toBeFocused();
  await expect(page.locator("#statusBar")).toContainText("Ready for your first message");
}

function trackMutations(page) {
  const requests = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (request.method() === "POST" && ["/api/tabs", "/api/prompt"].includes(url.pathname)) {
      requests.push({ path: url.pathname, tab: url.searchParams.get("tab"), body: request.postDataJSON() });
    }
  });
  return requests;
}

async function expectUnallocated(fixture) {
  expect((await fixture.api("/api/tabs")).tabs).toEqual([]);
  expect(await fixture.ownedDirectories()).toEqual([]);
  await expect(stat(fixture.ownedRoot)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await fixture.starts()).toEqual([]);
}

async function expectPrompt(fixture, message) {
  const userPrompts = async () => (await fixture.commands()).filter(item => item.type === "prompt" && !/^\/(?:webui-helper |fast-mode )/.test(item.message));
  await expect.poll(userPrompts).toHaveLength(1);
  const commands = await userPrompts();
  expect(commands.map(item => item.message)).toEqual([message]);
  return commands;
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: "image/png" });
}

// Hold only a real creation response, with a bound even if the test fails.
async function holdFirstCreation(page) {
  let notify;
  let release;
  const created = new Promise(resolve => { notify = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  let held = false;
  const handler = async route => {
    if (route.request().method() !== "POST" || held) return route.continue();
    held = true;
    const response = await route.fetch();
    notify((await response.json()).data.tab);
    await Promise.race([released, delay(3_000)]);
    await route.fulfill({ response });
  };
  await page.route("**/api/tabs", handler);
  return { created, release: () => release() };
}

test("initial load, reload, and empty activations allocate nothing", async ({ page, emptyStartup }, info) => {
  const requests = trackMutations(page);
  await ready(page, emptyStartup);
  await expectUnallocated(emptyStartup);
  await capture(page, info, "empty-no-project");
  await page.reload();
  await expect(page.locator("#emptyStartTitle")).toHaveText("Start a conversation");
  await expectUnallocated(emptyStartup);
  await page.locator("#promptInput").fill(" \n\t ");
  await page.locator("#promptInput").press("Enter");
  await page.locator("#sendButton").click();
  await expect(page.locator("#promptInput")).toHaveValue(" \n\t ");
  await expectUnallocated(emptyStartup);
  expect(requests).toEqual([]);
});

for (const activation of ["Enter", "click"]) {
  test(`first ${activation} sends captured text once to its owned tab`, async ({ page, emptyStartup }, info) => {
    const requests = trackMutations(page);
    await ready(page, emptyStartup);
    const message = `First ${activation} prompt\nwith a second line and λ`;
    await page.locator("#promptInput").fill(message);
    if (activation === "Enter") await page.locator("#promptInput").press("Enter");
    else await page.locator("#sendButton").click();
    const commands = await expectPrompt(emptyStartup, message);
    const tabs = (await emptyStartup.api("/api/tabs")).tabs;
    expect(tabs).toHaveLength(1);
    const tab = tabs[0];
    expect(tab.workspaceKind).toBe("no-project");
    expect(tab.cwd).toBe(join(emptyStartup.ownedRoot, tab.noProjectId));
    expect((await stat(tab.cwd)).isDirectory()).toBe(true);
    expect(commands[0].cwd).toBe(tab.cwd);
    expect(await emptyStartup.ownedDirectories()).toEqual([tab.noProjectId]);
    expect(requests.filter(item => item.path === "/api/tabs").map(item => item.body)).toEqual([{ workspaceKind: "no-project" }]);
    const prompts = requests.filter(item => item.path === "/api/prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0].tab).toBe(tab.id);
    expect(prompts[0].body.message).toBe(message);
    expect(prompts[0].body.requestId).toBeTruthy();
    await expect(page.locator("#promptInput")).toHaveValue("");
    await expect(page.locator("#chat .message.user", { hasText: message })).toHaveCount(1);
    await capture(page, info, `first-${activation.toLowerCase()}`);
  });
}

test("real creation failure retains the draft and permits retry", async ({ page, emptyStartup }, info) => {
  await ready(page, emptyStartup);
  const message = "Retain this text after creation fails";
  await writeFile(emptyStartup.failFile, "fail\n");
  await page.locator("#promptInput").fill(message);
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tabs" && response.request().method() === "POST");
  await page.locator("#sendButton").click();
  expect((await failed).status()).toBeGreaterThanOrEqual(400);
  await expect(page.locator("#promptInput")).toHaveValue(message);
  expect((await emptyStartup.api("/api/tabs")).tabs).toEqual([]);
  expect((await emptyStartup.commands()).filter(item => item.type === "prompt")).toEqual([]);
  await capture(page, info, "creation-failure-draft");
  await rm(emptyStartup.failFile);
  await page.locator("#promptInput").press("Enter");
  await expectPrompt(emptyStartup, message);
  await expect(page.locator("#promptInput")).toHaveValue("");
});

test("duplicate click and Enter activations share one first submission", async ({ page, emptyStartup }) => {
  const requests = trackMutations(page);
  await ready(page, emptyStartup);
  const hold = await holdFirstCreation(page);
  const message = "Only one activation";
  await page.locator("#promptInput").fill(message);
  await page.locator("#sendButton").click();
  await hold.created;
  await page.locator("#sendButton").click();
  await page.locator("#promptInput").press("Enter");
  hold.release();
  await expectPrompt(emptyStartup, message);
  await expect(page.locator("#promptInput")).toHaveValue("");
  expect(requests.filter(item => item.path === "/api/tabs")).toHaveLength(1);
  expect(requests.filter(item => item.path === "/api/prompt")).toHaveLength(1);
  expect((await emptyStartup.api("/api/tabs")).tabs).toHaveLength(1);
});

test("draft edits during creation survive while captured text reaches the new tab", async ({ page, emptyStartup }, info) => {
  await ready(page, emptyStartup);
  const hold = await holdFirstCreation(page);
  await page.locator("#promptInput").fill("Captured original");
  await page.locator("#sendButton").click();
  const tab = await hold.created;
  await page.locator("#promptInput").fill("Newer draft, never submitted");
  hold.release();
  const [command] = await expectPrompt(emptyStartup, "Captured original");
  expect(command.cwd).toBe(tab.cwd);
  await expect(page.locator("#promptInput")).toHaveValue("Newer draft, never submitted");
  await capture(page, info, "newer-draft-retained");
});

test("navigation and another session draft cannot redirect the pending first prompt", async ({ page, emptyStartup }) => {
  const requests = trackMutations(page);
  await ready(page, emptyStartup);
  const hold = await holdFirstCreation(page);
  await page.locator("#promptInput").fill("Captured before navigation");
  await page.locator("#sendButton").click();
  const first = await hold.created;
  const nextCreated = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tabs" && response.request().method() === "POST");
  await page.locator(".focused-brand").click();
  const second = (await (await nextCreated).json()).data.tab;
  expect(second.id).not.toBe(first.id);
  await expect(page.locator("#promptInput")).toHaveValue("");
  await page.locator("#promptInput").fill("Other session draft");
  hold.release();
  const [command] = await expectPrompt(emptyStartup, "Captured before navigation");
  expect(command.cwd).toBe(first.cwd);
  await expect(page.locator("#promptInput")).toHaveValue("Other session draft");
  await expect(page.locator(`#tabBar [data-tab-id="${second.id}"] .terminal-tab-button`)).toHaveAttribute("aria-selected", "true");
  expect(requests.filter(item => item.path === "/api/prompt").map(item => item.tab)).toEqual([first.id]);
  expect((await emptyStartup.api("/api/tabs")).tabs.map(tab => tab.id).sort()).toEqual([first.id, second.id].sort());
  await page.locator(`#tabBar [data-tab-id="${first.id}"] .terminal-tab-button`).click();
  await page.locator(`#tabBar [data-tab-id="${second.id}"] .terminal-tab-button`).click();
  await expect(page.locator("#promptInput")).toHaveValue("Other session draft");
});

test("first native selector opens normally when its new session stays selected", async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  await page.locator("#promptInput").fill("/name");
  await page.locator("#sendButton").click();
  await expect(page.locator("#nativeCommandDialog")).toBeVisible();
  const tabs = (await emptyStartup.api("/api/tabs")).tabs;
  expect(tabs).toHaveLength(1);
  await page.locator("#nativeCommandBody input").fill("First conversation");
  const dispatched = page.waitForRequest(request => new URL(request.url()).pathname === "/api/prompt" && request.method() === "POST");
  await page.getByRole("button", { name: "Name session", exact: true }).click();
  expect(new URL((await dispatched).url()).searchParams.get("tab")).toBe(tabs[0].id);
});

for (const destination of ["another session", "settings"]) test(`first native selector stays with its new session after navigation to ${destination}`, async ({ page, emptyStartup }) => {
  const requests = trackMutations(page);
  await ready(page, emptyStartup);
  const hold = await holdFirstCreation(page);
  await page.locator("#promptInput").fill("/name");
  await page.locator("#sendButton").click();
  const first = await hold.created;
  let second;
  if (destination === "another session") {
    const created = page.waitForResponse(response => new URL(response.url()).pathname === "/api/tabs" && response.request().method() === "POST");
    await page.locator(".focused-brand").click();
    second = (await (await created).json()).data.tab;
    await page.locator("#promptInput").fill("Other session draft");
  } else {
    await page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Settings", exact: true }).click();
  }
  hold.release();
  await expect(page.getByText(/Its command is saved in that conversation's draft\./).first()).toBeAttached();
  await expect(page.locator("#nativeCommandDialog")).not.toBeVisible();
  expect(requests.filter(item => item.path === "/api/prompt")).toHaveLength(0);
  if (second) {
    await expect(page.locator("#promptInput")).toHaveValue("Other session draft");
    await expect(page.locator(`#tabBar [data-tab-id="${second.id}"] .terminal-tab-button`)).toHaveAttribute("aria-selected", "true");
  } else {
    await expect(page).toHaveURL(/view=settings/);
    await page.getByRole("button", { name: "Back to conversation", exact: true }).click();
  }
  await page.locator(`#tabBar [data-tab-id="${first.id}"] .terminal-tab-button`).click();
  await expect(page.locator("#promptInput")).toHaveValue("/name");
  await page.locator("#sendButton").click();
  await expect(page.locator("#nativeCommandDialog")).toBeVisible();
  await page.locator("#nativeCommandBody input").fill("Intended first session");
  const dispatched = page.waitForRequest(request => new URL(request.url()).pathname === "/api/prompt" && request.method() === "POST");
  await page.getByRole("button", { name: "Name session", exact: true }).click();
  expect(new URL((await dispatched).url()).searchParams.get("tab")).toBe(first.id);
});

test("editing back to the captured text still preserves the newer draft", async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  const hold = await holdFirstCreation(page);
  const message = "Same text, newer draft";
  await page.locator("#promptInput").fill(message);
  await page.locator("#sendButton").click();
  await hold.created;
  await page.locator("#promptInput").fill("Temporary edit");
  await page.locator("#promptInput").fill(message);
  hold.release();
  await expectPrompt(emptyStartup, message);
  await expect(page.locator("#promptInput")).toHaveValue(message);
});

test("a destination chosen during creation stays open", async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  const hold = await holdFirstCreation(page);
  await page.locator("#promptInput").fill("Captured before settings navigation");
  await page.locator("#sendButton").click();
  const tab = await hold.created;
  await page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Settings", exact: true }).click();
  hold.release();
  const [command] = await expectPrompt(emptyStartup, "Captured before settings navigation");
  expect(command.cwd).toBe(tab.cwd);
  await expect(page).toHaveURL(/view=settings/);
  await expect(page.locator("#promptInput")).not.toBeVisible();
});

test("attachments explain the session requirement and long text pastes remain editable", async ({ page, context, emptyStartup }) => {
  await ready(page, emptyStartup);
  await page.locator("#promptInput").fill("Keep this draft");
  await page.locator("#attachmentInput").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("attachment") });
  await expect(page.locator("#chat")).toContainText("Start a conversation before adding attachments");
  await expect(page.locator("#promptInput")).toHaveValue("Keep this draft");
  await expectUnallocated(emptyStartup);
  const text = Array.from({ length: 400 }, (_, index) => `pasted line ${index}`).join("\n");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(text => navigator.clipboard.writeText(text), text);
  await page.locator("#promptInput").focus();
  await page.locator("#promptInput").press("Control+End");
  await page.locator("#promptInput").press("Control+v");
  await expect(page.locator("#promptInput")).toHaveValue(`Keep this draft${text}`);
  await expectUnallocated(emptyStartup);
});
