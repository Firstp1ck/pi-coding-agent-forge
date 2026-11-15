import { expect } from "@playwright/test";
import { test } from "./session-fixture.mjs";

test.use({ video: "off", serviceWorkers: "block", viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
test.setTimeout(45_000);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pi-webui-shell-preferences-v1", JSON.stringify({ v: 1, desktopLayout: "focused" })));
});

async function openActivity(page, ownership, topic) {
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator("#modelSelect")).not.toBeEmpty();
  await page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: topic, exact: true }).click();
}

test("Usage topics retain canonical provider data and explicit refresh through Classic restoration", async ({ page, ownership }, testInfo) => {
  const requests = [];
  await page.route("**/api/codex-usage*", route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: { ok: true, data: { source: "codex-cli", planType: "plus", selected: { primary: { usedPercent: 23, windowMinutes: 300 } } } } });
  });
  await page.route("**/api/claude-usage*", route => route.fulfill({ json: { ok: true, data: { summary: "Fixture Claude account", windows: [{ id: "week", label: "Weekly", usedPercent: 41 }] } } }));
  await openActivity(page, ownership, "Codex usage");
  await expect(page.locator("#codexUsageBox")).toContainText("23%");
  await expect(page.locator("#codexUsageBox")).toContainText("Codex CLI account");
  await page.locator("#codexUsageBox").evaluate(node => { window.canonicalUsage = node; });
  const refresh = page.waitForResponse(response => new URL(response.url()).pathname === "/api/codex-usage" && new URL(response.url()).searchParams.get("refresh") === "1");
  await page.locator("#refreshCodexUsageButton").click();
  await refresh;
  expect(requests.every(url => !url.searchParams.has("tab"))).toBe(true);
  await page.getByRole("tab", { name: "Claude usage", exact: true }).click();
  await expect(page.locator("#claudeUsageBox")).toContainText("41%");
  await expect(page.locator("#claudeUsageBox")).toContainText("Fixture Claude account");
  await page.screenshot({ path: testInfo.outputPath("activity-usage.png") });
  await page.getByRole("navigation", { name: "Workspace destinations" }).getByRole("button", { name: "Settings", exact: true }).click();
  await page.locator("#desktopShellSelect").selectOption("classic");
  await page.locator("#sidePanelSectionToggleCodexUsage").click();
  await expect(page.locator("#codexUsageBox")).toBeVisible();
  expect(await page.locator("#codexUsageBox").evaluate(node => node === window.canonicalUsage)).toBe(true);
  await expect(page.locator("#codexUsageBox")).toContainText("23%");
});

