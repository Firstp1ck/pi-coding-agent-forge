import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

const publicFile = name => readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8');
const sources = new Map(await Promise.all([
  'styles.css', 'shell-workspace.css', 'focused-shell-adapter.css', 'focused-composer-disclosure.mjs',
].map(async name => [`/${name}`, await publicFile(name)])));
const index = await publicFile('index.html');
const composer = index.match(/<form id="composer"[\s\S]*?<\/form>/)?.[0];
if (!composer) throw new Error('Canonical composer markup was not found');
const app = await publicFile('app.js');

// Exercise the existing keyboard/submenu implementation without starting the application or Pi.
function canonicalFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  const end = app.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error(`Missing canonical function ${name}`);
  return app.slice(start, end + 2);
}
const canonicalOptions = [
  'optionsSubmenuGroups', 'optionsSubmenuTrigger', 'optionsSubmenuPanel', 'optionsSubmenuBackButton',
  'isOptionsSubmenuPanelItem', 'isVisibleOptionsMenuItem', 'optionsSubmenuActionItems',
  'optionsSubmenuHasVisibleActions', 'optionsSubmenuItems', 'optionsMenuRootItems', 'focusOptionsMenuItem',
  'optionsSubmenuUsesDrillIn', 'syncOptionsSubmenuAvailability', 'updateOptionsSubmenuPlacement',
  'setOptionsSubmenuOpen', 'closeOptionsSubmenus', 'moveOptionsMenuFocus', 'handleOptionsMenuKeydown',
  'handleOptionsSubmenuClick',
].map(canonicalFunction).join('\n');

