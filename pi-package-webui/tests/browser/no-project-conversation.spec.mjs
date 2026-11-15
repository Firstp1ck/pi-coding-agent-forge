import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

async function ready(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  // Fake Pi seeds every process with the same transcript. Only substitute its
  // fresh-conversation messages; creation, identity, cwd and process state stay real.
  await page.route('**/api/messages?*', async route => {
    const tabId = new URL(route.request().url()).searchParams.get('tab');
    if (ownership.tabs.some(tab => tab.id === tabId)) return route.continue();
    return route.fulfill({ json: { type: 'response', success: true, data: { messages: [] } } });
  });
  await page.goto(ownership.baseURL);
  await expect(page.locator('#chat')).toContainText('fake answer');
}

async function openFresh(page, ownership) {
  const created = page.waitForResponse(response => new URL(response.url()).pathname === '/api/tabs' && response.request().method() === 'POST');
  await page.locator('.focused-brand').click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const tab = (await response.json()).data.tab;
  expect(tab.workspaceKind).toBe('no-project');
  await expect(page.locator('.focused-context')).toHaveText('No Project');
  await expect(page.locator('#emptyStartTitle')).toHaveText('Start a conversation');
  await expect(page.locator('#promptInput')).toHaveValue('');
  expect((await stat(tab.cwd)).isDirectory()).toBe(true);
  expect(ownership.tabs.map(item => item.cwd)).not.toContain(tab.cwd);
  return tab;
}

test('Pi creates distinct No Project folders while retaining drafts and background work', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const source = ownership.tabs[0];
  await page.locator('#promptInput').fill('Keep my project draft');
  await ownership.api(`/api/prompt?tab=${source.id}`, { message: 'fixture continuity held stream', requestId: 'no-project-source-run' });
  await expect(page.locator('#abortButton')).toBeVisible();
  const first = await openFresh(page, ownership);
  const savedFile = join(first.cwd, 'retained.txt');
  await writeFile(savedFile, 'No Project files survive navigation');
  await page.locator('#promptInput').fill('Keep my first No Project draft');
  const second = await openFresh(page, ownership);
  expect(second.id).not.toBe(first.id);
  expect(second.cwd).not.toBe(first.cwd);
  await page.screenshot({ path: info.outputPath('no-project-welcome.png') });
  await page.reload();
  await expect(page.locator('.focused-context')).toHaveText('No Project');
  expect((await ownership.api('/api/tabs')).tabs.find(tab => tab.id === second.id).cwd).toBe(second.cwd);
  await page.locator(`#tabBar [data-tab-id="${first.id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('Keep my first No Project draft');
  await page.locator(`#tabBar [data-tab-id="${source.id}"] .terminal-tab-button`).click();
  await expect(page.locator('#promptInput')).toHaveValue('Keep my project draft');
  expect((await ownership.api(`/api/state?tab=${source.id}`)).isStreaming).toBe(true);
  expect(await readFile(savedFile, 'utf8')).toBe('No Project files survive navigation');
  await ownership.api(`/api/abort?tab=${source.id}`, {});
});

test('No Project new-session follows a fresh tab and keeps the previous folder', async ({ page, ownership }) => {
  await ready(page, ownership);
  const original = await openFresh(page, ownership);
  await writeFile(join(original.cwd, 'keep.txt'), 'retained');
  await page.locator('#promptInput').fill('/new');
  const reset = page.waitForResponse(response => new URL(response.url()).pathname === '/api/prompt' && response.request().method() === 'POST');
  await page.locator('#promptInput').press('Enter');
  const payload = await (await reset).json();
  expect(payload.nextTabId || payload.data?.nextTabId).toBeTruthy();
  const nextId = payload.nextTabId || payload.data.nextTabId;
  await expect(page.locator(`#tabBar [data-tab-id="${nextId}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
  const tabs = (await ownership.api('/api/tabs')).tabs;
  expect(tabs.find(tab => tab.id === original.id).cwd).toBe(original.cwd);
  expect(tabs.find(tab => tab.id === nextId).cwd).not.toBe(original.cwd);
  expect(await readFile(join(original.cwd, 'keep.txt'), 'utf8')).toBe('retained');
  await expect(page.locator('#promptInput')).toHaveValue('');
});

test('failed No Project creation leaves the source and its draft selected', async ({ page, ownership }) => {
  await ready(page, ownership);
  await page.locator('#promptInput').fill('Do not lose this draft');
  await page.route('**/api/tabs', route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, json: { ok: false, error: 'No Project launch unavailable' } }) : route.continue());
  await page.locator('.focused-brand').click();
  await expect(page.locator('.focused-brand')).toBeEnabled();
  await expect(page.locator('#promptInput')).toHaveValue('Do not lose this draft');
  await expect(page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
  expect((await ownership.api('/api/tabs')).tabs).toHaveLength(2);
});
