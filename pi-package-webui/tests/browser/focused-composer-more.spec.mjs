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
    await page.screenshot({ path: info.outputPath('more-closed.png') });
    await more.click();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    await expect(panel).toBeVisible();
    await page.screenshot({ path: info.outputPath('more-open.png') });
    const openSend = await send.boundingBox();
    const openMore = await more.boundingBox();
    const actions = await panel.boundingBox();
    const row = await page.locator('.composer-row').boundingBox();
    expect(openSend.height).toBeLessThanOrEqual(closedSend.height + 2);
    expect(openMore.height).toBeLessThanOrEqual(closedMore.height + 2);
    expect(actions.x).toBeGreaterThanOrEqual(openMore.x + openMore.width);
    expect(actions.x + actions.width).toBeLessThanOrEqual(openSend.x);
    await expect(panel).toHaveCSS('grid-column-start', '2');
    expect(actions.y).toBeCloseTo(openMore.y, 0);
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
