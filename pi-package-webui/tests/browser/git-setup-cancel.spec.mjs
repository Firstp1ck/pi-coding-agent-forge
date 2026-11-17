import { expect } from '@playwright/test';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { test as startupTest } from './empty-startup-fixture.mjs';

const setupKey = 'pi-webui-git-footer-status-setup';
const usernamePrompt = 'git-footer-status-setup: GitHub username for origin remotes';

const test = startupTest.extend({
  gitSetup: async ({ page, emptyStartup }, use) => {
    const fixture = emptyStartup;
    const wrapper = join(fixture.root, 'fake-wrapper.mjs');
    // Publish the real footer extension event through fake Pi. The app still
    // owns the footer click, native prompt, validation and workflow actions.
    await writeFile(wrapper, `${await readFile(wrapper, 'utf8')}
const { createInterface } = await import('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const command = JSON.parse(line);
  if (command.type !== 'get_state') return;
  process.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'git-setup-footer', method: 'setStatus', statusKey: 'git-footer-webui', statusText: JSON.stringify({
    type: 'firstpick.git-footer-status.footer', version: 1,
    meta: [{ key: 'git', label: 'git', value: 'no repo' }], visibility: {},
  }) }) + '\\n');
});
`);
    const projects = [join(fixture.root, 'original-project'), join(fixture.root, 'other-project')];
    for (const cwd of projects) await mkdir(cwd);
    const tabs = [];
    for (const [index, cwd] of projects.entries()) {
      tabs.push((await fixture.api('/api/tabs', { cwd, title: `Git target ${index + 1}` })).tab);
    }
    await page.route('**/app.js?*', async route => {
      const response = await route.fetch();
      // Module-local state is exposed only in this test response, to seed
      // preexisting workflows and inspect ownership without production hooks.
      await route.fulfill({ response, body: `${await response.text()}
window.gitSetupTest = {
  snapshot: tabId => structuredClone(gitWorkflowForTab(tabId, { create: false })),
  seed: (tabId, patch) => { setGitWorkflow(patch, { tabId }); },
  switchTab,
  refreshTabs,
  reset: resetGitWorkflowForTab,
  layoutSettled: () => durableLayoutRevision !== null && durableLayoutSaveTimer === null && !durableLayoutSaveInFlight && durableLayoutDirtyFields.size === 0,
};
` });
    });
    const external = [];
    await page.route('**/*', async route => {
      if (new URL(route.request().url()).origin === fixture.baseURL) return route.fallback();
      external.push(route.request().url());
      await route.abort();
    });
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
    await page.goto(`${fixture.baseURL}/?tab=${tabs[0].id}`);
    await expect(page.locator('#promptInput')).toBeEditable();
    await expect(page.locator('#statusBar .footer-branch.footer-meta-action')).toBeVisible();
    await expect.poll(async () => !!JSON.parse(await readFile(join(fixture.root, 'settings.json'), 'utf8')).gitWorkflow).toBe(true);
    await page.waitForFunction(() => window.gitSetupTest.layoutSettled());
    const mutations = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (request.method() !== 'GET' && /\/api\/(?:git-workflow|settings|interface-preferences|prompt)(?:\/|$)/.test(url.pathname)) {
        if (url.pathname === '/api/prompt' && /^\/git-footer-refresh(?:\s|$)/.test(request.postDataJSON()?.message || '')) return;
        mutations.push({ path: url.pathname, tab: url.searchParams.get('tab'), body: request.postDataJSON() });
      }
    });
    await use({ ...fixture, tabs, mutations });
    expect(external).toEqual([]);
  },
});

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, actionTimeout: 8000 });
test.setTimeout(60_000);

const footer = page => page.locator('#statusBar .footer-branch.footer-meta-action');
const snapshot = (page, tab) => page.evaluate(id => window.gitSetupTest.snapshot(id), tab.id);
const seed = (page, tab, patch) => page.evaluate(({ id, patch }) => window.gitSetupTest.seed(id, patch), { id: tab.id, patch });

async function respondToPrompt(page, action, value = null, message = usernamePrompt) {
  const handled = page.waitForEvent('dialog', { timeout: 8000 }).then(async dialog => {
    expect(dialog.type()).toBe('prompt');
    expect(dialog.message()).toBe(message);
    if (value === null) await dialog.dismiss();
    else await dialog.accept(value);
  });
  await Promise.all([action(), handled]);
}

async function settings(page, fixture) {
  return {
    server: await readFile(join(fixture.root, 'settings.json'), 'utf8'),
    browser: await page.evaluate(key => localStorage.getItem(key), setupKey),
    files: await Promise.all(fixture.tabs.map(tab => readdir(tab.cwd))),
  };
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, fullPage: true });
  await info.attach(name, { path, contentType: 'image/png' });
}

