import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({
  video: 'off',
  serviceWorkers: 'block',
  reducedMotion: 'reduce',
  viewport: { width: 1100, height: 760 },
  launchOptions: { executablePath: '/usr/bin/chromium' },
});
test.describe.configure({ retries: 0 });

const sources = new Map(await Promise.all([
  'session-shelves.mjs', 'session-shelves.css', 'styles.css', 'focused-shell-adapter.css',
].map(async (name) => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en" data-desktop-shell="focused"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session shelves component fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/focused-shell-adapter.css">
<link rel="stylesheet" href="/session-shelves.css">
<style>
body { background: var(--bg); color: var(--text); }
#focusedWorkspace { display: grid; grid-template-columns: var(--fixture-sidebar-width, 280px) minmax(0, 1fr); height: 100dvh; }
.fixture-sidebar { min-height: 0; min-width: 0; padding: 10px; border-right: 1px solid var(--border); background: var(--panel); }
.fixture-sidebar .terminal-tabs-shell { padding: 0; background: transparent; border: 0; box-shadow: none; }
.fixture-sidebar .terminal-tabs { padding: 0; gap: 0; }
.fixture-conversation { padding: 32px; min-width: 0; }
.fixture-conversation h1 { font-size: 20px; }
.fixture-conversation p { color: var(--muted); font-size: 14px; }
#outside { margin-top: 16px; }
html.light {
  color-scheme: light; --bg: #eff1f5; --text: #4c4f69; --muted: #5c5f77;
  --panel: #e6e9ef; --panel-2: #dce0e8; --border: #9ca0b0; --accent: #8839ef;
  --ctp-text: #4c4f69; --ctp-subtext: #5c5f77; --ctp-subtext-rgb: 92,95,119;
  --ctp-crust: #dce0e8; --ctp-crust-rgb: 220,224,232; --ctp-base-rgb: 239,241,245;
  --ctp-mantle-rgb: 230,233,239; --ctp-surface-rgb: 204,208,218;
  --ctp-teal: #179299; --ctp-green: #40a02b; --ctp-blue: #1e66f5;
  --ctp-mauve: #8839ef; --ctp-red: #d20f39; --ctp-yellow: #df8e1d; --ctp-peach: #fe640b;
}
</style></head><body>
<main id="focusedWorkspace" data-navigation="left">
<aside class="fixture-sidebar" aria-label="Sessions"><div class="terminal-tabs-shell">
<button type="button" id="newSession">New session</button><div class="terminal-tabs" id="tabBar"></div>
</div></aside>
<section class="fixture-conversation"><h1>Session shelves</h1>
<p>Canonical Pi session rows supplied by the parent.</p><button type="button" id="outside">Conversation action</button></section>
</main><div id="reclaimed"></div>
<script type="module">
import { createSessionShelves } from '/session-shelves.mjs';
window.createSessionShelves = createSessionShelves;
window.toggles = []; window.actions = []; window.autoApply = true;
window.expansion = { inbox: true, working: true, settled: false };
window.shelves = createSessionShelves({ document, onToggle(section, nextExpanded) {
  toggles.push([section, nextExpanded]);
  if (autoApply) { expansion[section] = nextExpanded; shelves.update({ expanded: expansion }); }
} });
window.detachedAtConstruction = !shelves.element.isConnected;
document.getElementById('tabBar').append(shelves.element);

window.makeRow = (id, title, state = 'idle', groupItem = false) => {
  const row = document.createElement('div');
  row.className = (groupItem ? 'terminal-tab-group-item' : 'terminal-tab') + ' activity-' + state;
  row.dataset.tabId = id;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'terminal-tab-button' + (groupItem ? ' terminal-tab-group-item-button' : '');
  button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(id === 'inbox-0'));
  button.setAttribute('aria-label', title); button.title = title;
  const titleRow = document.createElement('span'); titleRow.className = 'terminal-tab-title-row';
  const indicator = document.createElement('span'); indicator.className = 'terminal-tab-activity-indicator'; indicator.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span'); label.className = 'terminal-tab-title'; label.textContent = title;
  titleRow.append(indicator, label);
  const meta = document.createElement('span'); meta.className = 'terminal-tab-meta';
  meta.textContent = '/workspace/npm-packages · ' + state; button.append(titleRow, meta);
  button.addEventListener('click', () => actions.push(['select', id]));
  const actionHost = document.createElement('div'); actionHost.className = 'terminal-tab-actions';
  for (const action of ['Split', 'Summary']) {
    const control = document.createElement('button'); control.type = 'button';
    control.className = 'terminal-tab-' + action.toLowerCase() + '-button';
    control.textContent = action === 'Split' ? '◫' : '≡'; control.setAttribute('aria-label', action + ' ' + title);
    control.addEventListener('click', () => actions.push([action, id])); actionHost.append(control);
  }
  const close = document.createElement('button'); close.type = 'button'; close.className = 'terminal-tab-close';
  close.textContent = '×'; close.setAttribute('aria-label', 'Close ' + title);
  close.addEventListener('click', () => actions.push(['close', id]));
  row.append(button, actionHost, close);
  return row;
};
window.rows = [];
for (const [section, titles] of Object.entries({
  inbox: ['Package documentation', 'Approve release notes', 'Review completed checks'],
  working: ['Implement session shelves', 'Run focused browser checks'],
  settled: ['Previous release', 'Archived investigation'],
})) {
  const slot = shelves.slots[section];
  slot.setAttribute('role', 'tablist'); slot.setAttribute('aria-label', section + ' sessions');
  for (const [index, title] of titles.entries()) {
    const state = section === 'working' ? 'working' : section === 'inbox' && index === 1 ? 'blocked' : 'done';
    const row = makeRow(section + '-' + index, title, state); rows.push(row); slot.append(row);
  }
}
window.counts = { inbox: 3, working: 2, settled: 2 };
shelves.update({ counts, expanded: expansion });
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  const errors = [];
  const unexpectedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const source = url.origin === 'http://shelves.test' ? sources.get(url.pathname) : undefined;
    if (source !== undefined || (url.origin === 'http://shelves.test' && url.pathname === '/')) {
      await route.fulfill({
        contentType: url.pathname.endsWith('.mjs') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html',
        body: source ?? fixture,
      });
    } else {
      unexpectedRequests.push(url.href);
      await route.abort();
    }
  });
  await page.goto('http://shelves.test/');
  await page.waitForFunction(() => window.ready);
  page.__shelfErrors = errors;
  page.__shelfRequests = unexpectedRequests;
});

