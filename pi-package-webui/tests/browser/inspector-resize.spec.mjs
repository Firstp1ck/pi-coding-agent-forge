import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test.use({ video: 'off' });
const sources = new Map(await Promise.all([
  'shell-workspace.mjs', 'shell-navigation-resize.mjs', 'shell-inspector-resize.mjs',
  'shell-workspace.css', 'focused-shell-adapter.css', 'styles.css',
].map(async name => [`/${name}`, await readFile(new URL(`../../public/${name}`, import.meta.url), 'utf8')])));

const fixture = `<!doctype html><html lang="en"><head><title>Inspector resize fixture</title>
<link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/shell-workspace.css">
<link rel="stylesheet" href="/focused-shell-adapter.css">
<style>body { height: 100vh; } .fixture-content { padding: 20px; }
textarea { width: 100%; } .fixture-run { display: flex; gap: 4px; }</style></head><body>
<script type="module">
import { createFocusedWorkspace } from '/shell-workspace.mjs';
window.commits = [];
window.failCommit = false;
window.snapshot = { destination: 'project', inspectorOpen: true, inspectorWidth: 320,
  title: 'Keep conversation space usable', context: 'Disposable component fixture', attentionCount: 2, finishedCount: 3 };
window.apply = patch => { Object.assign(snapshot, patch); shell.update(snapshot); };
window.shell = createFocusedWorkspace({ document,
  onInspectorResize: value => {
    commits.push(value);
    if (failCommit) return false;
    localStorage.setItem('fixture-inspector-width', String(value));
    apply({ inspectorWidth: value });
  },
  onInspectorClose: () => apply({ destination: 'conversation', inspectorOpen: false }),
});
document.body.append(shell.element);
shell.slots.conversation.insertAdjacentHTML('beforeend', '<div class="fixture-content"><h2>Conversation</h2><p id="stream">Stream remains mounted</p><label>Message Pi<textarea id="draft">Keep my unfinished draft</textarea></label><button>Send</button></div>');
shell.slots.inspector.insertAdjacentHTML('beforeend', '<h2>Project</h2><p>Inspector details stay mounted.</p><label>Unsaved file<textarea id="editor">Unsaved file buffer</textarea></label>');
shell.slots.navigation.insertAdjacentHTML('beforeend', '<div class="fixture-content">Sessions</div>');
shell.slots.runControls.insertAdjacentHTML('beforeend', '<div class="fixture-run"><button>Abort</button><button>End</button></div>');
window.originalStream = document.getElementById('stream');
apply({});
window.ready = true;
</script></body></html>`;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('http://workspace.test/**', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const source = sources.get(pathname);
    await route.fulfill({ status: source || pathname === '/' ? 200 : 404,
      contentType: pathname.endsWith('.mjs') ? 'text/javascript' : pathname.endsWith('.css') ? 'text/css' : 'text/html',
      body: source ?? (pathname === '/' ? fixture : 'Not found') });
  });
  await page.goto('http://workspace.test/');
  await page.waitForFunction(() => window.ready);
});

const separator = page => page.getByRole('separator', { name: 'Resize inspector', exact: true });
const actualWidth = page => page.locator('.focused-inspector').evaluate(node => Math.round(node.getBoundingClientRect().width));
const commits = page => page.evaluate(() => window.commits);
async function startDrag(page, delta) {
  const box = await separator(page).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + delta, box.y + box.height / 2, { steps: 8 });
}

