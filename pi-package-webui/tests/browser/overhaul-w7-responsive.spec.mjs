import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';
import { navigateFocused } from './focused-navigation-fixture.mjs';

test.use({ serviceWorkers: 'block', video: 'off', reducedMotion: 'reduce' });
test.setTimeout(60_000);

const viewports = [[360, 800], [390, 844], [844, 390], [768, 1024], [1024, 768], [1440, 900], [1920, 1080]];
const composer = ['#promptInput', '#attachButton', '#sendButton'];
const compactComposer = [...composer, '#composerActionsButton'];

async function seed(page, desktopLayout, navigation = 'left') {
  await page.addInitScript(({ desktopLayout, navigation }) => {
    const key = 'pi-webui-shell-preferences-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ v: 1, desktopLayout, navigation }));
  }, { desktopLayout, navigation });
}

async function open(page, ownership, query = '') {
  const preferences = page.waitForResponse(response => new URL(response.url()).pathname === '/api/interface-preferences' && response.request().method() === 'GET');
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}&${query}`);
  expect((await preferences).ok()).toBe(true);
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await expect(page.locator('#chat')).toContainText('fake answer');
  await page.evaluate(() => document.fonts.ready);
}

async function hitChecks(page, selectors, info, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const measurements = [];
  for (const selector of selectors) {
    const control = page.locator(selector);
    await expect(control).toHaveCount(1);
    const geometry = await control.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return {
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
        viewport: { width: innerWidth, height: innerHeight },
        inside: rect.width > 0 && rect.height > 0 && rect.x >= -0.5 && rect.y >= -0.5 && rect.right <= innerWidth + 0.5 && rect.bottom <= innerHeight + 0.5,
        hit: hit === node || node.contains(hit), hitTarget: hit?.id || hit?.className,
        inert: !!node.closest('[inert]'), disabled: node.matches(':disabled'),
      };
    });
    measurements.push({ selector, ...geometry });
    expect.soft(geometry.inside, `${label} ${selector} inside viewport: ${JSON.stringify(geometry)}`).toBe(true);
    expect.soft(geometry.hit, `${label} ${selector} center hit: ${JSON.stringify(geometry)}`).toBe(true);
    expect.soft(geometry.inert, `${label} ${selector} is interactive`).toBe(false);
    // Trial clicks exercise Chromium's actual actionability and ancestor clipping checks.
    await expect.soft(control).toBeEnabled();
    await expect.soft(async () => control.click({ trial: true, timeout: 1200 })).toPass({ timeout: 1500, intervals: [0] });
  }
  await info.attach(`${label}-geometry`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
}

async function screenshot(page, info, name) {
  await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
}

test.afterEach(async ({ page }, info) => {
  if (!page.isClosed()) await screenshot(page, info, 'final-state');
});

for (const [width, height] of viewports) {
  for (const mode of ['classic', 'focused', 'compact-v2']) {
    test(`${mode} ownership controls and axe at ${width}x${height}`, async ({ browser, ownership }, info) => {
      const context = await browser.newContext({ viewport: { width, height }, isMobile: width <= 844 && height <= 844, hasTouch: width <= 1050, serviceWorkers: 'block', reducedMotion: 'reduce' });
      try {
        const page = await context.newPage();
        await seed(page, mode === 'classic' ? 'classic' : 'focused');
        await open(page, ownership, mode === 'compact-v2' ? 'mobileShell=v2&tabletShell=v2' : 'mobileShell=legacy&tabletShell=legacy');
        const desktop = width > 1050;
        await expect(page.locator('#focusedWorkspace'))[desktop && mode !== 'classic' ? 'toBeVisible' : 'toBeHidden']();
        await expect(page.locator('#mobileShellV2'))[!desktop && mode === 'compact-v2' ? 'toBeVisible' : 'toBeHidden']();
        await page.locator('#promptInput').fill(`Retained ${mode} draft ${width}x${height}`);
        await screenshot(page, info, 'conversation');
        await hitChecks(page, desktop && mode === 'classic' ? composer : compactComposer, info, 'required-composer');
        const selector = desktop && mode !== 'classic' ? '#focusedWorkspace' : !desktop && mode === 'compact-v2' ? '#mobileShellV2' : 'body';
        const result = await new AxeBuilder({ page }).include(selector).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
        await info.attach('axe', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
        expect.soft(result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
        for (const id of ['promptInput', 'sendButton', 'attachButton', 'modelSelect', 'thinkingSelect']) await expect(page.locator(`#${id}`)).toHaveCount(1);
        if (!desktop && mode === 'compact-v2') {
          await page.locator('#mobileMoreButton').click();
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
        } else if (mode === 'classic' || !desktop) {
          if (!desktop) await page.locator('#sidePanelExpandButton').click();
          const controls = page.locator('[data-side-panel-section-toggle="controls"]');
          if (await controls.getAttribute('aria-expanded') !== 'true') await controls.click();
        }
        const modelControl = desktop && mode !== 'classic' ? '.focused-composer-setting-button:has(.focused-composer-model-value)' : '#modelSelect';
        const effortControl = desktop && mode !== 'classic' ? '.focused-composer-setting-button:has(.focused-composer-effort-value)' : '#thinkingSelect';
        await page.locator(modelControl).scrollIntoViewIfNeeded();
        await hitChecks(page, [modelControl], info, 'model');
        await page.locator(effortControl).scrollIntoViewIfNeeded();
        await hitChecks(page, [effortControl], info, 'effort');
        await screenshot(page, info, 'model-effort-controls');
        await expect(page.locator('#promptInput')).toHaveValue(`Retained ${mode} draft ${width}x${height}`);
      } finally { await context.close(); }
    });
  }

  test(`streaming Stop and composer hit targets at ${width}x${height}`, async ({ browser, ownership }, info) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width <= 844 && height <= 844, hasTouch: width <= 1050, serviceWorkers: 'block', reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await seed(page, 'focused');
      await open(page, ownership, 'mobileShell=v2&tabletShell=v2');
      await page.locator('#promptInput').fill('retain the streaming draft');
      await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, { message: 'fixture transcript continuity dwell', requestId: `w7-streaming-hit-${width}-${height}` });
      await expect(page.locator('#abortButton')).toBeVisible();
      await screenshot(page, info, 'streaming-controls');
      await hitChecks(page, ['#promptInput', '#attachButton', '#abortButton'], info, 'streaming-required');
      const aborted = page.waitForResponse(response => new URL(response.url()).pathname === '/api/abort' && response.request().method() === 'POST');
      await page.locator('#abortButton').hover();
      await page.mouse.down();
      try { await page.waitForTimeout(1500); } finally { await page.mouse.up(); }
      const response = await aborted;
      expect(response.ok()).toBe(true);
      expect(new URL(response.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
      await expect(page.locator('#abortButton')).toBeHidden();
      await expect(page.locator('#promptInput')).toHaveValue('retain the streaming draft');
    } finally { await context.close(); }
  });
}

