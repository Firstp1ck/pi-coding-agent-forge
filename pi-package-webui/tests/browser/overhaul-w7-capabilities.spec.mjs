import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', actionTimeout: 5_000,
  launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM || '/usr/bin/chromium' } });
test.setTimeout(40_000);

const destination = (page, name) => page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name, exact: true });
const category = (page, name) => page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name, exact: true });
const tab = (page, id) => page.locator(`#tabBar [data-tab-id="${id}"] .terminal-tab-button`);

async function open(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await expect(page.locator('#chat')).toContainText('fake answer');
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

// Counts navigation before editing a value. Native chooser selection and value
// application are recorded separately, as required by the frozen W0 contract.
const reachability = [
  ['switch session', 2, async (page, ownership, act) => {
    await act('select original peer tab', () => tab(page, ownership.tabs[1].id).click());
    await expect(tab(page, ownership.tabs[1].id)).toHaveAttribute('aria-selected', 'true');
  }],
  ['change model', 2, async (page, ownership, act) => {
    await act('open model picker', () => page.locator('.focused-composer-setting-button:has(.focused-composer-model-value)').click());
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/model' && r.request().method() === 'POST');
    await page.locator('#nativeCommandDialog').getByRole('option', { name: /fake\/fake-model-alt/ }).click();
    expect(new URL((await response).url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
    expect((await ownership.api(`/api/state?tab=${ownership.tabs[0].id}`)).model.id).toBe('fake-model-alt');
  }],
  ['change effort', 2, async (page, ownership, act) => {
    await act('open effort picker', () => page.locator('.focused-composer-setting-button:has(.focused-composer-effort-value)').click());
    await page.locator('#nativeCommandDialog').getByRole('option', { name: /^high/ }).click();
    await expect.poll(async () => (await ownership.api(`/api/state?tab=${ownership.tabs[0].id}`)).thinkingLevel).toBe('high');
  }],
  ['attach file', 2, async (page, _ownership, act) => {
    const chooser = page.waitForEvent('filechooser');
    await act('open native attachment chooser', () => page.locator('#attachButton').click());
    await (await chooser).setFiles({ name: 'w7-context.txt', mimeType: 'text/plain', buffer: Buffer.from('W7 attachment context') });
    await expect(page.locator('#attachmentTray')).toContainText('w7-context.txt');
  }],
  ['find changed file', 2, async (page, _ownership, act) => {
    await act('open Project', () => destination(page, 'Project').click());
    await act('open Changes', () => page.getByRole('tab', { name: 'Changes', exact: true }).click());
    const repository = page.locator('.git-side-panel-repository-toggle');
    await expect(repository).toBeVisible();
    if (await repository.getAttribute('aria-expanded') !== 'true') await act('expand repository changes', () => repository.click());
    const file = page.locator('.git-side-panel-file').filter({ hasText: 'w7-changed.txt' });
    await expect(file).toBeVisible();
    await file.click();
    await expect(page.locator('#fileViewerTitle')).toHaveText('w7-changed.txt');
  }],
  ['open runner output', 2, async (page, _ownership, act) => {
    await act('open Project', () => destination(page, 'Project').click());
    await act('open Runners', () => page.getByRole('tab', { name: 'Runners', exact: true }).click());
    await expect(page.locator('#appRunnerMenuPanel')).toBeVisible();
    await page.locator('#appRunnerMenuPanel button').filter({ hasText: 'w7-runner.sh' }).first().click();
    await expect(page.locator('[data-feature-host="runners"] .app-runner-widget')).toContainText('W7_RUNNER_OUTPUT');
  }],
  ['find approval', 2, async (page, ownership) => {
    await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, { message: 'fixture mobile blocker', requestId: 'w7-reach-approval' });
    await expect(page.locator('#dialogTitle')).toHaveText('Fixture blocker');
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/extension-ui-response');
    await page.locator('#dialogActions').getByRole('button', { name: 'No', exact: true }).click();
    const reply = await response;
    expect(new URL(reply.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
    expect(reply.request().postDataJSON()).toMatchObject({ id: 'fixture_blocker_12345678', confirmed: false });
  }],
  ['configure tool profile', 3, async (page, _ownership, act) => {
    await act('open Settings', () => destination(page, 'Settings').click());
    await act('open Models and resources', () => category(page, 'Models and resources').click());
    await act('open Tools Setup', () => page.locator('.settings-workspace').getByRole('button', { name: 'Tools', exact: true }).click());
    await expect(page.locator('#nativeCommandTitle')).toHaveText('Tools Setup');
    await expect(page.locator('#nativeCommandDialog')).toContainText('Session');
  }],
  ['change theme', 3, async (page, _ownership, act) => {
    await act('open Settings', () => destination(page, 'Settings').click());
    await act('open Appearance', () => category(page, 'Appearance').click());
    await expect(page.locator('#themeSelect')).toBeVisible();
    await page.locator('#themeSelect').selectOption('dracula');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('pi-webui-theme'))).toBe('dracula');
  }],
];

for (const [name, budget, exercise] of reachability) {
  test(`W7 reachability: ${name}`, async ({ page, ownership }, info) => {
    const cwd = ownership.tabs[0].cwd;
    if (name === 'find changed file') {
      execFileSync('git', ['init', '-q', '--template='], { cwd, timeout: 8_000, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
      await writeFile(join(cwd, 'w7-changed.txt'), 'changed file context\n');
    }
    if (name === 'open runner output') {
      await writeFile(join(cwd, 'w7-runner.sh'), '#!/usr/bin/env bash\nprintf "W7_RUNNER_OUTPUT\\n"\n');
      const detected = await ownership.api(`/api/app-runners?tab=${ownership.tabs[0].id}`);
      await info.attach('runner discovery precondition', { body: JSON.stringify(detected, null, 2), contentType: 'application/json' });
      expect(detected.runners.some(runner => runner.label === 'w7-runner.sh')).toBe(true);
    }
    if (name === 'configure tool profile') await page.route('**/api/commands?*', route => route.fulfill({ json: { ok: true, data: { commands: [{ name: 'tools', source: 'extension' }] } } }));
    await open(page, ownership);
    const actions = [];
    try {
      await exercise(page, ownership, async (label, action) => { actions.push(label); await action(); });
      expect(actions.length, `${name}: ${actions.join(' > ')}`).toBeLessThanOrEqual(budget);
    } finally {
      await info.attach('navigation actions', { body: JSON.stringify({ name, budget, actions, counting: 'reach control before editing; API fixture setup excluded' }, null, 2), contentType: 'application/json' });
      await capture(page, info, `reach-${name.replaceAll(' ', '-')}`);
    }
  });
}

test('file annotation sends the selected path, text and comment to its original tab', async ({ page, ownership }, info) => {
  await writeFile(join(ownership.tabs[0].cwd, 'w7-note.txt'), 'first line\nselected original text\nlast line\n');
  const writes = [];
  await page.route('**/api/prompt?*', async route => {
    writes.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true, data: {} } });
  });
  await open(page, ownership);
  await destination(page, 'Project').click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.locator('#fileTreeRoot [data-path="w7-note.txt"]').click();
  const editor = page.locator('#fileViewerEditor');
  await expect(editor).toBeVisible();
  await editor.focus();
  await editor.press('Home');
  await editor.press('Control+Home');
  await editor.press('ArrowDown');
  await editor.press('Home');
  await editor.press('Shift+End');
  await expect(page.locator('#fileSelectionBar')).toBeVisible();
  await page.locator('#fileSelectionCommentInput').fill('Explain this exact selection');
  await destination(page, 'Settings').click();
  await destination(page, 'Project').click();
  await expect(page.locator('#fileSelectionCommentInput')).toHaveValue('Explain this exact selection');
  await capture(page, info, 'file-annotation');
  await page.locator('#fileSelectionSendButton').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].tab).toBe(ownership.tabs[0].id);
  expect(writes[0].body.message).toContain('File selection from w7-note.txt');
  expect(writes[0].body.message).toContain('selected original text');
  expect(writes[0].body.message).toContain('User comment: Explain this exact selection');
  expect(writes[0].body.requestId).toEqual(expect.any(String));
});

