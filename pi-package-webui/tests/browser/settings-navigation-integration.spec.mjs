import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

const categories = [
  ['appearance', 'Appearance'],
  ['resources', 'Models and resources'],
  ['features', 'Features'],
  ['accounts', 'Accounts'],
  ['voice', 'Voice'],
  ['connection', 'Connection'],
  ['system', 'System'],
  ['help', 'Help'],
];
const search = (page) => page.getByRole('searchbox', { name: 'Search settings', exact: true });
const categoryNavigation = (page) => page.getByRole('navigation', { name: 'Settings categories', exact: true });
const destinations = (page) => page.getByRole('navigation', { name: 'Workspace destinations' });
const searchResults = (page) => page.getByRole('list', { name: 'Settings search results', exact: true });
const settingResult = (page, label) => searchResults(page).getByRole('listitem')
  .filter({ has: page.getByText(label, { exact: true }) });

// Keep the normal package runner portable; the isolated worker config selects system Chromium.
test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
test.setTimeout(45_000);

async function openFocused(page, ownership, query = '') {
  await page.addInitScript(() => {
    const key = 'pi-webui-shell-preferences-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ v: 1, desktopLayout: 'focused' }));
    history.replaceState({ ...history.state, settingsNavigationExternal: { keep: 'original history' } }, '');
  });
  const url = new URL(ownership.baseURL);
  url.search = query;
  url.searchParams.set('tab', ownership.tabs[0].id);
  await page.goto(url.href);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await expect(page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`))
    .toHaveAttribute('aria-selected', 'true');
  // Fresh fixture servers migrate initial layout defaults asynchronously. Observe
  // Settings writes only after that existing startup migration has persisted.
  await expect.poll(async () => {
    const { layout } = await ownership.api('/api/interface-preferences');
    const panel = layout?.sidePanel;
    return !!panel?.placement && Array.isArray(panel?.sectionLayout?.order)
      && typeof panel?.collapsedPanels?.right === 'boolean' && Number.isFinite(panel?.panelWidths?.right);
  }).toBe(true);
}

async function openSettings(page) {
  await destinations(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(search(page)).toBeVisible();
  await expect(categoryNavigation(page)).toBeVisible();
}

async function expectLocation(page, category, setting = null) {
  await expect.poll(() => {
    const params = new URL(page.url()).searchParams;
    return [params.get('view'), params.get('inspector'), params.get('setting')];
  }).toEqual(['settings', `settings:${category}`, setting]);
  const label = categories.find(([id]) => id === category)[1];
  await expect(categoryNavigation(page).getByRole('button', { name: label, exact: true }))
    .toHaveAttribute('aria-current', 'page');
}

async function preferenceSnapshot(page) {
  return page.evaluate(() => Object.fromEntries(Object.keys(localStorage).sort()
    .filter((key) => /^pi-webui-(shell-preferences|theme|control-visibility)/.test(key))
    .map((key) => [key, localStorage.getItem(key)])));
}

function observePreferenceWrites(page) {
  const writes = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (!['GET', 'HEAD'].includes(request.method()) &&
        /^\/api\/(settings|interface-preferences|themes|tools|skills)(\/|$)/.test(path)) {
      writes.push({ method: request.method(), path, body: request.postData() });
    }
  });
  return writes;
}

async function revealTheme(page) {
  await search(page).fill('Theme');
  const theme = settingResult(page, 'Theme').getByRole('button', { name: /^Theme(?:\s|$)/ });
  await expect(theme).toHaveCount(1);
  await theme.click();
  // The canonical Theme select opens its existing searchable picker when focused.
  await expectLocation(page, 'appearance', 'theme');
  await expect(page.locator('#themeSearchInput')).toBeVisible();
  await expect(page.locator('#themeSearchInput')).toBeFocused();
}

test('actual Settings exposes accessible categories and searches without changing preferences', async ({ page, ownership }, testInfo) => {
  await openFocused(page, ownership);
  await openSettings(page);
  await expect(categoryNavigation(page).getByRole('button')).toHaveText(categories.map(([, label]) => label));
  await expectLocation(page, 'appearance');
  for (const [id, label] of categories) {
    await categoryNavigation(page).getByRole('button', { name: label, exact: true }).click();
    await expectLocation(page, id);
  }
  const appearance = categoryNavigation(page).getByRole('button', { name: 'Appearance', exact: true });
  await appearance.focus();
  await page.keyboard.press('End');
  await expect(categoryNavigation(page).getByRole('button', { name: 'Help', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(appearance).toBeFocused();
  await page.keyboard.press('Enter');
  await expectLocation(page, 'appearance');

  const before = await preferenceSnapshot(page);
  const writes = observePreferenceWrites(page);
  await search(page).fill('Theme');
  await expect(settingResult(page, 'Theme').getByRole('button', { name: /^Theme(?:\s|$)/ })).toBeVisible();
  await search(page).fill('w5 no matching setting 7a658114');
  await expect(page.getByRole('status').filter({ hasText: 'No matching settings. Try another name or purpose.' })).toBeVisible();
  await expect(searchResults(page).getByRole('listitem')).toHaveCount(0);
  await search(page).press('Enter');
  await expectLocation(page, 'appearance');
  await search(page).press('Escape');
  await expect(search(page)).toHaveValue('');
  await expect(search(page)).toBeFocused();
  expect(await preferenceSnapshot(page)).toEqual(before);
  expect(writes).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('actual-settings-appearance.png'), animations: 'disabled' });
});

test('Theme search focuses the original control and restores its anchor through Back and Forward', async ({ page, ownership }, testInfo) => {
  await openFocused(page, ownership, 'custom=keep&another=value');
  await page.evaluate(() => {
    history.replaceState(history.state, '', `${location.href}#settings-fragment`);
    window.settingsOriginalTheme = document.querySelector('#themeSelect');
  });
  await openSettings(page);
  const before = await preferenceSnapshot(page);
  const writes = observePreferenceWrites(page);
  await revealTheme(page);
  expect(await page.locator('#themeSelect').evaluate((node) => node === window.settingsOriginalTheme)).toBe(true);
  await expect(page.locator('#themeSelect')).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath('actual-settings-theme-focus.png'), animations: 'disabled' });
  await destinations(page).getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-destination', 'conversation');
  await page.goBack();
  await expectLocation(page, 'appearance', 'theme');
  expect(new URL(page.url()).searchParams.get('custom')).toBe('keep');
  expect(new URL(page.url()).searchParams.get('another')).toBe('value');
  expect(new URL(page.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  expect(new URL(page.url()).hash).toBe('#settings-fragment');
  expect(await page.evaluate(() => history.state.settingsNavigationExternal)).toEqual({ keep: 'original history' });
  await expect(page.locator('#themeSearchInput')).toBeVisible();
  await expect(page.locator('#themeSearchInput')).toBeFocused();
  expect(await page.locator('#themeSelect').evaluate((node) => node === window.settingsOriginalTheme)).toBe(true);
  await page.goForward();
  await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-destination', 'conversation');
  const url = new URL(page.url());
  expect(url.searchParams.get('custom')).toBe('keep');
  expect(url.searchParams.get('another')).toBe('value');
  expect(url.searchParams.get('tab')).toBe(ownership.tabs[0].id);
  expect(url.hash).toBe('#settings-fragment');
  expect(await page.evaluate(() => history.state.settingsNavigationExternal)).toEqual({ keep: 'original history' });
  expect(await preferenceSnapshot(page)).toEqual(before);
  expect(writes).toEqual([]);
});