test.afterEach(async ({ page }) => {
  expect(page.__shelfErrors).toEqual([]);
  expect(page.__shelfRequests).toEqual([]);
});

const header = (page, section) => page.locator(`[data-session-shelf-toggle="${section}"]`);
const body = (page, section) => page.locator(`[data-session-shelf-body="${section}"]`);

test('starts detached with named sections, unique ARIA and collapsed Settled', async ({ page }) => {
  expect(await page.evaluate(() => detachedAtConstruction)).toBe(true);
  for (const [section, label, count, expanded] of [
    ['inbox', 'Inbox', 3, true], ['working', 'Working', 2, true], ['settled', 'Settled', 2, false],
  ]) {
    await expect(page.getByRole('region', { name: label, exact: true })).toBeVisible();
    await expect(header(page, section)).toHaveAccessibleName(`${label} ${count}`);
    await expect(header(page, section)).toHaveAttribute('aria-expanded', String(expanded));
    await expect(body(page, section)).toHaveJSProperty('hidden', !expanded);
    expect(await header(page, section).getAttribute('aria-controls')).toBe(await body(page, section).getAttribute('id'));
  }
  expect(await page.evaluate(() => {
    const second = createSessionShelves({ document });
    const third = createSessionShelves({ document });
    document.getElementById('reclaimed').append(second.element, third.element);
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    const result = ids.length === new Set(ids).size;
    second.dispose(); third.dispose(); return result;
  })).toBe(true);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});

test('uses native click, Enter and Space once and waits for parent state', async ({ page }) => {
  await page.evaluate(() => { autoApply = false; });
  await header(page, 'inbox').click();
  await expect(header(page, 'inbox')).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => shelves.update({ expanded: { inbox: false } }));
  await page.keyboard.press('Enter');
  await expect(header(page, 'inbox')).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => { expansion.inbox = false; autoApply = true; });
  await page.keyboard.press('Space');
  await expect(header(page, 'inbox')).toHaveAttribute('aria-expanded', 'true');
  await header(page, 'settled').focus();
  await page.keyboard.press('Space');
  await expect(body(page, 'settled')).toBeVisible();
  expect(await page.evaluate(() => toggles)).toEqual([
    ['inbox', false], ['inbox', true], ['inbox', true], ['settled', true],
  ]);
});

