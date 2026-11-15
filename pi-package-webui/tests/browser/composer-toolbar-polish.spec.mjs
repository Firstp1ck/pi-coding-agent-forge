import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce', actionTimeout: 8_000 });
test.setTimeout(60_000);

const draft = 'Keep this draft while checking composer controls.';
const model = page => page.locator('#statusBar .footer-model.footer-meta-action, #statusBar .footer-tui-model');
const effort = page => page.locator('#statusBar .footer-thinking.footer-meta-action');
const componentModel = page => page.locator('.focused-composer-controls').getByRole('button', { name: /^Model:/ });
const componentEffort = page => page.locator('.focused-composer-controls').getByRole('button', { name: /^Effort:/ });

async function ready(page, ownership, { width = 1440, height = 900, theme = 'dark', inspector = false } = {}) {
  await page.setViewportSize({ width, height });
  await page.addInitScript(({ theme }) => {
    localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' }));
    localStorage.setItem('pi-webui-theme', theme === 'light' ? 'catppuccin-latte' : 'catppuccin-mocha');
    // Put Send first in the saved order to exercise its independent primary placement.
    localStorage.setItem('pi-webui-composer-action-order-v1', JSON.stringify(['send', 'compact', 'options', 'new']));
  }, { theme });
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#chat')).toContainText('fake answer');
  await expect(model(page)).toBeEnabled();
  await expect(model(page)).toContainText('fake-model');
  await expect(effort(page)).toBeEnabled();
  await expect(page.locator('.focused-composer-controls')).toBeHidden();
  if (inspector) {
    await page.getByRole('button', { name: 'Inspector', exact: true }).click();
    await page.getByRole('tab', { name: 'Project', exact: true }).click();
    await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
  }
  await page.locator('#promptInput').fill(draft);
}

async function screenshot(page, info, name) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path, animations: 'disabled' });
  await info.attach(name, { path, contentType: 'image/png' });
}

