import { expect } from '@playwright/test';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

async function openPicker(page) {
  await page.getByRole('button', { name: /^Open workspace/ }).click();
  await expect(page.locator('#pathPickerChooseButton')).toBeEnabled();
}

async function directPath(page, cwd) {
  await page.locator('#pathPickerPathInput').fill(cwd);
  await page.locator('#pathPickerPathInput').press('Enter');
  await expect(page.locator('#pathPickerCurrent')).toHaveAttribute('title', cwd);
}

async function choose(page, cwd) {
  await openPicker(page);
  await directPath(page, cwd);
  await page.locator('#pathPickerChooseButton').click();
  await expect(page.locator('#pathPickerDialog')).toBeHidden();
  await expectWorkspace(page, cwd);
}

async function expectWorkspace(page, cwd) {
  await expect(page.locator('.empty-start-context')).toContainText(cwd);
  await expect(page.locator('.empty-start-heading p')).toContainText(cwd);
}

function track(page) {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() === 'POST') requests.push({ path: url.pathname, tab: url.searchParams.get('tab'), body: request.postDataJSON() });
  });
  return requests;
}

async function unallocated(fixture, requests = []) {
  expect((await fixture.api('/api/tabs')).tabs).toEqual([]);
  expect(await fixture.starts()).toEqual([]);
  expect(await fixture.ownedDirectories()).toEqual([]);
  expect(requests.filter(item => ['/api/tabs', '/api/prompt'].includes(item.path))).toEqual([]);
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
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

test('zero-tab picker pins, unpins and creates a folder; selection retains text without allocating', async ({ page, emptyStartup }, info) => {
  const requests = track(page);
  await ready(page, emptyStartup);
  const text = 'Keep this text while choosing a workspace\nλ';
  await page.locator('#promptInput').fill(text);
  await openPicker(page);
  await directPath(page, emptyStartup.root);
  await page.locator('#pathPickerAddFastPickButton').click();
  await expect.poll(async () => (await emptyStartup.api('/api/path-fast-picks')).picks.map(item => item.cwd)).toContain(emptyStartup.root);
  await page.locator('#pathPickerFastPicks .path-picker-fast-pick-remove').click();
  await expect.poll(async () => (await emptyStartup.api('/api/path-fast-picks')).picks).toEqual([]);
  await page.locator('#pathPickerCreateNameInput').fill('selected-workspace');
  await page.locator('#pathPickerCreateNameInput').press('Enter');
  const cwd = join(emptyStartup.root, 'selected-workspace');
  await expect(page.locator('#pathPickerCurrent')).toHaveAttribute('title', cwd);
  expect((await stat(cwd)).isDirectory()).toBe(true);
  await page.locator('#pathPickerChooseButton').click();
  await expectWorkspace(page, cwd);
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await expect(page.getByText(/failed to persist path fast picks/)).toHaveCount(0);
  await unallocated(emptyStartup, requests);
  await capture(page, info, 'selected-workspace-before-send');
});

test('recent choice saves cwd with its browser draft through navigation and reload, then sends once', async ({ page, emptyStartup }, info) => {
  const cwd = join(emptyStartup.root, 'project');
  await mkdir(cwd);
  await emptyStartup.api('/api/path-fast-picks', { picks: [{ cwd, displayCwd: cwd }] });
  const requests = track(page);
  await ready(page, emptyStartup);
  const text = 'Saved project draft';
  await page.locator('#promptInput').fill(text);
  await page.locator('.empty-start-recent-item').click();
  await expectWorkspace(page, cwd);
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await page.locator('.focused-brand').click();
  const draft = page.getByRole('tab', { name: `Draft: ${text}`, exact: true });
  await expect(draft).toBeVisible();
  await expect(page.locator('[data-draft-id] [data-settlement-action]')).toHaveCount(0);
  await draft.click();
  await expectWorkspace(page, cwd);
  await page.reload();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await expectWorkspace(page, cwd);
  await capture(page, info, 'saved-workspace-draft');
  expect(JSON.parse(await page.evaluate(key => localStorage.getItem(key), storageKey)).records[0].cwd).toBe(cwd);
  await unallocated(emptyStartup, requests);
  await page.locator('#sendButton').click();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.message === text)).toHaveLength(1);
  const tabs = (await emptyStartup.api('/api/tabs')).tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0].cwd).toBe(cwd);
  expect(tabs[0].workspaceKind).not.toBe('no-project');
  expect(requests.filter(item => item.path === '/api/tabs').map(item => item.body)).toEqual([{ cwd }]);
  expect(requests.filter(item => item.path === '/api/prompt').map(item => item.tab)).toEqual([tabs[0].id]);
  expect((await emptyStartup.commands()).find(item => item.message === text).cwd).toBe(cwd);
  expect(await emptyStartup.ownedDirectories()).toEqual([]);
  await expect(draft).toHaveCount(0);
});

