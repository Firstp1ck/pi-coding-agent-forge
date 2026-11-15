import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off' });
if (process.env.PI_WEBUI_TEST_CHROMIUM) {
  test.use({ launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM } });
}

const sources = new Map(await Promise.all([
  'conversation-overview.mjs', 'conversation-overview.css', 'styles.css',
].map(async name => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><title>Conversation overview component fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/conversation-overview.css">
<style>
body { background: var(--bg); background-image: none; }
body::before, body::after { display: none; }
#conversation { position: relative; width: 100%; height: 100dvh; padding: 18px; }
#host { position: absolute; inset: 12px 12px 90px; pointer-events: none; display: flex; justify-content: flex-end; align-items: flex-start; overflow-y: auto; overflow-x: hidden; scrollbar-width: none; }
#draft { position: absolute; bottom: 12px; left: 12px; width: calc(100% - 24px); height: 60px;
  min-height: 0; background: var(--panel-3); color: var(--text); }
html[data-fixture-theme="light"] { --bg: #eff1f5; --text: #4c4f69; --muted: #5c5f77;
  --panel-2: rgba(204, 208, 218, 0.78); --panel-3: rgba(230, 233, 239, 0.94);
  --border: rgba(92, 95, 119, 0.26); --accent: #8839ef; --shadow: rgba(76, 79, 105, 0.16); }
</style></head><body><main id="conversation"><div id="host"></div>
<textarea id="draft" aria-label="Message Pi">Keep this unfinished prompt.</textarea></main>
<script type="module">
import { createConversationOverview } from '/conversation-overview.mjs';
window.events = [];
window.closeCount = 0;
window.overview = createConversationOverview({ document,
  onAction: (actionId, target) => events.push({ actionId, target }), onClose: () => closeCount++ });
document.getElementById('host').append(overview.element);
window.state = { open: true, title: 'Overview', context: 'Isolated component fixture', target: { session: 'fixture-a' }, sections: [
  { id: 'workspace', label: 'Workspace & Git', items: [
    { id: 'directory', label: 'Workspace', value: 'Fixture workspace', actionId: 'workspace' },
    { id: 'branch', label: 'Branch', value: 'fixture/overview', detail: 'Git status unavailable in this fixture' }] },
  { id: 'runners', label: 'Runners', items: [
    { id: 'runner', label: 'Preview', value: 'Unavailable', actionId: 'runners', disabled: true, reason: 'No runner supplied' }] },
  { id: 'agents', label: 'Agents', items: [
    { id: 'agent', label: 'Agents', value: 'Unknown', actionId: 'agents' }] },
  { id: 'usage', label: 'Usage', items: [
    { id: 'context', label: 'Context', value: '32%', progress: 32 },
    { id: 'quota', label: 'Quota', value: null, detail: 'No provider usage supplied' }] }] };
window.render = patch => { state = { ...state, ...patch }; overview.update(state); };
document.getElementById('draft').focus();
render({});
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route('http://overview.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const source = sources.get(pathname);
    await route.fulfill({
      status: source || pathname === '/' ? 200 : 404,
      contentType: pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? (pathname === '/' ? fixture : 'Not found'),
    });
  });
  await page.goto('http://overview.test/');
  await page.waitForFunction(() => window.ready);
});

test('nonmodal labelled card preserves draft focus, reports unknown data and disabled reasons', async ({ page }) => {
  const region = page.getByRole('region', { name: 'Conversation overview', exact: true });
  await expect(region).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Pi' })).toBeFocused();
  await expect(region.getByText('Unknown', { exact: true })).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Open Preview', exact: true })).toBeDisabled();
  await expect(region.getByText('No runner supplied', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open Preview' })).toHaveAttribute('aria-description', 'No runner supplied');
  await expect(region.getByRole('button')).toHaveCount(4);
  await page.getByRole('button', { name: 'Open Preview' }).dispatchEvent('click');
  expect(await page.evaluate(() => events)).toEqual([]);
});

test('keyed updates and reordering preserve focused nodes, with the latest action and target', async ({ page }) => {
  await page.getByRole('button', { name: 'Open Agents', exact: true }).focus();
  await page.evaluate(() => {
    window.originalAction = document.activeElement;
    window.originalSection = originalAction.closest('.conversation-overview-section');
    render({ target: { session: 'fixture-b' }, sections: [...state.sections].reverse().map(section => ({
      ...section, items: [...section.items].reverse().map(item => item.id === 'agent'
        ? { ...item, value: 'Updated', actionId: 'inspect-agents' } : item),
    })) });
  });
  await expect(page.getByRole('button', { name: 'Open Agents', exact: true })).toBeFocused();
  expect(await page.evaluate(() => originalAction === document.activeElement
    && originalSection === originalAction.closest('.conversation-overview-section'))).toBe(true);
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => events)).toEqual([{ actionId: 'inspect-agents', target: { session: 'fixture-b' } }]);
  await page.getByRole('textbox').focus();
  await page.evaluate(() => render({ context: 'Another update' }));
  await expect(page.getByRole('textbox')).toBeFocused();
});

