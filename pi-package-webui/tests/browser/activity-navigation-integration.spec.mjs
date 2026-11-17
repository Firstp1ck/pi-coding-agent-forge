import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';
import { navigateFocused } from './focused-navigation-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

for (const width of [1100, 1440]) {
  test(`Activity sections remain reachable without sideways scrolling at ${width}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height: 700 });
    await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', inspectorWidth: 240 })));
    await page.goto(ownership.baseURL);
    await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
    await page.locator('#promptInput').fill('Keep this draft through Activity');
    await navigateFocused(page, 'Activity');
    const picker = page.getByRole('combobox', { name: 'Activity section', exact: true });
    await expect(picker).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Inspector topics' })).toBeHidden();
    const ids = await picker.locator('option').evaluateAll(options => options.map(option => option.value));
    expect(ids.slice().sort()).toEqual(['subagents', 'queue', 'progress', 'conversations', 'extensions', 'events', 'codex-usage', 'claude-usage', 'session', 'sampling', 'commands'].sort());
    await picker.evaluate(node => { window.originalActivityPicker = node; });
    for (const id of ids) {
      await picker.selectOption(id);
      await expect(picker).toHaveValue(id);
      await expect.poll(() => new URL(page.url()).searchParams.get('inspector')).toBe(id);
      await expect(page.locator('#focusedWorkspaceInspectorPanel')).toHaveAttribute('role', 'region');
      await expect.poll(() => picker.evaluate(node => node.closest('aside').scrollWidth - node.closest('aside').clientWidth)).toBeLessThanOrEqual(1);
    }
    expect(await picker.evaluate(node => node === window.originalActivityPicker)).toBe(true);
    await picker.selectOption('queue');
    await expect(page.locator('#createPromptListButton')).toBeVisible();
    await picker.selectOption('events');
    await page.locator('#eventFilterSelect').selectOption('warnings');
    await page.goBack();
    await expect(picker).toHaveValue('queue');
    await expect(page.locator('#createPromptListButton')).toBeVisible();
    await page.goForward();
    await expect(picker).toHaveValue('events');
    await expect(page.locator('#eventFilterSelect')).toHaveValue('warnings');
    await page.screenshot({ path: info.outputPath('activity-section-picker.png') });
    await navigateFocused(page, 'Project');
    await expect(picker).toBeHidden();
    await expect(page.getByRole('combobox', { name: 'Project section', exact: true })).toHaveValue('files');
    await expect(page.locator('#promptInput')).toHaveValue('Keep this draft through Activity');
  });
}
