import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.use({ video: 'off', launchOptions: { executablePath: '/usr/bin/chromium' } });

const sources = new Map(await Promise.all([
  'settings-navigation-controller.mjs', 'settings-navigation.css', 'styles.css',
].map(async (name) => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Settings navigation fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/settings-navigation.css">
<style>
html,body{height:auto;min-height:100%;overflow:auto}body{padding:16px;background:var(--ctp-base)}
body::before,body::after{display:none}main{position:relative;max-width:960px;margin:auto}
h1{font-size:var(--text-xl);margin:0 0 16px}#native-row{display:grid;gap:8px;padding:12px;border:1px solid var(--border);border-radius:8px}
#native-row p{margin:0;color:var(--muted)}#native-row input{min-width:0;width:100%;padding:8px}
:root[data-fixture-theme="light"]{color-scheme:light;--ctp-base:#eff1f5;--ctp-mantle:#e6e9ef;--ctp-crust:#dce0e8;
--ctp-text:#4c4f69;--ctp-subtext:#5c5f77;--ctp-surface:#ccd0da;--text:#4c4f69;--muted:#5c5f77;
--accent:#8839ef;--accent-2:#179299;--border:#9ca0b0;--panel-2:#e6e9ef;--panel-3:#eff1f5}
</style></head><body><main><h1>Settings</h1><div id="host"></div></main>
<dialog aria-label="Native confirmation"><label>Confirmation note<input id="modal-note"></label><button id="modal-close">Close</button></dialog>
<script type="module">
import {createSettingsNavigator} from '/settings-navigation-controller.mjs';
window.categories=[['appearance','Appearance'],['resources','Models and resources'],['features','Features'],['accounts','Accounts'],
['voice','Voice'],['connection','Connection'],['system','System'],['help','Help']].map(([id,label])=>({id,label}));
window.entries=[
{id:'theme',category:'appearance',label:'Theme',description:'Choose Pi colors and appearance.',aliases:['palette','colors'],scopeLabel:'Browser',available:true,reason:''},
{id:'models',category:'resources',label:'Model selection',description:'Choose the model for this session.',aliases:['provider'],scopeLabel:'Session',available:true,reason:''},
{id:'voice',category:'voice',label:'Voice input',description:'Speak to Pi with your microphone.',aliases:['dictation','audio'],scopeLabel:'Browser',available:false,reason:'Voice companion is not configured.',setupActionId:'setup:voice'},
{id:'remote',category:'connection',label:'Remote access',description:'Connect to this server.',aliases:['network'],scopeLabel:'Server',available:false,reason:'Remote access is disabled on this server.'}
];
window.target={tabId:'source-tab',generation:3,lifetime:'source-life'};
window.calls=[];
window.navigatorController=createSettingsNavigator({document,
onNavigate(category,id,captured){calls.push({kind:'navigate',category,id,target:captured,sameTarget:captured===target});},
onInvoke(actionId,captured){calls.push({kind:'invoke',actionId,target:captured,sameTarget:captured===target});}});
host.append(navigatorController.element);
window.nativeRow=document.createElement('div');nativeRow.id='native-row';
const nativeLabel=document.createElement('label');nativeLabel.textContent='Theme name';
window.draft=document.createElement('input');draft.value='Keep my custom Pi theme';nativeLabel.append(draft);
const note=document.createElement('p');note.textContent='Your existing appearance controls stay here.';
nativeRow.append(nativeLabel,note);navigatorController.slots.content.append(nativeRow);
window.render=(patch={})=>{window.state={category:'appearance',categories,entries,target,...window.state,...patch};navigatorController.update(state);};
render();
document.getElementById('modal-close').onclick=()=>document.querySelector('dialog').close();
window.ready=true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  page.__settingsErrors = [];
  page.on('pageerror', (error) => page.__settingsErrors.push(error.message));
  await page.route('http://settings.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: fixture });
    const source = sources.get(pathname);
    if (source === undefined) throw new Error(`Unexpected fixture request: ${pathname}`);
    await route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: source });
  });
  await page.goto('http://settings.test/');
  await page.waitForFunction(() => window.ready);
});

test.afterEach(async ({ page }) => {
  expect(page.__settingsErrors).toEqual([]);
});

const search = (page) => page.getByRole('searchbox', { name: 'Search settings', exact: true });
const category = (page, name) => page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name, exact: true });
const results = (page) => page.getByRole('list', { name: 'Settings search results' });