test('fallback DOM reordering preserves focus without stealing it from outside', async ({ page }) => {
  await page.evaluate(() => { Element.prototype.moveBefore = undefined; });
  await page.getByRole('button', { name: 'Open Workspace', exact: true }).focus();
  await page.evaluate(() => render({ sections: [...state.sections].reverse().map(section => ({
    ...section, items: [...section.items].reverse(),
  })) }));
  await expect(page.getByRole('button', { name: 'Open Workspace', exact: true })).toBeFocused();
  await page.getByRole('textbox').focus();
  await page.evaluate(() => render({ sections: [...state.sections].reverse() }));
  await expect(page.getByRole('textbox')).toBeFocused();
});

test('Escape belongs to the focused card, respects handled events, and close never steals draft focus', async ({ page }) => {
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => closeCount)).toBe(0);
  await page.getByRole('button', { name: 'Open Workspace', exact: true }).focus();
  await page.evaluate(() => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    event.preventDefault();
    document.activeElement.dispatchEvent(event);
  });
  expect(await page.evaluate(() => closeCount)).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'Conversation overview' })).toHaveCount(0);
  expect(await page.evaluate(() => closeCount)).toBe(1);
  await page.getByRole('textbox').focus();
  await page.evaluate(() => render({ open: true }));
  await expect(page.getByRole('textbox')).toBeFocused();
  await page.getByRole('button', { name: 'Close conversation overview' }).focus();
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => closeCount)).toBe(2);
  await page.getByRole('textbox').focus();
  await page.evaluate(() => render({ open: false }));
  await expect(page.getByRole('textbox')).toBeFocused();
});

test('hidden, inert, removed and disposed controls cannot dispatch, and disposal is final', async ({ page }) => {
  await page.evaluate(() => {
    const action = overview.element.querySelector('.conversation-overview-action');
    const close = overview.element.querySelector('.conversation-overview-close');
    render({ open: false });
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    close.click();
    render({ open: true });
    document.getElementById('host').inert = true;
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    close.click();
    document.getElementById('host').inert = false;
    document.getElementById('host').hidden = true;
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    close.click();
    document.getElementById('host').hidden = false;
    action.closest('.conversation-overview-item').hidden = true;
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    action.closest('.conversation-overview-item').hidden = false;
    action.closest('.conversation-overview-item').inert = true;
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    action.closest('.conversation-overview-item').inert = false;
    render({ sections: [] });
    overview.element.append(action);
    action.click();
    overview.dispose();
    document.getElementById('host').append(overview.element);
    overview.update(state);
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    close.click();
    overview.dispose();
  });
  expect(await page.evaluate(() => ({ events, closeCount, hidden: overview.element.hidden, inert: overview.element.inert })))
    .toEqual({ events: [], closeCount: 0, hidden: true, inert: true });
});

test('text stays literal, missing values are honest, stale sections and actions disappear', async ({ page }) => {
  const unsafe = '<img src=x onerror="window.injected=true">';
  await page.evaluate(unsafe => render({ title: unsafe, context: unsafe, sections: [{ id: 'literal', label: unsafe,
    items: [{ id: 'value', label: unsafe, value: unsafe, detail: unsafe, reason: unsafe, actionId: 'literal' },
      { id: 'empty', label: 'Missing', value: '' }, { id: 'zero', label: 'Count', value: 0 }] }] }), unsafe);
  await expect(page.locator('.conversation-overview img')).toHaveCount(0);
  await expect(page.locator('.conversation-overview-title')).toHaveText(unsafe);
  await expect(page.locator('.conversation-overview-value')).toHaveText([unsafe, 'Unknown', '0']);
  await expect(page.locator('.conversation-overview-section')).toHaveCount(1);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.evaluate(() => render({ context: '', sections: [{ id: 'literal', items: [{ id: 'value', label: 'Read only', value: 'Retained' }] }] }));
  await expect(page.locator('.conversation-overview-section-title')).toBeHidden();
  await expect(page.locator('.conversation-overview-context')).toBeHidden();
  await expect(page.getByRole('button')).toHaveCount(1);
});