for (const width of [1440, 390]) test(`native username Cancel ends initial setup at ${width}px`, async ({ page, gitSetup }, info) => {
  await page.setViewportSize({ width, height: 900 });
  if (width === 390) {
    await page.getByRole('button', { name: 'Show Git footer details', exact: true }).click();
    await expect(footer(page)).toBeVisible();
  }
  await page.waitForFunction(() => window.gitSetupTest.layoutSettled());
  gitSetup.mutations.length = 0;
  const before = await settings(page, gitSetup);
  const workflows = await Promise.all(gitSetup.tabs.map(tab => snapshot(page, tab)));
  await page.evaluate(() => {
    window.gitSetupTransitions = [];
    new MutationObserver(records => window.gitSetupTransitions.push(...records.map(record => record.attributeName)))
      .observe(document.querySelector('#gitWorkflowPanel'), { attributes: true, childList: true, subtree: true });
  });
  await respondToPrompt(page, () => footer(page).click());
  await expect(page.locator('#gitWorkflowPanel')).toBeHidden();
  expect(await Promise.all(gitSetup.tabs.map(tab => snapshot(page, tab)))).toEqual(workflows);
  expect(await settings(page, gitSetup)).toEqual(before);
  expect(gitSetup.mutations).toEqual([]);
  expect(await page.evaluate(() => window.gitSetupTransitions)).toEqual([]);
  await capture(page, info, `username-cancel-${width}`);
});

test('username Cancel preserves the active workflow and an unrelated workflow', async ({ page, gitSetup }, info) => {
  const [original, other] = gitSetup.tabs;
  await seed(page, original, { active: true, step: 'push', mode: 'standard', runId: 17, output: 'Keep original output', manualCommitMessage: 'Keep original message' });
  await seed(page, other, { active: true, step: 'remote', mode: 'initRepo', runId: 23, output: 'Keep other output', repoName: 'other-repository' });
  const workflows = await Promise.all(gitSetup.tabs.map(tab => snapshot(page, tab)));
  const before = await settings(page, gitSetup);
  await footer(page).click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  await respondToPrompt(page, () => page.getByRole('button', { name: 'Restart setup', exact: true }).click());
  expect(await Promise.all(gitSetup.tabs.map(tab => snapshot(page, tab)))).toEqual(workflows);
  await expect(page.locator('#gitWorkflowTitle')).toHaveText('Push commit');
  await expect(page.locator('#gitWorkflowOutput')).toHaveText('Keep original output');
  expect(await settings(page, gitSetup)).toEqual(before);
  expect(gitSetup.mutations).toEqual([]);
  await capture(page, info, 'username-cancel-keeps-workflows');
});

test('valid username continues to real local git init for the original project', async ({ page, gitSetup }, info) => {
  const [original, other] = gitSetup.tabs;
  await respondToPrompt(page, () => footer(page).click(), ' @octocat ');
  await expect(page.locator('#gitWorkflowTitle')).toHaveText('Initialize Git repository');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), setupKey)).toEqual({ githubUsername: 'octocat' });
  expect(await snapshot(page, original)).toMatchObject({ active: true, step: 'initRepo', githubUsername: 'octocat', repoName: basename(original.cwd), remoteUrl: `https://github.com/octocat/${basename(original.cwd)}.git` });
  expect(gitSetup.mutations).toEqual([]);
  await page.locator('#gitWorkflowActions').getByRole('button', { name: /^Run git init/ }).click();
  await expect(page.locator('#gitWorkflowTitle')).toHaveText('Choose repository stack');
  await access(join(original.cwd, '.git', 'HEAD'));
  expect(await readdir(other.cwd)).toEqual([]);
  expect(gitSetup.mutations.map(item => [item.path, item.tab])).toEqual([['/api/git-workflow/init', original.id]]);
  await capture(page, info, 'username-success-local-init');
});

test('stored username skips the native prompt and still starts setup', async ({ page, gitSetup }) => {
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ githubUsername: 'existing-user' })), setupKey);
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await footer(page).click();
  await expect(page.locator('#gitWorkflowTitle')).toHaveText('Initialize Git repository');
  expect(await snapshot(page, gitSetup.tabs[0])).toMatchObject({ githubUsername: 'existing-user', step: 'initRepo' });
  expect(dialogs).toEqual([]);
  expect(gitSetup.mutations).toEqual([]);
});

for (const [value, error] of [
  ['', 'GitHub username is required.'],
  ['bad--username', 'GitHub username must be 1-39 letters/numbers/hyphens, without leading/trailing or repeated hyphens.'],
]) test(`invalid username ${JSON.stringify(value)} keeps validation and retry`, async ({ page, gitSetup }, info) => {
  const before = await settings(page, gitSetup);
  await respondToPrompt(page, () => footer(page).click(), value);
  await expect(page.getByText(error, { exact: true }).first()).toBeAttached();
  await expect(page.locator('#gitWorkflowTitle')).toHaveText('Set up GitHub username');
  expect(await settings(page, gitSetup)).toEqual(before);
  const workflow = await snapshot(page, gitSetup.tabs[0]);
  await respondToPrompt(page, () => page.locator('#gitWorkflowActions').getByRole('button', { name: /^git-footer-status-setup/ }).click());
  expect(await snapshot(page, gitSetup.tabs[0])).toEqual(workflow);
  await respondToPrompt(page, () => page.locator('#gitWorkflowActions').getByRole('button', { name: /^git-footer-status-setup/ }).click(), 'valid-user');
  await expect(page.locator('#gitWorkflowTitle')).toHaveText('Initialize Git repository');
  expect(gitSetup.mutations).toEqual([]);
  await capture(page, info, value ? 'invalid-username-retried' : 'empty-username-retried');
});

