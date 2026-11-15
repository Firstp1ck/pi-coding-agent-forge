import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

for (const width of [390, 768]) {
  test(`More traps reverse Tab from its initial heading and releases on resize at ${width}px`, async ({ page, ownership }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${ownership.baseURL}/?mobileShell=v2&tabletShell=v2&tab=${ownership.tabs[0].id}`);
    await expect(page.locator('#chat')).toContainText('fake answer');
    await page.locator('#promptInput').fill('Retain this drawer draft');
    await page.locator('#mobileMoreButton').click();
    const surface = page.locator('#mobileShellSurface');
    await expect(page.locator('#mobileSurfaceTitle')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    expect(await surface.evaluate(node => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(surface).toBeHidden();
    await expect(page.locator('#mobileMoreButton')).toBeFocused();
    await page.locator('#mobileMoreButton').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('#mobileShellV2')).toBeHidden();
    await expect(surface).not.toHaveAttribute('aria-modal', 'true');
    await page.locator('#promptInput').focus();
    await page.keyboard.press('Tab');
    expect(await surface.evaluate(node => node.contains(document.activeElement))).toBe(false);
    await expect(page.locator('#promptInput')).toHaveValue('Retain this drawer draft');
  });
}

test('rapid keyboard resizing accumulates intended widths during the transition', async ({ page, ownership }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto(`${ownership.baseURL}/?shell=classic&tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#chat')).toContainText('fake answer');
  const handle = page.locator('#sidePanelResizeHandle');
  await expect(handle).toBeVisible();
  await handle.focus();
  const initial = Number(await handle.getAttribute('aria-valuenow'));
  const maximum = Number(await handle.getAttribute('aria-valuemax'));
  expect(initial + 240).toBeLessThanOrEqual(maximum);
  // Dispatch in one browser task so the layout cannot settle between keys.
  await handle.evaluate(node => {
    for (let index = 0; index < 3; index += 1) {
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true, cancelable: true }));
    }
  });
  await expect(handle).toHaveAttribute('aria-valuenow', String(initial + 240));
  await expect.poll(() => page.locator('#sidePanel').evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(initial + 240);
  await expect.poll(async () => (await ownership.api('/api/interface-preferences')).layout.sidePanel.panelWidths.right).toBe(initial + 240);
});
