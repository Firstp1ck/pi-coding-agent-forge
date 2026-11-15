import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', video: 'off', reducedMotion: 'reduce' });
test.setTimeout(60_000);

const destinations = page => page.getByRole('navigation', { name: 'Workspace destinations' });
const destination = (page, name) => destinations(page).getByRole('button', { name, exact: true });

async function open(page, ownership) {
  await page.addInitScript(() => {
    const key = 'pi-webui-shell-preferences-v1';
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ v: 1, desktopLayout: 'focused' }));
  });
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#chat')).toContainText('fake answer');
}

async function audit(page, selector, info, label) {
  const result = await new AxeBuilder({ page }).include(selector)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  await info.attach(`${label}-axe`, { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath(`${label.replace(/[^a-z0-9-]/gi, '-')}.png`), animations: 'disabled' });
  expect.soft(result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) })), label).toEqual([]);
}

async function enterByTab(page, target) {
  // A bounded traversal proves keyboard entry without assigning focus to the target.
  for (let index = 0; index < 120; index += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate(node => node === document.activeElement)) return;
  }
  throw new Error(`Tab traversal never reached ${await target.getAttribute('aria-label')}`);
}

async function containTab(page, dialog, count = 18) {
  const samples = [];
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let index = 0; index < count; index += 1) {
      await page.keyboard.press(key);
      const state = await dialog.evaluate(node => ({
        contained: node.contains(document.activeElement), documentFocused: document.hasFocus(),
        activeTag: document.activeElement?.tagName, activeId: document.activeElement?.id,
      }));
      samples.push({ key, index, ...state });
      // Native dialogs may traverse browser chrome, never another app control.
      const browserChrome = await dialog.evaluate(node => node.matches('dialog:modal'))
        && !state.documentFocused && state.activeTag === 'BODY';
      expect.soft(state.contained || browserChrome, `${key} stays in modal or native browser chrome: ${JSON.stringify(state)}`).toBe(true);
    }
  }
  await test.info().attach('modal-tab-samples', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' });
}

test.afterEach(async ({ page }, info) => {
  if (!page.isClosed()) await page.screenshot({ path: info.outputPath('final-state.png'), animations: 'disabled' });
});

test('changed desktop destinations and all Settings categories have zero selected WCAG violations', async ({ page, ownership }, info) => {
  await open(page, ownership);
  for (const name of ['Conversation', 'Home', 'Project', 'Activity', 'Settings']) {
    await destination(page, name).click();
    await expect(destination(page, name)).toHaveAttribute('aria-current', 'page');
    await audit(page, '#focusedWorkspace', info, name);
  }
  const categories = page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button');
  for (let index = 0; index < await categories.count(); index += 1) {
    const category = categories.nth(index);
    const label = await category.innerText();
    await category.click();
    await expect(category).toHaveAttribute('aria-current', 'page');
    await audit(page, '.settings-workspace', info, `settings-${label}`);
  }
});

test('Settings keyboard entry arrows Home End search Escape and conversation return preserve focus and selection', async ({ page, ownership }) => {
  await open(page, ownership);
  const prompt = page.locator('#promptInput');
  await prompt.fill('Keep this selected draft');
  await prompt.evaluate(node => node.setSelectionRange(5, 9, 'backward'));
  await enterByTab(page, destination(page, 'Settings'));
  await page.keyboard.press('Enter');
  const categories = page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button');
  await enterByTab(page, categories.first());
  for (const [key, index] of [['End', -1], ['Home', 0], ['ArrowDown', 1], ['ArrowUp', 0], ['ArrowRight', 1], ['ArrowLeft', 0]]) {
    await page.keyboard.press(key);
    await expect(categories.nth(index)).toBeFocused();
  }
  await page.keyboard.press('Enter');
  const search = page.getByRole('searchbox', { name: 'Search settings', exact: true });
  await enterByTab(page, search);
  await search.fill('desktop');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.settings-navigation-open:enabled').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).toBeFocused();
  await enterByTab(page, page.getByRole('button', { name: 'Back to conversation', exact: true }).filter({ visible: true }));
  await page.keyboard.press('Enter');
  await expect.soft(prompt).toBeFocused();
  await expect(prompt).toHaveValue('Keep this selected draft');
  expect(await prompt.evaluate(node => [node.selectionStart, node.selectionEnd, node.selectionDirection])).toEqual([5, 9, 'backward']);
});

test('Project inspector tabs support arrows Home End and selected panel names', async ({ page, ownership }, info) => {
  await open(page, ownership);
  await enterByTab(page, destination(page, 'Project'));
  await page.keyboard.press('Enter');
  const tabs = page.getByRole('tablist', { name: 'Inspector topics' }).getByRole('tab');
  await enterByTab(page, tabs.first());
  for (const [key, index] of [['End', -1], ['Home', 0], ['ArrowRight', 1], ['ArrowLeft', 0]]) {
    await page.keyboard.press(key);
    await expect(tabs.nth(index)).toBeFocused();
  }
  await page.keyboard.press('Enter');
  await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
  await audit(page, '#focusedWorkspace', info, 'project-keyboard');
});

