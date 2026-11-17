import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const height of [500, 900]) {
  test(`sidebar tooltips escape clipped navigation at ${height}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: 1100, height });
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
    await page.goto(ownership.baseURL);
    await expect(page.locator('#chat')).toContainText('fake answer');
    const tooltip = page.locator('#footerFloatingTooltip');
    for (const selector of ['#workspaceSaveButton', '#commandPaletteButton', '#workspaceDashboardToggleButton', '.terminal-settings-button']) {
      const button = page.locator(selector);
      await button.hover();
      await expect(tooltip).toBeVisible();
      expect(await tooltip.evaluate(node => node.matches(':popover-open'))).toBe(true);
      const bounds = await tooltip.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(8);
      expect(bounds.y).toBeGreaterThanOrEqual(8);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(1092);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height - 8);
      expect(await button.evaluate(node => getComputedStyle(node, '::after').display)).toBe('none');
      await page.keyboard.press('Escape');
      await expect(tooltip).toBeHidden();
    }
    await page.mouse.move(900, 100);
    await page.keyboard.press('Tab');
    await page.locator('#workspaceSaveButton').focus();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toHaveCSS('opacity', '1');
    await page.screenshot({ path: info.outputPath('sidebar-tooltip.png') });
    await page.keyboard.press('Escape');
    await expect(tooltip).toBeHidden();
    await expect(page.locator('#workspaceSaveButton')).toBeFocused();
  });
}
