import { writeFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';
import { navigateFocused } from './focused-navigation-fixture.mjs';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', video: 'off', reducedMotion: 'reduce', actionTimeout: 5_000 });
test.setTimeout(60_000);

const destinations = page => page.getByRole('navigation', { name: 'Workspace destinations' });
const plan = {
  requested: 'webui', transactionId: 'w7-webui-job', digest: '7'.repeat(64),
  active: { pi: '0.87.1', piRoot: '/fixture/pi', webui: '0.8.1', webuiRoot: '/fixture/webui' },
  pathPi: { eligible: true, version: '0.87.1', packageRoot: '/fixture/pi', executable: '/fixture/node', cli: '/fixture/pi/cli.js' },
  context: { shell: '/bin/bash', cwd: '/fixture/project', agentDir: '/fixture/agent', npmPrefix: '/fixture/prefix' },
  targets: ['npm-global', 'pi-user'].map(installation => ({
    id: `webui:${installation}`, packageName: 'Web UI', beforeVersion: '0.8.1',
    installedRoot: `/fixture/${installation}/webui`, effectRoot: `/fixture/${installation}`,
    command: { command: '/fixture/node', args: ['/fixture/updater', installation] },
  })),
  refusals: ['Project installations require manual maintenance.'],
  warning: 'Simulated plan only. Native lifecycle commands are never executed by this fixture.',
};

function partialJob() {
  return { transactionId: plan.transactionId, plan, phase: 'partial', outcome: 'partial', receipts: [
    { id: 'webui:npm-global', status: 'changed', stdout: 'W7 simulated npm receipt' },
    { id: 'webui:pi-user', status: 'failed', stderr: 'W7 simulated installation failure' },
  ], verifiedTargets: [{ id: 'webui:npm-global', status: 'healthy' }] };
}

async function mockUpdates(page, initialJob = null) {
  const state = { job: initialJob, writes: [], reads: [], discoveryError: '', networkAvailable: true };
  await page.route('**/api/update-status*', route => {
    if (!state.networkAvailable) return route.abort('internetdisconnected');
    state.reads.push('status');
    const running = state.job && !['partial', 'unknown', 'success', 'failed', 'unchanged'].includes(state.job.phase);
    return route.fulfill({ json: { ok: true, data: {
      // Leave the host permissive for partial results to verify the client gate itself.
      canRunUpdate: !running && state.job?.phase !== 'unknown', updateInProgress: !!running,
      nativeJobs: { pi: null, webui: state.job }, nativeJobDiscoveryError: state.discoveryError,
      pi: { checked: true, currentVersion: '0.87.1', latestVersion: '0.87.1' },
      webui: { checked: true, currentVersion: '0.8.1', latestVersion: '0.8.2', updateAvailable: true },
    } } });
  });
  await page.route('**/api/update/**', route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === 'GET' && pathname === `/api/update/transactions/${plan.transactionId}`) {
      if (!state.networkAvailable) return route.abort('internetdisconnected');
      state.reads.push(plan.transactionId);
      return route.fulfill({ json: { ok: true, data: state.job } });
    }
    state.writes.push({ pathname, body: request.postDataJSON() });
    if (pathname === '/api/update/plan') return route.fulfill({ status: 201, json: { ok: true, data: { plan } } });
    if (pathname === '/api/update/apply') {
      state.job = { transactionId: plan.transactionId, plan, phase: 'running', receipts: [], verifiedTargets: [] };
      return route.fulfill({ status: 202, json: { ok: true, data: { transactionId: plan.transactionId, phase: 'running' } } });
    }
    return route.fulfill({ status: 409, json: { ok: false, error: 'W7 forbids every unmocked update mutation' } });
  });
  return state;
}

async function openFocused(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
}

async function openSystem(page) {
  await navigateFocused(page, 'Settings');
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.locator('#serverActionSelect')).toBeVisible();
}

