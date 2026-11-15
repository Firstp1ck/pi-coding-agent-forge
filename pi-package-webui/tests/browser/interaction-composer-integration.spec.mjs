import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

async function ready(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
}

test('one busy submission matches Enter and changing behavior preserves the draft', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const input = page.locator('#promptInput');
  const send = page.locator('#sendButton');
  await expect(send).toHaveText('Send');
  await expect(page.getByLabel('During this run')).toBeHidden();
  await ownership.api('/api/prompt?tab=' + ownership.tabs[0].id, { message: 'fixture continuity held stream' });
  await expect(send).toHaveText('Queue message');
  await expect(page.locator('#steerButton')).toBeHidden();
  await expect(page.locator('#followUpButton')).toBeHidden();
  await expect(page.locator('#busyPromptBehaviorTag')).toBeHidden();
  // Hold the real fake-Pi stream while recording browser dispatch semantics. Its
  // generic prompt handler does not implement upstream busy-prompt delivery.
  await page.route('**/api/prompt?*', route => route.request().postDataJSON()?.streamingBehavior
    ? route.fulfill({ json: { ok: true, data: {} } }) : route.continue());
  await input.fill('Keep this correction');
  await page.getByLabel('During this run').selectOption('steer');
  await expect(send).toHaveText('Steer run');
  await expect(input).toHaveValue('Keep this correction');
  await page.screenshot({ path: info.outputPath('busy-composer.png') });
  const steering = page.waitForRequest(request => new URL(request.url()).pathname === '/api/prompt');
  await input.press('Enter');
  const request = await steering;
  expect(request.postDataJSON()).toMatchObject({ message: 'Keep this correction', streamingBehavior: 'steer', requestId: expect.any(String) });
  expect(new URL(request.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  await page.getByLabel('During this run').selectOption('followUp');
  await expect(send).toHaveText('Queue message');
  await input.fill('Do this afterward');
  const queued = page.waitForRequest(request => new URL(request.url()).pathname === '/api/prompt');
  await send.click();
  expect((await queued).postDataJSON()).toMatchObject({ message: 'Do this afterward', streamingBehavior: 'followUp', requestId: expect.any(String) });
  await expect(page.locator('#abortButton')).toBeVisible();
  await ownership.api('/api/abort?tab=' + ownership.tabs[0].id, {});
  await expect(send).toHaveText('Send');
});

test('effective model and effort controls open one-step pickers and restore focus', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const controls = page.getByRole('group', { name: 'Session composer controls' });
  const model = controls.getByRole('button', { name: /^Model:/ });
  const effort = controls.getByRole('button', { name: /^Effort:/ });
  await page.locator('#promptInput').fill('Retain this draft');
  await model.click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('Choose model');
  await page.keyboard.press('Escape');
  await expect(model).toBeFocused();
  await effort.click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('Choose thinking effort');
  await expect(page.locator('#nativeCommandMessage')).toContainText('next prompt');
  await page.keyboard.press('Escape');
  await expect(effort).toBeFocused();
  await expect(page.locator('#promptInput')).toHaveValue('Retain this draft');
  await page.screenshot({ path: info.outputPath('effective-composer.png') });
});

test('context menus are short and More actions searches the complete catalog', async ({ page, ownership }) => {
  await ready(page, ownership);
  await page.getByRole('button', { name: 'Project actions', exact: true }).click();
  const context = page.locator('#shellContextActions');
  await expect(context).toBeVisible();
  await expect(context.locator('.context-actions-action')).toHaveCount(6);
  await context.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(context).toBeHidden();
  const tools = page.locator('#shellToolsLauncher');
  await expect(tools).toBeVisible();
  await expect(tools.getByRole('navigation', { name: 'Tool categories' }).getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('/model');
  await expect(tools.getByRole('button', { name: '/model', exact: true })).toHaveCount(1);
  await page.keyboard.press('Escape');
  if (await tools.isVisible()) await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Project actions', exact: true })).toBeFocused();
  await page.keyboard.press('Control+k');
  await expect(tools).toBeVisible();
  await expect(tools.getByRole('navigation', { name: 'Tool categories' }).getByRole('button', { name: 'All', exact: true })).toHaveAttribute('aria-pressed', 'true');
});