test('blank folder choice stays out of Inbox; cancellation preserves the chosen folder and text', async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  await choose(page, emptyStartup.root);
  await expect(page.locator('[data-draft-id]')).toHaveCount(0);
  await page.locator('#promptInput').fill('Retain selected workspace');
  await openPicker(page);
  await directPath(page, join(emptyStartup.root, 'home'));
  await page.keyboard.press('Escape');
  await expectWorkspace(page, emptyStartup.root);
  await expect(page.locator('#promptInput')).toHaveValue('Retain selected workspace');
  await unallocated(emptyStartup);
});

test('late folder selection updates only its opening draft after navigation', async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  await page.locator('#promptInput').fill('Opening draft');
  await openPicker(page);
  await directPath(page, emptyStartup.root);
  // Resolve selection and navigate in one task, before the picker continuation.
  await page.evaluate(() => {
    document.querySelector('#pathPickerChooseButton').click();
    document.querySelector('.focused-brand').click();
  });
  await expect(page.locator('#promptInput')).toHaveValue('');
  await expect(page.locator('.empty-start-context')).toContainText('No Project');
  await page.getByRole('tab', { name: 'Draft: Opening draft', exact: true }).click();
  await expectWorkspace(page, emptyStartup.root);
  await expect(page.locator('#promptInput')).toHaveValue('Opening draft');
  await unallocated(emptyStartup);
});

test('pending project creation keeps captured cwd and text while another draft chooses a different folder', async ({ page, emptyStartup }) => {
  const firstCwd = join(emptyStartup.root, 'first');
  const otherCwd = join(emptyStartup.root, 'other');
  await Promise.all([mkdir(firstCwd), mkdir(otherCwd)]);
  await ready(page, emptyStartup);
  await choose(page, firstCwd);
  const hold = await holdCreation(page);
  await page.locator('#promptInput').fill('Captured project prompt');
  await page.locator('#sendButton').click();
  const first = await hold.created;
  await page.locator('#sendButton').click();
  await page.locator('.focused-brand').click();
  await page.locator('#promptInput').fill('Other draft stays selected');
  await choose(page, otherCwd);
  hold.release();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.message === 'Captured project prompt')).toHaveLength(1);
  expect((await emptyStartup.commands()).find(item => item.message === 'Captured project prompt').cwd).toBe(firstCwd);
  expect((await emptyStartup.api('/api/tabs')).tabs.map(tab => tab.id)).toEqual([first.id]);
  await expect(page.locator('#promptInput')).toHaveValue('Other draft stays selected');
  await expectWorkspace(page, otherCwd);
  await page.locator('#sendButton').click();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.message === 'Other draft stays selected')).toHaveLength(1);
  expect((await emptyStartup.commands()).find(item => item.message === 'Other draft stays selected').cwd).toBe(otherCwd);
  expect((await emptyStartup.api('/api/tabs')).tabs).toHaveLength(2);
  expect(await emptyStartup.ownedDirectories()).toEqual([]);
});

