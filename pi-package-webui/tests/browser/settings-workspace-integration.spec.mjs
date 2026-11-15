import { navigateFocused } from './focused-navigation-fixture.mjs';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test } from './session-fixture.mjs';

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block', video: 'off' });
const settings = page => page.locator('.settings-workspace');
const category = (page, name) => settings(page).getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name, exact: true });
async function open(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await navigateFocused(page, 'Settings');
}

test('Settings retains canonical administration controls, light/narrow layout and accessible navigation', async ({ page, ownership }, info) => {
  await open(page, ownership);
  for (const [name, selector] of [
    ['Appearance', '#desktopShellSelect'], ['Features', '#optionalFeaturesBox'],
    ['System', '#serverActionSelect'], ['Help', '#openIssueButton'],
  ]) {
    await category(page, name).click();
    await expect(settings(page).locator(selector)).toBeVisible();
    await expect(page.locator(selector)).toHaveCount(1);
  }
  await category(page, 'Models and resources').click();
  await expect(settings(page).getByRole('button', { name: 'Tools', exact: true })).toBeVisible();
  await expect(settings(page).getByRole('button', { name: 'Skills', exact: true })).toBeVisible();
  await category(page, 'Accounts').click();
  await expect(settings(page).getByRole('button', { name: 'Provider login', exact: true })).toBeVisible();
  await expect(settings(page).getByRole('button', { name: 'Provider logout', exact: true })).toBeVisible();
  await category(page, 'Appearance').click();
  await page.locator('#themeSchemeToggle [data-scheme-mode=light]').click();
  await page.screenshot({ path: info.outputPath('settings-light-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.locator("html")).toHaveAttribute("data-desktop-shell", "focused");
  await expect(settings(page)).toBeVisible();
  const overflow = await settings(page).evaluate(root => [...root.querySelectorAll('input,select,button')]
    .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
    .filter(node => { const rect = node.getBoundingClientRect(); return rect.left < 0 || rect.right > innerWidth + 1; })
    .map(node => node.id || node.textContent));
  expect(overflow).toEqual([]);
  await page.screenshot({ path: info.outputPath('settings-light-narrow.png'), animations: 'disabled' });
  const audit = await new AxeBuilder({ page }).include('.settings-workspace').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
});

test('Voice Settings loads on entry and rejects an old tab list and detached voice action', async ({ page, ownership }) => {
  let releaseOld;
  let held = false;
  let holdNext = false;
  const oldReply = new Promise(resolve => { releaseOld = resolve; });
  const writes = [];
  const voicePayload = id => ({ ok: true, data: { voices: [{ id, downloaded: true, current: false }] } });
  await page.route('**/api/conversation-voices?*', async route => {
    const tab = new URL(route.request().url()).searchParams.get('tab');
    if (tab === ownership.tabs[0].id && holdNext) {
      holdNext = false; held = true;
      await oldReply;
      await route.fulfill({ json: voicePayload('en_US-retired-medium') });
    } else await route.fulfill({ json: voicePayload(tab === ownership.tabs[0].id ? 'en_US-original-medium' : 'en_US-peer-medium') });
  });
  await page.route('**/api/conversation-voice?*', async route => { writes.push(route.request().postData()); await route.fulfill({ json: voicePayload('en_US-unexpected-medium') }); });
  await open(page, ownership);
  await category(page, 'Voice').click();
  const original = page.locator('#conversationVoiceMenuPanel [data-voice-id="en_US-original-medium"]');
  await expect(original).toBeVisible();
  const retained = await original.elementHandle();
  await category(page, 'Appearance').click();
  holdNext = true;
  await category(page, 'Voice').click();
  await expect.poll(() => held).toBe(true);
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-button`).click();
  await expect(page.locator('#conversationVoiceMenuPanel [data-voice-id="en_US-peer-medium"]')).toBeVisible();
  releaseOld();
  await expect.poll(async () => page.locator('#conversationVoiceMenuPanel [data-voice-id]').evaluateAll(nodes => nodes.map(node => node.dataset.voiceId))).toEqual(['en_US-peer-medium']);
  await retained.evaluate(node => node.click());
  expect(writes).toEqual([]);
  await expect(page.locator('#conversationVoiceMenuPanel [data-voice-id="en_US-retired-medium"]')).toHaveCount(0);
});

test('disabled Tools and Skills retain explicit Setup through cards and search', async ({ page, ownership }) => {
  await page.addInitScript(() => localStorage.setItem('pi-webui-optional-features-disabled', JSON.stringify(['tuiToolsCommand', 'tuiSkillsCommand'])));
  await page.route('**/api/commands?*', route => route.fulfill({ json: { ok: true, data: { commands: [
    { name: 'tools', source: 'extension', description: 'Tools' },
    { name: 'skills', source: 'extension', description: 'Skills' },
  ] } } }));
  await open(page, ownership);
  for (const label of ['Tools', 'Skills']) {
    await category(page, 'Models and resources').click();
    await settings(page).getByRole('button', { name: label, exact: true }).click();
    await expect(page.locator('#nativeCommandDialog')).toBeVisible();
    await expect(page.locator('#nativeCommandTitle')).toHaveText(`${label} Setup`);
    await page.keyboard.press('Escape');
    await category(page, 'Features').click();
    const row = page.locator(`[data-settings-feature="tui${label}Command"]`);
    await expect(row).toContainText('Disabled');
    await expect(row.getByRole('button', { name: `Set up TUI ${label} command`, exact: true })).toBeEnabled();
    await settings(page).getByRole('searchbox', { name: 'Search settings', exact: true }).fill(label);
    const result = settings(page).getByRole('list', { name: 'Settings search results' }).getByRole('listitem').filter({ has: page.getByText(label, { exact: true }) });
    await result.getByRole('button', { name: new RegExp(`^${label}\\s`) }).click();
    await expect(page.locator('#nativeCommandDialog')).toBeVisible();
    await expect(page.locator('#nativeCommandTitle')).toHaveText(`${label} Setup`);
    await page.keyboard.press('Escape');
  }
});

test('empty Voice Settings explains shared persistence and restores popup semantics', async ({ page, ownership }, info) => {
  await page.route('**/api/conversation-voices?*', route => route.fulfill({ json: { ok: true, data: { voices: [] } } }));
  await open(page, ownership);
  await settings(page).getByRole('searchbox', { name: 'Search settings', exact: true }).fill('Conversation voice');
  const result = settings(page).getByRole('listitem').filter({ hasText: 'Conversation voice' });
  await expect(result).toContainText('Shared Pi voice configuration');
  await result.getByRole('button').click();
  const panel = page.locator('#conversationVoiceMenuPanel');
  await expect(panel).toHaveAttribute('role', 'group');
  await expect(panel.getByRole('button', { name: 'No Piper voices — run /talk setup', exact: true })).toBeVisible();
  await expect(settings(page)).toContainText('saved in the shared Pi voice configuration for future sessions');
  const audit = await new AxeBuilder({ page }).include('.settings-workspace').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
  await page.screenshot({ path: info.outputPath('settings-empty-voice.png'), animations: 'disabled' });
  await category(page, 'Appearance').click();
  await expect(panel).toHaveAttribute('role', 'menu');
  await expect(panel.locator('button')).toHaveAttribute('role', 'menuitem');
  await category(page, 'Voice').click();
  await expect(panel).toHaveAttribute('role', 'group');
  await category(page, 'Appearance').click();
  await page.locator('#desktopShellSelect').selectOption('classic');
  await expect(page.locator('#focusedWorkspace')).toBeHidden();
  await expect(panel).toHaveAttribute('role', 'menu');
});
