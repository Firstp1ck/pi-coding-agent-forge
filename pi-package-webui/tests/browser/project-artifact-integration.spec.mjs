import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
test.setTimeout(45_000);
const artifact = { schema: 'pi.artifact/v1', kind: 'document', id: 'integration-document', revisionId: 'revision-a', title: 'Project notes', pageCount: 2, manifestUrl: '/api/fixture-document-manifest' };
const image = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><text x="35" y="60" font-size="28">Project notes</text></svg>');
const manifest = { pages: [{ pageNum: 1, imageUrl: image }, { pageNum: 2, imageUrl: image }], outline: [{ title: 'Project decisions' }], renderer: { engine: 'Integration fixture' } };

async function prepare(page, ownership) {
  const requests = [];
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  // Registration and containment are covered by the HTTP harness. These routes
  // supply its public payload shape to the real transcript and canonical hosts.
  await page.route(/\/api\/messages(?:\?|$)/, async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.messages.push({ role: 'assistant', content: [{ type: 'toolCall', id: 'artifact-integration', name: 'docx_render', arguments: {} }], timestamp: Date.now() }, { role: 'toolResult', toolCallId: 'artifact-integration', toolName: 'docx_render', content: [{ type: 'text', text: 'Rendered project notes' }], details: { artifact }, timestamp: Date.now() });
    await route.fulfill({ response, json: payload });
  });
  await page.route('**/api/fixture-document-manifest?*', async route => {
    requests.push(route.request().url());
    await route.fulfill({ json: { ok: true, data: manifest } });
  });
  await page.goto(`${ownership.baseURL}/?tab=${encodeURIComponent(ownership.tabs[0].id)}`);
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await expect(page.locator('.document-artifact-card')).toBeVisible();
  return requests;
}
const rail = page => page.getByRole('navigation', { name: 'Workspace destinations' });

test('document inspector loads lazily and retains page/zoom through destinations before exact composer insertion', async ({ page, ownership }, testInfo) => {
  const requests = await prepare(page, ownership);
  expect(requests).toHaveLength(0);
  await page.locator('#promptInput').fill('Keep this draft');
  await page.locator('.document-artifact-card').getByRole('button', { name: 'Open viewer' }).click();
  const content = page.locator('.document-artifact-content');
  await expect(content.locator('.document-artifact-meta')).toContainText('Page 1 of 2');
  expect(requests).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  await content.evaluate(node => { window.canonicalArtifact = node; });
  await content.getByRole('button', { name: 'Next', exact: true }).click();
  await content.getByRole('button', { name: '+', exact: true }).click();
  await rail(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await rail(page).getByRole('button', { name: 'Project', exact: true }).click();
  await page.getByRole('tab', { name: 'Documents', exact: true }).click();
  await expect(content.locator('.document-artifact-meta')).toContainText('Page 2 of 2 · 125%');
  expect(await content.evaluate(node => node === window.canonicalArtifact)).toBe(true);
  expect(requests).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('document-inspector.png') });
  await content.getByRole('button', { name: 'Send page to composer' }).click();
  await expect(page.locator('#promptInput')).toHaveValue('Keep this draft\n\n[Document artifact integration-document revision revision-a, page 2]');
  await expect(page.locator('#focusedWorkspace')).toHaveAttribute('data-destination', 'conversation');
});

test('open document transfers to Classic dialog and explicit close permits a fresh focused open', async ({ page, ownership }, testInfo) => {
  const requests = await prepare(page, ownership);
  await page.locator('.document-artifact-card').getByRole('button', { name: 'Open viewer' }).click();
  await page.locator('.document-artifact-content').getByRole('button', { name: 'Next', exact: true }).click();
  await rail(page).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#desktopShellSelect').selectOption('classic');
  const dialog = page.getByRole('dialog', { name: 'Document artifact', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.document-artifact-meta')).toContainText('Page 2 of 2');
  await page.screenshot({ path: testInfo.outputPath('document-classic-fallback.png') });
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.locator('#sidePanelSectionToggleControls').click();
  await page.locator('#desktopShellSelect').selectOption('focused');
  await rail(page).getByRole('button', { name: 'Conversation', exact: true }).click();
  await page.locator('.document-artifact-card').getByRole('button', { name: 'Open viewer' }).click();
  await expect(page.locator('.document-artifact-meta')).toContainText('Page 1 of 2');
  expect(requests).toHaveLength(2);
});

test('a document card remains usable after switching away and returning to the same session', async ({ page, ownership }) => {
  await prepare(page, ownership);
  for (const tab of [ownership.tabs[1], ownership.tabs[0]]) {
    await page.locator(`#tabBar [data-tab-id="${tab.id}"] .terminal-tab-button`).click();
    await expect(page.locator(`#tabBar [data-tab-id="${tab.id}"] .terminal-tab-button`)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.document-artifact-card')).toBeVisible();
  }
  await page.locator('.document-artifact-card').getByRole('button', { name: 'Open viewer' }).click();
  await expect(page.locator('.document-artifact-meta')).toContainText('Page 1 of 2');
});

test('short document inspector keeps scrolling inside the loaded page', async ({ page, ownership }, info) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await prepare(page, ownership);
  await page.locator('.document-artifact-card').getByRole('button', { name: 'Open viewer' }).click();
  const inspector = page.locator('.focused-inspector-content');
  const stage = inspector.locator('.document-artifact-stage');
  await expect(stage.locator('.document-artifact-page')).toBeVisible();
  await expect.poll(() => inspector.evaluate(node => node.scrollHeight - node.clientHeight)).toBeLessThanOrEqual(1);
  await expect.poll(() => stage.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  await stage.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => stage.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
  await stage.evaluate(node => { node.scrollTop = 0; });
  await expect(stage.getByRole('button', { name: 'Send page to composer' })).toBeInViewport();
  await page.screenshot({ path: info.outputPath('document-page-scroll.png') });
});
