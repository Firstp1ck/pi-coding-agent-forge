import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off' });
if (process.env.PI_WEBUI_TEST_CHROMIUM) {
  test.use({ launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM } });
}

const sources = new Map(await Promise.all([
  'shell-workspace.mjs', 'shell-navigation-resize.mjs', 'shell-inspector-resize.mjs', 'shell-workspace.css', 'shell-view-host.mjs', 'styles.css',
].map(async name => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><title>Inspector header component fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-workspace.css">
<style>
body { height: 100vh; }
#original { display: none; }
#canonicalConversation { height: 100%; padding: 20px; }
#draft, #filter { display: block; width: 100%; margin-top: 12px; }
#transcriptAction { position: absolute; right: 24px; top: 140px; }
#overviewFixture { width: 288px; max-width: 100%; padding: 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel-3); pointer-events: auto; }
#overviewFixture p { margin: 0 0 8px; }
.fixture-run { display: flex; gap: 4px; }
.fixture-run button { min-width: 40px; min-height: 30px; padding: 4px; font-size: 12px; }
</style></head><body><div id="original">
<div id="canonicalConversation"><h2>Inspector header fixture</h2><p>Conversation content stays mounted.</p>
<button id="transcriptAction">Transcript action</button><label for="draft">Message Pi</label><textarea id="draft">Unfinished prompt</textarea></div>
<div id="canonicalInspector"><p>Canonical inspector content</p><label for="filter">Filter</label><input id="filter" value="Unsaved filter"></div>
<div id="overviewFixture"><p>Overview component placeholder</p><button id="overviewAction">Inspect context</button></div>
<div id="runs" class="fixture-run"><button>Abort</button><button>End</button></div></div>
<script type="module">
import { createFocusedWorkspace } from '/shell-workspace.mjs';
import { createViewHost } from '/shell-view-host.mjs';
const catalogs = {
  project: [{ id: 'files', label: 'Files' }, { id: 'git', label: 'Changes' },
    { id: 'runners', label: 'Runners', available: false, unavailableReason: 'Choose a session first' },
    { id: 'release', label: 'Release' }],
  activity: [{ id: 'subagents', label: 'Agents' }, { id: 'queue', label: 'Queues' }, { id: 'events', label: 'Events' }],
};
window.events = [];
window.snapshot = { destination: 'project', inspector: 'files', inspectorOpen: true, overviewOpen: false,
  title: 'Review inspector navigation', context: 'Disposable workspace', inspectorTitle: 'Project', inspectorTopics: catalogs.project };
window.apply = patch => { Object.assign(snapshot, patch); shell.update(snapshot); };
window.shell = createFocusedWorkspace({ document,
  onNavigate: destination => {
    events.push(['navigate', destination]);
    apply({ destination, inspector: catalogs[destination]?.[0].id,
      inspectorTitle: destination === 'activity' ? 'Activity' : 'Project', inspectorTopics: catalogs[destination] || [] });
  },
  onInspectorSelect: id => { events.push(['section', id]); apply({ inspector: id }); },
  onToggleOverview: () => { events.push(['overview']); apply({ overviewOpen: !snapshot.overviewOpen }); },
  onToggleInspector: () => { events.push(['inspector']); apply({ destination: 'conversation', inspectorOpen: !snapshot.inspectorOpen }); },
  onInspectorClose: () => apply({ destination: 'conversation', inspectorOpen: false }),
});
window.host = createViewHost({ document });
document.body.append(shell.element);
for (const [slot, id] of Object.entries({ conversation: 'canonicalConversation', inspector: 'canonicalInspector', overview: 'overviewFixture', runControls: 'runs' })) {
  host.move(document.getElementById(id), shell.slots[slot]);
}
window.originalContent = document.getElementById('canonicalInspector');
window.originalConversation = document.getElementById('canonicalConversation');
window.transcriptClicks = 0;
window.overviewClicks = 0;
document.getElementById('transcriptAction').onclick = () => transcriptClicks++;
document.getElementById('overviewAction').onclick = () => overviewClicks++;
apply({});
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route('http://workspace.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const source = sources.get(pathname);
    await route.fulfill({
      status: source || pathname === '/' ? 200 : 404,
      contentType: pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? (pathname === '/' ? fixture : 'Not found'),
    });
  });
  await page.goto('http://workspace.test/');
  await page.waitForFunction(() => window.ready);
});

