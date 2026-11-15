import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
test.setTimeout(45_000);

const settings = page => page.locator('.settings-workspace');
const category = (page, name) => settings(page).getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name, exact: true });
const card = (page, name) => settings(page).getByRole('button', { name, exact: true });
const search = page => settings(page).getByRole('searchbox', { name: 'Search settings', exact: true });
const result = (page, label) => settings(page).getByRole('listitem').filter({ has: page.locator('.settings-navigation-result-label').getByText(label, { exact: true }) });
const reply = (route, data) => route.fulfill({ json: { ok: true, data } });
const tabId = route => new URL(route.request().url()).searchParams.get('tab');
const turn = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const sampling = value => ({
  session: { temperature: value, retained_extension: 7 }, defaults: { temperature: 1 }, effective: { temperature: value },
  support: { supported: true, api: 'openai-responses', model: { provider: 'fake', id: 'fake-model' },
    parameters: { temperature: { supported: true, source: 'api' }, top_k: { supported: false, reason: 'Fixture model does not support Top K.' } } },
});
const speed = { available: true, enabled: false, mode: 'normal', statusKnown: true, modelEligible: true, ultrafastModelEligible: true };
const summary = {
  preferences: { enabled: false, model: { provider: 'fake', modelId: 'fake-model', thinkingLevel: 'off' },
    prompts: { title: 'Create a title', summary: 'Create a Markdown summary' }, title: { enabled: true, minSettledTurns: 3 } },
  models: [{ provider: 'fake', id: 'fake-model' }], modelThinkingLevels: { 'fake/fake-model': ['off'] },
  disclosure: { scope: 'Selected active-branch text and tool names only.', cost: 'One configured-model request, no fallback.' },
};
const runners = name => ({ runners: [], customRunnerConfig: { searchPaths: [], runners: [], displayProjectRoot: name, displayConfigFile: `${name}/.pi-webui-runners.json` } });

async function open(page, ownership, { commands = true, speedData = speed } = {}) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.route(/\/api\/commands(?:\?|$)/, route => reply(route, { commands: [{ name: 'settings', source: 'extension', description: 'Runtime preferences' }, { name: 'fast-mode', source: 'extension', description: 'Codex speed' }, ...(commands ? [
    { name: 'summary-setup', source: 'extension', description: 'Summary preferences' },
    { name: 'git-footer-visibility', source: 'extension', description: 'Footer visibility' },
  ] : [])] }));
  await page.route(/\/api\/codex-fast-mode(?:\?|$)/, route => reply(route, speedData));
  await page.route(/\/api\/tabs\/[^/]+\/sampling-parameters/, route => reply(route, sampling(0.7)));
  await page.route(/\/api\/session-summary\/preferences(?:\?|$)/, route => reply(route, summary));
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#chat')).toContainText('fake answer');
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
}

async function selectTab(page, id, { behindDialog = false } = {}) {
  const tab = page.locator(`#tabBar [data-tab-id="${id}"] .terminal-tab-button`);
  // Exercise the real tab handler while a modal is pending, as an external target change would.
  if (behindDialog) await tab.evaluate(node => node.click());
  else await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#chat')).toContainText('fake answer');
}

async function release(page, route, data) {
  const delivered = page.waitForResponse(response => response.request() === route.request());
  await reply(route, data);
  await (await delivered).finished();
  await turn(page);
}

async function closeNative(page) {
  await page.locator('#nativeCommandActions').getByRole('button', { name: 'Cancel', exact: true }).click();
  if (await page.locator('#confirmationDialog').isVisible()) await page.locator('#confirmationConfirmButton').click();
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
}

