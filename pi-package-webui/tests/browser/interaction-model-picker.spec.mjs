import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

async function ready(page, ownership, preferences = {}) {
  await page.addInitScript(preferences => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', ...preferences })), preferences);
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await page.locator('#promptInput').fill('Keep my draft');
}

async function openModel(page) {
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('/model');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: '/model', exact: true }).click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('Choose model');
  await expect(page.locator('#nativeCommandBody .native-selector-item')).toHaveCount(2);
}

test('legacy slash-command pins resolve to one canonical model action', async ({ page, ownership }) => {
  await ready(page, ownership, { pinnedActions: ['command:model', 'native:model'] });
  await page.keyboard.press('Control+k');
  await page.getByRole('navigation', { name: 'Tool categories' }).getByRole('button', { name: 'Pinned', exact: true }).click();
  await expect(page.locator('#shellToolsLauncher .tools-launcher-action')).toHaveCount(1);
  await expect(page.locator('#shellToolsLauncher .tools-launcher-action')).toHaveAccessibleName('/model');
});

test('model selection applies once to the originating session and preserves draft', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  await openModel(page);
  await page.screenshot({ path: info.outputPath('session-model-picker.png') });
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/model' && r.request().method() === 'POST');
  await page.locator('#nativeCommandDialog').getByRole('option', { name: /fake\/fake-model-alt/ }).click();
  const result = await response;
  expect(new URL(result.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  await expect.poll(async () => (await ownership.api('/api/state?tab=' + ownership.tabs[0].id)).model.id).toBe('fake-model-alt');
  await expect(page.locator('#promptInput')).toHaveValue('Keep my draft');
  await openModel(page);
  await expect(page.locator('#nativeCommandDialog').getByRole('option', { name: /fake\/fake-model-alt/ })).toContainText('current');
});

test('failed selection remains in place and can be retried', async ({ page, ownership }) => {
  let requests = 0;
  await page.route('**/api/model?*', route => {
    requests++;
    return requests === 1 ? route.fulfill({ status: 503, json: { ok: false, error: 'Fixture provider unavailable' } }) : route.continue();
  });
  await ready(page, ownership);
  await openModel(page);
  await page.locator('#nativeCommandDialog').getByRole('option', { name: /fake\/fake-model-alt/ }).click();
  await expect(page.locator('#nativeCommandError')).toContainText('Fixture provider unavailable');
  await expect(page.locator('#nativeCommandDialog')).toBeVisible();
  await page.locator('#nativeCommandDialog').getByRole('option', { name: /fake\/fake-model-alt/ }).click();
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  expect(requests).toBe(2);
  await expect(page.locator('#promptInput')).toHaveValue('Keep my draft');
});

test('late model catalog cannot replace a reopened picker', async ({ page, ownership }) => {
  let release;
  let entered;
  const held = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { entered = resolve; });
  await ready(page, ownership);
  let reads = 0;
  await page.route('**/api/models?*', async route => {
    if (++reads === 1) { entered(); await held; }
    await route.continue();
  });
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('/model');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: '/model', exact: true }).click();
  await requested;
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('/theme');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: '/theme', exact: true }).click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('/theme');
  release();
  await expect(page.locator('#nativeCommandBody .native-selector-item')).not.toHaveCount(0);
  await expect(page.locator('#nativeCommandTitle')).toHaveText('/theme');
  await expect(page.locator('#nativeCommandBody')).not.toContainText('Fake Alternate Model');
});
