import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' } });

const sources = new Map(await Promise.all([
  'shell-context-actions.mjs', 'shell-context-actions.css', 'shell-tools-launcher.mjs',
  'shell-tools-launcher.css', 'shell-actions.mjs', 'styles.css',
].map(async (name) => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Action discovery component fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-tools-launcher.css">
<link rel="stylesheet" href="/shell-context-actions.css">
<style>body{margin:0;background:var(--bg);color:var(--text)}
#trigger,#allTools{margin:20px}.fixture-run{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}
.fixture-run button{flex-shrink:0;color:var(--danger)}
html.light{color-scheme:light;--bg:#eff1f5;--text:#4c4f69;--muted:#626880;--border:#bcc0cc;--panel:#e6e9ef;--panel-2:#dce0e8;--panel-3:#eff1f5;--accent:#8839ef;--accent-2:#179299;--warning:#805600;--danger:#d20f39;--shadow:#4c4f6933}</style>
</head><body><button id="trigger">Session actions</button><button id="allTools">All tools</button>
<div id="retained"></div><dialog id="nested"><h2>Action details</h2><button id="nestedClose">Close details</button></dialog>
<dialog id="outer"><button id="innerTrigger">Actions inside parent dialog</button></dialog>
<script type="module">
import { createContextActions } from '/shell-context-actions.mjs';
import { createToolsLauncher } from '/shell-tools-launcher.mjs';
window.target = Object.freeze({ tabId: 'fixture-tab', generation: 8, sessionIdentity: 'fixture-session', cwd: '/fixture' });
window.actions = Object.freeze([
  Object.freeze({ id: 'rename', label: 'Rename session', description: 'Give this conversation a clear name', category: 'Sessions', available: true, target }),
  Object.freeze({ id: 'compact', label: 'Compact context', description: 'Reduce the current context', category: 'Sessions', available: false, unavailableReason: 'Compaction is already running.', target }),
  Object.freeze({ id: 'fork', label: 'Fork session', description: 'Continue from a copy of this conversation', category: 'Sessions', available: true, target }),
]);
window.catalog = [...actions,
  { id: 'files', label: 'Files & search', description: 'Browse and edit project files', category: 'Project', keywords: 'directory annotate', target },
  { id: 'theme', label: 'Appearance', description: 'Change colors and backgrounds', category: 'Settings', keywords: 'theme light dark' },
];
window.invocations = []; window.moreCalls = []; window.closes = 0; window.stops = 0; window.openNested = false;
window.contextActions = createContextActions({ document,
  onInvoke(action) {
    invocations.push({ id: action.id, original: actions.includes(action), sameTarget: action.target === target });
    if (openNested) { contextActions.close(); document.getElementById('nested').showModal(); }
  },
  onMore(category) {
    moreCalls.push(category);
    contextActions.close();
    launcher.open({ actions: catalog, initialCategory: category });
  },
  onClose() { closes += 1; },
});
window.launcher = createToolsLauncher({ document });
window.runControls = contextActions.slots.runControls;
window.run = document.createElement('div'); run.className = 'fixture-run';
const runLabel = document.createElement('span'); runLabel.textContent = 'Fixture session · Response running';
window.stop = document.createElement('button'); stop.textContent = 'Stop fixture response'; stop.type = 'button';
stop.addEventListener('click', () => { stops += 1; }); run.append(runLabel, stop); runControls.append(run);
window.detachedAtConstruction = !contextActions.element.isConnected;
document.body.append(contextActions.element, launcher.element);
window.snapshot = () => ({ title: 'Session actions', actions, contextLabel: 'Fixture session · /fixture', category: 'Sessions' });
document.getElementById('trigger').addEventListener('click', (event) => contextActions.open(snapshot(), event.currentTarget));
document.getElementById('allTools').addEventListener('click', () => launcher.open({ actions: catalog }));
document.getElementById('nestedClose').addEventListener('click', () => document.getElementById('nested').close());
document.getElementById('innerTrigger').addEventListener('click', (event) => contextActions.open(snapshot(), event.currentTarget));
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.__actionDiscoveryErrors = errors;
  await page.route('http://actions.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const source = sources.get(pathname);
    await route.fulfill({ status: source || pathname === '/' ? 200 : 404,
      contentType: pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? (pathname === '/' ? fixture : '') });
  });
  await page.goto('http://actions.test/');
  await page.waitForFunction(() => window.ready);
});

test.afterEach(async ({ page }) => {
  expect(page.__actionDiscoveryErrors).toEqual([]);
});

const contextDialog = (page) => page.locator('#shellContextActions');
const contextRows = (page) => page.locator('.context-actions-action');
const launcherRows = (page) => page.locator('.tools-launcher-action');
const category = (page, name) => page.getByRole('navigation', { name: 'Tool categories' }).getByRole('button', { name, exact: true });
const openContext = (page) => page.getByRole('button', { name: 'Session actions', exact: true }).click();

test('initial category opens a subset while search still reaches every category and late records', async ({ page }) => {
  await page.evaluate(() => {
    catalog.push(...Array.from({ length: 125 }, (_, index) => ({ id: 'extra-' + index,
      label: 'Extra tool ' + index, category: 'Project', keywords: index === 124 ? 'rare-final-intent' : '' })));
    launcher.open({ actions: catalog, initialCategory: 'Sessions', pinnedIds: ['files'] });
  });
  await expect(category(page, 'Sessions')).toHaveAttribute('aria-pressed', 'true');
  await expect(launcherRows(page)).toHaveCount(3);
  await page.getByRole('searchbox').fill('rare-final-intent');
  await expect(launcherRows(page)).toHaveAccessibleName('Extra tool 124');
  await page.getByRole('searchbox').fill('theme');
  await expect(launcherRows(page)).toHaveAccessibleName('Appearance');
  await page.getByRole('searchbox').fill('');
  await expect(launcherRows(page)).toHaveCount(3);
  await page.evaluate(() => launcher.update({ actions: catalog, initialCategory: 'Project', contextLabel: 'Updated context' }));
  await expect(category(page, 'Sessions')).toHaveAttribute('aria-pressed', 'true');
  await category(page, 'Pinned').click();
  await expect(launcherRows(page)).toHaveAccessibleName('Files & search');
  await page.getByRole('button', { name: 'Close All tools' }).click();
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await expect(category(page, 'All')).toHaveAttribute('aria-pressed', 'true');
  await expect(launcherRows(page)).toHaveCount(130);
  await page.evaluate(() => { launcher.close(); launcher.open({ actions: catalog, initialCategory: 'Missing' }); });
  await expect(category(page, 'All')).toHaveAttribute('aria-pressed', 'true');
});

test('open while already open preserves the query, category, catalog, and pin state', async ({ page }) => {
  await page.evaluate(() => launcher.open({ actions: catalog, initialCategory: 'Sessions', pinnedIds: ['files'] }));
  await page.getByRole('searchbox').fill('theme');
  await page.evaluate(() => launcher.open({ contextLabel: 'Changed while open', initialCategory: 'Project' }));
  await expect(page.getByRole('searchbox')).toHaveValue('theme');
  await expect(launcherRows(page)).toHaveAccessibleName('Appearance');
  await page.getByRole('searchbox').fill('');
  await expect(category(page, 'Sessions')).toHaveAttribute('aria-pressed', 'true');
  await category(page, 'Pinned').click();
  await expect(launcherRows(page)).toHaveAccessibleName('Files & search');
});

test('context preserves supplied order, original action identity, and parent-owned closing', async ({ page }) => {
  await openContext(page);
  expect(await page.evaluate(() => detachedAtConstruction)).toBe(true);
  await expect(contextRows(page)).toHaveText([
    'Rename sessionGive this conversation a clear name',
    'Compact contextReduce the current context',
    'Fork sessionContinue from a copy of this conversation',
  ]);
  await expect(page.getByRole('button', { name: 'Rename session', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Fork session', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => invocations)).toEqual([{ id: 'rename', original: true, sameTarget: true }]);
  await expect(contextDialog(page)).toBeVisible();
  expect(await page.evaluate(() => Object.isFrozen(actions) && actions.every(Object.isFrozen))).toBe(true);
});

test('availability updates reject stale buttons and preserve focus on current records', async ({ page }) => {
  await openContext(page);
  await page.evaluate(() => {
    window.staleAction = document.querySelector('.context-actions-action');
    actions = [Object.freeze({ ...actions[0], label: 'Renamed action' }), ...actions.slice(1)];
    contextActions.update({ actions });
    staleAction.click();
  });
  await expect(page.getByRole('button', { name: 'Renamed action', exact: true })).toBeFocused();
  expect(await page.evaluate(() => invocations)).toEqual([]);
  await page.getByRole('button', { name: 'Renamed action', exact: true }).click();
  expect(await page.evaluate(() => invocations)).toEqual([{ id: 'rename', original: true, sameTarget: true }]);
  await page.evaluate(() => {
    window.newStaleAction = document.querySelector('.context-actions-action');
    actions = actions.map((action, index) => index === 0 ? Object.freeze({ ...action, available: false, unavailableReason: 'Session is changing.' }) : action);
    contextActions.update({ actions });
    newStaleAction.click();
  });
  await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeFocused();
  const unavailable = page.getByRole('button', { name: 'Renamed action', exact: true });
  await expect(unavailable).toBeDisabled();
  await expect(unavailable).toHaveAccessibleDescription('Session is changing.');
  await expect(page.getByText('Session is changing.', { exact: true })).toBeVisible();
  await unavailable.evaluate((button) => button.click());
  expect(await page.evaluate(() => invocations.length)).toBe(1);
  await page.evaluate(() => {
    actions = actions.map((action) => Object.freeze({ ...action, available: true }));
    contextActions.update({ actions });
  });
  await expect(unavailable).toBeEnabled();
  await expect(page.getByText('Session is changing.', { exact: true })).toBeHidden();
  await unavailable.click();
  expect(await page.evaluate(() => invocations.length)).toBe(2);
  await page.getByRole('button', { name: 'Fork session', exact: true }).focus();
  await page.evaluate(() => { actions = []; contextActions.update({ actions }); });
  await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeFocused();
  await expect(page.getByText('No actions available here. Browse all tools for more actions.')).toBeVisible();
});

test('disabled reasons have an accessible fallback and supplied strings render only as text', async ({ page }) => {
  await openContext(page);
  await expect(page.getByRole('button', { name: 'Compact context', exact: true })).toHaveAccessibleDescription('Compaction is already running.');
  const unsafe = '<img src=x onerror="window.injected=true">';
  await page.evaluate((unsafe) => contextActions.update({
    title: unsafe, contextLabel: unsafe,
    actions: [{ id: 'unsafe', label: unsafe, description: unsafe, available: false, unavailableReason: unsafe },
      { id: 'fallback', label: 'Unavailable action', available: false }],
  }), unsafe);
  await expect(contextRows(page).first()).toHaveAccessibleName(unsafe);
  await expect(contextRows(page).first()).toHaveAccessibleDescription(unsafe);
  await expect(page.getByRole('button', { name: 'Unavailable action', exact: true })).toHaveAccessibleDescription('This action is currently unavailable.');
  expect(await contextDialog(page).locator('img').count()).toBe(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
});

test('More actions passes the current category and parent transition returns focus to the original opener', async ({ page }) => {
  await openContext(page);
  await page.evaluate(() => contextActions.update({ category: 'Project' }));
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(contextDialog(page)).not.toBeVisible();
  await expect(category(page, 'Project')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => moreCalls)).toEqual(['Project']);
  await expect(launcherRows(page)).toHaveAccessibleName('Files & search');
  await page.getByRole('searchbox').fill('theme');
  await expect(launcherRows(page)).toHaveAccessibleName('Appearance');
  // Chromium first uses Escape to clear a native search input's nonempty query.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('searchbox')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Session actions', exact: true })).toBeFocused();
  expect(await page.evaluate(() => closes)).toBe(1);
});

test('Escape, immediate reopen, nested native transitions, and hidden or removed openers are safe', async ({ page }) => {
  await openContext(page);
  await page.evaluate(() => document.getElementById('allTools').focus());
  await expect(page.getByRole('button', { name: 'Rename session', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(contextDialog(page)).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Session actions', exact: true })).toBeFocused();
  await page.evaluate(() => {
    contextActions.open(snapshot(), document.getElementById('trigger'));
    contextActions.close();
    contextActions.open(snapshot(), document.getElementById('trigger'));
  });
  await expect(contextDialog(page)).toBeVisible();
  await expect.poll(() => page.evaluate(() => closes)).toBe(2);
  await page.evaluate(() => { openNested = true; });
  await page.getByRole('button', { name: 'Rename session', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Session actions', exact: true })).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Close details' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Session actions', exact: true })).toBeFocused();
  await page.evaluate(() => document.getElementById('outer').showModal());
  await page.getByRole('button', { name: 'Actions inside parent dialog' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Actions inside parent dialog' })).toBeFocused();
  await page.evaluate(() => document.getElementById('outer').close());
  await openContext(page);
  await page.evaluate(() => { document.getElementById('trigger').hidden = true; });
  await page.keyboard.press('Escape');
  await expect(contextDialog(page)).not.toBeVisible();
  expect(await page.evaluate(() => document.activeElement.id)).not.toBe('trigger');
  await page.evaluate(() => {
    const temporaryTrigger = document.createElement('button');
    document.body.append(temporaryTrigger);
    contextActions.open(snapshot(), temporaryTrigger);
    temporaryTrigger.remove();
  });
  await page.keyboard.press('Escape');
  await expect(contextDialog(page)).not.toBeVisible();
});

test('run-control slot survives updates, native focus remains bounded, and disposal revokes stale listeners', async ({ page }) => {
  const before = await page.evaluate(() => ({ length: history.length, href: location.href }));
  await openContext(page);
  await page.getByRole('button', { name: 'Stop fixture response' }).focus();
  await page.evaluate(() => contextActions.update({ contextLabel: 'Updated fixture session' }));
  await expect(page.getByRole('button', { name: 'Stop fixture response' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => stops)).toBe(1);
  expect(await page.evaluate(() => contextActions.slots.runControls === runControls && run.parentNode === runControls && run.lastChild === stop)).toBe(true);
  await page.getByRole('button', { name: 'Close context actions' }).focus();
  await page.keyboard.press('Shift+Tab');
  if (await page.evaluate(() => !document.hasFocus())) await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'More actions', exact: true })).toBeFocused();
  await page.evaluate(() => {
    window.staleAction = document.querySelector('.context-actions-action');
    window.staleMore = document.querySelector('.context-actions-more');
    window.staleClose = document.querySelector('.context-actions-close');
    document.getElementById('retained').append(run);
    contextActions.dispose(); contextActions.dispose();
    contextActions.open(snapshot()); contextActions.update(snapshot()); contextActions.close();
    staleAction.click(); staleMore.click(); staleClose.click(); stop.click();
  });
  await expect(contextDialog(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Session actions', exact: true })).toBeFocused();
  expect(await page.evaluate(() => ({ closes, invocations, moreCalls, stops, retained: run.parentNode.id,
    navigation: { length: history.length, href: location.href } }))).toEqual({ closes: 1, invocations: [], moreCalls: [], stops: 2, retained: 'retained', navigation: before });
});

for (const [width, height] of [[1100, 800], [320, 568]]) {
  test(`bounded context layout and reachable controls at ${width}px in dark and light`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await openContext(page);
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => document.documentElement.classList.toggle('light', theme === 'light'), theme);
      await page.screenshot({ path: testInfo.outputPath(`context-${width}-${theme}-short.png`), animations: 'disabled' });
    }
    await page.evaluate(() => contextActions.update({
      title: 'Session actions for ' + 'LongUnbrokenSessionName'.repeat(3),
      contextLabel: 'Fixture session · ' + '/long-project-path'.repeat(12),
      actions: [...actions, ...Array.from({ length: 8 }, (_, index) => ({ id: 'extra-' + index,
        label: index === 0 ? 'LongUnbrokenActionLabel'.repeat(6) : 'Session action ' + index,
        description: 'A longer action description that must wrap and remain readable on a narrow screen.' }))],
    }));
    for (const theme of ['dark', 'light']) {
      await page.evaluate((theme) => document.documentElement.classList.toggle('light', theme === 'light'), theme);
      await page.evaluate(() => { document.querySelector('.context-actions-body').scrollTop = 0; });
      for (const name of ['Close context actions', 'Stop fixture response', 'More actions']) {
        const control = page.getByRole('button', { name, exact: true });
        const bounds = await control.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
        await control.click({ trial: true });
      }
      const geometry = await page.evaluate(() => {
        const bounds = contextActions.element.getBoundingClientRect();
        const body = document.querySelector('.context-actions-body');
        return { left: bounds.left, right: bounds.right, bottom: bounds.bottom,
          overflow: document.documentElement.scrollWidth > innerWidth,
          bodyOverflow: body.scrollWidth > body.clientWidth, scrollable: body.scrollHeight > body.clientHeight };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(width);
      expect(geometry.bottom).toBeLessThanOrEqual(height);
      expect(geometry.overflow).toBe(false);
      expect(geometry.bodyOverflow).toBe(false);
      expect(geometry.scrollable).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`context-${width}-${theme}.png`), animations: 'disabled' });
      await contextRows(page).last().focus();
      await expect(contextRows(page).last()).toBeInViewport();
      await page.getByRole('button', { name: 'Stop fixture response' }).click();
    }
    expect(await page.evaluate(() => stops)).toBe(2);
  });
}