test('Models and resources opens Tools Setup through the actual Tools Settings entry', async ({ page, ownership }) => {
  // The fake Pi does not advertise companion commands; only its command catalog is supplied here.
  await page.route('**/api/commands?*', (route) => route.fulfill({ json: {
    ok: true, data: { commands: [{ name: 'tools', source: 'extension', description: 'Configure tools' }] },
  } }));
  await openFocused(page, ownership);
  await openSettings(page);
  await categoryNavigation(page).getByRole('button', { name: 'Models and resources', exact: true }).click();
  await expectLocation(page, 'resources');
  await search(page).fill('Tools');
  const tools = settingResult(page, 'Tools');
  await expect(tools).toHaveCount(1);
  const before = await preferenceSnapshot(page);
  const writes = observePreferenceWrites(page);
  await tools.getByRole('button', { name: /^Tools(?:\s|$)/ }).click();
  await expect(page.locator('#nativeCommandDialog')).toBeVisible();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('Tools Setup');
  await expect(page.locator('.native-resource-scope select')).toHaveValue('session');
  await expect(page.locator('.native-resource-scope select option')).toHaveText(['Session only', 'Global default', 'Model default']);
  await expect(page.locator('.native-selector-item').filter({ hasText: 'bash' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-destination', 'settings');
  expect(await preferenceSnapshot(page)).toEqual(before);
  expect(writes).toEqual([]);
});

test('invalid category and entry anchors replace history without changing the session or preferences', async ({ page, ownership }) => {
  await openFocused(page, ownership);
  await openSettings(page);
  const initialSession = await ownership.api(`/api/state?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  const before = await preferenceSnapshot(page);
  const writes = observePreferenceWrites(page);
  for (const [query, category] of [
    ['view=settings', 'appearance'],
    ['view=settings&inspector=settings:does-not-exist', 'appearance'],
    ['view=settings&inspector=settings:appearance&setting=does-not-exist', 'appearance'],
    ['view=settings&inspector=settings:resources&setting=does-not-exist', 'resources'],
  ]) {
    await destinations(page).getByRole('button', { name: 'Conversation', exact: true }).click();
    const url = new URL(ownership.baseURL);
    url.search = query;
    url.searchParams.set('tab', ownership.tabs[0].id);
    url.searchParams.set('custom', 'keep-recovery');
    url.hash = 'recovery-fragment';
    const historyLength = await page.evaluate(() => history.length);
    await page.goto(url.href);
    await expect(search(page)).toBeVisible();
    await expectLocation(page, category);
    expect(await page.evaluate(() => history.length)).toBe(historyLength + 1);
    expect(new URL(page.url()).searchParams.get('custom')).toBe('keep-recovery');
    expect(new URL(page.url()).hash).toBe('#recovery-fragment');
    expect(await page.evaluate(() => history.state.settingsNavigationExternal)).toEqual({ keep: 'original history' });
    await page.goBack();
    await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-destination', 'conversation');
    await page.goForward();
    await expectLocation(page, category);
    const currentSession = await ownership.api(`/api/state?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
    expect(currentSession.sessionId).toBe(initialSession.sessionId);
    await expect(page.locator(`#tabBar [data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-button`))
      .toHaveAttribute('aria-selected', 'true');
    expect(await preferenceSnapshot(page)).toEqual(before);
    expect(writes).toEqual([]);
  }
});

test('Settings search and canonical controls retain the composer draft through Classic and back', async ({ page, ownership }) => {
  await openFocused(page, ownership);
  const initialSession = await ownership.api(`/api/state?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  const prompt = page.locator('#promptInput');
  await prompt.fill('keep my Settings navigation draft');
  await page.evaluate(() => {
    window.settingsCanonicalControls = Object.fromEntries(['promptInput', 'sendButton', 'modelSelect', 'themeSelect', 'desktopShellSelect']
      .map((id) => [id, document.getElementById(id)]));
    document.querySelector('#promptInput').setSelectionRange(5, 14, 'backward');
  });
  await openSettings(page);
  await revealTheme(page);
  await search(page).fill('Theme');
  await search(page).evaluate((input) => input.setSelectionRange(1, 4, 'backward'));
  await destinations(page).getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(prompt).toHaveValue('keep my Settings navigation draft');
  await destinations(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(search(page)).toHaveValue('Theme');
  expect(await search(page).evaluate((input) => [input.selectionStart, input.selectionEnd, input.selectionDirection]))
    .toEqual([1, 4, 'backward']);
  await search(page).press('Escape');
  await expect(page.locator('#desktopShellSelect')).toBeVisible();
  await page.locator('#desktopShellSelect').selectOption('classic');
  await expect(page.locator('#focusedWorkspace')).toBeHidden();
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue('keep my Settings navigation draft');
  // Classic restores the existing Controls section; open its disclosure through its own button if needed.
  if (!await page.locator('#desktopShellSelect').isVisible()) {
    await page.locator('#sidePanelSectionToggleControls').click();
  }
  await page.locator('#desktopShellSelect').selectOption('focused');
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await openSettings(page);
  await revealTheme(page);
  expect(await page.evaluate(() => Object.entries(window.settingsCanonicalControls)
    .every(([id, node]) => node === document.getElementById(id) && document.querySelectorAll(`#${id}`).length === 1))).toBe(true);
  await destinations(page).getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(prompt).toHaveValue('keep my Settings navigation draft');
  await expect(page.locator('#sendButton')).toBeVisible();
  await expect(page.locator('#modelSelect')).toBeAttached();
  expect(await prompt.evaluate((input) => [input.selectionStart, input.selectionEnd, input.selectionDirection]))
    .toEqual([5, 14, 'backward']);
  expect((await ownership.api(`/api/state?tab=${encodeURIComponent(ownership.tabs[0].id)}`)).sessionId).toBe(initialSession.sessionId);
});

test('Back and Forward replace stale Settings anchors without adding history or applying settings', async ({ page, ownership }) => {
  await openFocused(page, ownership, 'external=keep');
  await openSettings(page);
  const before = await preferenceSnapshot(page);
  const writes = observePreferenceWrites(page);
  for (const [inspector, setting, expectedCategory] of [
    ['settings:resources', 'removed-setting', 'resources'],
    ['settings:removed-category', 'theme', 'appearance'],
  ]) {
    await page.evaluate(({ inspector, setting }) => {
      const url = new URL(location.href);
      url.searchParams.set('view', 'settings');
      url.searchParams.set('inspector', inspector);
      url.searchParams.set('setting', setting);
      url.hash = 'preserved-fragment';
      history.replaceState({ ...history.state, externalKeep: 'yes', focusedShellState: { destination: 'settings', inspector, setting } }, '', url);
    }, { inspector, setting });
    await destinations(page).getByRole('button', { name: 'Conversation', exact: true }).click();
    const length = await page.evaluate(() => history.length);
    await page.goBack();
    await expectLocation(page, expectedCategory);
    expect(await page.evaluate(() => history.state.focusedShellState)).toEqual({ destination: 'settings', inspector: `settings:${expectedCategory}` });
    expect(await page.evaluate(() => history.state.externalKeep)).toBe('yes');
    expect(await page.evaluate(() => history.length)).toBe(length);
    expect(new URL(page.url()).searchParams.get('external')).toBe('keep');
    expect(new URL(page.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
    expect(new URL(page.url()).hash).toBe('#preserved-fragment');
    await expect(page.locator('#nativeCommandDialog')).toBeHidden();
    await page.goForward();
    await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-destination', 'conversation');
    await page.goBack();
    await expectLocation(page, expectedCategory);
    expect(await page.evaluate(() => history.state.focusedShellState)).toEqual({ destination: 'settings', inspector: `settings:${expectedCategory}` });
    expect(await page.evaluate(() => history.length)).toBe(length);
  }
  expect(await preferenceSnapshot(page)).toEqual(before);
  expect(writes).toEqual([]);
});

for (const width of [1100, 1440]) {
  test(`sidebar Settings gear opens the canonical page at ${width}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openFocused(page, ownership);
    await page.locator('#promptInput').fill('Keep my settings draft');
    const actions = page.locator('#focusedWorkspace .terminal-sidebar-actions');
    const gear = actions.getByRole('button', { name: 'Settings', exact: true });
    await expect(gear).toBeVisible();
    const home = await actions.locator('#workspaceDashboardToggleButton').boundingBox();
    const bounds = await gear.boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(home.x + home.width);
    expect(Math.abs(bounds.y - home.y)).toBeLessThan(2);
    await gear.focus();
    await gear.press('Enter');
    await expect(search(page)).toBeVisible();
    await expectLocation(page, 'appearance');
    await expect(gear).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#desktopShellSelect')).toHaveCount(1);
    await page.screenshot({ path: info.outputPath('settings-sidebar-gear.png') });
    await page.goBack();
    await expect(page.locator('#promptInput')).toBeVisible();
    await expect(page.locator('#promptInput')).toHaveValue('Keep my settings draft');
    await gear.click();
    await page.locator('#focusedNavigationSelect').selectOption('top');
    await expect(gear).toBeHidden();
    await page.locator('#focusedNavigationSelect').selectOption('left');
    await expect(gear).toBeVisible();
    await page.locator('#desktopShellSelect').selectOption('classic');
    await expect(page.locator('.terminal-settings-button')).toBeHidden();
    await expect(page.locator('#promptInput')).toHaveValue('Keep my settings draft');
  });
}
