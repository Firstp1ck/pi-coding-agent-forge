import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from './empty-startup-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });

const draftStorageKey = 'pi-webui-draft-conversations-v1';

function terminalRow(page, id) {
  return page.locator(`#tabBar [data-tab-id="${id}"]`).filter({ has: page.locator('.terminal-tab-button') });
}

async function ready(page, fixture, { running = false, project = false } = {}) {
  if (running) {
    // The disposable wrapper has not launched a child yet. Enable the shared
    // fake Pi's held-stream scenario without changing a shared fixture.
    const wrapper = join(fixture.root, 'fake-wrapper.mjs');
    await writeFile(wrapper, `process.env.FAKE_PI_CONTINUITY_MODE = '1';\n${await readFile(wrapper, 'utf8')}`);
  }
  const { tab } = await fixture.api('/api/tabs', project
    ? { cwd: fixture.root, title: 'Project terminal' }
    : { workspaceKind: 'no-project', title: 'Last Inbox terminal' });
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(fixture.baseURL);
  await expect(terminalRow(page, tab.id).locator('.terminal-tab-button')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#promptInput')).toBeEditable();
  await expect.poll(async () => (await fixture.starts()).length).toBe(1);
  if (running) {
    await fixture.api(`/api/prompt?tab=${tab.id}`, { message: 'fixture continuity held stream', requestId: 'last-terminal-held-stream' });
    await expect(terminalRow(page, tab.id)).toHaveClass(/activity-working/);
  }
  return tab;
}

function trackMutations(page) {
  const requests = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/') && request.method() !== 'GET') {
      requests.push({ path: url.pathname, tab: url.searchParams.get('tab'), body: request.postDataJSON() });
    }
  });
  return requests;
}