test('independent phone tablet overrides rotation and Classic recovery preserve canonical draft', async ({ browser, ownership }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await seed(page, 'focused');
    await open(page, ownership, 'mobileShell=v2&tabletShell=legacy');
    await page.locator('#promptInput').fill('rotation draft');
    await page.locator('#promptInput').evaluate(node => { window.w7Composer = node; });
    for (const [width, height, compact] of [[844, 390, true], [768, 1024, false], [1024, 768, false], [1440, 900, false], [390, 844, true]]) {
      await page.setViewportSize({ width, height });
      await info.attach(`rotation-${width}x${height}`, { body: JSON.stringify(await page.evaluate(() => ({ width: innerWidth, height: innerHeight, classes: document.body.className, mobile: document.documentElement.dataset.mobileShell, tablet: document.documentElement.dataset.tabletShell }))), contentType: 'application/json' });
      await expect.soft(page.locator('#mobileShellV2'))[compact ? 'toBeVisible' : 'toBeHidden']();
      await expect.soft(page.locator('#focusedWorkspace'))[width > 1050 ? 'toBeVisible' : 'toBeHidden']();
      await expect(page.locator('#promptInput')).toHaveValue('rotation draft');
      expect(await page.locator('#promptInput').evaluate(node => node === window.w7Composer)).toBe(true);
    }
    await page.setViewportSize({ width: 768, height: 1024 });
    await open(page, ownership, 'mobileShell=legacy&tabletShell=v2');
    await expect(page.locator('#mobileShellV2')).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#mobileShellV2')).toBeHidden();
    await open(page, ownership, 'mobileShell=v2&tabletShell=v2&shell=classic');
    await expect(page.locator('#mobileShellV2')).toBeHidden();
    await expect(page.locator('#focusedWorkspace')).toBeHidden();
    await screenshot(page, info, 'classic-recovery');
  } finally { await context.close(); }
});

