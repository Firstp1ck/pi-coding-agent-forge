import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

// These DOM fixtures need no video encoder or application server.
test.use({ video: 'off' });

if (process.env.PI_WEBUI_TEST_CHROMIUM) {
  test.use({ launchOptions: { executablePath: process.env.PI_WEBUI_TEST_CHROMIUM } });
}

const modules = new Map(await Promise.all(['shell-view-host.mjs', 'shell-surfaces.mjs'].map(async (name) => [
  `/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8'),
])));

const fixture = `<!doctype html><html lang="en"><head><title>Shell ownership contract</title>
<style>
body { margin: 16px; font: 16px sans-serif; }
.host { border: 1px solid #777; padding: 8px; margin: 8px 0; min-height: 40px; }
#scroller { width: 260px; height: 80px; overflow: auto; }
#long { width: 700px; height: 400px; }
textarea { display: block; width: 240px; height: 60px; }
</style></head><body>
<button id="trigger">Open drawer</button><button id="otherTrigger">Open other drawer</button>
<div id="original" class="host"><span id="before">Before</span><section id="view"><input id="input" value="original input"><textarea id="draft">line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8</textarea><p id="text">Select this persistent conversation text.</p><div id="scroller"><div id="long">Scrollable retained content</div></div><button id="action">Retained listener</button></section><section id="neighbor">Neighbor view</section><span id="after">After</span></div>
<div id="hostA" class="host"></div><div id="hostB" class="host"></div>
<div id="drawer" class="host" role="region" tabindex="2" aria-modal="false"><button id="first">First</button><button id="last">Last</button><button hidden>Hidden</button><div inert><button>Inert</button></div></div>
<div id="otherDrawer" class="host"></div><button id="outside">Outside</button>
<dialog id="native"><button id="nativeFirst">Native first</button><button id="nativeLast">Native last</button></dialog>
<script type="module">
import { createViewHost } from '/shell-view-host.mjs';
import { createSurfaceCoordinator } from '/shell-surfaces.mjs';
window.createViewHost = createViewHost;
window.createSurfaceCoordinator = createSurfaceCoordinator;
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.route('http://shell.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const source = modules.get(pathname);
    await route.fulfill({ status: source || pathname === '/' ? 200 : 404, contentType: source ? 'text/javascript' : 'text/html', body: source ?? fixture });
  });
  await page.goto('http://shell.test/');
  await page.waitForFunction(() => window.ready);
});

test('canonical moves keep the same nodes, listeners, dirty values and original ordering', async ({ page }, testInfo) => {
  const result = await page.evaluate(() => {
    const host = createViewHost({ document });
    const byId = (id) => document.getElementById(id);
    const view = byId('view');
    const neighbor = byId('neighbor');
    const input = byId('input');
    let clicks = 0;
    byId('action').addEventListener('click', () => { clicks += 1; });
    input.value = 'unsaved editor contents';
    // Move the later sibling first, then repeatedly transfer both views.
    host.move(neighbor, byId('hostB'));
    host.move(view, byId('hostA'));
    for (let index = 0; index < 5; index += 1) {
      host.move(view, byId('hostB'));
      host.move(view, byId('hostA'));
      host.move(view, byId('hostA'));
    }
    byId('action').click();
    host.restore(view);
    host.restore(view);
    host.restoreAll();
    const firstOrder = [...byId('original').children].map((node) => node.id);
    // A restore releases ownership, so a later move captures a new home.
    byId('hostB').append(view);
    host.move(view, byId('hostA'));
    host.restore(view);
    const releasedHome = view.parentElement.id;
    byId('original').insertBefore(view, neighbor);
    host.move(view, byId('hostA'));
    host.move(neighbor, byId('hostB'));
    host.dispose();
    host.dispose();
    host.move(view, byId('hostA'));
    byId('action').click();
    return {
      same: view === byId('view') && input === byId('input'), clicks, value: input.value,
      firstOrder, finalOrder: [...byId('original').children].map((node) => node.id), releasedHome,
    };
  });
  expect(result).toEqual({ same: true, clicks: 2, value: 'unsaved editor contents', firstOrder: ['before', 'view', 'neighbor', 'after'], finalOrder: ['before', 'view', 'neighbor', 'after'], releasedHome: 'hostB' });
  const screenshot = testInfo.outputPath('shell-ownership-fixture.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('canonical DOM fixture', { path: screenshot, contentType: 'image/png' });
});

test('restoring a view appends safely if its original next sibling was removed', async ({ page }) => {
  expect(await page.evaluate(() => {
    const host = createViewHost({ document });
    const view = document.getElementById('view');
    host.move(view, document.getElementById('hostA'));
    document.getElementById('neighbor').remove();
    host.restore(view);
    host.dispose();
    return [...document.getElementById('original').children].map((node) => node.id);
  })).toEqual(['before', 'after', 'view']);
});

test('visible moves and restores retain focus, input selection and nested/window scroll', async ({ page }) => {
  const result = await page.evaluate(() => {
    document.body.style.minHeight = '2200px';
    const view = document.getElementById('view');
    const draft = document.getElementById('draft');
    const input = document.getElementById('input');
    const scroller = document.getElementById('scroller');
    const host = createViewHost({ document });
    scroller.scrollTo(130, 160);
    draft.focus();
    draft.setSelectionRange(9, 26, 'backward');
    draft.scrollTop = 45;
    window.scrollTo(0, 100);
    const snapshot = () => ({ focus: document.activeElement.id, selection: [draft.selectionStart, draft.selectionEnd, draft.selectionDirection], textareaScroll: draft.scrollTop, scroll: [scroller.scrollLeft, scroller.scrollTop], window: window.scrollY });
    const before = snapshot();
    host.move(view, document.getElementById('hostA'));
    const moved = snapshot();
    host.move(view, document.getElementById('hostB'));
    host.restore(view);
    const restored = snapshot();
    input.focus({ preventScroll: true });
    input.setSelectionRange(2, 8, 'forward');
    host.move(view, document.getElementById('hostA'));
    const inputState = [document.activeElement.id, input.selectionStart, input.selectionEnd, input.selectionDirection];
    host.dispose();
    return { before, moved, restored, inputState };
  });
  expect(result.before).toEqual({ focus: 'draft', selection: [9, 26, 'backward'], textareaScroll: 45, scroll: [130, 160], window: 100 });
  expect(result.moved).toEqual(result.before);
  expect(result.restored).toEqual(result.before);
  expect(result.inputState).toEqual(['input', 2, 8, 'forward']);
});

test('document Range selection and direction survive repeated view transfers', async ({ page }) => {
  const result = await page.evaluate(() => {
    const host = createViewHost({ document });
    const view = document.getElementById('view');
    const text = document.getElementById('text').firstChild;
    const selection = document.getSelection();
    selection.setBaseAndExtent(text, 30, text, 7);
    const snapshot = () => ({ text: selection.toString(), same: selection.anchorNode === text && selection.focusNode === text, anchor: selection.anchorOffset, focus: selection.focusOffset, ranges: selection.rangeCount });
    const before = snapshot();
    host.move(view, document.getElementById('hostA'));
    const moved = snapshot();
    host.move(view, document.getElementById('hostB'));
    host.dispose();
    return { before, moved, restored: snapshot() };
  });
  expect(result.before).toEqual({ text: 'this persistent convers', same: true, anchor: 30, focus: 7, ranges: 1 });
  expect(result.moved).toEqual(result.before);
  expect(result.restored).toEqual(result.before);
});

for (const unavailable of ['hidden', 'inert', 'display-none', 'visibility-hidden', 'disconnected']) {
  test(`view restoration never focuses a ${unavailable} original host`, async ({ page }) => {
    expect(await page.evaluate((mode) => {
      const host = createViewHost({ document });
      const original = document.getElementById('original');
      const view = document.getElementById('view');
      const input = document.getElementById('input');
      host.move(view, document.getElementById('hostA'));
      input.focus();
      const calls = [];
      const focus = input.focus.bind(input);
      input.focus = (...args) => { calls.push('focus'); focus(...args); };
      if (mode === 'hidden') original.hidden = true;
      if (mode === 'inert') original.inert = true;
      if (mode === 'display-none') original.style.display = 'none';
      if (mode === 'visibility-hidden') original.style.visibility = 'hidden';
      if (mode === 'disconnected') original.remove();
      host.restore(view);
      host.dispose();
      return { calls, parent: view.parentElement === original, hidden: original.hidden, inert: original.inert };
    }, unavailable)).toEqual({ calls: [], parent: true, hidden: unavailable === 'hidden', inert: unavailable === 'inert' });
  });
}

test('drawer Tab and Shift+Tab wrap with the local fallback, including an empty drawer', async ({ page }) => {
  await page.evaluate(() => {
    window.coordinator = createSurfaceCoordinator({ document });
    coordinator.activate(document.getElementById('drawer'), document.getElementById('trigger'));
  });
  await page.locator('#last').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#first')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#last')).toBeFocused();
  await page.locator('#outside').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#first')).toBeFocused();
  await page.locator('#outside').focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#last')).toBeFocused();
  await page.evaluate(() => {
    coordinator.activate(document.getElementById('otherDrawer'), document.getElementById('otherTrigger'));
  });
  await page.keyboard.press('Tab');
  await expect(page.locator('#otherDrawer')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#otherDrawer')).toBeFocused();
  await page.evaluate(() => coordinator.dispose());
});

test('callbacks update without extra listeners and nested Escape precedes drawer close', async ({ page }) => {
  await page.evaluate(() => {
    window.calls = { oldClose: 0, close: 0, nested: 0, helper: 0, bubbledEscape: 0, adds: 0, removes: 0 };
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, listener, options) => { if (type === 'keydown') calls.adds += 1; add(type, listener, options); };
    document.removeEventListener = (type, listener, options) => { if (type === 'keydown') calls.removes += 1; remove(type, listener, options); };
    let nested = true;
    window.coordinator = createSurfaceCoordinator({ document,
      getFocusableElements: (surface) => { calls.helper += 1; return surface.querySelectorAll('button'); },
      onEscape: (surface) => {
        if (surface.id !== 'drawer' || !nested) return false;
        nested = false;
        calls.nested += 1;
        return true;
      },
    });
    window.addEventListener('keydown', (event) => { if (event.key === 'Escape') calls.bubbledEscape += 1; });
    const drawer = document.getElementById('drawer');
    coordinator.activate(drawer, document.getElementById('trigger'), { close: () => { calls.oldClose += 1; } });
    coordinator.activate(drawer, document.getElementById('otherTrigger'), { close: () => { calls.close += 1; coordinator.deactivate(drawer); } });
  });
  await page.locator('#last').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#first')).toBeFocused();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => calls)).toMatchObject({ oldClose: 0, close: 0, nested: 1, helper: 1, bubbledEscape: 0, adds: 1, removes: 0 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#otherTrigger')).toBeFocused();
  expect(await page.evaluate(() => calls)).toMatchObject({ oldClose: 0, close: 1, nested: 1, bubbledEscape: 1, adds: 1, removes: 1 });
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => calls.close)).toBe(1);
});

test('replacement and disposal restore exact prior attributes without closing resources or returning focus', async ({ page }) => {
  const result = await page.evaluate(() => {
    let closes = 0;
    const coordinator = createSurfaceCoordinator({ document });
    const drawer = document.getElementById('drawer');
    const other = document.getElementById('otherDrawer');
    const attributes = (node) => ['role', 'tabindex', 'aria-modal'].map((name) => node.getAttribute(name));
    const before = attributes(drawer);
    document.getElementById('last').focus();
    const focused = document.activeElement;
    coordinator.activate(drawer, document.getElementById('trigger'), { close: () => { closes += 1; } });
    const activated = attributes(drawer);
    coordinator.activate(other, document.getElementById('otherTrigger'), { close: () => { closes += 1; } });
    const replaced = attributes(drawer);
    coordinator.deactivate(drawer);
    const untouchedActive = attributes(other);
    coordinator.dispose();
    coordinator.dispose();
    coordinator.activate(drawer, document.getElementById('trigger'));
    const event = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    document.dispatchEvent(event);
    return { before, activated, replaced, untouchedActive, disposed: attributes(other), drawer: attributes(drawer), closes, sameFocus: document.activeElement === focused, trappedAfterDispose: event.defaultPrevented };
  });
  expect(result).toEqual({ before: ['region', '2', 'false'], activated: ['dialog', '-1', 'true'], replaced: ['region', '2', 'false'], untouchedActive: ['dialog', '-1', 'true'], disposed: [null, null, null], drawer: ['region', '2', 'false'], closes: 0, sameFocus: true, trappedAfterDispose: false });
});

test('repeated drawer switching owns at most one listener and removes it on disposal', async ({ page }) => {
  expect(await page.evaluate(() => {
    const listeners = new Set();
    const add = document.addEventListener.bind(document);
    const remove = document.removeEventListener.bind(document);
    let maximum = 0;
    let adds = 0;
    let removes = 0;
    document.addEventListener = (type, listener, options) => {
      if (type === 'keydown') {
        listeners.add(listener);
        adds += 1;
        maximum = Math.max(maximum, listeners.size);
      }
      add(type, listener, options);
    };
    document.removeEventListener = (type, listener, options) => {
      if (type === 'keydown') { listeners.delete(listener); removes += 1; }
      remove(type, listener, options);
    };
    const coordinator = createSurfaceCoordinator({ document });
    const drawer = document.getElementById('drawer');
    const other = document.getElementById('otherDrawer');
    const trigger = document.getElementById('trigger');
    for (let index = 0; index < 10; index += 1) {
      coordinator.activate(drawer, trigger);
      coordinator.activate(drawer, trigger);
      coordinator.activate(other, trigger);
      coordinator.deactivate(other, { restoreFocus: false });
    }
    coordinator.activate(drawer, trigger);
    coordinator.dispose();
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(event);
    return { maximum, live: listeners.size, adds, removes, prevented: event.defaultPrevented };
  })).toEqual({ maximum: 1, live: 0, adds: 21, removes: 21, prevented: false });
});

test('a previously consumed event does not invoke the drawer callbacks', async ({ page }) => {
  expect(await page.evaluate(() => {
    let calls = 0;
    const coordinator = createSurfaceCoordinator({ document, onEscape: () => { calls += 1; } });
    coordinator.activate(document.getElementById('drawer'), document.getElementById('trigger'), { close: () => { calls += 1; } });
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    document.dispatchEvent(event);
    coordinator.dispose();
    return calls;
  })).toBe(0);
});

test('native modal owns Tab and Escape while a drawer remains active', async ({ page }) => {
  await page.evaluate(() => {
    window.drawerCloses = 0;
    window.nestedEscapes = 0;
    window.coordinator = createSurfaceCoordinator({ document, onEscape: () => { nestedEscapes += 1; return false; } });
    coordinator.activate(document.getElementById('drawer'), document.getElementById('trigger'), { close: () => { drawerCloses += 1; } });
    document.getElementById('native').showModal();
  });
  await expect(page.locator('#nativeFirst')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#nativeLast')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#nativeFirst')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#native')).not.toBeVisible();
  expect(await page.evaluate(() => [drawerCloses, nestedEscapes])).toEqual([0, 0]);
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => [drawerCloses, nestedEscapes])).toEqual([1, 1]);
  await page.evaluate(() => coordinator.dispose());
});