test('project creation failure keeps cwd; dispatch failure retries in the one created session', async ({ page, emptyStartup }) => {
  await ready(page, emptyStartup);
  await choose(page, emptyStartup.root);
  await page.locator('#promptInput').fill('Recover project submission');
  await writeFile(emptyStartup.failFile, 'fail\n');
  const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tabs' && response.request().method() === 'POST');
  await page.locator('#sendButton').click();
  expect((await failed).status()).toBeGreaterThanOrEqual(400);
  await expectWorkspace(page, emptyStartup.root);
  await expect(page.locator('#promptInput')).toHaveValue('Recover project submission');
  expect((await emptyStartup.api('/api/tabs')).tabs).toEqual([]);
  await rm(emptyStartup.failFile);
  await page.route('**/api/prompt?*', route => route.fulfill({ status: 503, json: { success: false, error: 'Project dispatch unavailable' } }));
  await page.locator('#sendButton').click();
  await expect(page.getByText('Project dispatch unavailable').first()).toBeAttached();
  await expect(page.locator('#promptInput')).toHaveValue('Recover project submission');
  const tabs = (await emptyStartup.api('/api/tabs')).tabs;
  expect(tabs).toHaveLength(1);
  expect(tabs[0].cwd).toBe(emptyStartup.root);
  await page.unroute('**/api/prompt?*');
  await page.locator('#sendButton').click();
  await expect.poll(async () => (await emptyStartup.commands()).filter(item => item.message === 'Recover project submission')).toHaveLength(1);
  expect((await emptyStartup.api('/api/tabs')).tabs.map(tab => tab.id)).toEqual([tabs[0].id]);
});

test('shared zero-tab HTTP writes retain invalid-tab, directory validation and Natural Conversation restrictions', async ({ request, emptyStartup }) => {
  const post = async (path, body, headers) => {
    const response = await request.post(`${emptyStartup.baseURL}${path}`, { data: body, headers });
    return { status: response.status(), payload: await response.json() };
  };
  for (const [path, body] of [
    ['/api/path-fast-picks', { picks: [] }],
    ['/api/directories', { parent: emptyStartup.root, name: 'invalid-tab-child' }],
  ]) {
    for (const target of ['query', 'body', 'header']) {
      const result = await post(`${path}${target === 'query' ? '?tab=stale-tab' : ''}`, target === 'body' ? { ...body, tabId: 'stale-tab' } : body, target === 'header' ? { 'x-pi-webui-tab': 'stale-tab' } : undefined);
      expect(result.status, JSON.stringify(result.payload)).toBe(404);
    }
  }
  for (const name of ['../escape', '..', '.', '', 'a/b', 'a\\b', 'null\0byte', 'x'.repeat(256)]) {
    expect((await post('/api/directories', { parent: emptyStartup.root, name })).status).toBe(400);
  }
  const created = await post('/api/directories', { parent: emptyStartup.root, name: 'http-created' });
  expect(created.status).toBe(201);
  expect(created.payload.data.cwd).toBe(join(emptyStartup.root, 'http-created'));
  expect((await post('/api/directories', { parent: emptyStartup.root, name: 'http-created' })).status).toBe(409);
  await emptyStartup.api('/api/path-fast-picks', { picks: [{ cwd: created.payload.data.cwd }] });
  expect((await emptyStartup.api('/api/path-fast-picks')).picks.map(item => item.cwd)).toEqual([created.payload.data.cwd]);
  await unallocated(emptyStartup);
  const tab = (await emptyStartup.api('/api/tabs', { cwd: emptyStartup.root })).tab;
  await emptyStartup.api(`/api/prompt?tab=${tab.id}`, { message: '/talk on' });
  await expect.poll(async () => (await emptyStartup.api('/api/tabs')).tabs[0].conversationMode.enabled).toBe(true);
  for (const [path, body] of [
    ['/api/path-fast-picks', { picks: [] }],
    ['/api/directories', { parent: emptyStartup.root, name: 'blocked-by-talk' }],
  ]) {
    for (const target of ['', `?tab=${tab.id}`]) {
      expect((await post(`${path}${target}`, body)).status).toBe(409);
    }
  }
  await expect(stat(join(emptyStartup.root, 'blocked-by-talk'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await emptyStartup.api('/api/path-fast-picks')).picks).toHaveLength(1);
  await emptyStartup.api(`/api/prompt?tab=${tab.id}`, { message: '/talk off' });
  await expect.poll(async () => (await emptyStartup.api('/api/tabs')).tabs[0].conversationMode.enabled).toBe(false);
  expect((await post(`/api/directories?tab=${tab.id}`, { parent: emptyStartup.root, name: 'allowed-with-tab' })).status).toBe(201);
  expect((await post(`/api/path-fast-picks?tab=${tab.id}`, { picks: [] })).status).toBe(200);
});
