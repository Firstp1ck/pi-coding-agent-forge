import { navigateFocused } from './focused-navigation-fixture.mjs';
import { chromium, expect } from '@playwright/test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from './session-fixture.mjs';

test.setTimeout(90_000);

const canonicalIds = ['promptInput', 'attachButton', 'sendButton', 'modelSelect', 'thinkingSelect'];
const composerSelectors = ['#promptInput', '#attachButton', '#sendButton'];

async function capture(page, info, label) {
  const path = info.outputPath(`${label}.png`);
  // Playwright's CSS-sized clip crops native zoom screenshots. Capture the actual surface.
  const session = await page.context().newCDPSession(page);
  try {
    const { data } = await session.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
    await writeFile(path, Buffer.from(data, 'base64'));
  } finally { await session.detach(); }
  await info.attach(label, { path, contentType: 'image/png' });
}

async function metrics(page) {
  return page.evaluate(() => ({
    dpr: devicePixelRatio, width: innerWidth, height: innerHeight,
    clientWidth: document.documentElement.clientWidth,
    outerWidth, outerHeight, screenWidth: screen.width, screenHeight: screen.height,
    visualScale: visualViewport.scale,
    visualWidth: visualViewport.width, visualHeight: visualViewport.height,
    softwareKeyboardClass: document.body.classList.contains('mobile-keyboard-open'),
    activeElement: document.activeElement?.id,
  }));
}

async function setZoom(worker, page, factor) {
  return worker.evaluate(async ({ url, factor }) => {
    const tabs = (await chrome.tabs.query({})).filter(tab => tab.url === url);
    if (tabs.length !== 1) throw new Error(`Expected one zoom target for ${url}, got ${tabs.length}`);
    const tabId = tabs[0].id;
    await chrome.tabs.setZoomSettings(tabId, { mode: 'automatic', scope: 'per-tab' });
    await chrome.tabs.setZoom(tabId, factor);
    return { factor: await chrome.tabs.getZoom(tabId), settings: await chrome.tabs.getZoomSettings(tabId) };
  }, { url: page.url(), factor });
}

async function assertZoom(page, worker, baseline, factor, info, label) {
  const browserZoom = await setZoom(worker, page, factor);
  expect(browserZoom.factor).toBe(factor);
  expect(browserZoom.settings).toMatchObject({ mode: 'automatic', scope: 'per-tab' });
  await expect.poll(async () => (await metrics(page)).dpr).toBeCloseTo(baseline.dpr * factor, 3);
  await expect.poll(async () => (await metrics(page)).width).toBe(Math.round(baseline.width / factor));
  const current = await metrics(page);
  await info.attach(label, {
    body: JSON.stringify({ mechanism: 'chrome.tabs.setZoom, persistent Chromium, viewport:null', browserZoom, baseline, current }, null, 2),
    contentType: 'application/json',
  });
  expect(current.dpr / baseline.dpr).toBeCloseTo(factor, 3);
  for (const dimension of ['width', 'height', 'clientWidth', 'visualWidth', 'visualHeight']) {
    expect(Math.abs(current[dimension] - baseline[dimension] / factor), dimension).toBeLessThanOrEqual(1);
  }
  // Browser zoom changes layout/DPR without pinch scale or a resized outer window.
  expect(current.visualScale).toBe(1);
  for (const dimension of ['outerWidth', 'outerHeight', 'screenWidth', 'screenHeight']) {
    expect(current[dimension], dimension).toBe(baseline[dimension]);
  }
}

async function hitChecks(page, selectors, info, label) {
  const results = [];
  for (const selector of selectors) {
    const control = page.locator(selector);
    await expect(control).toHaveCount(1);
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    // Wait for actionability before sampling so shell transitions have settled.
    await control.click({ trial: true });
    const geometry = await control.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        inside: rect.width > 0 && rect.height > 0 && rect.x >= -0.5 && rect.y >= -0.5
          && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5,
        hit: hit === node || node.contains(hit), hitTarget: hit?.id || hit?.className,
        inert: !!node.closest('[inert]'),
      };
    });
    results.push({ selector, ...geometry });
    await info.attach(`${label}-${results.length}`, { body: JSON.stringify(results, null, 2), contentType: 'application/json' });
    expect(geometry.inside, `${label} ${selector}: ${JSON.stringify(geometry)}`).toBe(true);
    expect(geometry.hit, `${label} ${selector}: ${JSON.stringify(geometry)}`).toBe(true);
    expect(geometry.inert, selector).toBe(false);
  }
}

