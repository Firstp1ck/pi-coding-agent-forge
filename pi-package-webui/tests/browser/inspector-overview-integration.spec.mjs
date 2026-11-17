import { navigateFocused } from './focused-navigation-fixture.mjs';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const [width, height] of [[1440, 900], [1100, 500]]) {
  for (const theme of ['dark', 'light']) {
    test(`inspector tabs and floating overview at ${width}x${height} ${theme}`, async ({ page, ownership }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(theme => {
        if (!localStorage.getItem('pi-webui-shell-preferences-v1')) localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' }));
        localStorage.setItem('pi-webui-theme', theme === 'light' ? 'catppuccin-latte' : 'catppuccin-mocha');
      }, theme);
      await page.goto(ownership.baseURL);
      await expect(page.locator('#chat')).toContainText('fake answer');
      await page.locator('#promptInput').fill('Preserve this overview draft');
      const toggle = page.getByRole('button', { name: 'Overview', exact: true });
      const overview = page.getByRole('region', { name: 'Conversation overview', exact: true });
      await expect(overview).toBeHidden();
      await toggle.click();
      await expect(overview).toBeVisible();
      await expect(overview).toContainText(ownership.cwd || '/project');
      await expect(overview).toContainText('Not loaded');
      const bounds = await overview.boundingBox();
      const chat = await page.locator('#chat').boundingBox();
      expect(bounds.y).toBeGreaterThanOrEqual(chat.y);
      if (height === 900) expect(bounds.y + bounds.height).toBeLessThanOrEqual(chat.y + chat.height);
      const host = await page.locator('#focusedWorkspaceOverview').boundingBox();
      expect(host.y + host.height).toBeLessThanOrEqual(chat.y + chat.height);
      expect(await overview.locator('.conversation-overview-content').evaluate(node => node.scrollHeight <= node.clientHeight + 1)).toBe(true);
      await overview.getByRole('button', { name: 'Open Folder', exact: true }).click();
      const inspector = page.locator('#focusedWorkspaceInspector');
      await expect(inspector).toBeVisible();
      await expect(page.getByRole('combobox', { name: 'Project section' })).toHaveValue('files');
      await expect(page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: /^(Project|Activity)$/ })).toHaveCount(0);
      await expect(page.locator('.side-panel-expand-button').first()).toBeHidden();
      const destinations = page.getByRole('tablist', { name: 'Inspector destinations' });
      await destinations.getByRole('tab', { name: 'Activity' }).click();
      const section = page.getByRole('combobox', { name: 'Activity section' });
      await expect(section).toHaveValue('subagents');
      await expect(section).toHaveCSS('appearance', 'base-select');
      await section.click();
      await expect.poll(() => section.evaluate(node => node.matches(':open'))).toBe(true);
      await page.screenshot({ path: info.outputPath('inspector-section-menu.png') });
      await section.locator('option[value="queue"]').click();
      await expect(section).toHaveValue('queue');
      for (const value of ['session', 'sampling', 'commands', 'queue']) {
        await section.selectOption(value);
        await expect(section).toHaveValue(value);
        await expect(inspector).toBeVisible();
      }
      expect(await inspector.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath('overview-inspector.png') });
      await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
      await expect(inspector).toBeHidden();
      await page.getByRole('button', { name: 'Inspector', exact: true }).click();
      await expect(section).toHaveValue('queue');
      await page.getByRole('button', { name: 'Inspector', exact: true }).click();
      await overview.getByRole('button', { name: 'Close conversation overview' }).click();
      await expect(overview).toBeHidden();
      await expect(toggle).toBeFocused();
      await toggle.click();
      await overview.getByRole('button', { name: 'Close conversation overview' }).focus();
      await page.keyboard.press('Escape');
      await expect(overview).toBeHidden();
      await expect(toggle).toBeFocused();
      await expect(page.locator('#promptInput')).toHaveValue('Preserve this overview draft');
      await toggle.click();
      await navigateFocused(page, 'Settings');
      await expect(overview).toBeHidden();
      await toggle.click();
      await expect(overview).toBeVisible();
      await expect(page.locator('#promptInput')).toHaveValue('Preserve this overview draft');
      await page.reload();
      await expect(overview).toBeVisible();
    });
  }
}

test('overview follows the active session without ending background work', async ({ page, ownership }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', overviewOpen: true })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#chat')).toContainText('fake answer');
  const overview = page.getByRole('region', { name: 'Conversation overview', exact: true });
  await expect(overview.locator('.conversation-overview-title')).toHaveText('Thread 1');
  await page.locator('#promptInput').fill('First session draft');
  await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, {
    message: 'fixture continuity held stream', requestId: 'overview-stream-continuity',
  });
  await expect(page.locator('.focused-run-controls #abortButton')).toBeVisible();
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-button`).click();
  await expect(overview.locator('.conversation-overview-title')).toHaveText('Thread 2');
  await overview.getByRole('button', { name: 'Open Folder', exact: true }).click();
  await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
  expect((await ownership.api(`/api/state?tab=${ownership.tabs[0].id}`)).isStreaming).toBe(true);
  await overview.getByRole('button', { name: 'Close conversation overview' }).click();
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('First session draft');
  await expect(page.locator('.focused-run-controls #abortButton')).toBeVisible();
  await page.locator('.focused-run-controls #abortButton').press('Enter', { delay: 1400 });
  await expect.poll(async () => (await ownership.api(`/api/state?tab=${ownership.tabs[0].id}`)).isStreaming).toBe(false);
});
