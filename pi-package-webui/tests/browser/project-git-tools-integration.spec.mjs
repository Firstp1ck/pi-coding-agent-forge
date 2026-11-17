import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "@playwright/test";
import { test as sessionTest } from "./session-fixture.mjs";
import { navigateFocused } from './focused-navigation-fixture.mjs';

const baseline = "committed fixture line\n";
const seedChange = "stashed fixture line\n";
const sectionEndpoints = {
  stash: "/api/git-stash",
  undo: "/api/git-undo",
  worktrees: "/api/git-worktrees",
  submodules: "/api/git-submodules",
  tags: "/api/git-tags",
  signing: "/api/git-signing",
};

const test = sessionTest.extend({
  repository: async ({ ownership }, use) => {
    const cwd = ownership.tabs[0].cwd;
    const git = (...args) => execFileSync("git", args, {
      cwd, encoding: "utf8", timeout: 8_000,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
    }).trimEnd();
    git("init", "--quiet", "--initial-branch=main", "--template=");
    git("config", "--local", "user.name", "WebUI fixture");
    git("config", "--local", "user.email", "webui-fixture@example.invalid");
    git("config", "--local", "commit.gpgsign", "false");
    git("config", "--local", "core.hooksPath", "/dev/null");
    await writeFile(join(cwd, "tracked.txt"), baseline);
    git("add", "tracked.txt");
    git("commit", "--quiet", "--no-gpg-sign", "-m", "T1 initial commit");
    await writeFile(join(cwd, "tracked.txt"), seedChange);
    git("stash", "push", "--quiet", "-m", "T1 preview seed");
    await use({ cwd, git });
  },
});

test.use({
  video: "off", serviceWorkers: "block", viewport: { width: 1440, height: 900 },
  reducedMotion: "reduce", actionTimeout: 8_000,
  launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM || "/usr/bin/chromium" },
});
test.setTimeout(45_000);

function recordGitRequests(page) {
  const requests = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/git-")) return;
    requests.push({ pathname: url.pathname, method: request.method(), tabId: url.searchParams.get("tab") });
  });
  return requests;
}

function waitForApi(page, pathname, method = "GET") {
  return page.waitForResponse((response) => new URL(response.url()).pathname === pathname && response.request().method() === method);
}

async function expectApi(responsePromise, tabId, body) {
  const response = await responsePromise;
  const payload = await response.json();
  expect(response.ok(), JSON.stringify(payload)).toBe(true);
  expect(payload.ok, JSON.stringify(payload)).toBe(true);
  expect(new URL(response.url()).searchParams.get("tab")).toBe(tabId);
  if (body !== undefined) expect(response.request().postDataJSON()).toEqual(body);
  return payload.data;
}

function section(page, key) {
  return page.locator(`#gitChangesDialog [data-git-tools="${key}"]`);
}

async function openSection(page, key, tabId) {
  const response = waitForApi(page, sectionEndpoints[key]);
  await section(page, key).locator(":scope > summary").click();
  const data = await expectApi(response, tabId);
  await expect(section(page, key)).toHaveAttribute("open", "");
  await expect(section(page, key).locator(".git-tools-body")).not.toContainText("Loading…");
  return data;
}

async function openProjectChanges(page, cwd) {
  await navigateFocused(page, 'Project');
  await page.getByRole('combobox', { name: 'Project section', exact: true }).selectOption({ label: 'Changes' });
  const repository = page.locator("#gitPanelGroups [data-git-root]").filter({ hasText: cwd });
  await expect(repository).toHaveCount(1);
  await repository.getByRole("button", { name: "Git actions for project", exact: true }).click();
  await page.locator("#gitPanelContextMenu").getByRole("menuitem", { name: "View Diff", exact: true }).click();
  await expect(page.locator("#gitChangesDialog")).toBeVisible();
  await expect(page.locator("#gitChangesSubtitle")).toContainText(cwd);
  await expect(page.locator("#gitChangesRefreshButton")).toBeEnabled();
  await expect(section(page, "stash")).toBeVisible();
}

