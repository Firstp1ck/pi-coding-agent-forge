import { expect } from '@playwright/test';
import { OPTIONAL_FEATURE_CATALOG } from '../../lib/optional-feature-catalog.mjs';
import { test } from './session-fixture.mjs';
import { navigateFocused } from './focused-navigation-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', actionTimeout: 5_000,
  launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM || '/usr/bin/chromium' } });
test.setTimeout(40_000);
const category = (page, name) => page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name, exact: true });
const row = (page, id) => page.locator(`[data-settings-feature="${id}"]`);

async function open(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
}
async function features(page) {
  await navigateFocused(page, 'Settings');
  await category(page, 'Features').click();
  await expect(page.locator('#optionalFeaturesBox')).toBeVisible();
}
async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

function audit(overrides = {}, extra = {}) {
  return { revision: 'w7-presentation-fixture', phase: 'ready', installKind: 'fresh', summary: { ready: 0, missing: 20 },
    features: OPTIONAL_FEATURE_CATALOG.map(feature => ({ ...feature, state: 'missing', installed: false, configured: false, ready: false, ...overrides[feature.featureId] })), ...extra };
}
async function mockAudit(page, snapshot) {
  await page.route('**/api/optional-features', route => route.fulfill({ json: { ok: true, data: snapshot } }));
}
async function commands(page, names) {
  await page.route('**/api/commands?*', route => route.fulfill({ json: { ok: true, data: { commands: names.map(name => ({ name, source: 'extension', description: `W7 ${name}` })) } } }));
}

// One bounded HTTP SSE response exercises the real browser event consumer. It
// deliberately does not claim a real companion, server replay or RPC processing.
async function mockEvents(page, tabId, events) {
  let release;
  let sent = false;
  const ready = new Promise(resolve => { release = resolve; });
  await page.route('**/api/events?*', async route => {
    const target = new URL(route.request().url()).searchParams.get('tab');
    if (target !== tabId) return route.continue();
    if (sent) return route.abort();
    sent = true;
    await ready;
    await route.fulfill({ contentType: 'text/event-stream', body: events.map(event => `data: ${JSON.stringify({ tabId, ...event })}\n\n`).join('') });
  });
  return release;
}

