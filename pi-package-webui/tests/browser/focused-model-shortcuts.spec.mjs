import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
const models = [
  { provider: 'fake', id: 'fake-model', name: 'Fake Model' },
  { provider: 'fake', id: 'second-model', name: 'Second Model' },
];

for (const layout of ['flat', 'advanced']) {
  test('focused model shortcuts retain ' + layout + ' picker and Classic recovery without duplicate summaries', async ({ page, ownership }, testInfo) => {
    await page.addInitScript(layout => {
      localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' }));
      localStorage.setItem('pi-webui-footer-scoped-model-layout-v1', layout);
    }, layout);
    await page.route('**/api/scoped-models*', route => route.fulfill({
      json: { ok: true, data: { models, patterns: ['*'], source: 'fixture', rpcRunning: true } },
    }));
    await page.goto(ownership.baseURL);
    await expect(page.locator('#focusedWorkspace')).toBeVisible();
    await expect(page.locator('#modelSelect')).not.toBeEmpty();
    await expect(page.locator('#statusBar .footer-model, #statusBar .footer-tui-model')).toBeHidden();
    await expect(page.locator('.focused-composer-controls #modelSelect')).toBeVisible();
    const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await rail.getByRole('button', { name: 'All tools', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search all tools' }).fill('Model shortcuts');
    await page.locator('#shellToolsLauncher').getByRole('button', { name: 'Model shortcuts', exact: true }).click();
    const picker = page.locator('.footer-model-picker');
    await expect(picker).toBeVisible();
    await expect(picker.locator('[data-footer-model-key]')).toHaveCount(2);
    await expect(picker).toHaveAttribute('aria-label', layout === 'advanced' ? 'Scoped models by provider' : 'Scoped models');
    await expect(picker.locator('[data-footer-model-key]').first()).toBeFocused();
    const bounds = await picker.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440);
    await page.screenshot({ path: testInfo.outputPath('focused-model-' + layout + '.png') });
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(page.locator('#modelSearchInput')).toBeFocused();
    await rail.getByRole('button', { name: 'All tools', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search all tools' }).fill('model shortcuts');
    const nextLayout = layout === 'advanced' ? 'simple' : 'advanced';
    await page.locator('#shellToolsLauncher').getByRole('button', { name: 'Use ' + nextLayout + ' model shortcuts', exact: true }).click();
    await expect(picker).toHaveAttribute('aria-label', nextLayout === 'advanced' ? 'Scoped models by provider' : 'Scoped models');
    expect(await page.evaluate(() => localStorage.getItem('pi-webui-footer-scoped-model-layout-v1'))).toBe(nextLayout === 'simple' ? 'flat' : 'advanced');
    await page.keyboard.press('Escape');
    await page.goto(ownership.baseURL + '/?shell=classic');
    await expect(page.locator('#focusedWorkspace')).toBeHidden();
    await expect(page.locator('#statusBar .footer-model, #statusBar .footer-tui-model')).toBeVisible();
  });
}
