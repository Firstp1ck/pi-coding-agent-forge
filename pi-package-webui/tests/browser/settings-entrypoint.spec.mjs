import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });

const rail = page => page.getByRole('navigation', { name: 'Workspace destinations' });
const gear = page => page.locator('#focusedWorkspace .terminal-sidebar-actions')
  .getByRole('button', { name: 'Settings', exact: true });

async function openFocused(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await page.locator('#promptInput').fill('Keep this unfinished Settings draft');
  await page.locator('#promptInput').evaluate(node => {
    window.originalPrompt = node;
    window.canonicalSettings = document.querySelector('.settings-workspace');
    node.setSelectionRange(5, 20, 'backward');
  });
}

async function expectCanonicalSettings(page) {
  await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-destination', 'settings');
  await expect(page.locator('.focused-page-content > .settings-workspace')).toBeVisible();
  await expect(page.locator('.settings-workspace')).toHaveCount(1);
  expect(await page.locator('.settings-workspace').evaluate(node => node === window.canonicalSettings)).toBe(true);
  await expect(page.locator('#desktopShellSelect')).toBeVisible();
  await expect(rail(page).getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  await expect(rail(page).locator('[aria-current]')).toHaveCount(0);
}

async function expectDraftOnReturn(page) {
  await page.getByRole('button', { name: 'Back to conversation', exact: true }).click();
  const prompt = page.locator('#promptInput');
  await expect(prompt).toBeVisible();
  await expect(prompt).toHaveValue('Keep this unfinished Settings draft');
  expect(await prompt.evaluate(node => node === window.originalPrompt)).toBe(true);
}

for (const width of [1100, 1440]) {
  test(`only the sidebar Settings gear remains at ${width}px and preserves the composer`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await openFocused(page, ownership);
    await expect(rail(page).getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(1);
    await expect(gear(page)).toBeInViewport({ ratio: 1 });
    const home = await page.locator('#focusedWorkspace #workspaceDashboardToggleButton').boundingBox();
    const bounds = await gear(page).boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(home.x + home.width);
    expect(Math.abs(bounds.y - home.y)).toBeLessThan(2);
    await page.screenshot({ path: info.outputPath(`sidebar-${width}.png`), animations: 'disabled' });
    await gear(page).focus();
    await page.keyboard.press('Enter');
    await expectCanonicalSettings(page);
    await expect(gear(page)).toHaveAttribute('aria-current', 'page');
    const search = page.getByRole('searchbox', { name: 'Search settings', exact: true });
    await search.fill('Session navigation');
    await expect(page.getByRole('list', { name: 'Settings search results' })).toContainText('Session navigation');
    await search.fill('');
    await page.screenshot({ path: info.outputPath(`settings-${width}.png`), animations: 'disabled' });
    await expectDraftOnReturn(page);
    await expect(gear(page)).not.toHaveAttribute('aria-current');
    await page.keyboard.press('Control+k');
    await expect(page.locator('#shellToolsLauncher')).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search all tools' }).fill('theme');
    await expect(page.locator('#shellToolsLauncher').getByRole('button', { name: '/theme', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close All tools', exact: true }).click();
    await expect(page.locator('#shellToolsLauncher')).toBeHidden();
    await expect(page.locator('#promptInput')).toHaveValue('Keep this unfinished Settings draft');
  });
}

for (const layout of ['top', 'collapsed']) {
  test(`All tools keeps Settings keyboard accessible with ${layout} navigation`, async ({ page, ownership }, info) => {
    await openFocused(page, ownership);
    if (layout === 'top') {
      await gear(page).click();
      await page.locator('#focusedNavigationSelect').selectOption('top');
      await expectDraftOnReturn(page);
      await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-navigation', 'top');
    } else {
      await rail(page).getByRole('button', { name: 'Collapse sessions', exact: true }).click();
      await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-nav-collapsed', 'true');
    }
    await expect(gear(page)).toBeHidden();
    await expect(rail(page).getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
    const tools = rail(page).getByRole('button', { name: 'All tools', exact: true });
    await tools.focus();
    await page.keyboard.press('Enter');
    const search = page.getByRole('searchbox', { name: 'Search all tools' });
    await expect(search).toBeFocused();
    await search.fill('Controls');
    const controls = page.locator('#shellToolsLauncher').getByRole('button', { name: 'Controls', exact: true });
    await expect(controls).toBeEnabled();
    await controls.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#shellToolsLauncher')).toBeHidden();
    await expectCanonicalSettings(page);
    await page.screenshot({ path: info.outputPath(`settings-${layout}.png`), animations: 'disabled' });
    await expectDraftOnReturn(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  });
}