const fixture = `<!doctype html><html lang="en" data-desktop-shell="focused"><head>
<meta charset="utf-8">
<title>Composer disclosure fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-workspace.css">
<link rel="stylesheet" href="/focused-shell-adapter.css">
<style>
#focusedWorkspace { grid-template-columns: 46px 202px minmax(0, 1fr); }
.fixture-header { grid-column: 3; grid-row: 1; padding: 12px; border-bottom: 1px solid var(--border); }
.fixture-rail { grid-row: 1 / -1; padding: 12px; }
.fixture-sessions { grid-column: 2; grid-row: 1 / -1; padding: 16px; background: var(--ctp-mantle); }
.fixture-overview { pointer-events: auto; padding: 24px; background: var(--ctp-surface); border-radius: 10px; }
#chat { padding: 24px; }
#statusBar { padding: 8px 16px; }
</style></head><body class="composer-action-grid-enabled mobile-composer-disclosure">
<div id="focusedWorkspace" data-navigation="left"><div class="fixture-rail">π</div>
<nav class="fixture-sessions" aria-label="Sessions">Composer layout<br><br>Release notes<br><br>Review tests</nav>
<header class="fixture-header">npm-packages / Composer layout</header>
<div class="focused-body"><div class="focused-conversation"><section class="chat-panel">
<div class="main-output-surface"><div id="chat" class="chat"><p>Keep the prompt and Send in place while choosing an action.</p></div></div>
<div class="footer-status-host"><div id="statusBar" class="statusbar">Fixture model · High · 14% context</div></div>
${composer}</section><div class="focused-overview-host"><div class="fixture-overview">Overview<br><br>Ready for your next request</div></div>
</div></div></div>
<dialog id="fixtureDialog"><form method="dialog"><p>Canonical Options dialog</p><button id="dialogClose">Close</button></form></dialog>
<script type="module">
import { createFocusedComposerDisclosure } from '/focused-composer-disclosure.mjs';
const byId = id => document.getElementById(id);
const trigger = byId('composerActionsButton');
const panel = byId('composerActionsPanel');
const optionsTrigger = byId('optionsMenuButton');
const optionsPanel = byId('optionsMenu');
const elements = { optionsMenu: optionsPanel, optionsMenuButton: optionsTrigger };
const OPTIONS_SUBMENU_GROUP_SELECTOR = '[data-options-submenu]';
const OPTIONS_SUBMENU_TRIGGER_SELECTOR = '[data-options-submenu-trigger]';
const OPTIONS_SUBMENU_PANEL_SELECTOR = '[data-options-submenu-panel]';
const OPTIONS_SUBMENU_BACK_SELECTOR = '[data-options-submenu-back]';
const OPTIONS_SUBMENU_LEFT_CLASS = 'opens-left';
const OPTIONS_SUBMENU_DRILL_IN_QUERY = '(hover: none), (pointer: coarse)';
let openOptionsSubmenuGroup = null;
let optionsSubmenuSyncing = false;
const isMobileView = () => false;
const scheduleOptionsMenuLabelFit = () => {};
const scheduleMobileDropdownScrollBoundsUpdate = () => {};
${canonicalOptions}
window.state = { enabled: true, open: false, optionsOpen: false };
window.identities = { trigger, panel, optionsTrigger, optionsPanel };
window.disclosure = createFocusedComposerDisclosure({ document, trigger, panel, optionsTrigger, optionsPanel });
window.sync = () => disclosure.update(state);
window.setOptions = open => {
  state.optionsOpen = open;
  optionsTrigger.setAttribute('aria-expanded', String(open));
  optionsTrigger.parentElement.classList.toggle('open', open);
  optionsTrigger.parentElement.classList.toggle('menu-dismissed', !open);
  if (!open) closeOptionsSubmenus();
  sync();
};
window.setMore = open => {
  state.open = open;
  document.body.classList.toggle('composer-actions-open', open);
  trigger.setAttribute('aria-expanded', String(open));
  panel.setAttribute('aria-hidden', String(!open));
  trigger.textContent = open ? '−' : 'More';
  trigger.setAttribute('aria-label', open ? 'Minimize more composer actions' : 'Show more composer actions');
  if (!open) setOptions(false);
  sync();
};
trigger.addEventListener('click', () => setMore(!state.open));
optionsTrigger.addEventListener('click', () => setOptions(true));
optionsTrigger.parentElement.addEventListener('pointerenter', () => setOptions(true));
optionsTrigger.parentElement.addEventListener('pointerleave', () => setOptions(false));
optionsTrigger.parentElement.addEventListener('focusin', () => setOptions(true));
optionsTrigger.addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  event.preventDefault();
  setOptions(true);
  const items = optionsMenuRootItems();
  focusOptionsMenuItem(event.key === 'ArrowDown' ? items[0] : items.at(-1));
});
optionsPanel.addEventListener('keydown', handleOptionsMenuKeydown);
optionsPanel.addEventListener('click', handleOptionsSubmenuClick);
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || event.defaultPrevented || byId('fixtureDialog').open) return;
  if (state.optionsOpen) { setOptions(false); optionsTrigger.focus(); }
  else if (state.open) { setMore(false); trigger.focus(); }
});
document.addEventListener('click', event => {
  if (state.optionsOpen && !optionsTrigger.parentElement.contains(event.target)) setOptions(false);
  if (state.open && !panel.contains(event.target) && event.target !== trigger) setMore(false);
});
byId('composer').addEventListener('submit', event => event.preventDefault());
byId('optionsSettingsButton').addEventListener('click', () => byId('fixtureDialog').showModal());
window.newActions = 0;
byId('newSessionButton').addEventListener('click', () => window.newActions++);
for (const id of ['steerButton', 'followUpButton']) panel.append(byId(id));
for (const node of panel.querySelectorAll('[data-composer-action-id]')) {
  node.style.setProperty('--composer-action-grid-column', '12');
  node.style.setProperty('--composer-action-grid-row', '8');
}
closeOptionsSubmenus();
syncOptionsSubmenuAvailability();
setMore(false);
byId('promptInput').value = 'Keep my unsent draft';
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route('http://composer.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const source = sources.get(pathname);
    await route.fulfill({
      status: source || pathname === '/' ? 200 : 404,
      contentType: pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? (pathname === '/' ? fixture : 'Not found'),
    });
  });
  await page.goto('http://composer.test/');
  await page.waitForFunction(() => window.ready);
});

const more = page => page.getByRole('button', { name: 'More composer actions', exact: true });
const geometry = page => page.evaluate(() => Object.fromEntries(
  ['promptInput', 'sendButton', 'chat', 'statusBar', 'composer'].map(id => {
    const { x, y, width, height } = document.getElementById(id).getBoundingClientRect();
    return [id, { x, y, width, height }];
  }),
));
async function fitInViewport(page, selector) {
  await expect.poll(async () => {
    const box = await page.locator(selector).boundingBox();
    const viewport = page.viewportSize();
    return box !== null && box.x >= 7.5 && box.y >= 7.5
      && box.x + box.width <= viewport.width - 7.5 && box.y + box.height <= viewport.height - 7.5;
  }).toBe(true);
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1100, height: 500 }]) {
  for (const theme of ['dark', 'light']) {
    test(`${viewport.width}×${viewport.height} ${theme}: floating actions preserve composer geometry`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      if (theme === 'light') await page.evaluate(() => {
        const tokens = {
          '--theme-color-scheme': 'light', '--bg': '#eff1f5', '--panel': '#eff1f5', '--text': '#4c4f69',
          '--muted': '#5c5f77', '--accent': '#8839ef', '--border': '#bcc0cc', '--ctp-base': '#eff1f5',
          '--ctp-mantle': '#e6e9ef', '--ctp-crust': '#dce0e8', '--ctp-text': '#4c4f69', '--ctp-surface': '#ccd0da',
          '--ctp-subtext': '#5c5f77', '--ctp-overlay': '#8c8fa1', '--ctp-peach': '#fe640b', '--ctp-yellow': '#df8e1d',
          '--ctp-mauve': '#8839ef', '--ctp-blue': '#1e66f5', '--ctp-teal': '#179299', '--ctp-sky': '#04a5e5',
          '--ctp-pink': '#ea76cb', '--ctp-red': '#d20f39', '--ctp-green': '#40a02b',
          '--ctp-text-rgb': '76, 79, 105', '--ctp-subtext-rgb': '92, 95, 119', '--ctp-mantle-rgb': '230, 233, 239',
          '--ctp-crust-rgb': '220, 224, 232', '--ctp-base-rgb': '239, 241, 245', '--ctp-surface-rgb': '204, 208, 218',
        };
        for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value);
      });
      await page.mouse.move(0, 0);
      const before = await geometry(page);
      await more(page).click();
      await page.mouse.move(0, 0);
      await expect(more(page)).toHaveAttribute('aria-expanded', 'true');
      expect(await geometry(page)).toEqual(before);
      const trigger = await more(page).boundingBox();
      const tray = await page.locator('#composerActionsPanel').boundingBox();
      expect(tray.x - trigger.x - trigger.width).toBeCloseTo(8, 0);
      await fitInViewport(page, '#composerActionsPanel');
      expect(await page.locator('#composerActionsPanel').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`composer-tray-${theme}-${viewport.width}.png`) });
      await page.getByRole('button', { name: 'New', exact: true }).click();
      expect(await page.evaluate(() => newActions)).toBe(1);
      const options = page.locator('#optionsMenuButton');
      await options.focus();
      await options.press('ArrowDown');
      await expect(page.locator('#optionsCommandPaletteButton')).toBeFocused();
      await fitInViewport(page, '#optionsMenu');
      const anchor = await options.boundingBox();
      const menu = await page.locator('#optionsMenu').boundingBox();
      expect(Math.abs(menu.y + menu.height - anchor.y)).toBeLessThan(1);
      expect(menu.x).toBeCloseTo(anchor.x, 0);
      expect(await geometry(page)).toEqual(before);
      await page.screenshot({ path: info.outputPath(`composer-${theme}-${viewport.width}.png`) });
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await page.mouse.move(0, 0);
      await expect(page.locator('#composerActionsPanel')).toBeHidden();
      expect(await geometry(page)).toEqual(before);
      await expect(page.locator('#promptInput')).toHaveValue('Keep my unsent draft');
    });
  }
}

test('pointer transit, nested keyboard navigation and dialog focus keep canonical controls', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await more(page).press('Enter');
  await page.locator('#optionsMenuButton').hover();
  const anchor = await page.locator('#optionsMenuButton').boundingBox();
  const menu = await page.locator('#optionsMenu').boundingBox();
  await page.mouse.move(anchor.x + anchor.width / 2, menu.y + menu.height - 4, { steps: 10 });
  await expect(page.locator('#optionsMenuButton')).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await expect(page.locator('#fixtureDialog')).toBeVisible();
  await expect(page.locator('#dialogClose')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#optionsMenuButton')).not.toBeFocused();
  await expect(more(page)).not.toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#dialogClose')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#fixtureDialog')).toBeHidden();
  await page.locator('#optionsMenuButton').focus();
  await page.locator('#optionsMenuButton').press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#optionsSessionSubmenuButton')).toBeFocused();
  const before = await page.locator('#optionsMenu').boundingBox();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#optionsResumeButton')).toBeFocused();
  await expect.poll(async () => (await page.locator('#optionsMenu').boundingBox()).height).toBeGreaterThan(before.height);
  await fitInViewport(page, '#optionsMenu');
  await page.keyboard.press('Escape');
  await expect(page.locator('#optionsSessionSubmenuButton')).toBeFocused();
  await expect(page.locator('#optionsMenuButton')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#optionsSessionSubmenu')).toBeHidden();
  const sameNodes = await page.evaluate(() => Object.entries(identities).every(([key, value]) =>
    document.getElementById({ trigger: 'composerActionsButton', panel: 'composerActionsPanel', optionsTrigger: 'optionsMenuButton', optionsPanel: 'optionsMenu' }[key]) === value));
  expect(sameNodes).toBe(true);
});

test('other secondary menus stay reachable inside the bounded tray', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await more(page).click();
  await page.evaluate(() => {
    const trigger = document.getElementById('nativeCommandMenuButton');
    trigger.parentElement.hidden = false;
    trigger.parentElement.classList.add('open');
    window.skillClicks = 0;
    document.getElementById('nativeSkillsButton').addEventListener('click', () => window.skillClicks++);
  });
  await page.getByRole('menuitem', { name: 'Skills Setup', exact: true }).click();
  expect(await page.evaluate(() => skillClicks)).toBe(1);
  await fitInViewport(page, '#composerActionsPanel');
  expect(await page.locator('#composerActionsPanel').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
});

test('a narrow conversation keeps Send outside the tray and Options in the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await page.locator('.focused-conversation').evaluate(node => { node.style.maxWidth = '360px'; });
  await page.mouse.move(0, 0);
  const before = await geometry(page);
  await more(page).click();
  await page.mouse.move(0, 0);
  const tray = await page.locator('#composerActionsPanel').boundingBox();
  const send = await page.locator('#sendButton').boundingBox();
  expect(tray.x + tray.width).toBeLessThanOrEqual(send.x - 7.5);
  expect(await geometry(page)).toEqual(before);
  expect(await page.locator('#composerActionsPanel').evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await page.locator('#sendButton').click({ trial: true });
  await page.locator('#optionsMenuButton').focus();
  await page.locator('#optionsMenuButton').press('ArrowDown');
  await expect(page.locator('#optionsCommandPaletteButton')).toBeFocused();
  await fitInViewport(page, '#optionsMenu');
});

test('presentation updates preserve owner visibility, hidden menus and accessible names', async ({ page }) => {
  await more(page).click();
  await page.evaluate(() => {
    const trigger = document.getElementById('composerActionsButton');
    trigger.textContent = '−';
    trigger.setAttribute('aria-label', 'Minimize more composer actions');
    sync();
  });
  await expect(more(page)).toHaveText('More');
  await expect(page.locator('#composerActionsPanel')).toBeVisible();
  await expect(page.locator('#optionsMenu')).toBeHidden();
  expect(await page.locator('#optionsMenu').evaluate(node => node.style.length)).toBe(0);
  await page.evaluate(() => {
    const options = document.getElementById('optionsMenu');
    options.hidden = true;
    setOptions(true);
  });
  await expect(page.locator('#optionsMenu')).toBeHidden();
  await expect(page.locator('#optionsMenuButton')).toHaveAttribute('aria-expanded', 'true');
  await page.evaluate(() => {
    document.getElementById('composerActionsPanel').hidden = true;
    sync();
  });
  await expect(page.locator('#composerActionsPanel')).toBeHidden();
  await expect(more(page)).toHaveAttribute('aria-expanded', 'true');
});

test('open overlays follow resize, scroll and content changes, then Classic and dispose clean up', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await more(page).click();
  await page.locator('#optionsMenuButton').focus();
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    const conversation = document.querySelector('.focused-conversation');
    conversation.style.maxWidth = '680px';
  });
  await expect.poll(async () => {
    const menu = await page.locator('#optionsMenu').boundingBox();
    const anchor = await page.locator('#optionsMenuButton').boundingBox();
    return Math.abs(menu.x - anchor.x);
  }).toBeLessThan(1);
  await page.setViewportSize({ width: 1100, height: 500 });
  await fitInViewport(page, '#optionsMenu');
  await page.evaluate(() => {
    document.getElementById('composer').style.top = '-40px';
    document.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(async () => {
    const tray = await page.locator('#composerActionsPanel').boundingBox();
    const trigger = await more(page).boundingBox();
    return Math.abs(tray.y + tray.height - trigger.y - trigger.height);
  }).toBeLessThan(1);
  await page.evaluate(() => {
    document.getElementById('composer').style.removeProperty('top');
    const panel = document.getElementById('composerActionsPanel');
    for (let index = 0; index < 30; index++) {
      const button = document.createElement('button');
      button.textContent = 'Action ' + index;
      panel.append(button);
    }
  });
  await expect.poll(async () => (await page.locator('#composerActionsPanel').boundingBox()).height).toBeGreaterThan(150);
  await fitInViewport(page, '#composerActionsPanel');
  await page.evaluate(() => {
    document.documentElement.removeAttribute('data-desktop-shell');
    state.enabled = false;
    sync();
  });
  await expect(page.locator('#composerActionsButton')).not.toHaveAttribute('data-focused-disclosure');
  expect(await page.locator('#composerActionsPanel').evaluate(node => node.style.length)).toBe(0);
  expect(await page.locator('#optionsMenu').evaluate(node => node.style.length)).toBe(0);
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-desktop-shell', 'focused');
    state.enabled = true;
    sync();
  });
  await fitInViewport(page, '#composerActionsPanel');
  await page.evaluate(() => { disclosure.dispose(); disclosure.dispose(); });
  await page.setViewportSize({ width: 1200, height: 600 });
  await page.evaluate(() => {
    document.getElementById('composerActionsPanel').append(document.createElement('button'));
    document.dispatchEvent(new Event('scroll'));
    sync();
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.locator('#composerActionsPanel').evaluate(node => node.style.length)).toBe(0);
  expect(await page.locator('#optionsMenu').evaluate(node => node.style.length)).toBe(0);
  await expect(page.locator('#composerActionsButton')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#optionsMenuButton')).toHaveAttribute('aria-expanded', 'true');
});