test('moves focus out of collapsed rows and otherwise preserves focused controls', async ({ page }) => {
  const rowControl = body(page, 'working').getByRole('tab').first();
  await rowControl.focus();
  await page.evaluate(() => shelves.update({ counts: { working: 7 }, expanded: { inbox: false } }));
  await expect(rowControl).toBeFocused();
  await page.evaluate(() => shelves.update({ expanded: { working: false } }));
  await expect(header(page, 'working')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(header(page, 'settled')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#outside')).toBeFocused();
  await page.evaluate(() => shelves.update({ expanded: { inbox: true, working: true, settled: true } }));
  await expect(page.locator('#outside')).toBeFocused();
  await body(page, 'settled').getByRole('button', { name: 'Close Previous release', exact: true }).focus();
  await page.evaluate(() => shelves.update({ expanded: { settled: false } }));
  await expect(header(page, 'settled')).toBeFocused();
});

test('retains canonical rows, groups, slots, headers and row listeners across updates', async ({ page }) => {
  await page.evaluate(() => {
    window.originalHeaders = [...shelves.element.querySelectorAll('[data-session-shelf-toggle]')];
    window.originalSlots = { ...shelves.slots };
    window.group = document.createElement('div'); group.className = 'terminal-tab terminal-tab-group';
    const groupLabel = document.createElement('button'); groupLabel.type = 'button';
    groupLabel.className = 'terminal-tab-button terminal-tab-group-button'; groupLabel.textContent = 'npm-packages';
    groupLabel.setAttribute('aria-expanded', 'true');
    const groupMenu = document.createElement('div'); groupMenu.className = 'terminal-tab-group-menu';
    groupMenu.append(makeRow('group-a', 'Shared workspace member', 'idle', true));
    group.append(groupLabel, groupMenu); shelves.slots.inbox.append(group);
    window.groupHTML = group.outerHTML;
    window.rowHTML = rows.map((row) => row.outerHTML);
    window.observedRowChanges = [];
    const observer = new MutationObserver((records) => observedRowChanges.push(...records.map((r) => r.type)));
    for (const row of [...rows, group]) observer.observe(row, { subtree: true, childList: true, attributes: true, characterData: true });
    window.rowObserver = observer;
    for (let index = 0; index < 30; index++) shelves.update({ counts: { inbox: index }, expanded: { settled: index % 2 === 0 } });
    shelves.update();
  });
  expect(await page.evaluate(() => ({
    stableHeaders: originalHeaders.every((node, index) => node === shelves.element.querySelectorAll('[data-session-shelf-toggle]')[index]),
    stableSlots: Object.keys(originalSlots).every((key) => originalSlots[key] === shelves.slots[key]),
    stableRows: rows.every((row, index) => row.isConnected && row.outerHTML === rowHTML[index]),
    stableGroup: group.isConnected && group.outerHTML === groupHTML,
    observedRowChanges,
  }))).toEqual({ stableHeaders: true, stableSlots: true, stableRows: true, stableGroup: true, observedRowChanges: [] });
  await body(page, 'working').getByRole('tab').first().click();
  await body(page, 'working').getByRole('button', { name: 'Summary Implement session shelves', exact: true }).click();
  expect(await page.evaluate(() => actions)).toEqual([['select', 'working-0'], ['Summary', 'working-0']]);
  await page.evaluate(() => rowObserver.disconnect());
});

test('bounds count text and rejects invalid values without interpreting markup', async ({ page }) => {
  for (const [value, label] of [[0, '0'], [999, '999'], [1000, '999+'], [Number.MAX_SAFE_INTEGER, '999+'], [-1, '0'], [1.5, '0'], ['<img src=x>', '0'], [null, '0']]) {
    await page.evaluate((value) => shelves.update({ counts: { inbox: value } }), value);
    await expect(header(page, 'inbox').locator('.session-shelf-count')).toHaveText(label);
  }
  await page.evaluate(() => shelves.update({ counts: { inbox: Infinity, working: NaN, settled: {} } }));
  await expect(page.locator('.session-shelf-count')).toHaveText(['0', '0', '0']);
  await expect(page.locator('.session-shelf-header img')).toHaveCount(0);
});

test('allows the parent to move the same row between shelves without losing its state or actions', async ({ page }) => {
  await page.evaluate(() => {
    rows[0].dataset.parentState = 'retained';
    shelves.slots.settled.append(rows[0]);
    shelves.update({ counts: { inbox: 2, settled: 3 }, expanded: { settled: true } });
  });
  const moved = body(page, 'settled').getByRole('tab', { name: 'Package documentation', exact: true });
  await expect(moved).toBeVisible();
  await moved.click();
  expect(await page.evaluate(() => ({
    identity: shelves.slots.settled.lastElementChild === rows[0],
    state: rows[0].dataset.parentState,
    occurrences: document.querySelectorAll('[data-tab-id="inbox-0"]').length,
    actions,
  }))).toEqual({ identity: true, state: 'retained', occurrences: 1, actions: [['select', 'inbox-0']] });
});

test('disposes idempotently, preserves detached rows and releases retained header listeners', async ({ page }) => {
  expect(await page.evaluate(() => {
    const retainedHeader = shelves.element.querySelector('[data-session-shelf-toggle]');
    const original = rows.map((row) => row.outerHTML);
    const reclaimed = document.getElementById('reclaimed');
    reclaimed.append(rows[0]);
    shelves.dispose(); shelves.dispose();
    const disposedHTML = shelves.element.outerHTML;
    shelves.update({ counts: { inbox: 99 }, expanded: { settled: true } });
    retainedHeader.click();
    rows[0].querySelector('button').click();
    rows[3].querySelector('button').click();
    return {
      detached: !shelves.element.isConnected,
      unchanged: disposedHTML === shelves.element.outerHTML && rows.every((row, index) => row.outerHTML === original[index]),
      reclaim: rows[0].parentElement === reclaimed && rows[0].isConnected,
      retained: rows[3].parentElement === shelves.slots.working && !rows[3].isConnected,
      toggles, actions,
    };
  })).toEqual({ detached: true, unchanged: true, reclaim: true, retained: true, toggles: [], actions: [['select', 'inbox-0'], ['select', 'working-0']] });
});

for (const sidebarWidth of [280, 192]) {
  test(`keeps populated shelves bounded and reachable in a ${sidebarWidth}px sidebar, dark and light`, async ({ page }, testInfo) => {
    await page.evaluate((width) => document.documentElement.style.setProperty('--fixture-sidebar-width', width + 'px'), sidebarWidth);
    for (const appearance of ['dark', 'light']) {
      await page.evaluate((appearance) => {
        document.documentElement.classList.toggle('light', appearance === 'light');
        shelves.update({ expanded: { settled: false } });
        shelves.element.scrollTop = 0;
      }, appearance);
      const settledBox = await header(page, 'settled').boundingBox();
      const shelvesBox = await page.locator('.session-shelves').boundingBox();
      expect(Math.abs(settledBox.y + settledBox.height - shelvesBox.y - shelvesBox.height)).toBeLessThan(2);
      await page.locator('.fixture-sidebar').screenshot({ path: testInfo.outputPath(`shelves-${sidebarWidth}-${appearance}-collapsed.png`), animations: 'disabled' });
      await header(page, 'settled').click();
      for (const section of ['inbox', 'working', 'settled']) {
        await expect(body(page, section).getByRole('tab').last()).toBeInViewport({ ratio: 1 });
        for (const control of await body(page, section).locator('button').all()) await control.click({ trial: true });
      }
      await page.mouse.move(700, 100);
      await page.locator('.fixture-sidebar').screenshot({ path: testInfo.outputPath(`shelves-${sidebarWidth}-${appearance}-expanded.png`), animations: 'disabled' });
      expect(await page.evaluate(() => {
        const root = shelves.element;
        const bounds = root.getBoundingClientRect();
        return root.scrollWidth <= root.clientWidth && [...root.querySelectorAll('button')].every((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left >= bounds.left && rect.right <= bounds.right + 1;
        });
      })).toBe(true);
    }
  });
}

test('scrolls overflowing canonical rows and long labels without losing bottom controls', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 420 });
  await page.evaluate(() => {
    document.documentElement.style.setProperty('--fixture-sidebar-width', '192px');
    for (let index = 0; index < 30; index++) {
      shelves.slots.inbox.append(makeRow('long-' + index, 'Long unbroken session title ' + 'x'.repeat(512)));
    }
    shelves.update({ counts: { inbox: 33 }, expanded: { settled: true } });
  });
  expect(await page.evaluate(() => ({
    scrolls: shelves.element.scrollHeight > shelves.element.clientHeight,
    bounded: shelves.element.scrollWidth <= shelves.element.clientWidth,
    pageBounded: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
  }))).toEqual({ scrolls: true, bounded: true, pageBounded: true });
  await page.locator('#newSession').click({ trial: true });
  for (const appearance of ['dark', 'light']) {
    await page.evaluate((appearance) => document.documentElement.classList.toggle('light', appearance === 'light'), appearance);
    await body(page, 'inbox').getByRole('tab').last().focus();
    await expect(body(page, 'inbox').getByRole('tab').last()).toBeInViewport({ ratio: 1 });
    const lastClose = body(page, 'settled').getByRole('button', { name: 'Close Archived investigation', exact: true });
    await lastClose.focus();
    await expect(lastClose).toBeInViewport({ ratio: 1 });
    await lastClose.click({ trial: true });
    await page.mouse.move(700, 100);
    await page.locator('.fixture-sidebar').screenshot({ path: testInfo.outputPath(`shelves-overflow-${appearance}.png`), animations: 'disabled' });
    await page.evaluate(() => shelves.update({ expanded: { settled: false } }));
    await expect(header(page, 'settled')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(body(page, 'settled')).toBeVisible();
  }
});