async function openCurrentTabChangesFromTools(page) {
  await page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "All tools", exact: true }).click();
  await page.getByRole("searchbox", { name: "Search all tools" }).fill("Git changes");
  await page.locator("#shellToolsLauncher").getByRole("button", { name: "Git changes", exact: true }).click();
  await expect(page.locator("#gitChangesDialog")).toBeVisible();
  await expect(page.locator("#gitChangesRefreshButton")).toBeEnabled();
}

async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function repositorySnapshot(repository) {
  return {
    head: repository.git("rev-parse", "HEAD"),
    refs: repository.git("show-ref"),
    status: repository.git("status", "--porcelain=v1", "--untracked-files=all"),
    stashes: repository.git("stash", "list", "--format=%H%x09%gs"),
    reflog: repository.git("reflog", "--format=%H%x09%gs"),
  };
}

test.beforeEach(async ({ page, ownership, repository }) => {
  await page.addInitScript(() => localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "focused" })));
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator("#focusedWorkspace")).toBeVisible();
  await expect(page.locator("#modelSelect")).not.toBeEmpty();
  await expect(page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`)).toHaveAttribute("aria-selected", "true");
  expect(repository.git("remote")).toBe("");
});

test("Project Git tools load each section only on expansion and reuse cached results", async ({ page, ownership, repository }, testInfo) => {
  const requests = recordGitRequests(page);
  await openProjectChanges(page, repository.cwd);
  const reads = () => requests.filter((request) => Object.values(sectionEndpoints).includes(request.pathname));
  const expectedContent = {
    stash: "T1 preview seed",
    undo: "T1 initial commit",
    worktrees: repository.cwd,
    submodules: "This repository has no submodules.",
    tags: "No tags.",
    signing: "commit.gpgsign: false",
  };
  expect(reads()).toEqual([]);
  for (const [key, pathname] of Object.entries(sectionEndpoints)) {
    const data = await openSection(page, key, ownership.tabs[0].id);
    expect(key === "worktrees" ? data.repoRoot : data.root).toBe(repository.cwd);
    await expect(section(page, key).locator(".git-tools-body")).toContainText(expectedContent[key]);
    expect(reads().filter((request) => request.pathname === pathname)).toHaveLength(1);
    for (const pending of Object.keys(sectionEndpoints).slice(Object.keys(sectionEndpoints).indexOf(key) + 1)) {
      expect(reads().filter((request) => request.pathname === sectionEndpoints[pending])).toHaveLength(0);
    }
    await section(page, key).locator(":scope > summary").click();
    await expect(section(page, key)).not.toHaveAttribute("open", "");
    await section(page, key).locator(":scope > summary").click();
    await expect(section(page, key).locator(".git-tools-body")).toBeVisible();
    expect(reads().filter((request) => request.pathname === pathname)).toHaveLength(1);
    await section(page, key).locator(":scope > summary").click();
  }
  expect(requests.filter((request) => request.pathname === "/api/git-reflog")).toHaveLength(1);
  await capture(page, testInfo, "project-git-lazy-sections");
  expect(reads().map((request) => request.pathname)).toEqual(Object.values(sectionEndpoints));
});

test("stash saves tracked and untracked changes with authoritative list and Changes refreshes", async ({ page, ownership, repository }, testInfo) => {
  const tabId = ownership.tabs[0].id;
  const head = repository.git("rev-parse", "HEAD");
  const pending = "pending tracked change\n";
  await writeFile(join(repository.cwd, "tracked.txt"), pending);
  await writeFile(join(repository.cwd, "untracked.txt"), "keep until explicitly included\n");
  await openProjectChanges(page, repository.cwd);
  await openSection(page, "stash", tabId);
  const requests = recordGitRequests(page);
  for (const [label, body, count] of [
    ["Stash tracked changes", {}, 2],
    ["Stash incl. untracked", { includeUntracked: true }, 3],
  ]) {
    const saved = waitForApi(page, "/api/git-stash/save", "POST");
    const refreshed = waitForApi(page, "/api/git-stash");
    const changes = waitForApi(page, "/api/git-changes");
    await section(page, "stash").getByRole("button", { name: label, exact: true }).click();
    expect((await expectApi(saved, tabId, body)).root).toBe(repository.cwd);
    const data = await expectApi(refreshed, tabId);
    expect(data.root).toBe(repository.cwd);
    expect(data.stashes).toHaveLength(count);
    expect((await expectApi(changes, tabId)).root).toBe(repository.cwd);
    await expect(section(page, "stash").locator(".git-tools-item")).toHaveCount(count);
    await expect(page.locator("#gitChangesStatus")).toContainText(body.includeUntracked ? "Stashed tracked and untracked changes." : "Stashed tracked changes.");
    expect(repository.git("stash", "list", "--format=%gd").split("\n")).toHaveLength(count);
    expect(await readFile(join(repository.cwd, "tracked.txt"), "utf8")).toBe(baseline);
    if (!body.includeUntracked) {
      expect(repository.git("show", "stash@{0}:tracked.txt")).toBe(pending.trimEnd());
      expect(await readFile(join(repository.cwd, "untracked.txt"), "utf8")).toBe("keep until explicitly included\n");
      expect(repository.git("status", "--porcelain=v1")).toBe("?? untracked.txt");
    }
  }
  expect(repository.git("show", "stash@{0}^3:untracked.txt")).toBe("keep until explicitly included");
  expect(repository.git("status", "--porcelain=v1")).toBe("");
  expect(repository.git("rev-parse", "HEAD")).toBe(head);
  const paths = requests.map((request) => request.pathname);
  const firstSave = paths.indexOf("/api/git-stash/save");
  expect(paths.indexOf("/api/git-stash", firstSave + 1)).toBeGreaterThan(firstSave);
  expect(paths.indexOf("/api/git-changes", firstSave + 1)).toBeGreaterThan(firstSave);
  await capture(page, testInfo, "project-git-stash-saved");
});

for (const action of ["Apply", "Pop", "Drop"]) {
  test(`stash ${action.toLowerCase()} previews real contents and decline preserves the stash and files`, async ({ page, ownership, repository }, testInfo) => {
    const tabId = ownership.tabs[0].id;
    const before = repositorySnapshot(repository);
    const requests = recordGitRequests(page);
    await openProjectChanges(page, repository.cwd);
    await openSection(page, "stash", tabId);
    const item = section(page, "stash").locator(".git-tools-item");
    const previewResponse = waitForApi(page, "/api/git-stash/show");
    await item.locator(":scope > summary").click();
    const preview = await expectApi(previewResponse, tabId);
    expect(preview.ref).toBe("stash@{0}");
    expect(preview.stat).toContain("tracked.txt");
    await expect(item.locator("pre")).toContainText("-committed fixture line");
    await expect(item.locator("pre")).toContainText("+stashed fixture line");
    const confirmationPreview = waitForApi(page, "/api/git-stash/show");
    await item.getByRole("button", { name: action, exact: true }).click();
    await expectApi(confirmationPreview, tabId);
    await expect(page.locator("#confirmationDialog")).toBeVisible();
    await expect(page.locator("#confirmationTitle")).toContainText(`${action} stash@{0}`);
    await expect(page.locator("#confirmationSummary")).toContainText("T1 preview seed");
    await expect(page.locator("#confirmationSummary")).toContainText(preview.stat.trim());
    await capture(page, testInfo, `project-git-${action.toLowerCase()}-decline-preview`);
    await page.locator("#confirmationCancelButton").click();
    await expect(page.locator("#confirmationDialog")).toBeHidden();
    expect(requests.filter((request) => request.method === "POST")).toEqual([]);
    expect(repositorySnapshot(repository)).toEqual(before);
    expect(await readFile(join(repository.cwd, "tracked.txt"), "utf8")).toBe(baseline);
    const authoritative = await ownership.api(`/api/git-stash?tab=${encodeURIComponent(tabId)}`);
    expect(authoritative.stashes).toHaveLength(1);
    expect(authoritative.stashes[0].subject).toContain("T1 preview seed");
    await expect(item).toHaveCount(1);
  });
}

test("cancelling the tag name prompt leaves refs and files unchanged", async ({ page, ownership, repository }) => {
  const tabId = ownership.tabs[0].id;
  const before = repositorySnapshot(repository);
  const requests = recordGitRequests(page);
  await openProjectChanges(page, repository.cwd);
  await openSection(page, "tags", tabId);
  const createTag = section(page, "tags").getByRole("button", { name: "Create annotated tag…", exact: true });
  await createTag.click();
  await expect(page.locator("#textPromptTitle")).toHaveText("Create annotated tag");
  await page.locator("#textPromptInput").fill("v-t1-cancelled-name");
  await page.locator("#textPromptCancelButton").click();
  await expect(page.locator("#textPromptDialog")).toBeHidden();
  await expect(page.locator("#confirmationDialog")).toBeHidden();
  expect(requests.filter((request) => request.method === "POST")).toEqual([]);
  expect(repositorySnapshot(repository)).toEqual(before);
  expect(await readFile(join(repository.cwd, "tracked.txt"), "utf8")).toBe(baseline);
  expect((await ownership.api(`/api/git-tags?tab=${encodeURIComponent(tabId)}`)).tags).toEqual([]);
});

test("the tag message prompt stays open and cancellation creates no tag", async ({ page, ownership, repository }, testInfo) => {
  const tabId = ownership.tabs[0].id;
  const before = repositorySnapshot(repository);
  const requests = recordGitRequests(page);
  await openProjectChanges(page, repository.cwd);
  await openSection(page, "tags", tabId);
  await section(page, "tags").getByRole("button", { name: "Create annotated tag…", exact: true }).click();
  await page.locator("#textPromptInput").fill("v-t1-cancelled-message");
  await page.locator("#textPromptConfirmButton").click();
  await expect(page.locator("#textPromptTitle")).toHaveText("Tag message for v-t1-cancelled-message");
  expect(repositorySnapshot(repository)).toEqual(before);
  expect((await ownership.api(`/api/git-tags?tab=${encodeURIComponent(tabId)}`)).tags).toEqual([]);
  await capture(page, testInfo, "project-git-tag-message-prompt");
  await expect(page.locator("#textPromptDialog")).toBeVisible();
  await page.locator("#textPromptInput").fill("Do not create this tag");
  await page.locator("#textPromptCancelButton").click();
  await expect(page.locator("#textPromptDialog")).toBeHidden();
  await expect(page.locator("#confirmationDialog")).toBeHidden();
  expect(requests.filter((request) => request.method === "POST")).toEqual([]);
  expect(repositorySnapshot(repository)).toEqual(before);
  expect(await readFile(join(repository.cwd, "tracked.txt"), "utf8")).toBe(baseline);
  expect((await ownership.api(`/api/git-tags?tab=${encodeURIComponent(tabId)}`)).tags).toEqual([]);
});

test("cancelling amend preserves HEAD, reflog, stash and files", async ({ page, ownership, repository }, testInfo) => {
  const tabId = ownership.tabs[0].id;
  const before = repositorySnapshot(repository);
  const requests = recordGitRequests(page);
  await openProjectChanges(page, repository.cwd);
  const undo = await openSection(page, "undo", tabId);
  expect(undo.canAmendMessage).toBe(true);
  await section(page, "undo").getByRole("button", { name: "Amend last commit message", exact: true }).click();
  await expect(page.locator("#textPromptTitle")).toHaveText("Amend last commit message");
  await expect(page.locator("#textPromptInput")).toHaveValue("T1 initial commit");
  await page.locator("#textPromptInput").fill("Do not amend this commit");
  await capture(page, testInfo, "project-git-amend-cancel");
  await page.locator("#textPromptCancelButton").click();
  await expect(page.locator("#textPromptDialog")).toBeHidden();
  await expect(page.locator("#confirmationDialog")).toBeHidden();
  expect(requests.filter((request) => request.method === "POST")).toEqual([]);
  expect(repositorySnapshot(repository)).toEqual(before);
  expect(await readFile(join(repository.cwd, "tracked.txt"), "utf8")).toBe(baseline);
  expect((await ownership.api(`/api/git-undo?tab=${encodeURIComponent(tabId)}`)).lastCommit).toEqual(undo.lastCommit);
});

test("a delayed source stash preview cannot mutate the replacement tab after its dialog closes", async ({ page, ownership, repository }, testInfo) => {
  const [source, peer] = ownership.tabs;
  const before = repositorySnapshot(repository);
  const requests = recordGitRequests(page);
  await openProjectChanges(page, repository.cwd);
  await openSection(page, "stash", source.id);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reportHeld;
  const previewHeld = new Promise((resolve) => { reportHeld = resolve; });
  let reportFinished;
  const previewFinished = new Promise((resolve) => { reportFinished = resolve; });
  await page.route("**/api/git-stash/show?*", async (route) => {
    try {
      const response = await route.fetch();
      expect(new URL(route.request().url()).searchParams.get("tab")).toBe(source.id);
      reportHeld();
      await held;
      await route.fulfill({ response });
    } finally {
      reportFinished();
    }
  });
  try {
    await section(page, "stash").getByRole("button", { name: "Apply", exact: true }).click();
    await previewHeld;
    await page.locator("#gitChangesCloseButton").click();
    const peerButton = page.locator(`#tabBar [data-tab-id="${peer.id}"] .terminal-tab-button`);
    await peerButton.click();
    await expect(peerButton).toHaveAttribute("aria-selected", "true");
    const replacement = waitForApi(page, "/api/git-changes");
    await openCurrentTabChangesFromTools(page);
    await expectApi(replacement, peer.id);
    const delayed = waitForApi(page, "/api/git-stash/show");
    release();
    await expectApi(delayed, source.id);
    await previewFinished;
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    // A retained confirmation is safe only if accepting it cannot authorize the old action for the new owner.
    if (await page.locator("#confirmationDialog").isVisible()) {
      await expect(page.locator("#confirmationTitle")).toContainText("Apply stash@{0}");
      await capture(page, testInfo, "project-git-delayed-source-confirmation");
      const mutation = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/git-stash/apply" && response.request().method() === "POST", { timeout: 1_000 }).catch((error) => {
        if (error.name === "TimeoutError") return null;
        throw error;
      });
      await page.locator("#confirmationConfirmButton").click();
      await expect(page.locator("#confirmationDialog")).toBeHidden();
      const response = await mutation;
      if (response) {
        await response.finished();
        await testInfo.attach("unexpected delayed mutation", { body: JSON.stringify({ url: response.url(), payload: await response.json() }, null, 2), contentType: "application/json" });
      }
    }
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await capture(page, testInfo, "project-git-delayed-preview-replacement");
    expect.soft(requests.filter((request) => request.method === "POST"), "A retired dialog must not start a Git mutation for either tab").toEqual([]);
    expect.soft(repositorySnapshot(repository)).toEqual(before);
    expect.soft(await readFile(join(repository.cwd, "tracked.txt"), "utf8")).toBe(baseline);
    expect((await ownership.api(`/api/git-stash?tab=${encodeURIComponent(peer.id)}`)).stashes).toHaveLength(1);
    await expect(peerButton).toHaveAttribute("aria-selected", "true");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
