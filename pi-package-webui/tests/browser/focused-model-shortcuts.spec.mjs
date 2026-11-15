import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
const models = [
  { provider: 'fake', id: 'fake-model', name: 'Fake Model' },
  { provider: 'fake', id: 'second-model', name: 'Second Model' },
];

for (const layout of ['flat', 'advanced']) {
  test('focused model shortcuts retain ' + layout + ' picker and Classic recovery with footer access', async ({ page, ownership }, testInfo) => {
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
    await expect(page.locator('#statusBar .footer-model, #statusBar .footer-tui-model')).toBeVisible();
    await expect(page.locator('.focused-composer-controls').getByRole('button', { name: /^Model:/ })).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'Scoped models', exact: true })).toBeFocused();
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

for (const width of [1100, 1440]) {
  test(`composer opens provider-scoped models directly at ${width}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' }));
      localStorage.setItem('pi-webui-footer-scoped-model-layout-v1', 'advanced');
    });
    await page.route('**/api/scoped-models*', route => route.fulfill({ json: { ok: true, data: {
      models: [models[0], { provider: 'fake', id: 'fake-model-alt', name: 'Fake Alternate Model' },
        { provider: 'other', id: 'other-model', name: 'Other Model' }], patterns: ['*'], source: 'fixture', rpcRunning: true,
    } } }));
    await page.goto(ownership.baseURL);
    await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
    await page.locator('#promptInput').fill('Keep my scoped model draft');
    const trigger = page.getByRole('button', { name: 'Scoped models', exact: true });
    await trigger.click();
    const picker = page.getByRole('listbox', { name: 'Scoped models by provider', exact: true });
    await expect(picker).toBeVisible();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(picker.locator('.footer-model-provider-column')).toHaveCount(2);
    const current = picker.locator('[data-footer-model-key="fake/fake-model"]');
    const alternate = picker.locator('[data-footer-model-key="fake/fake-model-alt"]');
    await expect(current).toBeFocused();
    await current.press('ArrowDown');
    await expect(alternate).toBeFocused();
    await alternate.press('Alt+ArrowUp');
    await expect.poll(() => picker.locator('[data-footer-provider="fake"] .footer-model-option').first().getAttribute('data-footer-model-key')).toBe('fake/fake-model-alt');
    await expect(alternate).toBeFocused();
    await expect(page.getByText('no queued messages to restore', { exact: true })).toHaveCount(0);
    await expect(page.locator('#promptInput')).toHaveValue('Keep my scoped model draft');
    await page.screenshot({ path: info.outputPath('composer-scoped-models.png') });
    await alternate.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    const footerTrigger = page.locator('#statusBar .footer-model.footer-meta-action, #statusBar .footer-tui-model');
    await footerTrigger.click();
    await expect(picker).toBeVisible();
    await expect(current).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(footerTrigger).toBeFocused();
    await expect(page.locator('#promptInput')).toHaveValue('Keep my scoped model draft');
    await trigger.press('Enter');
    await expect(picker).toBeVisible();
    const applied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/model' && response.request().method() === 'POST');
    await alternate.click();
    expect(new URL((await applied).url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
    await expect.poll(async () => (await ownership.api('/api/state?tab=' + ownership.tabs[0].id)).model.id).toBe('fake-model-alt');
    await expect(page.locator('#promptInput')).toHaveValue('Keep my scoped model draft');
    await page.locator('.focused-composer-controls').getByRole('button', { name: /^Model:/ }).click();
    await expect(page.locator('#nativeCommandTitle')).toHaveText('Choose model');
  });
}