test('destination tabs move out of the rail and retain manual activation with arrow, Home and End keys', async ({ page }) => {
  const tabs = page.getByRole('tablist', { name: 'Inspector destinations' });
  const project = tabs.getByRole('tab', { name: 'Project', exact: true });
  const activity = tabs.getByRole('tab', { name: 'Activity', exact: true });
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: /^(Project|Activity)$/ })).toHaveCount(0);
  await expect(project).toHaveAttribute('aria-selected', 'true');
  await expect(project).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tabpanel', { name: 'Project', exact: true })).toBeVisible();
  await project.focus();
  await page.keyboard.press('ArrowRight');
  await expect(activity).toBeFocused();
  await expect(project).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => apply({ title: 'Updated status' }));
  await expect(activity).toBeFocused();
  await expect(activity).toHaveAttribute('tabindex', '0');
  await page.keyboard.press('ArrowRight');
  await expect(project).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(activity).toBeFocused();
  await page.keyboard.press('Home');
  await expect(project).toBeFocused();
  await page.keyboard.press('End');
  await expect(activity).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(activity).toHaveAttribute('aria-selected', 'true');
  await expect(activity).toHaveAttribute('aria-current', 'page');
  await expect(project).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('tabpanel', { name: 'Activity', exact: true })).toBeVisible();
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  expect(await page.evaluate(() => events)).toEqual([['navigate', 'activity'], ['navigate', 'project']]);
});

