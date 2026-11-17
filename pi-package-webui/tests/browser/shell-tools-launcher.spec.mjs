import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' } });

const sources = new Map(await Promise.all([
  'shell-tools-launcher.mjs', 'shell-actions.mjs', 'shell-tools-launcher.css', 'styles.css',
].map(async (name) => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>All tools contract fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-tools-launcher.css">
<style>body{margin:0;background:var(--bg);color:var(--text)}
#trigger{margin:20px}.fixture-run{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px}
.fixture-run button{flex-shrink:0;color:var(--danger)}
html.light{color-scheme:light;--bg:#eff1f5;--text:#4c4f69;--muted:#626880;--border:#bcc0cc;--panel:#e6e9ef;--panel-2:#dce0e8;--panel-3:#eff1f5;--accent:#8839ef;--accent-2:#179299;--warning:#805600;--danger:#d20f39;--shadow:#4c4f6933}</style>
</head><body><button id="trigger">All tools</button><div id="retained"></div>
<script type="module">
import { createToolsLauncher } from '/shell-tools-launcher.mjs';
window.invocations = []; window.pinChanges = []; window.closes = 0;
window.target = Object.freeze({ tabId: 'fixture-tab', generation: 8, sessionIdentity: 'fixture-session', cwd: '/fixture' });
window.actions = [
  { id: 'files', label: 'Files & search', description: 'Browse and edit project files', category: 'Project', keywords: 'directory annotate', available: true, target },
  { id: 'compact', label: 'Compact context', description: 'Reduce the current context', category: 'Sessions', keywords: 'tokens', available: false, unavailableReason: 'Compaction is already running.', target },
  { id: 'queue', label: 'Follow-up queue', description: 'Review prompts waiting for this session', category: 'Activity', keywords: 'steer reorder', available: true, target },
  { id: 'theme', label: 'Appearance', description: 'Change colors and backgrounds', category: 'Settings', keywords: 'theme light dark', available: true },
];
window.launcher = createToolsLauncher({ document,
  onInvoke(action) { invocations.push({ id: action.id, original: actions.includes(action), sameTarget: action.target === target }); },
  onPinsChange(ids) { pinChanges.push(ids); }, onClose() { closes += 1; },
});
window.runControls = launcher.slots.runControls;
window.run = document.createElement('div'); run.className = 'fixture-run';
const runLabel = document.createElement('span'); runLabel.textContent = 'Fixture session · Response running';
window.stop = document.createElement('button'); stop.textContent = 'Stop fixture response'; stop.type = 'button';
window.stops = 0; stop.addEventListener('click', () => { stops += 1; });
run.append(runLabel, stop); runControls.append(run);
window.detachedAtConstruction = !launcher.element.isConnected;
document.body.append(launcher.element);
window.snapshot = () => ({ actions, pinnedIds: ['queue'], contextLabel: 'Fixture session · /fixture' });
document.getElementById('trigger').addEventListener('click', () => launcher.open(snapshot()));
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('http://tools.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const source = sources.get(pathname);
    await route.fulfill({ status: source || pathname === '/' ? 200 : 404,
      contentType: pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? (pathname === '/' ? fixture : '') });
  });
  await page.goto('http://tools.test/');
  await page.waitForFunction(() => window.ready);
  await page.getByRole('button', { name: 'All tools', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Search all tools' })).toBeFocused();
  page.__launcherErrors = errors;
});

test.afterEach(async ({ page }) => {
  expect(page.__launcherErrors).toEqual([]);
});

const actionButtons = (page) => page.locator('.tools-launcher-action');
const category = (page, name) => page.getByRole('navigation', { name: 'Tool categories' }).getByRole('button', { name, exact: true });

test('uses supplied categories and searches the complete catalog without dropping input focus', async ({ page }) => {
  expect(await page.evaluate(() => detachedAtConstruction)).toBe(true);
  await expect(actionButtons(page)).toHaveCount(4);
  await category(page, 'Project').click();
  await expect(category(page, 'Project')).toBeFocused();
  await expect(actionButtons(page)).toHaveText(['Files & searchBrowse and edit project filesProject']);
  const search = page.getByRole('searchbox');
  await search.fill('steer');
  await expect(actionButtons(page)).toHaveCount(1);
  await expect(actionButtons(page).first()).toHaveAccessibleName('Follow-up queue');
  await expect(search).toBeFocused();
  await expect(page.getByRole('status')).toHaveText('1 results across all tools');
  await search.fill('no match');
  await expect(page.getByText('No matching tools. Try another name or purpose.')).toBeVisible();
  await page.evaluate(() => {
    actions = Array.from({ length: 125 }, (_, index) => ({ id: 'action-' + index,
      label: 'Catalog tool ' + index, description: 'Shared purpose', category: 'Project', keywords: index === 124 ? 'rare-final-intent' : '' }));
    launcher.update({ actions });
  });
  await search.fill('');
  await expect(actionButtons(page)).toHaveCount(125);
  await search.fill('shared purpose');
  await expect(actionButtons(page)).toHaveCount(125);
  await search.fill('rare-final-intent');
  await expect(actionButtons(page)).toHaveCount(1);
  await expect(actionButtons(page)).toHaveAccessibleName('Catalog tool 124');
  await expect(search).toBeFocused();
});

test('emits original action and target references and leaves execution and closing to the parent', async ({ page }) => {
  await page.getByRole('button', { name: 'Files & search', exact: true }).click();
  expect(await page.evaluate(() => invocations)).toEqual([{ id: 'files', original: true, sameTarget: true }]);
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.evaluate(() => {
    const replacement = Object.freeze({ ...actions[0], target: Object.freeze({ ...target, generation: 9 }) });
    actions = [replacement];
    launcher.update({ actions });
    window.expectedAction = replacement;
    window.expectedTarget = replacement.target;
  });
  await page.getByRole('button', { name: 'Files & search', exact: true }).click();
  expect(await page.evaluate(() => invocations[1])).toEqual({ id: 'files', original: true, sameTarget: false });
  expect(await page.evaluate(() => actions[0] === expectedAction && actions[0].target === expectedTarget)).toBe(true);
});

test('renders unavailable reasons and treats all supplied strings as text', async ({ page }) => {
  const disabled = page.getByRole('button', { name: 'Compact context', exact: true });
  await expect(disabled).toBeDisabled();
  await expect(disabled).toHaveAccessibleDescription('Compaction is already running.');
  await expect(page.getByText('Compaction is already running.', { exact: true })).toBeVisible();
  await disabled.evaluate((button) => button.click());
  expect(await page.evaluate(() => invocations)).toEqual([]);
  const unsafe = '<img src=x onerror="window.injected=true">';
  await page.evaluate((unsafe) => {
    actions = [{ id: 'unsafe', label: unsafe, description: unsafe, category: unsafe, available: false, unavailableReason: unsafe }];
    launcher.update({ actions, contextLabel: unsafe });
  }, unsafe);
  await expect(actionButtons(page)).toHaveAccessibleName(unsafe);
  expect(await page.locator('#shellToolsLauncher img').count()).toBe(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await expect(category(page, unsafe)).toBeVisible();
});

test('pins and unpins with stable focus and a deduplicated maximum of 20 IDs', async ({ page }) => {
  await page.getByRole('button', { name: 'Pin Files & search', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unpin Files & search', exact: true })).toBeFocused();
  expect(await page.evaluate(() => pinChanges)).toEqual([['queue', 'files']]);
  await category(page, 'Pinned').click();
  await expect(actionButtons(page)).toHaveCount(2);
  await page.getByRole('button', { name: 'Unpin Files & search', exact: true }).click();
  await expect(page.getByRole('searchbox')).toBeFocused();
  await expect(actionButtons(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Unpin Follow-up queue', exact: true }).click();
  await expect(page.getByText('No pinned tools. Pin a tool from All to keep it here.')).toBeVisible();
  await page.evaluate(() => {
    actions = Array.from({ length: 22 }, (_, index) => ({ id: 'pin-' + index, label: 'Tool ' + index, category: 'Project' }));
    launcher.update({ actions, pinnedIds: ['pin-0', 'pin-0', ...actions.map((action) => action.id)] });
  });
  await category(page, 'All').click();
  await expect(page.locator('.tools-launcher-pin[aria-pressed="true"]')).toHaveCount(20);
  await expect(page.getByRole('button', { name: 'Pin Tool 20', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pin Tool 20', exact: true })).toHaveAttribute('title', /20 tools/);
  await page.getByRole('button', { name: 'Unpin Tool 0', exact: true }).click();
  await page.getByRole('button', { name: 'Pin Tool 20', exact: true }).click();
  expect(await page.evaluate(() => pinChanges.at(-1))).toEqual(Array.from({ length: 20 }, (_, i) => 'pin-' + (i + 1)));
  await page.evaluate(() => pinChanges.at(-1).push('pin-21'));
  await category(page, 'Pinned').click();
  await expect(actionButtons(page)).toHaveCount(20);
});

test('keyboard navigation skips unavailable actions and keeps parent run controls reachable', async ({ page }) => {
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Files & search', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Follow-up queue', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Files & search', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('button', { name: 'Appearance', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => invocations.length)).toBe(1);
  await page.getByRole('searchbox').fill('steer');
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => invocations.at(-1).id)).toBe('queue');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Stop fixture response' })).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => stops)).toBe(1);
  await page.evaluate(() => launcher.update({ contextLabel: 'Updated session' }));
  await expect(page.getByRole('button', { name: 'Stop fixture response' })).toBeFocused();
  expect(await page.evaluate(() => launcher.slots.runControls === runControls && run.parentNode === runControls && run.firstChild.nextSibling === stop)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'All tools', exact: true })).toBeFocused();
  await expect.poll(() => page.evaluate(() => closes)).toBe(1);
});

test('native modality prevents background focus and close/dispose are idempotent without history changes', async ({ page }) => {
  const before = await page.evaluate(() => ({ length: history.length, href: location.href }));
  await page.evaluate(() => document.getElementById('trigger').focus());
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('button', { name: 'Close All tools' }).focus();
  await page.keyboard.press('Shift+Tab');
  // Chromium can visit browser chrome at the boundary before returning to the native modal.
  if (await page.evaluate(() => !document.hasFocus())) await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.tools-launcher-pin').last()).toBeFocused();
  await page.keyboard.press('Tab');
  if (await page.evaluate(() => !document.hasFocus())) await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close All tools' })).toBeFocused();
  await page.getByRole('button', { name: 'Close All tools' }).click();
  await expect.poll(() => page.evaluate(() => closes)).toBe(1);
  await page.evaluate(() => { launcher.close(); launcher.open(snapshot()); launcher.close(); launcher.open(snapshot()); });
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await page.evaluate(() => closes)).toBe(2);
  await page.evaluate(() => {
    document.getElementById('retained').append(run);
    window.staleAction = document.querySelector('.tools-launcher-action');
    launcher.dispose(); launcher.dispose(); launcher.open(snapshot()); launcher.update(snapshot()); launcher.close();
    staleAction.click(); stop.click();
  });
  await expect(page.locator('#shellToolsLauncher')).toHaveCount(0);
  expect(await page.evaluate(() => ({ closes, invocations: invocations.length, stops, retained: run.parentNode.id,
    navigation: { length: history.length, href: location.href } }))).toEqual({ closes: 3, invocations: 0, stops: 1, retained: 'retained', navigation: before });
});

for (const [width, height] of [[320, 740], [390, 844], [1100, 800], [1440, 900]]) {
  test(`fits and scrolls at ${width}px with dark and light screenshots`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      actions.push(...Array.from({ length: 40 }, (_, index) => ({ id: 'extra-' + index,
        label: index === 0 ? 'LongUnbrokenActionLabel'.repeat(6) : 'Project fixture ' + index,
        description: 'A long description for checking readable wrapping and scroll access to the complete provided catalog.',
        category: index === 0 ? 'LongUnbrokenCategory'.repeat(5) : 'Project' })));
      launcher.update({ actions, contextLabel: 'Fixture session · ' + '/long-project-path'.repeat(8) });
    });
    await expect(page.getByRole('button', { name: 'Stop fixture response' })).toBeVisible();
    for (const control of [page.getByRole('searchbox'), page.getByRole('button', { name: 'Close All tools' }), page.getByRole('button', { name: 'Stop fixture response' })]) {
      const bounds = await control.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      await control.click({ trial: true });
    }
    const geometry = await page.evaluate(() => {
      const dialog = launcher.element.getBoundingClientRect();
      return { left: dialog.left, right: dialog.right, bottom: dialog.bottom,
        docOverflow: document.documentElement.scrollWidth > innerWidth,
        regions: ['.tools-launcher-categories', '.tools-launcher-results'].map((selector) => {
          const region = document.querySelector(selector);
          return { width: region.clientWidth, horizontalOverflow: region.scrollWidth > region.clientWidth,
            scrollable: region.scrollHeight > region.clientHeight };
        }) };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.bottom).toBeLessThanOrEqual(height);
    expect(geometry.docOverflow).toBe(false);
    expect(geometry.regions.every((region) => region.width > 0 && !region.horizontalOverflow)).toBe(true);
    expect(geometry.regions[1].scrollable).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`launcher-${width}-dark.png`), animations: 'disabled' });
    await actionButtons(page).last().focus();
    await expect(actionButtons(page).last()).toBeInViewport();
    await page.getByRole('searchbox').fill('steer');
    await expect(actionButtons(page)).toHaveAccessibleName('Follow-up queue');
    await page.getByRole('searchbox').fill('');
    await page.evaluate(() => document.documentElement.classList.add('light'));
    await page.screenshot({ path: testInfo.outputPath(`launcher-${width}-light.png`), animations: 'disabled' });
  });
}
