import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { verificationSlots } from '../release/batch.mjs';
import { monitorPublication } from '../release/monitor.mjs';

await test('probe slots bound active work and monitor deadlines include queue time', async () => {
  const slot = verificationSlots(1);
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const running = slot(() => { entered(); return new Promise(resolve => { release = resolve; }); });
  await ready;
  let queuedStarted = false;
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal(await monitorPublication(signal => slot(() => { queuedStarted = true; return true; }, signal), { timeout: 30 }), false);
    assert.equal(queuedStarted, false, 'an expired queued probe never runs');
    release(true); await running;
    assert.equal(await slot(() => true), true, 'expiry does not poison the queue');
    assert.equal(queuedStarted, false);
  } finally { clearInterval(keepAlive); release?.(true); await running; }
});

await test('cancellation rejects queued probes and drains in-flight work before slot reuse', async () => {
  const slot = verificationSlots(1), controller = new AbortController();
  let entered, active = 0, peak = 0, queuedStarted = false;
  const ready = new Promise(resolve => { entered = resolve; });
  const running = slot(async signal => {
    peak = Math.max(peak, ++active); entered();
    try { await delay(10_000, undefined, { signal }); }
    finally { active--; }
  }, controller.signal);
  await ready;
  const queued = slot(() => { queuedStarted = true; }, controller.signal);
  const results = Promise.allSettled([running, queued]);
  controller.abort(new Error('test cancellation'));
  assert.ok((await results).every(item => item.status === 'rejected'));
  assert.equal(queuedStarted, false); assert.equal(active, 0); assert.equal(peak, 1);
  await slot(() => { assert.equal(active, 0); });
  await assert.rejects(slot(() => assert.fail('pre-cancelled probe ran'), controller.signal));
});

await test('probe failures release capacity and simultaneous callers share the configured bound', async () => {
  const slot = verificationSlots(2);
  let active = 0, peak = 0;
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => slot(async () => {
    peak = Math.max(peak, ++active);
    try { await delay(5); if (index === 2) throw new Error('fixture failure'); return index; }
    finally { active--; }
  })));
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
});
