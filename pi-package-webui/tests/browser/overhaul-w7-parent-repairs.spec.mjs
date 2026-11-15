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

for (const outcome of ['success', 'failure']) {
  test(`retired summary ${outcome} releases busy state after same-tab replacement`, async ({ page, ownership }, testInfo) => {
    const tabId = ownership.tabs[0].id;
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
    await page.route('**/api/commands?*', route => route.fulfill({ json: { ok: true, data: { commands: [{ name: 'summary', source: 'extension' }, { name: 'summary-setup', source: 'extension' }] } } }));
    await page.route('**/api/session-summary/preferences?*', route => route.fulfill({ json: { ok: true, data: { preferences: { configured: true, enabled: false }, summary: { version: 1, status: 'idle', configured: true, enabled: false, durable: false } } } }));
    let release;
    let requests = 0;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/session-summary/generate?*', async route => {
      const first = ++requests === 1;
      if (first) await gate;
      if (first && outcome === 'failure') return route.fulfill({ status: 500, json: { ok: false, error: 'Retired generation failure' } });
      await route.fulfill({ json: { ok: true, data: { summary: { version: 1, status: 'success', configured: true, title: first ? 'OLD TARGET' : 'NEW TARGET', summaryMarkdown: first ? 'Old target result' : 'Replacement result' } } } });
    });
    try {
      await page.goto(`${ownership.baseURL}/?tab=${tabId}`);
      await expect(page.locator('#chat')).toContainText('fake answer');
      await expect(page.locator('#eventLog')).toContainText('connected to');
      const initial = (await ownership.api(`/api/state?tab=${tabId}`)).sessionId;
      const button = page.locator(`#tabBar [data-tab-id="${tabId}"] .terminal-tab-summary-button`);
      await button.click();
      await expect.poll(() => requests).toBe(1);
      await expect(button).toBeDisabled();
      await page.locator('#sessionSummaryOverlayCloseButton').click();
      await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'All tools', exact: true }).click();
      await page.locator('#shellToolsLauncher').getByRole('button', { name: 'New session', exact: true }).click();
      await expect(page.locator('#confirmationDialog')).toBeVisible();
      const replacement = page.waitForResponse(response => new URL(response.url()).pathname === '/api/new-session');
      await page.locator('#confirmationConfirmButton').click();
      expect((await replacement).ok()).toBe(true);
      await expect.poll(async () => (await ownership.api(`/api/state?tab=${tabId}`)).sessionId).not.toBe(initial);
      await expect(page.locator('#confirmationDialog')).toBeHidden();
      const completion = page.waitForResponse(response => new URL(response.url()).pathname === '/api/session-summary/generate');
      release();
      await completion;
      await expect(button).toBeEnabled();
      await expect(button).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#sessionSummaryOverlay')).not.toContainText('OLD TARGET');
      await button.click();
      await expect(page.locator('#sessionSummaryOverlay')).toContainText('NEW TARGET');
      await expect(page.locator('#sessionSummaryOverlay')).toContainText('Replacement result');
      await expect(button).toBeEnabled();
      expect(requests).toBe(2);
      await page.screenshot({ path: testInfo.outputPath(`summary-${outcome}-recovered.png`), animations: 'disabled' });
    } finally { release(); }
  });
}