test('attachment image preview reuses the canonical dialog without moving another tab attachment', async ({ page, ownership }, info) => {
  await open(page, ownership);
  const image = await readFile(new URL('../../public/icon-192.png', import.meta.url));
  await page.locator('#attachmentInput').setInputFiles({ name: 'w7-image.png', mimeType: 'image/png', buffer: image });
  await page.locator('#attachmentTray button').filter({ has: page.locator('img') }).click();
  const dialog = page.getByRole('dialog', { name: 'Image preview', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('img')).toHaveAttribute('alt', 'w7-image.png');
  await expect.poll(() => dialog.locator('img').evaluate(image => image.complete && image.naturalWidth > 0)).toBe(true);
  const original = await dialog.elementHandle();
  await capture(page, info, 'image-preview');
  await page.keyboard.press('Escape');
  await tab(page, ownership.tabs[1].id).click();
  await expect(page.locator('#attachmentTray')).toBeHidden();
  await tab(page, ownership.tabs[0].id).click();
  await page.locator('#attachmentTray button').filter({ has: page.locator('img') }).click();
  expect(await original.evaluate(node => node === document.querySelector('.image-lightbox'))).toBe(true);
  await expect(dialog.locator('figcaption')).toHaveText('w7-image.png');
  await dialog.getByRole('button', { name: 'Close image preview' }).click();
  await expect(page.locator('#attachmentTray')).toContainText('w7-image.png');
});

test('queued feedback survives failure, offers retry and stays with its original tab', async ({ page, ownership }, info) => {
  const writes = [];
  let fail = true;
  await page.route('**/api/action-feedback?*', async route => {
    writes.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    await route.fulfill(fail ? { status: 503, json: { ok: false, error: 'W7 feedback service unavailable' } } : { json: { ok: true, data: {} } });
  });
  await open(page, ownership);
  await page.locator('#chat .feedback-question').first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#feedbackTray')).toContainText('1 action reaction');
  await tab(page, ownership.tabs[1].id).click();
  await expect(page.locator('#feedbackTray')).toBeHidden();
  await tab(page, ownership.tabs[0].id).click();
  await page.locator('#sendFeedbackButton').click();
  await expect(page.locator('#chat')).toContainText('W7 feedback service unavailable');
  await expect(page.locator('#sendFeedbackButton')).toBeEnabled();
  await capture(page, info, 'feedback-failed-retry');
  fail = false;
  await page.locator('#sendFeedbackButton').click();
  await expect(page.locator('#feedbackTray')).toBeHidden();
  expect(writes).toHaveLength(2);
  expect(writes.every(write => write.tab === ownership.tabs[0].id)).toBe(true);
  expect(writes[1].body).toEqual(writes[0].body);
  expect(writes[0].body.feedback[0]).toMatchObject({ reaction: 'question', kind: 'final output', snippet: 'fake answer' });
});

test('saved workspace retains exact group membership and recovers a failed listing', async ({ page, ownership }, info) => {
  const ids = ownership.tabs.map(tab => tab.id);
  await page.addInitScript(ids => localStorage.setItem('pi-webui-terminal-custom-groups-v1', JSON.stringify({ version: 1, groups: [{ id: 'w7-group', title: 'W7 review group', tabIds: ids }] })), ids);
  let fail = true;
  await page.route('**/api/workspaces', async route => {
    if (route.request().method() !== 'GET') return route.continue();
    if (fail) return route.fulfill({ status: 503, json: { ok: false, error: 'W7 saved workspace listing unavailable' } });
    return route.continue();
  });
  await open(page, ownership);
  await destination(page, 'All tools').click();
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('Workspace: Load');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: 'Workspace: Load…', exact: true }).click();
  await expect(page.locator('#workspaceLoadDialog')).toContainText('W7 saved workspace listing unavailable');
  fail = false;
  await page.locator('#workspaceLoadDialog').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.locator('#workspaceLoadDialog')).toContainText('No saved workspaces yet');
  await page.keyboard.press('Escape');
  await page.locator('#workspaceSaveButton').click();
  await page.locator('#textPromptInput').fill('W7 saved group');
  const saved = page.waitForResponse(r => new URL(r.url()).pathname === '/api/workspaces' && r.request().method() === 'POST');
  await page.locator('#textPromptDialog').getByRole('button', { name: 'Save workspace', exact: true }).click();
  const response = await saved;
  expect(response.request().postDataJSON()).toMatchObject({ name: 'W7 saved group', activeTabId: ids[0], groups: [{ title: 'W7 review group', tabIds: ids }] });
  expect(response.ok()).toBe(true);
  await destination(page, 'All tools').click();
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('Workspace: Load');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: 'Workspace: Load…', exact: true }).click();
  await expect(page.locator('#workspaceLoadDialog')).toContainText('W7 saved group');
  await expect(page.locator('#workspaceLoadDialog')).toContainText('1 group');
  await capture(page, info, 'saved-workspace-group');
  await page.locator('#workspaceLoadDialog').getByRole('button', { name: 'Load workspace W7 saved group', exact: true }).click();
  await expect(page.locator('#workspaceReplaceDialog')).toBeVisible();
  await page.locator('#workspaceReplaceCancelButton').click();
  await expect(page.locator('#workspaceLoadDialog')).toBeVisible();
  expect((await ownership.api('/api/tabs')).tabs.map(tab => tab.id)).toEqual(ids);
  const data = await ownership.api('/api/workspaces');
  expect(data.workspaces).toHaveLength(1);
  expect(data.workspaces[0]).toMatchObject({ name: 'W7 saved group', tabCount: 2, groupCount: 1 });
});

