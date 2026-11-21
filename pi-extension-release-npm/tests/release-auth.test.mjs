import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { browserChallenge, chromiumBrowser, openBrowserApproval, waitForBrowserApproval } from '../release/auth.mjs';

const challengeError = (extra = {}) => ({ stdout: JSON.stringify({ error: { code: 'EOTP', authUrl: 'https://www.npmjs.com/auth/cli/fixture', doneUrl: 'https://registry.npmjs.org/-/v1/done?authId=fixture', ...extra } }) });

await test('browser approval accepts only the registry HTTPS completion endpoint', () => {
  const challenge = browserChallenge(challengeError(), 'https://registry.npmjs.org/');
  assert.match(challenge.authUrl, /^https:\/\/www.npmjs.com\//);
  assert.throws(() => browserChallenge(challengeError({ doneUrl: 'https://other.test/done' }), 'https://registry.npmjs.org/'), /unsafe/);
  assert.throws(() => browserChallenge(challengeError({ authUrl: 'http://www.npmjs.com/auth' }), 'https://registry.npmjs.org/'), /unsafe/);
  assert.throws(() => browserChallenge(challengeError({ doneUrl: 'https://user:password@registry.npmjs.org/done' }), 'https://registry.npmjs.org/'), /unsafe/);
  assert.equal(browserChallenge({ stdout: '{"error":{"code":"EOTP"}}' }, 'https://registry.npmjs.org/'), null);
});

await test('approval polling waits for 202, honors retry bounds, and returns its token only in memory', async () => {
  const challenge = browserChallenge(challengeError(), 'https://registry.npmjs.org/');
  let requests = 0; const waits = [];
  const token = await waitForBrowserApproval(challenge, { fetch: async (url, options) => {
    assert.equal(url, challenge.doneUrl); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    return ++requests === 1 ? new Response('{}', { status: 202, headers: { 'retry-after': '5000' } }) : new Response('{"token":"synthetic-one-time-token"}');
  }, wait: async duration => { waits.push(duration); } });
  assert.equal(token, 'synthetic-one-time-token'); assert.deepEqual(waits, [10000]); assert.equal(requests, 2);
});

await test('approval timeout, cancellation, expiry and invalid token responses fail without leaking response data', async () => {
  const challenge = browserChallenge(challengeError(), 'https://registry.npmjs.org/');
  await assert.rejects(waitForBrowserApproval(challenge, { timeout: 10, fetch: async () => new Response('{}', { status: 202 }) }), /timed out/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitForBrowserApproval(challenge, { signal: controller.signal }), /cancelled/);
  await assert.rejects(waitForBrowserApproval(challenge, { fetch: async () => new Response('{"private":"fixture"}', { status: 410 }) }), /HTTP 410/);
  await assert.rejects(waitForBrowserApproval(challenge, { fetch: async () => new Response('{}') }), /no valid one-time token/);
});

await test('approval opens an installed Chromium browser directly with the exact URL', async () => {
  const browser = chromiumBrowser({ env: { PATH: '/fixture/bin' }, exists: value => value === '/fixture/bin/chromium' });
  assert.equal(browser, '/fixture/bin/chromium');
  assert.throws(() => chromiumBrowser({ env: { PATH: '/fixture/bin' }, exists: () => false }), /Chromium/);
  let unreferenced = false;
  await openBrowserApproval('https://www.npmjs.com/auth/cli/fixture', { findBrowser: () => browser, launch: (executable, args, options) => {
    assert.equal(executable, browser); assert.deepEqual(args, ['--new-tab', 'https://www.npmjs.com/auth/cli/fixture']); assert.equal(options.shell, false);
    const child = new EventEmitter(); child.unref = () => { unreferenced = true; };
    queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0); }); return child;
  } });
  assert.equal(unreferenced, true);
  await assert.rejects(openBrowserApproval('javascript:alert(1)'), /Invalid browser/);
});
