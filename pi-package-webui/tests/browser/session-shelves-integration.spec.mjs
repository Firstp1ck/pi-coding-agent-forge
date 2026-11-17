import { navigateFocused } from './focused-navigation-fixture.mjs';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

const body = (page, section) => page.locator(`[data-session-shelf-body="${section}"]`);
const header = (page, section) => page.locator(`[data-session-shelf-toggle="${section}"]`);
const row = (page, id) => page.locator(`#tabBar [data-tab-id="${id}"]`);

async function ready(page, ownership, preferences = {}) {
  await page.addInitScript(prefs => {
    if (!localStorage.getItem('pi-webui-shell-preferences-v1')) localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', ...prefs }));
  }, preferences);
  await page.goto(ownership.baseURL);
  await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
  await expect(body(page, 'inbox')).toBeVisible();
}

async function settle(page, id) {
  await row(page, id).locator('[data-settlement-action="settle"]').click();
  await expect(body(page, 'settled').locator(`[data-tab-id="${id}"]`)).toHaveCount(1);
}

test('Settle and Restore organize sessions without stopping them or discarding drafts', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const first = ownership.tabs[0];
  const mutations = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/(abort|close|tabs)/.test(new URL(request.url()).pathname)) mutations.push(request.url());
  });
  await page.locator('#promptInput').fill('Keep my unfinished draft');
  await expect(header(page, 'inbox')).toContainText('2');
  await expect(header(page, 'settled')).toHaveAttribute('aria-expanded', 'false');
  await settle(page, first.id);
  await expect(header(page, 'settled')).toBeFocused();
  await expect(body(page, 'settled')).toBeHidden();
  await expect(page.locator('#promptInput')).toHaveValue('Keep my unfinished draft');
  await header(page, 'settled').press('Enter');
  await expect(body(page, 'settled')).toBeVisible();
  await page.screenshot({ path: info.outputPath('shelves-desktop.png') });
  await page.reload();
  await expect(body(page, 'settled')).toBeVisible();
  await expect(row(page, first.id).locator('[data-settlement-action="restore"]')).toBeVisible();
  await row(page, first.id).locator('[data-settlement-action="restore"]').click();
  await expect(body(page, 'inbox').locator(`[data-tab-id="${first.id}"]`)).toHaveCount(1);
  expect(mutations).toEqual([]);
  expect((await ownership.api('/api/tabs')).tabs.find(tab => tab.id === first.id).running).toBe(true);
  await expect(page.locator('#newTabButton')).toBeVisible();
  await navigateFocused(page, 'Settings');
  await page.locator('[data-scheme-mode="light"]').click();
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.screenshot({ path: info.outputPath('shelves-light.png') });
});

test('background input wakes a settled session into Inbox and preserves approval routing', async ({ page, ownership }) => {
  await ready(page, ownership);
  const background = ownership.tabs[1];
  await settle(page, background.id);
  await ownership.api('/api/prompt?tab=' + background.id, { message: 'fixture mobile blocker', requestId: 'shelves-blocker-12345678' });
  await expect(body(page, 'inbox').locator(`[data-tab-id="${background.id}"]`)).toHaveCount(1, { timeout: 16_000 });
  await expect(row(page, background.id).locator('[data-settlement-action="settle"]')).toBeDisabled();
  await row(page, background.id).locator('.terminal-tab-button').click();
  await expect(page.locator('#extensionDialog')).toBeVisible();
  await page.locator('#extensionDialog').getByRole('button', { name: 'Yes', exact: true }).click();
});

