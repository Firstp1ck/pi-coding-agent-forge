import { expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from './empty-startup-fixture.mjs';

const storageKey = 'pi-webui-draft-conversations-v1';
test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

/** Opens a real thread in `current` and pins `pinned`, so the palette lists Current, No project, pinned, Browse and Branch worktree. */
async function readyWithThread(page, fixture) {
  const current = join(fixture.root, 'current-project');
  const pinned = join(fixture.root, 'pinned-project');
  await Promise.all([mkdir(current), mkdir(pinned)]);
  await fixture.api('/api/path-fast-picks', { picks: [{ cwd: pinned, displayCwd: pinned }] });
  const thread = (await fixture.api('/api/tabs', { cwd: current })).tab;
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${fixture.baseURL}/?tab=${encodeURIComponent(thread.id)}`);
  await expect(page.locator(`#tabBar [data-tab-id="${thread.id}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#promptInput')).toBeEditable();
  return { thread, current, pinned };
}

function trackCreations(page) {
  const creations = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/tabs' && request.method() === 'POST') creations.push(request.postDataJSON());
  });
  return creations;
}

const paletteOptions = page => page.locator('#newThreadList [role="option"]');
const paletteOption = (page, name) => page.locator('#newThreadList').getByRole('option', { name });
const pickerOptions = page => page.locator('#draftWorkspacePickerList [role="option"]');
const pickerOption = (page, name) => page.locator('#draftWorkspacePickerList').getByRole('option', { name });
const workspaceButton = page => page.locator('.empty-start-workspace-button');

async function openPalette(page) {
  await page.locator('#newTabButton').click();
  await expect(page.locator('#newThreadDialog')).toBeVisible();
  await expect(page.locator('#newThreadInput')).toBeFocused();
}

async function expectDraftFolder(page, label) {
  await expect(page.locator('#emptyStartTitle')).toHaveText('Start a conversation');
  await expect(workspaceButton(page)).toHaveText(label);
  await expect(page.locator('.focused-context')).toHaveText(label);
}

async function directPath(page, cwd) {
  await page.locator('#pathPickerPathInput').fill(cwd);
  await page.locator('#pathPickerPathInput').press('Enter');
  await expect(page.locator('#pathPickerCurrent')).toHaveAttribute('title', cwd);
  await expect(page.locator('#pathPickerChooseButton')).toBeEnabled();
}