test('one header selector changes sections without replacing canonical content, drafts or focused controls', async ({ page }) => {
  const picker = page.getByRole('combobox', { name: 'Project section' });
  await expect(page.locator('.focused-inspector-header select')).toHaveCount(1);
  await expect(page.getByRole('tablist', { name: 'Inspector topics' })).toHaveCount(0);
  await expect(page.locator('.focused-inspector-header')).not.toContainText('View');
  await picker.evaluate(select => { window.originalSelect = select; });
  await picker.focus();
  await page.keyboard.press('ArrowDown');
  await expect(picker).toHaveValue('git');
  await page.keyboard.press('End');
  await expect(picker).toHaveValue('release');
  await page.keyboard.press('Home');
  await expect(picker).toHaveValue('files');
  await page.evaluate(() => { for (let index = 0; index < 10; index++) apply({ title: 'Status ' + index }); });
  await expect(picker).toBeFocused();
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Activity', exact: true })).toHaveAttribute('tabindex', '0');
  await expect(page.getByRole('tab', { name: 'Project', exact: true })).toHaveAttribute('tabindex', '-1');
  const activity = page.getByRole('combobox', { name: 'Activity section' });
  expect(await activity.evaluate(select => select === originalSelect)).toBe(true);
  await expect(activity.locator('optgroup')).toHaveCount(2);
  await activity.selectOption('events');
  await expect(page.getByRole('region', { name: 'Events', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Project', exact: true }).click();
  await expect(picker.locator('optgroup')).toHaveCount(0);
  await expect(picker.locator('option')).toHaveCount(4);
  await expect(picker.locator('option[value="runners"]')).toBeDisabled();
  await expect(page.locator('#draft')).toHaveValue('Unfinished prompt');
  await expect(page.locator('#filter')).toHaveValue('Unsaved filter');
  expect(await page.evaluate(() => ({ inspector: shell.slots.inspector.firstChild === originalContent,
    conversation: originalConversation.parentElement === shell.slots.conversation, events }))).toEqual({
    inspector: true, conversation: true,
    events: [['section', 'git'], ['section', 'release'], ['section', 'files'], ['navigate', 'activity'], ['section', 'events'], ['navigate', 'project']],
  });
});

test('overview and inspector toggles expose visibility and stable hosts without intercepting conversation clicks', async ({ page }) => {
  const overview = page.getByRole('button', { name: 'Overview', exact: true });
  const inspector = page.getByRole('button', { name: 'Inspector', exact: true });
  await expect(overview).toHaveAttribute('aria-expanded', 'false');
  await expect(inspector).toHaveAttribute('aria-expanded', 'true');
  await expect(overview).toHaveAttribute('aria-controls', 'focusedWorkspaceOverview');
  await expect(inspector).toHaveAttribute('aria-controls', 'focusedWorkspaceInspector');
  await page.locator('#draft').focus();
  await page.locator('#draft').evaluate(draft => draft.setSelectionRange(2, 8, 'backward'));
  await page.evaluate(() => apply({ overviewOpen: true }));
  await expect(page.locator('#draft')).toBeFocused();
  expect(await page.locator('#draft').evaluate(draft => [draft.selectionStart, draft.selectionEnd, draft.selectionDirection])).toEqual([2, 8, 'backward']);
  await expect(overview).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => { shell.slots.overview.style.height = '180px'; });
  await page.locator('#transcriptAction').click();
  await page.locator('#overviewAction').click();
  expect(await page.evaluate(() => ({ transcriptClicks, overviewClicks,
    pointerEvents: getComputedStyle(shell.slots.overview).pointerEvents,
    sibling: shell.slots.overview.parentElement === originalConversation.parentElement }))).toEqual({ transcriptClicks: 1, overviewClicks: 1, pointerEvents: 'none', sibling: true });
  await overview.click();
  await expect(page.locator('#overviewFixture')).toBeHidden();
  await overview.press('Enter');
  await expect(page.locator('#overviewFixture')).toBeVisible();
  await inspector.click();
  await expect(inspector).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.focused-inspector')).toBeHidden();
  await inspector.press('Space');
  await expect(inspector).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#canonicalInspector')).toBeVisible();
  await page.evaluate(() => { shell.dispose(); document.querySelectorAll('.focused-header button').forEach(button => button.click()); });
  expect(await page.evaluate(() => events)).toEqual([['overview'], ['overview'], ['inspector'], ['inspector']]);
});

for (const [width, inspectorWidth, textScale] of [[1440, 320, 1], [1100, 240, 1], [1100, 320, 2]]) {
  test(`header and inspector fit ${width}px with ${inspectorWidth}px inspector at ${textScale * 100}% text`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(({ inspectorWidth, textScale }) => {
      document.documentElement.style.fontSize = (16 * textScale) + 'px';
      apply({ inspectorWidth, overviewOpen: true, title: 'A very long conversation title '.repeat(12), context: '/long/workspace/path/'.repeat(12),
        inspectorTopics: [{ id: 'files', label: 'A very long current project section title '.repeat(8) }] });
    }, { inspectorWidth, textScale });
    const geometry = await page.evaluate(() => {
      const inspector = document.querySelector('.focused-inspector');
      const tabs = document.querySelector('.focused-inspector-destinations');
      const select = document.querySelector('.focused-inspector-section');
      const header = document.querySelector('.focused-header');
      const host = shell.slots.overview.getBoundingClientRect();
      const conversation = shell.slots.conversation.getBoundingClientRect();
      return { pageOverflow: document.documentElement.scrollWidth > innerWidth,
        inspectorOverflow: inspector.scrollWidth > inspector.clientWidth,
        tabsOverflow: tabs.scrollWidth > tabs.clientWidth,
        headerOverflow: header.scrollWidth > header.clientWidth,
        selectorInside: select.getBoundingClientRect().right <= inspector.getBoundingClientRect().right,
        overviewInside: host.right <= conversation.right && host.left >= conversation.left && host.top >= conversation.top,
        controls: [...header.querySelectorAll('button')].map(button => {
          const box = button.getBoundingClientRect();
          return box.width > 0 && box.left >= header.getBoundingClientRect().left && box.right <= innerWidth;
        }) };
    });
    expect(geometry).toEqual({ pageOverflow: false, inspectorOverflow: false, tabsOverflow: false, headerOverflow: false,
      selectorInside: true, overviewInside: true, controls: Array(6).fill(true) });
    await expect(page.getByRole('button', { name: 'Abort', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'End', exact: true })).toBeVisible();
    const screenshot = testInfo.outputPath(`inspector-header-${width}-${inspectorWidth}-${textScale}x.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach('Inspector header and overview host', { path: screenshot, contentType: 'image/png' });
  });
}