test('all six homes and Runtime aliases are discoverable; navigation preserves canonical nodes and drafts without writes', async ({ page, ownership }, info) => {
  const writes = [];
  const reads = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (/sampling-parameters|codex-fast-mode/.test(url.pathname) && request.method() === 'GET') reads.push(url.pathname);
    if (/sampling-parameters|codex-fast-mode|session-summary\/(preferences|generate)|app-runner(?:-config)?$|\/prompt$/.test(url.pathname) && request.method() !== 'GET') writes.push(url.pathname);
  });
  await open(page, ownership);
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.locator('#promptInput').fill('Keep this unsent draft');
  const sampleNode = await page.locator('.sampling-parameters').elementHandle();
  const speedNode = await page.locator('.codex-fast-mode-control').elementHandle();
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
  const before = reads.filter(path => path.endsWith('sampling-parameters')).length;
  await category(page, 'Models and resources').click();
  await expect(page.locator('#samplingParametersSupport')).toContainText('fake-model');
  await expect(page.locator('#codexFastModeSelect')).toBeEnabled();
  expect(reads.filter(path => path.endsWith('sampling-parameters')).length).toBeGreaterThan(before);
  await expect(page.locator('[data-sampling-parameter="top_k"] input[type=checkbox]')).toBeDisabled();
  await expect(page.locator('[data-sampling-parameter="top_k"]')).toContainText('Fixture model does not support Top K.');
  await page.locator('[data-sampling-parameter="temperature"] input[type=number]').fill('0.8');
  for (const [query, label] of [
    ['temperature', 'Sampling parameters'], ['ultrafast', 'Codex speed'], ['cadence', 'Summary Setup'],
    ['discovery paths', 'Runner configuration'], ['git footer', 'Git-footer Visibility'], ['bash', 'Tool output expansion'],
    ['steering', 'Runtime settings'], ['auto-compaction', 'Runtime settings'], ['double escape', 'Runtime settings'],
  ]) {
    await search(page).fill(query);
    await expect(result(page, label)).toBeVisible();
  }
  await search(page).fill('ultrafast');
  await result(page, 'Codex speed').getByRole('button').click();
  await expect(page.locator('#codexFastModeSelect')).toBeFocused();
  await expect(page.locator('#codexFastModeSelect')).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.locator('.codex-fast-mode-control').scrollIntoViewIfNeeded();
  await expect(page.locator('#setCodexFastModeButton')).toBeVisible();
  await page.screenshot({ path: info.outputPath('settings-codex-speed-narrow.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await search(page).fill('temperature');
  await result(page, 'Sampling parameters').getByRole('button').click();
  await expect(page.locator('[data-sampling-parameter="temperature"] input[type=number]')).toHaveValue('0.8');
  await expect(settings(page)).toContainText('current session branch');
  await page.screenshot({ path: info.outputPath('settings-resources-canonical.png'), animations: 'disabled' });
  await category(page, 'System').click();
  await expect(card(page, 'Runner configuration')).toBeEnabled();
  await expect(card(page, 'Runner configuration').locator('..')).toContainText('Current project');
  await category(page, 'Appearance').click();
  await expect(card(page, 'Git-footer Visibility')).toBeEnabled();
  await expect(card(page, 'Control visibility')).toBeEnabled();
  await expect(card(page, 'Tool output expansion')).toBeEnabled();
  await page.locator('#desktopShellSelect').selectOption('classic');
  expect(await sampleNode.evaluate(node => node.parentElement.id)).toBe('sidePanelSectionSampling');
  expect(await speedNode.evaluate(node => node.parentElement.id)).toBe('sidePanelSectionCodexUsage');
  await page.locator('#sidePanelSectionToggleControls').click();
  await page.locator('#desktopShellSelect').selectOption('focused');
  await expect(settings(page)).toBeVisible();
  expect(await sampleNode.evaluate(node => node === document.querySelector('.sampling-parameters'))).toBe(true);
  expect(await speedNode.evaluate(node => node === document.querySelector('.codex-fast-mode-control'))).toBe(true);
  await expect(page.locator('.sampling-parameters')).toHaveCount(1);
  await expect(page.locator('.codex-fast-mode-control')).toHaveCount(1);
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue('Keep this unsent draft');
  await expect(page.getByRole('group', { name: 'Session composer controls' }).getByRole('button', { name: /^Model:/ })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Session composer controls' }).getByRole('button', { name: 'Scoped models', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Session composer controls' }).getByRole('button', { name: /^Effort:/ })).toBeVisible();
  expect(writes).toEqual([]);
});

test('unavailable homes retain capability and model reasons in cards and search', async ({ page, ownership }, info) => {
  await open(page, ownership, { commands: false, speedData: { available: false, unavailableReason: 'Fixture Codex model is unsupported.' } });
  await category(page, 'Models and resources').click();
  await expect(card(page, 'Summary Setup')).toBeDisabled();
  await expect(page.locator('#codexFastModeSelect')).toBeDisabled();
  await expect(page.locator('#codexFastModeStatus')).toContainText('Fixture Codex model is unsupported.');
  await search(page).fill('ultrafast');
  await expect(result(page, 'Codex speed')).toContainText('Fixture Codex model is unsupported.');
  await expect(result(page, 'Codex speed').getByRole('button')).toBeDisabled();
  await search(page).fill('cadence');
  await expect(result(page, 'Summary Setup').getByRole('button')).toBeDisabled();
  await expect(result(page, 'Summary Setup').locator('.settings-navigation-reason')).not.toBeEmpty();
  await search(page).fill('git footer');
  await expect(result(page, 'Git-footer Visibility').getByRole('button')).toBeDisabled();
  await page.screenshot({ path: info.outputPath('settings-unavailable-search.png'), animations: 'disabled' });
});

