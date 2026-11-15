import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', launchOptions: { executablePath: '/usr/bin/chromium' }, viewport: { width: 1440, height: 900 } });
test.setTimeout(45_000);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
});

async function open(page, ownership) {
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
}

async function topic(page, destination, name) {
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: destination, exact: true }).click();
  if (destination === 'Activity') await page.getByRole('combobox', { name: 'Activity section', exact: true }).selectOption({ label: name });
  else await page.getByRole('tab', { name, exact: true }).click();
}

test('custom runner configuration, discovery and process lifecycle', async ({ page, ownership }, info) => {
  const project = ownership.tabs[0].cwd;
  await mkdir(join(project, 'tools'));
  await writeFile(join(project, 'tools', 'interactive.sh'), '#!/bin/sh\nprintf "ready\\n"\nwhile IFS= read -r line; do printf "echo:%s\\n" "$line"; done\n');
  await open(page, ownership);
  await topic(page, 'Project', 'Runners');
  await page.locator('#appRunnerInfoButton').click();
  const dialog = page.locator('#appRunnerInfoDialog');
  const paths = dialog.locator('.app-runner-search-path-section');
  await paths.getByRole('button', { name: 'Browse…' }).click();
  await paths.getByRole('button', { name: 'Use tools as a project discovery path' }).click();
  await paths.getByRole('button', { name: 'Add path' }).click();
  await expect(paths.getByRole('button', { name: 'Remove project discovery path tools' })).toBeVisible();
  await paths.locator('#appRunnerSearchPathInput').fill('unused');
  await paths.getByRole('button', { name: 'Reset', exact: true }).click();
  await expect(paths.locator('#appRunnerSearchPathInput')).toHaveValue('');
  const custom = dialog.locator('.app-runner-custom-section');
  await custom.locator('#appRunnerCustomLabelInput').fill('Interactive fixture');
  await custom.locator('#appRunnerCustomCommandInput').fill('sh');
  await custom.locator('#appRunnerCustomPathInput').fill('tools/interactive.sh');
  await custom.getByRole('button', { name: 'Add runner' }).click();
  await expect(custom.locator('.app-runner-custom-item')).toContainText('Interactive fixture');
  await custom.locator('.app-runner-custom-item').getByRole('button', { name: 'Edit' }).click();
  await custom.locator('#appRunnerCustomLabelInput').fill('Edited fixture');
  await custom.getByRole('button', { name: 'Save changes' }).click();
  await expect(custom.locator('.app-runner-custom-item')).toContainText('Edited fixture');
  await page.screenshot({ path: info.outputPath('runner-config.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.locator('#appRunnerMenuPanel button').filter({ hasText: 'Edited fixture' }).first().click();
  const widget = page.locator('.app-runner-widget');
  await expect(widget).toContainText('ready');
  await widget.locator('.app-runner-stdin-input').fill('hello');
  await widget.locator('.app-runner-stdin-input').press('Enter');
  await expect(widget).toContainText('echo:hello');
  await widget.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(widget.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await page.locator('#appRunnerInfoButton').click();
  await custom.locator('.app-runner-custom-item').getByRole('button', { name: 'Delete' }).click();
  await expect(custom).toContainText('No custom runners saved');
  await paths.getByRole('button', { name: 'Remove project discovery path tools' }).click();
  await expect(paths).toContainText('No project discovery paths configured');
});

test('Agents Auto-Clear and populated retry gate render', async ({ page, ownership }, info) => {
  const tab = ownership.tabs[0].id;
  await ownership.api(`/api/prompt?tab=${encodeURIComponent(tab)}`, { message: 'fixture subagents running', requestId: 'activity-controls-gate' });
  await open(page, ownership);
  await topic(page, 'Activity', 'Agents');
  const toggle = page.locator('#subagentsAutoClearButton');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#subagentsBox')).toContainText('reviewer');
  await expect(page.locator('.subagent-gate-card')).toContainText('reviewer');
  await page.locator('#subagentLaunchSlots summary').click();
  await expect(page.locator('#subagentLaunchSlotsStatus')).not.toContainText('Loading');
  await page.screenshot({ path: info.outputPath('agents.png') });
});

test('steering queue is displayed alongside editable follow-ups', async ({ page, ownership }, info) => {
  const tab = ownership.tabs[0].id;
  await open(page, ownership);
  await topic(page, 'Activity', 'Queues');
  await ownership.api(`/api/queue/mutate?tab=${encodeURIComponent(tab)}`, { source: 'pi-runtime', kind: 'followUp', expected: { steering: ['runtime steering'], followUp: ['runtime first', 'runtime second', 'runtime third'] }, operation: { type: 'edit', index: 0, expectedText: 'runtime first', text: 'runtime first' } });
  await expect(page.locator('#queueBox')).toContainText('runtime steering');
  await expect(page.locator('#queueBox')).toContainText('runtime first');
  await page.screenshot({ path: info.outputPath('steering-queue.png') });
});

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }]) {
  test(`Classic queues and agents are reachable at ${viewport.width}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize(viewport);
    await page.goto(ownership.baseURL);
    await expect(page.locator('#modelSelect')).not.toBeEmpty();
    const expand = page.locator('#sidePanelExpandButton');
    if (await expand.isVisible()) await expand.click();
    for (const name of ['Subagents', 'Queue', 'Events']) {
      const control = page.locator(`#sidePanelSectionToggle${name}`);
      if (await control.getAttribute('aria-expanded') !== 'true') await control.click();
      await expect(control).toHaveAttribute('aria-expanded', 'true');
      await control.click();
      await expect(control).toHaveAttribute('aria-expanded', 'false');
    }
    await page.locator('#sidePanelSectionToggleSubagents').click();
    await expect(page.locator('#subagentsAutoClearButton')).toBeVisible();
    await page.screenshot({ path: info.outputPath(`agents-${viewport.width}.png`) });
    await page.locator('#toggleSidePanelButton').click();
    await expect(expand).toBeVisible();
  });
}