for (const unavailable of ['hidden', 'inert', 'display-none', 'visibility-hidden', 'disconnected']) {
  test(`drawer focus return skips a ${unavailable} trigger`, async ({ page }) => {
    expect(await page.evaluate(async (mode) => {
      const coordinator = createSurfaceCoordinator({ document });
      const drawer = document.getElementById('drawer');
      const trigger = document.getElementById('trigger');
      coordinator.activate(drawer, trigger);
      document.getElementById('last').focus();
      const focused = document.activeElement;
      const calls = [];
      trigger.focus = () => { calls.push('focus'); };
      if (mode === 'hidden') trigger.hidden = true;
      if (mode === 'inert') document.body.inert = true;
      if (mode === 'display-none') trigger.style.display = 'none';
      if (mode === 'visibility-hidden') trigger.style.visibility = 'hidden';
      if (mode === 'disconnected') trigger.remove();
      coordinator.deactivate(drawer);
      await Promise.resolve();
      coordinator.dispose();
      return { calls, sameFocus: document.activeElement === focused };
    }, unavailable)).toEqual({ calls: [], sameFocus: true });
  });
}

test('new activation and disposal cancel queued focus return; restoreFocus false does not queue it', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const coordinator = createSurfaceCoordinator({ document });
    const drawer = document.getElementById('drawer');
    const trigger = document.getElementById('trigger');
    let returns = 0;
    trigger.focus = () => { returns += 1; };
    coordinator.activate(drawer, trigger);
    document.getElementById('last').focus();
    coordinator.deactivate(drawer);
    coordinator.activate(document.getElementById('otherDrawer'), trigger);
    await Promise.resolve();
    coordinator.deactivate(document.getElementById('otherDrawer'), { restoreFocus: false });
    await Promise.resolve();
    coordinator.activate(drawer, trigger);
    coordinator.deactivate(drawer);
    coordinator.dispose();
    await Promise.resolve();
    return returns;
  })).toBe(0);
});

test('deactivation cannot return focus behind a newly opened native modal', async ({ page }) => {
  expect(await page.evaluate(async () => {
    const coordinator = createSurfaceCoordinator({ document });
    const drawer = document.getElementById('drawer');
    coordinator.activate(drawer, document.getElementById('trigger'));
    coordinator.deactivate(drawer);
    document.getElementById('native').showModal();
    await Promise.resolve();
    const focused = document.activeElement.id;
    coordinator.dispose();
    return focused;
  })).toBe('nativeFirst');
});