for (const navigation of ['left', 'top']) {
  test(`many long session names and groups remain reachable with ${navigation} navigation`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const tabs = [...ownership.tabs];
    for (let index = 0; index < 6; index += 1) tabs.push((await ownership.api('/api/tabs', { title: `W7 session ${index} ${'long-name-'.repeat(14)}` })).tab);
    await seed(page, 'focused', navigation);
    await open(page, ownership);
    await page.locator('#promptInput').fill('many sessions source draft');
    await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-navigation', navigation);
    const tabButtons = page.locator('#tabBar .terminal-tab-button');
    await tabButtons.first().focus();
    for (const [key, index] of [['End', -1], ['Home', 0], ['ArrowRight', 1], ['ArrowLeft', 0]]) {
      await page.keyboard.press(key);
      await expect(tabButtons.nth(index)).toBeFocused();
    }
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page.locator(`#tabBar [data-tab-id="${tabs[1].id}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#promptInput')).toBeFocused();
    await expect(page.locator('#promptInput')).toHaveValue('');
    for (const tab of [tabs.at(-1), tabs[0]]) {
      const button = page.locator(`#tabBar [data-tab-id="${tab.id}"] .terminal-tab-button`);
      await button.scrollIntoViewIfNeeded();
      await hitChecks(page, [`#tabBar [data-tab-id="${tab.id}"] .terminal-tab-button`], info, `session-${tab.id}`);
      await button.click();
      await expect(button).toHaveAttribute('aria-selected', 'true');
    }
    await expect(page.locator('#promptInput')).toHaveValue('many sessions source draft');
    const current = await ownership.api('/api/interface-preferences');
    const groups = { version: 1, groups: [{ id: 'w7-long-group', title: `W7 group ${'long group '.repeat(12).trim()}`, tabIds: tabs.slice(0, 3).map(tab => tab.id) }] };
    const response = await page.request.put(`${ownership.baseURL}/api/interface-preferences`, { data: { expectedLayoutRevision: current.layoutRevision, layout: { version: 3, terminalTabs: { customGroups: groups } } } });
    expect(response.ok(), await response.text()).toBe(true);
    await page.reload();
    const group = page.locator('[data-custom-group-id="w7-long-group"] > .terminal-tab-group-button');
    await group.focus();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await hitChecks(page, tabs.slice(0, 3).map(tab => `[data-custom-group-id="w7-long-group"] [data-tab-id="${tab.id}"] .terminal-tab-group-item-button`), info, 'group');
    await screenshot(page, info, `many-sessions-${navigation}`);
  });
}