test('progress accepts finite numbers only, clamps bounds, and clears stale semantics', async ({ page }) => {
  await page.evaluate(() => render({ sections: [{ id: 'progress', items: [
    { id: 'low', label: 'Low', progress: -10 }, { id: 'high', label: 'High', progress: 150 },
    { id: 'fraction', label: 'Fraction', progress: 45.5 }, { id: 'nan', label: 'NaN', progress: NaN },
    { id: 'infinity', label: 'Infinity', progress: Infinity }, { id: 'string', label: 'String', progress: '60' },
  ] }] }));
  const bars = page.getByRole('progressbar');
  await expect(bars).toHaveCount(3);
  expect(await bars.evaluateAll(nodes => nodes.map(node => [node.getAttribute('aria-valuenow'), node.firstChild.style.width])))
    .toEqual([['0', '0%'], ['100', '100%'], ['45.5', '45.5%']]);
  await page.evaluate(() => render({ sections: [{ id: 'progress', items: [{ id: 'low', label: 'Low', progress: null }] }] }));
  await expect(bars).toHaveCount(0);
  await expect(page.locator('.conversation-overview-progress')).not.toHaveAttribute('aria-valuenow');
});

for (const theme of ['dark', 'light']) {
  for (const scenario of [
    { name: 'desktop', width: 1100, height: 800, text: 100 },
    { name: 'narrow-short', width: 320, height: 400, text: 100 },
    { name: 'narrow-host', width: 320, height: 400, text: 100, hostWidth: 196 },
    { name: 'double-text', width: 320, height: 500, text: 200 },
  ]) {
    test(`${theme} ${scenario.name} grows with content and retains access in constrained windows`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: scenario.width, height: scenario.height });
      await page.evaluate(({ theme, text, hostWidth }) => {
        document.documentElement.dataset.fixtureTheme = theme;
        document.documentElement.style.fontSize = text + '%';
        if (hostWidth) {
          const host = document.getElementById('host');
          host.style.left = 'auto';
          host.style.width = hostWidth + 'px';
        }
      }, { theme, text: scenario.text, hostWidth: scenario.hostWidth });
      const geometry = await page.locator('.conversation-overview').evaluate(card => {
        const content = card.querySelector('.conversation-overview-content');
        const host = card.parentElement;
        const rect = card.getBoundingClientRect();
        const bounds = host.getBoundingClientRect();
        return { width: rect.width, aboveDraft: bounds.bottom <= document.getElementById('draft').getBoundingClientRect().top,
        bounded: rect.left >= bounds.left && rect.right <= bounds.right
          && rect.top >= bounds.top,
        cardScrolls: card.scrollHeight > card.clientHeight + 1,
        contentScrolls: content.scrollHeight > content.clientHeight + 1,
        hostScrolls: host.scrollHeight > host.clientHeight + 1,
        horizontal: card.scrollWidth > card.clientWidth + 1 || content.scrollWidth > content.clientWidth + 1,
        pointer: getComputedStyle(card).pointerEvents };
      });
      expect(geometry.bounded).toBe(true);
      expect(geometry.aboveDraft).toBe(true);
      expect(geometry.width).toBeLessThanOrEqual(288);
      expect(geometry.horizontal).toBe(false);
      expect(geometry.cardScrolls).toBe(false);
      expect(geometry.contentScrolls).toBe(false);
      expect(geometry.hostScrolls).toBe(scenario.name !== 'desktop');
      expect(geometry.pointer).toBe('auto');
      await page.getByRole('button', { name: 'Open Agents', exact: true }).click();
      expect(await page.evaluate(() => events.at(-1).actionId)).toBe('agents');
      await page.locator('#host').evaluate(node => { node.scrollTop = 0; });
      await page.getByRole('textbox').focus();
      await page.screenshot({ path: testInfo.outputPath(`overview-${theme}-${scenario.name}.png`) });
      await page.getByRole('button', { name: 'Close conversation overview' }).click();
      await expect(page.locator('.conversation-overview')).toBeHidden();
    });
  }
}
