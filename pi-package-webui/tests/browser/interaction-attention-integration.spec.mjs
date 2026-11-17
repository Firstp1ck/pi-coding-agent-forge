import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

async function ready(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
  await page.locator('#promptInput').fill('Foreground draft');
}

test('inbox opens the originating background approval without replacing the foreground draft', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const background = ownership.tabs[1];
  await ownership.api('/api/prompt?tab=' + background.id, { message: 'fixture mobile blocker', requestId: 'inbox-approval-12345678' });
  const inboxButton = page.locator('.focused-inbox-button');
  await expect(inboxButton).toHaveAccessibleName(/1 decisions waiting/, { timeout: 16_000 });
  await expect(page.locator('#extensionDialog')).toBeHidden();
  await inboxButton.click();
  const inbox = page.locator('#shellAttentionInbox');
  await expect(inbox).toBeVisible();
  await expect(inbox.getByRole('region', { name: 'Needs your decision' }).locator('.attention-inbox-item')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath('background-decision.png') });
  await inbox.locator('.attention-inbox-item').click();
  await expect(inbox).toBeHidden();
  await expect(page.locator('#extensionDialog')).toBeVisible();
  await expect(page.locator('#dialogTitle')).toHaveText('Fixture blocker');
  const response = page.waitForRequest(request => new URL(request.url()).pathname === '/api/extension-ui-response');
  await page.locator('#extensionDialog').getByRole('button', { name: 'Yes', exact: true }).click();
  const request = await response;
  expect(new URL(request.url()).searchParams.get('tab')).toBe(background.id);
  expect(request.postDataJSON()).toMatchObject({ id: 'fixture_blocker_12345678', confirmed: true });
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('Foreground draft');
});

test('viewing the inbox keeps finished work unread until its conversation is opened', async ({ page, ownership }) => {
  await ready(page, ownership);
  const background = ownership.tabs[1];
  await ownership.api('/api/prompt?tab=' + background.id, { message: 'fixture continuity delayed stream', requestId: 'inbox-finished-12345678' });
  const inboxButton = page.locator('.focused-inbox-button');
  await expect(inboxButton).toHaveAccessibleName(/0 decisions waiting, 1 finished/, { timeout: 16_000 });
  await inboxButton.click();
  const inbox = page.locator('#shellAttentionInbox');
  await expect(inbox.getByRole('region', { name: 'Finished', exact: true }).locator('.attention-inbox-item')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(inboxButton).toBeFocused();
  await expect(inboxButton).toHaveAccessibleName(/0 decisions waiting, 1 finished/);
  await inboxButton.click();
  await inbox.getByRole('region', { name: 'Finished', exact: true }).locator('.attention-inbox-item').click();
  await expect(inboxButton).toHaveAccessibleName(/0 decisions waiting, 0 finished/);
});