async function assertCanonical(page, nodes, draft) {
  for (const id of canonicalIds) await expect(page.locator(`#${id}`)).toHaveCount(1);
  expect(await page.evaluate(({ nodes, ids }) => ids.every((id, index) => document.getElementById(id) === nodes[index]),
    { nodes, ids: canonicalIds })).toBe(true);
  await expect(page.locator('#promptInput')).toHaveValue(draft);
}

async function withNativeZoom(info, run) {
  const root = await mkdtemp(join(tmpdir(), 'pi-webui-w7-native-zoom-'));
  const extension = join(root, 'extension');
  let context;
  let worker;
  let page;
  try {
    await mkdir(extension);
    await writeFile(join(extension, 'manifest.json'), JSON.stringify({
      manifest_version: 3, name: 'Disposable W7 browser zoom', version: '1.0',
      permissions: ['tabs'], background: { service_worker: 'background.js' },
    }));
    await writeFile(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
    context = await chromium.launchPersistentContext(join(root, 'profile'), {
      executablePath: '/usr/bin/chromium', headless: true,
      // A real browser window supplies the viewport. No device, viewport or CDP emulation.
      viewport: null, deviceScaleFactor: undefined, isMobile: false, serviceWorkers: 'allow', reducedMotion: 'reduce',
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, '--window-size=1440,900'],
    });
    context.setDefaultTimeout(5_000);
    worker = context.serviceWorkers().find(candidate => candidate.url().startsWith('chrome-extension://'))
      || await context.waitForEvent('serviceworker', { predicate: candidate => candidate.url().startsWith('chrome-extension://'), timeout: 10_000 });
    page = context.pages()[0] || await context.newPage();
    await info.attach('browser-version', { body: context.browser().version(), contentType: 'text/plain' });
    await run({ page, worker });
  } finally {
    try {
      if (page && !page.isClosed()) {
        try { await capture(page, info, 'final-state'); }
        finally {
          if (worker && page.url().startsWith('http://127.0.0.1:')) {
            const reset = await setZoom(worker, page, 1);
            expect(reset.factor, 'cleanup restores browser zoom').toBe(1);
          }
        }
      }
    } finally {
      let contextClosed = false;
      try { await context?.close(); contextClosed = true; }
      finally {
        await rm(root, { recursive: true, force: true });
        await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
        await info.attach('disposable-browser-cleanup', {
          body: JSON.stringify({ root, contextClosed, profileAndExtensionRemoved: true }), contentType: 'application/json',
        });
      }
    }
  }
}

