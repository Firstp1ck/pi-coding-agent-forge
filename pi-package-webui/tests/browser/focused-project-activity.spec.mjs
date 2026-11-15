import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';
import { navigateFocused } from './focused-navigation-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
test.setTimeout(45_000);

test.beforeEach(async ({ page, ownership }) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
});

test('Project sections reveal canonical Files and Changes without losing filters or drafts', async ({ page }) => {
  await page.locator('#promptInput').fill('keep project draft');
  await navigateFocused(page, 'Project');
  const filter = page.locator('#fileTreeSearchInput');
  await filter.fill('project filter');
  await filter.evaluate(node => { window.originalFileFilter = node; });
  await page.getByRole('combobox', { name: 'Project section', exact: true }).selectOption({ label: 'Changes' });
  await expect(page.locator('#gitPanelGroups')).toBeVisible();
  await expect(page.locator('#gitPanelGroups')).not.toBeEmpty();
  expect(new URL(page.url()).searchParams.get('inspector')).toBe('git');
  await page.goBack();
  await expect(page.getByRole('combobox', { name: 'Project section', exact: true })).toHaveValue('files');
  await expect(filter).toHaveValue('project filter');
  expect(await filter.evaluate(node => node === window.originalFileFilter)).toBe(true);
  await expect(page.locator('#promptInput')).toHaveValue('keep project draft');
});

test('Activity topics preserve queue controls and Events filter through navigation and Classic restore', async ({ page }, testInfo) => {
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  await navigateFocused(page, 'Activity');
  await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: 'Queues' });
  await expect(page.locator('#createPromptListButton')).toBeVisible();
  await page.locator('#queueBox').evaluate(node => { window.originalQueue = node; });
  await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: 'Events' });
  await page.locator('#eventFilterSelect').selectOption('warnings');
  await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: 'Queues' });
  expect(await page.locator('#queueBox').evaluate(node => node === window.originalQueue)).toBe(true);
  await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: 'Events' });
  await expect(page.locator('#eventFilterSelect')).toHaveValue('warnings');
  await page.screenshot({ path: testInfo.outputPath('activity-events.png') });
  await navigateFocused(page, 'Settings');
  await page.locator('#desktopShellSelect').selectOption('classic');
  await page.locator('#sidePanelSectionToggleEvents').click();
  await expect(page.locator('#eventFilterSelect')).toBeVisible();
  await expect(page.locator('#eventFilterSelect')).toHaveValue('warnings');
  expect(await page.locator('#queueBox').evaluate(node => node === window.originalQueue)).toBe(true);
  await expect(page.locator('#sidePanelSectionEvents')).toHaveCount(1);
});


test('runner input and drafts survive destination changes and only explicit Stop ends the process', async ({ page, ownership }, testInfo) => {
  await writeFile(join(ownership.tabs[0].cwd, 'runner-test.sh'), '#!/usr/bin/env bash\nprintf "runner-ready\\n"\nwhile IFS= read -r line; do printf "echo:%s\\n" "$line"; done\n');
  await page.reload();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await page.locator('#composerActionsButton').click();
  await page.locator('#appRunnerMenuButton').click();
  await page.locator('#appRunnerMenuPanel button').filter({ hasText: 'runner-test.sh' }).first().click();
  const widget = page.locator('.app-runner-widget');
  await expect(widget).toContainText('runner-ready');
  const input = widget.locator('.app-runner-stdin-input');
  await page.route('**/api/app-runner/input?*', async route => {
    const response = await route.fetch();
    await new Promise(resolve => setTimeout(resolve, 600));
    await route.fulfill({ response });
  });
  await input.fill('submitted-line');
  await input.press('Enter');
  await expect(widget).toContainText('echo:submitted-line');
  await expect(input).toHaveValue('');
  await input.fill('second-submission');
  const acknowledged = page.waitForResponse(response => new URL(response.url()).pathname === '/api/app-runner/input');
  await input.press('Enter');
  await expect(widget).toContainText('echo:second-submission');
  await input.fill('keep stdin draft');
  await acknowledged;
  await expect(input).toHaveValue('keep stdin draft');
  await expect(widget).toContainText('echo:second-submission');
  await expect(page.locator('[data-feature-host="runners"] .app-runner-widget')).toBeVisible();
  await expect(page.locator('#widgetArea .app-runner-widget')).toHaveCount(0);
  await expect(page.locator('#appRunnerInfoButton')).toHaveCSS('opacity', '1');
  await page.locator('#appRunnerInfoButton').click();
  await expect(page.locator('#appRunnerInfoDialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('keep stdin draft');
  await page.screenshot({ path: testInfo.outputPath('runner-inspector.png') });
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  await widget.evaluate(node => { window.retainedRunnerWidget = node; });
  await navigateFocused(page, 'Settings');
  const overview = page.waitForResponse(response => new URL(response.url()).pathname === '/api/subagents');
  await ownership.api(`/api/prompt?tab=${encodeURIComponent(ownership.tabs[0].id)}`, { message: 'fixture subagents running', requestId: 'hidden-widget-refresh' });
  await overview;
  expect(await widget.evaluate(node => node === window.retainedRunnerWidget)).toBe(true);
  const hiddenRun = await ownership.api(`/api/app-runners?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  expect(hiddenRun.activeRun.status).toBe('running');
  await navigateFocused(page, 'Project');
  await page.getByRole('combobox', { name: 'Project section', exact: true }).selectOption({ label: 'Runners' });
  await expect(input).toHaveValue('keep stdin draft');
  await navigateFocused(page, 'Settings');
  await page.locator('#desktopShellSelect').selectOption('classic');
  await expect(page.locator('#widgetArea .app-runner-widget')).toBeVisible();
  await expect(input).toHaveValue('keep stdin draft');
  await widget.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(widget.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await ownership.api(`/api/app-runners?tab=${encodeURIComponent(ownership.tabs[0].id)}`)).activeRun?.status).not.toBe('running');
});
