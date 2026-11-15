import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { test } from "./session-fixture.mjs";

test.use({
  video: "off",
  serviceWorkers: "block",
  viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce",
});
test.setTimeout(45_000);

const original = {
  "origin.txt": Array.from({ length: 180 }, (_, index) => `Origin line ${index + 1}: retained file buffer`).join("\n") + "\n",
  "peer.txt": "Peer file on disk.\n",
  "replacement.txt": "Replacement file on disk.\n",
};
const originDraft = original["origin.txt"].replace("Origin line 1:", "Unsaved origin line 1:");
const peerDraft = "Unsaved peer buffer belongs to the peer tab.\n";

function destination(page, name) {
  return page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name, exact: true });
}

async function showFiles(page) {
  await destination(page, "Project").click();
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  await expect(page.locator("#fileTreeRoot")).toBeVisible();
}

async function openFile(page, tabId, name) {
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/files/content" && response.request().method() === "GET"
      && url.searchParams.get("path") === name && url.searchParams.get("tab") === tabId;
  });
  await page.locator(`#fileTreeRoot [role="treeitem"][data-path="${name}"]`).click();
  const response = await responsePromise;
  expect(response.ok()).toBe(true);
  expect((await response.json()).data.content).toBe(original[name]);
  await expect(page.locator("#fileViewerTitle")).toHaveText(name);
  await expect(page.locator("#fileViewerEditor")).toBeVisible();
  await expect(page.locator("#fileViewerEditor")).toHaveValue(original[name]);
}

function trackWrites(page) {
  const writes = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/files/content" && request.method() === "POST") {
      writes.push({ tabId: url.searchParams.get("tab"), body: request.postDataJSON() });
    }
  });
  return writes;
}

async function expectDisk(ownership, saved = {}) {
  for (const [name, content] of Object.entries({ ...original, ...saved })) {
    expect(await readFile(join(ownership.tabs[0].cwd, name), "utf8"), `${name} on disk`).toBe(content);
  }
}

async function saveFile(page, tabId, name, content) {
  const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/files/content"
    && response.request().method() === "POST");
  await page.locator("#fileViewerSaveButton").click();
  const response = await responsePromise;
  expect(new URL(response.url()).searchParams.get("tab")).toBe(tabId);
  expect(response.request().postDataJSON()).toEqual({ path: name, content, mtimeMs: expect.any(Number) });
  expect(response.ok()).toBe(true);
  const payload = await response.json();
  expect(payload.ok).toBe(true);
  expect(payload.data.path).toBe(name);
  await expect(page.locator("#fileViewerStatus")).toHaveText("Saved.");
  await expect(page.locator("#fileViewerSaveButton")).toBeDisabled();
}

