// Headless Chromium over the DevTools protocol, shared by render.mjs and assemble.mjs.
// The browser always runs headless with a throwaway profile; nothing opens on screen.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export const COMMAND_TIMEOUT_MS = 30_000;
const BROWSER_START_TIMEOUT_MS = 20_000;

/** Absolute path of a program on PATH, or null. */
export function which(name) {
  const r = spawnSync('sh', ['-c', 'command -v "$1"', 'sh', name], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Browser binary: explicit path, then $CHROME_PATH, then common names on PATH. */
export function findChromium(explicit) {
  if (explicit) return explicit;
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome', 'brave-browser', 'microsoft-edge']) {
    const found = which(name);
    if (found) return found;
  }
  throw new Error('no Chromium-family browser found; install chromium or pass --chromium <path>');
}

/** Minimal Chrome DevTools Protocol client over the browser WebSocket. */
export class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id != null && this.pending.has(msg.id)) {
        const { resolve: ok, reject, timer, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
        else ok(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject, timer, method } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error(`${method}: browser connection closed`));
      }
      this.pending.clear();
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => fail(new Error(`cannot connect to browser at ${url}`)), { once: true });
    });
    return new Cdp(ws);
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((ok, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}: no reply within ${COMMAND_TIMEOUT_MS / 1000}s`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve: ok, reject, timer, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  waitFor(method, sessionId) {
    return new Promise((ok, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), COMMAND_TIMEOUT_MS);
      const listener = (msg) => {
        if (msg.method === method && (!sessionId || msg.sessionId === sessionId)) {
          clearTimeout(timer);
          this.listeners = this.listeners.filter((l) => l !== listener);
          ok(msg.params);
        }
      };
      this.listeners.push(listener);
    });
  }

  close() { this.ws.close(); }
}

async function launchBrowser(binary, profileDir) {
  const args = [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--mute-audio', '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--force-device-scale-factor=1', '--font-render-hinting=none', '--allow-file-access-from-files',
    '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank'
  ];
  // Own process group, so cleanup can stop Chromium's helper processes too. A helper
  // that outlives the main process can recreate the profile folder after it is removed.
  const proc = spawn(binary, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32' });
  let stderr = '';
  proc.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
  let spawnError = null;
  proc.once('error', (err) => { spawnError = err; });
  const exited = new Promise((ok) => proc.once('exit', (code) => ok(code)));
  const portFile = join(profileDir, 'DevToolsActivePort');
  const deadline = Date.now() + BROWSER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) throw new Error(`cannot start browser ${binary}: ${spawnError.message}`);
    if (proc.exitCode != null) throw new Error(`browser exited with code ${proc.exitCode}:\n${stderr}`);
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n');
      if (port && path) return { proc, exited, wsUrl: `ws://127.0.0.1:${port}${path}` };
    }
    await sleep(100);
  }
  killGroup(proc, 'SIGKILL');
  throw new Error(`browser did not start within ${BROWSER_START_TIMEOUT_MS / 1000}s:\n${stderr}`);
}

export function killGroup(proc, signal) {
  try {
    if (process.platform !== 'win32' && proc.pid) process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    // ESRCH: the group is already gone.
  }
}

async function stopBrowser(browser) {
  if (browser.proc.exitCode != null) {
    killGroup(browser.proc, 'SIGKILL');
    return;
  }
  killGroup(browser.proc, 'SIGTERM');
  const abort = new AbortController();
  const timeout = sleep(3000, 'timeout', { signal: abort.signal }).catch(() => 'exited');
  await Promise.race([browser.exited, timeout]);
  abort.abort();
  killGroup(browser.proc, 'SIGKILL');
}

/**
 * Start headless Chromium and attach to one page target.
 * Every command has a 30 s reply bound; `close()` stops the whole browser process group
 * within about 3 s and must run in a finally block.
 * @param {string} binary browser path
 * @param {string} profileDir empty directory for the throwaway profile
 * @throws {Error} when the browser cannot start within 20 s or the connection fails
 */
export async function openBrowser(binary, profileDir) {
  const browser = await launchBrowser(binary, profileDir);
  let cdp;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    cdp?.close();
    await stopBrowser(browser);
  };
  try {
    cdp = await Cdp.connect(browser.wsUrl);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    return {
      send,
      close,
      async setSize(width, height) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      },
      async navigate(url) {
        const loaded = cdp.waitFor('Page.loadEventFired', sessionId);
        await send('Page.navigate', { url });
        await loaded;
      },
      async evaluate(expression) {
        const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) {
          const ex = r.exceptionDetails;
          throw new Error(`page error: ${ex.exception?.description || ex.text}`);
        }
        return r.result.value;
      },
      async screenshot() {
        // Chromium can reuse differently rasterized text layers after a jump. Rebuild
        // those layers before capture so pixels depend on this frame alone.
        await send('Runtime.evaluate', { expression: `(function () {
          var body = document.body, display = body.style.display;
          body.style.display = 'none'; void body.offsetHeight;
          body.style.display = display; void body.offsetHeight;
        })()` });
        const { data } = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
        return Buffer.from(data, 'base64');
      }
    };
  } catch (err) {
    await close();
    throw err;
  }
}

/**
 * Load a player page made by buildPage and wait until its images and fonts are ready.
 * @throws {Error} naming the scene, selector or image problem the page reported
 */
export async function loadPlayer(session, pageUrl, width, height) {
  await session.setSize(width, height);
  await session.navigate(pageUrl);
  const startError = await session.evaluate('window.__EV_ERROR || null');
  if (startError) throw new Error(startError);
  const playerType = await session.evaluate('typeof window.__EV');
  if (playerType !== 'object') throw new Error('player did not start; check the scenes file for broken HTML or script errors');
  await session.evaluate('window.__EV.ready()');
}