for (const placement of ['left', 'right', 'both']) {
  test(`Classic ${placement} customized deck restores layout after reload and focused rollback`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await seed(page, 'classic');
    await open(page, ownership);
    const controls = page.locator('[data-side-panel-section-toggle="controls"]');
    if (await controls.getAttribute('aria-expanded') !== 'true') await controls.click();
    await page.locator('#controlDeckPlacementSelect').selectOption(placement);
    // Sidebar explicitly excludes Both; exercise the supported combination.
    const tabPlacement = placement === 'both' ? 'top' : 'left';
    await page.locator('#terminalTabsLayoutSelect').selectOption(tabPlacement);
    const files = page.locator('[data-side-panel-section-toggle="files"]');
    await files.focus();
    await files.press('Alt+ArrowUp');
    if (placement === 'both') await files.press('Alt+ArrowLeft');
    const expectedDeck = await page.evaluate(() => JSON.parse(localStorage.getItem('pi-webui-control-deck-layout-v2')));
    await expect.poll(async () => (await ownership.api('/api/interface-preferences')).layout).toMatchObject({
      terminalTabs: { layout: tabPlacement }, sidePanel: { placement, sectionLayout: expectedDeck.sectionLayout },
    });
    const before = (await ownership.api('/api/interface-preferences')).layout;
    await page.reload();
    if (await controls.getAttribute('aria-expanded') !== 'true') await controls.click();
    await expect(page.locator('#controlDeckPlacementSelect')).toHaveValue(placement);
    await expect(page.locator('#terminalTabsLayoutSelect')).toHaveValue(tabPlacement);
    expect((await ownership.api('/api/interface-preferences')).layout.sidePanel.sectionLayout).toEqual(before.sidePanel.sectionLayout);
    if (await controls.getAttribute('aria-expanded') !== 'true') await controls.click();
    await expect(page.locator('#modelSelect')).toBeVisible();
    await page.locator('#promptInput').fill('custom layout retained draft');
    await screenshot(page, info, `classic-${placement}`);
    await hitChecks(page, [...composer, '#modelSelect', '#thinkingSelect'], info, `custom-${placement}`);
    await page.locator('#desktopShellSelect').selectOption('focused');
    await expect(page.locator('#focusedWorkspace')).toBeVisible();
    await navigateFocused(page, 'Settings');
    await page.locator('#desktopShellSelect').selectOption('classic');
    await expect(page.locator('#focusedWorkspace')).toBeHidden();
    await expect(page.locator('#promptInput')).toHaveValue('custom layout retained draft');
    expect((await ownership.api('/api/interface-preferences')).layout.sidePanel.sectionLayout).toEqual(before.sidePanel.sectionLayout);
  });
}

test('split drafts survive compact resize without reserving inaccessible half width and restore on return', async ({ page, ownership }, info) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await seed(page, 'classic');
  await open(page, ownership, 'mobileShell=legacy&tabletShell=legacy');
  await page.locator('#promptInput').fill('source split draft');
  await page.locator(`[data-tab-id="${ownership.tabs[0].id}"] .terminal-tab-split-button`).click();
  const frame = page.frameLocator('#terminalSplitFrame');
  await expect(frame.locator('#chat')).toContainText('fake answer');
  const splitId = await page.locator('#terminalSplitFrame').getAttribute('data-tab-id');
  expect(ownership.tabs.map(tab => tab.id)).not.toContain(splitId);
  await frame.locator('#promptInput').fill('independent split draft');
  for (const [width, height] of [[1920, 1080], [1024, 768], [390, 844], [1920, 1080]]) {
    await page.setViewportSize({ width, height });
    await expect(page.locator('#promptInput')).toHaveValue('source split draft');
    await expect(frame.locator('#promptInput')).toHaveValue('independent split draft');
    await screenshot(page, info, `split-${width}`);
    await hitChecks(page, composer, info, `split-${width}`);
    if (width > 1050) {
      await expect(page.locator('#terminalSplitShell')).toBeVisible();
      for (const selector of composer) {
        await frame.locator(selector).click({ trial: true });
        const box = await frame.locator(selector).boundingBox();
        expect(box).not.toBeNull();
        expect.soft(await page.evaluate(box => {
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return box.x >= 0 && box.y >= 0 && box.x + box.width <= innerWidth && box.y + box.height <= innerHeight && hit?.id === 'terminalSplitFrame';
        }, box), `embedded ${selector} reaches the top-level iframe`).toBe(true);
      }
    } else {
      const geometry = await page.locator('.chat-panel').evaluate(node => ({ width: node.getBoundingClientRect().width, viewport: innerWidth, splitHidden: !document.querySelector('#terminalSplitShell').getClientRects().length }));
      expect.soft(!geometry.splitHidden || geometry.width >= geometry.viewport * 0.9, `hidden split releases width: ${JSON.stringify(geometry)}`).toBe(true);
    }
  }
  await page.locator('#terminalSplitCloseButton').click();
  expect((await ownership.api('/api/tabs')).tabs.map(tab => tab.id)).toEqual(expect.arrayContaining([...ownership.tabs.map(tab => tab.id), splitId]));
});