async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.beforeEach(async ({ page, ownership }) => {
  await Promise.all(Object.entries(original).map(([name, content]) => writeFile(join(ownership.tabs[0].cwd, name), content)));
  await page.addInitScript(() => localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "focused" })));
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator("#focusedWorkspace")).toBeVisible();
  await expect(page.locator("#modelSelect")).not.toBeEmpty();
  await expect(page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`)).toHaveAttribute("aria-selected", "true");
  await showFiles(page);
});

test("dirty file survives Project, Activity and Settings until an explicit save", async ({ page, ownership }, testInfo) => {
  const writes = trackWrites(page);
  const source = ownership.tabs[0];
  await openFile(page, source.id, "origin.txt");
  await page.locator("#fileViewerEditor").fill(originDraft);
  await expect(page.locator("#fileViewerSaveButton")).toBeEnabled();

  for (const name of ["Activity", "Settings"]) {
    await destination(page, name).click();
    await expect(page.locator("#focusedWorkspace")).toHaveAttribute("data-destination", name.toLowerCase());
    if (name === "Activity") {
      await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: 'Events' });
      await expect(page.locator("#eventFilterSelect")).toBeVisible();
    } else {
      await expect(page.locator("#desktopShellSelect")).toBeVisible();
    }
    await expect(page.locator("#confirmationDialog")).toBeHidden();
    await showFiles(page);
    await expect(page.locator("#fileViewerTitle")).toHaveText("origin.txt");
    await expect(page.locator("#fileViewerEditor")).toHaveValue(originDraft);
    await expect(page.locator("#fileViewerSaveButton")).toBeEnabled();
    await expectDisk(ownership);
  }

  expect(writes).toEqual([]);
  const diskContent = await ownership.api(`/api/files/content?tab=${encodeURIComponent(source.id)}&path=origin.txt`);
  expect(diskContent.content).toBe(original["origin.txt"]);
  await capture(page, testInfo, "dirty-origin-after-destinations");
  await saveFile(page, source.id, "origin.txt", originDraft);
  await expectDisk(ownership, { "origin.txt": originDraft });
  expect(writes).toHaveLength(1);
});

test("declining dirty-file replacement retains the draft and saves only its original path", async ({ page, ownership }, testInfo) => {
  const writes = trackWrites(page);
  const source = ownership.tabs[0];
  await openFile(page, source.id, "origin.txt");
  await page.locator("#fileViewerEditor").fill(originDraft);
  await page.locator('#fileTreeRoot [role="treeitem"][data-path="replacement.txt"]').click();
  const confirmation = page.getByRole("dialog", { name: "Discard unsaved file edits?", exact: true });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText("origin.txt");
  await capture(page, testInfo, "decline-dirty-file-replacement");
  await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(page.locator("#fileViewerTitle")).toHaveText("origin.txt");
  await expect(page.locator("#fileViewerEditor")).toHaveValue(originDraft);
  await expect(page.locator("#fileViewerSaveButton")).toBeEnabled();
  await expectDisk(ownership);
  expect(writes).toEqual([]);

  await saveFile(page, source.id, "origin.txt", originDraft);
  await expectDisk(ownership, { "origin.txt": originDraft });
  expect(writes).toHaveLength(1);
  const replacement = await ownership.api(`/api/files/content?tab=${encodeURIComponent(source.id)}&path=replacement.txt`);
  expect(replacement.content).toBe(original["replacement.txt"]);
  await capture(page, testInfo, "saved-origin-after-declined-replacement");
});

test("tab switches retain separate dirty buffers and save only the selected tab's file", async ({ page, ownership }, testInfo) => {
  const writes = trackWrites(page);
  const [source, peer] = ownership.tabs;
  await openFile(page, source.id, "origin.txt");
  await page.locator("#fileViewerEditor").fill(originDraft);
  await page.locator(`#tabBar [data-tab-id="${peer.id}"] .terminal-tab-button`).click();
  await expect(page.locator("#confirmationDialog")).toBeHidden();
  await showFiles(page);
  await openFile(page, peer.id, "peer.txt");
  await page.locator("#fileViewerEditor").fill(peerDraft);

  for (const [tab, name, draft] of [[source, "origin.txt", originDraft], [peer, "peer.txt", peerDraft], [source, "origin.txt", originDraft]]) {
    await page.locator(`#tabBar [data-tab-id="${tab.id}"] .terminal-tab-button`).click();
    await showFiles(page);
    await expect(page.locator("#fileViewerTitle")).toHaveText(name);
    await expect(page.locator("#fileViewerEditor")).toHaveValue(draft);
    await expect(page.locator("#fileViewerSaveButton")).toBeEnabled();
    await expect(page.locator("#confirmationDialog")).toBeHidden();
  }
  await expectDisk(ownership);
  expect(writes).toEqual([]);
  await saveFile(page, source.id, "origin.txt", originDraft);
  await expectDisk(ownership, { "origin.txt": originDraft });
  await capture(page, testInfo, "origin-saved-peer-still-unsaved");

  await page.locator(`#tabBar [data-tab-id="${peer.id}"] .terminal-tab-button`).click();
  await showFiles(page);
  await expect(page.locator("#fileViewerTitle")).toHaveText("peer.txt");
  await expect(page.locator("#fileViewerEditor")).toHaveValue(peerDraft);
  await expect(page.locator("#fileViewerSaveButton")).toBeEnabled();
  expect(writes).toHaveLength(1);
  await saveFile(page, peer.id, "peer.txt", peerDraft);
  await expectDisk(ownership, { "origin.txt": originDraft, "peer.txt": peerDraft });
  expect(writes.map(({ tabId, body }) => ({ tabId, path: body.path, content: body.content }))).toEqual([
    { tabId: source.id, path: "origin.txt", content: originDraft },
    { tabId: peer.id, path: "peer.txt", content: peerDraft },
  ]);
});

test("editor selection and vertical scroll survive destinations and another tab's editor", async ({ page, ownership }, testInfo) => {
  const writes = trackWrites(page);
  const [source, peer] = ownership.tabs;
  await openFile(page, source.id, "origin.txt");
  const editor = page.locator("#fileViewerEditor");
  await editor.fill(originDraft);
  await editor.focus();
  const continuity = await editor.evaluate((node) => {
    const start = node.value.indexOf("Origin line 70:");
    node.setSelectionRange(start, start + "Origin line 70:".length, "backward");
    node.scrollTop = 900;
    return { start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, scrollTop: node.scrollTop };
  });
  expect(continuity.start).toBeGreaterThan(0);
  expect(continuity.scrollTop).toBeGreaterThan(0);
  await capture(page, testInfo, "editor-selection-before-navigation");

  const expectContinuity = async (label) => {
    await expect(editor).toBeVisible();
    await expect(editor).toHaveValue(originDraft);
    const current = await editor.evaluate((node) => ({ start: node.selectionStart, end: node.selectionEnd, direction: node.selectionDirection, scrollTop: node.scrollTop }));
    expect.soft({ start: current.start, end: current.end, direction: current.direction }, `${label}: selection`).toEqual({ start: continuity.start, end: continuity.end, direction: continuity.direction });
    expect.soft(Math.abs(current.scrollTop - continuity.scrollTop), `${label}: vertical scroll`).toBeLessThanOrEqual(1);
  };

  for (const name of ["Activity", "Settings"]) {
    await destination(page, name).click();
    await showFiles(page);
    await expectContinuity(name);
  }
  await page.locator(`#tabBar [data-tab-id="${peer.id}"] .terminal-tab-button`).click();
  await showFiles(page);
  await openFile(page, peer.id, "peer.txt");
  await page.locator(`#tabBar [data-tab-id="${source.id}"] .terminal-tab-button`).click();
  await showFiles(page);
  await capture(page, testInfo, "editor-selection-after-tab-return");
  await expectContinuity("tab return");
  await expect(page.locator("#fileViewerSaveButton")).toBeEnabled();
  await expectDisk(ownership);
  expect(writes).toEqual([]);
});
