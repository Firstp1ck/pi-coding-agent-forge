import { navigateFocused } from './focused-navigation-fixture.mjs';
import { expect } from '@playwright/test';
import { OPTIONAL_FEATURE_CATALOG } from '../../lib/optional-feature-catalog.mjs';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 }, launchOptions: { executablePath: '/usr/bin/chromium' } });

const ready = { state: 'registered', installed: true, configured: true, ready: true };
function snapshot(overrides = {}, extra = {}) {
  return { revision: 'display-test', phase: 'ready', installKind: 'fresh', summary: {},
    features: OPTIONAL_FEATURE_CATALOG.map(feature => ({ ...feature, ...ready, ...overrides[feature.featureId] })), ...extra };
}
async function openFeatures(page, ownership, response) {
  await page.route('**/api/**', route => {
    if (['GET', 'HEAD'].includes(route.request().method()) || new URL(route.request().url()).pathname === '/api/interface-preferences') return route.fallback();
    return route.fulfill({ status: 409, json: { ok: false, error: 'Mutation blocked by test' } });
  });
  await page.route('**/api/optional-features', route => route.fulfill(response));
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(`${ownership.baseURL}/?tab=${ownership.tabs[0].id}`);
  await navigateFocused(page, 'Settings');
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'Features', exact: true }).click();
}
const ok = data => ({ json: { ok: true, data } });
const toolbar = page => page.locator('.optional-feature-batch-toolbar');

test('mixed states disclose excluded features without changing batch eligibility', async ({ page, ownership }, info) => {
  await openFeatures(page, ownership, ok(snapshot({
    bangCommandAutocomplete: { state: 'unknown', installed: true, configured: false, ready: false },
    fishUserBash: { state: 'missing', installed: false, configured: false, ready: false },
    btwCommand: { state: 'conflict', resourceConflict: true },
    releaseNpm: { state: 'update-available', updateAvailable: true },
    releaseAur: { state: 'disabled' },
  })));
  await expect(toolbar(page)).toContainText('1 eligible for bulk install');
  await expect(toolbar(page)).toContainText('registration needed');
  for (const reason of ['conflicts', 'updates', 'disabled features']) await expect(toolbar(page)).toContainText(reason);
  await expect(toolbar(page).getByRole('button', { name: /Install all optional features.*registration needed/ })).toBeEnabled();
  const firstSection = page.locator('.optional-feature-section').first();
  await expect(firstSection.getByRole('button', { name: /Install missing features.*registration needed/ })).toBeEnabled();
  await expect(page.locator('[data-settings-feature="bangCommandAutocomplete"]')).toContainText('Registration needed');
  await page.screenshot({ path: info.outputPath('mixed.png'), animations: 'disabled' });
});

test('only established ready states get all-ready language', async ({ page, ownership }) => {
  await openFeatures(page, ownership, ok(snapshot()));
  await expect(toolbar(page)).toContainText('All features are registered or available locally');
  await expect(toolbar(page).getByRole('button', { name: /All features are registered/ })).toBeDisabled();
  await expect(page.locator('.optional-feature-section').first().getByRole('button', { name: /All features are registered/ })).toBeDisabled();
});

test('disabled and unknown-only states explain why no bulk action is offered', async ({ page, ownership }) => {
  await openFeatures(page, ownership, ok(snapshot(Object.fromEntries(OPTIONAL_FEATURE_CATALOG.map((f, i) => [f.featureId, i ? { state: 'disabled' } : { state: 'unknown', installed: false, configured: false }])))));
  await expect(toolbar(page)).toContainText('disabled features');
  await expect(toolbar(page)).toContainText('unknown status');
  await expect(toolbar(page).getByRole('button', { name: /unknown status/ })).toBeDisabled();
  await expect(toolbar(page)).not.toContainText('All features are registered');
});

test('disabled-only features are not described as all ready', async ({ page, ownership }) => {
  await openFeatures(page, ownership, ok(snapshot(Object.fromEntries(OPTIONAL_FEATURE_CATALOG.map(f => [f.featureId, { state: 'disabled' }])))));
  await expect(toolbar(page).getByRole('button', { name: /disabled features/ })).toBeDisabled();
  await expect(toolbar(page)).not.toContainText('All features are registered');
});

test('a failed individual install remains visible in the bulk explanation', async ({ page, ownership }) => {
  await openFeatures(page, ownership, ok(snapshot({}, { phase: 'partial', progress: {
    phase: 'partial', migration: true, total: 1, completed: 1, succeeded: 0, failed: 1,
    results: [{ featureId: 'bangCommandAutocomplete', ok: false, message: 'fixture install failed', kind: 'network' }],
  } })));
  await expect(toolbar(page)).toContainText('failed installs');
  await expect(toolbar(page).getByRole('button', { name: /failed installs/ })).toBeDisabled();
});

for (const [name, response, expected] of [
  ['checking', ok(snapshot({}, { phase: 'checking' })), 'Checking optional features'],
  ['error', { status: 503, json: { ok: false, error: 'fixture unavailable' } }, 'Package status check failed'],
]) {
  test(`${name} state has an accurate accessible explanation`, async ({ page, ownership }) => {
    await openFeatures(page, ownership, response);
    await expect(toolbar(page)).toContainText(expected);
    await expect(toolbar(page).getByRole('button', { name: new RegExp(expected) })).toBeDisabled();
    await expect(page.locator('.optional-feature-section').first().getByRole('button', { name: new RegExp(expected) })).toBeDisabled();
  });
}