for (const mode of ['compact-v2', 'classic']) {
  test(`genuine 200% browser zoom preserves ${mode} controls, draft and recovery`, async ({ ownership }, info) => {
    await withNativeZoom(info, async ({ page, worker }) => {
      await page.addInitScript(layout => localStorage.setItem('pi-webui-shell-preferences-v1',
        JSON.stringify({ v: 1, desktopLayout: layout, navigation: 'left' })), mode === 'classic' ? 'classic' : 'focused');
      const compact = mode === 'compact-v2' ? 'v2' : 'legacy';
      await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}&mobileShell=${compact}&tabletShell=${compact}`);
      await expect(page.locator('#chat')).toContainText('fake answer');
      await expect(page.locator('#modelSelect')).not.toBeEmpty();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('#focusedWorkspace'))[mode === 'classic' ? 'toBeHidden' : 'toBeVisible']();
      const draft = `Genuine browser zoom ${mode} retained draft`;
      await page.locator('#promptInput').fill(draft);
      const nodes = await page.evaluateHandle(ids => ids.map(id => document.getElementById(id)), canonicalIds);
      try {
        const initialZoom = await setZoom(worker, page, 1);
        expect(initialZoom.factor).toBe(1);
        const baseline = await metrics(page);
        expect(baseline.width).toBe(1440);
        expect(baseline.visualScale).toBe(1);
        await capture(page, info, 'baseline-100-percent');
        await hitChecks(page, composerSelectors, info, 'baseline-composer');

        await assertZoom(page, worker, baseline, 2, info, 'measured-200-percent');
        await expect(page.locator('#focusedWorkspace')).toBeHidden();
        await expect(page.locator('#mobileShellV2'))[mode === 'classic' ? 'toBeHidden' : 'toBeVisible']();
        await assertCanonical(page, nodes, draft);
        await capture(page, info, 'genuine-200-percent-conversation');
        await hitChecks(page, composerSelectors, info, 'zoomed-composer');
        // Native desktop zoom must not be mistaken for a software keyboard opening.
        await expect.soft(page.locator('body')).not.toHaveClass(/mobile-keyboard-open/);
        if (mode === 'compact-v2') {
          await expect.soft(page.locator('[data-mobile-route-button="sessions"]')).toBeVisible();
        } else {
          await expect.soft(page.locator('#composerActionsButton')).toBeVisible();
        }
        // A real focus change also checks recovery if the keyboard heuristic regresses.
        await page.keyboard.press('Tab');
        await expect(page.locator('body')).not.toHaveClass(/mobile-keyboard-open/);
        await hitChecks(page, [...composerSelectors, '#composerActionsButton'], info, 'zoomed-unfocused-composer');

        if (mode === 'compact-v2') {
          for (const route of ['sessions', 'activity', 'project', 'chat']) {
            const selector = `[data-mobile-route-button="${route}"]`;
            await hitChecks(page, [selector], info, `zoomed-navigation-${route}`);
            await page.locator(selector).click();
            if (route !== 'chat') await expect(page.locator(`[data-mobile-route="${route}"]`)).toBeVisible();
            await assertCanonical(page, nodes, draft);
          }
          await hitChecks(page, ['#mobileMoreButton'], info, 'zoomed-more');
          await page.locator('#mobileMoreButton').click();
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
        } else {
          await hitChecks(page, ['#sidePanelExpandButton'], info, 'zoomed-deck-navigation');
          await page.locator('#sidePanelExpandButton').click();
          const controls = page.locator('[data-side-panel-section-toggle="controls"]');
          if (await controls.getAttribute('aria-expanded') !== 'true') await controls.click();
        }
        for (const selector of ['#modelSelect', '#thinkingSelect']) {
          await page.locator(selector).scrollIntoViewIfNeeded();
          await hitChecks(page, [selector], info, 'zoomed-settings-controls');
        }
        await capture(page, info, 'genuine-200-percent-settings');
        if (mode === 'compact-v2') {
          await page.locator('#mobileSurfaceBackButton').click();
          await expect(page.locator('#mobileSurfaceTitle')).toHaveText('More');
          await page.locator('#mobileSurfaceCloseButton').click();
          await expect(page.locator('#mobileShellSurface')).toBeHidden();
        } else await page.locator('#toggleSidePanelButton').click();
        await assertCanonical(page, nodes, draft);
        await hitChecks(page, composerSelectors, info, 'zoomed-return-composer');

        await assertZoom(page, worker, baseline, 1, info, 'measured-reset-100-percent');
        await expect(page.locator('#mobileShellV2')).toBeHidden();
        await assertCanonical(page, nodes, draft);
        await hitChecks(page, composerSelectors, info, 'reset-composer');
        if (mode === 'compact-v2') {
          await expect(page.locator('#focusedWorkspace')).toBeVisible();
          await navigateFocused(page, 'Settings');
          await page.locator('#desktopShellSelect').selectOption('classic');
          await expect(page.locator('#focusedWorkspace')).toBeHidden();
          await assertCanonical(page, nodes, draft);
          await hitChecks(page, composerSelectors, info, 'classic-recovery-composer');
        }
        await capture(page, info, 'reset-classic-recovery');
      } finally { await nodes.dispose(); }
    });
  });
}