for (const [width, height, constrainedHeight] of [[390, 844, 500], [844, 390, 220]]) {
  test(`software-keyboard viewport emulation retains attachment and real hit targets ${width}x${height}`, async ({ browser, ownership }, info) => {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await open(page, ownership, 'mobileShell=v2&tabletShell=v2');
      await page.locator('#promptInput').fill('keyboard emulation draft');
      await page.locator('#attachmentInput').setInputFiles({ name: `${'long-context-'.repeat(8)}.txt`, mimeType: 'text/plain', buffer: Buffer.from('W7 attachment') });
      await page.locator('#promptInput').focus();
      await page.setViewportSize({ width, height: constrainedHeight });
      await expect(page.locator('body')).toHaveClass(/mobile-keyboard-open/);
      await screenshot(page, info, 'keyboard-emulation');
      await hitChecks(page, compactComposer, info, 'keyboard-emulation');
      await expect(page.locator('#promptInput')).toHaveValue('keyboard emulation draft');
      await expect(page.locator('#attachmentTray')).toContainText('long-context-');
    } finally { await context.close(); }
  });
}

test('200-message history selection find scroll and draft survive real streaming and destination return', async ({ page, ownership }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page, 'focused');
  const history = Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `W7 reading message ${String(index).padStart(3, '0')}. ${'Fixed long reading context. '.repeat(8)}`, timestamp: (index + 1) * 1000 }));
  // The unchanged ownership fixture has no transcript option. Seed only history
  // responses, retaining every real fake-Pi message and its subsequent stream.
  await page.route('**/api/messages?*', async route => {
    const url = new URL(route.request().url());
    const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : null;
    url.searchParams.delete('since');
    const response = await route.fetch({ url: url.href });
    const payload = await response.json();
    const messages = [...history, ...payload.data.messages];
    payload.data = since === null ? { ...payload.data, messages } : { ...payload.data, messages: messages.slice(since), since, totalCount: messages.length };
    await route.fulfill({ response, json: payload });
  });
  await open(page, ownership);
  await expect(page.locator('#chat .message')).toHaveCount(203);
  const selected = 'W7 reading message 101.';
  const bubble = page.locator('#chat .message').filter({ hasText: selected });
  await bubble.scrollIntoViewIfNeeded();
  await page.locator('#chat').click({ position: { x: 20, y: 20 } });
  await page.keyboard.press('Control+f');
  await page.locator('#chatSearchInput').fill(selected);
  await expect(page.locator('#chatSearchCount')).toHaveText('1/1');
  expect(await page.evaluate(() => CSS.highlights.get('chat-search-match')?.size)).toBe(1);
  await bubble.evaluate((node, text) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const index = walker.currentNode.textContent.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(walker.currentNode, index);
      range.setEnd(walker.currentNode, index + text.length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      return;
    }
    throw new Error('selection text missing');
  }, selected);
  const targetScroll = await page.locator('#chat').evaluate(node => node.scrollTop - 80);
  await page.locator('#chat').hover({ position: { x: 20, y: 100 } });
  await page.mouse.wheel(0, -80);
  await expect.poll(() => page.locator('#chat').evaluate(node => node.scrollTop)).toBe(targetScroll);
  const before = await page.locator('#chat').evaluate(node => node.scrollTop);
  expect(before).toBeGreaterThan(0);
  await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, { message: 'fixture continuity delayed stream', requestId: 'w7-reading-continuity-0001' });
  await expect(page.locator('#chat .assistant.streaming')).toBeVisible();
  const samples = [];
  for (let index = 0; index < 5; index += 1) {
    samples.push(await page.evaluate(() => ({ selection: getSelection().toString(), scroll: document.querySelector('#chat').scrollTop, query: document.querySelector('#chatSearchInput').value, count: document.querySelector('#chatSearchCount').textContent })));
    await page.waitForTimeout(180);
  }
  await expect(page.locator('#chat .assistant.streaming')).toHaveCount(0);
  await expect(page.locator('#chat .assistant').last().locator('.message-body')).toHaveText('continuity stream complete');
  samples.push(await page.evaluate(() => ({ selection: getSelection().toString(), scroll: document.querySelector('#chat').scrollTop, query: document.querySelector('#chatSearchInput').value, count: document.querySelector('#chatSearchCount').textContent })));
  await info.attach('reading-continuity', { body: JSON.stringify({ before, samples }, null, 2), contentType: 'application/json' });
  for (const sample of samples) {
    expect.soft(sample.selection).toBe(selected);
    expect.soft(Math.abs(sample.scroll - before)).toBeLessThanOrEqual(1);
    expect.soft(sample.query).toBe(selected);
    expect.soft(sample.count).toBe('1/1');
  }
  await screenshot(page, info, 'long-transcript-selection');
  await page.locator('#promptInput').fill('reading return draft');
  await navigateFocused(page, 'Settings');
  await navigateFocused(page, 'Conversation');
  await expect(page.locator('#promptInput')).toHaveValue('reading return draft');
  expect.soft(Math.abs(await page.locator('#chat').evaluate(node => node.scrollTop) - before)).toBeLessThanOrEqual(1);
});

