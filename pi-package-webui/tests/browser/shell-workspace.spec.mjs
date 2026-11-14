import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off' });
if (process.env.PI_WEBUI_TEST_CHROMIUM) {
  test.use({ launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM } });
}

const sources = new Map(await Promise.all([
  'shell-workspace.mjs', 'shell-workspace.css', 'shell-view-host.mjs', 'styles.css',
].map(async (name) => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><title>Focused workspace component fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-workspace.css">
<style>
body { height: 100vh; }
#original { display: none; }
.fixture-roster { padding: 12px; display: grid; gap: 8px; }
.fixture-roster h2 { margin: 0 0 8px; font-size: 14px; }
.fixture-roster button { text-align: left; font-size: 12px; padding: 8px; }
.fixture-roster input { width: 100%; min-width: 0; }
#focusedWorkspace[data-navigation="top"] .fixture-roster { display: flex; align-items: center; width: max-content; }
#focusedWorkspace[data-navigation="top"] .fixture-roster input { width: 160px; }
.fixture-transcript { flex: 1; min-height: 0; overflow: auto; padding: 24px max(20px, calc((100% - 800px) / 2)); }
.fixture-transcript p { font-size: 14px; line-height: 1.7; }
.fixture-transcript h2 { font-size: 16px; font-weight: 550; }
.fixture-transcript .message-role { font-size: 12px; color: var(--accent); }
.fixture-composer-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-top: 8px; }
.fixture-composer-controls button, .fixture-composer-controls select { font-size: 12px; }
#draft { display: block; width: 100%; height: 70px; resize: vertical; font-size: 14px; }
.fixture-settings h1, .fixture-home h1 { font-size: 22px; }
.fixture-setting { padding: 18px 0; border-bottom: 1px solid var(--border); display: flex; gap: 16px; align-items: center; justify-content: space-between; }
.fixture-setting p { color: var(--muted); margin: 4px 0; }
.fixture-inspector { display: grid; gap: 12px; }
.fixture-inspector textarea { width: 100%; height: 140px; font-size: 14px; }
.fixture-inspector button { text-align: left; }
.fixture-run button { color: var(--danger); border-color: var(--danger); font-size: 12px; }
</style></head><body>
<div id="original">
<nav class="fixture-roster" id="roster" aria-label="Fixture sessions">
<h2>npm-packages</h2><input id="sessionSearch" aria-label="Search sessions" placeholder="Search sessions">
<button aria-pressed="true">Compact workspace</button><button>Review architecture</button><button>Prepare release</button>
</nav>
<div id="canonicalConversation" class="workspace-column"><section class="chat-panel">
<div class="terminal-tabs-shell"><button id="canonicalAction">Session details</button><button>New session</button></div>
<div id="transcript" class="fixture-transcript">
<article class="message user"><span class="message-role">You</span><p>Make the workspace more compact. Keep the conversation and every feature reachable.</p></article>
<article class="message assistant"><span class="message-role">π Pi</span><h2>A smaller shell around your work</h2>
<p id="selectedText">The conversation stays mounted while you inspect your project or change settings.</p>
<p>This is a disposable component fixture. Its controls exercise callback routing without starting sessions or running commands.</p>
<details><summary>Inspected workspace layout</summary><p>Caller-owned content stays in the same slots.</p></details>
</article></div>
<form class="composer" onsubmit="return false"><label for="draft">Message Pi</label><textarea id="draft">Keep my unfinished prompt and selection.</textarea>
<div class="fixture-composer-controls"><button id="attach" type="button">Attach files</button><select aria-label="Model"><option>Fixture model</option></select><select aria-label="Effort"><option>High</option></select><button type="button">More composer actions</button><button type="submit">Send</button></div></form>
</section></div>
<div class="fixture-home" id="homeView"><h1>Your workspace</h1><p>Continue a conversation or choose a saved workspace.</p><input id="homeFilter" aria-label="Find workspace" value="Unsaved workspace filter"></div>
<div class="fixture-settings" id="settingsView"><h1>Settings</h1><p>Appearance and browser preferences</p>
<div class="fixture-setting"><div><strong>Theme</strong><p>Use Pi's existing colors.</p></div><select aria-label="Theme"><option>Fixture tokens</option></select></div>
<div class="fixture-setting"><div><strong>Desktop layout</strong><p>Session navigation beside the conversation.</p></div><span>Focused</span></div>
<div class="fixture-setting"><label for="settingsDraft">Uncommitted setting</label><input id="settingsDraft" value="Keep this setting"></div></div>
<div class="fixture-inspector" id="inspectorView"><strong>Project files</strong><button>public/</button><button>shell-workspace.mjs</button><label for="editor">Unsaved file buffer</label><textarea id="editor">const draft = 'keep me';</textarea></div>
<div class="fixture-run" id="runView"><button id="abort" type="button">Stop fixture run</button></div>
</div>
<script type="module">
import { createFocusedWorkspace } from '/shell-workspace.mjs';
import { createViewHost } from '/shell-view-host.mjs';
window.events = [];
window.createFocusedWorkspace = createFocusedWorkspace;
window.shell = createFocusedWorkspace({ document,
  onNavigate: (destination) => { events.push(['navigate', destination]); shell.update({ destination, inspectorTitle: destination === 'activity' ? 'Activity' : 'Project' }); },
  onTools: () => events.push(['tools']),
  onToggleNavigation: () => { events.push(['toggle']); shell.update({ navCollapsed: shell.element.dataset.navCollapsed !== 'true' }); },
  onSessionMenu: () => events.push(['session']),
  onProjectMenu: () => events.push(['project']),
  onInspectorSelect: id => { events.push(['inspector', id]); shell.update({ inspector: id }); },
  onInspectorClose: () => { events.push(['close']); shell.update({ destination: 'conversation', inspectorOpen: false }); },
  onConversation: () => { events.push(['conversation']); shell.update({ destination: 'conversation', inspectorOpen: false }); },
});
window.detachedBeforeMount = !shell.element.isConnected;
window.host = createViewHost({ document });
document.body.append(shell.element);
for (const [slot, id] of Object.entries({ navigation: 'roster', conversation: 'canonicalConversation', home: 'homeView', settings: 'settingsView', inspector: 'inspectorView', runControls: 'runView' })) {
  host.move(document.getElementById(id), shell.slots[slot]);
}
shell.update({ title: 'Compact workspace', context: 'npm-packages / design', attentionCount: 2 });
window.actionClicks = 0;
document.getElementById('canonicalAction').addEventListener('click', () => window.actionClicks++);
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route('http://workspace.test/**', async (route) => {
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

test('construction is detached with stable default slots and atomic destination validation', async ({ page }) => {
  const result = await page.evaluate(() => {
    const other = createFocusedWorkspace({ document });
    const original = other.element;
    const initial = { ...other.element.dataset };
    const names = Object.keys(other.slots);
    let error;
    try { other.update({ destination: 'unknown', title: 'must not apply' }); } catch (caught) { error = caught.name; }
    const unchanged = other.element === original && other.element.querySelector('.focused-title').textContent === '';
    other.dispose();
    return { detached: detachedBeforeMount && !other.element.isConnected, names, initial, error, unchanged };
  });
  expect(result).toEqual({ detached: true, names: ['navigation', 'conversation', 'home', 'settings', 'inspector', 'runControls'], initial: { destination: 'conversation', navigation: 'left', navCollapsed: 'false' }, error: 'TypeError', unchanged: true });
  await expect(page.locator('.focused-inspector')).toBeHidden();
  await expect(page.locator('.focused-run-controls')).toBeVisible();
});

test('keyboard controls route only their callback and show the selected destination', async ({ page }) => {
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  await rail.getByRole('button', { name: 'Home', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#homeView')).toBeVisible();
  await expect(page.locator('#canonicalConversation')).toBeHidden();
  await expect(page.locator('.focused-run-controls')).toBeVisible();
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).press('Space');
  await rail.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.locator('#canonicalConversation')).toBeVisible();
  await expect(page.locator('.focused-inspector')).toBeVisible();
  await expect(rail.getByRole('button', { name: 'Project', exact: true })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Close inspector', exact: true }).click();
  await expect(page.locator('.focused-inspector')).toBeHidden();
  await rail.getByRole('button', { name: /Activity, 2 items/ }).click();
  await expect(page.locator('#focusedWorkspaceInspectorTitle')).toHaveText('Activity');
  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#settingsView')).toBeVisible();
  await expect(page.locator('.focused-inspector')).toBeHidden();
  await page.getByRole('button', { name: 'Stop fixture run' }).click();
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await rail.getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.locator('.focused-header').getByRole('button', { name: 'All tools', exact: true }).click();
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  await page.getByRole('button', { name: 'Project actions', exact: true }).click();
  expect(await page.evaluate(() => events)).toEqual([
    ['navigate', 'home'], ['conversation'], ['navigate', 'project'], ['close'],
    ['navigate', 'activity'], ['navigate', 'settings'], ['conversation'], ['navigate', 'conversation'],
    ['tools'], ['session'], ['project'],
  ]);
});

test('left, top and collapsed layouts use one roster without changing children or focus', async ({ page }) => {
  await page.locator('#sessionSearch').fill('retained search');
  const result = await page.evaluate(() => {
    const slots = { ...shell.slots };
    const nodes = Object.values(slots).map((slot) => [...slot.childNodes]);
    const search = document.getElementById('sessionSearch');
    search.focus();
    search.setSelectionRange(2, 9, 'backward');
    const mutations = [];
    const observer = new MutationObserver((records) => mutations.push(...records));
    for (const slot of Object.values(slots)) {
      for (const child of slot.children) observer.observe(child, { subtree: true, childList: true, attributes: true, characterData: true });
    }
    const states = [];
    for (const navigation of ['top', 'left', 'top', 'left']) {
      shell.update({ navigation, title: 'Updated title', inspectorWidth: 500 });
      states.push([document.activeElement === search, search.selectionStart, search.selectionEnd, search.selectionDirection]);
    }
    mutations.push(...observer.takeRecords());
    observer.disconnect();
    return { states, same: Object.entries(slots).every(([name, slot], index) => shell.slots[name] === slot && [...slot.childNodes].every((child, childIndex) => child === nodes[index][childIndex]) && slot.childNodes.length === nodes[index].length), mutations: mutations.length, value: search.value };
  });
  expect(result).toEqual({ states: Array(4).fill([true, 2, 9, 'backward']), same: true, mutations: 0, value: 'retained search' });
  await expect(page.locator('#roster')).toHaveCount(1);
  await page.getByRole('button', { name: 'Collapse sessions', exact: true }).click();
  await expect(page.locator('#roster')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Expand sessions', exact: true })).toBeVisible();
  await page.evaluate(() => shell.update({ navigation: 'top' }));
  await page.getByRole('button', { name: 'Expand sessions', exact: true }).click();
  await expect(page.locator('#roster')).toBeVisible();
  expect(await page.locator('#sessionSearch').inputValue()).toBe('retained search');
  const boxes = await page.evaluate(() => {
    const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
    return { nav: box('.focused-navigation'), header: box('.focused-header'), body: box('.focused-body') };
  });
  expect(boxes.nav.x).toBe(46);
  expect(boxes.nav.y).toBe(boxes.header.bottom);
  expect(boxes.body.y).toBe(boxes.nav.bottom);
});

test('destination and inspector switches retain dirty fields, selection, listeners and transcript range', async ({ page }) => {
  const result = await page.evaluate(() => {
    const draft = document.getElementById('draft');
    const editor = document.getElementById('editor');
    const settings = document.getElementById('settingsDraft');
    draft.value = 'Unsent prompt with a selected phrase';
    draft.focus();
    draft.setSelectionRange(7, 20, 'backward');
    editor.value = 'Unsaved editor changes';
    editor.setSelectionRange(2, 8, 'forward');
    settings.value = 'Uncommitted setting';
    for (const destination of ['project', 'activity', 'settings', 'home', 'conversation']) {
      shell.update({ destination, inspectorOpen: false, navigation: 'top' });
    }
    const focused = document.activeElement === draft;
    const selection = [draft.selectionStart, draft.selectionEnd, draft.selectionDirection];
    const text = document.getElementById('selectedText').firstChild;
    document.getSelection().setBaseAndExtent(text, 4, text, 24);
    shell.update({ title: 'A safe title', inspectorOpen: true, inspectorTitle: 'Project', navigation: 'left' });
    const range = document.getSelection().toString();
    document.getElementById('canonicalAction').click();
    return { focused, selection, draft: draft.value, editor: editor.value, editorSelection: [editor.selectionStart, editor.selectionEnd], settings: settings.value, range, clicks: actionClicks };
  });
  expect(result).toEqual({ focused: true, selection: [7, 20, 'backward'], draft: 'Unsent prompt with a selected phrase', editor: 'Unsaved editor changes', editorSelection: [2, 8], settings: 'Uncommitted setting', range: 'conversation stays m', clicks: 1 });
});

test('inspector bounds, safe labels and disposal preserve parent-owned views', async ({ page }) => {
  const result = await page.evaluate(() => {
    const label = '<img src=x onerror="window.injected=true">';
    shell.update({ destination: 'project', title: label, context: label, inspectorTitle: label, inspectorWidth: 900, attentionCount: 123 });
    const maximum = shell.element.style.getPropertyValue('--focused-inspector-width');
    shell.update({ inspectorWidth: 10 });
    const minimum = shell.element.style.getPropertyValue('--focused-inspector-width');
    shell.update({ inspectorWidth: Number.NaN });
    const fallback = shell.element.style.getPropertyValue('--focused-inspector-width');
    const safe = !shell.element.querySelector('img') && !window.injected;
    const title = shell.element.querySelector('.focused-title').textContent;
    const badge = shell.element.querySelector('.focused-attention').textContent;
    const children = Object.values(shell.slots).map((slot) => slot.firstChild);
    host.restoreAll();
    const eventsBefore = events.length;
    shell.dispose();
    shell.dispose();
    shell.element.querySelectorAll('button').forEach((button) => button.click());
    shell.update({ destination: 'home' });
    return { maximum, minimum, fallback, safe, title, badge, callbackCount: events.length - eventsBefore, destination: shell.element.dataset.destination, restored: children.every((child) => child.parentElement.id === 'original'), connected: shell.element.isConnected };
  });
  expect(result).toEqual({ maximum: '640px', minimum: '240px', fallback: '320px', safe: true, title: '<img src=x onerror="window.injected=true">', badge: '99+', callbackCount: 0, destination: 'project', restored: true, connected: true });
});

test('real navigation clicks restore the latest field focus and selection on return', async ({ page }) => {
  await page.locator('#draft').fill('An unfinished prompt for the same session');
  await page.locator('#draft').evaluate((draft) => draft.setSelectionRange(3, 18, 'backward'));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#settingsView')).toBeVisible();
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  await expect(page.locator('#draft')).toBeFocused();
  expect(await page.locator('#draft').evaluate((draft) => [draft.selectionStart, draft.selectionEnd, draft.selectionDirection])).toEqual([3, 18, 'backward']);
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await page.locator('#editor').fill('Unsaved work in the project inspector');
  await page.locator('#editor').evaluate((editor) => editor.setSelectionRange(1, 12, 'forward'));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Project', exact: true }).click();
  await expect(page.locator('#editor')).toBeFocused();
  expect(await page.locator('#editor').evaluate((editor) => [editor.selectionStart, editor.selectionEnd, editor.selectionDirection])).toEqual([1, 12, 'forward']);
  await page.locator('#sessionSearch').fill('persistent roster search');
  await page.getByRole('button', { name: 'Collapse sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Expand sessions', exact: true }).click();
  await expect(page.locator('#sessionSearch')).toBeFocused();
});

for (const width of [1100, 1440, 1920]) {
  test(`desktop ${width}px keeps rail, roster, header, inspector and feature controls usable`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => shell.update({ destination: 'project', inspectorTitle: 'Project', inspectorWidth: 320 }));
    const geometry = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { rail: box('.focused-rail'), nav: box('.focused-navigation'), header: box('.focused-header'), inspector: box('.focused-inspector'), conversation: box('.focused-conversation'), attach: box('#attach'), run: box('#abort'), overflow: document.documentElement.scrollWidth > innerWidth };
    });
    expect(geometry.rail.width).toBe(46);
    expect(geometry.nav.width).toBe(202);
    expect(geometry.header.height).toBe(47);
    expect(geometry.inspector.width).toBe(320);
    expect(geometry.conversation.width).toBeGreaterThan(480);
    expect(geometry.overflow).toBe(false);
    for (const control of [geometry.attach, geometry.run]) {
      expect(control.x).toBeGreaterThanOrEqual(0);
      expect(control.right).toBeLessThanOrEqual(width);
      expect(control.bottom).toBeLessThanOrEqual(900);
    }
    await expect(page.getByRole('button', { name: 'Attach files', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'More composer actions' })).toBeVisible();
    const screenshot = testInfo.outputPath(`workspace-dark-${width}.png`);
    await page.screenshot({ path: screenshot });
    await testInfo.attach('desktop dark tokens', { path: screenshot, contentType: 'image/png' });
    await page.evaluate(() => shell.update({ inspectorWidth: 640 }));
    const bounded = await page.locator('.focused-conversation').boundingBox();
    expect(bounded.width).toBeGreaterThan(440);
    await page.evaluate(() => shell.update({ navigation: 'top', navCollapsed: true }));
    await expect(page.getByRole('button', { name: 'Stop fixture run' })).toBeVisible();
    await page.getByRole('button', { name: 'Expand sessions' }).click();
    await expect(page.locator('#roster')).toBeVisible();
  });
}

test('light tokens and Settings retain visible run controls and keyboard focus', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    const tokens = {
      '--theme-color-scheme': 'light', '--bg': '#eff1f5', '--panel': '#eff1f5', '--panel-2': '#ccd0da', '--panel-3': '#e6e9ef',
      '--text': '#4c4f69', '--muted': '#5c5f77', '--accent': '#8839ef', '--border': '#bcc0cc', '--danger': '#d20f39', '--warning': '#df8e1d',
      '--ctp-text': '#4c4f69', '--ctp-subtext': '#5c5f77', '--ctp-overlay': '#8c8fa1', '--ctp-base': '#eff1f5', '--ctp-mantle': '#e6e9ef', '--ctp-crust': '#dce0e8',
      '--ctp-mauve': '#8839ef', '--ctp-teal': '#179299', '--ctp-pink': '#ea76cb', '--ctp-red': '#d20f39',
      '--ctp-crust-rgb': '220, 224, 232', '--ctp-base-rgb': '239, 241, 245', '--ctp-surface-rgb': '204, 208, 218',
      '--ctp-mantle-rgb': '230, 233, 239', '--ctp-text-rgb': '76, 79, 105', '--ctp-subtext-rgb': '92, 95, 119',
    };
    for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    shell.update({ destination: 'settings' });
  });
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).focus();
  const outline = await page.getByRole('button', { name: 'Back to conversation', exact: true }).evaluate((button) => getComputedStyle(button).outlineWidth);
  expect(outline).toBe('2px');
  await expect(page.getByRole('button', { name: 'Stop fixture run' })).toBeVisible();
  await expect(page.locator('#settingsView')).toBeVisible();
  const screenshot = testInfo.outputPath('workspace-light-settings.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('light tokens Settings', { path: screenshot, contentType: 'image/png' });
  await page.keyboard.press('Enter');
  await expect(page.locator('#canonicalConversation')).toBeVisible();
  await expect(page.locator('#draft')).toHaveValue('Keep my unfinished prompt and selection.');
});


