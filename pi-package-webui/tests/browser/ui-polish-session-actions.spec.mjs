import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce', launchOptions: { executablePath: '/usr/bin/chromium' } });
test.setTimeout(45000);

async function ready(page, ownership, extra = '') {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}${extra}`);
  await expect(page.locator('#promptInput')).toBeVisible();
  await expect(page.locator('#chat')).toContainText('fake answer');
  await page.locator('#promptInput').fill('original draft');
}
async function sessionMenu(page, item) {
  if (!await page.locator('#optionsMenuButton').isVisible()) await page.locator('#composerActionsButton').click();
  await page.locator('#optionsMenuButton').click();
  await page.locator('#optionsSessionSubmenuButton').focus();
  await page.locator('#optionsSessionSubmenuButton').press('ArrowRight');
  await page.locator(item).click();
}
async function preserve(page, ownership) {
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('original draft');
}

test('directory picker Escape closes and restores focus', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  await page.locator('#newTabButton').click();
  await page.locator('#newTabChooseDirectoryButton').click();
  await expect(page.locator('#pathPickerDialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#pathPickerDialog')).toBeHidden();
  await expect(page.locator('#newTabButton')).toBeFocused();
  await preserve(page, ownership);
  await page.screenshot({ path: info.outputPath('directory-escape.png') });
});

test('rename sends command to source tab without replacing draft', async ({ page, ownership }) => {
  await ready(page, ownership);
  await sessionMenu(page, '#optionsNameButton');
  await page.getByPlaceholder('New session name').fill('Fixture renamed');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/prompt' && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Name session', exact: true }).click();
  const request = (await response).request();
  expect(new URL(request.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  expect(request.postDataJSON().message).toBe('/name Fixture renamed');
  await preserve(page, ownership);
});

test('tree cancel and selection target the original tab', async ({ page, ownership }) => {
  await ready(page, ownership);
  await page.route('**/api/session-tree?*', route => route.fulfill({ json: { ok: true, data: { nodes: [{ id: 'tree-1', type: 'message', title: 'Fixture user', text: 'tree point' }] } } }));
  await page.route('**/api/tree-navigate?*', route => route.fulfill({ json: { ok: true, data: { message: 'Navigated fixture' } } }));
  await sessionMenu(page, '#optionsTreeButton');
  await expect(page.locator('#nativeCommandTitle')).toHaveText('/tree');
  await page.keyboard.press('Escape');
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  await preserve(page, ownership);
  await sessionMenu(page, '#optionsTreeButton');
  const item = page.locator('.native-selector-item').first();
  await expect(item).toBeVisible();
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/tree-navigate' && r.request().method() === 'POST');
  await item.click();
  expect(new URL((await response).url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
});

test('effort applies to source session', async ({ page, ownership }) => {
  await ready(page, ownership);
  await page.locator('#thinkingSelect').selectOption('high');
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/thinking' && r.request().method() === 'POST');
  await page.locator('#setThinkingButton').click();
  const req = (await response).request();
  expect(new URL(req.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  expect(req.postDataJSON()).toMatchObject({ level: 'high' });
  await preserve(page, ownership);
});

test('message copy and edit retry cancellation retain draft', async ({ page, ownership, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page, ownership);
  const copy = page.locator('#chat .message-copy-button').first();
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).not.toBe('');
  await page.locator('#chat .message-edit-retry-button').first().click();
  await expect(page.locator('#editRetryDialog')).toBeVisible();
  await page.locator('#editRetryText').fill('edited fixture');
  await page.locator('#editRetryCancelButton').click();
  await expect(page.locator('#editRetryDialog')).toBeHidden();
  await preserve(page, ownership);
});

test('focused split close preserves source and split sessions', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  await page.locator(`[data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-split-button`).click();
  await expect(page.locator('#terminalSplitShell')).toBeVisible();
  const splitId = await page.locator('#terminalSplitFrame').getAttribute('data-tab-id');
  await page.screenshot({ path: info.outputPath('focused-split.png') });
  await page.locator('#terminalSplitCloseButton').click();
  await expect(page.locator('#terminalSplitShell')).toBeHidden();
  expect((await ownership.api('/api/tabs')).tabs.map(tab => tab.id)).toContain(splitId);
  await preserve(page, ownership);
});

test('phone More closes and restores focus while retaining draft', async ({ page, ownership }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, ownership, '&mobileShell=v2');
  await page.locator('#mobileMoreButton').click();
  await expect(page.locator('#mobileShellSurface')).toBeVisible();
  await page.screenshot({ path: info.outputPath('phone-menu.png') });
  await page.locator('#mobileSurfaceCloseButton').click();
  await expect(page.locator('#mobileShellSurface')).toBeHidden();
  await expect(page.locator('#mobileMoreButton')).toBeFocused();
  await expect(page.locator('#promptInput')).toHaveValue('original draft');
});


test('path suggestions select and cancel without submitting', async ({ page, ownership }) => {
  await writeFile(join(dirname(dirname(ownership.sessionPath)), 'project', 'fixture-path.txt'), 'fixture');
  await ready(page, ownership);
  await page.locator('#promptInput').fill('original draft @fixture');
  await expect(page.locator('.path-suggest-item').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.path-suggest-item')).toHaveCount(0);
  await expect(page.locator('#promptInput')).toHaveValue('original draft @fixture');
  await page.locator('#promptInput').fill('original draft @fixtur');
  await expect(page.locator('.path-suggest-item').first()).toBeVisible();
  await page.locator('.path-suggest-item').first().click();
  await expect(page.locator('#promptInput')).toHaveValue(/@fixture-path\.txt/);
  await page.locator('#promptInput').fill('original draft');
  await preserve(page, ownership);
});

test('fork selector targets source tab with simulated fork response', async ({ page, ownership }) => {
  const forkTab = (await ownership.api('/api/tabs', {})).tab;
  await page.route('**/api/fork?*', route => route.fulfill({ json: { ok: true, data: { tab: forkTab, text: 'forked draft' } } }));
  await ready(page, ownership);
  await sessionMenu(page, '#optionsForkButton');
  await expect(page.locator('#nativeCommandTitle')).toHaveText('/fork');
  const item = page.locator('.native-selector-item').first();
  await expect(item).toBeVisible();
  const request = page.waitForRequest(r => new URL(r.url()).pathname === '/api/fork');
  await item.click();
  expect(new URL((await request).url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  await expect(page.locator('#promptInput')).toHaveValue('forked draft');
  await preserve(page, ownership);
});


test('export offers browser download from a simulated RPC result', async ({ page, ownership, context }) => {
  await page.route('**/api/prompt?*', async route => {
    if (route.request().postDataJSON()?.message === '/export') {
      await route.fulfill({ json: { ok: true, command: 'native_slash_command', data: { command: 'export', download: { fileName: 'fixture.html', url: '/fixture-export.html' } } } });
    } else await route.continue();
  });
  await context.route('**/fixture-export.html*', route => route.fulfill({ contentType: 'text/html', body: '<h1>Fixture export</h1>' }));
  await ready(page, ownership);
  await sessionMenu(page, '#optionsExportButton');
  await expect(page.locator('#nativeCommandDialog')).toContainText('fixture.html');
  const popup = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open in browser' }).click();
  const exported = await popup;
  await expect(exported.locator('h1')).toHaveText('Fixture export');
  await exported.close();
  await preserve(page, ownership);
});

test('desktop light theme is selectable and keeps draft', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
  const light = page.locator('[data-scheme-mode="light"]');
  await light.click();
  await expect(light).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: info.outputPath('desktop-light.png') });
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  await preserve(page, ownership);
});


test('edit and fork only restores edited prompt in simulated fork tab', async ({ page, ownership }) => {
  const forkTab = (await ownership.api('/api/tabs', {})).tab;
  await page.route('**/api/fork?*', route => route.fulfill({ json: { ok: true, data: { tab: forkTab } } }));
  await ready(page, ownership);
  await page.locator('#chat .message-edit-retry-button').first().click();
  await page.locator('#editRetryText').fill('edited fixture');
  const request = page.waitForRequest(r => new URL(r.url()).pathname === '/api/fork');
  await page.locator('#editRetryForkButton').click();
  expect(new URL((await request).url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  await expect(page.locator('#promptInput')).toHaveValue('edited fixture');
  await preserve(page, ownership);
});

test('phone sessions navigation returns to chat with the source draft', async ({ page, ownership }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await ready(page, ownership, '&mobileShell=v2');
  await page.locator('#mobileSessionButton').click();
  await expect(page.locator('#mobileSessionsTitle')).toBeVisible();
  await page.getByRole('navigation', { name: 'Phone destinations' }).getByRole('button', { name: 'Chat', exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue('original draft');
});


test('directory picker Escape after loading closes and returns focus', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  await page.locator('#newTabButton').click();
  await page.locator('#newTabChooseDirectoryButton').click();
  await expect(page.locator('#pathPickerChooseButton')).toBeEnabled();
  await page.screenshot({ path: info.outputPath('directory-loaded.png') });
  await page.keyboard.press('Escape');
  await expect(page.locator('#pathPickerDialog')).toBeHidden();
  await expect(page.locator('#newTabButton')).toBeFocused();
  await preserve(page, ownership);
});


test('pending picker cancellation and reopen ignore the late result', async ({ page, ownership }) => {
  await ready(page, ownership);
  let release;
  let entered;
  let finishStale;
  const pending = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { entered = resolve; });
  const staleHandled = new Promise(resolve => { finishStale = resolve; });
  let count = 0;
  await page.route('**/api/directories?*', async route => {
    count += 1;
    if (count === 1) {
      entered();
      await pending;
      await route.fulfill({ json: { ok: true, data: { cwd: '/stale', displayCwd: 'Stale response', directories: [] } } });
      finishStale();
    } else {
      await route.fulfill({ json: { ok: true, data: { cwd: '/fresh', displayCwd: 'Fresh response', directories: [] } } });
    }
  });
  await page.locator('#newTabButton').click();
  await page.locator('#newTabChooseDirectoryButton').click();
  await intercepted;
  await expect(page.locator('#pathPickerCancelButton')).toBeFocused();
  const aborted = page.waitForEvent('requestfailed', request => new URL(request.url()).pathname === '/api/directories');
  await page.keyboard.press('Escape');
  expect((await aborted).failure().errorText).toMatch(/abort|cancel/i);
  await expect(page.locator('#pathPickerDialog')).toBeHidden();
  await expect(page.locator('#newTabButton')).toBeFocused();
  await page.locator('#newTabButton').click();
  await page.locator('#newTabChooseDirectoryButton').click();
  await expect(page.locator('#pathPickerCurrent')).toHaveText('Fresh response');
  release();
  await staleHandled;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(page.locator('#pathPickerCurrent')).toHaveText('Fresh response');
  await expect(page.locator('#pathPickerDialog')).toBeVisible();
  await page.locator('#pathPickerCancelButton').click();
  await expect(page.locator('#newTabButton')).toBeFocused();
  await preserve(page, ownership);
});

test('switching tabs while picker is open does not restore stale focus', async ({ page, ownership }) => {
  await ready(page, ownership);
  await page.locator('#newTabButton').click();
  await page.locator('#newTabChooseDirectoryButton').click();
  await expect(page.locator('#pathPickerDialog')).toBeVisible();
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-button`).evaluate(button => button.click());
  await expect(page.locator('#pathPickerDialog')).toBeHidden();
  await expect(page.locator('#promptInput')).toBeFocused();
  await expect(page.locator('#newTabButton')).not.toBeFocused();
  await preserve(page, ownership);
});

test('directory load error can be cancelled back to the original caller', async ({ page, ownership }) => {
  await ready(page, ownership);
  await page.route('**/api/directories?*', route => route.fulfill({ status: 500, json: { ok: false, error: 'Fixture directory error' } }));
  const caller = page.locator('.footer-tui-cwd');
  await caller.click();
  await expect(page.locator('#pathPickerError')).toHaveText('Fixture directory error');
  await page.locator('#pathPickerCancelButton').click();
  await expect(page.locator('#pathPickerDialog')).toBeHidden();
  await expect(caller).toBeFocused();
  await expect(page.locator('#promptInput')).toHaveValue('original draft');
});