test('120 real files and long filename retain editor state across destination return', async ({ page, ownership }, info) => {
  const longName = `${'long-context-'.repeat(10)}119.txt`;
  const longFile = Array.from({ length: 180 }, (_, index) => `Fixed context 119 line ${index}: retained long file`).join('\n');
  await Promise.all(Array.from({ length: 120 }, (_, index) => writeFile(join(ownership.tabs[0].cwd, index === 119 ? longName : `context-${String(index).padStart(3, '0')}.txt`), index === 119 ? longFile : `Fixed context ${index}\n`)));
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page, 'focused');
  await open(page, ownership);
  await navigateFocused(page, 'Project');
  await page.getByRole('combobox', { name: 'Project section', exact: true }).selectOption({ label: 'Files' });
  await expect(page.locator('#fileTreeRoot [role="treeitem"]')).toHaveCount(120);
  await screenshot(page, info, 'expanded-files');
  await page.locator('#fileTreeSearchInput').fill(longName);
  await page.locator(`#fileTreeRoot [data-path="${longName}"]`).click();
  await expect(page.locator('#fileViewerEditor')).toHaveValue(longFile);
  const draft = longFile.replace('Fixed context', 'Unsaved W7 context');
  await page.locator('#fileViewerEditor').fill(draft);
  const scrollBefore = await page.locator('#fileViewerEditor').evaluate(node => {
    node.setSelectionRange(8, 10);
    node.scrollTop = 240;
    node.dispatchEvent(new Event('scroll'));
    return node.scrollTop;
  });
  expect(scrollBefore).toBeGreaterThan(0);
  await navigateFocused(page, 'Settings');
  await navigateFocused(page, 'Project');
  await expect(page.locator('#fileViewerEditor')).toHaveValue(draft);
  expect(await page.locator('#fileViewerEditor').evaluate(node => [node.selectionStart, node.selectionEnd])).toEqual([8, 10]);
  expect.soft(Math.abs(await page.locator('#fileViewerEditor').evaluate(node => node.scrollTop) - scrollBefore)).toBeLessThanOrEqual(1);
  await hitChecks(page, ['#fileViewerCloseButton', '#fileViewerSaveButton'], info, 'long-file');
  await screenshot(page, info, 'long-file-editor');
});