test('Essential and Detailed change presentation without changing transport processing', async ({ page, ownership }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ownership.baseURL}/?mobileShell=v2&tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  const processing = await ownership.api('/api/webui-output-mode');
  const streams = [];
  const mutations = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/events') streams.push(url.searchParams.get('outputMode'));
    if (request.method() !== 'GET') mutations.push(url.pathname);
  });
  await page.locator('#mobileMoreButton').click();
  await page.getByRole('button', { name: 'Detailed', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mobile-presentation', 'detailed');
  await page.getByRole('button', { name: 'Essential', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-mobile-presentation', 'essential');
  await capture(page, info, 'presentation-essential');
  expect(streams).toEqual([]);
  expect(mutations.filter(path => /output|prompt|compact/.test(path))).toEqual([]);
  expect(await ownership.api('/api/webui-output-mode')).toEqual(processing);
});


test('final-output question feedback accepts a pointer click without copy-button interception', async ({ page, ownership }, info) => {
  await open(page, ownership);
  await page.locator('#chat .message').filter({ has: page.locator('.feedback-question') }).first().hover();
  await page.locator('#chat .feedback-question').first().click();
  await expect(page.locator('#feedbackTray')).toContainText('1 action reaction');
  await capture(page, info, 'pointer-feedback');
});

test('hidden attachment control can be recovered from All tools and Settings', async ({ page, ownership }, info) => {
  await open(page, ownership);
  await page.locator('#attachButton').click({ button: 'right' });
  await page.locator('#visibilityContextMenu [data-visibility-menu-action="hide"]').click();
  await expect(page.locator('#attachButton')).toBeHidden();
  await destination(page, 'All tools').click();
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('Show all controls');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: 'Show all controls', exact: true }).click();
  await expect(page.locator('#attachButton')).toBeVisible();
  await destination(page, 'Settings').click();
  await category(page, 'Appearance').click();
  await expect(page.locator('.settings-workspace').getByRole('button', { name: 'Reset control visibility', exact: true })).toBeVisible();
  await capture(page, info, 'hidden-control-recovery');
});