test('System update keeps its job through destination changes and a real browser disconnect/reconnect', async ({ page, context, ownership }, info) => {
  const state = await mockUpdates(page);
  const streams = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/events') streams.push(url.searchParams.get('tab'));
  });
  await openFocused(page, ownership);
  await expect.poll(() => streams.length).toBeGreaterThan(0);
  await page.locator('#promptInput').fill('update navigation retains the live draft');
  await page.evaluate(() => { window.w7Prompt = document.querySelector('#promptInput'); });
  const streamCount = streams.length;
  await openSystem(page);
  await page.locator('#serverActionSelect').selectOption('update-webui');
  await page.locator('#runServerActionButton').click();
  await expect(page.locator('#confirmationSummary')).toContainText('/fixture/npm-global/webui');
  await expect(page.locator('#confirmationSummary')).toContainText('/fixture/pi-user/webui');
  await expect(page.locator('#confirmationSummary')).toContainText('/fixture/updater');
  await page.locator('#confirmationConfirmButton').click();
  await expect(page.locator('#webuiVersionButton')).toHaveAttribute('data-update-state', 'running');
  await navigateFocused(page, 'Project');
  await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
  await page.locator('#fileTreeSearchInput').fill('retained project filter');
  expect(streams.length, 'Destination changes must retain the existing active-tab stream').toBe(streamCount);
  await expect(page.locator('#webuiVersionButton')).toHaveAttribute('data-update-state', 'running');
  try {
    state.networkAvailable = false;
    await context.setOffline(true);
    await page.locator('#fileTreeRefreshButton').click();
    await expect(page.locator('#serverOfflinePanel')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  await page.getByRole('button', { name: 'Retry connection', exact: true }).click();
  state.networkAvailable = true;
  await expect.poll(() => streams.length, { timeout: 15_000 }).toBeGreaterThan(streamCount);
  await expect(page.locator('#serverOfflinePanel')).toBeHidden();
  state.job = partialJob();
  await expect(page.locator('#webuiVersionButton')).toHaveAttribute('data-update-state', 'partial', { timeout: 12_000 });
  await expect.soft(page.locator('#fileTreeSearchInput'), 'Reconnect in the same tab must preserve the Project filter').toHaveValue('retained project filter');
  await openSystem(page);
  await page.locator('#webuiVersionButton').click();
  await expect(page.locator('#webuiComponentUpdateStatus')).toContainText(plan.transactionId);
  await expect(page.locator('#webuiComponentUpdateStatus')).toContainText('partial result');
  await expect(page.locator('#webuiComponentUpdateOutput')).toContainText('W7 simulated installation failure');
  await expect(page.locator('#webuiComponentUpdateOutput')).toContainText('verification healthy');
  await page.screenshot({ path: info.outputPath('system-update-reconnected-receipts.png') });
  await page.keyboard.press('Escape');
  await destinations(page).getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue('update navigation retains the live draft');
  expect(await page.evaluate(() => window.w7Prompt === document.querySelector('#promptInput'))).toBe(true);
  expect(streams.every(id => id === ownership.tabs[0].id)).toBe(true);
  expect(state.writes).toEqual([
    { pathname: '/api/update/plan', body: { targets: ['webui'] } },
    { pathname: '/api/update/apply', body: { transactionId: plan.transactionId, planDigest: plan.digest } },
  ]);
  const evidencePath = info.outputPath('update-and-stream-evidence.json');
  await writeFile(evidencePath, JSON.stringify({ ...state, streams }, null, 2));
  await info.attach('mock update requests and real stream targets', { path: evidencePath, contentType: 'application/json' });
});