test('mount and updates never dispatch; category navigation keeps the exact parent target', async ({ page }) => {
  await expect(category(page, 'Appearance')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Appearance', exact: true })).toBeVisible();
  expect(await page.evaluate(() => calls)).toEqual([]);
  await category(page, 'Accounts').click();
  expect(await page.evaluate(() => calls)).toEqual([{
    kind: 'navigate', category: 'accounts', id: null,
    target: { tabId: 'source-tab', generation: 3, lifetime: 'source-life' }, sameTarget: true,
  }]);
  await page.evaluate(() => render({ category: 'accounts' }));
  await expect(category(page, 'Accounts')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible();
  expect(await page.evaluate(() => calls.length)).toBe(1);
});

test('search trims and matches labels, descriptions and aliases across categories', async ({ page }) => {
  await search(page).fill('  PaLeTtE  ');
  await expect(results(page).getByRole('listitem')).toHaveCount(1);
  await results(page).getByRole('button').click();
  expect(await page.evaluate(() => calls[0])).toMatchObject({ category: 'appearance', id: 'theme', sameTarget: true });
  await search(page).fill('this session');
  await expect(results(page).getByRole('button')).toContainText('Model selection');
  await search(page).fill('model');
  await search(page).press('Enter');
  expect(await page.evaluate(() => calls[1])).toMatchObject({ category: 'resources', id: 'models', sameTarget: true });
  await search(page).fill('no such setting');
  await expect(page.getByRole('status')).toHaveText('No matching settings. Try another name or purpose.');
  await expect(results(page).getByRole('listitem')).toHaveCount(0);
  await search(page).press('Enter');
  expect(await page.evaluate(() => calls.length)).toBe(2);
});

test('caps queries and results with an honest count and a bounded scroll container', async ({ page }) => {
  await page.evaluate(() => render({ entries: Array.from({ length: 137 }, (_, i) => ({
    id: `entry-${i}`, category: 'system', label: `Setting ${i}`, description: 'Bounded fixture', aliases: [],
    scopeLabel: 'Global', available: true, reason: '',
  })) }));
  await search(page).fill('setting');
  await expect(results(page).getByRole('listitem')).toHaveCount(100);
  await expect(page.getByRole('status')).toHaveText('137 results. Showing the first 100; 37 more results. Refine your search.');
  expect(await results(page).evaluate((list) => list.scrollHeight > list.clientHeight && list.clientHeight <= 512)).toBe(true);
  await search(page).evaluate((input) => {
    input.value = 'x'.repeat(400);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(search(page)).toHaveValue('x'.repeat(256));
  await expect(search(page)).toHaveAttribute('maxlength', '256');
});

test('unavailable entries retain scope and reasons; only explicit Setup invokes', async ({ page }) => {
  await search(page).fill('audio');
  const voice = results(page).getByRole('listitem');
  await expect(voice.getByRole('button', { name: /Voice input Browser/ })).toBeDisabled();
  await expect(voice).toContainText('Voice companion is not configured.');
  await expect(voice).toContainText('Browser');
  await search(page).press('Enter');
  expect(await page.evaluate(() => calls)).toEqual([]);
  const reasonId = await voice.getByRole('button', { name: /Voice input Browser/ }).getAttribute('aria-describedby');
  await expect(page.locator(`[id="${reasonId}"]`)).toHaveText('Voice companion is not configured.');
  await voice.getByRole('button', { name: 'Setup Voice input', exact: true }).click();
  expect(await page.evaluate(() => calls)).toEqual([{
    kind: 'invoke', actionId: 'setup:voice', target: { tabId: 'source-tab', generation: 3, lifetime: 'source-life' }, sameTarget: true,
  }]);
  await search(page).fill('remote');
  await expect(results(page)).toContainText('Server');
  await expect(results(page)).toContainText('Remote access is disabled on this server.');
  await expect(results(page).getByRole('button', { name: /Setup/ })).toHaveCount(0);
  await search(page).press('Enter');
  expect(await page.evaluate(() => calls.length)).toBe(1);
});

test('ordinary updates preserve search, content typing, selection and keyed button identity', async ({ page }) => {
  await page.getByLabel('Theme name').focus();
  await page.evaluate(() => { draft.setSelectionRange(5, 12, 'backward'); render(); });
  expect(await page.evaluate(() => [document.activeElement === draft, draft.selectionStart, draft.selectionEnd, draft.selectionDirection,
    navigatorController.slots.content.firstChild === nativeRow])).toEqual([true, 5, 12, 'backward', true]);
  await search(page).fill('palette');
  await page.evaluate(() => {
    const input = document.querySelector('input[type="search"]');
    input.setSelectionRange(1, 4, 'backward');
    window.savedResult = document.querySelector('.settings-navigation-open');
    window.savedCategory = document.querySelector('.settings-navigation-category');
    for (let i = 0; i < 20; i++) render();
  });
  expect(await search(page).evaluate((input) => [document.activeElement === input, input.selectionStart, input.selectionEnd, input.selectionDirection])).toEqual([true, 1, 4, 'backward']);
  expect(await page.evaluate(() => savedResult === document.querySelector('.settings-navigation-open') &&
    savedCategory === document.querySelector('.settings-navigation-category') && nativeRow.parentNode === navigatorController.slots.content)).toBe(true);
  await results(page).getByRole('button').focus();
  await page.evaluate(() => render());
  await expect(results(page).getByRole('button')).toBeFocused();
  await page.evaluate(() => navigatorController.clearSearch());
  await expect(search(page)).toBeFocused();
  await expect(page.getByLabel('Theme name')).toHaveValue('Keep my custom Pi theme');
  expect(await page.evaluate(() => [draft.selectionStart, draft.selectionEnd])).toEqual([5, 12]);
  expect(await page.evaluate(() => calls)).toEqual([]);
});

test('keyed reordering and removed focus stay usable without replacing controls', async ({ page }) => {
  await category(page, 'Models and resources').focus();
  await page.evaluate(() => { window.saved = document.activeElement; render({ categories: [...categories].reverse() }); });
  expect(await page.evaluate(() => document.activeElement === saved)).toBe(true);
  await search(page).fill('pi');
  await results(page).getByRole('button', { name: /Theme Browser/ }).focus();
  await page.evaluate(() => { window.saved = document.activeElement; render({ entries: [...entries].reverse() }); });
  expect(await page.evaluate(() => document.activeElement === saved)).toBe(true);
  await page.evaluate(() => render({ entries: [] }));
  await expect(search(page)).toBeFocused();
});

test('old handlers cannot retarget changed entries, actions or parent lifetimes', async ({ page }) => {
  await search(page).fill('palette');
  await page.evaluate(() => {
    window.oldCategory = document.querySelector('.settings-navigation-category').onclick;
    window.oldResult = document.querySelector('.settings-navigation-open').onclick;
    window.target = { tabId: 'replacement', generation: 4, lifetime: 'replacement-life' };
    render({ target, entries: entries.map((entry) => entry.id === 'theme' ? { ...entry, category: 'system' } : entry) });
    oldCategory(); oldResult();
  });
  expect(await page.evaluate(() => calls)).toEqual([]);
  await results(page).getByRole('button').click();
  expect(await page.evaluate(() => calls[0])).toEqual({
    kind: 'navigate', category: 'system', id: 'theme',
    target: { tabId: 'replacement', generation: 4, lifetime: 'replacement-life' }, sameTarget: true,
  });
  await search(page).fill('audio');
  await page.evaluate(() => {
    window.oldSetup = document.querySelector('.settings-navigation-setup').onclick;
    render({ entries: entries.map((entry) => entry.id === 'voice' ? { ...entry, setupActionId: 'setup:replacement' } : entry) });
    oldSetup();
  });
  expect(await page.evaluate(() => calls.length)).toBe(1);
  await results(page).getByRole('button', { name: 'Setup Voice input', exact: true }).click();
  expect(await page.evaluate(() => calls[1])).toMatchObject({ kind: 'invoke', actionId: 'setup:replacement', sameTarget: true });
});

test('removed and hidden retained controls cannot dispatch, even when reattached', async ({ page }) => {
  await search(page).fill('palette');
  await page.evaluate(() => {
    const chrome = navigatorController.element;
    host.removeChild(chrome);
    document.activeElement?.blur();
    chrome.querySelector('.settings-navigation-open').click();
    chrome.querySelector('.settings-navigation-category').onclick();
    host.append(chrome);
    window.oldButton = document.querySelector('.settings-navigation-open'); window.oldClick = oldButton.onclick;
    window.oldCategoryNode = document.querySelector('.settings-navigation-category'); window.oldCategoryClick = oldCategoryNode.onclick;
    render({ entries: [], categories: [] });
    navigatorController.element.append(oldButton, oldCategoryNode);
    oldClick(); oldCategoryClick(); oldButton.click(); oldCategoryNode.click();
  });
  expect(await page.evaluate(() => calls)).toEqual([]);
  await page.evaluate(() => {
    oldButton.remove(); oldCategoryNode.remove(); render({ categories, entries });
    window.hiddenClick = document.querySelector('.settings-navigation-open').onclick;
    navigatorController.slots.content.hidden = true;
    navigatorController.element.hidden = true;
    hiddenClick();
    navigatorController.element.hidden = false;
    navigatorController.clearSearch(); hiddenClick();
  });
  expect(await page.evaluate(() => calls)).toEqual([]);
});

test('live availability, reasons and Setup updates retain keyed rows and correct focus', async ({ page }) => {
  await search(page).fill('audio');
  await results(page).getByRole('button', { name: 'Setup Voice input', exact: true }).focus();
  await page.evaluate(() => {
    window.rowBefore = document.querySelector('.settings-navigation-result');
    render({ entries: entries.map((entry) => entry.id === 'voice' ? { ...entry, reason: 'Microphone permission is missing.' } : entry) });
  });
  await expect(results(page)).toContainText('Microphone permission is missing.');
  await expect(results(page).getByRole('button', { name: 'Setup Voice input', exact: true })).toBeFocused();
  await page.evaluate(() => render({ entries: entries.map((entry) => ({ ...entry, available: true })) }));
  expect(await page.evaluate(() => rowBefore === document.querySelector('.settings-navigation-result'))).toBe(true);
  await expect(search(page)).toBeFocused();
  await expect(results(page).getByRole('button', { name: /Voice input Browser/ })).toBeEnabled();
  await expect(results(page)).not.toContainText('Microphone permission is missing.');
  await expect(results(page).getByRole('button', { name: 'Setup Voice input', exact: true })).toHaveCount(0);
});

test('keyboard supports categories and result actions while search keeps native caret keys', async ({ page }) => {
  await category(page, 'Appearance').focus();
  await page.keyboard.press('End');
  await expect(category(page, 'Help')).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(category(page, 'Models and resources')).toBeFocused();
  await page.keyboard.press('Enter');
  expect(await page.evaluate(() => calls[0].category)).toBe('resources');
  await search(page).fill('pi');
  await search(page).press('Home');
  await expect(search(page)).toBeFocused();
  await search(page).press('ArrowDown');
  await expect(results(page).getByRole('button', { name: /Theme Browser/ })).toBeFocused();
  await page.keyboard.press('End');
  await expect(results(page).getByRole('button', { name: 'Setup Voice input', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(results(page).getByRole('button', { name: /Theme Browser/ })).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(results(page).getByRole('button', { name: 'Setup Voice input', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search(page)).toHaveValue('');
  await expect(search(page)).toBeFocused();
  await expect(page.getByLabel('Theme name')).toBeVisible();
  await search(page).fill('pi');
  await search(page).press('ArrowUp');
  await expect(results(page).getByRole('button', { name: 'Setup Voice input', exact: true })).toBeFocused();
  expect(await page.evaluate(() => calls.length)).toBe(1);
});

test('Escape and arrow keys leave native modal keyboard ownership intact', async ({ page }) => {
  await search(page).fill('palette');
  await page.evaluate(() => document.querySelector('dialog').showModal());
  await page.getByLabel('Confirmation note').fill('keep this modal draft');
  expect(await search(page).evaluate((input) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(event); return event.defaultPrevented;
  })).toBe(false);
  await expect(search(page)).toHaveValue('palette');
  await page.getByLabel('Confirmation note').press('ArrowDown');
  await expect(page.getByLabel('Confirmation note')).toBeFocused();
  await page.getByLabel('Confirmation note').press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(search(page)).toHaveValue('palette');
  expect(await page.evaluate(() => calls)).toEqual([]);
});

test('safe text and instance-scoped labels cannot create markup or duplicate IDs', async ({ page }) => {
  await page.evaluate(async () => {
    const unsafe = '<img src=x onerror="window.injected=true">';
    render({ categories: [{ id: 'appearance', label: unsafe }], entries: [{ id: 'unsafe', category: 'appearance',
      label: unsafe, description: unsafe, aliases: ['unsafe'], scopeLabel: unsafe, available: false, reason: unsafe, setupActionId: 'setup:unsafe' }] });
    const { createSettingsNavigator } = await import('/settings-navigation-controller.mjs');
    window.second = createSettingsNavigator({ document, onNavigate() {}, onInvoke() {} });
    host.append(second.element); second.update(state);
  });
  await search(page).first().fill('unsafe');
  await expect(page.locator('.settings-navigation img')).toHaveCount(0);
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  expect(await page.evaluate(() => {
    const ids = [...document.querySelectorAll('[id]')].map((node) => node.id);
    return ids.length === new Set(ids).size && [...document.querySelectorAll('.settings-navigation label')]
      .every((label) => label.control?.closest('.settings-navigation') === label.closest('.settings-navigation'));
  })).toBe(true);
  await expect(page.locator('.settings-navigation-reason').first()).toHaveText('<img src=x onerror="window.injected=true">');
  await page.evaluate(() => second.dispose());
});

test('clear and disposal preserve caller nodes and resources and silence retained handlers', async ({ page }) => {
  await search(page).fill('audio');
  await page.getByRole('button', { name: 'Clear settings search', exact: true }).click();
  await expect(search(page)).toHaveValue('');
  await expect(search(page)).toBeFocused();
  await expect(page.getByLabel('Theme name')).toBeVisible();
  await search(page).fill('palette');
  await page.evaluate(() => {
    window.oldSearch = document.querySelector('input[type="search"]');
    window.oldKeyHandlerEvent = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    window.oldAction = document.querySelector('.settings-navigation-open').onclick;
    window.oldCategory = document.querySelector('.settings-navigation-category').onclick;
    window.nativeClicks = 0; nativeRow.addEventListener('click', () => nativeClicks++);
    navigatorController.clearSearch(); navigatorController.clearSearch();
  });
  await expect(search(page)).toHaveValue('');
  await expect(page.getByLabel('Theme name')).toBeVisible();
  expect(await page.evaluate(() => calls)).toEqual([]);
  await page.evaluate(() => {
    navigatorController.dispose(); navigatorController.dispose();
    oldAction(); oldCategory(); render(); navigatorController.clearSearch();
    oldSearch.value = 'ignored'; oldSearch.dispatchEvent(new Event('input', { bubbles: true }));
    navigatorController.element.dispatchEvent(oldKeyHandlerEvent);
    host.append(navigatorController.slots.content);
    nativeRow.click();
  });
  await expect(page.getByLabel('Theme name')).toHaveValue('Keep my custom Pi theme');
  expect(await page.evaluate(() => ({ calls, nativeClicks, same: nativeRow.parentNode === navigatorController.slots.content,
    chromeChildren: navigatorController.element.childElementCount, keyPrevented: oldKeyHandlerEvent.defaultPrevented })))
    .toEqual({ calls: [], nativeClicks: 1, same: true, chromeChildren: 0, keyPrevented: false });
});

for (const theme of ['dark', 'light']) {
  for (const width of [390, 1200]) {
    test(`${theme} ${width}px compact fixture fits content and unavailable search`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate((theme) => { document.documentElement.dataset.fixtureTheme = theme; }, theme);
      await expect(page.getByLabel('Theme name')).toBeVisible();
      const positions = await page.evaluate(() => {
        const nav = document.querySelector('.settings-navigation-categories').getBoundingClientRect();
        const main = document.querySelector('.settings-navigation-main').getBoundingClientRect();
        return { nav: { right: nav.right, bottom: nav.bottom }, main: { x: main.x, y: main.y } };
      });
      if (width > 640) expect(positions.main.x).toBeGreaterThan(positions.nav.right);
      else expect(positions.main.y).toBeGreaterThan(positions.nav.bottom);
      if ((theme === 'dark' && width === 1200) || (theme === 'light' && width === 390)) {
        await page.screenshot({ path: testInfo.outputPath(`settings-content-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      }
      await search(page).fill('pi');
      await expect(results(page)).toContainText('Voice companion is not configured.');
      await expect(results(page).getByRole('button', { name: 'Setup Voice input', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      for (const control of await page.locator('.settings-navigation button:visible, .settings-navigation input:visible').all()) {
        const bounds = await control.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      }
      await page.screenshot({ path: testInfo.outputPath(`settings-search-${theme}-${width}.png`), fullPage: true, animations: 'disabled' });
      const accessibility = await new AxeBuilder({ page }).include('.settings-navigation').analyze();
      expect(accessibility.violations).toEqual([]);
    });
  }
}