// Keep disposable layout writes real and acknowledge startup normalization.
// Other mutations need a test-specific reply so an unexpected click cannot
// start an install, authentication flow or publication.
async function blockMutations(page) {
  const writes = [];
  await page.route('**/api/**', async route => {
    if (['GET', 'HEAD'].includes(route.request().method())) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/interface-preferences') return route.fallback();
    // Startup disables unavailable speed mode. Keep that normalization local.
    if (path === '/api/codex-fast-mode' && route.request().postDataJSON().enabled === false) return route.fulfill({ json: { ok: true, data: { enabled: false, mode: 'normal', statusKnown: true } } });
    writes.push({ path: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({ status: 409, json: { ok: false, error: 'W7 unexpected external mutation blocked' } });
  });
  return writes;
}

test('all twenty catalog identities remain distinguishable from loaded capabilities', async ({ page, ownership }, info) => {
  const writes = await blockMutations(page);
  await mockAudit(page, audit({
    releaseNpm: { state: 'ready', installed: true, configured: true, ready: true },
    releaseAur: { state: 'missing', installed: true, configured: false },
    aurReview: { state: 'conflict', resourceConflict: true, installed: true, configured: true },
  }));
  await commands(page, []);
  await open(page, ownership);
  await features(page);
  await expect(page.locator('[data-settings-feature]')).toHaveCount(20);
  expect(await page.locator('[data-settings-feature]').evaluateAll(nodes => nodes.map(node => node.dataset.settingsFeature).sort())).toEqual(OPTIONAL_FEATURE_CATALOG.map(feature => feature.featureId).sort());
  await expect(row(page, 'releaseNpm')).toContainText('Installed');
  await expect(row(page, 'releaseNpm')).toContainText('not loaded in the active tab');
  await expect(row(page, 'releaseNpm').getByRole('button', { name: 'Reload', exact: true })).toBeEnabled();
  await expect(row(page, 'releaseAur')).toContainText('Registration needed');
  await expect(row(page, 'aurReview')).toContainText('Duplicate conflict');
  await expect(row(page, 'aurReview').getByRole('button', { name: 'Conflict', exact: true })).toBeDisabled();
  await expect(row(page, 'bangCommandAutocomplete')).toContainText('Install needed');
  await capture(page, info, 'companion-unavailable-conflict');
  expect(writes).toEqual([]);
});

test('disabled Setup stays reachable while ordinary release access explains its unavailable reason', async ({ page, ownership }, info) => {
  const writes = await blockMutations(page);
  await mockAudit(page, audit());
  await commands(page, ['tools', 'skills', 'release-npm']);
  await page.addInitScript(() => localStorage.setItem('pi-webui-optional-features-disabled', JSON.stringify(['tuiToolsCommand', 'tuiSkillsCommand', 'releaseNpm'])));
  await open(page, ownership);
  await features(page);
  for (const [id, name] of [['tuiToolsCommand', 'Tools'], ['tuiSkillsCommand', 'Skills']]) {
    await expect(row(page, id)).toContainText('Disabled');
    await row(page, id).getByRole('button', { name: `Set up TUI ${name} command`, exact: true }).click();
    await expect(page.locator('#nativeCommandTitle')).toHaveText(`${name} Setup`);
    await page.keyboard.press('Escape');
  }
  await navigateFocused(page, 'Project');
  await page.getByRole('combobox', { name: 'Project section', exact: true }).selectOption({ label: 'Release' });
  await expect(page.locator('#releaseNpmButton')).toBeHidden();
  await expect(page.locator('#releaseAurButton')).toBeHidden();
  await expect(page.locator('[data-feature-host="release"]')).toContainText('configure missing companions in Settings');
  await capture(page, info, 'release-disabled-reasons');
  expect(writes).toEqual([]);
});

for (const state of ['failed', 'busy']) {
  test(`capability administration keeps ${state} progress and safe controls across destinations`, async ({ page, ownership }, info) => {
    const writes = await blockMutations(page);
    const busy = state === 'busy';
    await mockAudit(page, audit({}, { phase: busy ? 'migrating' : 'partial', progress: {
      phase: busy ? 'migrating' : 'partial', migration: true, total: 1, completed: busy ? 0 : 1,
      succeeded: 0, failed: busy ? 0 : 1, currentFeatureId: busy ? 'releaseAur' : null,
      currentPackageName: '@firstpick/pi-extension-release-aur', startedAt: new Date().toISOString(),
      results: busy ? [] : [{ featureId: 'releaseAur', ok: false, message: 'W7 package download unavailable', kind: 'network' }],
    } }));
    await commands(page, []);
    await open(page, ownership);
    await features(page);
    if (busy) {
      await expect(row(page, 'releaseAur')).toHaveAttribute('aria-busy', 'true');
      await expect(row(page, 'releaseAur').getByRole('button', { name: 'Installing…', exact: true })).toBeDisabled();
    } else {
      await expect(row(page, 'releaseAur').getByRole('alert')).toContainText('W7 package download unavailable');
      await expect(row(page, 'releaseAur').getByRole('button', { name: 'Retry failed', exact: true })).toBeEnabled();
    }
    await navigateFocused(page, 'Activity');
    await navigateFocused(page, 'Settings');
    await category(page, 'Features').click();
    await expect(row(page, 'releaseAur')).toContainText(busy ? 'Installing' : 'W7 package download unavailable');
    await row(page, 'releaseAur').scrollIntoViewIfNeeded();
    await capture(page, info, `companion-${state}`);
    expect(writes).toEqual([]);
  });
}

test('npm and AUR progress stay in their Project host and explicit controls retain the original tab', async ({ page, ownership }, info) => {
  const writes = await blockMutations(page);
  await mockAudit(page, audit());
  await commands(page, ['release-npm', 'release-toggle', 'release-abort', 'release-aur']);
  const release = await mockEvents(page, ownership.tabs[0].id, ['npm', 'aur'].flatMap(kind => [
    { type: 'extension_ui_request', id: `w7-${kind}-footer`, method: 'setWidget', widgetKey: `release-${kind}:footer`, widgetLines: [`release-${kind}: preflight · no publication · 00:12`] },
    { type: 'extension_ui_request', id: `w7-${kind}-output`, method: 'setWidget', widgetKey: `release-${kind}:output`, widgetLines: [`W7 ${kind} preflight output`, 'No package was published.'] },
  ]));
  const prompts = [];
  await page.route('**/api/prompt?*', async route => {
    prompts.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true, data: {} } });
  });
  await open(page, ownership);
  release();
  await navigateFocused(page, 'Project');
  await page.getByRole('combobox', { name: 'Project section', exact: true }).selectOption({ label: 'Release' });
  const npm = page.getByRole('region', { name: 'npm release output', exact: true });
  const aur = page.getByRole('region', { name: 'AUR release output', exact: true });
  await expect(npm).toBeVisible();
  await expect(aur).toBeVisible();
  await expect(page.locator('#widgetArea .release-npm-live-widget')).toHaveCount(0);
  await navigateFocused(page, 'Settings');
  expect(prompts).toEqual([]);
  await navigateFocused(page, 'Project');
  await page.getByRole('combobox', { name: 'Project section', exact: true }).selectOption({ label: 'Release' });
  await expect(npm).toContainText('W7 npm preflight output');
  await expect(aur).toContainText('W7 aur preflight output');
  await capture(page, info, 'release-progress');
  await aur.scrollIntoViewIfNeeded();
  await capture(page, info, 'aur-release-progress');
  await npm.getByRole('button', { name: 'Toggle output', exact: true }).click();
  await aur.getByRole('button', { name: 'Abort', exact: true }).click();
  await expect.poll(() => prompts.length).toBe(2);
  expect(prompts.map(prompt => ({ tab: prompt.tab, message: prompt.body.message }))).toEqual([
    { tab: ownership.tabs[0].id, message: '/release-toggle' }, { tab: ownership.tabs[0].id, message: '/release-aur abort' },
  ]);
  expect(writes).toEqual([]);
});