for (const phase of ['unknown']) {
  test(`${phase} job survives reload and blocks a new plan from both version dialog and System`, async ({ page, ownership }, info) => {
    const state = await mockUpdates(page, { ...partialJob(), phase });
    await openFocused(page, ownership);
    await openSystem(page);
    await page.locator('#webuiVersionButton').click();
    await expect(page.locator('#webuiComponentUpdateStatus')).toContainText(plan.transactionId);
    await page.reload();
    await openSystem(page);
    await page.locator('#webuiVersionButton').click();
    await expect(page.locator('#webuiComponentUpdateStatus')).toContainText(phase === 'unknown' ? 'completion is unknown' : 'partial result');
    await expect(page.locator('#webuiComponentUpdateOutput')).toContainText('W7 simulated installation failure');
    await page.screenshot({ path: info.outputPath(`${phase}-recovered-job.png`) });
    await expect.soft(page.locator('#webuiComponentUpdateButton'), `${phase} receipts require recovery before a second plan`).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.locator('#serverActionSelect').selectOption('update-webui');
    await page.locator('#runServerActionButton').click();
    const evidencePath = info.outputPath('update-mutation-requests.json');
    await writeFile(evidencePath, JSON.stringify(state.writes, null, 2));
    await info.attach('update mutation requests', { path: evidencePath, contentType: 'application/json' });
    await expect.soft(page.locator('#confirmationDialog')).toBeHidden();
    expect(state.writes, `${phase} must prevent a new plan rather than merely blocking apply`).toEqual([]);
  });
}

test('partial results permit an explicit new preview without automatically retrying commands', async ({ page, ownership }) => {
  const state = await mockUpdates(page, partialJob());
  await openFocused(page, ownership);
  await openSystem(page);
  expect(state.writes).toEqual([]);
  await page.locator('#serverActionSelect').selectOption('update-webui');
  await page.locator('#runServerActionButton').click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  await page.locator('#confirmationCancelButton').click();
  expect(state.writes).toEqual([{ pathname: '/api/update/plan', body: { targets: ['webui'] } }]);
});

test('System restart reconnect rejects the old boot identity and retains the live draft', async ({ page, ownership }, info) => {
  const state = await mockUpdates(page, { ...partialJob(), phase: 'unknown' });
  const originalHealth = await (await page.request.get(`${ownership.baseURL}/api/health`)).json();
  let restarting = false;
  let oldBootReads = 0;
  let newBootReads = 0;
  let restartRequests = 0;
  let permitNewBoot = false;
  const changedBoot = '77777777-7777-4777-8777-777777777777';
  await page.route('**/api/health*', route => {
    const changed = restarting && permitNewBoot;
    if (restarting) changed ? newBootReads += 1 : oldBootReads += 1;
    return route.fulfill({ json: { ...originalHealth, bootIdentity: changed ? changedBoot : originalHealth.bootIdentity } });
  });
  await page.route('**/api/restart', route => {
    restartRequests += 1;
    restarting = true;
    return route.fulfill({ json: { ok: true, data: { restarting: true } } });
  });
  await openFocused(page, ownership);
  await page.locator('#promptInput').fill('same document restart draft');
  await page.evaluate(() => { window.w7Prompt = document.querySelector('#promptInput'); });
  await openSystem(page);
  await page.locator('#serverActionSelect').selectOption('restart');
  await page.locator('#runServerActionButton').click();
  await page.locator('#confirmationConfirmButton').click();
  await expect.poll(() => oldBootReads).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#serverActionStatus')).not.toContainText('Server restarted and reconnected.');
  permitNewBoot = true;
  await expect(page.locator('#serverActionStatus')).toContainText('Server restarted and reconnected.');
  expect(newBootReads).toBeGreaterThan(0);
  expect(restartRequests).toBe(1);
  await destinations(page).getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue('same document restart draft');
  expect(await page.evaluate(() => window.w7Prompt === document.querySelector('#promptInput'))).toBe(true);
  await page.screenshot({ path: info.outputPath('changed-boot-reconnect.png') });
  expect(state.writes).toEqual([]);
  const evidencePath = info.outputPath('boot-handshake.json');
  await writeFile(evidencePath, JSON.stringify({ oldBoot: originalHealth.bootIdentity, changedBoot, oldBootReads, newBootReads, restartRequests }, null, 2));
  await info.attach('simulated boot handshake', { path: evidencePath, contentType: 'application/json' });
});
