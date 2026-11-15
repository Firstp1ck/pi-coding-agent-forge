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
  await page.getByRole('navigation', { name: 'Workspace destinations' }).getByRole('button', { name: 'Settings', exact: true }).click();
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