test('native questionnaire Other and free text retain the exact request and original tab', async ({ page, ownership }, info) => {
  const writes = await blockMutations(page);
  const other = 'Other… (enter a custom answer)';
  const events = [
    { type: 'extension_ui_request', id: 'w7-question-select', method: 'select', title: 'Question 1 of 1: Which deployment?', options: ['01. Local — use a disposable project', '02. Remote — requires approval', other, 'Ask Pi to clarify…', 'Cancel questionnaire'] },
    { type: 'extension_ui_request', id: 'w7-question-other', method: 'input', title: 'Other answer', placeholder: 'Enter your custom answer' },
  ];
  const release = await mockEvents(page, ownership.tabs[0].id, events);
  const replies = [];
  await page.route('**/api/extension-ui-response?*', async route => {
    replies.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true, data: {} } });
  });
  await open(page, ownership);
  await navigateFocused(page, 'Settings');
  release();
  await expect(page.locator('#extensionDialog')).toHaveClass(/questionnaire-dialog/);
  await expect(page.locator('.questionnaire-option')).toHaveCount(2);
  await capture(page, info, 'questionnaire-other');
  await page.getByRole('button', { name: other, exact: true }).click();
  await expect(page.locator('#dialogTitle')).toHaveText('Other answer');
  await page.locator('#dialogBody input').fill('Keep it local <no publication>');
  await capture(page, info, 'questionnaire-free-text');
  await page.locator('#dialogBody input').press('Enter');
  await expect(page.locator('#extensionDialog')).toBeHidden();
  expect(replies).toEqual([
    { tab: ownership.tabs[0].id, body: { type: 'extension_ui_response', id: 'w7-question-select', value: other } },
    { tab: ownership.tabs[0].id, body: { type: 'extension_ui_response', id: 'w7-question-other', value: 'Keep it local <no publication>' } },
  ]);
  expect(writes).toEqual([]);
});

