import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.use({ video: 'off', serviceWorkers: 'block' });

const assetNames = ['styles.css', 'sidebar-update-menu.css', 'sidebar-update-menu.mjs'];
const sources = new Map(await Promise.all(assetNames.map(async (name) => [name,
  await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8'),
])));
const now = new Date('2026-11-15T12:00:30.000Z');
const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Update progress</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/sidebar-update-menu.css">
  <style>
    #sidebar { position: fixed; left: 0; bottom: 0; width: 180px; height: 100%; overflow: hidden; contain: paint; transform: translateZ(0); background: var(--panel); border-right: 1px solid var(--border); }
    #updates { position: absolute; bottom: 12px; left: 56px; display: grid; place-items: center; width: 38px; min-height: 38px; padding: 8px; }
    #outside { position: fixed; top: 8px; right: 8px; }
  </style></head><body><aside id="sidebar"><button id="updates" type="button" aria-label="Updates"></button></aside>
  <button id="outside" type="button">Keep typing</button></body></html>`;

async function mount(page) {
  await page.clock.install({ time: now });
  const unexpected = [];
  await page.route('http://update-progress.test/**', async (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    if (sources.has(name)) await route.fulfill({ body: sources.get(name), contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript' });
    else if (!name) await route.fulfill({ body: fixture, contentType: 'text/html' });
    else { unexpected.push(name); await route.abort(); }
  });
  await page.goto('http://update-progress.test/');
  await page.evaluate(async () => {
    const { createSidebarUpdateMenu, SIDEBAR_UPDATE_ICON } = await import('/sidebar-update-menu.mjs');
    const button = document.querySelector('#updates');
    button.innerHTML = SIDEBAR_UPDATE_ICON;
    window.selections = [];
    window.controller = createSidebarUpdateMenu({ button, onSelect: (mode) => window.selections.push(mode) });
    window.snapshot = {
      jobId: 'job-a', state: 'running', label: 'Pi and extensions + WebUI', totalSteps: 3, completedSteps: 0,
      currentTargetId: 'pi-self', startedAt: '2026-11-15T12:00:00.000Z', stepStartedAt: '2026-11-15T12:00:00.000Z',
      stdout: 'Checking packages…', stderr: '',
      steps: ['pi-self', 'extensions', 'webui'].map(id => ({ id, installedRoot: `/fixture/${id}`,
        command: { command: 'pi', args: ['update', ...(id === 'extensions' ? ['--all'] : [])] } })),
    };
    window.publish = (changes = {}, statusText = '') => {
      Object.assign(window.snapshot, changes);
      window.controller.update({ progress: window.snapshot, statusText });
    };
  });
  return unexpected;
}
const card = (page) => page.getByRole('region', { name: /Updating|Preparing update|Update complete|Already up to date|Update partly completed|Update failed|Update status unknown/ });
const timing = (page) => page.locator('.sidebar-update-progress-timing');
const track = (page) => page.locator('.sidebar-update-progress-track');
const fill = (page) => page.locator('.sidebar-update-progress-fill');

async function expectGeometry(page) {
  const element = page.locator('.sidebar-update-progress');
  await expect(element).toBeVisible();
  await expect(async () => {
    await page.clock.runFor(50);
    const bounds = await element.boundingBox();
    const trigger = await page.locator('#updates').boundingBox();
    const viewport = page.viewportSize();
    expect(bounds.x).toBeGreaterThanOrEqual(7);
    expect(bounds.y).toBeGreaterThanOrEqual(7);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 7);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 7);
    expect(bounds.x + bounds.width <= trigger.x || bounds.x >= trigger.x + trigger.width
      || bounds.y + bounds.height <= trigger.y || bounds.y >= trigger.y + trigger.height).toBe(true);
    expect(await element.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect(await page.locator('#updates').evaluate((node) => {
      const bounds = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    })).toBe(true);
  }).toPass();
}
async function capture(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}

test('live snapshots, elapsed time and capped heuristic change without focus or action calls', async ({ page }, info) => {
  const unexpected = await mount(page);
  await expect(page.locator('.sidebar-update-progress')).toBeHidden();
  await page.locator('#outside').focus();
  await page.evaluate(() => window.publish());
  await expect(card(page)).toBeVisible();
  await expect(page.locator('.sidebar-update-menu')).toBeHidden();
  await expect(page.locator('#outside')).toBeFocused();
  await expect(page.locator('#updates')).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('#updates')).toHaveClass(/sidebar-update-trigger-running/);
  await expect(timing(page)).toHaveText('Elapsed 30s · Estimated 16%');
  await expect(track(page)).toHaveAccessibleName('Estimated 16 percent, based on time, not measured work');
  await expect(page.locator('.sidebar-update-progress-step')).toHaveText('Step 1 of 3 · pi-self');
  await expect(card(page).getByText('Time-based estimate · about 60s per command')).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  await page.clock.fastForward(10_000);
  await expect(timing(page)).toHaveText('Elapsed 40s · Estimated 22%');
  await page.evaluate(() => window.publish({ completedSteps: 1, currentTargetId: 'extensions', stepStartedAt: new Date().toISOString(), stdout: 'Resolving extensions\n<img src=x onerror=alert(1)>', stderr: 'A warning snapshot' }));
  await expect(page.locator('.sidebar-update-progress-step')).toHaveText('Step 2 of 3 · extensions');
  await expect(page.locator('.sidebar-update-progress-stdout')).toHaveText('Resolving extensions\n<img src=x onerror=alert(1)>');
  await expect(page.locator('.sidebar-update-progress-stderr')).toHaveText('A warning snapshot');
  await expect(card(page).locator('img')).toHaveCount(0);
  await page.evaluate(() => window.publish({ completedSteps: 2, stepStartedAt: '2026-11-15T11:00:00.000Z' }));
  await page.clock.fastForward(600_000);
  await expect(timing(page)).toContainText('Estimated 98%');
  await page.evaluate(() => window.publish({ completedSteps: 3 }));
  await expect(timing(page)).toContainText('Estimated 99%');
  expect(await fill(page).evaluate((node) => Number.parseFloat(node.style.width))).toBeLessThan(100);
  await expect(page.locator('#outside')).toBeFocused();
  expect(await page.evaluate(() => window.selections)).toEqual([]);
  expect(unexpected).toEqual([]);
  await capture(page, info, 'progress-live');
});

test('launching Details stays on command results and returns to progress without duplicate actions', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.publish({ state: 'launching', totalSteps: 0, currentTargetId: null, stdout: '' }));
  await expect(card(page)).toHaveAccessibleName('Preparing update');
  await page.getByRole('button', { name: 'Details', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Back to progress' })).toBeFocused();
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.getByLabel('Command results', { exact: true })).toContainText('"pi" "update"');
  await page.evaluate(() => window.publish({ state: 'running', totalSteps: 3, currentTargetId: 'pi-self' }));
  await expect(page.getByLabel('Command results', { exact: true })).toContainText('pi-self: running');
  await expect(page.getByRole('button', { name: 'Back to progress' })).toBeFocused();
  await page.clock.fastForward(10000);
  await expect(timing(page)).toContainText('Elapsed 40s');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeFocused();
  await page.locator('#updates').click();
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await expect(page.getByRole('menuitem').first()).toBeDisabled();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Back to progress' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.selections)).toEqual([]);
});

for (const [state, title, resultText] of [
  ['success', 'Update complete', 'Commands completed. Restart the server to load changed packages.'],
  ['unchanged', 'Already up to date', 'Pi and packages are already up to date.'],
  ['partial', 'Update partly completed', 'Pi updated; WebUI failed. Review the command result.'],
  ['failed', 'Update failed', 'Command timed out. Review the installation before retrying.'],
  ['unknown', 'Update status unknown', 'Connection lost. The command outcome is unknown.'],
]) {
  test(`${state} uses parent result text, stops timing, and only confirmed success fills the bar`, async ({ page }, info) => {
    await mount(page);
    await page.evaluate(() => window.publish());
    await page.clock.fastForward(5000);
    await page.evaluate(({ state, resultText }) => window.publish({ state, completedSteps: state === 'success' || state === 'unchanged' ? 3 : 1 }, resultText), { state, resultText });
    await expect(card(page)).toHaveAccessibleName(title);
    await expect(page.locator('.sidebar-update-progress-result')).toHaveText(resultText);
    await expect(timing(page)).toHaveText('Elapsed 35s');
    await expect(page.locator('.sidebar-update-progress-heuristic')).toBeHidden();
    await expect(page.locator('#updates')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#updates')).not.toHaveClass(/sidebar-update-trigger-running/);
    await expect(page.getByRole('button', { name: 'Dismiss update result' })).toBeVisible();
    const previousWidth = await fill(page).getAttribute('style');
    const complete = state === 'success' || state === 'unchanged';
    expect(await fill(page).evaluate((node) => Number.parseFloat(node.style.width))).toBe(complete ? 100 : 19);
    if (state === 'unchanged') {
      expect((await card(page).innerText()).split(/\n+/)).toEqual(['Already up to date', 'Pi and extensions + WebUI', 'Details', 'Dismiss']);
      await expect(timing(page)).toBeHidden();
      await expect(track(page)).toBeHidden();
      await expect(page.locator('.sidebar-update-progress-step')).toBeHidden();
      await expect(page.locator('.sidebar-update-progress-output')).toBeHidden();
    }
    await page.clock.fastForward(90_000);
    await page.evaluate(({ state, resultText }) => window.publish({ state }, resultText), { state, resultText });
    await expect(timing(page)).toHaveText('Elapsed 35s');
    expect(await fill(page).getAttribute('style')).toBe(previousWidth);
    await capture(page, info, `progress-${state}`);
  });
}

test('terminal dismissal survives repeated snapshots and missing progress; a new job resets it', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.publish());
  await expect(timing(page)).toContainText('Estimated 16%');
  await page.evaluate(() => window.publish({ state: 'unchanged', completedSteps: 3 }, 'All packages already up to date.'));
  await page.getByRole('button', { name: 'Dismiss update result' }).focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#updates')).toBeFocused();
  await expect(page.locator('.sidebar-update-progress')).toBeHidden();
  await page.evaluate(() => window.publish({}, 'All packages already up to date.'));
  await expect(page.locator('.sidebar-update-progress')).toBeHidden();
  await page.locator('#updates').click();
  await expect(page.locator('.sidebar-update-menu-status')).toHaveText('All packages already up to date.');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sidebar-update-progress')).toBeHidden();
  await page.evaluate(() => { window.controller.update(); window.publish(); });
  await expect(page.locator('.sidebar-update-progress')).toBeHidden();
  await page.evaluate(() => window.publish({ jobId: 'job-b', state: 'launching', completedSteps: 0 }));
  await expect(card(page)).toHaveAccessibleName('Preparing update');
  await expect(timing(page)).toContainText('Estimated 0%');
  await expect(page.getByRole('button', { name: 'Dismiss update result' })).toBeHidden();
  await page.evaluate(() => window.controller.update({ statusText: 'No active update.' }));
  await expect(page.locator('.sidebar-update-progress')).toBeHidden();
  await expect(page.locator('#updates')).toHaveAttribute('aria-busy', 'false');
});


test('bounded output replaces both streams and identical polls do not repeat live summary mutations', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.publish({ stdout: 'old output'.repeat(2000), stderr: 'old warning'.repeat(2000) }));
  expect(await page.locator('.sidebar-update-progress-stdout').evaluate((node) => node.textContent.length)).toBe(8000);
  expect(await page.locator('.sidebar-update-progress-stderr').evaluate((node) => node.textContent.length)).toBe(8000);
  const mutations = await page.evaluate(async () => {
    const records = [];
    const observer = new MutationObserver((changes) => records.push(...changes));
    observer.observe(document.querySelector('.sidebar-update-progress-summary'), { subtree: true, childList: true, characterData: true });
    window.publish();
    window.publish();
    await Promise.resolve();
    observer.disconnect();
    return records.length;
  });
  expect(mutations).toBe(0);
  await page.evaluate(() => window.publish({ completedSteps: 1, currentTargetId: 'webui', stdout: 'New step snapshot', stderr: '' }));
  await expect(page.locator('.sidebar-update-progress-stdout')).toHaveText('New step snapshot');
  await expect(page.locator('.sidebar-update-progress-stderr')).toBeHidden();
  await expect(card(page)).not.toContainText('old output');
  await expect(card(page)).not.toContainText('old warning');
  await expect(page.locator('.sidebar-update-progress-step')).toHaveText('Step 2 of 3 · webui');
});

test('a new job resets a scrolled result and unknown can resume without claiming completion', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 240 });
  await mount(page);
  await page.evaluate(() => window.publish());
  await page.evaluate(() => window.publish({ state: 'unknown' }, 'Connection lost. '.repeat(20)));
  await page.locator('.sidebar-update-progress').evaluate((node) => { node.scrollTop = node.scrollHeight; });
  expect(await page.locator('.sidebar-update-progress').evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(() => window.publish({ jobId: 'job-b', state: 'running', startedAt: new Date().toISOString(), stepStartedAt: new Date().toISOString() }));
  expect(await page.locator('.sidebar-update-progress').evaluate((node) => node.scrollTop)).toBe(0);
  await expect(timing(page)).toContainText('Estimated 0%');
  await page.evaluate(() => window.publish({ state: 'unknown' }, 'Connection lost.'));
  await page.clock.fastForward(5000);
  await expect(timing(page)).toHaveText('Elapsed 0s');
  await page.evaluate(() => window.publish({ state: 'running' }));
  await page.clock.fastForward(5000);
  await expect(timing(page)).toHaveText('Elapsed 10s · Estimated 5%');
  await page.evaluate(() => window.publish({ state: 'success', completedSteps: 3 }, 'Commands completed.'));
  await expect(timing(page)).toHaveText('Elapsed 10s');
  await expect(track(page)).toHaveAccessibleName('Commands finished');
});

for (const scenario of [
  { name: 'dark', width: 1100, height: 700 },
  { name: 'light', width: 900, height: 650, light: true },
  { name: 'narrow', width: 280, height: 520 },
  { name: 'short', width: 600, height: 240 },
  { name: 'light-200-percent', width: 360, height: 640, light: true, textSize: 32 },
  { name: 'short-200-percent', width: 320, height: 240, textSize: 32 },
  { name: 'middle-anchor', width: 800, height: 300, top: 120 },
]) {
  test(`${scenario.name} screenshot keeps long snapshots inside viewport and leaves Updates clickable`, async ({ page }, info) => {
    await page.setViewportSize({ width: scenario.width, height: scenario.height });
    await mount(page);
    await page.evaluate((scenario) => {
      const root = document.documentElement;
      if (scenario.textSize) root.style.fontSize = `${scenario.textSize}px`;
      if (scenario.light) for (const [name, value] of Object.entries({
        '--bg': '#eff1f5', '--text': '#4c4f69', '--muted': '#5c5f77', '--panel': '#e6e9ef',
        '--panel-2': '#ccd0da', '--border': '#9ca0b0', '--accent': '#8839ef', '--warning': '#805800',
        '--danger': '#a91932', '--ok': '#286c1e', '--shadow': '#4c4f6933',
      })) root.style.setProperty(name, value);
      if (scenario.top) {
        document.querySelector('#updates').style.top = `${scenario.top}px`;
        document.querySelector('#updates').style.bottom = 'auto';
      }
      window.publish({ stdout: 'Resolving package-with-a-long-installation-path/'.repeat(80), stderr: 'warning: ' + 'details/'.repeat(80) });
    }, scenario);
    await expectGeometry(page);
    await expect(page.locator('.sidebar-update-progress-output')).toHaveCSS('max-height', scenario.textSize ? '160px' : '80px');
    await capture(page, info, `progress-${scenario.name}`);
    await page.getByRole('button', { name: 'Details', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Back to progress' })).toBeFocused();
    await expectGeometry(page);
    await capture(page, info, `details-${scenario.name}`);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeFocused();
    await expectGeometry(page);
    await page.locator('#updates').click();
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await page.evaluate(() => window.selections)).toEqual([]);
  });
}

test('progress card follows viewport and anchor changes with no open menu', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.publish());
  await page.setViewportSize({ width: 320, height: 400 });
  await page.clock.runFor(50);
  await expectGeometry(page);
  await page.evaluate(() => {
    const trigger = document.querySelector('#updates');
    trigger.style.top = '8px';
    trigger.style.bottom = 'auto';
    document.dispatchEvent(new Event('scroll'));
  });
  await page.clock.runFor(50);
  await expectGeometry(page);
  const trigger = await page.locator('#updates').boundingBox();
  expect((await card(page).boundingBox()).y).toBeGreaterThan(trigger.y + trigger.height);
});

test('reduced motion keeps progress readable with no spinner animation', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => window.publish());
  await expect(page.locator('#updates svg')).toHaveCSS('animation-name', 'sidebar-update-spin');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('#updates svg')).toHaveCSS('animation-name', 'none');
  await expect(timing(page)).toContainText('Estimated 16%');
  await expect(track(page)).toHaveAccessibleName(/based on time, not measured work/);
});

test('dispose clears running timers, listeners, observers and pending positioning', async ({ page }) => {
  await mount(page);
  const counts = await page.evaluate(async () => {
    window.controller.dispose();
    const active = { timers: new Set(), frames: new Set(), signals: [], observers: [] };
    const native = { interval: window.setInterval, clearInterval: window.clearInterval,
      frame: window.requestAnimationFrame, cancelFrame: window.cancelAnimationFrame,
      add: EventTarget.prototype.addEventListener, observer: window.ResizeObserver };
    window.setInterval = (...args) => { const id = native.interval(...args); active.timers.add(id); return id; };
    window.clearInterval = (id) => { active.timers.delete(id); native.clearInterval(id); };
    window.requestAnimationFrame = (callback) => {
      const id = native.frame((time) => { active.frames.delete(id); callback(time); });
      active.frames.add(id); return id;
    };
    window.cancelAnimationFrame = (id) => { active.frames.delete(id); native.cancelFrame(id); };
    EventTarget.prototype.addEventListener = function (type, handler, options) {
      if (options?.signal) active.signals.push(options.signal);
      return native.add.call(this, type, handler, options);
    };
    window.ResizeObserver = class extends native.observer {
      constructor(callback) { super(callback); active.observers.push(this); this.released = false; }
      disconnect() { this.released = true; super.disconnect(); }
    };
    try {
      const { createSidebarUpdateMenu } = await import('/sidebar-update-menu.mjs');
      for (let i = 0; i < 5; i += 1) {
        const controller = createSidebarUpdateMenu({ button: document.querySelector('#updates'), onSelect: () => window.selections.push('unexpected') });
        controller.update({ progress: window.snapshot });
        window.dispatchEvent(new Event('resize'));
        controller.dispose();
        controller.dispose();
        controller.update({ progress: window.snapshot });
      }
      return { timers: active.timers.size, frames: active.frames.size, aborted: active.signals.every((signal) => signal.aborted),
        disconnected: active.observers.every((observer) => observer.released), observers: active.observers.length };
    } finally {
      window.setInterval = native.interval; window.clearInterval = native.clearInterval;
      window.requestAnimationFrame = native.frame; window.cancelAnimationFrame = native.cancelFrame;
      EventTarget.prototype.addEventListener = native.add; window.ResizeObserver = native.observer;
    }
  });
  expect(counts).toEqual({ timers: 0, frames: 0, aborted: true, disconnected: true, observers: 5 });
  await expect(page.locator('.sidebar-update-progress, .sidebar-update-menu')).toHaveCount(0);
  await expect(page.locator('#updates')).not.toHaveClass(/sidebar-update-trigger-running/);
  await expect(page.locator('#updates')).not.toHaveAttribute('aria-busy');
  await page.clock.fastForward(120_000);
  await page.locator('#updates').click();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => window.selections)).toEqual([]);
});

test('Details preserves view across polls and menu close; later jobs replace receipts and reset the view', async ({ page }, info) => {
  await mount(page);
  await page.evaluate(() => window.publish());
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await page.evaluate(() => window.publish({ steps: [{ id: 'pi-self', command: { command: 'pi', args: ['update'] },
    receipt: { status: 'success', exitCode: 0, stdout: 'old command receipt' } }] }));
  await expect(page.getByLabel('Command results', { exact: true })).toContainText('old command receipt');
  await page.locator('#updates').click();
  await page.keyboard.press('Escape');
  await expect(card(page)).toHaveAttribute('data-details', 'true');
  await page.getByRole('button', { name: 'Back to progress' }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Back to progress' })).toBeFocused();
  await capture(page, info, 'running-details-back');
  const accessibility = await new AxeBuilder({ page }).include('.sidebar-update-progress').analyze();
  expect(accessibility.violations).toEqual([]);
  await page.evaluate(() => window.publish({ jobId: 'job-b', state: 'launching', stdout: '', steps: [{ id: 'webui', command: { command: 'npm', args: ['update', '-g'] } }] }));
  await expect(card(page)).toHaveAttribute('data-details', 'false');
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByLabel('Command results', { exact: true })).not.toContainText('old command receipt');
  await expect(page.getByLabel('Command results', { exact: true })).toContainText('"npm" "update" "-g"');
});

test('unchanged retains bounded escaped receipts only in Details and can be restored after dismissal', async ({ page }, info) => {
  await mount(page);
  await page.evaluate(() => window.publish({ state: 'unchanged', completedSteps: 3,
    steps: [{ id: 'webui', command: { command: 'npm', args: ['update', '-g'] },
      receipt: { status: 'unchanged', exitCode: 0, stdout: 'x'.repeat(9000) + '<script>bad()</script>' } }] }, 'No changes.'));
  await capture(page, info, 'minimal-unchanged');
  expect((await card(page).innerText()).split(/\n+/)).toEqual(['Already up to date', 'Pi and extensions + WebUI', 'Details', 'Dismiss']);
  const accessibility = await new AxeBuilder({ page }).include('.sidebar-update-progress').analyze();
  expect(accessibility.violations).toEqual([]);
  await page.getByRole('button', { name: 'Dismiss update result' }).click();
  await page.locator('#updates').click();
  await page.getByRole('button', { name: 'Back to progress' }).click();
  await page.getByRole('button', { name: 'Details', exact: true }).click();
  await expect(page.getByLabel('Command results', { exact: true })).toContainText('webui: unchanged · exit 0');
  await expect(page.getByLabel('Command results', { exact: true })).toContainText('<script>bad()</script>');
  await expect(card(page).locator('script')).toHaveCount(0);
  expect((await page.getByLabel('Command results', { exact: true }).textContent()).length).toBeLessThan(2200);
  await expect(timing(page)).toBeVisible();
  await expect(page.locator('.sidebar-update-progress-result')).toHaveText('No changes.');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Details', exact: true })).toBeFocused();
});
