import { navigateFocused } from './focused-navigation-fixture.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { test as sessionTest } from './session-fixture.mjs';

const publicRoot = new URL('../../public/', import.meta.url);
const workerSource = await readFile(new URL('service-worker.js', publicRoot), 'utf8');
const cacheName = workerSource.match(/const CACHE_NAME = "([^"]+)"/)[1];
const shellAssets = [...workerSource.match(/const APP_SHELL = (\[[\s\S]*?\]);/)[1].matchAll(/"([^"\n]+)"/g)].map(match => match[1]);
const settingsAssets = shellAssets.filter(path => path.startsWith('/settings-'));

// Read the entry graph independently of the worker list so an omitted import fails.
async function currentAssetGraph() {
  const html = await readFile(new URL('index.html', publicRoot), 'utf8');
  const pending = ['/index.html', ...[...html.matchAll(/(?:href|src|data-app-src)="(\/[^"#]+)"/g)]
    .map(match => new URL(match[1], 'http://fixture').pathname)];
  const graph = new Set();
  while (pending.length) {
    const pathname = pending.pop();
    if (graph.has(pathname)) continue;
    graph.add(pathname);
    if (!/\.(?:m?js|css|webmanifest)$/.test(pathname)) continue;
    const source = await readFile(new URL(pathname.slice(1), publicRoot), 'utf8');
    if (/\.m?js$/.test(pathname)) {
      for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
        pending.push(new URL(match[1], `http://fixture${pathname}`).pathname);
      }
    } else if (pathname.endsWith('.css')) {
      for (const match of source.matchAll(/url\(\s*['"]?([^)'"\s]+)['"]?\s*\)/g)) {
        if (!match[1].startsWith('data:')) pending.push(new URL(match[1], `http://fixture${pathname}`).pathname);
      }
    } else {
      pending.push(...JSON.parse(source).icons.map(icon => icon.src));
    }
  }
  return [...graph].sort();
}

const test = sessionTest.extend({
  assets: async ({ ownership }, use) => {
    const state = { epoch: 'current', missing: null, requests: [] };
    const upstreams = new Set();
    const server = createServer((request, response) => {
      const pathname = new URL(request.url, 'http://fixture').pathname;
      state.requests.push({ path: pathname, epoch: state.epoch });
      if (pathname === state.missing) {
        response.writeHead(404, { 'content-type': 'text/plain' });
        response.end('W7 deliberately missing asset');
        return;
      }
      if (pathname === '/service-worker.js') {
        let source = workerSource;
        if (state.epoch === 'old') {
          source = source.replace(cacheName, `${cacheName}-w7-old-fixture`)
            .replace(/const APP_SHELL = \[[\s\S]*?\];/, `const APP_SHELL = ${JSON.stringify(shellAssets.filter(path => !settingsAssets.includes(path)))};`);
        }
        response.writeHead(200, { 'content-type': 'application/javascript', 'cache-control': 'no-store' });
        response.end(source);
        return;
      }
      const upstream = proxyRequest(new URL(request.url, ownership.baseURL), {
        method: request.method, headers: { ...request.headers, host: new URL(ownership.baseURL).host },
      }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      });
      upstreams.add(upstream);
      upstream.on('close', () => upstreams.delete(upstream));
      upstream.on('error', error => {
        if (!response.headersSent) response.writeHead(502);
        response.end(error.message);
      });
      response.on('close', () => upstream.destroy());
      request.pipe(upstream);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    try {
      await use({ state, baseURL: `http://127.0.0.1:${server.address().port}` });
    } finally {
      for (const upstream of upstreams) upstream.destroy();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  },
});

test.use({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'allow', video: 'off', reducedMotion: 'reduce', actionTimeout: 5_000 });

async function openFocused(page, baseURL) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(baseURL);
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
}

async function controlled(page) {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

async function cacheSnapshot(page, name) {
  return page.evaluate(async name => {
    const names = await caches.keys();
    const cache = await caches.open(name);
    return { names, paths: (await cache.keys()).map(request => new URL(request.url).pathname).sort() };
  }, name);
}

const destinations = page => page.getByRole('navigation', { name: 'Workspace destinations' });

test('complete current entry graph is precached, including Settings, and never caches APIs', async ({ page, assets }, info) => {
  const graph = await currentAssetGraph();
  expect(settingsAssets.length).toBeGreaterThanOrEqual(5);
  expect(graph.filter(path => !shellAssets.includes(path)), 'Every entry import, stylesheet and manifest icon must be precached').toEqual([]);
  await openFocused(page, assets.baseURL);
  await controlled(page);
  const snapshot = await cacheSnapshot(page, cacheName);
  expect(snapshot.paths).toEqual([...shellAssets].sort());
  expect(snapshot.paths.some(path => path.startsWith('/api/'))).toBe(false);
  for (const path of shellAssets) {
    const response = await page.request.get(`${assets.baseURL}${path}`);
    expect(response.ok(), path).toBe(true);
  }
  await navigateFocused(page, 'Settings');
  await expect(page.locator('.settings-workspace')).toBeVisible();
  await page.screenshot({ path: info.outputPath('current-settings-cache.png') });
  const evidencePath = info.outputPath('current-asset-graph.json');
  await writeFile(evidencePath, JSON.stringify({ cacheName, graph, shellAssets, snapshot }, null, 2));
  await info.attach('current asset graph', { path: evidencePath, contentType: 'application/json' });
});

test('old cache gains new Settings modules while a stale open client retains its draft and nodes', async ({ page, assets }, info) => {
  assets.state.epoch = 'old';
  await openFocused(page, assets.baseURL);
  await controlled(page);
  const oldName = `${cacheName}-w7-old-fixture`;
  const before = await cacheSnapshot(page, oldName);
  expect(settingsAssets.filter(path => before.paths.includes(path))).toEqual([]);
  await page.locator('#promptInput').fill('stale open client draft, no reload');
  await page.evaluate(() => {
    window.w7Prompt = document.querySelector('#promptInput');
    window.w7Document = document;
    window.w7ControllerChanges = 0;
    navigator.serviceWorker.addEventListener('controllerchange', () => { window.w7ControllerChanges += 1; });
  });
  assets.state.epoch = 'current';
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
  await expect.poll(() => page.evaluate(() => window.w7ControllerChanges)).toBeGreaterThan(0);
  await expect.poll(async () => (await cacheSnapshot(page, cacheName)).names, { message: 'Activated current worker must retire the old cache' }).not.toContain(oldName);
  const after = await cacheSnapshot(page, cacheName);
  expect(after.names).not.toContain(oldName);
  expect(after.paths).toEqual([...shellAssets].sort());
  await navigateFocused(page, 'Settings');
  await page.getByRole('navigation', { name: 'Settings categories' }).getByRole('button', { name: 'System', exact: true }).click();
  await expect(page.locator('#serverActionSelect')).toBeVisible();
  await destinations(page).getByRole('button', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#promptInput')).toHaveValue('stale open client draft, no reload');
  expect(await page.evaluate(() => window.w7Document === document && window.w7Prompt === document.querySelector('#promptInput'))).toBe(true);
  await page.screenshot({ path: info.outputPath('stale-client-after-worker-update.png') });
  await page.reload();
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
  const evidencePath = info.outputPath('cache-transition.json');
  await writeFile(evidencePath, JSON.stringify({ before, after, requests: assets.state.requests }, null, 2));
  await info.attach('cache transition', { path: evidencePath, contentType: 'application/json' });
});

test('offline reload serves the Focused asset graph without claiming working offline APIs', async ({ page, context, assets }, info) => {
  await openFocused(page, assets.baseURL);
  await controlled(page);
  try {
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.locator('#webuiBootFailurePanel')).toBeHidden();
    await expect(page.locator('#focusedWorkspace')).toBeVisible();
    await navigateFocused(page, 'Settings');
    await expect(page.locator('.settings-workspace')).toBeVisible();
    const results = await page.evaluate(async paths => Promise.all(paths.map(async path => {
      const response = await fetch(path);
      return { path, ok: response.ok };
    })), await currentAssetGraph());
    expect(results.filter(result => !result.ok)).toEqual([]);
    expect(await page.evaluate(() => fetch('/api/tabs').then(() => 'unexpected network success', () => 'offline API unavailable'))).toBe('offline API unavailable');
    await expect(page.locator('#serverOfflinePanel')).toBeVisible();
    const snapshot = await cacheSnapshot(page, cacheName);
    expect(snapshot.paths.some(path => path.startsWith('/api/'))).toBe(false);
    await page.screenshot({ path: info.outputPath('offline-focused-shell.png') });
  } finally {
    await context.setOffline(false);
  }
  await page.reload();
  await expect(page.locator('#modelSelect')).not.toBeEmpty();
  await expect(page.locator('#serverOfflinePanel')).toBeHidden();
});

test('missing Settings import shows accessible diagnostics and keyboard retry recovers when the asset returns', async ({ page, assets }, info) => {
  assets.state.missing = '/settings-workspace.mjs';
  await openFailure(page, assets);
  await expect(page.locator('#webuiBootFailureReport')).toHaveValue(/settings-workspace\.mjs/);
  const audit = await new AxeBuilder({ page }).include('#webuiBootFailurePanel').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
  await page.screenshot({ path: info.outputPath('missing-settings-boot-failure.png') });
  assets.state.missing = null;
  const retry = page.getByRole('button', { name: 'Reload page', exact: true });
  await retry.focus();
  await expect(retry).toBeFocused();
  await retry.press('Enter');
  await expect(page.locator('#webuiBootFailurePanel')).toBeHidden();
  await expect(page.locator('#focusedWorkspace')).toBeVisible();
});

async function openFailure(page, assets) {
  await page.addInitScript(() => localStorage.setItem('pi-webui-shell-preferences-v1', JSON.stringify({ v: 1, desktopLayout: 'focused' })));
  await page.goto(assets.baseURL);
  await expect(page.getByRole('alert').filter({ has: page.getByRole('heading', { name: 'Pi Web UI could not load correctly' }) })).toBeVisible();
}

test('boot failure provides an accessible Classic startup escape', async ({ page, assets }, info) => {
  assets.state.missing = '/settings-workspace.mjs';
  await openFailure(page, assets);
  await page.screenshot({ path: info.outputPath('classic-startup-escape.png') });
  const recovery = page.locator('#webuiBootFailurePanel').getByRole('link', { name: /classic/i });
  await expect(recovery, 'W7 global startup recovery must name a keyboard-accessible Classic escape').toBeVisible();
  await expect(recovery).toHaveAttribute('href', /[?&]shell=classic(?:&|$)/);
  assets.state.missing = null;
  await recovery.focus();
  await recovery.press('Enter');
  await expect(page).toHaveURL(/[?&]shell=classic(?:&|$)/);
  await expect(page.locator('#focusedWorkspace')).toBeHidden();
  await expect(page.locator('#promptInput')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-webui-shell-preferences-v1')).desktopLayout)).toBe('focused');
});

test('explicit Classic URL recovery works after a failed asset is restored', async ({ page, assets }) => {
  assets.state.missing = '/settings-workspace.mjs';
  await openFailure(page, assets);
  assets.state.missing = null;
  await page.goto(`${assets.baseURL}/?shell=classic`);
  await expect(page.locator('#webuiBootFailurePanel')).toBeHidden();
  await expect(page.locator('#focusedWorkspace')).toBeHidden();
  await expect(page.locator('#promptInput')).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pi-webui-shell-preferences-v1')).desktopLayout)).toBe('focused');
});
