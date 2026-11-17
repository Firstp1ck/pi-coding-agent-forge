import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const start = source.indexOf('function nativeSessionChoiceOwner(');
const end = source.indexOf('\nasync function openNativeModelSelector', start);
assert.ok(start > 0 && end > start);

function fixture() {
  let resolve;
  let reject;
  const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
  const calls = [];
  const applied = [];
  const errors = [];
  const attributes = new Map();
  const body = { inert: false, setAttribute: (key, value) => attributes.set(key, value), removeAttribute: key => attributes.delete(key) };
  const dialog = { open: true };
  const target = { tabId: 'origin', generation: 1 };
  let targetCurrent = true;
  const context = vm.createContext({
    nativeCommandDialogGeneration: 0, nativeCommandTabId: null,
    elements: { nativeCommandBody: body, nativeCommandDialog: dialog, nativeCommandSearch: { disabled: false } },
    projectTargetFromContext: () => target,
    isCurrentProjectTarget: value => value === target && targetCurrent,
    openNativeCommandDialog: () => ++context.nativeCommandDialogGeneration,
    nativeCommandApi: (path, options) => { calls.push({ path, options }); return pending; },
    closeNativeCommandDialog: () => { dialog.open = false; context.nativeCommandDialogGeneration++; },
    refreshState: async value => { calls.push({ refresh: value }); },
    setNativeCommandError: value => errors.push(value),
  });
  vm.runInContext(source.slice(start, end), context);
  const owner = context.nativeSessionChoiceOwner({ title: 'Model' });
  return { owner, calls, applied, errors, body, dialog, attributes, context, resolve, reject,
    invalidate: () => { targetCurrent = false; },
    apply: () => owner.apply('/api/model', { provider: 'fixture', modelId: 'second' }, value => applied.push(value)),
  };
}

test('one choice dispatches once to the captured tab and closes only after success', async () => {
  const f = fixture();
  const first = f.apply();
  await f.apply();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.tabId, 'origin');
  assert.equal(f.body.inert, true);
  f.resolve({ data: { id: 'second' } });
  await first;
  assert.deepEqual(f.applied, [{ id: 'second' }]);
  assert.equal(f.dialog.open, false);
  assert.equal(f.calls[1].refresh.tabId, 'origin');
});

test('failure stays in the picker and restores retry controls', async () => {
  const f = fixture();
  const request = f.apply();
  f.reject(new Error('Provider unavailable'));
  await request;
  assert.equal(f.dialog.open, true);
  assert.equal(f.body.inert, false);
  assert.equal(f.attributes.has('aria-busy'), false);
  assert.equal(f.context.elements.nativeCommandSearch.disabled, false);
  assert.equal(f.errors.at(-1), 'Provider unavailable');
  await f.apply();
  assert.equal(f.calls.length, 2);
  assert.equal(f.applied.length, 0);
});

for (const outcome of ['success', 'failure']) {
  test(`late ${outcome} cannot update or close a replacement dialog`, async () => {
    const f = fixture();
    const request = f.apply();
    f.context.nativeCommandDialogGeneration++;
    f.body.inert = false;
    if (outcome === 'success') f.resolve({ data: { id: 'second' } });
    else f.reject(new Error('Old failure'));
    await request;
    assert.equal(f.dialog.open, true);
    assert.equal(f.body.inert, false);
    assert.equal(f.applied.length, 0);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.errors, ['']);
  });
}

test('same-tab session replacement prevents both old dispatch and late completion', async () => {
  const old = fixture();
  old.invalidate();
  await old.apply();
  assert.equal(old.calls.length, 0);
  assert.match(old.errors.at(-1), /session changed/);
  const pending = fixture();
  const request = pending.apply();
  pending.invalidate();
  pending.resolve({ data: { id: 'second' } });
  await request;
  assert.equal(pending.applied.length, 0);
  assert.equal(pending.dialog.open, true);
  assert.equal(pending.calls.length, 1);
});
