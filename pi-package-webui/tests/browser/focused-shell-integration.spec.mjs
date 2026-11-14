import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
test.setTimeout(45_000);

async function openFocused(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
}

test('compact workspace retains real drafts, settings and inspector fields across history and rollback', async ({ page, ownership }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await openFocused(page, ownership);
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  const prompt = page.locator('#promptInput');
  await prompt.fill('retain this compact draft');
  await prompt.evaluate(node => { window.originalPrompt = node; node.setSelectionRange(2, 7, 'backward'); });
  await rail.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
  await page.locator('#fileTreeSearchInput').fill('keep filter');
  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#desktopShellSelect')).toBeVisible();
  await page.goBack();
  await expect(page.locator('#fileTreeSearchInput')).toHaveValue('keep filter');
  await rail.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(prompt).toHaveValue('retain this compact draft');
  expect(await prompt.evaluate(node => node === window.originalPrompt)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('compact-conversation.png') });
  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#desktopShellSelect').selectOption('classic');
  await expect(page.locator('#focusedWorkspace')).toBeHidden();
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue('retain this compact draft');
  await page.reload();
  await expect(page.locator('#focusedWorkspace')).toBeVisible(); // init script opts in again
  expect(errors).toEqual([]);
});

test('All tools opens real features, pins searches and retains canonical run controls', async ({ page, ownership }, testInfo) => {
  await openFocused(page, ownership);
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'All tools', exact: true }).click();
  const dialog = page.locator('#shellToolsLauncher');
  await expect(dialog).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('files');
  await dialog.getByRole('button', { name: 'Pin Files', exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-webui-shell-preferences-v1')).pinnedActions)).toContain('view:files');
  await dialog.getByRole('button', { name: 'Files', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('compact-project.png') });
});

test('desktop opt-in preserves independent phone mode and returns canonical composer', async ({ page, ownership }) => {
  await openFocused(page, ownership);
  await page.locator('#promptInput').fill('resize draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#focusedWorkspace')).toBeHidden();
  await expect(page.locator('#promptInput')).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#promptInput')).toHaveValue('resize draft');
  await page.goto(`${ownership.baseURL}/?shell=classic`);
  await expect(page.locator('#focusedWorkspace')).toBeHidden();
  await expect(page.locator('#promptInput')).toBeVisible();
});

test('running session can be aborted from Settings and All tools without changing its target', async ({ page, ownership }) => {
  await openFocused(page, ownership);
  await page.locator('#promptInput').fill('fixture transcript continuity dwell');
  await page.locator('#sendButton').click();
  await expect(page.locator('#abortButton')).toBeVisible();
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('.focused-run-controls #abortButton')).toBeVisible();
  await rail.getByRole('button', { name: 'All tools', exact: true }).click();
  await expect(page.locator('#shellToolsLauncher #abortButton')).toBeVisible();
  await page.locator('#shellToolsLauncher').getByRole('button', { name: 'Choose directory for new tab', exact: true }).click();
  await expect(page.locator('dialog:modal #abortButton')).toBeVisible();
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/abort' && response.request().method() === 'POST');
  await page.locator('#abortButton').hover();
  await page.mouse.down();
  await page.waitForTimeout(1500);
  await page.mouse.up();
  expect((await response).ok()).toBe(true);
  await page.keyboard.press('Escape');
  await rail.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#promptInput')).toBeVisible();
});

test('phone landscape keeps draft and attachment reachable with a constrained keyboard viewport', async ({ browser, ownership }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(`${ownership.baseURL}/?mobileShell=v2`);
    await expect(page.locator('#modelSelect')).not.toBeEmpty();
    await page.locator('#promptInput').fill('landscape retained draft');
    await page.locator('#attachmentInput').setInputFiles({ name: 'context.txt', mimeType: 'text/plain', buffer: Buffer.from('context') });
    await page.locator('#promptInput').focus();
    await page.setViewportSize({ width: 844, height: 220 });
    await expect(page.locator('body')).toHaveClass(/mobile-keyboard-open/);
    await page.screenshot({ path: testInfo.outputPath('phone-landscape-before-hit-check.png') });
    for (const selector of ['#promptInput', '#attachButton', '#sendButton', '#composerActionsButton']) await page.locator(selector).click({ trial: true, timeout: 2000 });
    await expect(page.locator('#promptInput')).toHaveValue('landscape retained draft');
    await expect(page.locator('#attachmentTray')).toContainText('context.txt');
    await page.screenshot({ path: testInfo.outputPath('phone-landscape-keyboard.png') });
  } finally { await context.close(); }
});

test('compact navigation remains usable at 1100 and 1920 pixels with top and collapsed choices', async ({ page, ownership }, testInfo) => {
  await openFocused(page, ownership);
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  const [source, peer] = ownership.tabs;
  await page.locator('#promptInput').fill('original session draft');
  await page.locator(`#tabBar [data-tab-id="${peer.id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('');
  await page.locator(`#tabBar [data-tab-id="${source.id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('original session draft');
  for (const width of [1100, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await rail.getByRole('button', { name: 'Project', exact: true }).click();
    await page.locator('#fileTreeSearchInput').click({ trial: true });
    await page.locator('#promptInput').click({ trial: true });
    await expect(page.locator('#tabBar [role="tab"]')).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath(`compact-project-${width}.png`) });
  }
  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#focusedNavigationSelect').selectOption('top');
  await rail.getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-navigation', 'top');
  await page.locator(`#tabBar [data-tab-id="${peer.id}"] .terminal-tab-button`).click();
  await rail.getByRole('button', { name: 'Collapse sessions', exact: true }).click();
  await expect(page.locator('#focusedWorkspaceNavigation')).toBeHidden();
  await rail.getByRole('button', { name: 'Expand sessions', exact: true }).click();
  await expect(page.locator('#focusedWorkspaceNavigation')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('compact-top-navigation.png') });
});
