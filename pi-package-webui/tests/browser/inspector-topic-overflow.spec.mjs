import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';
import { navigateFocused } from './focused-navigation-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const width of [1100, 1440]) {
  test(`inspector header picker fits without sideways scrolling and remains reachable at ${width}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', inspectorWidth: 240 })));
    await page.goto(ownership.baseURL);
    await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
    await page.locator('#promptInput').fill('Keep this draft while inspecting');
    await navigateFocused(page, 'Project');
    const picker = page.getByRole('combobox', { name: 'Project section', exact: true });
    const destinations = page.getByRole('tablist', { name: 'Inspector destinations', exact: true });
    await expect(picker).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Inspector topics' })).toHaveCount(0);
    const ids = await picker.locator('option').evaluateAll(options => options.map(option => option.value));
    expect(ids).toEqual(['files', 'git', 'runners', 'release', 'artifacts']);
    for (const id of ids) {
      await picker.selectOption(id);
      await expect(picker).toHaveValue(id);
      await expect.poll(() => new URL(page.url()).searchParams.get('inspector')).toBe(id);
    }
    for (const navigation of [destinations, picker.locator('..')]) {
      await expect.poll(() => navigation.evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
      expect(await navigation.evaluate(node => node.scrollLeft)).toBe(0);
    }
    const outer = await picker.locator('..').boundingBox();
    const control = await picker.boundingBox();
    expect(control.x).toBeGreaterThanOrEqual(outer.x);
    expect(control.y).toBeGreaterThanOrEqual(outer.y);
    expect(control.x + control.width).toBeLessThanOrEqual(outer.x + outer.width + 1);
    expect(control.y + control.height).toBeLessThanOrEqual(outer.y + outer.height + 1);
    await picker.selectOption(ids[0]);
    await picker.focus();
    await picker.press('Enter');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(picker).toBeFocused();
    await expect(picker).toHaveValue(ids.at(-1));
    const inspector = page.locator('.focused-inspector-content');
    await expect(inspector.locator('.focused-artifact-empty')).toBeVisible();
    await expect.poll(() => inspector.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath('documents-empty-no-scrollbar.png') });
    await picker.press('Enter');
    await page.keyboard.press('Home');
    await page.keyboard.press('Enter');
    await expect(picker).toBeFocused();
    await expect(picker).toHaveValue(ids[0]);
    await expect(page.locator('#fileTreeSearchInput')).toBeVisible();
    await expect(page.locator('#promptInput')).toHaveValue('Keep this draft while inspecting');
    await page.screenshot({ path: info.outputPath('inspector-header-no-scrollbar.png') });
  });
}