test('work wakes a settled session and completed work returns to Inbox without being consumed', async ({ page, ownership }, info) => {
  const finished = (await ownership.api('/api/tabs', {})).tab;
  await ready(page, ownership);
  await settle(page, finished.id);
  const background = ownership.tabs[1];
  await settle(page, background.id);
  await ownership.api('/api/prompt?tab=' + background.id, { message: 'fixture continuity held stream', requestId: 'shelves-stream-12345678' });
  await expect(body(page, 'working').locator(`[data-tab-id="${background.id}"]`)).toHaveCount(1, { timeout: 16_000 });
  await expect(row(page, background.id).locator('[data-settlement-action="settle"]')).toBeDisabled();
  await page.screenshot({ path: info.outputPath('shelves-working.png') });
  await ownership.api('/api/abort?tab=' + background.id, {});
  await expect(body(page, 'inbox').locator(`[data-tab-id="${background.id}"]`)).toHaveCount(1, { timeout: 16_000 });
  await expect(body(page, 'settled').locator(`[data-tab-id="${background.id}"]`)).toHaveCount(0);
});

test('completion while the browser is away clears settlement on reload', async ({ page, ownership }) => {
  await ready(page, ownership);
  const background = ownership.tabs[1];
  await settle(page, background.id);
  await page.goto('about:blank');
  await ownership.api('/api/prompt?tab=' + background.id, { message: 'fixture continuity delayed stream', requestId: 'shelves-offline-12345678' });
  await expect.poll(async () => (await ownership.api('/api/tabs')).tabs.find(tab => tab.id === background.id)?.activity?.completionSerial, { timeout: 16_000 }).toBeGreaterThan(0);
  await page.goto(ownership.baseURL);
  await expect(body(page, 'inbox').locator(`[data-tab-id="${background.id}"]`)).toHaveCount(1);
  await expect(body(page, 'settled').locator('[data-tab-id]')).toHaveCount(0);
});

