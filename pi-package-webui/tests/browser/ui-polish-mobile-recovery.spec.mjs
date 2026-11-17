import { expect } from "@playwright/test";
import { test } from "./session-fixture.mjs";

test.use({ serviceWorkers: "block", video: "off", reducedMotion: "reduce", isMobile: true, hasTouch: true });

for (const width of [320, 390]) {
  test(`mobile send recovery remains clickable beneath an error notice at ${width}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${ownership.baseURL}/?mobileShell=v2`);
    await expect(page.locator("#chat")).toContainText("fake answer");
    const attempts = [];
    await page.route("**/api/prompt?*", async route => {
      attempts.push(route.request().postDataJSON());
      if (attempts.length === 1) await route.abort("failed");
      else await route.continue();
    });
    await page.locator("#promptInput").fill("Keep the failed request available for manual retry");
    await page.locator("#sendButton").click();
    await expect(page.locator("#mobileFailedSendRecovery")).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect(page.locator("#serverOfflinePanel")).toBeHidden();
    await expect(page.locator("#noticeToastStack .notice-toast.error").first()).toBeVisible();
    const retry = page.locator("#mobileFailedSendRetryButton");
    expect(await retry.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === node || node.contains(hit);
    })).toBe(true);
    expect(attempts).toHaveLength(1);
    await page.screenshot({ path: info.outputPath(`mobile-retry-notice-${width}.png`), animations: "disabled" });
    await retry.click();
    await expect(page.locator("#mobileFailedSendRecovery")).toBeHidden();
    expect(attempts).toHaveLength(2);
    expect(attempts[1].requestId).toBe(attempts[0].requestId);
  });
}