test('tool output expansion uses the existing browser preference and stays in Appearance', async ({ page, ownership }) => {
  await open(page, ownership);
  const stored = () => page.evaluate(() => localStorage.getItem('pi-webui-tool-output-expanded'));
  const initial = await stored();
  await search(page).fill('bash');
  await result(page, 'Tool output expansion').getByRole('button').click();
  await expect.poll(stored).not.toBe(initial);
  await expect(category(page, 'Appearance')).toHaveAttribute('aria-current', 'page');
  await expect(card(page, 'Tool output expansion').locator('..')).toContainText('Expanded');
  await card(page, 'Tool output expansion').click();
  await expect(card(page, 'Tool output expansion').locator('..')).toContainText('Collapsed');
  await page.reload();
  await expect(card(page, 'Tool output expansion').locator('..')).toContainText('Collapsed');
});

test('sampling late reads and writes cannot replace the peer session or its draft', async ({ page, ownership }) => {
  await open(page, ownership);
  const calls = [];
  await page.route(/\/api\/tabs\/[^/]+\/sampling-parameters/, route => {
    calls.push(route);
    if (route.request().method() === 'GET') return reply(route, sampling(route.request().url().includes(ownership.tabs[1].id) ? 0.4 : 0.7));
  });
  await category(page, 'Models and resources').click();
  const temperature = page.locator('[data-sampling-parameter="temperature"] input[type=number]');
  await expect(temperature).toHaveValue('0.7');
  await temperature.fill('0.9');
  await page.locator('#applySamplingParametersButton').click();
  await expect.poll(() => calls.filter(route => route.request().method() === 'PUT').length).toBe(1);
  const oldWrite = calls.find(route => route.request().method() === 'PUT');
  expect(oldWrite.request().url()).toContain(ownership.tabs[0].id);
  await selectTab(page, ownership.tabs[1].id);
  await expect(temperature).toHaveValue('0.4');
  await release(page, oldWrite, sampling(0.9));
  await temperature.fill('0.5');
  let held;
  await page.route(/\/api\/tabs\/[^/]+\/sampling-parameters/, route => {
    if (route.request().url().includes(ownership.tabs[1].id)) held = route;
    else return reply(route, sampling(0.7));
  });
  await page.locator('#reloadSamplingParametersButton').click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await selectTab(page, ownership.tabs[0].id);
  await release(page, held, sampling(0.1));
  await expect(temperature).not.toHaveValue('0.1');
});

