import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ serviceWorkers: 'block', video: 'off', reducedMotion: 'reduce' });
test.setTimeout(60_000);

async function open(page, ownership, { layout = 'focused', navigation = 'left', query = '' } = {}) {
  await page.addInitScript(({ layout, navigation }) => {
    localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: layout, navigation }));
  }, { layout, navigation });
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}&${query}`);
  await expect(page.locator('#chat')).toContainText('fake answer');
  await page.evaluate(() => document.fonts.ready);
}

async function measureTargets(controls, info, label) {
  const measurements = await controls.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    // A 24px diameter disk also checks round controls without sampling outside their shape.
    const points = [[0, 0], ...Array.from({ length: 8 }, (_, index) => {
      const angle = index * Math.PI / 4;
      return [12 * Math.cos(angle), 12 * Math.sin(angle)];
    })];
    return {
      name: node.getAttribute('aria-label') || node.id || node.className,
      box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
      inside: rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      enabled: !node.matches(':disabled') && !node.closest('[inert]'),
      hits: points.map(([x, y]) => {
        const hit = document.elementFromPoint(rect.x + rect.width / 2 + x, rect.y + rect.height / 2 + y);
        return { owned: hit === node || node.contains(hit), target: hit?.id || hit?.getAttribute('class') || hit?.tagName };
      }),
    };
  }));
  await info.attach(label, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  return measurements;
}

function expectUsable(measurements) {
  expect(measurements.length).toBeGreaterThan(0);
  for (const item of measurements) {
    expect.soft(item.inside, JSON.stringify(item)).toBe(true);
    expect.soft(item.enabled, item.name).toBe(true);
    expect.soft(item.hits.every(hit => hit.owned), JSON.stringify(item)).toBe(true);
    expect.soft(item.box.width, item.name).toBeGreaterThanOrEqual(24);
    expect.soft(item.box.height, item.name).toBeGreaterThanOrEqual(24);
  }
}

async function targetAudit(page, selector, info) {
  const result = await new AxeBuilder({ page }).include(selector).withRules(['target-size']).analyze();
  await info.attach('target-size-axe', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  expect.soft(result.violations).toEqual([]);
}

for (const [layout, navigation] of [['focused', 'left'], ['focused', 'top'], ['classic', 'top']]) {
  test(`${layout} ${navigation} session actions have unobscured 24px hit targets`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, ownership, { layout, navigation });
    await expect(page.locator('#focusedWorkspace'))[layout === 'focused' ? 'toBeVisible' : 'toBeHidden']();
    const controls = page.locator('#tabBar .terminal-tab-split-button, #tabBar .terminal-tab-summary-button, #tabBar .terminal-tab-close');
    await expect(controls).toHaveCount(6);
    await page.screenshot({ path: info.outputPath(`terminal-${layout}-${navigation}.png`), animations: 'disabled' });
    expectUsable(await measureTargets(controls, info, 'terminal-actions'));
    for (const button of await controls.all()) await button.click({ trial: true });
    await targetAudit(page, layout === 'classic' ? 'body' : '#tabBar', info);
    if (layout === 'classic') expectUsable(await measureTargets(page.locator('#busyPromptBehaviorTag'), info, 'busy-prompt-target'));
    const summary = page.locator('#tabBar .terminal-tab-summary-button').first();
    await summary.click();
    await expect(page.locator('#nativeCommandDialog')).toBeVisible();
    await expect(page.locator('#nativeCommandTitle')).toHaveText('/summary-setup');
    await page.locator('#nativeCommandActions').getByRole('button', { name: 'Cancel', exact: true }).click();
  });
}

test('legacy landscape message actions retain complete hit targets below the sticky prompt', async ({ browser, ownership }, info) => {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await open(page, ownership, { layout: 'classic', query: 'mobileShell=legacy&tabletShell=legacy' });
    const controls = page.locator('#chat .message-copy-button:visible, #chat .message-edit-retry-button:visible');
    await page.screenshot({ path: info.outputPath('legacy-landscape.png'), animations: 'disabled' });
    await measureTargets(controls, info, 'legacy-actions');
    await targetAudit(page, 'body', info);
    const lastActions = page.locator('#chat .message').last().locator('.message-copy-button, .message-edit-retry-button');
    expectUsable(await measureTargets(lastActions, info, 'last-message-actions'));
    for (const button of await lastActions.all()) await button.click({ trial: true });
  } finally { await context.close(); }
});

test('top group targets stay above the transcript and activate their exact session', async ({ page, ownership }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const tabs = [...ownership.tabs];
  for (let index = 0; index < 6; index += 1) tabs.push((await ownership.api('/api/tabs', { title: `Layout session ${index} ${'long-name-'.repeat(14)}` })).tab);
  const preferences = await ownership.api('/api/interface-preferences');
  const response = await page.request.put(`${ownership.baseURL}/api/interface-preferences`, { data: {
    expectedLayoutRevision: preferences.layoutRevision,
    layout: { version: 3, terminalTabs: { customGroups: { version: 1, groups: [{ id: 'w7-css-group', title: 'Long group '.repeat(12).trim(), tabIds: tabs.slice(0, 3).map(tab => tab.id) }] } } },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  await open(page, ownership, { navigation: 'top' });
  await page.locator('#promptInput').fill('top group source draft');
  const group = page.locator('[data-custom-group-id="w7-css-group"]');
  await group.locator(':scope > .terminal-tab-group-button').focus();
  await expect(group.locator(':scope > .terminal-tab-group-button')).toHaveAttribute('aria-expanded', 'true');
  const items = group.locator('.terminal-tab-group-item-button');
  await expect(items).toHaveCount(3);
  await page.screenshot({ path: info.outputPath('top-group.png'), animations: 'disabled' });
  expectUsable(await measureTargets(items, info, 'top-group-items'));
  for (const button of await items.all()) await button.click({ trial: true });
  await items.last().click();
  await expect(page.locator(`#tabBar [data-tab-id="${tabs[2].id}"] .terminal-tab-group-item-button`)).toHaveAttribute('aria-selected', 'true');
  await group.locator(':scope > .terminal-tab-group-button').focus();
  await items.first().click();
  await expect(page.locator('#promptInput')).toHaveValue('top group source draft');
});