test("Activity and composer conversations share the exact dialog and originating tab", async ({ page, ownership }, testInfo) => {
  const id = `conv_${"a".repeat(24)}`;
  const summary = { id, participants: { local: { id: "local", name: "Local" }, peer: { id: "peer", name: "Review agent" } }, messageCount: 1, lastMessageAt: "2026-11-15T00:00:00Z" };
  const detailTargets = [];
  await page.route("**/api/intercom/conversations*", route => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("conversation")) {
      detailTargets.push({ tab: url.searchParams.get("tab"), id: url.searchParams.get("conversation") });
      return route.fulfill({ json: { ok: true, data: { conversation: { ...summary, messages: [{ id: `msg_${"b".repeat(24)}`, direction: "peer", text: "Review notes stay in the original conversation.", timestamp: summary.lastMessageAt }] } } } });
    }
    return route.fulfill({ json: { ok: true, data: { conversations: url.searchParams.get("tab") === ownership.tabs[0].id ? [summary] : [] } } });
  });
  await openActivity(page, ownership, "Conversations");
  const link = page.locator('[data-feature-host="conversations"] button').filter({ hasText: "Review agent" });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator("#intercomConversationTranscript")).toContainText("Review notes stay");
  await page.locator("#intercomConversationDialog").evaluate(node => { window.canonicalConversation = node; });
  await page.keyboard.press("Escape");
  await expect(link).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath("activity-conversations.png") });
  const rail = page.getByRole("navigation", { name: "Workspace destinations" });
  await rail.getByRole("button", { name: "Conversation", exact: true }).click();
  await page.locator("#composerActionsButton").click();
  await page.locator(`#intercomConversationTags button[data-intercom-conversation-id="${id}"]`).first().click();
  await expect(page.locator("#intercomConversationTranscript")).toContainText("Review notes stay");
  expect(await page.locator("#intercomConversationDialog").evaluate(node => node === window.canonicalConversation)).toBe(true);
  await page.keyboard.press("Escape");
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-button`).click();
  await rail.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  await expect(link).toHaveCount(0);
  expect(detailTargets.length).toBeGreaterThanOrEqual(2);
  expect(detailTargets.every(target => target.tab === ownership.tabs[0].id && target.id === id)).toBe(true);
});

test("Agents output navigation preserves runs and explicit cancel and dismiss use their group", async ({ page, ownership }, testInfo) => {
  const tabId = ownership.tabs[0].id;
  await ownership.api(`/api/prompt?tab=${encodeURIComponent(tabId)}`, { message: "fixture subagents running", requestId: "w4-agent-actions" });
  const mutations = [];
  page.on("request", request => {
    if (request.method() === "POST" && /\/api\/subagents\/(cancel|dismiss)$/.test(new URL(request.url()).pathname)) mutations.push({ path: new URL(request.url()).pathname, body: request.postDataJSON() });
  });
  await openActivity(page, ownership, "Agents");
  await expect(page.locator("#subagentsBox .subagent-agent-row")).toHaveCount(2);
  await page.locator("#subagentsBox .subagent-agent-row").first().click();
  await expect(page.locator(".subagent-overlay-widget")).toBeVisible();
  await page.locator(".subagent-overlay-close-action").click();
  await expect(page.locator(".subagent-overlay-widget")).toHaveCount(0);
  const rail = page.getByRole("navigation", { name: "Workspace destinations" });
  await rail.getByRole("button", { name: "Settings", exact: true }).click();
  const before = await ownership.api("/api/subagents");
  expect(before.groups.flatMap(group => group.runs).find(run => run.id === "fixture-run").status).toBe("running");
  expect(mutations).toEqual([]);
  await rail.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Agents", exact: true }).click();
  await page.locator("#subagentsBox .subagent-agent-row").first().click();
  await page.locator(".subagent-overlay-cancel-action").click();
  await expect(page.locator("#subagentCancelDialogSubtitle")).toContainText("all 2 agents");
  await page.locator("#subagentCancelKeepRunningButton").click();
  expect(mutations).toEqual([]);
  await page.locator(".subagent-overlay-cancel-action").click();
  await page.locator("#subagentCancelReason").selectOption("Output no longer needed");
  await page.locator("#subagentCancelNote").fill("Reviewed from Activity");
  await page.screenshot({ path: testInfo.outputPath("activity-agent-cancel.png") });
  const cancelled = page.waitForResponse(response => new URL(response.url()).pathname === "/api/subagents/cancel");
  await page.locator("#subagentCancelSubmitButton").click();
  expect((await cancelled).ok()).toBe(true);
  await expect(page.locator("#subagentCancelDialog")).not.toBeVisible();
  expect(mutations[0]).toMatchObject({ path: "/api/subagents/cancel", body: { group: `tab:${tabId}`, runId: "fixture-run", reason: "Output no longer needed", note: "Reviewed from Activity" } });
  await expect(page.getByRole("button", { name: "Dismiss finished run", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Dismiss finished run", exact: true }).click();
  await expect.poll(async () => (await ownership.api("/api/subagents")).groups.flatMap(group => group.runs).some(run => run.id === "fixture-run")).toBe(false);
  expect(mutations[1]).toMatchObject({ path: "/api/subagents/dismiss", body: { group: `tab:${tabId}`, runId: "fixture-run" } });
});

test("Queues share authoritative edits, reorder, and removal across Activity and composer", async ({ page, ownership }, testInfo) => {
  const tabId = ownership.tabs[0].id;
  await openActivity(page, ownership, "Queues");
  await ownership.api(`/api/queue/mutate?tab=${encodeURIComponent(tabId)}`, {
    source: "pi-runtime", kind: "followUp",
    expected: { steering: ["runtime steering"], followUp: ["runtime first", "runtime second", "runtime third"] },
    operation: { type: "edit", index: 0, expectedText: "runtime first", text: "runtime first" },
  });
  await expect(page.locator("#queueBox")).toContainText("runtime first");
  const requests = [];
  page.on("request", request => {
    if (new URL(request.url()).pathname === "/api/queue/mutate") requests.push(request);
  });
  const rail = page.getByRole("navigation", { name: "Workspace destinations" });
  await rail.getByRole("button", { name: "Conversation", exact: true }).click();
  await page.locator("#followUpQueueTrigger").click();
  const first = page.getByRole("textbox", { name: "Queued follow-up 1", exact: true });
  await first.fill("edited first");
  await first.press("Control+Enter");
  await expect(page.locator("#followUpQueueStatus")).toContainText("Saved queued follow-up 1");
  await page.getByRole("button", { name: "Move queued follow-up 1 down", exact: true }).click();
  await expect(first).toHaveValue("runtime second");
  await expect(page.getByRole("textbox", { name: "Queued follow-up 2", exact: true })).toHaveValue("edited first");
  await page.screenshot({ path: testInfo.outputPath("activity-queue-edits.png") });
  await page.keyboard.press("Escape");
  await rail.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("tab", { name: "Queues", exact: true }).click();
  await expect(page.locator("#queueBox")).toContainText("edited first");
  await page.locator("#queueBox").getByRole("button", { name: "Remove queued follow-up #2", exact: true }).click();
  await expect(page.locator("#queueBox")).not.toContainText("edited first");
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-button`).click();
  await expect(page.locator("#queueBox")).toContainText("No queued messages");
  await page.locator(`#tabBar [data-tab-id="${tabId}"] .terminal-tab-button`).click();
  await expect(page.locator("#queueBox")).toContainText("runtime third");
  expect(requests.map(request => request.postDataJSON().operation.type)).toEqual(["edit", "move", "delete"]);
  expect(requests.every(request => new URL(request.url()).searchParams.get("tab") === tabId)).toBe(true);
});
