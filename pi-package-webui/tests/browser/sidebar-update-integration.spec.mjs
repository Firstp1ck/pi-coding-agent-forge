import { expect } from '@playwright/test';
import { test } from './empty-startup-fixture.mjs';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', video: 'off' });

const names = { all: 'Pi and extensions + WebUI', webui: 'WebUI only', pi: 'Pi only' };
const planFor = target => ({ requested: target, transactionId: `menu-${target}`, digest: 'fixture-preview-token',
  targets: [{ id: target, installedRoot: '/fixture/installed', command: { command: target === 'webui' ? 'npm' : 'pi',
    args: target === 'all' ? ['update', '--all'] : target === 'webui' ? ['update', '-g', '@firstpick/pi-package-webui'] : ['update'] } }], refusals: [] });

async function setup(page, fixture, { layout = 'focused', canRunUpdate = true, error = '' } = {}) {
  const requests = [], jobs = { all: null, pi: null, webui: null };
  const respond = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
  await page.route('**/api/update-status*', route => respond(route, {
    canRunUpdate, updateInProgress: Object.values(jobs).some(job => job?.phase === 'running'), nativeJobs: jobs,
    nativeJobDiscoveryError: '', pi: {}, webui: {},
  }));
  await page.route('**/api/update/plan', route => {
    const body = route.request().postDataJSON(); requests.push({ kind: 'plan', body });
    if (error) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error }) });
    return respond(route, { plan: planFor(body.targets[0]) }, 201);
  });
  await page.route('**/api/update/apply', route => {
    const body = route.request().postDataJSON(); requests.push({ kind: 'apply', body });
    const target = body.transactionId.replace('menu-', '');
    jobs[target] = { transactionId: body.transactionId, plan: planFor(target), phase: 'running', receipts: [] };
    return respond(route, { transactionId: body.transactionId, phase: 'running' }, 202);
  });
  await page.route('**/api/update/transactions/*', route => respond(route,
    Object.values(jobs).find(job => job?.transactionId === route.request().url().split('/').pop())));
  await page.addInitScript(layout => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: layout })), layout);
  await page.goto(fixture.baseURL);
  await expect(page.locator('#emptyStartTitle')).toBeVisible();
  if (layout === 'focused') {
    const gear = await page.locator('.terminal-settings-button').boundingBox();
    const update = await page.locator('#sidebarUpdateButton').boundingBox();
    expect(Math.abs(gear.y - update.y)).toBeLessThanOrEqual(1);
    expect(update.x).toBeGreaterThan(gear.x);
  }
  await page.locator('#sidebarUpdateButton').click();
  await expect(page.getByRole('menuitem').filter({ hasText: names.all })).toBeVisible();
  return { requests, jobs };
}

for (const target of Object.keys(names)) test(`${target} previews commands, cancels without apply, then reports completion`, async ({ page, emptyStartup }, info) => {
  const { requests, jobs } = await setup(page, emptyStartup);
  const choice = () => page.getByRole('menuitem').filter({ hasText: names[target] });
  await choice().click();
  await expect(page.locator('#confirmationSummary')).toContainText('/fixture/installed');
  await expect(page.locator('#confirmationSummary')).toContainText('Restart Web UI');
  await page.locator('#confirmationCancelButton').click();
  expect(requests).toEqual([{ kind: 'plan', body: { targets: [target] } }]);
  await page.locator('#sidebarUpdateButton').click();
  await choice().click();
  await page.locator('#confirmationConfirmButton').click();
  await expect.poll(() => requests.filter(item => item.kind === 'apply').length).toBe(1);
  expect(requests.at(-1).body).toEqual({ transactionId: `menu-${target}`, planDigest: 'fixture-preview-token' });
  await page.locator('#sidebarUpdateButton').click();
  await expect(choice()).toBeDisabled();
  jobs[target] = { ...jobs[target], phase: 'success', receipts: [{ id: target, status: 'success', stdout: 'fixture completed' }] };
  await expect(choice()).toBeEnabled({ timeout: 10_000 });
  await expect(page.locator('.sidebar-update-menu-status').filter({ hasText: 'update commands completed' })).toBeVisible();
  if (target === 'all') {
    const path = info.outputPath('sidebar-updates-completed.png');
    await page.screenshot({ path });
    await info.attach('Update menu with completion feedback', { path, contentType: 'image/png' });
  }
  expect(await emptyStartup.starts()).toEqual([]);
});

test('missing installation feedback is visible in the menu and launches no command', async ({ page, emptyStartup }, info) => {
  const { requests } = await setup(page, emptyStartup, { error: 'WebUI was not found in Pi or global npm installations.' });
  await page.getByRole('menuitem').filter({ hasText: names.webui }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.locator('#sidebarUpdateButton').click();
  await expect(page.locator('.sidebar-update-menu-status').filter({ hasText: 'WebUI was not found in Pi or global npm installations.' })).toBeVisible();
  await expect(page.locator('#confirmationDialog')).toBeHidden();
  expect(requests.every(item => item.kind === 'plan')).toBe(true);
  const path = info.outputPath('sidebar-updates-missing.png');
  await page.screenshot({ path });
  await info.attach('Missing installation feedback', { path, contentType: 'image/png' });
});

test('remote update restriction disables actions while keeping menu readable', async ({ page, emptyStartup }) => {
  const { requests } = await setup(page, emptyStartup, { canRunUpdate: false });
  for (const name of Object.values(names)) await expect(page.getByRole('menuitem').filter({ hasText: name })).toBeDisabled();
  await expect(page.getByText('Updates can only be started from localhost.')).toBeVisible();
  expect(requests).toEqual([]);
});

test('Classic navigation retains the same update actions and keyboard dismissal', async ({ page, emptyStartup }, info) => {
  const { requests } = await setup(page, emptyStartup, { layout: 'classic' });
  await expect(page.locator('#sidebarUpdateButton')).not.toHaveCount(0);
  for (const name of Object.values(names)) await expect(page.getByRole('menuitem').filter({ hasText: name })).toBeVisible();
  const path = info.outputPath('sidebar-updates-classic.png');
  await page.screenshot({ path });
  await info.attach('Classic update actions', { path, contentType: 'image/png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('#sidebarUpdateButton')).toBeFocused();
  expect(requests).toEqual([]);
});
