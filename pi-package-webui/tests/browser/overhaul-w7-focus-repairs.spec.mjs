import { readFile } from 'node:fs/promises';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', video: 'off', reducedMotion: 'reduce' });

const sources = new Map(await Promise.all(['shell-workspace.mjs', 'shell-navigation-resize.mjs', 'shell-inspector-resize.mjs', 'shell-workspace.css', 'styles.css'].map(async name => [
  `/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8'),
])));

async function enterByTab(page, target) {
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate(node => node === document.activeElement)) return;
  }
  throw new Error('Keyboard traversal did not reach the requested control.');
}

async function component(page) {
  await page.route('http://focus.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const source = sources.get(pathname);
    await route.fulfill({
      contentType: pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? `<!doctype html><html lang="en"><head><title>Workspace focus contract</title>
        <link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-workspace.css">
        </head><body><button id="outside">Caller-owned external control</button>
        <dialog id="native"><button id="nativeAction">Native dialog action</button></dialog>
        <script type="module">
          import { createFocusedWorkspace } from '/shell-workspace.mjs';
          window.shell = createFocusedWorkspace({ document,
            onNavigate: destination => shell.update({ destination }),
            onConversation: () => shell.update({ destination: 'conversation' }),
          });
          document.body.append(shell.element);
          const settingsEntry = document.createElement('button');
          settingsEntry.className = 'terminal-settings-button';
          settingsEntry.textContent = 'Settings';
          settingsEntry.addEventListener('click', () => shell.update({ destination: 'settings' }));
          shell.slots.navigation.append(settingsEntry);
          shell.slots.conversation.innerHTML = '<textarea id="draft" aria-label="Message Pi">Keep this selected draft</textarea><button id="action">Composer action</button><div id="scroll" style="height:80px;overflow:auto"><div style="height:600px">Persistent transcript</div></div>';
          shell.slots.settings.innerHTML = '<input id="setting" aria-label="Setting" value="Uncommitted setting">';
          window.originalDraft = document.getElementById('draft');
          document.getElementById('scroll').scrollTop = 120;
          window.ready = true;
        </script></body></html>`,
    });
  });
  await page.goto('http://focus.test/');
  await page.waitForFunction(() => window.ready);
}

const settings = page => page.getByRole('button', { name: 'Settings', exact: true });
const back = page => page.getByRole('button', { name: 'Back to conversation', exact: true }).filter({ visible: true });

test('Tab traversal to Settings preserves the originating composer field and canonical state', async ({ page }, info) => {
  await component(page);
  await page.locator('#draft').focus();
  await page.locator('#draft').evaluate(node => node.setSelectionRange(5, 9, 'backward'));
  await enterByTab(page, settings(page));
  await page.keyboard.press('Enter');
  await page.locator('#setting').fill('Keep this setting');
  await enterByTab(page, back(page));
  await page.keyboard.press('Enter');
  await expect(page.locator('#draft')).toBeFocused();
  expect(await page.locator('#draft').evaluate(node => ({
    same: node === window.originalDraft, selection: [node.selectionStart, node.selectionEnd, node.selectionDirection],
    scroll: document.getElementById('scroll').scrollTop,
  }))).toEqual({ same: true, selection: [5, 9, 'backward'], scroll: 120 });
  await expect(page.locator('#setting')).toHaveValue('Keep this setting');
  await page.screenshot({ path: info.outputPath('component-composer-return.png') });
});

for (const intent of ['pointer', 'caller']) {
  test(`${intent} focus after Tab traversal replaces the previous return target`, async ({ page }) => {
    await component(page);
    await page.locator('#draft').focus();
    await page.keyboard.press('Tab');
    if (intent === 'pointer') await page.locator('#action').click();
    else {
      await page.locator('#draft').focus();
      await page.locator('#action').focus();
    }
    await settings(page).click();
    await back(page).click();
    await expect(page.locator('#action')).toBeFocused();
  });
}

test('status updates during Tab traversal do not replace its return target', async ({ page }) => {
  await component(page);
  await page.locator('#draft').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#action')).toBeFocused();
  await page.evaluate(() => shell.update({ title: 'Running fixture' }));
  await enterByTab(page, settings(page));
  await page.keyboard.press('Enter');
  await enterByTab(page, back(page));
  await page.keyboard.press('Enter');
  await expect(page.locator('#draft')).toBeFocused();
});

test('a delayed feature focus redirect during Tab traversal preserves the keyboard return origin', async ({ page }) => {
  await component(page);
  await page.locator('#draft').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#action')).toBeFocused();
  await page.evaluate(() => {
    const search = document.createElement('input');
    search.id = 'redirectedSearch';
    search.tabIndex = -1;
    search.setAttribute('aria-label', 'Feature search');
    shell.slots.conversation.append(search);
    search.focus();
    shell.update({ title: 'Updated after feature focus' });
  });
  await expect(page.locator('#redirectedSearch')).toBeFocused();
  await enterByTab(page, settings(page));
  await page.keyboard.press('Enter');
  await enterByTab(page, back(page));
  await page.keyboard.press('Enter');
  await expect(page.locator('#draft')).toBeFocused();
});

test('keyboard activation of a feature control replaces the earlier Tab origin', async ({ page }) => {
  await component(page);
  await page.locator('#draft').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#action')).toBeFocused();
  await page.keyboard.press('Enter');
  await enterByTab(page, settings(page));
  await page.keyboard.press('Space');
  await enterByTab(page, back(page));
  await page.keyboard.press('Space');
  await expect(page.locator('#action')).toBeFocused();
});

test('native modal and caller-owned external focus keep precedence over workspace restoration', async ({ page }) => {
  await component(page);
  await page.locator('#draft').focus();
  await settings(page).click();
  await page.evaluate(() => {
    document.getElementById('native').showModal();
    shell.update({ destination: 'conversation' });
  });
  await expect(page.locator('#nativeAction')).toBeFocused();
  await page.evaluate(() => document.getElementById('native').close());
  await settings(page).click();
  await page.locator('#outside').focus();
  await page.evaluate(() => shell.update({ destination: 'conversation' }));
  await expect(page.locator('#outside')).toBeFocused();
});

test('workspace updates never attempt focus behind a native dialog in a canonical view', async ({ page }) => {
  await component(page);
  await page.locator('#draft').focus();
  await settings(page).click();
  expect(await page.evaluate(() => {
    const dialog = document.getElementById('native');
    shell.slots.settings.append(dialog);
    dialog.showModal();
    let attempts = 0;
    const focus = originalDraft.focus.bind(originalDraft);
    originalDraft.focus = options => { attempts += 1; focus(options); };
    shell.update({ destination: 'conversation' });
    return { attempts, modalOpen: dialog.open };
  })).toEqual({ attempts: 0, modalOpen: true });
});

test('disposing during keyboard navigation releases focus bookkeeping without removing canonical views', async ({ page }) => {
  await component(page);
  await page.locator('#draft').focus();
  await page.keyboard.press('Tab');
  await page.evaluate(() => { shell.dispose(); shell.dispose(); });
  await settings(page).click();
  await expect(page.locator('#draft')).toBeVisible();
  expect(await page.locator('#draft').evaluate(node => node === window.originalDraft)).toBe(true);
  await page.locator('#outside').focus();
  await page.evaluate(() => shell.update({ destination: 'settings' }));
  await expect(page.locator('#outside')).toBeFocused();
});

test('actual Settings keyboard return restores the selected composer draft', async ({ page, ownership }, info) => {
  await page.addInitScript(() => {
    localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' }));
    window.focusEvents = [];
    for (const type of ['keydown', 'keyup', 'focusin']) document.addEventListener(type, event => {
      window.focusEvents.push([type, event.key, event.target.id || event.target.className, event.target.getAttribute?.('aria-label')]);
    }, true);
  });
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#chat')).toContainText('fake answer');
  const prompt = page.locator('#promptInput');
  await prompt.fill('Keep this selected draft');
  await prompt.evaluate(node => { window.originalPrompt = node; node.setSelectionRange(5, 9, 'backward'); });
  await enterByTab(page, settings(page));
  await page.keyboard.press('Enter');
  await enterByTab(page, page.getByRole('searchbox', { name: 'Search settings', exact: true }));
  await page.keyboard.type('desktop');
  await page.keyboard.press('Escape');
  await enterByTab(page, back(page));
  await page.screenshot({ path: info.outputPath('actual-settings-keyboard-back.png'), animations: 'disabled' });
  await page.keyboard.press('Enter');
  await info.attach('keyboard-focus-events', { body: JSON.stringify(await page.evaluate(() => window.focusEvents), null, 2), contentType: 'application/json' });
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('Keep this selected draft');
  expect(await prompt.evaluate(node => ({ same: node === window.originalPrompt, selection: [node.selectionStart, node.selectionEnd, node.selectionDirection] })))
    .toEqual({ same: true, selection: [5, 9, 'backward'] });
  await page.screenshot({ path: info.outputPath('actual-settings-composer-return.png'), animations: 'disabled' });
});