test('untrusted theme administration explains why project save is unavailable', async ({ page, ownership }, info) => {
  const writes = await blockMutations(page);
  await page.route('**/api/themes*', async route => {
    if (new URL(route.request().url()).pathname !== '/api/themes') return route.fallback();
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.scopes = { global: { available: true }, project: { available: false, trusted: false } };
    await route.fulfill({ response, json: payload });
  });
  await open(page, ownership);
  await navigateFocused(page, 'Settings');
  await category(page, 'Appearance').click();
  await page.locator('#themeCustomizeButton').click();
  await expect(page.locator('#themeCustomizerDialog')).toBeVisible();
  expect(await page.locator('#themeCustomizerProjectOption').evaluate(option => option.disabled)).toBe(true);
  await expect(page.locator('#themeCustomizerScope')).toHaveValue('global');
  await expect(page.locator('#themeCustomizerScopeHint')).toContainText('not saved as trusted');
  await capture(page, info, 'untrusted-theme-save');
  await page.locator('#themeCustomizerCancelButton').click();
  expect(writes).toEqual([]);
});

test('Activity Progress keeps the fake-Pi run alive and routes Pause to the same tab and run', async ({ page, ownership }, info) => {
  const tabId = ownership.tabs[0].id;
  await ownership.api(`/api/prompt?tab=${tabId}`, { message: 'fixture workflow inspector running', requestId: 'w7-workflow-progress' });
  const prompts = [];
  await page.route('**/api/prompt?*', async route => {
    prompts.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true, data: {} } });
  });
  await open(page, ownership);
  await navigateFocused(page, 'Activity');
  await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: 'Progress' });
  const widget = page.locator('[data-feature-host="progress"] .workflow-inspector-widget');
  await expect(widget).toContainText('Fixture Workflow');
  await expect(widget).toContainText('Status: running');
  await navigateFocused(page, 'Settings');
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-button`).click();
  await navigateFocused(page, 'Activity');
  await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: 'Progress' });
  await expect(widget).toHaveCount(0);
  await page.locator(`#tabBar [data-tab-id="${tabId}"] .terminal-tab-button`).click();
  await expect(widget).toContainText('Status: running');
  expect(prompts).toEqual([]);
  await capture(page, info, 'workflow-progress-original-run');
  await widget.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0]).toMatchObject({ tab: tabId, body: { message: '/workflow pause fixture-workflow-run', requestId: expect.any(String) } });
});

test('multi-select questionnaire preserves selected markers and the exact Change Other action', async ({ page, ownership }, info) => {
  const writes = await blockMutations(page);
  const change = 'Change Other… (currently "local only")';
  const release = await mockEvents(page, ownership.tabs[0].id, [{ type: 'extension_ui_request', id: 'w7-question-multi', method: 'select',
    title: 'Question 1 of 1: Choose checks', options: ['01. [x] Browser checks', '02. [ ] Provider checks', change, 'Remove Other answer', 'Ask Pi to clarify…', 'Continue with 2 selection(s)', 'Cancel questionnaire'] }]);
  const replies = [];
  await page.route('**/api/extension-ui-response?*', async route => {
    replies.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    await route.fulfill({ json: { ok: true, data: {} } });
  });
  await open(page, ownership);
  release();
  await expect(page.getByRole('button', { name: '01. [x] Browser checks', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '02. [ ] Provider checks', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await capture(page, info, 'questionnaire-selected-other');
  await page.getByRole('button', { name: change, exact: true }).click();
  await expect.poll(() => replies.length).toBe(1);
  expect(replies[0]).toEqual({ tab: ownership.tabs[0].id, body: { type: 'extension_ui_response', id: 'w7-question-multi', value: change } });
  expect(writes).toEqual([]);
});