for (const running of [false, true]) {
  test(`landscape keyboard with attachment preserves ${running ? 'Stop' : 'Send'} and required controls`, async ({ browser, ownership }, info) => {
    const context = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      await open(page, ownership, { query: 'mobileShell=v2&tabletShell=v2' });
      await page.locator('#promptInput').fill('retained landscape keyboard draft');
      const filename = `${'long-context-'.repeat(8)}.txt`;
      await page.locator('#attachmentInput').setInputFiles({ name: filename, mimeType: 'text/plain', buffer: Buffer.from('W7 CSS attachment') });
      await expect(page.locator('#attachmentTray')).toContainText(filename);
      if (running) {
        await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, { message: 'fixture transcript continuity dwell', requestId: 'w7-css-keyboard-stop' });
        await expect(page.locator('#abortButton')).toBeVisible();
      }
      await page.locator('#promptInput').focus();
      await page.setViewportSize({ width: 844, height: 220 });
      await expect(page.locator('body')).toHaveClass(/mobile-keyboard-open/);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const selectors = ['#promptInput', '#attachButton', '#composerActionsButton', ...(running ? ['#abortButton', '#steerButton', '#followUpButton'] : ['#sendButton']), '#mobileSessionButton', '#mobileSearchButton', '#mobileMoreButton'];
      await info.attach('constrained-layout', { body: JSON.stringify(await page.locator('.composer').evaluate(node => {
        const ancestors = [];
        for (let element = node; element; element = element.parentElement) {
          const style = getComputedStyle(element);
          ancestors.push({ id: element.id, className: element.className, box: element.getBoundingClientRect().toJSON(), minHeight: style.minHeight, overflow: style.overflow, flex: style.flex, grid: style.gridTemplateRows });
        }
        return ancestors;
      }), null, 2), contentType: 'application/json' });
      await page.screenshot({ path: info.outputPath(`keyboard-${running ? 'stop' : 'send'}.png`), animations: 'disabled' });
      expectUsable(await measureTargets(page.locator(selectors.join(', ')), info, 'constrained-targets'));
      for (const selector of selectors) await page.locator(selector).click({ trial: true });
      await expect(page.locator('#promptInput')).toHaveValue('retained landscape keyboard draft');
      await expect(page.locator('#attachmentTray')).toContainText(filename);
      if (running) {
        await page.locator('#abortButton').hover();
        await page.evaluate(() => {
          window.w7PointerEvents = [];
          for (const type of ['pointerdown', 'pointerup', 'pointerleave', 'focusin', 'focusout']) {
            document.addEventListener(type, event => window.w7PointerEvents.push({ type, id: event.target.id, classes: document.body.className, box: document.querySelector('#abortButton').getBoundingClientRect().toJSON() }), true);
          }
        });
        let response;
        try {
          [response] = await Promise.all([
            page.waitForResponse(response => new URL(response.url()).pathname === '/api/abort' && response.request().method() === 'POST'),
            (async () => {
              await page.mouse.down();
              try { await page.waitForTimeout(1500); } finally { await page.mouse.up(); }
            })(),
          ]);
        } finally {
          await info.attach('abort-pointer-events', { body: JSON.stringify(await page.evaluate(() => window.w7PointerEvents), null, 2), contentType: 'application/json' });
        }
        expect(response.ok()).toBe(true);
        expect(new URL(response.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
        await expect(page.locator('#abortButton')).toBeHidden();
      }
      await page.setViewportSize({ width: 844, height: 390 });
      await expect(page.locator('body')).not.toHaveClass(/mobile-keyboard-open/);
      await expect(page.locator('#promptInput')).toHaveValue('retained landscape keyboard draft');
      await expect(page.locator('#attachmentTray')).toContainText(filename);
    } finally { await context.close(); }
  });
}