test('runner configuration keeps project ownership across delayed loads, saves, reopen and detached events', async ({ page, ownership }, info) => {
  await open(page, ownership);
  await page.route(/\/api\/app-runners(?:\?|$)/, route => reply(route, runners(tabId(route))));
  const writes = [];
  await page.route(/\/api\/app-runner-config(?:\?|$)/, route => { writes.push(route); });
  await search(page).fill('discovery paths');
  await result(page, 'Runner configuration').getByRole('button').click();
  const dialog = page.locator('#appRunnerInfoDialog');
  await expect(dialog).toContainText(ownership.tabs[0].id);
  await page.locator('#appRunnerCustomLabelInput').fill('Original project');
  await page.locator('#appRunnerCustomPathInput').fill('dev/start.sh');
  const oldSave = await dialog.getByRole('button', { name: 'Add runner', exact: true }).elementHandle();
  await dialog.getByRole('button', { name: 'Add runner', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(tabId(writes[0])).toBe(ownership.tabs[0].id);
  await page.locator('#appRunnerInfoCloseButton').click();
  await card(page, 'Runner configuration').click();
  await expect(page.locator('#appRunnerCustomLabelInput')).toHaveValue('Original project');
  await page.locator('#appRunnerCustomLabelInput').fill('New dialog draft');
  await release(page, writes[0], runners('retired save'));
  await expect(page.locator('#appRunnerCustomLabelInput')).toHaveValue('New dialog draft');
  await oldSave.evaluate(node => node.click());
  expect(writes).toHaveLength(1);
  await page.locator('#appRunnerInfoCloseButton').click();
  let held;
  await page.route(/\/api\/app-runners(?:\?|$)/, route => {
    if (tabId(route) === ownership.tabs[0].id) held = route;
    else return reply(route, runners('peer project'));
  });
  await card(page, 'Runner configuration').click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.locator('#appRunnerInfoCloseButton').click();
  await selectTab(page, ownership.tabs[1].id);
  await page.unroute(/\/api\/app-runners(?:\?|$)/);
  await page.route(/\/api\/app-runners(?:\?|$)/, route => reply(route, runners('peer project')));
  await card(page, 'Runner configuration').click();
  await expect(dialog).toContainText('peer project');
  await release(page, held, runners('retired original load'));
  await expect(dialog).not.toContainText('retired original load');
  await expect(page.locator('#appRunnerCustomLabelInput')).toHaveValue('');
  await page.screenshot({ path: info.outputPath('settings-runner-project.png'), animations: 'disabled' });
  await selectTab(page, ownership.tabs[0].id, { behindDialog: true });
  await expect(dialog).toContainText('session or project changed');
  await expect(page.locator('#appRunnerCustomPathInput')).toHaveCount(0);
});

test('Git-footer batches retain the origin and stop after its target changes', async ({ page, ownership }) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-git-footer-webui-payload-cache', JSON.stringify({ raw: JSON.stringify({ type: 'firstpick.git-footer-status.footer', version: 1, visibility: { git: false } }) })));
  await open(page, ownership);
  const prompts = [];
  await page.route(/\/api\/prompt(?:\?|$)/, route => { prompts.push(route); });
  await search(page).fill('git footer');
  await result(page, 'Git-footer Visibility').getByRole('button').click();
  await expect(page.locator('#gitFooterVisibilityDialog')).toContainText('saved globally');
  const inputs = page.locator('#gitFooterVisibilityBody input');
  await inputs.first().uncheck();
  await page.locator('[data-git-footer-visibility-key=git]').check();
  await page.locator('#gitFooterVisibilityApplyButton').click();
  await expect.poll(() => prompts.length).toBe(1);
  expect(tabId(prompts[0])).toBe(ownership.tabs[0].id);
  expect(prompts[0].request().postDataJSON().message).toContain('hide webui');
  await selectTab(page, ownership.tabs[1].id, { behindDialog: true });
  await release(page, prompts[0], { accepted: true });
  await turn(page);
  expect(prompts).toHaveLength(1);
  await expect(page.locator('#gitFooterVisibilityDialog')).toBeHidden();
  await card(page, 'Git-footer Visibility').click();
  await page.locator('#gitFooterVisibilityResetButton').click();
  await expect.poll(() => prompts.length).toBe(2);
  expect(tabId(prompts[1])).toBe(ownership.tabs[1].id);
  expect(prompts[1].request().postDataJSON().message).toContain('reset webui');
  await release(page, prompts[1], { accepted: true });
  await inputs.first().uncheck();
  await page.locator('[data-git-footer-visibility-key=git]').check();
  await page.locator('#gitFooterVisibilityApplyButton').click();
  await expect.poll(() => prompts.length).toBe(3);
  await release(page, prompts[2], { accepted: true });
  await expect.poll(() => prompts.length).toBe(4);
  expect(prompts.slice(2).map(route => tabId(route))).toEqual([ownership.tabs[1].id, ownership.tabs[1].id]);
  expect(prompts[2].request().postDataJSON().message).toContain('hide webui');
  expect(prompts[3].request().postDataJSON().message).toContain('show webui');
  await release(page, prompts[3], { accepted: true });
  await expect(page.locator('#gitFooterVisibilityStatus')).toContainText('Saved 2 global');
});

test('Summary Setup ignores retired loads and requires the original target after confirmation', async ({ page, ownership }) => {
  await open(page, ownership);
  const calls = [];
  let hold = true;
  await page.route(/\/api\/session-summary\/preferences(?:\?|$)/, route => {
    calls.push(route);
    if (!hold && route.request().method() === 'GET') return reply(route, summary);
  });
  await category(page, 'Models and resources').click();
  await search(page).fill('cadence');
  await result(page, 'Summary Setup').getByRole('button').click();
  await expect.poll(() => calls.length).toBe(1);
  await closeNative(page);
  hold = false;
  await card(page, 'Runtime settings').click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('/settings');
  await release(page, calls[0], { ...summary, models: [] });
  await expect(page.locator('#nativeCommandTitle')).toHaveText('/settings');
  await expect(page.locator('#nativeCommandError')).toBeHidden();
  await closeNative(page);
  await card(page, 'Summary Setup').click();
  await expect(page.locator('.session-summary-setup-panel')).toContainText('Selected active-branch text');
  await page.locator('#nativeCommandActions').getByRole('button', { name: 'Save and generate', exact: true }).click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  await selectTab(page, ownership.tabs[1].id, { behindDialog: true });
  await page.locator('#confirmationConfirmButton').click();
  await turn(page);
  expect(calls.filter(route => route.request().method() !== 'GET')).toEqual([]);
  await expect(page.locator('#sessionSummaryOverlay')).toBeHidden();
});

test('Summary Setup saves only after explicit confirmation; a retired save cannot generate or close the next dialog', async ({ page, ownership }) => {
  await open(page, ownership);
  const writes = [];
  const generations = [];
  await page.route(/\/api\/session-summary\/preferences(?:\?|$)/, route => route.request().method() === 'GET' ? reply(route, summary) : writes.push(route));
  await page.route(/\/api\/session-summary\/generate(?:\?|$)/, route => { generations.push(route); return reply(route, { requested: true }); });
  await category(page, 'Models and resources').click();
  await card(page, 'Summary Setup').click();
  const save = page.locator('#nativeCommandActions').getByRole('button', { name: 'Save and generate', exact: true });
  await save.click();
  await expect(page.locator('#confirmationDialog')).toContainText('Global session-summary preferences');
  expect(writes).toEqual([]);
  await page.locator('#confirmationConfirmButton').click();
  await expect.poll(() => writes.length).toBe(1);
  expect(tabId(writes[0])).toBe(ownership.tabs[0].id);
  expect(writes[0].request().postDataJSON().confirmed).toBe(true);
  await closeNative(page);
  await card(page, 'Runtime settings').click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('/settings');
  await release(page, writes[0], summary);
  await expect(page.locator('#nativeCommandTitle')).toHaveText('/settings');
  await expect(page.locator('#nativeCommandDialog')).toBeVisible();
  expect(generations).toEqual([]);
});

test('Codex speed keeps its confirmation and original target; Summary Setup generates only after a confirmed current save', async ({ page, ownership }, info) => {
  await open(page, ownership);
  const speedWrites = [];
  await page.route(/\/api\/codex-fast-mode(?:\?|$)/, route => {
    if (route.request().method() === 'PUT') speedWrites.push({ tab: tabId(route), body: route.request().postDataJSON() });
    return reply(route, speed);
  });
  await category(page, 'Models and resources').click();
  await expect(page.locator('#codexFastModeSelect')).toBeEnabled();
  await page.locator('#codexFastModeSelect').selectOption('ultrafast');
  await page.locator('#setCodexFastModeButton').click();
  await expect(page.locator('#confirmationDialog')).toContainText('8x');
  expect(speedWrites).toEqual([]);
  await selectTab(page, ownership.tabs[1].id, { behindDialog: true });
  if (await page.locator('#confirmationDialog').isVisible()) await page.locator('#confirmationConfirmButton').click();
  await turn(page);
  expect(speedWrites).toEqual([]);
  await expect(page.locator('#codexFastModeSelect')).toBeEnabled();
  await page.locator('#codexFastModeSelect').selectOption('fast');
  await page.locator('#setCodexFastModeButton').click();
  await expect.poll(() => speedWrites).toEqual([{ tab: ownership.tabs[1].id, body: { mode: 'fast' } }]);
  const preferences = [];
  const generations = [];
  await page.route(/\/api\/session-summary\/preferences(?:\?|$)/, route => {
    if (route.request().method() === 'PUT') preferences.push({ tab: tabId(route), body: route.request().postDataJSON() });
    return reply(route, summary);
  });
  await page.route(/\/api\/session-summary\/generate(?:\?|$)/, route => {
    generations.push({ tab: tabId(route), body: route.request().postDataJSON() });
    return reply(route, { requested: true, summary: { version: 1, status: 'success', configured: true, title: 'Fixture summary', summaryMarkdown: '## Goal\n\nSettings homes verified.' } });
  });
  await card(page, 'Summary Setup').click();
  await expect(page.locator('.session-summary-setup-panel')).toBeVisible();
  await page.locator('#nativeCommandActions').getByRole('button', { name: 'Save and generate', exact: true }).click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  expect(preferences).toEqual([]);
  expect(generations).toEqual([]);
  await page.locator('#confirmationConfirmButton').click();
  await expect.poll(() => preferences.length).toBe(1);
  await expect.poll(() => generations).toEqual([{ tab: ownership.tabs[1].id, body: { refresh: true } }]);
  expect(preferences[0].tab).toBe(ownership.tabs[1].id);
  expect(preferences[0].body.confirmed).toBe(true);
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  await expect(page.locator('#sessionSummaryOverlay')).toBeVisible();
  await expect(page.locator('#sessionSummaryOverlay')).toContainText('Settings homes verified.');
  await page.screenshot({ path: info.outputPath('settings-confirmed-summary.png'), animations: 'disabled' });
});

test('a replacement session cannot reuse a held sampling load from the same tab', async ({ page, ownership }) => {
  await open(page, ownership);
  const original = (await ownership.api(`/api/state?tab=${ownership.tabs[0].id}`)).sessionId;
  await category(page, 'Models and resources').click();
  await expect(page.locator('#samplingParametersSupport')).toContainText('fake-model');
  let held;
  let holdNext = true;
  await page.route(/\/api\/tabs\/[^/]+\/sampling-parameters/, route => {
    if (holdNext) { holdNext = false; held = route; return; }
    return reply(route, sampling(0.3));
  });
  await page.locator('#reloadSamplingParametersButton').click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  if (!await page.locator('#newSessionButton').isVisible()) await page.locator('#composerActionsButton').click();
  await page.locator('#newSessionButton').click();
  await expect(page.locator('#confirmationDialog')).toBeVisible();
  await page.locator('#confirmationConfirmButton').click();
  await expect.poll(async () => (await ownership.api(`/api/state?tab=${ownership.tabs[0].id}`)).sessionId).not.toBe(original);
  await expect(page.locator('#confirmationDialog')).toBeHidden();
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
  await category(page, 'Models and resources').click();
  const temperature = page.locator('[data-sampling-parameter="temperature"] input[type=number]');
  await expect(temperature).toHaveValue('0.3');
  await release(page, held, sampling(0.1));
  await expect(temperature).toHaveValue('0.3');
});

test('runner configuration cannot save a draft after the same tab changes its working directory', async ({ page, ownership }) => {
  await open(page, ownership);
  await page.route(/\/api\/app-runners(?:\?|$)/, route => reply(route, runners('Original project')));
  const writes = [];
  await page.route(/\/api\/app-runner-config(?:\?|$)/, route => { writes.push(route); return reply(route, runners('Unexpected write')); });
  await category(page, 'System').click();
  await card(page, 'Runner configuration').click();
  await expect(page.locator('#appRunnerCustomPathInput')).toBeVisible();
  await page.locator('#appRunnerCustomPathInput').fill('original.sh');
  const retained = await page.locator('#appRunnerInfoDialog').getByRole('button', { name: 'Add runner', exact: true }).elementHandle();
  const newCwd = `${ownership.tabs[0].cwd}/../agent`;
  const response = await page.request.patch(`${ownership.baseURL}/api/tabs/${ownership.tabs[0].id}`, { data: { cwd: newCwd } });
  expect(response.ok()).toBe(true);
  await expect(page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`)).toHaveAttribute('data-tooltip', /Working folder: .*\/agent/);
  await retained.evaluate(node => node.click());
  await turn(page);
  expect(writes).toEqual([]);
  await page.locator('#appRunnerInfoCloseButton').click();
  await card(page, 'Runner configuration').click();
  await expect(page.locator('#appRunnerCustomPathInput')).toHaveValue('');
});


test('Git-footer context hide remains available without opening its Settings dialog', async ({ page, ownership }) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-git-footer-webui-payload-cache', JSON.stringify({ raw: JSON.stringify({
    type: 'firstpick.git-footer-status.footer', version: 1, generatedAt: Date.now(),
    main: [{ key: 'tokens', label: 'tokens', value: '0' }],
    meta: [{ key: 'cwd', label: 'cwd', value: 'fixture' }], visibility: {},
  }) })));
  const prompts = [];
  await page.route(/\/api\/prompt(?:\?|$)/, async route => {
    prompts.push(route.request());
    await reply(route, { accepted: true });
  });
  await open(page, ownership);
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.locator('.footer-workspace.footer-meta-action').click({ button: 'right' });
  await page.locator('#gitFooterContextMenu [data-git-footer-menu-action="disable"]').click();
  await expect.poll(() => prompts.length).toBe(1);
  expect(prompts[0].postDataJSON().message).toContain('/git-footer-visibility hide webui cwd');
  expect(new URL(prompts[0].url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  await expect(page.locator('#gitFooterVisibilityDialog')).toBeHidden();
});
