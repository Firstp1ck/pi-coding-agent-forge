import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' } });

const sources = new Map(await Promise.all([
  'shell-attention-inbox.mjs', 'shell-attention-inbox.css', 'styles.css',
].map(async (name) => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Attention inbox contract fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-attention-inbox.css">
<style>body{background:var(--bg);color:var(--text)}#trigger{margin:20px}
.fixture-run{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12px}.fixture-run span{flex:1}
.fixture-run button{color:var(--danger);background:var(--panel);box-shadow:none}
html.light{color-scheme:light;--bg:#eff1f5;--text:#4c4f69;--muted:#626880;--border:#bcc0cc;--panel:#e6e9ef;--panel-2:#dce0e8;--accent:#8839ef;--accent-2:#179299;--warning:#805600;--danger:#d20f39;--shadow:#4c4f6933}
</style></head><body><button id="trigger">Attention inbox</button><div id="retained"></div>
<dialog id="outer"><button id="outerTrigger">Open attention from outer dialog</button></dialog>
<dialog id="review"><h2>Review decision</h2><button id="reviewClose">Close review</button></dialog>
<script type="module">
import { createAttentionInbox } from '/shell-attention-inbox.mjs';
window.selections = []; window.closes = 0; window.runActions = [];
window.targetA = Object.freeze({ tabId: 'tab-a', generation: 7, sessionIdentity: 'session-a' });
window.targetB = Object.freeze({ tabId: 'tab-b', generation: 2, sessionIdentity: 'session-b' });
window.items = Object.freeze([
  Object.freeze({ id: 'shared', tabId: 'tab-a', title: 'Build release', detail: 'Two approvals waiting in the release tab', state: 'blocked', decisionCount: 2, target: targetA }),
  Object.freeze({ id: 'running', tabId: 'tab-a', title: 'Check package', detail: 'Tests are running', state: 'working', decisionCount: 99, target: targetA }),
  Object.freeze({ id: 'shared', tabId: 'tab-b', title: 'Review changes', detail: 'One decision waiting in the review tab', state: 'blocked', decisionCount: 1, target: targetB }),
  Object.freeze({ id: 'finished', tabId: 'tab-b', title: 'Update docs', detail: 'Documentation update finished', state: 'done', decisionCount: 50, target: targetB }),
]);
window.initialItems = items;
window.inbox = createAttentionInbox({ document,
  onSelect(item) { selections.push(item); window.afterSelect?.(item); },
  onClose() { closes += 1; window.afterClose?.(); },
});
window.detachedAtConstruction = !inbox.element.isConnected;
document.body.append(inbox.element);
window.run = document.createElement('div'); run.className = 'fixture-run';
const label = document.createElement('span'); label.textContent = 'Release tab · Run active'; run.append(label);
for (const name of ['Abort', 'End']) {
  const control = document.createElement('button'); control.type = 'button'; control.textContent = name;
  control.addEventListener('click', () => runActions.push(name)); run.append(control);
}
inbox.slots.runControls.append(run);
window.snapshot = () => ({ items });
document.getElementById('trigger').addEventListener('click', (event) => inbox.open(snapshot(), event.currentTarget));
document.getElementById('outerTrigger').addEventListener('click', (event) => inbox.open(snapshot(), event.currentTarget));
document.getElementById('reviewClose').addEventListener('click', () => document.getElementById('review').close());
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  const errors = [];
  const unexpectedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const source = url.origin === 'http://attention.test' ? sources.get(url.pathname) : undefined;
    if (source !== undefined || (url.origin === 'http://attention.test' && url.pathname === '/')) {
      await route.fulfill({ contentType: url.pathname.endsWith('.mjs') ? 'text/javascript'
        : url.pathname.endsWith('.css') ? 'text/css' : 'text/html', body: source ?? fixture });
    } else {
      unexpectedRequests.push(url.href);
      await route.abort();
    }
  });
  await page.goto('http://attention.test/');
  await page.waitForFunction(() => window.ready);
  await page.getByRole('button', { name: 'Attention inbox', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close attention inbox' })).toBeFocused();
  page.__attentionErrors = errors;
  page.__attentionRequests = unexpectedRequests;
});

test.afterEach(async ({ page }) => {
  expect(page.__attentionErrors).toEqual([]);
  expect(page.__attentionRequests).toEqual([]);
});

const itemButtons = (page) => page.locator('.attention-inbox-item');
const section = (page, name) => page.getByRole('region', { name, exact: true });

test('groups in supplied order and counts only actual blocked decisions without consuming records', async ({ page }) => {
  expect(await page.evaluate(() => detachedAtConstruction)).toBe(true);
  await expect(page.getByRole('dialog', { name: 'Attention', exact: true })).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('3 decisions · 1 running · 1 finished');
  await expect(section(page, 'Needs your decision').locator('.attention-inbox-count')).toHaveText('3 decisions · 2 items');
  await expect(section(page, 'Running').locator('.attention-inbox-count')).toHaveText('1 item');
  await expect(section(page, 'Finished').locator('.attention-inbox-count')).toHaveText('1 item');
  await expect(itemButtons(page).locator('.attention-inbox-item-title')).toHaveText([
    'Build release', 'Review changes', 'Check package', 'Update docs',
  ]);
  expect(await page.evaluate(() => ({ selected: selections.length, closes,
    original: items === initialItems && items.every((item) => Object.isFrozen(item)),
    storage: [localStorage.length, sessionStorage.length] }))).toEqual({ selected: 0, closes: 0, original: true, storage: [0, 0] });
  await page.evaluate(() => { inbox.close(); inbox.open(snapshot(), document.getElementById('trigger')); });
  await expect(page.getByRole('status')).toHaveText('3 decisions · 1 running · 1 finished');
  expect(await page.evaluate(() => selections.length)).toBe(0);
});

test('returns the original item and target across tabs with colliding item IDs', async ({ page }) => {
  await itemButtons(page).nth(1).click();
  await itemButtons(page).nth(0).focus();
  await page.keyboard.press('Enter');
  await itemButtons(page).nth(2).click();
  await itemButtons(page).nth(3).click();
  expect(await page.evaluate(() => ({ originals: selections.every((item) => initialItems.includes(item)),
    tabs: selections.map((item) => item.tabId),
    references: selections[0] === items[2] && selections[0].target === targetB
      && selections[1] === items[0] && selections[1].target === targetA,
    open: inbox.element.open }))).toEqual({ originals: true, tabs: ['tab-b', 'tab-a', 'tab-a', 'tab-b'], references: true, open: true });
});

test('preserves focused row DOM across reordered, replaced and regrouped snapshots', async ({ page }) => {
  await itemButtons(page).nth(1).focus();
  await page.evaluate(() => {
    window.stableControl = document.activeElement;
    window.replacement = Object.freeze({ ...items[2], title: 'Review revised changes', target: Object.freeze({ ...targetB, generation: 3 }) });
    items = [replacement, items[1], items[0], items[3]];
    inbox.update(snapshot());
  });
  await expect(itemButtons(page).nth(0)).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === stableControl)).toBe(true);
  await page.evaluate(() => {
    items = items.map((item) => item === replacement ? Object.freeze({ ...item, state: 'done' }) : item);
    window.replacement = items[0];
    inbox.update(snapshot());
  });
  await expect(section(page, 'Finished').getByRole('button').first()).toBeFocused();
  expect(await page.evaluate(() => document.activeElement === stableControl)).toBe(true);
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => selections.length === 1 && selections[0] === replacement && selections[0].target === replacement.target)).toBe(true);
  await expect(page.getByRole('status')).toHaveText('2 decisions · 1 running · 2 finished');
  await expect(section(page, 'Needs your decision').locator('.attention-inbox-count')).toHaveText('2 decisions · 1 item');
});