test('phone approval is discoverable and toast leaves return navigation clickable with exact response targeting', async ({ browser, ownership }, info) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await open(page, ownership, 'mobileShell=v2');
    await page.locator('#promptInput').fill('foreground approval draft');
    await ownership.api(`/api/prompt?tab=${ownership.tabs[1].id}`, { message: 'fixture mobile blocker', requestId: 'w7-background-approval' });
    await page.locator('#mobileSessionButton').click();
    // Fake Pi may rename a session from its first prompt. Discover by its
    // visible blocked state, then verify canonical identity after activation.
    const target = page.locator('.mobile-session-row.is-blocked .mobile-session-select');
    await expect(target).toHaveCount(1, { timeout: 16_000 });
    await target.click();
    await expect(page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('#dialogTitle')).toHaveText('Fixture blocker');
    const audit = await new AxeBuilder({ page }).include('#extensionDialog').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
    await info.attach('approval-axe', { body: JSON.stringify(audit, null, 2), contentType: 'application/json' });
    await screenshot(page, info, 'approval-dialog');
    expect.soft(audit.violations).toEqual([]);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/extension-ui-response' && response.request().method() === 'POST');
    await page.locator('#dialogActions').getByRole('button', { name: 'Yes', exact: true }).click();
    const confirmed = await response;
    expect(confirmed.ok()).toBe(true);
    expect(new URL(confirmed.url()).searchParams.get('tab')).toBe(ownership.tabs[1].id);
    expect(confirmed.request().postDataJSON()).toMatchObject({ id: 'fixture_blocker_12345678', confirmed: true });
    await expect(page.locator('.notice-toast:visible').first()).toBeVisible();
    await screenshot(page, info, 'approval-toasts');
    await hitChecks(page, ['[data-mobile-route-button="sessions"]', '#mobileSessionButton'], info, 'toast-navigation');
    await page.locator('#mobileSessionButton').click();
    await page.locator('.mobile-session-select').filter({ hasText: ownership.tabs[0].title }).click();
    await expect(page.locator('#promptInput')).toHaveValue('foreground approval draft');
  } finally { await context.close(); }
});

test('browser zoom capability probe distinguishes genuine zoom from constrained reflow', async ({ page, ownership }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page, 'focused');
  await open(page, ownership);
  const metrics = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, visualScale: visualViewport.scale }));
  const before = await metrics();
  await page.keyboard.press('Control+0');
  for (let index = 0; index < 5; index += 1) await page.keyboard.press('Control++');
  const after = await metrics();
  const genuine200 = after.dpr / before.dpr >= 1.95 && after.dpr / before.dpr <= 2.05 && after.width <= before.width / 1.95;
  await info.attach('browser-zoom-probe', { body: JSON.stringify({ mechanism: 'browser Control+0 then five Control++ shortcuts', before, after, genuine200, status: genuine200 ? 'measured' : 'missing: headless chrome did not apply browser zoom' }, null, 2), contentType: 'application/json' });
  if (!genuine200) info.annotations.push({ type: 'missing-evidence', description: 'Genuine browser 200% zoom unsupported by this shortcut probe; 720x450 below is viewport reflow only.' });
  await screenshot(page, info, 'browser-zoom-probe');
  await page.keyboard.press('Control+0');
  await page.setViewportSize({ width: 720, height: 450 });
  await page.locator('#promptInput').fill('constrained reflow draft');
  await screenshot(page, info, 'viewport-reflow-only');
  await hitChecks(page, composer, info, 'viewport-reflow-only');
});
