import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monitorPublication } from '../release/monitor.mjs';
import { CommandError } from '../release/process.mjs';

const registryError = code => new CommandError('registry error', { stdout: JSON.stringify({ error: { code } }), stderr: '' });

await test('monitor waits with capped backoff until the artifact check succeeds', async () => {
  let elapsed = 0, checks = 0; const pauses = [], events = [];
  const verified = await monitorPublication(async signal => { assert.ok(signal); return ++checks === 6; }, {
    timeout: 1_200_000, now: () => elapsed, wait: async pause => { pauses.push(pause); elapsed += pause; },
    onWait: event => events.push(event),
  });
  assert.equal(verified, true); assert.equal(checks, 6);
  assert.deepEqual(pauses, [10000, 15000, 22500, 30000, 30000]);
  assert.equal(events.at(-1).elapsed, 77500);
});

await test('monitor retries absence and transient errors but rejects authentication, metadata and integrity failures', async () => {
  for (const code of ['E404', 'E429', 'E503', 'ECONNRESET']) {
    let checks = 0;
    const verified = await monitorPublication(async () => { if (++checks === 1) throw registryError(code); return true; }, { timeout: 1000, wait: async () => {} });
    assert.equal(verified, true); assert.equal(checks, 2);
  }
  for (const error of [registryError('E401'), registryError('E403'), new Error('integrity mismatch'), new Error('invalid metadata')]) {
    let checks = 0;
    await assert.rejects(monitorPublication(async () => { checks++; throw error; }, { timeout: 1000, wait: async () => {} }), error);
    assert.equal(checks, 1);
  }
});

await test('monitor deadline includes in-flight registry work and user cancellation remains distinct', async () => {
  const blocked = signal => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  // AbortSignal.timeout is unreferenced; keep the test event loop alive during the mock request.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    assert.equal(await monitorPublication(blocked, { timeout: 20 }), false);
    const controller = new AbortController();
    await assert.rejects(monitorPublication(async () => false, {
      timeout: 1000, signal: controller.signal, onWait: () => controller.abort(),
    }), error => error.cancelled && /receipt retained/.test(error.message));
  } finally { clearInterval(keepAlive); }
});

await test('monitor timeout stops scheduling checks and never reports verification success', async () => {
  let elapsed = 0, checks = 0;
  const verified = await monitorPublication(async () => { checks++; return false; }, {
    timeout: 1_200_000, now: () => elapsed, wait: async pause => { elapsed += pause; },
  });
  assert.equal(verified, false); assert.equal(elapsed, 1_200_000); assert.ok(checks < 50);
});
