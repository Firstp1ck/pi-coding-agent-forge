import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ serviceWorkers: 'block', video: 'off', reducedMotion: 'reduce' });

for (const width of [320, 390]) {
  test(`legacy phone file actions stay clear of the Control Deck at ${width}px`, async ({ page, ownership }, info) => {
    await writeFile(join(ownership.tabs[0].cwd, 'readme.md'), '# Fixture\nFind this text.\n');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${ownership.baseURL}/?shell=classic&mobileShell=legacy&tabletShell=legacy&tab=${ownership.tabs[0].id}`);
    await expect(page.locator('#chat')).toContainText('fake answer');
    const files = page.locator('#sidePanelSectionToggleFiles');
    if (await files.getAttribute('aria-expanded') !== 'true') await files.click();
    await page.locator('#fileTreeRoot [data-path="readme.md"]').click();
    await expect(page.locator('#fileViewerTitle')).toHaveText('readme.md');
    await page.setViewportSize({ width, height: 844 });
    await expect(page.locator('#sidePanelExpandButton')).toBeVisible();
    const actions = page.locator('#fileViewerOpenDefaultButton, #fileViewerCloseButton');
    for (const action of await actions.all()) {
      await expect(action).toBeInViewport({ ratio: 1 });
      expect(await action.evaluate(node => {
        const box = node.getBoundingClientRect();
        return [0.1, 0.5, 0.9].every(part => {
          const hit = document.elementFromPoint(box.x + box.width * part, box.y + box.height / 2);
          return hit === node || node.contains(hit);
        });
      })).toBe(true);
    }
    await page.route('**/api/files/open-default?*', route => route.fulfill({ json: { ok: true, data: { path: 'readme.md' } } }));
    const opened = page.waitForRequest(request => new URL(request.url()).pathname === '/api/files/open-default');
    await page.locator('#fileViewerOpenDefaultButton').click();
    expect((await opened).postDataJSON().path).toBe('readme.md');
    await page.screenshot({ path: info.outputPath(`file-actions-${width}.png`), animations: 'disabled' });
    await page.locator('#sidePanelExpandButton').click();
    await expect(page.locator('#sidePanel')).toBeVisible();
    await page.locator('#toggleSidePanelButton').click();
    await page.locator('#fileViewerCloseButton').click();
    await expect(page.locator('#fileViewerPane')).toBeHidden();
    await expect(page.locator('#promptInput')).toBeVisible();
  });
}