test('later username and repository-name cancellation never adds origin', async ({ page, gitSetup }, info) => {
  const original = gitSetup.tabs[0];
  await seed(page, original, { active: true, mode: 'initRepo', step: 'remote', runId: 7, output: 'Keep remote step', repoName: '' });
  const before = await settings(page, gitSetup);
  const workflow = await snapshot(page, original);
  await respondToPrompt(page, () => page.locator('#gitWorkflowActions').getByRole('button', { name: /^git-footer-status-setup/ }).click());
  expect(await snapshot(page, original)).toEqual(workflow);
  await respondToPrompt(page, () => page.locator('#gitWorkflowActions').getByRole('button', { name: /^Add origin remote/ }).click());
  await expect(page.locator('#gitWorkflowOutput')).toContainText('Origin setup cancelled.');
  expect(await snapshot(page, original)).toMatchObject({ active: true, step: 'remote', runId: 7, repoName: '' });
  expect(await settings(page, gitSetup)).toEqual(before);
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ githubUsername: 'octocat' })), setupKey);
  await respondToPrompt(page, () => page.locator('#gitWorkflowActions').getByRole('button', { name: /^Add origin remote/ }).click(), null, 'GitHub repository name for origin remote');
  expect(await snapshot(page, original)).toMatchObject({ active: true, step: 'remote', runId: 7, repoName: '' });
  expect(gitSetup.mutations).toEqual([]);
  await capture(page, info, 'later-prompt-cancellation');
});

test('restart confirmation keeps its original project after navigation', async ({ page, gitSetup }) => {
  const [original, other] = gitSetup.tabs;
  await seed(page, original, { active: true, step: 'push', runId: 8 });
  await seed(page, other, { active: true, mode: 'initRepo', step: 'remote', runId: 12, output: 'Other workflow stays here' });
  const otherWorkflow = await snapshot(page, other);
  await footer(page).click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  // Navigation can finish while an app confirmation is pending. Use the real
  // switch function because the modal correctly prevents pointer navigation.
  await page.evaluate(id => window.gitSetupTest.switchTab(id), other.id);
  await respondToPrompt(page, () => page.getByRole('button', { name: 'Restart setup', exact: true }).click(), 'octocat');
  expect(await snapshot(page, original)).toMatchObject({ active: true, step: 'initRepo', runId: 9, repoName: basename(original.cwd), remoteUrl: `https://github.com/octocat/${basename(original.cwd)}.git` });
  expect(await snapshot(page, other)).toEqual(otherWorkflow);
  await page.evaluate(id => window.gitSetupTest.switchTab(id), original.id);
  await page.locator('#gitWorkflowActions').getByRole('button', { name: /^Run git init/ }).click();
  await expect(page.locator('#gitWorkflowTitle')).toHaveText('Choose repository stack');
  expect(gitSetup.mutations.map(item => [item.path, item.tab])).toEqual([['/api/git-workflow/init', original.id]]);
  expect(await readdir(other.cwd)).toEqual([]);
});

for (const change of ['workflow replaced', 'workflow advanced', 'project changed', 'tab closed']) test(`stale restart confirmation stops when ${change}`, async ({ page, gitSetup }) => {
  const [original, other] = gitSetup.tabs;
  await seed(page, original, { active: true, step: 'push', runId: 8 });
  await footer(page).click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  if (change === 'workflow replaced') await page.evaluate(id => window.gitSetupTest.reset(id), original.id);
  if (change === 'workflow advanced') await seed(page, original, { runId: 9, step: 'done' });
  if (change === 'project changed') {
    const response = await page.request.patch(`${gitSetup.baseURL}/api/tabs/${original.id}`, { data: { cwd: other.cwd } });
    expect(response.ok()).toBe(true);
    await page.evaluate(() => window.gitSetupTest.refreshTabs());
  }
  if (change === 'tab closed') {
    await gitSetup.api('/api/tabs/close', { ids: [original.id] });
    await page.evaluate(() => window.gitSetupTest.refreshTabs());
  }
  const workflows = await Promise.all(gitSetup.tabs.map(tab => snapshot(page, tab)));
  const dialogs = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Restart setup', exact: true }).click();
  await expect(page.locator('#confirmationDialog')).toBeHidden();
  expect(await Promise.all(gitSetup.tabs.map(tab => snapshot(page, tab)))).toEqual(workflows);
  expect(dialogs).toEqual([]);
  expect(gitSetup.mutations).toEqual([]);
  expect(await page.evaluate(key => localStorage.getItem(key), setupKey)).toBeNull();
});
