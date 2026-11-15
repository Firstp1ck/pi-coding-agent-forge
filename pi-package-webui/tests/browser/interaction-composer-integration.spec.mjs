import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

async function ready(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await expect(page.locator('#chat')).toContainText('fake answer');
  await expect(page.locator('#statusBar .footer-model.footer-meta-action, #statusBar .footer-tui-model')).toContainText('fake-model');
  await expect(page.locator('.focused-composer-controls')).toBeHidden();
}

test('one busy submission matches Enter and changing behavior preserves the draft', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const input = page.locator('#promptInput');
  const send = page.locator('#sendButton');
  await expect(send).toHaveText('Send');
  await expect(page.getByLabel('During this run')).toBeHidden();
  await ownership.api('/api/prompt?tab=' + ownership.tabs[0].id, { message: 'fixture continuity held stream' });
  await expect(send).toHaveText('Queue message');
  await expect(page.locator('.focused-composer-controls')).toBeVisible();
  await expect(page.getByLabel('During this run')).toBeVisible();
  for (const setting of await page.locator('.focused-composer-setting').all()) await expect(setting).toBeHidden();
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
  const queuedRequest = await queued;
  expect(queuedRequest.postDataJSON()).toMatchObject({ message: 'Do this afterward', streamingBehavior: 'followUp', requestId: expect.any(String) });
  expect(new URL(queuedRequest.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  await expect(page.locator('#abortButton')).toBeVisible();
  await ownership.api('/api/abort?tab=' + ownership.tabs[0].id, {});
  await expect(send).toHaveText('Send');
  await expect(page.locator('.focused-composer-controls')).toBeHidden();
});

async function assertFooterFocusSurvivesRefresh(page, trigger) {
  const previous = await trigger.elementHandle();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => previous.evaluate(node => node.isConnected)).toBe(false);
  await expect(trigger).toBeFocused();
}

test('footer scoped-model Escape restores focus and preserves the draft', async ({ page, ownership }) => {
  await ready(page, ownership);
  const model = page.locator('#statusBar .footer-model.footer-meta-action, #statusBar .footer-tui-model');
  const input = page.locator('#promptInput');
  await input.fill('Retain this draft');
  await model.click();
  const scoped = page.getByRole('listbox', { name: /Scoped models/ });
  await expect(scoped).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(scoped).toHaveCount(0);
  await expect(model).toBeFocused();
  await assertFooterFocusSurvivesRefresh(page, model);
  await expect(input).toHaveValue('Retain this draft');
});

test('footer effort Escape restores focus and preserves the draft', async ({ page, ownership }) => {
  await ready(page, ownership);
  const effort = page.locator('#statusBar .footer-thinking.footer-meta-action');
  const input = page.locator('#promptInput');
  await input.fill('Retain this draft');
  await effort.click();
  const thinking = page.getByRole('listbox', { name: 'Thinking effort', exact: true });
  await expect(thinking).toBeVisible();
  await expect(thinking.getByRole('option', { name: 'off', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(thinking).toHaveCount(0);
  await expect(effort).toBeFocused();
  await assertFooterFocusSurvivesRefresh(page, effort);
  await expect(input).toHaveValue('Retain this draft');
});

test('effective footer effort and all-model search preserve draft and exact target', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const model = page.locator('#statusBar .footer-model.footer-meta-action, #statusBar .footer-tui-model');
  const effort = page.locator('#statusBar .footer-thinking.footer-meta-action');
  const input = page.locator('#promptInput');
  await input.fill('Retain this draft');
  await effort.press('Enter');
  const thinking = page.getByRole('listbox', { name: 'Thinking effort', exact: true });
  await expect(thinking).toBeVisible();
  await expect(thinking.getByRole('option', { name: 'off', exact: true })).toHaveAttribute('aria-selected', 'true');
  const applied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/thinking' && response.request().method() === 'POST');
  await thinking.getByRole('option', { name: 'high', exact: true }).click();
  const response = await applied;
  expect(new URL(response.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  expect(response.request().postDataJSON()).toEqual({ level: 'high' });
  await expect(thinking).toHaveCount(0);
  await expect.poll(async () => (await ownership.api('/api/state?tab=' + ownership.tabs[0].id)).thinkingLevel).toBe('high');
  await expect(effort).toContainText('high');
  await effort.click();
  await expect(thinking.getByRole('option', { name: 'high', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(thinking.getByRole('option', { name: 'high', exact: true })).toBeFocused();
  await page.screenshot({ path: info.outputPath('effective-footer-effort.png') });
  await page.keyboard.press('Escape');
  await expect(effort).toBeFocused();
  await effort.press('Enter');
  await expect(thinking.getByRole('option', { name: 'high', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(effort).toBeFocused();

  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  const allTools = rail.getByRole('button', { name: 'All tools', exact: true });
  await allTools.click();
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('Thinking effort');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: 'Thinking effort', exact: true }).click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('Choose thinking effort');
  await expect(page.locator('#nativeCommandMessage')).toContainText('next prompt');
  await page.keyboard.press('Escape');
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  await expect(allTools).toBeFocused();
  await allTools.click();
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('/model');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: '/model', exact: true }).click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('Choose model');
  const search = page.locator('#nativeCommandSearch');
  await expect(search).toBeFocused();
  await search.fill('fake-model-alt');
  await expect(page.locator('#nativeSelectorList').getByRole('option')).toHaveCount(1);
  const modelApplied = page.waitForResponse(result => new URL(result.url()).pathname === '/api/model' && result.request().method() === 'POST');
  await search.press('Enter');
  const modelResponse = await modelApplied;
  expect(new URL(modelResponse.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  expect(modelResponse.request().postDataJSON()).toEqual({ provider: 'fake', modelId: 'fake-model-alt' });
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  await expect(allTools).toBeFocused();
  await expect.poll(async () => (await ownership.api('/api/state?tab=' + ownership.tabs[0].id)).model.id).toBe('fake-model-alt');
  await expect(model).toContainText('fake-model-alt');
  await expect(input).toHaveValue('Retain this draft');
  await expect(page.locator('.focused-composer-controls')).toBeHidden();
  await page.screenshot({ path: info.outputPath('effective-footer.png') });
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
