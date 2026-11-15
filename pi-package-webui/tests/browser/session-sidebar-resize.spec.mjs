import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 900 } });
const key = 'pi-webui-shell-preferences-v1';
async function ready(page, ownership) {
  await page.addInitScript(key => {
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ v: 1, desktopLayout: 'focused' }));
  }, key);
  await page.goto(ownership.baseURL);
  await expect(page.getByRole('separator', { name: 'Resize session sidebar' })).toBeVisible();
  await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
}
const savedWidth = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)).navigationWidth, key);
const actualWidth = page => page.locator('#focusedWorkspaceNavigation').evaluate(node => Math.round(node.getBoundingClientRect().width));
async function dragStart(page, handle, delta) {
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 8 });
}

test('drag saves once on release, survives reload and preserves the draft', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  await page.locator('#promptInput').fill('Keep my sidebar draft');
  const handle = page.getByRole('separator', { name: 'Resize session sidebar' });
  await expect.poll(() => actualWidth(page)).toBe(202);
  await dragStart(page, handle, 100);
  await expect.poll(() => actualWidth(page)).toBe(302);
  expect(await savedWidth(page)).toBeUndefined();
  await page.mouse.up();
  await expect.poll(() => savedWidth(page)).toBe(302);
  await expect(page.locator('#promptInput')).toHaveValue('Keep my sidebar draft');
  await page.screenshot({ path: info.outputPath('resized-session-sidebar.png') });
  await page.reload();
  await expect.poll(() => actualWidth(page)).toBe(302);
  await expect(handle).toHaveAttribute('aria-valuenow', '302');
  await handle.dblclick();
  await expect.poll(() => savedWidth(page)).toBe(202);
});

test('keyboard limits, canceled drag and viewport clamps retain the preferred width', async ({ page, ownership }) => {
  await ready(page, ownership);
  const handle = page.getByRole('separator', { name: 'Resize session sidebar' });
  await handle.focus();
  await handle.press('ArrowRight');
  await expect.poll(() => savedWidth(page)).toBe(212);
  await handle.press('Shift+ArrowRight');
  await expect.poll(() => savedWidth(page)).toBe(262);
  await dragStart(page, handle, 100);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => actualWidth(page)).toBe(262);
  expect(await savedWidth(page)).toBe(262);
  await handle.press('Home');
  await expect.poll(() => savedWidth(page)).toBe(180);
  await handle.press('End');
  await expect.poll(() => savedWidth(page)).toBe(420);
  await page.locator('#focusedWorkspace').evaluate(node => { node.style.width = '900px'; });
  await expect.poll(() => actualWidth(page)).toBe(374);
  expect(await savedWidth(page)).toBe(420);
  await page.locator('#focusedWorkspace').evaluate(node => node.style.removeProperty('width'));
  await expect.poll(() => actualWidth(page)).toBe(420);
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(handle).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(() => actualWidth(page)).toBe(420);
  await page.getByRole('button', { name: 'Collapse sessions', exact: true }).click();
  await expect(handle).toBeHidden();
  await page.getByRole('button', { name: 'Expand sessions', exact: true }).click();
  await expect.poll(() => actualWidth(page)).toBe(420);
});

test('failed preference writes restore the prior width', async ({ page, ownership }) => {
  await ready(page, ownership);
  await page.evaluate(key => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(name, value) {
      if (name === key) throw new DOMException('Fixture quota', 'QuotaExceededError');
      return original.call(this, name, value);
    };
  }, key);
  const handle = page.getByRole('separator', { name: 'Resize session sidebar' });
  await dragStart(page, handle, 80);
  await page.mouse.up();
  await expect.poll(() => actualWidth(page)).toBe(202);
  expect(await savedWidth(page)).toBeUndefined();
});


test('top navigation and Classic restore the saved sidebar width', async ({ page, ownership }) => {
  await ready(page, ownership);
  const handle = page.getByRole('separator', { name: 'Resize session sidebar' });
  await handle.focus();
  await handle.press('Shift+ArrowRight');
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#focusedNavigationSelect').selectOption('top');
  await expect(handle).toBeHidden();
  await page.locator('#focusedNavigationSelect').selectOption('left');
  await expect.poll(() => actualWidth(page)).toBe(252);
  await page.locator('#desktopShellSelect').selectOption('classic');
  await expect(handle).toBeHidden();
  await page.evaluate(key => {
    const value = JSON.parse(localStorage.getItem(key));
    value.desktopLayout = 'focused';
    localStorage.setItem(key, JSON.stringify(value));
  }, key);
  await page.reload();
  await expect(handle).toBeVisible();
  await expect.poll(() => actualWidth(page)).toBe(252);
});