test('rejects disabled and removed rows including retained DOM and in-place availability changes', async ({ page }) => {
  await page.evaluate(() => {
    window.disabledItem = { ...items[0], disabled: true };
    window.unavailableItem = { ...items[2], available: false };
    items = [disabledItem, unavailableItem, items[1]];
    inbox.update(snapshot());
  });
  await expect(itemButtons(page).nth(0)).toBeDisabled();
  await expect(itemButtons(page).nth(1)).toBeDisabled();
  await itemButtons(page).nth(0).evaluate((control) => control.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await page.evaluate(() => {
    window.stale = document.querySelectorAll('.attention-inbox-item')[1];
    stale.disabled = false;
    stale.click();
    items = [{ ...items[2] }]; inbox.update(snapshot());
    stale.click();
    inbox.element.append(stale); stale.click(); stale.remove();
    items[0].available = false;
    document.querySelector('.attention-inbox-item').click();
  });
  expect(await page.evaluate(() => selections)).toEqual([]);
  await itemButtons(page).evaluate((control) => { control.disabled = true; control.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  expect(await page.evaluate(() => selections)).toEqual([]);
});

test('moves focus to a surviving item when the focused item is disabled or removed', async ({ page }) => {
  await itemButtons(page).first().focus();
  await page.evaluate(() => { items = items.map((item, index) => index ? item : { ...item, disabled: true }); inbox.update(snapshot()); });
  await expect(itemButtons(page).nth(1)).toBeFocused();
  await page.evaluate(() => { items = items.filter((item) => item.tabId !== 'tab-b'); inbox.update(snapshot()); });
  await expect(section(page, 'Running').getByRole('button')).toBeFocused();
  await page.evaluate(() => { items = []; inbox.update(snapshot()); });
  await expect(page.getByRole('button', { name: 'Close attention inbox' })).toBeFocused();
  await expect(page.getByText('No activity to show.', { exact: false })).toBeVisible();
});

test('renders empty and zero counts honestly and treats supplied titles and details as text', async ({ page }) => {
  await page.evaluate(() => { inbox.update({ items: [] }); });
  await expect(itemButtons(page)).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('0 decisions · 0 running · 0 finished');
  for (const name of ['Needs your decision', 'Running', 'Finished']) await expect(section(page, name)).toBeVisible();
  await expect(page.getByText('No decisions waiting.', { exact: true })).toBeVisible();
  await expect(page.getByText('Nothing running.', { exact: true })).toBeVisible();
  await expect(page.getByText('No finished work.', { exact: true })).toBeVisible();
  await page.evaluate(() => {
    items = [{ ...initialItems[0], title: '<img src=x onerror=alert(1)>', detail: '<script>throw new Error("unsafe")</script>', decisionCount: 0 }];
    inbox.update(snapshot()); inbox.update();
  });
  await expect(section(page, 'Needs your decision').locator('.attention-inbox-count')).toHaveText('0 decisions · 1 item');
  await expect(itemButtons(page)).toContainText('<img src=x onerror=alert(1)>');
  await expect(itemButtons(page)).toContainText('<script>throw new Error("unsafe")</script>');
  await expect(page.locator('#shellAttentionInbox img, #shellAttentionInbox script')).toHaveCount(0);
});

test('Escape and rapid reopen notify once per lifetime and restore the visible trigger', async ({ page }) => {
  await page.keyboard.press('Escape');
  await expect(page.locator('#shellAttentionInbox')).not.toBeVisible();
  await expect(page.locator('#trigger')).toBeFocused();
  expect(await page.evaluate(() => closes)).toBe(1);
  await page.evaluate(() => {
    inbox.close();
    inbox.open(snapshot(), document.getElementById('trigger'));
    inbox.close(); inbox.open(snapshot(), document.getElementById('trigger'));
  });
  await expect(page.locator('#shellAttentionInbox')).toBeVisible();
  expect(await page.evaluate(() => closes)).toBe(2);
  await page.getByRole('button', { name: 'Close attention inbox' }).click();
  await expect(page.locator('#trigger')).toBeFocused();
  expect(await page.evaluate(() => closes)).toBe(3);
  await page.evaluate(() => { inbox.open(snapshot()); inbox.element.close(); });
  await expect.poll(() => page.evaluate(() => closes)).toBe(4);
});

test('native Tab order excludes outside page controls and closed items cannot dispatch', async ({ page }) => {
  await page.keyboard.press('Shift+Tab');
  // Chromium permits a browser-chrome stop at native dialog boundaries.
  if (!await page.evaluate(() => document.hasFocus())) await page.keyboard.press('Shift+Tab');
  await expect(itemButtons(page).last()).toBeFocused();
  await page.keyboard.press('Tab');
  if (!await page.evaluate(() => document.hasFocus())) await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Close attention inbox' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Abort', exact: true })).toBeFocused();
  await page.evaluate(() => {
    inbox.close();
    document.querySelector('.attention-inbox-item').click();
  });
  expect(await page.evaluate(() => selections)).toEqual([]);
});

