import { expect } from '@playwright/test';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from './empty-startup-fixture.mjs';

const storageKey = 'pi-webui-draft-conversations-v1';
test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

async function ready(page, fixture) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(fixture.baseURL);
  await expect(page.locator('#emptyStartTitle')).toHaveText('Start a conversation');
  await expect(page.locator('#promptInput')).toBeEditable();
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

function track(page) {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) requests.push({ path: url.pathname, tab: url.searchParams.get('tab'), method: request.method(), body: request.postData() });
  });
  return requests;
}

async function promote(page, fixture, text) {
  await page.locator('#promptInput').fill(text);
  await page.locator('#sendButton').click();
  await expect.poll(async () => (await fixture.commands()).filter(item => item.type === 'prompt' && item.message === text.trim()).length).toBe(1);
  const tabs = (await fixture.api('/api/tabs')).tabs;
  return tabs.at(-1);
}

async function holdCreation(page) {
  let created;
  let release;
  const pending = new Promise(resolve => { created = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  let held = false;
  await page.route('**/api/tabs', async route => {
    if (route.request().method() !== 'POST' || held) return route.continue();
    held = true;
    const response = await route.fetch();
    created((await response.json()).data.tab);
    await Promise.race([released, delay(5000)]);
    await route.fulfill({ response });
  });
  return { created: pending, release };
}

async function openNoProjectMenu(page) {
  await page.locator('#newTabButton').click();
  await page.locator('#newTabNoProjectButton').click();
}

test('blank openings allocate nothing; leaving text creates an Inbox draft that resumes, reloads, and closes locally', async ({ page, emptyStartup }, info) => {
  const requests = track(page);
  await ready(page, emptyStartup);
  await page.locator('.focused-brand').click();
  await openNoProjectMenu(page);
  await expect(page.locator('[data-draft-id]')).toHaveCount(0);
  expect((await emptyStartup.api('/api/tabs')).tabs).toEqual([]);
  expect(await emptyStartup.starts()).toEqual([]);
  expect(await emptyStartup.ownedDirectories()).toEqual([]);
  await capture(page, info, 'empty-state-no-new-tabs');
  const original = 'Local draft before choosing a project\nsecond line λ';
  await page.locator('#promptInput').fill(original);
  await page.locator('.focused-brand').click();
  const row = page.locator('[data-session-shelf="inbox"] [data-draft-id]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Draft · browser only');
  await expect(row.locator('[data-settlement-action], [data-tab-id], .terminal-tab-actions')).toHaveCount(0);
  await expect(page.locator('#promptInput')).toHaveValue('');
  await capture(page, info, 'saved-draft');
  await row.getByRole('tab').click();
  await expect(page.locator('#promptInput')).toHaveValue(original);
  await page.locator('#promptInput').fill(`${original}\nedited after resume`);
  await capture(page, info, 'resume-draft');
  await page.reload();
  await expect(page.locator('#promptInput')).toHaveValue(`${original}\nedited after resume`);
  await expect(row).toHaveCount(1);
  await row.getByRole('button', { name: /^Close draft:/ }).click();
  await expect(row).toHaveCount(0);
  await expect(page.locator('#promptInput')).toHaveValue('');
  await page.reload();
  await expect(row).toHaveCount(0);
  expect((await emptyStartup.api('/api/tabs')).tabs).toEqual([]);
  expect(await emptyStartup.starts()).toEqual([]);
  expect(requests.filter(item => item.method !== 'GET' && !['/api/interface-preferences'].includes(item.path))).toEqual([]);
  expect(requests.filter(item => item.tab?.startsWith('draft:'))).toEqual([]);
});

test('saved draft promotes once to its real No Project session and disappears from local storage', async ({ page, emptyStartup }, info) => {
  const requests = track(page);
  await ready(page, emptyStartup);
  const text = '  Promote this saved draft\nwith its full text λ \n';
  await page.locator('#promptInput').fill(text);
  await page.locator('.focused-brand').click();
  await page.getByRole('tab', { name: /^Draft: Promote this/ }).click();
  const tab = await promote(page, emptyStartup, text);
  expect(tab.workspaceKind).toBe('no-project');
  await expect(page.locator('[data-draft-id]')).toHaveCount(0);
  await expect(page.locator(`#tabBar [data-tab-id="${tab.id}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#promptInput')).toHaveValue('');
  expect(JSON.parse(await page.evaluate(key => localStorage.getItem(key), storageKey)).records).toEqual([]);
  expect(requests.filter(item => item.path === '/api/tabs' && item.method === 'POST').map(item => JSON.parse(item.body))).toEqual([{ workspaceKind: 'no-project' }]);
  expect(requests.filter(item => item.path === '/api/prompt').map(item => item.tab)).toEqual([tab.id]);
  expect(JSON.parse(requests.find(item => item.path === '/api/prompt').body).message).toBe(text);
  expect(requests.filter(item => item.tab?.startsWith('draft:'))).toEqual([]);
  await capture(page, info, 'first-prompt-promotion');
});

test('Home and + Tab leave existing sessions intact while selecting fresh blank client state', async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  const source = await promote(page, emptyStartup, 'Existing conversation');
  await page.locator('#promptInput').fill('Existing session composer');
  await page.locator('.focused-brand').click();
  await expect(page.locator('#promptInput')).toHaveValue('');
  await expect(page.locator('#emptyStartTitle')).toHaveText('Start a conversation');
  await page.locator('#promptInput').fill('First browser draft');
  await openNoProjectMenu(page);
  await expect(page.locator('#promptInput')).toHaveValue('');
  await expect(page.getByRole('tab', { name: 'Draft: First browser draft', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('#promptInput')).toHaveValue('');
  await expect(page.locator('#emptyStartTitle')).toHaveText('Start a conversation');
  await page.locator(`#tabBar [data-tab-id="${source.id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('Existing session composer');
  await page.getByRole('tab', { name: 'Draft: First browser draft', exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue('First browser draft');
  expect((await emptyStartup.api('/api/tabs')).tabs.map(tab => tab.id)).toEqual([source.id]);
  expect(await emptyStartup.ownedDirectories()).toEqual([source.noProjectId]);
});

for (const mode of ['denied', 'failed writes', 'malformed', 'future']) test(`draft storage ${mode} is exposed and memory edits remain reopenable`, async ({ page, emptyStartup }) => {
  await page.addInitScript(({ mode, storageKey }) => {
    if (mode === 'denied') {
      Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage disabled for this browser'); } });
    } else if (mode === 'failed writes') {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === storageKey) throw new Error('Draft quota exceeded');
        return original.call(this, key, value);
      };
    } else {
      localStorage.setItem(storageKey, mode === 'malformed' ? '{invalid' : JSON.stringify({ version: 9, records: [], activeId: null }));
    }
  }, { mode, storageKey });
  if (mode === 'denied') {
    await page.goto(emptyStartup.baseURL);
    // Storage-denied startup falls back to the default shell; the composer and
    // canonical roster remain the same owners in both layouts.
    await expect(page.locator('#emptyStartTitle')).toHaveText('Start a conversation');
    await expect(page.locator('#draftStorageStatus')).toBeVisible();
    await expect(page.locator('#promptInput')).toBeEditable();
  } else await ready(page, emptyStartup);
  const text = `Keep this ${mode} draft`;
  await page.locator('#promptInput').fill(text);
  if (mode === 'denied') {
    // The focused brand is absent in the classic fallback layout.
    await openNoProjectMenu(page);
  } else await page.locator('.focused-brand').click();
  await expect(page.locator('#draftStorageStatus')).toContainText(/Browser drafts could not be (?:saved|loaded)/);
  await page.getByRole('tab', { name: `Draft: ${text}`, exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  expect((await emptyStartup.api('/api/tabs')).tabs).toEqual([]);
  if (mode === 'malformed' || mode === 'future') {
    const raw = await page.evaluate(key => localStorage.getItem(key), storageKey);
    expect(raw).toBe(mode === 'malformed' ? '{invalid' : JSON.stringify({ version: 9, records: [], activeId: null }));
  }
});

for (const navigation of ['selected', 'another blank']) test(`failed first dispatch retains captured and newer text after ${navigation}, retry reuses its real session`, async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  const hold = await holdCreation(page);
  const captured = 'Captured submission';
  await page.route('**/api/prompt?*', route => route.fulfill({ status: 503, json: { success: false, error: 'Dispatch unavailable' } }));
  await page.locator('#promptInput').fill(captured);
  await page.locator('#sendButton').click();
  const tab = await hold.created;
  await page.locator('#promptInput').fill('Newer edit');
  if (navigation === 'another blank') {
    await page.locator('.focused-brand').click();
    await page.locator('#promptInput').fill('Other blank stays selected');
  }
  hold.release();
  if (navigation === 'another blank') {
    await expect(page.getByText('Dispatch unavailable').first()).toBeAttached();
    await expect(page.locator('#promptInput')).toHaveValue('Other blank stays selected');
    await page.locator(`#tabBar [data-tab-id="${tab.id}"] .terminal-tab-button`).click();
  }
  await expect(page.locator('#promptInput')).toHaveValue(`${captured}\n\nNewer edit`);
  await expect(page.getByRole('tab', { name: 'Draft: Captured submission', exact: true })).toHaveCount(0);
  expect((await emptyStartup.api('/api/tabs')).tabs.map(item => item.id)).toEqual([tab.id]);
  await page.unroute('**/api/prompt?*');
  await page.locator('#sendButton').click();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.type === 'prompt' && item.message === `${captured}\n\nNewer edit`).length).toBe(1);
  expect((await emptyStartup.api('/api/tabs')).tabs).toHaveLength(1);
});

test('crossed promotion responses and newer navigation keep both exact server targets', async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  const hold = await holdCreation(page);
  await page.locator('#promptInput').fill('First delayed promotion');
  await page.locator('#sendButton').click();
  const first = await hold.created;
  await page.locator('.focused-brand').click();
  const second = await promote(page, emptyStartup, 'Second promotion');
  expect(second.id).not.toBe(first.id);
  await page.locator('#promptInput').fill('Newer real session draft');
  hold.release();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.type === 'prompt' && item.message === 'First delayed promotion').length).toBe(1);
  await expect(page.locator('#promptInput')).toHaveValue('Newer real session draft');
  await expect(page.locator(`#tabBar [data-tab-id="${second.id}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
  const commands = await emptyStartup.commands();
  expect(commands.find(item => item.message === 'First delayed promotion').cwd).toBe(first.cwd);
  expect(commands.find(item => item.message === 'Second promotion').cwd).toBe(second.cwd);
  expect((await emptyStartup.api('/api/tabs')).tabs).toHaveLength(2);
});

test('closing a pending draft never redirects its submitted prompt or revives its local entry', async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  const hold = await holdCreation(page);
  await page.locator('#promptInput').fill('Submitted before closing');
  await page.locator('#sendButton').click();
  const first = await hold.created;
  await page.locator('.focused-brand').click();
  await page.getByRole('button', { name: 'Close draft: Submitted before closing', exact: true }).click();
  await page.locator('#promptInput').fill('Unrelated blank text');
  hold.release();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.type === 'prompt' && item.message === 'Submitted before closing').length).toBe(1);
  expect((await emptyStartup.commands()).find(item => item.message === 'Submitted before closing').cwd).toBe(first.cwd);
  await expect(page.locator('#promptInput')).toHaveValue('Unrelated blank text');
  await expect(page.getByRole('tab', { name: /^Draft: Submitted before/ })).toHaveCount(0);
});

test('deferred native selectors retain both the command and newer edits in their real session', async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  const hold = await holdCreation(page);
  await page.locator('#promptInput').fill('/name');
  await page.locator('#sendButton').click();
  const tab = await hold.created;
  await page.locator('#promptInput').fill('Newer unsent text');
  await page.locator('.focused-brand').click();
  hold.release();
  await expect(page.getByText(/Its command is saved in that conversation's draft\./).first()).toBeAttached();
  await expect(page.locator('#nativeCommandDialog')).not.toBeVisible();
  await page.locator(`#tabBar [data-tab-id="${tab.id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('/name\n\nNewer unsent text');
  expect((await emptyStartup.commands()).filter(item => item.type === 'prompt' && item.message === '/name')).toEqual([]);
});

for (const width of [1200, 1024]) test(`draft actions stay visible and keyboard reachable at ${width}px`, async ({ page, emptyStartup }, info) => {
  await page.setViewportSize({ width, height: 768 });
  await ready(page, emptyStartup);
  await page.locator('#promptInput').fill('Draft with a long title that must truncate without covering its close action');
  if (await page.locator('.focused-brand').isVisible()) await page.locator('.focused-brand').click();
  else await openNoProjectMenu(page);
  const row = page.locator('#tabBar [data-draft-id]');
  const close = row.getByRole('button', { name: /^Close draft:/ });
  const resume = row.getByRole('tab');
  await expect(close).toBeInViewport();
  await expect(resume).toBeInViewport();
  await resume.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#promptInput')).toHaveValue('Draft with a long title that must truncate without covering its close action');
  await close.focus();
  await capture(page, info, `narrow-draft-actions-${width}`);
  await page.keyboard.press('Enter');
  await expect(row).toHaveCount(0);
  expect((await emptyStartup.api('/api/tabs')).tabs).toEqual([]);
});
