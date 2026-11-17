import { navigateFocused } from './focused-navigation-fixture.mjs';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });

async function checkMenu(page) {
  const trigger = page.locator('#newTabButton');
  const dialog = page.locator('#newThreadDialog');
  const options = page.locator('#newThreadList [role="option"]');
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(page.locator('#newThreadInput')).toBeFocused();
  const viewport = page.viewportSize();
  const box = await dialog.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  const labels = await options.locator('.command-palette-item-label').allTextContents();
  expect(labels.slice(0, 2)).toEqual([expect.any(String), 'No project']);
  expect(labels.slice(-2)).toEqual(['Browse…', 'Branch worktree…']);
  for (const option of await options.all()) {
    await option.scrollIntoViewIfNeeded();
    await expect(option).toBeInViewport();
    await option.click({ trial: true });
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeVisible();
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#newThreadInput')).toHaveAttribute('aria-activedescendant', await options.nth(1).getAttribute('id'));
  await page.keyboard.press('End');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await expect(options.last()).toBeInViewport();
  await page.keyboard.press('Home');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
}

test('new tab choices stay reachable in focused navigation', async ({ page, ownership }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-close`).click();
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(1);
  await page.locator('#promptInput').fill('retained draft');
  await checkMenu(page);
  await page.locator('#newTabButton').click();
  await page.screenshot({ path: testInfo.outputPath('after.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#promptInput')).toHaveValue('retained draft');
  for (let index = 0; index < 10; index++) await ownership.api('/api/tabs', {});
  await page.reload();
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(11);
  await page.setViewportSize({ width: 1100, height: 450 });
  await checkMenu(page);
  await navigateFocused(page, 'Settings');
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
  const palette = page.locator('#newThreadList');
  await page.locator('#newTabButton').click();
  await palette.getByRole('option', { name: /Browse…/ }).click();
  await expect(page.locator('#pathPickerDialog')).toBeVisible();
  await page.locator('#pathPickerCancelButton').click();
  await expect(page.locator('dialog:modal')).toHaveCount(0);
  await page.locator('#newTabButton').click();
  await palette.getByRole('option', { name: /Branch worktree…/ }).click();
  await expect(page.getByRole('listbox', { name: 'Git branches and worktrees' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Git branches and worktrees' })).toBeHidden();
  await page.locator('#newTabButton').click();
  await palette.getByRole('option').first().click();
  await expect(page.locator('#emptyStartTitle')).toHaveText('Start a conversation');
  await expect(page.locator('.empty-start-workspace-button')).toHaveText(ownership.tabs[0].cwd);
  await expect(page.locator('#promptInput')).toHaveValue('');
  await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(2);
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