async function expectToolbar(page, { coarse = false, component = false } = {}) {
  const geometry = await page.evaluate(() => {
    const rect = selector => {
      const { x, y, width, height, right, bottom } = document.querySelector(selector).getBoundingClientRect();
      return { x, y, width, height, right, bottom };
    };
    return {
      row: rect('.composer-row'), more: rect('#composerActionsButton'), send: rect('#sendButton'),
      group: document.querySelector('.focused-composer-controls').getClientRects().length ? rect('.focused-composer-controls') : null,
      footer: [...document.querySelectorAll('#statusBar .footer-model.footer-meta-action, #statusBar .footer-tui-model, #statusBar .footer-thinking.footer-meta-action')]
        .map(node => {
          const { x, right, y, bottom } = node.getBoundingClientRect();
          return { x, right, y, bottom };
        }),
      controls: [...document.querySelectorAll('.focused-composer-controls button, .focused-composer-controls select')]
        .filter(node => node.getClientRects().length).map(node => {
          const { x, right, y, bottom, height } = node.getBoundingClientRect();
          return { x, right, y, bottom, height, overflow: node.scrollWidth > node.clientWidth };
        }),
      overflow: document.documentElement.scrollWidth > innerWidth,
      chatScrollLeft: document.querySelector('#focusedWorkspace .chat-panel').scrollLeft,
      viewport: { width: innerWidth, height: innerHeight },
      gradient: getComputedStyle(document.querySelector('#sendButton')).backgroundImage,
    };
  });
  expect(geometry.overflow).toBe(false);
  expect(geometry.chatScrollLeft).toBe(0);
  expect(geometry.more.x).toBeCloseTo(geometry.row.x, 0);
  expect(geometry.send.right).toBeCloseTo(geometry.row.right, 0);
  expect(geometry.more.y).toBeCloseTo(geometry.send.y, 0);
  expect(geometry.more.right + 8).toBeLessThanOrEqual(geometry.send.x);
  expect(geometry.send.width).toBeLessThan(180);
  expect(geometry.gradient).toContain('linear-gradient');
  if (geometry.group) expect(geometry.group.y).toBeGreaterThanOrEqual(geometry.row.bottom);
  expect(geometry.footer).toHaveLength(2);
  for (const control of geometry.footer) {
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(control.y).toBeGreaterThanOrEqual(0);
    expect(control.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  }
  for (const control of [geometry.more, geometry.send, ...geometry.controls]) {
    expect(control.height).toBeGreaterThanOrEqual(coarse ? 44 : 30);
    if (!coarse) expect(control.height).toBeLessThanOrEqual(36);
    expect(control.x).toBeGreaterThanOrEqual(0);
    expect(control.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(control.y).toBeGreaterThanOrEqual(0);
    expect(control.bottom).toBeLessThanOrEqual(geometry.viewport.height);
  }
  expect(geometry.controls.every(control => !control.overflow)).toBe(true);
  const group = page.locator('.focused-composer-controls');
  if (component || await page.getByRole('combobox', { name: 'During this run' }).isVisible()) {
    await expect(group).toBeVisible();
  } else {
    await expect(group).toBeHidden();
  }
  if (!component) {
    for (const setting of await group.locator('.focused-composer-setting').all()) await expect(setting).toBeHidden();
    await expect(group.locator('.focused-composer-scoped-models')).toBeHidden();
  }
}

async function checkPickers(page) {
  const allTools = page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'All tools', exact: true });
  await allTools.click();
  await page.getByRole('searchbox', { name: 'Search all tools' }).fill('/model');
  await page.locator('#shellToolsLauncher').getByRole('button', { name: '/model', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Choose model', exact: true })).toBeVisible();
  await expect(page.locator('#nativeCommandBody')).toContainText('fake/fake-model-alt');
  await page.locator('#nativeCommandSearch').fill('fake-model-alt');
  await expect(page.locator('#nativeSelectorList').getByRole('option')).toHaveCount(1);
  await page.locator('#nativeCommandSearch').fill('');
  await page.keyboard.press('Escape');
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  await expect(allTools).toBeFocused();
  await model(page).click();
  const scoped = page.getByRole('listbox', { name: /Scoped models/ });
  await expect(scoped).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(scoped).toHaveCount(0);
  await expect(model(page)).toBeFocused();
  await effort(page).click();
  const thinking = page.getByRole('listbox', { name: 'Thinking effort', exact: true });
  await expect(thinking).toBeVisible();
  await expect(thinking.getByRole('option', { name: 'off', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(thinking).toHaveCount(0);
  await expect(effort(page)).toBeFocused();
  await expect(page.locator('#promptInput')).toHaveValue(draft);
}

async function checkMore(page, info, name) {
  const more = page.locator('#composerActionsButton');
  const panel = page.locator('#composerActionsPanel');
  const closedSend = await page.locator('#sendButton').boundingBox();
  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(panel).toHaveCSS('position', 'fixed');
  const actions = await panel.boundingBox();
  const row = await page.locator('.composer-row').boundingBox();
  const send = await page.locator('#sendButton').boundingBox();
  const moreBounds = await more.boundingBox();
  expect(actions.x).toBeGreaterThanOrEqual(moreBounds.x + moreBounds.width);
  expect(actions.x + actions.width).toBeLessThanOrEqual(send.x);
  expect(actions.y + actions.height).toBeCloseTo(moreBounds.y + moreBounds.height, 0);
  expect(send).toEqual(closedSend);
  expect(send.width).toBeCloseTo(closedSend.width, 0);
  expect(send.height).toBeCloseTo(closedSend.height, 0);
  const compact = await page.locator('#compactButton').boundingBox();
  const options = await page.locator('#optionsMenuButton').boundingBox();
  const newSession = await page.locator('#newSessionButton').boundingBox();
  expect(compact.x + compact.width).toBeLessThanOrEqual(options.x);
  expect(options.x + options.width).toBeLessThanOrEqual(newSession.x);
  for (const button of [compact, options, newSession]) {
    expect(button.y + button.height / 2).toBeCloseTo(compact.y + compact.height / 2, 0);
  }
  await expectToolbar(page);
  const relocatedControls = page.locator('#composerActionsPanel .composer-workflow-mode-dock button, #composerActionsPanel .composer-context-tags button');
  for (const button of await relocatedControls.all()) {
    if (!await button.isVisible()) continue;
    const bounds = await button.boundingBox();
    expect(bounds.y).toBeGreaterThanOrEqual(actions.y - 1);
    expect(bounds.x).toBeGreaterThanOrEqual(actions.x - 1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(actions.x + actions.width + 1);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(actions.y + actions.height + 1);
  }
  await screenshot(page, info, `${name}-more`);
  for (const selector of ['#newSessionButton', '#compactButton', '#optionsMenuButton', '#sendButton']) {
    await page.locator(selector).click({ trial: true });
  }
  await page.locator('#optionsMenuButton').click();
  const menu = page.locator('.composer-options-menu-panel');
  const menuBounds = await menu.boundingBox();
  const viewport = page.viewportSize();
  expect(menuBounds.x).toBeGreaterThanOrEqual(0);
  expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(menuBounds.y).toBeGreaterThanOrEqual(0);
  expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height);
  expect(menuBounds.x).toBeCloseTo(options.x, 0);
  await page.locator('#optionsSessionSubmenuButton').focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('#optionsNameButton').click({ trial: true });
  expect(await page.locator('.focused-conversation').evaluate(node => node.scrollLeft)).toBe(0);
  await expectToolbar(page);
  await screenshot(page, info, `${name}-nested`);
  await page.locator('#optionsNameButton').click();
  await expect(page.getByPlaceholder('New session name')).toBeVisible();
  await page.keyboard.press('Escape');
  if (await more.getAttribute('aria-expanded') === 'true') await more.click();
  await expect(panel).toBeHidden();
  await expect(page.locator('#promptInput')).toHaveValue(draft);
}

for (const [width, height, inspector] of [[1440, 900, false], [1100, 900, true], [1440, 500, false], [1100, 500, true]]) {
  for (const theme of ['dark', 'light']) {
    test(`compact toolbar at ${width}x${height}, ${theme}${inspector ? ', Project inspector' : ''}`, async ({ page, ownership }, info) => {
      await ready(page, ownership, { width, height, theme, inspector });
      await expect(page.locator('#sendButton')).toHaveText('Send');
      await expectToolbar(page);
      await screenshot(page, info, 'idle');
      await checkPickers(page);
      await checkMore(page, info, 'idle');

      await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, {
        message: 'fixture continuity held stream', requestId: 'composer-polish-held-stream',
      });
      const behavior = page.getByRole('combobox', { name: 'During this run' });
      await expect(behavior).toBeVisible();
      await behavior.selectOption('followUp');
      await expect(page.locator('#sendButton')).toHaveText('Queue message');
      await expectToolbar(page);
      await screenshot(page, info, 'running-queue');
      await behavior.selectOption('steer');
      await expect(page.locator('#sendButton')).toHaveText('Steer run');
      await expect(page.locator('.focused-composer-description')).toHaveText('Send guidance to Pi during this run.');
      await expect(page.locator('.focused-run-controls #abortButton')).toBeVisible();
      await expectToolbar(page);
      await screenshot(page, info, 'running-steer');
      await checkPickers(page);
      await checkMore(page, info, 'running');
      await expect(page.locator('#promptInput')).toHaveValue(draft);
    });
  }
}

test('focused desktop keeps coarse-pointer targets at least 44px', async ({ browser, ownership }, info) => {
  const context = await browser.newContext({ hasTouch: true, serviceWorkers: 'block', reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    await ready(page, ownership, { width: 1440, height: 900 });
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await expectToolbar(page, { coarse: true });
    await checkPickers(page);
    await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, {
      message: 'fixture continuity held stream', requestId: 'composer-polish-touch-stream',
    });
    await expect(page.getByRole('combobox', { name: 'During this run' })).toBeVisible();
    await expectToolbar(page, { coarse: true });
    await screenshot(page, info, 'coarse-pointer');
  } finally {
    await context.close();
  }
});

for (const theme of ['dark', 'light']) {
  test(`focused styles retain long values and disabled reasons, ${theme}`, async ({ page, ownership }, info) => {
    await ready(page, ownership, { width: 1100, height: 500, inspector: true, theme });
    // Fake Pi has short model names. Mount the same component in its real shell
    // to stress the focused CSS with long values and both disabled descriptions.
    const labels = {
      modelLabel: 'VeryLongProviderAndModelIdentifier'.repeat(4),
      effortLabel: 'Extended reasoning effort for the next prompt',
      modelReason: 'Model selection is unavailable while this session reconnects. Your draft will be kept.',
      effortReason: 'Effort selection is unavailable until the session model has loaded. Please wait for reconnection.',
    };
    await page.evaluate(async labels => {
      const { createFocusedComposerControls } = await import('/focused-composer-controls.mjs');
      const probe = createFocusedComposerControls({ document, onScopedModels() {} });
      document.querySelector('.focused-composer-controls').replaceWith(probe.element);
      probe.update({ ...labels, runActive: true, modelDisabled: true, effortDisabled: true });
    }, labels);
    await expect(componentModel(page)).toBeDisabled();
    await expect(componentEffort(page)).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Scoped models', exact: true })).toBeDisabled();
    await expect(componentModel(page)).toHaveAttribute('title', labels.modelReason);
    await expect(componentModel(page)).toHaveAccessibleDescription(labels.modelReason);
    await expect(componentEffort(page)).toHaveAccessibleDescription(labels.effortReason);
    await expect(page.getByText(labels.modelReason, { exact: true })).toBeVisible();
    await expect(page.getByText(labels.effortReason, { exact: true })).toBeVisible();
    const reasons = await page.locator('.focused-composer-reason').evaluateAll(nodes => nodes.map(node => {
      const rect = node.getBoundingClientRect();
      return { overflow: node.scrollWidth > node.clientWidth, top: rect.top, bottom: rect.bottom, right: rect.right };
    }));
    for (const reason of reasons) {
      expect(reason.overflow).toBe(false);
      expect(reason.top).toBeGreaterThanOrEqual(0);
      expect(reason.bottom).toBeLessThanOrEqual(500);
      expect(reason.right).toBeLessThanOrEqual(1100);
    }
    await expectToolbar(page, { component: true });
    await screenshot(page, info, 'disabled-reasons');
    await page.evaluate(async labels => {
      const { createFocusedComposerControls } = await import('/focused-composer-controls.mjs');
      const probe = createFocusedComposerControls({ document, onScopedModels() {} });
      document.querySelector('.focused-composer-controls').replaceWith(probe.element);
      probe.update(labels);
    }, labels);
    await expect(componentModel(page)).toHaveAttribute('title', labels.modelLabel);
    await expect(componentEffort(page)).toHaveAttribute('title', labels.effortLabel);
    expect(await page.locator('.focused-composer-model-value').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await page.keyboard.press('Tab');
    await componentModel(page).focus();
    await expect(componentModel(page)).toBeFocused();
    await expect(componentModel(page)).toHaveCSS('outline-style', 'solid');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Scoped models', exact: true })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(componentEffort(page)).toBeFocused();
    await expectToolbar(page, { component: true });
    await screenshot(page, info, 'long-values');
    await expect(page.locator('#promptInput')).toHaveValue(draft);
  });
}


for (const height of [500, 900]) {
  test(`minimized workflow controls and slash suggestions stay reachable at 1100x${height}`, async ({ page, ownership }, info) => {
    await ready(page, ownership, { width: 1100, height, theme: 'dark', inspector: true });
    await ownership.api(`/api/prompt?tab=${ownership.tabs[0].id}`, {
      message: 'fixture workflow inspector running', requestId: 'composer-minimized-workflow',
    });
    await page.getByRole('tab', { name: 'Activity', exact: true }).click();
    await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: 'Progress' });
    await page.locator('.workflow-overlay-close-button').first().click();
    await page.getByRole('tab', { name: 'Project', exact: true }).click();
    await page.locator('#composerActionsButton').click();
    const restore = page.locator('#workflowOverlayOpenButton');
    await expect(restore).toBeVisible();
    await expect(page.locator('#workflowModeButton')).toBeVisible();
    const controls = page.locator('#composerActionsPanel button');
    const bounds = await controls.evaluateAll(nodes => nodes.filter(node => node.getClientRects().length && !node.closest('.composer-options-menu-panel')).map(node => {
      const { x, y, right, bottom } = node.getBoundingClientRect();
      return { id: node.id, x, y, right, bottom };
    }));
    for (const id of ['workflowOverlayOpenButton', 'workflowModeButton']) {
      const own = bounds.find(button => button.id === id);
      for (const other of bounds.filter(button => button.id !== id)) {
        expect(Math.min(own.right, other.right) <= Math.max(own.x, other.x) + 1
          || Math.min(own.bottom, other.bottom) <= Math.max(own.y, other.y) + 1, `${id} overlaps ${other.id}`).toBe(true);
      }
    }
    await restore.click({ trial: true });
    await page.locator('#workflowModeButton').click({ trial: true });
    await page.locator('#promptInput').fill('/');
    await expect(page.locator('#commandSuggest')).toBeVisible();
    await page.locator('#sendButton').click({ trial: true });
    await page.locator('#composerActionsButton').click({ trial: true });
    await expect(page.locator('#promptInput')).toHaveValue('/');
    await screenshot(page, info, 'short-window-suggestions-recovery');
  });
}