test('cooperates with nested native dialogs, updates under a modal and Escape closes only the top dialog', async ({ page }) => {
  await page.evaluate(() => { inbox.close(); document.getElementById('outer').showModal(); });
  await page.getByRole('button', { name: 'Open attention from outer dialog' }).click();
  await itemButtons(page).first().focus();
  await page.evaluate(() => {
    window.focusedItem = document.activeElement;
    inbox.element.append(document.getElementById('review'));
    document.getElementById('review').showModal();
    inbox.update({ items: [...items].reverse() });
  });
  await expect(page.locator('#reviewClose')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#review')).not.toBeVisible();
  await expect(page.locator('#shellAttentionInbox')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === focusedItem)).toBe(true);
  expect(await page.evaluate(() => closes)).toBe(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('#shellAttentionInbox')).not.toBeVisible();
  await expect(page.locator('#outer')).toBeVisible();
  await expect(page.locator('#outerTrigger')).toBeFocused();
  expect(await page.evaluate(() => closes)).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('#outer')).not.toBeVisible();
});

test('closing underneath another modal or opening one on close does not steal its focus', async ({ page }) => {
  await page.evaluate(() => { document.getElementById('review').showModal(); inbox.close(); });
  await expect(page.locator('#reviewClose')).toBeFocused();
  await page.evaluate(() => {
    document.getElementById('review').close();
    inbox.open(snapshot(), document.getElementById('trigger'));
    window.afterClose = () => document.getElementById('review').showModal();
    inbox.close();
  });
  await expect(page.locator('#reviewClose')).toBeFocused();
  expect(await page.evaluate(() => closes)).toBe(2);
});

