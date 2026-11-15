import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const [width, height] of [[1440, 900], [1100, 500]]) {
  for (const theme of ['dark', 'light']) {
    test(`inspector tabs and floating overview at ${width}x${height} ${theme}`, async ({ page, ownership }, info) => {
      await page.setViewportSize({ width, height });
      await page.addInitScript(theme => {
        localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' }));
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
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(chat.y + chat.height);
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
      await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(overview).toBeHidden();
      await toggle.click();
      await expect(overview).toBeVisible();
      await expect(page.locator('#promptInput')).toHaveValue('Preserve this overview draft');
      await page.reload();
      await expect(overview).toBeVisible();
    });
  }
}
