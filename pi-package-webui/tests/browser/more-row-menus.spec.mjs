import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';
import { navigateFocused } from './focused-navigation-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
test.setTimeout(40_000);

const tray = page => page.locator('#composerActionsPanel');
const more = page => page.locator('#composerActionsButton');
const geometry = page => page.evaluate(() => Object.fromEntries(
  ['promptInput', 'sendButton', 'chat', 'statusBar', 'composer'].map(id => {
    const { x, y, width, height } = document.getElementById(id).getBoundingClientRect();
    return [id, { x, y, width, height }];
  }),
));
const actionOrder = page => tray(page).locator(':scope > [data-composer-action-id]').evaluateAll(nodes => nodes
  .map((node, index) => ({ id: node.dataset.composerActionId, order: Number(getComputedStyle(node).order), index }))
  .sort((a, b) => a.order - b.order || a.index - b.index).map(node => node.id));

async function anchored(page, triggerId, panelId) {
  await expect(page.locator(panelId)).toBeVisible();
  await expect.poll(async () => {
    const anchor = await page.locator(triggerId).boundingBox();
    const menu = await page.locator(panelId).boundingBox();
    const viewport = page.viewportSize();
    if (!anchor || !menu) return false;
    return menu.x >= 7.5 && menu.y >= 7.5 && menu.x + menu.width <= viewport.width - 7.5
      && menu.y + menu.height <= viewport.height - 7.5
      && Math.min(Math.abs(menu.y + menu.height - anchor.y), Math.abs(menu.y - anchor.y - anchor.height)) < 1;
  }).toBe(true);
  // A visible rectangle alone does not establish that a scroll clip or overlay permits clicks.
  expect(await page.locator(panelId).evaluate(node => {
    const item = [...node.querySelectorAll('button:not(:disabled)')].find(button => button.getClientRects().length);
    if (!item) return false;
    const rect = item.getBoundingClientRect();
    return item.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function escapeMenu(page, triggerId, panelId) {
  await page.locator(triggerId).hover();
  await page.keyboard.press('Escape');
  await expect(page.locator(panelId)).toBeHidden();
  await expect(page.locator(triggerId)).toBeFocused();
  await expect(tray(page)).toBeVisible();
}

test.beforeEach(async ({ page, ownership }) => {
  // Advertise release capabilities without installing companions or invoking a publisher.
  await page.route('**/api/commands?*', route => route.fulfill({ json: { ok: true, data: { commands:
    ['release-npm', 'release-aur', 'skills', 'tools', 'reload'].map(name => ({ name, source: 'extension' })),
  } } }));
  await page.route('**/api/app-runners?*', route => route.fulfill({ json: { ok: true, data: {
    cwd: ownership.tabs[0].cwd, activeRun: null,
    runners: [{ id: 'more-row-fixture', label: 'menu-fixture.sh', kind: 'shell', command: 'bash', args: ['menu-fixture.sh'], displayCommand: 'bash menu-fixture.sh' }],
  } } }));
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await expect(page.locator('#publishButton')).not.toHaveAttribute('hidden');
  await expect(page.locator('#appRunnerMenuButton')).toBeEnabled();
});

for (const width of [1440, 1920]) {
  test(`${width}px: actual composer actions share one floating row and retain identities/order`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.locator('#promptInput').fill('Keep this unsent draft');
    await page.evaluate(() => { window.moreActionNodes = [...document.querySelectorAll('#composerActionsPanel > [data-composer-action-id]')]; });
    const before = await geometry(page);
    const order = await actionOrder(page);
    await more(page).click();
    await page.mouse.move(0, 0);
    expect(await geometry(page)).toEqual(before);
    expect(await actionOrder(page)).toEqual(order);
    const row = await tray(page).locator(':scope > [data-composer-action-id]').evaluateAll(nodes => nodes
      .filter(node => node.getClientRects().length).map(node => node.getBoundingClientRect().y));
    expect(Math.max(...row) - Math.min(...row)).toBeLessThan(3);
    expect(await tray(page).evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    const trigger = await more(page).boundingBox();
    const box = await tray(page).boundingBox();
    expect(box.x - trigger.x - trigger.width).toBeCloseTo(8, 0);
    expect(box.width).toBeGreaterThan(416);
    await capture(page, info, `more-row-${width}`);
    await page.keyboard.press('Escape');
    await more(page).click();
    expect(await page.evaluate(() => window.moreActionNodes.every(node => document.querySelector(`[data-composer-action-id="${node.dataset.composerActionId}"]`) === node))).toBe(true);
    await expect(page.locator('#promptInput')).toHaveValue('Keep this unsent draft');
  });
}

test('actual Options pointer, nested keyboard, Escape and action dispatch survive resize above overlays', async ({ page }, info) => {
  const before = await geometry(page);
  await more(page).click();
  await page.locator('#optionsMenuButton').hover();
  await anchored(page, '#optionsMenuButton', '#optionsMenu');
  const menu = await page.locator('#optionsMenu').boundingBox();
  const trigger = await page.locator('#optionsMenuButton').boundingBox();
  await page.mouse.move(trigger.x + trigger.width / 2, menu.y + menu.height - 3, { steps: 10 });
  await expect(page.locator('#optionsMenuButton')).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#optionsSessionSubmenuButton').hover();
  await expect(page.locator('#optionsResumeButton')).toBeVisible();
  await page.locator('#optionsSessionSubmenuButton').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#optionsResumeButton')).toBeFocused();
  await anchored(page, '#optionsMenuButton', '#optionsMenu');
  await page.keyboard.press('Escape');
  await expect(page.locator('#optionsSessionSubmenuButton')).toBeFocused();
  await expect(page.locator('#optionsSessionSubmenu')).toBeHidden();
  expect(await geometry(page)).toEqual(before);
  await capture(page, info, 'more-options-desktop');
  await page.setViewportSize({ width: 1100, height: 500 });
  await anchored(page, '#optionsMenuButton', '#optionsMenu');
  await escapeMenu(page, '#optionsMenuButton', '#optionsMenu');
  await page.locator('#optionsMenuButton').press('ArrowDown');
  await expect(page.locator('#optionsCommandPaletteButton')).toBeFocused();
  await page.locator('#optionsCommandPaletteButton').click();
  await expect(page.getByRole('dialog', { name: 'All tools', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search all tools', exact: true })).toBeFocused();
});

test('narrow actual row scrolls horizontally while Options stays unclipped and Send stays reachable', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await page.locator('.focused-conversation').evaluate(node => { node.style.maxWidth = '360px'; });
  const before = await geometry(page);
  await more(page).click();
  await page.mouse.move(0, 0);
  expect(await tray(page).evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  expect(await geometry(page)).toEqual(before);
  await page.locator('#optionsMenuButton').focus();
  await page.locator('#optionsMenuButton').press('ArrowDown');
  await expect(page.locator('#optionsCommandPaletteButton')).toBeFocused();
  await anchored(page, '#optionsMenuButton', '#optionsMenu');
  await capture(page, info, 'more-options-narrow');
  await escapeMenu(page, '#optionsMenuButton', '#optionsMenu');
  await page.locator('#sendButton').click({ trial: true });
  const box = await tray(page).boundingBox();
  const send = await page.locator('#sendButton').boundingBox();
  expect(box.x + box.width).toBeLessThanOrEqual(send.x - 7.5);
  expect(await geometry(page)).toEqual(before);
});

test('actual Publish hover and keyboard reach the canonical menu and dispatch the original command/session', async ({ page, ownership }, info) => {
  const submissions = [];
  await page.route('**/api/prompt?*', route => {
    submissions.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    return route.fulfill({ json: { ok: true, data: {} } });
  });
  await more(page).click();
  await page.locator('#publishButton').hover();
  await anchored(page, '#publishButton', '#publishMenu');
  await page.locator('#publishButton').focus();
  await page.locator('#publishButton').press('ArrowDown');
  await expect(page.locator('#releaseNpmButton')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#releaseAurButton')).toBeFocused();
  await escapeMenu(page, '#publishButton', '#publishMenu');
  await page.locator('#publishButton').press('ArrowDown');
  await capture(page, info, 'more-publish-desktop');
  await page.setViewportSize({ width: 1100, height: 500 });
  await anchored(page, '#publishButton', '#publishMenu');
  await page.locator('#releaseNpmButton').click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].tab).toBe(ownership.tabs[0].id);
  expect(submissions[0].body.message).toBe('/release-npm');
});

test('actual runner hover and keyboard reach the canonical menu and dispatch the selected runner/session', async ({ page, ownership }, info) => {
  const submissions = [];
  await page.route('**/api/app-runner?*', route => {
    submissions.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    return route.fulfill({ status: 409, json: { ok: false, error: 'Fixture intercepted runner start' } });
  });
  await more(page).click();
  // Discovery is lazy in the real app, so open once before exercising hover reopening.
  await page.locator('#appRunnerMenuButton').click();
  await anchored(page, '#appRunnerMenuButton', '#appRunnerMenuPanel');
  await escapeMenu(page, '#appRunnerMenuButton', '#appRunnerMenuPanel');
  await more(page).focus();
  await page.mouse.move(0, 0);
  await expect(page.locator('#appRunnerMenu')).not.toHaveClass(/menu-dismissed/);
  await page.locator('#appRunnerMenuButton').hover();
  await anchored(page, '#appRunnerMenuButton', '#appRunnerMenuPanel');
  await page.locator('#appRunnerMenuButton').focus();
  await page.locator('#appRunnerMenuButton').press('ArrowDown');
  await expect(page.locator('#appRunnerMenuPanel button').first()).toBeFocused();
  await escapeMenu(page, '#appRunnerMenuButton', '#appRunnerMenuPanel');
  await page.locator('#appRunnerMenuButton').press('ArrowDown');
  await capture(page, info, 'more-runner-desktop');
  await page.setViewportSize({ width: 1100, height: 500 });
  await anchored(page, '#appRunnerMenuButton', '#appRunnerMenuPanel');
  const selected = page.locator('#appRunnerMenuPanel button').filter({ hasText: 'menu-fixture.sh' }).first();
  await selected.click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0].tab).toBe(ownership.tabs[0].id);
  expect(submissions[0].body).toEqual({ runnerId: 'more-row-fixture' });
});

for (const [name, triggerId, panelId] of [['Publish', '#publishButton', '#publishMenu'], ['runner', '#appRunnerMenuButton', '#appRunnerMenuPanel']]) {
  // Keep these active until the parent restores canonical focused click wiring and panel ancestry.
  test(`actual focused ${name} click opens its dropdown`, async ({ page }) => {
    await page.locator(panelId).evaluate(node => { window.canonicalMoreMenu = node; });
    await more(page).click();
    await page.locator(triggerId).click();
    await expect(tray(page)).toBeVisible();
    await anchored(page, triggerId, panelId);
    await escapeMenu(page, triggerId, panelId);
    await expect(page.locator(panelId)).toHaveCount(1);
    expect(await page.locator(panelId).evaluate(node => node === window.canonicalMoreMenu)).toBe(true);
    await navigateFocused(page, 'Project');
    await page.getByRole('combobox', { name: 'Project section', exact: true }).selectOption({ label: name === 'Publish' ? 'Release' : 'Runners' });
    await expect(page.locator(panelId)).toBeVisible();
    await expect(page.locator(panelId).locator('button').first()).toBeVisible();
    if (name === 'runner') await expect(page.locator('#appRunnerInfoButton')).toBeVisible();
  });
}

for (const nextAction of ['dismiss', 'options']) {
  test(`late runner discovery preserves the later ${nextAction} interaction`, async ({ page, ownership }, info) => {
    await more(page).click();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let started = false;
    await page.route('**/api/app-runners?*', async route => {
      started = true;
      await gate;
      await route.fulfill({ json: { ok: true, data: {
        cwd: ownership.tabs[0].cwd, activeRun: null,
        runners: [{ id: 'late-discovery-runner', label: 'late-discovery.sh', kind: 'shell', command: 'bash', args: ['late-discovery.sh'], displayCommand: 'bash late-discovery.sh' }],
      } } });
    });
    try {
      await page.locator('#appRunnerMenuButton').click();
      await expect.poll(() => started).toBe(true);
      if (nextAction === 'dismiss') {
        await page.keyboard.press('Escape');
        await expect(page.locator('#composerActionsPanel')).toBeHidden();
      } else {
        await page.locator('#optionsMenuButton').click();
        await expect(page.locator('#optionsMenu')).toBeVisible();
      }
      release();
      await expect(page.locator('#appRunnerMenuPanel')).toContainText('late-discovery.sh');
      await page.screenshot({ path: info.outputPath(`late-runner-${nextAction}.png`) });
      await expect(page.locator('#appRunnerMenuButton')).toHaveAttribute('aria-expanded', 'false');
      expect(await page.locator('#appRunnerMenuPanel').evaluate(node => Boolean(node.closest('.focused-feature-controls')))).toBe(true);
      if (nextAction === 'options') await expect(page.locator('#optionsMenu')).toBeVisible();
    } finally {
      release();
    }
  });
}
