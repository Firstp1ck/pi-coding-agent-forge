import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

async function ready(page, ownership) {
  await page.addInitScript(() => {
    if (!localStorage.getItem('pi-webui-shell-preferences-v1')) localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' }));
  });
  await page.goto(ownership.baseURL);
  await expect(page.locator('#chat')).toContainText('fake answer');
}

test('inspector width persists, cancels after Tab, and leaves the draft intact', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  await page.locator('#promptInput').fill('Retain while resizing');
  await page.getByRole('button', { name: 'Inspector', exact: true }).click();
  const handle = page.getByRole('separator', { name: 'Resize inspector', exact: true });
  await expect(handle).toBeVisible();
  const start = await handle.boundingBox();
  await page.mouse.move(start.x + start.width / 2, start.y + 80);
  await page.mouse.down();
  await page.mouse.move(start.x - 80, start.y + 80, { steps: 5 });
  await page.mouse.up();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pi-webui-shell-preferences-v1')).inspectorWidth);
  expect(saved).toBeGreaterThan(380);
  await page.reload();
  await expect(handle).toHaveAttribute('aria-valuenow', String(saved));
  const beforeCancel = await handle.boundingBox();
  await page.mouse.move(beforeCancel.x + beforeCancel.width / 2, beforeCancel.y + 80);
  await page.mouse.down();
  await page.mouse.move(beforeCancel.x + 50, beforeCancel.y + 80);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(handle).toHaveAttribute('aria-valuenow', String(saved));
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-webui-shell-preferences-v1')).inspectorWidth)).toBe(saved);
  await expect(page.locator('#promptInput')).toHaveValue('Retain while resizing');
  await page.screenshot({ path: info.outputPath('resizable-inspector.png') });
});

test('Attention lives with lower rail actions and header keeps only contextual controls', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const header = page.locator('.focused-header');
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  await expect(header.getByRole('button', { name: 'All tools', exact: true })).toHaveCount(0);
  await expect(header.getByRole('button', { name: /^Attention/ })).toHaveCount(0);
  const attention = rail.getByRole('button', { name: /^Attention/ });
  await expect(attention).toBeVisible();
  const tools = rail.getByRole('button', { name: 'All tools', exact: true });
  expect((await attention.boundingBox()).y).toBeGreaterThan(700);
  expect((await attention.boundingBox()).y).toBeLessThan((await tools.boundingBox()).y);
  await attention.click();
  await expect(page.locator('#shellAttentionInbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(attention).toBeFocused();
  await page.screenshot({ path: info.outputPath('lower-rail-attention.png') });
});