test('All tools supports keyboard entry arrows Home End modal Tab Escape and return focus', async ({ page, ownership }, info) => {
  await open(page, ownership);
  const opener = destination(page, 'All tools');
  await enterByTab(page, opener);
  await page.keyboard.press('Enter');
  const dialog = page.locator('#shellToolsLauncher');
  const search = page.getByRole('searchbox', { name: 'Search all tools' });
  await expect(search).toBeFocused();
  await audit(page, '#shellToolsLauncher', info, 'all-tools');
  const actions = dialog.locator('.tools-launcher-action:enabled');
  for (const [key, index] of [['ArrowDown', 0], ['End', -1], ['Home', 0], ['ArrowDown', 1], ['ArrowUp', 0]]) {
    await page.keyboard.press(key);
    await expect(actions.nth(index)).toBeFocused();
  }
  await containTab(page, dialog);
  await page.screenshot({ path: info.outputPath('all-tools-keyboard.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test('directory dialog reached from launcher is named trapped and restores its invoking control', async ({ page, ownership }, info) => {
  await open(page, ownership);
  await enterByTab(page, destination(page, 'All tools'));
  await page.keyboard.press('Enter');
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('Choose directory for new tab');
  await page.keyboard.press('Enter');
  const dialog = page.locator('dialog:modal');
  await expect(dialog).toHaveCount(1);
  await expect(dialog).toHaveAccessibleName('Choose CWD for new tab');
  await audit(page, 'dialog:modal', info, 'directory');
  await containTab(page, dialog);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.soft(destination(page, 'All tools'), 'closing nested flow returns to its launcher opener').toBeFocused();
});

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
  test(`compact v2 keyboard navigation and sheet WCAG ${viewport.width}x${viewport.height}`, async ({ page, ownership }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(`${ownership.baseURL}/?mobileShell=v2&tabletShell=v2&tab=${ownership.tabs[0].id}`);
    await expect(page.locator('#mobileShellV2')).toBeVisible();
    const nav = page.getByRole('navigation', { name: viewport.width < 700 ? 'Phone destinations' : 'Tablet destinations' });
    const buttons = nav.getByRole('button');
    await enterByTab(page, buttons.first());
    for (const [key, index] of [['End', -1], ['Home', 0], [viewport.width < 700 ? 'ArrowRight' : 'ArrowDown', 1]]) {
      await page.keyboard.press(key);
      await expect(buttons.nth(index)).toBeFocused();
    }
    await audit(page, '#mobileShellV2', info, 'compact-navigation');
    await page.locator('#mobileMoreButton').click();
    await audit(page, '#mobileShellSurface', info, 'compact-more');
    await containTab(page, page.locator('#mobileShellSurface'), 10);
    await page.keyboard.press('Escape');
    await expect(page.locator('#mobileShellSurface')).toBeHidden();
    await expect(page.locator('#mobileMoreButton')).toBeFocused();
  });
}

test('forced colors and reduced motion retain named keyboard controls and no selected WCAG violations', async ({ page, ownership }, info) => {
  await page.emulateMedia({ forcedColors: 'active', reducedMotion: 'reduce' });
  await open(page, ownership);
  expect(await page.evaluate(() => [matchMedia('(forced-colors: active)').matches, matchMedia('(prefers-reduced-motion: reduce)').matches])).toEqual([true, true]);
  await enterByTab(page, destination(page, 'All tools'));
  expect(await destination(page, 'All tools').evaluate(node => {
    const style = getComputedStyle(node);
    return node.matches(':focus-visible') && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
  }), 'forced-colors keyboard focus indicator').toBe(true);
  await page.keyboard.press('Enter');
  await audit(page, '#shellToolsLauncher', info, 'forced-colors');
  const excessiveMotion = await page.locator('#shellToolsLauncher').evaluate(root => [root, ...root.querySelectorAll('*')].filter(node => {
    const style = getComputedStyle(node);
    return [style.animationDuration, style.transitionDuration].some(value => value.split(',').some(duration => parseFloat(duration) > 0.1));
  }).map(node => node.id || node.className));
  expect.soft(excessiveMotion, 'reduced-motion modal has no prolonged animation').toEqual([]);
  await page.screenshot({ path: info.outputPath('forced-colors.png'), animations: 'disabled' });
});

test('compact lifecycle announces run and approval transitions without streaming token announcements', async ({ page, ownership }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${ownership.baseURL}/?mobileShell=v2&tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#chat')).toContainText('fake answer');
  await page.locator('#mobileLifecycleAnnouncer').evaluate(node => {
    window.w7Announcements = [];
    window.w7AnnouncementObserver = new MutationObserver(() => window.w7Announcements.push(node.textContent));
    window.w7AnnouncementObserver.observe(node, { subtree: true, childList: true, characterData: true });
  });
  await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, { message: 'fixture continuity delayed stream', requestId: 'w7-live-announcements-0001' });
  await expect(page.locator('#chat .assistant.streaming')).toBeVisible();
  await expect(page.locator('#chat .assistant.streaming')).toHaveCount(0);
  await expect(page.locator('#chat .assistant').last().locator('.message-body')).toHaveText('continuity stream complete');
  const streamAnnouncements = await page.evaluate(() => [...window.w7Announcements]);
  await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, { message: 'fixture mobile blocker', requestId: 'w7-live-announcements-0002' });
  await expect(page.locator('#dialogTitle')).toHaveText('Fixture blocker');
  await expect(page.locator('#mobileLifecycleAnnouncer')).toContainText('needs your decision');
  const announcements = await page.evaluate(() => {
    window.w7AnnouncementObserver.disconnect();
    return window.w7Announcements;
  });
  await info.attach('lifecycle-announcements', { body: JSON.stringify({ streamAnnouncements, announcements }, null, 2), contentType: 'application/json' });
  expect.soft(streamAnnouncements.filter(text => text.includes('is running.'))).toHaveLength(1);
  expect.soft(announcements.filter(text => text.includes('needs your decision.'))).toHaveLength(1);
  expect.soft(announcements.filter(text => ['continuity', 'continuity stream', 'continuity stream complete'].includes(text.trim()))).toEqual([]);
  await expect(page.locator('#chat')).not.toHaveAttribute('aria-live', /polite|assertive/);
  await page.locator('#dialogActions').getByRole('button', { name: 'No', exact: true }).click();
});