test('shelves preserve unique grouped members and restore Classic, top and phone layouts', async ({ page, ownership }, info) => {
  await ready(page, ownership);
  const [first, second] = ownership.tabs;
  await row(page, first.id).dragTo(row(page, second.id));
  await expect(page.locator('#tabBar [data-custom-group-id]')).toHaveCount(1);
  await settle(page, second.id);
  await header(page, 'settled').click();
  const fragments = page.locator('#tabBar [data-custom-group-id]');
  await expect(fragments).toHaveCount(2);
  expect(new Set(await fragments.evaluateAll(nodes => nodes.map(node => node.dataset.customGroupId))).size).toBe(1);
  await expect(row(page, first.id)).toHaveCount(1);
  await expect(row(page, second.id)).toHaveCount(1);
  await expect(body(page, 'settled').locator('.terminal-tab-group-close')).toHaveAccessibleName(/sessions in Settled/);
  const ids = await page.locator('#tabBar [id]').evaluateAll(nodes => nodes.map(node => node.id));
  expect(new Set(ids).size).toBe(ids.length);
  await page.setViewportSize({ width: 1100, height: 750 });
  await page.screenshot({ path: info.outputPath('shelves-narrow-group.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(ownership.baseURL + '/?shell=classic');
  await expect(page.locator('.session-shelves')).toHaveCount(0);
  await expect(page.locator('#tabBar [data-custom-group-id]')).toHaveCount(1);
  await page.evaluate(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', navigation: 'top' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-navigation', 'top');
  await expect(page.locator('.session-shelves')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(ownership.baseURL + '/?mobileShell=v2');
  await expect(page.locator('.session-shelves')).toHaveCount(0);
});

test('long sidebar lists scroll without visible scrollbar tracks and keep keyboard targets reachable', async ({ page, ownership }, info) => {
  for (let index = 0; index < 6; index += 1) await ownership.api('/api/tabs', {});
  await page.setViewportSize({ width: 1440, height: 500 });
  await ready(page, ownership);
  const list = page.locator('.session-shelves');
  await expect(body(page, 'inbox').locator('[data-tab-id]')).toHaveCount(8);
  await expect(list).toHaveCSS('scrollbar-width', 'none');
  await expect(page.locator('.focused-navigation')).toHaveCSS('scrollbar-width', 'none');
  await expect.poll(() => list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await list.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await header(page, 'settled').focus();
  const viewport = await list.boundingBox();
  const target = await header(page, 'settled').boundingBox();
  expect(target.y).toBeGreaterThanOrEqual(viewport.y - 1);
  expect(target.y + target.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
  await header(page, 'settled').press('Space');
  await expect(header(page, 'settled')).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  const after = await header(page, 'settled').boundingBox();
  expect(after.y + after.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1);
  await page.screenshot({ path: info.outputPath('shelves-scrollbar-hidden.png') });
});


test('replacing the conversation in a settled tab restores its current sidebar identity', async ({ page, ownership }) => {
  await ready(page, ownership);
  const first = ownership.tabs[0];
  await settle(page, first.id);
  await page.locator('#composerActionsButton').click();
  await page.locator('#newSessionButton').click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  await page.locator('#confirmationConfirmButton').click();
  await expect(body(page, 'inbox').locator(`[data-tab-id="${first.id}"]`)).toHaveCount(1);
  await expect(body(page, 'settled').locator('[data-tab-id]')).toHaveCount(0);
});

test('closing a group fragment closes only its visible members and preserves the other shelf draft', async ({ page, ownership }) => {
  await ready(page, ownership);
  const [first, second] = ownership.tabs;
  await page.locator('#promptInput').fill('Keep the other group member');
  await row(page, first.id).dragTo(row(page, second.id));
  await settle(page, second.id);
  await header(page, 'settled').click();
  const closed = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/tabs/close');
  await body(page, 'settled').locator('.terminal-tab-group-close').click();
  expect((await closed).postDataJSON().ids).toEqual([second.id]);
  await expect(body(page, 'settled').locator('[data-tab-id]')).toHaveCount(0);
  await expect(body(page, 'inbox').locator(`[data-tab-id="${first.id}"]`)).toHaveCount(1);
  await expect(page.locator('#promptInput')).toHaveValue('Keep the other group member');
  expect((await ownership.api('/api/tabs')).tabs.map(tab => tab.id)).toEqual([first.id]);
});

test('focused session remains visible when background work moves it between overflowing shelves', async ({ page, ownership }) => {
  test.setTimeout(45_000);
  for (let index = 0; index < 6; index += 1) await ownership.api('/api/tabs', {});
  await page.setViewportSize({ width: 1440, height: 600 });
  await ready(page, ownership);
  const background = ownership.tabs[1];
  const control = row(page, background.id).locator('.terminal-tab-button');
  await control.focus();
  await expect(control).toBeFocused();
  await ownership.api('/api/prompt?tab=' + background.id, { message: 'fixture continuity held stream', requestId: 'shelves-visible-focus-12345678' });
  await expect(body(page, 'working').locator(`[data-tab-id="${background.id}"]`)).toHaveCount(1, { timeout: 16_000 });
  await expect(control).toBeFocused();
  await expect(control).toBeInViewport({ ratio: 1 });
  await ownership.api('/api/abort?tab=' + background.id, {});
  await expect(body(page, 'inbox').locator(`[data-tab-id="${background.id}"]`)).toHaveCount(1, { timeout: 16_000 });
  await expect(control).toBeFocused();
  await expect(control).toBeInViewport({ ratio: 1 });
});

test('metadata refresh preserves deliberate wheel scrolling away from retained focus', async ({ page, ownership }, info) => {
  for (let index = 0; index < 6; index += 1) await ownership.api('/api/tabs', {});
  await page.setViewportSize({ width: 1440, height: 600 });
  await ready(page, ownership);
  const list = page.locator('.session-shelves');
  const control = row(page, ownership.tabs[1].id).locator('.terminal-tab-button');
  await control.focus();
  await list.hover();
  await page.mouse.wheel(0, 600);
  await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(200);
  await expect(control).toBeFocused();
  const before = await list.evaluate(node => node.scrollTop);
  const snapshot = await ownership.api('/api/tabs');
  const last = snapshot.tabs.at(-1);
  last.title = 'Title refresh without moving sessions';
  await page.route('**/api/tabs', route => route.fulfill({ json: { ok: true, data: snapshot } }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(row(page, last.id).locator('.terminal-tab-title')).toHaveText(last.title);
  await expect(control).toBeFocused();
  expect(await list.evaluate(node => node.scrollTop)).toBe(before);
  await page.screenshot({ path: info.outputPath('wheel-position-preserved.png') });
});
