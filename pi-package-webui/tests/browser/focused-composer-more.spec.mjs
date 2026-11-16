import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const [width, height] of [[1100, 900], [1440, 900], [1440, 500]]) {
  test(`More keeps primary controls compact and opens actions beside More at ${width}x${height}`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
    await page.goto(ownership.baseURL);
    await expect(page.locator('#focusedWorkspace')).toBeVisible();
    await expect(page.locator('#chat')).toContainText('fake answer');
    if (width === 1100) {
      await page.getByRole('button', { name: 'Inspector', exact: true }).click();
      await page.getByRole('tab', { name: 'Project', exact: true }).click();
      await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
    }
    const prompt = page.locator('#promptInput');
    const more = page.locator('#composerActionsButton');
    const send = page.locator('#sendButton');
    const panel = page.locator('#composerActionsPanel');
    await prompt.fill('Keep this draft while browsing actions');
    const closedSend = await send.boundingBox();
    const closedMore = await more.boundingBox();
    const stableSelectors = ['#promptInput', '#chat', '#statusBar', '.composer-row'];
    const closedLayout = await Promise.all(stableSelectors.map(selector => page.locator(selector).boundingBox()));
    await page.screenshot({ path: info.outputPath('more-closed.png') });
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await page.screenshot({ path: info.outputPath('more-open.png') });
    const openSend = await send.boundingBox();
    const openMore = await more.boundingBox();
    const actions = await panel.boundingBox();
    const openLayout = await Promise.all(stableSelectors.map(selector => page.locator(selector).boundingBox()));
    expect(openLayout).toEqual(closedLayout);
    expect(openSend).toEqual(closedSend);
    expect(openMore).toEqual(closedMore);
    expect(openSend.height).toBeLessThanOrEqual(closedSend.height + 2);
    expect(openMore.height).toBeLessThanOrEqual(closedMore.height + 2);
    expect(actions.x).toBeGreaterThanOrEqual(openMore.x + openMore.width);
    expect(actions.x + actions.width).toBeLessThanOrEqual(openSend.x);
    await expect(panel).toHaveCSS('position', 'fixed');
    expect(actions.y + actions.height).toBeCloseTo(openMore.y + openMore.height, 0);
    await expect(more).toHaveText('More');
    for (const selector of ['#newSessionButton', '#compactButton', '#optionsMenuButton', '#sendButton', '#composerActionsButton']) {
      await page.locator(selector).click({ trial: true });
    }
    await page.locator('#optionsMenuButton').click();
    await page.locator('#optionsSessionSubmenuButton').focus();
    await page.locator('#optionsSessionSubmenuButton').press('ArrowRight');
    await page.locator('#optionsNameButton').click();
    await expect(page.getByPlaceholder('New session name')).toBeVisible();
    await page.keyboard.press('Escape');
    if (await more.getAttribute('aria-expanded') === 'true') await more.click();
    await expect(panel).toBeHidden();
    await expect(prompt).toHaveValue('Keep this draft while browsing actions');
    await expect(send).toBeVisible();
  });
}


for (const [width, height] of [[1100, 500], [1440, 900]]) {
  test(`Options stays above the open overview at ${width}x${height}`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', overviewOpen: true })));
    await page.goto(ownership.baseURL);
    await expect(page.locator('#chat')).toContainText('fake answer');
    await page.getByRole('button', { name: 'Inspector', exact: true }).click();
    await page.locator('#promptInput').fill('Keep the draft under the menu');
    await page.locator('#composerActionsButton').click();
    await page.locator('#optionsMenuButton').click();
    const optionTrigger = await page.locator('#optionsMenuButton').boundingBox();
    const options = await page.locator('#optionsMenu').boundingBox();
    expect(Math.abs(options.x - optionTrigger.x)).toBeLessThan(2);
    const palette = page.locator('#optionsCommandPaletteButton');
    await expect(palette).toBeVisible();
    expect(await palette.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(true);
    await page.screenshot({ path: info.outputPath('options-above-overview.png') });
    const rect = await palette.boundingBox();
    await palette.click({ position: { x: rect.width / 2, y: rect.height / 2 } });
    await expect(page.getByRole('dialog', { name: 'All tools', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#promptInput')).toHaveValue('Keep the draft under the menu');
    await page.getByRole('button', { name: 'Close conversation overview' }).click();
    await expect(page.getByRole('region', { name: 'Conversation overview', exact: true })).toBeHidden();
    await page.locator('#sendButton').click({ trial: true });
  });
}

for (const [width, height, side] of [[1440, 900, 'right'], [1100, 600, 'left']]) {
  test(`Options submenus fly out to the ${side} at ${width}x${height} and stay open on the way in`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
    await page.goto(ownership.baseURL);
    await expect(page.locator('#chat')).toContainText('fake answer');
    await page.locator('#composerActionsButton').click();
    await page.locator('#optionsMenuButton').click();
    const trigger = page.locator('#optionsSessionSubmenuButton');
    const submenu = page.locator('#optionsSessionSubmenu');
    await trigger.hover();
    await expect(submenu).toBeVisible();
    await expect(submenu).toHaveCSS('position', 'fixed');
    const menu = await page.locator('#optionsMenu').boundingBox();
    const triggerBox = await trigger.boundingBox();
    const flyout = await submenu.boundingBox();
    if (side === 'right') expect(flyout.x).toBeGreaterThanOrEqual(menu.x + menu.width - 8);
    else expect(flyout.x + flyout.width).toBeLessThanOrEqual(menu.x + 8);
    expect(flyout.x).toBeGreaterThanOrEqual(0);
    expect(flyout.x + flyout.width).toBeLessThanOrEqual(width);
    expect(flyout.y + flyout.height).toBeLessThanOrEqual(height);
    await page.screenshot({ path: info.outputPath(`options-flyout-${side}.png`) });

    const item = page.locator('#optionsNameButton');
    const itemBox = await item.boundingBox();
    const startX = side === 'right' ? triggerBox.x + triggerBox.width - 2 : triggerBox.x + 2;
    await page.mouse.move(startX, triggerBox.y + triggerBox.height / 2);
    await page.mouse.move(itemBox.x + itemBox.width / 2, itemBox.y + itemBox.height / 2, { steps: 8 });
    await expect(submenu).toBeVisible();
    await item.click();
    await expect(page.getByPlaceholder('New session name')).toBeVisible();
    await page.keyboard.press('Escape');
  });
}
