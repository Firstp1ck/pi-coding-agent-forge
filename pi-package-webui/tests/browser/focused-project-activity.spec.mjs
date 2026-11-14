import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
test.setTimeout(45_000);

test.beforeEach(async ({ page, ownership }) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
});

test('Project topics reveal canonical Files and Changes without losing filters or drafts', async ({ page }) => {
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  await page.locator('#promptInput').fill('keep project draft');
  await rail.getByRole('button', { name: 'Project', exact: true }).click();
  const filter = page.locator('#fileTreeSearchInput');
  await filter.fill('project filter');
  await filter.evaluate(node => { window.originalFileFilter = node; });
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
  await expect(page.locator('#gitPanelGroups')).toBeVisible();
  await expect(page.locator('#gitPanelGroups')).not.toBeEmpty();
  expect(new URL(page.url()).searchParams.get('inspector')).toBe('git');
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(filter).toHaveValue('project filter');
  expect(await filter.evaluate(node => node === window.originalFileFilter)).toBe(true);
  await expect(page.locator('#promptInput')).toHaveValue('keep project draft');
});

test('Activity topics preserve queue controls and Events filter through navigation and Classic restore', async ({ page }, testInfo) => {
  const rail = page.getByRole('navigation', { name: 'Workspace destinations' });
  await rail.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('tab', { name: 'Queues', exact: true }).click();
  await expect(page.locator('#createPromptListButton')).toBeVisible();
  await page.locator('#queueBox').evaluate(node => { window.originalQueue = node; });
  await page.getByRole('tab', { name: 'Events', exact: true }).click();
  await page.locator('#eventFilterSelect').selectOption('warnings');
  await page.getByRole('tab', { name: 'Queues', exact: true }).click();
  expect(await page.locator('#queueBox').evaluate(node => node === window.originalQueue)).toBe(true);
  await page.getByRole('tab', { name: 'Events', exact: true }).click();
  await expect(page.locator('#eventFilterSelect')).toHaveValue('warnings');
  await page.screenshot({ path: testInfo.outputPath('activity-events.png') });
  await rail.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#desktopShellSelect').selectOption('classic');
  await page.locator('#sidePanelSectionToggleEvents').click();
  await expect(page.locator('#eventFilterSelect')).toBeVisible();
  await expect(page.locator('#eventFilterSelect')).toHaveValue('warnings');
  expect(await page.locator('#queueBox').evaluate(node => node === window.originalQueue)).toBe(true);
  await expect(page.locator('#sidePanelSectionEvents')).toHaveCount(1);
});
