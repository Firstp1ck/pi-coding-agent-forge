import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = app.indexOf('async function requestSessionSummaryGeneration(');
const end = app.indexOf('\nasync function openSessionSummaryForTab(', start);
assert.ok(start >= 0 && end > start);
const source = app.slice(start, end);

for (const outcome of ['success', 'failure']) {
  for (const replacement of ['none', 'authoritative state', 'new request']) {
    test(`retired summary ${outcome} preserves ${replacement}`, async () => {
      const target = { tabId: 'tab', generation: 1 };
      const newerTarget = { tabId: 'tab', generation: 2 };
      const states = new Map([['tab', { status: 'idle', configured: true }]]);
      const pending = new Map();
      let alive = true;
      let resolve, reject;
      const response = new Promise((yes, no) => { resolve = yes; reject = no; });
      const generate = vm.runInNewContext(`${source}\nrequestSessionSummaryGeneration`, {
        projectTargetFromContext: () => target,
        activeTabContext: () => ({}),
        isAliveProjectTarget: candidate => candidate === newerTarget || alive,
        sessionSummaryGenerationByTab: pending,
        sessionSummaryByTab: states,
        sessionSummaryStateForTab: tab => states.get(tab),
        updateSessionSummaryForTab: (tab, value) => { states.set(tab, value); return value; },
        SESSION_SUMMARY_PROTOCOL_VERSION: 1,
        SESSION_SUMMARY_REQUEST_TIMEOUT_MS: 1000,
        api: () => response,
        renderSessionSummaryControls() {},
        scheduleTabsRender() {},
        sessionSummaryOverlayTabId: null,
        renderSessionSummaryOverlay() {},
      });
      const settled = generate('tab').then(value => ({ value }), error => ({ error }));
      assert.equal(states.get('tab').status, 'generating');
      alive = false;
      const newerState = { status: replacement === 'new request' ? 'generating' : 'success', summaryMarkdown: 'Replacement content' };
      if (replacement !== 'none') states.set('tab', newerState);
      if (replacement === 'new request') pending.set('tab', newerTarget);
      if (outcome === 'failure') reject(new Error('Retired failure'));
      else resolve({ data: { summary: { status: 'success', summaryMarkdown: 'Retired content' } } });
      const result = await settled;
      if (outcome === 'failure') assert.equal(result.error.message, 'Retired failure');
      if (replacement === 'none') assert.equal(states.has('tab'), false);
      else assert.equal(states.get('tab'), newerState);
      if (replacement === 'new request') assert.equal(pending.get('tab'), newerTarget);
      else assert.equal(pending.has('tab'), false);
    });
  }
}
