import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

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
