import { expect } from '@playwright/test';
import { test } from './session-fixture.mjs';

test.use({ video: 'off', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
async function openOverview(page, ownership) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused', overviewOpen: true })));
  await page.goto(ownership.baseURL);
  await expect(page.locator('#chat')).toContainText('fake answer');
  return page.getByRole('region', { name: 'Conversation overview', exact: true });
}
function agentRow(overview) {
  return overview.locator('.conversation-overview-item').filter({ has: overview.page().locator('.conversation-overview-label', { hasText: /^Agents$/ }) });
}

test('external agents stay outside selected-session overview counts', async ({ page, ownership }, info) => {
  const data = {
    version: 2, available: true, updatedAt: Date.now(),
    tabs: ownership.tabs.map((tab, index) => ({ tabId: tab.id, tabIndex: index + 1, available: true, runs: [], gates: [] })),
    groups: [
      ...ownership.tabs.map(tab => ({ id: `tab:${tab.id}`, kind: 'tab', tabId: tab.id, runs: [], gates: [] })),
      { id: 'external', kind: 'external', title: 'External agents', gates: [], runs: [
        { id: 'outside', status: 'running', agents: [{ id: 'outside-agent', name: 'outside-agent', status: 'running', model: 'fixture/model' }] },
      ] },
    ],
  };
  await page.route('**/api/subagents*', route => route.fulfill({ json: { ok: true, data } }));
  const overview = await openOverview(page, ownership);
  const row = agentRow(overview);
  await expect(row).toContainText('0 running · 0 total');
  await expect(overview.locator('.conversation-overview-title')).toHaveText('Thread 1');
  await page.screenshot({ path: info.outputPath('external-excluded-from-terminal-1.png') });
  await page.locator(`#tabBar [data-tab-id="${ownership.tabs[1].id}"] .terminal-tab-button`).click();
  await expect(overview.locator('.conversation-overview-title')).toHaveText('Thread 2');
  await expect(row).toContainText('0 running · 0 total');
  await info.attach('ownership evidence', { body: JSON.stringify({ input: data, actual: await row.innerText() }, null, 2), contentType: 'application/json' });
});

test('unavailable agent reporting is distinct from an empty session', async ({ page, ownership }, info) => {
  const overview = await openOverview(page, ownership);
  const data = await ownership.api('/api/subagents');
  expect(data.available).toBe(false);
  expect(data.tabs.every(tab => tab.available === false)).toBe(true);
  await expect(agentRow(overview)).toContainText('Reporting unavailable');
  await info.attach('ownership evidence', { body: JSON.stringify({ input: data, actual: await agentRow(overview).innerText() }, null, 2), contentType: 'application/json' });
});