async function expectEmpty(page, fixture) {
  await expect(page.locator('#tabBar [data-tab-id]')).toHaveCount(0);
  await expect(page.locator('#emptyStartTitle')).toHaveText('Start a conversation');
  await expect(page.locator('#promptInput')).toBeEditable();
  await expect(page.locator('#promptInput')).toHaveValue('');
  await expect(page.locator('#statusBar')).toContainText('No Project');
  expect((await fixture.api('/api/tabs')).tabs).toEqual([]);
  expect(await fixture.starts()).toHaveLength(1);
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function addRemainingTerminal(page, fixture, keepRealTab) {
  if (!keepRealTab) return [];
  const { tab } = await fixture.api('/api/tabs', { workspaceKind: 'no-project', title: 'Retained Inbox terminal' });
  await page.reload();
  await expect(terminalRow(page, tab.id)).toBeVisible();
  return [tab.id];
}

for (const width of [1440, 1024]) test(`last idle Inbox terminal closes to a client blank without replacement at ${width}px`, async ({ page, emptyStartup }, info) => {
  await page.setViewportSize({ width, height: 900 });
  const tab = await ready(page, emptyStartup);
  const marker = join(tab.cwd, 'retain-after-close.txt');
  await writeFile(marker, 'Keep this working directory');
  const requests = trackMutations(page);
  const close = terminalRow(page, tab.id).getByRole('button', { name: `Close ${tab.title}`, exact: true });
  await expect(close).toBeInViewport();
  await close.focus();
  await capture(page, info, `last-terminal-close-control-${width}`);
  await page.keyboard.press('Enter');
  await expectEmpty(page, emptyStartup);
  await expect(page.locator('#confirmationDialog')).not.toBeVisible();
  await expect(page.locator('#undoToastButton')).toBeVisible();
  expect(await emptyStartup.ownedDirectories()).toEqual([tab.noProjectId]);
  expect(await readFile(marker, 'utf8')).toBe('Keep this working directory');
  expect(requests.filter(item => item.path === '/api/tabs/close').map(item => item.body)).toEqual([{ ids: [tab.id], allowEmpty: true }]);
  expect(requests.filter(item => item.path === '/api/tabs')).toEqual([]);
  await capture(page, info, `last-terminal-empty-composer-${width}`);
});

test('last running terminal retains cancel and explicit stop confirmation', async ({ page, emptyStartup }, info) => {
  const tab = await ready(page, emptyStartup, { running: true });
  const requests = trackMutations(page);
  const close = terminalRow(page, tab.id).locator('.terminal-tab-close');
  await close.click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  await expect(page.locator('#confirmationSummary')).toContainText('still running or waiting for input');
  await capture(page, info, 'last-running-close-confirmation');
  await page.locator('#confirmationCancelButton').click();
  await expect(terminalRow(page, tab.id).locator('.terminal-tab-button')).toHaveAttribute('aria-selected', 'true');
  expect((await emptyStartup.api('/api/tabs')).tabs.map(item => item.id)).toEqual([tab.id]);
  expect(requests.filter(item => item.path === '/api/tabs/close')).toEqual([]);
  await close.click();
  await page.getByRole('button', { name: 'Close and stop work', exact: true }).click();
  await expectEmpty(page, emptyStartup);
  expect(requests.filter(item => item.path === '/api/tabs/close').map(item => item.body)).toEqual([{ ids: [tab.id], allowEmpty: true }]);
  expect(await emptyStartup.ownedDirectories()).toEqual([tab.noProjectId]);
});

test('Undo reopens the last idle terminal in its retained No Project directory', async ({ page, emptyStartup }) => {
  const tab = await ready(page, emptyStartup);
  const requests = trackMutations(page);
  await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
  await expectEmpty(page, emptyStartup);
  await page.locator('#undoToastButton').click();
  await expect.poll(async () => (await emptyStartup.api('/api/tabs')).tabs.length).toBe(1);
  const [reopened] = (await emptyStartup.api('/api/tabs')).tabs;
  expect(reopened.cwd).toBe(tab.cwd);
  expect(reopened.noProjectId).toBe(tab.noProjectId);
  expect(reopened.workspaceKind).toBe('no-project');
  await expect(terminalRow(page, reopened.id).locator('.terminal-tab-button')).toHaveAttribute('aria-selected', 'true');
  expect(await emptyStartup.starts()).toHaveLength(2);
  expect(await emptyStartup.ownedDirectories()).toEqual([tab.noProjectId]);
  expect(requests.filter(item => item.path === '/api/tabs/reopen').map(item => item.body)).toEqual([{ id: tab.id }]);
  expect(requests.filter(item => item.path === '/api/tabs')).toEqual([]);
});

test('failed last close keeps its canonical row, selection, composer and backend state', async ({ page, emptyStartup }) => {
  const tab = await ready(page, emptyStartup);
  const text = 'Unsent text survives close failure';
  await page.locator('#promptInput').fill(text);
  await page.route('**/api/tabs/close', route => route.fulfill({ status: 503, json: { ok: false, error: 'Close unavailable' } }));
  await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
  await expect(page.getByText('Close unavailable', { exact: true }).first()).toBeAttached();
  await expect(terminalRow(page, tab.id).locator('.terminal-tab-button')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await expect(page.locator('#undoToast')).not.toBeVisible();
  expect((await emptyStartup.api('/api/tabs')).tabs.map(item => item.id)).toEqual([tab.id]);
  expect(await emptyStartup.starts()).toHaveLength(1);
  expect(await emptyStartup.ownedDirectories()).toEqual([tab.noProjectId]);
  await page.unroute('**/api/tabs/close');
  await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
  await expectEmpty(page, emptyStartup);
});

for (const keepRealTab of [false, true]) test(`background real close preserves a saved Draft with ${keepRealTab ? 'one' : 'zero'} real tabs remaining`, async ({ page, emptyStartup }, info) => {
  const tab = await ready(page, emptyStartup);
  const remainingIds = await addRemainingTerminal(page, emptyStartup, keepRealTab);
  await page.locator('.focused-brand').click();
  await page.locator('#promptInput').fill('Saved browser Draft');
  await page.locator('.focused-brand').click();
  const draft = page.getByRole('tab', { name: 'Draft: Saved browser Draft', exact: true });
  await draft.click();
  const text = 'Saved browser Draft\nnewer edits λ';
  await page.locator('#promptInput').fill(text);
  const draftId = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).activeId, draftStorageKey);
  const requests = trackMutations(page);
  await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
  await expect(terminalRow(page, tab.id)).toHaveCount(0);
  await expect(page.locator('#tabBar [data-tab-id]')).toHaveCount(remainingIds.length);
  await expect(page.locator(`[data-draft-id="${draftId}"] [role="tab"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#promptInput')).toHaveValue(text);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)).activeId, draftStorageKey)).toBe(draftId);
  expect((await emptyStartup.api('/api/tabs')).tabs.map(item => item.id)).toEqual(remainingIds);
  expect(await emptyStartup.starts()).toHaveLength(1 + remainingIds.length);
  expect(requests.filter(item => item.path === '/api/tabs' || item.tab?.startsWith('draft:'))).toEqual([]);
  await capture(page, info, `background-close-keeps-draft-${remainingIds.length}-real-remaining`);
  await page.reload();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await page.locator(`[data-draft-id="${draftId}"]`).getByRole('button', { name: /^Close draft:/ }).click();
  await expect(page.locator('[data-draft-id]')).toHaveCount(0);
  await expect(page.locator('#promptInput')).toHaveValue('');
  expect((await emptyStartup.api('/api/tabs')).tabs.map(item => item.id)).toEqual(remainingIds);
});

for (const keepRealTab of [false, true]) test(`background real close preserves fresh unsaved client text with ${keepRealTab ? 'one' : 'zero'} real tabs remaining`, async ({ page, emptyStartup }, info) => {
  const tab = await ready(page, emptyStartup);
  const remainingIds = await addRemainingTerminal(page, emptyStartup, keepRealTab);
  await page.locator('.focused-brand').click();
  const text = 'Fresh unsaved client text\nkeep every character λ';
  await page.locator('#promptInput').fill(text);
  await expect(page.locator('[data-draft-id]')).toHaveCount(0);
  const requests = trackMutations(page);
  await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
  await expect(terminalRow(page, tab.id)).toHaveCount(0);
  await expect(page.locator('#tabBar [data-tab-id]')).toHaveCount(remainingIds.length);
  await expect(page.locator('#tabBar .terminal-tab-button[aria-selected="true"]')).toHaveCount(0);
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await expect(page.locator('[data-draft-id]')).toHaveCount(0);
  await capture(page, info, `background-close-keeps-fresh-text-${remainingIds.length}-real-remaining`);
  await page.reload();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await page.locator('.focused-brand').click();
  const draft = page.getByRole('tab', { name: 'Draft: Fresh unsaved client text', exact: true });
  await draft.click();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await page.reload();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  expect((await emptyStartup.api('/api/tabs')).tabs.map(item => item.id)).toEqual(remainingIds);
  expect(await emptyStartup.starts()).toHaveLength(1 + remainingIds.length);
  expect(requests.filter(item => item.path === '/api/tabs' || item.tab?.startsWith('draft:'))).toEqual([]);
});

test('failed running close reconnects the original event stream and remains responsive', async ({ page, emptyStartup }) => {
  const tab = await ready(page, emptyStartup, { running: true });
  await page.route('**/api/tabs/close', route => route.fulfill({ status: 503, json: { ok: false, error: 'Running close unavailable' } }));
  await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
  const reconnect = page.waitForRequest(request => {
    const url = new URL(request.url());
    return url.pathname === '/api/events' && url.searchParams.get('tab') === tab.id;
  });
  await page.getByRole('button', { name: 'Close and stop work', exact: true }).click();
  await reconnect;
  await expect(terminalRow(page, tab.id).locator('.terminal-tab-button')).toHaveAttribute('aria-selected', 'true');
  expect((await emptyStartup.api('/api/state?tab=' + tab.id)).isStreaming).toBe(true);
  await emptyStartup.api('/api/abort?tab=' + tab.id, {});
  await expect(terminalRow(page, tab.id)).not.toHaveClass(/activity-working/);
  await expect(page.locator('#abortButton')).not.toBeVisible();
  expect((await emptyStartup.api('/api/tabs')).tabs.map(item => item.id)).toEqual([tab.id]);
  expect(await emptyStartup.starts()).toHaveLength(1);
});

test('navigation to a Draft during a delayed last-close response preserves the newer selection', async ({ page, emptyStartup }) => {
  const tab = await ready(page, emptyStartup);
  let release;
  let received;
  const released = new Promise(resolve => { release = resolve; });
  const pending = new Promise(resolve => { received = resolve; });
  await page.route('**/api/tabs/close', async route => {
    const response = await route.fetch();
    received();
    await released;
    await route.fulfill({ response });
  });
  try {
    await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
    await pending;
    await page.locator('.focused-brand').click();
    await page.locator('#promptInput').fill('New blank selected during close');
  } finally {
    release();
  }
  await expect(page.locator('#tabBar [data-tab-id]')).toHaveCount(0);
  await expect(page.locator('#promptInput')).toHaveValue('New blank selected during close');
  await page.locator('.focused-brand').click();
  await page.getByRole('tab', { name: 'Draft: New blank selected during close', exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue('New blank selected during close');
  expect((await emptyStartup.api('/api/tabs')).tabs).toEqual([]);
  expect(await emptyStartup.starts()).toHaveLength(1);
});

test('typing in the blank after last close and navigating away saves a reopenable Draft', async ({ page, emptyStartup }) => {
  const tab = await ready(page, emptyStartup);
  await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
  await expectEmpty(page, emptyStartup);
  const text = 'Draft written after closing the last terminal\nsecond line λ';
  await page.locator('#promptInput').fill(text);
  await page.locator('.focused-brand').click();
  await expect(page.locator('#promptInput')).toHaveValue('');
  const draft = page.getByRole('tab', { name: 'Draft: Draft written after closing the last terminal', exact: true });
  await expect(draft).toBeVisible();
  await draft.click();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  await page.reload();
  await expect(page.locator('#promptInput')).toHaveValue(text);
  expect((await emptyStartup.api('/api/tabs')).tabs).toEqual([]);
  expect(await emptyStartup.starts()).toHaveLength(1);
  expect(await emptyStartup.ownedDirectories()).toEqual([tab.noProjectId]);
});

test('closing the last project terminal preserves its directory and leaves a No Project blank', async ({ page, emptyStartup }) => {
  const tab = await ready(page, emptyStartup, { project: true });
  const marker = join(tab.cwd, 'project-retained.txt');
  await writeFile(marker, 'Project files survive');
  await terminalRow(page, tab.id).locator('.terminal-tab-close').click();
  await expectEmpty(page, emptyStartup);
  expect(await readFile(marker, 'utf8')).toBe('Project files survive');
  expect(await emptyStartup.ownedDirectories()).toEqual([]);
});