test('inspector topics retain canonical content and support manual keyboard selection', async ({ page }, testInfo) => {
  await page.evaluate(() => {
    shell.update({ destination: 'project', inspector: 'files', inspectorTitle: 'Project', inspectorTopics: [
      { id: 'files', label: 'Files' }, { id: 'git', label: 'Changes' },
      { id: 'runners', label: 'Runners', available: false, unavailableReason: 'Choose a session first' },
      { id: 'release', label: 'Release' },
    ] });
    window.originalEditor = document.querySelector('#editor');
  });
  const files = page.getByRole('tab', { name: 'Files', exact: true });
  const changes = page.getByRole('tab', { name: 'Changes', exact: true });
  await expect(files).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Files', exact: true }).locator('#editor')).toBeVisible();
  await files.focus();
  await page.keyboard.press('ArrowRight');
  await expect(changes).toBeFocused();
  await expect(files).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(changes).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Release', exact: true })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Runners', exact: true })).toBeDisabled();
  await expect(page.getByRole('tab', { name: 'Runners', exact: true })).toHaveAttribute('title', 'Choose a session first');
  expect(await page.evaluate(() => events.filter(event => event[0] === 'inspector'))).toEqual([['inspector', 'git']]);
  expect(await page.locator('#editor').evaluate(node => node === window.originalEditor)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('project-topics.png') });
});

test('inspector topic updates preserve buttons and remove obsolete keyboard targets', async ({ page }) => {
  await page.evaluate(() => {
    shell.update({ destination: 'activity', inspector: 'queue', inspectorTopics: [
      { id: 'subagents', label: 'Agents' }, { id: 'queue', label: 'Queues' }, { id: 'events', label: 'Events' },
    ] });
  });
  const queues = page.getByRole('tab', { name: 'Queues', exact: true });
  await queues.evaluate(node => { window.originalQueueTab = node; });
  await queues.focus();
  await page.evaluate(() => shell.update({ title: 'New status', inspectorTopics: [
    { id: 'subagents', label: 'Agents (2)' }, { id: 'queue', label: 'Queues' },
  ] }));
  await expect(queues).toBeFocused();
  expect(await queues.evaluate(node => node === window.originalQueueTab)).toBe(true);
  await expect(page.getByRole('tab', { name: 'Events', exact: true })).toHaveCount(0);
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'Agents (2)', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(queues).toBeFocused();
  await page.evaluate(() => shell.update({ inspectorTopics: [] }));
  await expect(page.getByRole('tablist', { name: 'Inspector topics' })).toBeHidden();
  await expect(page.locator('#editor')).toBeVisible();
});
