import { expect } from '@playwright/test';
import { test } from './empty-startup-fixture.mjs';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', video: 'off' });

const names = { all: 'Pi and extensions + WebUI', webui: 'WebUI only', pi: 'Pi only' };
const planFor = target => ({ requested: target, transactionId: `menu-${target}`, digest: 'fixture-preview-token',
  targets: [{ id: target, installedRoot: '/fixture/installed', command: { command: target === 'webui' ? 'npm' : 'pi',
    args: target === 'all' ? ['update', '--all'] : target === 'webui' ? ['update', '-g', '@firstpick/pi-package-webui'] : ['update'] } }], refusals: [] });

async function setup(page, fixture, { layout = 'focused', canRunUpdate = true, error = '', applyGate = null, invalidPlan = false } = {}) {
  const requests = [], jobs = { all: null, pi: null, webui: null };
  const respond = (route, data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ ok: true, data }) });
  await page.route('**/api/update-status*', route => respond(route, {
    canRunUpdate, updateInProgress: Object.values(jobs).some(job => job?.phase === 'running'), nativeJobs: jobs,
    nativeJobDiscoveryError: '', pi: {}, webui: {},
  }));
  await page.route('**/api/update/plan', route => {
    const body = route.request().postDataJSON(); requests.push({ kind: 'plan', body });
    if (error) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ ok: false, error }) });
    return respond(route, { plan: invalidPlan ? { ...planFor(body.targets[0]), digest: '' } : planFor(body.targets[0]) }, 201);
  });
  await page.route('**/api/update/apply', async route => {
    const body = route.request().postDataJSON(); requests.push({ kind: 'apply', body });
    const target = body.transactionId.replace('menu-', '');
    jobs[target] = { transactionId: body.transactionId, plan: planFor(target), phase: 'running', receipts: [] };
    if (applyGate) await applyGate;
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

for (const target of Object.keys(names)) test(`${target} starts its discovered plan once without confirmation, then reports completion`, async ({ page, emptyStartup }, info) => {
  const { requests, jobs } = await setup(page, emptyStartup);
  const choice = () => page.getByRole('menuitem').filter({ hasText: names[target] });
  await choice().click();
  await expect(page.locator('#confirmationDialog')).toBeHidden();
  await expect.poll(() => requests.filter(item => item.kind === 'apply').length).toBe(1);
  expect(requests.at(-1).body).toEqual({ transactionId: `menu-${target}`, planDigest: 'fixture-preview-token' });
  await page.locator('#sidebarUpdateButton').click();
  await expect(choice()).toBeDisabled();
  jobs[target] = { ...jobs[target], phase: 'success', receipts: [{ id: target, status: 'success', stdout: 'fixture completed' }] };
  await expect(choice()).toBeEnabled({ timeout: 10_000 });
  await expect(page.locator('.sidebar-update-menu-status').filter({ hasText: 'Update commands completed' })).toBeVisible();
  await expect(page.locator('.sidebar-update-menu-status').filter({ hasText: 'Update commands completed' })).not.toContainText(`menu-${target}`);
  if (target === 'all') {
    await page.getByRole('button', { name: 'Back to progress', exact: true }).click();
    await page.getByRole('button', { name: 'Details', exact: true }).click();
    await expect(page.getByLabel('Command results', { exact: true })).not.toContainText('menu-all');
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

for (const target of ['pi', 'all']) test(`${target} feedback replaces an older partial WebUI result`, async ({ page, emptyStartup }) => {
  const { jobs } = await setup(page, emptyStartup);
  jobs.webui = { transactionId: 'old-webui', plan: planFor('webui'), phase: 'partial',
    receipts: [{ id: 'webui', status: 'failed', stderr: 'old WebUI output' }] };
  await page.keyboard.press('Escape');
  await page.locator('#sidebarUpdateButton').click();
  await expect(page.locator('.sidebar-update-menu-status')).toContainText('Some commands completed; others failed.');
  await page.getByRole('menuitem').filter({ hasText: names[target] }).click();
  await page.locator('#sidebarUpdateButton').click();
  const status = page.locator('.sidebar-update-menu-status');
  await expect(status).toContainText(target === 'all' ? 'Pi, extensions and Web UI:' : 'Pi:');
  await expect(status).not.toContainText(`menu-${target}`);
  await expect(status).not.toContainText('old WebUI output');
  jobs[target] = { ...jobs[target], phase: 'failed', receipts: [{ id: target, status: 'failed', stderr: 'new command error' }] };
  await expect(status).toContainText('The update command failed.', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Back to progress' }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByLabel('Command results', { exact: true })).toContainText('new command error');
  await expect(status).not.toContainText('old WebUI output');
});

for (const outcome of ['unchanged', 'failed']) test(`persistent progress starts before apply responds and reports ${outcome}`, async ({ page, emptyStartup }, info) => {
  let releaseApply;
  const applyGate = new Promise(resolve => { releaseApply = resolve; });
  const { requests, jobs } = await setup(page, emptyStartup, { applyGate });
  await page.getByRole('menuitem').filter({ hasText: names.webui }).click();
  try {
    await expect(page.locator('.sidebar-update-progress-track')).toBeVisible();
    await expect(page.getByRole('menu', { name: 'Updates', exact: true })).toBeHidden();
    await expect(page.locator('#sidebarUpdateButton')).toHaveAttribute('aria-busy', 'true');
    expect(requests.filter(item => item.kind === 'apply')).toHaveLength(1);
  } finally {
    releaseApply();
  }
  const startedAt = new Date(Date.now() - 15_000).toISOString();
  jobs.webui = { ...jobs.webui, progress: { totalSteps: 2, completedSteps: 0,
    currentTargetId: 'webui:pi-user', startedAt, stepStartedAt: startedAt, stdout: 'Fetching package metadata', stderr: '' } };
  await expect.poll(() => page.locator('body').innerText()).toContain('Fetching package metadata');
  const progress = page.locator('.sidebar-update-progress-track');
  await expect(progress).toBeVisible();
  await expect.poll(async () => Number((await progress.getAttribute('aria-label')).match(/Estimated (\d+)/)?.[1])).toBeGreaterThan(0);
  expect(Number((await progress.getAttribute('aria-label')).match(/Estimated (\d+)/)?.[1])).toBeLessThan(100);
  await expect.poll(() => page.locator('body').innerText()).toMatch(/estimat/i);
  jobs.webui.progress = { ...jobs.webui.progress, completedSteps: 1, currentTargetId: 'webui:npm-global', stepStartedAt: new Date().toISOString(), stdout: 'Checking global WebUI' };
  await expect.poll(() => page.locator('body').innerText()).toContain('Checking global WebUI');
  if (outcome === 'unchanged') {
    await page.reload();
    await expect.poll(() => page.locator('body').innerText()).toContain('Checking global WebUI');
    await expect(page.locator('.sidebar-update-progress-track')).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('update-progress-running.png') });
  jobs.webui = { ...jobs.webui, phase: outcome, restartRequired: false,
    progress: { ...jobs.webui.progress, completedSteps: 2, currentTargetId: null },
    receipts: [{ id: 'webui', status: outcome, stdout: outcome === 'unchanged' ? 'up to date in 1s' : '', stderr: outcome === 'failed' ? 'fixture download failed' : '' }] };
  await expect(page.locator('.sidebar-update-progress')).toHaveAttribute('data-state', outcome);
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByLabel('Command results', { exact: true })).toContainText(outcome === 'unchanged' ? 'up to date in 1s' : 'fixture download failed');
  await expect(page.locator('#sidebarUpdateButton')).toHaveAttribute('aria-busy', 'false');
  expect(requests.filter(item => item.kind === 'apply')).toHaveLength(1);
  await page.screenshot({ path: info.outputPath(`update-progress-${outcome}.png`) });
});

for (const responseOrder of ['status-before-apply', 'status-after-apply', 'apply-error']) test(`selected job survives older status: ${responseOrder}`, async ({ page, emptyStartup }, info) => {
  const { jobs, requests } = await setup(page, emptyStartup);
  const oldJob = { transactionId: 'previous-webui', plan: { ...planFor('webui'), transactionId: 'previous-webui' },
    phase: 'unchanged', receipts: [{ id: 'webui', status: 'unchanged', stdout: 'Previous run was up to date' }] };
  jobs.webui = oldJob;
  let releaseApply, releaseStatus;
  const applyGate = new Promise(resolve => { releaseApply = resolve; });
  const statusGate = new Promise(resolve => { releaseStatus = resolve; });
  await page.route('**/api/update/apply', async route => {
    const body = route.request().postDataJSON();
    requests.push({ kind: 'apply', body });
    await applyGate;
    if (responseOrder === 'apply-error') return route.fulfill({ status: 503, json: { ok: false, error: 'Launch reply unavailable' } });
    const startedAt = new Date().toISOString();
    jobs.webui = { transactionId: body.transactionId, plan: planFor('webui'), phase: 'running', receipts: [],
      progress: { startedAt, stepStartedAt: startedAt, totalSteps: 1, completedSteps: 0, currentTargetId: 'webui:npm-global', stdout: 'New command running', stderr: '' } };
    return route.fulfill({ status: 202, json: { ok: true, data: { transactionId: body.transactionId, phase: 'running' } } });
  });
  await page.getByRole('menuitem').filter({ hasText: names.webui }).click();
  const card = page.locator('.sidebar-update-progress');
  await expect(card).toHaveAttribute('data-state', 'launching');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  let statusRequested = false;
  await page.route('**/api/update-status*', async route => {
    statusRequested = true;
    await statusGate;
    return route.fulfill({ json: { ok: true, data: { canRunUpdate: true, updateInProgress: false,
      nativeJobs: { all: null, pi: null, webui: oldJob }, nativeJobDiscoveryError: '', pi: {}, webui: {} } } });
  }, { times: 1 });
  try {
    const statusResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/update-status');
    await page.locator('#sidebarUpdateButton').click();
    await expect.poll(() => statusRequested).toBe(true);
    if (responseOrder === 'status-after-apply') {
      releaseApply();
      await expect(page.locator('.sidebar-update-menu-status')).toContainText('Step 1 of 1');
    }
    releaseStatus();
    await statusResponse;
    await page.keyboard.press('Escape');
    await expect(card).toHaveAttribute('data-state', responseOrder === 'status-after-apply' ? 'running' : 'launching');
    await expect(card).not.toContainText('Previous run was up to date');
    await expect(card).toHaveAttribute('data-details', 'true');
    releaseApply();
    if (responseOrder === 'apply-error') {
      await expect(card).toHaveAttribute('data-state', 'unknown');
      await expect(card).toContainText('Launch reply unavailable');
    } else {
      await expect(card).toHaveAttribute('data-state', 'running');
      await expect(card).toContainText('New command running', { timeout: 10_000 });
    }
    expect(requests.filter(item => item.kind === 'apply')).toEqual([{ kind: 'apply', body: { transactionId: 'menu-webui', planDigest: 'fixture-preview-token' } }]);
    await page.screenshot({ path: info.outputPath(`${responseOrder}.png`) });
  } finally { releaseApply(); releaseStatus(); }
});

for (const kind of ['rejected', 'invalid']) test(`${kind} discovery never applies`, async ({ page, emptyStartup }) => {
  const { requests } = await setup(page, emptyStartup, kind === 'rejected' ? { error: 'Discovery refused' } : { invalidPlan: true });
  await page.getByRole('menuitem').filter({ hasText: names.pi }).click();
  await page.locator('#sidebarUpdateButton').click();
  await expect(page.locator('.sidebar-update-menu-status')).toContainText(kind === 'rejected' ? 'Discovery refused' : 'no command was launched');
  expect(requests.map(item => item.kind)).toEqual(['plan']);
  await expect(page.locator('#confirmationDialog')).toBeHidden();
});

test('partial EROFS is concise; Details follows the running job and preserves output safely', async ({ page, emptyStartup }, info) => {
  const { jobs, requests } = await setup(page, emptyStartup);
  await page.getByRole('menuitem').filter({ hasText: names.all }).click();
  await expect.poll(() => requests.filter(item => item.kind === 'apply').length).toBe(1);
  const startedAt = new Date().toISOString();
  jobs.all = { ...jobs.all, plan: { ...jobs.all.plan, targets: [...jobs.all.plan.targets, ...planFor('webui').targets] },
    receipts: [{ id: 'all', status: 'success', exitCode: 0, stdout: 'Updated disposable Pi and extensions' }],
    progress: { totalSteps: 2, completedSteps: 1, currentTargetId: 'webui', startedAt, stepStartedAt: startedAt,
      stdout: 'Updating disposable WebUI installation', stderr: '' } };
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  const results = page.getByLabel('Command results', { exact: true });
  await expect(results).toContainText('"pi" "update" "--all"');
  await expect(results).toContainText('webui: running', { timeout: 10_000 });
  await expect(page.getByRole('button', { name: 'Back to progress' })).toBeFocused();
  await page.screenshot({ path: info.outputPath('running-details-back.png') });
  jobs.all = { ...jobs.all, phase: 'partial', restartRequired: false, receipts: [
    { id: 'all', status: 'success', exitCode: 0, stdout: 'Updated disposable Pi and extensions' },
    { id: 'webui', status: 'failed', exitCode: 1, stderr: 'npm error code EROFS\nnpm error rename <img src=x onerror=alert(1)>', error: 'EROFS' },
  ] };
  await expect(results).toContainText('webui: failed · exit 1', { timeout: 10_000 });
  await expect(page.locator('.sidebar-update-progress')).toHaveAttribute('data-details', 'true');
  await expect(page.locator('.sidebar-update-progress-result')).toContainText('The installation is read-only. Run the update outside the preview or sandbox.');
  await expect(page.locator('.sidebar-update-progress img')).toHaveCount(0);
  await expect(results).toContainText('<img src=x onerror=alert(1)>');
  await page.screenshot({ path: info.outputPath('partial-erofs-details.png') });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeFocused();
  const compact = page.locator('.sidebar-update-progress');
  expect(await compact.innerText()).not.toContain('npm error rename');
  await expect(compact.locator('.sidebar-update-progress-output')).toBeHidden();
  await page.screenshot({ path: info.outputPath('partial-erofs-compact.png') });
  await page.locator('#sidebarUpdateButton').click();
  await page.getByRole('button', { name: 'Back to progress' }).click();
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeFocused();
  expect(requests.filter(item => item.kind === 'apply')).toHaveLength(1);
});

test('read-only guidance requires failed command output', async ({ page, emptyStartup }) => {
  const { jobs } = await setup(page, emptyStartup);
  await page.getByRole('menuitem').filter({ hasText: names.pi }).click();
  await expect.poll(() => jobs.pi?.transactionId).toBe('menu-pi');
  jobs.pi = { ...jobs.pi, phase: 'partial', error: 'EROFS', receipts: [{ id: 'pi', status: 'success', stdout: 'EROFS warning only' }] };
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar-update-progress')).toHaveAttribute('data-state', 'partial', { timeout: 10_000 });
  await expect(page.locator('.sidebar-update-progress-result')).not.toContainText('read-only');
});
