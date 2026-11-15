import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off' });
if (process.env.PI_WEBUI_TEST_CHROMIUM) {
  test.use({ launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM } });
}

const sources = new Map(await Promise.all([
  'shell-workspace.mjs', 'shell-navigation-resize.mjs', 'shell-workspace.css', 'shell-view-host.mjs', 'styles.css',
].map(async name => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const groups = [
  ['Work', ['subagents', 'queue', 'progress']],
  ['Conversations', ['conversations', 'extensions']],
  ['Usage & diagnostics', ['codex-usage', 'claude-usage', 'events']],
  ['Session', ['session', 'sampling', 'commands']],
];
const topics = [
  { id: 'subagents', label: 'Agents' }, { id: 'queue', label: 'Queues' }, { id: 'progress', label: 'Progress' },
  { id: 'conversations', label: 'Conversations' }, { id: 'extensions', label: 'Extensions' },
  { id: 'codex-usage', label: 'Codex usage' }, { id: 'claude-usage', label: 'Claude usage' }, { id: 'events', label: 'Events' },
  { id: 'session', label: 'Session' }, { id: 'sampling', label: 'Sampling' }, { id: 'commands', label: 'Commands' },
];

const fixture = `<!doctype html><html lang="en"><head><title>Activity picker component fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-workspace.css">
<style>
body { height: 100vh; }
#original { display: none; }
.fixture-conversation { padding: 24px; }
.fixture-conversation h1 { font-size: 20px; }
#draft { width: 100%; height: 80px; }
#inspectorView { display: grid; gap: 12px; }
#inspectorView h2 { font-size: 16px; margin: 0; }
#inspectorView input { width: 100%; min-width: 0; }
</style></head><body><div id="original">
<section id="conversationView" class="fixture-conversation"><h1>Activity navigation</h1>
<p>Inspect work while your conversation stays mounted.</p><label for="draft">Message Pi</label>
<textarea id="draft">Keep this unfinished prompt.</textarea></section>
<div id="inspectorView"><h2 id="sectionHeading">Agents</h2><p>Canonical inspector content</p>
<label for="inspectorDraft">Retained filter</label><input id="inspectorDraft" value="Unfinished filter">
<button id="canonicalAction">Inspect work</button></div></div>
<script type="module">
import { createFocusedWorkspace } from '/shell-workspace.mjs';
import { createViewHost } from '/shell-view-host.mjs';
window.topics = ${JSON.stringify(topics)};
window.projectTopics = [{ id: 'files', label: 'Files' }, { id: 'git', label: 'Changes' },
  { id: 'runners', label: 'Runners', available: false, unavailableReason: 'Choose a session first' },
  { id: 'release', label: 'Release' }];
window.events = [];
window.activityId = 'subagents';
window.projectId = 'files';
window.shell = createFocusedWorkspace({ document,
  onNavigate: destination => shell.update({ destination, inspectorTitle: destination === 'activity' ? 'Activity' : 'Project',
    inspector: destination === 'activity' ? activityId : projectId,
    inspectorTopics: destination === 'activity' ? topics : projectTopics }),
  onInspectorSelect: id => {
    events.push(id);
    if (shell.element.dataset.destination === 'activity') activityId = id;
    else projectId = id;
    document.getElementById('sectionHeading').textContent = [...topics, ...projectTopics].find(topic => topic.id === id)?.label || id;
    shell.update({ inspector: id });
  },
});
window.host = createViewHost({ document });
document.body.append(shell.element);
host.move(document.getElementById('conversationView'), shell.slots.conversation);
host.move(document.getElementById('inspectorView'), shell.slots.inspector);
window.originalContent = shell.slots.inspector.firstChild;
window.actionClicks = 0;
document.getElementById('canonicalAction').addEventListener('click', () => actionClicks++);
shell.update({ destination: 'activity', inspectorTitle: 'Activity', inspector: activityId, inspectorTopics: topics,
  inspectorWidth: 320, title: 'Activity fixture', context: 'Disposable workspace', navCollapsed: true });
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

test('all grouped sections stay reachable with one callback per selection and labeled canonical content', async ({ page }) => {
  const picker = page.getByRole('combobox', { name: 'Activity section', exact: true });
  await expect(page.locator('.focused-activity-picker > span')).toHaveText('View');
  await expect(picker).toHaveValue('subagents');
  await expect(page.getByRole('tablist', { name: 'Inspector topics' })).toHaveCount(0);
  await expect(page.getByRole('tabpanel')).toHaveCount(0);
  expect(await picker.locator('optgroup').evaluateAll(nodes => nodes.map(group => [group.label, [...group.children].map(option => option.value)]))).toEqual(groups);
  const selections = [...topics.slice(1), topics[0]];
  for (const topic of selections) {
    await picker.selectOption(topic.id);
    await expect(picker).toHaveValue(topic.id);
    await expect(picker.locator('option:checked')).toHaveText(topic.label);
    await expect(page.getByRole('region', { name: topic.label, exact: true }).locator('#inspectorView')).toBeVisible();
  }
  expect(await page.evaluate(() => events)).toEqual(selections.map(topic => topic.id));
  await page.locator('#canonicalAction').click();
  expect(await page.evaluate(() => ({ same: shell.slots.inspector.firstChild === originalContent, clicks: actionClicks }))).toEqual({ same: true, clicks: 1 });
});

test('disabled reasons, fallback and future sections follow the existing topic catalog contract', async ({ page }) => {
  await page.evaluate(() => shell.update({ inspector: 'queue', inspectorTopics: [
    { id: 'queue', label: 'Queues', available: false, unavailableReason: 'Choose a session first' },
    { id: 'future/topic', label: '<Future view>' },
    { id: 'events', label: 'Events' },
    { id: 'another', label: 'Another view', available: false },
  ] }));
  const picker = page.getByRole('combobox', { name: 'Activity section' });
  await expect(picker).toHaveValue('future/topic');
  await expect(picker.locator('option[value="queue"]')).toHaveJSProperty('disabled', true);
  await expect(picker.locator('option[value="queue"]')).toHaveText('Queues (Choose a session first)');
  await expect(picker.locator('option[value="queue"]')).toHaveAttribute('title', 'Choose a session first');
  await expect(picker.locator('option[value="another"]')).toHaveText('Another view (Unavailable)');
  expect(await picker.locator('optgroup').evaluateAll(nodes => nodes.map(group => [group.label, [...group.children].map(option => option.value)]))).toEqual([
    ['Work', ['queue']], ['Usage & diagnostics', ['events']], ['More', ['future/topic', 'another']],
  ]);
  await expect(page.getByRole('region', { name: '<Future view>', exact: true })).toBeVisible();
  await expect(picker.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => events)).toEqual([]);
  await picker.selectOption('events');
  await picker.selectOption('future/topic');
  expect(await page.evaluate(() => events)).toEqual(['events', 'future/topic']);
  await page.evaluate(() => shell.update({ inspector: 'missing' }));
  await expect(picker).toHaveValue('future/topic');
  expect(await page.evaluate(() => events)).toEqual(['events', 'future/topic']);
});

test('repeated snapshots retain picker, option identity and focus while applying the latest catalog', async ({ page }) => {
  const picker = page.getByRole('combobox', { name: 'Activity section' });
  await picker.selectOption('queue');
  await picker.focus();
  const result = await page.evaluate(() => {
    const select = document.activeElement;
    const options = [...select.options];
    const groups = [...select.children];
    window.retainedOptions = { queue: options.find(option => option.value === 'queue'), events: options.find(option => option.value === 'events') };
    const focused = [];
    for (let index = 0; index < 12; index++) {
      shell.update({ title: 'Updated status ' + index, inspectorTopics: topics.map(topic => ({ ...topic })) });
      focused.push(document.activeElement === select);
    }
    return { focused, sameSelect: select === document.querySelector('.focused-activity-picker select'),
      sameOptions: options.every((option, index) => option === select.options[index]),
      sameGroups: groups.every((group, index) => group === select.children[index]), events };
  });
  expect(result).toEqual({ focused: Array(12).fill(true), sameSelect: true, sameOptions: true, sameGroups: true, events: ['queue'] });
  await page.evaluate(() => shell.update({ inspector: 'events', inspectorTopics: [
    { id: 'events', label: 'Events (3)' }, { id: 'future', label: 'Future view' },
    { id: 'queue', label: 'Queues (2)', available: false, unavailableReason: 'Session disconnected' },
  ] }));
  await expect(picker).toBeFocused();
  await expect(picker).toHaveValue('events');
  await expect(picker.locator('option:checked')).toHaveText('Events (3)');
  expect(await picker.locator('option[value="events"]').evaluate(option => option === retainedOptions.events)).toBe(true);
  expect(await picker.locator('option[value="queue"]').evaluate(option => option === retainedOptions.queue)).toBe(true);
  await expect(picker.locator('option')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'Events (3)', exact: true })).toBeVisible();
  expect(await page.evaluate(() => events)).toEqual(['queue']);
});

test('native keyboard navigation skips unavailable sections and releases focus with Tab', async ({ page }) => {
  await page.evaluate(() => shell.update({ inspectorTopics: topics.map(topic => topic.id === 'queue'
    ? { ...topic, available: false, unavailableReason: 'Choose a session first' } : topic) }));
  const picker = page.getByRole('combobox', { name: 'Activity section' });
  await picker.focus();
  await page.keyboard.press('ArrowDown');
  await expect(picker).toHaveValue('progress');
  await page.keyboard.press('End');
  await expect(picker).toHaveValue('commands');
  await page.keyboard.press('Home');
  await expect(picker).toHaveValue('subagents');
  expect(await page.evaluate(() => events)).toEqual(['progress', 'commands', 'subagents']);
  await page.keyboard.press('Tab');
  await expect(page.locator('#inspectorDraft')).toBeFocused();
});

test('empty and unavailable catalogs do not synthesize a selection or replace content', async ({ page }) => {
  await page.evaluate(() => shell.update({ inspectorTopics: [
    { id: 'queue', label: 'Queues', available: false, unavailableReason: 'No session' },
    { id: 'events', label: 'Events', available: false },
  ] }));
  const picker = page.getByRole('combobox', { name: 'Activity section' });
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveValue('');
  await expect(page.getByRole('region', { name: 'Activity', exact: true })).toBeVisible();
  await page.evaluate(() => shell.update({ inspectorTopics: [] }));
  await expect(picker).toBeHidden();
  await expect(picker.locator('option')).toHaveCount(0);
  await expect(page.getByRole('tabpanel')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Activity', exact: true }).locator('#inspectorDraft')).toHaveValue('Unfinished filter');
  await page.evaluate(() => shell.update({ inspectorTopics: topics, inspector: 'queue' }));
  await expect(picker).toBeEnabled();
  await expect(picker).toHaveValue('queue');
  expect(await page.evaluate(() => events)).toEqual([]);
});

test('destination switches restore Activity selection and Project tab semantics and keyboard behavior', async ({ page }) => {
  const picker = page.getByRole('combobox', { name: 'Activity section' });
  await picker.selectOption('queue');
  await page.locator('#inspectorDraft').fill('Keep this filter');
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(picker).toBeHidden();
  await expect(page.getByRole('tablist', { name: 'Inspector topics' })).toBeVisible();
  const files = page.getByRole('tab', { name: 'Files', exact: true });
  await files.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Changes', exact: true })).toBeFocused();
  await expect(files).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tabpanel', { name: 'Changes', exact: true })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Release', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Runners', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(picker).toBeVisible();
  await expect(picker).toHaveValue('queue');
  await expect(page.getByRole('region', { name: 'Queues', exact: true })).toBeVisible();
  await expect(page.getByRole('tabpanel')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.locator('#inspectorDraft')).toHaveValue('Keep this filter');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(picker).toBeHidden();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await expect(picker).toHaveValue('queue');
  expect(await page.evaluate(() => shell.slots.inspector.firstChild === originalContent)).toBe(true);
  expect(await page.evaluate(() => events)).toEqual(['queue', 'git']);
});

test('disposal removes select listeners and stops snapshot updates', async ({ page }) => {
  const result = await page.evaluate(() => {
    const select = document.querySelector('.focused-activity-picker select');
    shell.dispose();
    shell.dispose();
    select.value = 'queue';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    shell.update({ inspector: 'events' });
    return { events, selected: select.value, sameContent: shell.slots.inspector.firstChild === originalContent };
  });
  expect(result).toEqual({ events: [], selected: 'queue', sameContent: true });
});

for (const width of [240, 320]) {
  for (const theme of ['dark', 'light']) {
    test(`${width}px inspector in ${theme} keeps the full-width picker visible without horizontal scrolling`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1100, height: 750 });
      await page.evaluate(({ width, theme }) => {
        if (theme === 'light') {
          const tokens = {
            '--theme-color-scheme': 'light', '--bg': '#eff1f5', '--panel': '#eff1f5', '--panel-2': '#ccd0da', '--panel-3': '#e6e9ef',
            '--text': '#4c4f69', '--muted': '#5c5f77', '--accent': '#8839ef', '--border': '#bcc0cc',
            '--ctp-text': '#4c4f69', '--ctp-overlay': '#8c8fa1', '--ctp-base': '#eff1f5', '--ctp-mantle': '#e6e9ef',
            '--ctp-mauve': '#8839ef', '--ctp-teal': '#179299', '--ctp-pink': '#ea76cb',
            '--ctp-crust-rgb': '220, 224, 232', '--ctp-surface-rgb': '204, 208, 218', '--ctp-mantle-rgb': '230, 233, 239',
          };
          for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
        }
        shell.update({ inspectorWidth: width });
      }, { width, theme });
      const picker = page.getByRole('combobox', { name: 'Activity section' });
      await picker.selectOption('claude-usage');
      await picker.focus();
      await expect(picker).toHaveValue('claude-usage');
      await expect(picker.locator('option:checked')).toHaveText('Claude usage');
      const geometry = await picker.evaluate(select => {
        const wrapper = select.parentElement;
        const inspector = wrapper.parentElement;
        return { inspectorWidth: inspector.getBoundingClientRect().width,
          selectWidth: select.getBoundingClientRect().width, availableWidth: wrapper.clientWidth - 24,
          wrapperOverflow: wrapper.scrollWidth > wrapper.clientWidth,
          selectOverflow: select.scrollWidth > select.clientWidth,
          inspectorOverflow: inspector.scrollWidth > inspector.clientWidth,
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          outline: getComputedStyle(select).outlineWidth };
      });
      expect(geometry).toEqual({ inspectorWidth: width, selectWidth: width - 25, availableWidth: width - 25,
        wrapperOverflow: false, selectOverflow: false, inspectorOverflow: false, pageOverflow: false, outline: '2px' });
      const screenshot = testInfo.outputPath(`activity-picker-${width}-${theme}.png`);
      await page.screenshot({ path: screenshot });
      await testInfo.attach(`Activity picker ${width}px ${theme}`, { path: screenshot, contentType: 'image/png' });
    });
  }
}
