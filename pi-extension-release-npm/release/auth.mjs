import { setTimeout as delay } from 'node:timers/promises';
import { jsonOutput } from './process.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function chromiumBrowser({ env = process.env, platform = process.platform, exists = existsSync } = {}) {
  const names = platform === 'win32' ? ['chrome.exe', 'msedge.exe', 'chromium.exe', 'brave.exe']
    : ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave-browser', 'brave', 'microsoft-edge-stable', 'microsoft-edge'];
  const candidates = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : path.delimiter)
    .filter(Boolean).flatMap(directory => names.map(name => path.join(directory, name)));
  if (platform === 'darwin') candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  if (platform === 'win32') for (const base of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
    for (const relative of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe', 'BraveSoftware/Brave-Browser/Application/brave.exe']) candidates.push(path.win32.join(base, relative));
  }
  const browser = candidates.find(exists);
  if (!browser) throw new Error('Browser approval requires an installed Chromium-based browser; none was found');
  return browser;
}

export async function openBrowserApproval(url, { signal, findBrowser = chromiumBrowser, launch = spawn } = {}) {
  signal?.throwIfAborted();
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('Invalid browser approval URL');
  const browser = findBrowser();
  await new Promise((resolve, reject) => {
    const child = launch(browser, ['--new-tab', target.href], { detached: true, stdio: 'ignore', shell: false });
    let timer;
    const finish = error => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once('error', () => finish(new Error('Chromium could not be started for browser approval')));
    child.once('exit', code => finish(code === 0 ? null : new Error('Chromium exited before opening browser approval')));
    child.once('spawn', () => { timer = setTimeout(() => finish(), 500); child.unref(); });
  });
}

export function failureCode(error) {
  try { return jsonOutput(error.stdout ?? '').error?.code ?? null; }
  catch { return /(?:npm (?:error|ERR!) code) ([A-Z0-9_]+)/.exec(error.stderr ?? '')?.[1] ?? null; }
}

export function browserChallenge(error, registry) {
  if (failureCode(error) !== 'EOTP') return null;
  let body;
  try { const value = jsonOutput(error.stdout); body = value.error ?? value; } catch { return null; }
  if (!body.authUrl || !body.doneUrl) return null;
  let auth, done, origin;
  try { auth = new URL(body.authUrl); done = new URL(body.doneUrl); origin = new URL(registry); }
  catch { throw new Error('Registry returned invalid browser authentication URLs'); }
  if (auth.protocol !== 'https:' || done.protocol !== 'https:' || done.origin !== origin.origin
    || auth.username || auth.password || done.username || done.password) throw new Error('Registry returned an unsafe browser authentication challenge');
  return { authUrl: auth.href, doneUrl: done.href };
}

/** Complete npm's browser OTP challenge without exposing its short-lived token. */
export async function waitForBrowserApproval(challenge, {
  signal, timeout = 600_000, fetch = globalThis.fetch, wait = delay,
} = {}) {
  const deadline = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  try {
    for (;;) {
      combined.throwIfAborted();
      const response = await fetch(challenge.doneUrl, {
        signal: combined, redirect: 'error', headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      });
      const body = await response.json();
      if (response.status === 200) {
        if (typeof body.token !== 'string' || !body.token || body.token.length > 4096 || /[\r\n\0]/.test(body.token)) throw new Error('Browser approval returned no valid one-time token');
        return body.token;
      }
      if (response.status !== 202) throw new Error(`Browser approval failed with HTTP ${response.status}; start a fresh publish attempt`);
      const seconds = Number(response.headers.get('retry-after'));
      await wait(Math.min(10_000, Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 1000)), undefined, { signal: combined });
    }
  } catch (error) {
    if (signal?.aborted) throw Object.assign(new Error('Release cancelled during browser approval'), { cancelled: true });
    if (deadline.aborted) throw new Error('Browser authentication timed out after ten minutes; start a fresh publish attempt');
    if (error.message.startsWith('Browser approval')) throw error;
    throw new Error('Browser approval could not be completed; start a fresh publish attempt');
  }
}
