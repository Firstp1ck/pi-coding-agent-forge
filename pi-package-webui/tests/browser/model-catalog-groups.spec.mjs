import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', reducedMotion: 'reduce' });

const catalog = [
  { provider: 'zeta', id: 'long-model-name-for-context-window-and-provider-layout', name: 'Zeta Model' },
  { provider: 'fake', id: 'fake-model', name: 'Z Current Model' },
  { provider: 'alpha', id: 'undated', name: 'Alpha Undated' },
  { provider: 'alpha', id: 'old', name: 'Alpha Old', releaseDate: '2024-01-01' },
  { provider: 'fake', id: 'fake-model-alt', name: 'Alternate Model' },
  { provider: 'alpha', id: 'new', name: 'Zulu New', release_date: '2026-10-15' },
];

async function openCatalog(page, ownership, models = catalog) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.route('**/api/models?*', route => route.fulfill({ json: { ok: true, data: { models } } }));
  await page.goto(ownership.baseURL);
  await expect(page.locator('.focused-composer-model-value')).toContainText('fake-model');
  await page.locator('#promptInput').fill('Keep this model-picker draft');
  await page.locator('.focused-composer-controls').getByRole('button', { name: /^Model:/ }).click();
  await expect(page.locator('#nativeCommandTitle')).toHaveText('Choose model');
  await expect(page.locator('#nativeSelectorList').getByRole('option')).toHaveCount(models.length);
}

for (const width of [1440, 1100]) {
  test(`provider hierarchy, release order and search preserve context at ${width}px`, async ({ page, ownership }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await openCatalog(page, ownership);
    if (width === 1100) await page.locator('#nativeCommandDialog').evaluate(node => { node.style.width = '500px'; });
    const list = page.locator('#nativeSelectorList');
    await expect(list.getByRole('group')).toHaveCount(3);
    expect(await list.getByRole('group').evaluateAll(groups => groups.map(group => group.getAttribute('aria-label')))).toEqual(['alpha', 'fake', 'zeta']);
    expect(await list.getByRole('group', { name: 'alpha', exact: true }).locator('.native-selector-title strong').allTextContents()).toEqual(['alpha/new', 'alpha/old', 'alpha/undated']);
    expect(await list.getByRole('group', { name: 'fake', exact: true }).locator('.native-selector-title strong').allTextContents()).toEqual(['fake/fake-model-alt', 'fake/fake-model']);
    await expect(list.getByRole('option', { name: /fake\/fake-model current/i })).toHaveAttribute('aria-selected', 'true');
    await expect(list.getByRole('option', { name: /alpha\/new/ })).toContainText('2026-10-15');
    await expect.poll(() => page.locator('#nativeCommandDialog').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await page.locator('#nativeCommandSearch').press('Home');
    await expect(list.locator('.keyboard-active')).toContainText('alpha/new');
    const firstGroup = list.getByRole('group', { name: 'alpha', exact: true });
    const heading = await firstGroup.locator('.native-selector-group').boundingBox();
    const firstTitle = await firstGroup.locator('.native-selector-title').first().boundingBox();
    expect(firstTitle.y).toBeGreaterThanOrEqual(heading.y + heading.height);
    await page.screenshot({ path: info.outputPath('provider-model-hierarchy.png') });
    const search = page.locator('#nativeCommandSearch');
    await search.fill('zulu');
    await expect(list.getByRole('group')).toHaveCount(1);
    await expect(list.getByRole('group', { name: 'alpha', exact: true })).toBeVisible();
    await expect(list.getByRole('option')).toHaveCount(1);
    await search.fill('zeta');
    await expect(list.getByRole('group', { name: 'zeta', exact: true })).toBeVisible();
    await search.fill('no-match-fixture');
    await expect(page.locator('#nativeCommandBody')).toContainText('No models match');
    await search.fill('');
    await expect(list.getByRole('group')).toHaveCount(3);
    await page.keyboard.press('Escape');
    await expect(page.locator('#promptInput')).toHaveValue('Keep this model-picker draft');
  });
}

test('keyboard skips provider headings and applies the exact originating model', async ({ page, ownership }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openCatalog(page, ownership);
  const search = page.locator('#nativeCommandSearch');
  await search.fill('fake');
  await search.press('ArrowDown');
  await expect(page.locator('#nativeSelectorList .keyboard-active')).toContainText('fake/fake-model');
  await search.press('ArrowUp');
  await expect(page.locator('#nativeSelectorList .keyboard-active')).toContainText('fake/fake-model-alt');
  const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/model' && result.request().method() === 'POST');
  await search.press('Enter');
  const result = await response;
  expect(new URL(result.url()).searchParams.get('tab')).toBe(ownership.tabs[0].id);
  await expect(page.locator('#nativeCommandDialog')).toBeHidden();
  await expect.poll(async () => (await ownership.api('/api/state?tab=' + ownership.tabs[0].id)).model.id).toBe('fake-model-alt');
  await expect(page.locator('#promptInput')).toHaveValue('Keep this model-picker draft');
});


test('wrapped provider headings leave keyboard targets readable at 320px', async ({ page, ownership }, info) => {
  const provider = 'vendor-with-a-custom-provider-name-with-regional-routing-and-version-2026';
  const models = [...catalog, ...Array.from({ length: 30 }, (_, i) => ({
    provider, id: `model-${String(i).padStart(2, '0')}`, name: `Model ${i}`,
  }))];
  await page.setViewportSize({ width: 1440, height: 800 });
  await openCatalog(page, ownership, models);
  await page.setViewportSize({ width: 320, height: 800 });
  const search = page.locator('#nativeCommandSearch');
  await search.fill('');
  await search.press('End');
  const group = page.getByRole('group', { name: provider, exact: true });
  for (let i = 0; i < 30; i++) await search.press('ArrowUp');
  await expect(group.locator('.keyboard-active')).toContainText(`${provider}/model-00`);
  const heading = await group.locator('.native-selector-group').boundingBox();
  const title = await group.locator('.keyboard-active .native-selector-title').boundingBox();
  const body = await page.locator('#nativeCommandBody').boundingBox();
  expect(title.y).toBeGreaterThanOrEqual(heading.y + heading.height);
  expect(title.y).toBeGreaterThanOrEqual(body.y);
  expect(title.y + title.height).toBeLessThanOrEqual(body.y + body.height);
  await expect.poll(() => page.locator('#nativeCommandBody').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: info.outputPath('wrapped-provider-keyboard.png') });
});