for (const kind of ['hidden', 'disconnected', 'invisible', 'disabled']) {
  test(`skips focus restoration when the opener is ${kind}`, async ({ page }) => {
    await page.evaluate((kind) => {
      const trigger = document.getElementById('trigger');
      window.hiddenFocusAttempts = 0;
      trigger.focus = () => { hiddenFocusAttempts += 1; };
      if (kind === 'hidden') trigger.hidden = true;
      if (kind === 'disconnected') trigger.remove();
      if (kind === 'invisible') trigger.style.visibility = 'hidden';
      if (kind === 'disabled') trigger.disabled = true;
      inbox.close();
    }, kind);
    expect(await page.evaluate(() => hiddenFocusAttempts)).toBe(0);
    expect(await page.evaluate(() => document.activeElement.id)).not.toBe('trigger');
  });
}

test('leaves canonical run controls reachable, releases listeners on disposal and cannot dispatch retained nodes', async ({ page }) => {
  await expect(page.getByRole('group', { name: 'Run controls', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Abort', exact: true }).focus();
  await page.evaluate(() => inbox.update({ items: [...items].reverse() }));
  await expect(page.getByRole('button', { name: 'Abort', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'End', exact: true }).click();
  await page.evaluate(() => {
    window.retainedButton = document.querySelector('.attention-inbox-item');
    window.retainedClose = document.querySelector('.attention-inbox-close');
    document.getElementById('retained').append(run);
    inbox.dispose(); inbox.dispose(); inbox.open(snapshot()); inbox.update(snapshot()); inbox.close();
    retainedButton.click(); retainedClose.click();
    inbox.element.dispatchEvent(new Event('close')); inbox.element.dispatchEvent(new Event('cancel', { cancelable: true }));
    run.querySelector('button').click();
  });
  await expect(page.locator('#shellAttentionInbox')).toHaveCount(0);
  expect(await page.evaluate(() => ({ closes, selections: selections.length, runActions, retained: run.parentNode.id })))
    .toEqual({ closes: 1, selections: 0, runActions: ['Abort', 'End', 'Abort'], retained: 'retained' });
});

for (const [width, height] of [[1440, 1000], [390, 844]]) {
  test(`shows populated sections together at ${width}px in dark and light`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    for (const name of ['Needs your decision', 'Running', 'Finished']) {
      await expect(section(page, name)).toBeInViewport();
      await expect(section(page, name).getByRole('button').last()).toBeInViewport();
    }
    for (const appearance of ['dark', 'light']) {
      await page.evaluate((appearance) => document.documentElement.classList.toggle('light', appearance === 'light'), appearance);
      await page.screenshot({ path: testInfo.outputPath(`attention-populated-${width}-${appearance}.png`), animations: 'disabled' });
      await page.locator('#shellAttentionInbox').screenshot({ path: testInfo.outputPath(`attention-component-${width}-${appearance}.png`), animations: 'disabled' });
    }
  });
}

for (const [width, height] of [[1440, 1000], [390, 844], [320, 640], [720, 500]]) {
  test(`wraps long text and keeps controls reachable at ${width}px in dark and light`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      items = [...items, ...Array.from({ length: 25 }, (_, index) => ({ id: 'extra-' + index, tabId: 'tab-long',
        title: index === 0 ? 'VeryLongUnbrokenActivityTitle'.repeat(12) : 'Background task ' + index,
        detail: index === 0 ? '/very-long-unbroken-project-path'.repeat(20) : 'A caller-provided description of work in another tab.',
        state: index === 0 ? 'blocked' : index % 2 ? 'working' : 'done', decisionCount: index === 0 ? 12 : 0, target: targetA }))];
      inbox.update(snapshot());
    });
    for (const control of [page.getByRole('button', { name: 'Close attention inbox' }),
      page.getByRole('button', { name: 'Abort', exact: true }), page.getByRole('button', { name: 'End', exact: true })]) {
      const bounds = await control.boundingBox();
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(bounds.y).toBeGreaterThanOrEqual(0);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
      await control.click({ trial: true });
    }
    const geometry = await page.evaluate(() => {
      const dialog = inbox.element.getBoundingClientRect();
      const body = document.querySelector('.attention-inbox-body');
      return { left: dialog.left, right: dialog.right, top: dialog.top, bottom: dialog.bottom,
        docOverflow: document.documentElement.scrollWidth > innerWidth,
        overflow: body.scrollWidth > body.clientWidth, scrolls: body.scrollHeight > body.clientHeight,
        titleHeight: document.querySelectorAll('.attention-inbox-blocked .attention-inbox-item-title')[2].getBoundingClientRect().height };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(width);
    expect(geometry.top).toBeGreaterThanOrEqual(0);
    expect(geometry.bottom).toBeLessThanOrEqual(height);
    expect(geometry.docOverflow).toBe(false);
    expect(geometry.overflow).toBe(false);
    expect(geometry.scrolls).toBe(true);
    expect(geometry.titleHeight).toBeLessThan(80);
    for (const appearance of ['dark', 'light']) {
      await page.evaluate((appearance) => {
        document.documentElement.classList.toggle('light', appearance === 'light');
        document.querySelector('.attention-inbox-body').scrollTop = 0;
      }, appearance);
      await page.screenshot({ path: testInfo.outputPath(`attention-${width}-${appearance}.png`), animations: 'disabled' });
    }
    await itemButtons(page).last().focus();
    await expect(itemButtons(page).last()).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Abort', exact: true })).toBeInViewport();
  });
}