test('dragging left increases width and commits once on release while retaining canonical content', async ({ page }) => {
  const handle = separator(page);
  await expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  await expect(handle).toHaveAttribute('aria-controls', 'focusedWorkspaceInspector');
  await startDrag(page, -100);
  await expect.poll(() => actualWidth(page)).toBe(420);
  expect(await commits(page)).toEqual([]);
  await page.evaluate(() => { originalStream.textContent += ' with another chunk'; apply({ title: 'Streaming status' }); });
  await expect.poll(() => actualWidth(page)).toBe(420);
  await page.mouse.up();
  expect(await commits(page)).toEqual([420]);
  expect(await page.evaluate(() => localStorage.getItem('fixture-inspector-width'))).toBe('420');
  await expect(page.locator('#draft')).toHaveValue('Keep my unfinished draft');
  await expect(page.locator('#editor')).toHaveValue('Unsaved file buffer');
  expect(await page.locator('#stream').evaluate(node => node === originalStream)).toBe(true);
  await expect(handle).toHaveAttribute('aria-valuenow', '420');
});

test('keyboard arrows follow the right edge, Home and End honor effective bounds and double click resets', async ({ page }) => {
  const handle = separator(page);
  await handle.press('ArrowLeft');
  await handle.press('Shift+ArrowLeft');
  await handle.press('ArrowRight');
  await handle.press('Shift+ArrowRight');
  expect(await commits(page)).toEqual([330, 380, 370, 320]);
  await handle.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '240');
  await handle.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '536');
  await expect.poll(() => actualWidth(page)).toBe(536);
  await handle.dblclick();
  await expect.poll(() => actualWidth(page)).toBe(320);
  expect(await commits(page)).toEqual([330, 380, 370, 320, 240, 536, 320]);
});

test('viewport and sidebar clamping preserve preferred width and no-op clicks never commit', async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.evaluate(() => apply({ inspectorWidth: 640 }));
  await expect.poll(() => actualWidth(page)).toBe(640);
  await page.setViewportSize({ width: 1100, height: 500 });
  await expect.poll(() => actualWidth(page)).toBe(383);
  await separator(page).click();
  await separator(page).press('End');
  await page.evaluate(() => apply({ navigationWidth: 420, title: 'History snapshot' }));
  await expect.poll(() => actualWidth(page)).toBe(285);
  await expect(separator(page)).toHaveAttribute('aria-valuemax', '285');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '285');
  expect((await page.locator('.focused-conversation').boundingBox()).width).toBeGreaterThanOrEqual(320);
  await separator(page).click();
  await page.evaluate(() => apply({ navigation: 'top' }));
  await expect.poll(() => actualWidth(page)).toBe(474);
  await page.setViewportSize({ width: 1920, height: 900 });
  await expect.poll(() => actualWidth(page)).toBe(640);
  expect(await commits(page)).toEqual([]);
  expect(await page.evaluate(() => snapshot.inspectorWidth)).toBe(640);
});

test('a constrained body still reserves 320px for conversation and ARIA matches actual geometry', async ({ page }) => {
  await page.evaluate(() => { shell.element.style.width = '700px'; apply({ navigationWidth: 202, inspectorWidth: 640 }); });
  await expect.poll(() => actualWidth(page)).toBe(154);
  await expect(separator(page)).toHaveAttribute('aria-valuemin', '154');
  await expect(separator(page)).toHaveAttribute('aria-valuemax', '154');
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '154');
  expect((await page.locator('.focused-conversation').boundingBox()).width).toBe(320);
  await separator(page).click();
  await page.evaluate(() => shell.element.style.removeProperty('width'));
  await expect.poll(() => actualWidth(page)).toBe(536);
  expect(await commits(page)).toEqual([]);
});

test('Escape cancels after Tab moves focus away from the separator', async ({ page }) => {
  await startDrag(page, -90);
  await page.keyboard.press('Tab');
  await expect(separator(page)).not.toBeFocused();
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => actualWidth(page)).toBe(320);
  expect(await commits(page)).toEqual([]);
  await expect(page.locator('.focused-inspector-resizing')).toHaveCount(0);
});

for (const event of ['pointercancel', 'lostpointercapture']) {
  test(`${event} cancels without saving`, async ({ page }) => {
    await startDrag(page, -90);
    await separator(page).evaluate((node, event) => {
      if (event === 'lostpointercapture') node.releasePointerCapture(1);
      else node.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    }, event);
    await page.mouse.up();
    await expect.poll(() => actualWidth(page)).toBe(320);
    expect(await commits(page)).toEqual([]);
  });
}