async function holdCreation(page) {
  let release;
  let notify;
  const released = new Promise(resolve => { release = resolve; });
  const created = new Promise(resolve => { notify = resolve; });
  let held = false;
  await page.route('**/api/tabs', async route => {
    if (route.request().method() !== 'POST' || held) return route.continue();
    held = true;
    const response = await route.fetch();
    notify((await response.json()).data.tab);
    await Promise.race([released, delay(5000)]);
    await route.fulfill({ response });
  });
  return { created, release };
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('the sidebar compose button opens the palette; Current, pinned, No project and Browse open drafts without creating threads', async ({ page, emptyStartup }, info) => {
  const { thread, current, pinned } = await readyWithThread(page, emptyStartup);
  const creations = trackCreations(page);
  await expect(page.locator('#newTabButton')).toHaveAccessibleName('New thread');
  await openPalette(page);
  await expect(page.locator('#newThreadDialog')).toHaveAccessibleName('New thread');
  await expect(paletteOptions(page).locator('.command-palette-item-label')).toHaveText(['current-project', 'No project', 'pinned-project', 'Browse…', 'Branch worktree…']);
  await expect(paletteOptions(page).locator('.command-palette-item-kind')).toHaveText(['Current', 'Isolated', 'Pinned', 'Action', 'Git']);
  await capture(page, info, 'palette');

  await paletteOption(page, /current-project/).click();
  await expect(page.locator('#newThreadDialog')).toBeHidden();
  await expectDraftFolder(page, current);
  await expect(page.locator('#promptInput')).toBeFocused();
  await expect(page.locator('#promptInput')).toHaveValue('');

  await openPalette(page);
  await paletteOption(page, /pinned-project/).click();
  await expectDraftFolder(page, pinned);
  await expect(page.locator('[data-draft-id]'), 'a blank draft is reused, never listed').toHaveCount(0);

  const text = 'Pinned folder draft text';
  await page.locator('#promptInput').fill(text);
  await openPalette(page);
  await paletteOption(page, /No project/).click();
  await expectDraftFolder(page, 'No Project');
  await expect(page.locator('#promptInput')).toHaveValue('');
  const saved = page.getByRole('tab', { name: `Draft: ${text}`, exact: true });
  await expect(saved, 'a draft with text is kept, not reused').toBeVisible();
  await saved.click();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await expectDraftFolder(page, pinned);

  const browsed = join(emptyStartup.root, 'browsed-project');
  await mkdir(browsed);
  await page.locator(`#tabBar [data-tab-id="${thread.id}"] .terminal-tab-button`).click();
  await openPalette(page);
  await paletteOption(page, /Browse…/).click();
  await expect(page.locator('#pathPickerDialog')).toBeVisible();
  await directPath(page, browsed);
  await page.locator('#pathPickerChooseButton').click();
  await expect(page.locator('#pathPickerDialog')).toBeHidden();
  await expectDraftFolder(page, browsed);
  await capture(page, info, 'draft-with-folder');

  expect(creations).toEqual([]);
  expect((await emptyStartup.api('/api/tabs')).tabs.map(tab => tab.id)).toEqual([thread.id]);
  expect(await emptyStartup.starts()).toHaveLength(1);
  expect(await emptyStartup.ownedDirectories()).toEqual([]);
});

test('palette keyboard: arrows wrap, Home/End jump, typing filters, Enter selects, Escape returns focus', async ({ page, emptyStartup }) => {
  const { pinned } = await readyWithThread(page, emptyStartup);
  const creations = trackCreations(page);
  const input = page.locator('#newThreadInput');
  const options = paletteOptions(page);
  await page.locator('#newTabButton').focus();
  await page.keyboard.press('Enter');
  await expect(input).toBeFocused();
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(input).toHaveAttribute('aria-activedescendant', await options.first().getAttribute('id'));
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(options.first()).toHaveAttribute('aria-selected', 'false');
  await expect(input).toHaveAttribute('aria-activedescendant', await options.nth(1).getAttribute('id'));
  await page.keyboard.press('End');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(options.last()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('#newThreadDialog')).toBeHidden();
  await expect(page.locator('#newTabButton')).toBeFocused();

  await page.keyboard.press('Enter');
  await input.pressSequentially('PINNED');
  await expect(options.locator('.command-palette-item-label')).toHaveText(['pinned-project', 'Browse…', 'Branch worktree…']);
  await input.fill(emptyStartup.root.slice(-6));
  await expect(options.locator('.command-palette-item-label')).toHaveText(['current-project', 'pinned-project', 'Browse…', 'Branch worktree…']);
  await input.fill('pinned');
  await page.keyboard.press('Enter');
  await expectDraftFolder(page, pinned);
  expect(creations).toEqual([]);
});

test('Branch worktree stays eager and opens its picker; the command palette offers New thread', async ({ page, emptyStartup }) => {
  await readyWithThread(page, emptyStartup);
  await openPalette(page);
  await paletteOption(page, /Branch worktree…/).click();
  await expect(page.locator('#newThreadDialog')).toBeHidden();
  await expect(page.getByRole('listbox', { name: 'Git branches and worktrees' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox', { name: 'Git branches and worktrees' })).toBeHidden();

  await page.locator('#promptInput').focus();
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox').filter({ visible: true }).first();
  await search.fill('New thread');
  await page.keyboard.press('Enter');
  await expect(page.locator('#newThreadDialog')).toBeVisible();
  await expect(page.locator('#newThreadInput')).toBeFocused();
});

test('the card folder dropdown changes only the draft folder, with keyboard, filter, outside click and focus return', async ({ page, emptyStartup }, info) => {
  const { current, pinned } = await readyWithThread(page, emptyStartup);
  const creations = trackCreations(page);
  await openPalette(page);
  await paletteOption(page, /current-project/).click();
  const trigger = workspaceButton(page);
  await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Choose a folder for this draft' });
  await expect(picker).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.draft-workspace-picker-input')).toBeFocused();
  await expect(pickerOptions(page).locator('.footer-model-option-main')).toHaveText(['current-project · selected', 'No project', 'pinned-project', 'Browse…']);
  await expect(pickerOptions(page).first(), 'the draft folder starts highlighted').toHaveAttribute('aria-selected', 'true');
  await capture(page, info, 'card-dropdown');

  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await page.keyboard.press('ArrowDown');
  await expect(picker).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(pickerOption(page, /pinned-project/)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expectDraftFolder(page, pinned);
  await expect(workspaceButton(page)).toBeFocused();

  await workspaceButton(page).click();
  await page.locator('.draft-workspace-picker-input').fill('CURRENT-PRO');
  await expect(pickerOptions(page).locator('.footer-model-option-main')).toHaveText(['current-project', 'Browse…']);
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expectDraftFolder(page, current);

  await workspaceButton(page).click();
  await page.locator('#chat').click({ position: { x: 8, y: 8 } });
  await expect(picker).toBeHidden();
  await expectDraftFolder(page, current);

  await workspaceButton(page).click();
  await pickerOption(page, /No project/).click();
  await expectDraftFolder(page, 'No Project');
  await workspaceButton(page).click();
  await expect(pickerOption(page, /No project/)).toHaveAttribute('aria-selected', 'true');
  await workspaceButton(page).click();
  await expect(picker, 'the trigger toggles the dropdown').toBeHidden();

  expect(creations).toEqual([]);
  expect((await emptyStartup.api('/api/tabs')).tabs).toHaveLength(1);
});

test('the card dropdown fits a 360px viewport above scroll containers', async ({ page, emptyStartup }, info) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await readyWithThread(page, emptyStartup);
  await page.locator('#terminalTabsToggleButton').click();
  await page.locator('#newTabButton').click();
  await expect(page.locator('#newThreadDialog')).toBeVisible();
  await paletteOption(page, /current-project/).click();
  await workspaceButton(page).scrollIntoViewIfNeeded();
  await workspaceButton(page).click();
  const picker = page.locator('.draft-workspace-picker');
  await expect(picker).toBeVisible();
  const box = await picker.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(box.y + box.height).toBeLessThanOrEqual(740);
  expect(await picker.evaluate(node => node.matches(':popover-open'))).toBe(true);
  for (const option of await pickerOptions(page).all()) await expect(option).toBeInViewport();
  await capture(page, info, 'card-dropdown-360');
});

test('the first prompt creates exactly one thread in the folder chosen from the card', async ({ page, emptyStartup }) => {
  const { pinned } = await readyWithThread(page, emptyStartup);
  const creations = trackCreations(page);
  await openPalette(page);
  await paletteOption(page, /current-project/).click();
  await workspaceButton(page).click();
  await pickerOption(page, /pinned-project/).click();
  const text = 'Start in the pinned folder';
  await page.locator('#promptInput').fill(text);
  await page.locator('#sendButton').click();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.type === 'prompt' && item.message === text)).toHaveLength(1);
  expect(creations).toEqual([{ cwd: pinned }]);
  const tabs = (await emptyStartup.api('/api/tabs')).tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs.at(-1).cwd).toBe(pinned);
  expect((await emptyStartup.commands()).find(item => item.message === text).cwd).toBe(pinned);
  expect(JSON.parse(await page.evaluate(key => localStorage.getItem(key) || '{"records":[]}', storageKey)).records).toEqual([]);
});

test('a dropdown change while the first prompt is pending never redirects it', async ({ page, emptyStartup }) => {
  const { current, pinned } = await readyWithThread(page, emptyStartup);
  await openPalette(page);
  await paletteOption(page, /current-project/).click();
  const hold = await holdCreation(page);
  const text = 'Captured in the current folder';
  await page.locator('#promptInput').fill(text);
  await page.locator('#sendButton').click();
  const created = await hold.created;
  // The pending send shows the message at once, so the start card leaves.
  await expect(page.locator('.message.user').first()).toContainText(text);
  await expect(page.locator('#promptInput')).toHaveValue('');
  await expect(workspaceButton(page)).toHaveCount(0);
  // Returning to the pending draft brings the card back; its folder must still be locked.
  await page.locator('#tabBar [role="tab"]').first().click();
  await page.locator('[data-draft-id] [role="tab"]').click();
  await expect(workspaceButton(page)).toBeVisible();
  await workspaceButton(page).click();
  await pickerOption(page, /pinned-project/).click();
  await expect(page.getByText('The first message is already starting this thread; its folder stays unchanged.').first()).toBeAttached();
  await expect(workspaceButton(page)).toHaveText(current);
  hold.release();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.type === 'prompt' && item.message === text)).toHaveLength(1);
  expect(created.cwd).toBe(current);
  expect((await emptyStartup.commands()).find(item => item.message === text).cwd).toBe(current);
  const tabs = (await emptyStartup.api('/api/tabs')).tabs;
  expect(tabs).toHaveLength(2);
  expect(tabs.map(tab => tab.cwd)).not.toContain(pinned);
});

