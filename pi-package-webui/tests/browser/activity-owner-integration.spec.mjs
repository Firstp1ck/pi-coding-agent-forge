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
