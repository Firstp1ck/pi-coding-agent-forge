import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });

async function checkMenu(page) {
  const trigger = page.locator('#newTabButton');
  await trigger.scrollIntoViewIfNeeded();
  await trigger.hover();
  for (const id of ['newTabNoProjectButton', 'newTabCurrentDirectoryButton', 'newTabChooseDirectoryButton', 'newTabWorktreeButton']) {
    const item = page.locator(`#${id}`);
    await expect(item).toBeInViewport({ ratio: 1 });
    await item.click({ trial: true });
  }
  await trigger.focus();
  await trigger.press('ArrowDown');
  await expect(page.locator('#newTabNoProjectButton')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#newTabCurrentDirectoryButton')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#newTabChooseDirectoryButton')).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.locator('#newTabWorktreeButton')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.locator('#newTabMenuPanel')).toBeHidden();
}

test('new tab choices stay reachable in focused navigation', async ({ page, ownership }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-close`).click();
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(1);
  await page.locator('#promptInput').fill('retained draft');
  const oldPlacement = await page.addStyleTag({ content: '#focusedWorkspace .terminal-new-tab-menu .composer-publish-menu-panel { position: absolute; inset: auto 0 100%; width: 100%; min-width: 0; padding-bottom: .38rem; overflow: visible; }' });
  await page.locator('#newTabButton').hover();
  expect((await page.locator('#newTabCurrentDirectoryButton').boundingBox()).y).toBeLessThan(0);
  await page.screenshot({ path: testInfo.outputPath('before-one-tab.png') });
  await oldPlacement.evaluate(node => node.remove());
  await page.mouse.move(500, 300);
  await checkMenu(page);
  await page.locator('#newTabButton').hover();
  await page.screenshot({ path: testInfo.outputPath('after.png') });
  await page.mouse.move(500, 300);
  await expect(page.locator('#promptInput')).toHaveValue('retained draft');
  for (let index = 0; index < 10; index++) await ownership.api('/api/tabs', {});
  await page.reload();
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(11);
  await page.setViewportSize({ width: 1100, height: 450 });
  await checkMenu(page);
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#focusedNavigationSelect').selectOption('top');
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-navigation', 'top');
  await checkMenu(page);
  await page.setViewportSize({ width: 1100, height: 220 });
  await checkMenu(page);
});

test('new tab actions open their intended destinations and keep the draft', async ({ page, ownership }) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await page.locator('#promptInput').fill('source draft');
  await page.locator('#newTabButton').click();
  await page.locator('#newTabChooseDirectoryButton').click();
  await expect(page.locator('dialog:modal')).toBeVisible();
  await page.locator('#pathPickerCancelButton').click();
  await expect(page.locator('dialog:modal')).toBeHidden();
  await page.locator('#newTabButton').click();
  await page.locator('#newTabWorktreeButton').click();
  await expect(page.getByRole('listbox', { name: 'Git branches and worktrees' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Git branches and worktrees' })).toBeHidden();
  await page.locator('#newTabButton').click();
  await page.locator('#newTabCurrentDirectoryButton').click();
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(3);
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('source draft');
});

test('tools categories, unpinning and attachment lifetimes remain usable', async ({ page, ownership }) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'All tools', exact: true }).click();
  const categories = page.getByRole('navigation', { name: 'Tool categories' }).getByRole('button');
  const names = await categories.allTextContents();
  expect(names.length).toBeGreaterThan(2);
  for (const name of names) {
    await page.getByRole('navigation', { name: 'Tool categories' }).getByRole('button', { name: name.trim(), exact: true }).click();
  }
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('Search transcript');
  await page.getByRole('button', { name: 'Pin Search transcript', exact: true }).click();
  await page.getByRole('button', { name: 'Unpin Search transcript', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-webui-shell-preferences-v1')).pinnedActions || [])).not.toContain('conversation:search');
  await page.keyboard.press('Escape');
  await page.locator('#attachmentInput').setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('fixture') });
  await expect(page.locator('#attachmentTray')).toContainText('note.txt');
  await page.locator('.attachment-remove-button').click();
  await expect(page.locator('#attachmentTray')).toBeHidden();
  await page.locator('#promptInput').evaluate(node => {
    const clipboard = new DataTransfer();
    clipboard.items.add(new File(['paste fixture'], 'pasted.txt', { type: 'text/plain' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#attachmentTray')).toContainText('pasted.txt');
  await page.locator('.attachment-remove-button').click();
  await expect(page.locator('#attachmentTray')).toBeHidden();
});