for (const action of ['close', 'disable', 'classic', 'dispose']) {
  test(`${action} cancels active dragging and releases document listeners`, async ({ page }) => {
    await startDrag(page, -90);
    await page.evaluate(action => {
      if (action === 'close') apply({ destination: 'conversation', inspectorOpen: false });
      else if (action === 'disable') apply({ enabled: false });
      else if (action === 'classic') { shell.cancelInspectorResize(); shell.element.hidden = true; }
      else shell.dispose();
    }, action);
    await page.mouse.up();
    const escaped = await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(escaped).toBe(false);
    expect(await commits(page)).toEqual([]);
    await expect(page.locator('.focused-inspector-resizing')).toHaveCount(0);
    if (action !== 'dispose') {
      await page.evaluate(() => { shell.element.hidden = false; apply({ destination: 'project', enabled: true }); });
      await expect.poll(() => actualWidth(page)).toBe(320);
    } else {
      await separator(page).dispatchEvent('keydown', { key: 'ArrowLeft' });
      expect(await commits(page)).toEqual([]);
    }
  });
}

test('failed commit restores the previous preferred width for pointer, keyboard and reset', async ({ page }) => {
  await page.evaluate(() => { apply({ inspectorWidth: 400 }); window.failCommit = true; });
  await startDrag(page, -70);
  await page.mouse.up();
  await expect.poll(() => actualWidth(page)).toBe(400);
  await separator(page).press('ArrowLeft');
  await expect.poll(() => actualWidth(page)).toBe(400);
  await separator(page).dblclick();
  await expect.poll(() => actualWidth(page)).toBe(400);
  expect(await commits(page)).toEqual([470, 410, 320]);
  expect(await page.evaluate(() => localStorage.getItem('fixture-inspector-width'))).toBeNull();
});

for (const theme of ['dark', 'light']) {
  for (const [width, height] of [[1440, 900], [1100, 500]]) {
    test(`${theme} ${width}x${height} keeps rail badges, run controls and narrow inspector visible`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await page.evaluate(theme => {
        if (theme === 'light') {
          const tokens = { '--theme-color-scheme': 'light', '--bg': '#eff1f5', '--panel': '#eff1f5',
            '--panel-2': '#ccd0da', '--panel-3': '#e6e9ef', '--text': '#4c4f69', '--muted': '#5c5f77',
            '--border': '#bcc0cc', '--accent': '#8839ef', '--warning': '#df8e1d', '--danger': '#d20f39',
            '--ctp-text': '#4c4f69', '--ctp-subtext': '#5c5f77', '--ctp-overlay': '#8c8fa1',
            '--ctp-base': '#eff1f5', '--ctp-mantle': '#e6e9ef', '--ctp-crust': '#dce0e8',
            '--ctp-mauve': '#8839ef', '--ctp-teal': '#179299', '--ctp-pink': '#ea76cb', '--ctp-red': '#d20f39',
            '--ctp-crust-rgb': '220, 224, 232', '--ctp-base-rgb': '239, 241, 245', '--ctp-surface-rgb': '204, 208, 218',
            '--ctp-mantle-rgb': '230, 233, 239', '--ctp-text-rgb': '76, 79, 105', '--ctp-subtext-rgb': '92, 95, 119' };
          for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
        }
        apply({ inspectorWidth: 240 });
      }, theme);
      await expect.poll(() => actualWidth(page)).toBe(240);
      await expect(page.getByRole('button', { name: 'Attention, 2 decisions waiting, 3 finished' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Abort', exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await separator(page).focus();
      const screenshot = info.outputPath(`inspector-resize-${theme}-${width}x${height}.png`);
      await page.screenshot({ path: screenshot });
      await info.attach('Inspector and rail', { path: screenshot, contentType: 'image/png' });
    });
  }
}
