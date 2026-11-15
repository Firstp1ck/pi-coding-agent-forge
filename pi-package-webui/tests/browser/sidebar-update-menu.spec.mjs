import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

const assetNames = ['styles.css', 'sidebar-update-menu.css', 'sidebar-update-menu.mjs'];
const sources = new Map(await Promise.all(assetNames.map(async (name) => [name,
  await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8'),
])));
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Sidebar updates</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/sidebar-update-menu.css">
  <style>
    #sidebar { position: fixed; left: 0; bottom: 0; width: 180px; height: 100%; overflow: hidden; contain: paint; transform: translateZ(0); background: var(--panel); border-right: 1px solid var(--border); }
    #actions { position: absolute; bottom: 12px; left: 12px; display: flex; gap: 6px; }
    #actions button { display: grid; place-items: center; width: 38px; min-height: 38px; padding: 8px; }
    main { position: fixed; top: 16px; right: 16px; }
  </style></head><body>
  <aside id="sidebar" aria-label="Sidebar"><div id="actions"><button id="settings" type="button" aria-label="Settings">⚙</button><button id="updates" type="button" aria-label="Updates"></button></div></aside>
  <main><button id="outside" type="button">Outside</button></main>
  </body></html>`;

async function connectMenu(page) {
  await page.evaluate(async () => {
    const { createSidebarUpdateMenu, SIDEBAR_UPDATE_ICON } = await import('/sidebar-update-menu.mjs');
    const button = document.querySelector('#updates');
    button.innerHTML = SIDEBAR_UPDATE_ICON;
    window.selections = [];
    window.triggerClicks = 0;
    button.onclick = () => { window.triggerClicks += 1; };
    window.makeMenu = () => createSidebarUpdateMenu({ button, onSelect(mode) {
      window.selections.push({ mode, expanded: button.getAttribute('aria-expanded'),
        visible: !document.getElementById(button.getAttribute('aria-controls')).hidden,
        focus: document.activeElement.id });
    } });
    window.updateMenu = window.makeMenu();
  });
}

async function mount(page) {
  const unexpected = [];
  await page.route('http://sidebar-update.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const name = pathname.slice(1);
    if (sources.has(name)) {
      await route.fulfill({ body: sources.get(name), contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript' });
    } else if (pathname === '/') {
      await route.fulfill({ body: fixture, contentType: 'text/html' });
    } else {
      unexpected.push(pathname);
      await route.abort();
    }
  });
  await page.goto('http://sidebar-update.test/');
  await connectMenu(page);
  return unexpected;
}

const popup = (page) => page.locator('.sidebar-update-menu').last();
const items = (page) => page.getByRole('menuitem');

async function expectWithinViewport(page) {
  await expect(popup(page)).toBeVisible();
  const bounds = await popup(page).boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(7);
  expect(bounds.y).toBeGreaterThanOrEqual(7);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 7);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 7);
  expect(await popup(page).evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
}

async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('all three scopes close before one exact callback, preserving the parent trigger handler', async ({ page }, info) => {
  const requests = await mount(page);
  const modes = ['all', 'webui', 'pi'];
  const labels = ['Pi and extensions + WebUI', 'WebUI only', 'Pi only'];
  for (let index = 0; index < modes.length; index += 1) {
    await page.locator('#updates').click();
    await expect(page.getByRole('menu', { name: 'Updates', exact: true })).toBeVisible();
    await expect(items(page)).toHaveText([
      'Pi and extensions + WebUIUpdate Pi, configured extensions, and WebUI.',
      'WebUI onlyUpdate existing WebUI installations.',
      'Pi onlyUpdate the Pi coding agent.',
    ]);
    expect(await popup(page).evaluate((element) => element.matches(':popover-open'))).toBe(true);
    if (index === 0) await capture(page, info, 'updates-dark');
    const choice = page.getByRole('menuitem', { name: labels[index], exact: true });
    await choice.locator('.sidebar-update-menu-description').click();
    // A queued or repeated click after dismissal cannot start another preview.
    await page.locator(`.sidebar-update-menu-choice[data-mode="${modes[index]}"]`).dispatchEvent('click');
    await expect(popup(page)).toBeHidden();
    await expect(page.locator('#updates')).toBeFocused();
  }
  expect(await page.evaluate(() => window.selections)).toEqual(modes.map((mode) => ({ mode, expanded: 'false', visible: false, focus: 'updates' })));
  expect(await page.evaluate(() => window.triggerClicks)).toBe(3);
  expect(requests).toEqual([]);
});

test('keyboard opens at either end, wraps, jumps, selects once, and returns focus on Escape', async ({ page }) => {
  await mount(page);
  const button = page.locator('#updates');
  await button.focus();
  await page.keyboard.press('ArrowUp');
  await expect(items(page).nth(2)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items(page).nth(0)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(items(page).nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(items(page).nth(0)).toBeFocused();
  await page.keyboard.press('End');
  await expect(items(page).nth(2)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await expect(popup(page)).toBeHidden();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(button).toBeFocused();
  await page.keyboard.press('Space');
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  expect((await page.evaluate(() => window.selections)).map(({ mode }) => mode)).toEqual(['webui', 'pi']);
});

test('outside click, focus transfer, trigger toggle and Tab dismiss without choosing or stealing outside focus', async ({ page }) => {
  await mount(page);
  await page.locator('#updates').click();
  await page.locator('#outside').click();
  await expect(popup(page)).toBeHidden();
  await expect(page.locator('#outside')).toBeFocused();
  await page.locator('#updates').click();
  await page.locator('#settings').focus();
  await expect(popup(page)).toBeHidden();
  await expect(page.locator('#settings')).toBeFocused();
  await page.locator('#updates').click();
  await page.locator('#updates').click();
  await expect(popup(page)).toBeHidden();
  await page.locator('#updates').click();
  await page.keyboard.press('Tab');
  await expect(popup(page)).toBeHidden();
  await expect(page.locator('#outside')).toBeFocused();
  await page.locator('#updates').click();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#settings')).toBeFocused();
  expect(await page.evaluate(() => window.selections)).toEqual([]);
});

test('busy and unavailable states retain an enabled status trigger and prevent every selection path', async ({ page }, info) => {
  await mount(page);
  const button = page.locator('#updates');
  await page.evaluate(() => window.updateMenu.update({ busy: true, statusText: 'Checking installation receipts…' }));
  await button.focus();
  await expect(button).toBeFocused();
  expect(await button.evaluate((element) => element.disabled)).toBe(false);
  await expect(button).toHaveAccessibleDescription('An update is in progress. Checking installation receipts…');
  await page.keyboard.press('Enter');
  await expect(popup(page)).toContainText('An update is in progress.');
  for (const choice of await items(page).all()) {
    await expect(button).toBeEnabled();
    await expect(choice).toHaveAttribute('aria-disabled', 'true');
    await choice.dispatchEvent('click');
    await choice.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
  }
  expect(await page.evaluate(() => window.selections)).toEqual([]);
  await page.evaluate(() => window.updateMenu.update({ disabledReason: 'Updates are available only on the local server.', statusText: 'Reconnect locally to preview an update.' }));
  await expect(popup(page)).toContainText('Updates are available only on the local server.');
  await expect(button).toHaveAccessibleDescription('Updates are available only on the local server. Reconnect locally to preview an update.');
  await capture(page, info, 'updates-unavailable');
  await page.keyboard.press('Escape');
  await expect(button).toBeFocused();
  await page.evaluate(() => window.updateMenu.update());
  await expect(button).toHaveAttribute('aria-disabled', 'false');
  await expect(button).toHaveAttribute('aria-busy', 'false');
  await button.click();
  await items(page).first().click();
  expect((await page.evaluate(() => window.selections)).map(({ mode }) => mode)).toEqual(['all']);
});

test('status and errors render as readable text, can update while open, and clear without stale state', async ({ page }, info) => {
  await mount(page);
  await page.locator('#updates').click();
  const error = 'Update failed. <img src=x onerror=alert(1)>\nReview the installation preview before retrying.';
  await page.evaluate((statusText) => window.updateMenu.update({ statusText, statusTone: 'error' }), error);
  await expect(page.getByRole('status')).toHaveText(error);
  await expect(page.getByRole('status')).toHaveCSS('color', 'rgb(243, 139, 168)');
  await expect(popup(page).locator('img')).toHaveCount(0);
  await expectWithinViewport(page);
  await capture(page, info, 'updates-error');
  await page.evaluate(() => window.updateMenu.update({ statusText: 'Update complete.', statusTone: 'success' }));
  await expect(page.getByRole('status')).toHaveCSS('color', 'rgb(166, 227, 161)');
  await page.evaluate(() => window.updateMenu.update({ statusText: 'Manual steps needed.', statusTone: 'warning' }));
  await expect(page.getByRole('status')).toHaveCSS('color', 'rgb(249, 226, 175)');
  await page.evaluate(() => window.updateMenu.update());
  await expect(page.getByRole('status')).toBeHidden();
  await expect(popup(page).locator('.sidebar-update-menu-availability')).toBeHidden();
  await expect(page.locator('#updates')).not.toHaveAttribute('aria-describedby');
});

test('controller close can suppress focus restoration and an in-flight busy update prevents selection', async ({ page }) => {
  await mount(page);
  await page.locator('#updates').click();
  await page.keyboard.press('ArrowDown');
  await page.evaluate(() => window.updateMenu.update({ busy: true }));
  await expect(items(page).nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => window.selections)).toEqual([]);
  await expect(popup(page)).toBeVisible();
  await page.evaluate(() => window.updateMenu.close({ restoreFocus: false }));
  await expect(popup(page)).toBeHidden();
  await expect(page.locator('#updates')).not.toBeFocused();
  await page.evaluate(() => window.updateMenu.update());
  await page.locator('#updates').click();
  await page.evaluate(() => window.updateMenu.close());
  await expect(page.locator('#updates')).toBeFocused();
});

for (const scenario of [
  { name: 'bottom-left', width: 1100, height: 700, left: 12, top: 645, textSize: 16 },
  { name: 'top-left', width: 800, height: 600, left: 12, top: 8, textSize: 16 },
  { name: 'sidebar-middle', width: 800, height: 300, left: 12, top: 110, textSize: 16 },
  { name: 'right-edge', width: 800, height: 600, left: 745, top: 540, textSize: 16 },
  { name: 'narrow', width: 280, height: 520, left: 12, top: 460, textSize: 16 },
  { name: 'short-zoomed-text', width: 320, height: 240, left: 12, top: 185, textSize: 32 },
]) {
  test(`${scenario.name} keeps the popup visible outside a clipped sidebar`, async ({ page }, info) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await mount(page);
    await page.evaluate(({ left, top, textSize }) => {
      document.documentElement.style.fontSize = `${textSize}px`;
      const actions = document.querySelector('#actions');
      actions.style.position = 'fixed';
      actions.style.left = `${left}px`;
      actions.style.top = `${top}px`;
      actions.style.bottom = 'auto';
      document.querySelector('#sidebar').style.width = '100%';
    }, { ...scenario, left: scenario.left - 44 });
    await page.locator('#updates').click();
    await expectWithinViewport(page);
    expect(await popup(page).evaluate((element) => element.matches(':popover-open'))).toBe(true);
    const all = page.getByRole('menuitem', { name: 'Pi and extensions + WebUI', exact: true });
    await expect(all).toBeFocused();
    await page.keyboard.press('End');
    const last = page.getByRole('menuitem', { name: 'Pi only', exact: true });
    await expect(last).toBeInViewport({ ratio: 0.99 });
    await expect(last).toBeFocused();
    await page.keyboard.press('Home');
    await expect(all).toBeInViewport({ ratio: 0.99 });
    if (scenario.name === 'short-zoomed-text') {
      expect(await popup(page).evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
      await expect(all.locator('.sidebar-update-menu-description')).toHaveCSS('font-size', '24px');
    }
    await capture(page, info, `updates-${scenario.name}`);
  });
}

test('open popup follows resize, anchor resize and scroll; close cancels pending positioning', async ({ page }) => {
  await mount(page);
  await page.locator('#updates').click();
  await page.setViewportSize({ width: 360, height: 500 });
  await expectWithinViewport(page);
  const oldTop = (await popup(page).boundingBox()).y;
  await page.evaluate(() => {
    document.querySelector('#updates').style.height = '90px';
    document.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => (await popup(page).boundingBox()).y).not.toBe(oldTop);
  await expectWithinViewport(page);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'));
    window.updateMenu.close();
  });
  await expect(popup(page)).toBeHidden();
  await expect(page.locator('#updates')).toBeFocused();
});

test('light theme, long errors and 200% text stay readable without horizontal clipping', async ({ page }, info) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await mount(page);
  await page.evaluate(() => {
    const root = document.documentElement;
    root.style.fontSize = '32px';
    for (const [name, value] of Object.entries({
      '--theme-color-scheme': 'light', '--bg': '#eff1f5', '--text': '#4c4f69', '--muted': '#5c5f77',
      '--panel': '#e6e9ef', '--panel-2': '#ccd0da', '--border': '#9ca0b0', '--danger': '#a91932',
      '--accent': '#8839ef', '--accent-2': '#1e66f5', '--shadow': '#4c4f6933',
    })) root.style.setProperty(name, value);
    window.updateMenu.update({ statusText: 'Unable to update /a/long/installation/path/without/spaces/or/a/package-manager. Open the preview to check the target.', statusTone: 'error' });
  });
  await page.locator('#updates').click();
  await popup(page).evaluate((element) => { element.scrollTop = 0; });
  await expectWithinViewport(page);
  await expect(popup(page)).toHaveCSS('background-color', 'rgb(239, 241, 245)');
  await expect(page.getByRole('status')).toHaveCSS('color', 'rgb(169, 25, 50)');
  await expect(page.getByRole('status')).toHaveCSS('font-size', '24px');
  await capture(page, info, 'updates-light-zoomed-error');
  await items(page).first().focus();
  await page.keyboard.press('End');
  await expect(items(page).last()).toBeInViewport({ ratio: 0.99 });
});

test('dispose restores trigger attributes and releases listeners, observers, popup and queued frame', async ({ page }) => {
  await mount(page);
  const counts = await page.evaluate(() => {
    window.updateMenu.dispose();
    const button = document.querySelector('#updates');
    button.setAttribute('aria-describedby', 'outside');
    button.setAttribute('title', 'Original title');
    button.setAttribute('aria-controls', 'originalPanel');
    const tracked = { signals: [], observers: [], frames: new Set() };
    const NativeObserver = window.ResizeObserver;
    const add = EventTarget.prototype.addEventListener;
    const request = window.requestAnimationFrame;
    const cancel = window.cancelAnimationFrame;
    EventTarget.prototype.addEventListener = function (type, handler, options) {
      if (options?.signal) tracked.signals.push(options.signal);
      return add.call(this, type, handler, options);
    };
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback) { super(callback); tracked.observers.push(this); this.released = false; }
      disconnect() { this.released = true; super.disconnect(); }
    };
    window.requestAnimationFrame = (callback) => {
      const frame = request.call(window, (time) => { tracked.frames.delete(frame); callback(time); });
      tracked.frames.add(frame);
      return frame;
    };
    window.cancelAnimationFrame = (frame) => { tracked.frames.delete(frame); cancel.call(window, frame); };
    try {
      for (let index = 0; index < 5; index += 1) {
        const controller = window.makeMenu();
        button.click();
        window.dispatchEvent(new Event('resize'));
        controller.dispose();
        controller.dispose();
        controller.update({ busy: true });
        controller.close();
      }
      return { signals: tracked.signals.length, aborted: tracked.signals.every((signal) => signal.aborted),
        observers: tracked.observers.length, disconnected: tracked.observers.every((observer) => observer.released),
        frames: tracked.frames.size };
    } finally {
      EventTarget.prototype.addEventListener = add;
      window.ResizeObserver = NativeObserver;
      window.requestAnimationFrame = request;
      window.cancelAnimationFrame = cancel;
    }
  });
  expect(counts.signals).toBeGreaterThan(40);
  expect(counts).toMatchObject({ aborted: true, observers: 5, disconnected: true, frames: 0 });
  await expect(popup(page)).toHaveCount(0);
  await expect(page.locator('#updates')).toHaveAttribute('title', 'Original title');
  await expect(page.locator('#updates')).toHaveAttribute('aria-describedby', 'outside');
  await expect(page.locator('#updates')).toHaveAttribute('aria-controls', 'originalPanel');
  await expect(page.locator('#updates')).not.toHaveAttribute('aria-expanded');
  await page.locator('#updates').click();
  await page.keyboard.press('ArrowDown');
  await expect(popup(page)).toHaveCount(0);
  expect(await page.evaluate(() => window.selections)).toEqual([]);
});

for (const layout of ['classic', 'focused']) {
  test(`component mounts beside Settings in the real ${layout} app using fake Pi`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: 1100, height: 650 });
    await page.addInitScript((desktopLayout) => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout })), layout);
    await page.goto(ownership.baseURL);
    await expect(page.locator('#chat')).toContainText('fake answer');
    await page.addStyleTag({ url: `${ownership.baseURL}/sidebar-update-menu.css` });
    await page.evaluate(() => {
      const settings = document.querySelector('.terminal-settings-button');
      const button = document.createElement('button');
      button.id = 'updates';
      button.type = 'button';
      button.setAttribute('aria-label', 'Updates');
      // Classic currently has no sidebar Settings shortcut; the parent owns that integration.
      settings.hidden = false;
      settings.after(button);
    });
    await connectMenu(page);
    const updateRequests = [];
    page.on('request', (request) => { if (/\/api\/update/.test(request.url())) updateRequests.push(request.url()); });
    await page.locator('#updates').click();
    await expectWithinViewport(page);
    await expect(items(page)).toHaveCount(3);
    await capture(page, info, `updates-real-${layout}`);
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    expect((await page.evaluate(() => window.selections)).map(({ mode }) => mode)).toEqual(['pi']);
    expect(updateRequests).toEqual([]);
    await expect(page.locator('#updates')).toBeFocused();
    await page.evaluate(() => window.updateMenu.dispose());
  });
}