test('runner input failure keeps the draft and reports an event', async ({ page, ownership }) => {
  const project = ownership.tabs[0].cwd;
  await writeFile(join(project, 'fixture.sh'), '#!/bin/sh\nprintf "ready\\n"\nwhile IFS= read -r line; do printf "%s\\n" "$line"; done\n');
  await page.route('**/api/app-runner/input?*', route => route.fulfill({ status: 500, json: { ok: false, error: 'fixture input failure' } }));
  await open(page, ownership);
  await topic(page, 'Project', 'Runners');
  await page.locator('#appRunnerMenuPanel button').filter({ hasText: 'fixture.sh' }).first().click();
  const widget = page.locator('.app-runner-widget');
  await expect(widget).toContainText('ready');
  const input = widget.locator('.app-runner-stdin-input');
  await input.fill('unsent');
  await input.press('Enter');
  await expect(input).toHaveValue('unsent');
  await topic(page, 'Activity', 'Events');
  await expect(page.locator('#sidePanelSectionEvents')).toContainText('fixture input failure');
  await topic(page, 'Project', 'Runners');
  await widget.getByRole('button', { name: 'Stop', exact: true }).click();
});

test('bash commands queue behind an active command and target the originating tab', async ({ page, ownership }) => {
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/bash?*', async route => {
    calls.push({ tab: new URL(route.request().url()).searchParams.get('tab'), body: route.request().postDataJSON() });
    if (calls.length === 1) await held;
    await route.fulfill({ json: { ok: true, data: { output: 'fixture output', exitCode: 0 } } });
  });
  await open(page, ownership);
  const input = page.locator('#promptInput');
  await input.fill('!printf first');
  await page.locator('#sendButton').click();
  await expect.poll(() => calls.length).toBe(1);
  await input.fill('!printf second');
  await page.locator('#sendButton').click();
  await expect(page.locator('body')).toContainText('Queued behind the active bash command');
  release();
  await expect.poll(() => calls.length).toBe(2);
  expect(calls).toEqual([{ tab: ownership.tabs[0].id, body: { command: 'printf first', excludeFromContext: false } }, { tab: ownership.tabs[0].id, body: { command: 'printf second', excludeFromContext: false } }]);
});

test('background workflow decision stays attached to its originating tab', async ({ page, ownership }) => {
  const origin = ownership.tabs[0].id;
  const other = ownership.tabs[1].id;
  await open(page, ownership);
  await page.locator(`#tabBar [data-tab-id="${other}"] .terminal-tab-button`).click();
  const accepted = await ownership.api(`/api/prompt?tab=${encodeURIComponent(origin)}`, {
    message: 'fixture activity model decision', requestId: 'activity-background-decision',
  });
  expect(accepted.output).toBe('activity decision fixture accepted');
  await expect(page.locator(`#tabBar [data-tab-id="${origin}"] .terminal-tab-button`)).toHaveAttribute('aria-label', /Blocked/, { timeout: 16_000 });
  await page.locator(`#tabBar [data-tab-id="${origin}"] .terminal-tab-button`).click();
  await expect(page.locator('#dialogTitle')).toHaveText('Workflow model exception for fixture run');
  const reply = page.waitForResponse(response => new URL(response.url()).pathname === '/api/extension-ui-response');
  await page.getByRole('button', { name: 'Approve fixture model', exact: true }).click();
  const response = await reply;
  expect(response.ok()).toBe(true);
  expect(new URL(response.url()).searchParams.get('tab')).toBe(origin);
  expect(response.request().postDataJSON()).toEqual({ type: 'extension_ui_response', id: 'fixture-workflow-model-exception', value: 'Approve fixture model' });
  await expect(page.locator('#dialog')).toBeHidden();
});