test('a Browse choice that resolves after navigation does not pull the user into a new draft', async ({ page, emptyStartup }) => {
  const { thread } = await readyWithThread(page, emptyStartup);
  const creations = trackCreations(page);
  await page.locator('#promptInput').fill('Thread composer stays');
  await openPalette(page);
  await paletteOption(page, /Browse…/).click();
  await directPath(page, emptyStartup.root);
  // Resolve the picker and navigate in one task, before the picker continuation runs.
  await page.evaluate(() => {
    document.querySelector('#pathPickerChooseButton').click();
    document.querySelector('.focused-brand').click();
  });
  await expectDraftFolder(page, 'No Project');
  await page.locator(`#tabBar [data-tab-id="${thread.id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('Thread composer stays');
  expect(creations).toEqual([]);
});

test('draft text and its palette-chosen folder survive navigation and reload', async ({ page, emptyStartup }) => {
  const { thread, pinned } = await readyWithThread(page, emptyStartup);
  await openPalette(page);
  await paletteOption(page, /pinned-project/).click();
  const text = 'Reload keeps this folder';
  await page.locator('#promptInput').fill(text);
  await page.locator(`#tabBar [data-tab-id="${thread.id}"] .terminal-tab-button`).click();
  const draft = page.getByRole('tab', { name: `Draft: ${text}`, exact: true });
  await draft.click();
  await expectDraftFolder(page, pinned);
  await page.reload();
  // The page URL names the real thread, so reload selects it; the draft waits in the Inbox.
  await expect(page.locator(`#tabBar [data-tab-id="${thread.id}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
  await draft.click();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await expectDraftFolder(page, pinned);
  expect(JSON.parse(await page.evaluate(key => localStorage.getItem(key), storageKey)).records[0].cwd).toBe(pinned);
  expect((await emptyStartup.api('/api/tabs')).tabs).toHaveLength(1);
});

test('a palette choice applies its folder only to the draft it opened, even if another draft is opened during the switch', async ({ page, emptyStartup }) => {
  const { thread, current } = await readyWithThread(page, emptyStartup);
  await openPalette(page);
  await paletteOption(page, /current-project/).click();
  await page.locator('#promptInput').fill('saved draft A');
  await page.locator(`#tabBar [data-tab-id="${thread.id}"] .terminal-tab-button`).click();
  await openPalette(page);
  // Both clicks run in one task, so the draft switch lands while the palette's draft opening is still awaiting.
  await page.evaluate(() => {
    [...document.querySelectorAll('#newThreadList [role="option"]')].find(node => node.textContent.includes('pinned-project')).click();
    document.querySelector('[data-draft-id] [role="tab"]').click();
  });
  await expect(page.locator('#promptInput')).toHaveValue('saved draft A');
  await expect(workspaceButton(page)).toHaveText(current);
});

test('clicking the palette backdrop closes it and returns focus to the New thread button', async ({ page, emptyStartup }) => {
  await readyWithThread(page, emptyStartup);
  await openPalette(page);
  await page.locator('#newThreadInput').click();
  await expect(page.locator('#newThreadDialog')).toBeVisible();
  await page.mouse.click(4, 4);
  await expect(page.locator('#newThreadDialog')).toBeHidden();
  await expect(page.locator('#newTabButton')).toBeFocused();
});

test('Browse from the card dropdown returns focus to the re-rendered folder button', async ({ page, emptyStartup }) => {
  const { pinned } = await readyWithThread(page, emptyStartup);
  await openPalette(page);
  await paletteOption(page, /current-project/).click();
  await workspaceButton(page).click();
  await pickerOption(page, /Browse/).click();
  await directPath(page, pinned);
  await page.locator('#pathPickerChooseButton').click();
  await expect(workspaceButton(page)).toHaveText(pinned);
  await expect(workspaceButton(page)).toBeFocused();
});

test('Browse from a reusable blank draft on mobile returns to Chat', async ({ page, emptyStartup }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const folder = join(emptyStartup.root, 'chosen');
  await mkdir(folder);
  await page.goto(`${emptyStartup.baseURL}/?mobileShell=v2`);
  await expect(page.locator('#promptInput')).toBeEditable();
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.locator('#mobileNewCurrentDirectoryButton').click();
  await paletteOption(page, /Browse/).click();
  await directPath(page, folder);
  await page.locator('#pathPickerChooseButton').click();
  await expect(page.locator('#pathPickerDialog')).toBeHidden();
  await expect(workspaceButton(page)).toHaveText(folder);
  await expect(page.locator('html')).toHaveAttribute('data-mobile-shell-route', 'chat');
});

test('a stored legacy title shows as a thread in All tools', async ({ page, emptyStartup }) => {
  const current = join(emptyStartup.root, 'current');
  await mkdir(current);
  const thread = (await emptyStartup.api('/api/tabs', { cwd: current, title: 'Terminal 7' })).tab;
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${emptyStartup.baseURL}/?tab=${encodeURIComponent(thread.id)}`);
  await expect(page.locator('.focused-title')).toHaveText('Thread 7');
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'All tools', exact: true }).click();
  await expect(page.locator('.tools-launcher-context')).toHaveText('Thread 7');
});

test('a No project draft ignores the git footer cached by the previous thread', async ({ page, emptyStartup }) => {
  const { current } = await readyWithThread(page, emptyStartup);
  await page.evaluate(cwd => localStorage.setItem('pi-webui-git-footer-webui-payload-cache', JSON.stringify({
    cwd,
    raw: JSON.stringify({ type: 'firstpick.git-footer-status.footer', version: 1, main: [{ key: 'cwd', label: 'CWD', value: 'stale-previous-thread' }], meta: [] }),
  })), current);
  await openPalette(page);
  await paletteOption(page, /No project/).click();
  await expectDraftFolder(page, 'No Project');
  await expect(page.locator('#statusBar')).toContainText('Ready for your first message');
  await expect(page.locator('#statusBar')).not.toContainText('stale-previous-thread');
  await expect(page.locator('#statusBar')).not.toHaveClass(/statusbar-git-footer/);
});

test('the first prompt shows at once and is sent before the new thread finishes loading its UI', async ({ page, emptyStartup }) => {
  await readyWithThread(page, emptyStartup);
  await openPalette(page);
  await paletteOption(page, /current-project/).click();
  const hold = await holdCreation(page);
  const timeline = [];
  // A freshly started Pi answers its first reads slowly; the prompt must not wait for them.
  await page.route('**/api/state?*', async route => {
    await delay(1500);
    await route.continue().catch(() => {});
  });
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/prompt' || path === '/api/state') timeline.push(`start ${path}`);
  });
  page.on('requestfinished', request => {
    if (new URL(request.url()).pathname === '/api/state') timeline.push('end /api/state');
  });
  const text = 'Show me before the thread exists';
  await page.locator('#promptInput').fill(text);
  await page.locator('#sendButton').click();
  await hold.created;
  await expect(page.locator('.message.user').first()).toContainText(text);
  await expect(page.locator('#promptInput')).toHaveValue('');
  hold.release();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.type === 'prompt' && item.message === text)).toHaveLength(1);
  const promptAt = timeline.indexOf('start /api/prompt');
  expect(promptAt, timeline.join(', ')).toBeGreaterThanOrEqual(0);
  const firstStateEnd = timeline.indexOf('end /api/state');
  expect(firstStateEnd === -1 || promptAt < firstStateEnd, timeline.join(', ')).toBe(true);
});

test('a failed thread start puts the prompt back, followed by text typed while it was starting', async ({ page, emptyStartup }) => {
  const { current } = await readyWithThread(page, emptyStartup);
  await openPalette(page);
  await paletteOption(page, /current-project/).click();
  let release;
  const released = new Promise(resolve => { release = resolve; });
  await page.route('**/api/tabs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    await Promise.race([released, delay(5000)]);
    await route.fulfill({ status: 500, json: { success: false, error: 'Pi could not start' } });
  });
  await page.locator('#promptInput').fill('Original first prompt');
  await page.locator('#sendButton').click();
  await expect(page.locator('.message.user').first()).toContainText('Original first prompt');
  await page.locator('#promptInput').fill('typed while starting');
  release();
  await expect(page.locator('#promptInput')).toHaveValue('Original first prompt\n\ntyped while starting');
  await expect(page.locator('.message.user')).toHaveCount(0);
  await expectDraftFolder(page, current);
  expect((await emptyStartup.api('/api/tabs')).tabs).toHaveLength(1);
});
