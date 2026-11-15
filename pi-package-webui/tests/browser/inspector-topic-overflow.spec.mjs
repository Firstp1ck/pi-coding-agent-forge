import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const width of [1100, 1440]) {
  test(`inspector topic overflow has no scrollbar and remains reachable at ${width}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', inspectorWidth: 240 })));
    await page.goto(ownership.baseURL);
    await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
    await page.locator('#promptInput').fill('Keep this draft while inspecting');
    await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Project', exact: true }).click();
    const topics = page.getByRole('tablist', { name: 'Inspector topics' });
    await expect(topics).toBeVisible();
    await expect(topics).toHaveCSS('scrollbar-width', 'none');
    await expect.poll(() => topics.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await topics.hover();
    await page.mouse.wheel(500, 0);
    await expect.poll(() => topics.evaluate(node => node.scrollLeft)).toBeGreaterThan(0);
    const first = topics.getByRole('tab').first();
    const last = topics.getByRole('tab').last();
    await first.focus();
    await first.press('End');
    await expect(last).toBeFocused();
    const outer = await topics.boundingBox();
    const tab = await last.boundingBox();
    expect(tab.x + tab.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
    await last.press('Enter');
    await expect(last).toHaveAttribute('aria-selected', 'true');
    const inspector = page.locator('.focused-inspector-content');
    await expect(inspector.locator('.focused-artifact-empty')).toBeVisible();
    await expect.poll(() => inspector.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('documents-empty-no-scrollbar.png') });
    await last.press('Home');
    await expect(first).toBeFocused();
    await first.press('Enter');
    await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
    await expect(page.locator('#promptInput')).toHaveValue('Keep this draft while inspecting');
    await page.screenshot({ path: info.outputPath('inspector-tabs-no-scrollbar.png') });
  });
}
