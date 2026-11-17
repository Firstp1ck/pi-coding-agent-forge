import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('async function followFreshConversationResponse(');
assert.ok(start >= 0);
const follow = source.slice(start, source.indexOf('\n}', start) + 2);

function fixture({ current = true, refresh } = {}) {
  const calls = [];
  const context = {
    tabs: [], activeTabId: 'source',
    syncResponseTabs(response) { context.tabs = response.data?.tabs || []; calls.push('metadata'); },
    async refreshTabs() { if (refresh) await refresh(context); },
    isCurrentTabContext() { return current && context.activeTabId === 'source'; },
    async switchTab(id) { calls.push(['switch', id]); context.activeTabId = id; },
    navigateFocusedShell(...args) { calls.push(['navigate', ...args]); },
    focusPromptInput() { calls.push('focus'); },
  };
  vm.createContext(context);
  vm.runInContext(`${follow}\nthis.follow = followFreshConversationResponse;`, context);
  return { context, calls };
}

test('fresh response follows only its still-current source after authoritative metadata', async () => {
  const { context, calls } = fixture();
  assert.equal(await context.follow({ data: { nextTabId: 'next', tabs: [{ id: 'source' }, { id: 'next' }] } }, {}), true);
  assert.deepEqual(calls, ['metadata', ['switch', 'next'], ['navigate', 'conversation', null], 'focus']);
});

test('a delayed No Project response retains its new tab without stealing navigation', async () => {
  const { context, calls } = fixture({ current: false });
  assert.equal(await context.follow({ nextTabId: 'next', data: { tabs: [{ id: 'next' }] } }, {}), true);
  assert.deepEqual(calls, ['metadata']);
  assert.equal(context.activeTabId, 'source');
});

test('navigation during missing-tab refresh prevents automatic switching', async () => {
  const { context, calls } = fixture({ refresh: async state => {
    state.activeTabId = 'chosen';
    state.tabs.push({ id: 'next' });
  } });
  assert.equal(await context.follow({ nextTabId: 'next' }, {}), true);
  assert.deepEqual(calls, ['metadata']);
  assert.equal(context.activeTabId, 'chosen');
});

test('ordinary reset responses preserve their existing handling', async () => {
  const { context, calls } = fixture();
  assert.equal(await context.follow({ success: true, data: {} }, {}), false);
  assert.deepEqual(calls, []);
});
